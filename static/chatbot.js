"use strict";

(() => {
  const get = (id) => document.getElementById(id);
  const panel = get("chatbot-panel");
  if (!panel) return;
  const layout = get("app-layout"), launcher = get("chatbot-launcher");
  const messages = get("chatbot-messages"), controls = get("chatbot-controls");
  const close = get("chatbot-close"), reset = get("chatbot-reset");
  const minimize = get("chatbot-minimize"), minimized = get("chatbot-minimized");
  const resume = get("chatbot-resume"), dismiss = get("chatbot-mini-dismiss");
  const minimizedStatus = get("chatbot-minimized-status");
  const wideScreen = window.matchMedia("(min-width: 1280px)");
  const defaultMode = (wide = wideScreen.matches) => layout.dataset.chatbotDefault === "closed" ? "closed" : wide ? "open" : "closed";
  const answerLabels = Object.freeze({ yes: "네", no: "아니요", unsure: "잘 모르겠어요" });
  const questions = Object.freeze([
    { key: "outline", label: "헤어라인·가르마 변화", text: "이전보다 헤어라인이 뒤로 이동하거나 가르마가 넓어 보이나요?", hint: "기억이나 사진을 기준으로 답해 주세요. 비교하기 어렵다면 ‘잘 모르겠어요’를 선택해도 괜찮아요." },
    { key: "shedding", label: "평소보다 많은 빠짐", text: "평소보다 머리카락이 많이 빠지는 상태가 계속되나요?", hint: "머리를 감거나 빗을 때 평소와 다른 변화가 있는지 떠올려 보세요." },
    { key: "sudden", label: "갑작스러운·부분적인 빠짐", text: "갑자기 많이 빠지거나, 동그랗게 비어 보이는 부위가 있나요?", hint: "서서히 생긴 변화와 갑자기 나타난 변화를 구분해 주세요." },
    { key: "scalp", label: "두피 불편감", text: "두피에 심한 가려움, 통증, 화끈거림이나 붉어짐이 있나요?", hint: "현재 느끼거나 눈으로 확인할 수 있는 증상을 기준으로 답해 주세요." },
    { key: "comparison", label: "비슷한 조건의 사진 비교", text: "비슷한 조명과 각도로 찍은 과거 사진에서도 변화가 보이나요?", hint: "과거 사진이 없거나 촬영 조건이 다르다면 ‘잘 모르겠어요’를 선택해 주세요." },
  ]);
  const faq = Object.freeze({
    progress: { label: "탈모 진행 상태 안내", title: "어떤 변화가 있는지 살펴봐요", paragraphs: ["헤어라인이 뒤로 이동하거나 가르마가 넓어지는 등 눈에 보이는 변화가 관찰될 수 있어요. 변화가 시작된 시점과 빠르기도 함께 기록해 주세요.", "사진 한 장이나 자가 테스트만으로 탈모의 단계·진행 속도를 확정할 수는 없어요. 정확한 원인과 상태는 피부과 진료로 확인해 주세요."], next: ["hairline", "crown", "sudden"] },
    hairline: { label: "헤어라인이 뒤로 밀려 보여요", title: "헤어라인의 변화를 기록해 보세요", paragraphs: ["앞쪽 경계나 양옆의 모양이 이전과 달라졌는지 살펴보세요. 촬영 각도와 앞머리 정리에 따라 다르게 보일 수 있어요.", "변화가 이어지거나 걱정된다면, 과거 사진과 변화가 시작된 시점을 정리해 피부과에 상담해 보세요."], next: ["crown", "sudden"] },
    crown: { label: "가르마·정수리가 넓어 보여요", title: "두피가 보이는 범위를 살펴봐요", paragraphs: ["가르마가 넓어 보이거나 정수리 모발이 덜 풍성해 보이는 변화가 있을 수 있어요. 조명과 가르마 위치의 영향도 함께 생각해 주세요.", "같은 조건에서 보이는 변화를 기록하고, 지속되거나 걱정된다면 피부과에서 원인을 확인해 주세요."], next: ["hairline", "sudden"] },
    sudden: { label: "갑자기 많이 빠지거나 두피가 불편해요", title: "원인을 진료로 확인해 주세요", paragraphs: ["갑작스러운 빠짐, 부분적으로 비어 보이는 부위, 심한 가려움·통증·화끈거림 같은 두피 증상이 있다면 피부과 진료를 받아 보세요.", "언제부터 어떤 변화가 있었는지 정리하면 상담에 도움이 돼요. 챗봇은 증상의 원인을 판별하거나 치료를 결정하지 않아요."], next: [] },
    photo: { label: "사진은 어떻게 찍나요?", title: "비슷한 조건으로 기록해 주세요", paragraphs: ["필터 없이 밝고 일정한 조명에서 머리 전체가 보이도록 찍어 주세요. 헤어라인은 정면, 정수리는 위쪽에서 촬영해 보세요.", "비교할 때는 조명·각도·가르마를 최대한 맞춰 주세요. 사진 분석 페이지에서 사진 점검과 부위별 관찰을 시작할 수 있어요."], next: [] },
    consultation: { label: "언제 상담받으면 좋을까요?", title: "걱정이 이어져도 상담할 수 있어요", paragraphs: ["갑자기 빠지거나 부분적으로 비어 보이고 두피에 심한 불편감이 있다면 진료로 원인을 확인해 주세요.", "천천히 생긴 변화라도 계속 걱정되거나 일상에 영향을 준다면 피부과에 상담해 보세요. 변화 시점과 과거 사진을 준비하면 좋아요."], next: [] },
  });
  let answers = [], revision = 0, visibilityChosen = false;

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    svg.setAttribute("aria-hidden", "true");
    use.setAttribute("href", `/static/icons.svg#${name}`);
    svg.append(use);
    return svg;
  }
  function beginView(view) {
    revision++;
    panel.dataset.view = view;
    updateMinimizedSummary();
    messages.replaceChildren();
    controls.replaceChildren();
    controls.removeAttribute("aria-describedby");
  }
  function bubble(title, paragraphs, user = false) {
    const node = make("div", `chatbot-message${user ? " chatbot-user" : ""}`);
    if (!user) {
      const author = make("span", "chatbot-message-author");
      author.append(icon("follicle"), make("span", "", "헤어라인 도우미"));
      node.append(author);
    }
    if (title) node.append(make("h3", "", title));
    for (const paragraph of paragraphs) node.append(make("p", "", paragraph));
    messages.append(node);
    return node;
  }
  function choice(label, action, primary = false, parent = controls, options = {}) {
    const version = revision;
    const button = make("button", `chatbot-choice${primary ? " chatbot-choice-primary" : ""}`);
    button.type = "button";
    button.setAttribute("aria-label", label);
    if (options.topic) button.dataset.topic = options.topic;
    if (options.icon) {
      const badge = make("span", "chatbot-topic-icon");
      badge.append(icon(options.icon));
      button.append(badge);
    }
    const copy = make("span", "chatbot-choice-copy");
    copy.append(make("span", "chatbot-choice-label", label));
    if (options.description) copy.append(make("span", "chatbot-choice-description", options.description));
    button.append(copy, icon("arrow-right"));
    button.addEventListener("click", (event) => {
      if (version !== revision || event.detail > 1) return;
      action();
    });
    parent.append(button);
    return button;
  }
  function focusFirstChoice() {
    controls.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
    messages.scrollTop = 0;
  }
  function menu(focus = false) {
    answers = [];
    beginView("menu");
    const welcome = bubble("나의 모발, 무엇이 궁금하세요?", ["궁금한 점부터 가볍게 살펴봐요."]);
    welcome.classList.add("chatbot-welcome");
    choice(faq.progress.label, () => showFaq("progress"), true, controls, { topic: "progress", icon: "hairline", description: "헤어라인·정수리의 변화 알아보기" });
    choice("자가 테스트 시작 · 5문항", startCheck, true, controls, { topic: "check", icon: "report", description: "내가 관찰한 변화, 차근차근 점검" });
    choice(faq.photo.label, () => showFaq("photo"), false, controls, { icon: "frame" });
    choice(faq.consultation.label, () => showFaq("consultation"), false, controls, { icon: "chat" });
    if (focus) focusFirstChoice();
  }
  function showFaq(key) {
    const item = faq[key];
    if (!item) return;
    answers = [];
    beginView("faq");
    bubble("", [item.label], true);
    bubble(item.title, item.paragraphs);
    if (key === "photo") choice("사진 분석 페이지 열기", () => window.location.assign("/analysis"), true);
    for (const next of item.next) choice(faq[next].label, () => showFaq(next));
    choice("자가 테스트 시작 · 5문항", startCheck, true);
    choice("다른 질문 보기", () => menu(true));
    focusFirstChoice();
  }
  function startCheck() {
    answers = [];
    showQuestion();
  }
  function showQuestion() {
    const index = answers.length, question = questions[index];
    if (!question) return;
    beginView("check");
    if (index) bubble("", [answerLabels[answers[index - 1]]], true);
    const node = bubble("", []);
    node.append(make("span", "chatbot-question-number", `Q${index + 1}. ${question.label}`));
    const heading = make("h3", "", question.text);
    heading.id = "chatbot-question";
    node.append(heading, make("p", "", question.hint));
    controls.setAttribute("aria-describedby", heading.id);
    node.append(make("p", "chatbot-message-note", "탈모 여부나 진행 단계를 판정하는 검사는 아니에요."));
    const progressHeading = make("div", "chatbot-progress-heading");
    progressHeading.append(make("span", "", "내 상태 살펴보기"), make("strong", "", `${index + 1} / ${questions.length}`));
    controls.append(progressHeading);
    const progress = make("progress", "chatbot-check-progress");
    progress.max = questions.length;
    progress.value = index;
    progress.setAttribute("aria-label", `자가 테스트 ${questions.length}문항 중 ${index}문항 응답 완료`);
    controls.append(progress);
    const row = make("div", "chatbot-answer-row");
    for (const [value, label] of Object.entries(answerLabels)) {
      choice(label, () => {
        if (!Object.hasOwn(answerLabels, value) || answers.length !== index) return;
        answers.push(value);
        if (answers.length === questions.length) showResult();
        else showQuestion();
      }, false, row);
    }
    controls.append(row);
    const backRow = make("div", "chatbot-back-row");
    const back = make("button", "", "이전 문항");
    back.type = "button";
    back.disabled = !index;
    const version = revision;
    back.addEventListener("click", () => {
      if (version !== revision || !answers.length) return;
      answers.pop();
      showQuestion();
    });
    const quit = make("button", "", "그만하고 질문 보기");
    quit.type = "button";
    quit.addEventListener("click", () => { if (version === revision) menu(true); });
    backRow.append(back, quit);
    controls.append(backRow);
    focusFirstChoice();
  }
  function checkResult() {
    if (answers[2] === "yes" || answers[3] === "yes") {
      return { key: "consult", title: "진료로 원인을 확인해 보세요", text: "갑작스러운·부분적인 빠짐이나 두피 불편감에 ‘네’라고 답했어요. 피부과에서 원인을 확인하고, 변화가 시작된 시점과 증상을 함께 알려 주세요." };
    }
    if (answers.some((answer) => answer === "yes")) {
      return { key: "record", title: "관찰한 변화를 정리해 보세요", text: "변화가 있다고 답한 항목이 있어요. 비슷한 조건의 사진과 변화 시점을 기록하고, 변화가 이어지거나 걱정된다면 피부과에 상담해 보세요." };
    }
    if (answers.includes("unsure")) {
      return { key: "compare", title: "비교할 기록부터 준비해 보세요", text: "아직 판단하기 어려운 항목이 있어요. 비슷한 조명과 각도로 사진을 남겨 비교해 보세요. 갑작스러운 빠짐이나 두피 불편감이 생기면 진료로 확인해 주세요." };
    }
    return { key: "observe", title: "오늘 확인한 내용을 기억해 두세요", text: "이번 질문에는 모두 ‘아니요’라고 답했어요. 이 답변만으로 탈모가 없다고 판단할 수는 없어요. 이후 변화가 보이거나 걱정된다면 피부과에 상담해 주세요." };
  }
  function showResult() {
    if (answers.length !== questions.length) return;
    const result = checkResult();
    beginView("result");
    const node = bubble(result.title, [result.text]);
    node.dataset.result = result.key;
    const summary = make("ul", "chatbot-check-summary");
    summary.setAttribute("aria-label", "자가 테스트 응답 요약");
    questions.forEach((question, index) => {
      const row = make("li");
      const answer = make("strong", "", answerLabels[answers[index]]);
      answer.dataset.answer = answers[index];
      row.append(make("span", "", question.label), answer);
      summary.append(row);
    });
    node.append(summary, make("p", "chatbot-message-note", "이 요약은 진단 점수나 진행 단계가 아니에요. 응답은 저장되지 않으며 페이지를 새로고침하면 사라져요."));
    choice("마지막 답변 수정하기", () => { answers.pop(); showQuestion(); });
    choice("처음부터 다시 점검하기", startCheck, true);
    choice("다른 질문 보기", () => menu(true));
    focusFirstChoice();
  }
  function updateMinimizedSummary() {
    const view = panel.dataset.view;
    if (view === "check") minimizedStatus.textContent = `자가 테스트 · ${answers.length + 1} / ${questions.length}문항 이어서`;
    else if (view === "result") minimizedStatus.textContent = "자가 테스트 완료 · 결과 다시 보기";
    else if (view === "faq") minimizedStatus.textContent = "살펴보던 안내 이어서 보기";
    else minimizedStatus.textContent = "궁금한 내용을 선택해 보세요";
  }
  function setVisibility(mode, focus = false) {
    const open = mode === "open";
    panel.dataset.visibility = mode;
    panel.hidden = !open;
    minimized.hidden = mode !== "minimized";
    launcher.hidden = mode !== "closed";
    launcher.setAttribute("aria-expanded", String(open));
    resume.setAttribute("aria-expanded", String(open));
    layout.classList.toggle("chatbot-is-open", open);
    updateMinimizedSummary();
    if (focus) (open ? close : mode === "minimized" ? resume : launcher).focus({ preventScroll: true });
  }
  launcher.addEventListener("click", () => { visibilityChosen = true; setVisibility("open", true); });
  resume.addEventListener("click", () => { visibilityChosen = true; setVisibility("open", true); });
  minimize.addEventListener("click", () => { visibilityChosen = true; setVisibility("minimized", true); });
  close.addEventListener("click", () => { visibilityChosen = true; setVisibility("closed", true); });
  dismiss.addEventListener("click", () => { visibilityChosen = true; setVisibility("closed", true); });
  reset.addEventListener("click", () => menu(true));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || panel.hidden || document.querySelector("dialog[open]")) return;
    visibilityChosen = true;
    setVisibility("closed", true);
  });
  document.addEventListener("auth-changed", () => menu(false));
  wideScreen.addEventListener("change", (event) => {
    // Honor an explicit open/close choice while resizing.
    if (!visibilityChosen) setVisibility(defaultMode(event.matches));
  });
  menu();
  setVisibility(defaultMode());
})();
