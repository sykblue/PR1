const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(hash = "", { panel = false } = {}) {
  class Element {
    constructor(id = "") { this.id = id; this.events = {}; this.attributes = {}; this.dataset = {}; this.hidden = false; this.open = false; this.value = ""; this.textContent = ""; }
    addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
    fire(type) { for (const fn of this.events[type] || []) fn(); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    focus() { this.focused = true; }
    scrollIntoView(options) { this.scrolled = options; }
    getBoundingClientRect() {
      if (panel && this.id === "help-reading") return { top: 150, bottom: 650 };
      return { top: (this.top || 0) - (panel ? ids.get("help-reading").scrollTop : window.scrollY) + (panel ? 150 : 0), bottom: 72 };
    }
  }
  const html = fs.readFileSync(path.join(__dirname, "../guide.html"), "utf8");
  const ids = new Map([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => [m[1], new Element(m[1])]));
  const questions = [...html.matchAll(/<details class="help-faq-item" id="([^"]+)" data-faq-category="([^"]+)"([^>]*)>([\s\S]*?)<\/details>/g)].map((m) => {
    const item = ids.get(m[1]); item.dataset.faqCategory = m[2]; item.open = m[3].includes("open"); item.textContent = m[4].replace(/<[^>]*>/g, " "); return item;
  });
  const filters = [...html.matchAll(/data-faq-filter="([^"]+)"/g)].map((m) => Object.assign(new Element(), { dataset: { faqFilter: m[1] } }));
  const links = [...html.matchAll(/data-guide-link="([^"]+)"/g)].map((m, i) => {
    ids.get(m[1]).top = i * 400;
    return Object.assign(new Element(), { dataset: { guideLink: m[1] } });
  });
  const frames = [], handlers = {};
  Object.assign(ids.get("help-reading"), { scrollTop: 0, clientHeight: 500, scrollHeight: 2000 });
  const window = { location: { hash }, scrollY: 0, innerHeight: 800,
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
    requestAnimationFrame: (fn) => frames.push(fn), matchMedia: (query) => ({ matches: query === "(min-width: 992px) and (min-height: 600px)" ? panel : true }) };
  const document = { getElementById: (id) => ids.get(id) || null, documentElement: { scrollHeight: 2300 },
    querySelector: () => new Element(),
    querySelectorAll: (selector) => selector === "[data-faq-category]" ? questions : selector === "[data-faq-filter]" ? filters : selector === "[data-guide-link]" ? links : [] };
  let requests = 0;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/guide.js"), "utf8"), vm.createContext({ document, window,
    fetch: () => { requests++; throw new Error("Guide search must not request a server"); } }));
  const flush = () => { while (frames.length) frames.shift()(); };
  flush();
  return { el: (id) => ids.get(id), questions, filters, links, window, document, frames, flush,
    fire: (type) => { for (const fn of handlers[type] || []) fn(); },
    visible: () => questions.filter((item) => !item.hidden),
    search: (text) => { ids.get("faq-search").value = text; ids.get("faq-search").fire("input"); },
    requests: () => requests };
}

test("the real guide provides all FAQ answers without a photo or analysis initialization", () => {
  const f = fixture();
  assert.equal(f.questions.length, 10);
  assert.equal(f.visible().length, 10);
  assert.equal(f.el("faq-tools").hidden, false);
  assert.equal(f.el("faq-expand-tools").hidden, false);
  assert.equal(f.requests(), 0);
});

test("search matches answers, combined Korean terms and normalized full-width text entirely locally", () => {
  const f = fixture();
  f.search("  질환   확률 ");
  assert.deepEqual(f.visible().map((item) => item.id), ["faq-observation"]);
  assert.equal(f.el("faq-observation").open, true);
  f.search("ＪＰＧ");
  assert.deepEqual(f.visible().map((item) => item.id), ["faq-file"]);
  f.search("   ");
  assert.equal(f.visible().length, 10);
  assert.equal(f.requests(), 0);
});

