import asyncio
import base64
import logging
import secrets
import re
import time

import httpx
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, StringConstraints

from app.competition import Store, snapshot
from app.config import ROOT, Problem, load_settings
from app.grading import AppealGradeRequest, GradeRequest, grade_appeal, grade_solution
from app.account_api import ModelName, current_account, init_accounts, resolve_identity, saved_api_key
from app.problem_bank import ProblemBank
from app.solutions import SolutionContent


settings = load_settings()
logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/api")
IDENTITY_COOKIE = "math_player"
KEY_COOKIE = "math_openrouter_key"
MONTH = 30 * 24 * 60 * 60
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]


def store(request: Request) -> Store:
    return request.app.state.store


def token(request: Request) -> str:
    value = resolve_identity(request) if hasattr(request.app.state, "accounts") else request.cookies.get(IDENTITY_COOKIE)
    if not value:
        raise HTTPException(401, "Join or create a session first.")
    return value


def set_cookie(response: Response, request: Request, name: str, value: str):
    response.set_cookie(name, value, max_age=MONTH, httponly=True, samesite="strict", secure=request.url.scheme == "https")


def provider_key(request: Request) -> str | None:
    if hasattr(request.app.state, "accounts") and current_account(request):
        return saved_api_key(request)
    return request.cookies.get(KEY_COOKIE)


def preferred_model(request: Request) -> str:
    account = current_account(request) if hasattr(request.app.state, "accounts") else None
    return (account["default_model"] if account else None) or settings.grading.model


def decorate(request: Request, session: dict, value: str) -> dict:
    result = snapshot(session, value)
    result["has_api_key"] = bool(provider_key(request))
    if session["phase"] == "lobby" and hasattr(request.app.state, "problem_bank"):
        result["available_topics"] = request.app.state.problem_bank.topics([p["identity"] for p in session["players"]])
    return result


def view(request: Request, session: dict) -> dict:
    return decorate(request, session, token(request))


def participant_name(request: Request, supplied: str | None) -> str:
    account = current_account(request) if hasattr(request.app.state, "accounts") else None
    if account:
        return account["display_name"]
    if not supplied:
        raise HTTPException(422, "Enter a display name or sign in first.")
    return supplied


def validate_topic(request: Request, topic: str | None):
    if topic is not None and topic not in {t["slug"] for t in request.app.state.problem_bank.topics()}:
        raise HTTPException(422, "Choose an available topic.")


def grading_problem(session: dict) -> Problem:
    return Problem.model_validate({k: session["problem"][k] for k in Problem.model_fields})


class CreateSession(BaseModel):
    name: Name | None = None
    problem: Problem | None = None
    topic: str | None = Field(default=None, min_length=1, max_length=100)
    model: ModelName | None = None


class JoinSession(BaseModel):
    name: Name | None = None


class VisibilityRequest(BaseModel):
    hidden: bool


class RoundRequest(BaseModel):
    round: int = Field(default=1, ge=1)


class ReadyRequest(RoundRequest):
    ready: bool


class ModelRequest(RoundRequest):
    model: ModelName


class ProblemRequest(RoundRequest):
    problem: Problem


class TopicRequest(RoundRequest):
    topic: str | None = Field(default=None, min_length=1, max_length=100)


class DraftRequest(RoundRequest):
    text: str = Field(max_length=50_000)
    revision: int = Field(ge=0)


class SubmitRequest(SolutionContent):
    finalize: bool = False
    round: int = Field(default=1, ge=1)
    request_id: str = Field(min_length=1, max_length=100)


class AppealRequest(RoundRequest):
    request_id: str = Field(min_length=1, max_length=100)
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10_000)]


class ChatRequest(BaseModel):
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]


class KeyRequest(BaseModel):
    api_key: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=512, pattern=r"^[\x21-\x7e]+$")]


