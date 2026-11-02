import tempfile
import unittest
from pathlib import Path

from app import create_app
from helpers import TEST_CONFIG, client_with_csrf
from services.images import image_bytes
from test_training import sample_image


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.app = create_app({**TEST_CONFIG, "TESTING": True,
                               "TRAINING_DIR": str(Path(self.folder.name) / "training")})
        self.db = self.app.extensions["database"]

    def tearDown(self):
        self.db.close()
        self.folder.cleanup()

    def test_guest_cannot_read_account_dashboard(self):
        response = self.app.test_client().get("/api/dashboard")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json["error"]["code"], "login_required")
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_empty_account_has_real_zero_totals_and_no_model(self):
        client, _ = client_with_csrf(self.app, "empty_user")
        self.assertEqual(client.get("/api/dashboard").json, {
            "report_count": 0, "photo_count": 0, "recent_reports": [],
            "training": {"total": 0, "model_ready": False, "model_stale": False, "can_train": False}})

    def test_totals_are_exact_recent_reports_are_limited_and_accounts_are_isolated(self):
        first, user = client_with_csrf(self.app, "first_user")
        second, other = client_with_csrf(self.app, "second_user")
        trainer = self.app.extensions["trainers"].for_user(user["id"])
        trainer.add(sample_image(11), "reference", "p001")
        jpeg = image_bytes(sample_image(12), "JPEG")
        identifiers = [self.db.save_report(user["id"], {"model": "test", "result": {"summary": f"Report {i}"}},
                                           photo=jpeg if i == 0 else None) for i in range(55)]
        self.db.save_report(other["id"], {"model": "test", "result": {"summary": "Other private report"}})
        before = self.db.connection.total_changes
        response = first.get("/api/dashboard")
        data = response.json
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(data["report_count"], 55)  # Not the history API's 50-row limit.
        self.assertEqual(data["photo_count"], 2)
        self.assertEqual(data["training"]["total"], 1)
        self.assertEqual([r["id"] for r in data["recent_reports"]], identifiers[-4:][::-1])
        self.assertEqual(set(data), {"report_count", "photo_count", "recent_reports", "training"})
        self.assertEqual(set(data["training"]), {"total", "model_ready", "model_stale", "can_train"})
        self.assertEqual(set(data["recent_reports"][0]), {"id", "created_at", "summary"})
        self.assertNotIn("Other private report", response.text)
        self.assertEqual(self.db.connection.total_changes, before)
        other_data = second.get("/api/dashboard").json
        self.assertEqual(other_data["report_count"], 1)
        self.assertEqual(other_data["photo_count"], 0)
        self.assertEqual(other_data["training"]["total"], 0)
        self.db.delete_report(user["id"], identifiers[-1])
        updated = first.get("/api/dashboard").json
        self.assertEqual(updated["report_count"], 54)
        self.assertEqual(updated["recent_reports"][0]["id"], identifiers[-2])
