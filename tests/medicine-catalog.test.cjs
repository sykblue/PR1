const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture({ missing = false, mutate } = {}) {
  const html = fs.readFileSync(path.join(__dirname, "../analysis.html"), "utf8");
  const requests = [];
  class Element {
    constructor(tag = "div") { this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; this.dataset = {}; this.value = ""; this.hidden = false; this.disabled = false; this.ownText = ""; }
    set innerHTML(value) { throw Error("Catalog must use text nodes"); }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map((item) => item.textContent).join(""); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
    fire(name) { for (const fn of this.events[name] || []) fn({ target: this }); }
    focus() { this.focused = true; }
  }
  const ids = new Map([...html.matchAll(/\bid="([\w-]+)"/g)].map((match) => [match[1], new Element()]));
  const document = { getElementById: (id) => ids.get(id), createElement: (tag) => new Element(tag) };
  const window = {};
  const context = vm.createContext({ window, document, fetch: (...args) => { requests.push(args); throw Error("Catalog must stay local"); } });
  if (!missing) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/medicine-catalog-data.js"), "utf8"), context);
    if (mutate) window.HairlineMedicineCatalogData = mutate(JSON.parse(JSON.stringify(window.HairlineMedicineCatalogData)));
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/medicine-catalog.js"), "utf8"), context);
  const all = (element) => [element, ...element.children.flatMap(all)];
  return { el: (id) => ids.get(`medicine-${id}`), data: window.HairlineMedicineCatalogData,
    nodes: () => all(ids.get("medicine-results")), cards: () => all(ids.get("medicine-results")).filter((node) => node.className === "medicine-product"),
    api: window.HairlineMedicineCatalog, requests };
}

test("the shipped catalog displays 20 distinct official products with five types and 13 companies", () => {
  const f = fixture();
  assert.equal(f.cards().length, 20);
  assert.equal(f.el("results").children.length, 5);
  assert.equal(new Set(f.data.products.map((item) => item.id)).size, 20);
  assert.equal(f.el("company").children.length, 14);
  assert.match(f.el("count").textContent, /20종 \/ 전체 20종/);
  for (const item of f.data.products) {
    assert.match(item.id, /^\d{9}$/);
    assert.equal(item.source, `https://nedrug.mfds.go.kr/pbp/CCBBB01/getItemDetail?itemSeq=${item.id}`);
  }
  assert.equal(f.data.products.filter((item) => item.classification === "전문의약품").length, 10);
  assert.equal(f.requests.length, 0);
});

test("type, company and keyword filters apply together and empty results can be reset", () => {
  const f = fixture();
  f.el("type").value = "oral-finasteride"; f.el("type").fire("change");
  assert.equal(f.cards().length, 5);
  f.el("company").value = "현대약품(주)"; f.el("company").fire("change");
  assert.equal(f.cards().length, 1); assert.match(f.el("results").textContent, /미노페시아/);
  f.el("search").value = "없는 제품"; f.el("search").fire("input");
  assert.equal(f.cards().length, 0); assert.equal(f.el("empty").hidden, false);
  f.el("reset").fire("click");
  assert.equal(f.cards().length, 20); assert.equal(f.el("empty").hidden, true);
  assert.equal(f.el("search").focused, true);
});

test("grouping by company preserves filters and the selected state is accessible", () => {
  const f = fixture();
  f.el("group-company").fire("click");
  assert.equal(f.el("results").children.length, 13);
  assert.equal(f.el("group-company").attributes["aria-pressed"], "true");
  assert.equal(f.el("group-type").attributes["aria-pressed"], "false");
  f.el("type").value = "oral-finasteride"; f.el("type").fire("change");
  assert.equal(f.cards().length, 5); assert.equal(f.el("results").children.length, 5);
  f.el("group-type").fire("click");
  assert.equal(f.cards().length, 5); assert.equal(f.el("results").children.length, 1);
  f.api.reset();
  assert.equal(f.cards().length, 20); assert.equal(f.el("type").value, "all");
});

