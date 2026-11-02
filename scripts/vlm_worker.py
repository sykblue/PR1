"""Isolated, offline Qwen vision QLoRA worker. No dataset upload or remote code."""
import argparse
import base64
import io
import json
import math
import os
from pathlib import Path
import sys
import time

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["WANDB_DISABLED"] = "true"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

from PIL import Image
from services.errors import ServiceError
from services.gemini import BASE_SYSTEM_PROMPT, SYSTEM_PROMPT, analysis_text, validate_analysis
from services.ollama import LOCAL_ANALYSIS_SCHEMA
from services.vlm_data import BASE_MODEL, GPULock, atomic_json, load_json, validate_target

BASE_PATH = ROOT / "models" / "vlm-base"
GPU_LOCK = ROOT / ".cache" / "vlm" / "gpu.lock"
RUNTIME = ROOT / ".cache" / "vlm" / "runtime.json"
MAX_PIXELS = 256 * 28 * 28
MAX_TOKENS = 2048


def libraries():
    import torch
    import transformers
    import peft
    import bitsandbytes
    if not torch.cuda.is_available():
        raise ServiceError("CUDA GPU 학습 환경을 확인해 주세요.", 503, "vision_cuda_missing")
    return torch, transformers, peft, bitsandbytes


def probe():
    torch, transformers, peft, bnb = libraries()
    transformers.AutoProcessor.from_pretrained(str(BASE_PATH), local_files_only=True, trust_remote_code=False, use_fast=False)
    config = load_json(BASE_PATH / "config.json", {})
    index = load_json(BASE_PATH / "model.safetensors.index.json", {})
    weights = set(index.get("weight_map", {}).values())
    if not weights and (BASE_PATH / "model.safetensors").is_file():
        weights = {"model.safetensors"}
    if (config.get("model_type") != "qwen2_5_vl" or not weights
            or any(not (BASE_PATH / name).is_file() for name in weights)):
        raise ServiceError("학습용 기본 가중치를 먼저 준비해 주세요.", 503, "vision_base_missing")
    # Exercise the CUDA quantization backend rather than only importing it.
    layer = bnb.nn.Linear4bit(16, 16, bias=False, quant_type="nf4", compute_dtype=torch.bfloat16).to("cuda")
    layer(torch.ones(1, 16, device="cuda", dtype=torch.bfloat16))
    del layer
    torch.cuda.empty_cache()
    value = {"ready": True, "base_model": BASE_MODEL, "gpu": torch.cuda.get_device_name(),
             "vram_gb": round(torch.cuda.get_device_properties(0).total_memory / 1024 ** 3, 1),
             "versions": {"torch": torch.__version__, "transformers": transformers.__version__, "peft": peft.__version__, "bitsandbytes": bnb.__version__},
             "checked_at": time.time()}
    atomic_json(RUNTIME, value)
    print(json.dumps(value), flush=True)


def load_model(training):
    torch, transformers, peft, _ = libraries()
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    processor = transformers.AutoProcessor.from_pretrained(str(BASE_PATH), local_files_only=True, trust_remote_code=False, use_fast=False,
                                                           min_pixels=64 * 28 * 28, max_pixels=MAX_PIXELS)
    model = transformers.Qwen2_5_VLForConditionalGeneration.from_pretrained(
        str(BASE_PATH), local_files_only=True, trust_remote_code=False, use_safetensors=True,
        quantization_config=transformers.BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=dtype),
        torch_dtype=dtype, device_map={"": 0}, attn_implementation="sdpa")
    if training:
        model.config.use_cache = False
        model = peft.prepare_model_for_kbit_training(model, use_gradient_checkpointing=True,
                                                     gradient_checkpointing_kwargs={"use_reentrant": False})
        model = peft.get_peft_model(model, peft.LoraConfig(r=8, lora_alpha=16, lora_dropout=.05,
                                    target_modules=["q_proj", "v_proj"], bias="none", task_type="CAUSAL_LM"))
    return model, processor, torch, transformers


def messages(row, target=False):
    values = [{"role": "system", "content": [{"type": "text", "text": BASE_SYSTEM_PROMPT}]},
              {"role": "user", "content": [{"type": "image"}, {"type": "text", "text": "\n".join(analysis_text(focus=row["focus"]))}]}]
    if target:
        values.append({"role": "assistant", "content": [{"type": "text", "text": json.dumps(row["target"], ensure_ascii=False)}]})
    return values


