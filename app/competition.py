"""Persistent, atomic competition transitions. No API keys are stored here."""

import hashlib
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from copy import deepcopy
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

from app.config import Problem


class CompetitionError(Exception):
    def __init__(self, message: str, status: int = 409):
        self.message = message
        self.status = status
        super().__init__(message)


def identity(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def score(player: dict) -> dict:
    counted = [s for s in player["submissions"] if s["status"] == "graded"]
    best = max((Decimal(str(s["grade"]["verdict"])) for s in counted), default=Decimal(0))
    penalty = max(0, len(counted) - 1)
    return {"best": float(best), "counted": len(counted), "penalty": penalty, "score": float(best - penalty)}


def match_score(session: dict) -> dict:
    results = [r["result"] for r in session.get("rounds", [])]
    if session["phase"] == "finished":
        results.append(session["result"])
    return {
        "wins": {p["id"]: sum(r["winner"] == p["id"] for r in results) for p in session["players"]},
        "draws": sum(r["winner"] is None for r in results),
        "completed_rounds": len(results),
    }


def reconcile(session: dict, now: float) -> None:
    if session["phase"] not in ("active", "grading"):
        return
    for player in session["players"]:
        if not player["finalized"] and player["deadline"] is not None and now >= player["deadline"]:
            player["finalized"] = True
            player["finalized_at"] = player["deadline"]
    if not all(p["finalized"] for p in session["players"]):
        return
    session["phase"] = "grading"
    if any(s["status"] == "pending" for p in session["players"] for s in p["submissions"]):
        return
    first, second = session["players"]
    a, b = score(first)["score"], score(second)["score"]
    winner = None
    reason = "Equal scores and identical finalization times: draw."
    if a != b:
        winner = first["id"] if a > b else second["id"]
        reason = "Higher final score."
    else:
        if first["finalized_at"] != second["finalized_at"]:
            winner = first["id"] if first["finalized_at"] < second["finalized_at"] else second["id"]
            reason = "Equal scores; earlier finalization wins."
    session["phase"] = "finished"
    session["ended_at"] = now
    session["result"] = {"winner": winner, "reason": reason}


class Store:
    def __init__(self, path: Path | str):
        self.path = str(path)
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS sessions (code TEXT PRIMARY KEY, state TEXT NOT NULL)")

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    @contextmanager
    def edit(self, code: str, now: float | None = None):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT state FROM sessions WHERE code = ?", (code.upper(),)).fetchone()
            if row is None:
                raise CompetitionError("Session not found. Check your invite code.", 404)
            session = json.loads(row[0])
            session.setdefault("round", 1)
            session.setdefault("rounds", [])
            reconcile(session, time.time() if now is None else now)
            yield session
            session["version"] += 1
            db.execute("UPDATE sessions SET state = ? WHERE code = ?", (json.dumps(session), session["code"]))

    def create(self, token: str, name: str, problem: Problem, model: str) -> dict:
        code = secrets.token_hex(5).upper()
        session = {
            "version": 1,
            "round": 1, "rounds": [],
            "code": code, "model": model, "problem": problem.model_dump(),
            "phase": "lobby", "created_at": time.time(), "started_at": None,
            "ended_at": None, "result": None, "chat": [],
            "players": [self.new_player(token, name)],
        }
        with self.connection() as db:
            db.execute("INSERT INTO sessions VALUES (?, ?)", (code, json.dumps(session)))
        return session

    @staticmethod
    def new_player(token: str, name: str) -> dict:
        return {
            "id": str(uuid4()), "identity": identity(token), "name": name,
            "ready": False, "finalized": False, "finalized_at": None,
            "deadline": None, "draft": "", "draft_revision": 0, "submissions": [],
        }

    @staticmethod
    def player(session: dict, token: str) -> dict:
        found = next((p for p in session["players"] if p["identity"] == identity(token)), None)
        if found is None:
            raise CompetitionError("Join this session first.", 403)
        return found

    @staticmethod
    def check_round(session: dict, round: int | None):
        if round is not None and round != session["round"]:
            raise CompetitionError("The round changed. Refresh to continue in the current round.")

    def join(self, code: str, token: str, name: str) -> dict:
        with self.edit(code) as session:
            if any(p["identity"] == identity(token) for p in session["players"]):
                return session
            if len(session["players"]) >= 2:
                raise CompetitionError("This session already has two players.")
            if session["phase"] != "lobby":
                raise CompetitionError("This competition has already started.")
            session["players"].append(self.new_player(token, name))
            return session

    def read(self, code: str, token: str) -> dict:
        with self.edit(code) as session:
            self.player(session, token)
            return session

    def recent(self, token: str) -> list[dict]:
        digest = identity(token)
        with self.connection() as db:
            rows = db.execute("SELECT state FROM sessions").fetchall()
        sessions = [json.loads(row[0]) for row in rows]
        return [
            {"code": s["code"], "phase": s["phase"], "created_at": s["created_at"], "names": [p["name"] for p in s["players"]]}
            for s in sorted(sessions, key=lambda s: s["created_at"], reverse=True)
            if any(p["identity"] == digest for p in s["players"])
        ][:20]

    def ready(self, code: str, token: str, ready: bool, round: int | None = None) -> dict:
        with self.edit(code) as session:
            player = self.player(session, token)
            self.check_round(session, round)
            if session["phase"] != "lobby":
                raise CompetitionError("The competition has already started.")
            player["ready"] = ready
            if len(session["players"]) == 2 and all(p["ready"] for p in session["players"]):
                session["phase"] = "active"
                session["started_at"] = time.time()
            return session

    def model(self, code: str, token: str, model: str, round: int | None = None) -> dict:
        with self.edit(code) as session:
            player = self.player(session, token)
            self.check_round(session, round)
            if player["id"] != session["players"][0]["id"]:
                raise CompetitionError("Only the creator can change the model.", 403)
            if session["phase"] != "lobby":
                raise CompetitionError("The grading model is locked once the competition starts.")
            session["model"] = model
            for p in session["players"]:
                p["ready"] = False
            return session

    def problem(self, code: str, token: str, problem: Problem, round: int) -> dict:
        with self.edit(code) as session:
            player = self.player(session, token)
            self.check_round(session, round)
            if player["id"] != session["players"][0]["id"]:
                raise CompetitionError("Only the creator can change the problem.", 403)
            if session["phase"] != "lobby":
                raise CompetitionError("The problem is locked once the round starts.")
            session["problem"] = problem.model_dump()
            for p in session["players"]:
                p["ready"] = False
            return session

    def rematch(self, code: str, token: str, round: int) -> dict:
        with self.edit(code) as session:
            self.player(session, token)
            # Concurrent clicks/retries from the just-finished round reset only once.
            if round == session["round"] - 1:
                return session
            self.check_round(session, round)
            if session["phase"] != "finished":
                raise CompetitionError("Wait until the round and all pending grading have finished.")
            session["rounds"].append(deepcopy({
                key: session[key] for key in
                ("round", "model", "problem", "players", "started_at", "ended_at", "result")
            }))
            session["round"] += 1
            session.update(phase="lobby", started_at=None, ended_at=None, result=None)
            for p in session["players"]:
                p.update(ready=False, finalized=False, finalized_at=None, deadline=None,
                         draft="", draft_revision=p["draft_revision"] + 1, submissions=[])
            return session

    def draft(self, code: str, token: str, text: str, revision: int, round: int | None = None) -> dict:
        with self.edit(code) as session:
            player = self.player(session, token)
            self.check_round(session, round)
            if session["phase"] == "lobby":
                raise CompetitionError("The problem has not been revealed yet.")
            if revision != player["draft_revision"]:
                raise CompetitionError("Your draft changed in another tab. Reload to retrieve the saved draft.")
            player["draft"] = text
            player["draft_revision"] += 1
            return session

    def submit(self, code: str, token: str, solution: str, request_id: str, now: float | None = None, images: list[dict] | None = None, round: int | None = None) -> tuple[dict, dict, bool]:
        images = images or []
        now = time.time() if now is None else now
        with self.edit(code, now) as session:
            player = self.player(session, token)
            self.check_round(session, round)
            duplicate = next((s for s in player["submissions"] if s["request_id"] == request_id), None)
            if duplicate:
                if duplicate["solution"] != solution or duplicate.get("images", []) != images:
                    raise CompetitionError("This submission ID was already used for a different solution.")
                return session, duplicate, False
            if session["phase"] != "active" or player["finalized"]:
                raise CompetitionError("Your submissions are locked; the deadline may have expired.")
            submission = {
                "id": str(uuid4()), "request_id": request_id, "submitted_at": now,
                "solution": solution, "images": images, "status": "pending", "attempts": 0,
                "grade": None, "error": None,
            }
            player["submissions"].append(submission)
            return session, submission, True

    def finalize(self, code: str, token: str, now: float | None = None, round: int | None = None) -> dict:
        now = time.time() if now is None else now
        with self.edit(code, now) as session:
            player = self.player(session, token)
            self.check_round(session, round)
            if player["finalized"]:
                return session
            if session["phase"] != "active":
                raise CompetitionError("The competition is not accepting finalization.")
            player["finalized"] = True
            player["finalized_at"] = now
            other = next(p for p in session["players"] if p["id"] != player["id"])
            if not other["finalized"] and other["deadline"] is None:
                other["deadline"] = now + 300
            reconcile(session, now)
            return session

    def complete(self, code: str, submission_id: str, result: dict) -> None:
        with self.edit(code) as session:
            rounds = [session, *session["rounds"]]
            submission = next(s for r in rounds for p in r["players"] for s in p["submissions"] if s["id"] == submission_id)
            if submission["status"] != "pending":
                return
            submission.update({key: result.get(key) for key in ("status", "attempts", "grade", "error")})
            reconcile(session, time.time())

    def chat(self, code: str, token: str, text: str) -> dict:
        with self.edit(code) as session:
            player = self.player(session, token)
            solution_command = text.strip().lower() == "/solution"
            reference = None
            if solution_command:
                if len(session["players"]) != 2 or not all(p["finalized"] for p in session["players"]):
                    raise CompetitionError("The reference solution is available after both players finalize.")
                reference = session["problem"].get("reference_solution")
                if not reference or not reference.strip():
                    raise CompetitionError("No reference solution is available for this round.", 404)
            if len(session["chat"]) + (2 if solution_command else 1) > 1000:
                raise CompetitionError("This session has reached its 1,000-message limit.")
            session["chat"].append({"id": str(uuid4()), "player_id": player["id"], "text": text, "sent_at": time.time()})
            if solution_command:
                session["chat"].append({
                    "id": str(uuid4()), "player_id": None, "kind": "solution",
                    "round": session["round"], "text": reference, "sent_at": time.time(),
                })
            return session

    def tick(self, recover: bool = False) -> None:
        with self.connection() as db:
            codes = [row[0] for row in db.execute("SELECT code FROM sessions WHERE json_extract(state, '$.phase') IN ('active', 'grading')")]
        for code in codes:
            with self.edit(code) as session:
                if recover:
                    for p in session["players"]:
                        for s in p["submissions"]:
                            if s["status"] == "pending":
                                s.update(status="failed", error="Grading was interrupted by a server restart. No submission penalty was applied.")
                reconcile(session, time.time())


def snapshot(session: dict, token: str) -> dict:
    me = Store.player(session, token)
    finished = session["phase"] == "finished"
    tally = match_score(session)
    players = []
    for player in session["players"]:
        own = player["id"] == me["id"]
        history = []
        for s in player["submissions"]:
            item = {k: s[k] for k in ("id", "submitted_at", "status", "attempts", "error")}
            item["verdict"] = s["grade"]["verdict"] if s["grade"] else None
            if own or finished:
                item["solution"] = s["solution"]
                item["images"] = [
                    {"name": image["name"], "url": f'/api/sessions/{session["code"]}/submissions/{s["id"]}/images/{index}'}
                    for index, image in enumerate(s.get("images", []))
                ]
            if finished and s["grade"]:
                item["grade"] = s["grade"]
            history.append(item)
        public = {k: player[k] for k in ("id", "name", "ready", "finalized", "finalized_at", "deadline")}
        public.update(score=score(player), submissions=history, wins=tally["wins"][player["id"]])
        if own:
            public.update(draft=player["draft"], draft_revision=player["draft_revision"])
        players.append(public)
    problem = None
    if session["phase"] != "lobby":
        problem = {k: session["problem"][k] for k in ("title", "statement")}
        if finished:
            problem = session["problem"]
    return {
        "code": session["code"], "phase": session["phase"], "model": session["model"],
        "me": me["id"], "host": session["players"][0]["id"], "players": players,
        "problem": problem, "chat": session["chat"], "result": session["result"],
        "started_at": session["started_at"], "ended_at": session["ended_at"],
        "server_time": time.time(),
        "version": session["version"],
        "round": session.get("round", 1), "match": tally,
        "previous_rounds": [
            {"round": r["round"], "title": r["problem"]["title"], "ended_at": r["ended_at"], "result": r["result"],
             "scores": {p["id"]: score(p)["score"] for p in r["players"]}}
            for r in session.get("rounds", [])
        ],
    }
