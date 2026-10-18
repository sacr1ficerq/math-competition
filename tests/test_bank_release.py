"""Release gates reject changes made after mathematical review."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class BankReleaseTests(unittest.TestCase):
    def test_review_binds_to_content_and_reviewer(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            reviews = directory / 'reviews'
            reviews.mkdir()
            problem = dict(id='example', title='Example', statement='Prove this.',
                           criterions='Complete proof earns 10.', reference_solution='Proof.',
                           topic='algebra', topic_label='Algebra', retired=False,
                           review_status='reviewed', reviewed_by='reviewer')
            digest = hashlib.sha256((problem['statement'] + problem['criterions'] + problem['reference_solution']).encode()).hexdigest()
            report = reviews / 'example.json'
            report.write_text(json.dumps(dict(reviewer='reviewer', files=[dict(
                id='example', status='verified', content_hash=digest)])))

            def check():
                (directory / 'example.json').write_text(json.dumps(problem))
                result = subprocess.run([
                    sys.executable, str(ROOT / 'scripts/validate_problem_bank.py'),
                    '--directory', str(directory), '--min-active', '1', '--verify-review-hashes',
                ], capture_output=True, text=True)
                return result.returncode

            self.assertEqual(check(), 0)
            problem['reference_solution'] = 'Changed after review.'
            self.assertNotEqual(check(), 0)
            problem['reference_solution'] = 'Proof.'
            problem['reviewed_by'] = 'someone_else'
            self.assertNotEqual(check(), 0)
            problem['reviewed_by'] = 'reviewer'
            report.rename(reviews / 'typography.json')
            self.assertNotEqual(check(), 0)
