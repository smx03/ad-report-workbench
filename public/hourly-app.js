import { assertHourlyHeaders, availableHourlyDates, buildHourlyReports } from "./hourly-engine.js?v=20260723-2";
import { extractHourlyHistory, findComparisonSnapshot, historyKey, reportBatchForHour, snapshotFromReport } from "./hourly-history.js?v=20260723-2";
import { renderHourlyTargetDashboard } from "./hourly-target-view.js?v=20260723-1";

const HISTORY_KEY = "doubao-hourly-snapshots-v2";
const state = { file: null, rows: [], report: null, history: readHistory() };
const input = document.querySelector("#hourly-file");
const slot = document.querySelector("#hourly-file-slot");
const dateInput = document.querySelector("#hourly-date");
const hourSelect = document.querySelector("#hourly-hour");
const generateButton = document.querySelector("#generate-hourly");
const validation = document.querySelector("#hourly-validation");
const results = document.querySelector("#hourly-results");
const historyInput = document.querySelector("#hourly-history-file");

input.addEventListener("change", readWorkbook);
historyInput.addEventListener("change", readHistoryWorkbook);
document.querySelector("#clear-hourly-file").addEventListener("click", clearFile);
document.querySelector("#clear-hourly-history").addEventListener("click", clearHistory);
generateButton.addEventListener("click", generate);
document.querySelector("#download-all-hourly").addEventListener("click", downloadAll);
document.querySelectorAll("[data-hourly-download]").forEach((button) => button.addEventListener("click", () => downloadReport(button.dataset.hourlyDownload, button)));
renderHistoryStatus();

async function readWorkbook() {
  const file = input.files[0];
  if (!file) return;
  const label = slot.querySelector(".file-select");
  state.file = null;
  state.rows = [];
  state.report = null;
  generateButton.disabled = true;
  results.classList.add("hidden");
  slot.classList.remove("ready");
  slot.querySelector(".file-state").textContent = file.name;
  slot.querySelector("#clear-hourly-file").disabled = false;
  document.querySelector("#hourly-upload-summary").textContent = "正在读取并校验Excel，请稍候…";
  label.textContent = "正在读取";
  label.classList.add("loading");
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheet = findHourlySourceSheet(workbook);
    if (!sheet) throw new Error("Excel中未找到“分时源数据”或包含时报必需表头的工作表");
    const headers = readHeaders(sheet);
    assertHourlyHeaders(headers);
    const columns = uniqueHeaderColumns(headers);
    const rows = [];
    sheet.eachRow((row, index) => {
      if (index === 1) return;
      const record = Object.fromEntries(columns.map(({ header, column }) => [header, unwrap(row.getCell(column).value)]));
      if (Object.values(record).some((value) => value !== null && value !== "")) rows.push(record);
    });
    const dates = availableHourlyDates(rows);
    if (dates.length < 2) throw new Error("源表至少需要包含今天和昨天两天数据");
    state.file = file;
    state.rows = rows;
    dateInput.value = dates.at(-1);
    dateInput.min = dates[0];
    dateInput.max = dates.at(-1);
    slot.classList.add("ready");
    slot.querySelector(".file-state").textContent = file.name;
    slot.querySelector("#clear-hourly-file").disabled = false;
    document.querySelector("#hourly-upload-summary").textContent = `已读取${rows.length.toLocaleString("zh-CN")}行 · ${dates.length}个日期 · 数据仅在本机浏览器处理`;
    generateButton.disabled = false;
    label.textContent = "替换文件";
    resetResult();
  } catch (error) {
    state.file = null;
    state.rows = [];
    slot.classList.remove("ready");
    slot.querySelector(".file-state").textContent = "读取失败，请重新选择";
    slot.querySelector("#clear-hourly-file").disabled = false;
    document.querySelector("#hourly-upload-summary").textContent = "文件未通过校验，无法生成时报";
    generateButton.disabled = true;
    showValidation("error", "文件读取失败", error.message);
    label.textContent = "重新选择";
  } finally {
    label.classList.remove("loading");
    input.value = "";
  }
}

