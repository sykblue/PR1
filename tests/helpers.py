from pathlib import Path


TEST_CONFIG = {"DATABASE_PATH": ":memory:", "SECRET_KEY": "test-only-session-secret-at-least-32-characters",
               "ENABLE_OLLAMA_FALLBACK": False,
               "TRAINING_DIR": str(Path(__file__).resolve().parent.parent / ".cache" / "test-training"),
               "VISION_TRAINING_DIR": str(Path(__file__).resolve().parent.parent / ".cache" / "test-vision" / "users"),
               "VISION_GPU_LOCK_PATH": str(Path(__file__).resolve().parent.parent / ".cache" / "test-vision" / "gpu.lock")}


def client_with_csrf(app, username=None):
    client = app.test_client()
    data = client.get("/api/auth/me").json
    client.environ_base["HTTP_X_CSRF_TOKEN"] = data["csrf_token"]
    if username:
        response = client.post("/api/auth/register", data={"username": username, "password": "TestPassword123!"})
        assert response.status_code == 201, response.json
        data = response.json
        client.environ_base["HTTP_X_CSRF_TOKEN"] = data["csrf_token"]
    return client, data["user"]


def sync_csrf(client, response):
    client.environ_base["HTTP_X_CSRF_TOKEN"] = response.json["csrf_token"]


def visual_evidence(**fields):
    return {"image_type": "photo", "target_visibility": "clear", "forehead_skin": "visible",
            "scalp_in_hair": "unclear", "confounders": [], "basis": "Mock visual evidence", **fields}
