import uvicorn

from app.config import load_settings


if __name__ == "__main__":
    settings = load_settings()
    uvicorn.run("app.main:app", host=settings.server.host, port=settings.server.port)
