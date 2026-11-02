"""Download only the public base model. Never upload training data."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("HF_HOME", str(ROOT / ".cache" / "huggingface-vlm"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from huggingface_hub import HfApi, snapshot_download

REPO = "Qwen/Qwen2.5-VL-3B-Instruct"
destination = ROOT / "models" / "vlm-base"
revision_file = destination / "hairline-base.json"
if revision_file.is_file():
    revision = json.loads(revision_file.read_text(encoding="utf-8"))["revision"]
else:
    revision = HfApi().model_info(REPO, token=False).sha
print(json.dumps({"phase": "downloading_base", "repo": REPO, "revision": revision}), flush=True)
snapshot_download(REPO, revision=revision, local_dir=destination, token=False, max_workers=2,
                  allow_patterns=["*.json", "*.safetensors", "*.txt", "*.jinja", "LICENSE", "LICENSE.txt", "README.md"],
                  ignore_patterns=["optimizer*", "training*", "*.bin"])
revision_file.write_text(json.dumps({"repo": REPO, "revision": revision}), encoding="utf-8")
print(json.dumps({"phase": "base_ready", "revision": revision}), flush=True)
