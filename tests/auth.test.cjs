const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor() { this.events = {}; this.children = []; this.value = ""; this.open = false; this.checked = false; this.dataset = {}; }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  fire(name, event = {}) { return Promise.all((this.events[name] || []).map((fn) => fn(event))); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire("close"); }
  focus() { this.focused = true; }
  setAttribute() {}
  removeAttribute() {}
  reportValidity() { return true; }
}
async function fixture({ page = false, register = false, user = null, next = "/#analysis", hash = "#training", pathname = "/", bootHistory } = {}) {
  const ids = new Map();
  const el = (id) => {
    if (page && !register && id === "account-confirm") return null;
    if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id);
  };
  const document = new Element(); document.getElementById = el; document.createElement = () => new Element();
  document.createElementNS = () => new Element();
  document.body = { classList: { contains: () => false } };
  document.dispatchEvent = (event) => document.fire(event.type, event);
  const calls = [], destinations = [], queue = [{ data: { user, csrf_token: "initial-token" } }];
  if (bootHistory) queue.push({ data: { items: bootHistory } });
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (!queue.length) throw new Error("Unexpected request " + url);
    const item = queue.shift();
    return { ok: !item.status || item.status < 400, status: item.status || 200, json: async () => item.data };
  };
  const window = new Element();
  window.location = { origin: "http://127.0.0.1:8000", pathname, search: "", hash,
    assign: (target) => destinations.push(target), replace: (target) => destinations.push(target), reload() {} };
  if (page) {
    el("account-form").dataset = { mode: register ? "register" : "login", next };
    el("account-submit").textContent = register ? "가입하고 시작하기" : "로그인";
  }
  const context = vm.createContext({ window, document, fetch, Date, URL,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    FormData: class { constructor(form) { this.form = form; } } });
  const filename = page ? "account-page.js" : "auth.js";
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static", filename), "utf8"), context);
  if (page) await new Promise(setImmediate); else await window.HairlineAuth.ready;
  return { el, document, window, calls, queue, destinations };
}

test("main page logout clears private history, identity and saved-report consent", async () => {
  const f = await fixture({ user: { id: 7, username: "developer" } }), changes = [];
  f.document.addEventListener("auth-changed", (event) => changes.push(event.detail));
  assert.equal(f.el("account-login").hidden, true);
  assert.equal(f.el("account-register").hidden, true);
  f.el("history-list").append("private report"); f.el("history-dialog").showModal();
  f.el("save-history").checked = true;
  f.queue.push({ data: { user: null, csrf_token: "new-guest-token" } });
  await f.el("account-logout").fire("click");
  assert.equal(f.calls[1].url, "/api/auth/logout");
  assert.equal(f.calls[1].options.headers["X-CSRF-Token"], "initial-token");
  assert.equal(f.window.HairlineAuth.user, null);
  assert.equal(f.el("history-list").children.length, 0);
  assert.equal(f.el("history-dialog").open, false);
  assert.equal(f.el("save-history").checked, false);
  assert.equal(f.el("save-history").disabled, true);
  assert.equal(f.el("account-register").hidden, false);
  assert.equal((await f.window.HairlineAuth.headers())["X-CSRF-Token"], "new-guest-token");
  assert.equal(changes[0].previousUserId, 7);
});

test("features requiring authentication navigate to the login page with a return destination", async () => {
  const f = await fixture();
  await f.document.fire("auth-required");
  assert.equal(f.destinations[0], "/login?next=%2F%23training");
});

test("history cards show Korea dates and preserve report viewing, deletion and the empty state", async () => {
  const f = await fixture({ user: { id: 7, username: "developer" }, pathname: "/analysis" });
  const item = { id: 42, created_at: "2026-10-28T20:55:00+00:00", model: "gemini-2.5-flash", summary: "<img> is literal report text" };
  const find = (root, name) => root.className === name ? root : root.children.map((child) => find(child, name)).find(Boolean);
  f.queue.push({ data: { items: [item] } });
  const loading = f.el("account-history").fire("click");
  assert.equal(f.el("history-loading").hidden, false);
  await loading;
  assert.equal(f.el("history-count").textContent, "1개");
  assert.equal(f.el("history-loading").hidden, true);
  let card = f.el("history-list").children[0];
  assert.equal(find(card, "history-date-day").textContent, "29");
  assert.equal(find(card, "history-time").textContent, "05:55");
  assert.equal(find(card, "history-summary").textContent, item.summary);
  let selected;
  f.document.addEventListener("history-selected", (event) => { selected = event.detail; });
  f.queue.push({ data: { history_id: 42, result: { summary: item.summary } } });
  await find(card, "history-view").fire("click");
  assert.equal(selected.history_id, 42);
  assert.equal(f.el("history-dialog").open, false);
  f.queue.push({ data: { items: [item] } });
  await f.el("account-history").fire("click");
  card = f.el("history-list").children[0];
  f.window.confirm = () => true;
  f.queue.push({ data: { deleted: true } }, { data: { items: [] } });
  await find(card, "history-remove").fire("click");
  const deletion = f.calls.find((call) => call.options?.method === "DELETE");
  assert.equal(deletion.url, "/api/history/42");
  assert.equal(deletion.options.headers["X-CSRF-Token"], "initial-token");
  assert.equal(f.el("history-count").textContent, "0개");
  assert.equal(f.el("history-empty").hidden, false);
  assert.equal(f.el("history-list").children.length, 0);
});

