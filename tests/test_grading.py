import base64
import json
import unittest
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from pydantic import ValidationError
from PIL import Image

from app.config import GradingConfig, load_settings
from app.grading import GradeRequest, Verdict, grade_solution
from app.main import app
from app.solutions import MAX_IMAGE_BYTES, SolutionContent, SolutionImage


def completion(content):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


VALID_GRADE = {"reasoning": "A complete proof.", "verdict": 10, "evidence": "Uses the constraint to expand the square."}


def screenshot(format="PNG", size=(2, 2), mode="RGB"):
    buffer = BytesIO()
    Image.new(mode, size).save(buffer, format=format)
    mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}[format]
    return {"name": "Proof screenshot", "data_url": f"data:{mime};base64," + base64.b64encode(buffer.getvalue()).decode()}


class GradingTests(unittest.IsolatedAsyncioTestCase):
    async def grade_with(self, responses, solution="My proof", images=None):
        create = AsyncMock(side_effect=responses)
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        context = AsyncMock()
        context.__aenter__.return_value = client
        request = GradeRequest(api_key="test-secret", solution=solution, images=images or [])
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
        self.assertIn("Write reasoning and evidence in Russian", arguments["messages"][0]["content"])
        payload = json.loads(arguments["messages"][1]["content"])
        self.assertEqual(payload["submitted_solution"], "My proof")
        self.assertIn("criterions", payload["problem"])
        self.assertIn("reference_solution", payload["problem"])
        self.assertNotIn("test-secret", json.dumps(payload))

    async def test_screenshots_are_sent_as_images_with_optional_text(self):
        images = [screenshot(), screenshot("JPEG")]
        for solution in ["", "See the attached handwritten proof."]:
            with self.subTest(solution=solution):
                result, create = await self.grade_with([completion(json.dumps(VALID_GRADE))], solution, images)
                self.assertTrue(result.counted)
                content = create.call_args.kwargs["messages"][1]["content"]
                payload = json.loads(content[0]["text"])
                self.assertEqual(payload["submitted_solution"], solution)
                self.assertIn("reference_solution", payload["problem"])
                self.assertEqual(content[1:], [
                    {"type": "image_url", "image_url": {"url": image["data_url"]}}
                    for image in images
                ])
                self.assertNotIn("test-secret", json.dumps(content))

    async def test_retry_keeps_original_text_and_images_after_invalid_output(self):
        images = [screenshot()]
        result, create = await self.grade_with([
            completion("not JSON"),
            completion(json.dumps({**VALID_GRADE, "verdict": 11})),
            completion(json.dumps(VALID_GRADE)),
        ], "Original proof", images)
        self.assertTrue(result.counted)
        self.assertEqual(result.attempts, 3)
        for call in create.await_args_list:
            content = call.kwargs["messages"][1]["content"]
            self.assertEqual(json.loads(content[0]["text"])["submitted_solution"], "Original proof")
            self.assertEqual(content[1]["image_url"]["url"], images[0]["data_url"])

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
        for call in create.await_args_list:
            self.assertEqual(json.loads(call.kwargs["messages"][1]["content"])["submitted_solution"], "My proof")

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
    def test_valid_screenshot_formats_and_image_only_solutions(self):
        for format in ["PNG", "JPEG", "WEBP"]:
            with self.subTest(format=format):
                content = SolutionContent(images=[screenshot(format)])
                self.assertEqual(content.solution, "")
                self.assertEqual(len(content.images), 1)

    def test_invalid_and_oversized_screenshots_are_rejected(self):
        png = screenshot()
        invalid = [
            "https://example.com/proof.png",
            "data:image/svg+xml;base64,PHN2Zy8+",
            "data:image/png;base64,not-base64!",
            "data:image/png;base64," + base64.b64encode(b"not an image").decode(),
            png["data_url"].replace("image/png", "image/jpeg"),
            "data:image/png;base64," + base64.b64encode(b"x" * (MAX_IMAGE_BYTES + 1)).decode(),
            screenshot(size=(5000, 4001), mode="1")["data_url"],
        ]
        for index, data_url in enumerate(invalid):
            with self.subTest(index=index), self.assertRaises(ValidationError):
                SolutionImage(data_url=data_url)

    def test_empty_solution_and_too_many_screenshots_are_rejected(self):
        for content in [{}, {"solution": "   "}, {"images": [screenshot()] * 5}]:
            with self.assertRaises(ValidationError):
                SolutionContent.model_validate(content)

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

    def test_practice_image_only_submission_reaches_grader(self):
        image = screenshot()
        mock_result = {
            "id": "image-test", "submitted_at": "2026-10-10T12:00:00Z",
            "status": "graded", "attempts": 1, "counted": True, "grade": VALID_GRADE,
        }
        with patch("app.main.grade_solution", new=AsyncMock(return_value=mock_result)) as grader:
            response = self.client.post("/api/grade", json={"api_key": "test-secret", "images": [image]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(grader.call_args.args[0].images[0].data_url, image["data_url"])


if __name__ == "__main__":
    unittest.main()
