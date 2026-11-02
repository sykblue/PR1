const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function fixture({ user = { id: 7 }, enabled = true, configuration } = {}) {
  const handlers = {}, events = [], requests = [], sockets = [], timeouts = new Map(), intervals = new Map();
  let nextTimer = 0;
  const document = {
    addEventListener: (name, handler) => { handlers[name] = handler; },
    dispatchEvent: (event) => { events.push(event); handlers[event.type]?.(event); },
  };
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close(code) { this.readyState = 3; this.onclose?.({ code }); }
    open() { this.readyState = 1; this.onopen?.(); }
    message(value) { this.onmessage?.({ data: value }); }
  }
  const auth = { ready: Promise.resolve(), user };
  const window = { HairlineAuth: auth, WebSocket: Socket,
    location: { protocol: "http:", hostname: "127.0.0.1" },
    addEventListener: (name, handler) => { handlers[name] = handler; } };
  const config = { enabled, port: 8001, path: "/ws" };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    return configuration ? configuration() : { ok: true, status: 200, json: async () => config };
  };
  const context = vm.createContext({ window, document, fetch,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    AbortSignal: { timeout: () => undefined },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (callback, delay) => { const id = ++nextTimer; intervals.set(id, { callback, delay }); return id; },
    clearInterval: (id) => intervals.delete(id) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/realtime.js"), "utf8"), context);
  await new Promise(setImmediate);
  return { window, auth, config, events, requests, sockets, timeouts, intervals,
    identity: async (value) => { auth.user = value; handlers["auth-changed"](); await new Promise(setImmediate); },
    retry: async () => {
      const [id, item] = timeouts.entries().next().value;
      timeouts.delete(id); item.callback(); await new Promise(setImmediate);
    },
    pagehide: () => handlers.pagehide(),
  };
}

test("anonymous pages never fetch configuration or open a WebSocket", async () => {
  const f = await fixture({ user: null });
  assert.equal(f.requests.length, 0);
  assert.equal(f.sockets.length, 0);
  assert.equal(f.window.HairlineRealtime.connected, false);
});

test("authenticated connections use the local endpoint without putting session credentials in the URL", async () => {
  const f = await fixture();
  assert.equal(f.requests[0].url, "/api/realtime");
  assert.equal(f.requests[0].options.credentials, "same-origin");
  assert.equal(f.sockets.length, 1);
  const socket = f.sockets[0];
  assert.equal(socket.url, "ws://127.0.0.1:8001/ws");
  socket.open();
  assert.equal(f.window.HairlineRealtime.connected, true);
  assert.deepEqual(socket.sent[0], { type: "subscribe", topics: ["history", "training"] });
  assert.equal(f.window.HairlineRealtime.ping(), true);
  assert.deepEqual(socket.sent.at(-1), { type: "ping" });
  assert.equal(f.window.HairlineRealtime.requestStatus(), true);
  assert.deepEqual(socket.sent.at(-1), { type: "status" });
  assert.equal(f.intervals.size, 1);
});

test("server messages dispatch application events without creating UI or accepting malformed data", async () => {
  const f = await fixture(); const socket = f.sockets[0]; socket.open();
  socket.message('{"type":"history.updated"}');
  socket.message('{"type":"training.updated"}');
  socket.message("{"); socket.message('{"type":"unknown"}');
  const types = f.events.filter((event) => event.type === "realtime-message").map((event) => event.detail.type);
  assert.deepEqual(types, ["history.updated", "training.updated"]);
});

test("logout closes the connection, cancels timers and ignores old-account messages", async () => {
  const f = await fixture(); const old = f.sockets[0]; old.open();
  await f.identity(null);
  assert.equal(old.readyState, 3);
  assert.equal(f.timeouts.size, 0);
  assert.equal(f.intervals.size, 0);
  old.message('{"type":"history.updated"}');
  assert.equal(f.events.some((event) => event.type === "realtime-message"), false);
  assert.equal(f.window.HairlineRealtime.ping(), false);
});

test("reconnection has an increasing delay and stops after five retries", async () => {
  const f = await fixture();
  for (let index = 0; index < 6; index++) {
    f.sockets.at(-1).close(1006);
    if (index < 5) {
      assert.equal(f.timeouts.size, 1);
      assert.equal([...f.timeouts.values()][0].delay, 1000 * 2 ** index);
      await f.retry();
    }
  }
  assert.equal(f.sockets.length, 6);
  assert.equal(f.timeouts.size, 0);
  assert.equal(f.events.at(-1).detail.state, "retry-limit");
});

test("expired sessions and disabled transport stop without redirecting or retrying", async () => {
  const expired = await fixture(); expired.sockets[0].close(1008);
  assert.equal(expired.timeouts.size, 0);
  assert.equal(expired.events.at(-1).detail.state, "auth-required");
  const disabled = await fixture({ enabled: false });
  assert.equal(disabled.sockets.length, 0);
  assert.equal(disabled.timeouts.size, 0);
  assert.equal(disabled.events.at(-1).detail.state, "disabled");
  const unauthorized = await fixture({ configuration: async () => ({ ok: false, status: 401 }) });
  assert.equal(unauthorized.sockets.length, 0);
  assert.equal(unauthorized.timeouts.size, 0);
});

test("late configuration responses cannot reconnect the previous user", async () => {
  let resolve;
  const f = await fixture({ configuration: () => new Promise((done) => { resolve = done; }) });
  await f.identity(null);
  resolve({ ok: true, status: 200, json: async () => ({ enabled: true, port: 8001, path: "/ws" }) });
  await new Promise(setImmediate);
  assert.equal(f.sockets.length, 0);
});

test("leaving the page stops sockets and heartbeat without retrying", async () => {
  const f = await fixture(); f.sockets[0].open();
  f.pagehide();
  assert.equal(f.sockets[0].readyState, 3);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.timeouts.size, 0);
});
