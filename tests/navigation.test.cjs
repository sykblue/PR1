const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture({ offset = 0, headerHeight = 72, height = 800, total = 4000, fallback = true,
  positions = [500, 1800, 2800], reduced = false, targets = true } = {}) {
  const handlers = {}, frames = [], observers = [], menuScrolls = [];
  let scrollY = offset, headerBottom = headerHeight;
  const links = ["#analysis", "#simulation", "/training", "#guide"].map((href, index) => {
    const attributes = { href, ...(index === 0 && fallback ? { "data-nav-default": "true" } : {}) }, classes = new Set(index === 2 ? ["active"] : []);
    return { attributes, classes, bounds: { left: index * 110, right: index * 110 + 90 },
      getAttribute: (key) => attributes[key],
      setAttribute: (key, value) => { attributes[key] = value; },
      removeAttribute: (key) => { delete attributes[key]; },
      classList: { toggle: (key, on) => on ? classes.add(key) : classes.delete(key) },
      getBoundingClientRect() { return this.bounds; } };
  });
  const sections = Object.fromEntries(["analysis", "simulation", "guide"].map((id, index) => [id,
    { id, top: positions[index], getBoundingClientRect() { return { top: this.top - scrollY }; } }]));
  const header = { getBoundingClientRect: () => ({ bottom: headerBottom }) };
  const menu = { scrollLeft: 0, bounds: { left: 0, right: 600 },
    getBoundingClientRect() { return this.bounds; },
    scrollTo(options) { menuScrolls.push(options); this.scrollLeft = options.left; } };
  const main = {};
  const document = { documentElement: { scrollHeight: total },
    querySelector: (selector) => ({ ".site-header": header, ".site-header nav": menu, main })[selector],
    querySelectorAll: (selector) => { assert.equal(selector, ".site-header .nav-link"); return links; },
    getElementById: (id) => targets ? sections[id] : null };
  const window = { innerHeight: height,
    get scrollY() { return scrollY; },
    requestAnimationFrame: (callback) => { frames.push(callback); },
    addEventListener: (name, handler, options) => { handlers[name] = handler; if (name === "scroll") assert.equal(options.passive, true); },
    matchMedia: (query) => { assert.equal(query, "(prefers-reduced-motion: reduce)"); return { matches: reduced }; } };
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(node) { this.targets.push(node); }
  }
  const context = vm.createContext({ window, document, ResizeObserver });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/navigation.js"), "utf8"), context);
  const flush = () => { while (frames.length) frames.shift()(); };
  return { links, sections, handlers, frames, observers, menu, menuScrolls, document,
    active: () => links.filter((link) => link.classes.has("active")).map((link) => link.attributes.href),
    scroll: (value) => { scrollY = value; handlers.scroll(); flush(); },
    headerHeight: (value) => { headerBottom = value; }, flush };
}

test("the visible section changes the active menu when scrolling down and back up", () => {
  const f = fixture();
  assert.deepEqual(f.active(), ["#analysis"]);
  f.scroll(1700);
  assert.deepEqual(f.active(), ["#simulation"]);
  f.scroll(2700);
  assert.deepEqual(f.active(), ["#guide"]);
  f.scroll(1800);
  assert.deepEqual(f.active(), ["#simulation"]);
  f.scroll(0);
  assert.deepEqual(f.active(), ["#analysis"]);
  assert.equal(f.links[2].attributes["aria-current"], undefined);
  assert.equal(f.links[0].attributes["aria-current"], "page");
  assert.equal(f.links[1].attributes["aria-current"], undefined);
});

test("an initial deep-link position and history restoration use the actual viewport position", () => {
  const f = fixture({ offset: 1712 });
  assert.deepEqual(f.active(), ["#simulation"]);
  f.sections.guide.top = 1750;
  f.handlers.pageshow(); f.flush();
  assert.deepEqual(f.active(), ["#guide"]);
});

test("a short final section activates at the page bottom even when its top cannot reach the header", () => {
  const f = fixture({ positions: [500, 1500, 2850], total: 3300 });
  f.scroll(2490);
  assert.deepEqual(f.active(), ["#simulation"]);
  f.scroll(2500);
  assert.deepEqual(f.active(), ["#guide"]);
});

test("the real header height and resized content determine the activation line", () => {
  const f = fixture();
  f.scroll(1680);
  assert.deepEqual(f.active(), ["#analysis"]);
  f.headerHeight(104);
  f.handlers.resize(); f.flush();
  assert.deepEqual(f.active(), ["#simulation"]);
  f.sections.simulation.top = 2000;
  f.observers[0].callback(); f.flush();
  assert.deepEqual(f.active(), ["#analysis"]);
  assert.equal(f.observers[0].targets.length, 2);
});

test("bursts of scroll events schedule only one update per animation frame", () => {
  const f = fixture();
  for (let index = 0; index < 20; index++) f.handlers.scroll();
  assert.equal(f.frames.length, 1);
  f.flush();
  assert.equal(f.frames.length, 0);
  f.handlers.scroll();
  assert.equal(f.frames.length, 1);
});

test("the active item is revealed within an overflowing horizontal menu and respects reduced motion", () => {
  const f = fixture({ reduced: true });
  f.menu.bounds.right = 230;
  f.scroll(2700);
  assert.equal(f.menuScrolls.length, 1);
  assert.equal(f.menuScrolls[0].left, 202);
  assert.equal(f.menuScrolls[0].behavior, "auto");
  f.scroll(2750);
  assert.equal(f.menuScrolls.length, 1);
});

test("a page with no local section targets preserves the current page menu", () => {
  const f = fixture({ targets: false });
  assert.deepEqual(f.active(), ["/training"]);
  assert.equal(Object.keys(f.handlers).length, 0);
});

test("home has no false page selection above its first tracked section", () => {
  const f = fixture({ fallback: false });
  assert.deepEqual(f.active(), []);
  f.scroll(500);
  assert.deepEqual(f.active(), ["#analysis"]);
  f.scroll(0);
  assert.deepEqual(f.active(), []);
});