test("search handles full-width text, spacing and separately disclosed contract manufacturers", () => {
  const f = fixture();
  for (const [query, count] of [["미녹시딜　５％", 6], ["1 mg", 5], ["영일제약", 2]]) {
    f.el("search").value = query; f.el("search").fire("input");
    assert.equal(f.cards().length, count, query);
  }
  assert.equal(f.requests.length, 0);
});

test("support medicines stay separate from minoxidil and finasteride products", () => {
  const f = fixture();
  f.el("type").value = "oral-support"; f.el("type").fire("change");
  assert.equal(f.cards().length, 3);
  assert.match(f.el("results").textContent, /탈모 보조치료/);
  assert.match(f.el("results").textContent, /마이녹실에스캡슐/);
  for (const product of f.data.products.filter((item) => item.type === "oral-support")) {
    assert.doesNotMatch(product.composition, /미녹시딜|피나스테리드|두타스테리드/);
    assert.equal(product.classification, "일반의약품");
  }
});

test("product text stays inert and links always use the official item ID", () => {
  const attack = '<img src=x onerror="alert(1)">';
  const f = fixture({ mutate: (data) => {
    data.products[0].name = attack; data.products[0].source = "javascript:alert(1)";
    data.products.push({ ...data.products[0], id: "../../private" });
    return data;
  } });
  assert.equal(f.cards().length, 20); assert.ok(f.el("results").textContent.includes(attack));
  const links = f.nodes().filter((node) => node.className === "medicine-product-source");
  assert.equal(links.length, 20);
  for (const link of links) {
    assert.match(link.href, /^https:\/\/nedrug\.mfds\.go\.kr\/pbp\/CCBBB01\/getItemDetail\?itemSeq=\d{9}$/);
    assert.equal(link.rel, "noopener noreferrer");
  }
});

test("each of the 20 products has its own local photo with dimensions, attribution and a larger preview", () => {
  const f = fixture();
  const images = f.nodes().filter((node) => node.tagName === "img");
  assert.equal(images.length, 20); assert.equal(new Set(images.map((image) => image.src)).size, 20);
  for (const image of images) {
    assert.match(image.src, /^\/static\/medicine-products\/\d{9}\.(jpg|png)$/);
    assert.ok(image.alt); assert.ok(image.width > 0 && image.height > 0);
    assert.equal(image.loading, "lazy"); assert.equal(image.decoding, "async");
    assert.ok(fs.existsSync(path.join(__dirname, "..", image.src)));
  }
  assert.equal(f.nodes().filter((node) => node.className === "medicine-product-photo-source").length, 20);
  assert.equal(f.nodes().filter((node) => node.className === "medicine-product-photo-preview").length, 20);
  assert.equal(f.data.products.filter((item) => item.photo.kind === "pill").length, 1);
});

test("a missing image leaves product information and filters usable", () => {
  const f = fixture();
  const image = f.nodes().find((node) => node.tagName === "img"); image.fire("error");
  assert.match(f.el("results").textContent, /사진을 불러오지 못했어요/);
  assert.equal(f.cards().length, 20);
  f.el("type").value = "oral-finasteride"; f.el("type").fire("change");
  assert.equal(f.cards().length, 5);
});

test("catalog photo paths cannot load external images or a different product's photo", () => {
  for (const path of ["https://untrusted.invalid/image.jpg", "/static/medicine-products/000000000.jpg", "/static/medicine-products/../private.jpg"]) {
    const f = fixture({ mutate: (data) => { data.products[0].photo.src = path; data.products[0].photo.source = "javascript:alert(1)"; return data; } });
    assert.equal(f.nodes().filter((node) => node.tagName === "img").length, 19);
    assert.equal(f.cards().length, 20);
  }
});

test("a missing catalog reports an error and disables filters without external requests", () => {
  const f = fixture({ missing: true });
  assert.match(f.el("count").textContent, /불러오지 못했어요/);
  assert.equal(f.el("search").disabled, true); assert.equal(f.el("company").disabled, true);
  assert.equal(f.cards().length, 0); assert.equal(f.requests.length, 0);
});
