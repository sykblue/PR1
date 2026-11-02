"""Local, CPU-only PaddleOCR. Uploaded images are never written to disk."""
import importlib.util
import logging
import math
import os
import threading
from pathlib import Path

import cv2
import numpy as np

from .errors import ServiceError

DETECTION_MODEL = "PP-OCRv5_mobile_det"
RECOGNITION_MODEL = "korean_PP-OCRv5_mobile_rec"
MODEL_FILES = ("inference.json", "inference.pdiparams", "inference.yml")


def normalize_results(results):
    """Return only bounded, JSON-safe text results from the OCR engine."""
    lines = []
    characters = 0
    truncated = False
    for result in results:
        texts = result.get("rec_texts", [])
        scores = result.get("rec_scores", [])
        polygons = result.get("rec_polys", [])
        if len(texts) != len(scores):
            raise ValueError("Mismatched recognition results")
        for index, raw in enumerate(texts):
            if not isinstance(raw, str):
                raise ValueError("Invalid recognition text")
            text = raw.strip()
            if not text:
                continue
            score = float(scores[index])
            if not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError("Invalid recognition score")
            if len(lines) >= 1000 or characters + len(text) > 100000:
                truncated = True
                break
            line = {"text": text, "confidence": round(score, 4)}
            if index < len(polygons):
                points = np.asarray(polygons[index], dtype=float)
                if points.shape == (4, 2) and np.isfinite(points).all():
                    line["box"] = points.round(1).tolist()
            lines.append(line)
            characters += len(text)
        if truncated:
            break
    return {"text": "\n".join(line["text"] for line in lines), "lines": lines,
            "line_count": len(lines), "truncated": truncated}


class LocalOCR:
    def __init__(self, model_dir, cache_dir):
        self.model_dir = Path(model_dir)
        self.cache_dir = Path(cache_dir)
        self._engine = None
        self._lock = threading.Lock()

    @property
    def packages_available(self):
        return bool(importlib.util.find_spec("paddleocr") and importlib.util.find_spec("paddle"))

    @property
    def models_available(self):
        return all((self.model_dir / name / filename).is_file()
                   for name in (DETECTION_MODEL, RECOGNITION_MODEL) for filename in MODEL_FILES)

    @property
    def ready(self):
        return self.packages_available and self.models_available

    def _create_engine(self):
        # Model assets are installed explicitly by setup_ocr.py. These locations
        # also keep configurable library caches inside this project. Paddle's
        # legacy dataset module may initialize an empty user cache on first import.
        os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(self.cache_dir / "paddlex"))
        os.environ.setdefault("PADDLE_HOME", str(self.cache_dir / "paddle"))
        os.environ.setdefault("HF_HOME", str(self.cache_dir / "huggingface"))
        os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
        from paddleocr import PaddleOCR
        return PaddleOCR(
            text_detection_model_name=DETECTION_MODEL,
            text_detection_model_dir=str(self.model_dir / DETECTION_MODEL),
            text_recognition_model_name=RECOGNITION_MODEL,
            text_recognition_model_dir=str(self.model_dir / RECOGNITION_MODEL),
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            device="cpu", enable_mkldnn=False, cpu_threads=4,
        )

    def recognize(self, image):
        if not self.packages_available:
            raise ServiceError("OCR 패키지가 없어요. requirements-ocr.txt를 설치한 뒤 서버를 다시 실행해 주세요.",
                               503, "ocr_not_installed")
        if not self.models_available:
            raise ServiceError("OCR 모델이 없어요. 서버에서 setup_ocr.py를 실행해 주세요.", 503, "ocr_models_missing")
        if not self._lock.acquire(blocking=False):
            raise ServiceError("다른 이미지의 글자를 읽고 있어요. 완료 후 다시 시도해 주세요.", 429, "ocr_busy")
        try:
            if self._engine is None:
                self._engine = self._create_engine()
            pixels = cv2.cvtColor(np.array(image, dtype=np.uint8), cv2.COLOR_RGB2BGR)
            # Threshold removes very weak detections; scores remain model scores,
            # not a claim that the extracted document is factually correct.
            results = self._engine.predict(pixels, text_rec_score_thresh=0.5)
            return normalize_results(results)
        except ServiceError:
            raise
        except Exception as error:
            logging.getLogger(__name__).error("Local OCR failed: %s", type(error).__name__)
            raise ServiceError("글자 추출을 완료하지 못했어요. 이미지와 OCR 설치 상태를 확인해 주세요.",
                               503, "ocr_failed") from None
        finally:
            self._lock.release()
