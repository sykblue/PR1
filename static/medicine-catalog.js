"use strict";

(() => {
  const get = (id) => document.getElementById(id);
  const root = get("medicine-catalog");
  if (!root) return;
  const search = get("medicine-search"), type = get("medicine-type"), company = get("medicine-company");
  const results = get("medicine-results"), count = get("medicine-count"), empty = get("medicine-empty");
  const byType = get("medicine-group-type"), byCompany = get("medicine-group-company");
  const data = window.HairlineMedicineCatalogData;
  if (!data || !Array.isArray(data.products) || !Array.isArray(data.types)) {
    count.textContent = "제품 목록을 불러오지 못했어요. 페이지를 새로고침해 주세요.";
    [search, type, company, byType, byCompany, get("medicine-reset")].forEach((control) => { control.disabled = true; });
    return;
  }
  const types = new Map(data.types.map((item) => [item.id, item]));
  const products = data.products.filter((item) => /^\d{9}$/.test(item.id) && types.has(item.type)
    && [item.name, item.company, item.composition, item.form].every((value) => typeof value === "string" && value.trim())
    && ["일반의약품", "전문의약품"].includes(item.classification));
  let grouping = "type";
  const normalize = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/g, "");
  const order = (a, b) => a.localeCompare(b, "ko");
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function option(value, label) {
    const element = node("option", "", label); element.value = value; return element;
  }
  type.replaceChildren(option("all", "전체 종류"), ...data.types.map((item) => option(item.id, item.name)));
  company.replaceChildren(option("all", "전체 제조·수입사"), ...[...new Set(products.map((item) => item.company))].sort(order).map((name) => option(name, name)));
  get("medicine-verified").textContent = `식약처 확인 ${data.verifiedAt.replaceAll("-", ".")} · 제조·수입사 ${new Set(products.map((item) => item.company)).size}곳`;

  function photoFigure(product) {
    const photo = product.photo;
    if (!photo || !new RegExp(`^/static/medicine-products/${product.id}\\.(jpg|png)$`).test(photo.src)
      || !Number.isInteger(photo.width) || !Number.isInteger(photo.height) || photo.width < 1 || photo.height < 1) return null;
    const figure = node("figure", "medicine-product-photo");
    const preview = node("a", "medicine-product-photo-preview");
    preview.href = photo.src; preview.target = "_blank"; preview.rel = "noopener noreferrer";
    preview.setAttribute("aria-label", `${product.name} 사진 크게 보기, 새 창`);
    const image = node("img");
    image.src = photo.src; image.alt = photo.alt || `${product.name} 제품 사진`;
    image.width = photo.width; image.height = photo.height;
    image.loading = "lazy"; image.decoding = "async";
    preview.append(image);
    const caption = node("figcaption", "medicine-product-photo-caption");
    if (/^https:\/\/(?:nedrug\.mfds\.go\.kr|www\.yuhan\.co\.kr|www\.segyebiz\.com)\//.test(photo.source)) {
      const source = node("a", "medicine-product-photo-source", photo.sourceLabel || "사진 출처");
      source.href = photo.source; source.target = "_blank"; source.rel = "noopener noreferrer";
      source.setAttribute("aria-label", `${product.name} 사진 출처, 새 창`);
      caption.append(source);
    } else {
      caption.textContent = "제품 사진";
    }
    image.addEventListener("error", () => {
      preview.hidden = true;
      caption.textContent = "사진을 불러오지 못했어요.";
      caption.setAttribute("role", "status");
    });
    figure.append(preview, caption);
    return figure;
  }

  function card(product) {
    const item = node("li", "medicine-product");
    const photo = photoFigure(product);
    if (photo) item.append(photo);
    const badges = node("div", "medicine-product-badges");
    const classification = node("span", "medicine-product-classification", product.classification);
    classification.dataset.prescription = String(product.classification === "전문의약품");
    badges.append(node("span", "medicine-product-form", product.form), classification);
    const name = node("h6", "medicine-product-name", product.name);
    const composition = node("p", "medicine-product-composition", product.composition);
    const facts = node("dl", "medicine-product-facts");
    for (const [label, value] of [["제조·수입사", product.company], ["위탁 제조", product.contractManufacturer], ["허가 효능 요약", product.indication]]) {
      if (!value) continue;
      const row = node("div"); row.append(node("dt", "", label), node("dd", "", value)); facts.append(row);
    }
    const link = node("a", "medicine-product-source", "식약처 제품정보 ↗");
    // Build a fixed official URL; catalog text cannot supply a different host.
    link.href = `https://nedrug.mfds.go.kr/pbp/CCBBB01/getItemDetail?itemSeq=${product.id}`;
    link.target = "_blank"; link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `${product.name} 식약처 제품정보, 새 창`);
    item.append(badges, name, composition, facts, link);
    return item;
  }
  function render() {
    const query = normalize(search.value.slice(0, 80));
    const selected = products.filter((item) => (type.value === "all" || item.type === type.value)
      && (company.value === "all" || item.company === company.value)
      && (!query || normalize([item.name, item.composition, item.company, item.contractManufacturer, item.form, types.get(item.type).name].join(" ")).includes(query)));
    const groups = new Map();
    for (const product of selected) {
      const key = grouping === "company" ? product.company : product.type;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(product);
    }
    const keys = grouping === "company" ? [...groups.keys()].sort(order) : data.types.map((item) => item.id).filter((id) => groups.has(id));
    results.replaceChildren();
    for (const key of keys) {
      const section = node("section", "medicine-product-group");
      const heading = node("div", "medicine-product-group-heading");
      heading.append(node("h5", "", grouping === "company" ? key : types.get(key).name), node("span", "", `${groups.get(key).length}종`));
      section.append(heading);
      if (grouping === "type") section.append(node("p", "medicine-product-group-description", types.get(key).description));
      const list = node("ul", "medicine-product-list");
      list.append(...groups.get(key).slice().sort((a, b) => order(a.name, b.name)).map(card));
      section.append(list); results.append(section);
    }
    empty.hidden = selected.length !== 0;
    count.textContent = `검색 결과 ${selected.length}종 / 전체 ${products.length}종`;
    byType.setAttribute("aria-pressed", String(grouping === "type"));
    byCompany.setAttribute("aria-pressed", String(grouping === "company"));
  }
  function reset() {
    search.value = ""; type.value = "all"; company.value = "all"; grouping = "type";
    render();
  }
  search.addEventListener("input", render);
  type.addEventListener("change", render); company.addEventListener("change", render);
  byType.addEventListener("click", () => { grouping = "type"; render(); });
  byCompany.addEventListener("click", () => { grouping = "company"; render(); });
  get("medicine-reset").addEventListener("click", () => { reset(); search.focus(); });
  window.HairlineMedicineCatalog = Object.freeze({ reset });
  reset();
})();
