const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(wide = false, defaultMode) {
  let document;
  class Element {
    constructor(tag = "div") {
      this.tagName = tag; this.children = []; this.handlers = {}; this.attributes = {};
      this.dataset = {}; this.hidden = false; this.disabled = false; this.ownText = "";
      this.classes = new Set();
      this.classList = {
        add: (name) => this.classes.add(name),
        toggle: (name, active) => active ? this.classes.add(name) : this.classes.delete(name),
        contains: (name) => this.classes.has(name),
      };
    }
    set textContent(text) { this.ownText = text; this.children = []; }
    get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(""); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; this.ownText = ""; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
    fire(name, event = {}) { for (const fn of this.handlers[name] || []) fn(event); }
    focus() { document.activeElement = this; }
    querySelector(selector) {
      assert.equal(selector, "button:not(:disabled)");
      return descendants(this).find((node) => node.tagName === "button" && !node.disabled) || null;
    }
  }
  const ids = new Map(["app-layout", "chatbot-panel", "chatbot-launcher", "chatbot-messages",
    "chatbot-controls", "chatbot-close", "chatbot-reset", "chatbot-minimize", "chatbot-minimized",
    "chatbot-resume", "chatbot-mini-dismiss", "chatbot-minimized-status"].map((id) => [id, new Element()]));
  if (defaultMode) ids.get("app-layout").dataset.chatbotDefault = defaultMode;
  document = new Element("document");
  document.getElementById = (id) => {
    assert.ok(ids.has(id), `Unexpected element lookup: ${id}`);
    return ids.get(id);
  };
  document.createElement = (tag) => new Element(tag);
  document.createElementNS = (_namespace, tag) => new Element(tag);
  document.querySelector = (selector) => {
    assert.equal(selector, "dialog[open]");
    return document.modalOpen ? new Element("dialog") : null;
  };
  const media = new Element(); media.matches = wide;
  const requests = [];
  const window = { matchMedia: (query) => {
    assert.equal(query, "(min-width: 1280px)"); return media;
  } };
  const forbiddenStorage = new Proxy({}, { get() { throw new Error("Chatbot must not access persistent storage"); } });
  const context = vm.createContext({ document, window,
    fetch: (...args) => { requests.push(args); throw new Error("Chatbot must not make network requests"); },
    localStorage: forbiddenStorage, sessionStorage: forbiddenStorage });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/chatbot.js"), "utf8"), context);
  const el = (id) => ids.get(id);
  const find = (label) => {
    const button = descendants(el("chatbot-controls")).find((node) => node.tagName === "button" && (node.attributes["aria-label"] || node.textContent) === label);
    assert.ok(button, `Missing choice: ${label}`);
    return button;
  };
  const choose = (label) => { const node = find(label); assert.equal(node.disabled, false); node.fire("click", { detail: 1 }); };
  const result = () => descendants(el("chatbot-messages")).find((node) => node.dataset.result);
  return { el, document, media, requests, find, choose, result,
    text: () => el("chatbot-messages").textContent,
    progress: () => descendants(el("chatbot-controls")).find((node) => node.tagName === "progress") };
}
function descendants(node) { return node.children.flatMap((child) => [child, ...descendants(child)]); }
function complete(f, answers) {
  f.choose("자가 테스트 시작 · 5문항");
  for (const answer of answers) f.choose(answer);
}

test("wide screens open a sidebar; small screens expose a launcher with working close and focus return", () => {
  const wide = fixture(true);
  assert.equal(wide.el("chatbot-panel").hidden, false);
  assert.equal(wide.el("chatbot-launcher").hidden, true);
  assert.equal(wide.el("app-layout").classList.contains("chatbot-is-open"), true);
  const small = fixture();
  assert.equal(small.el("chatbot-panel").hidden, true);
  small.el("chatbot-launcher").fire("click");
  assert.equal(small.document.activeElement, small.el("chatbot-close"));
  assert.equal(small.el("chatbot-launcher").attributes["aria-expanded"], "true");
  small.el("chatbot-close").fire("click");
  assert.equal(small.el("chatbot-panel").hidden, true);
  assert.equal(small.document.activeElement, small.el("chatbot-launcher"));
});

test("FAQ choices provide fixed answers and return to the topic menu without requesting an API", () => {
  const f = fixture();
  f.choose("탈모 진행 상태 안내");
  assert.match(f.text(), /진행 속도를 확정할 수는 없어요/);
  f.choose("헤어라인이 뒤로 밀려 보여요");
  assert.match(f.text(), /헤어라인의 변화를 기록/);
  f.choose("갑자기 많이 빠지거나 두피가 불편해요");
  assert.match(f.text(), /피부과 진료/);
  f.choose("다른 질문 보기");
  f.choose("사진은 어떻게 찍나요?");
  assert.match(f.text(), /조명·각도·가르마/);
  f.choose("다른 질문 보기");
  f.choose("언제 상담받으면 좋을까요?");
  assert.match(f.text(), /걱정이 이어져도 상담/);
  assert.deepEqual(f.requests, []);
});

