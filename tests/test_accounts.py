import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.account_api import router, resolve_identity
from app.accounts import AccountStore
from app.competition import Store, identity
from app.config import Problem


class AccountsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "test.db"
        self.secret = Path(self.temp.name) / "secret"
        self.accounts = AccountStore(self.path, self.secret)
        app = FastAPI()
        app.state.accounts = self.accounts
        app.include_router(router)
        @app.get("/identity")
        def who(request: Request):
            return {"identity": resolve_identity(request)}
        self.client = TestClient(app)
        self.app = app

    def register(self, login="alice"):
        response = self.client.post("/api/auth/register", json={"login": login, "display_name": "Alice", "password": "safe-password"})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()["user"]

    def test_authentication_cookie_and_isolation(self):
        user = self.register()
        self.assertEqual(set(user), {"id", "login", "display_name", "has_api_key", "default_model"})
        self.assertIn("HttpOnly", self.client.post("/api/auth/login", json={"login": "ALICE", "password": "safe-password"}).headers["set-cookie"])
        other = TestClient(self.app)
        self.assertIsNone(other.get("/api/auth/me").json()["user"])
        self.assertEqual(other.post("/api/auth/login", json={"login": "alice", "password": "wrong"}).status_code, 401)
        self.assertEqual(other.post("/api/auth/register", json={"login": "Alice", "display_name": "Other", "password": "safe-password"}).status_code, 409)
        old_cookie = self.client.cookies.get("math_auth")
        old_identity = self.client.cookies.get("math_player")
        self.client.post("/api/auth/logout")
        self.assertIsNone(self.accounts.authenticate(old_cookie))
        self.client.cookies.set("math_player", old_identity)
        self.assertIsNone(self.client.get("/identity").json()["identity"])

    def test_key_encrypted_persistent_and_explicitly_removed(self):
        user = self.register()
        key = "sk-or-secret-test-key"
        self.assertEqual(self.client.put("/api/auth/key", json={"api_key": key}).status_code, 200)
        with self.accounts.connection() as db:
            account = db.execute("SELECT * FROM accounts").fetchone()
            session = db.execute("SELECT * FROM account_sessions").fetchone()
        self.assertNotIn(key, str(dict(account)))
        self.assertNotEqual(account["password_hash"], "safe-password")
        self.assertNotEqual(session["token_hash"], self.client.cookies.get("math_auth"))
        self.assertEqual(self.secret.stat().st_mode & 0o777, 0o600)
        self.client.post("/api/auth/logout")
        self.app.state.accounts = AccountStore(self.path, self.secret)
        other = TestClient(self.app)
        self.assertEqual(other.put("/api/auth/key", json={"api_key": "other"}).status_code, 401)
        other.post("/api/auth/login", json={"login": "alice", "password": "safe-password"})
        self.assertTrue(other.get("/api/auth/me").json()["user"]["has_api_key"])
        self.assertEqual(self.app.state.accounts.get_key(user["id"]), key)
        other.delete("/api/auth/key")
        self.assertIsNone(self.app.state.accounts.get_key(user["id"]))

    def test_legacy_key_migrates_without_overwriting_account_key(self):
        self.client.cookies.set("math_openrouter_key", "legacy-provider-key")
        user = self.register()
        self.assertTrue(user["has_api_key"])
        self.assertEqual(self.accounts.get_key(user["id"]), "legacy-provider-key")
        self.assertNotIn("legacy-provider-key", str(user))
        self.client.put("/api/auth/key", json={"api_key": "saved-account-key"})
        other = TestClient(self.app)
        other.cookies.set("math_openrouter_key", "another-browser-key")
        response = other.post("/api/auth/login", json={"login": "alice", "password": "safe-password"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.accounts.get_key(user["id"]), "saved-account-key")

    def test_legacy_sessions_and_history_link_without_player_changes(self):
        store = Store(self.path)
        problem = Problem(title="Test", statement="Question", reference_solution="Answer", criterions="Criteria")
        session = store.create("legacy", "Alice", problem, "openai/test")
        self.register()
        canonical = self.client.cookies.get("math_player")
        with self.accounts.connection() as db:
            db.execute("CREATE TABLE bank_history(identity TEXT, problem_id TEXT, seen_at REAL, attempted_at REAL, solved_at REAL, PRIMARY KEY(identity,problem_id))")
            db.execute("INSERT INTO bank_history VALUES (?, 'p1', 1, NULL, NULL)", (identity("legacy"),))
            db.execute("INSERT INTO bank_history VALUES (?, 'p1', 2, 3, NULL)", (identity(canonical),))
        other = TestClient(self.app)
        other.cookies.set("math_player", "legacy")
        response = other.post("/api/auth/login", json={"login": "alice", "password": "safe-password"})
        self.assertEqual(response.status_code, 200)
        linked = store.read(session["code"], canonical)
        self.assertEqual(linked["players"][0]["id"], session["players"][0]["id"])
        with self.accounts.connection() as db:
            history = db.execute("SELECT * FROM bank_history").fetchall()
        self.assertEqual(len(history), 1)
        self.assertEqual(tuple(history[0]), (identity(canonical), "p1", 1, 3, None))

    def test_link_refuses_opponents_and_rolls_back(self):
        self.register()
        canonical = self.client.cookies.get("math_player")
        store = Store(self.path)
        session = store.create(canonical, "Alice", Problem(title="T", statement="S", reference_solution="R", criterions="C"), "openai/test")
        store.join(session["code"], "opponent", "Bob")
        other = TestClient(self.app)
        other.cookies.set("math_player", "opponent")
        self.assertEqual(other.post("/api/auth/login", json={"login": "alice", "password": "safe-password"}).status_code, 409)
        self.assertEqual(store.read(session["code"], "opponent")["players"][1]["identity"], identity("opponent"))

    def test_expired_session(self):
        self.register()
        token = self.client.cookies.get("math_auth")
        with self.accounts.connection() as db:
            db.execute("UPDATE account_sessions SET expires_at=0")
        self.assertIsNone(self.accounts.authenticate(token))
        self.assertIsNone(self.client.get("/api/auth/me").json()["user"])
