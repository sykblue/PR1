import json
import unittest
from datetime import datetime, timezone
from email.utils import format_datetime
from unittest.mock import call, patch

import requests
from PIL import Image

from services.errors import ServiceError
from services.gemini import GeminiClient, retry_delay
from helpers import visual_evidence


def response(status, body=None, retry_after=None):
    result = requests.Response()
    result.status_code = status
    result._content = json.dumps(body or {}).encode()
    result._content_consumed = True
    if retry_after is not None:
        result.headers["Retry-After"] = retry_after
    return result


def success():
    result = {"image_usable": True, "visible_signal": "unclear", "summary": "Test observation",
              "observations": [{"area": "hairline", "detail": "Test outline"}],
              "limitations": ["Single image"], "next_steps": ["Keep consistent photos"], "visual_evidence": visual_evidence()}
    return response(200, {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": json.dumps(result)}]}}]})


class GeminiRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.model = GeminiClient("test-secret-key", "test-model", 60)
        self.image = Image.new("RGB", (160, 160))

    @patch("services.gemini.time.sleep")
    @patch("services.gemini.requests.post")
    def test_analysis_recovers_from_transient_errors_without_changing_the_request(self, post, sleep):
        post.side_effect = [response(503), response(500), success()]
        result = self.model.analyze(self.image)
        self.assertEqual(result["summary"], "Test observation")
        self.assertEqual(post.call_count, 3)
        self.assertEqual(sleep.call_args_list, [call(1), call(2)])
        self.assertTrue(all(c.kwargs["json"] == post.call_args_list[0].kwargs["json"] for c in post.call_args_list))

    @patch("services.gemini.time.sleep")
    @patch("services.gemini.requests.post")
    def test_transient_failures_stop_after_three_attempts_with_a_specific_error(self, post, sleep):
        for status in (500, 502, 503, 504):
            with self.subTest(status=status):
                post.reset_mock(); sleep.reset_mock()
                post.side_effect = [response(status) for _ in range(3)]
                with self.assertRaises(ServiceError) as caught:
                    self.model.analyze(self.image)
                self.assertEqual(post.call_count, 3)
                self.assertEqual(caught.exception.code, "upstream_timeout" if status == 504 else "upstream_unavailable")
                self.assertEqual(caught.exception.status, 504 if status == 504 else 503)

    @patch("services.gemini.time.sleep")
    @patch("services.gemini.requests.post")
    def test_bad_request_auth_quota_and_unknown_errors_are_not_retried(self, post, sleep):
        for status, code in ((400, "upstream_bad_request"), (401, "upstream_auth"), (403, "upstream_auth"),
                             (404, "upstream_model"), (429, "upstream_quota"), (409, "upstream_error")):
            with self.subTest(status=status):
                post.reset_mock(); post.return_value = response(status)
                with self.assertRaises(ServiceError) as caught:
                    self.model.analyze(self.image)
                self.assertEqual(caught.exception.code, code)
                post.assert_called_once()
        sleep.assert_not_called()

    @patch("services.gemini.requests.post")
    def test_400_key_failures_and_project_preconditions_are_identified(self, post):
        for error, code in (({"message": "API key expired. Renew the API key."}, "upstream_auth"),
                            ({"details": [{"reason": "API_KEY_INVALID"}]}, "upstream_auth"),
                            ({"status": "FAILED_PRECONDITION"}, "upstream_precondition")):
            with self.subTest(code=code):
                post.return_value = response(400, {"error": error})
                with self.assertRaises(ServiceError) as caught:
                    self.model.analyze(self.image)
                self.assertEqual(caught.exception.code, code)

    @patch("services.gemini.time.sleep")
    @patch("services.gemini.requests.post")
    def test_paid_image_generation_never_retries(self, post, sleep):
        post.return_value = response(503)
        with self.assertRaises(ServiceError):
            self.model.generate(self.image, "test-image-model", "hairline", 25)
        post.assert_called_once()
        sleep.assert_not_called()

    @patch("services.gemini.requests.post")
    def test_invalid_successful_output_is_not_requested_again(self, post):
        post.return_value = response(200, {"candidates": [{"finishReason": "MAX_TOKENS"}]})
        with self.assertRaises(ServiceError) as caught:
            self.model.analyze(self.image)
        self.assertEqual(caught.exception.code, "invalid_ai_output")
        post.assert_called_once()

    @patch("services.gemini.time.sleep")
    @patch("services.gemini.requests.post")
    def test_transport_failures_do_not_resend_uncertain_requests(self, post, sleep):
        for error, code in ((requests.Timeout("private transport details"), "upstream_timeout"),
                            (requests.ConnectionError("private transport details"), "upstream_connection")):
            with self.subTest(code=code):
                post.reset_mock(); post.side_effect = error
                with self.assertRaises(ServiceError) as caught:
                    self.model.analyze(self.image)
                self.assertEqual(caught.exception.code, code)
                self.assertNotIn("private", str(caught.exception))
                post.assert_called_once()
        sleep.assert_not_called()

    @patch("services.gemini.time.monotonic")
    @patch("services.gemini.time.sleep")
    @patch("services.gemini.requests.post")
    def test_retries_share_the_existing_timeout_budget(self, post, sleep, monotonic):
        clock = [0]
        monotonic.side_effect = lambda: clock[0]
        def unavailable(*args, **kwargs):
            clock[0] += 59
            return response(503)
        post.side_effect = unavailable
        with self.assertRaises(ServiceError):
            self.model.analyze(self.image)
        post.assert_called_once()
        sleep.assert_not_called()

    @patch("services.gemini.time.monotonic")
    @patch("services.gemini.time.sleep")
    @patch("services.gemini.requests.post")
    def test_the_read_timeout_shrinks_as_requests_and_backoff_use_time(self, post, sleep, monotonic):
        clock = [0]
        monotonic.side_effect = lambda: clock[0]
        sleep.side_effect = lambda delay: clock.__setitem__(0, clock[0] + delay)
        def request(*args, **kwargs):
            clock[0] += 8
            return response(503) if post.call_count == 1 else success()
        post.side_effect = request
        self.model.analyze(self.image)
        self.assertEqual(post.call_args_list[0].kwargs["timeout"], (10, 60))
        self.assertEqual(post.call_args_list[1].kwargs["timeout"], (10, 51))

    @patch("services.gemini.time.time", return_value=1000)
    def test_retry_after_seconds_and_dates_are_respected_and_invalid_headers_use_backoff(self, now):
        date = format_datetime(datetime.fromtimestamp(1004, tz=timezone.utc), usegmt=True)
        for header, expected in (("4", 4), (date, 4), ("invalid header", 1), (None, 1)):
            with self.subTest(header=header):
                self.assertEqual(retry_delay(response(503, retry_after=header), 0), expected)

    @patch("services.gemini.time.sleep")
    @patch("services.gemini.requests.post")
    def test_retry_after_beyond_the_budget_returns_without_sleeping(self, post, sleep):
        post.return_value = response(503, retry_after="120")
        with self.assertRaises(ServiceError):
            self.model.analyze(self.image)
        post.assert_called_once()
        sleep.assert_not_called()

    @patch("services.gemini.requests.post")
    def test_upstream_body_and_private_identifiers_never_appear_in_messages_or_logs(self, post):
        private = "PRIVATE-PROJECT-PHOTO-DETAIL-test-secret-key"
        post.return_value = response(400, {"error": {"message": private, "details": [{"metadata": {"consumer": private}}]}})
        with self.assertLogs("services.gemini", level="WARNING") as logs:
            with self.assertRaises(ServiceError) as caught:
                self.model.analyze(self.image)
        self.assertNotIn(private, str(caught.exception))
        self.assertNotIn(private, " ".join(logs.output))
        self.assertIn("status=400", " ".join(logs.output))


if __name__ == "__main__":
    unittest.main()
