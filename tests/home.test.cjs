const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function fixture(hash = "", { reducedMotion = false, holdSmooth = false } = {}) {
  const destinations = [], requests = [], lookups = [], frames = [], handlers = {};
  class Element {
    constructor(id = "") { this.id = id; this.dataset = {}; this.attributes = {}; this.handlers = {}; this.children = []; this.disabled = false; this.hidden = false; this.scrollLeft = 0; this.offsetLeft = 0; this.textContent = ""; this.scrolls = []; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(type, callback) { (this.handlers[type] ||= []).push(callback); }
    fire(type, event = {}) { for (const callback of this.handlers[type] || []) callback(event); }
    contains(target) { return target === this || this.children.some((child) => child.contains(target)); }
    scrollTo(options) {
      this.scrolls.push({ left: options.left, behavior: options.behavior });
      if (options.behavior === "smooth" && holdSmooth) return;
      this.scrollLeft = options.left;
      this.fire("scroll");
    }
  }
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const elements = new Map([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => [m[1], new Element(m[1])]));
  const slides = [...html.matchAll(/<article class="home-feature-card"([^>]*)>/g)].map((m, index) => {
    const slide = new Element();
    slide.offsetLeft = 40 + index * 700;
    slide.dataset.featureTitle = m[1].match(/data-feature-title="([^"]+)"/)[1];
    slide.children.push(new Element("link"));
    return slide;
  });
  const pickers = [...html.matchAll(/data-carousel-to="(\d+)"/g)].map((m) => Object.assign(new Element(), { dataset: { carouselTo: m[1] } }));
  const track = elements.get("feature-track"), controls = elements.get("feature-controls");
  track.querySelectorAll = (selector) => { assert.equal(selector, "[data-feature-slide]"); return slides; };
  controls.querySelectorAll = (selector) => { assert.equal(selector, "[data-carousel-to]"); return pickers; };
  controls.hidden = true;
  const document = { getElementById: (id) => { lookups.push(id); return elements.get(id) || null; } };
  const window = { location: { hash, replace: (target) => destinations.push(target) },
    addEventListener: (type, callback) => { (handlers[type] ||= []).push(callback); },
    requestAnimationFrame: (callback) => frames.push(callback),
    matchMedia: (query) => { assert.equal(query, "(prefers-reduced-motion: reduce)"); return { matches: reducedMotion }; } };
  const fetch = async (url) => {
    requests.push(url);
    throw Error("Home must not request technology status or photo analysis");
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/home.js"), "utf8"), vm.createContext({ window, document, fetch, AbortSignal }));
  await new Promise(setImmediate);
  return { destinations, requests, elements, lookups, slides, pickers, track, controls, frames,
    el: (id) => elements.get(id),
    flush: () => { while (frames.length) frames.shift()(); },
    fire: (type) => { for (const callback of handlers[type] || []) callback(); },
    key: (key, target = track, modifiers = {}) => {
      let prevented = false;
      track.fire("keydown", { key, target, ...modifiers, preventDefault: () => { prevented = true; } });
      return prevented;
    } };
}

test("old analysis, simulation and guide bookmarks migrate to dedicated pages", async () => {
  for (const [hash, target] of [["#analysis", "/analysis"], ["#simulation", "/simulation"], ["#guide", "/guide"]]) {
    const f = await fixture(hash);
    assert.deepEqual(f.destinations, [target]);
    assert.equal(f.requests.length, 0);
    assert.equal(f.lookups.length, 0);
  }
});

test("home and history entry do not request technology status or initialize analysis", async () => {
  for (const hash of ["", "#history"]) {
    const f = await fixture(hash);
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.destinations, []);
    assert.equal(f.controls.hidden, false);
    assert.equal(f.track.dataset.enhanced, "true");
  }
});

test("carousel arrows and pickers move to real slide positions and preserve boundary states", async () => {
  const f = await fixture();
  assert.equal(f.slides.length, 3);
  assert.equal(f.el("feature-position").textContent, "1 / 3");
  assert.equal(f.el("feature-previous").disabled, true);
  f.el("feature-next").fire("click"); f.flush();
  assert.equal(f.track.scrollLeft, 700);
  assert.equal(f.pickers[1].attributes["aria-current"], "true");
  assert.equal(f.pickers[0].attributes["aria-current"], undefined);
  f.pickers[2].fire("click"); f.flush();
  assert.equal(f.track.scrollLeft, 1400);
  assert.equal(f.el("feature-next").disabled, true);
  f.el("feature-previous").fire("click"); f.flush();
  assert.equal(f.el("feature-position").textContent, "2 / 3");
  assert.deepEqual(f.requests, []);
});

test("touch and wheel scrolling synchronize the active card and coalesce updates", async () => {
  const f = await fixture();
  f.track.fire("touchstart");
  f.track.scrollLeft = 760;
  f.track.fire("scroll"); f.track.fire("scroll");
  assert.equal(f.frames.length, 1);
  f.flush();
  assert.equal(f.el("feature-position").textContent, "2 / 3");
  f.track.fire("wheel"); f.track.scrollLeft = 1400; f.track.fire("scroll"); f.flush();
  assert.equal(f.el("feature-next").disabled, true);
  assert.match(f.el("feature-position").attributes["aria-label"], /3.*3/);
});

test("keyboard, reduced motion, link focus and resizing preserve usable carousel navigation", async () => {
  const f = await fixture("", { reducedMotion: true });
  assert.equal(f.key("ArrowRight"), true); f.flush();
  assert.equal(f.track.scrolls.at(-1).behavior, "auto");
  assert.equal(f.key("End"), true); f.flush();
  assert.equal(f.el("feature-position").textContent, "3 / 3");
  assert.equal(f.key("ArrowRight"), true); f.flush();
  assert.equal(f.track.scrollLeft, 1400);
  assert.equal(f.key("Home"), true); f.flush();
  assert.equal(f.key("ArrowRight", f.slides[0].children[0]), false);
  assert.equal(f.key("ArrowLeft", f.track, { altKey: true }), false);
  assert.equal(f.key("PageDown"), false);
  f.track.fire("focusin", { target: f.slides[1].children[0] }); f.flush();
  assert.equal(f.el("feature-position").textContent, "2 / 3");
  f.slides.forEach((slide, index) => { slide.offsetLeft = 80 + index * 900; });
  f.fire("resize"); f.flush();
  assert.equal(f.track.scrollLeft, 900);
  assert.equal(f.track.scrolls.at(-1).behavior, "auto");
});

test("rapid navigation keeps its destination during smooth motion and user input can interrupt it", async () => {
  const f = await fixture("", { holdSmooth: true });
  f.el("feature-next").fire("click"); f.track.fire("scroll"); f.flush();
  f.el("feature-next").fire("click");
  assert.deepEqual(f.track.scrolls.map((request) => request.left), [700, 1400]);
  assert.equal(f.el("feature-position").textContent, "3 / 3");
  f.track.fire("pointerdown"); f.track.scrollLeft = 700; f.track.fire("scroll"); f.flush();
  assert.equal(f.el("feature-position").textContent, "2 / 3");
  assert.equal(f.el("feature-next").disabled, false);
});

test("old analysis-page simulation anchors open the separate preview page", () => {
  const destinations = [], handlers = {};
  const window = { location: { hash: "#simulation", replace: (url) => destinations.push(url) },
    addEventListener: (name, fn) => { handlers[name] = fn; } };
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/analysis-links.js"), "utf8"), vm.createContext({ window }));
  assert.deepEqual(destinations, ["/simulation"]);
  window.location.hash = "#analysis"; handlers.hashchange();
  assert.equal(destinations.length, 1);
});
