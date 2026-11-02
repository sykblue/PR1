"""Extract registered dermatology facilities from the public HIRA quarterly ZIP."""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import zipfile

SOURCE_URL = "https://www.data.go.kr/data/15051059/fileData.do"


def build(source, output, as_of):
    with zipfile.ZipFile(source) as archive:
        def rows(prefix):
            name = next(name for name in archive.namelist() if name.startswith(prefix))
            with io.TextIOWrapper(archive.open(name), encoding="cp949") as stream:
                yield from csv.DictReader(stream)
        selected = {}
        for row in rows("5."):
            if row.get("진료과목코드명") != "피부과":
                continue
            count = row.get("과목별 전문의수", "")
            if count.isdigit() and int(count) > 0:
                selected[row["암호화요양기호"]] = int(count)
        items = {}
        for row in rows("1."):
            key = row.get("암호화요양기호")
            if key not in selected:
                continue
            try:
                latitude, longitude = float(row["좌표(Y)"]), float(row["좌표(X)"])
                if not (33 <= latitude <= 39.5 and 124 <= longitude <= 132):
                    continue
            except (ValueError, KeyError, TypeError):
                continue
            items[key] = {"id": hashlib.sha256(key.encode()).hexdigest()[:16], "name": row["요양기관명"],
                          "latitude": latitude, "longitude": longitude, "address": row.get("주소", ""),
                          "phone": row.get("전화번호", ""), "opening_hours": "", "dermatology": True,
                          "department_source": "hira_reported", "specialists_count": selected[key], "source_url": SOURCE_URL}
        def clock(value):
            if not value or not value.isdigit() or int(value) == 0:
                return ""
            value = value.zfill(4)
            return value[:2] + ":" + value[2:] if len(value) == 4 and int(value[:2]) < 24 and int(value[2:]) < 60 else ""
        for row in rows("4."):
            item = items.get(row.get("암호화요양기호"))
            if item is None:
                continue
            hours = []
            for day in ("월", "화", "수", "목", "금", "토", "일"):
                start, end = clock(row.get(f"진료시작시간_{day}요일", "")), clock(row.get(f"진료종료시간_{day}요일", ""))
                if start and end:
                    hours.append(f"{day} {start}–{end}")
            item["opening_hours"] = " · ".join(hours)
    data = {"source": "건강보험심사평가원", "as_of": as_of, "source_url": SOURCE_URL,
            "license": "공공누리 제1유형(출처표시)", "items": list(items.values())}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"facilities": len(items), "as_of": as_of, "bytes": output.stat().st_size}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, default=Path("data/clinics-20260930.json"))
    parser.add_argument("--as-of", default="2026-09-30")
    args = parser.parse_args()
    build(args.source, args.output, args.as_of)
