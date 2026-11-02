"use strict";

(() => {
  const el = (id) => document.getElementById(id);
  const rules = el("guide-readiness").dataset;
  const minimum = { photos: Number(rules.minimumPhotos), groups: Number(rules.minimumGroups), total: Number(rules.minimumTotalGroups) };
  let epoch = 0, seenUser, controller = null;
  function message(text) { el("guide-data-message").textContent = text; el("guide-data-message").hidden = !text; }
  function state(label, text, ready = false) {
    el("guide-model-state").textContent = label;
    el("guide-model-state").className = `tag ${ready ? "blue" : "neutral"}`;
    el("guide-status-summary").textContent = text;
  }
  function clear() {
    el("guide-metrics").hidden = true;
    el("guide-last-trained").hidden = true; el("guide-last-trained").textContent = "";
    for (const id of ["guide-reference-count", "guide-concern-count", "guide-reference-groups", "guide-concern-groups", "guide-total-groups"]) el(id).textContent = "—";
    el("guide-reference-progress").value = el("guide-concern-progress").value = 0;
    message("");
  }
  async function refresh() {
    if (!window.HairlineAuth.user) return;
    controller?.abort();
    const current = new AbortController(), version = ++epoch;
    controller = current; clear();
    state("확인 중", "내 계정의 사진 수와 학습 상태를 확인하고 있어요.");
    el("guide-readiness").setAttribute("aria-busy", "true");
    el("guide-refresh").disabled = true;
    const timeout = setTimeout(() => current.abort(), 15000);
    try {
      const task = fetch("/api/training/status", { signal: current.signal, cache: "no-store" })
        .then(async response => [response, await response.json()]);
      window.HairlinePage?.track(task);
      const [response, data] = await task;
      if (version !== epoch) return;
      if (response.status === 401) {
        el("guide-login").hidden = false; el("guide-training").hidden = true;
        state("로그인 필요", "로그인 세션이 끝났어요. 다시 로그인하면 내 준비 상태를 확인할 수 있어요."); return;
      }
      if (!response.ok) throw new Error(data.error?.message || "학습 상태를 불러오지 못했어요.");
      const photos = data.minimum_per_label ?? minimum.photos;
      const groups = data.minimum_groups_per_label ?? minimum.groups;
      const allGroups = data.minimum_groups_total ?? minimum.total;
      const totalGroups = data.total_groups ?? new Set(data.samples.map((sample) => sample.group)).size;
      const needed = [];
      for (const [key, label] of [["reference", "기준"], ["concern", "의심"]]) {
        el(`guide-${key}-count`).textContent = `${data.counts[key]} / ${photos}장`;
        el(`guide-${key}-progress`).max = photos;
        el(`guide-${key}-progress`).value = Math.min(data.counts[key], photos);
        el(`guide-${key}-groups`).textContent = `${data.group_counts[key]} / ${groups}개`;
        if (data.counts[key] < photos) needed.push(`${label} 사진 ${photos - data.counts[key]}장`);
        if (data.group_counts[key] < groups) needed.push(`${label} 사람 그룹 ${groups - data.group_counts[key]}개`);
      }
      if (totalGroups < allGroups) needed.push(`전체 사람 그룹 ${allGroups - totalGroups}개`);
      el("guide-total-groups").textContent = `전체 사람 그룹 ${totalGroups} / ${allGroups}개 · 등록 사진 ${data.total}장`;
      el("guide-metrics").hidden = false;
      if (data.model_ready) {
        state("학습 완료", "지금은 추가 학습이 필요하지 않아요. 새 사진으로 로컬 분류를 사용해 보세요.", true);
        message("사진을 추가·삭제하면 현재 데이터로 다시 1회 학습해 주세요.");
      } else if (data.can_train) {
        state("학습 1회 필요", data.model_stale ? "등록 데이터가 바뀌었어요. 현재 사진으로 다시 한 번 학습해 주세요." : "최소 조건을 갖췄어요. 로컬 학습 페이지에서 한 번 학습하면 돼요.", true);
        message("사진 수 조건을 충족해도 라벨이 학습·검증 양쪽에 들어가도록 사람 그룹을 나눌 수 있어야 해요.");
      } else {
        state("사진 준비 중", "아직 학습 조건이 부족해요. 사진은 저장할 수 있고, 아래 항목을 채운 뒤 학습하면 돼요.");
        message(`추가로 필요한 항목: ${needed.join(" · ")}. 같은 사람을 다른 그룹 코드로 나누지 마세요.`);
      }
      if (data.model?.trained_at) {
        const date = new Date(data.model.trained_at);
        if (!Number.isNaN(date.getTime())) {
          el("guide-last-trained").textContent = `최근 모델 학습: ${date.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}${data.model_stale ? " · 데이터 변경 후 재학습 대기" : ""}`;
          el("guide-last-trained").hidden = false;
        }
      }
    } catch (error) {
      if (version !== epoch) return;
      state("상태 확인 필요", "현재 상태를 가져오지 못했어요. 아래 가이드는 계속 읽을 수 있어요.");
      message(error.name === "AbortError" ? "응답이 늦어졌어요. 준비 상태 다시 확인을 눌러 주세요." : error instanceof TypeError || error instanceof SyntaxError ? "로컬 서버 연결을 확인하고 다시 시도해 주세요." : error.message);
    } finally {
      clearTimeout(timeout);
      if (version === epoch) { controller = null; el("guide-refresh").disabled = false; el("guide-readiness").removeAttribute("aria-busy"); }
    }
  }
  function accountChanged() {
    const id = window.HairlineAuth.user?.id ?? null;
    if (seenUser === id) return;
    seenUser = id; epoch++; controller?.abort(); controller = null;
    clear(); el("guide-readiness").removeAttribute("aria-busy");
    el("guide-login").hidden = !!id;
    el("guide-training").hidden = el("guide-refresh").hidden = !id;
    el("guide-refresh").disabled = false;
    if (id) refresh();
    else state("로그인 후 확인", "로그인하면 내 사진이 얼마나 모였는지, 지금 학습이 필요한지 알려드려요.");
  }
  el("guide-refresh").addEventListener("click", refresh);
  document.addEventListener("auth-changed", accountChanged);
  window.HairlineAuth.ready.then(accountChanged).catch(() => {
    clear(); state("서버 연결 필요", "로컬 서버에 연결하면 내 학습 준비 상태를 확인할 수 있어요.");
  });
})();
