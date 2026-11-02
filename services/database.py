"""Small local SQLite store for accounts, revocable sessions and opt-in reports."""
import hashlib
import io
import json
import re
import secrets
import sqlite3
import threading
import time
import unicodedata
from datetime import datetime, timezone
from contextlib import contextmanager
from pathlib import Path

from werkzeug.security import check_password_hash, generate_password_hash
from PIL import Image

from .errors import ServiceError


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class Database:
    def __init__(self, path):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(str(path), timeout=5, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self.connection:
            self.connection.execute("PRAGMA foreign_keys=ON")
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    expires_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS analysis_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    model TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    report_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS history_by_user ON analysis_history(user_id, id DESC);
                CREATE TABLE IF NOT EXISTS photos (
                    id TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    purpose TEXT NOT NULL CHECK(purpose IN ('analysis','local_training','vision_training')),
                    source_id TEXT NOT NULL,
                    history_id INTEGER UNIQUE REFERENCES analysis_history(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
                    width INTEGER NOT NULL CHECK(width>0),
                    height INTEGER NOT NULL CHECK(height>0),
                    byte_size INTEGER NOT NULL CHECK(byte_size>0),
                    sha256 TEXT NOT NULL,
                    image_data BLOB NOT NULL,
                    metadata_json TEXT NOT NULL,
                    UNIQUE(user_id,purpose,source_id)
                );
                CREATE INDEX IF NOT EXISTS photos_by_user ON photos(user_id,created_at DESC,id);
            """)
        self._dummy_hash = generate_password_hash(secrets.token_urlsafe(24))

    def close(self):
        with self._lock:
            self.connection.close()

    @staticmethod
    def username(value):
        return unicodedata.normalize("NFKC", value).strip().casefold()

    def register(self, username, password):
        username = self.username(username)
        if not re.fullmatch(r"[a-z0-9가-힣_]{3,24}", username):
            raise ServiceError("아이디는 한글·영문·숫자·밑줄 3~24자로 입력해 주세요.")
        if not 8 <= len(password) <= 128:
            raise ServiceError("비밀번호는 8~128자로 입력해 주세요.")
        encoded = generate_password_hash(password)
        try:
            with self._lock, self.connection:
                cursor = self.connection.execute(
                    "INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)",
                    (username, encoded, now_iso()))
                user_id = cursor.lastrowid
        except sqlite3.IntegrityError:
            raise ServiceError("이미 사용 중인 아이디예요.", 409, "username_exists") from None
        return {"id": user_id, "username": username}

    def authenticate(self, username, password):
        if len(username) > 100 or len(password) > 128:
            raise ServiceError("아이디 또는 비밀번호를 확인해 주세요.", 401, "invalid_credentials")
        with self._lock:
            row = self.connection.execute("SELECT * FROM users WHERE username=?", (self.username(username),)).fetchone()
        valid = check_password_hash(row["password_hash"] if row else self._dummy_hash, password)
        if not row or not valid:
            raise ServiceError("아이디 또는 비밀번호를 확인해 주세요.", 401, "invalid_credentials")
        return {"id": row["id"], "username": row["username"]}

    def create_session(self, user_id):
        token = secrets.token_urlsafe(32)
        with self._lock, self.connection:
            self.connection.execute("DELETE FROM sessions WHERE expires_at<=?", (time.time(),))
            self.connection.execute("INSERT INTO sessions VALUES(?,?,?)",
                                    (hashlib.sha256(token.encode()).hexdigest(), user_id, time.time() + 8 * 3600))
        return token

    def session_user(self, token):
        if not isinstance(token, str) or len(token) > 200:
            return None
        with self._lock:
            row = self.connection.execute(
                "SELECT u.id,u.username FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?",
                (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        return dict(row) if row else None

    def revoke_session(self, token):
        if isinstance(token, str):
            with self._lock, self.connection:
                self.connection.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))

    def profile(self, user_id):
        with self._lock:
            row = self.connection.execute(
                "SELECT u.id,u.username,u.created_at,"
                "(SELECT COUNT(*) FROM analysis_history WHERE user_id=u.id) AS report_count,"
                "(SELECT MAX(created_at) FROM analysis_history WHERE user_id=u.id) AS last_report_at "
                "FROM users u WHERE u.id=?", (user_id,)).fetchone()
        if not row:
            raise ServiceError("계정 정보를 찾지 못했어요.", 404, "account_not_found")
        return dict(row)

    def save_report(self, user_id, report, photo=None):
        # Optional photo bytes live in their own table, never inside report JSON.
        body = json.dumps(report, ensure_ascii=False, allow_nan=False)
        if len(body) > 64000:
            raise ValueError("Report too large")
        with self._lock, self.connection:
            cursor = self.connection.execute(
                "INSERT INTO analysis_history(user_id,created_at,model,summary,report_json) VALUES(?,?,?,?,?)",
                (user_id, now_iso(), report["model"], report["result"]["summary"][:300], body))
            if photo is not None:
                self._insert_photo(user_id, "analysis", str(cursor.lastrowid), photo,
                                   {"focus": report.get("focus", "all")}, history_id=cursor.lastrowid)
            return cursor.lastrowid

    def history(self, user_id):
        with self._lock:
            rows = self.connection.execute(
                "SELECT id,created_at,model,summary FROM analysis_history WHERE user_id=? ORDER BY id DESC LIMIT 50", (user_id,)).fetchall()
        return [dict(row) for row in rows]

    def dashboard(self, user_id):
        """Account totals and a small report preview, without loading photo bytes."""
        with self._lock:
            counts = self.connection.execute(
                "SELECT (SELECT COUNT(*) FROM analysis_history WHERE user_id=?) AS report_count,"
                "(SELECT COUNT(*) FROM photos WHERE user_id=?) AS photo_count",
                (user_id, user_id)).fetchone()
            recent = self.connection.execute(
                "SELECT id,created_at,summary FROM analysis_history WHERE user_id=? ORDER BY id DESC LIMIT 4",
                (user_id,)).fetchall()
        return {**dict(counts), "recent_reports": [dict(row) for row in recent]}

    def report(self, user_id, identifier):
        with self._lock:
            row = self.connection.execute(
                "SELECT report_json,created_at FROM analysis_history WHERE id=? AND user_id=?", (identifier, user_id)).fetchone()
        if not row:
            raise ServiceError("분석 기록을 찾지 못했어요.", 404, "history_not_found")
        report = json.loads(row["report_json"])
        report.update(history_id=identifier, created_at=row["created_at"])
        photo = self.report_photo(user_id, identifier)
        if photo:
            report["photo"] = photo
        return report

    def delete_report(self, user_id, identifier):
        with self._lock, self.connection:
            cursor = self.connection.execute("DELETE FROM analysis_history WHERE id=? AND user_id=?", (identifier, user_id))
            if not cursor.rowcount:
                raise ServiceError("분석 기록을 찾지 못했어요.", 404, "history_not_found")

    def user_ids(self):
        with self._lock:
            return [row[0] for row in self.connection.execute("SELECT id FROM users")]

    def _insert_photo(self, user_id, purpose, source_id, payload, metadata, history_id=None):
        if not isinstance(payload, bytes) or not 0 < len(payload) <= 12 * 1024 * 1024:
            raise ValueError("Invalid stored photo")
        with Image.open(io.BytesIO(payload)) as image:
            if image.format != "JPEG" or image.getexif() or image.width * image.height > 20_000_000:
                raise ValueError("Stored photo must be a metadata-free JPEG")
            image.load()
            width, height = image.size
        identifier = secrets.token_hex(16)
        self.connection.execute(
            "INSERT INTO photos(id,user_id,purpose,source_id,history_id,created_at,width,height,byte_size,sha256,image_data,metadata_json) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (identifier, user_id, purpose, source_id, history_id, now_iso(), width, height, len(payload),
             hashlib.sha256(payload).hexdigest(), payload, json.dumps(metadata, ensure_ascii=False, allow_nan=False)))
        return identifier

    @contextmanager
    def sync_training_photos(self, user_id, purpose, rows, read_photo):
        """Keep SQL and the worker's manifest in the same application transaction."""
        if purpose not in {"local_training", "vision_training"}:
            raise ValueError("Invalid photo purpose")
        identifiers = {row["id"] for row in rows}
        if len(identifiers) != len(rows):
            raise ValueError("Duplicate photo identifiers")
        with self._lock, self.connection:
            existing = {row["source_id"]: row for row in self.connection.execute(
                "SELECT source_id,metadata_json FROM photos WHERE user_id=? AND purpose=?", (user_id, purpose))}
            for row in rows:
                encoded = json.dumps(row, ensure_ascii=False, allow_nan=False)
                if row["id"] not in existing:
                    self._insert_photo(user_id, purpose, row["id"], read_photo(row), row)
                elif existing[row["id"]]["metadata_json"] != encoded:
                    self.connection.execute("UPDATE photos SET metadata_json=? WHERE user_id=? AND purpose=? AND source_id=?",
                                            (encoded, user_id, purpose, row["id"]))
            for source_id in existing.keys() - identifiers:
                self.connection.execute("DELETE FROM photos WHERE user_id=? AND purpose=? AND source_id=?", (user_id, purpose, source_id))
            yield

    @staticmethod
    def _photo_info(row):
        if row is None:
            return None
        info = {key: row[key] for key in ("id", "purpose", "source_id", "history_id", "created_at", "mime_type", "width", "height", "byte_size", "sha256")}
        metadata = json.loads(row["metadata_json"])
        info["metadata"] = {key: metadata[key] for key in ("label", "group", "focus", "source") if key in metadata}
        info["image_url"] = f"/api/photos/{row['id']}/image"
        return info

    def photos(self, user_id):
        with self._lock:
            rows = self.connection.execute(
                "SELECT id,purpose,source_id,history_id,created_at,mime_type,width,height,byte_size,sha256,metadata_json "
                "FROM photos WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 500", (user_id,)).fetchall()
            return [self._photo_info(row) for row in rows]

    def photo(self, user_id, identifier, *, include_image=False):
        if not re.fullmatch(r"[a-f0-9]{32}", identifier or ""):
            raise ServiceError("사진을 찾지 못했어요.", 404, "photo_not_found")
        fields = "id,purpose,source_id,history_id,created_at,mime_type,width,height,byte_size,sha256,metadata_json"
        with self._lock:
            row = self.connection.execute(f"SELECT {fields}{',image_data' if include_image else ''} FROM photos WHERE id=? AND user_id=?",
                                          (identifier, user_id)).fetchone()
            if row is None:
                raise ServiceError("사진을 찾지 못했어요.", 404, "photo_not_found")
            info = self._photo_info(row)
            return (info, bytes(row["image_data"])) if include_image else info

    def report_photo(self, user_id, history_id):
        with self._lock:
            row = self.connection.execute(
                "SELECT id,purpose,source_id,history_id,created_at,mime_type,width,height,byte_size,sha256,metadata_json "
                "FROM photos WHERE user_id=? AND history_id=?", (user_id, history_id)).fetchone()
            return self._photo_info(row)
