import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import zipfile

import numpy as np
from PIL import Image, ImageDraw

from app import create_app
from helpers import TEST_CONFIG, client_with_csrf, visual_evidence
from services.analysis import AnalysisService
from services.errors import ServiceError
from services.gemini import GeminiClient, analysis_text
from services.ollama import OllamaClient
from services.scalp_classifier import ScalpClassifier
from services.scalp_dataset import JoinedParts, assign_splits, prepare


def observation():
    return {"image_usable": True, "visible_signal": "not_obvious", "summary": "Test observation",
            "observations": [{"area": "Scalp", "detail": "Visible hairs"}], "limitations": ["Single photo"],
            "next_steps": ["Keep consistent photos"], "visual_evidence": visual_evidence(scalp_in_hair="not_obvious")}


def reference():
    return {"model": "test-scalp", "input_kind": "scalp_macro", "status": "reference_only",
            "dataset_grade": 1, "dataset_label": "경증", "label_score": .8, "warning": "Experimental label only"}


class ReferenceTests(unittest.TestCase):
    def test_macro_opt_in_runs_once_and_the_same_result_reaches_cloud_and_quota_backup(self):
        cloud, local, classifier = Mock(model="cloud"), Mock(model="local", provider="ollama"), Mock()
        cloud.analyze.side_effect = ServiceError("quota", 429, "upstream_quota")
        local.analyze.return_value = observation(); classifier.predict.return_value = reference()
        result = AnalysisService(cloud, local, scalp=classifier).analyze(Image.new("RGB", (200, 200)), scalp_macro=True)
        classifier.predict.assert_called_once()
        self.assertEqual(cloud.analyze.call_args.kwargs["scalp_result"], reference())
        self.assertEqual(local.analyze.call_args.kwargs["scalp_result"], reference())
        self.assertEqual(result["scalp_reference"], reference())
        self.assertEqual(result["provider"], "ollama")

    def test_general_photos_do_not_run_a_macro_classifier_or_add_context(self):
        cloud, local, classifier = Mock(model="cloud"), Mock(model="local"), Mock()
        cloud.analyze.return_value = observation()
        value = AnalysisService(cloud, local, scalp=classifier).analyze(Image.new("RGB", (200, 200)))
        classifier.predict.assert_not_called(); local.analyze.assert_not_called()
        self.assertNotIn("scalp_reference", value)
        self.assertNotIn("scalp_result", cloud.analyze.call_args.kwargs)

    def test_non_quota_cloud_errors_do_not_silently_switch_to_backup(self):
        cloud, local, classifier = Mock(model="cloud"), Mock(model="local"), Mock()
        cloud.analyze.side_effect = ServiceError("bad key", 502, "upstream_auth")
        classifier.predict.return_value = reference()
        with self.assertRaises(ServiceError):
            AnalysisService(cloud, local, scalp=classifier).analyze(Image.new("RGB", (200, 200)), scalp_macro=True)
        local.analyze.assert_not_called()

    def test_reference_payload_survives_both_real_provider_request_builders(self):
        image, expected = Image.new("RGB", (200, 200)), reference()
        client = GeminiClient("test", "gemini-2.5-flash")
        with patch.object(client, "request", return_value=[{"text": json.dumps(observation())}]) as request:
            client.analyze(image, scalp_result=expected)
            cloud_context = request.call_args.args[1][1]["text"]
        session = Mock()
        session.post.side_effect = [Mock(status_code=200, json=lambda: {"capabilities": ["vision"]}),
                                    Mock(status_code=200, json=lambda: {"done": True, "done_reason": "stop", "message": {"content": json.dumps(observation())}})]
        with patch("services.ollama.requests.Session") as factory:
            factory.return_value.__enter__.return_value = session
            OllamaClient().analyze(image, scalp_result=expected)
        local_context = session.post.call_args.kwargs["json"]["messages"][1]["content"]
        self.assertIn(cloud_context, local_context)
        self.assertEqual(json.loads(cloud_context.split("\n")[-1])["trained_scalp_reference"], expected)
        self.assertNotIn("trained_scalp_reference", analysis_text()[-1])


class ClassifierTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name)
        (self.path / "model.onnx").write_bytes(b"controlled-model-fixture")
        self.metadata = {"version": 1, "classes": ["양호", "경증", "중등도", "중증"], "input_kind": "scalp_macro",
                         "input_size": 224, "onnx_verified": True, "experimental": True, "dataset_images": 100,
                         "mean": [.485, .456, .406], "std": [.229, .224, .225], "temperature": 1., "confidence_threshold": .55,
                         "model_sha256": hashlib.sha256((self.path / "model.onnx").read_bytes()).hexdigest()}
        self.write_metadata()
        self.client = ScalpClassifier(self.path)

    def write_metadata(self):
        (self.path / "metadata.json").write_text(json.dumps(self.metadata), encoding="utf-8")

    def test_unverified_or_malformed_artifacts_are_not_advertised_as_ready(self):
        for value in ([], {**self.metadata, "onnx_verified": False}, {**self.metadata, "input_kind": "forehead"},
                      {**self.metadata, "classes": ["normal"]}):
            (self.path / "metadata.json").write_text(json.dumps(value), encoding="utf-8")
            self.assertFalse(self.client.status()["ready"])

    def test_checksum_mismatch_is_rejected_before_loading_the_model(self):
        (self.path / "model.onnx").write_bytes(b"tampered")
        with patch("services.scalp_classifier.cv2.dnn.readNetFromONNX") as load:
            with self.assertRaises(ServiceError) as caught: self.client.predict(Image.new("RGB", (640, 480)))
        self.assertEqual(caught.exception.code, "scalp_model_invalid"); load.assert_not_called()

    def test_weak_outputs_abstain_and_strong_outputs_remain_research_labels(self):
        network = Mock(); network.forward.side_effect = [np.zeros((1, 4)), np.array([[0., 9., 0., 0.]])]
        with patch("services.scalp_classifier.cv2.dnn.readNetFromONNX", return_value=network):
            weak = self.client.predict(Image.new("RGB", (640, 480)))
            strong = self.client.predict(Image.new("RGB", (640, 480)))
        self.assertIsNone(weak["dataset_label"]); self.assertEqual(weak["status"], "uncertain")
        self.assertEqual(strong["dataset_label"], "경증"); self.assertIn("의료 진단", strong["warning"])
        self.assertEqual(network.setInput.call_args.args[0].shape, (1, 3, 224, 224))


class DatasetTests(unittest.TestCase):
    def test_split_zip_stream_reads_across_boundaries_and_rejects_missing_parts(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive: archive.writestr("test.txt", b"content")
        payload = output.getvalue(); cut = len(payload) // 2
        values = {"a.zip.part0": payload[:cut], f"a.zip.part{cut}": payload[cut:]}
        archive = SimpleNamespace(extractfile=lambda member: io.BytesIO(values[member.name]))
        members = [SimpleNamespace(name=name, size=len(value)) for name, value in values.items()]
        with JoinedParts(archive, members) as stream, zipfile.ZipFile(stream) as inner:
            self.assertEqual(inner.read("test.txt"), b"content")
        with self.assertRaises(ValueError): JoinedParts(archive, members[1:])

    def test_id_splits_keep_all_four_classes_and_are_deterministic(self):
        rows = [{"identity": str(identity), "grade": grade} for identity in range(20) for grade in range(4)]
        other = [dict(row) for row in rows]
        self.assertEqual(assign_splits(rows), assign_splits(other)); self.assertEqual(rows, other)
        groups = {split: {row["identity"] for row in rows if row["split"] == split} for split in ("train", "validation", "test")}
        self.assertFalse(groups["train"] & groups["test"]); self.assertFalse(groups["train"] & groups["validation"])
        for split in groups: self.assertEqual({row["grade"] for row in rows if row["split"] == split}, {0, 1, 2, 3})

    def test_identical_bytes_with_conflicting_labels_stop_preparation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); payload = io.BytesIO(); Image.new("RGB", (200, 200)).save(payload, "JPEG")
            for grade in range(4):
                zipped = io.BytesIO()
                with zipfile.ZipFile(zipped, "w") as archive: archive.writestr("p001_camera_1234_2_TH.jpg", payload.getvalue())
                with tarfile.open(root / f"download-{grade}.tar", "w") as outer:
                    member = tarfile.TarInfo(f"root/{grade}.label/data.zip.part0"); member.size = len(zipped.getvalue())
                    outer.addfile(member, io.BytesIO(zipped.getvalue()))
            with self.assertRaisesRegex(ValueError, "conflicting"):
                prepare(root, root / "prepared", progress=lambda *args, **kwargs: None)


class EndpointTests(unittest.TestCase):
    def test_macro_reference_is_opt_in_and_quota_backup_receives_it(self):
        app = create_app({**TEST_CONFIG, "TESTING": True, "ENABLE_OLLAMA_FALLBACK": True, "SCALP_MODEL_DIR": ".cache/missing-test-scalp-model"})
        self.addCleanup(app.extensions["database"].close)
        client, _ = client_with_csrf(app)
        cloud, local, classifier = Mock(), Mock(model="backup", provider="ollama"), Mock()
        cloud.return_value = observation(); local.analyze.return_value = observation(); classifier.predict.return_value = reference()
        app.extensions["gemini"].analyze = cloud
        app.extensions["analysis"].scalp = classifier
        app.extensions["vision_training"].base_client = lambda: local
        def post(**fields):
            image = Image.new("RGB", (320, 400), "white"); ImageDraw.Draw(image).line((0, 0, 319, 399), fill="black", width=8)
            data = io.BytesIO(); image.save(data, "JPEG"); data.seek(0)
            return client.post("/api/analyze", data={"photo": (data, "fixture.jpg"), "consent": "true", **fields})
        ordinary = post(); self.assertEqual(ordinary.status_code, 200); classifier.predict.assert_not_called()
        self.assertNotIn("scalp_reference", ordinary.json)
        cloud.side_effect = ServiceError("quota", 429, "upstream_quota")
        enlarged = post(scalp_macro="true"); self.assertEqual(enlarged.status_code, 200)
        self.assertEqual(enlarged.json["provider"], "ollama")
        self.assertEqual(enlarged.json["scalp_reference"], reference())
        self.assertEqual(cloud.call_args.kwargs["scalp_result"], local.analyze.call_args.kwargs["scalp_result"])
