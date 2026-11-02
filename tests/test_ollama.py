import base64
import io
import json
import unittest
from unittest.mock import Mock, patch

import requests
from PIL import Image, ImageDraw

from app import create_app
from helpers import TEST_CONFIG, client_with_csrf, visual_evidence
from services.analysis import AnalysisService
from services.errors import ServiceError
from services.gemini import SYSTEM_PROMPT, ANALYSIS_FOCUS
from services.ollama import OllamaClient, LOCAL_ANALYSIS_SCHEMA


def observation():
    return {"image_usable": True, "visible_signal": "not_obvious", "summary": "Test observation",
            "observations": [{"area": "hairline", "detail": "Visible outline"}],
            "limitations": ["Single image"], "next_steps": ["Record consistent photos"],
            "visual_evidence": visual_evidence(scalp_in_hair="not_obvious")}


def response(status=200, body=None):
    result = requests.Response()
    result.status_code = status
    result._content = json.dumps(body if body is not None else {}).encode()
    result._content_consumed = True
    return result


def completed(value=None, **fields):
    return response(body={"done": True, "done_reason": "stop", "message": {"content": json.dumps(value or observation())}, **fields})


class OllamaTests(unittest.TestCase):
    def setUp(self):
        self.image = Image.new("RGB", (160, 200))
        self.model = OllamaClient()
        self.session = Mock()
        self.session.post.side_effect = [response(body={"capabilities": ["completion", "vision"]}), completed()]
        self.factory = patch("services.ollama.requests.Session")
        self.factory.start().return_value.__enter__.return_value = self.session
        self.addCleanup(self.factory.stop)

    def test_native_vision_request_shares_prompt_focus_context_and_standard_json_schema(self):
        result = self.model.analyze(self.image, ocr_text="untrusted reference", local_result={"label": "user label"}, focus="crown")
        self.assertEqual(result, observation())
        self.assertFalse(self.session.trust_env)
        show, chat = self.session.post.call_args_list
        self.assertEqual(show.args[0], "http://127.0.0.1:11434/api/show")
        self.assertEqual(show.kwargs["json"], {"model": "qwen2.5vl:3b"})
        self.assertEqual(chat.args[0], "http://127.0.0.1:11434/api/chat")
        self.assertFalse(chat.kwargs["allow_redirects"])
        payload = chat.kwargs["json"]
        self.assertFalse(payload["stream"])
        self.assertEqual(payload["messages"][0], {"role": "system", "content": SYSTEM_PROMPT})
        user = payload["messages"][1]
        self.assertIn(ANALYSIS_FOCUS["crown"], user["content"])
        self.assertIn('"ocr_text": "untrusted reference"', user["content"])
        self.assertIn('"experimental_local_classifier"', user["content"])
        self.assertEqual(payload["format"]["type"], "object")
        self.assertEqual(LOCAL_ANALYSIS_SCHEMA["properties"]["image_usable"]["type"], "boolean")
        with Image.open(io.BytesIO(base64.b64decode(user["images"][0], validate=True))) as image:
            self.assertEqual(image.size, self.image.size)
            self.assertEqual(image.format, "JPEG")
        self.assertNotIn("headers", chat.kwargs)

    def test_nonlocal_urls_redirects_and_cloud_models_are_blocked_before_photo_submission(self):
        for url in ("https://ollama.com", "http://192.168.1.5:11434", "http://localhost.evil:11434",
                    "http://127.0.0.1:11434/api", "http://user:secret@127.0.0.1", "http://127.0.0.1?x=1", "http://127.0.0.1:99999"):
            with self.subTest(url=url):
                with self.assertRaises(ServiceError) as caught:
                    OllamaClient(url).analyze(self.image)
                self.assertEqual(caught.exception.code, "ollama_not_configured")
        with self.assertRaises(ServiceError) as caught:
            OllamaClient(model="qwen3-vl:cloud").analyze(self.image)
        self.assertEqual(caught.exception.code, "ollama_local_model_required")
        self.session.post.assert_not_called()
        for body, status, code in (({}, 302, "ollama_error"),
                                   ({"capabilities": ["vision"], "remote_host": "https://ollama.com"}, 200, "ollama_local_model_required"),
                                   ({"capabilities": ["vision"], "remote_model": "remote"}, 200, "ollama_local_model_required")):
            self.session.post.reset_mock(side_effect=True)
            self.session.post.return_value = response(status, body)
            with self.assertRaises(ServiceError) as caught:
                self.model.analyze(self.image)
            self.assertEqual(caught.exception.code, code)
            self.session.post.assert_called_once()

    def test_text_only_or_unknown_model_capabilities_never_receive_an_image(self):
        for capabilities in (["completion", "tools"], None, 7, "vision"):
            self.session.post.reset_mock(side_effect=True)
            self.session.post.return_value = response(body={"capabilities": capabilities})
            with self.assertRaises(ServiceError) as caught:
                self.model.analyze(self.image)
            self.assertEqual(caught.exception.code, "ollama_vision_required")
            self.session.post.assert_called_once()

    def test_missing_model_busy_timeout_and_connection_errors_are_specific_and_private(self):
        for outcome, code in ((response(404, {"error": "PRIVATE"}), "ollama_model_missing"),
                              (response(429), "ollama_busy"), (response(500), "ollama_error"),
                              (requests.Timeout("PRIVATE"), "ollama_timeout"),
                              (requests.ConnectionError("PRIVATE"), "ollama_connection")):
            with self.subTest(code=code):
                self.session.post.reset_mock()
                self.session.post.side_effect = [outcome]
                with self.assertRaises(ServiceError) as caught:
                    self.model.analyze(self.image)
                self.assertEqual(caught.exception.code, code)
                self.assertNotIn("PRIVATE", caught.exception.message)
                self.session.post.assert_called_once()

    def test_incomplete_invalid_or_nonmatching_results_are_rejected(self):
        invalid = observation(); invalid["visible_signal"] = "diagnosis"
        for output in (completed(done=False), completed(done_reason="length"),
                       response(body={"done": True, "message": {"content": "not JSON"}}), completed(invalid),
                       response(body={"done": True, "message": {"content": "{}"}})):
            self.session.post.side_effect = [response(body={"capabilities": ["vision"]}), output]
            with self.assertRaises(ServiceError) as caught:
                self.model.analyze(self.image)
            self.assertEqual(caught.exception.code, "ollama_invalid_output")

    def test_unusable_photo_remains_a_422_instead_of_fabricating_a_report(self):
        value = observation(); value["image_usable"] = False; value["observations"] = []
        self.session.post.side_effect = [response(body={"capabilities": ["vision"]}), completed(value)]
        with self.assertRaises(ServiceError) as caught:
            self.model.analyze(self.image)
        self.assertEqual((caught.exception.status, caught.exception.code), (422, "photo_not_usable"))

    @patch("services.ollama.time.monotonic", side_effect=[0, 8])
    def test_preflight_and_inference_share_a_timeout_budget(self, monotonic):
        self.model.analyze(self.image)
        self.assertEqual(self.session.post.call_args.kwargs["timeout"], (5, 112))