test("topic filters combine with the search and the empty state can reset both", () => {
  const f = fixture();
  const privacy = f.filters.find((item) => item.dataset.faqFilter === "privacy");
  privacy.fire("click");
  assert.deepEqual(f.visible().map((item) => item.id), ["faq-history", "faq-transfer"]);
  assert.equal(privacy.attributes["aria-pressed"], "true");
  f.search("<not a real question>");
  assert.equal(f.visible().length, 0);
  assert.equal(f.el("faq-empty").hidden, false);
  assert.equal(f.el("faq-list").hidden, true);
  assert.equal(f.el("faq-expand").disabled, true);
  f.el("faq-reset").fire("click");
  assert.equal(f.visible().length, 10);
  assert.equal(f.el("faq-search").value, "");
  assert.equal(f.el("faq-search").focused, true);
  assert.equal(f.filters[0].attributes["aria-pressed"], "true");
});

test("expand and collapse affect only the currently visible questions and clearing search restores the topic", () => {
  const f = fixture();
  f.filters.find((item) => item.dataset.faqFilter === "editing").fire("click");
  f.el("faq-expand").fire("click");
  assert.ok(f.visible().every((item) => item.open));
  f.el("faq-collapse").fire("click");
  assert.ok(f.visible().every((item) => !item.open));
  assert.equal(f.el("faq-file").open, true);
  f.search("비용"); f.el("faq-clear").fire("click");
  assert.equal(f.visible().length, 2);
  assert.equal(f.el("faq-clear").hidden, true);
});

test("FAQ deep links open their question and reveal it after a previous filter", () => {
  const f = fixture("#faq-history");
  assert.equal(f.el("faq-history").open, true);
  assert.equal(f.el("faq-history").scrolled.behavior, "auto");
  f.filters.find((item) => item.dataset.faqFilter === "photo").fire("click");
  f.search("카메라");
  f.window.location.hash = "#faq-paid"; f.fire("hashchange");
  assert.equal(f.visible().length, 10);
  assert.equal(f.el("faq-search").value, "");
  assert.equal(f.el("faq-paid").open, true);
  assert.equal(f.el("faq-paid").scrolled.block, "start");
  f.window.location.hash = "#%E0%A4%A"; assert.doesNotThrow(() => f.fire("hashchange"));
});

test("the contents follow scroll position, coalesce updates and select the final section at the bottom", () => {
  const f = fixture();
  assert.equal(f.links[0].attributes["aria-current"], "location");
  f.window.scrollY = 450;
  f.fire("scroll"); f.fire("scroll"); f.fire("resize");
  assert.equal(f.frames.length, 1);
  f.flush();
  assert.equal(f.links[1].attributes["aria-current"], "location");
  f.window.scrollY = 1500; f.fire("scroll"); f.flush();
  assert.equal(f.links[3].attributes["aria-current"], "location");
  assert.equal(f.links[1].attributes["aria-current"], undefined);
});

test("desktop contents follow the reading pane independently of the page and still reveal linked FAQ answers", () => {
  const f = fixture("", { panel: true });
  assert.equal(f.links[0].attributes["aria-current"], "location");
  const reader = f.el("help-reading");
  reader.scrollTop = 450;
  reader.fire("scroll"); reader.fire("scroll");
  assert.equal(f.frames.length, 1);
  f.flush();
  assert.equal(f.window.scrollY, 0);
  assert.equal(f.links[1].attributes["aria-current"], "location");
  reader.scrollTop = 1500; reader.fire("scroll"); f.flush();
  assert.equal(f.links[3].attributes["aria-current"], "location");
  assert.equal(f.links[1].attributes["aria-current"], undefined);
  f.filters.find((item) => item.dataset.faqFilter === "photo").fire("click");
  f.window.location.hash = "#faq-paid"; f.fire("hashchange"); f.flush();
  assert.equal(f.visible().length, 10);
  assert.equal(f.el("faq-paid").open, true);
  assert.equal(f.el("faq-paid").scrolled.block, "start");
  assert.equal(f.requests(), 0);
});
