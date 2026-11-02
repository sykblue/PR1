"use strict";

const $ = (id) => document.getElementById(id);
const state = { file: null, originalUrl: null, overlay: null, overlayVisible: false,
  report: null, busy: false, toastTimer: null, analysisTimeout: 200000, scalpReady: false,
  identityVersion: 0, controller: null, selectionVersion: 0, trainingPhotoSaved: false };

function setWorkflow(stage) {
  const steps = ["photo", "settings", "report"];
  const index = steps.indexOf(stage === "working" ? "report" : stage);
  document.querySelectorAll("[data-analysis-step]").forEach((item) => {
    const itemIndex = steps.indexOf(item.dataset.analysisStep);
    item.classList.toggle("is-complete", itemIndex < index);
    if (itemIndex === index) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  });
}

function showMessage(id, message, info = false) {
  const target = $(id);
  target.textContent = message;
  target.classList.toggle("info", info);
  target.hidden = !message;
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
}

function syncPhotoStorage() {
  const input = $("save-photo");
  if (!input) return;
  input.disabled = state.busy || !window.HairlineAuth.user || !$("save-history").checked;
  if (!window.HairlineAuth.user || !$("save-history").checked) input.checked = false;
}

function busy(button, active, text) {
  state.busy = active;
  document.body.classList.toggle("busy", active);
  for (const id of ["analyze-button", "segment-button", "open-simulation", "photo-input", "dropzone", "change-photo", "photo-reset", "local-classify-button", "share-local-result"]) {
    $(id).disabled = active;
  }
  document.querySelectorAll('input[name="analysis-focus"]').forEach((el) => { el.disabled = active; });
  if ($("scalp-macro")) $("scalp-macro").disabled = active || !state.scalpReady;
  $("camera-open").disabled = active;
  $("save-history").disabled = active || !window.HairlineAuth.user;
  syncPhotoStorage();
  syncPhotoTraining();
  if (active) {
    button.dataset.originalLabel = button.querySelector("span").textContent;
    button.querySelector("span").textContent = text;
    button.querySelectorAll("svg").forEach((icon) => { icon.setAttribute("hidden", ""); });
    const spinner = document.createElement("i");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    button.prepend(spinner);
    button.setAttribute("aria-busy", "true");
  } else {
    button.querySelector("span").textContent = button.dataset.originalLabel;
    button.querySelector(".spinner")?.remove();
    button.querySelectorAll("svg").forEach((icon) => { icon.removeAttribute("hidden"); });
    button.removeAttribute("aria-busy");
  }
}

async function api(path, fields = {}, timeout = 90000) {
  const version = state.identityVersion;
  const body = new FormData();
  if (state.file) body.append("photo", state.file);
  for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
  const controller = new AbortController();
  state.controller = controller;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = await window.HairlineAuth.headers();
    if (version !== state.identityVersion) throw new Error("account_changed");
    const response = await fetch(path, { method: "POST", body, headers, signal: controller.signal });
    let result;
    try { result = await response.json(); } catch { throw new Error("서버 응답을 읽지 못했어요. Python 서버 주소로 접속했는지 확인해 주세요."); }
    if (version !== state.identityVersion) throw new Error("account_changed");
    if (response.status === 401) document.dispatchEvent(new CustomEvent("auth-required"));
    if (!response.ok) throw new Error(result.error?.message || "요청을 완료하지 못했어요.");
    return result;
  } catch (error) {
    if (version !== state.identityVersion) {
      const stale = new Error("계정이 변경되어 요청을 중단했어요."); stale.name = "AccountChangedError"; throw stale;
    }
    if (error.name === "AbortError") throw new Error("처리 시간이 길어졌어요. 서버 상태를 확인한 뒤 다시 시도해 주세요.");
    if (error instanceof TypeError) throw new Error("서버에 연결하지 못했어요. 로컬 Python 서버가 실행 중인지 확인해 주세요.");
    throw error;
  } finally { clearTimeout(timer); if (state.controller === controller) state.controller = null; }
}

