const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "../static/home.js"), "utf8");
const flush = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const data = (fields = {}) => ({ report_count: 7, photo_count: 3,
  training: { total: 2, model_ready: false, model_stale: false, can_train: false },
  recent_reports: [{ id: 7, created_at: "2026-11-01T18:00:00+00:00", summary: "Saved observation" }], ...fields });

function fixture({ hash = "", user = null, ready = Promise.resolve(), request = async () => ({ ok: true, json: async () => data() }) } = {}) {
  class Element {
    constructor(tag = "div") { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.textContent = ""; this.hidden = false; this.disabled = false; this.clicks = 0; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    replaceChildren(...children) { this.children = [...children]; }
    append(...children) { this.children.push(...children); }
    addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
    fire(type, event = {}) { for (const fn of this.events[type] || []) fn(event); }
    click() { this.clicks++; this.fire("click", { preventDefault() {} }); }
    set innerHTML(_value) { throw Error("Account text must never be inserted as HTML"); }
  }
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const lookups = [], destinations = [], requests = [], docEvents = {}, winEvents = {}, timers = new Map(), tracked = [];
  let timerId = 0;
  const auth = { user, ready };
  const document = { getElementById(id) { lookups.push(id); return elements.get(id); }, createElement: tag => new Element(tag),
    addEventListener(type, fn) { (docEvents[type] ||= []).push(fn); } };
  const window = { location: { hash, replace: url => destinations.push(url), assign: url => destinations.push(url) }, HairlineAuth: auth, HairlinePage: { track: promise => tracked.push(promise) },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    addEventListener(type, fn) { (winEvents[type] ||= []).push(fn); } };
  const fetch = (url, options) => { requests.push({ url, options }); return request(url, options); };
  vm.runInContext(source, vm.createContext({ window, document, fetch, AbortController, Intl, Date }));
  return { el: id => elements.get(id), requests, destinations, lookups, tracked, timers,
    doc(type, event = {}) { for (const fn of docEvents[type] || []) fn(event); },
    event(type, event = {}) { for (const fn of winEvents[type] || []) fn(event); },
    account(user) { auth.user = user; this.doc("auth-changed", { detail: { user } }); } };
}

test("old feature bookmarks redirect without starting the dashboard", async () => {
  for (const [hash, target] of [["#analysis", "/analysis"], ["#simulation", "/simulation"], ["#guide", "/guide"]]) {
    const f = fixture({ hash }); await flush();
    assert.deepEqual(f.destinations, [target]); assert.equal(f.lookups.length, 0); assert.equal(f.requests.length, 0);
  }
});

test("guests see sign-in and empty states without private, analysis or model requests", async () => {
  for (const hash of ["", "#history"]) {
    const f = fixture({ hash }); await flush();
    assert.equal(f.requests.length, 0);
    assert.equal(f.el("dashboard-report-count").textContent, "—");
    assert.equal(f.el("dashboard-login").hidden, false);
    assert.equal(f.el("dashboard-refresh").hidden, true);
    assert.match(f.el("dashboard-empty-copy").textContent, /로그인/);
  }
});

test("dashboard waits for auth and renders real account totals, safe summaries and KST dates", async () => {
  const ready = deferred();
  const f = fixture({ user: { id: 1, username: "<img onerror=bad>" }, ready: ready.promise, request: async () => ({ ok: true, json: async () => data({ recent_reports: [{ id: 77, summary: "<script>private</script>", created_at: "2026-11-01T18:00:00Z" }] }) }) });
  await flush(); assert.equal(f.requests.length, 0);
  ready.resolve(); await flush();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, "/api/dashboard");
  assert.equal(f.requests[0].options.cache, "no-store"); assert.equal(f.requests[0].options.credentials, "same-origin");
  assert.equal(f.el("dashboard-report-count").textContent, "7");
  assert.equal(f.el("dashboard-photo-count").textContent, "3");
  assert.equal(f.el("dashboard-training-count").textContent, "2");
  assert.equal(f.el("dashboard-notice").hidden, true);
  const link = f.el("dashboard-report-list").children[0].children[0];
  assert.equal(link.href, "/analysis?report=77");
  assert.equal(link.children[1].children[0].textContent, "<script>private</script>");
  assert.match(link.children[1].children[1].textContent, /2026\. 11\. 02/);
  assert.equal(f.el("dashboard-empty").hidden, true);
  assert.equal(f.el("dashboard-stats").attributes["aria-busy"], "false");
  assert.equal(f.timers.size, 0);
});

