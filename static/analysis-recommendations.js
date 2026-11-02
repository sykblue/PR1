"use strict";

(() => {
  function locationPoint(coords) {
    const { latitude, longitude } = coords || {};
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { latitude: Number(latitude.toFixed(3)), longitude: Number(longitude.toFixed(3)) };
  }
  function distanceLabel(metres) {
    if (!Number.isFinite(metres) || metres < 0) return "거리 확인 필요";
    return metres < 100 ? "100m 이내" : metres < 1000 ? `${Math.round(metres / 10) * 10}m` : `${(metres / 1000).toFixed(1)}km`;
  }
  const get = (id) => document.getElementById(id);
  const root = get("recommendations"), dialog = get("recommendation-dialog"), clinics = get("clinics-dialog");
  const views = ["clinics", "medicines"], tabs = views.map(view => get(`recommendation-tab-${view}`));
  const panels = views.map(view => get(`recommendation-panel-${view}`));
  const locate = get("recommendation-locate");
  const radiusButtons = clinics ? [...clinics.querySelectorAll("[data-clinic-radius]")] : [];
  let currentReport = null, returnFocus = null, restoreAfterClose = true, clinicRestore = true;
  let locationVersion = 0, requestVersion = 0, controller = null, locating = false;
  let point = null, radius = 2000, items = [], selectedId = "";

  function setTab(view, focus = false) {
    const selected = Math.max(0, views.indexOf(view));
    tabs.forEach((tab, index) => {
      tab.setAttribute("aria-selected", String(index === selected));
      tab.tabIndex = index === selected ? 0 : -1;
      panels[index].hidden = index !== selected;
      panels[index].scrollTop = 0;
    });
    if (focus) tabs[selected].focus({ preventScroll: true });
  }
  function openDialog(view, trigger) {
    if (!currentReport || !dialog || root.hidden) return;
    returnFocus = trigger; restoreAfterClose = true; setTab(view);
    if (!dialog.open) {
      dialog.querySelector(".recommendation-dialog-body").scrollTop = 0;
      dialog.showModal();
    }
    get("recommendation-dialog-title").focus({ preventScroll: true });
  }
  function setBusy(active) {
    if (!locate) return;
    locate.disabled = active;
    active ? locate.setAttribute("aria-busy", "true") : locate.removeAttribute("aria-busy");
    get("clinics-retry").disabled = active;
    radiusButtons.forEach(button => { button.disabled = active; });
  }
  function invalidateLocation() {
    locationVersion++; requestVersion++; controller?.abort(); controller = null;
    locating = false; point = null; items = []; selectedId = ""; setBusy(false);
    if (!clinics) return;
    get("clinics-list").replaceChildren(); get("clinics-results").hidden = true;
    get("clinic-detail-feedback").textContent = ""; get("clinics-status").textContent = "";
    get("clinic-call").hidden = true; get("clinic-call").removeAttribute("href");
    get("clinic-source").removeAttribute("href");
    for (const id of ["clinic-detail-name", "clinic-detail-department", "clinic-detail-distance", "clinic-detail-address", "clinic-detail-phone", "clinic-detail-hours"]) get(id).textContent = "";
    get("clinic-copy-address").disabled = true;
  }
  function closeClinics(restore = true) {
    clinicRestore = restore; invalidateLocation();
    if (clinics?.open) clinics.close();
  }
  function closeDialog(restore = true) {
    closeClinics(false);
    if (!dialog?.open) { returnFocus = null; return; }
    restoreAfterClose = restore;
    if (!restore) returnFocus = null;
    dialog.close();
  }
  function bindBackdrop(target, close) {
    let startedOutside = false;
    const outside = event => { const b = target.getBoundingClientRect(); return event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom; };
    target.addEventListener("pointerdown", event => { startedOutside = event.target === target && outside(event); });
    target.addEventListener("click", event => {
      if (startedOutside && event.target === target && outside(event)) close();
      startedOutside = false;
    });
  }
  function reset() {
    window.HairlineMedicineCatalog?.reset();
    currentReport = null; if (root) root.hidden = true; closeDialog(false);
    if (!root) return;
    setTab("clinics"); radius = 2000;
    radiusButtons.forEach(button => button.setAttribute("aria-pressed", String(Number(button.dataset.clinicRadius) === radius)));
  }
  function render(report) {
    reset();
    if (!root || !report?.result || typeof report.result !== "object") return;
    currentReport = report; root.hidden = false;
  }
  function showState(title, detail, loading = false) {
    get("clinics-state").hidden = false; get("clinics-results").hidden = true;
    get("clinics-spinner").hidden = !loading; get("clinics-state-icon").hidden = loading;
    get("clinics-state-title").textContent = title; get("clinics-state-detail").textContent = detail;
    get("clinics-status").textContent = title;
  }
  function selectClinic(id, reveal = false) {
    const item = items.find(item => item.id === id); if (!item) return;
    selectedId = id;
    for (const button of get("clinics-list").querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.clinicId === id));
      button.tabIndex = button.dataset.clinicId === id ? 0 : -1;
    }
    get("clinic-detail-name").textContent = item.name;
    get("clinic-detail-department").textContent = "피부과 전문의 신고기관";
    get("clinic-detail-distance").textContent = "약 " + distanceLabel(item.distance_m);
    get("clinic-detail-address").textContent = item.address || "등록된 주소가 없어요.";
    get("clinic-detail-phone").textContent = item.phone || "병원에 직접 확인해 주세요.";
    get("clinic-detail-hours").textContent = item.opening_hours || "등록된 운영 시간이 없어요. 방문 전에 확인해 주세요.";
    get("clinic-copy-address").disabled = !item.address;
    const validPhone = typeof item.phone === "string" && /^[+\d][\d\s().-]{4,47}$/.test(item.phone);
    get("clinic-call").hidden = !validPhone;
    validPhone ? get("clinic-call").href = "tel:" + item.phone.replace(/[^+\d]/g, "") : get("clinic-call").removeAttribute("href");
    get("clinic-source").href = "https://www.data.go.kr/data/15051059/fileData.do";
    get("clinic-detail-feedback").textContent = "";
    get("clinic-detail-content").scrollTop = 0;
    if (reveal && window.matchMedia?.("(max-width: 760px)").matches) get("clinic-detail").scrollIntoView({ block: "nearest", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  function renderClinics(data) {
    items = data.items.filter(item => item && typeof item.id === "string" && typeof item.name === "string" && Number.isFinite(item.distance_m) && item.distance_m >= 0).slice(0, 20);
    if (!items.length) { showState("이 범위에서 병원을 찾지 못했어요", "범위를 넓혀 다시 찾아보세요. 국내 피부과 전문의 신고기관의 공개 현황을 사용해요."); return; }
    const rows = items.map((item, index) => {
      const row = document.createElement("div"); row.className = "clinic-list-row"; row.setAttribute("role", "listitem");
      const button = document.createElement("button"); button.type = "button"; button.className = "clinic-result-button"; button.dataset.clinicId = item.id;
      button.setAttribute("aria-controls", "clinic-detail");
      const number = document.createElement("span"); number.className = "clinic-result-number"; number.textContent = String(index + 1);
      const copy = document.createElement("span"); copy.className = "clinic-result-copy";
      const name = document.createElement("strong"); name.textContent = item.name;
      const address = document.createElement("small"); address.textContent = item.address || "주소 정보 미등록";
      const distance = document.createElement("span"); distance.className = "clinic-result-distance"; distance.textContent = distanceLabel(item.distance_m);
      const selected = document.createElement("span"); selected.className = "clinic-result-selected"; selected.textContent = "선택됨"; selected.setAttribute("aria-hidden", "true");
      const meta = document.createElement("span"); meta.className = "clinic-result-meta"; meta.append(distance, selected);
      copy.append(name, address); button.append(number, copy, meta);
      button.addEventListener("click", () => selectClinic(item.id, true)); row.append(button); return row;
    });
    get("clinics-list").replaceChildren(...rows); get("clinics-list").scrollTop = 0;
    get("clinics-state").hidden = true; get("clinics-results").hidden = false;
    const total = Number.isInteger(data.total) && data.total >= items.length ? data.total : items.length;
    get("clinics-status").textContent = `반경 ${radius / 1000}km · ${total}곳 중 가까운 ${items.length}곳 · 직선 거리`;
    selectClinic(items[0].id);
  }
  async function lookupClinics() {
    if (!point || !currentReport || !dialog.open || !clinics.open) return;
    const version = locationVersion, request = ++requestVersion;
    controller?.abort(); const active = new AbortController(); controller = active;
    const timer = setTimeout(() => active.abort(), 15000);
    const fresh = () => currentReport && clinics.open && version === locationVersion && request === requestVersion;
    setBusy(true); showState("주변 병원을 찾고 있어요", "공개 병원 현황에서 거리순으로 살펴보고 있어요.", true);
    try {
      await window.HairlineAuth.ready;
      const headers = await window.HairlineAuth.headers();
      if (!fresh()) return;
      const response = await fetch("/api/clinics/nearby", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ ...point, radius_m: radius }), signal: active.signal });
      const data = await response.json();
      if (!fresh()) return;
      if (!response.ok) throw new Error(data.error?.message || "병원 정보를 불러오지 못했어요.");
      if (!Array.isArray(data.items)) throw new Error("병원 정보를 읽지 못했어요.");
      renderClinics(data);
    } catch (error) {
      if (fresh()) showState("병원 정보를 불러오지 못했어요", error.name === "AbortError" ? "검색 대기 시간이 길어졌어요. 다시 찾기를 눌러 주세요." : error instanceof TypeError ? "로컬 서버 연결을 확인하고 다시 찾아 주세요." : error.message || "잠시 후 다시 찾아 주세요.");
    } finally {
      clearTimeout(timer);
      if (controller === active) controller = null;
      if (fresh()) setBusy(false);
    }
  }
  function findLocation() {
    if (!currentReport || !dialog?.open || locating) return;
    invalidateLocation(); clinicRestore = true;
    if (!clinics.open) clinics.showModal();
    get("clinics-title").focus({ preventScroll: true });
    showState("현재 위치를 확인하고 있어요", "브라우저의 위치 권한을 확인해 주세요.", true);
    if (!navigator.geolocation) { showState("위치를 확인할 수 없어요", "위치를 지원하는 브라우저에서 다시 찾아 주세요."); return; }
    const version = locationVersion; locating = true; setBusy(true);
    const fail = error => {
      if (!currentReport || !clinics.open || version !== locationVersion) return;
      locating = false; setBusy(false);
      showState("위치를 확인하지 못했어요", error?.code === 1 ? "브라우저에서 위치 권한을 확인한 뒤 다시 찾기를 눌러 주세요." : error?.code === 3 ? "위치 확인 시간이 초과됐어요. 다시 찾아 주세요." : "기기의 위치 기능과 네트워크를 확인한 뒤 다시 찾아 주세요.");
    };
    try {
      navigator.geolocation.getCurrentPosition(position => {
        if (!currentReport || !clinics.open || version !== locationVersion) return;
        point = locationPoint(position?.coords);
        if (!point) { fail(); return; }
        locating = false; lookupClinics();
      }, fail, { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 });
    } catch { fail(); }
  }

  if (root) {
    views.forEach((view, index) => {
      const trigger = get(`recommendation-open-${view}`);
      trigger.addEventListener("click", () => openDialog(view, trigger));
      tabs[index].addEventListener("click", () => setTab(view));
    });
    get("recommendation-tabs").addEventListener("keydown", event => {
      const current = tabs.indexOf(event.target); if (current < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
      const targets = { ArrowLeft: (current + tabs.length - 1) % tabs.length, ArrowRight: (current + 1) % tabs.length, Home: 0, End: tabs.length - 1 };
      if (!Object.hasOwn(targets, event.key)) return;
      event.preventDefault(); setTab(views[targets[event.key]], true);
    });
    get("recommendation-close").addEventListener("click", () => closeDialog());
    get("recommendation-done").addEventListener("click", () => closeDialog());
    dialog.addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      closeClinics(false);
      if (restoreAfterClose && returnFocus && !root.hidden) returnFocus.focus({ preventScroll: true });
      returnFocus = null; restoreAfterClose = true;
    });
    get("clinics-close").addEventListener("click", () => closeClinics());
    get("clinics-done").addEventListener("click", () => closeClinics());
    clinics.addEventListener("cancel", event => { event.preventDefault(); closeClinics(); });
    clinics.addEventListener("close", () => {
      if (clinics.open) return;
      invalidateLocation();
      if (clinicRestore && dialog.open && currentReport && !root.hidden) locate.focus({ preventScroll: true });
      clinicRestore = true;
    });
    bindBackdrop(dialog, () => closeDialog()); bindBackdrop(clinics, () => closeClinics());
    locate.addEventListener("click", findLocation);
    radiusButtons.forEach(button => button.addEventListener("click", () => {
      if (!clinics.open || !point || button.disabled) return;
      const value = Number(button.dataset.clinicRadius); if (![2000, 5000, 10000].includes(value)) return;
      radius = value; radiusButtons.forEach(option => option.setAttribute("aria-pressed", String(option === button))); lookupClinics();
    }));
    get("clinics-retry").addEventListener("click", () => point ? lookupClinics() : findLocation());
    get("clinics-list").addEventListener("keydown", event => {
      if (!items.length || event.altKey || event.ctrlKey || event.metaKey) return;
      const index = Math.max(0, items.findIndex(item => item.id === (event.target.dataset.clinicId || selectedId)));
      const keys = { ArrowDown: Math.min(items.length - 1, index + 1), ArrowUp: Math.max(0, index - 1), Home: 0, End: items.length - 1 };
      if (!Object.hasOwn(keys, event.key)) return;
      event.preventDefault(); selectClinic(items[keys[event.key]].id);
      [...get("clinics-list").querySelectorAll("button")].find(button => button.dataset.clinicId === selectedId)?.focus();
    });
    get("clinic-copy-address").addEventListener("click", async () => {
      const item = items.find(item => item.id === selectedId); if (!item?.address) return;
      const version = locationVersion;
      try {
        await navigator.clipboard.writeText(item.address);
        if (version === locationVersion && selectedId === item.id && clinics.open) get("clinic-detail-feedback").textContent = "주소를 복사했어요.";
      } catch {
        if (version === locationVersion && clinics.open) get("clinic-detail-feedback").textContent = "주소 복사를 사용할 수 없어요. 표시된 주소를 선택해 주세요.";
      }
    });
    reset();
  }
  window.HairlineRecommendations = Object.freeze({ locationPoint, distanceLabel, render, reset });
})();
