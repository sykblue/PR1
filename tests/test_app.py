import io
import json
import unittest
from unittest.mock import Mock, patch

import numpy as np
import requests
from PIL import Image, ImageDraw
from werkzeug.datastructures import FileStorage

from app import ROOT, create_app
from services.errors import ServiceError
from services.gemini import validate_analysis
from services.images import image_bytes, read_photo
from services.vision import edit_mask, simulate
from services.training import MIN_PER_LABEL, MIN_GROUPS_PER_LABEL, MIN_GROUPS_TOTAL
from helpers import TEST_CONFIG, client_with_csrf, visual_evidence


def photo(size=(320, 400), color=(205, 175, 151), fmt="JPEG"):
    image = Image.new("RGB", size, color)
    ImageDraw.Draw(image).line((0, 0, size[0] - 1, size[1] - 1), fill=(30, 60, 90), width=max(1, min(size) // 20))
    return io.BytesIO(image_bytes(image, fmt))


def analysis():
    return {"image_usable": True, "visible_signal": "unclear", "summary": "TEST observation",
            "observations": [{"area": "hairline", "detail": "TEST visible shape"}],
            "limitations": ["Single image only"], "next_steps": ["Record under consistent conditions"],
            "visual_evidence": visual_evidence()}


class AppTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app({**TEST_CONFIG, "TESTING": True, "GEMINI_API_KEY": "test-key-not-real",
                               "ENABLE_PAID_IMAGE_GENERATION": False, "ENABLE_SD_INPAINTING": False})
        self.client, _ = client_with_csrf(self.app)

    def tearDown(self):
        self.app.extensions["database"].close()

    def post(self, path, **fields):
        return self.client.post(path, data={"photo": (photo(), "test.jpg"), **fields})

    def test_home_and_assets(self):
        for path in ["/", "/guide", "/static/guide.js", "/static/guide-page.css", "/analysis", "/simulation", "/static/simulation.js", "/static/simulation-page.css", "/static/photo-handoff.js", "/static/analysis-links.js", "/static/app.js", "/static/analysis-tools.js", "/static/analysis-page.css", "/static/home.js", "/static/styles.css", "/static/icons.svg", "/static/favicon.svg",
                     "/static/auth.js", "/static/camera.js", "/static/account-camera.css",
                     "/static/account-page.js", "/static/account-page.css",
                     "/training-guide", "/static/training-guide.js", "/static/training-guide.css"]:
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                response.close()

    def test_training_guide_renders_current_rules_without_requiring_login(self):
        response = self.client.get("/training-guide")
        self.assertEqual(response.status_code, 200)
        self.assertIn(f'data-minimum-photos="{MIN_PER_LABEL}"', response.text)
        self.assertIn(f'data-minimum-groups="{MIN_GROUPS_PER_LABEL}"', response.text)
        self.assertIn(f'data-minimum-total-groups="{MIN_GROUPS_TOTAL}"', response.text)
        self.assertIn('href="/training"', response.text)
        self.assertNotIn("{{", response.text)
        self.assertNotIn("test-key-not-real", response.text)
        self.assertNotIn('/static/training.js', response.text)
        result = self.client.get("/analysis")
        self.assertIn('href="/training-guide"', result.text)
        result.close()
        result = self.client.get("/training")
        self.assertNotIn('href="/training-guide"', result.text)
        self.assertIn('id="camera-open"', result.text)
        self.assertIn('/static/camera.js', result.text)
        result.close()

    def test_photo_analysis_has_its_own_page_and_home_links_to_it(self):
        home = self.client.get("/")
        page = self.client.get("/analysis")
        self.assertIn('href="/analysis"', home.text)
        self.assertNotIn('id="photo-input"', home.text)
        self.assertNotIn('/static/app.js', home.text)
        self.assertNotIn('/static/camera.js', home.text)
        self.assertIn('id="photo-input"', page.text)
        self.assertNotIn('id="simulate-button"', page.text)
        self.assertIn('href="/simulation"', page.text)
        self.assertIn('id="photo-checks"', page.text)
        self.assertIn('name="analysis-focus"', page.text)
        self.assertIn('id="copy-report"', page.text)
        self.assertIn('id="export-report-text"', page.text)
        self.assertEqual(page.headers["Cache-Control"], "no-store")
        home.close()
        page.close()

    def test_analysis_focus_is_validated_and_passed_to_the_model(self):
        with patch.object(self.app.extensions["gemini"], "analyze", return_value=analysis()) as model:
            response = self.post("/api/analyze", consent="true", focus="crown")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json["focus"], "crown")
            self.assertEqual(model.call_args.kwargs["focus"], "crown")
        with patch.object(self.app.extensions["gemini"], "analyze") as model:
            response = self.post("/api/analyze", consent="true", focus="ignore-rules")
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json["error"]["code"], "invalid_analysis_focus")
            model.assert_not_called()

    def test_simulation_is_a_public_independent_page(self):
        page = self.client.get("/simulation")
        self.assertEqual(page.status_code, 200)
        self.assertIn('id="photo-input"', page.text)
        self.assertIn('id="simulate-button"', page.text)
        self.assertIn('id="side-comparison"', page.text)
        self.assertIn('/static/simulation.js', page.text)
        self.assertIn('/static/camera.js', page.text)
        self.assertNotIn('/static/app.js', page.text)
        self.assertNotIn('id="analyze-button"', page.text)
        self.assertIn('href="/simulation" class="nav-link active" aria-current="page"', page.text)
        self.assertEqual(page.headers["Cache-Control"], "no-store")
        page.close()

    def test_usage_guide_is_public_and_links_to_current_product_pages(self):
        page = self.client.get("/guide")
        self.assertEqual(page.status_code, 200)
        self.assertIn('/static/guide.js', page.text)
        self.assertIn('id="faq-search"', page.text)
        self.assertIn('id="photo-guide"', page.text)
        self.assertEqual(page.text.count('class="help-faq-item"'), 10)
        for route in ("/analysis", "/simulation", "/training-guide"):
            self.assertIn(f'href="{route}"', page.text)
        for script in ("/static/app.js", "/static/simulation.js", "/static/camera.js"):
            self.assertNotIn(script, page.text)
        self.assertNotIn('id="photo-input"', page.text)
        self.assertIn('href="/guide" class="nav-link active" aria-current="page"', page.text)
        page.close()
        for route in ("/", "/analysis", "/simulation", "/training", "/training-guide"):
            result = self.client.get(route)
            self.assertIn('href="/guide', result.text)
            self.assertNotIn('href="/#guide"', result.text)
            if route == "/":
                self.assertNotIn('id="guide"', result.text)
            result.close()

    def test_focused_prompt_keeps_medical_limits(self):
        from services.gemini import GeminiClient, SYSTEM_PROMPT
        model = GeminiClient("test-only-key", "test-model")
        with patch.object(model, "request", return_value=[{"text": json.dumps(analysis())}]) as remote:
            self.assertEqual(model.analyze(Image.new("RGB", (320, 400)), focus="density"), analysis())
            self.assertIn("실제 모발 밀도나 모낭 수", "\n".join(part.get("text", "") for part in remote.call_args.args[1]))
            self.assertEqual(remote.call_args.args[3], SYSTEM_PROMPT)

    def test_saved_report_preserves_the_selected_focus(self):
        client, _ = client_with_csrf(self.app, "focused_report_owner")
        with patch.object(self.app.extensions["gemini"], "analyze", return_value=analysis()):
            response = client.post("/api/analyze", data={"photo": (photo(), "test.jpg"),
                "consent": "true", "save_history": "true", "focus": "hairline"})
        self.assertEqual(response.status_code, 200)
        saved = client.get(f'/api/history/{response.json["history_id"]}')
        self.assertEqual(saved.json["focus"], "hairline")

    def test_status_never_exposes_secret(self):
        response = self.client.get("/api/status")
        self.assertTrue(response.json["analysis_ready"])
        self.assertNotIn("test-key-not-real", response.text)
        self.assertFalse(response.json["paid_image_ready"])

    def test_private_files_not_served(self):
        for path in ["/.env", "/.env.example", "/app.py", "/requirements.txt", "/models/hair_segmenter.tflite"]:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)

    def test_unknown_host_rejected(self):
        self.assertEqual(self.client.get("/api/status", headers={"Host": "foreign.example"}).status_code, 403)

    def test_cross_origin_post_rejected(self):
        response = self.client.post("/api/segment", headers={"Origin": "https://foreign.example"})
        self.assertEqual(response.status_code, 403)

    def test_consent_required_before_ai_call(self):
        with patch("services.gemini.requests.post") as remote:
            self.assertEqual(self.post("/api/analyze").status_code, 400)
            remote.assert_not_called()

    def test_missing_photo(self):
        self.assertEqual(self.client.post("/api/segment").status_code, 400)

    def test_corrupt_photo(self):
        response = self.client.post("/api/segment", data={"photo": (io.BytesIO(b"not an image"), "test.jpg")})
        self.assertEqual(response.status_code, 400)

    def test_unsupported_format(self):
        response = self.client.post("/api/segment", data={"photo": (photo(fmt="BMP"), "test.jpg")})
        self.assertEqual(response.status_code, 400)

    def test_small_photo(self):
        response = self.client.post("/api/segment", data={"photo": (photo((100, 100)), "test.jpg")})
        self.assertEqual(response.status_code, 400)

    def test_upload_limit(self):
        response = self.client.post("/api/segment", data={"photo": (io.BytesIO(b"x" * (10 * 1024 * 1024 + 1)), "test.jpg")})
        self.assertEqual(response.status_code, 413)
        response.request.environ["wsgi.input"].close()
        response.close()

    def test_exif_is_removed_and_image_resized(self):
        image = Image.new("RGB", (2400, 1800))
        exif = Image.Exif()
        exif[270] = "metadata must not reach provider"
        raw = io.BytesIO()
        image.save(raw, "JPEG", exif=exif)
        raw.seek(0)
        clean = read_photo(FileStorage(raw, filename="test.jpg"))
        self.assertLessEqual(max(clean.size), 1280)
        self.assertFalse(clean.getexif())
        self.assertFalse(clean.info)

    def test_missing_key_returns_actionable_error(self):
        self.app.extensions["gemini"].api_key = ""
        response = self.post("/api/analyze", consent="true")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json["error"]["code"], "api_key_missing")

    @patch("services.gemini.requests.post")
    def test_valid_analysis_and_key_is_only_in_header(self, remote):
        remote.return_value = Mock(ok=True, status_code=200)
        remote.return_value.json.return_value = {"candidates": [{"finishReason": "STOP", "content": {
            "parts": [{"text": json.dumps(analysis())}]}}]}
        response = self.post("/api/analyze", consent="true")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["result"]["visible_signal"], "unclear")
        args, kwargs = remote.call_args
        self.assertNotIn("test-key-not-real", args[0])
        self.assertEqual(kwargs["headers"]["x-goog-api-key"], "test-key-not-real")
        self.assertNotIn("test-key-not-real", response.text)

    @patch("services.gemini.requests.post")
    def test_upstream_quota(self, remote):
        remote.return_value = Mock(ok=False, status_code=429)
        response = self.post("/api/analyze", consent="true")
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json["error"]["code"], "upstream_quota")

    @patch("services.gemini.requests.post")
    def test_upstream_auth_does_not_leak_body(self, remote):
        remote.return_value = Mock(ok=False, status_code=403, text="test-key-not-real")
        response = self.post("/api/analyze", consent="true")
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("test-key-not-real", response.text)

    @patch("services.gemini.requests.post")
    def test_upstream_timeout(self, remote):
        remote.side_effect = requests.Timeout()
        self.assertEqual(self.post("/api/analyze", consent="true").status_code, 504)

    @patch("services.gemini.requests.post")
    def test_upstream_network_failure(self, remote):
        remote.side_effect = requests.ConnectionError("sensitive transport detail")
        response = self.post("/api/analyze", consent="true")
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("sensitive", response.text)

    @patch("services.gemini.time.sleep")
    @patch("services.gemini.requests.post")
    def test_transient_ai_failure_recovers_without_a_second_browser_request(self, remote, sleep):
        failed = Mock(ok=False, status_code=503, headers={})
        recovered = Mock(ok=True, status_code=200)
        recovered.json.return_value = {"candidates": [{"finishReason": "STOP", "content": {
            "parts": [{"text": json.dumps(analysis())}]}}]}
        remote.side_effect = [failed, recovered]
        response = self.post("/api/analyze", consent="true")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(remote.call_count, 2)
        sleep.assert_called_once_with(1)

    @patch("services.gemini.time.sleep")
    @patch("services.gemini.requests.post")
    def test_persistent_ai_service_failure_has_a_specific_public_error(self, remote, sleep):
        remote.return_value = Mock(ok=False, status_code=503, headers={}, text="private upstream body")
        response = self.post("/api/analyze", consent="true")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json["error"]["code"], "upstream_unavailable")
        self.assertEqual(remote.call_count, 3)
        self.assertNotIn("private", response.text)

    @patch("services.gemini.requests.post")
    def test_malformed_ai_response(self, remote):
        remote.return_value = Mock(ok=True, status_code=200)
        remote.return_value.json.return_value = {"candidates": [{"content": {"parts": [{"text": "not-json"}]}}]}
        self.assertEqual(self.post("/api/analyze", consent="true").status_code, 502)

    @patch("services.gemini.requests.post")
    def test_incomplete_ai_response(self, remote):
        remote.return_value = Mock(ok=True, status_code=200)
        remote.return_value.json.return_value = {"candidates": [{"finishReason": "MAX_TOKENS", "content": {
            "parts": [{"text": json.dumps(analysis())}]}}]}
        self.assertEqual(self.post("/api/analyze", consent="true").status_code, 502)

    @patch("services.gemini.requests.post")
    def test_unusable_photo_rejected(self, remote):
        value = analysis()
        value["image_usable"] = False
        remote.return_value = Mock(ok=True, status_code=200)
        remote.return_value.json.return_value = {"candidates": [{"content": {"parts": [{"text": json.dumps(value)}]}}]}
        self.assertEqual(self.post("/api/analyze", consent="true").status_code, 422)

    def test_ai_schema_rejects_wrong_types(self):
        value = analysis()
        value["image_usable"] = "true"
        with self.assertRaises(ValueError):
            validate_analysis(value)

    def test_missing_segmentation_model(self):
        self.app.extensions["hair_vision"].model_path = ROOT / "models" / "missing.tflite"
        self.assertEqual(self.post("/api/segment").status_code, 503)

    def test_simulation_validates_options(self):
        for fields in [{"strength": "nan"}, {"strength": "0"}, {"strength": "101"},
                       {"scenario": "unknown"}, {"provider": "unknown"}]:
            with self.subTest(fields=fields):
                self.assertEqual(self.post("/api/simulate", **fields).status_code, 400)

    def test_paid_disabled_never_calls_remote(self):
        with patch("services.gemini.requests.post") as remote:
            self.assertEqual(self.post("/api/simulate", provider="gemini", consent="true", paid_consent="true").status_code, 503)
            remote.assert_not_called()

    def test_paid_enabled_still_requires_per_request_consent(self):
        self.app.config.update(ENABLE_PAID_IMAGE_GENERATION=True, GEMINI_IMAGE_MODEL="test-image-model")
        with patch("services.gemini.requests.post") as remote:
            self.assertEqual(self.post("/api/simulate", provider="gemini", consent="true").status_code, 400)
            remote.assert_not_called()

    def test_local_inpainting_requires_configuration(self):
        with self.assertRaises(ServiceError) as result:
            self.app.extensions["painter"].generate(Image.new("RGB", (320, 400)), np.zeros((400, 320), np.uint8), "hairline")
        self.assertEqual(result.exception.status, 503)

    def test_local_opencv_scenarios_change_pixels(self):
        image = Image.new("RGB", (320, 400), (205, 175, 151))
        array = np.array(image)
        array[30:180, 50:270] = [35, 30, 26]
        image = Image.fromarray(array)
        mask = np.zeros((400, 320), np.uint8)
        mask[30:180, 50:270] = 255
        for scenario in ["hairline", "crown", "density"]:
            with self.subTest(scenario=scenario):
                output, region = simulate(image, mask, scenario, 50)
                self.assertEqual(output.size, image.size)
                self.assertTrue(np.any(region))
                self.assertTrue(np.any(np.array(output) != array))

    def test_empty_edit_mask_rejected(self):
        with self.assertRaises(ServiceError):
            edit_mask(np.zeros((100, 100), np.uint8), "hairline", 30)

    def test_blank_analysis_photo_is_rejected_before_either_provider_is_called(self):
        with patch.object(self.app.extensions["gemini"], "analyze") as cloud, patch.object(self.app.extensions["ollama"], "analyze") as local:
            for color in ("white", "black", (205, 175, 151)):
                raw = io.BytesIO(image_bytes(Image.new("RGB", (320, 400), color), "JPEG"))
                response = self.client.post("/api/analyze", data={"photo": (raw, "blank.jpg"), "consent": "true"})
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json["error"]["code"], "photo_not_usable")
            cloud.assert_not_called(); local.assert_not_called()

    def test_analysis_keeps_higher_detail_and_withholds_a_forehead_only_positive(self):
        value = analysis(); value["visible_signal"] = "visible"
        value["visual_evidence"]["scalp_in_hair"] = "not_obvious"
        with patch.object(self.app.extensions["gemini"], "analyze", return_value=value) as cloud:
            response = self.client.post("/api/analyze", data={"photo": (photo(size=(3200, 2400)), "detail.jpg"), "consent": "true", "focus": "hairline"})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(cloud.call_args.args[0].size, (2048, 1536))
        self.assertFalse(cloud.call_args.args[0].getexif())
        self.assertEqual(response.json["result"]["visible_signal"], "unclear")
        self.assertEqual(response.json["result"]["quality_review"]["status"], "conflicting_evidence")
        self.assertFalse(response.json["result"]["quality_review"]["cause_assessable"])

    def test_local_simulation_route_returns_real_png(self):
        mask = np.zeros((400, 320), np.uint8)
        mask[30:180, 50:270] = 255
        with patch.object(self.app.extensions["hair_vision"], "segment", return_value=mask):
            response = self.post("/api/simulate", provider="opencv", scenario="hairline", strength="50")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json["image"].startswith("data:image/png;base64,"))


if __name__ == "__main__":
    unittest.main()
