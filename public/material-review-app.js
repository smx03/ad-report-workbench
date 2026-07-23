import { buildMaterialReview } from "./material-review-engine.js?v=20260723-3";
import { readMaterialWorkbook } from "./material-review-reader.js?v=20260723-3";
import { buildCpaSeries, directionSpendBreakdown, MATERIAL_PAGE_SIZE, paginateItems, paginationTokens } from "./material-review-view.js?v=20260723-1";

const root = document.querySelector("#weekly-material-page");
const CHART_COLORS = ["#176b50", "#2f6f9f", "#c18a2f", "#8b5d73", "#4f827d", "#75684b", "#aab3af"];
const state = { file: null, dataset: null, review: null, materialByKey: new Map(), tablePage: 1, chartPlacement: "全部" };
const fileInput = root.querySelector("#material-file");
const fileSlot = root.querySelector("#material-file-slot");
const fileState = root.querySelector("#material-file-state");
const uploadSummary = root.querySelector("#material-upload-summary");
const generateButton = root.querySelector("#generate-material-review");
const clearFileButton = root.querySelector("#clear-material-file");
const clearAllButton = root.querySelector("#clear-material-all");
const validation = root.querySelector("#material-validation");
const results = root.querySelector("#material-results");
const detailDialog = document.querySelector("#material-detail-dialog");
let capacityRebuildTimer = null;

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  state.file = file;
  state.dataset = null;
  state.review = null;
  state.tablePage = 1;
  state.chartPlacement = "全部";
  root.querySelector("#material-chart-placement").value = "全部";
  fileSlot.classList.add("ready");
  fileState.textContent = file.name;
  fileSlot.querySelector(".file-select").textContent = "替换文件";
  clearFileButton.disabled = false;
  clearAllButton.disabled = false;
  generateButton.disabled = false;
  uploadSummary.textContent = `${formatFileSize(file.size)} · 文件只在当前浏览器内读取`;
  validation.classList.add("hidden");
  results.classList.add("hidden");
  fileInput.value = "";
});

clearFileButton.addEventListener("click", clearMaterialFile);
clearAllButton.addEventListener("click", clearMaterialFile);
generateButton.addEventListener("click", generateReview);

root.querySelectorAll("[data-material-tab]").forEach((button) => {
  button.addEventListener("click", () => selectTab(button.dataset.materialTab));
});

for (const id of ["material-target-inner", "material-target-outer", "material-min-spend", "material-min-conversions", "material-weekly-capacity"]) {
  root.querySelector(`#${id}`).addEventListener("change", () => {
    if (!state.dataset) return;
    state.tablePage = 1;
    rebuildReview();
    renderReview();
  });
}
root.querySelector("#material-weekly-capacity").addEventListener("input", () => {
  if (!state.dataset) return;
  clearTimeout(capacityRebuildTimer);
  capacityRebuildTimer = setTimeout(() => {
    state.tablePage = 1;
    rebuildReview();
    renderReview();
  }, 180);
});

root.querySelector("#material-search").addEventListener("input", resetAndRenderMaterialTable);
root.querySelector("#material-placement-filter").addEventListener("change", resetAndRenderMaterialTable);
root.querySelector("#material-status-filter").addEventListener("change", resetAndRenderMaterialTable);
root.querySelector("#material-chart-placement").addEventListener("change", (event) => {
  state.chartPlacement = event.target.value;
  renderCharts();
});
root.querySelector("#material-page-prev").addEventListener("click", () => setMaterialPage(state.tablePage - 1));
root.querySelector("#material-page-next").addEventListener("click", () => setMaterialPage(state.tablePage + 1));
root.querySelector("#material-page-numbers").addEventListener("click", (event) => {
  const button = event.target.closest("[data-material-page]");
  if (button) setMaterialPage(Number(button.dataset.materialPage));
});
root.querySelector("#copy-material-brief").addEventListener("click", copyBrief);
root.querySelector("#download-material-csv").addEventListener("click", downloadMaterialCsv);
root.querySelector("#material-top-list").addEventListener("click", handleMaterialClick);
root.querySelector("#material-table-body").addEventListener("click", handleMaterialClick);
document.querySelectorAll("[data-close-material-dialog]").forEach((button) => button.addEventListener("click", () => detailDialog.close()));

