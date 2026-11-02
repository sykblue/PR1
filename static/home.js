"use strict";

(() => {
  if (["#analysis", "#simulation", "#guide"].includes(window.location.hash)) {
    window.location.replace({ "#analysis": "/analysis", "#simulation": "/simulation", "#guide": "/guide" }[window.location.hash]);
    return;
  }

  const get = (id) => document.getElementById(id);
  const track = get("feature-track"), controls = get("feature-controls");
  if (!track || !controls) return;
  const slides = [...track.querySelectorAll("[data-feature-slide]")];
  const pickers = [...controls.querySelectorAll("[data-carousel-to]")];
  const previous = get("feature-previous"), next = get("feature-next"), position = get("feature-position");
  if (!slides.length || !previous || !next || !position) return;
  let active = 0, destination = null, queued = false;
  const leftFor = (index) => slides[index].offsetLeft - slides[0].offsetLeft;

  function render(index) {
    previous.disabled = index === 0;
    next.disabled = index === slides.length - 1;
    const label = `${index + 1} / ${slides.length}`;
    if (position.textContent !== label) position.textContent = label;
    position.setAttribute("aria-label", `${slides[index].dataset.featureTitle}, ${slides.length}개 중 ${index + 1}번째 카드`);
    pickers.forEach((button) => {
      if (Number(button.dataset.carouselTo) === index) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });
  }
  function goTo(index, immediate = false) {
    index = Math.max(0, Math.min(slides.length - 1, index));
    const smooth = !immediate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    active = index;
    destination = smooth ? index : null;
    render(index);
    track.scrollTo({ left: leftFor(index), behavior: smooth ? "smooth" : "auto" });
  }
  function syncFromScroll() {
    if (destination !== null) {
      if (Math.abs(track.scrollLeft - leftFor(destination)) > 2) return;
      active = destination;
      destination = null;
    } else {
      active = slides.reduce((closest, _slide, index) => Math.abs(track.scrollLeft - leftFor(index)) < Math.abs(track.scrollLeft - leftFor(closest)) ? index : closest, 0);
    }
    render(active);
  }
  function scheduleSync() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(() => { queued = false; syncFromScroll(); });
  }
  previous.addEventListener("click", () => goTo((destination ?? active) - 1));
  next.addEventListener("click", () => goTo((destination ?? active) + 1));
  pickers.forEach((button) => button.addEventListener("click", () => goTo(Number(button.dataset.carouselTo))));
  track.addEventListener("scroll", scheduleSync, { passive: true });
  for (const type of ["pointerdown", "touchstart", "wheel"]) track.addEventListener(type, () => { destination = null; scheduleSync(); }, { passive: true });
  track.addEventListener("keydown", (event) => {
    if (event.target !== track || event.altKey || event.ctrlKey || event.metaKey) return;
    const index = destination ?? active;
    const targets = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: slides.length - 1 };
    if (!Object.hasOwn(targets, event.key)) return;
    event.preventDefault();
    goTo(targets[event.key]);
  });
  track.addEventListener("focusin", (event) => {
    const index = slides.findIndex((slide) => slide.contains(event.target));
    if (index !== -1) goTo(index, true);
  });
  window.addEventListener("resize", () => goTo(destination ?? active, true));
  window.addEventListener("pageshow", scheduleSync);
  track.dataset.enhanced = "true";
  controls.hidden = false;
  syncFromScroll();
})();
