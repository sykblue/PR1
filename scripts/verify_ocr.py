"""OCR smoke check using generated text only; does not read .env or user photos."""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".cache" / "matplotlib"))

from PIL import Image, ImageDraw, ImageFont
from services.ocr import LocalOCR


def main():
    image = Image.new("RGB", (1200, 500), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("C:/Windows/Fonts/malgun.ttf", 52)
    for y, text in [(45, "한국어 영어 인식 테스트"), (145, "HAIRLINE LAB OCR TEST"), (245, "Sample only 12345")]:
        draw.text((55, y), text, font=font, fill="black")
    folder = ROOT / "test-artifacts"
    folder.mkdir(exist_ok=True)
    image.save(folder / "ocr-smoke.png")
    result = LocalOCR(ROOT / "models" / "ocr", ROOT / ".cache").recognize(image)
    print(json.dumps(result, ensure_ascii=True), flush=True)
    assert "한국어" in result["text"], "Korean text was not recognized"
    assert "HAIRLINE" in result["text"], "English text was not recognized"
    assert "12345" in result["text"], "Digits were not recognized"
    print("Korean, English and numeric local OCR: OK", flush=True)


if __name__ == "__main__":
    main()
