"use strict";

(() => {
  const el = (id) => document.getElementById(id);
  const names = { reference: "기준 사진", concern: "탈모 의심 사진" };
  let current = null;
  let running = false;
  let epoch = 0, seenUser;
  let cameraPhoto = null, cameraPreview = null;
  const controllers = new Set();
  const stale = () => Object.assign(new Error("계정이 변경되어 작업을 중단했어요."), { name: "AccountChangedError" });

  function message(text, info = false) {
    el("training-message").textContent = text;
    el("training-message").classList.toggle("info", info);
    el("training-message").hidden = !text;
  }

  function clearCameraPhoto() {
    if (cameraPreview) URL.revokeObjectURL(cameraPreview);
    cameraPhoto = cameraPreview = null;
    el("training-camera-image").removeAttribute("src");
    el("training-camera-name").textContent = "";
    el("training-camera-preview").hidden = true;
  }

  function selectCameraPhoto(file) {
    if (running || !window.HairlineAuth.user) return;
    clearCameraPhoto(); el("training-files").value = "";
    el("training-storage-consent").checked = false;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) {
      message("10MB 이하 JPG·PNG·WEBP 사진을 촬영하거나 선택해 주세요."); return;
    }
    cameraPhoto = file; cameraPreview = URL.createObjectURL(file);
    el("training-camera-image").src = cameraPreview;
    el("training-camera-name").textContent = file.name;
    el("training-camera-preview").hidden = false;
    message("");
  }
  window.HairlineCamera = { selectPhoto: selectCameraPhoto, focusTarget: "training-add" };

  async function request(path, fields = null) {
    const version = epoch, controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const options = { signal: controller.signal };
      if (fields) { options.method = "POST"; options.body = fields; options.headers = await window.HairlineAuth.headers(); }
      if (version !== epoch) throw stale();
      const response = await fetch(path, options);
      let result;
      try { result = await response.json(); } catch { throw new Error("서버 응답을 읽지 못했어요. Python 서버를 확인해 주세요."); }
      if (version !== epoch) throw stale();
      if (response.status === 401) document.dispatchEvent(new CustomEvent("auth-required"));
      if (!response.ok) throw new Error(result.error?.message || "학습 요청을 완료하지 못했어요.");
      return result;
    } catch (error) { if (version !== epoch) throw stale(); throw error; }
    finally { clearTimeout(timeout); controllers.delete(controller); }
  }

  function setRunning(value) {
    running = value;
    const locked = value || !window.HairlineAuth.user;
    for (const id of ["training-files", "training-label", "training-group", "training-storage-consent", "training-add", "camera-open", "camera-file", "training-camera-remove"]) el(id).disabled = locked;
    el("training-run").disabled = locked || !current?.can_train;
    el("training-export").disabled = locked || !current?.model;
    el("training-sample-list").querySelectorAll("button").forEach((button) => { button.disabled = value; });
    el("training-run").querySelector("span").textContent = value ? "작업 중이에요" : "로컬 분류기 학습하기";
    el("training-run").setAttribute("aria-busy", String(value));
  }

  function render(data) {
    current = data;
    el("training-reference-count").textContent = `${data.counts.reference}장`;
    el("training-concern-count").textContent = `${data.counts.concern}장`;
    el("training-total").textContent = `${data.total}장`;
    el("training-requirements").textContent = `기준 그룹 ${data.group_counts.reference}개 · 의심 그룹 ${data.group_counts.concern}개. 각 라벨 5장 이상·그룹 2개 이상, 전체 4개 그룹부터 학습할 수 있어요.`;
    if (data.model_stale) el("training-requirements").textContent += " 데이터가 바뀌어 재학습이 필요해요.";
    el("training-metrics").replaceChildren();
    el("training-metrics").hidden = !data.model;
    if (data.model) {
      const metric = document.createElement("strong");
      metric.textContent = `${data.model_stale ? "이전 모델의 " : ""}보류 사진 라벨 일치율 ${(data.model.validation_accuracy * 100).toFixed(1)}%`;
      const detail = document.createElement("p");
      detail.textContent = `학습 ${data.model.training_size}장 · 검증 ${data.model.validation_size}장 · 다수 라벨 기준선 ${(data.model.majority_baseline * 100).toFixed(1)}%. 사람 그룹을 분리한 내부 검증이며 의료적 정확도가 아니에요.`;
      el("training-metrics").append(metric, detail);
    }
    el("training-sample-list").replaceChildren(...data.samples.map((sample) => {
      const row = document.createElement("tr");
      for (const value of [sample.id.slice(0, 12), names[sample.label], sample.group,
        sample.source === "analysis" ? "분석 화면 · 학습 폴더" : "직접 등록"]) {
        const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
      }
      const cell = document.createElement("td");
      const button = document.createElement("button"); button.type = "button"; button.className = "text-button training-delete"; button.textContent = "삭제";
      button.setAttribute("aria-label", `${sample.group} 그룹의 사진 ${sample.id.slice(0, 8)} 삭제`);
      button.addEventListener("click", () => removeSample(sample));
      cell.append(button); row.append(cell); return row;
    }));
    setRunning(running);
  }

  async function refresh() {
    const task = request("/api/training/status");
    window.HairlinePage?.track(task);
    render(await task);
  }

  function changed() { document.dispatchEvent(new CustomEvent("training-updated")); }

  async function addSamples() {
    if (running) return;
    if (!window.HairlineAuth.user) { window.HairlineAuth.open(); return; }
    const version = epoch;
    const files = cameraPhoto ? [cameraPhoto] : [...el("training-files").files];
    const group = el("training-group").value.trim();
    const label = el("training-label").value;
    if (!files.length) { message("학습용 사진을 선택해 주세요."); return; }
    if (files.length > 50) { message("한 번에 최대 50장까지 선택해 주세요."); return; }
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(group)) { message("이름 대신 p001 같은 영문·숫자 익명 그룹 코드를 입력해 주세요."); return; }
    if (!el("training-storage-consent").checked) { message("학습 사진을 이 컴퓨터에 저장하는 데 동의해 주세요."); return; }
    setRunning(true);
    let added = 0;
    const errors = [];
    try {
      for (let index = 0; index < files.length; index++) {
        if (version !== epoch) return;
        const file = files[index];
        message(`${index + 1}/${files.length} 사진을 등록하고 있어요.`, true);
        if (file.size > 10 * 1024 * 1024) { errors.push(`${file.name}: 10MB 초과`); continue; }
        const body = new FormData();
        body.append("photo", file); body.append("label", label); body.append("group", group); body.append("storage_consent", "true");
        try {
          const data = await request("/api/training/add", body);
          render(data.status); changed(); added += 1;
        } catch (error) {
          if (version !== epoch) return;
          errors.push(`${file.name}: ${error.message}`);
          if (error instanceof TypeError || error.name === "TimeoutError") break;
        }
      }
      if (added) { el("training-files").value = ""; clearCameraPhoto(); changed(); }
      message(`${added}장 등록했어요.${errors.length ? " 등록하지 못한 항목: " + errors.slice(0, 4).join(" / ") : " 다른 사람의 사진은 새로운 익명 그룹 코드로 등록해 주세요."}`, !errors.length);
    } finally { if (version === epoch) { el("training-storage-consent").checked = false; setRunning(false); } }
  }

  async function train() {
    if (running) return;
    if (!window.HairlineAuth.user) { window.HairlineAuth.open(); return; }
    const version = epoch;
    setRunning(true); message("사람별 그룹을 분리해 로컬 분류기를 학습·검증하고 있어요.", true);
    try {
      render(await request("/api/training/train", new FormData()));
      changed();
      message("로컬 분류기 학습을 완료했어요. 검증 결과를 확인하거나 평가 결과를 저장할 수 있어요.", true);
    } catch (error) { if (version === epoch) message(error.message); }
    finally { if (version === epoch) setRunning(false); }
  }

  async function removeSample(sample) {
    if (running || !window.confirm("이 학습 사진과 라벨을 이 컴퓨터에서 삭제할까요? 기존 모델은 다시 학습해야 해요.")) return;
    setRunning(true);
    const version = epoch;
    try {
      const body = new FormData(); body.append("id", sample.id);
      render(await request("/api/training/remove", body)); changed();
      message("학습 사진을 삭제했어요. 로컬 분류기를 사용하려면 다시 학습해 주세요.", true);
    } catch (error) { if (version === epoch) message(error.message); }
    finally { if (version === epoch) setRunning(false); }
  }

  el("training-add").addEventListener("click", addSamples);
  el("training-files").addEventListener("change", () => { clearCameraPhoto(); el("training-storage-consent").checked = false; message(""); });
  el("training-camera-remove").addEventListener("click", () => { clearCameraPhoto(); el("training-storage-consent").checked = false; message(""); });
  el("training-run").addEventListener("click", train);
  el("training-export").addEventListener("click", () => {
    if (!current?.model) return;
    const report = { ...current.model, model_stale: current.model_stale,
      notice: "사용자 라벨의 내부 보류 검증 결과이며 의료적 정확도가 아닙니다." };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "local-training-evaluation.json";
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  function accountChanged() {
    const id = window.HairlineAuth.user?.id ?? null;
    if (seenUser === id) return;
    seenUser = id; epoch++;
    controllers.forEach((controller) => controller.abort()); controllers.clear();
    current = null;
    clearCameraPhoto(); el("camera-file").value = "";
    el("training-files").value = el("training-group").value = "";
    el("training-storage-consent").checked = false;
    el("training-sample-list").replaceChildren();
    el("training-metrics").replaceChildren(); el("training-metrics").hidden = true;
    for (const field of ["training-reference-count", "training-concern-count", "training-total"]) el(field).textContent = "0장";
    el("training-requirements").textContent = "학습 사진과 모델은 계정별로 관리돼요.";
    setRunning(false);
    message("");
    const version = epoch;
    if (id) refresh().catch((error) => { if (version === epoch) message(error.message); });
  }
  document.addEventListener("auth-changed", accountChanged);
  window.addEventListener("pagehide", clearCameraPhoto);
  setRunning(false);
  window.HairlineAuth.ready.then(accountChanged).catch((error) => message(error.message));
})();
