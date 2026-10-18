import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

from app.competition import CompetitionError, Store, snapshot
from app.config import Problem


class RematchConsentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / 'consent.sqlite3')
        self.code = self.store.create('alice', 'Alice', Problem(title='Task', statement='Prove it', criterions='Proof'), 'test/model')['code']
        self.store.join(self.code, 'bob', 'Bob')
        self.store.ready(self.code, 'alice', True)
        self.store.ready(self.code, 'bob', True)
        _, submission, _ = self.store.submit(self.code, 'alice', 'Original proof', 'submission')
        self.submission = submission['id']
        self.store.complete(self.code, self.submission, {'status': 'graded', 'attempts': 1, 'grade': {'verdict': 8, 'reasoning': 'Original grade', 'evidence': ''}})
        self.store.finalize(self.code, 'alice')
        self.finished = self.store.finalize(self.code, 'bob')

    def test_single_consent_is_persistent_idempotent_and_keeps_appeal_available(self):
        for _ in range(2):
            waiting = self.store.rematch(self.code, 'bob', 1)
            self.assertEqual(waiting['round'], 1)
            self.assertEqual(waiting['phase'], 'finished')
            self.assertEqual(waiting['rounds'], [])
            self.assertEqual(waiting['result'], self.finished['result'])
            self.assertEqual(waiting['players'][0]['submissions'], self.finished['players'][0]['submissions'])
        persisted = Store(self.store.path).read(self.code, 'alice')
        public = snapshot(persisted, 'alice')
        self.assertEqual([p['next_round_ready'] for p in public['players']], [False, True])
        self.assertTrue(public['players'][0]['submissions'][0]['appeal_eligible'])
        _, _, appeal, created = self.store.appeal(self.code, 'alice', self.submission, 'Review original proof', 'appeal', 1)
        self.assertTrue(created)
        after = self.store.read(self.code, 'alice')
        self.assertEqual([p['next_round_ready'] for p in snapshot(after, 'alice')['players']], [False, False])
        self.assertEqual(appeal['status'], 'pending')

    def test_pending_appeal_blocks_confirmation_and_requires_fresh_mutual_consent(self):
        self.store.rematch(self.code, 'alice', 1)
        _, _, appeal, _ = self.store.appeal(self.code, 'alice', self.submission, 'Please review', 'appeal', 1)
        for token in ['alice', 'bob']:
            with self.assertRaises(CompetitionError):
                self.store.rematch(self.code, token, 1)
            self.assertEqual(self.store.rematch(self.code, token, 1, ready=False)['round'], 1)
        self.store.complete_appeal(self.code, self.submission, appeal['id'], {'status': 'graded', 'attempts': 1, 'grade': {'verdict': 9, 'reasoning': 'Revised grade', 'evidence': ''}})
        waiting = self.store.rematch(self.code, 'bob', 1)
        self.assertEqual(waiting['phase'], 'finished')
        self.assertEqual(waiting['round'], 1)
        started = self.store.rematch(self.code, 'alice', 1)
        self.assertEqual(started['round'], 2)
        self.assertEqual([p['next_round_ready'] for p in started['players']], [False, False])
        self.assertEqual(started['rounds'][0]['players'][0]['submissions'][0]['effective_verdict'], 9)

    def test_withdraw_prevents_other_consent_from_starting_round(self):
        self.store.rematch(self.code, 'alice', 1)
        withdrawn = self.store.rematch(self.code, 'alice', 1, ready=False)
        self.assertFalse(withdrawn['players'][0]['next_round_ready'])
        waiting = self.store.rematch(self.code, 'bob', 1)
        self.assertEqual(waiting['round'], 1)
        self.assertEqual(waiting['rounds'], [])
        self.assertEqual(self.store.rematch(self.code, 'alice', 1)['round'], 2)

    def test_parallel_players_start_once_and_stale_retry_cannot_mutate_new_round(self):
        barrier = Barrier(2)
        def confirm(token):
            barrier.wait()
            return Store(self.store.path).rematch(self.code, token, 1)['round']
        with ThreadPoolExecutor(max_workers=2) as pool:
            rounds = list(pool.map(confirm, ['alice', 'bob']))
        self.assertEqual(sorted(rounds), [1, 2])
        self.store.ready(self.code, 'alice', True, round=2)
        for token in ['alice', 'bob']:
            for ready in [True, False]:
                state = self.store.rematch(self.code, token, 1, ready=ready)
                self.assertEqual(state['round'], 2)
                self.assertEqual(len(state['rounds']), 1)
                self.assertTrue(state['players'][0]['ready'])
                self.assertFalse(any(p['next_round_ready'] for p in state['players']))
        for ready in [True, False]:
            with self.assertRaises(CompetitionError) as error:
                self.store.rematch(self.code, 'outsider', 1, ready=ready)
            self.assertEqual(error.exception.status, 403)

    def test_closed_room_cannot_accept_or_withdraw_consent(self):
        self.store.rematch(self.code, 'alice', 1)
        self.store.close(self.code, 'alice', 1)
        for ready in [True, False]:
            with self.assertRaises(CompetitionError):
                self.store.rematch(self.code, 'bob', 1, ready=ready)
        state = self.store.read(self.code, 'alice')
        self.assertEqual(state['round'], 1)
        self.assertEqual(state['rounds'], [])

    def test_legacy_snapshot_defaults_to_no_consent(self):
        with self.store.edit(self.code) as state:
            for player in state['players']:
                player.pop('next_round_ready')
        state = self.store.read(self.code, 'alice')
        self.assertEqual([p['next_round_ready'] for p in snapshot(state, 'alice')['players']], [False, False])