function clearReport() {
  state.report = null;
  window.HairlineRecommendations?.reset();
  for (const id of ["result-summary", "observations", "limitations", "next-steps", "analysis-meta", "signal-tag"]) $(id).replaceChildren();
  $("report-content").hidden = true;
  $("report-loading").hidden = true;
  $("report-empty").hidden = false;
  $("report-tag").textContent = "분석 전";
  $("report-tag").className = "tag neutral";
  if ($("report-panel")) $("report-panel").scrollTop = 0;
  if ($("report-details")) $("report-details").scrollTop = 0;
  setWorkflow(state.file ? "settings" : "photo");
}

function revealReport(behavior = "smooth") {
  // All three panels are already visible in the desktop workspace.
  if (window.matchMedia?.("(min-width: 992px) and (min-height: 600px)").matches) return;
  $("report-panel").scrollIntoView({
    behavior: behavior === "auto" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start",
  });
}

function resetPhoto(force = false) {
  if (state.busy && force !== true) return;
  state.selectionVersion++;
  if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
  state.file = null;
  state.originalUrl = null;
  state.overlay = null;
  state.overlayVisible = false;
  state.trainingPhotoSaved = false;
  $("photo-input").value = "";
  $("photo-name").textContent = $("photo-meta").textContent = "";
  $("photo-preview").removeAttribute("src");
  $("photo-view").hidden = true;
  $("photo-toolbar").hidden = true;
  $("dropzone").hidden = false;
  $("segmentation-info").hidden = true;
  $("consent").checked = false;
  $("save-history").checked = false;
  if ($("save-photo")) $("save-photo").checked = false;
  syncPhotoStorage();
  $("segmentation-text").textContent = "";
  $("share-local-result").checked = false;
  if ($("scalp-macro")) $("scalp-macro").checked = false;
  $("photo-training-auto-save").checked = false;
  $("photo-training-label").value = "";
  $("local-prediction").hidden = true;
  $("local-prediction").textContent = "";
  if ($("photo-checks")) $("photo-checks").hidden = true;
  clearReport();
  showMessage("analysis-message", "");
  showMessage("photo-training-message", "");
  syncPhotoTraining();
  syncSimulationLink();
}

async function selectPhoto(file) {
  if (!file || state.busy) return;
  const version = ++state.selectionVersion;
  showMessage("analysis-message", "");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    showMessage("analysis-message", "JPG, PNG, WEBP 사진만 사용할 수 있어요."); return;
  }
  if (file.size > 10 * 1024 * 1024) { showMessage("analysis-message", "10MB 이하 사진을 선택해 주세요."); return; }
  const nextUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = nextUrl;
    await image.decode();
    if (Math.min(image.naturalWidth, image.naturalHeight) < 160 || image.naturalWidth * image.naturalHeight > 20000000) {
      throw new Error("가로·세로 160px 이상, 전체 20MP 이하 사진을 선택해 주세요.");
    }
  } catch (error) {
    URL.revokeObjectURL(nextUrl);
    if (version !== state.selectionVersion) return;
    showMessage("analysis-message", error instanceof DOMException ? "사진을 읽을 수 없어요. 다른 파일을 선택해 주세요." : error.message);
    return;
  }
  if (version !== state.selectionVersion || state.busy) { URL.revokeObjectURL(nextUrl); return; }
  resetPhoto();
  state.file = file;
  state.originalUrl = nextUrl;
  $("dropzone").hidden = true;
  $("photo-view").hidden = false;
  $("photo-toolbar").hidden = false;
  $("photo-preview").src = nextUrl;
  $("photo-view-label").textContent = "원본 사진";
  $("photo-name").textContent = file.name;
  $("photo-meta").textContent = `${image.naturalWidth} × ${image.naturalHeight}px · ${(file.size / 1024 / 1024).toFixed(2)}MB`;
  if (window.HairlineAnalysisTools && $("photo-checks")) {
    const checks = window.HairlineAnalysisTools.inspectPhoto(image);
    $("photo-check-resolution").textContent = checks.resolution;
    $("photo-check-light").textContent = checks.light;
    $("photo-check-note").textContent = checks.note;
    $("photo-checks").dataset.tone = checks.attention ? "attention" : "neutral";
    $("photo-checks").hidden = false;
  }
  setWorkflow("settings");
  syncPhotoTraining();
  syncSimulationLink();
  toast("사진을 선택했어요. 분석이나 로컬 영역 확인을 시작할 수 있어요.");
}

