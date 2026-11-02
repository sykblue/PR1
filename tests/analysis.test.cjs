const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const report = (focus = "all") => ({ focus, model: "test-model", elapsed_ms: 500,
  result: { image_usable: true, visible_signal: "not_obvious", summary: "Test observation",
    observations: [{ area: "Test area", detail: "Visible outline" }],
    limitations: ["A single photo"], next_steps: ["Keep consistent photos"] } });

async function fixture({ search = "", history, user = { id: 7 }, brightness = 120, transfer, desktop = true, reducedMotion = true, status = {}, analysisResult } = {}) {
  const handlers = {}, requests = [], copied = [], downloads = [], redirects = [], handoffs = [], removed = [];
  class Element {
    constructor(tag = "div") {
      this.tagName = tag; this.children = []; this.events = {}; this.dataset = {}; this.attributes = {};
      this.value = ""; this.checked = false; this.hidden = false; this.disabled = false; this.ownText = "";
      this.style = { setProperty() {} }; this.options = [{}, {}, {}]; this.classes = new Set();
      this.classList = { toggle: (name, active) => active ? this.classes.add(name) : this.classes.delete(name), add() {}, remove() {} };
    }
    get textContent() { return this.ownText + this.children.map((node) => typeof node === "string" ? node : node.textContent).join(""); }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    append(...nodes) { this.children.push(...nodes); }
    prepend(...nodes) { this.children.unshift(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; this.ownText = ""; }
    addEventListener(type, callback) { (this.events[type] ||= []).push(callback); }
    fire(type, event = {}) { return Promise.all((this.events[type] || []).map((callback) => callback(event))); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    querySelector(selector) { return selector === "span" ? this.label ||= new Element("span") : selector === ".recommendation-dialog-body" ? this.dialogBody ||= new Element() : null; }
    querySelectorAll() { return []; }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire("close"); }
    scrollIntoView(options) { this.scrolled = options; }
    remove() {}
    click() { if (this.tagName === "a") downloads.push(this.download); }
  }
  const html = fs.readFileSync(path.join(__dirname, "../analysis.html"), "utf8");
  const ids = new Map([...html.matchAll(/\bid="([\w-]+)"/g)].map((match) => [match[1], new Element()]));
  const radios = ["all", "hairline", "crown", "density"].map((value, index) => Object.assign(new Element("input"), { value, checked: !index }));
  const scenarios = ["hairline", "crown", "density"].map((value, index) => Object.assign(new Element("input"), { value, checked: !index }));
  const steps = ["photo", "settings", "report"].map((name) => Object.assign(new Element("li"), { dataset: { analysisStep: name } }));
  const pixels = new Uint8ClampedArray(24 * 24 * 4).fill(brightness);
  const document = {
    getElementById: (id) => ids.get(id) || null,
    querySelectorAll: (selector) => selector.includes('name="analysis-focus"') ? radios : selector.includes('name="scenario"') ? scenarios : selector === "[data-analysis-step]" ? steps : [],
    querySelector: (selector) => selector.includes('name="analysis-focus"') ? radios.find((radio) => radio.checked) : scenarios.find((radio) => radio.checked),
    createElement: (tag) => tag === "canvas" ? { getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels }) }) } : new Element(tag),
    createTextNode: (text) => text,
    addEventListener: (type, callback) => { (handlers[type] ||= []).push(callback); },
    dispatchEvent: (event) => { for (const callback of handlers[event.type] || []) callback(event); },
    body: new Element("body"),
  };
  const auth = { user, ready: Promise.resolve(), headers: async () => ({}), open: () => redirects.push("login") };
  const window = { HairlineAuth: auth, location: { search, assign: (url) => redirects.push(url) }, addEventListener() {}, matchMedia: (query) => ({ matches: query === "(prefers-reduced-motion: reduce)" ? reducedMotion : desktop }),
    HairlinePhotoHandoff: { put: async (file, owner) => { handoffs.push({ file, owner }); return transfer ? transfer() : "one-use-token"; },
      remove: async (token) => removed.push(token) } };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    let data;
    if (url === "/api/status") data = { analysis_model: "gemini-2.5-flash", analysis_ready: true, ...status };
    else if (url === "/api/analyze") data = analysisResult || report(options.body.get("focus"));
    else if (url.startsWith("/api/history/")) data = history ? await history() : { ...report("crown"), created_at: "2026-10-29T03:00:00Z" };
    else throw Error("Unexpected request " + url);
    return { ok: true, status: 200, json: async () => data };
  };
  class Image { constructor() { this.naturalWidth = 800; this.naturalHeight = 1000; } decode() { return Promise.resolve(); } }
  const file = new File(["test-input"], "test.jpg", { type: "image/jpeg" });
  const context = vm.createContext({ window, document, fetch, Image, file, report: report(),
    navigator: { clipboard: { writeText: async (text) => copied.push(text) } },
    File, Blob, FormData, URL, URLSearchParams, AbortController, AbortSignal, DOMException, Date,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout });
  for (const name of ["analysis-tools.js", "analysis-recommendations.js", "app.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../static", name), "utf8"), context);
  await new Promise(setImmediate);
  return { el: (id) => ids.get(id), radios, steps, requests, copied, downloads, redirects, handoffs, removed, context, document,
    tools: window.HairlineAnalysisTools,
    run: (code) => vm.runInContext(code, context),
    currentStep: () => steps.find((step) => step.attributes["aria-current"] === "step")?.dataset.analysisStep };
}

