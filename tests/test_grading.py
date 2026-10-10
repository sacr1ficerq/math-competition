import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import GradingConfig, load_settings
from app.grading import GradeRequest, Verdict, grade_solution
from app.main import app


def completion(content):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


VALID_GRADE = {"reasoning": "A complete proof.", "verdict": 10, "evidence": "Uses the constraint to expand the square."}


class GradingTests(unittest.IsolatedAsyncioTestCase):
    async def grade_with(self, responses):
        create = AsyncMock(side_effect=responses)
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        context = AsyncMock()
        context.__aenter__.return_value = client
        request = GradeRequest(api_key="test-secret", solution="My proof")
        settings = load_settings()
        with (
            patch("app.grading.AsyncOpenAI", return_value=context) as factory,
            patch("app.grading.DefaultAsyncHttpxClient") as http_factory,
        ):
            result = await grade_solution(
                request, settings.problem,
                GradingConfig(retry_delay_seconds=0, proxy="http://127.0.0.1:12334"),
            )
        http_factory.assert_called_once_with(proxy="http://127.0.0.1:12334")
        self.assertIs(factory.call_args.kwargs["http_client"], http_factory.return_value)
        self.assertEqual(factory.call_args.kwargs["max_retries"], 0)
        self.assertEqual(factory.call_args.kwargs["base_url"], "https://openrouter.ai/api/v1")
        return result, create

    async def test_success_uses_problem_and_structured_output(self):
        result, create = await self.grade_with([completion(json.dumps(VALID_GRADE))])
        self.assertTrue(result.counted)
        self.assertEqual(result.attempts, 1)
        self.assertEqual(result.grade.verdict, 10)
        self.assertIsNotNone(result.submitted_at.tzinfo)
        arguments = create.call_args.kwargs
        self.assertEqual(arguments["response_format"]["type"], "json_schema")
        payload = json.loads(arguments["messages"][1]["content"])
        self.assertEqual(payload["submitted_solution"], "My proof")
        self.assertIn("criterions", payload["problem"])
        self.assertIn("reference_solution", payload["problem"])
        self.assertNotIn("test-secret", json.dumps(payload))

    async def test_inference_and_validation_errors_are_retried(self):
        result, create = await self.grade_with([
            RuntimeError("provider failure"),
            completion("not JSON"),
            completion(json.dumps({**VALID_GRADE, "verdict": 11})),
            completion(json.dumps(VALID_GRADE)),
        ])
        self.assertEqual(result.attempts, 4)
        self.assertEqual(create.await_count, 4)
        self.assertTrue(result.counted)

    async def test_sixth_attempt_can_succeed(self):
        result, create = await self.grade_with(
            [completion("{}")] * 5 + [completion(json.dumps(VALID_GRADE))]
        )
        self.assertTrue(result.counted)
        self.assertEqual(result.attempts, 6)
        self.assertEqual(create.await_count, 6)

    async def test_exhausted_retries_are_not_counted_and_errors_are_redacted(self):
        result, create = await self.grade_with([RuntimeError("test-secret")] * 6)
        self.assertFalse(result.counted)
        self.assertIsNone(result.grade)
        self.assertEqual(result.status, "failed")
        self.assertEqual(create.await_count, 6)
        self.assertNotIn("test-secret", result.model_dump_json())

    async def test_missing_content_and_choices_are_retried(self):
        result, create = await self.grade_with([
            SimpleNamespace(choices=[]), completion(None), completion(json.dumps(VALID_GRADE))
        ])
        self.assertTrue(result.counted)
        self.assertEqual(create.await_count, 3)


class ValidationTests(unittest.TestCase):
    def test_invalid_verdicts_are_rejected(self):
        for value in [-1, 11, "10", True, float("nan"), float("inf")]:
            with self.subTest(value=value), self.assertRaises(ValidationError):
                Verdict.model_validate({**VALID_GRADE, "verdict": value})

    def test_empty_feedback_and_extra_fields_are_rejected(self):
        for grade in [{**VALID_GRADE, "evidence": ""}, {**VALID_GRADE, "extra": "ignored?"}]:
            with self.assertRaises(ValidationError):
                Verdict.model_validate(grade)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_public_config_hides_grading_material(self):
        response = self.client.get("/api/config")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json()["problem"]), {"title", "statement"})
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_index_and_assets_are_served(self):
        for path in ["/", "/static/app.js", "/static/styles.css"]:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)

    def test_invalid_request_does_not_echo_api_key(self):
        secret = "secret-" * 100
        response = self.client.post("/api/grade", json={"api_key": secret, "solution": ""})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn(secret, response.text)

    def test_custom_problem_is_forwarded_to_grader(self):
        problem = load_settings().problem.model_copy(update={"title": "Custom problem"})
        mock_result = {
            "id": "test", "submitted_at": "2026-10-10T12:00:00Z",
            "status": "graded", "attempts": 1, "counted": True, "grade": VALID_GRADE,
        }
        with patch("app.main.grade_solution", new=AsyncMock(return_value=mock_result)) as grader:
            response = self.client.post("/api/grade", json={
                "api_key": "test-secret", "solution": "My proof", "problem": problem.model_dump(),
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(grader.call_args.args[1].title, "Custom problem")
        self.assertNotIn("test-secret", response.text)


if __name__ == "__main__":
    unittest.main()
