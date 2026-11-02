const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../static/page-experience.js"), "utf8");
const flush = () => new Promise(setImmediate);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function fixture({ reduced = false, previousBusy, domReady = false, hasMain = true } = {}) {
  class Element {
    constructor() { this.attributes = {}; this.textContent = ""; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
    removeAttribute(name) { delete this.attributes[name]; }
  }
  const root = new Element(), main = new Element(), announcement = new Element();
  if (previousBusy !== undefined) main.setAttribute("aria-busy", previousBusy);
  const documentEvents = {}, windowEvents = {}, frames = new Map(), timers = new Map();
  let nextId = 0;
  const document = { documentElement: root, readyState: domReady ? "interactive" : "loading",
    querySelector: selector => selector === "main[data-page-content]" ? hasMain ? main : null : announcement,
    addEventListener: (type, callback) => { (documentEvents[type] ||= []).push(callback); } };
  const window = { matchMedia: query => { assert.equal(query, "(prefers-reduced-motion: reduce)"); return { matches: reduced }; },
    requestAnimationFrame: callback => { const id = ++nextId; frames.set(id, callback); return id; },
    addEventListener: (type, callback) => { (windowEvents[type] ||= []).push(callback); } };
  Object.defineProperty(window, "location", { get() { throw Error("Page effects must not replace navigation"); } });
  const context = vm.createContext({ document, window, Promise, Set,
    setTimeout: (callback, ms) => { const id = ++nextId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id) });
  vm.runInContext(source, context);
  return { root, main, announcement, api: window.HairlinePage, timers, windowEvents, documentEvents,
    dom() { document.readyState = "interactive"; for (const callback of documentEvents.DOMContentLoaded || []) callback(); },
    frame() { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback()); },
    event(type, value = {}) { for (const callback of windowEvents[type] || []) callback(value); },
    failsafe() { const entry = [...timers.values()].find(timer => timer.ms === 6500); assert.ok(entry); entry.callback(); } };
}

test("the initial skeleton waits for DOM and tracked startup work, then restores the page without a minimum delay", async () => {
  const f = fixture(), auth = deferred(), data = deferred();
  assert.equal(f.api.track(auth.promise), auth.promise); f.api.track(data.promise);
  assert.equal(f.root.getAttribute("data-page-loading"), "true");
  f.frame(); assert.equal(f.root.getAttribute("data-page-loading"), "true");
  f.dom(); assert.equal(f.main.getAttribute("aria-busy"), "true");
  auth.resolve(); await flush(); f.frame();
  assert.equal(f.main.getAttribute("data-page-ready"), null);
  data.resolve(); await flush(); f.frame(); await f.api.ready;
  assert.equal(f.root.getAttribute("data-page-loading"), null);
  assert.equal(f.main.getAttribute("aria-busy"), null);
  assert.equal(f.main.getAttribute("data-page-ready"), "true");
  assert.equal(f.announcement.textContent, ""); assert.equal(f.timers.size, 0);
});

test("an async bootstrap can register its next request before the completion frame", async () => {
  const f = fixture(), auth = deferred(), status = deferred();
  f.api.track(auth.promise);
  auth.promise.then(() => f.api.track(status.promise));
  f.dom(); auth.resolve(); await flush(); f.frame();
  assert.equal(f.root.getAttribute("data-page-loading"), "true");
  status.resolve(); await flush(); f.frame();
  assert.equal(f.root.getAttribute("data-page-loading"), null);
});

test("a failed bootstrap releases the skeleton and preserves the caller's error and earlier busy state", async () => {
  const f = fixture({ previousBusy: "false" }), task = deferred();
  const original = new Error("Handled by the page");
  f.api.track(task.promise); f.dom(); task.reject(original);
  await assert.rejects(task.promise, error => error === original);
  await flush(); f.frame();
  assert.equal(f.root.getAttribute("data-page-loading"), null);
  assert.equal(f.main.getAttribute("aria-busy"), "false");
});

test("the failsafe also works before DOM arrival and late responses cannot cover ready content again", async () => {
  const f = fixture(), task = deferred();
  f.api.track(task.promise); f.failsafe(); await f.api.ready;
  assert.equal(f.root.getAttribute("data-page-loading"), null);
  f.dom(); assert.equal(f.main.getAttribute("data-page-ready"), "true");
  const later = deferred(); f.api.track(later.promise);
  task.resolve(); later.resolve(); await flush(); f.frame();
  assert.equal(f.root.getAttribute("data-page-loading"), null);
  assert.equal(f.main.getAttribute("aria-busy"), null);
});

test("back-forward restoration cannot retain a pending skeleton and never intercepts links or location", async () => {
  const f = fixture(), task = deferred(); f.api.track(task.promise); f.dom();
  f.event("pageshow", { persisted: true }); await f.api.ready;
  assert.equal(f.root.getAttribute("data-page-loading"), null);
  assert.equal(f.main.getAttribute("aria-busy"), null);
  assert.equal(f.documentEvents.click, undefined);
  assert.equal(f.windowEvents.beforeunload, undefined);
  task.resolve(); await flush();
});

test("native entrances avoid duplicate entry effects while reduced-motion users skip the transition", () => {
  const regular = fixture(); const native = { skipTransition() { throw Error("Regular transition should run"); } };
  regular.event("pagereveal", { viewTransition: native });
  assert.equal(regular.root.getAttribute("data-native-page-entry"), "true");
  const reduced = fixture({ reduced: true }); let skipped = 0;
  reduced.event("pagereveal", { viewTransition: { skipTransition() { skipped++; } } });
  assert.equal(skipped, 1); assert.equal(reduced.root.getAttribute("data-native-page-entry"), null);
});

test("static and late-loaded documents finish in the next frame, including a missing surface", async () => {
  for (const hasMain of [true, false]) {
    const f = fixture({ domReady: true, hasMain }); f.frame(); await f.api.ready;
    assert.equal(f.root.getAttribute("data-page-loading"), null);
  }
});
