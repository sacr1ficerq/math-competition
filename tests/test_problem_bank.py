import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.problem_bank import ProblemBank, ProblemBankError


class ProblemBankTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.problems = self.root / "problems"
        self.problems.mkdir()
        for name in ("quadratic", "quadratic_nonmonic", "count"):
            self.write(name, name)
        self.bank = ProblemBank(self.root / "state.db", self.problems)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, statement):
        (self.problems / f"{name}.json").write_text(json.dumps({"title": name, "statement": statement, "criterions": "private rubric", "reference_solution": "private answer"}))

    def test_union_practice_exhaustion_and_retry(self):
        self.bank.reveal_practice("a", "quadratic")
        self.bank.reveal_practice("b", "quadratic_nonmonic")
        result = self.bank.select("abc", 1, ["a", "b"])
        self.assertEqual(result["id"], "count")
        self.assertEqual(self.bank.select("ABC", 1, ["a", "b"]), result)
        with self.assertRaises(ProblemBankError) as caught:
            self.bank.select("next", 1, ["a", "b"])
        self.assertEqual(caught.exception.status, 409)
        self.assertTrue(all(p["seen"] for p in self.bank.catalog(["a", "b"])))
        public = json.dumps(self.bank.catalog())
        self.assertNotIn("private", public)
        self.assertNotIn("statement", public)

    def test_revision_retirement_preserve_history_and_snapshot(self):
        original = self.bank.select("abc", 1, ["a"], "combinatorics")
        self.write("count", "changed statement")
        self.bank.sync_catalog()
        self.assertEqual(self.bank.select("abc", 1, ["a"]), original)
        with self.assertRaises(ProblemBankError):
            self.bank.select("next", 1, ["a"], "combinatorics")
        newer = self.bank.select("new", 1, ["b"], "combinatorics")
        self.assertNotEqual(original["version"], newer["version"])
        (self.problems / "count.json").unlink()
        self.bank.sync_catalog()
        self.assertEqual(len(self.bank.catalog()), 2)
        self.assertEqual(self.bank.select("abc", 1, ["a"]), original)

    def test_concurrent_starts_and_retry(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda code: self.bank.select(code, 1, ["same", code], "algebra"), ["one", "two"]))
        self.assertNotEqual(results[0]["id"], results[1]["id"])
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.bank.select("retry", 1, ["other"], "combinatorics"), range(2)))
        self.assertEqual(results[0], results[1])

    def test_statuses_are_distinct_and_monotonic(self):
        with self.bank.connection() as db:
            self.bank.record_status(db, "a", "quadratic", "seen")
            self.assertEqual(db.execute("SELECT attempted_at,solved_at FROM bank_history").fetchone(), (None, None))
            self.bank.record_status(db, "a", "quadratic", "attempted")
            attempted, solved = db.execute("SELECT attempted_at,solved_at FROM bank_history").fetchone()
            self.assertIsNotNone(attempted)
            self.assertIsNone(solved)
            self.bank.record_status(db, "a", "quadratic", "solved")
            self.bank.record_status(db, "a", "quadratic", "seen")
            self.assertIsNotNone(db.execute("SELECT solved_at FROM bank_history").fetchone()[0])
