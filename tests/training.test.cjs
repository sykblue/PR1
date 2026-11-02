const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const flush = () => new Promise(setImmediate);
const status = () => ({ counts: { reference: 0, concern: 0 }, group_counts: { reference: 0, concern: 0 },
  total: 0, can_train: false, model_ready: false, model_stale: false, model: null, samples: [] });
const json = (data, code = 200) => ({ ok: code < 400, status: code, json: async () => data });

async function fixture({ user = { id: 1 }, native = false, deferredCapture = false, transport } = {}) {
  let document, finishCapture;
  const requests = [], cameraCalls = [], urls = [], revoked = [];
  class Element {
    constructor(tag = "div") { this.tagName = tag; this.events = {}; this.attributes = {}; this.children = []; this.value = ""; this.files = []; this.checked = false; this.disabled = false; this.hidden = false; this.open = false; this.textContent = ""; this.classList = { toggle() {} }; }
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
    fire(name, event = {}) { return Promise.all((this.events[name] || []).map(fn => fn(event))); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; if (key === "src") delete this.src; }
    querySelector(selector) { return this.children.find(node => node.tagName === selector) || null; }
    querySelectorAll(selector) { return this.children.flatMap(node => [...(node.tagName === selector ? [node] : []), ...node.querySelectorAll(selector)]); }
    focus() { document.activeElement = this; }
    click() { this.clicked = true; }
    remove() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.fire("close"); }
    play() { return Promise.resolve(); }
  }
  const html = fs.readFileSync(path.join(__dirname, "../training.html"), "utf8");
  const elements = new Map([...html.matchAll(/<([\w-]+)[^>]*\bid="([\w-]+)"[^>]*>/g)].map(match => {
    const node = new Element(match[1]); node.hidden = /\shidden(?:\s|>)/.test(match[0]);
    return [match[2], node];
  }));
  const el = id => elements.get(id) || null;
  el("training-run").append(new Element("span")); el("training-label").value = "reference";
  const track = { stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ facingMode: "user" }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const canvas = { getContext: () => ({ drawImage() {} }), toBlob(callback) {
    if (deferredCapture) finishCapture = callback;
    else callback(new Blob(["synthetic-camera-image"], { type: "image/jpeg" }));
  } };
  document = new Element("document"); document.hidden = false; document.body = new Element("body");
  document.getElementById = el;
  document.createElement = tag => tag === "canvas" ? canvas : new Element(tag);
  document.dispatchEvent = event => { document.fire(event.type, event); };
  const auth = { user, ready: Promise.resolve(), headers: async () => ({ "X-CSRF-Token": "test-csrf" }), open() {} };
  const window = new Element("window"); window.HairlineAuth = auth;
  const navigator = { mediaDevices: native ? {} : { getUserMedia: async options => { cameraCalls.push(options); return stream; } } };
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (transport) { const result = await transport(url, options); if (result) return result; }
    return json(url.endsWith("/add") ? { status: status() } : status());
  };
  const fakeURL = { createObjectURL(file) { const url = "blob:training-" + urls.length; urls.push({ url, file }); return url; }, revokeObjectURL(url) { revoked.push(url); } };
  el("camera-video").videoWidth = 1280; el("camera-video").videoHeight = 960;
  const context = vm.createContext({ document, window, navigator, fetch, Blob, File, FormData, AbortController, URL: fakeURL,
    CustomEvent: class { constructor(type) { this.type = type; } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout });
  for (const script of ["training.js", "camera.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../static", script), "utf8"), context);
  await flush(); await flush();
  return { el, requests, cameraCalls, urls, revoked, track, document, window,
    posts: () => requests.filter(call => call.options.method === "POST"),
    capture: async () => { await el("camera-open").fire("click"); await el("camera-capture").fire("click"); },
    finishCapture: () => finishCapture(new Blob(["late-camera-image"], { type: "image/jpeg" })),
    async changeUser(value) { auth.user = value; await document.fire("auth-changed"); await flush(); await flush(); } };
}

test("anonymous training has no introduction or login banner and never opens a camera or fetches private data automatically", async () => {
  const f = await fixture({ user: null });
  assert.deepEqual(f.requests, []); assert.deepEqual(f.cameraCalls, []);
  assert.equal(f.el("training-message").hidden, true);
  assert.equal(f.el("training-model-state"), null);
  assert.equal(f.el("camera-open").disabled, true); assert.equal(f.el("training-add").disabled, true);
});

test("camera capture only stages a JPEG preview, releases the stream and focuses explicit registration", async () => {
  const f = await fixture();
  assert.equal(f.cameraCalls.length, 0);
  await f.capture();
  assert.equal(f.cameraCalls[0].audio, false);
  assert.equal(f.el("training-camera-preview").hidden, false);
  assert.equal(f.urls[0].file.type, "image/jpeg");
  assert.equal(f.track.stopped, true); assert.equal(f.el("camera-dialog").open, false);
  assert.equal(f.document.activeElement, f.el("training-add"));
  assert.deepEqual(f.posts(), []); assert.equal(f.el("training-storage-consent").checked, false);
});

