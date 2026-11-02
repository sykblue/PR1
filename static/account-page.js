"use strict";

(() => {
  const el = (id) => document.getElementById(id);
  const form = el("account-form"), button = el("account-submit");
  const registering = form.dataset.mode === "register";
  const originalLabel = button.textContent;
  let csrf = "", submitting = false, leaving = false;
  const message = (text) => { el("account-message").textContent = text; el("account-message").hidden = !text; };
  function clearPasswords() {
    el("account-password").value = "";
    if (el("account-confirm")) el("account-confirm").value = "";
  }
  function finish() {
    clearPasswords();
    leaving = true;
    // The server also validates this destination before rendering it into the form.
    const target = new URL(form.dataset.next || "/", window.location.origin);
    const allowed = target.origin === window.location.origin && ["/", "/analysis", "/simulation", "/guide", "/training", "/training/vision", "/training-guide", "/profile"].includes(target.pathname);
    window.location.replace(allowed ? target.href : "/");
  }
  async function initialize() {
    try {
      const response = await fetch("/api/auth/me", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.csrf_token) throw new Error("로그인 준비를 완료하지 못했어요. 페이지를 새로고침해 주세요.");
      csrf = data.csrf_token;
      if (data.user) finish();
    } catch (error) { message(error instanceof TypeError || error instanceof SyntaxError ? "서버에 연결하지 못했어요. 페이지를 새로고침해 주세요." : error.message); }
    finally { button.disabled = !csrf || leaving; }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || leaving || !csrf || !form.reportValidity()) return;
    if (registering && el("account-password").value !== el("account-confirm").value) {
      message("비밀번호 확인이 일치하지 않아요."); el("account-confirm").focus(); return;
    }
    submitting = true; button.disabled = true; button.textContent = "확인하고 있어요…";
    form.setAttribute("aria-busy", "true"); message("");
    const body = new FormData(form);
    try {
      const response = await fetch(registering ? "/api/auth/register" : "/api/auth/login", {
        method: "POST", body, headers: { "X-CSRF-Token": csrf },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || "요청을 완료하지 못했어요.");
      if (!data.user || !data.csrf_token) throw new Error("로그인 응답을 확인하지 못했어요. 다시 시도해 주세요.");
      finish();
    } catch (error) {
      message(error instanceof TypeError || error instanceof SyntaxError ? "서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요." : error.message);
    } finally {
      clearPasswords(); submitting = false; button.disabled = leaving; button.textContent = originalLabel;
      form.removeAttribute("aria-busy");
    }
  });
  window.addEventListener("pagehide", clearPasswords);
  window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
  const initialization = initialize();
  window.HairlinePage?.track(initialization);
})();
