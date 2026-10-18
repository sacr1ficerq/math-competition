"""Versioned private problem catalog and permanent per-person exposure history."""
import hashlib
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from app.config import ROOT, Problem
from app.problem_subtopics import SUBTOPIC_LABELS


class ProblemBankError(Exception):
    def __init__(self, message, status=409):
        self.message, self.status = message, status
        super().__init__(message)


class ProblemBank:
    def __init__(self, path, problems_dir=ROOT / "problems"):
        self.path = str(path)
        self.problems_dir = Path(problems_dir)
        self.public_labels = {}
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS bank_problems (
                    id TEXT PRIMARY KEY, topic TEXT NOT NULL, topic_label TEXT NOT NULL,
                    version TEXT NOT NULL, retired INTEGER NOT NULL, content TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS bank_history (
                    identity TEXT NOT NULL, problem_id TEXT NOT NULL,
                    seen_at REAL NOT NULL, attempted_at REAL, solved_at REAL,
                    PRIMARY KEY(identity, problem_id));
                CREATE TABLE IF NOT EXISTS bank_rounds (
                    code TEXT NOT NULL, round INTEGER NOT NULL, snapshot TEXT NOT NULL,
                    PRIMARY KEY(code, round));
            """)
        self.sync_catalog()

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def sync_catalog(self):
        """Catalog entries may override filename ids/topics; removal retires a task."""
        manifest_path = self.problems_dir / "catalog.json"
        manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
        entries = manifest.get("problems", []) if isinstance(manifest, dict) else manifest
        overrides = {entry.get("file", entry.get("id", "") + ".json"): entry for entry in entries}
        public_labels = {}
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE bank_problems SET retired = 1")
            for path in sorted(self.problems_dir.glob("*.json")):
                if path.name == "catalog.json":
                    continue
                entry = overrides.get(path.name, {})
                raw = json.loads(path.read_text(encoding="utf-8"))
                identifier = entry.get("id", raw.get("id", path.stem))
                public_labels[identifier] = SUBTOPIC_LABELS.get(entry.get("subtopic", raw.get("subtopic")), "")
                content = Problem.model_validate({k: raw[k] for k in Problem.model_fields}).model_dump()
                serialized = json.dumps(content, ensure_ascii=False, sort_keys=True)
                topic = entry.get("topic", raw.get("topic", "algebra" if path.stem.startswith("quadratic") else "combinatorics"))
                label = entry.get("topic_label", raw.get("topic_label", {"algebra": "Алгебра", "combinatorics": "Комбинаторика"}.get(topic, topic)))
                db.execute("""INSERT INTO bank_problems VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET topic=excluded.topic, topic_label=excluded.topic_label,
                    version=excluded.version, retired=excluded.retired, content=excluded.content""",
                    (entry.get("id", raw.get("id", path.stem)), topic, label,
                     hashlib.sha256(serialized.encode()).hexdigest()[:16], int(entry.get("retired", raw.get("retired", False))), serialized))
        self.public_labels = public_labels

    @staticmethod
    def record_status(db, identity, problem_id, status="seen"):
        if status not in {"seen", "attempted", "solved"}:
            raise ValueError("Unknown problem status")
        now = time.time()
        db.execute("INSERT OR IGNORE INTO bank_history(identity,problem_id,seen_at) VALUES (?,?,?)", (identity, problem_id, now))
        if status in {"attempted", "solved"}:
            db.execute("UPDATE bank_history SET attempted_at=COALESCE(attempted_at,?) WHERE identity=? AND problem_id=?", (now, identity, problem_id))
        if status == "solved":
            db.execute("UPDATE bank_history SET solved_at=COALESCE(solved_at,?) WHERE identity=? AND problem_id=?", (now, identity, problem_id))

    @staticmethod
    def _rows(db, participant_keys=(), topic=None):
        rows = db.execute("SELECT id,topic,topic_label,version,content FROM bank_problems WHERE retired=0" + (" AND topic=?" if topic else "") + " ORDER BY id", (topic,) if topic else ()).fetchall()
        seen = set()
        for key in set(participant_keys):
            seen.update(row[0] for row in db.execute("SELECT problem_id FROM bank_history WHERE identity=?", (key,)))
        return rows, seen

    def catalog(self, participant_keys=(), topic=None):
        with self.connection() as db:
            rows, seen = self._rows(db, participant_keys, topic)
            return [{"id": r[0], "topic": r[1], "topic_label": r[2], "subtopic_label": self.public_labels.get(r[0], ""), "version": r[3], "title": json.loads(r[4])["title"], "seen": r[0] in seen} for r in rows]

    def topics(self, participant_keys=()):
        result = {}
        for p in self.catalog(participant_keys):
            item = result.setdefault(p["topic"], {"slug": p["topic"], "label": p["topic_label"], "count": 0, "unseen_count": 0})
            item["count"] += 1
            item["unseen_count"] += not p["seen"]
        return list(result.values())

    def select_for_round(self, db, code, round, participant_keys, topic=None):
        """Caller must hold BEGIN IMMEDIATE, sharing its session transaction."""
        if not db.in_transaction:
            raise RuntimeError("Selection requires an active write transaction")
        previous = db.execute("SELECT snapshot FROM bank_rounds WHERE code=? AND round=?", (code.upper(), round)).fetchone()
        if previous:
            return json.loads(previous[0])
        keys = tuple(set(participant_keys))
        if not keys:
            raise ValueError("Selection requires participants")
        rows, seen = self._rows(db, keys, topic)
        available = [row for row in rows if row[0] not in seen]
        if not available:
            raise ProblemBankError("No common unseen problems remain in this topic. Choose another topic or add new problems to the bank.")
        chosen = secrets.choice(available)
        snapshot = {**json.loads(chosen[4]), "id": chosen[0], "topic": chosen[1], "topic_label": chosen[2], "version": chosen[3]}
        db.execute("INSERT INTO bank_rounds VALUES (?,?,?)", (code.upper(), round, json.dumps(snapshot)))
        for key in keys:
            self.record_status(db, key, chosen[0])
        return snapshot

    def select(self, code, round, participant_keys, topic=None):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            return self.select_for_round(db, code, round, participant_keys, topic)

    def reveal_practice(self, participant_key, problem_id):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT content,version,topic,topic_label FROM bank_problems WHERE id=? AND retired=0", (problem_id,)).fetchone()
            if row is None:
                raise ProblemBankError("Problem not found.", 404)
            self.record_status(db, participant_key, problem_id)
            content = json.loads(row[0])
            return {"id": problem_id, "version": row[1], "topic": row[2], "topic_label": row[3], "title": content["title"], "statement": content["statement"]}
