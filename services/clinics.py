"""Search a bundled public HIRA snapshot; never forward or persist user coordinates."""
import json
import math
from pathlib import Path

from .errors import ServiceError

RADII = frozenset({2000, 5000, 10000})
SOURCE_URL = "https://www.data.go.kr/data/15051059/fileData.do"


def coordinates(latitude, longitude):
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in (latitude, longitude)):
        raise ServiceError("현재 위치를 다시 확인해 주세요.", 400, "invalid_location")
    if abs(latitude) > 90 or abs(longitude) > 180:
        raise ServiceError("현재 위치를 다시 확인해 주세요.", 400, "invalid_location")
    return round(latitude, 3), round(longitude, 3)


def distance_m(latitude, longitude, target_latitude, target_longitude):
    lat1, lat2 = map(math.radians, (latitude, target_latitude))
    dlat, dlon = lat2 - lat1, math.radians(target_longitude - longitude)
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(min(1, max(0, a))))


class NearbyClinics:
    def __init__(self, path=None):
        path = Path(path) if path else Path(__file__).resolve().parent.parent / "data" / "clinics-20260930.json"
        self.items = ()
        self.as_of = ""
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("items"), list):
                return
            self.items = tuple(item for item in data["items"] if self._valid(item))
            self.as_of = data.get("as_of", "")
        except (OSError, ValueError, TypeError):
            pass

    @staticmethod
    def _valid(item):
        if not isinstance(item, dict) or not all(isinstance(item.get(k), str) for k in ("id", "name", "address", "phone", "opening_hours")):
            return False
        try:
            coordinates(item.get("latitude"), item.get("longitude"))
        except ServiceError:
            return False
        return bool(item["name"]) and type(item.get("specialists_count")) is int and item["specialists_count"] > 0

    def search(self, payload):
        if not isinstance(payload, dict) or set(payload) - {"latitude", "longitude", "radius_m"}:
            raise ServiceError("병원 검색 요청을 확인해 주세요.", 400, "invalid_clinic_request")
        latitude, longitude = coordinates(payload.get("latitude"), payload.get("longitude"))
        radius = payload.get("radius_m", 2000)
        if type(radius) is not int or radius not in RADII:
            raise ServiceError("검색 범위를 다시 선택해 주세요.", 400, "invalid_clinic_radius")
        if not self.items:
            raise ServiceError("병원 현황 자료를 준비하지 못했어요. 서버의 병원 데이터 파일을 확인해 주세요.", 503, "clinics_not_configured")
        results = []
        for item in self.items:
            distance = distance_m(latitude, longitude, item["latitude"], item["longitude"])
            if distance <= radius:
                results.append({**item, "distance_m": round(distance), "source_url": SOURCE_URL})
        results.sort(key=lambda item: (item["distance_m"], item["name"]))
        return {"items": results[:20], "total": len(results), "radius_m": radius,
                "source": "건강보험심사평가원", "as_of": self.as_of, "source_url": SOURCE_URL,
                "license": "공공누리 제1유형(출처표시)"}
