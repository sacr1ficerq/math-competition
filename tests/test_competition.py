import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from app.api import lifespan, settings
from app.competition import CompetitionError, Store, match_score, score, snapshot
from app.config import Problem
from app.grading import GradeResponse, Verdict
from app.main import app
from test_grading import screenshot


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

    def test_tie_uses_finalization_instead_of_submission_times(self):
        self.start()
        self.submit(verdict=5, offset=1)
        self.submit("bob-token", verdict=5, offset=2)
        failed = self.submit(verdict=None, offset=3)
        self.store.complete(self.code, failed["id"], {"status": "failed", "attempts": 6, "error": "Failed"})
        self.store.finalize(self.code, "bob-token", self.now + 20)
        session = self.store.finalize(self.code, "alice-token", self.now + 21)
        self.assertEqual(session["result"]["winner"], session["players"][1]["id"])
        self.assertEqual(session["result"]["reason"], "Equal scores; earlier finalization wins.")

    def test_no_submissions_tie_is_decided_by_finalization(self):
        self.start()
        session = self.end()
        self.assertEqual(session["result"]["winner"], session["players"][0]["id"])

    def test_identical_submission_times_still_use_finalization(self):
        self.start()
        self.submit(verdict=5, offset=1)
        self.submit("bob-token", verdict=5, offset=1)
        session = self.end()
        self.assertEqual(session["result"]["winner"], session["players"][0]["id"])

    def test_identical_finalization_times_use_acceptance_order(self):
        self.start()
        self.submit(verdict=5, offset=1)
        self.submit("bob-token", verdict=5, offset=2)
        self.store.finalize(self.code, "alice-token", self.now + 20)
        session = self.store.finalize(self.code, "bob-token", self.now + 20)
        self.assertEqual(session["result"]["winner"], session["players"][0]["id"])
        self.assertEqual(session["result"]["reason"], "Equal scores; earlier finalization wins.")

    def test_same_clock_second_player_can_finalize_first(self):
        self.start()
        self.store.finalize(self.code, "bob-token", self.now + 20)
        session = self.store.finalize(self.code, "alice-token", self.now + 20)
        self.assertEqual(session["result"]["winner"], session["players"][1]["id"])

    def test_score_tie_ignores_submission_presence(self):
        self.start()
        self.submit(verdict=0)
        self.store.finalize(self.code, "bob-token", self.now + 20)
        session = self.store.finalize(self.code, "alice-token", self.now + 21)
        self.assertEqual(session["result"]["winner"], session["players"][1]["id"])

    def test_tie_uses_deadline_for_automatic_finalization(self):
        self.start()
        self.submit(verdict=5, offset=1)
        self.submit("bob-token", verdict=5, offset=2)
        session = self.store.finalize(self.code, "alice-token", self.now + 20)
        deadline = session["players"][1]["deadline"]
        with patch("app.competition.time.time", return_value=deadline + 50):
            session = self.store.read(self.code, "alice-token")
        self.assertEqual(session["players"][1]["finalized_at"], deadline)
        self.assertEqual(session["result"]["winner"], session["players"][0]["id"])

    def test_repeated_finalize_keeps_original_timestamp(self):
        self.start()
        self.store.finalize(self.code, "alice-token", self.now + 20)
        session = self.store.finalize(self.code, "alice-token", self.now + 21)
        self.assertEqual(session["players"][0]["finalized_at"], self.now + 20)

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

    def test_image_submissions_persist_and_idempotency_checks_images(self):
        self.start()
        images = [screenshot()]
        _, submission, created = self.store.submit(self.code, "alice-token", "", "image-once", images=images)
        self.assertTrue(created)
        reopened = Store(self.path)
        session, duplicate, created = reopened.submit(self.code, "alice-token", "", "image-once", images=images)
        self.assertFalse(created)
        self.assertEqual(duplicate["id"], submission["id"])
        self.assertEqual(session["players"][0]["submissions"][0]["images"], images)
        with self.assertRaises(CompetitionError):
            reopened.submit(self.code, "alice-token", "", "image-once", images=[screenshot("JPEG")])
        own = snapshot(session, "alice-token")["players"][0]["submissions"][0]
        self.assertEqual(own["images"][0]["name"], images[0]["name"])
        self.assertNotIn("base64", json.dumps(own))
        self.assertNotIn("images", snapshot(session, "bob-token")["players"][0]["submissions"][0])

    def test_in_flight_draft_save_after_finalization_cannot_unlock_submissions(self):
        self.start()
        self.store.finalize(self.code, "alice-token", self.now + 1)
        session = self.store.draft(self.code, "alice-token", "Latest unsubmitted draft", 0)
        self.assertTrue(session["players"][0]["finalized"])
        self.assertEqual(session["players"][0]["draft"], "Latest unsubmitted draft")
        with self.assertRaises(CompetitionError):
            self.store.submit(self.code, "alice-token", "Too late", "late", self.now + 2)

    def test_opponent_solutions_reveal_after_round_ends_but_drafts_stay_private(self):
        self.start()
        self.store.draft(self.code, "alice-token", "Unsubmitted private draft", 0)
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
        self.assertIn("Private proof", json.dumps(view))
        self.assertNotIn("Unsubmitted private draft", json.dumps(view))

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

    def test_solution_command_unlocks_after_both_finalize_while_grading_runs(self):
        with self.assertRaises(CompetitionError):
            self.store.chat(self.code, "alice-token", "/solution")
        self.start()
        submission = self.submit(verdict=None)
        with self.assertRaises(CompetitionError):
            self.store.chat(self.code, "bob-token", "/solution")
        self.store.finalize(self.code, "alice-token", self.now + 20)
        with self.assertRaises(CompetitionError):
            self.store.chat(self.code, "alice-token", "/solution")
        self.store.finalize(self.code, "bob-token", self.now + 21)
        session = self.store.chat(self.code, "bob-token", " /SOLUTION ")
        self.assertEqual(session["phase"], "grading")
        self.assertEqual(len(session["chat"]), 2)
        reply = session["chat"][-1]
        self.assertEqual(reply["kind"], "solution")
        self.assertEqual(reply["round"], 1)
        self.assertIsNone(reply["player_id"])
        self.assertEqual(reply["text"], PROBLEM.reference_solution)
        with self.assertRaises(CompetitionError):
            self.store.chat(self.code, "outsider", "/solution")
        self.store.complete(self.code, submission["id"], outcome())
        reopened = Store(self.path).read(self.code, "alice-token")
        self.assertEqual(snapshot(reopened, "alice-token")["chat"][-1], reply)
        self.store.rematch(self.code, "bob-token", 1)
        self.store.rematch(self.code, "alice-token", 1)
        with self.assertRaises(CompetitionError):
            self.store.chat(self.code, "bob-token", "/solution")
        self.assertEqual(self.store.read(self.code, "bob-token")["chat"][-1], reply)

    def test_solution_command_unlocks_when_second_player_auto_finalizes(self):
        self.start()
        self.submit("bob-token", verdict=None)
        session = self.store.finalize(self.code, "alice-token", self.now + 20)
        deadline = session["players"][1]["deadline"]
        with patch("app.competition.time.time", return_value=deadline):
            session = self.store.chat(self.code, "alice-token", "/solution")
        self.assertEqual(session["phase"], "grading")
        self.assertEqual(session["chat"][-1]["text"], PROBLEM.reference_solution)

    def test_solution_command_handles_missing_reference_and_chat_limit(self):
        self.start()
        self.end()
        with self.store.edit(self.code) as session:
            session["problem"]["reference_solution"] = ""
        with self.assertRaises(CompetitionError) as error:
            self.store.chat(self.code, "alice-token", "/solution")
        self.assertEqual(error.exception.status, 404)
        with self.store.edit(self.code) as session:
            session["problem"]["reference_solution"] = PROBLEM.reference_solution
            session["chat"] = [{"text": "Existing message"}] * 999
        with self.assertRaises(CompetitionError):
            self.store.chat(self.code, "alice-token", "/solution")
        self.assertEqual(len(self.store.read(self.code, "alice-token")["chat"]), 999)

    def test_rematch_keeps_identity_chat_history_and_resets_round_state(self):
        self.start()
        self.store.chat(self.code, "alice-token", "Rematch next?")
        self.store.draft(self.code, "alice-token", "Private draft", 0)
        self.submit(verdict=9)
        self.submit("bob-token", verdict=8)
        finished = self.end()
        ids = [p["id"] for p in finished["players"]]
        self.store.rematch(self.code, "alice-token", 1)
        session = self.store.rematch(self.code, "bob-token", 1)
        self.assertEqual(session["code"], self.code)
        self.assertEqual(session["round"], 2)
        self.assertEqual(session["phase"], "lobby")
        self.assertEqual([p["id"] for p in session["players"]], ids)
        self.assertEqual(session["chat"][0]["text"], "Rematch next?")
        self.assertEqual(session["rounds"][0]["result"], finished["result"])
        self.assertEqual(session["rounds"][0]["players"][0]["draft"], "Private draft")
        for player in session["players"]:
            self.assertFalse(player["ready"])
            self.assertFalse(player["finalized"])
            self.assertIsNone(player["deadline"])
            self.assertIsNone(player["finalized_at"])
            self.assertEqual(player["draft"], "")
            self.assertEqual(player["submissions"], [])
            self.assertEqual(score(player)["score"], 0)
        view = snapshot(session, "bob-token")
        self.assertIsNone(view["problem"])
        self.assertEqual([p["wins"] for p in view["players"]], [1, 0])
        self.assertNotIn("Private proof", json.dumps(view))
        reopened = Store(self.path).read(self.code, "bob-token")
        self.assertEqual(reopened["rounds"], session["rounds"])
        self.assertEqual(match_score(reopened)["wins"], {ids[0]: 1, ids[1]: 0})

    def test_rematch_retries_and_both_players_click_reset_only_once(self):
        self.start()
        self.end()
        self.store.rematch(self.code, "bob-token", 1)
        self.store.rematch(self.code, "alice-token", 1)
        self.store.ready(self.code, "alice-token", True, round=2)
        session = self.store.rematch(self.code, "bob-token", 1)
        self.assertEqual(session["round"], 2)
        self.assertEqual(len(session["rounds"]), 1)
        self.assertTrue(session["players"][0]["ready"])
        self.assertEqual(match_score(session)["completed_rounds"], 1)

    def test_rematch_waits_for_pending_grading_and_requires_membership(self):
        with self.assertRaises(CompetitionError):
            self.store.rematch(self.code, "alice-token", 1)
        self.start()
        submission = self.submit(verdict=None)
        self.end()
        with self.assertRaises(CompetitionError):
            self.store.rematch(self.code, "alice-token", 1)
        self.store.complete(self.code, submission["id"], outcome())
        with self.assertRaises(CompetitionError) as error:
            self.store.rematch(self.code, "outsider", 1)
        self.assertEqual(error.exception.status, 403)
        self.assertEqual(self.store.rematch(self.code, "alice-token", 1)["round"], 1)
        self.assertEqual(self.store.rematch(self.code, "bob-token", 1)["round"], 2)
        self.store.complete(self.code, submission["id"], outcome(0))
        self.assertEqual(match_score(self.store.read(self.code, "alice-token"))["completed_rounds"], 1)

    def test_wins_are_counted_once_across_three_rounds(self):
        self.start()
        self.submit(verdict=9)
        self.submit("bob-token", verdict=8)
        self.end()
        self.store.rematch(self.code, "bob-token", 1)
        self.store.rematch(self.code, "alice-token", 1)
        self.start()
        self.submit(verdict=7)
        self.submit("bob-token", verdict=10)
        self.end()
        self.store.rematch(self.code, "alice-token", 2)
        self.store.rematch(self.code, "bob-token", 2)
        self.start()
        self.submit(verdict=5)
        self.submit("bob-token", verdict=5)
        self.store.finalize(self.code, "alice-token", self.now + 20)
        self.store.finalize(self.code, "bob-token", self.now + 20)
        for _ in range(3):
            session = self.store.read(self.code, "alice-token")
            tally = match_score(session)
            self.assertEqual(list(tally["wins"].values()), [2, 1])
            self.assertEqual(tally["draws"], 0)
            self.assertEqual(tally["completed_rounds"], 3)
        self.store.rematch(self.code, "bob-token", 3)
        session = self.store.rematch(self.code, "alice-token", 3)
        self.assertEqual(match_score(session), tally)
        self.assertEqual(session["round"], 4)

    def test_stale_round_actions_and_draft_revisions_cannot_affect_rematch(self):
        self.start()
        self.end()
        self.store.rematch(self.code, "bob-token", 1)
        self.store.rematch(self.code, "alice-token", 1)
        for action in [
            lambda: self.store.ready(self.code, "alice-token", True, round=1),
            lambda: self.store.model(self.code, "alice-token", "new/model", round=1),
            lambda: self.store.draft(self.code, "alice-token", "Old draft", 0, round=1),
            lambda: self.store.submit(self.code, "alice-token", "Old proof", "old", round=1),
            lambda: self.store.finalize(self.code, "alice-token", round=1),
        ]:
            with self.assertRaises(CompetitionError):
                action()
        self.start()
        with self.assertRaises(CompetitionError):
            self.store.draft(self.code, "alice-token", "Old draft", 0, round=2)
        session = self.store.read(self.code, "alice-token")
        self.assertEqual(session["players"][0]["draft"], "")
        self.assertFalse(session["players"][0]["finalized"])

    def test_new_problem_is_creator_only_lobby_only_and_resets_readiness(self):
        self.start()
        self.end()
        self.store.rematch(self.code, "bob-token", 1)
        self.store.rematch(self.code, "alice-token", 1)
        self.store.ready(self.code, "bob-token", True, round=2)
        problem = PROBLEM.model_copy(update={"title": "Round two", "statement": "NEW_SECRET_STATEMENT"})
        with self.assertRaises(CompetitionError) as error:
            self.store.problem(self.code, "bob-token", problem, 2)
        self.assertEqual(error.exception.status, 403)
        session = self.store.problem(self.code, "alice-token", problem, 2)
        self.assertFalse(any(p["ready"] for p in session["players"]))
        self.assertNotIn("NEW_SECRET_STATEMENT", json.dumps(snapshot(session, "bob-token")))
        self.start()
        with self.assertRaises(CompetitionError):
            self.store.problem(self.code, "alice-token", PROBLEM, 2)
        self.assertEqual(self.store.read(self.code, "bob-token")["problem"]["title"], "Round two")

    def test_existing_finished_sessions_get_their_first_win_and_can_rematch(self):
        self.start()
        finished = self.end()
        finished.pop("round")
        finished.pop("rounds")
        with self.store.connection() as db:
            db.execute("UPDATE sessions SET state = ? WHERE code = ?", (json.dumps(finished), self.code))
        session = self.store.read(self.code, "alice-token")
        self.assertEqual(session["round"], 1)
        self.assertEqual(list(match_score(session)["wins"].values()), [1, 0])
        self.assertEqual(self.store.rematch(self.code, "alice-token", 1)["round"], 1)
        self.assertEqual(self.store.rematch(self.code, "bob-token", 1)["round"], 2)


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
            self.assertFalse(release.is_set())
            self.assertEqual(len(app.state.grading_tasks), 1)
            self.assertTrue(all(not task.done() and not task.cancelling() for task in app.state.grading_tasks))
            response = await self.bob.post(self.path + "/finalize")
            self.assertEqual(response.json()["phase"], "grading")
            self.assertNotIn("Private proof", response.text)
            self.assertTrue(all(not task.done() and not task.cancelling() for task in app.state.grading_tasks))
            release.set()
            await asyncio.gather(*list(app.state.grading_tasks))
        view = (await self.bob.get(self.path)).json()
        self.assertEqual(view["phase"], "finished")
        self.assertEqual(view["players"][0]["submissions"][0]["submitted_at"], accepted_at)
        self.assertIn("Private proof", json.dumps(view))
        self.assertIn("Hidden reasoning", json.dumps(view))
        response = await self.alice.post(self.path + "/submissions", json={"solution": "Too late", "request_id": "late"})
        self.assertEqual(response.status_code, 409)

    async def test_graceful_shutdown_waits_for_inflight_grading(self):
        await self.start()
        await self.alice.put("/api/key", json={"api_key": "test-secret"})
        started = asyncio.Event()
        release = asyncio.Event()

        async def fake_grade(request, problem, config):
            started.set()
            await release.wait()
            return GradeResponse(id="shutdown-grade", submitted_at="2026-10-10T12:00:00Z", status="graded", attempts=1, counted=True, grade=Verdict.model_validate(outcome()["grade"]))

        with patch("app.api.grade_solution", side_effect=fake_grade):
            response = await self.alice.post(self.path + "/submissions", json={"solution": "Proof", "request_id": "shutdown-once"})
            self.assertEqual(response.status_code, 202)
            await asyncio.wait_for(started.wait(), 2)
            await self.alice.post(self.path + "/finalize")
            await self.bob.post(self.path + "/finalize")
            with self.assertLogs("uvicorn.error", level="INFO") as logs:
                shutdown = asyncio.create_task(self.lifespan.__aexit__(None, None, None))
                try:
                    await asyncio.sleep(0.02)
                    self.assertFalse(shutdown.done())
                    self.assertTrue(all(not task.cancelling() for task in app.state.grading_tasks))
                finally:
                    release.set()
                    await asyncio.wait_for(shutdown, 2)
                self.assertTrue(any("waiting for 1 in-flight" in line for line in logs.output))
        self.lifespan = lifespan(app)
        await self.lifespan.__aenter__()
        view = (await self.alice.get(self.path)).json()
        self.assertEqual(view["phase"], "finished")
        self.assertEqual(view["players"][0]["submissions"][0]["status"], "graded")

    async def test_finalize_does_not_submit_unsubmitted_draft(self):
        await self.start()
        await self.alice.put(self.path + "/draft", json={"text": "Unsubmitted proof", "revision": 0})
        with patch("app.api.grade_solution") as grader, self.assertLogs("uvicorn.error", level="INFO") as logs:
            response = await self.alice.post(self.path + "/finalize")
            self.assertEqual(response.status_code, 200)
            grader.assert_not_called()
        self.assertEqual(response.json()["players"][0]["submissions"], [])
        self.assertTrue(any("submissions=0" in line for line in logs.output))

    async def test_submission_requires_key_and_hidden_feedback_on_api(self):
        await self.start()
        response = await self.alice.post(self.path + "/submissions", json={"solution": "Proof", "request_id": "first"})
        self.assertEqual(response.status_code, 400)
        response = await self.alice.put("/api/key", json={"api_key": "bad key with spaces"})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("bad key with spaces", response.text)

    async def test_image_submission_grading_and_finished_round_reveal(self):
        await self.start()
        await self.alice.put("/api/key", json={"api_key": "test-secret"})
        image = screenshot()

        async def fake_grade(request, problem, config):
            self.assertEqual(request.solution, "")
            self.assertEqual(request.images[0].model_dump(), image)
            return GradeResponse(id="image-grade", submitted_at="2026-10-10T12:00:00Z", status="graded", attempts=1, counted=True, grade=Verdict.model_validate(outcome()["grade"]))

        with patch("app.api.grade_solution", side_effect=fake_grade) as grader:
            response = await self.alice.post(self.path + "/submissions", json={"images": [image], "request_id": "image-once"})
            self.assertEqual(response.status_code, 202)
            await asyncio.gather(*list(app.state.grading_tasks))
            duplicate = await self.alice.post(self.path + "/submissions", json={"images": [image], "request_id": "image-once"})
            self.assertEqual(duplicate.status_code, 202)
            self.assertEqual(grader.call_count, 1)
        url = response.json()["players"][0]["submissions"][0]["images"][0]["url"]
        fetched = await self.alice.get(url)
        self.assertEqual(fetched.status_code, 200)
        self.assertEqual(fetched.headers["content-type"], "image/png")
        self.assertEqual(fetched.headers["cache-control"], "no-store")
        self.assertTrue(fetched.content.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual((await self.bob.get(url)).status_code, 404)
        self.assertEqual((await self.alice.get(url.rsplit("/", 1)[0] + "/-1")).status_code, 404)
        await self.alice.post(self.path + "/finalize")
        await self.bob.post(self.path + "/finalize")
        self.assertEqual((await self.bob.get(url)).status_code, 200)
        self.assertEqual((await self.alice.get(url)).status_code, 200)
        bob_view = (await self.bob.get(self.path)).json()
        self.assertEqual(bob_view["players"][0]["submissions"][0]["images"][0]["url"], url)

    async def test_opponent_images_wait_for_grading_and_require_membership(self):
        await self.start()
        token = self.alice.cookies["math_player"]
        image = screenshot()
        _, submission, _ = app.state.store.submit(self.code, token, "Screenshot proof", "pending-image", images=[image])
        url = (await self.alice.get(self.path)).json()["players"][0]["submissions"][0]["images"][0]["url"]
        await self.alice.post(self.path + "/finalize")
        view = (await self.bob.post(self.path + "/finalize")).json()
        self.assertEqual(view["phase"], "grading")
        self.assertNotIn("solution", view["players"][0]["submissions"][0])
        self.assertNotIn("images", view["players"][0]["submissions"][0])
        self.assertEqual((await self.bob.get(url)).status_code, 404)
        app.state.store.complete(self.code, submission["id"], outcome())
        self.assertEqual((await self.bob.get(url)).status_code, 200)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as outsider:
            self.assertEqual((await outsider.get(url)).status_code, 401)
            outsider.cookies.set("math_player", "outsider-token")
            self.assertEqual((await outsider.get(url)).status_code, 403)

    async def test_invalid_screenshots_are_rejected_without_creating_submissions(self):
        await self.start()
        await self.alice.put("/api/key", json={"api_key": "test-secret"})
        with patch("app.api.grade_solution") as grader:
            for images in [[{"data_url": "data:image/png;base64,aW52YWxpZA=="}], [screenshot()] * 5]:
                response = await self.alice.post(self.path + "/submissions", json={"images": images, "request_id": "invalid"})
                self.assertEqual(response.status_code, 422)
            grader.assert_not_called()
        view = (await self.alice.get(self.path)).json()
        self.assertEqual(view["players"][0]["submissions"], [])

    async def test_rematch_api_mutual_consent_default_and_withdrawal(self):
        await self.start()
        await self.alice.post(self.path + "/finalize")
        await self.bob.post(self.path + "/finalize")
        for _ in range(2):
            response = await self.alice.post(self.path + "/rematch", json={"round": 1})
            self.assertEqual(response.status_code, 200)
            view = response.json()
            self.assertEqual((view["round"], view["phase"]), (1, "finished"))
            self.assertEqual([p["next_round_ready"] for p in view["players"]], [True, False])
            self.assertEqual(view["previous_rounds"], [])
        withdrawn = await self.alice.post(self.path + "/rematch", json={"round": 1, "ready": False})
        self.assertEqual(withdrawn.status_code, 200)
        self.assertFalse(withdrawn.json()["players"][0]["next_round_ready"])
        waiting = await self.bob.post(self.path + "/rematch", json={"round": 1, "ready": True})
        self.assertEqual(waiting.json()["round"], 1)
        started = await self.alice.post(self.path + "/rematch", json={"round": 1, "ready": True})
        self.assertEqual((started.json()["round"], started.json()["phase"]), (2, "lobby"))
        self.assertFalse(any(p["next_round_ready"] for p in started.json()["players"]))
        stale = await self.bob.post(self.path + "/rematch", json={"round": 1, "ready": False})
        self.assertEqual(stale.json()["round"], 2)
        self.assertEqual(len(stale.json()["previous_rounds"]), 1)

    async def test_rematch_preserves_cookies_and_revealed_archived_solutions(self):
        await self.start()
        await self.alice.put("/api/key", json={"api_key": "test-secret"})
        await self.bob.put("/api/key", json={"api_key": "bob-secret"})
        token = self.alice.cookies["math_player"]
        image = screenshot()
        _, submission, _ = app.state.store.submit(self.code, token, "Private round one proof", "round-one", images=[image])
        app.state.store.complete(self.code, submission["id"], outcome())
        await self.alice.post(self.path + "/finalize")
        finished = (await self.bob.post(self.path + "/finalize")).json()
        image_url = (await self.alice.get(self.path)).json()["players"][0]["submissions"][0]["images"][0]["url"]
        consent = await self.alice.post(self.path + "/rematch", json={"round": 1})
        self.assertEqual(consent.json()["round"], 1)
        self.assertTrue(consent.json()["players"][0]["next_round_ready"])
        response = await self.bob.post(self.path + "/rematch", json={"round": 1})
        self.assertEqual(response.status_code, 200)
        view = response.json()
        self.assertEqual(view["round"], 2)
        self.assertEqual(view["phase"], "lobby")
        self.assertEqual([p["id"] for p in view["players"]], [p["id"] for p in finished["players"]])
        self.assertTrue(view["has_api_key"])
        self.assertTrue((await self.alice.get(self.path)).json()["has_api_key"])
        self.assertEqual(self.alice.cookies["math_player"], token)
        self.assertEqual([p["wins"] for p in view["players"]], [1, 0])
        own = await self.alice.get(self.path + "/rounds/1")
        opponent = await self.bob.get(self.path + "/rounds/1")
        self.assertEqual(own.status_code, 200)
        self.assertIn("Private round one proof", own.text)
        self.assertIn("Private round one proof", opponent.text)
        self.assertIn("Hidden reasoning", opponent.text)
        self.assertEqual((await self.alice.get(image_url)).status_code, 200)
        self.assertEqual((await self.bob.get(image_url)).status_code, 200)
        self.assertEqual((await self.alice.get(self.path + "/rounds/99")).status_code, 404)
        self.assertEqual((await self.alice.post(self.path + "/rematch", json={"round": 1})).json()["round"], 2)
        self.assertEqual((await self.alice.put(self.path + "/ready", json={"ready": True})).status_code, 409)
        await self.alice.put(self.path + "/ready", json={"ready": True, "round": 2})
        active = await self.bob.put(self.path + "/ready", json={"ready": True, "round": 2})
        self.assertEqual(active.json()["phase"], "active")
        self.assertEqual((await self.alice.post(self.path + "/finalize", json={"round": 1})).status_code, 409)


if __name__ == "__main__":
    unittest.main()