test("new accounts show genuine zeroes and each classifier state is represented", async () => {
  for (const [training, state] of [
    [{ total: 0, model_ready: false, model_stale: false, can_train: false }, "준비 중"],
    [{ total: 10, model_ready: false, model_stale: false, can_train: true }, "학습 가능"],
    [{ total: 10, model_ready: true, model_stale: false, can_train: true }, "사용 가능"],
    [{ total: 11, model_ready: false, model_stale: true, can_train: true }, "갱신 필요"]]) {
    const f = fixture({ user: { id: 1, username: "first" }, request: async () => ({ ok: true, json: async () => data({ report_count: 0, photo_count: 0, recent_reports: [], training }) }) });
    await flush();
    assert.equal(f.el("dashboard-report-count").textContent, "0");
    assert.equal(f.el("dashboard-model-state").textContent, state);
    assert.equal(f.el("dashboard-report-list").hidden, true);
    assert.equal(f.el("dashboard-empty").hidden, false);
    assert.match(f.el("dashboard-empty-title").textContent, /아직/);
  }
});

test("logout and account switching clear private data immediately and reject late replies", async () => {
  const late = deferred(); let calls = 0;
  const f = fixture({ user: { id: 1, username: "first" }, request: async () => ++calls === 1 ? late.promise : ({ ok: true, json: async () => data({ report_count: 1 }) }) });
  await flush(); const firstSignal = f.requests[0].options.signal;
  f.account(null);
  assert.equal(firstSignal.aborted, true);
  assert.equal(f.el("dashboard-report-count").textContent, "—");
  assert.equal(f.el("dashboard-report-list").children.length, 0);
  f.account({ id: 2, username: "second" }); await flush();
  assert.equal(f.el("dashboard-report-count").textContent, "1");
  late.resolve({ ok: true, json: async () => data({ report_count: 999 }) }); await flush();
  assert.equal(f.el("dashboard-report-count").textContent, "1");
  assert.match(f.el("dashboard-greeting").textContent, /second/);
});

test("failed refresh clears cached data, permits retry, and session expiry offers login", async () => {
  let reply = { ok: false, status: 503 };
  const f = fixture({ user: { id: 1, username: "first" }, request: async () => reply }); await flush();
  assert.match(f.el("dashboard-message").textContent, /불러오지 못/);
  assert.equal(f.el("dashboard-refresh").disabled, false);
  reply = { ok: true, json: async () => data() }; f.el("dashboard-refresh").click(); await flush();
  assert.equal(f.el("dashboard-report-count").textContent, "7");
  reply = { ok: false, status: 401 }; f.el("dashboard-refresh").click(); await flush();
  assert.equal(f.el("dashboard-report-count").textContent, "—");
  assert.equal(f.el("dashboard-report-list").children.length, 0);
  assert.equal(f.el("dashboard-login").hidden, false);
  assert.match(f.el("dashboard-message").textContent, /만료/);
});

