const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

async function fixture({ unavailable = false, ready = Promise.resolve() } = {}) {
  const records = new Map(), handlers = {};
  let now = 1000000, created = false;
  // A small IndexedDB adapter exercises the real handoff's transactions and asynchronous requests.
  const indexedDB = { open() {
    const opening = {};
    queueMicrotask(() => {
      opening.result = {
        createObjectStore() { created = true; }, close() {},
        transaction() {
          const tx = { objectStore: () => ({
            clear() { records.clear(); }, put(value, key) { records.set(key, value); }, delete(key) { records.delete(key); },
            get(key) { const req = {}; queueMicrotask(() => { req.result = records.get(key); req.onsuccess?.(); }); return req; },
            openCursor() {
              const req = {}, keys = [...records.keys()]; let i = 0;
              function next() {
                const key = keys[i++];
                req.result = key === undefined ? null : { value: records.get(key), delete: () => records.delete(key),
                  continue: () => queueMicrotask(next) };
                req.onsuccess?.();
              }
              queueMicrotask(next); return req;
            }
          }), abort() { tx.aborted = true; tx.onabort?.(); } };
          setImmediate(() => { if (!tx.aborted) tx.oncomplete?.(); });
          return tx;
        }
      };
      if (!created) opening.onupgradeneeded?.();
      opening.onsuccess?.();
    });
    return opening;
  } };
  const document = { addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
    dispatchEvent: (event) => { for (const fn of handlers[event.type] || []) fn(event); } };
  class Clock extends Date { static now() { return now; } }
  const window = { indexedDB: unavailable ? null : indexedDB, crypto: { randomUUID }, HairlineAuth: { ready } };
  const context = vm.createContext({ window, document, Date: Clock, Blob });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/photo-handoff.js"), "utf8"), context);
  await new Promise(setImmediate);
  return { api: window.HairlinePhotoHandoff, document, records, advance: (ms) => { now += ms; } };
}
const photo = () => new File(["a photo"], "source.jpg", { type: "image/jpeg" });

test("photo handoffs preserve the original file and are consumed exactly once", async () => {
  const f = await fixture(), file = photo();
  const token = await f.api.put(file, 7);
  assert.match(token, /^[a-f0-9-]{36}$/);
  assert.equal(f.records.size, 1);
  assert.equal(await f.api.take(token, 7), file);
  assert.equal(f.records.size, 0);
  assert.equal(await f.api.take(token, 7), null);
});

test("a different account and an expired handoff cannot recover the photo", async () => {
  const f = await fixture();
  const wrongOwner = await f.api.put(photo(), 7);
  assert.equal(await f.api.take(wrongOwner, 8), null);
  assert.equal(await f.api.take(wrongOwner, 7), null);
  const expired = await f.api.put(photo(), null);
  f.advance(300001);
  assert.equal(await f.api.take(expired, null), null);
  assert.equal(f.records.size, 0);
  assert.equal(await f.api.take("malformed", null), null);
});

test("a new transfer replaces an older pending photo and a cancelled transfer can be removed", async () => {
  const f = await fixture(), old = await f.api.put(photo(), 7), next = await f.api.put(photo(), 7);
  assert.equal(f.records.size, 1);
  assert.equal(await f.api.take(old, 7), null);
  await f.api.remove(next);
  assert.equal(f.records.size, 0);
});

test("later account changes clear pending photos, while initial authentication keeps its handoff", async () => {
  let resolve;
  const f = await fixture({ ready: new Promise((done) => { resolve = done; }) });
  const file = photo(), token = await f.api.put(file, 7);
  f.document.dispatchEvent({ type: "auth-changed" });
  resolve(); await new Promise(setImmediate);
  assert.equal(await f.api.take(token, 7), file);
  await f.api.put(file, 7);
  f.document.dispatchEvent({ type: "auth-changed" });
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(f.records.size, 0);
});

test("unsupported photos and unavailable browser storage fail without a handoff", async () => {
  const f = await fixture();
  await assert.rejects(f.api.put(new Blob(["text"], { type: "text/plain" }), 7));
  assert.equal(f.records.size, 0);
  const unavailable = await fixture({ unavailable: true });
  await assert.rejects(unavailable.api.put(photo(), 7), /unavailable/);
});