async function generateReview() {
  if (!state.file) return;
  const original = generateButton.innerHTML;
  generateButton.disabled = true;
  generateButton.textContent = "正在读取周表";
  validation.className = "validation-band";
  validation.innerHTML = `<div class="spinner">↻</div><div><strong>正在本机解析素材数据</strong><span>大文件可能需要十几秒；正在识别内广、外广和任务映射页…</span></div>`;
  results.classList.add("hidden");
  try {
    state.dataset = await readMaterialWorkbook(await state.file.arrayBuffer());
    generateButton.textContent = "正在聚合与分层";
    await nextFrame();
    rebuildReview();
    renderReview();
    const sourceRows = state.dataset.rows.length;
    const materialCount = state.review.materials.length;
    const supplierPlan = state.review.supplierPlan;
    validation.className = "validation-band success";
    const warnings = state.review.warnings.length ? ` 数据提示：${state.review.warnings.map(escapeHtml).join(" ")}` : "";
    validation.innerHTML = `<div>✓</div><div><strong>读取完成：${integer(sourceRows)}行已聚合为${integer(materialCount)}条版位素材</strong><span>已识别${state.dataset.sourceSheets.map((sheet) => `${escapeHtml(sheet.placement)} ${integer(sheet.rowCount)}行`).join("、")}；优矩/禾也可归因${integer(supplierPlan.identifiableCount)}条，产能计算已排除${integer(supplierPlan.excludedOriginalPriceCount)}条一口价原素材。${warnings}</span></div>`;
    results.classList.remove("hidden");
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    state.dataset = null;
    state.review = null;
    validation.className = "validation-band error";
    validation.innerHTML = `<div>!</div><div><strong>生成失败</strong><span>${escapeHtml(error.message || "请检查Excel文件")}</span></div>`;
  } finally {
    generateButton.innerHTML = original;
    generateButton.disabled = !state.file;
  }
}

function rebuildReview() {
  state.review = buildMaterialReview(state.dataset.rows, readOptions());
  state.materialByKey = new Map(state.review.materials.map((item) => [materialKey(item), item]));
}

function readOptions() {
  return {
    targets: {
      内广: positiveOrNull(root.querySelector("#material-target-inner").value),
      外广: positiveOrNull(root.querySelector("#material-target-outer").value),
    },
    minSpend: nonnegative(root.querySelector("#material-min-spend").value, 500),
    minConversions: Math.max(1, Math.round(nonnegative(root.querySelector("#material-min-conversions").value, 10))),
    weeklyCapacity: Math.max(1, Math.round(nonnegative(root.querySelector("#material-weekly-capacity").value, 30))),
  };
}

function renderReview() {
  const review = state.review;
  const summary = review.summary;
  root.querySelector("#material-result-week").textContent = state.dataset.weekLabel;
  root.querySelector("#material-result-source").textContent = `${state.dataset.sourceSheets.map((sheet) => sheet.name).join(" + ")} · 共${state.dataset.workbookSheetCount}个工作表`;
  renderKpis(summary);
  renderCharts();
  renderDirections(review.directionSummaries);
  renderTopMaterials(review.materials);
  renderInsights(review);
  renderMaterialTable();
  renderSupplierPlan(review.supplierPlan);
  renderBriefs(review.briefs);
}

