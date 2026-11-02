const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const flush = () => new Promise(setImmediate);
const answer = (usable = true) => ({ image_usable: usable, visible_signal: usable ? "not_obvious" : "unclear", summary: "Test target", observations: usable ? [{ area: "hairline", detail: "Visible outline" }] : [], limitations: ["Single photo"], next_steps: ["Record photos"] });
const status = () => ({ samples: [], total: 0, counts: { usable: 0, unusable: 0 }, groups: 0, reason: "More examples needed", signature: "snapshot", can_start: false, gpu_busy: false, own_job_running: false, runtime: { ready: true, gpu: "Test GPU" }, jobs: [], active_job: null });

async function fixture({ user = { id: 1 }, data = status(), transport } = {}) {
  const requests = [], events = {}, revoked = [], urls = [];
  class Element {
    constructor(tag = "div") { this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; this.dataset = {}; this.value = ""; this.hidden = false; this.checked = false; this.disabled = false; this.open = false; this.ownText = ""; this.files = []; this.classList = { toggle() {} }; }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map(c => c.textContent || "").join(""); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; this.ownText = ""; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
    fire(name, event = {}) { return Promise.all((this.events[name] || []).map(fn => fn(event))); }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire("close"); }
    reportValidity() { return true; }
    querySelectorAll(selector) {
      if (selector === "input, select, textarea") return controls;
      return this.children.flatMap(c => [...(c.tagName === selector ? [c] : []), ...c.querySelectorAll(selector)]);
    }
  }
  const html = fs.readFileSync(path.join(__dirname, "../vision-training.html"), "utf8");
  const elements = new Map([...html.matchAll(/<([\w-]+)[^>]*\bid="([\w-]+)"[^>]*>/g)].map(m => [m[2], new Element(m[1])]));
  const controls = [...elements.values()].filter(e => ["input", "select", "textarea"].includes(e.tagName));
  const document = { hidden: false, getElementById: id => elements.get(id), createElement: tag => new Element(tag),
    addEventListener: (name, fn) => { (events[name] ||= []).push(fn); }, dispatchEvent: event => { for (const fn of events[event.type] || []) fn(event); } };
  const auth = { user, ready: Promise.resolve(), headers: async () => ({ "X-CSRF-Token": "test-csrf" }) };
  const window = { HairlineAuth: auth, addEventListener() {} };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    if (transport) { const value = await transport(url, options); if (value) return value; }
    const result = url.endsWith("/status") ? data : { saved: true };
    return { ok: true, status: 200, json: async () => result };
  };
  const fakeURL = { createObjectURL(blob) { const id = "blob:" + urls.length; urls.push(id); return id; }, revokeObjectURL: url => revoked.push(url) };
  const context = vm.createContext({ window, document, fetch, URL: fakeURL, File, Blob, FormData, AbortController,
    CustomEvent: class { constructor(type) { this.type = type; } },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; }, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/vision-training.js"), "utf8"), context);
  await flush(); await flush();
  return { el: id => elements.get("vision-" + id), auth, data, requests, revoked, urls, document,
    async changeUser(value) { auth.user = value; await Promise.all((events["auth-changed"] || []).map(fn => fn())); },
    async photo() { elements.get("vision-photo").files = [new File(["synthetic"], "test.jpg", { type: "image/jpeg" })]; await elements.get("vision-photo").fire("change"); },
    buttons: id => elements.get("vision-" + id).querySelectorAll("button") };
}

test("private training data is never fetched before login and changing accounts clears the form and preview", async () => {
  const f = await fixture({ user: null });
  assert.equal(f.requests.length, 0); assert.equal(f.el("save").disabled, true);
  await f.changeUser({ id: 1 }); assert.equal(f.requests.length, 1);
  await f.photo(); f.el("summary").value = "private target"; f.el("storage-consent").checked = true;
  await f.changeUser(null);
  assert.equal(f.el("summary").value, ""); assert.equal(f.el("storage-consent").checked, false);
  assert.equal(f.el("preview").hidden, true); assert.equal(f.revoked.length, 1);
  assert.equal(f.el("samples").children.length, 0); assert.equal(f.el("jobs").children.length, 0);
});

