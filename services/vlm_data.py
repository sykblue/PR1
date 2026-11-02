"""Small, account-scoped observation datasets shared by the web app and GPU worker."""
import hashlib
import json
from pathlib import Path
import random
import re
import uuid

from PIL import Image

from .errors import ServiceError
from .gemini import ANALYSIS_FOCUS, validate_analysis
from .images import image_bytes

BASE_MODEL = "Qwen/Qwen2.5-VL-3B-Instruct"
MIN_PER_STATE = 4
MIN_GROUPS = 4
MAX_SAMPLES = 200


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex[:8] + ".tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def load_json(path, default=None, maximum=4 * 1024 * 1024):
    path = Path(path)
    if not path.is_file():
        return default
    try:
        if path.stat().st_size > maximum:
            raise ValueError("Too large")
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        raise ServiceError("비전 학습 자료를 읽지 못했어요. 로컬 학습 폴더를 확인해 주세요.", 503, "vision_dataset_invalid") from None


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ServiceError("학습 사진을 다시 선택해 주세요.", 400, "invalid_vision_sample")
    return value


def validate_target(target):
    try:
        target = validate_analysis(target)
        if not target["image_usable"] and (target["visible_signal"] != "unclear" or target["observations"]):
            raise ValueError("Unusable examples cannot contain visible observations")
        return target
    except (ValueError, TypeError):
        raise ServiceError("정답 설명의 필수 항목을 확인해 주세요. 관찰 불가 사진은 판단 어려움·빈 관찰 목록으로 등록해 주세요.",
                           400, "invalid_vision_target") from None