test("history shortcuts use the existing history dialog and live updates refresh only signed-in accounts", async () => {
  const f = fixture({ user: { id: 1, username: "first" } }); await flush();
  for (const id of ["dashboard-history", "dashboard-stat-history", "dashboard-history-shortcut"]) {
    let prevented = false; f.el(id).fire("click", { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  }
  assert.equal(f.el("account-history").clicks, 3);
  f.el("dashboard-history").fire("click", { ctrlKey: true }); assert.equal(f.el("account-history").clicks, 3);
  f.doc("realtime-message", { detail: { type: "history.updated" } }); await flush();
  f.doc("realtime-message", { detail: { type: "training.updated" } }); await flush();
  assert.equal(f.requests.length, 3);
  f.account(null); f.doc("realtime-message", { detail: { type: "training.updated" } }); await flush();
  assert.equal(f.requests.length, 3);
  let prevented = false;
  f.el("dashboard-history-shortcut").fire("click", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(f.destinations, ["/login?next=%2F%23history"]);
});

test("timed-out summaries leave retry available and a failed auth bootstrap makes no private request", async () => {
  const f = fixture({ user: { id: 1 }, request: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Error("timeout")))) });
  await flush(); [...f.timers.values()][0](); await flush();
  assert.equal(f.el("dashboard-refresh").disabled, false);
  assert.match(f.el("dashboard-message").textContent, /불러오지 못/);
  const failed = fixture({ ready: Promise.reject(Error("offline")) }); await flush();
  assert.equal(failed.requests.length, 0); assert.match(failed.el("dashboard-message").textContent, /로그인 상태/);
});

test("reference-layout record search, sorting and page buttons work within the actual recent records", async () => {
  const reports = [14, 13, 12, 11].map(id => ({ id, created_at: "2026-11-01T18:00:00Z", summary: id === 12 ? "Hairline lighting" : `Observation ${id}` }));
  const f = fixture({ user: { id: 1, username: "first" }, request: async () => ({ ok: true, json: async () => data({ recent_reports: reports }) }) });
  await flush();
  const ids = () => f.el("dashboard-report-list").children.map(item => item.children[0].href);
  assert.equal(ids().length, 3);
  assert.equal(ids()[0], "/analysis?report=14");
  assert.equal(f.el("dashboard-page-status").textContent, "1 / 2");
  assert.equal(f.el("dashboard-page-previous").disabled, true);
  f.el("dashboard-page-next").click();
  assert.deepEqual(ids(), ["/analysis?report=11"]);
  assert.equal(f.el("dashboard-page-next").disabled, true);
  f.el("dashboard-page-previous").click();
  f.el("dashboard-order").value = "oldest"; f.el("dashboard-order").fire("change");
  assert.equal(ids()[0], "/analysis?report=11");
  f.el("dashboard-search").value = "HAIRLINE"; f.el("dashboard-search").fire("input");
  assert.deepEqual(ids(), ["/analysis?report=12"]);
  assert.equal(f.el("dashboard-page-status").textContent, "1 / 1");
  assert.match(f.el("dashboard-result-count").textContent, /4개 중 1개/);
  f.el("dashboard-search").value = "no-match"; f.el("dashboard-search").fire("input");
  assert.equal(f.el("dashboard-report-list").hidden, true);
  assert.match(f.el("dashboard-empty-title").textContent, /검색 결과/);
  assert.equal(f.requests.length, 1); // Search and paging never trigger another AI/API request.
  f.account(null);
  assert.equal(f.el("dashboard-search").value, "");
  assert.equal(f.el("dashboard-search").disabled, true);
  assert.equal(f.el("dashboard-order").value, "newest");
  assert.equal(f.el("dashboard-report-list").children.length, 0);
});

test("old analysis-page simulation anchors open the separate preview page", () => {
  const destinations = [], handlers = {};
  const window = { location: { hash: "#simulation", replace: url => destinations.push(url) }, addEventListener(name, fn) { handlers[name] = fn; } };
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/analysis-links.js"), "utf8"), vm.createContext({ window }));
  assert.deepEqual(destinations, ["/simulation"]);
  window.location.hash = "#analysis"; handlers.hashchange(); assert.equal(destinations.length, 1);
});
