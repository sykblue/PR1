const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const report = (signal = "not_obvious", usable = true) => ({ result: { image_usable: usable, visible_signal: signal } });
const clinicData = () => ({ as_of: "2026-09-30", total: 2, items: [
  { id: "one", name: "첫 피부과", address: "공개 도로 1", phone: "+82-2-123-4567", opening_hours: "월 09:00–18:00", distance_m: 125 },
  { id: "two", name: "<script>두 번째 병원</script>", address: "", phone: "javascript:alert(1)", opening_hours: "", distance_m: 1550 }
] });
const flush = () => new Promise(setImmediate);

function fixture({ available = true, throws = false, lookup, authReady = Promise.resolve() } = {}) {
  const html = fs.readFileSync(path.join(__dirname, "../analysis.html"), "utf8");
  let radiusButtons = [];
  class Element {
    constructor(tag = "div") { this.tagName = tag; this.attributes = {}; this.events = {}; this.dataset = {}; this.children = []; this.ownText = ""; this.hidden = false; this.open = false; this.disabled = false; this.checked = false; }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map(c => c.textContent || "").join(""); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.ownText = ""; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    set href(value) { this.setAttribute("href", value); }
    get href() { return this.getAttribute("href") || ""; }
    focus() { this.focused = true; }
    showModal() { this.open = true; this.modalCalls = (this.modalCalls || 0) + 1; }
    close() { this.open = false; this.fire("close"); }
    querySelector(selector) { assert.equal(selector, ".recommendation-dialog-body"); return this.body ||= new Element(); }
    querySelectorAll(selector) {
      if (selector === "[data-clinic-radius]") return radiusButtons;
      assert.equal(selector, "button");
      return this.children.flatMap(c => [...(c.tagName === "button" ? [c] : []), ...c.querySelectorAll("button")]);
    }
    getBoundingClientRect() { return { left: 50, right: 950, top: 40, bottom: 740 }; }
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
    fire(name, event = {}) { return Promise.all((this.events[name] || []).map(fn => fn(event))); }
  }
  const elements = new Map([...html.matchAll(/\bid="([\w-]+)"/g)].map(m => [m[1], new Element()]));
  radiusButtons = [2000, 5000, 10000].map(value => Object.assign(new Element("button"), { dataset: { clinicRadius: String(value) } }));
  const geo = [], requests = [], copied = [];
  const navigator = { clipboard: { writeText: async value => copied.push(value) } };
  if (available) navigator.geolocation = { getCurrentPosition(success, failure, options) {
    if (throws) throw Error("No location");
    geo.push({ success, failure, options });
  } };
  const document = { getElementById: id => elements.get(id) || null, createElement: tag => new Element(tag) };
  let catalogResets = 0;
  const window = { HairlineMedicineCatalog: { reset: () => { catalogResets++; } }, HairlineAuth: { ready: authReady, headers: async () => ({ "X-CSRF-Token": "test" }) }, matchMedia: () => ({ matches: false }) };
  const fetch = async (url, options) => {
    assert.equal(url, "/api/clinics/nearby"); requests.push({ url, options });
    return lookup ? await lookup(options) : { ok: true, json: async () => clinicData() };
  };
  const context = vm.createContext({ window, document, navigator, fetch, AbortController, URL,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; }, clearTimeout,
    localStorage: { setItem() { throw Error("Must not persist location"); } },
    sessionStorage: { setItem() { throw Error("Must not persist answers"); } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/analysis-recommendations.js"), "utf8"), context);
  return { api: window.HairlineRecommendations, catalogResets: () => catalogResets, el: id => elements.get("recommendation-" + id), node: id => elements.get(id),
    root: elements.get("recommendations"), geo, requests, copied, radiusButtons,
    open: (view = "clinics") => elements.get("recommendation-open-" + view).fire("click"),
    async located() { window.HairlineRecommendations.render(report()); await this.open(); await this.el("locate").fire("click"); geo.at(-1).success({ coords: { latitude: 37.56654321, longitude: 126.97865432 } }); await flush(); }
  };
}

test("positions lose precision and invalid coordinates are rejected; distances stay labelled as estimates", () => {
  const { api } = fixture();
  assert.equal(JSON.stringify(api.locationPoint({ latitude: 37.56654321, longitude: 126.97865432 })), '{"latitude":37.567,"longitude":126.979}');
  for (const latitude of [NaN, Infinity, 91, "37", null]) assert.equal(api.locationPoint({ latitude, longitude: 127 }), null);
  assert.equal(api.locationPoint({ latitude: 37, longitude: 181 }), null);
  assert.equal(api.distanceLabel(25), "100m 이내");
  assert.equal(api.distanceLabel(1550), "1.6km");
  assert.equal(api.distanceLabel(NaN), "거리 확인 필요");
});

test("report buttons open their native parent tab without automatically requesting position or hospital data", async () => {
  const f = fixture(); await f.open(); assert.equal(f.el("dialog").open, false);
  f.api.render(report());
  for (const view of ["clinics", "medicines"]) {
    await f.open(view);
    assert.equal(f.el("dialog").open, true);
    assert.equal(f.el("panel-" + view).hidden, false);
    assert.equal(f.el("dialog-title").focused, true);
    await f.el("done").fire("click");
    assert.equal(f.el("open-" + view).focused, true);
  }
  assert.equal(f.geo.length, 0); assert.equal(f.requests.length, 0);
});

test("a new report and analysis reset clear the medicine catalog filters", () => {
  const f = fixture();
  const before = f.catalogResets();
  f.api.render(report());
  assert.equal(f.catalogResets(), before + 1);
  f.api.reset();
  assert.equal(f.catalogResets(), before + 2);
});

test("location opens a second native modal and posts only approximate coordinates with CSRF", async () => {
  const f = fixture(); await f.located();
  assert.equal(f.el("dialog").open, true); assert.equal(f.node("clinics-dialog").open, true);
  assert.equal(f.geo.length, 1); assert.equal(f.geo[0].options.enableHighAccuracy, false);
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["X-CSRF-Token"], "test");
  assert.deepEqual(JSON.parse(request.options.body), { latitude: 37.567, longitude: 126.979, radius_m: 2000 });
  assert.equal(f.node("clinics-results").hidden, false);
  assert.equal(f.node("clinic-detail-name").textContent, "첫 피부과");
  assert.equal(f.node("clinic-call").href, "tel:+8221234567");
  assert.equal(f.node("clinic-source").href, "https://www.data.go.kr/data/15051059/fileData.do");
});

test("selecting facilities uses text, never executes names or phone schemes, and handles missing details", async () => {
  const f = fixture(); await f.located();
  const buttons = f.node("clinics-list").querySelectorAll("button");
  await buttons[1].fire("click");
  assert.equal(f.node("clinic-detail-name").textContent, "<script>두 번째 병원</script>");
  assert.equal(f.node("clinic-call").hidden, true);
  assert.equal(f.node("clinic-call").getAttribute("href"), null);
  assert.equal(f.node("clinic-copy-address").disabled, true);
  assert.match(f.node("clinic-detail-address").textContent, /등록된 주소/);
  assert.equal(buttons[0].tabIndex, -1); assert.equal(buttons[1].tabIndex, 0);
});

test("result keyboard navigation selects details and address copy stays local", async () => {
  const f = fixture(); await f.located();
  const buttons = f.node("clinics-list").querySelectorAll("button");
  let prevented = false;
  await f.node("clinics-list").fire("keydown", { target: buttons[0], key: "End", preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(buttons[1].focused, true);
  await buttons[0].fire("click"); await f.node("clinic-copy-address").fire("click");
  assert.deepEqual(f.copied, ["공개 도로 1"]);
  assert.equal(f.requests.length, 1);
});

test("empty results can expand radius within the same child modal without another location request", async () => {
  let calls = 0;
  const f = fixture({ lookup: async () => ({ ok: true, json: async () => ++calls === 1 ? { items: [], total: 0, as_of: "2026-09-30" } : clinicData() }) });
  await f.located();
  assert.match(f.node("clinics-state-title").textContent, /찾지 못했어요/);
  await f.radiusButtons[1].fire("click"); await flush();
  assert.equal(JSON.parse(f.requests[1].options.body).radius_m, 5000);
  assert.equal(f.radiusButtons[1].getAttribute("aria-pressed"), "true");
  assert.equal(f.geo.length, 1); assert.equal(f.node("clinics-results").hidden, false);
});

test("unsupported, denied, timed out and invalid location stay inside the child modal with no fabricated results", async () => {
  for (const options of [{ available: false }, { throws: true }, { code: 1 }, { code: 3 }, { invalid: true }]) {
    const f = fixture(options); f.api.render(report()); await f.open(); await f.el("locate").fire("click");
    if (options.code) f.geo[0].failure({ code: options.code });
    if (options.invalid) f.geo[0].success({ coords: { latitude: 100, longitude: 200 } });
    assert.equal(f.node("clinics-dialog").open, true); assert.equal(f.node("clinics-results").hidden, true);
    assert.equal(f.node("clinics-spinner").hidden, true); assert.equal(f.requests.length, 0);
  }
});

test("child Escape returns to the parent and ignores a position arriving after closing", async () => {
  const f = fixture(); f.api.render(report()); await f.open(); await f.el("locate").fire("click");
  let prevented = false;
  await f.node("clinics-dialog").fire("cancel", { preventDefault() { prevented = true; } });
  f.geo[0].success({ coords: { latitude: 37.5, longitude: 127 } }); await flush();
  assert.equal(prevented, true); assert.equal(f.node("clinics-dialog").open, false);
  assert.equal(f.el("dialog").open, true); assert.equal(f.el("locate").focused, true); assert.equal(f.requests.length, 0);
});

test("closing the parent aborts its pending hospital request and late data cannot restore old details", async () => {
  let finish;
  const f = fixture({ lookup: () => new Promise(resolve => { finish = resolve; }) });
  f.api.render(report()); await f.open(); await f.el("locate").fire("click");
  f.geo[0].success({ coords: { latitude: 37.5, longitude: 127 } }); await flush();
  await f.el("done").fire("click");
  assert.equal(f.requests[0].options.signal.aborted, true);
  finish({ ok: true, json: async () => clinicData() }); await flush();
  assert.equal(f.node("clinics-dialog").open, false);
  assert.equal(f.node("clinic-detail-name").textContent, ""); assert.equal(f.node("clinics-results").hidden, true);
});

test("closing before asynchronous authentication completes prevents the hospital POST", async () => {
  let ready;
  const f = fixture({ authReady: new Promise(resolve => { ready = resolve; }) });
  f.api.render(report()); await f.open(); await f.el("locate").fire("click");
  f.geo[0].success({ coords: { latitude: 37.5, longitude: 127 } });
  await f.node("clinics-close").fire("click"); ready(); await flush();
  assert.equal(f.requests.length, 0);
});

test("HTTP failures and malformed clinic responses are recoverable error states", async () => {
  for (const result of [{ ok: false, json: async () => ({ error: { message: "test service error" } }) }, { ok: true, json: async () => ({ unexpected: [] }) }]) {
    const f = fixture({ lookup: async () => result }); await f.located();
    assert.match(f.node("clinics-state-title").textContent, /불러오지 못했어요/);
    assert.equal(f.node("clinics-results").hidden, true); assert.equal(f.node("clinics-retry").disabled, false);
  }
});

test("tabs support arrows and new reports close both dialogs and reset location results", async () => {
  const f = fixture(); f.api.render(report()); await f.open();
  let prevented = false;
  await f.el("tabs").fire("keydown", { target: f.el("tab-clinics"), key: "ArrowRight", preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.el("tab-medicines").tabIndex, 0);
  await f.el("locate").fire("click");
  f.api.render(report("visible"));
  assert.equal(f.el("dialog").open, false); assert.equal(f.node("clinics-dialog").open, false);
  assert.equal(f.el("panel-clinics").hidden, false);
});

test("backdrop needs both pointer endpoints outside; reopening ignores stale close events", async () => {
  const f = fixture(); f.api.render(report()); await f.open();
  const dialog = f.el("dialog");
  await dialog.fire("pointerdown", { target: dialog, clientX: 60, clientY: 50 });
  await dialog.fire("click", { target: dialog, clientX: 10, clientY: 10 }); assert.equal(dialog.open, true);
  await dialog.fire("pointerdown", { target: dialog, clientX: 10, clientY: 10 });
  await dialog.fire("click", { target: dialog, clientX: 10, clientY: 10 }); assert.equal(dialog.open, false);
  await f.open();
  await dialog.fire("close"); assert.equal(dialog.open, true);
});