test("home opts into a launcher on desktop and keeps the user's explicit helper choice", () => {
  const f = fixture(true, "closed");
  assert.equal(f.el("chatbot-panel").hidden, true);
  assert.equal(f.el("chatbot-launcher").hidden, false);
  f.media.fire("change", { matches: false });
  f.media.fire("change", { matches: true });
  assert.equal(f.el("chatbot-panel").hidden, true);
  f.el("chatbot-launcher").fire("click");
  f.choose("자가 테스트 시작 · 5문항");
  f.choose("네");
  f.media.fire("change", { matches: false });
  assert.equal(f.el("chatbot-panel").hidden, false);
  f.el("chatbot-minimize").fire("click");
  f.media.fire("change", { matches: true });
  assert.equal(f.el("chatbot-minimized").hidden, false);
  f.el("chatbot-resume").fire("click");
  assert.equal(f.progress().value, 1);
  assert.deepEqual(f.requests, []);
});

test("self-check results distinguish uncertain answers, observations and symptoms without diagnosing a stage", () => {
  const cases = [
    { answers: ["아니요", "아니요", "아니요", "아니요", "아니요"], key: "observe", text: /탈모가 없다고 판단할 수는 없어요/ },
    { answers: ["잘 모르겠어요", "아니요", "아니요", "아니요", "아니요"], key: "compare", text: /판단하기 어려운 항목/ },
    { answers: ["네", "아니요", "아니요", "아니요", "잘 모르겠어요"], key: "record", text: /관찰한 변화를 정리/ },
    { answers: ["아니요", "네", "아니요", "아니요", "아니요"], key: "record", text: /변화가 이어지거나 걱정/ },
    { answers: ["아니요", "아니요", "네", "아니요", "아니요"], key: "consult", text: /진료로 원인을 확인/ },
    { answers: ["잘 모르겠어요", "네", "아니요", "네", "아니요"], key: "consult", text: /피부과에서 원인을 확인/ },
  ];
  for (const item of cases) {
    const f = fixture(); complete(f, item.answers);
    assert.equal(f.result().dataset.result, item.key);
    assert.match(f.text(), item.text);
    assert.match(f.text(), /진단 점수나 진행 단계가 아니에요/);
    const summary = descendants(f.result()).filter((node) => node.tagName === "strong");
    assert.deepEqual(summary.map((node) => node.textContent), item.answers);
    assert.deepEqual(f.requests, []);
  }
});

test("previous-question navigation replaces the answer and the final summary uses corrected answers", () => {
  const f = fixture();
  f.choose("자가 테스트 시작 · 5문항");
  assert.equal(f.find("이전 문항").disabled, true);
  assert.equal(f.progress().value, 0);
  f.choose("네"); f.choose("아니요");
  assert.equal(f.progress().value, 2);
  f.choose("이전 문항");
  assert.equal(f.progress().value, 1);
  assert.match(f.text(), /많이 빠지는 상태가 계속되나요/);
  f.choose("잘 모르겠어요");
  f.choose("아니요"); f.choose("아니요"); f.choose("아니요");
  const summary = descendants(f.result()).filter((node) => node.tagName === "strong");
  assert.deepEqual(summary.map((node) => node.textContent), ["네", "잘 모르겠어요", "아니요", "아니요", "아니요"]);
  f.choose("마지막 답변 수정하기");
  assert.equal(f.progress().value, 4);
  f.choose("네");
  assert.equal(descendants(f.result()).filter((node) => node.tagName === "strong").at(-1).textContent, "네");
});

test("stale and duplicate clicks cannot skip questions or complete the check prematurely", () => {
  const f = fixture(); f.choose("자가 테스트 시작 · 5문항");
  const stale = f.find("네");
  stale.fire("click", { detail: 1 });
  assert.equal(f.progress().value, 1);
  stale.fire("click", { detail: 1 });
  f.find("네").fire("click", { detail: 2 });
  assert.equal(f.progress().value, 1);
  assert.equal(f.result(), undefined);
});

test("reset, quit, restart and account changes clear the previous self-check answers", () => {
  const f = fixture(); f.choose("자가 테스트 시작 · 5문항");
  f.choose("네");
  f.el("chatbot-reset").fire("click");
  assert.equal(f.progress(), undefined);
  f.choose("자가 테스트 시작 · 5문항");
  assert.equal(f.progress().value, 0);
  f.choose("네"); f.choose("그만하고 질문 보기");
  complete(f, ["아니요", "아니요", "아니요", "아니요", "아니요"]);
  f.choose("처음부터 다시 점검하기");
  assert.equal(f.progress().value, 0);
  f.choose("네"); f.document.fire("auth-changed");
  assert.equal(f.result(), undefined);
  assert.equal(f.progress(), undefined);
  assert.match(f.text(), /무엇이 궁금하세요/);
  f.choose("자가 테스트 시작 · 5문항");
  assert.equal(f.progress().value, 0);
});

