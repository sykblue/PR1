"""Download the official hair-only model. No user images are accessed."""
import hashlib
from pathlib import Path
from urllib.request import urlopen

URL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/1/hair_segmenter.tflite"
TARGET = Path(__file__).resolve().parent / "models" / "hair_segmenter.tflite"


def main():
    if TARGET.is_file() and TARGET.read_bytes()[4:8] == b"TFL3":
        print("Hair segmentation model is already installed.")
        return
    with urlopen(URL, timeout=60) as response:
        content = response.read(50 * 1024 * 1024 + 1)
    if len(content) > 50 * 1024 * 1024 or content[4:8] != b"TFL3":
        raise RuntimeError("Downloaded file is not a valid TFLite model.")
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    staged = TARGET.with_suffix(".download")
    staged.write_bytes(content)
    staged.replace(TARGET)
    print(f"Installed {TARGET.name} ({len(content):,} bytes)")
    print("SHA256:", hashlib.sha256(content).hexdigest())


if __name__ == "__main__":
    main()
