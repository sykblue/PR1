"use strict";

(() => {
  const el = (id) => document.getElementById(id);
  let user = null, csrf = "", epoch = 0, historyLoad = 0;
  const history = el("history-dialog");
  const notify = (id, text) => { el(id).textContent = text; el(id).hidden = !text; };
  function render() {
    el("account-name").textContent = user ? `${user.username}님` : "";
    el("account-name").hidden = !user;
    el("account-name").title = user ? `${user.username}님의 내 정보` : "";
    el("account-login").hidden = !!user;
    el("account-register").hidden = !!user;
    el("account-logout").hidden = !user;
    // 기록 버튼과 저장 체크는 사진 분석 페이지에만 있어요.
    if (el("account-history")) el("account-history").hidden = !user;
    const saveHistory = el("save-history");
    if (saveHistory) {
      saveHistory.disabled = !user || document.body.classList.contains("busy");
      if (!user) saveHistory.checked = false;
    }
    const savePhoto = el("save-photo");
    if (savePhoto) {
      savePhoto.disabled = !user || !saveHistory?.checked || document.body.classList.contains("busy");
      if (!user || !saveHistory?.checked) savePhoto.checked = false;
    }
  }
  function identity(data) {
    const previousUserId = user?.id ?? null;
    csrf = data.csrf_token;
    user = data.user;
    render();
    if (previousUserId !== (user?.id ?? null)) {
      epoch++;
      if (history) {
        historyLoad++;
        el("history-list").replaceChildren();
        el("history-list").removeAttribute("aria-busy");
        notify("history-message", "");
        el("history-count").textContent = "—";
        el("history-loading").hidden = el("history-empty").hidden = true;
        if (history.open) history.close();
      }
      document.dispatchEvent(new CustomEvent("auth-changed", { detail: { user, previousUserId } }));
    }
  }
  const ready = fetch("/api/auth/me", { cache: "no-store" }).then(async (response) => {
    if (!response.ok) throw new Error("로그인 상태를 확인하지 못했어요. 페이지를 새로고침해 주세요.");
    identity(await response.json());
  });
  window.HairlinePage?.track(ready);
  // Keep the failed bootstrap observable to callers without an unhandled rejection.
  ready.catch((error) => notify("account-message", error.message));
  async function headers() {
    await ready;
    if (!csrf) throw new Error("페이지를 새로고침한 뒤 다시 시도해 주세요.");
    return { "X-CSRF-Token": csrf };
  }
  function open() {
    const next = window.location.pathname + window.location.search + window.location.hash;
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
  }
  window.HairlineAuth = { ready, headers, open, get user() { return user; } };

  async function request(path, options = {}) {
    const response = await fetch(path, { ...options, headers: options.method ? await headers() : undefined });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && path.startsWith("/api/history")) {
        identity(await (await fetch("/api/auth/me")).json());
        open();
      }
      throw new Error(data.error?.message || "요청을 완료하지 못했어요.");
    }
    return data;
  }
  document.addEventListener("auth-required", open);
  el("account-logout").addEventListener("click", async () => {
    el("account-logout").disabled = true;
    try { identity(await request("/api/auth/logout", { method: "POST" })); }
    catch (error) { notify("account-message", error.message); }
    finally { el("account-logout").disabled = false; }
  });

  function historyIcon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    svg.setAttribute("aria-hidden", "true");
    use.setAttribute("href", `/static/icons.svg#${name}`);
    svg.append(use);
    return svg;
  }

  function historyDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return { day: "—", month: "날짜 미상", time: "", full: "날짜 미상" };
    const options = { timeZone: "Asia/Seoul" };
    const parts = Object.fromEntries(new Intl.DateTimeFormat("ko-KR", { ...options,
      year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date)
      .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return { day: parts.day, month: `${parts.year}.${parts.month}`,
      time: date.toLocaleTimeString("ko-KR", { ...options, hour: "2-digit", minute: "2-digit", hour12: false }),
      full: date.toLocaleString("ko-KR", options) };
  }

  async function loadHistory() {
    const version = epoch, requestId = ++historyLoad;
    const current = () => version === epoch && requestId === historyLoad;
    el("history-list").replaceChildren();
    el("history-list").setAttribute("aria-busy", "true");
    el("history-count").textContent = "—";
    el("history-empty").hidden = true;
    el("history-loading").hidden = false;
    notify("history-message", "");
    try {
      const data = await request("/api/history");
      if (!current()) return;
      el("history-count").textContent = `${data.items.length}개`;
      el("history-empty").hidden = data.items.length > 0;
      for (const item of data.items) {
        const row = document.createElement("article"); row.className = "history-item";
        row.setAttribute("role", "listitem");
        const date = historyDate(item.created_at);
        const dateBadge = document.createElement("div"); dateBadge.className = "history-date"; dateBadge.setAttribute("aria-hidden", "true");
        const day = document.createElement("span"); day.className = "history-date-day"; day.textContent = date.day;
        const month = document.createElement("span"); month.className = "history-date-month"; month.textContent = date.month;
        dateBadge.append(day, month);
        const content = document.createElement("div"); content.className = "history-item-content";
        const meta = document.createElement("div"); meta.className = "history-item-meta";
        const kind = document.createElement("span"); kind.className = "history-kind"; kind.textContent = "헤어라인 관찰 리포트";
        const time = document.createElement("time"); time.className = "history-time";
        time.dateTime = item.created_at; time.textContent = date.time;
        time.setAttribute("aria-label", date.full); time.title = date.full;
        meta.append(kind, time);
        const summary = document.createElement("p"); summary.className = "history-summary"; summary.textContent = item.summary;
        const bottom = document.createElement("div"); bottom.className = "history-item-bottom";
        const model = document.createElement("span"); model.className = "history-model"; model.title = "분석에 사용한 모델";
        const modelName = document.createElement("span"); modelName.textContent = item.model;
        model.append(historyIcon("sparkles"), modelName);
        const buttons = document.createElement("div"); buttons.className = "history-actions";
        const view = document.createElement("button"); view.type = "button"; view.className = "history-view";
        const viewText = document.createElement("span"); viewText.textContent = "리포트 보기";
        view.append(viewText, historyIcon("arrow-right"));
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "history-remove";
        remove.title = "기록 삭제"; remove.setAttribute("aria-label", `${date.full} 리포트 삭제`);
        remove.append(historyIcon("trash"));
        view.addEventListener("click", async () => {
          view.disabled = true; view.setAttribute("aria-busy", "true"); viewText.textContent = "불러오는 중";
          try {
            if (window.location.pathname !== "/analysis") {
              window.location.assign(`/analysis?report=${item.id}`);
              return;
            }
            const report = await request(`/api/history/${item.id}`);
            if (version !== epoch) return;
            document.dispatchEvent(new CustomEvent("history-selected", { detail: report })); history.close();
          } catch (error) { if (version === epoch) notify("history-message", error.message); }
          finally { view.disabled = false; view.removeAttribute("aria-busy"); viewText.textContent = "리포트 보기"; }
        });
        remove.addEventListener("click", async () => {
          if (!window.confirm("이 분석 리포트를 삭제할까요?")) return;
          remove.disabled = true; remove.setAttribute("aria-busy", "true");
          try {
            await request(`/api/history/${item.id}`, { method: "DELETE" });
            if (version === epoch) await loadHistory();
          } catch (error) { if (version === epoch) notify("history-message", error.message); }
          finally { remove.disabled = false; remove.removeAttribute("aria-busy"); }
        });
        buttons.append(remove, view); bottom.append(model, buttons); content.append(meta, summary, bottom);
        row.append(dateBadge, content); el("history-list").append(row);
      }
    } catch (error) { if (current()) notify("history-message", error.message); }
    finally {
      if (current()) { el("history-loading").hidden = true; el("history-list").removeAttribute("aria-busy"); }
    }
  }
  if (history) {
    const openHistory = () => {
      if (!user) { open(); return; }
      if (!history.open) history.showModal();
      return loadHistory();
    };
    el("account-history").addEventListener("click", openHistory);
    ready.then(() => { if (window.location.hash === "#history") return openHistory(); }).catch(() => {});
    el("history-close").addEventListener("click", () => history.close());
    el("history-start").addEventListener("click", () => {
      history.close();
      if (window.location.pathname !== "/analysis") { window.location.assign("/analysis"); return; }
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el("analysis").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
      el("analyze-button").focus({ preventScroll: true });
    });
    document.addEventListener("report-saved", () => { if (history.open) loadHistory(); });
  }
  window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
  render();
})();
