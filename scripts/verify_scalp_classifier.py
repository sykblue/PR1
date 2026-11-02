"""Check exported ONNX inference parity before allowing the web app to use it."""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, default=Path("models/scalp-classifier"))
    args = parser.parse_args()
    path = args.model_dir / "metadata.json"
    metadata = json.loads(path.read_text(encoding="utf-8"))
    network = cv2.dnn.readNetFromONNX(str(args.model_dir / "model.onnx"))
    with np.load(metadata["parity_fixture"], allow_pickle=False) as fixture:
        actual = []
        for sample in fixture["images"]:
            network.setInput(sample[None])
            actual.append(network.forward().reshape(-1))
        expected = fixture["logits"]
        difference = float(np.abs(np.asarray(actual) - expected).max())
        if not np.isfinite(difference) or difference > .005:
            raise RuntimeError(f"OpenCV / PyTorch parity failed: {difference}")
    metadata["onnx_verified"] = True
    metadata["opencv_max_absolute_error"] = difference
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)
    print(json.dumps({"onnx_verified": True, "max_absolute_error": difference, "test": metadata["test"]}))