test("Escape returns focus to the launcher while an open application modal keeps its keyboard behavior", () => {
  const f = fixture(true);
  f.document.modalOpen = true;
  f.document.fire("keydown", { key: "Escape" });
  assert.equal(f.el("chatbot-panel").hidden, false);
  f.document.modalOpen = false;
  f.document.fire("keydown", { key: "Escape" });
  assert.equal(f.el("chatbot-panel").hidden, true);
  assert.equal(f.document.activeElement, f.el("chatbot-launcher"));
});

test("responsive visibility follows the viewport until the user explicitly opens or closes the assistant", () => {
  const f = fixture();
  f.media.fire("change", { matches: true });
  assert.equal(f.el("chatbot-panel").hidden, false);
  f.media.fire("change", { matches: false });
  assert.equal(f.el("chatbot-panel").hidden, true);
  f.el("chatbot-launcher").fire("click");
  f.media.fire("change", { matches: false });
  assert.equal(f.el("chatbot-panel").hidden, false);
  f.el("chatbot-close").fire("click");
  f.media.fire("change", { matches: true });
  assert.equal(f.el("chatbot-panel").hidden, true);
});

test("minimizing shows a compact bar and restores the current question without losing answers", () => {
  const f = fixture(true);
  f.choose("자가 테스트 시작 · 5문항");
  f.choose("네"); f.choose("아니요");
  f.el("chatbot-minimize").fire("click");
  assert.equal(f.el("chatbot-panel").hidden, true);
  assert.equal(f.el("chatbot-panel").dataset.visibility, "minimized");
  assert.equal(f.el("chatbot-minimized").hidden, false);
  assert.equal(f.el("chatbot-launcher").hidden, true);
  assert.equal(f.el("app-layout").classList.contains("chatbot-is-open"), false);
  assert.equal(f.document.activeElement, f.el("chatbot-resume"));
  assert.match(f.el("chatbot-minimized-status").textContent, /3 \/ 5/);
  f.el("chatbot-resume").fire("click");
  assert.equal(f.el("chatbot-panel").hidden, false);
  assert.equal(f.el("chatbot-minimized").hidden, true);
  assert.equal(f.progress().value, 2);
  f.choose("아니요"); f.choose("아니요"); f.choose("아니요");
  const summary = descendants(f.result()).filter((node) => node.tagName === "strong");
  assert.deepEqual(summary.map((node) => node.textContent), ["네", "아니요", "아니요", "아니요", "아니요"]);
  f.el("chatbot-minimize").fire("click");
  assert.match(f.el("chatbot-minimized-status").textContent, /완료.*결과/);
  f.el("chatbot-resume").fire("click");
  assert.equal(f.result().dataset.result, "record");
});

test("dismissing the minimized bar leaves the normal launcher and preserves the selected FAQ", () => {
  const f = fixture(true);
  f.choose("탈모 진행 상태 안내");
  const previous = f.text();
  f.el("chatbot-minimize").fire("click");
  assert.match(f.el("chatbot-minimized-status").textContent, /안내 이어서/);
  f.el("chatbot-mini-dismiss").fire("click");
  assert.equal(f.el("chatbot-panel").hidden, true);
  assert.equal(f.el("chatbot-minimized").hidden, true);
  assert.equal(f.el("chatbot-launcher").hidden, false);
  assert.equal(f.document.activeElement, f.el("chatbot-launcher"));
  f.el("chatbot-launcher").fire("click");
  assert.equal(f.text(), previous);
});

test("minimized visibility survives resizing while an account change clears the previous responses", () => {
  const f = fixture(true);
  f.choose("자가 테스트 시작 · 5문항"); f.choose("네");
  f.el("chatbot-minimize").fire("click");
  f.media.fire("change", { matches: false });
  f.media.fire("change", { matches: true });
  assert.equal(f.el("chatbot-minimized").hidden, false);
  assert.equal(f.el("chatbot-panel").hidden, true);
  f.document.fire("auth-changed");
  assert.equal(f.el("chatbot-minimized").hidden, false);
  assert.doesNotMatch(f.el("chatbot-minimized-status").textContent, /2 \/ 5/);
  f.el("chatbot-resume").fire("click");
  assert.match(f.text(), /무엇이 궁금하세요/);
  f.choose("자가 테스트 시작 · 5문항");
  assert.equal(f.progress().value, 0);
  assert.deepEqual(f.requests, []);
});
