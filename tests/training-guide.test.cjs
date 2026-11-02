const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor() { this.events = {}; this.textContent = ""; this.dataset = {}; }
  addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
  dispatchEvent(event) { for (const fn of this.events[event.type] || []) fn(event); }
  setAttribute() {}
  removeAttribute() {}
}
const data = (extra = {}) => ({ minimum_per_label: 5, minimum_groups_per_label: 2, minimum_groups_total: 4,
  total_groups: 2, total: 3, counts: { reference: 2, concern: 1 }, group_counts: { reference: 1, concern: 1 },
  samples: [], can_train: false, model_ready: false, model_stale: false, ...extra });
async function fixture({ user = { id: 7 }, result = data(), pending = null } = {}) {
  const elements = new Map(), calls = [];
  const el = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  el("guide-readiness").dataset = { minimumPhotos: "5", minimumGroups: "2", minimumTotalGroups: "4" };
  const document = new Element(); document.getElementById = el;
  const auth = { user, ready: Promise.resolve() }, window = { HairlineAuth: auth };
  const fetch = async (url) => { calls.push(url); if (pending) await pending;
    return { ok: true, status: 200, json: async () => result }; };
  const context = vm.createContext({ window, document, fetch, AbortController, Date,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/training-guide.js"), "utf8"), context);
  await new Promise(setImmediate);
  return { el, document, auth, calls };
}

test("public guide does not request private training data before login", async () => {
  const f = await fixture({ user: null });
  assert.equal(f.calls.length, 0);
  assert.equal(f.el("guide-metrics").hidden, true);
  assert.equal(f.el("guide-login").hidden, false);
  assert.match(f.el("guide-status-summary").textContent, /로그인/);
});

test("guide shows real counts and remaining photos and people groups", async () => {
  const f = await fixture();
  assert.deepEqual(f.calls, ["/api/training/status"]);
  assert.equal(f.el("guide-reference-count").textContent, "2 / 5장");
  assert.equal(f.el("guide-concern-count").textContent, "1 / 5장");
  assert.match(f.el("guide-data-message").textContent, /기준 사진 3장/);
  assert.match(f.el("guide-data-message").textContent, /의심 사진 4장/);
  assert.match(f.el("guide-data-message").textContent, /전체 사람 그룹 2개/);
});

test("prepared or changed data asks for one fit; unchanged ready model needs no extra fit", async () => {
  for (const status of [{ can_train: true }, { can_train: true, model_stale: true }, { can_train: true, model_ready: true }]) {
    const f = await fixture({ result: data({ counts: { reference: 5, concern: 5 }, group_counts: { reference: 2, concern: 2 }, total_groups: 4, total: 10, ...status }) });
    assert.equal(f.el("guide-model-state").textContent, status.model_ready ? "학습 완료" : "학습 1회 필요");
    if (status.model_stale) assert.match(f.el("guide-status-summary").textContent, /바뀌었어요/);
    if (status.model_ready) assert.match(f.el("guide-status-summary").textContent, /추가 학습이 필요하지 않아요/);
  }
});

test("logout clears readiness metrics and ignores a late response", async () => {
  let resolve;
  const f = await fixture({ pending: new Promise((done) => { resolve = done; }) });
  f.auth.user = null; f.document.dispatchEvent({ type: "auth-changed" });
  resolve(); await new Promise(setImmediate);
  assert.equal(f.el("guide-metrics").hidden, true);
  assert.equal(f.el("guide-reference-count").textContent, "—");
  assert.equal(f.el("guide-model-state").textContent, "로그인 후 확인");
});
