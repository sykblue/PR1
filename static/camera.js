"use strict";

(() => {
  const el = (id) => document.getElementById(id);
  const dialog = el("camera-dialog"), video = el("camera-video");
  let stream = null, facing = "user", generation = 0, photoEpoch = 0, nativeGeneration = null;
  const receivePhoto = file => window.HairlineCamera?.selectPhoto ? window.HairlineCamera.selectPhoto(file) : selectPhoto(file);
  function stop() {
    generation++;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    el("camera-capture").disabled = true;
    el("camera-switch").disabled = true;
  }
  function close() { stop(); if (dialog.open) dialog.close(); }
  function invalidatePhoto() { photoEpoch++; nativeGeneration = null; close(); }
  async function start() {
    stop();
    const version = generation;
    el("camera-message").textContent = "카메라 권한을 확인하고 있어요…";
    try {
      const next = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 960 } } });
      if (version !== generation || !dialog.open || document.hidden) { next.getTracks().forEach((track) => track.stop()); return; }
      stream = next;
      video.srcObject = stream;
      const actualFacing = stream.getVideoTracks()[0]?.getSettings?.().facingMode || facing;
      video.classList.toggle("mirrored", actualFacing === "user");
      await video.play();
      if (version !== generation || !dialog.open) return;
      el("camera-capture").disabled = false;
      el("camera-switch").disabled = false;
      el("camera-message").textContent = "머리 전체가 보이게 맞춘 뒤 촬영해 주세요.";
    } catch (error) {
      if (version !== generation) return;
      stop();
      const messages = {
        NotAllowedError: "카메라 권한이 필요해요. 주소창의 카메라 권한을 허용한 뒤 다시 열어 주세요.",
        NotFoundError: "연결된 카메라를 찾지 못했어요. 사진 파일을 선택해 주세요.",
        NotReadableError: "카메라를 열지 못했어요. 다른 앱에서 사용 중인지 확인해 주세요.",
      };
      el("camera-message").textContent = messages[error.name] || "카메라를 시작하지 못했어요. 창을 닫고 사진 파일을 선택해 주세요.";
    }
  }
  el("camera-open").addEventListener("click", () => {
    nativeGeneration = null;
    if (!navigator.mediaDevices?.getUserMedia) { nativeGeneration = photoEpoch; el("camera-file").click(); return; }
    if (!dialog.open) dialog.showModal();
    return start();
  });
  el("camera-close").addEventListener("click", close);
  dialog.addEventListener("close", stop);
  dialog.addEventListener("cancel", stop);
  document.addEventListener("visibilitychange", () => { if (document.hidden) close(); });
  window.addEventListener("pagehide", invalidatePhoto);
  document.addEventListener("auth-changed", invalidatePhoto);
  el("camera-switch").addEventListener("click", () => { facing = facing === "user" ? "environment" : "user"; return start(); });
  el("camera-file").addEventListener("change", async (event) => {
    const version = nativeGeneration; nativeGeneration = null;
    const file = event.target.files[0]; event.target.value = "";
    if (file && version === photoEpoch) await receivePhoto(file);
  });
  el("camera-capture").addEventListener("click", async () => {
    if (!stream || Math.min(video.videoWidth, video.videoHeight) < 160) {
      el("camera-message").textContent = "카메라 화면을 준비하고 있어요. 잠시 후 촬영해 주세요."; return;
    }
    const version = generation;
    el("camera-capture").disabled = el("camera-switch").disabled = true;
    const canvas = document.createElement("canvas");
    const ratio = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * ratio); canvas.height = Math.round(video.videoHeight * ratio);
    try {
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (version !== generation || !dialog.open) return;
      if (!blob) throw new Error("capture_failed");
      close();
      await receivePhoto(new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" }));
      (el(window.HairlineCamera?.focusTarget || "analyze-button") || el("simulate-button"))?.focus();
    } catch {
      if (version !== generation) return;
      el("camera-message").textContent = "촬영하지 못했어요. 다시 시도해 주세요.";
      el("camera-capture").disabled = el("camera-switch").disabled = false;
    }
  });
})();