function renderKpis(summary) {
  const kpis = [
    ["素材记录", integer(summary.totalMaterials), `原始${integer(summary.sourceRows)}行`],
    ["总消耗", money(summary.totalSpend), "内外广合计"],
    ["总转化", integer(summary.totalConversions), "有效转化"],
    ["加权成本", money(summary.cpa), "消耗 ÷ 转化", "highlight"],
    ["次留率", percent(summary.retentionRate), "仅已回传并排除异常", "highlight"],
    ["优质 / 潜力", `${integer(summary.winnerCount)} / ${integer(summary.potentialCount)}`, "进入下周Brief", "warning"],
  ];
  root.querySelector("#material-kpis").innerHTML = kpis.map(([label, value, note, className = ""]) => `<div class="material-kpi ${className}"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join("");
}

function renderCharts() {
  if (!state.review) return;
  const placement = state.chartPlacement;
  const pieData = directionSpendBreakdown(state.review.materials, placement);
  const lineData = buildCpaSeries(state.review.materials, state.review.thresholds, placement);
  root.querySelector("#material-pie-context").textContent = placement === "全部" ? "全部版位" : `${placement}素材`;
  root.querySelector("#material-line-context").textContent = `${placement === "全部" ? "全部版位" : placement} · 按消耗排序 · 成本越低越好`;
  renderDirectionPie(pieData);
  renderCpaLine(lineData);
}

function renderDirectionPie(data) {
  const container = root.querySelector("#material-direction-pie");
  if (!data.length || !data.some((item) => item.spend > 0)) {
    container.innerHTML = `<div class="empty-material-state">当前版位暂无可绘制的消耗数据</div>`;
    return;
  }
  const totalSpend = data.reduce((sum, item) => sum + item.spend, 0);
  let angle = -Math.PI / 2;
  const paths = data.map((item, index) => {
    const sweep = item.spendShare * Math.PI * 2;
    const end = angle + Math.min(sweep, Math.PI * 2 - .0001);
    const path = donutPath(120, 120, 86, 52, angle, end);
    angle += sweep;
    const tooltip = `${item.direction}｜消耗${money(item.spend)}｜占比${percent(item.spendShare)}｜成本${money(item.cpa)}`;
    return `<path d="${path}" fill="${CHART_COLORS[index % CHART_COLORS.length]}" data-chart-tooltip="${escapeAttribute(tooltip)}" aria-label="${escapeAttribute(tooltip)}"></path>`;
  }).join("");
  const legend = data.map((item, index) => `<div class="material-pie-legend-row"><i style="background:${CHART_COLORS[index % CHART_COLORS.length]}"></i><span><strong>${escapeHtml(item.direction)}</strong><small>${integer(item.materialCount)}条 · ${money(item.spend)}</small></span><b>${percent(item.spendShare)}</b></div>`).join("");
  container.innerHTML = `<div class="material-chart-canvas"><svg class="material-pie-svg" viewBox="0 0 240 240" role="img" aria-label="内容方向消耗占比环形图"><title>内容方向消耗占比</title><desc>展示各内容方向在当前版位筛选下的消耗占比</desc>${paths}<circle cx="120" cy="120" r="49" fill="#ffffff"></circle><text x="120" y="114" text-anchor="middle" class="material-pie-total">${escapeHtml(compactMoney(totalSpend))}</text><text x="120" y="136" text-anchor="middle" class="material-pie-label">总消耗</text></svg><div class="material-chart-tooltip" role="status"></div></div><div class="material-pie-legend">${legend}</div>`;
  bindChartTooltip(container);
}

function renderCpaLine(data) {
  const container = root.querySelector("#material-cpa-line");
  if (!data.length) {
    container.innerHTML = `<div class="empty-material-state">当前版位暂无有效成本数据</div>`;
    return;
  }
  const width = 700;
  const height = 280;
  const plot = { left: 50, right: 18, top: 22, bottom: 46 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const maxValue = Math.max(...data.flatMap((item) => [item.cpa, item.targetCpa || 0]));
  const yMax = Math.max(10, Math.ceil(maxValue * 1.15 / 10) * 10);
  const x = (index) => data.length === 1 ? plot.left + plotWidth / 2 : plot.left + index * plotWidth / (data.length - 1);
  const y = (value) => plot.top + plotHeight - (value / yMax) * plotHeight;
  const actualPoints = data.map((item, index) => `${x(index).toFixed(1)},${y(item.cpa).toFixed(1)}`);
  const targetPoints = data.map((item, index) => `${x(index).toFixed(1)},${y(item.targetCpa || 0).toFixed(1)}`);
  const ticks = Array.from({ length: 5 }, (_, index) => index * yMax / 4);
  const grid = ticks.map((tick) => `<g><line x1="${plot.left}" x2="${width - plot.right}" y1="${y(tick)}" y2="${y(tick)}"></line><text x="${plot.left - 9}" y="${y(tick) + 4}" text-anchor="end">${Math.round(tick)}</text></g>`).join("");
  const labels = data.map((item, index) => (index % 3 === 0 || index === data.length - 1) ? `<text x="${x(index)}" y="${height - 18}" text-anchor="middle">${index + 1}</text>` : "").join("");
  const points = data.map((item, index) => {
    const tooltip = `#${index + 1} ${item.materialId}｜${item.placement}｜消耗${money(item.spend)}｜成本${money(item.cpa)}｜目标${money(item.targetCpa)}`;
    return `<circle cx="${x(index)}" cy="${y(item.cpa)}" r="4.5" fill="${chartStatusColor(item.classification)}" data-chart-tooltip="${escapeAttribute(tooltip)}" aria-label="${escapeAttribute(tooltip)}"></circle>`;
  }).join("");
  const belowTarget = data.filter((item) => item.targetCpa != null && item.cpa <= item.targetCpa).length;
  const top = data[0];
  container.innerHTML = `<div class="material-line-legend"><span><i class="actual"></i>实际成本</span><span><i class="target"></i>版位目标</span><b>${belowTarget}/${data.length}条低于目标</b></div><div class="material-chart-canvas"><svg class="material-line-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="高消耗素材成本与目标成本折线图"><title>高消耗素材成本曲线</title><desc>按消耗从高到低展示前${data.length}条素材的实际转化成本与对应版位目标成本</desc><g class="material-chart-grid-lines">${grid}</g><polyline class="material-target-line" points="${targetPoints.join(" ")}"></polyline><polyline class="material-actual-line" points="${actualPoints.join(" ")}"></polyline><g class="material-line-points">${points}</g><g class="material-chart-x-labels">${labels}<text x="${plot.left + plotWidth / 2}" y="${height - 2}" text-anchor="middle">素材消耗排名</text></g><text class="material-chart-unit" x="${plot.left}" y="12">成本（元）</text></svg><div class="material-chart-tooltip" role="status"></div></div><div class="material-chart-footnote"><strong>最高消耗素材 ${escapeHtml(top.materialId)}</strong><span>${escapeHtml(top.placement)} · 消耗${money(top.spend)} · 成本${money(top.cpa)}</span></div>`;
  bindChartTooltip(container);
}

