"""Account-scoped datasets, cancellable GPU jobs, and private LoRA inference."""
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
import uuid
import zipfile

from .errors import ServiceError
from .gemini import validate_analysis
from .observation import observation_image
from .photo_storage import AccountPhotoStore
from .vlm_data import BASE_MODEL, GPULock, VisionDataset, atomic_json, load_json, split_groups

PENDING = {"queued", "running"}


class VisionTraining:
    def __init__(self, root, directory=None, python=None, ollama=None, timeout=120, gpu_lock=None, database=None):
        self.root = Path(root).resolve()
        self.directory = Path(directory or self.root / "data" / "vision-training").resolve()
        self.python = Path(python or self.root / ".venv-vlm" / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))
        self.ollama = ollama
        self.timeout = timeout
        self.gpu_lock = Path(gpu_lock or self.root / ".cache" / "vlm" / "gpu.lock")
        self._lock = threading.RLock()
        self._processes = {}
        self._infer_busy = False
        self.database = database
        self._datasets = {}

    def _user(self, user_id):
        if type(user_id) is not int or user_id < 1:
            raise ServiceError("비전 모델 학습은 로그인 후 사용할 수 있어요.", 401, "login_required")
        path = (self.directory / "users" / str(user_id)).resolve()
        if not path.is_relative_to(self.directory):
            raise ServiceError("계정 학습 경로를 확인해 주세요.", 400, "invalid_training_path")
        return path

    def dataset(self, user_id):
        with self._lock:
            if user_id not in self._datasets:
                store = AccountPhotoStore(self.database, user_id, "vision_training") if self.database else None
                dataset = VisionDataset(self._user(user_id), photo_store=store)
                dataset.sync_database()
                self._datasets[user_id] = dataset
            return self._datasets[user_id]

    def _job(self, user_id, job_id):
        if not isinstance(job_id, str) or not re.fullmatch(r"[a-f0-9]{32}", job_id):
            raise ServiceError("학습 작업을 다시 선택해 주세요.", 400, "invalid_vision_job")
        path = (self._user(user_id) / "jobs" / job_id).resolve()
        if not path.is_relative_to(self._user(user_id)) or not path.is_dir():
            raise ServiceError("내 학습 작업을 찾지 못했어요.", 404, "vision_job_missing")
        return path

    def runtime(self):
        value = load_json(self.root / ".cache" / "vlm" / "runtime.json", {})
        ready = bool(self.python.is_file() and value.get("ready") is True)
        return {"ready": ready, "gpu": value.get("gpu", ""), "vram_gb": value.get("vram_gb"),
                "base_model": BASE_MODEL, "setup_command": "powershell -File scripts/setup_vlm.ps1"}

    def _require_runtime(self):
        if not self.runtime()["ready"]:
            raise ServiceError("학습용 GPU 환경을 먼저 설치해 주세요. scripts/setup_vlm.ps1로 준비할 수 있어요.", 503, "vision_runtime_missing")

    def _busy(self):
        return self._infer_busy or any(process.poll() is None for process, _ in self._processes.values())

    def _own_busy(self, user_id):
        item = self._processes.get(user_id)
        return bool(item and item[0].poll() is None)

    def save(self, user_id, image, group, focus, target, sample_id=None):
        with self._lock:
            if self._own_busy(user_id):
                raise ServiceError("학습이 끝나거나 취소한 뒤 예시를 수정해 주세요.", 429, "vision_busy")
            return self.dataset(user_id).save(image, group, focus, target, sample_id)

    def remove(self, user_id, sample_id):
        with self._lock:
            if self._own_busy(user_id):
                raise ServiceError("학습 중인 예시는 완료 후 수정해 주세요.", 429, "vision_busy")
            self.dataset(user_id).remove(sample_id)

    def _public_job(self, path):
        value = load_json(path / "status.json", {})
        return {key: value[key] for key in ("id", "state", "phase", "step", "steps", "loss", "created_at", "updated_at", "metadata", "error_code") if key in value}

    def active_job(self, user_id):
        value = load_json(self._user(user_id) / "active.json", {})
        job_id = value.get("job_id")
        if not job_id:
            return None
        try:
            path = self._job(user_id, job_id)
            if self._public_job(path).get("state") == "completed" and (path / "adapter" / "adapter_model.safetensors").is_file():
                return job_id
        except ServiceError:
            pass
        return None

    def status(self, user_id):
        with self._lock:
            dataset = self.dataset(user_id).readiness()
            jobs_path = self._user(user_id) / "jobs"
            paths = sorted((p for p in jobs_path.glob("*") if p.is_dir() and re.fullmatch(r"[a-f0-9]{32}", p.name)),
                           key=lambda p: p.stat().st_mtime, reverse=True)[:10]
            jobs = [self._public_job(path) for path in paths]
            runtime = self.runtime()
            return {**dataset, "runtime": runtime, "gpu_busy": self._busy(), "own_job_running": self._own_busy(user_id),
                    "jobs": jobs, "active_job": self.active_job(user_id),
                    "can_start": dataset["can_train"] and runtime["ready"] and not self._busy()}

    def _release_ollama(self):
        if self.ollama:
            self.ollama.release()

    def base_client(self):
        return GuardedOllama(self)

    def analyze_base(self, image, **context):
        with self._lock:
            if self._busy():
                raise ServiceError("비전 학습·테스트가 GPU를 사용 중이에요. 완료 후 다시 분석해 주세요.", 429, "vision_busy")
            self._infer_busy = True
        try:
            with GPULock(self.gpu_lock):
                return self.ollama.analyze(image, **context)
        finally:
            with self._lock:
                self._infer_busy = False

    def _watch(self, user_id, job_id, process):
        code = process.wait()
        with self._lock:
            path = self._job(user_id, job_id)
            status = load_json(path / "status.json", {})
            if status.get("state") in PENDING:
                cancelled = (path / "cancel.flag").exists()
                status.update(state="cancelled" if cancelled else "failed", updated_at=time.time(),
                              phase="학습을 취소했어요." if cancelled else "학습 프로세스가 종료됐어요. 학습 환경을 확인해 주세요.",
                              error_code="vision_process_stopped" if code else "vision_output_missing")
                atomic_json(path / "status.json", status)
            if self._processes.get(user_id, (None,))[0] is process:
                self._processes.pop(user_id, None)

    def start(self, user_id, steps):
        if type(steps) is not int or not 1 <= steps <= 200:
            raise ServiceError("학습 스텝은 1~200 사이로 선택해 주세요.", 400, "invalid_vision_steps")
        self._require_runtime()
        with self._lock:
            if self._busy():
                raise ServiceError("다른 비전 학습·테스트가 GPU를 사용 중이에요.", 429, "vision_busy")
            data = self.dataset(user_id)
            ready = data.readiness()
            if not ready["can_train"]:
                raise ServiceError(ready["reason"], 400, "vision_data_needed")
            train, validation = split_groups(ready["samples"])
            job_id = uuid.uuid4().hex
            path = self._user(user_id) / "jobs" / job_id
            (path / "images").mkdir(parents=True)
            for row in ready["samples"]:
                shutil.copyfile(data.photo(row["id"]), path / "images" / (row["id"] + ".jpg"))
            atomic_json(path / "snapshot.json", {"train": train, "validation": validation, "signature": ready["signature"], "steps": steps})
            atomic_json(path / "status.json", {"id": job_id, "state": "queued", "phase": "학습 환경을 준비하고 있어요.",
                                               "step": 0, "steps": steps, "created_at": time.time(), "updated_at": time.time()})
            try:
                self._release_ollama()
                process = subprocess.Popen([str(self.python), str(self.root / "scripts" / "vlm_worker.py"), "train", "--job", str(path)],
                    cwd=self.root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except (OSError, ServiceError):
                atomic_json(path / "status.json", {"id": job_id, "state": "failed", "phase": "학습 프로세스를 시작하지 못했어요.",
                                                   "created_at": time.time(), "error_code": "vision_start_failed"})
                raise ServiceError("학습 프로세스를 시작하지 못했어요. GPU 환경을 확인해 주세요.", 503, "vision_start_failed") from None
            self._processes[user_id] = (process, job_id)
            threading.Thread(target=self._watch, args=(user_id, job_id, process), daemon=True).start()
            return self._public_job(path)

    def cancel(self, user_id, job_id):
        with self._lock:
            path = self._job(user_id, job_id)
            if self._public_job(path).get("state") not in PENDING:
                return self._public_job(path)
            (path / "cancel.flag").touch()
            item = self._processes.get(user_id)
            if item and item[1] == job_id and item[0].poll() is None:
                item[0].terminate()
            return self._public_job(path)

    def activate(self, user_id, job_id):
        if job_id:
            path = self._job(user_id, job_id)
            if self._public_job(path).get("state") != "completed" or not (path / "adapter" / "adapter_model.safetensors").is_file():
                raise ServiceError("완료된 LoRA 모델만 적용할 수 있어요.", 400, "vision_model_not_ready")
        atomic_json(self._user(user_id) / "active.json", {"job_id": job_id or None})
        return {"active_job": self.active_job(user_id)}

    def client(self, user_id, job_id=None):
        job_id = job_id or self.active_job(user_id)
        if not job_id:
            return None
        path = self._job(user_id, job_id)
        if self._public_job(path).get("state") != "completed":
            raise ServiceError("완료된 학습 모델을 선택해 주세요.", 400, "vision_model_not_ready")
        return AdapterClient(self, user_id, job_id)

    def infer(self, user_id, job_id, image, **context):
        self._require_runtime()
        path = self._job(user_id, job_id)
        if self._public_job(path).get("state") != "completed":
            raise ServiceError("학습을 완료한 뒤 테스트해 주세요.", 400, "vision_model_not_ready")
        with self._lock:
            if self._busy():
                raise ServiceError("비전 학습·테스트가 GPU를 사용 중이에요. 완료 후 다시 시도해 주세요.", 429, "vision_busy")
            self._infer_busy = True
        try:
            self._release_ollama()
            payload = {"image": observation_image(image, max_side=1280)["inlineData"]["data"], **context}
            try:
                process = subprocess.run([str(self.python), str(self.root / "scripts" / "vlm_worker.py"), "infer", "--adapter", str(path / "adapter")],
                    input=json.dumps(payload, ensure_ascii=True), capture_output=True, text=True, encoding="utf-8", errors="replace",
                    timeout=self.timeout, cwd=self.root, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except subprocess.TimeoutExpired:
                raise ServiceError("학습 모델의 응답 시간이 길어졌어요. 다시 시도해 주세요.", 504, "vision_inference_timeout") from None
            except OSError:
                raise ServiceError("학습 모델을 실행하지 못했어요. GPU 환경을 확인해 주세요.", 503, "vision_runtime_missing") from None
            try:
                line = next(line for line in process.stdout.splitlines() if line.startswith("HAIRLINE_RESULT "))
                value = json.loads(line[len("HAIRLINE_RESULT "):])
                if not isinstance(value, dict):
                    raise ValueError("Invalid worker response")
                if isinstance(value.get("error"), dict):
                    error = value["error"]
                    raise ServiceError(error["message"], error["status"], error["code"])
                result = validate_analysis(value["result"])
                if not result["image_usable"]:
                    raise ServiceError("사진에서 모발 상태를 관찰하기 어려워요. 선명한 사진을 준비해 주세요.", 422, "photo_not_usable")
                return result
            except (StopIteration, ValueError, KeyError, TypeError):
                raise ServiceError("학습 모델의 응답 형식을 검증하지 못했어요. 정답 예시와 모델을 확인해 주세요.", 502, "vision_invalid_output") from None
        finally:
            with self._lock:
                self._infer_busy = False

    def export(self, user_id, job_id):
        path = self._job(user_id, job_id)
        if self._public_job(path).get("state") != "completed":
            raise ServiceError("완료된 모델만 내려받을 수 있어요.", 400, "vision_model_not_ready")
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name in ("adapter/adapter_model.safetensors", "adapter/adapter_config.json", "metadata.json"):
                file = (path / name).resolve()
                if not file.is_relative_to(path) or not file.is_file() or file.stat().st_size > 100 * 1024 * 1024:
                    raise ServiceError("모델 파일을 확인해 주세요.", 503, "vision_artifact_invalid")
                archive.write(file, arcname=name)
        stream.seek(0)
        return stream


class AdapterClient:
    provider = "local_adapter"

    def __init__(self, manager, user_id, job_id):
        self.manager, self.user_id, self.job_id = manager, user_id, job_id
        self.model = "hairline-qlora-" + job_id[:8]

    def analyze(self, image, **context):
        return self.manager.infer(self.user_id, self.job_id, image, **context)


class GuardedOllama:
    provider = "ollama"

    def __init__(self, manager):
        self.manager = manager
        self.model = manager.ollama.model

    def analyze(self, image, **context):
        return self.manager.analyze_base(image, **context)
