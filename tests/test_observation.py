import base64
import io
import json
import unittest
from unittest.mock import Mock, patch

from PIL import Image, ImageDraw

from helpers import visual_evidence
from services.analysis import AnalysisService
from services.errors import ServiceError
from services.gemini import GeminiClient, SYSTEM_PROMPT, validate_analysis
from services.observation import CAUSE_LIMITATION, calibrate_observation, ensure_observable_image, observation_image, validate_evidence
from services.vlm_data import validate_target


def observation(signal="not_obvious", **evidence):
    return {"image_usable": True, "visible_signal": signal, "summary": "Visible outline only",
            "observations": [{"area": "Hairline", "detail": "An outline is visible"}],
            "limitations": ["Single photo"], "next_steps": ["Compare consistent photos"],
            "visual_evidence": visual_evidence(scalp_in_hair=signal, **evidence)}


class EvidenceTests(unittest.TestCase):
    def test_exposed_forehead_without_scalp_exposure_is_not_a_positive_signal(self):
        raw = observation(forehead_skin="visible")
        result = calibrate_observation(raw, "hairline")
        self.assertEqual(result["visible_signal"], "not_obvious")
        self.assertEqual(result["quality_review"]["status"], "consistent")
        self.assertFalse(result["quality_review"]["cause_assessable"])
        self.assertIn(CAUSE_LIMITATION, result["limitations"])
        self.assertNotIn("quality_review", raw)

    def test_forehead_only_positive_and_other_disagreements_are_withheld(self):
        for claimed, evidence in (("visible", "not_obvious"), ("visible", "unclear"), ("not_obvious", "visible")):
            raw = observation(claimed); raw["visual_evidence"]["scalp_in_hair"] = evidence
            result = calibrate_observation(raw, "hairline")
            self.assertEqual(result["visible_signal"], "unclear")
            self.assertEqual(result["quality_review"]["status"], "conflicting_evidence")
            self.assertNotEqual(result["summary"], raw["summary"])

    def test_a_visible_scalp_observation_is_preserved_without_diagnosing_its_cause(self):
        result = calibrate_observation(observation("visible", forehead_skin="not_visible"), "crown")
        self.assertEqual(result["visible_signal"], "visible")
        self.assertEqual(result["quality_review"]["status"], "consistent")
        self.assertFalse(result["quality_review"]["cause_assessable"])

    def test_covered_cropped_or_poor_target_visibility_never_looks_normal_or_positive(self):
        for visibility in ("limited", "not_visible"):
            for signal in ("not_obvious", "visible"):
                result = calibrate_observation(observation(signal, target_visibility=visibility, confounders=["occlusion"]), "hairline")
                self.assertEqual(result["visible_signal"], "unclear")
                self.assertEqual(result["quality_review"]["status"], "limited_view")

    def test_non_photographic_results_are_rejected(self):
        for kind in ("illustration", "other"):
            with self.assertRaises(ServiceError) as caught:
                calibrate_observation(observation(image_type=kind))
            self.assertEqual((caught.exception.status, caught.exception.code), (422, "photo_not_usable"))

    def test_existing_training_targets_remain_valid_but_old_analysis_without_evidence_abstains(self):
        old = observation("visible"); del old["visual_evidence"]
        self.assertEqual(validate_target(old), old)
        with self.assertRaises(ValueError): validate_analysis(old, require_evidence=True)
        result = calibrate_observation(old)
        self.assertEqual(result["visible_signal"], "unclear")
        self.assertEqual(result["quality_review"]["status"], "legacy_evidence_missing")

    def test_invalid_evidence_is_not_repaired_with_invented_facts(self):
        for fields in ({"scalp_in_hair": "bald"}, {"image_type": True}, {"basis": ""}, {"basis": "x" * 301},
                       {"confounders": ["genetics"]}, {"confounders": "blur"}, {"target_visibility": "normal"}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                validate_evidence(visual_evidence(**fields))

    def test_cloud_and_quota_fallback_share_the_same_evidence_policy(self):
        wrong = observation("visible"); wrong["visual_evidence"]["scalp_in_hair"] = "not_obvious"
        cloud, local = Mock(model="cloud"), Mock(model="local")
        cloud.analyze.return_value = local.analyze.return_value = wrong
        local.provider = "ollama"
        service = AnalysisService(cloud, local)
        cloud_result = service.analyze(Image.new("RGB", (200, 200)), focus="hairline")
        cloud.analyze.side_effect = ServiceError("quota", 429, "upstream_quota")
        local_result = service.analyze(Image.new("RGB", (200, 200)), focus="hairline")
        self.assertEqual(cloud_result["result"], local_result["result"])
        self.assertEqual(cloud_result["result"]["visible_signal"], "unclear")

    def test_uniform_inputs_are_rejected_but_no_hair_or_disease_label_is_inferred_from_image_statistics(self):
        for color in ("white", "black", (200, 160, 130)):
            with self.assertRaises(ServiceError): ensure_observable_image(Image.new("RGB", (400, 400), color))
        image = Image.new("RGB", (400, 400), "white")
        ImageDraw.Draw(image).line((0, 0, 399, 399), fill="black", width=8)
        self.assertIsNone(ensure_observable_image(image))

    def test_high_detail_encoding_preserves_size_without_upscaling_or_exif(self):
        image = Image.new("RGB", (3200, 2400), "white")
        exif = image.getexif(); exif[270] = "private metadata"; image.info["exif"] = exif.tobytes()
        encoded = observation_image(image)
        with Image.open(io.BytesIO(base64.b64decode(encoded["inlineData"]["data"]))) as decoded:
            self.assertEqual(decoded.size, (2048, 1536)); self.assertFalse(decoded.getexif())
        with Image.open(io.BytesIO(base64.b64decode(observation_image(Image.new("RGB", (320, 400)))["inlineData"]["data"]))) as decoded:
            self.assertEqual(decoded.size, (320, 400))

    def test_gemini_analysis_uses_evidence_schema_and_a_bounded_thinking_budget(self):
        value = observation()
        for model, thinking in (("gemini-2.5-flash", {"thinkingBudget": 1024}), ("gemini-3.1-pro-preview", {"thinkingLevel": "LOW"}), ("custom-model", None)):
            client = GeminiClient("test-key", model)
            with patch.object(client, "request", return_value=[{"text": json.dumps(value)}]) as request:
                self.assertEqual(client.analyze(Image.new("RGB", (320, 400))), value)
            config = request.call_args.args[2]
            self.assertEqual(config.get("thinkingConfig"), thinking)
            self.assertIn("visual_evidence", config["responseSchema"]["required"])
            self.assertIn("text", request.call_args.args[1][0])
            self.assertIn("inlineData", request.call_args.args[1][-1])
            self.assertIn("이마 높이를 양성 근거로 쓰지 않는다", SYSTEM_PROMPT)

    def test_missing_new_provider_evidence_is_an_error_instead_of_fabrication_or_a_second_request(self):
        value = observation(); del value["visual_evidence"]
        client = GeminiClient("test-key", "custom-model")
        with patch.object(client, "request", return_value=[{"text": json.dumps(value)}]) as request:
            with self.assertRaises(ServiceError) as caught: client.analyze(Image.new("RGB", (320, 400)))
        self.assertEqual(caught.exception.code, "invalid_ai_output")
        request.assert_called_once()


if __name__ == "__main__": unittest.main()