test("a captured photo requires a group and storage consent and is saved only by registration", async () => {
  const f = await fixture(); await f.capture();
  await f.el("training-add").fire("click"); assert.deepEqual(f.posts(), []);
  f.el("training-group").value = "p001"; f.el("training-label").value = "concern";
  await f.el("training-add").fire("click"); assert.deepEqual(f.posts(), []);
  assert.match(f.el("training-message").textContent, /동의/);
  f.el("training-storage-consent").checked = true; await f.el("training-add").fire("click");
  assert.equal(f.posts().length, 1);
  const call = f.posts()[0], body = call.options.body;
  assert.equal(call.url, "/api/training/add"); assert.equal(call.options.headers["X-CSRF-Token"], "test-csrf");
  assert.equal(body.get("photo"), f.urls[0].file); assert.equal(body.get("group"), "p001");
  assert.equal(body.get("label"), "concern"); assert.equal(body.get("storage_consent"), "true");
  assert.equal(f.el("training-camera-preview").hidden, true);
  assert.deepEqual(f.revoked, [f.urls[0].url]); assert.equal(f.el("training-storage-consent").checked, false);
});

test("failed registration retains the capture for a manual retry and requires renewed consent", async () => {
  let failed = false;
  const f = await fixture({ transport: async url => {
    if (url.endsWith("/add") && !failed) { failed = true; return json({ error: { message: "Try again" } }, 503); }
  } });
  await f.capture(); f.el("training-group").value = "p001"; f.el("training-storage-consent").checked = true;
  await f.el("training-add").fire("click");
  assert.equal(f.el("training-camera-preview").hidden, false); assert.equal(f.revoked.length, 0);
  assert.equal(f.el("training-storage-consent").checked, false); assert.equal(f.posts().length, 1);
  f.el("training-storage-consent").checked = true; await f.el("training-add").fire("click");
  assert.equal(f.posts().length, 2); assert.equal(f.el("training-camera-preview").hidden, true);
});

test("native capture is staged locally and choosing files replaces it without mixing sources", async () => {
  const f = await fixture({ native: true }); await f.el("camera-open").fire("click");
  assert.equal(f.el("camera-file").clicked, true);
  const shot = new File(["native-shot"], "native.jpg", { type: "image/jpeg" });
  await f.el("camera-file").fire("change", { target: { files: [shot], value: "native.jpg" } });
  assert.equal(f.el("training-camera-preview").hidden, false); assert.deepEqual(f.posts(), []);
  const files = [new File(["upload-a"], "a.png", { type: "image/png" }), new File(["upload-b"], "b.png", { type: "image/png" })];
  f.el("training-files").files = files; await f.el("training-files").fire("change");
  assert.equal(f.el("training-camera-preview").hidden, true); assert.deepEqual(f.revoked, [f.urls[0].url]);
  f.el("training-group").value = "p002"; f.el("training-storage-consent").checked = true;
  await f.el("training-add").fire("click");
  assert.deepEqual(f.posts().map(call => call.options.body.get("photo").name), ["a.png", "b.png"]);
});

test("account changes clear a captured preview and discard a photo still being encoded", async () => {
  const ready = await fixture(); await ready.capture(); await ready.changeUser(null);
  assert.equal(ready.el("training-camera-preview").hidden, true);
  assert.equal(ready.el("camera-open").disabled, true); assert.equal(ready.el("training-message").hidden, true);
  assert.deepEqual(ready.revoked, [ready.urls[0].url]);
  const pending = await fixture({ deferredCapture: true }); await pending.el("camera-open").fire("click");
  const capture = pending.el("camera-capture").fire("click"); await pending.changeUser({ id: 2 });
  pending.finishCapture(); await capture;
  assert.equal(pending.el("training-camera-preview").hidden, true);
  assert.equal(pending.urls.length, 0); assert.equal(pending.track.stopped, true); assert.deepEqual(pending.posts(), []);
});

test("a native picker opened by a previous account cannot populate the next account", async () => {
  const f = await fixture({ native: true }); await f.el("camera-open").fire("click"); await f.changeUser({ id: 2 });
  const shot = new File(["previous-account"], "old.jpg", { type: "image/jpeg" });
  await f.el("camera-file").fire("change", { target: { files: [shot], value: "old.jpg" } });
  assert.equal(f.el("training-camera-preview").hidden, true); assert.equal(f.urls.length, 0); assert.deepEqual(f.posts(), []);
});

test("opening the device camera can hide the page without discarding the returned photo", async () => {
  const f = await fixture({ native: true }); await f.el("camera-open").fire("click");
  f.document.hidden = true; await f.document.fire("visibilitychange"); f.document.hidden = false;
  const shot = new File(["device-camera"], "device.jpg", { type: "image/jpeg" });
  await f.el("camera-file").fire("change", { target: { files: [shot], value: "device.jpg" } });
  assert.equal(f.el("training-camera-preview").hidden, false); assert.equal(f.urls[0].file, shot); assert.deepEqual(f.posts(), []);
  await f.el("training-camera-remove").fire("click");
  assert.equal(f.el("training-camera-preview").hidden, true); assert.deepEqual(f.revoked, [f.urls[0].url]);
});
