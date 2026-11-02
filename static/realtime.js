"use strict";

(() => {
  const auth = window.HairlineAuth;
  if (!auth) return;
  let socket = null, ownerId = null, generation = 0, initialized = false;
  let retryTimer = null, heartbeat = null, attempts = 0, stopped = true;
  const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));
  const state = (value) => emit("realtime-state", { state: value, reconnectAttempt: attempts });
  const current = (version) => version === generation && !stopped && auth.user?.id === ownerId;

  function clearTimers() {
    clearTimeout(retryTimer);
    clearInterval(heartbeat);
    retryTimer = heartbeat = null;
  }
  function disconnect() {
    generation++;
    stopped = true;
    clearTimers();
    const previous = socket;
    socket = null;
    if (previous) previous.close(1000, "client_stopped");
    state("closed");
  }
  function send(payload) {
    if (!socket || socket.readyState !== window.WebSocket.OPEN || stopped) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }
  function retry(version) {
    if (!current(version) || retryTimer !== null) return;
    if (attempts >= 5) { stopped = true; state("retry-limit"); return; }
    const delay = 1000 * 2 ** attempts++;
    state("reconnecting");
    retryTimer = setTimeout(() => { retryTimer = null; open(version); }, delay);
  }
  async function open(version) {
    if (!current(version)) return;
    state("connecting");
    try {
      const response = await fetch("/api/realtime", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(5000) });
      if (!current(version)) return;
      if (response.status === 401) { stopped = true; state("auth-required"); return; }
      if (!response.ok) throw new Error("configuration_unavailable");
      const config = await response.json();
      if (!current(version)) return;
      if (!config.enabled) { stopped = true; state("disabled"); return; }
      if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || config.path !== "/ws" ||
          !["127.0.0.1", "localhost"].includes(window.location.hostname)) throw new Error("invalid_configuration");
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const connection = new window.WebSocket(`${scheme}//${window.location.hostname}:${config.port}/ws`);
      socket = connection;
      connection.onopen = () => {
        if (!current(version) || socket !== connection) { connection.close(1000); return; }
        state("open");
        send({ type: "subscribe", topics: ["history", "training"] });
        heartbeat = setInterval(() => send({ type: "ping" }), 25000);
      };
      connection.onmessage = (event) => {
        if (!current(version) || socket !== connection || typeof event.data !== "string" || event.data.length > 16384) return;
        try {
          const payload = JSON.parse(event.data);
          if (payload && ["connected", "pong", "subscribed", "status", "history.updated", "training.updated", "error"].includes(payload.type)) {
            emit("realtime-message", payload);
          }
        } catch { /* Ignore messages outside the documented JSON protocol. */ }
      };
      connection.onerror = () => { if (current(version) && socket === connection) state("error"); };
      connection.onclose = (event) => {
        if (!current(version) || socket !== connection) return;
        socket = null;
        clearInterval(heartbeat);
        heartbeat = null;
        if (event.code === 1008 || event.code === 1000) {
          stopped = true;
          state(event.code === 1008 ? "auth-required" : "closed");
        } else retry(version);
      };
    } catch {
      if (current(version)) retry(version);
    }
  }
  function connect() {
    disconnect();
    initialized = true;
    ownerId = auth.user?.id ?? null;
    attempts = 0;
    if (!ownerId) return;
    if (!window.WebSocket) { state("unsupported"); return; }
    stopped = false;
    open(generation);
  }
  function syncIdentity() {
    if (!initialized || ownerId !== (auth.user?.id ?? null)) connect();
  }
  window.HairlineRealtime = Object.freeze({
    connect, disconnect,
    ping: () => send({ type: "ping" }),
    requestStatus: () => send({ type: "status" }),
    get connected() { return !!socket && socket.readyState === window.WebSocket.OPEN && !stopped; },
  });
  document.addEventListener("auth-changed", syncIdentity);
  auth.ready.then(syncIdentity).catch(() => state("unavailable"));
  window.addEventListener("pagehide", disconnect);
})();