@router.get("/models")
async def models(request: Request):
    # Public metadata only. Provider keys and the grading proxy are never used here.
    state = request.app.state
    if not hasattr(state, "model_catalog"):
        state.model_catalog = {"models": None, "checked_at": 0, "stale": True}
        state.model_catalog_lock = asyncio.Lock()
    async with state.model_catalog_lock:
        cache = state.model_catalog
        age = time.monotonic() - cache["checked_at"]
        if cache["checked_at"] == 0 or age >= (60 if cache["stale"] else 600):
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    response = await client.get("https://openrouter.ai/api/v1/models")
                    response.raise_for_status()
                    payload = response.json()
                if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
                    raise ValueError("Invalid model catalog")
                entries = {}
                for entry in payload["data"]:
                    if not isinstance(entry, dict):
                        continue
                    model_id = entry.get("id")
                    parameters = entry.get("supported_parameters")
                    if not isinstance(model_id, str) or len(model_id) > 200 or not re.fullmatch(r"[\w.:-]+/[\w.:-]+", model_id):
                        continue
                    if not isinstance(parameters, list) or not any(p in parameters for p in ("response_format", "structured_outputs")):
                        continue
                    architecture = entry.get("architecture")
                    modalities = architecture.get("input_modalities") if isinstance(architecture, dict) else None
                    entries[model_id] = {"id": model_id, "name": entry["name"] if isinstance(entry.get("name"), str) and entry["name"] else model_id,
                                         "supports_images": "image" in modalities if isinstance(modalities, list) else None}
                cache.update(models=sorted(entries.values(), key=lambda m: str(m["name"]).casefold()), stale=False)
            except (httpx.HTTPError, ValueError, TypeError):
                cache["stale"] = True
            cache["checked_at"] = time.monotonic()
        available = cache["models"]
        if available is None:
            available = [{"id": settings.grading.model, "name": settings.grading.model, "supports_images": None}]
        return {"models": available, "default_model": settings.grading.model, "stale": cache["stale"]}


@router.get("/sessions")
async def sessions(request: Request):
    value = resolve_identity(request) if hasattr(request.app.state, "accounts") else request.cookies.get(IDENTITY_COOKIE)
    return {"sessions": store(request).recent(value) if value else [], "model": settings.grading.model}


@router.post("/sessions", status_code=201)
async def create(body: CreateSession, request: Request, response: Response):
    value = (resolve_identity(request) if hasattr(request.app.state, "accounts") else request.cookies.get(IDENTITY_COOKIE)) or secrets.token_urlsafe(32)
    if body.problem is None:
        validate_topic(request, body.topic)
    session = store(request).create(value, participant_name(request, body.name), body.problem, body.model or preferred_model(request), body.topic)
    set_cookie(response, request, IDENTITY_COOKIE, value)
    return decorate(request, session, value)


@router.post("/sessions/{code}/join")
async def join(code: str, body: JoinSession, request: Request, response: Response):
    value = (resolve_identity(request) if hasattr(request.app.state, "accounts") else request.cookies.get(IDENTITY_COOKIE)) or secrets.token_urlsafe(32)
    session = store(request).join(code, value, participant_name(request, body.name))
    set_cookie(response, request, IDENTITY_COOKIE, value)
    return decorate(request, session, value)


@router.get("/sessions/{code}")
async def get_session(code: str, request: Request):
    return view(request, store(request).read(code, token(request)))


@router.put("/sessions/{code}/visibility")
async def room_visibility(code: str, body: VisibilityRequest, request: Request):
    store(request).visibility(code, token(request), body.hidden)
    return {"hidden": body.hidden}


@router.get("/sessions/{code}/rounds/{round_number}")
async def get_round(code: str, round_number: int, request: Request):
    session = store(request).read(code, token(request))
    archived = next((r for r in session["rounds"] if r["round"] == round_number), None)
    if archived is None:
        raise HTTPException(404, "Completed round not found.")
    return view(request, {**session, **archived, "phase": "finished", "rounds": [], "_archived": True})


