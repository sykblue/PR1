import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

from PIL import Image
from app import create_app
from helpers import TEST_CONFIG, client_with_csrf
from services.analysis import AnalysisService
from services.errors import ServiceError
from services.images import image_bytes
from services.vision_training import VisionTraining
from services.vlm_data import VisionDataset, atomic_json, split_groups, validate_target


def target(usable=True):
    return {"image_usable": usable, "visible_signal": "not_obvious" if usable else "unclear", "summary": "Test target",
            "observations": [{"area": "Test area", "detail": "Visible outline"}] if usable else [],
            "limitations": ["Single photo"], "next_steps": ["Record consistent photos"]}


def add_examples(dataset):
    for group in range(4):
        for sample in range(2):
            dataset.save(Image.new("RGB", (160, 200), (group * 40 + sample, 120, 130)), f"p{group}", "all", target(group < 2))


class VisionDataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = VisionDataset(self.root / "u1")

    def test_targets_are_observation_json_and_unusable_examples_cannot_contain_observations(self):
        self.assertEqual(validate_target(target(False)), target(False))
        for value in (None, {}, {**target(), "image_usable": "true"}, {**target(False), "observations": target()["observations"]},
                      {**target(False), "visible_signal": "visible"}, {**target(), "next_steps": []}):
            with self.assertRaises(ServiceError): validate_target(value)

    def test_save_removes_metadata_and_editing_a_jpeg_preserves_its_identifier(self):
        image = Image.new("RGB", (160, 200), (133, 99, 71)); image.info["private"] = "not retained"
        row = self.data.save(image, "p001", "hairline", target())
        with Image.open(self.data.photo(row["id"])) as saved:
            self.assertNotIn("private", saved.info)
            decoded = saved.convert("RGB")
        revised = {**target(), "summary": "Revised observation"}
        result = self.data.save(decoded, "p001", "crown", revised, row["id"])
        self.assertEqual(result["id"], row["id"])
        self.assertEqual(len(self.data.rows()), 1)
        self.assertEqual(self.data.rows()[0]["target"], revised)
        with self.assertRaises(ServiceError): self.data.save(Image.new("RGB", (160, 200)), "p001", "all", target(), row["id"])

    def test_group_split_has_no_person_overlap_and_both_image_states_are_held_out(self):
        add_examples(self.data)
        status = self.data.readiness(); self.assertTrue(status["can_train"])
        self.assertEqual(status["counts"], {"usable": 4, "unusable": 4})
        train, validation = split_groups(status["samples"])
        self.assertFalse({row["group"] for row in train} & {row["group"] for row in validation})
        for subset in (train, validation): self.assertEqual({row["target"]["image_usable"] for row in subset}, {True, False})
        for row in status["samples"]: self.assertTrue(self.data.photo(row["id"]).is_file())

    def test_insufficient_data_group_collapse_and_path_traversal_are_rejected(self):
        self.assertFalse(self.data.readiness()["can_train"])
        for group in ("../p1", "private name", "a" * 41, ""):
            with self.assertRaises(ServiceError): self.data.save(Image.new("RGB", (160, 200)), group, "all", target())
        with self.assertRaises(ServiceError): self.data.photo("../outside")
        add_examples(self.data)
        rows = self.data.rows()
        for row in rows: row["group"] = "same-person"
        atomic_json(self.data.directory / "dataset.json", rows)
        self.assertFalse(self.data.readiness()["can_train"])


class VisionManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.python = self.root / "python.exe"; self.python.touch()
        atomic_json(self.root / ".cache/vlm/runtime.json", {"ready": True, "gpu": "Test GPU", "vram_gb": 8})
        self.ollama = Mock()
        self.manager = VisionTraining(self.root, python=self.python, ollama=self.ollama)
        add_examples(self.manager.dataset(1))

    def completed(self, user=1, job_id="a" * 32):
        path = self.manager._user(user) / "jobs" / job_id
        atomic_json(path / "status.json", {"id": job_id, "state": "completed", "metadata": {"adapter_updated": True}})
        atomic_json(path / "metadata.json", {"adapter_updated": True})
        atomic_json(path / "adapter/adapter_config.json", {"test": True})
        (path / "adapter/adapter_model.safetensors").write_bytes(b"test-only-weights")
        return path

    def test_start_snapshots_only_own_data_with_fixed_worker_arguments_and_no_shell(self):
        process = Mock(); process.poll.return_value = None
        with patch("services.vision_training.subprocess.Popen", return_value=process) as popen, patch("services.vision_training.threading.Thread"):
            job = self.manager.start(1, 20)
        path = self.manager._job(1, job["id"])
        snapshot = json.loads((path / "snapshot.json").read_text(encoding="utf-8"))
        self.assertEqual(len(snapshot["train"]) + len(snapshot["validation"]), 8)
        self.assertEqual(len(list((path / "images").glob("*.jpg"))), 8)
        self.assertEqual(popen.call_args.args[0][:3], [str(self.python), str(self.root / "scripts/vlm_worker.py"), "train"])
        self.assertNotIn("shell", popen.call_args.kwargs)
        self.ollama.release.assert_called_once()
        with self.assertRaises(ServiceError): self.manager.start(2, 20)
        with self.assertRaises(ServiceError): self.manager.remove(1, self.manager.dataset(1).rows()[0]["id"])
        self.manager.cancel(1, job["id"]); process.terminate.assert_called_once()
        self.assertTrue((path / "cancel.flag").exists())

    def test_activation_export_and_account_boundaries_never_expose_photos_or_other_users(self):
        path = self.completed()
        self.manager.activate(1, path.name)
        self.assertEqual(self.manager.active_job(1), path.name)
        self.assertIsNone(self.manager.active_job(2))
        with self.assertRaises(ServiceError): self.manager.activate(2, path.name)
        with self.assertRaises(ServiceError): self.manager.export(2, path.name)
        with self.assertRaises(ServiceError): self.manager._job(1, "../u2")
        with zipfile.ZipFile(self.manager.export(1, path.name)) as archive:
            self.assertEqual(set(archive.namelist()), {"adapter/adapter_model.safetensors", "adapter/adapter_config.json", "metadata.json"})
        self.manager.activate(1, None); self.assertIsNone(self.manager.active_job(1))

    def test_pending_and_incomplete_models_cannot_be_applied(self):
        path = self.completed()
        (path / "adapter/adapter_model.safetensors").unlink()
        with self.assertRaises(ServiceError): self.manager.activate(1, path.name)
        atomic_json(path / "status.json", {"id": path.name, "state": "running"})
        with self.assertRaises(ServiceError): self.manager.client(1, path.name)

    def test_private_inference_uses_json_stdin_and_timeout_and_strictly_validates_results(self):
        path = self.completed()
        success = subprocess.CompletedProcess([], 0, stdout="HAIRLINE_RESULT " + json.dumps({"result": target()}), stderr="private runtime output")
        image = Image.new("RGB", (160, 200))
        with patch("services.vision_training.subprocess.run", return_value=success) as run:
            result = self.manager.infer(1, path.name, image, focus="crown")
        self.assertEqual(result, target())
        payload = json.loads(run.call_args.kwargs["input"])
        self.assertEqual(payload["focus"], "crown"); self.assertIn("image", payload)
        self.assertNotIn("image", " ".join(run.call_args.args[0]))
        self.assertEqual(run.call_args.kwargs["timeout"], 120)
        self.assertFalse(self.manager._infer_busy)
        with patch("services.vision_training.subprocess.run", side_effect=subprocess.TimeoutExpired("test", 120)):
            with self.assertRaises(ServiceError) as caught: self.manager.infer(1, path.name, image)
        self.assertEqual(caught.exception.code, "vision_inference_timeout")
        self.assertFalse(self.manager._infer_busy)

    def test_account_adapter_is_only_used_after_quota_and_reports_the_real_provider(self):
        path = self.completed(); self.manager.activate(1, path.name)
        gemini, default = Mock(model="gemini"), Mock(model="base-ollama")
        gemini.analyze.side_effect = ServiceError("Quota", 429, "upstream_quota")
        with patch.object(self.manager, "infer", return_value=target()) as infer:
            result = AnalysisService(gemini, default).analyze(Image.new("RGB", (160, 200)), local_client=self.manager.client(1), focus="hairline")
        self.assertEqual(result["provider"], "local_adapter")
        self.assertEqual(result["model"], "hairline-qlora-" + path.name[:8])
        self.assertEqual(infer.call_args.args[:2], (1, path.name)); default.analyze.assert_not_called()


class VisionEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.app = create_app({**TEST_CONFIG, "VISION_TRAINING_DIR": self.temp.name, "GEMINI_API_KEY": "test-key"})
        self.addCleanup(self.app.extensions["database"].close)
        self.client, _ = client_with_csrf(self.app, "vision_user")

    def photo(self): return io.BytesIO(image_bytes(Image.new("RGB", (160, 200), (120, 130, 140)), "JPEG"))

    def test_page_login_return_and_private_endpoints_keep_auth_csrf_and_storage_consent(self):
        page = self.client.get("/training/vision"); self.assertEqual(page.status_code, 200); page.close()
        anonymous = self.app.test_client()
        self.assertEqual(anonymous.get("/api/training/vision/status").status_code, 401)
        self.assertEqual(anonymous.post("/api/training/vision/start").status_code, 401)
        self.assertEqual(self.client.post("/api/training/vision/save", data={"photo": (self.photo(), "test.jpg")}).status_code, 400)
        failed = self.client.post("/api/training/vision/start", headers={"X-CSRF-Token": "wrong"})
        self.assertEqual(failed.status_code, 403)
        from services.accounts import safe_return_to
        self.assertEqual(safe_return_to("/training/vision"), "/training/vision")

    def test_registered_annotations_and_photo_reads_are_own_account_only(self):
        saved = self.client.post("/api/training/vision/save", data={"photo": (self.photo(), "test.jpg"), "storage_consent": "true", "group": "p001", "focus": "all", "target": json.dumps(target())})
        self.assertEqual(saved.status_code, 201, saved.json)
        identifier = saved.json["sample"]["id"]
        status = self.client.get("/api/training/vision/status")
        self.assertEqual(status.json["total"], 1)
        image = self.client.get("/api/training/vision/photo/" + identifier)
        self.assertEqual(image.status_code, 200); self.assertIn("no-store", image.headers["Cache-Control"])
        image.close()
        other, _ = client_with_csrf(self.app, "vision_other")
        self.assertEqual(other.get("/api/training/vision/photo/" + identifier).status_code, 404)
        self.assertEqual(other.get("/api/training/vision/status").json["total"], 0)
        invalid = self.client.post("/api/training/vision/save", data={"photo": (self.photo(), "test.jpg"), "storage_consent": "true", "group": "p001", "target": "not json"})
        self.assertEqual(invalid.status_code, 400)


if __name__ == "__main__": unittest.main()
