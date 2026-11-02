"""Local vision analysis through Ollama's native JSON API (no cloud routing)."""
import json
import re
import time
from urllib.parse import urlsplit

import requests

from .errors import ServiceError
from .gemini import ANALYSIS_SCHEMA, SYSTEM_PROMPT, analysis_text, validate_analysis
from .observation import observation_image


def json_schema(value):
    # Gemini uses uppercase type names; Ollama expects standard JSON Schema.
    if isinstance(value, dict):
        return {key: item.lower() if key == "type" and isinstance(item, str) else json_schema(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [json_schema(item) for item in value]
    return value


LOCAL_ANALYSIS_SCHEMA = json_schema(ANALYSIS_SCHEMA)


class OllamaClient:
    provider = "ollama"

    def __init__(self, base_url="http://127.0.0.1:11434", model="qwen2.5vl:3b", timeout=120):
        self.model = model.strip()
        self.timeout = min(600, max(10, int(timeout)))
        self.base_url = ""
        try:
            url = urlsplit(base_url.strip())
            if (url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost", "::1"}
                    and not url.username and not url.password and not url.query and not url.fragment
                    and url.path in {"", "/"}):
                port = url.port or 11434
                if 1 <= port <= 65535:
                    host = "[::1]" if url.hostname == "::1" else "127.0.0.1"
                    self.base_url = f"http://{host}:{port}"
        except ValueError:
            pass

    def _post(self, session, path, payload, timeout):
        try:
            response = session.post(self.base_url + path, json=payload, timeout=(min(5, timeout), timeout),
                                    allow_redirects=False)
        except requests.Timeout:
            raise ServiceError("로컬 Ollama의 응답 시간이 길어졌어요. 모델과 기기 성능을 확인해 주세요.", 504, "ollama_timeout") from None
        except requests.RequestException:
            raise ServiceError("로컬 Ollama에 연결하지 못했어요. Ollama 실행 상태와 OLLAMA_BASE_URL을 확인해 주세요.", 503, "ollama_connection") from None
        try:
            if response.status_code == 404:
                raise ServiceError(f"Ollama 비전 모델이 없어요. 터미널에서 ollama pull {self.model} 실행 후 다시 분석해 주세요.",
                                   503, "ollama_model_missing")
            if response.status_code == 429:
                raise ServiceError("로컬 Ollama가 다른 요청을 처리하고 있어요. 잠시 후 다시 시도해 주세요.", 503, "ollama_busy")
            if response.status_code != 200:
                raise ServiceError("로컬 Ollama가 요청을 완료하지 못했어요. 모델과 서버 상태를 확인해 주세요.", 502, "ollama_error")
            try:
                data = response.json()
                if not isinstance(data, dict) or data.get("error"):
                    raise ValueError("Invalid response")
                return data
            except (ValueError, TypeError):
                raise ServiceError("로컬 Ollama 응답을 읽지 못했어요. 모델을 확인해 주세요.", 502, "ollama_invalid_output") from None
        finally:
            response.close()

    def analyze(self, image, ocr_text="", local_result=None, focus="all", scalp_result=None):
        texts = analysis_text(ocr_text, local_result, focus, scalp_result)
        if not self.base_url or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}", self.model):
            raise ServiceError("Ollama의 로컬 주소와 비전 모델 이름을 확인해 주세요.", 503, "ollama_not_configured")
        if "cloud" in self.model.lower().split(":")[-1]:
            raise ServiceError("로컬 분석에는 Ollama cloud 모델을 사용할 수 없어요. 내려받은 비전 모델을 설정해 주세요.",
                               503, "ollama_local_model_required")
        deadline = time.monotonic() + self.timeout
        with requests.Session() as session:
            # Ignore proxy/netrc settings and never follow redirects to other services.
            session.trust_env = False
            details = self._post(session, "/api/show", {"model": self.model}, min(5, self.timeout))
            if details.get("remote_host") or details.get("remote_model"):
                raise ServiceError("로컬에 내려받은 Ollama 비전 모델을 사용해 주세요.", 503, "ollama_local_model_required")
            capabilities = details.get("capabilities")
            if not isinstance(capabilities, list) or "vision" not in capabilities:
                raise ServiceError("설정된 Ollama 모델은 사진을 볼 수 없어요. qwen2.5vl:3b 같은 비전 모델을 준비해 주세요.",
                                   503, "ollama_vision_required")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ServiceError("로컬 Ollama 준비 시간이 초과됐어요. 다시 시도해 주세요.", 504, "ollama_timeout")
            data = self._post(session, "/api/chat", {
                "model": self.model, "stream": False,
                "messages": [{"role": "system", "content": SYSTEM_PROMPT},
                             {"role": "user", "content": "\n".join(texts) + "\nJSON 스키마:\n" + json.dumps(LOCAL_ANALYSIS_SCHEMA, ensure_ascii=False),
                              "images": [observation_image(image, max_side=1280)["inlineData"]["data"]]}],
                "format": LOCAL_ANALYSIS_SCHEMA, "options": {"temperature": .2, "num_predict": 4096},
            }, remaining)
        try:
            if data.get("done") is not True or data.get("done_reason") not in {None, "stop"}:
                raise ValueError("Incomplete response")
            result = validate_analysis(json.loads(data["message"]["content"]), require_evidence=True)
        except (ValueError, KeyError, TypeError):
            raise ServiceError("로컬 Ollama 결과 형식을 검증하지 못했어요. 비전 모델과 사진을 확인해 주세요.",
                               502, "ollama_invalid_output") from None
        if not result["image_usable"]:
            raise ServiceError("사진에서 모발 상태를 관찰하기 어려워요. 한 사람의 머리가 선명하게 보이는 사진을 올려 주세요.",
                               422, "photo_not_usable")
        return result

    def release(self):
        """Release this app's base model before a GPU training/inference worker."""
        if not self.base_url:
            return
        try:
            with requests.Session() as session:
                session.trust_env = False
                response = session.post(self.base_url + "/api/generate", json={"model": self.model, "keep_alive": 0},
                                        timeout=(2, 5), allow_redirects=False)
                response.close()
        except requests.RequestException:
            pass
