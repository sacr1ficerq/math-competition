"""Cookie authentication and account helpers shared by API routers."""
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, StringConstraints

from app.accounts import AccountStore, SESSION_SECONDS

ModelName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200, pattern=r"^[\w.:-]+/[\w.:-]+$")]

AUTH_COOKIE = "math_auth"
router = APIRouter(prefix="/api/auth")


def init_accounts(app, secret_path=None):
    app.state.accounts = AccountStore(app.state.store.path, secret_path)


def current_account(request: Request):
    if not hasattr(request.state, "account"):
        request.state.account = request.app.state.accounts.authenticate(request.cookies.get(AUTH_COOKIE))
    return request.state.account


def require_account(request: Request):
    account = current_account(request)
    if account is None:
        raise HTTPException(401, "Sign in to your account first.")
    return account


def resolve_identity(request: Request) -> str | None:
    account = current_account(request)
    if account:
        return account["player_token"]
    legacy = request.cookies.get("math_player")
    if legacy and request.app.state.accounts.is_account_identity(legacy):
        return None
    return legacy


competition_token = resolve_identity


def saved_api_key(request: Request) -> str | None:
    account = current_account(request)
    return request.app.state.accounts.get_key(account["id"]) if account else None


def has_api_key(request: Request) -> bool:
    account = current_account(request)
    return bool(account and account["api_key"])


class RegisterRequest(BaseModel):
    login: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")
    display_name: str = Field(min_length=1, max_length=40, pattern=r"\S")
    password: str = Field(min_length=8, max_length=1024)


class LoginRequest(BaseModel):
    login: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=1024)


class KeyRequest(BaseModel):
    api_key: str = Field(min_length=1, max_length=512, pattern=r"^[\x21-\x7e]+$")


def authenticated_response(request, response, result):
    account, raw = result
    # Replace browser identity with the canonical one; logout clears it to protect
    # account-owned duels from continued anonymous access on shared devices.
    for name, value in [(AUTH_COOKIE, raw), ("math_player", account["player_token"])]:
        response.set_cookie(name, value, max_age=SESSION_SECONDS, httponly=True,
                            samesite="strict", secure=request.url.scheme == "https")
    response.delete_cookie("math_openrouter_key")
    return {"user": AccountStore.public(account)}


@router.post("/register", status_code=201)
def register(body: RegisterRequest, request: Request, response: Response):
    return authenticated_response(request, response, request.app.state.accounts.register(
        body.login, body.display_name.strip(), body.password, request.cookies.get("math_player")))


@router.post("/login")
def login(body: LoginRequest, request: Request, response: Response):
    return authenticated_response(request, response, request.app.state.accounts.login(
        body.login, body.password, request.cookies.get("math_player")))


@router.post("/logout")
def logout(request: Request, response: Response):
    request.app.state.accounts.logout(request.cookies.get(AUTH_COOKIE))
    for name in [AUTH_COOKIE, "math_player", "math_openrouter_key"]:
        response.delete_cookie(name)
    return {"user": None}


@router.get("/me")
def me(request: Request):
    account = current_account(request)
    return {"user": AccountStore.public(account) if account else None}


@router.put("/key")
def save_key(body: KeyRequest, request: Request, response: Response):
    account = require_account(request)
    request.app.state.accounts.set_key(account["id"], body.api_key)
    response.delete_cookie("math_openrouter_key")
    return {"has_api_key": True}


@router.delete("/key")
def delete_key(request: Request, response: Response):
    account = require_account(request)
    request.app.state.accounts.set_key(account["id"], None)
    response.delete_cookie("math_openrouter_key")
    return {"has_api_key": False}


class PreferencesRequest(BaseModel):
    default_model: ModelName


@router.put("/preferences")
def preferences(body: PreferencesRequest, request: Request):
    account = require_account(request)
    updated = request.app.state.accounts.set_default_model(account["id"], body.default_model)
    return {"user": AccountStore.public(updated)}