test("the actual analysis-page DOM initializes, selects a photo and resets its local checks", async () => {
  const f = await fixture();
  await f.run("selectPhoto(file)");
  assert.equal(f.el("photo-checks").hidden, false);
  assert.equal(f.el("photo-check-resolution").textContent, "800 × 1000px");
  assert.equal(f.currentStep(), "settings");
  assert.equal(f.requests.some((request) => request.url === "/api/analyze"), false);
  await f.run("resetPhoto()");
  assert.equal(f.el("photo-checks").hidden, true);
  assert.equal(f.currentStep(), "photo");
});

test("quota fallback displays the actual local provider and waits for the configured combined timeout", async () => {
  const local = { ...report(), provider: "ollama", model: "qwen2.5vl:3b", fallback_reason: "gemini_quota" };
  const f = await fixture({ status: { ollama_fallback_enabled: true, analysis_timeout_ms: 260000 }, analysisResult: local });
  assert.equal(f.el("ollama-fallback-notice").hidden, false);
  assert.equal(f.run("state.analysisTimeout"), 260000);
  await f.run("selectPhoto(file)"); f.el("consent").checked = true;
  await f.run("analyze()");
  assert.match(f.el("analysis-meta").textContent, /Ollama · qwen2\.5vl:3b/);
  assert.match(f.el("analysis-meta").textContent, /Gemini 한도로 로컬 전환/);
  assert.match(f.el("analysis-message").textContent, /Ollama/);
  assert.equal(f.requests.filter(item => item.url === "/api/analyze").length, 1);
  const disabled = await fixture({ status: { ollama_fallback_enabled: false, analysis_timeout_ms: -1 } });
  assert.equal(disabled.el("ollama-fallback-notice").hidden, true);
  assert.equal(disabled.run("state.analysisTimeout"), 200000);
});

test("the selected observation focus reaches the API and changing it clears the previous report", async () => {
  const f = await fixture();
  await f.run("selectPhoto(file)");
  for (const radio of f.radios) radio.checked = radio.value === "crown";
  f.el("consent").checked = true;
  await f.run("analyze()");
  const request = f.requests.find((item) => item.url === "/api/analyze");
  assert.equal(request.options.body.get("focus"), "crown");
  assert.equal(f.el("report-content").hidden, false);
  assert.equal(f.currentStep(), "report");
  assert.equal(f.el("recommendations").hidden, false);
  assert.match(f.el("analysis-meta").textContent, /정수리/);
  await f.radios[0].fire("change");
  assert.equal(f.el("report-content").hidden, true);
  assert.equal(f.el("recommendations").hidden, true);
  assert.equal(f.currentStep(), "settings");
});

test("a completed analysis opens the care modal and account changes close and clear it", async () => {
  const f = await fixture();
  f.run("renderReport(report)");
  await f.el("recommendation-open-medicines").fire("click");
  assert.equal(f.el("recommendation-dialog").open, true);
  assert.equal(f.el("recommendation-panel-medicines").hidden, false);
  await f.el("recommendation-tab-clinics").fire("click");
  await f.el("recommendation-locate").fire("click");
  assert.equal(f.el("clinics-dialog").open, true);
  f.document.dispatchEvent({ type: "auth-changed" });
  assert.equal(f.el("recommendation-dialog").open, false);
  assert.equal(f.el("recommendations").hidden, true);
  assert.equal(f.el("clinics-dialog").open, false);
});

test("completed report content can be copied and downloaded as readable text", async () => {
  const f = await fixture();
  f.run("renderReport(report)");
  await f.el("copy-report").fire("click");
  assert.equal(f.copied.length, 1);
  assert.match(f.copied[0], /Test observation/);
  assert.match(f.copied[0], /의료 진단/);
  await f.el("export-report-text").fire("click");
  assert.deepEqual(f.downloads, ["hairline-lab-report.txt"]);
});

