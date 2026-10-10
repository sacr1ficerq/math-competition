import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from app.api import lifespan, settings
from app.competition import CompetitionError, Store, score, snapshot
from app.config import Problem
from app.grading import GradeResponse, Verdict
from app.main import app


PROBLEM = Problem(title="Secret problem", statement="Prove $x=x$.", criterions="Secret criteria", reference_solution="Secret reference")


def outcome(verdict=10):
    return {"status": "graded", "attempts": 1, "grade": {"verdict": verdict, "reasoning": "Hidden reasoning", "evidence": "Hidden evidence"}, "error": None}


class CompetitionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "sessions.sqlite3"
        self.store = Store(self.path)
        self.code = self.store.create("alice-token", "Alice", PROBLEM, "z-ai/glm-5.3-flash")["code"]
        self.store.join(self.code, "bob-token", "Bob")
        self.now = time.time()

    def start(self):
        self.store.ready(self.code, "alice-token", True)
        return self.store.ready(self.code, "bob-token", True)

    def submit(self, player="alice-token", verdict=10, offset=1, request_id=None):
        session, submission, _ = self.store.submit(self.code, player, "Private proof", request_id or str(offset), self.now + offset)
        if verdict is not None:
            self.store.complete(self.code, submission["id"], outcome(verdict))
        return submission

    def end(self):
        self.store.finalize(self.code, "alice-token", self.now + 20)
        return self.store.finalize(self.code, "bob-token", self.now + 21)

    def test_lobby_problem_is_hidden_until_both_ready(self):
        session = self.store.ready(self.code, "alice-token", True)
        self.assertIsNone(snapshot(session, "alice-token")["problem"])
        session = self.store.ready(self.code, "bob-token", True)
        view = snapshot(session, "bob-token")
        self.assertEqual(view["phase"], "active")
        self.assertEqual(set(view["problem"]), {"title", "statement"})
        self.assertNotIn("Secret criteria", json.dumps(view))
        self.assertNotIn("identity", json.dumps(view))

    def test_no_third_player_or_unauthorized_access(self):
        with self.assertRaises(CompetitionError):
            self.store.join(self.code, "third-token", "Third")
        with self.assertRaises(CompetitionError) as error:
            self.store.read(self.code, "third-token")
        self.assertEqual(error.exception.status, 403)
        self.assertEqual(len(self.store.join(self.code, "alice-token", "Ignored")["players"]), 2)

    def test_model_changes_reset_readiness_and_are_locked_after_start(self):
        self.store.ready(self.code, "bob-token", True)
        with self.assertRaises(CompetitionError):
            self.store.model(self.code, "bob-token", "another/model")
        session = self.store.model(self.code, "alice-token", "another/model")
        self.assertFalse(any(p["ready"] for p in session["players"]))
        self.start()
        with self.assertRaises(CompetitionError):
            self.store.model(self.code, "alice-token", "third/model")

    def test_draft_revision_and_private_persistent_reconnection(self):
        self.start()
        self.store.draft(self.code, "alice-token", "Unsubmitted private draft", 0)
        with self.assertRaises(CompetitionError):
            self.store.draft(self.code, "alice-token", "Stale draft", 0)
        reopened = Store(self.path)
        session = reopened.read(self.code, "alice-token")
        self.assertEqual(session["players"][0]["draft"], "Unsubmitted private draft")
        self.assertNotIn("Unsubmitted private draft", json.dumps(snapshot(session, "bob-token")))
        self.assertEqual(reopened.recent("alice-token")[0]["code"], self.code)

    def test_finalize_while_pending_waits_for_all_grades(self):
        self.start()
        submission = self.submit(verdict=None)
        session = self.end()
        self.assertEqual(session["phase"], "grading")
        self.assertIsNone(session["result"])
        self.store.complete(self.code, submission["id"], outcome())
        session = self.store.read(self.code, "alice-token")
        self.assertEqual(session["phase"], "finished")
        self.assertEqual(session["result"]["winner"], session["players"][0]["id"])
        self.assertEqual(session["players"][0]["submissions"][0]["submitted_at"], self.now + 1)

    def test_deadline_allows_earlier_submission_and_rejects_exact_expiry(self):
        self.start()
        session = self.store.finalize(self.code, "alice-token", self.now + 1)
        deadline = session["players"][1]["deadline"]
        self.assertEqual(deadline, self.now + 301)
        _, submission, _ = self.store.submit(self.code, "bob-token", "Eligible proof", "eligible", deadline - 0.001)
        self.store.complete(self.code, submission["id"], outcome(8))
        with self.assertRaises(CompetitionError):
            self.store.submit(self.code, "bob-token", "Too late", "late", deadline)
        with patch("app.competition.time.time", return_value=deadline + 10):
            self.store.tick()
            session = self.store.read(self.code, "bob-token")
        self.assertTrue(session["players"][1]["finalized"])
        self.assertEqual(session["players"][1]["finalized_at"], deadline)
        self.assertEqual(session["phase"], "finished")

    def test_expiry_with_pending_grade_waits_and_timestamp_stays_eligible(self):
        self.start()
        self.store.finalize(self.code, "alice-token", self.now + 1)
        submission = self.submit("bob-token", verdict=None, offset=300)
        with patch("app.competition.time.time", return_value=self.now + 302):
            session = self.store.read(self.code, "bob-token")
            self.assertEqual(session["phase"], "grading")
            self.store.complete(self.code, submission["id"], outcome(10))
        self.assertEqual(self.store.read(self.code, "bob-token")["phase"], "finished")

    def test_failed_grading_is_excluded_from_penalties(self):
        self.start()
        self.submit(verdict=7)
        failed = self.submit(verdict=None, offset=2)
        self.store.complete(self.code, failed["id"], {"status": "failed", "attempts": 6, "error": "Failed"})
        self.submit(verdict=8, offset=3)
        session = self.end()
        self.assertEqual(score(session["players"][0]), {"best": 8.0, "counted": 2, "penalty": 1, "score": 7.0})

    def test_zero_beats_negative_score(self):
        self.start()
        self.submit(verdict=0)
        self.submit(verdict=0, offset=2)
        session = self.end()
        self.assertEqual(score(session["players"][0])["score"], -1)
        self.assertEqual(session["result"]["winner"], session["players"][1]["id"])

    def test_tie_uses_last_successful_submission_and_excludes_failed(self):
        self.start()
        self.submit(verdict=5, offset=1)
        self.submit("bob-token", verdict=5, offset=2)
        failed = self.submit(verdict=None, offset=3)
        self.store.complete(self.code, failed["id"], {"status": "failed", "attempts": 6, "error": "Failed"})
        session = self.end()
        self.assertEqual(session["result"]["winner"], session["players"][0]["id"])

    def test_no_submissions_draw(self):
        self.start()
        self.assertIsNone(self.end()["result"]["winner"])

    def test_identical_successful_submission_times_draw(self):
        self.start()
        self.submit(verdict=5, offset=1)
        self.submit("bob-token", verdict=5, offset=1)
        self.assertIsNone(self.end()["result"]["winner"])

    def test_successful_zero_wins_tie_with_no_submission(self):
        self.start()
        self.submit(verdict=0)
        session = self.end()
        self.assertEqual(session["result"]["winner"], session["players"][0]["id"])

    def test_duplicate_requests_are_idempotent_even_after_finalization(self):
        self.start()
        submission = self.submit(verdict=None, request_id="same")
        self.store.submit(self.code, "alice-token", "Other", "different", self.now + 2)
        self.store.finalize(self.code, "alice-token", self.now + 3)
        session, duplicate, created = self.store.submit(self.code, "alice-token", "Private proof", "same", self.now + 4)
        self.assertEqual(duplicate["id"], submission["id"])
        self.assertFalse(created)
        self.assertEqual(len(session["players"][0]["submissions"]), 2)
        with self.assertRaises(CompetitionError):
            self.store.submit(self.code, "alice-token", "Changed proof", "same", self.now + 4)

    def test_multiple_pending_grades_finish_out_of_order_before_result(self):
        self.start()
        first = self.submit(verdict=None, offset=1)
        second = self.submit(verdict=None, offset=2)
        self.end()
        self.store.complete(self.code, second["id"], outcome(9))
        self.assertEqual(self.store.read(self.code, "alice-token")["phase"], "grading")
        self.store.complete(self.code, first["id"], outcome(10))
        session = self.store.read(self.code, "alice-token")
        self.assertEqual(session["phase"], "finished")
        self.assertEqual(score(session["players"][0])["score"], 9)

    def test_in_flight_draft_save_after_finalization_cannot_unlock_submissions(self):
        self.start()
        self.store.finalize(self.code, "alice-token", self.now + 1)
        session = self.store.draft(self.code, "alice-token", "Latest unsubmitted draft", 0)
        self.assertTrue(session["players"][0]["finalized"])
        self.assertEqual(session["players"][0]["draft"], "Latest unsubmitted draft")
        with self.assertRaises(CompetitionError):
            self.store.submit(self.code, "alice-token", "Too late", "late", self.now + 2)

    def test_feedback_is_delayed_and_opponent_solutions_never_exposed(self):
        self.start()
        self.submit()
        session = self.store.read(self.code, "bob-token")
        view = snapshot(session, "bob-token")
        self.assertNotIn("Hidden reasoning", json.dumps(view))
        self.assertNotIn("Private proof", json.dumps(view))
        self.assertEqual(view["players"][0]["submissions"][0]["verdict"], 10)
        session = self.end()
        view = snapshot(session, "bob-token")
        self.assertIn("Hidden reasoning", json.dumps(view))
        self.assertIn("Secret reference", json.dumps(view))
        self.assertNotIn("Private proof", json.dumps(view))

    def test_restart_recovers_pending_grading_without_penalty(self):
        self.start()
        self.submit(verdict=None)
        self.end()
        reopened = Store(self.path)
        reopened.tick(recover=True)
        session = reopened.read(self.code, "alice-token")
        self.assertEqual(session["phase"], "finished")
        self.assertEqual(score(session["players"][0])["counted"], 0)
        self.assertEqual(session["players"][0]["submissions"][0]["status"], "failed")

    def test_chat_is_shared_persistent_and_authenticated(self):
        self.store.chat(self.code, "alice-token", "Hello Bob!")
        session = Store(self.path).read(self.code, "bob-token")
        self.assertEqual(snapshot(session, "bob-token")["chat"][0]["text"], "Hello Bob!")
        with self.assertRaises(CompetitionError):
            self.store.chat(self.code, "outsider", "No")


class SessionApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.override = patch.object(settings, "database", str(Path(self.temp.name) / "test.sqlite3"))
        self.override.start()
        self.addCleanup(self.override.stop)
        self.lifespan = lifespan(app)
        await self.lifespan.__aenter__()
        self.alice = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")
        self.bob = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")
        response = await self.alice.post("/api/sessions", json={"name": "Alice", "problem": PROBLEM.model_dump()})
        self.assertEqual(response.status_code, 201)
        self.code = response.json()["code"]
        self.create_cookie = response.headers["set-cookie"]
        self.path = f"/api/sessions/{self.code}"

    async def asyncTearDown(self):
        await self.alice.aclose()
        await self.bob.aclose()
        await self.lifespan.__aexit__(None, None, None)

    async def start(self):
        await self.bob.post(self.path + "/join", json={"name": "Bob"})
        await self.alice.put(self.path + "/ready", json={"ready": True})
        await self.bob.put(self.path + "/ready", json={"ready": True})

    async def test_cookie_identity_key_privacy_and_cross_origin_checks(self):
        self.assertIn("HttpOnly", self.create_cookie)
        response = await self.alice.put("/api/key", json={"api_key": "test-secret"})
        self.assertIn("HttpOnly", response.headers["set-cookie"])
        self.assertIn("SameSite=strict", response.headers["set-cookie"])
        state = (await self.alice.get(self.path)).json()
        self.assertTrue(state["has_api_key"])
        self.assertNotIn("test-secret", json.dumps(state))
        self.assertNotIn("test-secret", json.dumps(app.state.store.read(self.code, self.alice.cookies["math_player"])))
        response = await self.alice.post(self.path + "/finalize", headers={"Origin": "http://other.example"})
        self.assertEqual(response.status_code, 403)
        response = await self.bob.get(self.path)
        self.assertEqual(response.status_code, 401)
        await self.alice.delete("/api/key")
        self.assertFalse((await self.alice.get(self.path)).json()["has_api_key"])

    async def test_background_grading_and_finalization_integration(self):
        await self.start()
        await self.alice.put("/api/key", json={"api_key": "test-secret"})
        release = asyncio.Event()
        started = asyncio.Event()

        async def fake_grade(request, problem, config):
            self.assertEqual(request.api_key, "test-secret")
            self.assertEqual(config.model, "z-ai/glm-5.3-flash")
            self.assertEqual(problem.reference_solution, "Secret reference")
            started.set()
            await release.wait()
            return GradeResponse(id="grade", submitted_at="2026-10-10T12:00:00Z", status="graded", attempts=1, counted=True, grade=Verdict.model_validate(outcome()["grade"]))

        with patch("app.api.grade_solution", side_effect=fake_grade) as grader:
            response = await self.alice.post(self.path + "/submissions", json={"solution": "Private proof", "request_id": "once"})
            self.assertEqual(response.status_code, 202)
            accepted_at = response.json()["players"][0]["submissions"][0]["submitted_at"]
            await asyncio.wait_for(started.wait(), 2)
            await self.alice.post(self.path + "/submissions", json={"solution": "Private proof", "request_id": "once"})
            self.assertEqual(grader.call_count, 1)
            await self.alice.post(self.path + "/finalize")
            response = await self.bob.post(self.path + "/finalize")
            self.assertEqual(response.json()["phase"], "grading")
            release.set()
            await asyncio.gather(*list(app.state.grading_tasks))
        view = (await self.bob.get(self.path)).json()
        self.assertEqual(view["phase"], "finished")
        self.assertEqual(view["players"][0]["submissions"][0]["submitted_at"], accepted_at)
        self.assertNotIn("Private proof", json.dumps(view))
        self.assertIn("Hidden reasoning", json.dumps(view))
        response = await self.alice.post(self.path + "/submissions", json={"solution": "Too late", "request_id": "late"})
        self.assertEqual(response.status_code, 409)

    async def test_submission_requires_key_and_hidden_feedback_on_api(self):
        await self.start()
        response = await self.alice.post(self.path + "/submissions", json={"solution": "Proof", "request_id": "first"})
        self.assertEqual(response.status_code, 400)
        response = await self.alice.put("/api/key", json={"api_key": "bad key with spaces"})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("bad key with spaces", response.text)


if __name__ == "__main__":
    unittest.main()
