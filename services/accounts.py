import os
import secrets
import io
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from flask import g, jsonify, redirect, render_template, request, session, url_for, send_file

from .errors import ServiceError
from .training import LocalTrainer
from .photo_storage import AccountPhotoStore


def secret_key(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="ascii") as output:
            output.write(secrets.token_urlsafe(48))
    except FileExistsError:
        pass
    value = path.read_text(encoding="ascii").strip()
    if len(value) < 32:
        raise RuntimeError("Session secret must contain at least 32 characters")
    return value


class AccountTrainers:
    def __init__(self, root, database=None):
        self.root = Path(root)
        self.database = database
        self._items = {}
        self._lock = threading.Lock()

    def for_user(self, user_id):
        if type(user_id) is not int or user_id < 1:
            raise ServiceError("로그인이 필요해요.", 401, "login_required")
        with self._lock:
            if user_id not in self._items:
                store = AccountPhotoStore(self.database, user_id, "local_training") if self.database else None
                trainer = LocalTrainer(self.root / "users" / str(user_id), photo_store=store)
                trainer.sync_database()
                self._items[user_id] = trainer
            return self._items[user_id]


def require_user():
    if not g.user:
        raise ServiceError("이 기능은 로그인 후 사용할 수 있어요.", 401, "login_required")
    return g.user


def safe_return_to(value):
    """Only the app's own pages can be the destination after authentication."""
    if len(value) > 2000 or "\\" in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        return "/"
    try:
        parsed = urlsplit(value)
    except ValueError:
        return "/"
    if parsed.scheme or parsed.netloc or parsed.path not in {"/", "/analysis", "/simulation", "/guide", "/training", "/training/vision", "/training-guide", "/profile"} or value.startswith("//"):
        return "/"
    return value


def init_accounts(app, database):
    app.config.update(SESSION_COOKIE_NAME="hairline_session", SESSION_COOKIE_HTTPONLY=True,
                      SESSION_COOKIE_SAMESITE="Lax", SESSION_COOKIE_SECURE=bool(os.getenv("VERCEL")) or os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true",
                      PERMANENT_SESSION_LIFETIME=timedelta(hours=8))
    failures = {}
    failure_lock = threading.Lock()

    def account_page(template, other_endpoint):
        return_to = safe_return_to(request.args.get("next", "/"))
        if g.user:
            return redirect(return_to)
        options = {"next": return_to} if return_to != "/" else {}
        return render_template(template, return_to=return_to, switch_url=url_for(other_endpoint, **options))

    @app.get("/login")
    def login_page():
        return account_page("login.html", "register_page")

    @app.get("/register")
    def register_page():
        return account_page("register.html", "login_page")

    @app.get("/profile")
    def profile_page():
        if not g.user:
            return redirect(url_for("login_page", next="/profile"))
        profile = database.profile(g.user["id"])
        training = app.extensions["trainers"].for_user(g.user["id"]).status()
        korea = timezone(timedelta(hours=9))

        def display_date(value):
            return datetime.fromisoformat(value).astimezone(korea).strftime("%Y.%m.%d") if value else None

        return render_template("profile.html", profile=profile, training=training,
                               joined_on=display_date(profile["created_at"]),
                               last_report_on=display_date(profile["last_report_at"]))

    @app.before_request
    def load_account_and_check_csrf():
        g.user = database.session_user(session.get("sid"))
        protected = (request.path.startswith("/api/training/") or request.path.startswith("/api/history")
                     or request.path.startswith("/api/photos")
                     or request.path == "/api/classify")
        if protected:
            require_user()
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            expected = session.get("csrf_token", "")
            provided = request.headers.get("X-CSRF-Token", "")
            if not expected or len(provided) > 128 or not provided.isascii() or not secrets.compare_digest(expected, provided):
                raise ServiceError("페이지를 새로고침한 뒤 다시 시도해 주세요.", 403, "csrf_failed")

    def response(user, status=200):
        if "csrf_token" not in session:
            session["csrf_token"] = secrets.token_urlsafe(32)
        return jsonify(user=user, csrf_token=session["csrf_token"]), status

    def sign_in(user):
        old_sid = session.get("sid")
        database.revoke_session(old_sid)
        app.extensions["realtime"].revoke(old_sid)
        session.clear()
        session["sid"] = database.create_session(user["id"])
        session["csrf_token"] = secrets.token_urlsafe(32)
        session.permanent = True

    @app.get("/api/auth/me")
    def me():
        if session.get("sid") and not g.user:
            session.clear()
        return response(g.user)

    @app.post("/api/auth/register")
    def register():
        if g.user:
            raise ServiceError("로그아웃 후 다른 계정을 만들어 주세요.", 409)
        user = database.register(request.form.get("username", ""), request.form.get("password", ""))
        sign_in(user)
        return response(user, 201)

    @app.post("/api/auth/login")
    def login():
        username = request.form.get("username", "")
        bucket = (request.remote_addr or "local", database.username(username[:100]))
        now = time.monotonic()
        with failure_lock:
            attempts = [t for t in failures.get(bucket, []) if now - t < 60]
            if len(attempts) >= 10:
                raise ServiceError("로그인 시도가 많아요. 1분 후 다시 시도해 주세요.", 429, "login_rate_limited")
        try:
            user = database.authenticate(username, request.form.get("password", ""))
        except ServiceError:
            with failure_lock:
                if len(failures) > 1000:
                    failures.clear()
                failures[bucket] = attempts + [now]
            raise
        with failure_lock:
            failures.pop(bucket, None)
        sign_in(user)
        return response(user)

    @app.post("/api/auth/logout")
    def logout():
        old_sid = session.get("sid")
        database.revoke_session(old_sid)
        app.extensions["realtime"].revoke(old_sid)
        session.clear()
        return response(None)

    @app.get("/api/history")
    def history():
        return jsonify(items=database.history(require_user()["id"]))

    @app.get("/api/dashboard")
    def dashboard():
        user_id = require_user()["id"]
        training = app.extensions["trainers"].for_user(user_id).status()
        return jsonify(**database.dashboard(user_id), training={
            key: training[key] for key in ("total", "model_ready", "model_stale", "can_train")})

    @app.get("/api/photos")
    def photos():
        return jsonify(items=database.photos(require_user()["id"]))

    @app.get("/api/photos/<identifier>")
    def photo_metadata(identifier):
        return jsonify(database.photo(require_user()["id"], identifier))

    @app.get("/api/photos/<identifier>/image")
    def photo_image(identifier):
        info, payload = database.photo(require_user()["id"], identifier, include_image=True)
        return send_file(io.BytesIO(payload), mimetype=info["mime_type"], download_name="photo.jpg", max_age=0)

    @app.get("/api/history/<int:identifier>")
    def get_report(identifier):
        return jsonify(database.report(require_user()["id"], identifier))

    @app.delete("/api/history/<int:identifier>")
    def delete_report(identifier):
        database.delete_report(require_user()["id"], identifier)
        app.extensions["realtime"].publish(g.user["id"], "history")
        return jsonify(deleted=True)
