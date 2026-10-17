import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app.api import lifespan, run_appeal, settings
from app.main import app
from app.competition import CompetitionError, Store, match_score, score, snapshot
from app.config import GradingConfig, Problem
from app.grading import AppealGradeRequest, GradeResponse, Verdict, grade_appeal
from test_grading import screenshot

PROBLEM = Problem(title="P", statement="Question", criterions="Criteria", reference_solution="Reference")


def result(verdict):
    return {"status": "graded", "attempts": 1, "grade": {"verdict": verdict, "reasoning": "Private review", "evidence": "Specific evidence"}, "error": None}


class AppealTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / "duels.sqlite3")
        self.new_duel()
        self.submission = self.submit("alice", 5)
        self.other = self.submit("bob", 6)

    def new_duel(self):
        self.code = self.store.create("alice", "Alice", PROBLEM, "openai/test")["code"]
        self.store.join(self.code, "bob", "Bob")
        self.store.ready(self.code, "alice", True)
        self.store.ready(self.code, "bob", True)

    def submit(self, token, verdict):
        _, submission, _ = self.store.submit(self.code, token, "Original proof", str(time.time_ns()))
        self.store.complete(self.code, submission["id"], result(verdict))
        return submission

    def appeal(self, request_id="appeal", reason="The original proof covers this.", token="alice", sid=None):
        return self.store.appeal(self.code, token, sid or self.submission["id"], reason, request_id, 1)

    def finish(self):
        self.store.finalize(self.code, "alice", now=100)
        return self.store.finalize(self.code, "bob", now=101)

    def test_higher_verdict_adopted_original_unchanged_one_slot(self):
        self.finish()
        original = deepcopy(self.store.read(self.code, "alice")["players"][0]["submissions"][0])
        _, _, appeal, _ = self.appeal()
        self.store.complete_appeal(self.code, original["id"], appeal["id"], result(8))
        state = self.store.read(self.code, "alice")
        current = state["players"][0]["submissions"][0]
        for field in ("grade", "solution", "submitted_at", "status", "request_id"):
            self.assertEqual(current[field], original[field])
        self.assertEqual(current["effective_verdict"], 8)
        self.assertEqual(score(state["players"][0]), {"best": 8, "counted": 1, "penalty": 0, "score": 8})
        with self.assertRaises(CompetitionError):
            self.appeal("second")
        self.store.complete_appeal(self.code, original["id"], appeal["id"], result(1))
        self.assertEqual(score(self.store.read(self.code, "alice")["players"][0])["score"], 8)

    def test_equal_and_lower_penalize_exactly_one_including_zero(self):
        for old, proposed in [(5, 5), (5, 2), (0, 0), (10, 10)]:
            with self.subTest(old=old, proposed=proposed):
                self.new_duel()
                submission = self.submit("alice", old)
                self.submit("bob", 6)
                self.finish()
                _, _, appeal, _ = self.appeal(str(old)+str(proposed), sid=submission["id"])
                self.store.complete_appeal(self.code, submission["id"], appeal["id"], result(proposed))
                actual = next(s for s in self.store.read(self.code, "alice")["players"][0]["submissions"] if s["id"] == submission["id"])
                self.assertEqual(actual["effective_verdict"], old - 1)
        self.assertEqual(score({"submissions": [{"status": "graded", "grade": {"verdict": 0}, "effective_verdict": -1}]} )["score"], -1)

    def test_duplicate_and_concurrent_requests_do_not_create_extra_jobs(self):
        self.finish()
        def submit(_):
            return self.appeal()[3]
        with ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(sum(pool.map(submit, range(8))), 1)
        with self.assertRaises(CompetitionError):
            self.appeal(reason="Changed argument")
        with self.assertRaises(CompetitionError):
            self.appeal("new-pending")
        with self.assertRaises(CompetitionError):
            self.appeal(token="bob")

    def test_declined_appeal_decrement_and_repeat_penalty_count_once(self):
        self.submit("alice", 2)
        self.finish()
        _, _, appeal, _ = self.appeal()
        self.store.complete_appeal(self.code, self.submission["id"], appeal["id"], result(5))
        state = self.store.read(self.code, "alice")
        self.assertEqual(score(state["players"][0]), {"best":4, "counted":2, "penalty":1, "score":3})
        target = snapshot(state, "alice")["players"][0]["submissions"][0]
        self.assertEqual((target["original_verdict"], target["verdict"]), (5, 4))
        self.assertEqual((target["appeal"]["old_verdict"], target["appeal"]["effective_verdict"]), (5, 4))
        self.assertEqual(target["grade"]["verdict"], 5)

    def test_declined_appeal_keeps_another_better_submission_score(self):
        self.submit("alice", 8)
        self.finish()
        _, _, appeal, _ = self.appeal()
        self.store.complete_appeal(self.code, self.submission["id"], appeal["id"], result(5))
        state = self.store.read(self.code, "alice")
        self.assertEqual(score(state["players"][0]), {"best":8, "counted":2, "penalty":1, "score":7})
        self.assertEqual(state["players"][0]["submissions"][0]["effective_verdict"], 4)

    def test_one_budget_across_all_submissions_with_independent_opponent_budget(self):
        second = self.submit("alice", 7)
        self.finish()
        initial = self.store.read(self.code, "alice")
        self.assertTrue(all(s["appeal_eligible"] for s in snapshot(initial, "alice")["players"][0]["submissions"]))
        state, _, appeal, created = self.appeal(sid=second["id"])
        self.assertTrue(created)
        self.assertFalse(any(s["appeal_eligible"] for s in snapshot(state, "alice")["players"][0]["submissions"]))
        self.assertTrue(snapshot(state, "bob")["players"][1]["submissions"][0]["appeal_eligible"])
        with self.assertRaises(CompetitionError):
            self.appeal("another-target", sid=self.submission["id"])
        duplicate = self.appeal(sid=second["id"])
        self.assertFalse(duplicate[3])
        self.assertEqual(duplicate[2]["id"], appeal["id"])
        self.store.complete_appeal(self.code, second["id"], appeal["id"], result(8))
        self.assertFalse(self.appeal(sid=second["id"])[3])
        with self.assertRaises(CompetitionError):
            self.appeal("after-decision", sid=self.submission["id"])
        state, _, _, created = self.appeal("bob-independent", token="bob", sid=self.other["id"])
        self.assertTrue(created)
        self.assertFalse(any(s["appeal_eligible"] for s in snapshot(state, "alice")["players"][0]["submissions"]))

    def test_concurrent_appeals_on_different_submissions_share_one_budget(self):
        second = self.submit("alice", 7)
        self.finish()
        targets = [self.submission["id"], second["id"]]
        def submit(index):
            target, request = targets[index % 2], f"race-{index}"
            try:
                accepted = self.appeal(request, sid=target)
                return target, request, accepted[2]["id"]
            except CompetitionError as error:
                self.assertEqual(error.status, 409)
                return None
        with ThreadPoolExecutor(max_workers=4) as pool:
            accepted = [outcome for outcome in pool.map(submit, range(8)) if outcome]
        self.assertEqual(len(accepted), 1)
        target, request, appeal_id = accepted[0]
        duplicate = self.appeal(request, sid=target)
        self.assertFalse(duplicate[3])
        self.assertEqual(duplicate[2]["id"], appeal_id)
        player = self.store.read(self.code, "alice")["players"][0]
        self.assertEqual(sum(len(s.get("appeals", [])) for s in player["submissions"]), 1)

    def test_technical_failure_releases_budget_for_other_target_and_restart(self):
        second = self.submit("alice", 7)
        self.finish()
        _, _, failed, _ = self.appeal()
        self.store.complete_appeal(self.code, self.submission["id"], failed["id"], {"status":"failed"})
        self.assertFalse(self.appeal()[3])
        state = self.store.read(self.code, "alice")
        self.assertTrue(all(s["appeal_eligible"] for s in snapshot(state, "alice")["players"][0]["submissions"]))
        _, _, retry, created = self.appeal("different-target", sid=second["id"])
        self.assertTrue(created)
        self.store.tick(recover=True)
        state = self.store.read(self.code, "alice")
        self.assertTrue(all(s["appeal_eligible"] for s in snapshot(state, "alice")["players"][0]["submissions"]))
        # A stale success for a failed job cannot consume or alter the new slot.
        self.store.complete_appeal(self.code, second["id"], retry["id"], result(9))
        unchanged = self.store.read(self.code, "alice")
        self.assertNotIn("effective_verdict", unchanged["players"][0]["submissions"][1])
        self.assertEqual(score(unchanged["players"][0]), score(state["players"][0]))
        _, _, final, _ = self.appeal("after-restart")
        self.store.complete_appeal(self.code, self.submission["id"], final["id"], result(8))
        with self.assertRaises(CompetitionError):
            self.appeal("used-budget", sid=second["id"])

    def test_new_round_has_fresh_budget_and_archive_does_not_count(self):
        self.finish()
        _, _, appeal, _ = self.appeal()
        self.store.complete_appeal(self.code, self.submission["id"], appeal["id"], result(8))
        self.store.rematch(self.code, "alice", 1)
        self.store.ready(self.code, "alice", True, round=2)
        self.store.ready(self.code, "bob", True, round=2)
        current = self.submit("alice", 5)
        self.submit("bob", 6)
        state = self.finish()
        self.assertEqual(state["rounds"][0]["players"][0]["submissions"][0]["appeals"][0]["status"], "graded")
        self.assertTrue(snapshot(state, "alice")["players"][0]["submissions"][0]["appeal_eligible"])
        _, _, fresh, created = self.store.appeal(self.code, "alice", current["id"], "Round two", "round-two", 2)
        self.assertTrue(created)
        self.assertNotEqual(fresh["id"], appeal["id"])

    def test_finished_result_wins_and_times_recomputed_without_double_award(self):
        state = self.finish()
        ended_at = state["ended_at"]
        times = [(p["finalized_at"], p["finalized_order"]) for p in state["players"]]
        self.assertEqual(match_score(state)["wins"][state["players"][1]["id"]], 1)
        _, _, appeal, _ = self.appeal()
        provisional = self.store.read(self.code, "alice")
        self.assertEqual(provisional["phase"], "finished")
        self.assertTrue(snapshot(provisional, "alice")["appeals_pending"])
        with self.assertRaises(CompetitionError):
            self.store.rematch(self.code, "alice", 1)
        self.store.complete_appeal(self.code, self.submission["id"], appeal["id"], result(8))
        state = self.store.read(self.code, "alice")
        self.assertEqual(state["ended_at"], ended_at)
        self.assertEqual([(p["finalized_at"], p["finalized_order"]) for p in state["players"]], times)
        self.assertEqual(list(match_score(state)["wins"].values()), [1, 0])
        self.store.read(self.code, "alice")
        rematch = self.store.rematch(self.code, "alice", 1)
        self.assertEqual(list(match_score(rematch)["wins"].values()), [1, 0])
        with self.assertRaises(CompetitionError):
            self.appeal("archive")

    def test_finished_pending_appeal_failed_retry_and_restart(self):
        self.finish()
        state, _, appeal, _ = self.appeal()
        self.assertEqual(state["phase"], "finished")
        self.store.complete_appeal(self.code, self.submission["id"], appeal["id"], {"status": "failed", "error": "Secret provider input"})
        state = self.store.read(self.code, "alice")
        self.assertEqual(state["phase"], "finished")
        self.assertEqual(score(state["players"][0])["score"], 5)
        self.assertFalse(self.appeal()[3])
        _, _, retry, created = self.appeal("retry")
        self.assertTrue(created)
        self.store.tick(recover=True)
        state = self.store.read(self.code, "alice")
        self.assertEqual(state["players"][0]["submissions"][0]["appeals"][-1]["status"], "failed")
        self.assertEqual(score(state["players"][0])["score"], 5)
        _, _, last, _ = self.appeal("after-restart")
        self.store.complete_appeal(self.code, self.submission["id"], retry["id"], result(9))
        self.assertEqual(score(self.store.read(self.code, "alice")["players"][0])["score"], 5)
        self.store.complete_appeal(self.code, self.submission["id"], last["id"], result(7))
        self.assertEqual(score(self.store.read(self.code, "alice")["players"][0])["score"], 7)

    def test_privacy_and_archived_eligibility(self):
        active = self.store.read(self.code, "alice")
        self.assertFalse(snapshot(active, "alice")["players"][0]["submissions"][0]["appeal_eligible"])
        self.finish()
        state, _, appeal, _ = self.appeal(reason="Private argument")
        self.assertEqual(snapshot(state, "bob")["players"][0]["submissions"][0]["appeal"]["reason"], "Private argument")
        self.store.complete_appeal(self.code, self.submission["id"], appeal["id"], result(8))
        state = self.store.read(self.code, "alice")
        self.assertEqual(snapshot(state, "bob")["players"][0]["submissions"][0]["appeal"]["grade"]["reasoning"], "Private review")
        # Redact legacy early-review data when displaying a round still in play.
        legacy = {**state, "phase":"active"}
        self.assertIsNone(snapshot(legacy, "alice")["players"][0]["submissions"][0]["appeal"]["grade"])
        self.assertNotIn("Private argument", json.dumps(snapshot(legacy, "bob")))
        self.assertTrue(snapshot(state, "bob")["players"][1]["submissions"][0]["appeal_eligible"])
        self.assertFalse(snapshot({**state, "_archived": True}, "bob")["players"][1]["submissions"][0]["appeal_eligible"])

    def test_appeal_requires_finished_round_after_all_original_grades(self):
        state = self.store.read(self.code, "alice")
        self.assertEqual(state["phase"], "active")
        with self.assertRaises(CompetitionError) as solving:
            self.appeal()
        self.assertEqual(solving.exception.status, 409)
        _, pending, _ = self.store.submit(self.code, "bob", "Pending original proof", "pending")
        state = self.finish()
        self.assertEqual(state["phase"], "grading")
        self.assertTrue(all(p["finalized"] for p in state["players"]))
        self.assertFalse(snapshot(state, "alice")["players"][0]["submissions"][0]["appeal_eligible"])
        with self.assertRaises(CompetitionError) as grading:
            self.appeal()
        self.assertEqual(grading.exception.status, 409)
        self.store.complete(self.code, pending["id"], result(7))
        state = self.store.read(self.code, "alice")
        self.assertEqual(state["phase"], "finished")
        self.assertTrue(snapshot(state, "alice")["players"][0]["submissions"][0]["appeal_eligible"])
        self.assertTrue(self.appeal()[3])

    def test_finished_parallel_appeals_recompute_after_final_failure_or_restart(self):
        self.finish()
        _, _, first, _ = self.appeal()
        _, _, second, _ = self.appeal("bob-appeal", token="bob", sid=self.other["id"])
        self.store.complete_appeal(self.code, self.submission["id"], first["id"], result(8))
        self.store.complete_appeal(self.code, self.other["id"], second["id"], {"status":"failed"})
        self.assertEqual(list(match_score(self.store.read(self.code, "alice"))["wins"].values()), [1, 0])
        # Recreate a dirty provisional result and recover the final pending job.
        with self.store.edit(self.code) as state:
            state["result"]["winner"] = state["players"][1]["id"]
            state["appeal_result_dirty"] = True
            state["players"][1]["submissions"][0]["appeals"][-1]["status"] = "pending"
        self.store.tick(recover=True)
        self.assertEqual(list(match_score(self.store.read(self.code, "alice"))["wins"].values()), [1, 0])

    def test_legacy_finished_result_preserved_without_decided_appeal(self):
        self.finish()
        with self.store.edit(self.code) as state:
            state["result"] = {"winner": None, "reason": "Legacy draw"}
        self.store.tick(recover=True)
        self.assertEqual(self.store.read(self.code, "alice")["result"], {"winner": None, "reason": "Legacy draw"})


class AppealApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_background_idempotency_payload(self):
        with tempfile.TemporaryDirectory() as temp:
            store = Store(Path(temp) / "db")
            code = store.create("alice", "Alice", PROBLEM, "openai/exact-round-model")["code"]
            store.join(code, "bob", "Bob")
            store.ready(code, "alice", True)
            store.ready(code, "bob", True)
            _, sub, _ = store.submit(code, "alice", "Exact original", "original", images=[screenshot()])
            store.complete(code, sub["id"], result(5))
            secret = str(Path(temp) / "secret")
            lifecycle = lifespan(app)
            with patch.object(settings, "database", store.path), patch.dict(os.environ, {"MATH_ACCOUNT_SECRET_FILE": secret}):
                await lifecycle.__aenter__()
            self.addAsyncCleanup(lifecycle.__aexit__, None, None, None)
            gate = asyncio.Event()
            async def review(request, problem, config):
                self.assertEqual(request.solution, "Exact original")
                self.assertEqual(request.appeal_reason, "Look at line two")
                self.assertEqual(len(request.images), 1)
                self.assertEqual(request.previous_verdict.verdict, 5)
                self.assertEqual(config.model, "openai/exact-round-model")
                await gate.wait()
                return GradeResponse(id="review", submitted_at="2026-01-01T00:00:00Z", status="graded", attempts=1, counted=True, grade=Verdict(**result(8)["grade"]))
            mock = AsyncMock(side_effect=review)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", cookies={"math_player":"alice", "math_openrouter_key":"secret"}) as client:
                with patch("app.api.grade_appeal", mock):
                    body = {"round":1,"request_id":"appeal","reason":"Look at line two"}
                    url = f"/api/sessions/{code}/submissions/{sub['id']}/appeal"
                    early = await client.post(url, json=body)
                    self.assertEqual(early.status_code, 409)
                    mock.assert_not_awaited()
                    _, pending, _ = store.submit(code, "bob", "Pending original", "bob-original")
                    store.finalize(code, "alice")
                    waiting = store.finalize(code, "bob")
                    self.assertEqual(waiting["phase"], "grading")
                    during_grading = await client.post(url, json=body)
                    self.assertEqual(during_grading.status_code, 409)
                    mock.assert_not_awaited()
                    store.complete(code, pending["id"], result(6))
                    self.assertEqual(store.read(code, "alice")["phase"], "finished")
                    responses = await asyncio.gather(*[client.post(f"/api/sessions/{code}/submissions/{sub['id']}/appeal", json=body) for _ in range(3)])
                    self.assertEqual([r.status_code for r in responses], [202]*3)
                    self.assertNotIn("secret", json.dumps([r.json() for r in responses]))
                    await asyncio.sleep(0)
                    self.assertEqual(mock.await_count, 1)
                    gate.set()
                    await asyncio.gather(*app.state.grading_tasks)
                    self.assertEqual(score(store.read(code,"alice")["players"][0])["score"], 8)

    async def test_cancelled_background_review_keeps_original_grade(self):
        with tempfile.TemporaryDirectory() as temp:
            store = Store(Path(temp) / "db")
            code = store.create("alice", "Alice", PROBLEM, "openai/test")["code"]
            store.join(code, "bob", "Bob")
            store.ready(code, "alice", True)
            store.ready(code, "bob", True)
            _, submission, _ = store.submit(code, "alice", "Original", "request")
            store.complete(code, submission["id"], result(5))
            store.finalize(code, "alice")
            store.finalize(code, "bob")
            state, submission, appeal, _ = store.appeal(code, "alice", submission["id"], "Argument", "appeal", 1)
            target = type("Target", (), {"state": type("State", (), {"store":store})()})()
            with patch("app.api.grade_appeal", AsyncMock(side_effect=asyncio.CancelledError)):
                with self.assertRaises(asyncio.CancelledError):
                    await run_appeal(target, code, submission, appeal, state, "secret")
            current = store.read(code, "alice")["players"][0]
            self.assertEqual(score(current)["score"], 5)
            self.assertEqual(current["submissions"][0]["appeals"][0]["status"], "failed")

    async def test_review_model_receives_separate_untrusted_fields(self):
        response = AsyncMock()
        response.choices = [type("Choice", (), {"message":type("Message", (), {"content":json.dumps(result(7)["grade"])})()})()]
        client = AsyncMock()
        client.chat.completions.create.return_value = response
        manager = AsyncMock()
        manager.__aenter__.return_value = client
        with patch("app.grading.AsyncOpenAI", return_value=manager):
            await grade_appeal(AppealGradeRequest(api_key="secret", solution="original", images=[screenshot()], previous_verdict=result(5)["grade"], appeal_reason="argument"), PROBLEM, GradingConfig())
        messages = client.chat.completions.create.call_args.kwargs["messages"]
        payload = json.loads(messages[1]["content"][0]["text"])
        self.assertEqual(payload["submitted_solution"], "original")
        self.assertEqual(payload["appeal_argument"], "argument")
        self.assertEqual(payload["previous_verdict"]["verdict"], 5)
        self.assertEqual(payload["problem"], PROBLEM.model_dump())
        self.assertIn("cannot add missing proof", messages[0]["content"])
        self.assertEqual(messages[1]["content"][1]["image_url"]["url"], screenshot()["data_url"])
