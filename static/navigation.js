"use strict";

(() => {
  const header = document.querySelector(".site-header");
  const navigation = document.querySelector(".site-header nav");
  const links = [...document.querySelectorAll(".site-header .nav-link")];
  const sections = links.flatMap((link) => {
    const href = link.getAttribute("href") || "";
    const target = link.getAttribute("data-nav-section") || (href.startsWith("#") ? href.slice(1) : "");
    if (!target) return [];
    const section = document.getElementById(target);
    return section ? [{ link, section }] : [];
  });
  if (!header || !navigation || !sections.length) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const defaultLink = links.find((link) => link.getAttribute("data-nav-default") === "true") || null;
  let current, queued = false;

  function revealLink(link) {
    const bounds = navigation.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    let left = navigation.scrollLeft;
    if (item.left < bounds.left) left += item.left - bounds.left - 12;
    else if (item.right > bounds.right) left += item.right - bounds.right + 12;
    else return;
    // Only scroll the horizontal menu, never the page or the keyboard focus.
    navigation.scrollTo({ left, behavior: reducedMotion.matches ? "auto" : "smooth" });
  }
  function update() {
    const readingLine = header.getBoundingClientRect().bottom + 32;
    let active = null;
    for (const entry of sections) {
      if (entry.section.getBoundingClientRect().top <= readingLine) active = entry;
    }
    const page = document.documentElement;
    const atBottom = page.scrollHeight > window.innerHeight + 1 &&
      window.scrollY + window.innerHeight >= page.scrollHeight - 2;
    if (atBottom) active = sections[sections.length - 1];
    const activeLink = active?.link || defaultLink;
    if (current === activeLink) return;
    current = activeLink;
    for (const link of links) {
      const selected = link === activeLink;
      link.classList.toggle("active", selected);
      if (selected) link.setAttribute("aria-current", active ? "location" : "page");
      else link.removeAttribute("aria-current");
    }
    if (activeLink) revealLink(activeLink);
  }
  function schedule() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(() => { queued = false; update(); });
  }
  window.addEventListener("scroll", schedule, { passive: true });
  for (const name of ["resize", "hashchange", "pageshow", "load"]) window.addEventListener(name, schedule);
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(schedule);
    observer.observe(header);
    const main = document.querySelector("main");
    if (main) observer.observe(main);
  }
  update();
})();
