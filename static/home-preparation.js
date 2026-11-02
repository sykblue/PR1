"use strict";

(() => {
  const fields = document.getElementById("photo-prep-fields");
  if (!fields) return;
  const checks = [...fields.querySelectorAll("[data-photo-prep]")];
  const count = document.getElementById("photo-prep-count");
  const progress = document.getElementById("photo-prep-progress");
  const message = document.getElementById("photo-prep-message");
  const reset = document.getElementById("photo-prep-reset");
  if (!checks.length || !count || !progress || !message || !reset) return;
  function update() {
    const ready = checks.filter(check => check.checked).length;
    count.textContent = `${ready} / ${checks.length}개 확인`;
    progress.max = checks.length; progress.value = ready;
    progress.textContent = `${ready} / ${checks.length}`;
    reset.disabled = ready === 0;
    message.textContent = ready === checks.length
      ? "준비 항목을 모두 확인했어요. 사진 분석에서 사진을 선택해 주세요."
      : "확인한 항목을 체크해 보세요. 사진은 분석 페이지에서 선택해요.";
  }
  fields.addEventListener("change", update);
  reset.addEventListener("click", () => {
    checks.forEach(check => { check.checked = false; });
    update(); checks[0].focus();
  });
  window.addEventListener("pageshow", update);
  update();
})();
