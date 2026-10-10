import asyncio
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, StringConstraints

from app.competition import Store, snapshot
from app.config import ROOT, Problem, load_settings
from app.grading import GradeRequest, grade_solution


settings = load_settings()
router = APIRouter(prefix="/api")
IDENTITY_COOKIE = "math_player"
KEY_COOKIE = "math_openrouter_key"
MONTH = 30 * 24 * 60 * 60
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
ModelName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200, pattern=r"^[\w.:-]+/[\w.:-]+$")]
Solution = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50_000)]


def store(request: Request) -> Store:
    return request.app.state.store


def token(request: Request) -> str:
    value = request.cookies.get(IDENTITY_COOKIE)
    if not value:
        raise HTTPException(401, "Join or create a session first.")
    return value


def set_cookie(response: Response, request: Request, name: str, value: str):
    response.set_cookie(name, value, max_age=MONTH, httponly=True, samesite="strict", secure=request.url.scheme == "https")


def view(request: Request, session: dict) -> dict:
    result = snapshot(session, token(request))
    result["has_api_key"] = bool(request.cookies.get(KEY_COOKIE))
    return result


class CreateSession(BaseModel):
    name: Name
    problem: Problem
    model: ModelName | None = None


class JoinSession(BaseModel):
    name: Name


class ReadyRequest(BaseModel):
    ready: bool


class ModelRequest(BaseModel):
    model: ModelName


class DraftRequest(BaseModel):
    text: str = Field(max_length=50_000)
    revision: int = Field(ge=0)


class SubmitRequest(BaseModel):
    solution: Solution
    request_id: str = Field(min_length=1, max_length=100)


class ChatRequest(BaseModel):
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]


class KeyRequest(BaseModel):
    api_key: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=512, pattern=r"^[\x21-\x7e]+$")]


@router.get("/sessions")
async def sessions(request: Request):
    value = request.cookies.get(IDENTITY_COOKIE)
    return {"sessions": store(request).recent(value) if value else [], "model": settings.grading.model}


@router.post("/sessions", status_code=201)
async def create(body: CreateSession, request: Request, response: Response):
    value = request.cookies.get(IDENTITY_COOKIE) or secrets.token_urlsafe(32)
    session = store(request).create(value, body.name, body.problem, body.model or settings.grading.model)
    set_cookie(response, request, IDENTITY_COOKIE, value)
    result = snapshot(session, value)
    result["has_api_key"] = bool(request.cookies.get(KEY_COOKIE))
    return result


@router.post("/sessions/{code}/join")
async def join(code: str, body: JoinSession, request: Request, response: Response):
    value = request.cookies.get(IDENTITY_COOKIE) or secrets.token_urlsafe(32)
    session = store(request).join(code, value, body.name)
    set_cookie(response, request, IDENTITY_COOKIE, value)
    result = snapshot(session, value)
    result["has_api_key"] = bool(request.cookies.get(KEY_COOKIE))
    return result


@router.get("/sessions/{code}")
async def get_session(code: str, request: Request):
    return view(request, store(request).read(code, token(request)))


@router.put("/key")
async def save_key(body: KeyRequest, request: Request, response: Response):
    token(request)
    set_cookie(response, request, KEY_COOKIE, body.api_key)
    return {"has_api_key": True}


@router.delete("/key")
async def delete_key(response: Response):
    response.delete_cookie(KEY_COOKIE)
    return {"has_api_key": False}


@router.put("/sessions/{code}/model")
async def set_model(code: str, body: ModelRequest, request: Request):
    return view(request, store(request).model(code, token(request), body.model))


@router.put("/sessions/{code}/ready")
async def ready(code: str, body: ReadyRequest, request: Request):
    return view(request, store(request).ready(code, token(request), body.ready))


@router.put("/sessions/{code}/draft")
async def draft(code: str, body: DraftRequest, request: Request):
    return view(request, store(request).draft(code, token(request), body.text, body.revision))


async def run_grade(app, code: str, submission: dict, session: dict, api_key: str):
    try:
        result = await grade_solution(
            GradeRequest(api_key=api_key, solution=submission["solution"]),
            Problem.model_validate(session["problem"]),
            settings.grading.model_copy(update={"model": session["model"]}),
        )
        output = result.model_dump(mode="json")
    except asyncio.CancelledError:
        app.state.store.complete(code, submission["id"], {
            "status": "failed", "attempts": 0, "error": "Grading was interrupted. No submission penalty was applied.",
        })
        raise
    except Exception:
        output = {"status": "failed", "attempts": 0, "error": "Unable to grade this submission. No submission penalty was applied."}
    app.state.store.complete(code, submission["id"], output)


@router.post("/sessions/{code}/submissions", status_code=202)
async def submit(code: str, body: SubmitRequest, request: Request):
    value = token(request)
    api_key = request.cookies.get(KEY_COOKIE)
    if not api_key:
        raise HTTPException(400, "Save your OpenRouter API key before submitting.")
    session, submission, created = store(request).submit(code, value, body.solution, body.request_id)
    if created:
        task = asyncio.create_task(run_grade(request.app, code, submission, session, api_key))
        request.app.state.grading_tasks.add(task)
        task.add_done_callback(request.app.state.grading_tasks.discard)
    return view(request, session)


@router.post("/sessions/{code}/finalize")
async def finalize(code: str, request: Request):
    return view(request, store(request).finalize(code, token(request)))


@router.post("/sessions/{code}/chat")
async def chat(code: str, body: ChatRequest, request: Request):
    return view(request, store(request).chat(code, token(request), body.text))


async def deadline_loop(app):
    while True:
        await asyncio.sleep(1)
        app.state.store.tick()


@asynccontextmanager
async def lifespan(app):
    path = Path(settings.database)
    app.state.store = Store(path if path.is_absolute() else ROOT / path)
    app.state.store.tick(recover=True)
    app.state.grading_tasks = set()
    ticker = asyncio.create_task(deadline_loop(app))
    try:
        yield
    finally:
        ticker.cancel()
        tasks = list(app.state.grading_tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(ticker, *tasks, return_exceptions=True)