function syncPhotoTraining() {
  const user = window.HairlineAuth.user;
  const locked = state.busy || !user || state.trainingPhotoSaved;
  $("photo-training-login").hidden = !!user;
  for (const id of ["photo-training-label", "photo-training-group", "photo-training-auto-save", "photo-training-auto-train"]) $(id).disabled = locked;
  $("photo-training-save").disabled = locked || !state.file;
  $("photo-training-folder").textContent = user
    ? `저장 위치: data/training/users/${user.id}/학습/ · 학습 페이지에서 삭제할 수 있어요.`
    : "저장을 선택한 사진은 내 계정의 학습 폴더에 보관돼요.";
}

function photoTrainingFields() {
  if (!window.HairlineAuth.user) throw new Error("로그인 후 사진을 학습용으로 저장해 주세요.");
  if (!state.file) throw new Error("먼저 촬영하거나 사진을 선택해 주세요.");
  const label = $("photo-training-label").value, group = $("photo-training-group").value.trim();
  if (!["reference", "concern"].includes(label)) throw new Error("학습에 사용할 사진 라벨을 직접 선택해 주세요.");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(group)) throw new Error("p001 같은 익명 그룹 코드를 입력해 주세요. 같은 사람은 같은 코드를 사용해 주세요.");
  return { label, group, source: "analysis", storage_consent: true,
    train_if_ready: $("photo-training-auto-train").checked };
}

async function storeTrainingPhoto(fields) {
  showMessage("photo-training-message", "사진을 저장하고 로컬 학습 상태를 확인하고 있어요.", true);
  const data = await api("/api/training/add", fields, 120000);
  state.trainingPhotoSaved = true;
  $("photo-training-auto-save").checked = false;
  document.dispatchEvent(new CustomEvent("training-updated"));
  let message = `학습 폴더에 사진을 저장했어요. 내 학습 사진은 총 ${data.status.total}장이에요.`;
  if (data.auto_training === "completed") message += " 로컬 분류기도 학습했어요.";
  else if (data.auto_training === "needs_data") message += " 각 라벨 5장·사람 그룹 2개 이상, 전체 4개 그룹이 모이면 학습할 수 있어요.";
  else if (data.auto_training === "failed") message += ` ${data.training_error}`;
  else message += " 로컬 학습 페이지에서 분류기를 학습해 주세요.";
  showMessage("photo-training-message", message, data.auto_training !== "failed");
  syncPhotoTraining();
  return data;
}

async function savePhotoForTraining() {
  if (state.busy || state.trainingPhotoSaved) return;
  let fields;
  try { fields = photoTrainingFields(); }
  catch (error) { showMessage("photo-training-message", error.message); return; }
  busy($("photo-training-save"), true, "사진 저장 · 학습 중");
  try { await storeTrainingPhoto(fields); }
  catch (error) { if (error.name !== "AccountChangedError") showMessage("photo-training-message", error.message); }
  finally { busy($("photo-training-save"), false); }
}

function listItems(id, items) {
  $(id).replaceChildren(...items.map((text) => {
    const li = document.createElement("li"); li.textContent = text; return li;
  }));
}

