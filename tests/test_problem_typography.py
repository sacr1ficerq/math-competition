import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

from app.api import decorate, grading_problem
from app.competition import Store
from app.config import Problem
from app.problem_bank import ProblemBank


class TypographyPresentationTests(unittest.TestCase):
    def test_exact_presentation_preserves_grading_and_early_reference_privacy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            problems = root / 'problems'
            problems.mkdir()
            original = 'Find A_i+B_j.'
            formatted = 'Find $A_i+B_j$.'
            problem = Problem(title='P', statement=original, criterions='C', reference_solution=original)
            (problems / 'p.json').write_text(json.dumps(problem.model_dump()))
            bank = ProblemBank(root/'db', problems)
            (problems/'presentation').mkdir()
            overlay = problems/'presentation'/'typography.json'
            overlay.write_text(json.dumps({'texts': {hashlib.sha256(original.encode()).hexdigest(): formatted}}))
            store = Store(root/'db')
            code = store.create('a', 'A', problem, 'mock/model')['code']
            store.join(code, 'b', 'B')
            store.ready(code, 'a', True)
            session = store.ready(code, 'b', True)
            request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(problem_bank=bank)), cookies={})
            active = decorate(request, session, 'a')
            self.assertEqual(active['problem']['statement'], formatted)
            self.assertNotIn('reference_solution', active['problem'])
            self.assertEqual(grading_problem(session).statement, original)
            store.finalize(code, 'a')
            session = store.finalize(code, 'b')
            finished = decorate(request, session, 'a')
            self.assertEqual(finished['problem']['reference_solution'], formatted)
            self.assertEqual(session['problem']['statement'], original)
            self.assertEqual(session['problem']['reference_solution'], original)
            self.assertEqual(store.read(code, 'a')['problem']['statement'], original)
            self.assertEqual(bank.presentation_text(original + ' changed'), original + ' changed')
            self.assertNotIn('statement', bank.catalog()[0])
            overlay.write_text('{broken')
            self.assertEqual(bank.presentation_text(original), original)
