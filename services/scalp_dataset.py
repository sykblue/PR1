"""Read AI Hub split ZIPs locally and prepare a deduplicated research dataset."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import random
import re
import tarfile
import zipfile
from collections import Counter

from PIL import Image

CLASSES = ("양호", "경증", "중등도", "중증")
NAME = re.compile(r"(?P<identity>[A-Za-z0-9-]+)_(?P<device>[A-Za-z0-9-]+)_(?P<frame>\d+)_(?P<part>\d+)_(?P<view>TH|LH|RH|BH)\.jpg", re.I)


class JoinedParts(io.RawIOBase):
    def __init__(self, archive, members):
        super().__init__()
        self.parts, self.position, self.length = [], 0, 0
        ordered = sorted(members, key=lambda item: int(item.name.rsplit(".part", 1)[1]))
        for member in ordered:
            offset = int(member.name.rsplit(".part", 1)[1])
            if offset != self.length:
                raise ValueError("Missing or overlapping ZIP parts")
            self.parts.append((self.length, member.size, archive.extractfile(member)))
            self.length += member.size

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        if whence not in (0, 1, 2):
            raise ValueError("Invalid seek mode")
        target = offset if whence == 0 else self.position + offset if whence == 1 else self.length + offset
        if target < 0:
            raise ValueError("Negative seek")
        self.position = target
        return target

    def read(self, size=-1):
        remaining = max(0, self.length - self.position)
        if size >= 0:
            remaining = min(size, remaining)
        chunks = []
        for start, length, stream in self.parts:
            if not remaining:
                break
            if start <= self.position < start + length:
                stream.seek(self.position - start)
                count = min(remaining, length - (self.position - start))
                chunk = stream.read(count)
                if len(chunk) != count:
                    raise EOFError("Incomplete ZIP part")
                chunks.append(chunk)
                self.position += count
                remaining -= count
        return b"".join(chunks)

    def close(self):
        for _, _, stream in self.parts:
            stream.close()
        super().close()


def assign_splits(rows, seed=42):
    """Choose the first class-feasible ID split, never select by model scores."""
    identities = sorted({row["identity"] for row in rows})
    if len(identities) < 12:
        raise ValueError("At least 12 deidentified IDs are required")
    count = max(2, round(len(identities) * .15))
    for attempt in range(200):
        ordered = identities.copy()
        random.Random(seed + attempt).shuffle(ordered)
        membership = {identity: "test" if i < count else "validation" if i < count * 2 else "train"
                      for i, identity in enumerate(ordered)}
        labels = {split: {row["grade"] for row in rows if membership[row["identity"]] == split}
                  for split in ("train", "validation", "test")}
        if all(values == set(range(4)) for values in labels.values()):
            for row in rows:
                row["split"] = membership[row["identity"]]
            return seed + attempt
    raise ValueError("Cannot put all four classes in independent ID splits")


def prepare(source, output, progress=print):
    source, output = Path(source).resolve(), Path(output).resolve()
    archives = sorted(source.glob("download*.tar"))
    if len(archives) != 4:
        raise ValueError("Expected four original download TAR files")
    images = output / "images"
    images.mkdir(parents=True, exist_ok=True)
    by_hash, raw_counts, duplicate_ids, duplicates = {}, Counter(), 0, 0
    for path in archives:
        with tarfile.open(path, "r:") as outer:
            members = [member for member in outer if member.isfile()]
            if not members or any(".zip.part" not in member.name for member in members):
                raise ValueError("Unexpected archive contents")
            grades = {int(PurePosixPath(member.name).parent.name.split(".")[0]) for member in members}
            if len(grades) != 1 or not grades <= set(range(4)):
                raise ValueError("Invalid grade folder")
            grade = grades.pop()
            with JoinedParts(outer, members) as joined, zipfile.ZipFile(joined) as archive:
                for entry in archive.infolist():
                    if entry.is_dir():
                        continue
                    name = PurePosixPath(entry.filename)
                    match = NAME.fullmatch(name.name)
                    if not match or len(name.parts) != 1 or not 0 < entry.file_size <= 10 * 1024 * 1024:
                        raise ValueError("Unexpected image name or size")
                    payload = archive.read(entry)  # CRC is checked by zipfile.
                    digest = hashlib.sha256(payload).hexdigest()
                    raw_counts[grade] += 1
                    identity = match["identity"]
                    if digest in by_hash:
                        row = by_hash[digest]
                        if row["grade"] != grade:
                            raise ValueError("The same image has conflicting grade labels")
                        duplicates += 1
                        duplicate_ids += identity not in row["original_ids"]
                        row["original_ids"] = sorted(set(row["original_ids"]) | {identity})
                        row["identity"] = row["original_ids"][0]
                        continue
                    with Image.open(io.BytesIO(payload)) as image:
                        if image.format != "JPEG" or min(image.size) < 160:
                            raise ValueError("Invalid source JPEG")
                    destination = images / (digest + ".jpg")
                    if not destination.exists() or hashlib.sha256(destination.read_bytes()).hexdigest() != digest:
                        destination.write_bytes(payload)
                    by_hash[digest] = {"sha256": digest, "image": "images/" + digest + ".jpg", "grade": grade,
                                       "identity": identity, "original_ids": [identity], "view": match["view"].upper()}
        progress(json.dumps({"archive": path.name, "unique_images": len(by_hash), "duplicates": duplicates}), flush=True)
    rows = sorted(by_hash.values(), key=lambda row: row["sha256"])
    split_seed = assign_splits(rows)
    distribution = {split: {str(grade): sum(row["split"] == split and row["grade"] == grade for row in rows)
                            for grade in range(4)} for split in ("train", "validation", "test")}
    manifest = {"version": 1, "classes": list(CLASSES), "input_kind": "scalp_macro", "raw_counts": dict(raw_counts),
                "unique_images": len(rows), "removed_duplicate_copies": duplicates, "cross_id_duplicate_copies": duplicate_ids,
                "split_seed": split_seed, "distribution": distribution,
                "split_limitations": "Exact duplicates are removed before canonical-ID splitting. Original IDs contain reused images; true person independence is not externally verified.",
                "rows": rows}
    signature = hashlib.sha256(json.dumps([(row["sha256"], row["grade"], row["identity"], row["split"]) for row in rows]).encode()).hexdigest()
    manifest["signature"] = signature
    temporary = output / "manifest.json.tmp"
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(output / "manifest.json")
    return {key: value for key, value in manifest.items() if key != "rows"}
