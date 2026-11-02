const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function fixture(user = { id: 7, username: "owner" }) {
  const content = { dataset: { profileUserId: "7" }, hidden: false };
  const handlers = {}, destinations = [];
  const document = {
    getElementById: (id) => { assert.equal(id, "profile-content"); return content; },
    addEventListener: (name, fn) => { handlers[name] = fn; },
  };
  const window = { HairlineAuth: { ready: Promise.resolve(), user },
    location: { replace: (target) => destinations.push({ target, privateContentHidden: content.hidden }) } };
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/profile.js"), "utf8"), vm.createContext({ document, window }));
  await new Promise(setImmediate);
  return { content, destinations, identity: (nextUser) => handlers["auth-changed"]({ detail: { user: nextUser } }) };
}

test("profile keeps the server-rendered information when its authenticated owner is unchanged", async () => {
  const f = await fixture();
  assert.equal(f.content.hidden, false);
  assert.deepEqual(f.destinations, []);
  f.identity({ id: 7, username: "owner" });
  assert.equal(f.content.hidden, false);
  assert.deepEqual(f.destinations, []);
});

test("logout hides private profile content before returning to login", async () => {
  const f = await fixture();
  f.identity(null);
  assert.deepEqual(f.destinations, [{ target: "/login?next=%2Fprofile", privateContentHidden: true }]);
});

test("a changed account reloads its own profile and an already-expired session requires login", async () => {
  const changed = await fixture();
  changed.identity({ id: 8, username: "other" });
  assert.deepEqual(changed.destinations, [{ target: "/profile", privateContentHidden: true }]);
  const expired = await fixture(null);
  assert.deepEqual(expired.destinations, [{ target: "/login?next=%2Fprofile", privateContentHidden: true }]);
});