function renderReport(data) {
  state.report = data;
  const { result } = data;
  const signals = {
    not_obvious: [result.visual_evidence ? "모발 사이 두피 노출이 뚜렷하지 않아요" : "두피 노출이 뚜렷하지 않아요", "blue"],
    visible: [result.visual_evidence ? "모발 사이 두피 노출이 관찰돼요" : "두피 노출이 관찰돼요", "warning"],
    unclear: ["사진에서 판단하기 어려워요", "neutral"],
  };
  const [label, tone] = signals[result.visible_signal];
  $("signal-tag").textContent = label;
  $("signal-tag").className = `tag ${tone}`;
  $("result-summary").textContent = result.summary;
  const observations = window.HairlineAnalysisTools?.observationRows ? window.HairlineAnalysisTools.observationRows(result, data.scalp_reference) : result.observations;
  $("observations").replaceChildren(...observations.map((item, index) => {
    const row = document.createElement("div"); row.className = "observation";
    const number = document.createElement("span"); number.className = "observation-number"; number.textContent = String(index + 1).padStart(2, "0");
    const body = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = item.area;
    const detail = document.createElement("p"); detail.textContent = item.detail;
    body.append(title, detail); row.append(number, body); return row;
  }));
  listItems("limitations", result.limitations);
  listItems("next-steps", result.next_steps);
  window.HairlineRecommendations?.render(data);
  const supplements = [];
  if (data.supplemental?.ocr_characters) supplements.push(`보조 텍스트 ${data.supplemental.ocr_characters}자 참고`);
  if (data.supplemental?.local_result) supplements.push("로컬 분류 참고");
  if (data.scalp_reference) supplements.push("확대 두피 학습 참고");
  const modelLabel = data.provider === "local_adapter" ? `학습한 로컬 모델 · ${data.model}` : data.provider === "ollama" ? `Ollama · ${data.model}` : data.model;
  $("analysis-meta").textContent = `${modelLabel} · ${(data.elapsed_ms / 1000).toFixed(1)}초${supplements.length ? " · " + supplements.join(" · ") : ""}${data.fallback_reason === "gemini_quota" ? " · Gemini 한도로 로컬 전환" : ""}`;
  $("report-empty").hidden = true;
  $("report-content").hidden = false;
  $("report-tag").textContent = "관찰 완료";
  $("report-tag").className = "tag blue";
  if (data.focus && window.HairlineAnalysisTools?.focusLabels[data.focus]) $("analysis-meta").textContent += ` · ${window.HairlineAnalysisTools.focusLabels[data.focus]}`;
  setWorkflow("report");
}

async function analyze() {
  if (state.busy) return;
  showMessage("analysis-message", "");
  if (!state.file) { showMessage("analysis-message", "먼저 분석할 사진을 선택해 주세요."); $("dropzone").focus(); return; }
  if (!$("consent").checked) { showMessage("analysis-message", "AI 분석을 시작하려면 사진의 Google Gemini 전송에 동의해 주세요."); $("consent").focus(); return; }
  const version = state.identityVersion;
  let trainingFields = null;
  if ($("photo-training-auto-save").checked && !state.trainingPhotoSaved) {
    try { trainingFields = photoTrainingFields(); }
    catch (error) { $("analysis-extra-settings").open = true; $("photo-training").open = true; showMessage("photo-training-message", error.message); $("photo-training-label").focus(); return; }
  }
  clearReport();
  busy($("analyze-button"), true, "AI가 관찰하고 있어요");
  $("report-empty").hidden = true;
  $("report-loading").hidden = false;
  $("report-tag").textContent = "분석 중";
  setWorkflow("working");
  $("report-panel")?.setAttribute("aria-busy", "true");
  try {
    const focus = document.querySelector?.('input[name="analysis-focus"]:checked')?.value || "all";
    const data = await api("/api/analyze", { consent: true, focus,
      share_local_result: $("share-local-result").checked,
      scalp_macro: $("scalp-macro")?.checked === true,
      save_history: $("save-history").checked,
      save_photo: $("save-photo")?.checked === true && $("save-history").checked }, state.analysisTimeout);
    renderReport(data);
    revealReport();
    if (data.history_id) document.dispatchEvent(new CustomEvent("report-saved"));
    if (data.history_error) showMessage("analysis-message", data.history_error);
    else if (data.fallback_reason === "gemini_quota") showMessage("analysis-message", data.provider === "local_adapter" ? "Gemini 호출 한도에 도달해 내가 학습한 로컬 모델로 관찰했어요." : "Gemini 호출 한도에 도달해 이 컴퓨터의 Ollama로 관찰했어요.", true);
    toast(data.history_id ? (data.photo ? "사진과 리포트를 내 기록에 저장했어요." : "리포트를 내 기록에 저장했어요.") : "사진 관찰 리포트가 준비됐어요.");
  } catch (error) {
    if (error.name === "AccountChangedError") return;
    clearReport();
    showMessage("analysis-message", error.message);
    revealReport("auto");
  } finally {
    $("report-loading").hidden = true;
    $("report-panel")?.removeAttribute("aria-busy");
    // Observe/classify before learning from this photo. Local saving remains
    // available even when the Gemini request fails or its quota is exhausted.
    if (trainingFields && version === state.identityVersion && state.file && !state.trainingPhotoSaved) {
      try { await storeTrainingPhoto(trainingFields); }
      catch (error) { if (error.name !== "AccountChangedError") showMessage("photo-training-message", `학습 사진을 저장하지 못했어요. ${error.message}`); }
    }
    busy($("analyze-button"), false);
  }
}

