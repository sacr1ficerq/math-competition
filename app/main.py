import json
from typing import Annotated

from fastapi import FastAPI, HTTPException, Request
from pydantic import Field, StringConstraints, model_validator
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from urllib.parse import urlsplit

from app.api import lifespan, preferred_model, provider_key, router, settings
from app.account_api import router as account_router, resolve_identity
from app.problem_api import create_problem_router
from app.problem_bank import ProblemBank, ProblemBankError
from app.competition import CompetitionError, identity
from app.config import ROOT, Problem
from app.grading import GradeRequest, GradeResponse, grade_solution
from app.solutions import SolutionContent


app = FastAPI(title="Math Competition", version="1.0.0", lifespan=lifespan)
app.include_router(router)
app.include_router(account_router)
app.include_router(create_problem_router(
    lambda request: identity(value) if (value := resolve_identity(request)) else None
))
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.exception_handler(ProblemBankError)
@app.exception_handler(CompetitionError)
async def competition_error(request, error):
    messages = {
        "No common unseen problems remain in this topic. Choose another topic or add new problems to the bank.": "В этой теме не осталось задач, новых для обоих игроков. Выберите другую тему или добавьте задачи в банк.",
        "Only the creator can change the topic.": "Только создатель дуэли может менять тему.",
        "The topic is locked once the competition starts.": "После начала раунда изменить тему нельзя.",
    }
    return JSONResponse(status_code=error.status, content={"detail": messages.get(error.message, error.message)})


@app.exception_handler(RequestValidationError)
async def invalid_request(request, error):
    # Pydantic's default error includes rejected input, which may be an API key.
    return JSONResponse(
        status_code=422,
        content={"detail": [
            {"loc": list(item["loc"]), "msg": item["msg"], "type": item["type"]}
            for item in error.errors()
        ]},
    )


@app.middleware("http")
async def disable_caching(request, call_next):
    origin = request.headers.get("origin")
    if request.method not in ("GET", "HEAD", "OPTIONS") and origin:
        if urlsplit(origin).netloc != request.headers.get("host"):
            return JSONResponse(status_code=403, content={"detail": "Cross-origin requests are not allowed."})
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/")
async def index():
    return FileResponse(ROOT / "static" / "competition.html")


@app.get("/s/{code}")
async def session_page(code: str):
    return FileResponse(ROOT / "static" / "competition.html")


@app.get("/practice")
async def practice():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/config")
async def public_config():
    return {
        "model": settings.grading.model,
        "problem": {
            "title": settings.problem.title,
            "statement": settings.problem.statement,
        },
    }


class PracticeRequest(SolutionContent):
    api_key: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=512)] | None = None
    problem: Problem | None = None
    problem_id: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode="after")
    def one_problem_source(self):
        if self.problem_id and self.problem:
            raise ValueError("Choose a bank problem or upload a custom problem.")
        return self


@app.post("/api/grade", response_model=GradeResponse)
async def grade(body: PracticeRequest, request: Request):
    api_key = body.api_key or provider_key(request)
    if not api_key:
        raise HTTPException(400, "Save your OpenRouter API key before submitting.")
    participant = None
    problem = body.problem or settings.problem
    if body.problem_id:
        value = resolve_identity(request)
        if not value:
            raise HTTPException(401, "Sign in before practicing a bank problem.")
        participant = identity(value)
        with request.app.state.problem_bank.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT content FROM bank_problems WHERE id=? AND retired=0", (body.problem_id,)).fetchone()
            if row is None:
                raise HTTPException(404, "Problem not found.")
            problem = Problem.model_validate(json.loads(row[0]))
            ProblemBank.record_status(db, participant, body.problem_id, "attempted")
    downstream = GradeRequest(api_key=api_key, solution=body.solution, images=body.images, problem=body.problem)
    result = await grade_solution(downstream, problem, settings.grading.model_copy(update={"model": preferred_model(request)}))
    if participant and result.status == "graded" and result.grade and result.grade.verdict == 10:
        with request.app.state.problem_bank.connection() as db:
            ProblemBank.record_status(db, participant, body.problem_id, "solved")
    return result
