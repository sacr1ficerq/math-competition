import json
from pathlib import Path
import tempfile
import unittest

from app.competition import Store, CompetitionError
from app.config import Problem


class RoomVisibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'db'
        self.store = Store(self.path)
        problem = Problem(title='Task', statement='Question', criterions='Criteria')
        self.code = self.store.create('alice', 'Alice', problem, 'mock/model')['code']
        self.store.join(self.code, 'bob', 'Bob')

    def test_hide_is_personal_persistent_idempotent_and_reversible(self):
        before = self.store.read(self.code, 'alice')
        self.store.visibility(self.code.lower(), 'alice', True)
        self.store.visibility(self.code, 'alice', True)
        self.assertEqual(Store(self.path).recent('alice'), [])
        self.assertEqual(self.store.recent('bob')[0]['code'], self.code)
        with self.store.connection() as db:
            saved = json.loads(db.execute('SELECT state FROM sessions WHERE code=?', (self.code,)).fetchone()[0])
        self.assertEqual(saved, before)
        self.assertEqual(self.store.read(self.code, 'alice')['players'], before['players'])
        self.store.visibility(self.code, 'alice', False)
        self.store.visibility(self.code, 'alice', False)
        self.assertEqual(self.store.recent('alice')[0]['code'], self.code)

    def test_closed_room_can_be_hidden_and_still_read(self):
        self.store.close(self.code, 'alice', 1)
        self.store.visibility(self.code, 'bob', True)
        self.assertEqual(self.store.recent('bob'), [])
        self.assertIsNotNone(self.store.read(self.code, 'bob')['closed_at'])

    def test_outsider_cannot_hide_or_restore(self):
        for hidden in (True, False):
            with self.assertRaises(CompetitionError) as caught:
                self.store.visibility(self.code, 'outsider', hidden)
            self.assertEqual(caught.exception.status, 403)
        self.assertEqual(len(self.store.recent('alice')), 1)

    def test_missing_room(self):
        with self.assertRaises(CompetitionError) as caught:
            self.store.visibility('missing', 'alice', True)
        self.assertEqual(caught.exception.status, 404)