async function classifyLocally() {
  if (state.busy) return;
  if (!state.file) { showMessage("analysis-message", "먼저 분류할 사진을 선택해 주세요."); return; }
  busy($("local-classify-button"), true, "로컬 분류 중");
  showMessage("analysis-message", "");
  try {
    const data = await api("/api/classify");
    $("local-prediction").textContent = `로컬 분류: ${data.result.label_name}. ${data.result.notice}`;
    $("local-prediction").hidden = false;
    $("analysis-assistance").open = true;
  } catch (error) { if (error.name !== "AccountChangedError") showMessage("analysis-message", error.message); }
  finally { busy($("local-classify-button"), false); }
}

async function segment() {
  if (state.busy) return;
  showMessage("analysis-message", "");
  if (!state.file) { showMessage("analysis-message", "먼저 모발 영역을 확인할 사진을 선택해 주세요."); return; }
  busy($("segment-button"), true, "머리카락 영역을 찾고 있어요");
  try {
    const data = await api("/api/segment");
    state.overlay = data.overlay;
    state.overlayVisible = true;
    $("photo-preview").src = data.overlay;
    $("photo-view-label").textContent = "MediaPipe 모발 영역";
    $("segmentation-info").hidden = false;
    $("segmentation-text").textContent = `사진 전체 중 모발로 분할된 면적 ${data.hair_area_percent}% · ${data.elapsed_ms}ms. 촬영 범위에 따라 달라지며, 모발 밀도나 탈모 비율이 아니에요.`;
    $("toggle-overlay").textContent = "원본 보기";
    toast("파란색으로 표시된 부분이 모델이 찾은 모발 영역이에요.");
  } catch (error) { if (error.name !== "AccountChangedError") showMessage("analysis-message", error.message); }
  finally { busy($("segment-button"), false); }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadStatus() {
  try {
    const response = await fetch("/api/status", { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("status");
    const data = await response.json();
    if (Number.isFinite(data.analysis_timeout_ms) && data.analysis_timeout_ms >= 10000 && data.analysis_timeout_ms <= 900000) state.analysisTimeout = data.analysis_timeout_ms;
    state.scalpReady = data.scalp_reference?.ready === true;
    if ($("scalp-macro")) $("scalp-macro").disabled = !state.scalpReady || state.busy;
    if ($("scalp-assist-status")) $("scalp-assist-status").textContent = data.scalp_reference?.ready === true ? "학습된 확대 두피 참고 모델을 사용할 수 있어요." : "확대 두피 참고 모델을 준비한 뒤 사용할 수 있어요.";
    $("ollama-fallback-notice").hidden = data.ollama_fallback_enabled !== true;
    $("service-state").replaceChildren();
    const dot = document.createElement("span"); dot.className = `status-dot${data.analysis_ready ? "" : " warning"}`;
    $("service-state").append(dot, document.createTextNode(data.analysis_ready ? "AI 분석 연결 준비" : "로컬 준비 · AI 키 필요"));
    const rows = [
      ["tech-gemini", data.analysis_ready, "설정됨", "API 키 필요"],
      ["tech-mediapipe", data.segmentation_ready, "사용 가능", "모델 설치 필요"],
      ["tech-opencv", data.opencv_ready, "사용 가능", "설치 필요"],
      ["tech-sd", data.sd_configured, "설정됨 · GPU 확인 필요", "선택 · 설정 필요"],
      ["tech-image", data.paid_image_ready, "설정됨 · 유료", "선택 · 기본 비활성"],
    ];
    for (const [id, ready, yes, no] of rows) {
      if (!$(id)) continue;
      $(id).textContent = ready ? yes : no;
      $(id).className = ready ? "ready-text" : "pending-text";
    }
    if (data.analysis_model !== "gemini-2.5-flash" && $("tech-gemini")) $("tech-gemini").closest("tr").querySelector("th").textContent = `Gemini · ${data.analysis_model}`;
  } catch {
    $("service-state").textContent = "Python 서버 연결 필요";
    ["tech-gemini", "tech-mediapipe", "tech-opencv", "tech-sd", "tech-image"].forEach((id) => { if ($(id)) $(id).textContent = "서버 연결 필요"; });
    showMessage("analysis-message", "Python 서버를 실행하고 http://127.0.0.1:8000 으로 접속해 주세요. Live Server에서는 분석 API를 실행할 수 없어요.");
  }
}

$("dropzone").addEventListener("click", () => $("photo-input").click());
$("change-photo").addEventListener("click", () => $("photo-input").click());
$("photo-input").addEventListener("change", (event) => selectPhoto(event.target.files[0]));
$("photo-reset").addEventListener("click", () => resetPhoto());
for (const eventName of ["dragenter", "dragover"]) $("dropzone").addEventListener(eventName, (event) => { event.preventDefault(); if (!state.busy) $("dropzone").classList.add("dragover"); });
for (const eventName of ["dragleave", "drop"]) $("dropzone").addEventListener(eventName, (event) => { event.preventDefault(); $("dropzone").classList.remove("dragover"); });
$("dropzone").addEventListener("drop", (event) => selectPhoto(event.dataTransfer.files[0]));
$("analyze-button").addEventListener("click", analyze);
$("photo-training-save").addEventListener("click", savePhotoForTraining);
$("local-classify-button").addEventListener("click", classifyLocally);
document.addEventListener("training-updated", () => { $("local-prediction").hidden = true; $("share-local-result").checked = false; });
$("segment-button").addEventListener("click", segment);
$("toggle-overlay").addEventListener("click", () => { state.overlayVisible = !state.overlayVisible; $("photo-preview").src = state.overlayVisible ? state.overlay : state.originalUrl; $("photo-view-label").textContent = state.overlayVisible ? "MediaPipe 모발 영역" : "원본 사진"; $("toggle-overlay").textContent = state.overlayVisible ? "원본 보기" : "모발 영역 보기"; });
document.querySelectorAll('input[name="analysis-focus"]').forEach((radio) => radio.addEventListener("change", clearReport));
$("download-report").addEventListener("click", () => {
  if (state.report) saveBlob(new Blob([JSON.stringify({ ...state.report, exported_at: new Date().toISOString(),
    notice: "사진 기반 참고 관찰이며 의료 진단이 아닙니다." }, null, 2)], { type: "application/json;charset=utf-8" }), "hairline-lab-report.json");
});
$("copy-report").addEventListener("click", async () => {
  if (!state.report || !window.HairlineAnalysisTools) return;
  try {
    await navigator.clipboard.writeText(window.HairlineAnalysisTools.reportText(state.report));
    toast("리포트 내용을 복사했어요.");
  } catch { showMessage("analysis-message", "복사를 사용할 수 없어요. ‘텍스트 저장’으로 리포트를 저장해 주세요.", true); }
});
$("export-report-text").addEventListener("click", () => {
  if (state.report && window.HairlineAnalysisTools) saveBlob(new Blob(["\ufeff", window.HairlineAnalysisTools.reportText(state.report)], { type: "text/plain;charset=utf-8" }), "hairline-lab-report.txt");
});
document.addEventListener("auth-changed", () => {
  state.identityVersion++;
  state.controller?.abort();
  resetPhoto(true);
  document.querySelectorAll('input[name="analysis-focus"]').forEach((radio) => { radio.checked = radio.value === "all"; });
  $("analysis-assistance").open = false;
  $("analysis-extra-settings").open = false;
  $("photo-training-label").value = $("photo-training-group").value = "";
  $("photo-training").open = false;
  $("toast").hidden = true;
  clearTimeout(state.toastTimer);
});
document.addEventListener("history-selected", (event) => {
  if (state.busy) { toast("진행 중인 작업이 끝난 뒤 기록을 다시 열어 주세요."); return; }
  resetPhoto();
  renderReport(event.detail);
  $("report-tag").textContent = "저장된 기록";
  $("analysis-meta").textContent += ` · ${new Date(event.detail.created_at).toLocaleString("ko-KR")}`;
  const photo = event.detail.photo;
  if (photo && /^[a-f0-9]{32}$/.test(photo.id)) {
    $("photo-preview").src = `/api/photos/${photo.id}/image`;
    $("photo-view").hidden = false;
    $("photo-toolbar").hidden = false;
    $("dropzone").hidden = true;
    $("photo-view-label").textContent = "저장한 사진";
    $("photo-name").textContent = "함께 저장한 분석 사진";
    $("photo-meta").textContent = `${photo.width} × ${photo.height}px`;
    showMessage("analysis-message", "사진과 함께 저장된 리포트예요. 새로운 분석에는 사진을 다시 선택해 주세요.", true);
  } else {
    showMessage("analysis-message", "저장된 리포트예요. 함께 저장한 사진은 없어요.", true);
  }
  revealReport();
});

async function loadSavedReport() {
  if (!window.location?.search) return;
  const value = new URLSearchParams(window.location.search).get("report");
  if (value === null) return;
  const identifier = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(identifier) || identifier > 2147483647) {
    showMessage("analysis-message", "기록 주소를 확인하고 ‘내 기록’에서 다시 열어 주세요."); return;
  }
  if (!window.HairlineAuth.user) { window.HairlineAuth.open(); return; }
  const identity = state.identityVersion, selection = state.selectionVersion;
  showMessage("analysis-message", "저장된 리포트를 불러오고 있어요.", true);
  try {
    const response = await fetch(`/api/history/${identifier}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    const report = await response.json();
    if (identity !== state.identityVersion || selection !== state.selectionVersion || state.busy) return;
    if (response.status === 401) { window.HairlineAuth.open(); return; }
    if (!response.ok) throw new Error(report.error?.message || "리포트를 불러오지 못했어요.");
    document.dispatchEvent(new CustomEvent("history-selected", { detail: report }));
  } catch (error) { if (identity === state.identityVersion && selection === state.selectionVersion) showMessage("analysis-message", error.message || "리포트를 불러오지 못했어요. 내 기록에서 다시 시도해 주세요."); }
}

function syncSimulationLink() {
  $("open-simulation").querySelector("span").textContent = "변화 비교";
  $("handoff-note").hidden = !state.file;
}
$("open-simulation").addEventListener("click", async (event) => {
  if (state.busy) { event.preventDefault(); return; }
  if (!state.file) return;
  event.preventDefault();
  const version = state.identityVersion, file = state.file;
  busy($("open-simulation"), true, "사진을 준비하고 있어요");
  let token;
  try {
    await window.HairlineAuth.ready;
    token = await window.HairlinePhotoHandoff.put(file, window.HairlineAuth.user?.id ?? null);
    if (version !== state.identityVersion || file !== state.file) {
      await window.HairlinePhotoHandoff.remove(token); return;
    }
    window.location.assign("/simulation?photo=" + encodeURIComponent(token));
  } catch {
    showMessage("analysis-message", "사진을 옮기지 못했어요. 변화 미리보기 페이지에서 사진을 직접 선택해 주세요.");
  } finally { busy($("open-simulation"), false); syncSimulationLink(); }
});
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });

syncPhotoTraining();
$("scalp-macro")?.addEventListener("change", () => { if (!state.busy) clearReport(); });
$("save-history").addEventListener("change", syncPhotoStorage);
syncPhotoStorage();
window.HairlineAuth.ready.then(syncPhotoTraining).catch(() => {});
const initialReport = window.HairlineAuth.ready.then(loadSavedReport).catch(() => {});
window.HairlinePage?.track(initialReport);
const initialAnalysisStatus = loadStatus();
window.HairlinePage?.track(initialAnalysisStatus);
