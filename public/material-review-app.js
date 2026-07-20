import { buildMaterialReview } from "./material-review-engine.js?v=20260720-1";
import { readMaterialWorkbook } from "./material-review-reader.js?v=20260720-1";

const root = document.querySelector("#weekly-material-page");
const state = { file: null, dataset: null, review: null, materialByKey: new Map() };
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

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  state.file = file;
  state.dataset = null;
  state.review = null;
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
    rebuildReview();
    renderReview();
  });
}

root.querySelector("#material-search").addEventListener("input", renderMaterialTable);
root.querySelector("#material-placement-filter").addEventListener("change", renderMaterialTable);
root.querySelector("#material-status-filter").addEventListener("change", renderMaterialTable);
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
    validation.className = "validation-band success";
    const warnings = state.review.warnings.length ? ` 数据提示：${state.review.warnings.map(escapeHtml).join(" ")}` : "";
    validation.innerHTML = `<div>✓</div><div><strong>读取完成：${integer(sourceRows)}行已聚合为${integer(materialCount)}条版位素材</strong><span>已识别${state.dataset.sourceSheets.map((sheet) => `${escapeHtml(sheet.placement)} ${integer(sheet.rowCount)}行`).join("、")}；重复素材已按版位和素材ID合并。${warnings}</span></div>`;
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
  renderDirections(review.directionSummaries);
  renderTopMaterials(review.materials);
  renderInsights(review);
  renderMaterialTable();
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

function renderMaterialTable() {
  if (!state.review) return;
  const query = root.querySelector("#material-search").value.trim().toLowerCase();
  const placement = root.querySelector("#material-placement-filter").value;
  const status = root.querySelector("#material-status-filter").value;
  const rank = { 跑量优质: 0, 高效潜力: 1, 跑量待优化: 2, 稳态观察: 3, 低效观察: 4, 数据不足: 5 };
  const matches = state.review.materials.filter((item) => {
    if (placement !== "全部" && item.placement !== placement) return false;
    if (status !== "全部" && item.classification !== status) return false;
    if (!query) return true;
    return [item.materialId, item.title, item.taskName, ...(item.taskNames || [])].join(" ").toLowerCase().includes(query);
  }).sort((a, b) => (rank[a.classification] ?? 9) - (rank[b.classification] ?? 9) || b.spend - a.spend);

  const visible = matches.slice(0, 500);
  const body = root.querySelector("#material-table-body");
  body.innerHTML = visible.map((item) => `<tr data-material-id="${escapeAttribute(item.materialId)}" data-material-key="${escapeAttribute(materialKey(item))}">
    <td><div class="material-identity"><strong>${escapeHtml(item.materialId)}</strong><span title="${escapeAttribute(item.title)}">${escapeHtml(item.title || "未填写视频标题")}</span><small>${escapeHtml(item.taskName || item.taskNames?.[0] || "任务名称未匹配")}</small></div></td>
    <td>${escapeHtml(item.placement)}</td><td class="metric">${money(item.spend)}</td><td class="metric">${integer(item.conversions)}</td><td class="metric">${money(item.cpa)}</td><td class="metric">${materialRetention(item)}</td>
    <td>${escapeHtml(item.direction)}</td><td><span class="material-status ${statusClass(item.classification)}">${escapeHtml(item.classification)}</span></td>
  </tr>`).join("");
  if (!visible.length) body.innerHTML = `<tr><td colspan="8"><div class="empty-material-state">没有符合当前筛选条件的素材</div></td></tr>`;
  if (matches.length > visible.length) body.insertAdjacentHTML("beforeend", `<tr><td colspan="8"><div class="empty-material-state">已显示前${visible.length}条，继续输入素材ID或标题可精确查找其余${integer(matches.length - visible.length)}条</div></td></tr>`);
}

