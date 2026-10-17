"""Persistent accounts. Only encrypted provider keys and hashed sessions reach SQLite."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sqlite3
import time
from contextlib import contextmanager

from cryptography.fernet import Fernet
from fastapi import HTTPException

from app.competition import identity

SESSION_SECONDS = 30 * 24 * 60 * 60


def password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1)
    return salt.hex() + ":" + digest.hex()


def password_matches(password: str, encoded: str) -> bool:
    return hmac.compare_digest(password_hash(password, bytes.fromhex(encoded.split(":")[0])), encoded)


def installation_key(path: Path) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return path.read_bytes().strip()
    key = Fernet.generate_key()
    with os.fdopen(fd, "wb") as stream:
        stream.write(key)
    return key


class AccountStore:
    def __init__(self, path: str | Path, secret_path: str | Path | None = None):
        self.path = str(path)
        default = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "math-competition/account-key"
        key_path = Path(secret_path or os.environ.get("MATH_ACCOUNT_SECRET_FILE", default)).expanduser()
        self.cipher = Fernet(installation_key(key_path))
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS accounts (
                    id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE,
                    display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
                    player_token TEXT NOT NULL UNIQUE, api_key BLOB, created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS account_sessions (
                    token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL,
                    expires_at REAL NOT NULL,
                    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
                );
            """)
        # Equal-cost password verification for unknown logins.
        self.dummy_hash = password_hash(secrets.token_urlsafe(32))

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def public(account) -> dict:
        return {"id": account["id"], "login": account["login"], "display_name": account["display_name"], "has_api_key": bool(account["api_key"])}

    def register(self, login: str, display_name: str, password: str, legacy: str | None = None):
        account_id = secrets.token_hex(16)
        canonical = legacy or secrets.token_urlsafe(32)
        hashed = password_hash(password)
        try:
            with self.connection() as db:
                db.execute("BEGIN IMMEDIATE")
                # A browser identity previously linked to an account cannot be claimed again.
                if db.execute("SELECT 1 FROM accounts WHERE player_token=?", (canonical,)).fetchone():
                    canonical = secrets.token_urlsafe(32)
                db.execute("INSERT INTO accounts VALUES (?, ?, ?, ?, ?, NULL, ?)",
                           (account_id, login.casefold(), display_name, hashed, canonical, time.time()))
                return self._issue_session(db, account_id)
        except sqlite3.IntegrityError:
            raise HTTPException(409, "This login is already registered.") from None

    def login(self, login: str, password: str, legacy: str | None = None):
        with self.connection() as db:
            account = db.execute("SELECT * FROM accounts WHERE login=?", (login.casefold(),)).fetchone()
        if not password_matches(password, account["password_hash"] if account else self.dummy_hash) or account is None:
            raise HTTPException(401, "Incorrect login or password.")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if legacy and legacy != account["player_token"]:
                self._link_legacy(db, legacy, account["player_token"])
            return self._issue_session(db, account["id"])

    def _link_legacy(self, db, legacy: str, canonical: str):
        # Never import another registered account's identity after switching users.
        if db.execute("SELECT 1 FROM accounts WHERE player_token=?", (legacy,)).fetchone():
            return
        old, new = identity(legacy), identity(canonical)
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").fetchone()
        if exists:
            for row in db.execute("SELECT code, state FROM sessions").fetchall():
                state = json.loads(row["state"])
                if any(p["identity"] == old for p in state["players"]) and any(p["identity"] == new for p in state["players"]):
                    raise HTTPException(409, "This browser and account are opponents in a duel. Sign out of the browser duel before linking.")
                changed = False
                for part in [state, *state.get("rounds", [])]:
                    for player in part["players"]:
                        if player["identity"] == old:
                            player["identity"] = new
                            changed = True
                if changed:
                    state["version"] += 1
                    db.execute("UPDATE sessions SET state=? WHERE code=?", (json.dumps(state), row["code"]))

        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bank_history'").fetchone():
            db.execute("""INSERT INTO bank_history(identity, problem_id, seen_at, attempted_at, solved_at)
                SELECT ?, problem_id, seen_at, attempted_at, solved_at FROM bank_history WHERE identity=?
                ON CONFLICT(identity, problem_id) DO UPDATE SET
                seen_at=MIN(bank_history.seen_at, excluded.seen_at),
                attempted_at=COALESCE(bank_history.attempted_at, excluded.attempted_at),
                solved_at=COALESCE(bank_history.solved_at, excluded.solved_at)""", (new, old))
            db.execute("DELETE FROM bank_history WHERE identity=?", (old,))

    def is_account_identity(self, token: str) -> bool:
        with self.connection() as db:
            return bool(db.execute("SELECT 1 FROM accounts WHERE player_token=?", (token,)).fetchone())

    def _issue_session(self, db, account_id):
        raw = secrets.token_urlsafe(32)
        db.execute("DELETE FROM account_sessions WHERE expires_at<=?", (time.time(),))
        db.execute("INSERT INTO account_sessions VALUES (?, ?, ?)", (identity(raw), account_id, time.time() + SESSION_SECONDS))
        return db.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone(), raw

    def authenticate(self, token: str | None):
        if not token:
            return None
        with self.connection() as db:
            return db.execute("SELECT a.* FROM accounts a JOIN account_sessions s ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>?", (identity(token), time.time())).fetchone()

    def logout(self, token: str | None):
        if token:
            with self.connection() as db:
                db.execute("DELETE FROM account_sessions WHERE token_hash=?", (identity(token),))

    def set_key(self, account_id: str, key: str | None):
        encrypted = self.cipher.encrypt(key.encode()) if key else None
        with self.connection() as db:
            db.execute("UPDATE accounts SET api_key=? WHERE id=?", (encrypted, account_id))

    def get_key(self, account_id: str) -> str | None:
        with self.connection() as db:
            row = db.execute("SELECT api_key FROM accounts WHERE id=?", (account_id,)).fetchone()
        return self.cipher.decrypt(row[0]).decode() if row and row[0] else None