def signature(rows):
    return hashlib.sha256(json.dumps(sorted(rows, key=lambda r: r["id"]), ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def split_groups(rows):
    groups = sorted({row["group"] for row in rows})
    if len(groups) < MIN_GROUPS:
        raise ServiceError("같은 사람의 사진을 같은 코드로 묶고 익명 그룹을 최소 4개 준비해 주세요.", 400, "vision_groups_needed")
    rng = random.Random(42)
    for _ in range(200):
        shuffled = groups[:]
        rng.shuffle(shuffled)
        held_out = set(shuffled[:max(2, round(len(groups) * .25))])
        train = [r for r in rows if r["group"] not in held_out]
        validation = [r for r in rows if r["group"] in held_out]
        if all({r["target"]["image_usable"] for r in subset} == {False, True} for subset in (train, validation)):
            return train, validation
    raise ServiceError("관찰 가능·불가 예시가 학습·검증 양쪽에 포함되도록 그룹을 더 준비해 주세요.", 400, "vision_split_needed")


class VisionDataset:
    def __init__(self, directory, photo_store=None):
        self.directory = Path(directory).resolve()
        self.photo_store = photo_store

    def _write_rows(self, rows):
        path = self.directory / "dataset.json"
        write = lambda: atomic_json(path, rows)
        if self.photo_store:
            self.photo_store.sync(rows, path, lambda row: self.directory / "photos" / (identifier(row["id"]) + ".jpg"), write)
        else:
            write()

    def sync_database(self):
        if self.photo_store:
            self.photo_store.sync(self.rows(), self.directory / "dataset.json",
                                  lambda row: self.photo(row["id"]))

    def rows(self):
        rows = load_json(self.directory / "dataset.json", [])
        if not isinstance(rows, list) or len(rows) > MAX_SAMPLES:
            raise ServiceError("비전 학습 목록 형식을 확인해 주세요.", 503, "vision_dataset_invalid")
        for row in rows:
            if (not isinstance(row, dict) or not isinstance(row.get("group"), str)
                    or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", row.get("group", ""))
                    or row.get("focus") not in ANALYSIS_FOCUS):
                raise ServiceError("비전 학습 목록 형식을 확인해 주세요.", 503, "vision_dataset_invalid")
            identifier(row.get("id"))
            validate_target(row.get("target"))
        return rows

    def photo(self, sample_id):
        path = (self.directory / "photos" / (identifier(sample_id) + ".jpg")).resolve()
        if not path.is_relative_to(self.directory) or not path.is_file():
            raise ServiceError("학습 사진을 찾지 못했어요.", 404, "vision_photo_missing")
        return path

    def save(self, image, group, focus, target, sample_id=None):
        if not isinstance(group, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", group):
            raise ServiceError("p001 같은 익명 그룹 코드를 입력해 주세요.", 400, "invalid_vision_group")
        if focus not in ANALYSIS_FOCUS:
            raise ServiceError("관찰 부위를 선택해 주세요.", 400, "invalid_analysis_focus")
        target = validate_target(target)
        rows = self.rows()
        if sample_id:
            stored = self.photo(sample_id)
            if not any(row["id"] == sample_id for row in rows):
                raise ServiceError("수정할 예시를 찾지 못했어요.", 404, "vision_photo_missing")
            with Image.open(stored) as source:
                source = source.convert("RGB")
                if source.size != image.size or source.tobytes() != image.tobytes():
                    raise ServiceError("새 사진은 새 예시로 등록해 주세요.", 400, "vision_photo_changed")
        else:
            sample_id = hashlib.sha256(str(image.size).encode() + image.tobytes()).hexdigest()
        old = next((r for r in rows if r["id"] == sample_id), None)
        if old is None and len(rows) >= MAX_SAMPLES:
            raise ServiceError("비전 학습 예시는 최대 200장까지 등록할 수 있어요.", 400, "vision_dataset_full")
        path = self.directory / "photos" / (sample_id + ".jpg")
        path.parent.mkdir(parents=True, exist_ok=True)
        created = not path.is_file()
        if created:
            path.write_bytes(image_bytes(image, "JPEG"))
        row = {"id": sample_id, "group": group, "focus": focus, "target": target}
        try:
            self._write_rows([r for r in rows if r["id"] != sample_id] + [row])
        except Exception:
            if created:
                path.unlink(missing_ok=True)
            raise
        return row

    def remove(self, sample_id):
        identifier(sample_id)
        rows = self.rows()
        retained = [r for r in rows if r["id"] != sample_id]
        if len(rows) == len(retained):
            raise ServiceError("학습 예시를 찾지 못했어요.", 404, "vision_photo_missing")
        photo = self.directory / "photos" / (sample_id + ".jpg")
        staged = photo.with_suffix(".delete")
        if photo.exists():
            photo.replace(staged)
        try:
            self._write_rows(retained)
        except Exception:
            if staged.exists():
                staged.replace(photo)
            raise
        staged.unlink(missing_ok=True)

    def readiness(self):
        rows = self.rows()
        counts = {"usable": sum(r["target"]["image_usable"] for r in rows),
                  "unusable": sum(not r["target"]["image_usable"] for r in rows)}
        reason = ""
        if min(counts.values()) < MIN_PER_STATE:
            reason = "관찰 가능·불가 예시를 각각 4장 이상 준비해 주세요."
        else:
            try:
                split_groups(rows)
            except ServiceError as error:
                reason = error.message
        return {"samples": rows, "total": len(rows), "counts": counts, "groups": len({r["group"] for r in rows}),
                "can_train": not reason, "reason": reason, "minimum_per_state": MIN_PER_STATE, "minimum_groups": MIN_GROUPS,
                "signature": signature(rows)}


class GPULock:
    """OS file lock also protects GPU workers left running across web restarts."""
    def __init__(self, path):
        self.path = Path(path)
        self.stream = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open("a+b")
        self.stream.seek(0)
        self.stream.write(b"0")
        self.stream.flush()
        self.stream.seek(0)
        try:
            if __import__("os").name == "nt":
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.stream.close()
            self.stream = None
            raise ServiceError("다른 비전 학습·테스트가 GPU를 사용 중이에요.", 429, "vision_busy") from None
        return self

    def __exit__(self, *args):
        if self.stream:
            self.stream.close()