function donutPath(cx, cy, outerRadius, innerRadius, startAngle, endAngle) {
  const outerStart = polar(cx, cy, outerRadius, startAngle);
  const outerEnd = polar(cx, cy, outerRadius, endAngle);
  const innerEnd = polar(cx, cy, innerRadius, endAngle);
  const innerStart = polar(cx, cy, innerRadius, startAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${outerStart.x} ${outerStart.y} A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y} L ${innerEnd.x} ${innerEnd.y} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y} Z`;
}

function polar(cx, cy, radius, angle) {
  return { x: (cx + Math.cos(angle) * radius).toFixed(3), y: (cy + Math.sin(angle) * radius).toFixed(3) };
}

function bindChartTooltip(container) {
  if (container.dataset.tooltipBound) return;
  container.dataset.tooltipBound = "true";
  const hide = () => container.querySelector(".material-chart-tooltip")?.classList.remove("show");
  container.addEventListener("pointermove", (event) => {
    const mark = event.target.closest("[data-chart-tooltip]");
    if (!mark) return hide();
    const tooltip = container.querySelector(".material-chart-tooltip");
    const chart = container.querySelector(".material-chart-canvas");
    if (!tooltip || !chart) return;
    tooltip.textContent = mark.dataset.chartTooltip;
    tooltip.classList.add("show");
    const chartRect = chart.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    const left = markRect.left - chartRect.left + markRect.width / 2 - tooltip.offsetWidth / 2;
    const top = markRect.top - chartRect.top - tooltip.offsetHeight - 9;
    tooltip.style.left = `${Math.max(8, Math.min(chartRect.width - tooltip.offsetWidth - 8, left))}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  });
  container.addEventListener("pointerleave", hide);
}

function renderDirections(directions) {
  const container = root.querySelector("#material-direction-list");
  const maxSpend = Math.max(1, ...directions.map((item) => item.spend));
  container.innerHTML = directions.slice(0, 7).map((item) => `<div class="direction-row">
    <div class="direction-name"><strong>${escapeHtml(item.direction)}</strong><small>${integer(item.materialCount)}条素材 · ${integer(item.winnerCount)}条跑量优质</small></div>
    <div class="direction-meter"><div class="direction-meter-track"><span style="width:${Math.max(2, item.spend / maxSpend * 100).toFixed(1)}%"></span></div><small>消耗占比 ${percent(item.spendShare)}</small></div>
    <div class="direction-metric"><span>成本</span><strong>${money(item.cpa)}</strong></div>
    <div class="direction-metric"><span>次留率</span><strong>${percent(item.retentionRate)}</strong></div>
  </div>`).join("") || `<div class="empty-material-state">暂无可归纳的内容方向</div>`;
}

function renderTopMaterials(materials) {
  const top = [...materials]
    .filter((item) => ["跑量优质", "高效潜力"].includes(item.classification))
    .sort((a, b) => b.spend - a.spend || a.cpa - b.cpa)
    .slice(0, 6);
  root.querySelector("#material-top-list").innerHTML = top.map((item, index) => `<button class="top-material-row" type="button" data-material-key="${escapeAttribute(materialKey(item))}">
    <span class="top-material-rank">${String(index + 1).padStart(2, "0")}</span>
    <span class="top-material-copy"><strong>${escapeHtml(item.materialId)}</strong><span>${escapeHtml(item.title || "未填写视频标题")}</span></span>
    <span class="top-material-metrics"><strong>${money(item.spend)} · ${integer(item.conversions)}转化</strong><small>${escapeHtml(item.placement)} / 成本${money(item.cpa)}</small></span>
  </button>`).join("") || `<div class="empty-material-state">当前口径下暂无跑量优质或高效潜力素材</div>`;
}

