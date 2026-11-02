"use strict";

(() => {
  const el = id => document.getElementById(id), auth = window.HairlineAuth;
  const stateNames = { queued: "대기", running: "학습 중", completed: "완료", failed: "실패", cancelled: "취소" };
  const focusNames = { all: "전체", hairline: "헤어라인", crown: "정수리·가르마", density: "모발 분포" };
  let epoch = 0, seenUser, current = null, file = null, preview = null, editing = null;
  let pending = false, timer = null, selection = 0, testVersion = 0, testController = null;
  let sampleKey = "", jobsKey = "";
  const controllers = new Set();
  const stale = () => Object.assign(new Error("계정이 변경됐어요."), { name: "AccountChangedError" });

  function message(text = "", info = false) {
    el("vision-message").textContent = text;
    el("vision-message").hidden = !text;
    el("vision-message").classList.toggle("info", info);
  }
  async function request(path, fields = null, { blob = false, test = false } = {}) {
    const version = epoch, controller = new AbortController(); controllers.add(controller);
    if (test) testController = controller;
    const timeout = setTimeout(() => controller.abort(), test ? 150000 : 30000);
    try {
      const options = { signal: controller.signal, cache: "no-store" };
      if (fields) { options.method = "POST"; options.body = fields; options.headers = await auth.headers(); }
      if (version !== epoch || !auth.user) throw stale();
      const response = await fetch(path, options);
      const value = blob && response.ok ? await response.blob() : await response.json();
      if (version !== epoch) throw stale();
      if (response.status === 401) document.dispatchEvent(new CustomEvent("auth-required"));
      if (!response.ok) throw new Error(value.error?.message || "요청을 완료하지 못했어요.");
      return value;
    } catch (error) {
      if (version !== epoch) throw stale();
      if (error.name === "AbortError") throw new Error("응답 대기 시간이 길어졌어요. 서버 상태를 확인해 주세요.");
      if (error instanceof TypeError) throw new Error("로컬 서버에 연결하지 못했어요.");
      throw error;
    } finally {
      clearTimeout(timeout); controllers.delete(controller);
      if (testController === controller) testController = null;
    }
  }
  function fields(values) {
    const data = new FormData();
    for (const [key, value] of Object.entries(values)) data.append(key, value);
    return data;
  }
  function controls() {
    const locked = pending || !auth.user;
    el("vision-workspace").querySelectorAll("input, select, textarea").forEach(input => { input.disabled = locked; });
    if (!locked && el("vision-usable").value === "false") { el("vision-signal").disabled = true; el("vision-observations").disabled = true; }
    el("vision-save").disabled = locked || current?.own_job_running;
    el("vision-start").disabled = locked || !current?.can_start;
    el("vision-cancel").disabled = locked || !current?.jobs?.some(job => ["queued", "running"].includes(job.state));
    el("vision-use-base").disabled = locked || !current?.active_job;
    el("vision-new").disabled = locked;
    el("vision-save").textContent = pending ? "처리 중…" : editing ? "정답 설명 수정" : "사진과 정답 저장";
    el("vision-workspace").setAttribute("aria-busy", String(pending));
    el("vision-jobs").querySelectorAll("button").forEach(button => { button.disabled = locked || current?.gpu_busy || (button.dataset.action === "test" && !file) || button.dataset.active === "true"; });
    el("vision-samples").querySelectorAll("button").forEach(button => { button.disabled = locked || current?.own_job_running; });
  }
  function clearPhoto() {
    if (preview) URL.revokeObjectURL(preview);
    preview = null; file = null; el("vision-preview").removeAttribute("src");
    el("vision-preview").hidden = true; el("vision-photo-empty").hidden = false;
    el("vision-photo").value = "";
  }
  function setPhoto(value) {
    clearPhoto(); file = value; preview = URL.createObjectURL(value);
    el("vision-preview").src = preview; el("vision-preview").hidden = false; el("vision-photo-empty").hidden = true; controls();
  }
  function newExample() {
    selection++; editing = null; clearPhoto();
    for (const id of ["vision-group", "vision-usable", "vision-signal", "vision-summary", "vision-observations", "vision-limitations", "vision-next-steps"]) el(id).value = "";
    el("vision-focus").value = "all"; el("vision-storage-consent").checked = false;
    sampleKey = ""; if (current) renderSamples(current.samples); controls();
  }
  function target() {
    const usable = el("vision-usable").value === "true";
    const lines = id => el(id).value.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    const observations = usable ? lines("vision-observations").map(line => {
      const separator = line.indexOf("|");
      if (separator < 1 || !line.slice(separator + 1).trim()) throw new Error("부위별 관찰은 ‘부위 | 설명’ 형식으로 입력해 주세요.");
      return { area: line.slice(0, separator).trim(), detail: line.slice(separator + 1).trim() };
    }) : [];
    const value = { image_usable: usable, visible_signal: usable ? el("vision-signal").value : "unclear", summary: el("vision-summary").value.trim(),
      observations, limitations: lines("vision-limitations"), next_steps: lines("vision-next-steps") };
    if ((usable && !observations.length) || observations.length > 6) throw new Error("관찰 가능한 사진은 부위별 관찰을 1~6개 입력해 주세요.");
    if (!value.limitations.length || value.limitations.length > 5 || !value.next_steps.length || value.next_steps.length > 5) throw new Error("사진의 한계와 다음 행동을 각각 1~5개 입력해 주세요.");
    return value;
  }
  async function editSample(sample) {
    const version = ++selection;
    try {
      const blob = await request(`/api/training/vision/photo/${encodeURIComponent(sample.id)}`, null, { blob: true });
      if (version !== selection) return;
      editing = sample.id; setPhoto(new File([blob], "training-example.jpg", { type: "image/jpeg" }));
      el("vision-group").value = sample.group; el("vision-focus").value = sample.focus;
      const value = sample.target;
      el("vision-usable").value = String(value.image_usable); el("vision-signal").value = value.visible_signal;
      el("vision-summary").value = value.summary;
      el("vision-observations").value = value.observations.map(row => `${row.area} | ${row.detail}`).join("\n");
      el("vision-limitations").value = value.limitations.join("\n"); el("vision-next-steps").value = value.next_steps.join("\n");
      el("vision-storage-consent").checked = false; sampleKey = ""; renderSamples(current.samples); controls();
    } catch (error) { if (error.name !== "AccountChangedError" && version === selection) message(error.message); }
  }
  function renderSamples(samples) {
    const key = JSON.stringify([editing, samples]); if (key === sampleKey) return; sampleKey = key;
    el("vision-sample-empty").hidden = samples.length > 0;
    el("vision-samples").replaceChildren(...samples.map(sample => {
      const row = document.createElement("div"); row.className = "vision-sample"; row.setAttribute("role", "listitem");
      const select = document.createElement("button"); select.type = "button"; select.setAttribute("aria-pressed", String(editing === sample.id));
      const name = document.createElement("strong"); name.textContent = `${sample.group} · 관찰 ${sample.target.image_usable ? "가능" : "불가"}`;
      const detail = document.createElement("small"); detail.textContent = `${focusNames[sample.focus]} · ${sample.id.slice(0, 8)}`;
      select.append(name, detail); select.addEventListener("click", () => editSample(sample));
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "text-button"; remove.textContent = "삭제";
      remove.setAttribute("aria-label", `${sample.group} 그룹 예시 ${sample.id.slice(0, 8)} 등록 목록에서 삭제`);
      remove.addEventListener("click", () => action(async () => { await request("/api/training/vision/remove", fields({ id: sample.id })); if (editing === sample.id) newExample(); }, "등록 예시를 삭제했어요."));
      row.append(select, remove); return row;
    }));
  }
  function renderJobs(data) {
    const key = JSON.stringify([data.jobs, data.active_job, data.signature]); if (key === jobsKey) return; jobsKey = key;
    el("vision-job-empty").hidden = data.jobs.length > 0;
    el("vision-jobs").replaceChildren(...data.jobs.filter(job => /^[a-f0-9]{32}$/.test(job.id)).map(job => {
      const card = document.createElement("article"); card.className = "vision-job";
      const title = document.createElement("strong"); title.textContent = `LoRA ${job.id.slice(0, 8)} · ${data.active_job === job.id ? "내 분석에 적용 중" : stateNames[job.state] || "상태 확인"}`;
      const detail = document.createElement("p"); detail.textContent = job.phase; card.append(title, detail);
      if (job.state === "completed") {
        const metric = document.createElement("p"), meta = job.metadata || {};
        metric.textContent = `학습 ${meta.training_size}장 · 검증 ${meta.validation_size}장 · 검증 손실 ${Number.isFinite(meta.validation_loss) ? meta.validation_loss.toFixed(3) : "확인 필요"}${meta.dataset_signature !== data.signature ? " · 예시 변경됨" : ""}`;
        const actions = document.createElement("div"); actions.className = "vision-job-actions";
        const test = document.createElement("button"); test.type = "button"; test.className = "text-button"; test.textContent = "선택 사진 테스트"; test.dataset.action = "test";
        test.addEventListener("click", () => testModel(job.id));
        const apply = document.createElement("button"); apply.type = "button"; apply.className = "text-button"; apply.textContent = data.active_job === job.id ? "적용 중" : "내 분석에 적용"; apply.dataset.active = String(data.active_job === job.id);
        apply.addEventListener("click", () => action(() => request("/api/training/vision/activate", fields({ job_id: job.id })), "Gemini 한도 시 내 학습 모델을 사용해요."));
        const download = document.createElement("a"); download.className = "text-button"; download.textContent = "LoRA 저장"; download.href = `/api/training/vision/export/${encodeURIComponent(job.id)}`;
        actions.append(test, apply, download); card.append(metric, actions);
      }
      return card;
    }));
    const latest = data.jobs.find(job => ["queued", "running"].includes(job.state)) || data.jobs[0];
    el("vision-progress").hidden = !latest;
    if (latest) {
      el("vision-progress-title").textContent = stateNames[latest.state] || "상태 확인";
      el("vision-progress-step").textContent = `${latest.step || 0} / ${latest.steps || 0}`;
      el("vision-progress-bar").max = latest.steps || 1; el("vision-progress-bar").value = latest.step || 0;
      el("vision-progress-detail").textContent = latest.phase + (Number.isFinite(latest.loss) ? ` · 학습 손실 ${latest.loss.toFixed(3)}` : "");
    }
  }
  function render(data) {
    current = data;
    el("vision-sample-count").textContent = `${data.total}장`;
    el("vision-usable-count").textContent = data.counts.usable; el("vision-unusable-count").textContent = data.counts.unusable; el("vision-group-count").textContent = data.groups;
    el("vision-runtime-detail").textContent = data.runtime.ready ? `${data.runtime.gpu} · QLoRA 4비트` : "학습 환경을 먼저 준비해 주세요. scripts/setup_vlm.ps1로 설치할 수 있어요.";
    el("vision-readiness").textContent = data.reason || (data.gpu_busy ? "GPU가 학습·테스트를 처리하고 있어요." : "사람 그룹을 분리해 학습을 시작할 수 있어요.");
    renderSamples(data.samples); renderJobs(data); controls();
  }
  async function refresh() {
    const task = request("/api/training/vision/status");
    window.HairlinePage?.track(task);
    render(await task);
  }
  async function action(work, success = "") {
    if (pending || !auth.user) return;
    const version = epoch;
    pending = true; controls(); message();
    try { await work(); await refresh(); if (success) message(success, true); }
    catch (error) { if (error.name !== "AccountChangedError") message(error.message); }
    finally { if (version === epoch) { pending = false; controls(); } }
  }
  function closeTest() { testVersion++; testController?.abort(); if (el("vision-test-dialog").open) el("vision-test-dialog").close(); }
  async function testModel(jobId) {
    if (!file || pending || !auth.user) { message("왼쪽에서 테스트할 사진을 먼저 선택해 주세요."); return; }
    const version = ++testVersion;
    el("vision-test-state").textContent = "학습 모델로 사진을 관찰하고 있어요."; el("vision-test-result").textContent = "";
    el("vision-test-dialog").showModal();
    try {
      const data = await request("/api/training/vision/test", fields({ photo: file, job_id: jobId, focus: el("vision-focus").value }), { test: true });
      if (version !== testVersion || !el("vision-test-dialog").open) return;
      el("vision-test-state").textContent = `${data.model} · ${(data.elapsed_ms / 1000).toFixed(1)}초`;
      el("vision-test-result").textContent = JSON.stringify(data.result, null, 2);
    } catch (error) {
      if (error.name !== "AccountChangedError" && version === testVersion && el("vision-test-dialog").open) el("vision-test-state").textContent = error.message;
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!auth.user) return;
      try { if (!document.hidden && !pending) await refresh(); }
      catch (error) { if (error.name !== "AccountChangedError") message(error.message); }
      if (auth.user) schedule();
    }, 2500);
  }
  async function accountChanged() {
    const user = auth.user?.id || null; if (user === seenUser) return; seenUser = user;
    epoch++; for (const controller of controllers) controller.abort(); controllers.clear(); clearTimeout(timer); closeTest();
    current = null; pending = false; sampleKey = ""; jobsKey = ""; newExample();
    el("vision-samples").replaceChildren(); el("vision-jobs").replaceChildren(); el("vision-progress").hidden = true;
    el("vision-test-result").textContent = ""; el("vision-test-state").textContent = "";
    for (const id of ["vision-usable-count", "vision-unusable-count", "vision-group-count"]) el(id).textContent = "0";
    el("vision-sample-count").textContent = "0장"; el("vision-sample-empty").hidden = false; el("vision-job-empty").hidden = false;
    el("vision-readiness").textContent = "로그인 후 준비 상태를 확인할 수 있어요.";
    el("vision-runtime-detail").textContent = ""; message(); controls();
    if (!user) return;
    try { await refresh(); } catch (error) { if (error.name !== "AccountChangedError") message(error.message); }
    if (auth.user) schedule();
  }

  el("vision-photo").addEventListener("change", () => {
    const chosen = el("vision-photo").files?.[0]; if (!chosen) return;
    selection++; editing = null;
    for (const id of ["vision-usable", "vision-signal", "vision-summary", "vision-observations", "vision-limitations", "vision-next-steps"]) el(id).value = "";
    el("vision-storage-consent").checked = false;
    if (!["image/jpeg", "image/png", "image/webp"].includes(chosen.type) || chosen.size > 10 * 1024 * 1024) { message("10MB 이하 JPG·PNG·WEBP 사진을 선택해 주세요."); clearPhoto(); controls(); return; }
    setPhoto(chosen); message();
  });
  el("vision-usable").addEventListener("change", () => { if (el("vision-usable").value === "false") { el("vision-signal").value = "unclear"; el("vision-observations").value = ""; } controls(); });
  el("vision-new").addEventListener("click", newExample);
  el("vision-workspace").addEventListener("submit", event => {
    event.preventDefault(); if (!auth.user || pending) return;
    if (!file) { message("학습할 사진을 선택해 주세요."); el("vision-photo").focus(); return; }
    if (!el("vision-storage-consent").checked) { message("사진과 정답 설명의 학습용 저장에 동의해 주세요."); el("vision-storage-consent").focus(); return; }
    if (!el("vision-workspace").reportValidity()) return;
    let answer; try { answer = target(); } catch (error) { message(error.message); return; }
    action(() => request("/api/training/vision/save", fields({ photo: file, id: editing || "", target: JSON.stringify(answer), group: el("vision-group").value.trim(), focus: el("vision-focus").value, storage_consent: "true" })), "사진과 정답 설명을 저장했어요.");
  });
  el("vision-start").addEventListener("click", () => { if (current?.can_start) action(() => request("/api/training/vision/start", fields({ steps: el("vision-steps").value })), "GPU 학습을 시작했어요. 진행 상태를 여기에서 확인할 수 있어요."); });
  el("vision-cancel").addEventListener("click", () => { const job = current?.jobs.find(job => ["queued", "running"].includes(job.state)); if (job) action(() => request("/api/training/vision/cancel", fields({ job_id: job.id })), "학습 취소를 요청했어요."); });
  el("vision-use-base").addEventListener("click", () => action(() => request("/api/training/vision/activate", fields({ job_id: "" })), "내 분석을 기본 Ollama 모델로 되돌렸어요."));
  el("vision-refresh").addEventListener("click", () => action(async () => {}));
  el("vision-test-close").addEventListener("click", closeTest);
  el("vision-test-dialog").addEventListener("cancel", event => { event.preventDefault(); closeTest(); });
  el("vision-test-dialog").addEventListener("close", () => { if (!el("vision-test-dialog").open) { testVersion++; testController?.abort(); } });
  document.addEventListener("auth-changed", accountChanged);
  window.addEventListener("pagehide", () => { epoch++; clearTimeout(timer); controllers.forEach(controller => controller.abort()); clearPhoto(); });
  auth.ready.then(accountChanged);
})();
