import contextlib
import csv
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from app import create_app
from helpers import TEST_CONFIG, client_with_csrf
from services.clinics import NearbyClinics, coordinates, distance_m
from services.errors import ServiceError
from scripts.prepare_clinics import build


def facility(identifier, latitude=37.567, longitude=126.979, count=1):
    return {"id": identifier, "name": identifier, "latitude": latitude, "longitude": longitude,
            "address": "Public facility address", "phone": "02-123-4567", "opening_hours": "",
            "specialists_count": count, "dermatology": True}


class ClinicTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = Path(self.folder.name) / "clinics.json"
        self.path.write_text(json.dumps({"as_of": "2026-09-30", "items": [facility("near"), facility("far", 37.59), facility("outside", 38.0)]}), encoding="utf-8")
        self.service = NearbyClinics(self.path)

    def tearDown(self):
        self.folder.cleanup()

    def test_position_precision_and_invalid_input(self):
        self.assertEqual(coordinates(37.56654321, 126.97865432), (37.567, 126.979))
        for point in [(True, 127), ("37", 127), (None, 127), (float("nan"), 127), (37, float("inf")), (91, 127), (37, 181)]:
            with self.subTest(point=point), self.assertRaises(ServiceError):
                coordinates(*point)

    def test_radius_selection_distance_sort_and_no_network(self):
        with patch("requests.post") as post, patch("requests.get") as get:
            small = self.service.search({"latitude": 37.56654321, "longitude": 126.97865432, "radius_m": 2000})
            large = self.service.search({"latitude": 37.567, "longitude": 126.979, "radius_m": 5000})
        self.assertEqual([x["id"] for x in small["items"]], ["near"])
        self.assertEqual([x["id"] for x in large["items"]], ["near", "far"])
        self.assertEqual(small["as_of"], "2026-09-30")
        self.assertNotIn("37.56654321", json.dumps(small))
        post.assert_not_called(); get.assert_not_called()

    def test_invalid_payloads_never_trigger_lookup(self):
        for payload in [None, [], {}, {"latitude": 37, "longitude": 127, "photo": "private"},
                        {"latitude": 37, "longitude": 127, "radius_m": True},
                        {"latitude": 37, "longitude": 127, "radius_m": 999999}]:
            with self.subTest(payload=payload), self.assertRaises(ServiceError) as error:
                self.service.search(payload)
            self.assertEqual(error.exception.status, 400)

    def test_empty_results_and_limit_do_not_fabricate_facilities(self):
        result = self.service.search({"latitude": 0, "longitude": 0})
        self.assertEqual(result["items"], []); self.assertEqual(result["total"], 0)
        self.service.items = tuple(facility(str(x), 37.567 + x / 100000) for x in range(25))
        result = self.service.search({"latitude": 37.567, "longitude": 126.979})
        self.assertEqual(len(result["items"]), 20); self.assertEqual(result["total"], 25)

    def test_missing_corrupt_and_invalid_snapshot_are_explicit_failures(self):
        for value in ["bad json", "[]", json.dumps({"items": [facility("not-specialist", count=0)]})]:
            self.path.write_text(value, encoding="utf-8")
            service = NearbyClinics(self.path)
            with self.assertRaises(ServiceError) as error:
                service.search({"latitude": 37, "longitude": 127})
            self.assertEqual(error.exception.code, "clinics_not_configured")
        self.assertEqual(NearbyClinics(Path(self.folder.name)/"missing").items, ())

    def test_haversine_distance_is_symmetric(self):
        distance = distance_m(37.0, 127.0, 37.01, 127.0)
        self.assertAlmostEqual(distance, 1111.95, places=1)
        self.assertAlmostEqual(distance, distance_m(37.01, 127.0, 37.0, 127.0))

    def test_bundled_snapshot_is_usable_and_attributes_public_data(self):
        real = NearbyClinics()
        self.assertEqual(len(real.items), 1744)
        result = real.search({"latitude": 37.5665, "longitude": 126.978, "radius_m": 2000})
        self.assertGreater(result["total"], 0)
        self.assertTrue(all(item["address"] and item["specialists_count"] > 0 for item in result["items"]))
        self.assertIn("15051059", result["source_url"])

    def test_http_endpoint_requires_csrf_and_retains_private_response_headers(self):
        app = create_app({**TEST_CONFIG, "TESTING": True})
        self.addCleanup(app.extensions["database"].close)
        app.extensions["nearby_clinics"] = self.service
        plain = app.test_client().post("/api/clinics/nearby", json={"latitude": 37, "longitude": 127})
        self.assertEqual(plain.status_code, 403)
        client, _ = client_with_csrf(app)
        with patch("requests.post") as remote:
            response = client.post("/api/clinics/nearby", json={"latitude": 37.567, "longitude": 126.979})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["total"], 1)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        remote.assert_not_called()
        denied = client.post("/api/clinics/nearby", json={"latitude": 37, "longitude": 127}, headers={"Origin": "https://other.example"})
        self.assertEqual(denied.status_code, 403)

    def test_snapshot_builder_joins_departments_and_uses_only_valid_specialist_facilities(self):
        archive = Path(self.folder.name)/"input.zip"; output = Path(self.folder.name)/"output.json"
        def csv_bytes(columns, rows):
            stream=io.StringIO();writer=csv.DictWriter(stream,fieldnames=columns);writer.writeheader();writer.writerows(rows)
            return stream.getvalue().encode("cp949")
        with zipfile.ZipFile(archive,"w") as z:
            z.writestr("5.departments.csv", csv_bytes(["암호화요양기호","진료과목코드명","과목별 전문의수"], [
                {"암호화요양기호":"yes","진료과목코드명":"피부과","과목별 전문의수":"2"},
                {"암호화요양기호":"no","진료과목코드명":"피부과","과목별 전문의수":"0"}]))
            z.writestr("1.facilities.csv", csv_bytes(["암호화요양기호","요양기관명","좌표(X)","좌표(Y)","주소","전화번호"], [
                {"암호화요양기호":key,"요양기관명":key,"좌표(X)":"127","좌표(Y)":"37","주소":"Public address","전화번호":"02-123-4567"} for key in ("yes","no")]))
            z.writestr("4.hours.csv", csv_bytes(["암호화요양기호","진료시작시간_월요일","진료종료시간_월요일"], [
                {"암호화요양기호":"yes","진료시작시간_월요일":"930","진료종료시간_월요일":"1800"}]))
        with contextlib.redirect_stdout(io.StringIO()):
            build(archive, output, "2026-09-30")
        data=json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(len(data["items"]),1)
        self.assertEqual(data["items"][0]["specialists_count"],2)
        self.assertEqual(data["items"][0]["opening_hours"],"월 09:30–18:00")
        self.assertNotEqual(data["items"][0]["id"],"yes")
