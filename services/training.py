"""User-labelled, experimental HOG + linear SVM. No pretrained diagnosis model."""
import hashlib
import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

from .errors import ServiceError
from .images import image_bytes

LABELS = {"reference": "기준 사진", "concern": "탈모 의심 사진 (사용자 라벨)"}
FEATURE_VERSION = "hog-hsv-v1"
MIN_PER_LABEL = 5
MIN_GROUPS_PER_LABEL = 2
MIN_GROUPS_TOTAL = 4
PHOTO_FOLDERS = {"upload": "photos", "analysis": "학습"}


def extract_features(image):
    # Fixed preprocessing is shared by fitting and prediction. This baseline
    # can learn framing/lighting as well as hair, so consistent crops matter.
    rgb = cv2.resize(np.array(image), (128, 128), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    hog = cv2.HOGDescriptor((128, 128), (32, 32), (16, 16), (16, 16), 9)
    edges = hog.compute(gray).flatten()
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    histogram = cv2.calcHist([hsv], [0, 1], None, [16, 4], [0, 180, 0, 256]).flatten()
    histogram /= max(float(histogram.sum()), 1)
    structure = cv2.resize(gray, (8, 8), interpolation=cv2.INTER_AREA).flatten() / 255.0
    return np.concatenate((edges, histogram, structure)).astype(np.float32)


def perceptual_hash(image):
    gray = cv2.cvtColor(cv2.resize(np.array(image), (32, 32)), cv2.COLOR_RGB2GRAY)
    values = cv2.dct(gray.astype(np.float32))[:8, :8].flatten()[1:]
    bits = values > np.median(values)
    return format(sum(int(bit) << index for index, bit in enumerate(bits)), "016x")


def dataset_signature(rows):
    identifiers = sorted((r["id"], r["label"], r["group"]) for r in rows)
    return hashlib.sha256(json.dumps(identifiers, separators=(",", ":")).encode()).hexdigest()


def grouped_split(rows):
    groups = sorted({r["group"] for r in rows})
    if len(groups) < MIN_GROUPS_TOTAL:
        raise ServiceError("학습·검증 분리를 위해 익명 그룹이 최소 4개 필요해요. 같은 사람의 사진은 같은 그룹에 넣어 주세요.")
    random = np.random.default_rng(42)
    count = max(2, int(np.ceil(len(groups) * .25)))
    # Pick the first label-feasible split, never select by validation accuracy.
    for _ in range(200):
        held_out = set(random.permutation(groups)[:count])
        train = [i for i, row in enumerate(rows) if row["group"] not in held_out]
        validation = [i for i, row in enumerate(rows) if row["group"] in held_out]
        if ({rows[i]["label"] for i in train} == set(LABELS)
                and {rows[i]["label"] for i in validation} == set(LABELS)):
            return train, validation
    raise ServiceError("두 라벨이 학습·검증 양쪽에 포함되도록 사람별 그룹을 더 추가해 주세요.")


class LocalTrainer:
    def __init__(self, directory, photo_store=None):
        self.directory = Path(directory).resolve()
        self.photo_store = photo_store
        self._lock = threading.RLock()

    def _photo_path(self, row):
        return self._path(PHOTO_FOLDERS[row.get("source", "upload")], row["id"] + ".jpg")

    def sync_database(self):
        if self.photo_store:
            with self._lock:
                self.photo_store.sync(self._rows(), self._path("dataset.json"), self._photo_path)

    def _path(self, *parts):
        path = self.directory.joinpath(*parts).resolve()
        if not path.is_relative_to(self.directory):
            raise ServiceError("학습 데이터 경로를 확인해 주세요.", 400, "invalid_training_path")
        return path

    def _rows(self):
        path = self._path("dataset.json")
        if not path.exists():
            return []
        try:
            if path.stat().st_size > 50 * 1024 * 1024:
                raise ValueError("Dataset too large")
            rows = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(rows, list) or len(rows) > 500:
                raise ValueError("Invalid dataset")
            for row in rows:
                if (not re.fullmatch(r"[a-f0-9]{64}", row["id"]) or row["label"] not in LABELS
                        or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", row["group"])
                        or row.get("source", "upload") not in PHOTO_FOLDERS
                        or not re.fullmatch(r"[a-f0-9]{16}", row["phash"])):
                    raise ValueError("Invalid record")
            return rows
        except (ValueError, KeyError, TypeError, OSError):
            raise ServiceError("학습 목록을 읽지 못했어요. data/training의 데이터를 확인해 주세요.", 503, "dataset_invalid") from None

    def _write_json(self, filename, value):
        self.directory.mkdir(parents=True, exist_ok=True)
        staged = self._path(filename + ".tmp")
        try:
            staged.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
            if filename == "dataset.json" and self.photo_store:
                self.photo_store.sync(value, self._path(filename), self._photo_path,
                                      lambda: staged.replace(self._path(filename)))
            else:
                staged.replace(self._path(filename))
        finally:
            staged.unlink(missing_ok=True)

    def _metadata(self):
        path = self._path("model.json")
        if not path.is_file():
            return None
        try:
            if path.stat().st_size > 2 * 1024 * 1024:
                raise ValueError
            value = json.loads(path.read_text(encoding="utf-8"))
            if value.get("feature_version") != FEATURE_VERSION:
                return None
            return value
        except (ValueError, OSError, AttributeError):
            return None

    def status(self):
        with self._lock:
            rows = self._rows()
            metadata = self._metadata()
            counts = {label: sum(row["label"] == label for row in rows) for label in LABELS}
            group_counts = {label: len({row["group"] for row in rows if row["label"] == label}) for label in LABELS}
            ready = bool(metadata and metadata.get("signature") == dataset_signature(rows)
                         and self._path("model.xml").is_file())
            return {"counts": counts, "group_counts": group_counts, "total": len(rows),
                    "model_ready": ready, "model_stale": bool(metadata and not ready),
                    "can_train": all(counts[k] >= MIN_PER_LABEL and group_counts[k] >= MIN_GROUPS_PER_LABEL for k in LABELS)
                                 and len({r["group"] for r in rows}) >= MIN_GROUPS_TOTAL,
                    "minimum_per_label": MIN_PER_LABEL,
                    "minimum_groups_per_label": MIN_GROUPS_PER_LABEL, "minimum_groups_total": MIN_GROUPS_TOTAL,
                    "total_groups": len({r["group"] for r in rows}),
                    "model": {k: metadata[k] for k in ("trained_at", "training_size", "validation_size",
                        "validation_accuracy", "majority_baseline", "confusion_matrix") if k in metadata} if metadata else None,
                    "samples": [{"id": r["id"], "label": r["label"], "group": r["group"],
                                 "source": r.get("source", "upload")} for r in rows]}

    def add(self, image, label, group, source="upload"):
        if source not in PHOTO_FOLDERS:
            raise ServiceError("학습 사진의 출처를 확인해 주세요.")
        if label not in LABELS:
            raise ServiceError("학습 라벨을 선택해 주세요.")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", group or ""):
            raise ServiceError("이름 대신 p001 같은 영문·숫자 익명 그룹 코드를 입력해 주세요. 같은 사람은 같은 코드를 사용해 주세요.")
        payload = image_bytes(image, "JPEG")
        identifier = hashlib.sha256(image.size[0].to_bytes(4, "big") + image.size[1].to_bytes(4, "big") + image.tobytes()).hexdigest()
        phash = perceptual_hash(image)
        features = extract_features(image)
        with self._lock:
            rows = self._rows()
            if len(rows) >= 500:
                raise ServiceError("학습 사진은 최대 500장까지 등록할 수 있어요.")
            for row in rows:
                if row["id"] == identifier or (int(row["phash"], 16) ^ int(phash, 16)).bit_count() <= 1:
                    raise ServiceError("같거나 매우 비슷한 사진이 이미 등록돼 있어요. 중복 사진은 제외해 주세요.", 409, "duplicate_training_photo")
            photo_folder = PHOTO_FOLDERS[source]
            self._path(photo_folder).mkdir(parents=True, exist_ok=True)
            path = self._path(photo_folder, identifier + ".jpg")
            path.write_bytes(payload)
            rows.append({"id": identifier, "label": label, "group": group, "phash": phash,
                         "features": features.round(6).tolist(), "source": source})
            try:
                self._write_json("dataset.json", rows)
            except Exception:
                path.unlink(missing_ok=True)
                raise
            return {"id": identifier, "label": label, "group": group, "source": source}

    def remove(self, identifier):
        if not re.fullmatch(r"[a-f0-9]{64}", identifier or ""):
            raise ServiceError("학습 사진 ID를 확인해 주세요.")
        with self._lock:
            rows = self._rows()
            retained = [r for r in rows if r["id"] != identifier]
            if len(rows) == len(retained):
                raise ServiceError("등록된 학습 사진을 찾지 못했어요.", 404)
            record = next(row for row in rows if row["id"] == identifier)
            photo_folder = PHOTO_FOLDERS[record.get("source", "upload")]
            photo = self._path(photo_folder, identifier + ".jpg")
            staged = self._path(photo_folder, identifier + ".delete")
            if photo.exists():
                photo.replace(staged)
            try:
                self._write_json("dataset.json", retained)
            except Exception:
                if staged.exists():
                    staged.replace(photo)
                raise
            staged.unlink(missing_ok=True)

    def train(self):
        if not self._lock.acquire(blocking=False):
            raise ServiceError("다른 학습 작업을 처리 중이에요.", 429, "training_busy")
        try:
            if not self.status()["can_train"]:
                raise ServiceError("각 라벨에 사진 5장 이상, 사람별 익명 그룹 2개 이상을 추가해 주세요. 전체 그룹은 최소 4개가 필요해요.")
            rows = self._rows()
            train, validation = grouped_split(rows)
            matrix = np.asarray([r["features"] for r in rows], dtype=np.float32)
            if matrix.ndim != 2 or matrix.shape[1] != 1892 or not np.isfinite(matrix).all():
                raise ServiceError("학습 특징을 읽지 못했어요. 데이터 형식을 확인해 주세요.", 503)
            labels = np.array([0 if r["label"] == "reference" else 1 for r in rows], dtype=np.int32)
            mean = matrix[train].mean(axis=0)
            scale = matrix[train].std(axis=0)
            scale[scale < 1e-6] = 1
            features = np.ascontiguousarray((matrix - mean) / scale, dtype=np.float32)
            svm = cv2.ml.SVM_create()
            svm.setType(cv2.ml.SVM_C_SVC)
            svm.setKernel(cv2.ml.SVM_LINEAR)
            svm.setC(1.0)
            svm.setTermCriteria((cv2.TERM_CRITERIA_MAX_ITER + cv2.TERM_CRITERIA_EPS, 2000, 1e-6))
            class_counts = np.bincount(labels[train], minlength=2)
            svm.setClassWeights((len(train) / (2 * class_counts)).astype(np.float32))
            if not svm.train(features[train], cv2.ml.ROW_SAMPLE, labels[train]):
                raise ServiceError("학습을 완료하지 못했어요.", 503)
            predicted = svm.predict(features[validation])[1].flatten().astype(int)
            truth = labels[validation]
            confusion = [[int(np.sum((truth == a) & (predicted == b))) for b in (0, 1)] for a in (0, 1)]
            majority = int(np.argmax(class_counts))
            self.directory.mkdir(parents=True, exist_ok=True)
            staged = self._path("model.tmp.xml")
            svm.save(str(staged))
            model_hash = hashlib.sha256(staged.read_bytes()).hexdigest()
            metadata = {"feature_version": FEATURE_VERSION, "signature": dataset_signature(rows),
                        "trained_at": datetime.now(timezone.utc).isoformat(), "mean": mean.tolist(), "scale": scale.tolist(),
                        "model_sha256": model_hash, "training_size": len(train), "validation_size": len(validation),
                        "validation_accuracy": round(float(np.mean(predicted == truth)), 4),
                        "majority_baseline": round(float(np.mean(truth == majority)), 4),
                        "confusion_matrix": confusion,
                        "training_groups": sorted({rows[i]["group"] for i in train}),
                        "validation_groups": sorted({rows[i]["group"] for i in validation})}
            staged.replace(self._path("model.xml"))
            self._write_json("model.json", metadata)
            return self.status()
        except cv2.error:
            raise ServiceError("로컬 분류기를 학습하지 못했어요. 데이터와 OpenCV 설치를 확인해 주세요.", 503) from None
        finally:
            self._lock.release()

    def predict(self, image):
        with self._lock:
            status = self.status()
            if not status["model_ready"]:
                raise ServiceError("로컬 분류기를 먼저 학습해 주세요. 데이터를 바꿨다면 다시 학습해야 해요.", 409, "local_model_not_ready")
            metadata = self._metadata()
            try:
                model_path = self._path("model.xml")
                if model_path.stat().st_size > 10 * 1024 * 1024 or hashlib.sha256(model_path.read_bytes()).hexdigest() != metadata["model_sha256"]:
                    raise ValueError
                mean = np.asarray(metadata["mean"], dtype=np.float32)
                scale = np.asarray(metadata["scale"], dtype=np.float32)
                features = extract_features(image)
                if mean.shape != features.shape or scale.shape != features.shape or not np.isfinite(mean).all() or not np.isfinite(scale).all() or np.any(scale <= 0):
                    raise ValueError
                svm = cv2.ml.SVM_load(str(model_path))
                prediction = int(svm.predict(np.ascontiguousarray(((features - mean) / scale)[None, :], dtype=np.float32))[1][0, 0])
                if prediction not in (0, 1):
                    raise ValueError
            except (ValueError, KeyError, TypeError, cv2.error, OSError):
                raise ServiceError("저장된 분류기를 읽지 못했어요. 다시 학습해 주세요.", 503, "local_model_invalid") from None
            label = "reference" if prediction == 0 else "concern"
            return {"label": label, "label_name": LABELS[label], "model": "HOG + linear SVM",
                    "training_size": metadata["training_size"], "validation_size": metadata["validation_size"],
                    "notice": "사용자가 붙인 라벨을 학습한 실험 분류예요. 탈모 확진이나 질환 확률이 아니에요."}
