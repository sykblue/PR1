"""Small, local ONNX reference classifier for explicitly selected macro images."""
import hashlib
import json
from pathlib import Path
import re
import threading

import cv2
import numpy as np
from PIL import Image

from .errors import ServiceError
from .scalp_dataset import CLASSES

WARNING = "확대 두피 데이터셋 라벨의 실험용 분류예요. 질환 확률·의료 진단·일반 이마 사진의 판정으로 사용하지 않아요."


class ScalpClassifier:
    def __init__(self, directory):
        self.directory = Path(directory)
        self._lock = threading.Lock()
        self._network, self._digest = None, None

    def _metadata(self):
        path = self.directory / "metadata.json"
        try:
            if path.stat().st_size > 128 * 1024:
                return None
            value = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                return None
            if (value.get("version") != 1 or value.get("classes") != list(CLASSES)
                    or value.get("input_kind") != "scalp_macro" or value.get("input_size") != 224
                    or value.get("onnx_verified") is not True or value.get("experimental") is not True
                    or type(value.get("dataset_images")) is not int or value["dataset_images"] < 1
                    or not isinstance(value.get("model_sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", value["model_sha256"])
                    or value.get("mean") != [.485, .456, .406] or value.get("std") != [.229, .224, .225]
                    or not .1 <= float(value["temperature"]) <= 10
                    or not .5 <= float(value["confidence_threshold"]) <= 1
                    or not 0 < (self.directory / "model.onnx").stat().st_size <= 32 * 1024 * 1024):
                return None
            return value
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def status(self):
        metadata = self._metadata()
        return {"ready": metadata is not None, "input_kind": "scalp_macro", "experimental": True,
                "model": "MobileNetV3 Small", "dataset_images": metadata.get("dataset_images", 0) if metadata else 0}

    def predict(self, image):
        with self._lock:
            metadata = self._metadata()
            if metadata is None:
                raise ServiceError("확대 두피 참고 모델이 준비되지 않았어요. 해당 옵션을 해제하거나 모델 준비 후 다시 시도해 주세요.",
                                   503, "scalp_model_not_ready")
            try:
                digest = metadata["model_sha256"]
                if digest != self._digest:
                    path = self.directory / "model.onnx"
                    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                        raise ValueError("Model checksum mismatch")
                    self._network = cv2.dnn.readNetFromONNX(str(path))
                    self._network.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
                    self._network.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
                    self._digest = digest
                pixels = np.asarray(image.convert("RGB").resize((224, 224), Image.Resampling.BILINEAR), dtype=np.float32) / 255
                pixels = (pixels - np.asarray(metadata["mean"], dtype=np.float32)) / np.asarray(metadata["std"], dtype=np.float32)
                blob = np.ascontiguousarray(pixels.transpose(2, 0, 1)[None])
                self._network.setInput(blob)
                logits = np.asarray(self._network.forward(), dtype=np.float64).reshape(-1)
                if logits.shape != (4,) or not np.isfinite(logits).all():
                    raise ValueError("Invalid classifier output")
                logits /= metadata["temperature"]
                probabilities = np.exp(logits - logits.max())
                probabilities /= probabilities.sum()
                grade = int(probabilities.argmax())
                ranked = np.sort(probabilities)
                usable = probabilities[grade] >= metadata["confidence_threshold"] and ranked[-1] - ranked[-2] >= .1
            except (ValueError, KeyError, TypeError, OSError, cv2.error):
                raise ServiceError("확대 두피 참고 모델을 확인하지 못했어요. 해당 옵션을 해제하고 다시 시도해 주세요.",
                                   503, "scalp_model_invalid") from None
            return {"model": "scalp-mobilenet-v3-small-v1-" + self._digest[:12], "input_kind": "scalp_macro",
                    "status": "reference_only" if usable else "uncertain",
                    "dataset_grade": grade if usable else None, "dataset_label": CLASSES[grade] if usable else None,
                    "label_score": round(float(probabilities[grade]), 4), "dataset_images": metadata["dataset_images"],
                    "warning": WARNING}
