"use strict";

(() => {
  const focusLabels = Object.freeze({ all: "전체 관찰", hairline: "헤어라인", crown: "정수리·가르마", density: "모발 분포" });
  function inspectPhoto(image) {
    const width = image.naturalWidth, height = image.naturalHeight;
    let light = "직접 확인해 주세요", attention = Math.min(width, height) < 480;
    let note = "사진 전체의 크기와 밝기만 점검해요. 머리 전체와 모발 경계가 선명하게 보이는지도 확인해 주세요.";
    try {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 24;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0, 24, 24);
      const pixels = context.getImageData(0, 0, 24, 24).data;
      let sum = 0;
      for (let i = 0; i < pixels.length; i += 4) sum += .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2];
      const average = sum / (pixels.length / 4);
      light = average < 50 ? "어두운 편이에요" : average > 225 ? "밝은 편이에요" : "중간 밝기예요";
      if (average < 50 || average > 225) {
        attention = true;
        note = "빛이 너무 약하거나 강하면 모발 경계가 다르게 보일 수 있어요. 일정한 조명에서 다시 촬영하는 것도 좋아요.";
      }
    } catch { /* A local preview check must never block the analysis workflow. */ }
    if (Math.min(width, height) < 480) note += " 작은 사진보다 해상도가 높은 원본을 권해요.";
    return { resolution: `${width} × ${height}px`, light, note, attention };
  }
  function observationRows(result, scalpReference = null) {
    const referenceRows = scalpReference ? [{ area: "확대 두피 학습 참고", detail:
      `${scalpReference.status === "reference_only" && ["양호", "경증", "중등도", "중증"].includes(scalpReference.dataset_label) ? `데이터셋 참고 라벨: ${scalpReference.dataset_label}.` : "학습 모델이 참고 라벨을 충분히 구분하지 못했어요."} ${scalpReference.warning || "실험용 분류이며 의료 진단이 아니에요."}` }] : [];
    const evidence = result.visual_evidence;
    if (!evidence) return [...referenceRows, ...(result.observations || [])];
    const forehead = { visible: "이마 피부가 보여요", not_visible: "이마 피부가 보이지 않아요", unclear: "이마 피부는 확인이 어려워요" };
    const scalp = { visible: "모발 사이 두피가 보여요", not_obvious: "모발 사이 두피 노출은 뚜렷하지 않아요", unclear: "모발 사이 두피는 확인이 어려워요" };
    const visibility = { clear: "관찰 부위가 보여요", limited: "관찰 부위가 일부 가려져 있어요", not_visible: "관찰 부위가 보이지 않아요" };
    return [...referenceRows, { area: "이마와 모발 영역 구분", detail: `${forehead[evidence.forehead_skin] || forehead.unclear}. ${scalp[evidence.scalp_in_hair] || scalp.unclear}. ${visibility[evidence.target_visibility] || visibility.limited}. ${evidence.basis || ""}` }, ...(result.observations || [])];
  }
  function reportText(data) {
    if (!data?.result) return "";
    const result = data.result;
    const sections = ["Hairline Lab · 나의 관찰 리포트", `관찰 부위: ${focusLabels[data.focus] || focusLabels.all}`, "", result.summary, "", "[부위별 관찰]"];
    for (const item of observationRows(result, data.scalp_reference)) sections.push(`- ${item.area}: ${item.detail}`);
    sections.push("", "[사진의 한계]", ...(result.limitations || []).map((item) => `- ${item}`));
    sections.push("", "[다음 행동]", ...(result.next_steps || []).map((item) => `- ${item}`));
    if (data.model) sections.push("", `분석 모델: ${data.model}`);
    sections.push("", "사진 기반 참고 관찰이며 의료 진단·실제 진행 예측이 아닙니다.");
    return sections.join("\n");
  }
  window.HairlineAnalysisTools = Object.freeze({ inspectPhoto, reportText, observationRows, focusLabels });
})();
