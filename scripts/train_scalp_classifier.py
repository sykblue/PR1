"""Train an experimental macro-scalp classifier, separate from Gemini/Ollama weights."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import random
import sys
import time

import numpy as np
from PIL import Image
import torch
from torch import nn
from torch.utils.data import Dataset, DataLoader
from torchvision import models, transforms

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from services.vlm_data import GPULock


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


class Photos(Dataset):
    def __init__(self, root, rows, training=False):
        self.root, self.rows = root, rows
        steps = [transforms.Resize((224, 224), interpolation=transforms.InterpolationMode.BILINEAR)]
        if training:
            steps += [transforms.RandomHorizontalFlip(), transforms.RandomVerticalFlip(),
                      transforms.ColorJitter(brightness=.08, contrast=.08, saturation=.04)]
        self.transform = transforms.Compose([*steps, transforms.ToTensor(),
                                             transforms.Normalize([.485, .456, .406], [.229, .224, .225])])

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        row = self.rows[index]
        path = (self.root / row["image"]).resolve()
        if not path.is_relative_to(self.root.resolve() / "images"):
            raise ValueError("Invalid training image path")
        with Image.open(path) as image:
            tensor = self.transform(image.convert("RGB"))
        return tensor, row["grade"]


def scores(logits, labels):
    predictions = logits.argmax(1)
    confusion = np.zeros((4, 4), dtype=np.int64)
    for expected, predicted in zip(labels, predictions):
        confusion[int(expected), int(predicted)] += 1
    recall = np.diag(confusion) / np.maximum(confusion.sum(1), 1)
    precision = np.diag(confusion) / np.maximum(confusion.sum(0), 1)
    f1 = 2 * precision * recall / np.maximum(precision + recall, 1e-12)
    return {"accuracy": float((predictions == labels).mean()), "balanced_accuracy": float(recall.mean()),
            "macro_f1": float(f1.mean()), "recall": recall.tolist(), "precision": precision.tolist(),
            "confusion_matrix": confusion.tolist(), "samples": int(len(labels))}


def evaluate(model, loader, device):
    model.eval()
    values, targets = [], []
    with torch.inference_mode():
        for images, labels in loader:
            with torch.amp.autocast("cuda", enabled=device.type == "cuda"):
                logits = model(images.to(device))
            values.append(logits.float().cpu().numpy())
            targets.append(labels.numpy())
    return np.concatenate(values), np.concatenate(targets)


def main(args):
    random.seed(42); np.random.seed(42); torch.manual_seed(42)
    torch.set_num_threads(min(8, torch.get_num_threads()))
    torch.hub.set_dir(str(ROOT / ".cache" / "torch"))
    root, output = args.dataset.resolve(), args.output.resolve()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    splits = {name: [row for row in manifest["rows"] if row["split"] == name] for name in ("train", "validation", "test")}
    groups = {key: {row["identity"] for row in rows} for key, rows in splits.items()}
    assert not groups["train"] & groups["validation"] and not groups["train"] & groups["test"] and not groups["test"] & groups["validation"]
    assert len({row["sha256"] for row in manifest["rows"]}) == len(manifest["rows"])
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU required for this training job")
    output.mkdir(parents=True, exist_ok=True)
    job = ROOT / "data" / "scalp-training" / ("job-" + time.strftime("%Y%m%d-%H%M%S"))
    job.mkdir(parents=True)
    status_path = job / "status.json"
    device = torch.device("cuda")
    started = time.monotonic()
    def status(**fields):
        value = {"state": "running", "elapsed_seconds": round(time.monotonic() - started, 1), **fields}
        write_json(status_path, value)
        print(json.dumps(value, ensure_ascii=True), flush=True)
    status(phase="loading_pretrained_model", dataset_images=len(manifest["rows"]), job=str(job))
    model = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.IMAGENET1K_V1)
    model.classifier[-1] = nn.Linear(model.classifier[-1].in_features, 4)
    for parameter in model.features.parameters(): parameter.requires_grad = False
    model.to(device)
    datasets = {name: Photos(root, rows, training=name == "train") for name, rows in splits.items()}
    loaders = {name: DataLoader(dataset, batch_size=args.batch_size, shuffle=name == "train", num_workers=0,
                                pin_memory=True) for name, dataset in datasets.items()}
    counts = Counter(row["grade"] for row in splits["train"])
    weights = torch.tensor([len(splits["train"]) / (4 * counts[i]) for i in range(4)], dtype=torch.float32, device=device)
    criterion = nn.CrossEntropyLoss(weight=weights)
    optimizer = torch.optim.AdamW(filter(lambda parameter: parameter.requires_grad, model.parameters()), lr=.001, weight_decay=.0001)
    scaler = torch.amp.GradScaler("cuda")
    history, best, best_epoch = [], -1, 0
    for epoch in range(args.epochs):
        if epoch == 1:
            for parameter in model.features[-4:].parameters(): parameter.requires_grad = True
            optimizer = torch.optim.AdamW(filter(lambda parameter: parameter.requires_grad, model.parameters()), lr=.0003, weight_decay=.0001)
        model.train()
        if epoch == 0: model.features.eval()
        else: model.features[:-4].eval()
        total_loss, seen = 0., 0
        for step, (images, labels) in enumerate(loaders["train"]):
            images, labels = images.to(device), labels.to(device)
            optimizer.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda"):
                loss = criterion(model(images), labels)
            scaler.scale(loss).backward(); scaler.step(optimizer); scaler.update()
            total_loss += float(loss.detach()) * len(labels); seen += len(labels)
            if step % 50 == 0:
                status(phase="training", epoch=epoch + 1, epochs=args.epochs, step=step,
                       steps=len(loaders["train"]), loss=round(total_loss / seen, 4))
        logits, labels = evaluate(model, loaders["validation"], device)
        metrics = scores(logits, labels)
        history.append({"epoch": epoch + 1, "training_loss": total_loss / seen, "validation": metrics})
        if metrics["macro_f1"] > best:
            best, best_epoch = metrics["macro_f1"], epoch + 1
            torch.save(model.state_dict(), job / "best.pt")
        status(phase="validation", epoch=epoch + 1, validation=metrics, best_epoch=best_epoch)
    model.load_state_dict(torch.load(job / "best.pt", map_location=device, weights_only=True))
    validation_logits, validation_labels = evaluate(model, loaders["validation"], device)
    def nll(temperature):
        return float(nn.functional.cross_entropy(torch.tensor(validation_logits / temperature), torch.tensor(validation_labels)))
    temperature = min((1., 1.5, 2., 3., 4., 6.), key=nll)
    test_logits, test_labels = evaluate(model, loaders["test"], device)
    model.cpu().eval()
    onnx_path = output / "model.onnx"
    torch.onnx.export(model, torch.zeros(1, 3, 224, 224), str(onnx_path), input_names=["images"],
                      output_names=["logits"], opset_version=12, dynamo=False)
    import onnx
    onnx.checker.check_model(str(onnx_path))
    golden_images = torch.stack([datasets["validation"][i][0] for i in range(min(8, len(datasets["validation"])))])
    with torch.inference_mode(): golden_logits = model(golden_images).numpy()
    np.savez(job / "onnx-check.npz", images=golden_images.numpy(), logits=golden_logits)
    metadata = {"version": 1, "architecture": "mobilenet_v3_small", "classes": manifest["classes"],
                "input_kind": "scalp_macro", "input_size": 224, "mean": [.485, .456, .406], "std": [.229, .224, .225],
                "model_sha256": hashlib.sha256(onnx_path.read_bytes()).hexdigest(), "dataset_signature": manifest["signature"],
                "dataset_images": len(manifest["rows"]), "distribution": manifest["distribution"],
                "best_epoch": best_epoch, "temperature": temperature, "confidence_threshold": .55,
                "validation": scores(validation_logits, validation_labels), "test": scores(test_logits, test_labels),
                "history": history, "experimental": True, "onnx_verified": False,
                "limitations": [manifest["split_limitations"], "Macro-scalp dataset label classification; not a clinical diagnosis or a validated forehead/hairline model."],
                "parity_fixture": str(job / "onnx-check.npz"), "trained_at": time.strftime("%Y-%m-%d %H:%M:%S")}
    write_json(output / "metadata.json", metadata)
    status(state="completed", phase="awaiting_opencv_verification", best_epoch=best_epoch,
           validation=metadata["validation"], test=metadata["test"], model=str(onnx_path))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, default=ROOT / "data/scalp-training/dataset")
    parser.add_argument("--output", type=Path, default=ROOT / "models/scalp-classifier")
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=64)
    args = parser.parse_args()
    if not 1 <= args.epochs <= 30 or not 1 <= args.batch_size <= 128: parser.error("Invalid training size")
    with GPULock(ROOT / ".cache/vlm/gpu.lock"):
        main(args)