@router.post("/sessions/{code}/close")
async def close_session(code: str, body: RoundRequest, request: Request):
    return view(request, store(request).close(code, token(request), body.round))


@router.post("/sessions/{code}/rematch")
async def rematch(code: str, body: RoundRequest, request: Request):
    session = store(request).rematch(code, token(request), body.round)
    logger.info("Rematch lobby: session=%s round=%d", code, session["round"])
    return view(request, session)


@router.put("/sessions/{code}/problem")
async def set_problem(code: str, body: ProblemRequest, request: Request):
    return view(request, store(request).problem(code, token(request), body.problem, body.round))


@router.put("/sessions/{code}/topic")
async def set_topic(code: str, body: TopicRequest, request: Request):
    validate_topic(request, body.topic)
    return view(request, store(request).topic(code, token(request), body.topic, body.round))


@router.put("/key")
async def save_key(body: KeyRequest, request: Request, response: Response):
    token(request)
    account = current_account(request) if hasattr(request.app.state, "accounts") else None
    if account:
        request.app.state.accounts.set_key(account["id"], body.api_key)
        response.delete_cookie(KEY_COOKIE)
    else:
        set_cookie(response, request, KEY_COOKIE, body.api_key)
    return {"has_api_key": True}


@router.delete("/key")
async def delete_key(request: Request, response: Response):
    account = current_account(request) if hasattr(request.app.state, "accounts") else None
    if account:
        request.app.state.accounts.set_key(account["id"], None)
    response.delete_cookie(KEY_COOKIE)
    return {"has_api_key": False}


@router.put("/sessions/{code}/model")
async def set_model(code: str, body: ModelRequest, request: Request):
    return view(request, store(request).model(code, token(request), body.model, round=body.round))


@router.put("/sessions/{code}/ready")
async def ready(code: str, body: ReadyRequest, request: Request):
    return view(request, store(request).ready(code, token(request), body.ready, round=body.round, bank=getattr(request.app.state, "problem_bank", None)))


@router.put("/sessions/{code}/draft")
async def draft(code: str, body: DraftRequest, request: Request):
    return view(request, store(request).draft(code, token(request), body.text, body.revision, round=body.round))


async def run_grade(app, code: str, submission: dict, session: dict, api_key: str):
    logger.info("Grading started: session=%s submission=%s model=%s started_at=%s", code, submission["id"], session["model"], datetime.now(timezone.utc).isoformat())
    try:
        result = await grade_solution(
            GradeRequest(api_key=api_key, solution=submission["solution"], images=submission.get("images", [])),
            grading_problem(session),
            settings.grading.model_copy(update={"model": session["model"]}),
        )
        output = result.model_dump(mode="json")
    except asyncio.CancelledError:
        logger.warning("Grading interrupted: session=%s submission=%s interrupted_at=%s", code, submission["id"], datetime.now(timezone.utc).isoformat())
        app.state.store.complete(code, submission["id"], {
            "status": "failed", "attempts": 0, "error": "Grading was interrupted. No submission penalty was applied.",
        })
        raise
    except Exception as error:
        logger.error("Grading job failed: session=%s submission=%s error_type=%s", code, submission["id"], type(error).__name__)
        output = {"status": "failed", "attempts": 0, "error": "Unable to grade this submission. No submission penalty was applied."}
    app.state.store.complete(code, submission["id"], output)
    logger.info("Grading finished: session=%s submission=%s status=%s attempts=%s finished_at=%s", code, submission["id"], output["status"], output["attempts"], datetime.now(timezone.utc).isoformat())