function renderInsights(review) {
  const topDirection = review.directionSummaries[0];
  const efficientDirection = [...review.directionSummaries].filter((item) => item.conversions > 0).sort((a, b) => a.cpa - b.cpa)[0];
  const firstBrief = review.briefs[0];
  const items = [
    ["规模信号", topDirection ? `${topDirection.direction}贡献${percent(topDirection.spendShare)}消耗，包含${topDirection.winnerCount}条跑量优质素材。` : "当前数据不足以形成规模方向。"],
    ["效率信号", efficientDirection ? `${efficientDirection.direction}的方向成本为${money(efficientDirection.cpa)}，次留率${percent(efficientDirection.retentionRate)}，可优先验证同结构变体。` : "当前暂无有效转化方向。"],
    ["下周动作", firstBrief ? `建议先执行“${firstBrief.direction}”方向，共${firstBrief.quantity}条；素材团队按证据素材做变量测试，不直接复刻原片。` : "补充有效样本后再分配下周产能。"],
  ];
  root.querySelector("#material-insight-copy").innerHTML = items.map(([label, copy]) => `<div class="insight-item"><span>${label}</span><p>${escapeHtml(copy)}</p></div>`).join("");
}

function resetAndRenderMaterialTable() {
  state.tablePage = 1;
  renderMaterialTable();
}

function filteredMaterials() {
  if (!state.review) return;
  const query = root.querySelector("#material-search").value.trim().toLowerCase();
  const placement = root.querySelector("#material-placement-filter").value;
  const status = root.querySelector("#material-status-filter").value;
  const rank = { 跑量优质: 0, 高效潜力: 1, 跑量待优化: 2, 稳态观察: 3, 低效观察: 4, 数据不足: 5 };
  return state.review.materials.filter((item) => {
    if (placement !== "全部" && item.placement !== placement) return false;
    if (status !== "全部" && item.classification !== status) return false;
    if (!query) return true;
    return [item.materialId, item.title, item.taskName, ...(item.taskNames || [])].join(" ").toLowerCase().includes(query);
  }).sort((a, b) => (rank[a.classification] ?? 9) - (rank[b.classification] ?? 9) || b.spend - a.spend);
}

function renderMaterialTable() {
  if (!state.review) return;
  const matches = filteredMaterials();
  const page = paginateItems(matches, state.tablePage, MATERIAL_PAGE_SIZE);
  state.tablePage = page.page;
  const body = root.querySelector("#material-table-body");
  body.innerHTML = page.items.map((item) => `<tr data-material-id="${escapeAttribute(item.materialId)}">
    <td><div class="material-identity"><button type="button" class="material-id-button" data-material-key="${escapeAttribute(materialKey(item))}" aria-label="查看素材 ${escapeAttribute(item.materialId)} 详情">${escapeHtml(item.materialId)}</button><span>${escapeHtml(item.title || "未填写视频标题")}</span><small>${escapeHtml(item.taskName || item.taskNames?.[0] || "任务名称未匹配")}</small></div></td>
    <td>${escapeHtml(item.placement)}</td><td class="metric">${money(item.spend)}</td><td class="metric">${integer(item.conversions)}</td><td class="metric">${money(item.cpa)}</td><td class="metric">${materialRetention(item)}</td>
    <td>${escapeHtml(item.direction)}</td><td><span class="material-status ${statusClass(item.classification)}">${escapeHtml(item.classification)}</span></td>
  </tr>`).join("");
  if (!page.items.length) body.innerHTML = `<tr><td colspan="8"><div class="empty-material-state">没有符合当前筛选条件的素材</div></td></tr>`;
  root.querySelector("#material-table-count").textContent = `当前筛选共${integer(page.totalItems)}条`;
  renderMaterialPagination(page);
}