test("desktop analysis keeps its viewport while small screens reveal results and respect reduced motion", async () => {
  for (const [desktop, reducedMotion, behavior] of [[true, false, undefined], [false, false, "smooth"], [false, true, "auto"]]) {
    const f = await fixture({ desktop, reducedMotion });
    await f.run("selectPhoto(file)");
    f.el("consent").checked = true;
    await f.run("analyze()");
    assert.equal(f.el("report-panel").scrolled?.behavior, behavior);
    assert.equal(f.el("report-content").hidden, false);
    f.el("report-details").scrollTop = 260;
    await f.radios[0].fire("change");
    assert.equal(f.el("report-details").scrollTop, 0);
    assert.equal(f.el("report-content").hidden, true);
  }
});

test("invalid automatic training options reveal both disclosure levels before focusing the required label", async () => {
  const f = await fixture();
  await f.run("selectPhoto(file)");
  f.el("consent").checked = true;
  f.el("photo-training-auto-save").checked = true;
  await f.run("analyze()");
  assert.equal(f.el("analysis-extra-settings").open, true);
  assert.equal(f.el("photo-training").open, true);
  assert.equal(f.el("photo-training-label").focused, true);
  assert.equal(f.requests.some((item) => item.url === "/api/analyze"), false);
});

test("a saved report URL restores a legacy report without a photo or another AI call", async () => {
  const f = await fixture({ search: "?report=42" });
  assert.equal(f.requests.some((item) => item.url === "/api/history/42"), true);
  assert.equal(f.requests.some((item) => item.url === "/api/analyze"), false);
  assert.equal(f.el("report-tag").textContent, "저장된 기록");
  assert.equal(f.el("report-content").hidden, false);
  assert.equal(f.run("state.file"), null);
});

test("saving a photo requires report opt-in and resets when the report choice or account changes", async () => {
  const f = await fixture();
  await f.run("selectPhoto(file)");
  assert.equal(f.el("save-photo").disabled, true);
  f.el("save-history").checked = true; await f.el("save-history").fire("change");
  assert.equal(f.el("save-photo").disabled, false);
  f.el("save-photo").checked = true; f.el("consent").checked = true;
  await f.run("analyze()");
  const request = f.requests.find((item) => item.url === "/api/analyze");
  assert.equal(request.options.body.get("save_history"), "true");
  assert.equal(request.options.body.get("save_photo"), "true");
  f.el("save-history").checked = false; await f.el("save-history").fire("change");
  assert.equal(f.el("save-photo").checked, false); assert.equal(f.el("save-photo").disabled, true);
  f.el("save-history").checked = true; f.el("save-photo").checked = true;
  f.document.dispatchEvent({ type: "auth-changed" });
  assert.equal(f.el("save-photo").checked, false);
});

test("saved photos use an authenticated local URL and clear when a different account is selected", async () => {
  const photo = { id: "a".repeat(32), width: 640, height: 480, image_url: "https://untrusted.invalid/photo" };
  const f = await fixture({ search: "?report=42", history: async () => ({ ...report(), photo, created_at: "2026-11-02T01:00:00Z" }) });
  assert.equal(f.el("photo-preview").src, `/api/photos/${photo.id}/image`);
  assert.equal(f.el("photo-view").hidden, false);
  assert.equal(f.el("photo-view-label").textContent, "저장한 사진");
  assert.equal(f.run("state.file"), null);
  assert.equal(f.requests.some((request) => request.url === "/api/analyze"), false);
  f.document.dispatchEvent({ type: "auth-changed" });
  assert.equal(f.el("photo-view").hidden, true);
});

test("invalid report addresses never request a private report and anonymous users go through login", async () => {
  const invalid = await fixture({ search: "?report=-1" });
  assert.equal(invalid.requests.some((item) => item.url.startsWith("/api/history/")), false);
  assert.match(invalid.el("analysis-message").textContent, /기록 주소/);
  const guest = await fixture({ search: "?report=42", user: null });
  assert.deepEqual(guest.redirects, ["login"]);
  assert.equal(guest.requests.some((item) => item.url.startsWith("/api/history/")), false);
});

test("a late saved-report response cannot overwrite a newly selected photo", async () => {
  let finish;
  const f = await fixture({ search: "?report=42", history: () => new Promise((resolve) => { finish = resolve; }) });
  await f.run("selectPhoto(file)");
  finish({ ...report(), created_at: "2026-10-29T03:00:00Z" });
  await new Promise(setImmediate);
  assert.equal(f.el("report-content").hidden, true);
  assert.notEqual(f.run("state.file"), null);
  assert.equal(f.currentStep(), "settings");
});

