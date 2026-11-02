"""Install two official PaddleOCR models; no photos or API keys are read."""
import hashlib
import io
import tarfile
from pathlib import Path
from urllib.request import urlopen

from services.ocr import DETECTION_MODEL, MODEL_FILES, RECOGNITION_MODEL

ROOT = Path(__file__).resolve().parent / "models" / "ocr"
BASE_URL = "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0"


def install_model(name):
    destination = ROOT / name
    if all((destination / filename).is_file() for filename in MODEL_FILES):
        print(name, "already installed")
        return
    with urlopen(f"{BASE_URL}/{name}_infer.tar", timeout=90) as response:
        content = response.read(60 * 1024 * 1024 + 1)
    if len(content) > 60 * 1024 * 1024:
        raise RuntimeError("Unexpected model archive size")
    # Copy only named model files, never archive-supplied paths or symlinks.
    extracted = {}
    with tarfile.open(fileobj=io.BytesIO(content), mode="r:*") as archive:
        for member in archive.getmembers():
            filename = Path(member.name).name
            if member.isfile() and filename in MODEL_FILES:
                if member.size > 60 * 1024 * 1024 or filename in extracted:
                    raise RuntimeError("Unexpected model archive contents")
                extracted[filename] = archive.extractfile(member).read()
    if set(extracted) != set(MODEL_FILES):
        raise RuntimeError("Model archive is incomplete")
    destination.mkdir(parents=True, exist_ok=True)
    for filename, data in extracted.items():
        staged = destination / (filename + ".download")
        staged.write_bytes(data)
        staged.replace(destination / filename)
    print(name, "installed; archive SHA256", hashlib.sha256(content).hexdigest())


if __name__ == "__main__":
    for model in (DETECTION_MODEL, RECOGNITION_MODEL):
        install_model(model)
