import importlib.util
import threading
from pathlib import Path

from PIL import Image

from .errors import ServiceError


class LocalInpainting:
    def __init__(self, enabled, model_path):
        self.enabled = enabled
        self.model_path = Path(model_path) if model_path else None
        self._pipeline = None
        self._lock = threading.Lock()

    @property
    def configured(self):
        return bool(self.enabled and self.model_path and self.model_path.is_dir()
                    and importlib.util.find_spec("torch") and importlib.util.find_spec("diffusers"))

    def generate(self, image, mask, scenario):
        if not self.configured:
            raise ServiceError("로컬 AI 편집은 CUDA GPU, 추가 패키지, 로컬 모델 경로 설정이 필요해요. README를 확인해 주세요.",
                               503, "inpainting_not_configured")
        if not self._lock.acquire(blocking=False):
            raise ServiceError("다른 AI 편집을 처리 중이에요. 완료 후 다시 시도해 주세요.", 429, "gpu_busy")
        try:
            import torch
            from diffusers import AutoPipelineForInpainting
            if not torch.cuda.is_available():
                raise ServiceError("사용 가능한 CUDA GPU를 찾지 못했어요.", 503, "gpu_unavailable")
            if self._pipeline is None:
                self._pipeline = AutoPipelineForInpainting.from_pretrained(
                    str(self.model_path), torch_dtype=torch.float16,
                    local_files_only=True, use_safetensors=True,
                ).to("cuda")
            scale = min(1.0, 512 / max(image.size))
            size = tuple(max(64, (int(d * scale) // 8) * 8) for d in image.size)
            base = image.resize(size, Image.Resampling.LANCZOS)
            region = Image.fromarray(mask).resize(size, Image.Resampling.NEAREST)
            description = {"hairline": "a naturally receded hairline with realistic forehead skin",
                           "crown": "a small thinning crown area with natural scalp skin",
                           "density": "sparse natural hair with subtle visible scalp"}[scenario]
            with torch.inference_mode():
                result = self._pipeline(prompt=f"portrait photo, {description}, realistic skin texture, same person and lighting",
                    negative_prompt="distorted face, disfigured, text, watermark, unnatural skin",
                    image=base, mask_image=region, width=size[0], height=size[1],
                    num_inference_steps=25, guidance_scale=7.0,
                    generator=torch.Generator(device="cuda").manual_seed(42))
            if getattr(result, "nsfw_content_detected", None) and any(result.nsfw_content_detected):
                raise ServiceError("이 사진의 편집 결과를 제공할 수 없어요.", 422, "generation_filtered")
            edited = result.images[0].convert("RGB").resize(image.size, Image.Resampling.LANCZOS)
            # Preserve all pixels outside the requested hair edit region.
            return Image.composite(edited, image, Image.fromarray(mask))
        except ServiceError:
            raise
        except Exception:
            raise ServiceError("로컬 AI 편집을 완료하지 못했어요. GPU 메모리와 모델 호환성을 확인해 주세요.",
                               503, "inpainting_failed") from None
        finally:
            self._lock.release()