test("local lighting advice is informational and readable exports exclude unrelated data", async () => {
  const dark = await fixture({ brightness: 10 });
  const checks = dark.tools.inspectPhoto({ naturalWidth: 320, naturalHeight: 400 });
  assert.equal(checks.attention, true);
  assert.match(checks.light, /어두운/);
  assert.match(checks.note, /원본/);
  const text = dark.tools.reportText({ ...report("density"), photo: "private-base64", ocr_text: "private-ocr" });
  assert.match(text, /모발 분포/);
  assert.match(text, /Visible outline/);
  assert.doesNotMatch(text, /private-base64|private-ocr/);
});

test("only an explicit comparison action hands off the original selected file", async () => {
  const f = await fixture();
  await f.run("selectPhoto(file)");
  f.el("photo-preview").src = "data:image/png;base64,overlay";
  assert.equal(f.handoffs.length, 0);
  await f.el("open-simulation").fire("click", { preventDefault() {} });
  assert.equal(f.handoffs.length, 1);
  assert.equal(f.handoffs[0].file, f.run("state.file"));
  assert.equal(f.handoffs[0].owner, 7);
  assert.deepEqual(f.redirects, ["/simulation?photo=one-use-token"]);
  assert.equal(f.requests.some((item) => item.url === "/api/simulate"), false);
});

test("an account change during transfer removes the stale handoff instead of navigating", async () => {
  let finish;
  const f = await fixture({ transfer: () => new Promise((resolve) => { finish = resolve; }) });
  await f.run("selectPhoto(file)");
  const pending = f.el("open-simulation").fire("click", { preventDefault() {} });
  await new Promise(setImmediate);
  f.document.dispatchEvent({ type: "auth-changed" });
  finish("stale-token"); await pending;
  assert.deepEqual(f.redirects, []);
  assert.deepEqual(f.removed, ["stale-token"]);
});

test("a failed temporary transfer keeps the current photo and explains direct selection", async () => {
  const f = await fixture({ transfer: async () => { throw new Error("Storage unavailable"); } });
  await f.run("selectPhoto(file)");
  await f.el("open-simulation").fire("click", { preventDefault() {} });
  assert.equal(f.run("state.file.name"), "test.jpg");
  assert.match(f.el("analysis-message").textContent, /직접 선택/);
  assert.deepEqual(f.redirects, []);
  assert.equal(f.run("state.busy"), false);
});

test("new reports distinguish forehead skin from scalp exposure in the screen and readable export", async () => {
  const data = report("hairline");
  data.result.visual_evidence = { image_type: "photo", target_visibility: "clear", forehead_skin: "visible",
    scalp_in_hair: "not_obvious", confounders: ["hairstyle"], basis: "모발 경계 안쪽과 이마 피부를 나누어 관찰했어요." };
  const f = await fixture({ analysisResult: data });
  await f.run("selectPhoto(file)"); f.el("consent").checked = true; await f.run("analyze()");
  assert.match(f.el("observations").textContent, /이마 피부가 보여요/);
  assert.match(f.el("observations").textContent, /모발 사이 두피 노출은 뚜렷하지/);
  assert.match(f.el("signal-tag").textContent, /모발 사이/);
  const text = f.tools.reportText(data);
  assert.match(text, /이마와 모발 영역 구분/);
  assert.match(text, /모발 경계 안쪽과 이마 피부/);
});

test("macro assistance requires explicit selection, is exported as a reference and resets with a new photo", async () => {
  const data = report();
  data.scalp_reference = { status: "reference_only", dataset_label: "경증", warning: "실험용 분류이며 의료 진단이 아니에요." };
  const f = await fixture({ status: { scalp_reference: { ready: true } }, analysisResult: data });
  assert.equal(f.el("scalp-macro").checked, false);
  assert.equal(f.el("scalp-macro").disabled, false);
  await f.run("selectPhoto(file)"); f.el("consent").checked = true; f.el("scalp-macro").checked = true;
  await f.run("analyze()");
  const request = f.requests.find(item => item.url === "/api/analyze");
  assert.equal(request.options.body.get("scalp_macro"), "true");
  assert.match(f.el("observations").textContent, /데이터셋 참고 라벨/);
  assert.match(f.tools.reportText(data), /의료 진단이 아니/);
  await f.run("selectPhoto(file)"); assert.equal(f.el("scalp-macro").checked, false);
});