function generate() {
  generateButton.disabled = true;
  try {
    const cutoffHour = Number(hourSelect.value);
    const previousDate = shiftDate(dateInput.value, -1);
    const batch = reportBatchForHour(cutoffHour);
    if (!batch) throw new Error("请选择有效的时报批次");
    const comparison = findComparisonSnapshot(state.history, previousDate, cutoffHour);
    if (!comparison) throw new Error(`${formatDate(previousDate)}缺少${batch.label}有效历史时报（${batch.comparisonHours.map((hour) => `${hour}:00`).join("或")}），请先更新历史基准。`);
    const report = buildHourlyReports(state.rows, dateInput.value, cutoffHour, comparison?.snapshot ?? null);
    state.report = report;
    state.history[historyKey(report.reportDate, report.cutoffHour)] = snapshotFromReport(report);
    writeHistory(state.history);
    renderHistoryStatus();
    renderReport("pull", report.pull);
    renderReport("unload", report.unload);
    renderHourlyTargetDashboard({
      report,
      summary: document.querySelector("#hourly-target-summary"),
      costChart: document.querySelector("#hourly-target-cost-chart"),
      retentionChart: document.querySelector("#hourly-target-retention-chart"),
      volumeChart: document.querySelector("#hourly-target-volume-chart"),
    });
    const label = `${formatDate(report.reportDate)} ${pad(report.cutoffHour)}:00`;
    document.querySelector("#hourly-result-date").textContent = label;
    document.querySelector("#hourly-pull-title").textContent = `${label} 拉新时报`;
    document.querySelector("#hourly-unload-title").textContent = `${label} 卸载时报`;
    const comparisonText = `三项环比使用${formatDate(previousDate)} ${pad(comparison.hour)}:00历史时报${comparison.exact ? "" : "（兼容旧时刻）"}。`;
    showValidation("success", "校验通过", `已读取${report.sourceRows.toLocaleString("zh-CN")}行。${comparisonText}`);
    results.classList.remove("hidden");
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    results.classList.add("hidden");
    showValidation("error", "校验未通过", error.message);
  } finally {
    generateButton.disabled = !state.file;
  }
}

async function readHistoryWorkbook() {
  const file = historyInput.files[0];
  if (!file) return;
  const slot = document.querySelector("#hourly-history-slot");
  const label = slot.querySelector(".file-select");
  label.textContent = "正在提取历史";
  label.classList.add("loading");
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const extracted = extractHourlyHistory(workbook);
    const count = Object.keys(extracted).length;
    if (!count) throw new Error("未找到可用的2606历史时报块");
    state.history = extracted;
    writeHistory(state.history);
    slot.classList.add("ready");
    slot.querySelector(".file-state").textContent = file.name;
    slot.querySelector("#clear-hourly-history").disabled = false;
    label.textContent = "更新历史基准";
    renderHistoryStatus();
    resetResult();
    toast(`已按工作簿重建${count}个历史时报快照`);
  } catch (error) {
    slot.classList.remove("ready");
    slot.querySelector(".file-state").textContent = "导入失败，请重新选择";
    label.textContent = "重新选择";
    showValidation("error", "历史基准导入失败", error.message);
  } finally {
    label.classList.remove("loading");
    historyInput.value = "";
  }
}

function clearHistory() {
  state.history = {};
  writeHistory(state.history);
  const slot = document.querySelector("#hourly-history-slot");
  slot.classList.remove("ready");
  slot.querySelector(".file-state").textContent = "尚未导入";
  slot.querySelector(".file-select").textContent = "选择历史工作簿";
  slot.querySelector("#clear-hourly-history").disabled = true;
  renderHistoryStatus();
  resetResult();
  toast("历史时报基准已清空");
}

function renderHistoryStatus() {
  const count = Object.keys(state.history).length;
  document.querySelector("#hourly-history-detail").textContent = count
    ? `浏览器已保存${count}个历史快照，生成后会自动追加本次时报。`
    : "首次使用或更换电脑时，请导入同一份《豆包时报.xlsx》重建历史基准。";
  const slot = document.querySelector("#hourly-history-slot");
  if (count) {
    slot.classList.add("ready");
    slot.querySelector(".file-state").textContent = `已保存${count}个快照`;
    slot.querySelector("#clear-hourly-history").disabled = false;
    slot.querySelector(".file-select").textContent = "更新历史基准";
  }
}

