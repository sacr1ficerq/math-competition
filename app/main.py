from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from urllib.parse import urlsplit

from app.api import lifespan, router, settings
from app.account_api import router as account_router, resolve_identity
from app.problem_api import create_problem_router
from app.problem_bank import ProblemBankError
from app.competition import CompetitionError, identity
from app.config import ROOT
from app.grading import GradeRequest, GradeResponse, grade_solution


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
    return JSONResponse(status_code=error.status, content={"detail": error.message})


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


@app.post("/api/grade", response_model=GradeResponse)
async def grade(request: GradeRequest):
    return await grade_solution(request, request.problem or settings.problem, settings.grading)
