"use strict";

(() => {
  const el = (id) => document.getElementById(id);
  const questions = [...document.querySelectorAll("[data-faq-category]")];
  const filters = [...document.querySelectorAll("[data-faq-filter]")];
  const links = [...document.querySelectorAll("[data-guide-link]")];
  const sections = links.map((link) => ({ link, section: el(link.dataset.guideLink) })).filter((item) => item.section);
  const search = el("faq-search");
  const reader = el("help-reading");
  const normalize = (value) => value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/g, " ").trim();
  const searchable = new Map(questions.map((item) => [item, normalize(item.textContent)]));
  let category = "all", queued = false;

  function renderQuestions() {
    const terms = normalize(search.value).split(" ").filter(Boolean);
    let count = 0;
    for (const item of questions) {
      const matches = (category === "all" || item.dataset.faqCategory === category) &&
        terms.every((term) => searchable.get(item).includes(term));
      item.hidden = !matches;
      if (matches) { count++; if (terms.length) item.open = true; }
    }
    for (const filter of filters) filter.setAttribute("aria-pressed", String(filter.dataset.faqFilter === category));
    el("faq-count").textContent = count + "개의 도움말";
    el("faq-empty").hidden = count !== 0;
    el("faq-list").hidden = count === 0;
    el("faq-clear").hidden = !search.value;
    el("faq-expand").disabled = el("faq-collapse").disabled = count === 0;
    scheduleContents();
  }
  function reset() { category = "all"; search.value = ""; renderQuestions(); }
  search.addEventListener("input", renderQuestions);
  filters.forEach((button) => button.addEventListener("click", () => { category = button.dataset.faqFilter; renderQuestions(); }));
  el("faq-clear").addEventListener("click", () => { search.value = ""; renderQuestions(); search.focus(); });
  el("faq-reset").addEventListener("click", () => { reset(); search.focus(); });
  el("faq-expand").addEventListener("click", () => { questions.filter((item) => !item.hidden).forEach((item) => { item.open = true; }); });
  el("faq-collapse").addEventListener("click", () => { questions.filter((item) => !item.hidden).forEach((item) => { item.open = false; }); });
  questions.forEach((item) => item.addEventListener("toggle", scheduleContents));

  function updateContents() {
    const header = document.querySelector(".site-header");
    const inPanel = reader && window.matchMedia("(min-width: 992px) and (min-height: 600px)").matches;
    const readingLine = inPanel ? reader.getBoundingClientRect().top + 16 : (header?.getBoundingClientRect().bottom || 72) + 32;
    let active = sections[0];
    for (const item of sections) if (item.section.getBoundingClientRect().top <= readingLine) active = item;
    const page = inPanel ? reader : document.documentElement;
    const height = inPanel ? reader.clientHeight : window.innerHeight;
    const top = inPanel ? reader.scrollTop : window.scrollY;
    if (page.scrollHeight > height && top + height >= page.scrollHeight - 2) active = sections[sections.length - 1];
    for (const item of sections) {
      if (item === active) item.link.setAttribute("aria-current", "location");
      else item.link.removeAttribute("aria-current");
    }
  }
  function scheduleContents() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(() => { queued = false; updateContents(); });
  }
  function openLinkedQuestion() {
    let id;
    try { id = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
    const question = questions.find((item) => item.id === id);
    if (!question) return;
    reset(); question.open = true;
    question.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  window.addEventListener("hashchange", () => { openLinkedQuestion(); scheduleContents(); });
  window.addEventListener("scroll", scheduleContents, { passive: true });
  reader?.addEventListener("scroll", scheduleContents, { passive: true });
  window.addEventListener("resize", scheduleContents);
  window.addEventListener("pageshow", scheduleContents);
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(scheduleContents);
    observer.observe(el("guide-main"));
    if (reader) observer.observe(reader);
    const header = document.querySelector(".site-header");
    if (header) observer.observe(header);
  }
  el("faq-tools").hidden = el("faq-expand-tools").hidden = false;
  renderQuestions();
  openLinkedQuestion();
})();
