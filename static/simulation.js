"use strict";

const $ = (id) => document.getElementById(id);
const preview = { file: null, url: null, generated: null, busy: false, selection: 0, identity: 0,
  request: 0, controller: null, view: "split", available: {}, toastTimer: null };
const scenarioNames = { hairline: "헤어라인", crown: "정수리", density: "모발 분포" };
const providerNames = { opencv: "로컬 간단 편집", sd: "로컬 AI 편집", gemini: "Google AI 편집" };
const providerDescriptions = {
  opencv: "사진을 외부로 보내지 않고 간단히 합성해요. 경계나 피부색이 부자연스러울 수 있어요.",
  sd: "이 컴퓨터의 AI 모델로 편집해요. 생성에 시간이 걸리고 원본의 다른 부분도 달라질 수 있어요.",
  gemini: "사진을 Google로 보내 편집해요. 요청마다 비용이 발생할 수 있고 다른 부분도 달라질 수 있어요."
};
function message(text = "", info = false) {
  $("simulation-message").textContent = text;
  $("simulation-message").hidden = !text;
  $("simulation-message").classList.toggle("info", info);
}
function toast(text) {
  clearTimeout(preview.toastTimer);
  $("toast").textContent = text;
  $("toast").hidden = false;
  preview.toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
}
function scenario() { return document.querySelector('input[name="scenario"]:checked').value; }
function syncControls() {
  for (const id of ["photo-input", "dropzone", "change-photo", "photo-reset", "camera-open", "provider", "strength", "simulation-consent", "paid-consent"]) $(id).disabled = preview.busy;
  document.querySelectorAll('input[name="scenario"], [data-strength]').forEach((item) => { item.disabled = preview.busy; });
  document.querySelectorAll("[data-view]").forEach((item) => { item.disabled = preview.busy || !preview.generated; });
  $("simulate-button").disabled = preview.busy || !preview.file || !preview.available[$("provider").value];
  $("download-image").disabled = preview.busy || !preview.generated;
  $("reset-comparison").disabled = preview.busy || !preview.generated;
  $("compare-slider").disabled = preview.busy || !preview.generated;
  $("preview-loading").hidden = !preview.busy;
  $("preview-canvas").setAttribute("aria-busy", String(preview.busy));
  $("simulate-button").setAttribute("aria-busy", String(preview.busy));
  $("simulate-label").textContent = preview.busy ? "가상 이미지를 만들고 있어요" : "변화 미리보기 만들기";
  document.body.classList.toggle("busy", preview.busy);
}
function splitAt(value) {
  $("compare-slider").value = String(value);
  $("comparison").style.setProperty("--split", value + "%");
}
function view(mode) {
  preview.view = mode === "side" ? "side" : "split";
  $("comparison").hidden = !preview.file || (!!preview.generated && preview.view === "side");
  $("side-comparison").hidden = !preview.generated || preview.view !== "side";
  $("slider-controls").hidden = !!preview.generated && preview.view === "side";
  document.querySelectorAll("[data-view]").forEach((item) => item.setAttribute("aria-pressed", String(item.dataset.view === preview.view)));
}
function clearResult() {
  preview.generated = null;
  for (const id of ["compare-after", "side-after"]) { $(id).removeAttribute("src"); $(id).hidden = true; }
  $("compare-divider").hidden = $("compare-labels").hidden = true;
  $("preview-result-state").textContent = preview.file ? "설정 준비" : "사진 대기";
  $("preview-result-state").className = "tag neutral";
  $("result-setting").textContent = preview.file ? "원본 사진을 준비했어요" : "아직 만든 미리보기가 없어요";
  $("simulation-meta").textContent = preview.file ? "원하는 부위와 강도를 선택해 가상 편집을 시작해 보세요." : "사진을 선택하고 원하는 변화를 만들어 보세요.";
  $("compare-hint").textContent = "미리보기가 완성되면 슬라이더로 비교할 수 있어요.";
  splitAt(50);
  view("split");
  syncControls();
}
function cancelRequest() {
  preview.request++;
  preview.controller?.abort();
  preview.controller = null;
  preview.busy = false;
}
function resetPhoto(force = false) {
  if (preview.busy && !force) return;
  cancelRequest();
  preview.selection++;
  if (preview.url) URL.revokeObjectURL(preview.url);
  preview.file = preview.url = null;
  $("photo-input").value = "";
  $("photo-preview").removeAttribute("src");
  for (const id of ["compare-before", "side-before"]) $(id).removeAttribute("src");
  $("photo-selected").hidden = true;
  $("dropzone").hidden = false;
  $("comparison-empty").hidden = false;
  $("simulation-consent").checked = $("paid-consent").checked = false;
  clearResult();
  message();
}
async function selectPhoto(file) {
  if (!file || preview.busy) return;
  const selection = ++preview.selection;
  message();
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { message("JPG, PNG, WEBP 사진만 사용할 수 있어요."); return; }
  if (!file.size || file.size > 10 * 1024 * 1024) { message("내용이 있는 10MB 이하 사진을 선택해 주세요."); return; }
  const url = URL.createObjectURL(file), image = new Image();
  try {
    image.src = url;
    await image.decode();
    if (Math.min(image.naturalWidth, image.naturalHeight) < 160 || image.naturalWidth * image.naturalHeight > 20000000) throw new Error("가로·세로 160px 이상, 전체 20MP 이하 사진을 선택해 주세요.");
  } catch (error) {
    URL.revokeObjectURL(url);
    if (selection === preview.selection) message(error instanceof DOMException ? "사진을 읽지 못했어요. 다른 사진을 선택해 주세요." : error.message);
    return;
  }
  if (selection !== preview.selection || preview.busy) { URL.revokeObjectURL(url); return; }
  resetPhoto();
  preview.file = file; preview.url = url;
  $("photo-name").textContent = file.name || "분석에서 가져온 사진";
  $("photo-name").title = file.name || "분석에서 가져온 사진";
  $("photo-meta").textContent = image.naturalWidth + " × " + image.naturalHeight + "px · " + (file.size / 1024 / 1024).toFixed(2) + "MB";
  for (const id of ["photo-preview", "compare-before", "side-before"]) $(id).src = url;
  $("photo-selected").hidden = false;
  $("dropzone").hidden = true;
  $("comparison-empty").hidden = true;
  clearResult();
}
function settingChanged() {
  clearResult();
  message();
}
function strengthChanged(value) {
  $("strength").value = String(value);
  $("strength-value").textContent = String(value);
  document.querySelectorAll("[data-strength]").forEach((item) => item.setAttribute("aria-pressed", String(item.dataset.strength === String(value))));
  settingChanged();
}
function providerChanged() {
  const provider = $("provider").value;
  $("provider-description").textContent = providerDescriptions[provider];
  $("google-consents").hidden = provider !== "gemini";
  $("simulation-consent").checked = $("paid-consent").checked = false;
  settingChanged();
}
async function simulate() {
  if (preview.busy) return;
  message();
  if (!preview.file) { message("먼저 사진을 선택해 주세요."); return; }
  const provider = $("provider").value;
  if (!preview.available[provider]) { message("선택한 편집 방식이 준비되지 않았어요. 사용 가능한 방식을 선택해 주세요."); return; }
  if (provider === "gemini" && (!$("simulation-consent").checked || !$("paid-consent").checked)) {
    message("사진의 Google 전송과 이미지 생성 비용을 모두 확인해 주세요."); return;
  }
  const body = new FormData(), chosenScenario = scenario(), strength = $("strength").value;
  body.append("photo", preview.file);
  for (const [key, value] of Object.entries({ provider, scenario: chosenScenario, strength,
    consent: provider === "gemini" && $("simulation-consent").checked, paid_consent: provider === "gemini" && $("paid-consent").checked })) body.append(key, String(value));
  clearResult();
  const request = ++preview.request, identity = preview.identity;
  const controller = new AbortController();
  preview.controller = controller;
  preview.busy = true;
  syncControls();
  $("preview-result-state").textContent = "편집 중";
  const timer = setTimeout(() => controller.abort(), provider === "sd" ? 300000 : 120000);
  try {
    const headers = await window.HairlineAuth.headers();
    if (identity !== preview.identity || request !== preview.request) return;
    const response = await fetch("/api/simulate", { method: "POST", body, headers, signal: controller.signal });
    let data;
    try { data = await response.json(); } catch { throw new Error("서버 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요."); }
    if (identity !== preview.identity || request !== preview.request) return;
    if (response.status === 401) { document.dispatchEvent(new CustomEvent("auth-required")); return; }
    if (!response.ok) throw new Error(data.error?.message || "이미지를 만들지 못했어요. 설정이나 사진을 바꿔 다시 시도해 주세요.");
    if (typeof data.image !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(data.image)) throw new Error("편집 이미지를 확인하지 못했어요. 다시 시도해 주세요.");
    const generated = new Image(); generated.src = data.image;
    await generated.decode();
    if (identity !== preview.identity || request !== preview.request) return;
    preview.generated = data.image;
    for (const id of ["compare-after", "side-after"]) { $(id).src = data.image; $(id).hidden = false; }
    $("compare-divider").hidden = $("compare-labels").hidden = false;
    $("preview-result-state").textContent = "비교 준비 완료";
    $("preview-result-state").className = "tag";
    $("result-setting").textContent = scenarioNames[chosenScenario] + " · 편집 강도 " + strength;
    $("simulation-meta").textContent = providerNames[provider] + " · " + (Number.isFinite(data.elapsed_ms) ? (data.elapsed_ms / 1000).toFixed(1) + "초 · " : "") + "가상 편집";
    $("compare-hint").textContent = "슬라이더를 움직여 같은 위치의 원본과 편집 이미지를 비교해 보세요.";
    view("split");
    message(data.notice || "가상의 외형 편집 이미지예요. 실제 진행 예측이 아니에요.", true);
    toast("미리보기를 만들었어요. 두 가지 방식으로 비교해 보세요.");
    if (window.matchMedia("(max-width: 767px)").matches) $("preview-result").scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  } catch (error) {
    if (identity !== preview.identity || request !== preview.request) return;
    $("preview-result-state").textContent = "다시 시도";
    message(error.name === "AbortError" ? "처리 시간이 길어 대기를 종료했어요. 서버 처리는 계속될 수 있어요. 잠시 후 다시 시도해 주세요." :
      error instanceof TypeError ? "서버에 연결하지 못했어요. 연결 상태를 확인해 주세요." : error.message);
  } finally {
    clearTimeout(timer);
    if (request === preview.request) { preview.busy = false; preview.controller = null; syncControls(); }
  }
}
async function downloadImage() {
  if (!preview.generated || preview.busy) return;
  const identity = preview.identity, generated = preview.generated;
  const image = new Image(); image.src = generated;
  try {
    await image.decode();
    if (identity !== preview.identity || generated !== preview.generated) return;
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight + 44;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    context.fillStyle = "#2e2f33"; context.font = "13px sans-serif";
    context.fillText("Hairline Lab · 가상 모발 편집 · 실제 진행 예측 아님", 12, image.naturalHeight + 27, canvas.width - 24);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob || identity !== preview.identity || generated !== preview.generated) return;
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = "hairline-lab-simulation.png";
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { message("이미지를 저장하지 못했어요. 다시 시도해 주세요."); }
}
async function loadStatus() {
  try {
    const response = await fetch("/api/status", { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Status unavailable");
    const data = await response.json();
    preview.available = { opencv: !!(data.opencv_ready && data.segmentation_ready), sd: !!(data.sd_configured && data.segmentation_ready), gemini: !!data.paid_image_ready };
    const options = $("provider").options;
    for (const option of options) {
      option.disabled = !preview.available[option.value];
      option.textContent = providerNames[option.value] + (option.disabled ? " · 준비 필요" : option.value === "gemini" ? " · 유료" : "");
    }
    const first = [...options].find((option) => !option.disabled);
    $("provider").value = first?.value || "opencv";
    providerChanged();
    if (!first) message("사용 가능한 편집 방식이 없어요. 모발 분할 모델이나 AI 편집 설정을 확인해 주세요.");
  } catch {
    preview.available = {};
    $("provider-description").textContent = "편집 가능 여부를 확인하지 못했어요. 페이지를 새로고침해 주세요.";
    message("서버에 연결하지 못했어요. 페이지를 새로고침해 주세요.");
  } finally { syncControls(); }
}
async function importPhoto() {
  const url = new URL(window.location.href), token = url.searchParams.get("photo");
  if (!token) return;
  url.searchParams.delete("photo");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  try {
    await window.HairlineAuth.ready;
    const identity = preview.identity, selection = preview.selection;
    const file = await window.HairlinePhotoHandoff.take(token, window.HairlineAuth.user?.id ?? null);
    if (identity !== preview.identity || selection !== preview.selection || preview.busy) return;
    if (file) { await selectPhoto(file); if (preview.file === file) message("분석에서 선택한 원본 사진을 가져왔어요.", true); }
    else message("가져올 사진이 없거나 전달 시간이 지났어요. 사진을 다시 선택해 주세요.");
  } catch { if (!preview.file) message("사진을 가져오지 못했어요. 이 페이지에서 사진을 직접 선택해 주세요."); }
}
$("dropzone").addEventListener("click", () => $("photo-input").click());
$("change-photo").addEventListener("click", () => $("photo-input").click());
$("photo-input").addEventListener("change", (event) => selectPhoto(event.target.files[0]));
$("photo-reset").addEventListener("click", () => resetPhoto());
for (const name of ["dragenter", "dragover"]) $("dropzone").addEventListener(name, (event) => { event.preventDefault(); if (!preview.busy) $("dropzone").classList.add("dragover"); });
for (const name of ["dragleave", "drop"]) $("dropzone").addEventListener(name, (event) => { event.preventDefault(); $("dropzone").classList.remove("dragover"); });
$("dropzone").addEventListener("drop", (event) => selectPhoto(event.dataTransfer.files[0]));
$("simulate-button").addEventListener("click", simulate);
$("strength").addEventListener("input", (event) => strengthChanged(event.target.value));
document.querySelectorAll("[data-strength]").forEach((item) => item.addEventListener("click", () => strengthChanged(item.dataset.strength)));
document.querySelectorAll('input[name="scenario"]').forEach((item) => item.addEventListener("change", () => {
  $("scenario-description").textContent = { hairline: "앞쪽 모발 경계가 달라 보이는 모습을 편집해요.", crown: "정수리 부근의 두피 노출이 달라 보이는 모습을 편집해요.", density: "일부 모발이 성기게 보이는 가상의 모습을 편집해요." }[scenario()];
  settingChanged();
}));
$("provider").addEventListener("change", providerChanged);
$("compare-slider").addEventListener("input", (event) => splitAt(event.target.value));
document.querySelectorAll("[data-view]").forEach((item) => item.addEventListener("click", () => { if (preview.generated) view(item.dataset.view); }));
$("reset-comparison").addEventListener("click", () => { splitAt(50); view("split"); });
$("download-image").addEventListener("click", downloadImage);
$("cancel-simulation").addEventListener("click", () => {
  cancelRequest(); clearResult();
  message("화면의 대기를 취소했어요. 서버 처리는 계속될 수 있어요. 잠시 후 다시 시도해 주세요.", true);
});
document.addEventListener("auth-changed", () => {
  preview.identity++; resetPhoto(true);
  $("toast").hidden = true; clearTimeout(preview.toastTimer);
});
window.addEventListener("pagehide", () => { resetPhoto(true); });
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
syncControls();
const initialSimulationStatus = loadStatus();
window.HairlinePage?.track(initialSimulationStatus);
const initialPhotoImport = importPhoto();
window.HairlinePage?.track(initialPhotoImport);