test("registration submits with CSRF then returns to the app and clears passwords", async () => {
  const f = await fixture({ page: true, register: true });
  assert.equal(f.el("account-submit").disabled, false);
  f.el("account-password").value = f.el("account-confirm").value = "StrongPassword123!";
  f.queue.push({ data: { user: { id: 7, username: "developer" }, csrf_token: "signed-in-token" } });
  await f.el("account-form").fire("submit", { preventDefault() {} });
  assert.equal(f.calls[1].url, "/api/auth/register");
  assert.equal(f.calls[1].options.headers["X-CSRF-Token"], "initial-token");
  assert.equal(f.el("account-password").value, "");
  assert.equal(f.el("account-confirm").value, "");
  assert.equal(f.destinations[0], "http://127.0.0.1:8000/#analysis");
});

test("registration confirmation mismatch never sends credentials", async () => {
  const f = await fixture({ page: true, register: true });
  f.el("account-password").value = "StrongPassword123!";
  f.el("account-confirm").value = "different";
  await f.el("account-form").fire("submit", { preventDefault() {} });
  assert.equal(f.calls.length, 1);
  assert.match(f.el("account-message").textContent, /일치/);
  assert.equal(f.el("account-confirm").focused, true);
});

test("login errors are shown on the login page and the user can retry", async () => {
  const f = await fixture({ page: true });
  f.el("account-password").value = "wrong-password";
  f.queue.push({ status: 401, data: { error: { message: "아이디 또는 비밀번호를 확인해 주세요." } } });
  await f.el("account-form").fire("submit", { preventDefault() {} });
  assert.equal(f.calls[1].url, "/api/auth/login");
  assert.equal(f.el("account-submit").disabled, false);
  assert.match(f.el("account-message").textContent, /비밀번호/);
  assert.equal(f.el("account-password").value, "");
  assert.equal(f.destinations.length, 0);
});

test("a successful login cannot redirect to an external destination", async () => {
  const f = await fixture({ page: true, next: "https://foreign.example" });
  f.queue.push({ data: { user: { id: 7, username: "developer" }, csrf_token: "signed-in-token" } });
  await f.el("account-form").fire("submit", { preventDefault() {} });
  assert.equal(f.destinations[0], "/");
});

test("login returns to the training page, training guide or profile", async () => {
  for (const route of ["/analysis", "/simulation", "/guide", "/analysis?report=42", "/training", "/training-guide", "/profile"]) {
    const f = await fixture({ page: true, next: route });
    f.queue.push({ data: { user: { id: 7, username: "developer" }, csrf_token: "signed-in-token" } });
    await f.el("account-form").fire("submit", { preventDefault() {} });
    assert.equal(f.destinations[0], "http://127.0.0.1:8000" + route);
  }
});

test("the profile record link opens saved reports after authentication is ready", async () => {
  const f = await fixture({ user: { id: 7, username: "developer" }, hash: "#history", bootHistory: [] });
  await new Promise(setImmediate);
  assert.equal(f.el("history-dialog").open, true);
  assert.equal(f.el("history-empty").hidden, false);
  assert.equal(f.calls.filter((call) => call.url === "/api/history").length, 1);
});

test("a saved-record deep link with an expired session returns through login", async () => {
  const f = await fixture({ hash: "#history" });
  await new Promise(setImmediate);
  assert.equal(f.el("history-dialog").open, false);
  assert.equal(f.calls.some((call) => call.url === "/api/history"), false);
  assert.equal(f.destinations[0], "/login?next=%2F%23history");
});

test("viewing a report from home navigates to its dedicated analysis URL", async () => {
  const f = await fixture({ user: { id: 7, username: "developer" } });
  f.queue.push({ data: { items: [{ id: 42, created_at: "2026-10-29T01:00:00Z", summary: "Saved report", model: "test" }] } });
  await f.el("account-history").fire("click");
  const card = f.el("history-list").children[0];
  const find = (node) => node.className === "history-view" ? node : node.children.map(find).find(Boolean);
  await find(card).fire("click");
  assert.equal(f.destinations[0], "/analysis?report=42");
  assert.equal(f.calls.some((call) => call.url === "/api/history/42"), false);
});

test("starting a first observation from the home history dialog opens the analysis page", async () => {
  const f = await fixture({ user: { id: 7, username: "developer" } });
  await f.el("history-start").fire("click");
  assert.equal(f.destinations[0], "/analysis");
});