function renderMaterialPagination(page) {
  const pagination = root.querySelector("#material-pagination");
  pagination.classList.toggle("hidden", page.totalItems <= MATERIAL_PAGE_SIZE);
  root.querySelector("#material-page-range").textContent = page.totalItems ? `${integer(page.startIndex + 1)}-${integer(page.endIndex)}` : "0-0";
  root.querySelector("#material-page-total").textContent = `共${integer(page.totalItems)}条 · 每页${MATERIAL_PAGE_SIZE}条`;
  const previous = root.querySelector("#material-page-prev");
  const next = root.querySelector("#material-page-next");
  previous.disabled = page.page <= 1;
  next.disabled = page.page >= page.totalPages;
  root.querySelector("#material-page-numbers").innerHTML = paginationTokens(page.page, page.totalPages).map((token) => token === "ellipsis"
    ? `<span class="material-page-ellipsis" aria-hidden="true">…</span>`
    : `<button type="button" data-material-page="${token}" ${token === page.page ? 'class="active" aria-current="page"' : ""}>${token}</button>`).join("");
}

function setMaterialPage(requestedPage) {
  if (!state.review) return;
  const page = paginateItems(filteredMaterials(), requestedPage, MATERIAL_PAGE_SIZE);
  if (page.page === state.tablePage && requestedPage === state.tablePage) return;
  state.tablePage = page.page;
  renderMaterialTable();
  root.querySelector(".material-table-wrap").scrollTop = 0;
}

function renderBriefs(briefs) {
  const total = briefs.reduce((sum, item) => sum + item.quantity, 0);
  root.querySelector("#material-brief-capacity").innerHTML = `<span>下周建议总产能</span><strong>${integer(total)} 条</strong>`;
  root.querySelector("#material-brief-list").innerHTML = briefs.map((item, index) => `<article class="brief-card">
    <div class="brief-card-head"><span class="brief-number">${String(index + 1).padStart(2, "0")}</span><div class="brief-title"><span>${escapeHtml(item.strategy)} · ${escapeHtml(item.priority)}</span><h5>${escapeHtml(item.direction)}</h5></div><div class="brief-quantity"><strong>${integer(item.quantity)}</strong><span>建议条数</span></div></div>
    ${briefSupplierPlan(item.supplierAllocation)}
    <div class="brief-body"><div class="brief-field"><span>目标人群</span><p>${escapeHtml(item.audience)}</p></div><div class="brief-field"><span>开场钩子</span><p>${escapeHtml(item.hook)}</p></div><div class="brief-field"><span>内容结构</span><p>${escapeHtml(item.structure)}</p></div><div class="brief-field"><span>本轮变量</span><p>${escapeHtml(item.tests)}</p></div></div>
    <div class="brief-evidence"><span>数据依据</span><p>${escapeHtml(item.evidence)}${item.referenceIds?.length ? `；参考素材 ${item.referenceIds.map(escapeHtml).join("、")}` : ""}</p></div>
  </article>`).join("") || `<div class="material-section empty-material-state">当前有效素材不足，暂未生成下周创意Brief。</div>`;
}

function renderSupplierPlan(plan) {
  const container = root.querySelector("#material-supplier-plan");
  if (!plan?.directions?.length) {
    container.innerHTML = `<div class="empty-material-state">暂无可分配的下周产能</div>`;
    return;
  }
  const [youju, heye] = plan.suppliers;
  const rows = plan.directions.map((item) => {
    const [left, right] = item.allocation;
    return `<article class="supplier-direction-row">
      <div class="supplier-direction-title"><strong>${escapeHtml(item.direction)}</strong><span>${integer(item.quantity)}条 · ${escapeHtml(item.confidence)}置信度${item.usesFallback ? " · 全盘参考" : ""}</span></div>
      <div class="supplier-stack" role="img" aria-label="${escapeAttribute(`${item.direction}：优矩${left.quantity}条，禾也/禾悦${right.quantity}条`)}"><span class="is-youju" style="width:${(left.share * 100).toFixed(2)}%"></span><span class="is-heye" style="width:${(right.share * 100).toFixed(2)}%"></span></div>
      <div class="supplier-row-values"><span><i class="is-youju"></i>优矩 <strong>${integer(left.quantity)}</strong></span><span><i class="is-heye"></i>禾也/禾悦 <strong>${integer(right.quantity)}</strong></span></div>
      <p>${escapeHtml(item.reason)}</p>
    </article>`;
  }).join("");
  container.innerHTML = `<div class="supplier-overall">
    <div class="supplier-overall-copy"><strong>${integer(plan.totalCapacity)}条产能建议</strong><span>优矩${integer(youju.quantity)}条 · 禾也/禾悦${integer(heye.quantity)}条</span></div>
    <div class="supplier-stack supplier-stack-overall" role="img" aria-label="总产能：优矩${integer(youju.quantity)}条，禾也/禾悦${integer(heye.quantity)}条"><span class="is-youju" style="width:${(youju.share * 100).toFixed(2)}%"></span><span class="is-heye" style="width:${(heye.share * 100).toFixed(2)}%"></span></div>
    <div class="supplier-overall-metrics"><span><i class="is-youju"></i><b>优矩 ${percent(youju.share)}</b><small>${integer(youju.materialCount)}条样本 · 成本${money(youju.cpa)}</small></span><span><i class="is-heye"></i><b>禾也/禾悦 ${percent(heye.share)}</b><small>${integer(heye.materialCount)}条样本 · 成本${money(heye.cpa)}</small></span></div>
    <div class="supplier-scope-note">排除${integer(plan.excludedOriginalPriceCount)}条客户共享一口价原素材（${money(plan.excludedOriginalPriceSpend)}）；保留${integer(plan.retainedSecondEditCount)}条一口价二剪。${plan.unresolvedCount || plan.mixedCount ? `另有${integer(plan.unresolvedCount)}条待识别、${integer(plan.mixedCount)}条混合归因，不强行分给任一家。` : ""}</div>
  </div><div class="supplier-direction-list">${rows}</div>`;
}

