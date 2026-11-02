"""Try Gemini first and use local vision only for an explicit quota response."""
import logging

from .errors import ServiceError
from .observation import calibrate_observation

logger = logging.getLogger(__name__)


class AnalysisService:
    def __init__(self, gemini, ollama, fallback_enabled=True, scalp=None):
        self.gemini = gemini
        self.ollama = ollama
        self.fallback_enabled = fallback_enabled
        self.scalp = scalp

    def analyze(self, image, *, local_client=None, scalp_macro=False, **context):
        supplemental = {}
        if scalp_macro:
            if self.scalp is None:
                raise ServiceError("확대 두피 참고 모델이 준비되지 않았어요.", 503, "scalp_model_not_ready")
            reference = self.scalp.predict(image)
            context["scalp_result"] = reference
            supplemental["scalp_reference"] = reference
        try:
            result = self.gemini.analyze(image, **context)
            return {"result": calibrate_observation(result, context.get("focus", "all")), "provider": "gemini", "model": self.gemini.model, "fallback_reason": None, **supplemental}
        except ServiceError as error:
            if error.code != "upstream_quota" or not self.fallback_enabled:
                raise
        local_client = local_client if local_client is not None else self.ollama
        logger.info("Gemini quota reached; using local vision analysis")
        try:
            result = local_client.analyze(image, **context)
        except ServiceError as error:
            raise ServiceError("Gemini 한도에 도달했어요. " + error.message, error.status, error.code) from None
        provider = "local_adapter" if getattr(local_client, "provider", None) == "local_adapter" else "ollama"
        return {"result": calibrate_observation(result, context.get("focus", "all")), "provider": provider, "model": local_client.model, "fallback_reason": "gemini_quota", **supplemental}