test("selecting a photo never trains or analyzes and saving requires explicit storage consent", async () => {
  const f = await fixture(); await f.photo();
  assert.equal(f.requests.filter(r => r.options.method === "POST").length, 0);
  await f.el("workspace").fire("submit", { preventDefault() {} });
  assert.match(f.el("message").textContent, /동의/);
  assert.equal(f.requests.filter(r => r.options.method === "POST").length, 0);
  f.el("storage-consent").checked = true; f.el("group").value = "p001"; f.el("focus").value = "hairline";
  f.el("usable").value = "false"; await f.el("usable").fire("change");
  f.el("summary").value = "Test image cannot be observed"; f.el("limitations").value = "No visible hair"; f.el("next-steps").value = "Retake photo";
  await f.el("workspace").fire("submit", { preventDefault() {} }); await flush(); await flush();
  const request = f.requests.find(r => r.url.endsWith("/save")); assert.ok(request);
  assert.equal(request.options.headers["X-CSRF-Token"], "test-csrf");
  const target = JSON.parse(request.options.body.get("target"));
  assert.equal(target.image_usable, false); assert.equal(target.visible_signal, "unclear"); assert.deepEqual(target.observations, []);
  assert.equal(request.options.body.get("storage_consent"), "true"); assert.equal(request.options.body.get("group"), "p001");
});

test("starting is explicit and duplicate clicks never submit a second GPU job", async () => {
  let finish;
  const data = { ...status(), can_start: true };
  const f = await fixture({ data, transport: async url => url.endsWith("/start") ? await new Promise(resolve => { finish = () => resolve({ ok: true, status: 202, json: async () => ({ id: "a".repeat(32) }) }); }) : null });
  assert.equal(f.requests.filter(r => r.url.endsWith("/start")).length, 0);
  f.el("steps").value = "20";
  await f.el("start").fire("click"); await flush(); await f.el("start").fire("click");
  assert.equal(f.requests.filter(r => r.url.endsWith("/start")).length, 1);
  assert.equal(f.el("start").disabled, true); finish(); await flush(); await flush();
});

test("a delayed status response cannot repaint another account's private examples", async () => {
  let finish; let first = true;
  const f = await fixture({ transport: async url => {
    if (url.endsWith("/status") && first) { first = false; return { ok: true, status: 200, json: () => new Promise(resolve => { finish = () => resolve({ ...status(), total: 100 }); }) }; }
    return null;
  } });
  await f.changeUser(null); finish(); await flush(); await flush();
  assert.equal(f.el("sample-count").textContent, "0장"); assert.equal(f.el("save").disabled, true);
});

test("completed models expose local testing, activation, private export and late-test result protection", async () => {
  const id = "a".repeat(32); let finish;
  const data = { ...status(), jobs: [{ id, state: "completed", phase: "Completed", metadata: { training_size: 4, validation_size: 4, validation_loss: 1.2, dataset_signature: "snapshot" } }] };
  const f = await fixture({ data, transport: async url => url.endsWith("/test") ? { ok: true, status: 200, json: () => new Promise(resolve => { finish = () => resolve({ model: "local-test", elapsed_ms: 500, result: answer() }); }) } : null });
  await f.photo();
  const buttons = f.buttons("jobs");
  const testButton = buttons.find(b => b.textContent.includes("테스트"));
  const testing = testButton.fire("click"); await flush();
  assert.equal(f.el("test-dialog").open, true);
  const request = f.requests.find(r => r.url.endsWith("/test")); assert.equal(request.options.body.get("job_id"), id);
  await f.el("test-close").fire("click"); finish(); await testing; await flush(); await flush();
  assert.equal(f.el("test-dialog").open, false); assert.equal(f.el("test-result").textContent, "");
  const apply = buttons.find(b => b.textContent === "내 분석에 적용"); await apply.fire("click"); await flush(); await flush();
  assert.equal(f.requests.filter(r => r.url.endsWith("/activate")).length, 1);
  const anchors = f.el("jobs").querySelectorAll("a"); assert.match(anchors[0].href, /^\/api\/training\/vision\/export\/[a-f0-9]{32}$/);
});
