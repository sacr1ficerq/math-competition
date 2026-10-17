"""Public metadata only; practice statement access explicitly records exposure."""
from fastapi import APIRouter, HTTPException, Request

from app.problem_bank import ProblemBankError


def create_problem_router(identity_resolver=None):
    router = APIRouter(prefix="/api/problems")

    def bank(request):
        return request.app.state.problem_bank

    def keys(request):
        if identity_resolver is None:
            return ()
        try:
            value = identity_resolver(request)
        except HTTPException as error:
            if error.status_code == 401:
                return ()
            raise
        return (value,) if value else ()

    @router.get("/topics")
    def topics(request: Request):
        return {"topics": bank(request).topics(keys(request))}

    @router.get("")
    def catalog(request: Request, topic: str | None = None):
        return {"problems": bank(request).catalog(keys(request), topic)}

    @router.post("/{problem_id}/practice")
    def practice(problem_id: str, request: Request):
        participants = keys(request)
        if not participants:
            raise HTTPException(401, "Sign in before revealing a practice problem.")
        try:
            return bank(request).reveal_practice(participants[0], problem_id)
        except ProblemBankError as error:
            raise HTTPException(error.status, error.message) from error

    return router
