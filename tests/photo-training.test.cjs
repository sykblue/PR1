const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor() {
    this.events = {}; this.children = []; this.value = ""; this.checked = false; this.dataset = {};
    this.textContent = ""; this.style = { setProperty() {} }; this.options = [{}, {}, {}];
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  dispatchEvent(event) { for (const fn of this.events[event.type] || []) fn(event); }
  querySelector(selector) { if (selector === "span") return this.span ||= new Element(); return null; }
  querySelectorAll() { return []; }
  append(...children) { this.children.push(...children); }
  prepend(child) { this.children.unshift(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  removeAttribute(name) { delete this[name]; }
  focus() {}
  scrollIntoView(options) { this.scrolled = options; }
  remove() {}
}
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
async function fixture(responders = {}) {
  const elements = new Map();
  const el = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const document = new Element(); document.getElementById = el;
  document.querySelectorAll = () => []; document.createElement = () => new Element();
  document.createTextNode = (text) => text; document.body = new Element();
  const calls = [], auth = { user: { id: 7, username: "developer" }, ready: Promise.resolve(), headers: async () => ({ "X-CSRF-Token": "csrf" }) };
  const window = { HairlineAuth: auth, addEventListener() {} };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (responders[url]) return responders[url](options);
    if (url === "/api/status") return json({ analysis_model: "gemini-2.5-flash" });
    if (url === "/api/training/add") return json({ sample: { id: "sample" }, status: { total: 1 }, auto_training: "needs_data" }, 201);
    throw new Error("Unexpected request: " + url);
  };
  const shot = new File(["original-camera-photo"], "camera-shot.jpg", { type: "image/jpeg" });
  const context = vm.createContext({ window, document, fetch, FormData, File, Blob, URL, AbortController, AbortSignal, DOMException,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } }, shot });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8"), context);
  await new Promise(setImmediate);
  vm.runInContext("state.file = shot", context);
  el("photo-training-label").value = "reference"; el("photo-training-group").value = "p001";
  el("photo-training-auto-train").checked = true;
  return { el, calls, auth, document, context, run: (code) => vm.runInContext(code, context) };
}

test("current photo is saved with manual label, source and automatic fitting option without Gemini", async () => {
  const f = await fixture();
  f.el("photo-preview").src = "data:image/png;base64,overlay-only";
  await f.run("savePhotoForTraining()");
  const posts = f.calls.filter((call) => call.options?.method === "POST");
  assert.equal(posts.length, 1); assert.equal(posts[0].url, "/api/training/add");
  const body = posts[0].options.body;
  assert.equal(body.get("photo").name, "camera-shot.jpg");
  assert.equal(body.get("source"), "analysis"); assert.equal(body.get("label"), "reference");
  assert.equal(body.get("group"), "p001"); assert.equal(body.get("storage_consent"), "true");
  assert.equal(body.get("train_if_ready"), "true");
  assert.equal(f.run("state.trainingPhotoSaved"), true);
  assert.equal(f.el("photo-training-save").disabled, true);
  assert.match(f.el("photo-training-message").textContent, /저장했어요/);
  await f.run("savePhotoForTraining()");
  assert.equal(f.calls.filter((call) => call.options?.method === "POST").length, 1);
});

test("opted-in saving runs after the Gemini attempt even when Gemini returns a quota error", async () => {
  const f = await fixture({ "/api/analyze": () => json({ error: { message: "Gemini quota exceeded" } }, 429) });
  f.el("consent").checked = f.el("photo-training-auto-save").checked = true;
  await f.run("analyze()");
  assert.deepEqual(f.calls.filter((call) => call.options?.method === "POST").map((call) => call.url), ["/api/analyze", "/api/training/add"]);
  assert.match(f.el("analysis-message").textContent, /quota/);
  assert.equal(f.el("report-panel").scrolled.block, "start");
  assert.match(f.el("photo-training-message").textContent, /저장했어요/);
});

test("normal analysis without storage opt-in never registers the photo", async () => {
  const f = await fixture({ "/api/analyze": () => json({ error: { message: "Gemini unavailable" } }, 503) });
  f.el("consent").checked = true;
  await f.run("analyze()");
  assert.equal(f.calls.some((call) => call.url === "/api/training/add"), false);
});

test("account change while Gemini is pending cancels the deferred photo registration", async () => {
  let finish;
  const f = await fixture({ "/api/analyze": () => new Promise((resolve) => { finish = resolve; }) });
  f.el("consent").checked = f.el("photo-training-auto-save").checked = true;
  const analyzing = f.run("analyze()"); await new Promise(setImmediate);
  f.auth.user = null; f.document.dispatchEvent({ type: "auth-changed" });
  finish(json({ error: { message: "old-account result" } }, 429)); await analyzing;
  assert.equal(f.calls.some((call) => call.url === "/api/training/add"), false);
  assert.equal(f.run("state.file"), null);
  assert.equal(f.el("photo-training-group").value, "");
  assert.equal(f.el("photo-training-message").textContent, "");
});

test("saving requires an explicit label and login before sending any photo", async () => {
  const f = await fixture(); f.el("photo-training-label").value = "";
  await f.run("savePhotoForTraining()");
  assert.match(f.el("photo-training-message").textContent, /라벨/);
  f.auth.user = null;
  await f.run("savePhotoForTraining()");
  assert.match(f.el("photo-training-message").textContent, /로그인/);
  assert.equal(f.calls.some((call) => call.options?.method === "POST"), false);
});
