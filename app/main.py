from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import ROOT, load_settings
from app.grading import GradeRequest, GradeResponse, grade_solution


settings = load_settings()
app = FastAPI(title="Math Competition PoC")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


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
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/")
async def index():
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
