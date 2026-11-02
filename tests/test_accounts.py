import hashlib
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from werkzeug.security import check_password_hash

from app import create_app
from helpers import TEST_CONFIG, client_with_csrf, sync_csrf
from services.accounts import secret_key
from test_app import analysis, photo
from test_training import sample_image


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.app = create_app({**TEST_CONFIG, "TESTING": True, "GEMINI_API_KEY": "fake-key",
                               "TRAINING_DIR": str(Path(self.folder.name) / "training")})
        self.database = self.app.extensions["database"]
        self.client, _ = client_with_csrf(self.app)

    def tearDown(self):
        self.database.close()
        self.folder.cleanup()

    def register(self, username="developer_1", password="StrongPassword123!"):
        response = self.client.post("/api/auth/register", data={"username": username, "password": password})
        if response.status_code == 201:
            sync_csrf(self.client, response)
        return response

    def logout(self):
        response = self.client.post("/api/auth/logout")
        sync_csrf(self.client, response)
        return response

    def analyze(self, client=None, **fields):
        return (client or self.client).post("/api/analyze", data={"photo": (photo(), "private-name.jpg"), "consent": "true", **fields})

    def test_signup_hashes_password_and_sets_http_only_cookie(self):
        response = self.register("DeVeloper_1")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json["user"]["username"], "developer_1")
        stored = self.database.connection.execute("SELECT password_hash FROM users").fetchone()[0]
        self.assertTrue(stored.startswith("scrypt:"))
        self.assertTrue(check_password_hash(stored, "StrongPassword123!"))
        self.assertNotIn("StrongPassword", stored)
        self.assertNotIn("password_hash", response.text)
        self.assertIn("HttpOnly", response.headers["Set-Cookie"])
        self.assertIn("SameSite=Lax", response.headers["Set-Cookie"])
        self.assertEqual(self.client.get("/api/auth/me").json["user"], response.json["user"])

    def test_csrf_is_required_and_rotated_after_signup(self):
        fresh = self.app.test_client()
        self.assertEqual(fresh.post("/api/auth/register").status_code, 403)
        self.assertEqual(self.client.post("/api/auth/login", headers={"X-CSRF-Token": "wrong"}).status_code, 403)
        self.assertEqual(self.client.post("/api/auth/login", headers={"X-CSRF-Token": "잘못된토큰"}).status_code, 403)
        old = self.client.environ_base["HTTP_X_CSRF_TOKEN"]
        self.register()
        self.assertNotEqual(old, self.client.environ_base["HTTP_X_CSRF_TOKEN"])
        self.assertEqual(self.client.post("/api/auth/logout", headers={"X-CSRF-Token": old}).status_code, 403)

    def test_credentials_validation_and_duplicate_normalization(self):
        for username, password in [("ab", "password123"), ("../name", "password123"), ("name", "short"), ("name", "x" * 129)]:
            self.assertEqual(self.register(username, password).status_code, 400)
        self.assertEqual(self.register().status_code, 201)
        self.logout()
        self.assertEqual(self.register("DEVELOPER_1").status_code, 409)

    def test_wrong_password_and_sql_input_do_not_login(self):
        self.register()
        self.logout()
        responses = [self.client.post("/api/auth/login", data={"username": name, "password": "wrong"})
                     for name in ("developer_1", "missing", "' OR 1=1 --")]
        self.assertTrue(all(r.status_code == 401 for r in responses))
        self.assertEqual(responses[0].json, responses[1].json)
        self.assertIsNone(self.client.get("/api/auth/me").json["user"])

    def test_login_and_logout_revoke_old_cookie_on_server(self):
        self.register()
        old_cookie = self.client.get_cookie("hairline_session").value
        with self.client.session_transaction() as session:
            sid = session["sid"]
        stored = self.database.connection.execute("SELECT token_hash FROM sessions").fetchone()[0]
        self.assertEqual(stored, hashlib.sha256(sid.encode()).hexdigest())
        self.assertNotEqual(stored, sid)
        self.logout()
        replay = self.app.test_client()
        replay.set_cookie("hairline_session", old_cookie)
        self.assertIsNone(replay.get("/api/auth/me").json["user"])
        response = self.client.post("/api/auth/login", data={"username": "developer_1", "password": "StrongPassword123!"})
        self.assertEqual(response.status_code, 200)
        with self.client.session_transaction() as session:
            self.assertNotEqual(sid, session["sid"])

    def test_expired_session_cannot_access_history(self):
        self.register()
        with self.database.connection:
            self.database.connection.execute("UPDATE sessions SET expires_at=?", (time.time() - 1,))
        self.assertEqual(self.client.get("/api/history").status_code, 401)
        self.assertIsNone(self.client.get("/api/auth/me").json["user"])

    def test_login_attempts_are_limited(self):
        for _ in range(10):
            self.assertEqual(self.client.post("/api/auth/login", data={"username": "absent", "password": "bad"}).status_code, 401)
        self.assertEqual(self.client.post("/api/auth/login", data={"username": "absent", "password": "bad"}).status_code, 429)

    def test_guest_cannot_access_private_endpoints(self):
        for method, path in [("get", "/api/history"), ("get", "/api/training/status"),
                             ("post", "/api/training/add"), ("post", "/api/training/train"), ("post", "/api/classify")]:
            self.assertEqual(getattr(self.client, method)(path).status_code, 401)
        with patch.object(self.app.extensions["gemini"], "analyze") as remote:
            self.assertEqual(self.analyze(save_history="true").status_code, 401)
            remote.assert_not_called()

    def test_reports_only_saved_with_explicit_opt_in(self):
        self.register()
        with patch.object(self.app.extensions["gemini"], "analyze", return_value=analysis()):
            self.assertEqual(self.analyze().status_code, 200)
            self.assertEqual(self.client.get("/api/history").json["items"], [])
            response = self.analyze(save_history="true", ocr_text="private-source-text", ocr_text_consent="true")
        self.assertEqual(response.status_code, 200)
        self.assertIn("history_id", response.json)
        items = self.client.get("/api/history").json["items"]
        self.assertEqual(len(items), 1)
        stored = self.database.connection.execute("SELECT report_json FROM analysis_history").fetchone()[0]
        for private in ("private-name", "private-source-text", "data:image", "fake-key", "password"):
            self.assertNotIn(private, stored)
        report = self.client.get(f"/api/history/{items[0]['id']}")
        self.assertEqual(report.json["result"], response.json["result"])
        self.assertIn("created_at", report.json)

    def test_other_account_cannot_read_delete_or_classify_my_data(self):
        first = self.register().json["user"]
        second_client, second = client_with_csrf(self.app, "developer_2")
        trainer = self.app.extensions["trainers"].for_user(first["id"])
        record = trainer.add(sample_image(), "reference", "p001")
        self.assertEqual(self.client.get("/api/training/status").json["total"], 1)
        self.assertEqual(second_client.get("/api/training/status").json["total"], 0)
        self.assertEqual(second_client.post("/api/training/remove", data={"id": record["id"]}).status_code, 404)
        self.assertEqual(second_client.post("/api/classify", data={"photo": (photo(), "test.jpg")}).status_code, 409)
        self.assertNotEqual(trainer.directory, self.app.extensions["trainers"].for_user(second["id"]).directory)
        with patch.object(self.app.extensions["gemini"], "analyze", return_value=analysis()):
            identifier = self.analyze(save_history="true").json["history_id"]
        self.assertEqual(second_client.get("/api/history").json["items"], [])
        self.assertEqual(second_client.get(f"/api/history/{identifier}").status_code, 404)
        self.assertEqual(second_client.delete(f"/api/history/{identifier}").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/history/{identifier}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/history/{identifier}").status_code, 404)

    def test_report_survives_save_failure_instead_of_losing_api_result(self):
        self.register()
        with patch.object(self.app.extensions["gemini"], "analyze", return_value=analysis()), \
                patch.object(self.database, "save_report", side_effect=sqlite3.OperationalError("private path")):
            response = self.analyze(save_history="true")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["result"]["summary"], analysis()["summary"])
        self.assertEqual(response.json["result"]["observations"], analysis()["observations"])
        self.assertEqual(response.json["result"]["visual_evidence"], analysis()["visual_evidence"])
        self.assertEqual(response.json["result"]["quality_review"]["status"], "consistent")
        self.assertIn("history_error", response.json)
        self.assertNotIn("private path", response.text)

    def test_training_page_is_separate(self):
        response = self.client.get("/training")
        self.assertEqual(response.status_code, 200)
        self.assertIn('id="training-run"', response.text)
        response.close()
        response = self.client.get("/")
        self.assertNotIn('id="training-run"', response.text)
        self.assertIn('href="/training"', response.text)
        response.close()

    def test_return_to_allows_only_app_pages(self):
        from services.accounts import safe_return_to
        self.assertEqual(safe_return_to("/training"), "/training")
        self.assertEqual(safe_return_to("/training-guide"), "/training-guide")
        self.assertEqual(safe_return_to("/profile"), "/profile")
        self.assertEqual(safe_return_to("/simulation"), "/simulation")
        self.assertEqual(safe_return_to("/guide#faq"), "/guide#faq")
        self.assertEqual(safe_return_to("/analysis?report=1#simulation"), "/analysis?report=1#simulation")
        self.assertEqual(safe_return_to("/#ocr"), "/#ocr")
        for value in ("//evil.example/training", "https://evil.example/", "/login", "/training/../x"):
            self.assertEqual(safe_return_to(value), "/")

    def test_profile_requires_login_and_preserves_the_return_destination(self):
        response = self.client.get("/profile")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/login?next=/profile")
        login = self.client.get(response.headers["Location"])
        self.assertIn('data-next="/profile"', login.text)
        self.register()
        response = self.client.get("/login?next=/profile")
        self.assertEqual(response.headers["Location"], "/profile")

    def test_profile_shows_own_account_and_total_reports_without_secrets(self):
        user = self.register("profile_owner").json["user"]
        other, other_user = client_with_csrf(self.app, "another_private_account")
        for _ in range(52):
            self.database.save_report(user["id"], {"model": "test", "result": analysis()})
        self.database.save_report(other_user["id"], {"model": "test", "result": analysis()})
        with self.database.connection:
            self.database.connection.execute("UPDATE users SET created_at=? WHERE id=?",
                                             ("2026-10-28T16:00:00+00:00", user["id"]))
        response = self.client.get("/profile", query_string={"user_id": other_user["id"]})
        self.assertEqual(response.status_code, 200)
        self.assertIn("profile_owner", response.text)
        self.assertNotIn("another_private_account", response.text)
        self.assertIn("2026.10.29", response.text)
        self.assertIn("<strong>52<small>", response.text)
        self.assertIn('href="/#history"', response.text)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertNotIn("password_hash", response.text)
        self.assertNotIn("StrongPassword123!", response.text)
        self.assertNotIn("scrypt:", response.text)
        self.assertEqual(set(self.database.profile(user["id"])),
                         {"id", "username", "created_at", "report_count", "last_report_at"})
        self.assertNotIn("profile_owner", other.get("/profile").text)

    def test_profile_training_summary_is_scoped_to_the_current_user(self):
        user = self.register().json["user"]
        trainer = self.app.extensions["trainers"].for_user(user["id"])
        with patch.object(trainer, "status", return_value={"total": 7, "model_ready": True, "model_stale": False}):
            response = self.client.get("/profile")
        self.assertEqual(response.status_code, 200)
        self.assertIn("<strong>7<small>", response.text)
        self.assertIn("사용 가능", response.text)
        self.assertIn("아직 저장한 리포트가 없어요", response.text)

    def test_expired_profile_session_redirects_without_rendering_private_information(self):
        self.register("profile_expired")
        with self.database.connection:
            self.database.connection.execute("UPDATE sessions SET expires_at=0")
        response = self.client.get("/profile")
        self.assertEqual(response.status_code, 302)
        self.assertNotIn("profile_expired", response.text)

    def test_all_signed_in_headers_link_to_the_profile_page(self):
        for path in ("/", "/training", "/training-guide"):
            response = self.client.get(path)
            self.assertIn('<a id="account-name" class="account-profile" href="/profile"', response.text)
            response.close()

    def test_local_camera_policy_and_database_files_not_public(self):
        response = self.client.get("/")
        self.assertEqual(response.headers["Permissions-Policy"], "camera=(self), microphone=()")
        response.close()
        for path in ("/data/hairline.sqlite3", "/data/.session_secret", "/data/training/users/1/dataset.json"):
            self.assertEqual(self.client.get(path).status_code, 404)

    def test_login_and_register_are_distinct_pages_with_correct_forms(self):
        for path, mode in [("/login", "login"), ("/register", "register")]:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertIn(f'data-mode="{mode}"', response.text)
            self.assertIn(f'action="/api/auth/{mode}"', response.text)
            self.assertIn('/static/account-page.js', response.text)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertNotIn('/static/app.js', response.text)
            self.assertEqual('id="account-confirm"' in response.text, mode == "register")
        home = self.client.get("/")
        self.assertIn('id="account-login" href="/login"', home.text)
        self.assertIn('id="account-register" href="/register"', home.text)
        self.assertNotIn('id="account-dialog"', home.text)
        home.close()

    def test_auth_pages_preserve_return_section_and_redirect_signed_in_users(self):
        for path in ("/login", "/register"):
            response = self.client.get(path, query_string={"next": "/#training"})
            self.assertIn('data-next="/#training"', response.text)
            self.assertIn('next=/%23training', response.text)
        self.register()
        for path in ("/login", "/register"):
            response = self.client.get(path, query_string={"next": "/#training"})
            self.assertEqual(response.status_code, 302)
            self.assertEqual(response.headers["Location"], "/#training")

    def test_auth_return_destination_blocks_external_urls_and_non_app_paths(self):
        targets = ["https://foreign.example/", "//foreign.example/", "/\\foreign.example", "/api/history",
                   "javascript:alert(1)", "/\n/foreign.example", "https://[malformed", "/" + "x" * 2100]
        for target in targets:
            for path in ("/login", "/register"):
                response = self.client.get(path, query_string={"next": target})
                self.assertEqual(response.status_code, 200)
                self.assertIn('data-next="/"', response.text)
        self.register()
        for target in targets:
            response = self.client.get("/login", query_string={"next": target})
            self.assertEqual(response.status_code, 302)
            self.assertEqual(response.headers["Location"], "/")


class DatabasePersistenceTests(unittest.TestCase):
    def test_database_and_session_survive_application_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            config = {**TEST_CONFIG, "TESTING": True, "DATABASE_PATH": str(Path(folder) / "app.sqlite3")}
            app = create_app(config)
            client, user = client_with_csrf(app, "persistent_user")
            identifier = app.extensions["database"].save_report(user["id"], {"model": "test", "result": analysis()})
            cookie = client.get_cookie("hairline_session").value
            app.extensions["database"].close()
            reopened = create_app(config)
            try:
                second = reopened.test_client()
                second.set_cookie("hairline_session", cookie)
                self.assertEqual(second.get("/api/auth/me").json["user"], user)
                self.assertEqual(second.get(f"/api/history/{identifier}").json["result"], analysis())
            finally:
                reopened.extensions["database"].close()

    def test_generated_session_secret_is_persistent(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / ".session_secret"
            self.assertEqual(secret_key(path), secret_key(path))
            self.assertGreaterEqual(len(secret_key(path)), 32)


if __name__ == "__main__":
    unittest.main()