class AnalysisRoutingTests(unittest.TestCase):
    def setUp(self):
        self.gemini = Mock(model="test-gemini")
        self.ollama = Mock(model="test-local-vision")
        self.gemini.analyze.return_value = self.ollama.analyze.return_value = observation()
        self.service = AnalysisService(self.gemini, self.ollama)
        self.image = Image.new("RGB", (160, 200))

    def test_successful_gemini_never_calls_local_and_quota_uses_same_image_and_context_once(self):
        normal = self.service.analyze(self.image, focus="hairline")
        self.assertEqual(normal["provider"], "gemini")
        self.assertIsNone(normal["fallback_reason"])
        self.ollama.analyze.assert_not_called()
        self.gemini.analyze.reset_mock()
        self.gemini.analyze.side_effect = ServiceError("quota", 429, "upstream_quota")
        local = self.service.analyze(self.image, focus="density", ocr_text="reference", local_result=None)
        self.assertEqual((local["provider"], local["model"], local["fallback_reason"]), ("ollama", "test-local-vision", "gemini_quota"))
        self.assertEqual(self.gemini.analyze.call_args, self.ollama.analyze.call_args)
        self.gemini.analyze.assert_called_once()
        self.ollama.analyze.assert_called_once()

    def test_auth_network_output_photo_errors_and_disabled_fallback_keep_original_error(self):
        for code in ("upstream_auth", "upstream_connection", "upstream_timeout", "upstream_unavailable",
                     "invalid_ai_output", "photo_not_usable", "api_key_missing", "upstream_precondition"):
            error = ServiceError("Original", 502, code)
            self.gemini.analyze.side_effect = error
            with self.assertRaises(ServiceError) as caught:
                self.service.analyze(self.image)
            self.assertIs(caught.exception, error)
        self.service.fallback_enabled = False
        error = ServiceError("Quota", 429, "upstream_quota")
        self.gemini.analyze.side_effect = error
        with self.assertRaises(ServiceError) as caught:
            self.service.analyze(self.image)
        self.assertIs(caught.exception, error)
        self.ollama.analyze.assert_not_called()

    def test_local_failure_explains_quota_and_configuration_without_retry_or_loop(self):
        self.gemini.analyze.side_effect = ServiceError("Quota", 429, "upstream_quota")
        self.ollama.analyze.side_effect = ServiceError("Local model missing", 503, "ollama_model_missing")
        with self.assertRaises(ServiceError) as caught:
            self.service.analyze(self.image)
        self.assertEqual(caught.exception.code, "ollama_model_missing")
        self.assertIn("Gemini", caught.exception.message)
        self.assertIn("Local model missing", caught.exception.message)
        self.gemini.analyze.assert_called_once()
        self.ollama.analyze.assert_called_once()

    def test_each_new_request_returns_to_gemini_when_quota_is_available(self):
        self.gemini.analyze.side_effect = [ServiceError("Quota", 429, "upstream_quota"), observation()]
        self.assertEqual(self.service.analyze(self.image)["provider"], "ollama")
        self.assertEqual(self.service.analyze(self.image)["provider"], "gemini")
        self.ollama.analyze.assert_called_once()


class FallbackEndpointTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app({**TEST_CONFIG, "TESTING": True, "GEMINI_API_KEY": "test-key", "ENABLE_OLLAMA_FALLBACK": True})
        self.addCleanup(self.app.extensions["database"].close)
        self.client, _ = client_with_csrf(self.app)
        self.image = io.BytesIO()
        image = Image.new("RGB", (160, 200))
        ImageDraw.Draw(image).line((0, 0, 159, 199), fill=(80, 120, 160), width=10)
        image.save(self.image, "JPEG")
        self.image.seek(0)

    def test_actual_gemini_429_routes_to_native_ollama_and_saves_real_provider_metadata(self):
        # Mock transports, including a real Gemini 429 response, rather than bypassing routing.
        local_session = Mock()
        local_session.post.side_effect = [response(body={"capabilities": ["vision"]}), completed()]
        auth = self.client.post("/api/auth/register", data={"username": "fallback_user", "password": "TestPassword123!"})
        self.assertEqual(auth.status_code, 201, auth.json)
        self.client.environ_base["HTTP_X_CSRF_TOKEN"] = auth.json["csrf_token"]
        with patch("services.gemini.requests.post", return_value=response(429)) as remote, \
                patch("services.ollama.requests.Session") as factory:
            factory.return_value.__enter__.return_value = local_session
            result = self.client.post("/api/analyze", data={"photo": (self.image, "photo.jpg"), "consent": "true", "focus": "crown", "save_history": "true"})
        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(result.json["provider"], "ollama")
        self.assertEqual(result.json["fallback_reason"], "gemini_quota")
        self.assertEqual(result.json["model"], self.app.extensions["ollama"].model)
        self.assertEqual(result.json["focus"], "crown")
        remote.assert_called_once()
        self.assertEqual(local_session.post.call_count, 2)
        stored = self.client.get(f'/api/history/{result.json["history_id"]}').json
        self.assertEqual(stored["provider"], "ollama")
        self.assertEqual(stored["model"], result.json["model"])
        self.assertNotIn("images", json.dumps(stored))

    def test_consent_and_bad_focus_stop_both_providers_and_status_does_not_probe_or_claim_readiness(self):
        with patch.object(self.app.extensions["gemini"], "analyze") as gemini, patch.object(self.app.extensions["ollama"], "analyze") as ollama:
            denied = self.client.post("/api/analyze", data={"photo": (self.image, "photo.jpg")})
            self.assertEqual(denied.status_code, 400)
            invalid = self.client.post("/api/analyze", data={"consent": "true", "focus": "unknown"})
            self.assertEqual(invalid.status_code, 400)
            status = self.client.get("/api/status")
            self.assertTrue(status.json["ollama_fallback_enabled"])
            self.assertEqual(status.json["analysis_timeout_ms"], 200000)
            self.assertNotIn("ollama_ready", status.json)
            gemini.assert_not_called(); ollama.assert_not_called()

    def test_paid_generation_does_not_use_vision_analysis_fallback(self):
        self.app.config.update(ENABLE_PAID_IMAGE_GENERATION=True, GEMINI_IMAGE_MODEL="test-image")
        with patch.object(self.app.extensions["gemini"], "generate", side_effect=ServiceError("Quota", 429, "upstream_quota")), \
                patch.object(self.app.extensions["ollama"], "analyze") as local:
            result = self.client.post("/api/simulate", data={"photo": (self.image, "photo.jpg"), "provider": "gemini", "consent": "true", "paid_consent": "true"})
        self.assertEqual(result.status_code, 429)
        local.assert_not_called()


if __name__ == "__main__":
    unittest.main()
