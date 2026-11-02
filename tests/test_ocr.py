import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, PropertyMock, patch

import numpy as np
from PIL import Image
from werkzeug.datastructures import FileStorage

from app import ROOT, create_app
from services.errors import ServiceError
from services.images import image_bytes, read_photo
from services.ocr import LocalOCR, normalize_results
from helpers import TEST_CONFIG, client_with_csrf


class OCRTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app({**TEST_CONFIG, "TESTING": True, "GEMINI_API_KEY": "", "ENABLE_PAID_IMAGE_GENERATION": False})
        self.client, _ = client_with_csrf(self.app)
        self.image = Image.new("RGB", (400, 300), "white")

    def tearDown(self):
        self.app.extensions["database"].close()

    def upload(self, image=None):
        return self.client.post("/api/ocr", data={"photo":
            (io.BytesIO(image_bytes(image or self.image)), "document.png")})

    def test_route_works_without_api_key_or_external_consent(self):
        result = {"text": "한국어 TEST", "lines": [{"text": "한국어 TEST", "confidence": .95}],
                  "line_count": 1, "truncated": False}
        with patch.object(self.app.extensions["ocr"], "recognize", return_value=result), \
                patch("services.gemini.requests.post") as remote:
            response = self.upload()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["text"], "한국어 TEST")
        self.assertEqual(response.json["engine"], "PaddleOCR")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        remote.assert_not_called()

    def test_missing_upload(self):
        self.assertEqual(self.client.post("/api/ocr").status_code, 400)

    def test_document_upload_does_not_accept_pdf(self):
        response = self.client.post("/api/ocr", data={"photo": (io.BytesIO(b"%PDF-1.4"), "document.pdf")})
        self.assertEqual(response.status_code, 400)

    def test_document_keeps_higher_resolution(self):
        image = Image.new("RGB", (3200, 2400), "white")
        clean = read_photo(FileStorage(io.BytesIO(image_bytes(image)), filename="document.png"), max_side=2560)
        self.assertEqual(clean.size, (2560, 1920))

    def test_missing_packages_is_actionable(self):
        with patch.object(LocalOCR, "packages_available", new_callable=PropertyMock, return_value=False):
            response = self.upload()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json["error"]["code"], "ocr_not_installed")

    def test_missing_models_does_not_trigger_download(self):
        with patch.object(LocalOCR, "packages_available", new_callable=PropertyMock, return_value=True), \
                patch.object(LocalOCR, "models_available", new_callable=PropertyMock, return_value=False), \
                patch.object(self.app.extensions["ocr"], "_create_engine") as initialize:
            response = self.upload()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json["error"]["code"], "ocr_models_missing")
        initialize.assert_not_called()

    def test_normalize_korean_and_numpy_metadata(self):
        raw = [{"rec_texts": ["한국어", "TEST 123"], "rec_scores": np.array([.9, .99]),
                "rec_polys": np.array([[[1, 2], [3, 2], [3, 4], [1, 4]], [[5, 6], [7, 6], [7, 8], [5, 8]]])}]
        result = normalize_results(raw)
        self.assertEqual(result["text"], "한국어\nTEST 123")
        self.assertEqual(result["line_count"], 2)
        self.assertIsInstance(result["lines"][0]["confidence"], float)
        self.assertEqual(len(result["lines"][0]["box"]), 4)

    def test_empty_image_result_is_not_fabricated(self):
        result = normalize_results([{"rec_texts": [], "rec_scores": [], "rec_polys": []}])
        self.assertEqual(result["text"], "")
        self.assertEqual(result["line_count"], 0)

    def test_scores_must_match_text(self):
        with self.assertRaises(ValueError):
            normalize_results([{"rec_texts": ["one"], "rec_scores": []}])

    def test_invalid_confidences_rejected(self):
        for score in [float("nan"), float("inf"), -1, 2]:
            with self.subTest(score=score), self.assertRaises(ValueError):
                normalize_results([{"rec_texts": ["one"], "rec_scores": [score]}])

    def test_empty_lines_are_skipped(self):
        result = normalize_results([{"rec_texts": ["  ", " TEST "], "rec_scores": [.8, .9]}])
        self.assertEqual(result["text"], "TEST")

    def test_large_output_is_explicitly_truncated(self):
        result = normalize_results([{"rec_texts": ["TEST"] * 1001, "rec_scores": [.9] * 1001}])
        self.assertEqual(result["line_count"], 1000)
        self.assertTrue(result["truncated"])

    def test_local_engine_receives_bgr_pixels_not_filename(self):
        service = self.app.extensions["ocr"]
        service._engine = Mock()
        service._engine.predict.return_value = [{"rec_texts": ["TEST"], "rec_scores": [.9]}]
        with patch.object(LocalOCR, "packages_available", new_callable=PropertyMock, return_value=True), \
                patch.object(LocalOCR, "models_available", new_callable=PropertyMock, return_value=True):
            service.recognize(Image.new("RGB", (160, 160), (12, 34, 56)))
        pixels = service._engine.predict.call_args.args[0]
        self.assertEqual(pixels[0, 0].tolist(), [56, 34, 12])

    def test_busy_engine_rejected(self):
        service = self.app.extensions["ocr"]
        service._lock.acquire()
        try:
            with patch.object(LocalOCR, "packages_available", new_callable=PropertyMock, return_value=True), \
                    patch.object(LocalOCR, "models_available", new_callable=PropertyMock, return_value=True), \
                    self.assertRaises(ServiceError) as error:
                service.recognize(self.image)
            self.assertEqual(error.exception.status, 429)
        finally:
            service._lock.release()

    def test_engine_failure_releases_lock_and_hides_details(self):
        service = self.app.extensions["ocr"]
        service._engine = Mock()
        service._engine.predict.side_effect = [RuntimeError("private document content"), []]
        with patch.object(LocalOCR, "packages_available", new_callable=PropertyMock, return_value=True), \
                patch.object(LocalOCR, "models_available", new_callable=PropertyMock, return_value=True):
            with self.assertLogs("services.ocr", level="ERROR") as log:
                response = self.upload()
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("private document content", response.text)
            self.assertNotIn("private document content", " ".join(log.output))
            self.assertEqual(service.recognize(self.image)["line_count"], 0)


if __name__ == "__main__":
    unittest.main()
