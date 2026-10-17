import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import httpx

from app.api import lifespan, settings
from app.competition import CompetitionError, Store, snapshot
from app.config import Problem
from app.main import app

PROBLEM = Problem(title="Task", statement="Question", criterions="Criteria", reference_solution="Reference")


def result(verdict):
    return {"status":"graded","attempts":1,"grade":{"verdict":verdict,"reasoning":"Review","evidence":"Evidence"},"error":None}


class CloseRoomTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name)/"db")
        self.code = self.store.create("alice","Alice",PROBLEM,"provider/model")["code"]
        self.store.join(self.code,"bob","Bob")

    def start(self):
        self.store.ready(self.code,"alice",True)
        return self.store.ready(self.code,"bob",True)

    def submission(self, token="alice"):
        return self.store.submit(self.code,token,"Proof",token+str(time.time_ns()))[1]

    def finish(self):
        self.store.finalize(self.code,"alice")
        return self.store.finalize(self.code,"bob")

    def test_owner_permission_persistent_idempotence_and_stale_round_retry(self):
        for token in ("bob","outsider"):
            with self.assertRaises(CompetitionError) as error:
                self.store.close(self.code,token,1)
            self.assertEqual(error.exception.status,403)
        with self.assertRaises(CompetitionError):
            self.store.close(self.code,"alice",2)
        with patch("app.competition.time.time",return_value=100):
            closed=self.store.close(self.code,"alice",1)
        with patch("app.competition.time.time",return_value=200):
            retry=self.store.close(self.code,"alice",0)
        self.assertEqual((closed["closed_at"],retry["closed_at"]),(100,100))
        restarted=Store(self.store.path)
        self.assertEqual(restarted.read(self.code,"alice")["closed_at"],100)
        self.assertEqual(restarted.recent("bob")[0]["closed_at"],100)
        self.assertEqual(snapshot(retry,"bob")["phase"],"lobby")
        self.assertIsNone(snapshot(retry,"bob")["problem"])

    def test_every_user_mutation_blocked_even_duplicate_requests(self):
        self.start()
        submission=self.submission()
        self.store.complete(self.code,submission["id"],result(5))
        self.finish()
        _,_,appeal,_=self.store.appeal(self.code,"alice",submission["id"],"Reason","appeal",1)
        self.store.close(self.code,"alice",1)
        changes=[
            lambda:self.store.join(self.code,"alice","Alice"),
            lambda:self.store.join(self.code,"outsider","Outsider"),
            lambda:self.store.ready(self.code,"alice",True,round=1),
            lambda:self.store.model(self.code,"alice","provider/other",round=1),
            lambda:self.store.problem(self.code,"alice",PROBLEM,1),
            lambda:self.store.topic(self.code,"alice",None,1),
            lambda:self.store.rematch(self.code,"alice",1),
            lambda:self.store.draft(self.code,"alice","Edited",0,round=1),
            lambda:self.store.submit(self.code,"alice","Proof",submission["request_id"],round=1),
            lambda:self.store.finalize(self.code,"alice",round=1),
            lambda:self.store.appeal(self.code,"alice",submission["id"],"Reason","appeal",1),
            lambda:self.store.chat(self.code,"alice","Message"),
        ]
        before=self.store.read(self.code,"alice")
        for change in changes:
            with self.subTest(change=change):
                with self.assertRaises(CompetitionError) as error:
                    change()
                self.assertEqual(error.exception.status,409)
                self.assertIn("закрыта",error.exception.message)
        after=self.store.read(self.code,"alice")
        self.assertEqual(after["players"],before["players"])
        self.assertEqual(after["result"],before["result"])

    def test_active_draft_chat_and_timers_frozen_after_close(self):
        self.start()
        self.store.draft(self.code,"alice","Saved unfinished proof",0,round=1)
        self.store.chat(self.code,"alice","Saved message")
        self.store.finalize(self.code,"bob",now=time.time())
        before=self.store.read(self.code,"alice")
        closed=self.store.close(self.code,"alice",1)
        self.assertEqual(closed["players"],before["players"])
        self.assertEqual(closed["chat"],before["chat"])
        with patch("app.competition.time.time",return_value=time.time()+3600):
            self.store.tick()
            later=self.store.read(self.code,"alice")
        self.assertEqual(later["phase"],"active")
        self.assertEqual(later["players"],closed["players"])
        self.assertEqual(snapshot(later,"alice")["players"][0]["draft"],"Saved unfinished proof")
        self.assertNotIn("draft",snapshot(later,"bob")["players"][0])

    def test_late_grade_does_not_finalize_unfinished_closed_players(self):
        self.start()
        submission=self.submission()
        self.store.finalize(self.code,"alice")
        closed=self.store.close(self.code,"alice",1)
        self.store.complete(self.code,submission["id"],result(8))
        state=self.store.read(self.code,"alice")
        self.assertEqual(state["closed_at"],closed["closed_at"])
        self.assertEqual(state["phase"],"active")
        self.assertFalse(state["players"][1]["finalized"])
        self.assertIsNone(state["result"])
        self.assertEqual(state["players"][0]["submissions"][0]["grade"]["verdict"],8)

    def test_restart_recovers_pending_job_without_reopening_or_expiring_players(self):
        self.start()
        self.submission()
        self.store.finalize(self.code,"alice")
        closed=self.store.close(self.code,"alice",1)
        restarted=Store(self.store.path)
        with patch("app.competition.time.time",return_value=time.time()+3600):
            restarted.tick(recover=True)
            state=restarted.read(self.code,"alice")
        self.assertEqual(state["closed_at"],closed["closed_at"])
        self.assertEqual(state["phase"],"active")
        self.assertFalse(state["players"][1]["finalized"])
        self.assertEqual(state["players"][0]["submissions"][0]["status"],"failed")
        self.assertEqual(state["players"][1]["deadline"],closed["players"][1]["deadline"])

    def test_late_grade_settles_already_finalized_closed_round(self):
        self.start()
        submission=self.submission()
        self.finish()
        closed=self.store.close(self.code,"alice",1)
        times=[p["finalized_at"] for p in closed["players"]]
        self.assertEqual(closed["phase"],"grading")
        self.store.complete(self.code,submission["id"],result(8))
        state=self.store.read(self.code,"alice")
        self.assertEqual(state["phase"],"finished")
        self.assertEqual(state["closed_at"],closed["closed_at"])
        self.assertEqual([p["finalized_at"] for p in state["players"]],times)
        self.assertEqual(state["result"]["winner"],state["players"][0]["id"])
        self.assertFalse(snapshot(state,"alice")["players"][0]["submissions"][0]["appeal_eligible"])
        self.assertIn("grade",snapshot(state,"bob")["players"][0]["submissions"][0])

    def test_late_appeal_preserves_closure_and_updates_result(self):
        self.start()
        alice,bob=self.submission(),self.submission("bob")
        self.store.complete(self.code,alice["id"],result(5))
        self.store.complete(self.code,bob["id"],result(6))
        self.finish()
        _,_,appeal,_=self.store.appeal(self.code,"alice",alice["id"],"Original proof","appeal",1)
        closed=self.store.close(self.code,"alice",1)
        self.store.complete_appeal(self.code,alice["id"],appeal["id"],result(8))
        state=self.store.read(self.code,"alice")
        self.assertEqual(state["closed_at"],closed["closed_at"])
        self.assertEqual(state["phase"],"finished")
        self.assertEqual(state["ended_at"],closed["ended_at"])
        self.assertEqual(state["result"]["winner"],state["players"][0]["id"])
        self.assertFalse(snapshot(state,"bob")["players"][1]["submissions"][0]["appeal_eligible"])

    def test_archived_results_stay_readable_after_closing_next_round(self):
        self.start()
        finished=self.finish()
        rematch=self.store.rematch(self.code,"alice",1)
        closed=self.store.close(self.code,"alice",2)
        self.assertEqual(closed["rounds"][0]["result"],finished["result"])
        self.assertEqual(closed["players"],rematch["players"])
        self.assertEqual(len(snapshot(closed,"alice")["previous_rounds"]),1)
        retry=self.store.close(self.code,"alice",1)
        self.assertEqual(retry["closed_at"],closed["closed_at"])


class CloseRoomApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_close_endpoint_read_history_summary_and_join_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(settings,"database",str(Path(temp)/"db")),patch.dict(os.environ,{"MATH_ACCOUNT_SECRET_FILE":str(Path(temp)/"secret")}):
                async with lifespan(app):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test",cookies={"math_player":"alice"}) as alice, httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test",cookies={"math_player":"bob"}) as bob:
                        store=app.state.store
                        code=store.create("alice","Alice",PROBLEM,"provider/model")["code"]
                        store.join(code,"bob","Bob")
                        store.ready(code,"alice",True)
                        store.ready(code,"bob",True)
                        store.finalize(code,"alice")
                        store.finalize(code,"bob")
                        store.rematch(code,"alice",1)
                        path=f"/api/sessions/{code}"
                        denied=await bob.post(path+"/close",json={"round":2})
                        self.assertEqual(denied.status_code,403)
                        closed=await alice.post(path+"/close",json={"round":2})
                        self.assertEqual(closed.status_code,200)
                        self.assertIsNotNone(closed.json()["closed_at"])
                        retry=await alice.post(path+"/close",json={"round":1})
                        self.assertEqual(retry.json()["closed_at"],closed.json()["closed_at"])
                        self.assertEqual((await bob.get(path)).status_code,200)
                        self.assertEqual((await bob.get(path+"/rounds/1")).status_code,200)
                        recent=(await bob.get("/api/sessions")).json()["sessions"][0]
                        self.assertEqual(recent["closed_at"],closed.json()["closed_at"])
                        self.assertEqual((await bob.post(path+"/join",json={"name":"Bob"})).status_code,409)
                        self.assertEqual((await bob.put(path+"/ready",json={"ready":True,"round":2})).status_code,409)
                        self.assertEqual((await alice.post(path+"/chat",json={"text":"Blocked"})).status_code,409)