def encode_example(processor, row, image, torch):
    prompt = processor.apply_chat_template(messages(row), tokenize=False, add_generation_prompt=True)
    full = processor.apply_chat_template(messages(row, True), tokenize=False, add_generation_prompt=False)
    data = processor(text=[full], images=[image], return_tensors="pt")
    prefix = processor(text=[prompt], images=[image], return_tensors="pt")["input_ids"]
    prefix_length = prefix.shape[1]
    if data["input_ids"].shape[1] > MAX_TOKENS:
        raise ServiceError("정답 설명이 길어요. 요약과 각 관찰 문장을 줄여 주세요.", 400, "vision_example_too_long")
    if not torch.equal(data["input_ids"][:, :prefix_length], prefix):
        raise ServiceError("학습 문장 구성을 검증하지 못했어요.", 503, "vision_template_mismatch")
    labels = data["input_ids"].clone()
    labels[:, :prefix_length] = -100
    labels[data["attention_mask"] == 0] = -100
    if not (labels != -100).any():
        raise ServiceError("학습할 정답 토큰이 없어요.", 400, "vision_target_empty")
    data["labels"] = labels
    return data


def train(job_path):
    job_path = Path(job_path).resolve()
    snapshot = load_json(job_path / "snapshot.json")
    status_path = job_path / "status.json"
    status = load_json(status_path, {})
    cancelled = job_path / "cancel.flag"

    def update(**values):
        status.update(values)
        status["updated_at"] = time.time()
        atomic_json(status_path, status)

    try:
        with GPULock(GPU_LOCK):
            if cancelled.exists():
                update(state="cancelled", phase="학습을 취소했어요.")
                return
            update(state="running", phase="기본 모델을 GPU에 준비하고 있어요.")
            model, processor, torch, transformers = load_model(True)

            class Examples(torch.utils.data.Dataset):
                def __init__(self, rows):
                    self.rows = rows

                def __len__(self):
                    return len(self.rows)

                def __getitem__(self, index):
                    row = self.rows[index]
                    validate_target(row["target"])
                    path = (job_path / "images" / (row["id"] + ".jpg")).resolve()
                    if not path.is_relative_to(job_path):
                        raise ServiceError("학습 사진 경로를 확인해 주세요.", 400, "invalid_training_path")
                    with Image.open(path) as image:
                        return encode_example(processor, row, image.convert("RGB"), torch)

            class Progress(transformers.TrainerCallback):
                def on_step_end(self, args, state, control, **kwargs):
                    update(step=state.global_step, phase="정답 설명으로 LoRA 가중치를 학습하고 있어요.")
                    if cancelled.exists():
                        control.should_training_stop = True

                def on_log(self, args, state, control, logs=None, **kwargs):
                    loss = (logs or {}).get("loss")
                    if isinstance(loss, (int, float)) and math.isfinite(loss):
                        update(loss=float(loss))

            args = transformers.TrainingArguments(
                output_dir=str(job_path / "checkpoints"), max_steps=snapshot["steps"],
                per_device_train_batch_size=1, gradient_accumulation_steps=2, learning_rate=2e-4,
                warmup_ratio=.05 if snapshot["steps"] >= 20 else 0, optim="adamw_torch", logging_steps=1, save_strategy="no", eval_strategy="no",
                report_to=[], remove_unused_columns=False, dataloader_num_workers=0, dataloader_pin_memory=False,
                bf16=torch.cuda.is_bf16_supported(), fp16=not torch.cuda.is_bf16_supported(),
                gradient_checkpointing=True, gradient_checkpointing_kwargs={"use_reentrant": False}, seed=42, disable_tqdm=True)
            dataset = Examples(snapshot["train"])
            trainer = transformers.Trainer(model=model, args=args, train_dataset=dataset,
                                            data_collator=lambda batch: batch[0], callbacks=[Progress()])
            outcome = trainer.train()
            if cancelled.exists():
                update(state="cancelled", phase="학습을 취소했어요. 완료 모델로 적용하지 않아요.")
                return
            update(phase="분리한 그룹의 정답 설명으로 검증 손실을 계산하고 있어요.")
            model.eval()
            losses = []
            with torch.no_grad():
                for row in Examples(snapshot["validation"]):
                    if cancelled.exists():
                        update(state="cancelled", phase="검증을 취소했어요.")
                        return
                    batch = {key: value.to("cuda") for key, value in row.items()}
                    value = float(model(**batch).loss)
                    if not math.isfinite(value):
                        raise ServiceError("검증 손실이 유효하지 않아요. 예시와 학습 설정을 확인해 주세요.", 503, "vision_nonfinite_loss")
                    losses.append(value)
            adapter = job_path / "adapter"
            updated = any(bool(parameter.detach().abs().sum() > 0) for name, parameter in model.named_parameters() if "lora_B" in name)
            if not updated:
                raise ServiceError("LoRA 가중치가 갱신되지 않았어요. 학습 스텝과 정답 예시를 확인해 주세요.", 503, "vision_no_weight_update")
            model.save_pretrained(str(adapter), safe_serialization=True)
            metadata = {"base_model": BASE_MODEL, "base_revision": load_json(BASE_PATH / "hairline-base.json", {}).get("revision"),
                        "dataset_signature": snapshot["signature"], "training_size": len(snapshot["train"]),
                        "validation_size": len(snapshot["validation"]), "training_loss": float(outcome.training_loss),
                        "validation_loss": sum(losses) / len(losses), "steps": trainer.state.global_step,
                        "trainable_parameters": sum(p.numel() for p in model.parameters() if p.requires_grad),
                        "adapter_updated": True, "completed_at": time.time(), "recipe": "qwen25vl-qlora-r8-assistant-only-v1"}
            atomic_json(job_path / "metadata.json", metadata)
            update(state="completed", phase="LoRA 학습을 완료했어요. 테스트한 뒤 내 분석에 적용할 수 있어요.", metadata=metadata)
    except BaseException as error:
        code = getattr(error, "code", "vision_training_failed")
        if "outofmemory" in type(error).__name__.lower() or "out of memory" in str(error).lower():
            code = "vision_out_of_memory"
            message = "GPU 메모리가 부족해요. 다른 GPU 작업을 종료하고 다시 시도해 주세요."
        elif isinstance(error, ServiceError):
            message = error.message
        else:
            message = "비전 학습을 완료하지 못했어요. 학습 환경과 예시 형식을 확인해 주세요."
        update(state="cancelled" if cancelled.exists() else "failed", phase=message, error_code=code,
               error_type=type(error).__name__)
        raise SystemExit(1) from None


