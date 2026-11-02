"""Authenticated local WebSocket notifications; no photos or report content."""
import json
import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from http import HTTPStatus

from websockets.datastructures import MultipleValuesError
from websockets.exceptions import ConnectionClosed
from websockets.sync.server import serve


@dataclass(eq=False)
class Peer:
    user_id: int
    sid: str
    topics: frozenset = field(default_factory=frozenset)
    pending: queue.Queue = field(default_factory=lambda: queue.Queue(maxsize=32))
    shutdown: tuple | None = None


class RealtimeHub:
    def __init__(self, app, database):
        self.app, self.database = app, database
        self.enabled = app.config["ENABLE_WEBSOCKET"]
        self.port = app.config["WEBSOCKET_PORT"]
        self.http_port = app.config["HTTP_PORT"]
        self.server = self.thread = None
        self._peers = set()
        self._lock = threading.Lock()
        self._logger = logging.getLogger("hairline.websocket")

    @property
    def running(self):
        return bool(self.server and self.thread and self.thread.is_alive())

    def start(self):
        if not self.enabled or self.running:
            return self
        if not 0 <= self.port <= 65535 or not 1 <= self.http_port <= 65535:
            raise ValueError("Invalid local WebSocket or HTTP port")
        if self.port == self.http_port:
            raise ValueError("HTTP and WebSocket ports must differ")
        self.server = serve(self.handle, "127.0.0.1", self.port,
                            origins=[f"http://127.0.0.1:{self.http_port}", f"http://localhost:{self.http_port}"],
                            process_request=self.authorize, compression=None,
                            open_timeout=5, ping_interval=20, ping_timeout=20,
                            close_timeout=1, max_size=4096, max_queue=8,
                            server_header=None, logger=self._logger)
        self.port = self.server.socket.getsockname()[1]
        self.thread = threading.Thread(target=self.server.serve_forever, name="hairline-websocket", daemon=True)
        self.thread.start()
        return self

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.thread.join(timeout=5)
            self.server = self.thread = None

    @staticmethod
    def reject(connection, status, message):
        response = connection.respond(status, message + "\n")
        response.headers["Cache-Control"] = "no-store"
        return response

    def authorize(self, connection, request):
        if request.path != "/ws":
            return self.reject(connection, HTTPStatus.NOT_FOUND, "not_found")
        try:
            host = request.headers.get("Host", "").lower()
            origin = request.headers.get("Origin", "")
            cookie = request.headers.get("Cookie", "")
        except MultipleValuesError:
            return self.reject(connection, HTTPStatus.BAD_REQUEST, "invalid_headers")
        hosts = {f"127.0.0.1:{self.port}": "127.0.0.1", f"localhost:{self.port}": "localhost"}
        if host not in hosts or origin != f"http://{hosts[host]}:{self.http_port}":
            return self.reject(connection, HTTPStatus.FORBIDDEN, "invalid_origin")
        if len(cookie) > 4096:
            return self.reject(connection, HTTPStatus.BAD_REQUEST, "invalid_cookie")
        flask_request = self.app.request_class.from_values(base_url=f"http://{host}", headers={"Cookie": cookie})
        signed_session = self.app.session_interface.open_session(self.app, flask_request)
        sid = signed_session.get("sid") if signed_session else None
        user = self.database.session_user(sid)
        if not user:
            return self.reject(connection, HTTPStatus.UNAUTHORIZED, "login_required")
        connection.hairline_identity = (user["id"], sid)
        return None

    def publish(self, user_id, topic):
        if topic not in {"history", "training"}:
            raise ValueError("Unsupported notification topic")
        # HTTP requests only enqueue a small notification; they never wait on a socket.
        with self._lock:
            for peer in self._peers:
                if peer.user_id != user_id or topic not in peer.topics or peer.shutdown:
                    continue
                try:
                    peer.pending.put_nowait({"type": f"{topic}.updated"})
                except queue.Full:
                    peer.shutdown = (1013, "reconnect_required")

    def revoke(self, sid):
        with self._lock:
            for peer in self._peers:
                if peer.sid == sid:
                    peer.shutdown = (1008, "session_ended")

    def authenticated(self, peer):
        user = self.database.session_user(peer.sid)
        return bool(user and user["id"] == peer.user_id)

    @staticmethod
    def send(connection, payload):
        connection.send(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

    def message(self, peer, raw):
        try:
            data = json.loads(raw)
        except (ValueError, RecursionError):
            return {"type": "error", "code": "invalid_message"}
        if type(data) is not dict:
            return {"type": "error", "code": "invalid_message"}
        if data == {"type": "ping"}:
            return {"type": "pong"}
        if data == {"type": "status"}:
            profile = self.database.profile(peer.user_id)
            training = self.app.extensions["trainers"].for_user(peer.user_id).status()
            return {"type": "status", "history_count": profile["report_count"],
                    "training_count": training["total"], "model_ready": training["model_ready"]}
        if data.get("type") == "subscribe" and set(data) == {"type", "topics"}:
            topics = data["topics"]
            if (type(topics) is list and len(topics) <= 2 and
                    all(type(topic) is str and topic in {"history", "training"} for topic in topics) and
                    len(set(topics)) == len(topics)):
                peer.topics = frozenset(topics)
                return {"type": "subscribed", "topics": sorted(peer.topics)}
        return {"type": "error", "code": "unsupported_message"}

    def handle(self, connection):
        peer = Peer(*connection.hairline_identity)
        with self._lock:
            admitted = len(self._peers) < 32 and sum(item.user_id == peer.user_id for item in self._peers) < 4
            if admitted:
                self._peers.add(peer)
        if not admitted:
            connection.close(1013, "connection_limit")
            return
        try:
            self.send(connection, {"type": "connected", "version": 1})
            window_started, received = time.monotonic(), 0
            while True:
                if peer.shutdown or not self.authenticated(peer):
                    connection.close(*(peer.shutdown or (1008, "session_ended")))
                    break
                for _ in range(32):
                    try:
                        notification = peer.pending.get_nowait()
                    except queue.Empty:
                        break
                    if peer.shutdown or not self.authenticated(peer):
                        break
                    if notification["type"].split(".", 1)[0] in peer.topics:
                        self.send(connection, notification)
                try:
                    raw = connection.recv(timeout=0.5)
                except TimeoutError:
                    continue
                if not isinstance(raw, str):
                    connection.close(1003, "text_json_required")
                    break
                if time.monotonic() - window_started >= 60:
                    window_started, received = time.monotonic(), 0
                received += 1
                if received > 60:
                    connection.close(1008, "rate_limited")
                    break
                if not self.authenticated(peer):
                    connection.close(1008, "session_ended")
                    break
                reply = self.message(peer, raw)
                if self.authenticated(peer):
                    self.send(connection, reply)
        except ConnectionClosed:
            pass
        except Exception as error:
            self._logger.error("WebSocket handler failed: %s", type(error).__name__)
            connection.close(1011, "internal_error")
        finally:
            with self._lock:
                self._peers.discard(peer)