function briefSupplierPlan(plan) {
  if (!plan?.allocation?.length) return "";
  const [youju, heye] = plan.allocation;
  return `<div class="brief-supplier-plan"><div class="brief-supplier-head"><span>产能分工 · ${escapeHtml(plan.confidence)}置信度</span><strong>优矩 ${integer(youju.quantity)} · 禾也/禾悦 ${integer(heye.quantity)}</strong></div><div class="supplier-stack" role="img" aria-label="优矩${integer(youju.quantity)}条，禾也/禾悦${integer(heye.quantity)}条"><span class="is-youju" style="width:${(youju.share * 100).toFixed(2)}%"></span><span class="is-heye" style="width:${(heye.share * 100).toFixed(2)}%"></span></div><p>${escapeHtml(plan.reason)}</p></div>`;
}

function handleMaterialClick(event) {
  const target = event.target.closest("[data-material-key]");
  if (!target) return;
  const material = state.materialByKey.get(target.dataset.materialKey);
  if (material) showMaterialDetail(material);
}

function showMaterialDetail(item) {
  document.querySelector("#material-detail-id").textContent = `${item.placement} · ${item.materialId}`;
  document.querySelector("#material-detail-body").innerHTML = `<div class="detail-metrics"><div><span>消耗</span><strong>${money(item.spend)}</strong></div><div><span>转化数</span><strong>${integer(item.conversions)}</strong></div><div><span>转化成本</span><strong>${money(item.cpa)}</strong></div><div><span>次留率</span><strong>${materialRetention(item)}</strong></div></div>
    <div class="detail-block"><span>视频标题</span><p>${escapeHtml(item.title || "未填写")}</p></div>
    <div class="detail-block"><span>智能归纳</span><div class="detail-tags"><i>${escapeHtml(item.classification)}</i><i>${escapeHtml(item.direction)}</i><i>${escapeHtml(item.hookType)}</i>${(item.hashtags || []).slice(0, 6).map((tag) => `<i>${escapeHtml(tag)}</i>`).join("")}</div><p>${escapeHtml(item.evidence)}</p></div>
    <div class="detail-block"><span>任务与归因</span><p>${escapeHtml((item.taskNames || [item.taskName]).filter(Boolean).join("；") || "任务名称未匹配")}<br>服务商：${escapeHtml(item.supplierGroup)}（${escapeHtml(item.supplierConfidence)}置信度）· ${escapeHtml(item.priceType)}<br>${escapeHtml(item.supplierEvidence || "暂无服务商证据")}<br>已合并${integer(item.sourceRows || 1)}条原始记录。</p></div>
    <div class="detail-block"><span>推断说明</span><p>内容方向和钩子类型来自标题与标签语义；当前没有读取视频画面，因此不把它作为前三秒镜头或口播结论。</p></div>`;
  const link = document.querySelector("#material-detail-link");
  link.href = item.videoUrl || "#";
  link.classList.toggle("hidden", !item.videoUrl);
  detailDialog.showModal();
}

