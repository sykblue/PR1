"""Prepare private scalp classification data without changing source archives."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from services.scalp_dataset import prepare

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("data/scalp-training/dataset"))
    args = parser.parse_args()
    print(json.dumps(prepare(args.source, args.output), ensure_ascii=True), flush=True)
