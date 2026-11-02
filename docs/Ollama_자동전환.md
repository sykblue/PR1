# Gemini 한도 시 Ollama 자동 전환

사진 분석은 Gemini를 먼저 호출하고 **HTTP 429 / `upstream_quota`**인 경우에만 같은 요청을 로컬 Ollama 비전 모델로 한 번 이어서 처리한다. 각 새 요청은 다시 Gemini부터 시작한다. API 키·권한·네트워크 오류, 시간 초과, 잘못된 응답·관찰 불가 사진은 자동 전환하지 않는다. 유료 이미지 편집은 이 전환 대상에 포함하지 않는다.

## 로컬 준비

Ollama 설치·실행 후 사진 입력을 지원하는 모델을 준비한다. 기본 모델은 [공식 qwen2.5vl:3b](https://ollama.com/library/qwen2.5vl:3b)다. 기존 `qwen2.5:3b`, `qwen2.5:14b` 같은 텍스트 모델로 사진 관찰을 대신하지 않는다.

```powershell
ollama pull qwen2.5vl:3b
```

Ollama가 실행되지 않았다면 별도 터미널에서 `ollama serve`를 실행한다. 이미 앱으로 실행 중이면 중복 실행할 필요가 없다. 모델은 자동으로 다운로드하지 않는다. 기본값을 사용하면 기존 `.env`에 항목을 추가하지 않아도 되며 아래 값으로 변경할 수 있다.

```dotenv
ENABLE_OLLAMA_FALLBACK=true
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_ANALYSIS_MODEL=qwen2.5vl:3b
OLLAMA_API_TIMEOUT=120
```

설정을 바꾸면 Hairline Lab 서버도 재시작한다. `OLLAMA_BASE_URL`은 이 앱이 접속하는 주소이며 Ollama 자체의 바인딩 설정 `OLLAMA_HOST`와 구분한다. `ENABLE_OLLAMA_FALLBACK=false`이면 기존 Gemini 한도 오류를 반환한다.

## 요청과 결과

1. 기존 Google 전송 동의·사진 검증·부위·보조 데이터 동의를 적용한 뒤 Gemini를 호출한다.
2. 429 응답이면 Ollama `/api/show`로 설정 모델이 로컬 비전 모델인지 먼저 확인한다. 미설치·텍스트 전용·cloud 모델이면 사진 요청 전에 중단한다.
3. `/api/chat`에 메타데이터를 제거한 JPEG의 base64, 기존 관찰 지시·부위·동의한 보조 자료, 표준 JSON Schema, `stream=false`를 전송한다.
4. 기존 관찰 결과 검증을 동일하게 적용한다. 미완성·잘못된 JSON·규격 불일치는 보고서로 표시하지 않는다. 사진을 관찰할 수 없다는 응답은 기존과 같이 422로 처리한다.
5. 결과에 실제 `provider`·`model`과 `fallback_reason=gemini_quota`를 반환하고 화면에 로컬 전환을 표시한다. 기록 저장을 선택한 경우 이 메타데이터도 저장되며 원본 사진은 포함하지 않는다. 기존 저장 기록도 계속 열 수 있다.

로컬 주소는 HTTP의 `127.0.0.1`·`localhost`·`::1`만 허용하고 `localhost`는 접속 시 `127.0.0.1`로 고정한다. 프록시 설정·인증 정보 자동 읽기와 리다이렉트를 끄고 원격 모델 메타데이터를 거부한다. Gemini API 키는 Ollama에 전달하지 않는다. 사진이나 프롬프트를 앱 로그에 출력하지 않으며 모델 학습·영구 대화 기록을 이 코드에서 추가하지 않는다.

전환 전에 Gemini에 보낸 요청까지 로컬 전용이 되는 것은 아니다. 최초 Google 전송 동의는 계속 필요하다. Ollama 자체의 로컬 전용 설정은 [공식 FAQ](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features)를 참고한다.

## 대기·상태·오류

- 기본 Gemini 60초 + Ollama 120초에 여유 20초를 더해 브라우저 대기를 200초로 설정한다. `/api/status`의 `analysis_timeout_ms`로 현재 설정을 전달한다. 로컬 준비 조회와 생성은 같은 Ollama 대기 예산을 사용한다.
- `/api/status`의 `ollama_fallback_enabled`와 `ollama_model`은 설정 정보다. 모델 설치·GPU 준비·추론 성공을 보장하는 상태가 아니며 상태 조회만으로 모델을 불러오지 않는다.
- `ollama_model_missing`: 설정한 비전 모델을 `ollama pull`로 준비한다.
- `ollama_vision_required`: 이미지 입력을 지원하는 모델로 바꾼다.
- `ollama_connection` / `ollama_timeout`: Ollama 실행·주소·기기 성능·대기 설정을 확인한다.
- `ollama_local_model_required`: 내려받은 로컬 모델을 사용한다.
- `ollama_invalid_output`: 모델이 기존 분석 규격에 맞는 완전한 결과를 반환하지 못한 상태다. 임의의 결과로 채우지 않는다.

로컬 실패는 Gemini 한도에 도달했다는 사실과 로컬 실패 원인을 함께 안내한다. 같은 요청을 반복하거나 Gemini↔Ollama 간 무한 전환하지 않는다. 로컬 모델의 관찰 정확도·한국어 품질·임상 성능은 별도로 검증한 것이 아니다.

## 코드와 검증

`services/analysis.py`는 전환 규칙, `services/ollama.py`는 로컬 비전 API, `services/gemini.py`는 공통 관찰 지시·결과 검증을 제공한다. `app.py`에서 연결하고 `static/app.js`가 실제 사용 모델과 전환 안내·대기 시간을 표시한다. 새 SDK 의존성은 추가하지 않는다.

`tests/test_ollama.py`에서 429 전환·동의·저장 메타데이터·비전 확인·설정/응답 오류·로컬 경계·대기 예산·유료 편집 제외를 검증하고, `tests/analysis.test.cjs`에서 화면 표시·설정 대기를 확인한다. 모의 응답 검증과 실제 모델 추론 성공은 구분한다.

공식 API 근거: [사진 입력](https://docs.ollama.com/capabilities/vision), [Chat·JSON Schema](https://docs.ollama.com/api/chat), [구조화 응답](https://docs.ollama.com/capabilities/structured-outputs), [모델 정보](https://docs.ollama.com/api-reference/show-model-details).

## 이 개발 환경의 설치 확인 — 2026-10-30

- 사용자 요청으로 `ollama pull qwen2.5vl:3b`를 실행해 약 3.2GB를 설치했다. 다운로드의 SHA-256 검증과 manifest 기록이 완료됐으며 필요한 blob 파일이 모두 존재한다.
- 저장소는 `C:\Users\user\.ollama\models`다. 프로젝트 HTML에 가중치를 넣지 않으며 앱의 기본 모델 설정으로 연결한다. `/api/show`에서 `vision` 기능과 원격 모델이 아님을 확인했다.
- 실행 중인 앱은 자동 전환 활성화·`qwen2.5vl:3b`·기본 합산 대기 200초 설정을 사용한다. 모델을 매번 조회하므로 설치 후 앱 재시작은 필요하지 않았다.
- Google 한도만 모의로 발생시킨 별도 Flask 테스트에서 실제 Ollama로 합성 단색 이미지 한 장을 전송해 38.6초 후 HTTP 200과 기존 규격에 맞는 관찰 JSON을 받았다. Google API 호출·사용자 사진·기록 저장은 사용하지 않았다.
- 이 테스트는 설치·실제 추론·전환·응답 형식을 확인한다. 단색 테스트도 유효한 사진으로 응답했으므로 사진 적합성 판단과 관찰 내용의 정확성을 검증한 결과로 취급하지 않는다.