function selectTab(tab) {
  root.querySelectorAll("[data-material-tab]").forEach((button) => {
    const active = button.dataset.materialTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  root.querySelectorAll("[data-material-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.materialPanel !== tab));
}

async function copyBrief() {
  if (!state.review) return;
  const lines = [`${state.dataset.weekLabel} 抖音精选素材周度复盘`, `下周建议总产能：${state.review.briefs.reduce((sum, item) => sum + item.quantity, 0)}条`, ""];
  const [youju, heye] = state.review.supplierPlan.suppliers;
  lines.push(`供应商总分配：优矩${youju.quantity}条，禾也/禾悦${heye.quantity}条`, `口径：排除${state.review.supplierPlan.excludedOriginalPriceCount}条客户共享一口价原素材，保留${state.review.supplierPlan.retainedSecondEditCount}条一口价二剪。`, "");
  state.review.briefs.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.direction}｜${item.quantity}条｜${item.strategy}`);
    if (item.supplierAllocation) {
      const [left, right] = item.supplierAllocation.allocation;
      lines.push(`产能分工：优矩${left.quantity}条，禾也/禾悦${right.quantity}条（${item.supplierAllocation.confidence}置信度）`);
      lines.push(`分配依据：${item.supplierAllocation.reason}`);
    }
    lines.push(`目标人群：${item.audience}`);
    lines.push(`开场钩子：${item.hook}`);
    lines.push(`内容结构：${item.structure}`);
    lines.push(`本轮变量：${item.tests}`);
    lines.push(`数据依据：${item.evidence}${item.referenceIds?.length ? `；参考素材 ${item.referenceIds.join("、")}` : ""}`, "");
  });
  const text = lines.join("\n");
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
    toast("下周创意Brief已复制");
  } catch {
    toast(fallbackCopy(text) ? "下周创意Brief已复制" : "复制失败，请检查浏览器剪贴板权限");
  }
}

function downloadMaterialCsv() {
  if (!state.review) return;
  const headers = ["素材ID", "版位", "视频标题", "视频链接", "消耗", "转化数", "转化成本", "次留率", "内容方向", "钩子类型", "服务商分组", "归因置信度", "归因依据", "一口价口径", "周度结论", "判断依据"];
  const rows = state.review.materials.map((item) => [item.materialId, item.placement, item.title, item.videoUrl, item.spend, item.conversions, item.cpa, item.retentionRate, item.direction, item.hookType, item.supplierGroup, item.supplierConfidence, item.supplierEvidence, item.priceType, item.classification, item.evidence]);
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${state.dataset.weekLabel.replace(/\s/g, "")}-抖音精选素材复盘.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("素材清单已导出");
}

function clearMaterialFile() {
  state.file = null;
  state.dataset = null;
  state.review = null;
  state.materialByKey.clear();
  state.tablePage = 1;
  state.chartPlacement = "全部";
  root.querySelector("#material-chart-placement").value = "全部";
  fileSlot.classList.remove("ready");
  fileState.textContent = "未选择";
  fileSlot.querySelector(".file-select").textContent = "选择文件";
  clearFileButton.disabled = true;
  clearAllButton.disabled = true;
  generateButton.disabled = true;
  uploadSummary.textContent = "等待上传1个Excel文件";
  validation.classList.add("hidden");
  results.classList.add("hidden");
}

function statusClass(status) {
  if (status === "跑量优质") return "is-winner";
  if (status === "高效潜力") return "is-potential";
  if (status === "跑量待优化") return "is-optimize";
  if (status === "低效观察") return "is-risk";
  return "is-neutral";
}

function materialKey(item) { return `${item.placement}||${item.materialId}`; }
function positiveOrNull(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : null; }
function nonnegative(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback; }
function money(value) { return Number.isFinite(value) ? `¥${Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}` : "--"; }
function compactMoney(value) { const number = Number(value); if (!Number.isFinite(number)) return "--"; return number >= 10000 ? `¥${(number / 10000).toFixed(number >= 1000000 ? 0 : 1)}万` : money(number); }
function integer(value) { return Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 }); }
function percent(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "--"; }
function materialRetention(item) { return item.retentionAnomaly ? `异常 ${percent(item.retentionRate)}` : percent(item.retentionRate); }
function formatFileSize(bytes) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`; }
function csvCell(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function nextFrame() { return new Promise((resolve) => requestAnimationFrame(() => resolve())); }
function fallbackCopy(text) { const area = document.createElement("textarea"); area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0"; document.body.append(area); area.select(); const copied = document.execCommand("copy"); area.remove(); return copied; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char])); }
function escapeAttribute(value) { return escapeHtml(value).replace(/'/g, "&#39;"); }
function chartStatusColor(status) { return ({ 跑量优质: "#176b50", 高效潜力: "#2f6f9f", 跑量待优化: "#c18a2f", 低效观察: "#a65349" })[status] || "#7d8883"; }
function toast(message, duration = 2600) { const element = document.querySelector("#toast"); element.textContent = message; element.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove("show"), duration); }
