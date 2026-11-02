import threading
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from .errors import ServiceError


class HairVision:
    def __init__(self, model_path):
        self.model_path = Path(model_path)
        self._segmenter = None
        self._lock = threading.Lock()

    def segment(self, image):
        if not self.model_path.is_file():
            raise ServiceError("모발 영역 모델이 없어요. 서버에서 setup_model.py를 실행해 주세요.",
                               503, "model_missing")
        try:
            import mediapipe as mp
            pixels = np.array(image, dtype=np.uint8)
            with self._lock:
                if self._segmenter is None:
                    options = mp.tasks.vision.ImageSegmenterOptions(
                        base_options=mp.tasks.BaseOptions(model_asset_path=str(self.model_path)),
                        running_mode=mp.tasks.vision.RunningMode.IMAGE,
                        output_category_mask=True,
                        output_confidence_masks=False,
                    )
                    self._segmenter = mp.tasks.vision.ImageSegmenter.create_from_options(options)
                result = self._segmenter.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=pixels))
                mask = (result.category_mask.numpy_view().copy().squeeze() == 1).astype(np.uint8) * 255
        except (ImportError, RuntimeError, ValueError, OSError):
            raise ServiceError("모발 영역 추출을 실행할 수 없어요. 모델과 MediaPipe 설치를 확인해 주세요.",
                               503, "segmentation_failed") from None
        if mask.shape != pixels.shape[:2]:
            mask = cv2.resize(mask, image.size, interpolation=cv2.INTER_NEAREST)
        # Keep the largest component, avoiding detached background predictions.
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        if count > 1:
            largest = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
            mask = (labels == largest).astype(np.uint8) * 255
        if np.count_nonzero(mask) < mask.size * 0.003:
            raise ServiceError("머리카락 영역을 충분히 찾지 못했어요. 머리 전체가 보이는 사진으로 다시 시도해 주세요.",
                               422, "hair_not_found")
        return mask


def overlay_mask(image, mask):
    pixels = np.array(image).astype(np.float32)
    alpha = (mask.astype(np.float32) / 255 * 0.34)[..., None]
    color = np.array([0, 102, 255], dtype=np.float32)
    mixed = (pixels * (1 - alpha) + color * alpha).astype(np.uint8)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(mixed, contours, -1, (0, 102, 255), 2)
    return Image.fromarray(mixed)


def edit_mask(mask, scenario, strength):
    """An illustrative edit region, deliberately not a clinical progression model."""
    if scenario not in {"hairline", "crown", "density"}:
        raise ServiceError("지원하지 않는 미리보기 유형이에요.")
    ys, xs = np.where(mask > 0)
    if not len(xs):
        raise ServiceError("편집할 모발 영역이 없어요.", 422)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    width, height = max(1, x1 - x0), max(1, y1 - y0)
    region = np.zeros_like(mask)
    amount = strength / 100.0
    if scenario == "hairline":
        for x in range(x0 + int(width * .15), x1 - int(width * .15)):
            col = np.flatnonzero(mask[y0:y0 + int(height * .78) + 1, x])
            if not len(col):
                continue
            edge = y0 + int(col[-1])
            lateral = abs((x - (x0 + x1) / 2) / (width / 2))
            depth = max(1, int(height * (.035 + .24 * amount) * (.3 + lateral)))
            region[max(y0, edge - depth):edge + 1, x] = 255
    else:
        center = (int((x0 + x1) / 2), int(y0 + height * .38))
        axes = (max(2, int(width * (.08 + amount * .2))),
                max(2, int(height * (.06 + amount * .16))))
        cv2.ellipse(region, center, axes, 0, 0, 360, 255, -1)
    region = cv2.bitwise_and(region, mask)
    if not np.any(region):
        raise ServiceError("이 사진에서 편집 영역을 만들기 어려워요. 다른 유형이나 사진을 선택해 주세요.", 422)
    return region


def simulate(image, mask, scenario, strength):
    region = edit_mask(mask, scenario, strength)
    source = np.array(image)
    ys, xs = np.where(mask > 0)
    x0, x1 = int(xs.min()), int(xs.max())
    # Sample a small, central non-hair patch below the detected hair boundary.
    cx = int((x0 + x1) / 2)
    col = np.flatnonzero(mask[:, cx])
    sy = min(source.shape[0] - 2, int(col[-1]) + 8) if len(col) else source.shape[0] // 2
    patch = source[sy:min(sy + 28, source.shape[0]), max(0, cx - 18):cx + 18]
    # Prefer skin-like, non-hair pixels in the central portrait area. Sampling
    # immediately below long hair can otherwise pick background or clothing.
    ycc = cv2.cvtColor(source, cv2.COLOR_RGB2YCrCb)
    candidates = ((ycc[:, :, 0] > 25) & (ycc[:, :, 1] >= 133) & (ycc[:, :, 1] <= 180)
                  & (ycc[:, :, 2] >= 77) & (ycc[:, :, 2] <= 135) & (mask == 0))
    central = np.zeros_like(mask, dtype=bool)
    h, w = mask.shape
    central[int(h * .2):int(h * .75), int(w * .25):int(w * .75)] = True
    samples = source[candidates & central]
    skin = np.median(samples if len(samples) >= 50 else patch.reshape(-1, 3), axis=0).astype(np.float32)
    filled = cv2.inpaint(source, region, 5, cv2.INPAINT_TELEA).astype(np.float32)
    # Local compositing is intentionally labelled as a simple approximation in the UI.
    filled = filled * .18 + skin.reshape(1, 1, 3) * .82
    feather = cv2.GaussianBlur(region.astype(np.float32) / 255, (15, 15), 0)[..., None]
    if scenario == "density":
        feather *= .25 + strength / 100 * .45
    mixed = source.astype(np.float32) * (1 - feather) + filled * feather
    return Image.fromarray(np.clip(mixed, 0, 255).astype(np.uint8)), region
