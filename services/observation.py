"""Evidence checks for appearance observations, never a hair-loss diagnosis."""
import base64
from copy import deepcopy
import io

import numpy as np
from PIL import Image

from .errors import ServiceError

POLICY_VERSION = "hair-evidence-v1"
CONFOUNDERS = {"lighting", "angle", "hairstyle", "blur", "occlusion"}
CAUSE_LIMITATION = "이마 높이나 M자 모양만으로 선천적 헤어라인과 탈모를 구분할 수 없어요. 이전 사진·변화 경과와 진료를 함께 확인해야 해요."
EVIDENCE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "image_type": {"type": "STRING", "enum": ["photo", "illustration", "other"]},
        "target_visibility": {"type": "STRING", "enum": ["clear", "limited", "not_visible"]},
        "forehead_skin": {"type": "STRING", "enum": ["visible", "not_visible", "unclear"]},
        "scalp_in_hair": {"type": "STRING", "enum": ["visible", "not_obvious", "unclear"]},
        "confounders": {"type": "ARRAY", "items": {"type": "STRING", "enum": sorted(CONFOUNDERS)}},
        "basis": {"type": "STRING"},
    },
    "required": ["image_type", "target_visibility", "forehead_skin", "scalp_in_hair", "confounders", "basis"],
}


def validate_evidence(value):
    if not isinstance(value, dict):
        raise ValueError("Invalid visual evidence")
    for key in ("image_type", "target_visibility", "forehead_skin", "scalp_in_hair"):
        if value.get(key) not in EVIDENCE_SCHEMA["properties"][key]["enum"]:
            raise ValueError("Invalid evidence category")
    factors = value.get("confounders")
    if not isinstance(factors, list) or len(factors) > 5 or any(not isinstance(item, str) or item not in CONFOUNDERS for item in factors):
        raise ValueError("Invalid confounders")
    basis = value.get("basis")
    if not isinstance(basis, str) or not 1 <= len(basis.strip()) <= 300:
        raise ValueError("Invalid evidence basis")
    result = {key: value[key] for key in EVIDENCE_SCHEMA["required"]}
    result["confounders"] = list(dict.fromkeys(factors))
    result["basis"] = basis.strip()
    return result


def ensure_observable_image(image):
    """Reject only effectively uniform inputs; this is not a clinical quality score."""
    pixels = np.asarray(image.convert("RGB").resize((64, 64)), dtype=np.float32)
    if float(pixels.std(axis=(0, 1)).max()) < 1.0:
        raise ServiceError("사진에 구분할 수 있는 형태가 거의 없어요. 머리와 모발 경계가 선명한 원본 사진을 올려 주세요.",
                           422, "photo_not_usable")


def observation_image(image, max_side=2048):
    """Keep hair boundaries at higher JPEG quality without EXIF or upscaling."""
    clean = image.convert("RGB").copy()
    clean.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    clean.save(output, format="JPEG", quality=95, subsampling=0)
    return {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(output.getvalue()).decode("ascii")}}


def calibrate_observation(value, focus="all"):
    """Only retain an exposure signal supported by consistent, visible evidence."""
    result = deepcopy(value)
    evidence = result.get("visual_evidence")
    status, note = "consistent", "이마 피부는 모발 영역 안의 두피 노출에 포함하지 않아요."
    if evidence is None:
        status = "legacy_evidence_missing"
        note = "이전 형식의 모델이 이마 피부와 모발 영역을 구분한 근거를 제공하지 않아 판단을 보류했어요."
    else:
        evidence = validate_evidence(evidence)
        result["visual_evidence"] = evidence
        if evidence["image_type"] != "photo":
            raise ServiceError("일러스트나 화면 자료로 모발 상태를 판단하지 않아요. 실제 머리 사진을 올려 주세요.", 422, "photo_not_usable")
        if evidence["target_visibility"] != "clear":
            status = "limited_view"
            note = "선택한 부위가 충분히 보이지 않아 판단을 보류했어요. 해당 부위가 가려지거나 잘리지 않은 사진이 필요해요."
        elif result["visible_signal"] != "unclear" and result["visible_signal"] != evidence["scalp_in_hair"]:
            status = "conflicting_evidence"
            note = "노출 표시와 모발 영역의 관찰 근거가 서로 일치하지 않아 판단을 보류했어요. 이마 피부만 보이는 것은 탈모 근거가 아니에요."
    if status != "consistent":
        result["visible_signal"] = "unclear"
        result["summary"] = note
        result["limitations"] = [note, *result["limitations"]][:5]
    if focus in {"all", "hairline"} and CAUSE_LIMITATION not in result["limitations"]:
        result["limitations"] = [CAUSE_LIMITATION, *result["limitations"]][:5]
    result["quality_review"] = {"version": POLICY_VERSION, "status": status,
                                "cause_assessable": False, "message": note}
    return result