@router.post("/sessions/{code}/submissions", status_code=202)
async def submit(code: str, body: SubmitRequest, request: Request):
    value = token(request)
    api_key = provider_key(request)
    if not api_key:
        raise HTTPException(400, "Save your OpenRouter API key before submitting.")
    session, submission, created = store(request).submit(
        code, value, body.solution, body.request_id,
        images=[image.model_dump() for image in body.images],
        round=body.round, finalize=body.finalize,
    )
    if created:
        logger.info("Submission accepted: session=%s submission=%s submitted_at=%s", code, submission["id"], datetime.fromtimestamp(submission["submitted_at"], timezone.utc).isoformat())
        task = asyncio.create_task(run_grade(request.app, code, submission, session, api_key))
        request.app.state.grading_tasks.add(task)
        task.add_done_callback(request.app.state.grading_tasks.discard)
    return view(request, session)


async def run_appeal(app, code: str, submission: dict, appeal: dict, session: dict, api_key: str):
    try:
        result = await grade_appeal(
            AppealGradeRequest(api_key=api_key, solution=submission["solution"], images=submission.get("images", []),
                               previous_verdict=submission["grade"], appeal_reason=appeal["reason"]),
            grading_problem(session),
            settings.grading.model_copy(update={"model": session["model"]}),
        )
        output = result.model_dump(mode="json")
    except asyncio.CancelledError:
        app.state.store.complete_appeal(code, submission["id"], appeal["id"], {"status": "failed"})
        raise
    except Exception as error:
        logger.error("Appeal review failed: session=%s submission=%s error_type=%s", code, submission["id"], type(error).__name__)
        output = {"status": "failed"}
    app.state.store.complete_appeal(code, submission["id"], appeal["id"], output)


@router.post("/sessions/{code}/submissions/{submission_id}/appeal", status_code=202)
async def appeal_submission(code: str, submission_id: str, body: AppealRequest, request: Request):
    value = token(request)
    api_key = provider_key(request)
    if not api_key:
        raise HTTPException(400, "Save your OpenRouter API key before appealing.")
    session, submission, appeal, created = store(request).appeal(code, value, submission_id, body.reason, body.request_id, body.round)
    if created:
        task = asyncio.create_task(run_appeal(request.app, code, submission, appeal, session, api_key))
        request.app.state.grading_tasks.add(task)
        task.add_done_callback(request.app.state.grading_tasks.discard)
    return view(request, session)


@router.get("/sessions/{code}/submissions/{submission_id}/images/{index}")
async def submission_image(code: str, submission_id: str, index: int, request: Request):
    value = token(request)
    session = store(request).read(code, value)
    me = Store.player(session, value)
    players = [p for p in session["players"] if p["id"] == me["id"] or session["phase"] == "finished"]
    players.extend(p for round in session["rounds"] for p in round["players"])
    submission = next((s for p in players for s in p["submissions"] if s["id"] == submission_id), None)
    if submission is None or not 0 <= index < len(submission.get("images", [])):
        raise HTTPException(404, "Screenshot not found.")
    prefix, encoded = submission["images"][index]["data_url"].split(",", 1)
    return Response(content=base64.b64decode(encoded), media_type=prefix[5:-7])


@router.post("/sessions/{code}/finalize")
async def finalize(code: str, request: Request, body: RoundRequest | None = None):
    value = token(request)
    session = store(request).finalize(code, value, round=body.round if body else 1)
    player = Store.player(session, value)
    pending = sum(s["status"] == "pending" for p in session["players"] for s in p["submissions"])
    logger.info("Player finalized: session=%s player=%s finalized_at=%s submissions=%d session_pending=%d phase=%s", code, player["id"], datetime.fromtimestamp(player["finalized_at"], timezone.utc).isoformat(), len(player["submissions"]), pending, session["phase"])
    return view(request, session)


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
    init_accounts(app)
    app.state.problem_bank = ProblemBank(app.state.store.path)
    app.state.store.tick(recover=True)
    app.state.grading_tasks = set()
    ticker = asyncio.create_task(deadline_loop(app))
    try:
        yield
    finally:
        ticker.cancel()
        tasks = list(app.state.grading_tasks)
        if tasks:
            logger.info("Server shutdown: waiting for %d in-flight grading jobs to finish.", len(tasks))
        await asyncio.gather(ticker, *tasks, return_exceptions=True)