def infer(adapter):
    request = json.loads(sys.stdin.read(8 * 1024 * 1024))
    with GPULock(GPU_LOCK):
        model, processor, torch, _ = load_model(False)
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, str(adapter), is_trainable=False, local_files_only=True)
        model.eval()
        text = "\n".join(analysis_text(request.get("ocr_text", ""), request.get("local_result"), request.get("focus", "all"), request.get("scalp_result")))
        text += "\nJSON 스키마:\n" + json.dumps(LOCAL_ANALYSIS_SCHEMA, ensure_ascii=False)
        values = [{"role": "system", "content": [{"type": "text", "text": SYSTEM_PROMPT}]},
                  {"role": "user", "content": [{"type": "image"}, {"type": "text", "text": text}]}]
        # Prefill syntax only. The model still generates every observation value.
        prompt = processor.apply_chat_template(values, tokenize=False, add_generation_prompt=True) + "{"
        with Image.open(io.BytesIO(base64.b64decode(request["image"], validate=True))) as image:
            inputs = processor(text=[prompt], images=[image.convert("RGB")], return_tensors="pt").to("cuda")
        with torch.inference_mode():
            output = model.generate(**inputs, max_new_tokens=2048, do_sample=False, temperature=1.0,
                                    eos_token_id=processor.tokenizer.eos_token_id)
        generated = output[0, inputs["input_ids"].shape[1]:]
        result = validate_analysis(json.loads("{" + processor.decode(generated, skip_special_tokens=True)))
        if not result["image_usable"]:
            raise ServiceError("사진에서 모발 상태를 관찰하기 어려워요. 한 사람의 머리가 선명한 사진을 준비해 주세요.", 422, "photo_not_usable")
        print("HAIRLINE_RESULT " + json.dumps({"result": result}, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["probe", "train", "infer"])
    parser.add_argument("--job", type=Path)
    parser.add_argument("--adapter", type=Path)
    options = parser.parse_args()
    try:
        if options.mode == "probe":
            probe()
        elif options.mode == "train":
            train(options.job)
        else:
            infer(options.adapter)
    except BaseException as error:
        if options.mode == "infer":
            code = getattr(error, "code", "vision_invalid_output" if isinstance(error, (ValueError, KeyError, TypeError)) else "vision_inference_failed")
            status = getattr(error, "status", 502)
            message = error.message if isinstance(error, ServiceError) else "학습 모델의 응답을 검증하지 못했어요. 예시와 모델을 확인해 주세요."
            print("HAIRLINE_RESULT " + json.dumps({"error": {"code": code, "status": status, "message": message}}, ensure_ascii=True), flush=True)
        elif options.mode == "probe":
            value = {"ready": False, "error_code": getattr(error, "code", "vision_runtime_missing"), "error_type": type(error).__name__}
            atomic_json(RUNTIME, value)
            print(json.dumps(value), flush=True)
        raise SystemExit(1) from None