function renderReport(kind, report) {
  const headers = ["消耗", "折后消耗", "量级", "量级环比", "账面成本", "折后成本", "成本环比", "实时次留", "留存环比", "点击率", "转化率"];
  const rows = report.rows.map((row) => `<tr class="${row.style}">${renderDimensions(row)}${metricCells(row.metrics)}</tr>`).join("");
  document.querySelector(`#hourly-${kind}-report`).innerHTML = `<table class="hourly-report ${kind}"><thead><tr><th>${pad(state.report.cutoffHour)}:00</th><th colspan="2" class="report-kind">${kind === "pull" ? "拉新" : "卸载"}</th>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderDimensions(row) {
  if (row.style === "channel-total" || row.style === "overall") return `<td colspan="3">${escapeHtml(row.assessment)}</td>`;
  return `<td class="channel">${escapeHtml(row.channel)}</td><td>${escapeHtml(row.device)}</td><td>${escapeHtml(row.assessment)}</td>`;
}

function metricCells(metrics) {
  return [
    money(metrics.spend), money(metrics.discountSpend), integer(metrics.volume), percent(metrics.volumeChange), money(metrics.accountCost), money(metrics.discountCost),
    metrics.costChangeError ?? percent(metrics.costChange), percent(metrics.realtimeRetention), percent(metrics.retentionChange), percent(metrics.ctr), percent(metrics.conversionRate),
  ].map((value) => `<td>${value}</td>`).join("");
}

async function downloadReport(kind, button, silent = false) {
  if (!state.report) return false;
  if (button) button.disabled = true;
  try {
    const table = document.querySelector(`#hourly-${kind}-report table`);
    const blob = await tableToPng(table);
    saveBlob(blob, `${state.report.reportDate}-${pad(state.report.cutoffHour)}时-${kind === "pull" ? "拉新" : "卸载"}时报.png`);
    if (!silent) toast("时报图片已下载");
    return true;
  } catch (error) {
    toast(`下载失败：${error.message}`, 3500);
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

async function downloadAll() {
  const button = document.querySelector("#download-all-hourly");
  button.disabled = true;
  await downloadReport("pull", null, true);
  await new Promise((resolve) => setTimeout(resolve, 180));
  await downloadReport("unload", null, true);
  button.disabled = false;
  toast("两张时报图片已下载");
}

function clearFile() {
  state.file = null; state.rows = []; state.report = null;
  slot.classList.remove("ready");
  slot.querySelector(".file-state").textContent = "未选择";
  slot.querySelector(".file-select").textContent = "选择文件";
  slot.querySelector("#clear-hourly-file").disabled = true;
  document.querySelector("#hourly-upload-summary").textContent = "等待上传1个分时源表";
  generateButton.disabled = true;
  dateInput.value = "";
  resetResult();
}

function resetResult() { validation.classList.add("hidden"); results.classList.add("hidden"); }
function showValidation(kind, title, message) { validation.className = `validation-band ${kind}`; validation.innerHTML = `<div>${kind === "success" ? "✓" : "!"}</div><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`; }
function unwrap(value) { return value && typeof value === "object" && "result" in value ? value.result : value && typeof value === "object" && "text" in value ? value.text : value; }
function findHourlySourceSheet(workbook) {
  const named = workbook.getWorksheet("分时源数据");
  if (named) return named;
  return workbook.worksheets.find((sheet) => {
    const headers = readHeaders(sheet);
    try { assertHourlyHeaders(headers); return true; } catch { return false; }
  });
}
function readHeaders(sheet) {
  const row = sheet.getRow(1);
  return Array.from({ length: row.cellCount }, (_, index) => String(unwrap(row.getCell(index + 1).value) ?? "").trim());
}
function uniqueHeaderColumns(headers) {
  const seen = new Set();
  return headers.flatMap((header, index) => {
    if (!header || seen.has(header)) return [];
    seen.add(header);
    return [{ header, column: index + 1 }];
  });
}
function money(value) { return value == null ? "#DIV/0!" : Number(value).toFixed(2); }
function integer(value) { return Math.round(Number(value) || 0).toString(); }
function percent(value) { return value == null || !Number.isFinite(value) ? "#DIV/0!" : `${(value * 100).toFixed(2)}%`; }
function formatDate(value) { const [, month, day] = value.split("-"); return `${Number(month)}月${Number(day)}日`; }
function pad(value) { return String(value).padStart(2, "0"); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function toast(message, duration = 2200) { const node = document.querySelector("#toast"); node.textContent = message; node.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), duration); }
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function tableToPng(table) {
  await document.fonts.ready;
  const tableRect = table.getBoundingClientRect();
  const width = Math.ceil(tableRect.width);
  const height = Math.ceil(tableRect.height);
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  context.scale(scale, scale);
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  const cells = [...table.querySelectorAll("th, td")];
  for (const cell of cells) {
    const rect = cell.getBoundingClientRect();
    const style = getComputedStyle(cell);
    context.fillStyle = transparent(style.backgroundColor) ? "#ffffff" : style.backgroundColor;
    context.fillRect(rect.left - tableRect.left, rect.top - tableRect.top, rect.width, rect.height);
  }
  context.strokeStyle = "#222222";
  context.lineWidth = 1;
  for (const cell of cells) {
    const rect = cell.getBoundingClientRect();
    context.strokeRect(Math.round(rect.left - tableRect.left) + 0.5, Math.round(rect.top - tableRect.top) + 0.5, Math.max(0, Math.round(rect.width) - 1), Math.max(0, Math.round(rect.height) - 1));
  }
  for (const cell of cells) {
    const rect = cell.getBoundingClientRect();
    const style = getComputedStyle(cell);
    const text = cell.textContent.trim();
    let fontSize = Number.parseFloat(style.fontSize) || 12;
    const fontWeight = style.fontWeight || "400";
    const fontFamily = style.fontFamily || '"PingFang SC", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = style.color || "#17201d";
    context.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    const availableWidth = Math.max(8, rect.width - 10);
    while (fontSize > 8 && context.measureText(text).width > availableWidth) {
      fontSize -= 0.5;
      context.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    }
    context.fillText(text, rect.left - tableRect.left + rect.width / 2, rect.top - tableRect.top + rect.height / 2, availableWidth);
  }
  return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG生成失败")), "image/png"));
}

function transparent(color) { return !color || color === "transparent" || color === "rgba(0, 0, 0, 0)"; }
function readHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}"); } catch { return {}; } }
function writeHistory(value) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(value)); } catch { /* History import remains optional. */ } }
function shiftDate(value, days) { const date = new Date(`${value}T12:00:00`); date.setDate(date.getDate() + days); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
