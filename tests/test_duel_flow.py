import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app.api import lifespan, settings
from app.competition import CompetitionError, identity
from app.config import Problem
from app.grading import GradeResponse, Verdict
from app.main import app
from app.problem_bank import ProblemBank
from test_grading import screenshot

CUSTOM = Problem(title="Custom", statement="Custom question", criterions="Secret custom criteria", reference_solution="Secret custom reference")


def grade(verdict=10):
    return GradeResponse(id="review", submitted_at="2026-01-01T00:00:00Z", status="graded", attempts=1, counted=True,
                         grade=Verdict(verdict=verdict, reasoning="Review", evidence="Evidence"))


class DuelFlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.setting = patch.object(settings, "database", str(root / "db.sqlite3"))
        self.environment = patch.dict(os.environ, {"MATH_ACCOUNT_SECRET_FILE":str(root / "secret")})
        self.setting.start()
        self.environment.start()
        self.lifecycle = lifespan(app)
        await self.lifecycle.__aenter__()
        problems = root / "problems"
        problems.mkdir()
        for topic in ("algebra", "geometry"):
            for number in range(3):
                content = {**CUSTOM.model_dump(), "title": f"{topic}-{number}", "statement": f"Question {topic}-{number}", "topic":topic}
                (problems / f"{topic}-{number}.json").write_text(json.dumps(content))
        app.state.problem_bank = ProblemBank(settings.database, problems)
        self.alice = self.client()
        self.bob = self.client()
        self.clients = [self.alice, self.bob]
        for client, login in [(self.alice, "alice"), (self.bob,"bob")]:
            response = await client.post("/api/auth/register", json={"login":login, "display_name":login.title(), "password":"safe-password"})
            self.assertEqual(response.status_code, 201)
            await client.put("/api/key", json={"api_key":f"secret-{login}"})
        self.store = app.state.store
        self.bank = app.state.problem_bank

    def client(self):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    def account_key(self, client):
        return identity(app.state.accounts.authenticate(client.cookies.get("math_auth"))["player_token"])

    def raw_token(self, client):
        return app.state.accounts.authenticate(client.cookies.get("math_auth"))["player_token"]

    async def asyncTearDown(self):
        await self.lifecycle.__aexit__(None, None, None)
        for client in self.clients:
            await client.aclose()
        self.setting.stop()
        self.environment.stop()
        self.temp.cleanup()

    async def lobby(self, topic="algebra", problem=None):
        body = {"topic":topic} if problem is None else {"problem":problem.model_dump()}
        response = await self.alice.post("/api/sessions", json=body)
        self.assertEqual(response.status_code, 201, response.text)
        state = response.json()
        self.path = f"/api/sessions/{state['code']}"
        joined = await self.bob.post(self.path+"/join", json={})
        self.assertEqual(joined.status_code, 200)
        return joined.json()

    async def start(self, topic="algebra", problem=None):
        await self.lobby(topic, problem)
        await self.alice.put(self.path+"/ready", json={"ready":True})
        response = await self.bob.put(self.path+"/ready", json={"ready":True})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_cross_device_name_saved_key_bank_union_and_no_early_reveal(self):
        await self.alice.post("/api/problems/algebra-0/practice")
        await self.bob.post("/api/problems/algebra-1/practice")
        other = self.client()
        self.clients.append(other)
        await other.post("/api/auth/login", json={"login":"alice", "password":"safe-password"})
        state = await self.lobby()
        self.assertEqual([p["name"] for p in state["players"]], ["Alice", "Bob"])
        self.assertEqual(state["source"], "bank")
        self.assertIsNone(state["problem"])
        self.assertEqual(next(t for t in state["available_topics"] if t["slug"]=="algebra")["unseen_count"], 1)
        first = await other.put(self.path+"/ready", json={"ready":True})
        self.assertIsNone(first.json()["problem"])
        active = (await self.bob.put(self.path+"/ready", json={"ready":True})).json()
        self.assertEqual(active["problem"]["id"], "algebra-2")
        self.assertNotIn("criterions", active["problem"])
        self.assertNotIn("reference_solution", active["problem"])
        self.assertTrue((await other.get(self.path)).json()["has_api_key"])
        self.assertNotIn("secret-alice", json.dumps(active))
        with self.bank.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM bank_rounds").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM bank_history WHERE problem_id='algebra-2'").fetchone()[0], 2)
        # A separate duel sees the union of exposure history from both devices.
        await self.lobby()
        await other.put(self.path+"/ready", json={"ready":True})
        exhausted = await self.bob.put(self.path+"/ready", json={"ready":True})
        self.assertEqual(exhausted.status_code, 409)
        self.assertIn("новых для обоих", exhausted.json()["detail"])
        state = (await other.get(self.path)).json()
        self.assertEqual([p["ready"] for p in state["players"]], [True, False])
        self.assertIsNone(state["problem"])

    async def test_source_switch_host_validation_rematch_fresh_task(self):
        await self.lobby()
        self.assertEqual((await self.bob.put(self.path+"/topic", json={"topic":"geometry","round":1})).status_code,403)
        self.assertEqual((await self.alice.put(self.path+"/topic", json={"topic":"missing","round":1})).status_code,422)
        await self.alice.put(self.path+"/ready", json={"ready":True})
        custom = await self.alice.put(self.path+"/problem", json={"problem":CUSTOM.model_dump(),"round":1})
        self.assertEqual(custom.json()["source"], "custom")
        self.assertFalse(any(p["ready"] for p in custom.json()["players"]))
        self.assertIsNone(custom.json()["problem"])
        bank = await self.alice.put(self.path+"/topic", json={"topic":"geometry","round":1})
        self.assertEqual(bank.json()["source"], "bank")
        await self.alice.put(self.path+"/ready", json={"ready":True})
        active = (await self.bob.put(self.path+"/ready", json={"ready":True})).json()
        old_id = active["problem"]["id"]
        await self.alice.post(self.path+"/chat", json={"text":"Keep this chat"})
        await self.alice.post(self.path+"/finalize")
        await self.bob.post(self.path+"/finalize")
        rematch = (await self.alice.post(self.path+"/rematch", json={"round":1})).json()
        self.assertEqual((rematch["source"], rematch["topic"]), ("bank","geometry"))
        self.assertIsNone(rematch["problem"])
        self.assertEqual(rematch["chat"][0]["text"], "Keep this chat")
        self.assertEqual(sum(rematch["match"]["wins"].values()),1)
        await self.alice.put(self.path+"/ready",json={"ready":True,"round":2})
        next_round=(await self.bob.put(self.path+"/ready",json={"ready":True,"round":2})).json()
        self.assertNotEqual(next_round["problem"]["id"],old_id)
        self.assertNotIn("Secret",json.dumps(next_round["problem"]))

    async def test_atomic_final_submission_retry_missing_key_and_solved(self):
        state=await self.start()
        code=state["code"]
        problem_id=state["problem"]["id"]
        body={"solution":"Original proof","images":[screenshot()],"request_id":"finish","round":1,"finalize":True}
        await self.alice.delete("/api/key")
        rejected=await self.alice.post(self.path+"/submissions",json=body)
        self.assertEqual(rejected.status_code,400)
        current=self.store.read(code,self.raw_token(self.alice))
        self.assertFalse(current["players"][0]["finalized"])
        self.assertEqual(current["players"][0]["submissions"],[])
        await self.alice.put("/api/key",json={"api_key":"secret-alice"})
        gate=asyncio.Event()
        async def grader(request,problem,config):
            self.assertEqual(request.api_key,"secret-alice")
            self.assertEqual(request.solution,"Original proof")
            self.assertEqual(len(request.images),1)
            self.assertEqual(set(problem.model_dump()),set(Problem.model_fields))
            await gate.wait()
            return grade()
        mocked=AsyncMock(side_effect=grader)
        with patch("app.api.grade_solution",mocked):
            responses=await asyncio.gather(*[self.alice.post(self.path+"/submissions",json=body) for _ in range(3)])
            self.assertEqual([r.status_code for r in responses],[202]*3)
            await asyncio.sleep(0)
            self.assertEqual(mocked.await_count,1)
            current=self.store.read(code,self.raw_token(self.alice))
            player,opponent=current["players"]
            self.assertTrue(player["finalized"])
            self.assertEqual(player["finalized_at"],player["submissions"][0]["submitted_at"])
            self.assertEqual(opponent["deadline"],player["finalized_at"]+300)
            self.assertEqual(len(player["submissions"]),1)
            conflict=await self.alice.post(self.path+"/submissions",json={**body,"finalize":False})
            self.assertEqual(conflict.status_code,409)
            gate.set()
            await asyncio.gather(*app.state.grading_tasks)
        with self.bank.connection() as db:
            status=db.execute("SELECT attempted_at,solved_at FROM bank_history WHERE identity=? AND problem_id=?",(self.account_key(self.alice),problem_id)).fetchone()
        self.assertTrue(all(status))

    async def test_practice_saved_key_server_problem_and_duel_exclusion(self):
        mocked=AsyncMock(return_value=grade())
        with patch("app.main.grade_solution",mocked):
            response=await self.alice.post("/api/grade",json={"problem_id":"algebra-0","solution":"My proof","images":[screenshot()]})
        self.assertEqual(response.status_code,200,response.text)
        request,problem,_=mocked.call_args.args
        self.assertEqual(request.api_key,"secret-alice")
        self.assertEqual(problem.statement,"Question algebra-0")
        self.assertEqual(problem.criterions,CUSTOM.criterions)
        self.assertNotIn("secret-alice",response.text)
        with self.bank.connection() as db:
            status=db.execute("SELECT seen_at,attempted_at,solved_at FROM bank_history WHERE identity=? AND problem_id='algebra-0'",(self.account_key(self.alice),)).fetchone()
        self.assertTrue(all(status))
        conflict=await self.alice.post("/api/grade",json={"problem_id":"algebra-1","problem":CUSTOM.model_dump(),"solution":"Proof"})
        self.assertEqual(conflict.status_code,422)
        active=await self.start()
        self.assertNotEqual(active["problem"]["id"],"algebra-0")
        await self.alice.post("/api/auth/logout")
        anonymous=await self.alice.post("/api/grade",json={"problem_id":"geometry-0","solution":"Proof"})
        self.assertEqual(anonymous.status_code,400)

    async def test_concurrent_ready_and_final_submission_transactions(self):
        state=await self.lobby()
        code=state["code"]
        alice,bob=self.raw_token(self.alice),self.raw_token(self.bob)
        def ready(token):
            try:
                return self.store.ready(code,token,True,round=1,bank=self.bank)["phase"]
            except CompetitionError as error:
                return error.status
        with ThreadPoolExecutor(max_workers=4) as pool:
            outcomes=list(pool.map(ready,[alice,bob,alice,bob]))
        self.assertIn("active",outcomes)
        with self.bank.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM bank_rounds").fetchone()[0],1)
        def finish(_):
            return self.store.submit(code,alice,"Proof","finish",round=1,finalize=True)[2]
        with ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(sum(pool.map(finish,range(8))),1)
        current=self.store.read(code,alice)
        self.assertEqual(len(current["players"][0]["submissions"]),1)
        self.assertEqual(current["players"][0]["finalized_order"],1)

    async def test_appeal_ten_records_solved_without_extra_submission(self):
        state=await self.start()
        code=state["code"]
        token=self.raw_token(self.alice)
        _,submission,_=self.store.submit(code,token,"Proof","initial",round=1)
        self.store.complete(code,submission["id"],grade(8).model_dump(mode="json"))
        _,_,appeal,_=self.store.appeal(code,token,submission["id"],"Review this","appeal",1)
        self.store.complete_appeal(code,submission["id"],appeal["id"],grade(10).model_dump(mode="json"))
        with self.bank.connection() as db:
            status=db.execute("SELECT solved_at FROM bank_history WHERE identity=? AND problem_id=?",(self.account_key(self.alice),state["problem"]["id"])).fetchone()
        self.assertTrue(status[0])
        self.assertEqual(len(self.store.read(code,token)["players"][0]["submissions"]),1)
