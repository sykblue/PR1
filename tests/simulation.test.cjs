const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const result = { image: "data:image/png;base64,dGVzdA==", elapsed_ms: 800, provider: "opencv", notice: "Virtual edit only" };
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
async function fixture({ respond, status, take, href = "http://127.0.0.1:8000/simulation", size = [800, 1000] } = {}) {
  class Element {
    constructor(tag = "div") {
      this.tagName = tag; this.events = {}; this.attributes = {}; this.dataset = {}; this.hidden = false; this.disabled = false;
      this.textContent = ""; this.value = ""; this.checked = false; this.styles = {}; this.children = [];
      this.style = { setProperty: (key, value) => { this.styles[key] = value; } };
      this.classList = { toggle() {}, add() {}, remove() {} };
    }
    addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
    fire(type, event = {}) { return Promise.all((this.events[type] || []).map((fn) => fn(event))); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; if (key === "src") delete this.src; }
    append(...nodes) { this.children.push(...nodes); }
    focus() { this.focused = true; }
    scrollIntoView() { this.scrolled = true; }
    click() { if (this.tagName === "a") downloads.push(this.download); }
    remove() {}
  }
  const html = fs.readFileSync(path.join(__dirname, "../simulation.html"), "utf8");
  const ids = new Map([...html.matchAll(/\bid="([\w-]+)"/g)].map((match) => [match[1], new Element()]));
  const radios = ["hairline", "crown", "density"].map((value, i) => Object.assign(new Element("input"), { value, checked: !i }));
  const presets = ["25", "50", "75"].map((value) => Object.assign(new Element("button"), { dataset: { strength: value } }));
  const modes = ["split", "side"].map((value) => Object.assign(new Element("button"), { dataset: { view: value } }));
  const steps = ["photo", "settings", "compare"].map((value) => Object.assign(new Element("li"), { dataset: { previewStep: value } }));
  const handlers = {}, windowHandlers = {}, calls = [], downloads = [], draw = [], history = [], transfers = [];
  const el = (id) => ids.get(id) || null;
  el("provider").options = ["opencv", "sd", "gemini"].map((value) => ({ value }));
  el("provider").value = "opencv"; el("strength").value = "35";
  const canvas = { getContext: () => ({ fillRect() {}, drawImage() {}, fillText: (...args) => draw.push(args) }),
    toBlob: (fn) => fn(new Blob(["output"], { type: "image/png" })) };
  const document = {
    getElementById: el, body: new Element("body"),
    querySelector: () => radios.find((item) => item.checked),
    querySelectorAll: (selector) => selector === "[data-preview-step]" ? steps : selector === "[data-view]" ? modes :
      selector === "[data-strength]" ? presets : selector.includes(",") ? [...radios, ...presets] : selector.includes('name="scenario"') ? radios : [],
    createElement: (tag) => tag === "canvas" ? canvas : new Element(tag),
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
    dispatchEvent: (event) => { for (const fn of handlers[event.type] || []) fn(event); }
  };
  const auth = { user: { id: 7 }, ready: Promise.resolve(), headers: async () => ({ "X-CSRF-Token": "test" }) };
  const window = { HairlineAuth: auth, location: { href, reload() {} }, history: { replaceState: (...args) => history.push(args[2]) },
    matchMedia: () => ({ matches: false }), addEventListener: (type, fn) => { (windowHandlers[type] ||= []).push(fn); },
    HairlinePhotoHandoff: { take: async (token, owner) => { transfers.push({ token, owner }); return take ? take() : null; } } };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/status") return status ? status() : json({ opencv_ready: true, segmentation_ready: true, sd_configured: false, paid_image_ready: true });
    if (url === "/api/simulate") return respond ? respond(options) : json(result);
    throw new Error("Unexpected API call " + url);
  };
  class Image {
    constructor() { this.naturalWidth = size[0]; this.naturalHeight = size[1]; }
    decode() { return Promise.resolve(); }
  }
  const file = new File(["test-photo"], "test.jpg", { type: "image/jpeg" });
  const context = vm.createContext({ window, document, fetch, Image, file, File, Blob, URL, URLSearchParams, FormData,
    AbortController, AbortSignal, DOMException, Date, Number,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/simulation.js"), "utf8"), context);
  await new Promise(setImmediate);
  return { el, context, calls, downloads, draw, radios, presets, modes, steps, document, auth, history, transfers,
    run: (code) => vm.runInContext(code, context), posts: () => calls.filter((item) => item.options?.method === "POST") };
}

test("the actual simulation page initializes independently and photo selection never generates an image", async () => {
  const f = await fixture();
  assert.equal(f.el("simulate-button").disabled, true);
  await f.run("selectPhoto(file)");
  assert.equal(f.el("simulate-button").disabled, false);
  assert.equal(f.el("comparison-empty").hidden, true);
  assert.equal(f.el("comparison").hidden, false);
  assert.equal(f.posts().length, 0);
  await f.run('selectPhoto(new File(["bad"], "bad.txt", {type:"text/plain"}))');
  assert.match(f.el("simulation-message").textContent, /JPG/);
  assert.equal(f.run("preview.file.name"), "test.jpg");
  const tiny = await fixture({ size: [100, 100] });
  await tiny.run("selectPhoto(file)");
  assert.equal(tiny.run("preview.file"), null);
  assert.match(tiny.el("simulation-message").textContent, /160px/);
});

test("an explicit local edit submits its selected settings, supports both comparisons and saves with a notice", async () => {
  const f = await fixture();
  await f.run("selectPhoto(file)");
  f.radios.forEach((item) => { item.checked = item.value === "crown"; });
  await f.presets[1].fire("click");
  await f.el("simulate-button").fire("click");
  const body = f.posts()[0].options.body;
  assert.equal(f.posts().length, 1);
  assert.equal(f.posts()[0].url, "/api/simulate");
  assert.equal(body.get("scenario"), "crown");
  assert.equal(body.get("strength"), "50");
  assert.equal(body.get("provider"), "opencv");
  assert.equal(body.get("consent"), "false");
  assert.equal(body.get("photo").name, "test.jpg");
  assert.equal(f.el("compare-after").src, result.image);
  assert.equal(f.el("download-image").disabled, false);
  await f.el("compare-slider").fire("input", { target: { value: "70" } });
  assert.equal(f.el("comparison").styles["--split"], "70%");
  await f.modes[1].fire("click");
  assert.equal(f.el("side-comparison").hidden, false);
  assert.equal(f.el("comparison").hidden, true);
  await f.el("reset-comparison").fire("click");
  assert.equal(f.el("side-comparison").hidden, true);
  assert.equal(f.el("compare-slider").value, "50");
  await f.el("download-image").fire("click");
  assert.deepEqual(f.downloads, ["hairline-lab-simulation.png"]);
  assert.match(f.draw[0][0], /가상 모발 편집.*예측 아님/);
});

test("changing settings or a photo clears the previous generated result and disables its download", async () => {
  const f = await fixture();
  await f.run("selectPhoto(file)");
  await f.run("simulate()");
  await f.presets[2].fire("click");
  assert.equal(f.run("preview.generated"), null);
  assert.equal(f.el("compare-after").src, undefined);
  assert.equal(f.el("download-image").disabled, true);
  assert.equal(f.el("strength-value").textContent, "75");
  assert.equal(f.presets[2].attributes["aria-pressed"], "true");
  await f.run("simulate()");
  await f.run("resetPhoto()");
  assert.equal(f.run("preview.file"), null);
  assert.equal(f.el("comparison-empty").hidden, false);
  assert.equal(f.el("simulate-button").disabled, true);
});

test("Google image editing requires separate transfer and cost consents and changing providers revokes them", async () => {
  const f = await fixture();
  await f.run("selectPhoto(file)");
  f.el("provider").value = "gemini";
  await f.el("provider").fire("change");
  assert.equal(f.el("google-consents").hidden, false);
  await f.run("simulate()");
  f.el("simulation-consent").checked = true;
  await f.run("simulate()");
  assert.equal(f.posts().length, 0);
  f.el("paid-consent").checked = true;
  await f.run("simulate()");
  assert.equal(f.posts()[0].options.body.get("consent"), "true");
  assert.equal(f.posts()[0].options.body.get("paid_consent"), "true");
  f.el("provider").value = "opencv";
  await f.el("provider").fire("change");
  assert.equal(f.el("paid-consent").checked, false);
  assert.equal(f.el("simulation-consent").checked, false);
  assert.equal(f.run("preview.generated"), null);
});

test("unavailable and failed status checks never allow an unprepared editing provider", async () => {
  for (const status of [async () => json({}), async () => { throw new TypeError("offline"); }]) {
    const f = await fixture({ status });
    await f.run("selectPhoto(file)");
    await f.run("simulate()");
    assert.equal(f.posts().length, 0);
    assert.equal(f.el("simulate-button").disabled, true);
  }
});

test("failed generation retains the source, clears old output and permits an explicit retry", async () => {
  let count = 0;
  const f = await fixture({ respond: async () => ++count === 1 ? json({ error: { message: "No hair region" } }, 422) : json(result) });
  await f.run("selectPhoto(file)");
  await f.run("simulate()");
  assert.match(f.el("simulation-message").textContent, /No hair region/);
  assert.equal(f.run("preview.file.name"), "test.jpg");
  assert.equal(f.el("download-image").disabled, true);
  await f.run("simulate()");
  assert.equal(f.posts().length, 2);
  assert.equal(f.el("download-image").disabled, false);
});

test("account changes and waiting cancellation discard late generation responses", async () => {
  for (const action of ["account", "cancel"]) {
    let finish;
    const f = await fixture({ respond: () => new Promise((resolve) => { finish = resolve; }) });
    await f.run("selectPhoto(file)");
    const pending = f.run("simulate()");
    await new Promise(setImmediate);
    if (action === "account") f.document.dispatchEvent({ type: "auth-changed" });
    else await f.el("cancel-simulation").fire("click");
    finish(json(result)); await pending;
    assert.equal(f.run("preview.generated"), null);
    assert.equal(f.el("download-image").disabled, true);
    assert.equal(f.run("preview.busy"), false);
    assert.equal(f.run("preview.file === null"), action === "account");
  }
});

test("the handoff URL is consumed with the current owner and removed without generating an image", async () => {
  const file = new File(["transferred"], "original.jpg", { type: "image/jpeg" });
  const f = await fixture({ href: "http://127.0.0.1:8000/simulation?photo=one-use-token", take: async () => file });
  assert.deepEqual(f.transfers, [{ token: "one-use-token", owner: 7 }]);
  assert.deepEqual(f.history, ["/simulation"]);
  assert.equal(f.run("preview.file.name"), "original.jpg");
  assert.equal(f.posts().length, 0);
});

test("a late or missing photo handoff cannot replace a manually selected photo", async () => {
  let finish;
  const f = await fixture({ href: "http://127.0.0.1:8000/simulation?photo=one-use-token",
    take: () => new Promise((resolve) => { finish = resolve; }) });
  await f.run("selectPhoto(file)");
  finish(new File(["old"], "old.jpg", { type: "image/jpeg" }));
  await new Promise(setImmediate);
  assert.equal(f.run("preview.file.name"), "test.jpg");
  const missing = await fixture({ href: "http://127.0.0.1:8000/simulation?photo=expired" });
  assert.equal(missing.run("preview.file"), null);
  assert.match(missing.el("simulation-message").textContent, /전달 시간/);
});
