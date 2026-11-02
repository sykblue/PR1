"use strict";

// Loaded before rendering so every document can opt into the same entrance.
(() => {
  const root = document.documentElement;
  const pending = new Set();
  let main = null, announcement = null, previousBusy = null;
  let domReady = document.readyState !== "loading", finished = false, frame = null;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });

  function finish(force = false) {
    if (finished || (!force && (!domReady || pending.size))) return;
    finished = true;
    clearTimeout(failsafe);
    pending.clear();
    root.removeAttribute("data-page-loading");
    if (main) {
      if (previousBusy === null) main.removeAttribute("aria-busy");
      else main.setAttribute("aria-busy", previousBusy);
      main.setAttribute("data-page-ready", "true");
    }
    if (announcement) announcement.textContent = "";
    resolveReady();
  }
  function schedule() {
    if (finished || frame !== null) return;
    frame = window.requestAnimationFrame(() => { frame = null; finish(); });
  }
  function track(task) {
    if (finished) return task;
    const token = {};
    pending.add(token);
    const settle = () => { pending.delete(token); schedule(); };
    // Observe either result; the original caller still owns success/error UI.
    Promise.resolve(task).then(settle, settle);
    return task;
  }
  function attach() {
    domReady = true;
    main = document.querySelector("main[data-page-content]");
    announcement = document.querySelector("[data-page-announcement]");
    if (main && !finished) {
      previousBusy = main.getAttribute("aria-busy");
      main.setAttribute("aria-busy", "true");
      if (announcement) announcement.textContent = "페이지를 준비하고 있어요.";
    }
    if (finished) {
      if (main) main.setAttribute("data-page-ready", "true");
      return;
    }
    schedule();
  }
  // A failed or stalled bootstrap must never leave the document concealed.
  const failsafe = setTimeout(() => finish(true), 6500);
  window.HairlinePage = Object.freeze({ track, ready });
  root.setAttribute("data-page-loading", "true");
  if (domReady) attach();
  else document.addEventListener("DOMContentLoaded", attach, { once: true });
  window.addEventListener("pageshow", event => { if (event.persisted) finish(true); });
  window.addEventListener("pagereveal", event => {
    if (!event.viewTransition) return;
    if (reduceMotion.matches) event.viewTransition.skipTransition();
    else root.setAttribute("data-native-page-entry", "true");
  });
})();
