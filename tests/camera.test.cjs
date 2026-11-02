const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

class Element {
  constructor() { this.handlers = {}; this.disabled = false; this.open = false; this.classes = new Set();
    this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) }; }
  addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
  fire(name, event = {}) { return Promise.all((this.handlers[name] || []).map((fn) => fn(event))); }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire("close"); }
  click() { this.clicked = true; }
  focus() { this.focused = true; }
  play() { return Promise.resolve(); }
}
function media(facing = "user") {
  const track = { stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ facingMode: facing }) };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}
function fixture(getUserMedia, customBlob) {
  const ids = new Map();
  const el = (id) => { if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id); };
  const document = new Element(); document.getElementById = el; document.hidden = false;
  const canvas = { getContext: () => ({ drawImage: (...args) => { canvas.drawn = args; } }),
    toBlob: customBlob || ((callback, type) => callback(new Blob(["photo"], { type }))) };
  document.createElement = () => canvas;
  const window = new Element(), selected = [], calls = [];
  const navigator = { mediaDevices: getUserMedia ? { getUserMedia: (options) => { calls.push(options); return getUserMedia(options); } } : {} };
  el("camera-video").videoWidth = 1920; el("camera-video").videoHeight = 1080;
  const context = vm.createContext({ document, window, navigator, Blob, File, Date,
    selectPhoto: async (file) => selected.push(file) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/camera.js"), "utf8"), context);
  return { el, document, window, calls, selected, canvas };
}

test("camera permission starts only on click, without microphone; close releases tracks", async () => {
  const stream = media();
  const f = fixture(async () => stream);
  assert.equal(f.calls.length, 0);
  await f.el("camera-open").fire("click");
  assert.equal(f.calls[0].audio, false);
  assert.equal(f.calls[0].video.facingMode.ideal, "user");
  assert.equal(f.el("camera-video").srcObject, stream);
  assert.equal(f.el("camera-capture").disabled, false);
  assert.ok(f.el("camera-video").classes.has("mirrored"));
  await f.el("camera-close").fire("click");
  assert.ok(stream.track.stopped);
  assert.equal(f.el("camera-video").srcObject, null);
});

test("permission arriving after close is discarded and its tracks stopped", async () => {
  let grant;
  const stream = media();
  const f = fixture(() => new Promise((resolve) => { grant = resolve; }));
  const opening = f.el("camera-open").fire("click");
  await f.el("camera-close").fire("click");
  grant(stream); await opening;
  assert.ok(stream.track.stopped);
  assert.equal(f.el("camera-video").srcObject, null);
});

test("capture produces a JPEG for the existing photo flow, and releases camera", async () => {
  const stream = media(), f = fixture(async () => stream);
  await f.el("camera-open").fire("click");
  await f.el("camera-capture").fire("click");
  assert.equal(f.selected.length, 1);
  assert.equal(f.selected[0].type, "image/jpeg");
  assert.equal(f.canvas.width, 1280); assert.equal(f.canvas.height, 720);
  assert.equal(f.canvas.drawn[0], f.el("camera-video"));
  assert.ok(stream.track.stopped);
  assert.equal(f.el("camera-dialog").open, false);
  assert.equal(f.el("analyze-button").focused, true);
});

test("capture can focus the generation action on the separate simulation page", async () => {
  const f = fixture(async () => media());
  const lookup = f.document.getElementById;
  f.document.getElementById = (id) => id === "analyze-button" ? null : lookup(id);
  await f.el("camera-open").fire("click");
  await f.el("camera-capture").fire("click");
  assert.equal(f.selected.length, 1);
  assert.equal(f.el("simulate-button").focused, true);
});

test("switch replaces the stream; hiding the tab releases the new stream", async () => {
  const front = media(), back = media("environment"); let count = 0;
  const f = fixture(async () => count++ ? back : front);
  await f.el("camera-open").fire("click");
  await f.el("camera-switch").fire("click");
  assert.ok(front.track.stopped);
  assert.equal(f.calls[1].video.facingMode.ideal, "environment");
  assert.equal(f.el("camera-video").classes.has("mirrored"), false);
  f.document.hidden = true; await f.document.fire("visibilitychange");
  assert.ok(back.track.stopped);
  assert.equal(f.el("camera-dialog").open, false);
});

test("account change discards a pending captured image", async () => {
  let finishBlob;
  const stream = media(), f = fixture(async () => stream, (callback) => { finishBlob = callback; });
  await f.el("camera-open").fire("click");
  const capturing = f.el("camera-capture").fire("click");
  await f.document.fire("auth-changed");
  finishBlob(new Blob(["photo"], { type: "image/jpeg" })); await capturing;
  assert.ok(stream.track.stopped);
  assert.equal(f.selected.length, 0);
});

test("permission denial leaves capture disabled with a useful message", async () => {
  const f = fixture(async () => { throw Object.assign(new Error(), { name: "NotAllowedError" }); });
  await f.el("camera-open").fire("click");
  assert.equal(f.el("camera-capture").disabled, true);
  assert.match(f.el("camera-message").textContent, /권한/);
});

test("unsupported media API opens native image capture and reuses photo selection", async () => {
  const f = fixture();
  await f.el("camera-open").fire("click");
  assert.equal(f.el("camera-file").clicked, true);
  const photo = new File(["photo"], "native.jpg", { type: "image/jpeg" });
  await f.el("camera-file").fire("change", { target: { files: [photo], value: "native.jpg" } });
  assert.equal(f.selected[0], photo);
});
