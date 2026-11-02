import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from PIL import ImageDraw

from app import create_app
from helpers import TEST_CONFIG, client_with_csrf
from services.database import Database
from services.training import LocalTrainer
from test_app import analysis, photo
from test_training import sample_image


class PhotoDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {**TEST_CONFIG, "TESTING": True, "GEMINI_API_KEY": "fake",
                       "TRAINING_DIR": str(self.root / "training"), "VISION_TRAINING_DIR": str(self.root / "vision")}
        self.app = create_app(self.config)
        self.db = self.app.extensions["database"]; self.addCleanup(self.db.close)
        self.client, self.user = client_with_csrf(self.app, "photo_owner")

    def analyze(self, **fields):
        with patch.object(self.app.extensions["gemini"], "analyze", return_value=analysis()):
            return self.client.post("/api/analyze", data={"photo": (photo(), "private-original-name.jpg"),
                                    "consent": "true", **fields})

    def test_photo_and_metadata_are_private_and_deleted_with_the_report(self):
        response = self.analyze(save_history="true", save_photo="true", focus="crown")
        self.assertEqual(response.status_code, 200)
        info = response.json["photo"]
        image_response = self.client.get(info["image_url"])
        self.assertEqual(image_response.status_code, 200)
        self.assertEqual(image_response.mimetype, "image/jpeg")
        self.assertEqual(image_response.headers["Cache-Control"], "no-store")
        with Image.open(io.BytesIO(image_response.data)) as image:
            self.assertEqual((info["width"], info["height"]), image.size)
            self.assertFalse(image.getexif())
        self.assertEqual(info["sha256"], hashlib.sha256(image_response.data).hexdigest())
        self.assertEqual(info["byte_size"], len(image_response.data))
        self.assertEqual(info["metadata"]["focus"], "crown")
        self.assertNotIn("private-original-name", json.dumps(self.client.get("/api/photos").json))
        self.assertNotIn("image_data", self.client.get("/api/photos").text)
        self.assertEqual(self.client.get(f"/api/photos/{info['id']}").json, info)
        self.assertEqual(self.client.get(f"/api/history/{response.json['history_id']}").json["photo"], info)
        other, _ = client_with_csrf(self.app, "other_photo_owner")
        self.assertEqual(other.get("/api/photos").json["items"], [])
        self.assertEqual(other.get(info["image_url"]).status_code, 404)
        self.assertEqual(other.get(f"/api/photos/{info['id']}").status_code, 404)
        self.assertEqual(self.app.test_client().get(info["image_url"]).status_code, 401)
        self.assertEqual(self.client.delete(f"/api/history/{response.json['history_id']}").status_code, 200)
        self.assertEqual(self.client.get(info["image_url"]).status_code, 404)
        self.assertEqual(self.db.photos(self.user["id"]), [])

    def test_photo_storage_requires_its_own_choice_and_a_saved_report(self):
        self.assertEqual(self.analyze().status_code, 200)
        self.assertEqual(self.analyze(save_history="true").status_code, 200)
        self.assertEqual(self.db.photos(self.user["id"]), [])
        with patch.object(self.app.extensions["gemini"], "analyze") as provider:
            invalid = self.client.post("/api/analyze", data={"consent": "true", "save_photo": "true"})
            self.assertEqual((invalid.status_code, invalid.json["error"]["code"]), (400, "photo_history_required"))
            provider.assert_not_called()
        self.assertEqual(self.app.test_client().get("/api/photos").status_code, 401)

    def test_failed_photo_insert_rolls_back_the_report_and_keeps_analysis_result(self):
        self.db.connection.execute("CREATE TRIGGER fail_photo BEFORE INSERT ON photos BEGIN SELECT RAISE(ABORT,'controlled failure'); END")
        response = self.analyze(save_history="true", save_photo="true")
        self.assertEqual(response.status_code, 200)
        self.assertIn("history_error", response.json)
        self.assertNotIn("history_id", response.json)
        self.assertEqual(response.json["result"]["summary"], analysis()["summary"])
        self.assertEqual(self.db.history(self.user["id"]), [])
        self.assertEqual(self.db.photos(self.user["id"]), [])

    def test_upload_metadata_is_removed_before_the_photo_enters_sqlite(self):
        image = Image.new("RGB", (320, 400), "white")
        ImageDraw.Draw(image).line((0, 0, 319, 399), fill="black", width=10)
        exif = Image.Exif(); exif[271] = "PRIVATE_CAMERA_METADATA"; exif[274] = 6
        source = io.BytesIO(); image.save(source, "JPEG", exif=exif); source.seek(0)
        with patch.object(self.app.extensions["gemini"], "analyze", return_value=analysis()):
            response = self.client.post("/api/analyze", data={"photo": (source, "private-photo.jpg"),
                "consent": "true", "save_history": "true", "save_photo": "true"})
        self.assertEqual(response.status_code, 200)
        payload = self.client.get(response.json["photo"]["image_url"]).data
        self.assertNotIn(b"PRIVATE_CAMERA_METADATA", payload)
        with Image.open(io.BytesIO(payload)) as stored:
            self.assertFalse(stored.getexif()); self.assertEqual(stored.size, (400, 320))

    def test_training_photo_bytes_labels_and_deletion_are_synchronized(self):
        trainer = self.app.extensions["trainers"].for_user(self.user["id"])
        sample = trainer.add(sample_image(), "reference", "p001", source="analysis")
        info = self.db.photos(self.user["id"])[0]
        self.assertEqual(info["purpose"], "local_training")
        self.assertEqual(info["metadata"], {"label": "reference", "group": "p001", "source": "analysis"})
        payload = self.client.get(info["image_url"]).data
        self.assertEqual(payload, (trainer.directory / "학습" / (sample["id"] + ".jpg")).read_bytes())
        trainer.remove(sample["id"])
        self.assertEqual(self.db.photos(self.user["id"]), [])
        self.assertFalse(list(trainer.directory.rglob("*.jpg")))

    def test_failed_training_insert_and_delete_restore_manifest_and_files(self):
        trainer = self.app.extensions["trainers"].for_user(self.user["id"])
        first = trainer.add(sample_image(), "reference", "p001")
        before = (trainer.directory / "dataset.json").read_bytes()
        self.db.connection.execute("CREATE TRIGGER fail_photo BEFORE INSERT ON photos BEGIN SELECT RAISE(ABORT,'controlled failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            trainer.add(sample_image(20), "concern", "p002")
        self.assertEqual((trainer.directory / "dataset.json").read_bytes(), before)
        self.assertEqual(len(list(trainer.directory.rglob("*.jpg"))), 1)
        self.assertFalse(list(trainer.directory.rglob("*.tmp")))
        self.db.connection.execute("DROP TRIGGER fail_photo")
        self.db.connection.execute("CREATE TRIGGER fail_remove BEFORE DELETE ON photos BEGIN SELECT RAISE(ABORT,'controlled failure'); END")
        with self.assertRaises(sqlite3.IntegrityError): trainer.remove(first["id"])
        self.assertEqual((trainer.directory / "dataset.json").read_bytes(), before)
        self.assertEqual(len(list(trainer.directory.rglob("*.jpg"))), 1)
        self.assertEqual(len(self.db.photos(self.user["id"])), 1)

    def test_vision_training_photo_target_updates_and_delete_reach_the_database(self):
        service = self.app.extensions["vision_training"]
        sample = service.save(self.user["id"], sample_image(), "p001", "hairline", analysis())
        info = self.db.photos(self.user["id"])[0]
        self.assertEqual(info["purpose"], "vision_training")
        service.save(self.user["id"], sample_image(), "p002", "density", analysis())
        updated = self.db.photos(self.user["id"])[0]
        self.assertEqual(updated["id"], info["id"])
        self.assertEqual(updated["metadata"], {"group": "p002", "focus": "density"})
        service.remove(self.user["id"], sample["id"])
        self.assertEqual(self.db.photos(self.user["id"]), [])

    def test_migration_preserves_existing_accounts_and_files_and_is_idempotent(self):
        path = self.root / "persistent.sqlite3"
        old = Database(path)
        user = old.register("legacy_owner", "PersistentPassword123!")
        report_id = old.save_report(user["id"], {"model": "legacy", "result": analysis()})
        # This is the schema before photo storage was added.
        old.connection.execute("DROP TABLE photos"); old.connection.commit(); old.close()
        folder = self.root / "legacy-training" / "users" / str(user["id"])
        LocalTrainer(folder).add(sample_image(), "reference", "p001")
        before = {p.relative_to(folder): hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.rglob("*") if p.is_file()}
        identities = []
        new_report = None
        for attempt in range(2):
            app = create_app({**self.config, "DATABASE_PATH": str(path), "TRAINING_DIR": str(self.root / "legacy-training")})
            db = app.extensions["database"]
            try:
                self.assertEqual(db.authenticate("legacy_owner", "PersistentPassword123!")["id"], user["id"])
                self.assertEqual(db.report(user["id"], report_id)["model"], "legacy")
                photos = db.photos(user["id"]); self.assertEqual(len(photos), 1 + attempt)
                identities.append(next(item["id"] for item in photos if item["purpose"] == "local_training"))
                if attempt == 0:
                    new_report = db.save_report(user["id"], {"model": "with-photo", "result": analysis()}, photo=photo().getvalue())
                else:
                    stored_photo = db.report(user["id"], new_report)["photo"]
                    self.assertEqual(db.photo(user["id"], stored_photo["id"], include_image=True)[1], photo().getvalue())
            finally: db.close()
        self.assertEqual(identities[0], identities[1])
        after = {p.relative_to(folder): hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
