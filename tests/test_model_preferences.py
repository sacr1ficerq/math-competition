import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app.accounts import AccountStore, password_hash
from app.api import lifespan, settings
from app.config import Problem
from app.grading import GradeResponse, Verdict
from app.main import app

CUSTOM = Problem(title="Custom", statement="Question", criterions="Criteria", reference_solution="Reference")


class PreferenceMigrationTests(unittest.TestCase):
    def test_old_schema_additive_migration_and_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            path, secret = Path(temp)/"db", Path(temp)/"secret"
            with sqlite3.connect(path) as db:
                db.execute("""CREATE TABLE accounts(id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE,
                    display_name TEXT NOT NULL, password_hash TEXT NOT NULL, player_token TEXT NOT NULL UNIQUE,
                    api_key BLOB, created_at REAL NOT NULL)""")
                db.execute("INSERT INTO accounts VALUES ('old','alice','Alice',?,'legacy',NULL,1)", (password_hash("safe-password"),))
            store = AccountStore(path, secret)
            account, session = store.login("alice","safe-password")
            self.assertIsNone(AccountStore.public(account)["default_model"])
            store.set_key(account["id"],"secret-provider-key")
            store.set_default_model(account["id"],"provider/preferred")
            restarted = AccountStore(path, secret)
            migrated = restarted.authenticate(session)
            self.assertEqual(migrated["default_model"],"provider/preferred")
            self.assertEqual(restarted.get_key(account["id"]),"secret-provider-key")
            self.assertNotIn("secret-provider-key", json.dumps(AccountStore.public(migrated)))
            new,_=restarted.register("bob","Bob","safe-password")
            self.assertIsNone(new["default_model"])


class ModelPreferenceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.path=Path(self.temp.name)
        self.setting=patch.object(settings,"database",str(self.path/"db"))
        self.environment=patch.dict(os.environ,{"MATH_ACCOUNT_SECRET_FILE":str(self.path/"secret")})
        self.setting.start()
        self.environment.start()
        self.lifecycle=lifespan(app)
        await self.lifecycle.__aenter__()
        for name in ("model_catalog","model_catalog_lock"):
            if hasattr(app.state,name):
                delattr(app.state,name)
        self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test")
        self.other=httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test")
        await self.client.post("/api/auth/register",json={"login":"alice","display_name":"Alice","password":"safe-password"})
        await self.client.put("/api/key",json={"api_key":"secret-provider"})

    async def asyncTearDown(self):
        await self.lifecycle.__aexit__(None,None,None)
        await self.client.aclose()
        await self.other.aclose()
        self.setting.stop()
        self.environment.stop()
        self.temp.cleanup()

    async def preference(self,model):
        return await self.client.put("/api/auth/preferences",json={"default_model":model})

    async def test_authenticated_validated_preference_persists_across_devices(self):
        self.assertEqual((await self.other.put("/api/auth/preferences",json={"default_model":"provider/model"})).status_code,401)
        for invalid in ("missing-provider", "provider/model?key=secret", "x/"+"a"*200, ""):
            response=await self.preference(invalid)
            self.assertEqual(response.status_code,422)
            if invalid:
                self.assertNotIn(invalid,response.text)
        response=await self.preference("provider/preferred")
        self.assertEqual(response.json()["user"]["default_model"],"provider/preferred")
        app.state.accounts=AccountStore(settings.database,self.path/"secret")
        login=await self.other.post("/api/auth/login",json={"login":"alice","password":"safe-password"})
        self.assertEqual(login.json()["user"]["default_model"],"provider/preferred")
        self.assertTrue(login.json()["user"]["has_api_key"])
        self.assertEqual((await self.other.get("/api/auth/me")).json()["user"]["default_model"],"provider/preferred")
        await self.other.post("/api/auth/logout")
        self.assertEqual((await self.client.get("/api/auth/me")).json()["user"]["default_model"],"provider/preferred")

    async def test_new_duel_priority_and_existing_room_unchanged(self):
        base={"problem":CUSTOM.model_dump()}
        initial=await self.client.post("/api/sessions",json=base)
        self.assertEqual(initial.json()["model"],settings.grading.model)
        await self.preference("provider/preferred")
        preferred=(await self.client.post("/api/sessions",json=base)).json()
        self.assertEqual(preferred["model"],"provider/preferred")
        override=(await self.client.post("/api/sessions",json={**base,"model":"provider/override"})).json()
        self.assertEqual(override["model"],"provider/override")
        path=f"/api/sessions/{preferred['code']}"
        await self.other.post(path+"/join",json={"name":"Bob"})
        await self.client.put(path+"/ready",json={"ready":True})
        await self.other.put(path+"/ready",json={"ready":True})
        await self.preference("provider/next")
        self.assertEqual((await self.client.get(path)).json()["model"],"provider/preferred")
        self.assertEqual((await self.client.put(path+"/model",json={"model":"provider/next"})).status_code,409)
        self.assertEqual((await self.client.get(f"/api/sessions/{initial.json()['code']}")).json()["model"],settings.grading.model)

    async def test_practice_uses_saved_default_and_legacy_uses_global(self):
        await self.preference("provider/preferred")
        result=GradeResponse(id="grade",submitted_at="2026-01-01T00:00:00Z",status="graded",attempts=1,counted=True,
                             grade=Verdict(verdict=8,reasoning="Review",evidence="Evidence"))
        mocked=AsyncMock(return_value=result)
        with patch("app.main.grade_solution",mocked):
            response=await self.client.post("/api/grade",json={"solution":"Proof","problem":CUSTOM.model_dump()})
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(mocked.call_args.args[2].model,"provider/preferred")
            self.assertEqual(mocked.call_args.args[0].api_key,"secret-provider")
            legacy=await self.other.post("/api/grade",json={"api_key":"legacy-secret","solution":"Proof","problem":CUSTOM.model_dump()})
            self.assertEqual(legacy.status_code,200)
            self.assertEqual(mocked.call_args.args[2].model,settings.grading.model)

    async def test_catalog_filters_advertised_capabilities_caches_and_preserves_stale(self):
        payload={"data":[
            {"id":"provider/vision","name":"Vision","supported_parameters":["structured_outputs"],"architecture":{"input_modalities":["text","image"]}},
            {"id":"provider/text","name":"Text","supported_parameters":["response_format"],"architecture":{"input_modalities":["text"]}},
            {"id":"provider/unknown","name":"Unknown","supported_parameters":["response_format"]},
            {"id":"provider/no-json","supported_parameters":["temperature"]},
            {"id":"provider/missing-metadata"},
            {"id":"invalid","supported_parameters":["response_format"]},
        ]}
        upstream=httpx.Response(200,json=payload,request=httpx.Request("GET","https://openrouter.ai/api/v1/models"))
        provider=AsyncMock()
        provider.get.return_value=upstream
        manager=AsyncMock()
        manager.__aenter__.return_value=provider
        with patch("app.api.httpx.AsyncClient",return_value=manager) as factory:
            response=(await self.client.get("/api/models")).json()
            cached=(await self.client.get("/api/models")).json()
        self.assertEqual(provider.get.await_count,1)
        provider.get.assert_awaited_once_with("https://openrouter.ai/api/v1/models")
        self.assertEqual(factory.call_args.kwargs,{"timeout":5.0})
        self.assertEqual(response,cached)
        self.assertFalse(response["stale"])
        self.assertEqual({m["id"]:m["supports_images"] for m in response["models"]},{"provider/vision":True,"provider/text":False,"provider/unknown":None})
        app.state.model_catalog["checked_at"]-=601
        provider.get.side_effect=httpx.ConnectError("Sensitive internal provider diagnostics")
        with patch("app.api.httpx.AsyncClient",return_value=manager):
            stale=(await self.client.get("/api/models")).json()
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["models"],response["models"])
        self.assertNotIn("Sensitive",json.dumps(stale))

    async def test_catalog_failure_falls_back_only_to_configured_model(self):
        manager=AsyncMock()
        manager.__aenter__.side_effect=httpx.ConnectError("unavailable")
        with patch("app.api.httpx.AsyncClient",return_value=manager):
            response=(await self.client.get("/api/models")).json()
        self.assertTrue(response["stale"])
        self.assertEqual(response["models"],[{"id":settings.grading.model,"name":settings.grading.model,"supports_images":None}])
        self.assertEqual(response["default_model"],settings.grading.model)
