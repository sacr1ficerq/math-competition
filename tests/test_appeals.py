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
        self.code = self.store.create("alice", "Alice", PROBLEM, "openai/test")["code"]
        self.store.join(self.code, "bob", "Bob")
        self.store.ready(self.code, "alice", True)
        self.store.ready(self.code, "bob", True)
        self.submission = self.submit("alice", 5)
        self.other = self.submit("bob", 6)

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
                submission = self.submit("alice", old)
                _, _, appeal, _ = self.appeal(str(old)+str(proposed), sid=submission["id"])
                self.store.complete_appeal(self.code, submission["id"], appeal["id"], result(proposed))
                actual = next(s for s in self.store.read(self.code, "alice")["players"][0]["submissions"] if s["id"] == submission["id"])
                self.assertEqual(actual["effective_verdict"], old - 1)
        self.assertEqual(score({"submissions": [{"status": "graded", "grade": {"verdict": 0}, "effective_verdict": -1}]} )["score"], -1)

    def test_duplicate_and_concurrent_requests_do_not_create_extra_jobs(self):
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

    def test_pending_prevents_finalization_and_failed_retry_restart(self):
        _, _, appeal, _ = self.appeal()
        state = self.finish()
        self.assertEqual(state["phase"], "grading")
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
        state, _, appeal, _ = self.appeal(reason="Private argument")
        self.assertTrue(snapshot(state, "alice")["players"][0]["submissions"][0]["appeal"]["reason"])
        self.assertEqual(snapshot(state, "bob")["players"][0]["submissions"][0]["appeal"], {"status": "pending"})
        self.store.complete_appeal(self.code, self.submission["id"], appeal["id"], result(8))
        state = self.store.read(self.code, "alice")
        self.assertIsNone(snapshot(state, "alice")["players"][0]["submissions"][0]["appeal"]["grade"])
        self.assertNotIn("Private argument", json.dumps(snapshot(state, "bob")))
        state = self.finish()
        self.assertEqual(snapshot(state, "bob")["players"][0]["submissions"][0]["appeal"]["grade"]["reasoning"], "Private review")
        self.assertTrue(snapshot(state, "bob")["players"][1]["submissions"][0]["appeal_eligible"])
        self.assertFalse(snapshot({**state, "_archived": True}, "bob")["players"][1]["submissions"][0]["appeal_eligible"])

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
