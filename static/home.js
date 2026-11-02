"use strict";

(() => {
  const legacy = { "#analysis": "/analysis", "#simulation": "/simulation", "#guide": "/guide" };
  if (Object.hasOwn(legacy, window.location.hash)) {
    window.location.replace(legacy[window.location.hash]);
    return;
  }
  const get = (id) => document.getElementById(id);
  if (!get("dashboard-stats")) return;
  const auth = window.HairlineAuth;
  let identity = null, version = 0, controller = null, initialized = false;
  let recentReports = [], reportPage = 0;
  const pageSize = 3;
  const put = (id, text) => { get(id).textContent = text; };
  const formatDate = (value, options = { month: "long", day: "numeric", weekday: "short" }) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "날짜 확인 중" : new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", ...options }).format(date);
  };
  function today() {
    const now = new Date();
    get("dashboard-date").dateTime = now.toISOString();
    put("dashboard-date", formatDate(now));
  }
  function notice(message, login = false) {
    put("dashboard-message", message);
    get("dashboard-notice").hidden = !message;
    get("dashboard-login").hidden = !login;
  }
  function clear(user) {
    recentReports = [];
    reportPage = 0;
    get("dashboard-search").value = "";
    get("dashboard-order").value = "newest";
    get("dashboard-search").disabled = get("dashboard-order").disabled = true;
    get("dashboard-page-previous").disabled = get("dashboard-page-next").disabled = true;
    put("dashboard-page-status", "1 / 1");
    put("dashboard-result-count", user ? "불러오는 중" : "로그인 후 확인");
    for (const id of ["dashboard-report-count", "dashboard-photo-count", "dashboard-training-count", "dashboard-model-state"]) put(id, "—");
    put("dashboard-model-caption", user ? "불러오는 중" : "로그인 후 확인");
    put("dashboard-greeting", user ? `${user.username}님, 오늘의 관찰을 이어가세요.` : "사진 관찰부터 기록과 학습까지, 한곳에서 시작하세요.");
    put("dashboard-empty-title", user ? "최근 기록을 불러오고 있어요" : "나의 관찰 기록을 모아보세요");
    put("dashboard-empty-copy", user ? "잠시만 기다려 주세요." : "로그인하면 저장한 리포트를 여기서 볼 수 있어요.");
    put("dashboard-training-badge", "내 분류기");
    put("dashboard-training-title-text", "내 사진으로 시작하는 학습");
    put("dashboard-training-description", user ? "내 학습 현황을 불러오고 있어요." : "로그인 후 내 분류기를 관리해 보세요.");
    get("dashboard-report-list").replaceChildren();
    get("dashboard-report-list").hidden = true;
    get("dashboard-empty").hidden = false;
    get("dashboard-refresh").hidden = !user;
    get("dashboard-refresh").disabled = false;
    get("dashboard-stats").setAttribute("aria-busy", "false");
    get("dashboard-recent").setAttribute("aria-busy", "false");
    notice(user ? "" : "로그인하면 내 기록과 학습 현황을 볼 수 있어요.", !user);
  }
  function render(data) {
    const count = (value) => new Intl.NumberFormat("ko-KR").format(value);
    put("dashboard-report-count", count(data.report_count));
    put("dashboard-photo-count", count(data.photo_count));
    put("dashboard-training-count", count(data.training.total));
    const state = data.training.model_ready ? "사용 가능" : data.training.model_stale ? "갱신 필요" : data.training.can_train ? "학습 가능" : "준비 중";
    put("dashboard-model-state", state);
    put("dashboard-model-caption", data.training.model_ready ? "현재 데이터로 학습 완료" : data.training.model_stale ? "데이터 변경 후 재학습 필요" : data.training.can_train ? "학습을 시작할 수 있어요" : "학습 사진을 준비해 주세요");
    put("dashboard-training-badge", state);
    put("dashboard-training-title-text", data.training.model_ready ? "내 분류기가 준비됐어요" : data.training.model_stale ? "새 데이터로 다시 학습해요" : data.training.can_train ? "이제 학습을 시작해 보세요" : "사진을 모아 분류기를 만들어요");
    put("dashboard-training-description", data.training.model_ready ? "내 분류기를 학습 공간에서 검증할 수 있어요." : data.training.model_stale ? "데이터가 달라졌어요. 다시 학습해 주세요." : data.training.can_train ? "사진과 사람 그룹이 준비됐어요. 학습을 시작해 보세요." : "사진에 라벨과 사람 그룹을 지정해 학습을 준비해요.");
    recentReports = data.recent_reports;
    get("dashboard-search").disabled = get("dashboard-order").disabled = false;
    renderReports();
  }
  function renderReports() {
    const query = get("dashboard-search").value.trim().toLocaleLowerCase("ko-KR");
    const ascending = get("dashboard-order").value === "oldest";
    const matches = recentReports.filter(report => `${report.id} ${report.summary || ""}`.toLocaleLowerCase("ko-KR").includes(query))
      .sort((a, b) => ascending ? a.id - b.id : b.id - a.id);
    const pages = Math.max(1, Math.ceil(matches.length / pageSize));
    reportPage = Math.max(0, Math.min(reportPage, pages - 1));
    put("dashboard-result-count", `최근 ${recentReports.length}개 중 ${matches.length}개`);
    put("dashboard-page-status", `${reportPage + 1} / ${pages}`);
    get("dashboard-page-previous").disabled = reportPage === 0;
    get("dashboard-page-next").disabled = reportPage === pages - 1;
    const list = get("dashboard-report-list");
    list.replaceChildren();
    for (const report of matches.slice(reportPage * pageSize, (reportPage + 1) * pageSize)) {
      const item = document.createElement("li"), link = document.createElement("a");
      link.href = `/analysis?report=${encodeURIComponent(report.id)}`;
      const number = document.createElement("span");
      number.className = "dashboard-report-number";
      number.textContent = String(report.id);
      number.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span"), summary = document.createElement("span"), date = document.createElement("time");
      summary.className = "dashboard-report-summary";
      summary.textContent = report.summary || "저장한 분석 리포트";
      date.dateTime = report.created_at;
      date.textContent = formatDate(report.created_at, { year: "numeric", month: "2-digit", day: "2-digit" });
      copy.append(summary, date);
      const saved = document.createElement("span");
      saved.className = "dashboard-report-saved";
      saved.textContent = "계정에 저장";
      const open = document.createElement("span");
      open.className = "dashboard-report-open";
      open.textContent = "열기 →";
      open.setAttribute("aria-hidden", "true");
      link.append(number, copy, saved, open);
      item.append(link);
      list.append(item);
    }
    list.hidden = !matches.length;
    get("dashboard-empty").hidden = !!matches.length;
    put("dashboard-empty-title", query ? "검색 결과가 없어요" : "아직 저장한 분석 기록이 없어요");
    put("dashboard-empty-copy", query ? "다른 검색어로 최근 저장 기록을 찾아보세요." : "사진 분석에서 기록 저장을 선택해 첫 리포트를 남겨보세요.");
  }
  async function load() {
    if (!identity) return;
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    const requestVersion = ++version;
    get("dashboard-refresh").disabled = true;
    get("dashboard-stats").setAttribute("aria-busy", "true");
    get("dashboard-recent").setAttribute("aria-busy", "true");
    const timeout = window.setTimeout(() => requestController.abort(), 10000);
    try {
      const response = await fetch("/api/dashboard", { credentials: "same-origin", cache: "no-store", signal: requestController.signal });
      if (!response.ok) throw new Error(response.status === 401 ? "session" : "dashboard");
      const data = await response.json();
      if (requestVersion !== version || !identity) return;
      render(data);
      notice("");
    } catch (error) {
      if (requestVersion !== version || !identity) return;
      clear(auth?.user);
      put("dashboard-model-caption", "불러오기 실패");
      put("dashboard-empty-title", "기록을 불러오지 못했어요");
      put("dashboard-empty-copy", "새로고침을 눌러 다시 확인해 주세요.");
      put("dashboard-training-description", "학습 공간에서 내 학습 현황을 확인하거나 다시 불러와 주세요.");
      notice(error.message === "session" ? "로그인이 만료됐어요. 다시 로그인해 주세요." : "현황을 불러오지 못했어요. 새로고침으로 다시 시도할 수 있어요.", error.message === "session");
    } finally {
      window.clearTimeout(timeout);
      if (requestVersion === version) {
        get("dashboard-refresh").disabled = false;
        get("dashboard-stats").setAttribute("aria-busy", "false");
        get("dashboard-recent").setAttribute("aria-busy", "false");
      }
    }
  }
  function accountChanged() {
    const user = auth?.user || null;
    const next = user?.id ?? null;
    if (initialized && next === identity) return;
    initialized = true;
    ++version;
    controller?.abort();
    identity = next;
    clear(user);
    if (!user) return;
    const loading = load();
    window.HairlinePage?.track(loading);
    return loading;
  }
  for (const id of ["dashboard-history", "dashboard-stat-history", "dashboard-history-shortcut"]) get(id).addEventListener("click", (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!auth?.user) {
      window.location.assign(`/login?next=${encodeURIComponent("/#history")}`);
      return;
    }
    get("account-history")?.click();
  });
  get("dashboard-refresh").addEventListener("click", load);
  get("dashboard-search").addEventListener("input", () => { reportPage = 0; if (identity) renderReports(); });
  get("dashboard-order").addEventListener("change", () => { reportPage = 0; if (identity) renderReports(); });
  get("dashboard-page-previous").addEventListener("click", () => { if (identity && reportPage > 0) { reportPage--; renderReports(); } });
  get("dashboard-page-next").addEventListener("click", () => { if (identity && !get("dashboard-page-next").disabled) { reportPage++; renderReports(); } });
  document.addEventListener("auth-changed", accountChanged);
  document.addEventListener("realtime-message", (event) => {
    if (["history.updated", "training.updated"].includes(event.detail?.type)) load();
  });
  window.addEventListener("pageshow", (event) => { today(); if (event.persisted) { clear(auth?.user); load(); } });
  today();
  const ready = Promise.resolve(auth?.ready).then(accountChanged).catch(() => {
    clear(null);
    notice("로그인 상태를 확인하지 못했어요. 페이지를 새로고침해 주세요.", true);
  });
  window.HairlinePage?.track(ready);
})();
