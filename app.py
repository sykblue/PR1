"""Local server with accounts, opt-in report history and per-account training."""
import os
import json
import sqlite3
import time
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
from dotenv import load_dotenv
from flask import Flask, g, jsonify, render_template, request, send_file
from werkzeug.exceptions import HTTPException

from services.errors import ServiceError
from services.gemini import GeminiClient, PROMPT_VERSION, ANALYSIS_FOCUS
from services.ollama import OllamaClient
from services.analysis import AnalysisService
from services.images import data_url, read_photo, image_bytes
from services.inpainting import LocalInpainting
from services.ocr import LocalOCR
from services.observation import ensure_observable_image
from services.vision import HairVision, edit_mask, overlay_mask, simulate
from services.accounts import AccountTrainers, init_accounts, require_user, secret_key
from services.database import Database
from services.training import MIN_PER_LABEL, MIN_GROUPS_PER_LABEL, MIN_GROUPS_TOTAL
from services.realtime import RealtimeHub
from services.clinics import NearbyClinics
from services.vision_training import VisionTraining
from services.scalp_classifier import ScalpClassifier

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".cache" / "matplotlib"))


def create_app(overrides=None):
    load_dotenv(ROOT / ".env")
    app = Flask(__name__, static_folder="static")
    http_port = int(os.getenv("PORT", "8000"))
    app.config.update(MAX_CONTENT_LENGTH=11 * 1024 * 1024,
                      HTTP_PORT=http_port,
                      ENABLE_WEBSOCKET=os.getenv("ENABLE_WEBSOCKET", "true").lower() == "true",
                      WEBSOCKET_PORT=int(os.getenv("WEBSOCKET_PORT", str(http_port + 1))),
                      GEMINI_API_KEY=os.getenv("GEMINI_API_KEY", ""),
                      GEMINI_ANALYSIS_MODEL=os.getenv("GEMINI_ANALYSIS_MODEL", "gemini-2.5-flash"),
                      GEMINI_API_TIMEOUT=int(os.getenv("GEMINI_API_TIMEOUT", "60")),
                      ENABLE_OLLAMA_FALLBACK=os.getenv("ENABLE_OLLAMA_FALLBACK", "true").lower() == "true",
                      OLLAMA_BASE_URL=os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
                      OLLAMA_ANALYSIS_MODEL=os.getenv("OLLAMA_ANALYSIS_MODEL", "qwen2.5vl:3b"),
                      OLLAMA_API_TIMEOUT=int(os.getenv("OLLAMA_API_TIMEOUT", "120")),
                      HAIR_MODEL_PATH=os.getenv("HAIR_MODEL_PATH", "models/hair_segmenter.tflite"),
                      ENABLE_PAID_IMAGE_GENERATION=os.getenv("ENABLE_PAID_IMAGE_GENERATION", "false").lower() == "true",
                      GEMINI_IMAGE_MODEL=os.getenv("GEMINI_IMAGE_MODEL", ""),
                      ENABLE_SD_INPAINTING=os.getenv("ENABLE_SD_INPAINTING", "false").lower() == "true",
                      SD_MODEL_PATH=os.getenv("SD_MODEL_PATH", ""),
                      SCALP_MODEL_DIR=os.getenv("SCALP_MODEL_DIR", "models/scalp-classifier"),
                      TRAINING_DIR=str(ROOT / "data" / "training"),
                      VISION_TRAINING_DIR=str(ROOT / "data" / "vision-training"),
                      DATABASE_PATH=os.getenv("DATABASE_PATH", str(ROOT / "data" / "hairline.sqlite3")),
                      SECRET_KEY=os.getenv("APP_SECRET_KEY") or None)
    if overrides:
        app.config.update(overrides)
    if not app.config["SECRET_KEY"]:
        app.config["SECRET_KEY"] = secret_key(ROOT / "data" / ".session_secret")
    database_path = app.config["DATABASE_PATH"]
    if database_path != ":memory:" and not Path(database_path).is_absolute():
        database_path = str(ROOT / database_path)
    database = Database(database_path)
    vision = HairVision(ROOT / app.config["HAIR_MODEL_PATH"])
    gemini = GeminiClient(app.config["GEMINI_API_KEY"], app.config["GEMINI_ANALYSIS_MODEL"], app.config["GEMINI_API_TIMEOUT"])
    ollama = OllamaClient(app.config["OLLAMA_BASE_URL"], app.config["OLLAMA_ANALYSIS_MODEL"], app.config["OLLAMA_API_TIMEOUT"])
    scalp = ScalpClassifier(ROOT / app.config["SCALP_MODEL_DIR"])
    analysis = AnalysisService(gemini, ollama, app.config["ENABLE_OLLAMA_FALLBACK"], scalp=scalp)
    sd_path = app.config["SD_MODEL_PATH"]
    painter = LocalInpainting(app.config["ENABLE_SD_INPAINTING"], str(ROOT / sd_path) if sd_path else "")
    ocr = LocalOCR(ROOT / "models" / "ocr", ROOT / ".cache")
    trainers = AccountTrainers(app.config["TRAINING_DIR"], database=database)
    vision_training = VisionTraining(ROOT, app.config["VISION_TRAINING_DIR"], ollama=ollama, timeout=ollama.timeout,
                                     gpu_lock=app.config.get("VISION_GPU_LOCK_PATH"), database=database)
    # Existing account photos were already saved with storage consent. Add SQL
    # copies without changing their manifests, files, labels or model weights.
    for user_id in database.user_ids():
        if (Path(app.config["TRAINING_DIR"]) / "users" / str(user_id) / "dataset.json").is_file():
            trainers.for_user(user_id)
        if (vision_training._user(user_id) / "dataset.json").is_file():
            vision_training.dataset(user_id)
    app.extensions.update(hair_vision=vision, gemini=gemini, ollama=ollama, analysis=analysis, painter=painter, ocr=ocr, scalp_classifier=scalp,
                          trainers=trainers, database=database, nearby_clinics=NearbyClinics(), vision_training=vision_training)

    def user_trainer():
        return trainers.for_user(require_user()["id"])

    @app.before_request
    def local_requests_only():
        if request.host.split(":")[0] not in {"127.0.0.1", "localhost"}:
            raise ServiceError("로컬 주소로 접속해 주세요.", 403, "invalid_host")
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            origin = request.headers.get("Origin")
            if request.headers.get("Sec-Fetch-Site") == "cross-site" or (origin and urlsplit(origin).netloc != request.host):
                raise ServiceError("같은 로컬 사이트에서 요청해 주세요.", 403, "invalid_origin")

    init_accounts(app, database)
    realtime = RealtimeHub(app, database)
    app.extensions["realtime"] = realtime

    @app.after_request
    def private_response(response):
        websocket_sources = (f" ws://127.0.0.1:{realtime.port} ws://localhost:{realtime.port}"
                             if realtime.enabled else "")
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(self), microphone=()"
        response.headers["Content-Security-Policy"] = ("default-src 'self'; img-src 'self' data: blob:; "
            f"style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'{websocket_sources}; "
            "font-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
        return response

    @app.errorhandler(ServiceError)
    def service_error(error):
        return jsonify(error={"message": error.message, "code": error.code}), error.status

    @app.errorhandler(HTTPException)
    def http_error(error):
        message = "사진은 10MB 이하로 올려 주세요." if error.code == 413 else "요청 주소와 입력을 확인해 주세요."
        return jsonify(error={"message": message, "code": "http_error"}), error.code

    @app.errorhandler(Exception)
    def unexpected_error(error):
        # No exception string, request body, filename or photo data in public responses/logs.
        app.logger.error("Request failed: %s", type(error).__name__)
        return jsonify(error={"message": "처리를 완료하지 못했어요. 잠시 후 다시 시도해 주세요.", "code": "internal_error"}), 500

    @app.get("/")
    def index():
        return send_file(ROOT / "index.html")

    @app.get("/analysis")
    def analysis_page():
        return send_file(ROOT / "analysis.html")

    @app.get("/simulation")
    def simulation_page():
        return send_file(ROOT / "simulation.html")

    @app.get("/guide")
    def usage_guide():
        return send_file(ROOT / "guide.html")

    @app.get("/training")
    def training_page():
        return send_file(ROOT / "training.html")

    @app.get("/training/vision")
    def vision_training_page():
        return send_file(ROOT / "vision-training.html")

    @app.get("/training-guide")
    def training_guide():
        return render_template("training-guide.html", minimum_per_label=MIN_PER_LABEL,
                               minimum_groups_per_label=MIN_GROUPS_PER_LABEL, minimum_groups_total=MIN_GROUPS_TOTAL)

    @app.get("/api/status")
    def status():
        training = user_trainer().status() if g.user else {"model_ready": False, "total": 0}
        return jsonify(analysis_ready=bool(gemini.api_key), analysis_model=gemini.model,
                       ollama_fallback_enabled=analysis.fallback_enabled, ollama_model=ollama.model,
                       scalp_reference=scalp.status(),
                       analysis_timeout_ms=(gemini.timeout + (ollama.timeout if analysis.fallback_enabled else 0) + 20) * 1000,
                       segmentation_ready=vision.model_path.is_file(), opencv_ready=True,
                       sd_configured=painter.configured,
                       paid_image_ready=bool(app.config["ENABLE_PAID_IMAGE_GENERATION"] and
                                             app.config["GEMINI_IMAGE_MODEL"] and gemini.api_key),
                       ocr_ready=ocr.ready, ocr_packages_installed=ocr.packages_available,
                       local_model_ready=training["model_ready"], training_samples=training["total"],
                       stores_photos=True, stores_analysis_photos=True, analysis_photo_storage_opt_in=True,
                       photo_storage="sqlite", training_storage_opt_in=True,
                       login_available=True, history_storage_opt_in=True)

    @app.post("/api/clinics/nearby")
    def nearby_clinics():
        return jsonify(app.extensions["nearby_clinics"].search(request.get_json(silent=True)))

    @app.get("/api/training/status")
    def training_status():
        return jsonify(user_trainer().status())

    @app.get("/api/training/vision/status")
    def vision_training_status():
        return jsonify(vision_training.status(require_user()["id"]))

    @app.get("/api/training/vision/photo/<sample_id>")
    def vision_training_photo(sample_id):
        return send_file(vision_training.dataset(require_user()["id"]).photo(sample_id), mimetype="image/jpeg")

    @app.post("/api/training/vision/save")
    def vision_training_save():
        user = require_user()
        if request.form.get("storage_consent") != "true":
            raise ServiceError("사용 권한이 있는 사진과 정답 설명의 학습용 저장에 동의해 주세요.", 400, "training_storage_consent_required")
        raw = request.form.get("target", "")
        try:
            if len(raw) > 16000:
                raise ValueError("Too long")
            target = json.loads(raw)
        except (ValueError, TypeError):
            raise ServiceError("정답 설명 형식을 확인해 주세요.", 400, "invalid_vision_target") from None
        image = read_photo(request.files.get("photo"))
        sample = vision_training.save(user["id"], image, request.form.get("group", ""), request.form.get("focus", "all"), target,
                                      request.form.get("id") or None)
        return jsonify(sample=sample), 201

    @app.post("/api/training/vision/remove")
    def vision_training_remove():
        vision_training.remove(require_user()["id"], request.form.get("id", ""))
        return jsonify(removed=True)

    @app.post("/api/training/vision/start")
    def vision_training_start():
        user = require_user()
        try:
            steps = int(request.form.get("steps", "20"))
        except ValueError:
            raise ServiceError("학습 스텝을 선택해 주세요.", 400, "invalid_vision_steps") from None
        return jsonify(vision_training.start(user["id"], steps)), 202

    @app.post("/api/training/vision/cancel")
    def vision_training_cancel():
        return jsonify(vision_training.cancel(require_user()["id"], request.form.get("job_id", "")))

    @app.post("/api/training/vision/activate")
    def vision_training_activate():
        return jsonify(vision_training.activate(require_user()["id"], request.form.get("job_id") or None))

    @app.get("/api/training/vision/export/<job_id>")
    def vision_training_export(job_id):
        stream = vision_training.export(require_user()["id"], job_id)
        return send_file(stream, mimetype="application/zip", as_attachment=True, download_name=f"hairline-lora-{job_id[:8]}.zip")

    @app.post("/api/training/vision/test")
    def vision_training_test():
        user = require_user()
        image = read_photo(request.files.get("photo"))
        started = time.perf_counter()
        client = vision_training.client(user["id"], request.form.get("job_id"))
        if client is None:
            raise ServiceError("완료된 학습 모델을 선택해 주세요.", 400, "vision_model_not_ready")
        focus = request.form.get("focus", "all")
        if focus not in ANALYSIS_FOCUS:
            raise ServiceError("관찰할 부위를 선택해 주세요.", 400, "invalid_analysis_focus")
        result = client.analyze(image, focus=focus)
        return jsonify(result=result, provider=client.provider, model=client.model, focus=focus,
                       elapsed_ms=round((time.perf_counter() - started) * 1000))

    @app.get("/api/realtime")
    def realtime_configuration():
        require_user()
        return jsonify(enabled=realtime.running, port=realtime.port, path="/ws")

    @app.post("/api/training/add")
    def add_training_sample():
        if request.form.get("storage_consent") != "true":
            raise ServiceError("학습용 사진을 이 컴퓨터에 저장하는 데 동의해 주세요.", 400, "training_storage_consent_required")
        image = read_photo(request.files.get("photo"))
        trainer = user_trainer()
        sample = trainer.add(image, request.form.get("label", ""), request.form.get("group", ""),
                             source=request.form.get("source", "upload"))
        status = trainer.status()
        auto_training = "not_requested"
        training_error = None
        if request.form.get("train_if_ready") == "true":
            auto_training = "needs_data"
            if status["can_train"]:
                try:
                    status = trainer.train()
                    auto_training = "completed"
                except Exception as error:
                    # Registration has already succeeded; keep that result even
                    # if fitting fails, so retrying does not duplicate a sample.
                    auto_training = "failed"
                    app.logger.error("Automatic local training failed: %s", type(error).__name__)
                    training_error = "사진은 저장했지만 분류기 학습을 완료하지 못했어요. 로컬 학습 페이지에서 다시 시도해 주세요."
        realtime.publish(g.user["id"], "training")
        return jsonify(sample=sample, status=status, auto_training=auto_training,
                       training_error=training_error), 201

    @app.post("/api/training/remove")
    def remove_training_sample():
        trainer = user_trainer()
        trainer.remove(request.form.get("id", ""))
        realtime.publish(g.user["id"], "training")
        return jsonify(trainer.status())

    @app.post("/api/training/train")
    def train_local_model():
        started = time.perf_counter()
        result = user_trainer().train()
        realtime.publish(g.user["id"], "training")
        return jsonify(**result, elapsed_ms=round((time.perf_counter() - started) * 1000))

    @app.post("/api/classify")
    def classify_photo():
        image = read_photo(request.files.get("photo"))
        started = time.perf_counter()
        result = user_trainer().predict(image)
        return jsonify(result=result, elapsed_ms=round((time.perf_counter() - started) * 1000))

    @app.post("/api/ocr")
    def recognize_text():
        # Preserve more detail for small document text; all other image checks
        # and metadata removal are shared with the existing upload pipeline.
        image = read_photo(request.files.get("photo"), max_side=2560)
        started = time.perf_counter()
        result = ocr.recognize(image)
        return jsonify(**result, engine="PaddleOCR", language="한국어·영어",
                       elapsed_ms=round((time.perf_counter() - started) * 1000))

    @app.post("/api/segment")
    def segment():
        started = time.perf_counter()
        image = read_photo(request.files.get("photo"))
        mask = vision.segment(image)
        return jsonify(overlay=data_url(overlay_mask(image, mask)),
                       hair_area_percent=round(np.count_nonzero(mask) / mask.size * 100, 1),
                       elapsed_ms=round((time.perf_counter() - started) * 1000))

    @app.post("/api/analyze")
    def analyze():
        if request.form.get("consent") != "true":
            raise ServiceError("Google Gemini로 사진을 전송하는 데 동의해 주세요.", 400, "consent_required")
        save_history = request.form.get("save_history") == "true"
        save_photo = request.form.get("save_photo") == "true"
        if save_history or save_photo:
            require_user()
        if save_photo and not save_history:
            raise ServiceError("사진을 함께 저장하려면 리포트 저장도 선택해 주세요.", 400, "photo_history_required")
        focus = request.form.get("focus", "all")
        if focus not in ANALYSIS_FOCUS:
            raise ServiceError("관찰할 부위를 다시 선택해 주세요.", 400, "invalid_analysis_focus")
        image = read_photo(request.files.get("photo"), max_side=2048)
        ensure_observable_image(image)
        started = time.perf_counter()
        ocr_text = request.form.get("ocr_text", "").strip()
        if ocr_text and request.form.get("ocr_text_consent") != "true":
            raise ServiceError("OCR 보조 텍스트를 Google Gemini로 함께 전송하는 데 동의해 주세요.", 400, "ocr_context_consent_required")
        if len(ocr_text) > 6000:
            raise ServiceError("OCR 보조 텍스트는 6,000자 이하로 줄여 주세요.")
        local_result = user_trainer().predict(image) if request.form.get("share_local_result") == "true" else None
        local_client = vision_training.client(g.user["id"]) if g.user else None
        if local_client is None:
            local_client = vision_training.base_client()
        outcome = analysis.analyze(image, local_client=local_client, ocr_text=ocr_text, local_result=local_result, focus=focus,
                                   scalp_macro=request.form.get("scalp_macro") == "true")
        report = dict(**outcome, prompt_version=PROMPT_VERSION, focus=focus,
                      supplemental={"ocr_characters": len(ocr_text), "local_result": local_result},
                      elapsed_ms=round((time.perf_counter() - started) * 1000))
        if save_history:
            try:
                if save_photo:
                    report["history_id"] = database.save_report(g.user["id"], report, photo=image_bytes(image, "JPEG"))
                    report["photo"] = database.report_photo(g.user["id"], report["history_id"])
                else:
                    report["history_id"] = database.save_report(g.user["id"], report)
                realtime.publish(g.user["id"], "history")
            except (sqlite3.Error, ValueError, OSError):
                report["history_error"] = "분석은 완료했지만 기록을 저장하지 못했어요. 리포트를 파일로 저장해 주세요."
        return jsonify(report)

    @app.post("/api/simulate")
    def preview():
        image = read_photo(request.files.get("photo"))
        provider = request.form.get("provider", "opencv")
        scenario = request.form.get("scenario", "hairline")
        if provider not in {"opencv", "sd", "gemini"} or scenario not in {"hairline", "crown", "density"}:
            raise ServiceError("지원하지 않는 미리보기 설정이에요.")
        try:
            strength = int(request.form.get("strength", "35"))
            if not 1 <= strength <= 100:
                raise ValueError
        except ValueError:
            raise ServiceError("변형 강도는 1~100 사이로 선택해 주세요.") from None
        if provider == "gemini":
            if not app.config["ENABLE_PAID_IMAGE_GENERATION"] or not app.config["GEMINI_IMAGE_MODEL"]:
                raise ServiceError("유료 이미지 생성은 꺼져 있어요. 필요한 경우 .env에서 별도로 설정해 주세요.", 503, "paid_disabled")
            if request.form.get("paid_consent") != "true" or request.form.get("consent") != "true":
                raise ServiceError("사진 전송과 유료 호출에 모두 동의해 주세요.", 400, "paid_consent_required")
        started = time.perf_counter()
        if provider == "gemini":
            edited = gemini.generate(image, app.config["GEMINI_IMAGE_MODEL"], scenario, strength)
        else:
            mask = vision.segment(image)
            if provider == "sd":
                edited = painter.generate(image, edit_mask(mask, scenario, strength), scenario)
            else:
                edited, _ = simulate(image, mask, scenario, strength)
        return jsonify(image=data_url(edited), provider=provider,
                       elapsed_ms=round((time.perf_counter() - started) * 1000),
                       notice="가상의 외형 편집 이미지예요. 실제 탈모 진행이나 치료 결과를 예측하지 않아요.")

    return app


if __name__ == "__main__":
    from waitress import serve
    application = create_app()
    port = application.config["HTTP_PORT"]
    realtime = application.extensions["realtime"].start()
    print(f"Hairline Lab: http://127.0.0.1:{port}", flush=True)
    if realtime.running:
        print(f"WebSocket: ws://127.0.0.1:{realtime.port}/ws", flush=True)
    try:
        serve(application, host="127.0.0.1", port=port, threads=4)
    finally:
        realtime.stop()
