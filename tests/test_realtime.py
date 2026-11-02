import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from websockets.exceptions import ConnectionClosed, InvalidStatus
from websockets.sync.client import connect

from app import create_app
from helpers import TEST_CONFIG, client_with_csrf
from services.errors import ServiceError
from services.realtime import Peer
from test_app import analysis, photo


class RealtimeTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.app = create_app({**TEST_CONFIG, "TESTING": True, "GEMINI_API_KEY": "",
                               "HTTP_PORT": 8000, "WEBSOCKET_PORT": 0, "ENABLE_WEBSOCKET": True,
                               "TRAINING_DIR": str(Path(self.folder.name) / "training")})
        self.database = self.app.extensions["database"]
        self.client, self.user = client_with_csrf(self.app, "realtime_owner")
        self.hub = self.app.extensions["realtime"].start()
        self.uri = f"ws://127.0.0.1:{self.hub.port}/ws"

    def tearDown(self):
        self.hub.stop()
        self.database.close()
        self.folder.cleanup()

    def socket(self, client=None, cookie=None, origin="http://127.0.0.1:8000", uri=None):
        if cookie is None:
            cookie = "hairline_session=" + (client or self.client).get_cookie("hairline_session").value
        return connect(uri or self.uri, origin=origin, additional_headers={"Cookie": cookie},
                       proxy=None, open_timeout=3, close_timeout=1, ping_interval=None)

    def receive(self, socket):
        return json.loads(socket.recv(timeout=3))

    def subscribe(self, socket, topics):
        self.assertEqual(self.receive(socket), {"type": "connected", "version": 1})
        socket.send(json.dumps({"type": "subscribe", "topics": topics}))
        self.assertEqual(self.receive(socket), {"type": "subscribed", "topics": sorted(topics)})

    def assert_closed(self, socket, code):
        with self.assertRaises(ConnectionClosed) as closed:
            socket.recv(timeout=3)
        self.assertEqual(closed.exception.rcvd.code, code)

    def test_configuration_requires_login_and_exposes_only_connection_settings(self):
        self.assertEqual(self.app.test_client().get("/api/realtime").status_code, 401)
        response = self.client.get("/api/realtime")
        self.assertEqual(response.json, {"enabled": True, "port": self.hub.port, "path": "/ws"})
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertIn(f"ws://127.0.0.1:{self.hub.port}", response.headers["Content-Security-Policy"])

    def test_ping_and_status_work_over_an_actual_authenticated_websocket(self):
        with self.socket() as socket:
            self.assertEqual(self.receive(socket), {"type": "connected", "version": 1})
            socket.send('{"type":"ping"}')
            self.assertEqual(self.receive(socket), {"type": "pong"})
            socket.send('{"type":"status"}')
            self.assertEqual(self.receive(socket), {"type": "status", "history_count": 0,
                                                   "training_count": 0, "model_ready": False})

    def test_missing_or_tampered_session_cookie_cannot_complete_the_handshake(self):
        for cookie in ("", "hairline_session=invalid-signature"):
            with self.subTest(cookie_present=bool(cookie)), self.assertRaises(InvalidStatus) as rejected:
                with self.socket(cookie=cookie):
                    self.fail("Unauthenticated handshake accepted")
            self.assertEqual(rejected.exception.response.status_code, 401)

    def test_missing_foreign_or_wrong_port_origin_is_rejected(self):
        for origin in (None, "http://foreign.example", "http://127.0.0.1:9000", "http://localhost:8000"):
            with self.subTest(origin=origin), self.assertRaises(InvalidStatus) as rejected:
                with self.socket(origin=origin):
                    self.fail("Cross-origin handshake accepted")
            self.assertEqual(rejected.exception.response.status_code, 403)

    def test_unknown_path_and_query_credentials_are_not_supported(self):
        for uri in (self.uri + "?token=not-a-credential", self.uri + "/unknown"):
            with self.assertRaises(InvalidStatus) as rejected:
                with self.socket(uri=uri):
                    self.fail("Unknown endpoint accepted")
            self.assertEqual(rejected.exception.response.status_code, 404)

    def test_notifications_reach_only_the_owner_and_subscribed_topic(self):
        other, other_user = client_with_csrf(self.app, "other_owner")
        with self.socket() as mine, self.socket(client=other) as theirs:
            self.subscribe(mine, ["history"])
            self.subscribe(theirs, ["history", "training"])
            self.hub.publish(self.user["id"], "history")
            self.assertEqual(self.receive(mine), {"type": "history.updated"})
            with self.assertRaises(TimeoutError):
                theirs.recv(timeout=0.15)
            self.hub.publish(self.user["id"], "training")
            with self.assertRaises(TimeoutError):
                mine.recv(timeout=0.15)
            self.hub.publish(other_user["id"], "training")
            self.assertEqual(self.receive(theirs), {"type": "training.updated"})

    def test_invalid_messages_cannot_select_another_account_or_change_data(self):
        with self.socket() as socket:
            self.receive(socket)
            messages = ["{", "[]", '{"type":"subscribe","topics":[{}]}',
                        '{"type":"subscribe","topics":["history","history"]}',
                        '{"type":"subscribe","topics":["history"],"user_id":999}',
                        '{"type":"delete","id":1}', '{"type":"ping","photo":"private-input"}']
            for raw in messages:
                socket.send(raw)
                self.assertEqual(self.receive(socket)["type"], "error")
            socket.send('{"type":"ping"}')
            self.assertEqual(self.receive(socket), {"type": "pong"})
            self.assertEqual(self.database.profile(self.user["id"])["report_count"], 0)

    def test_binary_and_oversized_messages_close_the_connection(self):
        for payload, code in ((b"binary-photo", 1003), ("x" * 4097, 1009)):
            with self.socket() as socket:
                self.receive(socket)
                socket.send(payload)
                self.assert_closed(socket, code)

    def test_logout_revokes_the_active_connection(self):
        with self.socket() as socket:
            self.receive(socket)
            self.assertEqual(self.client.post("/api/auth/logout").status_code, 200)
            self.assert_closed(socket, 1008)

    def test_expiration_is_rechecked_even_without_client_messages(self):
        with self.socket() as socket:
            self.receive(socket)
            with self.database.connection:
                self.database.connection.execute("UPDATE sessions SET expires_at=0")
            self.assert_closed(socket, 1008)

    def test_signing_in_again_revokes_the_previous_socket_session(self):
        with self.socket() as old:
            self.receive(old)
            response = self.client.post("/api/auth/login", data={"username": "realtime_owner", "password": "TestPassword123!"})
            self.assertEqual(response.status_code, 200)
            self.assert_closed(old, 1008)
        with self.socket() as current:
            self.assertEqual(self.receive(current)["type"], "connected")

    def test_history_saved_and_deleted_notifications_do_not_contain_report_content(self):
        with self.socket() as socket:
            self.subscribe(socket, ["history"])
            with patch.object(self.app.extensions["gemini"], "analyze", return_value=analysis()):
                response = self.client.post("/api/analyze", data={"photo": (photo(), "private-photo.jpg"),
                                                                 "consent": "true", "save_history": "true"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.receive(socket), {"type": "history.updated"})
            response = self.client.delete(f'/api/history/{response.json["history_id"]}')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.receive(socket), {"type": "history.updated"})

    def test_failed_analysis_does_not_emit_a_saved_history_event(self):
        with self.socket() as socket:
            self.subscribe(socket, ["history"])
            with patch.object(self.app.extensions["gemini"], "analyze", side_effect=ServiceError("Test unavailable", 503)):
                response = self.client.post("/api/analyze", data={"photo": (photo(), "test.jpg"),
                                                                 "consent": "true", "save_history": "true"})
            self.assertEqual(response.status_code, 503)
            with self.assertRaises(TimeoutError):
                socket.recv(timeout=0.15)

    def test_successful_training_mutations_emit_notifications(self):
        trainer = self.app.extensions["trainers"].for_user(self.user["id"])
        with self.socket() as socket:
            self.subscribe(socket, ["training"])
            with patch.object(trainer, "add", return_value={"id": "test-sample"}):
                response = self.client.post("/api/training/add", data={"photo": (photo(), "test.jpg"),
                    "storage_consent": "true", "label": "reference", "group": "p001"})
            self.assertEqual(response.status_code, 201)
            self.assertEqual(self.receive(socket), {"type": "training.updated"})
            with patch.object(trainer, "remove", return_value=None):
                self.assertEqual(self.client.post("/api/training/remove", data={"id": "test-sample"}).status_code, 200)
            self.assertEqual(self.receive(socket), {"type": "training.updated"})
            with patch.object(trainer, "train", return_value={"total": 0}):
                self.assertEqual(self.client.post("/api/training/train").status_code, 200)
            self.assertEqual(self.receive(socket), {"type": "training.updated"})

    def test_per_account_connection_limit_and_message_rate_limit(self):
        with ExitStack() as sockets:
            for _ in range(4):
                socket = sockets.enter_context(self.socket())
                self.assertEqual(self.receive(socket)["type"], "connected")
            excess = sockets.enter_context(self.socket())
            self.assert_closed(excess, 1013)
            for _ in range(60):
                socket.send('{"type":"ping"}')
                self.assertEqual(self.receive(socket), {"type": "pong"})
            socket.send('{"type":"ping"}')
            self.assert_closed(socket, 1008)

    def test_slow_consumer_queue_is_bounded_without_blocking_http_publish(self):
        peer = Peer(self.user["id"], "test-only-session", topics=frozenset(["history"]))
        with self.hub._lock:
            self.hub._peers.add(peer)
        for _ in range(100):
            self.hub.publish(self.user["id"], "history")
        self.assertEqual(peer.pending.qsize(), 32)
        self.assertEqual(peer.shutdown, (1013, "reconnect_required"))
        with self.hub._lock:
            self.hub._peers.discard(peer)

    def test_transport_can_be_disabled_and_stopped_without_changing_http_endpoints(self):
        self.hub.stop()
        self.hub.enabled = False
        self.hub.start()
        self.assertFalse(self.hub.running)
        self.assertFalse(self.client.get("/api/realtime").json["enabled"])
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("ws://", response.headers["Content-Security-Policy"])
        response.close()