function renderBriefs(briefs) {
  const total = briefs.reduce((sum, item) => sum + item.quantity, 0);
  root.querySelector("#material-brief-capacity").innerHTML = `<span>下周建议总产能</span><strong>${integer(total)} 条</strong>`;
  root.querySelector("#material-brief-list").innerHTML = briefs.map((item, index) => `<article class="brief-card">
    <div class="brief-card-head"><span class="brief-number">${String(index + 1).padStart(2, "0")}</span><div class="brief-title"><span>${escapeHtml(item.strategy)} · ${escapeHtml(item.priority)}</span><h5>${escapeHtml(item.direction)}</h5></div><div class="brief-quantity"><strong>${integer(item.quantity)}</strong><span>建议条数</span></div></div>
    <div class="brief-body"><div class="brief-field"><span>目标人群</span><p>${escapeHtml(item.audience)}</p></div><div class="brief-field"><span>开场钩子</span><p>${escapeHtml(item.hook)}</p></div><div class="brief-field"><span>内容结构</span><p>${escapeHtml(item.structure)}</p></div><div class="brief-field"><span>本轮变量</span><p>${escapeHtml(item.tests)}</p></div></div>
    <div class="brief-evidence"><span>数据依据</span><p>${escapeHtml(item.evidence)}${item.referenceIds?.length ? `；参考素材 ${item.referenceIds.map(escapeHtml).join("、")}` : ""}</p></div>
  </article>`).join("") || `<div class="material-section empty-material-state">当前有效素材不足，暂未生成下周创意Brief。</div>`;
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
    <div class="detail-block"><span>任务与归因</span><p>${escapeHtml((item.taskNames || [item.taskName]).filter(Boolean).join("；") || "任务名称未匹配")}<br>已合并${integer(item.sourceRows || 1)}条原始记录。</p></div>
    <div class="detail-block"><span>推断说明</span><p>内容方向和钩子类型来自标题与标签语义；当前没有读取视频画面，因此不把它作为前三秒镜头或口播结论。</p></div>`;
  const link = document.querySelector("#material-detail-link");
  link.href = item.videoUrl || "#";
  link.classList.toggle("hidden", !item.videoUrl);
  detailDialog.showModal();
}

function selectTab(tab) {
  root.querySelectorAll("[data-material-tab]").forEach((button) => button.classList.toggle("active", button.dataset.materialTab === tab));
  root.querySelectorAll("[data-material-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.materialPanel !== tab));
}

async function copyBrief() {
  if (!state.review) return;
  const lines = [`${state.dataset.weekLabel} 抖音精选素材周度复盘`, `下周建议总产能：${state.review.briefs.reduce((sum, item) => sum + item.quantity, 0)}条`, ""];
  state.review.briefs.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.direction}｜${item.quantity}条｜${item.strategy}`);
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
  const headers = ["素材ID", "版位", "视频标题", "视频链接", "消耗", "转化数", "转化成本", "次留率", "内容方向", "钩子类型", "周度结论", "判断依据"];
  const rows = state.review.materials.map((item) => [item.materialId, item.placement, item.title, item.videoUrl, item.spend, item.conversions, item.cpa, item.retentionRate, item.direction, item.hookType, item.classification, item.evidence]);
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
function integer(value) { return Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 }); }
function percent(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "--"; }
function materialRetention(item) { return item.retentionAnomaly ? `异常 ${percent(item.retentionRate)}` : percent(item.retentionRate); }
function formatFileSize(bytes) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`; }
function csvCell(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function nextFrame() { return new Promise((resolve) => requestAnimationFrame(() => resolve())); }
function fallbackCopy(text) { const area = document.createElement("textarea"); area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0"; document.body.append(area); area.select(); const copied = document.execCommand("copy"); area.remove(); return copied; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char])); }
function escapeAttribute(value) { return escapeHtml(value).replace(/'/g, "&#39;"); }
function toast(message, duration = 2600) { const element = document.querySelector("#toast"); element.textContent = message; element.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove("show"), duration); }
