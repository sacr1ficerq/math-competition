from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field


ROOT = Path(__file__).resolve().parent.parent


class Problem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=300)
    statement: str = Field(min_length=1, max_length=30_000)
    criterions: str = Field(min_length=1, max_length=30_000)
    reference_solution: str = Field(min_length=1, max_length=30_000)


class ServerConfig(BaseModel):
    host: str = "127.0.0.1"
    port: int = Field(default=9000, ge=1, le=65535)


class GradingConfig(BaseModel):
    model: str = Field(default="z-ai/glm-5.3-flash", min_length=1)
    proxy: str | None = None
    timeout_seconds: float = Field(default=60, gt=0)
    retry_delay_seconds: float = Field(default=1, ge=0, le=30)


class Settings(BaseModel):
    server: ServerConfig = Field(default_factory=ServerConfig)
    grading: GradingConfig = Field(default_factory=GradingConfig)
    problem: Problem
    database: str = "competition.sqlite3"


def load_settings(path: Path = ROOT / "config.yaml") -> Settings:
    with path.open(encoding="utf-8") as file:
        return Settings.model_validate(yaml.safe_load(file))
