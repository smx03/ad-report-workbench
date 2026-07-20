import { generateDailyReport } from "./report-engine.js?v=20260720-3";
import { REPORT_CONFIG } from "./report-config.js?v=20260720-3";
import { readWorkbookRows } from "./spreadsheet-reader.js?v=20260720-3";

const REQUIRED_FILES = ["current", "previous", "sevenDay", "mapping"];
const HISTORY_KEY = "doubao-report-retention-history-v1";
const state = { files: {}, report: null, baseNarrative: "" };
const fileSlots = [...document.querySelectorAll("#daily-page .file-slot[data-key]")];
const generateButton = document.querySelector("#generate");
const uploadSummary = document.querySelector("#upload-summary");
const validation = document.querySelector("#validation");
const results = document.querySelector("#results");
const narrative = document.querySelector("#narrative");
const reportDateInput = document.querySelector("#report-date");
const clearAllFilesButton = document.querySelector("#clear-all-files");

reportDateInput.value = shiftDate(localIsoDate(), -1);
updateDateHints();
updateReadyState();

reportDateInput.addEventListener("change", () => {
  updateDateHints();
  invalidateResult("日报日期已更新，请上传对应日期文件后重新生成。");
});

fileSlots.forEach((slot) => {
  const input = slot.querySelector("input");
  const selectButton = slot.querySelector(".file-select");
  input.addEventListener("change", () => {
    const file = input.files[0];
    if (!file) return;
    const key = slot.dataset.key;
    state.files[key] = file;
    slot.classList.add("ready");
    slot.querySelector(".file-state").textContent = file.name;
    slot.querySelector(".file-clear").disabled = false;
    selectButton.textContent = "替换文件";
    input.value = "";
    updateReadyState();
    invalidateResult();
  });
});

document.querySelectorAll("#daily-page .file-clear[data-clear]").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearFile(button.dataset.clear);
  });
});

clearAllFilesButton.addEventListener("click", () => {
  for (const key of Object.keys(state.files)) resetFileSlot(key);
  state.files = {};
  updateReadyState();
  invalidateResult("本次上传文件已全部清空。");
});

document.querySelector("#load-sample").addEventListener("click", () => {
  const date = reportDateInput.value;
  toast(`请上传${displayShortDate(date)}、${displayShortDate(shiftDate(date, -1))}、${displayShortDate(shiftDate(date, -7))}三份全部账户数据，以及一份最新账户匹配表。`, 5200);
});

generateButton.addEventListener("click", generate);
document.querySelector("#action-tags").addEventListener("change", updateNarrative);
document.querySelector("#copy-narrative").addEventListener("click", () => copyText(narrative.value, "日报文案已复制"));
document.querySelectorAll("[data-download]").forEach((button) => button.addEventListener("click", () => downloadReport(button.dataset.download, button)));
document.querySelector("#download-all").addEventListener("click", downloadAllReports);

async function generate() {
  const original = generateButton.innerHTML;
  generateButton.disabled = true;
  generateButton.textContent = "正在本地读取与校验";
  validation.className = "validation-band";
  validation.innerHTML = `<div class="spinner">↻</div><div><strong>正在本机读取四份Excel</strong><span>校验账户范围，自动按账户ID合并三日数据…</span></div>`;
  try {
    const [current, previous, sevenDay, mapping] = await Promise.all(REQUIRED_FILES.map(async (key) => {
      const file = state.files[key];
      if (!file) throw new Error("请先上传完整的四份Excel文件。");
      return readWorkbookRows(await file.arrayBuffer());
    }));
    const reportDate = reportDateInput.value;
    const historyStore = readHistory();
    const data = generateDailyReport({
      current,
      previous,
      sevenDay,
      mapping,
      reportDate,
      history: historyStore[shiftDate(reportDate, -1)] ?? {},
      config: REPORT_CONFIG,
    });
    state.report = data;
    renderValidation(data);
    if (!data.validation.ok) {
      results.classList.add("hidden");
      return;
    }
    historyStore[reportDate] = { retentionByRow: data.retentionByRow };
    writeHistory(historyStore);
    renderReport("pull", data.pull);
    renderReport("unload", data.unload);
    document.querySelector("#result-date").textContent = formatDate(data.reportDate);
    state.baseNarrative = data.narrative;
    updateNarrative();
    results.classList.remove("hidden");
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    validation.className = "validation-band error";
    validation.innerHTML = `<div>!</div><div><strong>生成失败</strong><span>${escapeHtml(error.message || "请检查Excel文件")}</span></div>`;
    results.classList.add("hidden");
  } finally {
    generateButton.innerHTML = original;
    updateReadyState();
  }
}

function renderValidation(data) {
  const errors = data.validation.warnings.filter((item) => item.level === "error");
  const warnings = data.validation.warnings.filter((item) => item.level !== "error");
  if (errors.length) {
    validation.className = "validation-band error";
    validation.innerHTML = `<div>!</div><div><strong>校验未通过</strong><span>${errors.map((item) => escapeHtml(item.message)).join("")}</span></div>`;
    return;
  }
  validation.className = "validation-band success";
  validation.innerHTML = `<div>✓</div><div><strong>校验通过：已读取${data.stats.accountUniverseAccounts}个账户，${data.stats.matchedAccounts}个已匹配</strong><span>${warnings.length ? warnings.map((item) => escapeHtml(item.message)).join("；") : "四份表格的表头、账户ID与匹配关系正常；Excel数据未上传。"}</span></div>`;
}

function renderReport(kind, report) {
  const container = document.querySelector(`#${kind}-report`);
  const date = formatDate(state.report.reportDate);
  const rows = report.rows;
  const spans = computeSpans(rows);
  const headers = ["日期", report.title, "版位", "版位", "账面消耗", "折后消耗", "量级", "量级环比", "账面成本", "折后成本", "成本环比", "次留", "次留环比", "完整7留", "点击率", "转化率"];
  let html = `<table class="daily-report ${kind}" data-report="${kind}"><colgroup><col style="width:108px"><col style="width:105px"><col style="width:106px"><col style="width:106px">${"<col style=\"width:105px\">".repeat(12)}</colgroup><thead><tr>${headers.map((header, index) => `<th class="${index === 1 ? "report-kind" : ""}">${header}</th>`).join("")}</tr></thead><tbody>`;
  rows.forEach((row, index) => {
    html += `<tr class="${row.style}">`;
    if (index === 0) html += `<td class="date" rowspan="${rows.length}">${date}</td>`;
    if (spans.channel[index]) html += `<td class="channel" rowspan="${spans.channel[index]}">${row.channel || ""}</td>`;
    if (spans.device[index]) html += `<td class="device" rowspan="${spans.device[index]}">${row.device || ""}</td>`;
    html += `<td class="assessment">${row.assessment}</td>${metricCells(row.metrics)}</tr>`;
  });
  container.innerHTML = `${html}</tbody></table>`;
}

function computeSpans(rows) {
  const channel = {};
  const device = {};
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (["overall", "channel-total"].includes(row.style)) {
      channel[index] = 1;
      device[index] = 1;
      index += 1;
      continue;
    }
    let channelEnd = index;
    while (channelEnd + 1 < rows.length && rows[channelEnd + 1].channel === row.channel && rows[channelEnd + 1].style !== "overall") channelEnd += 1;
    channel[index] = channelEnd - index + 1;
    let cursor = index;
    while (cursor <= channelEnd) {
      const deviceValue = rows[cursor].device;
      let deviceEnd = cursor;
      while (deviceEnd + 1 <= channelEnd && rows[deviceEnd + 1].device === deviceValue) deviceEnd += 1;
      device[cursor] = deviceEnd - cursor + 1;
      cursor = deviceEnd + 1;
    }
    index = channelEnd + 1;
  }
  return { channel, device };
}

function metricCells(metrics) {
  return [
    money(metrics.spend), money(metrics.discountedSpend), integer(metrics.volume), percent(metrics.volumeChange),
    money(metrics.bookCost), money(metrics.discountedCost), percent(metrics.costChange), percent(metrics.retention),
    percent(metrics.retentionChange), percent(metrics.sevenRetention), percent(metrics.ctr), percent(metrics.conversion),
  ].map((value) => `<td>${value}</td>`).join("");
}

function updateNarrative() {
  const actions = [...document.querySelectorAll("#action-tags input:checked")].map((input) => input.value);
  narrative.value = actions.length ? `${state.baseNarrative}操作上，${actions.join("，")}。` : state.baseNarrative;
}

async function downloadReport(kind, button, silent = false) {
  if (!state.report) {
    toast("请先生成日报");
    return false;
  }
  const original = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.textContent = "生成图片中";
  }
  try {
    const table = document.querySelector(`[data-report="${kind}"]`);
    if (!table) throw new Error("未找到日报表格");
    const blob = await tableToPng(table);
    const reportTitle = state.report[kind]?.title || (kind === "pull" ? "拉新" : "卸载");
    saveBlob(blob, `${state.report.reportDate}-${reportTitle}日报.png`);
    if (!silent) toast(`${reportTitle}日报图片已下载`);
    return true;
  } catch (error) {
    toast(`下载失败：${error.message || "请重试"}`, 3800);
    return false;
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
}

async function downloadAllReports(event) {
  const button = event.currentTarget;
  if (!state.report) return toast("请先生成日报");
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = "正在下载 1/2";
  const pullOk = await downloadReport("pull", null, true);
  button.textContent = "正在下载 2/2";
  const unloadOk = await downloadReport("unload", null, true);
  button.disabled = false;
  button.innerHTML = original;
  if (pullOk && unloadOk) toast("两张日报图片已下载");
}

async function tableToPng(table) {
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
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG生成失败")), "image/png"));
}

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

function updateReadyState() {
  const count = REQUIRED_FILES.filter((key) => state.files[key]).length;
  uploadSummary.textContent = count === REQUIRED_FILES.length ? "4个Excel文件已就绪，数据将在本机处理" : `已上传${count}/4个Excel文件`;
  generateButton.disabled = count !== REQUIRED_FILES.length;
  clearAllFilesButton.disabled = count === 0;
}

function clearFile(key) {
  delete state.files[key];
  resetFileSlot(key);
  updateReadyState();
  invalidateResult("文件已删除，可重新选择文件。");
}

function resetFileSlot(key) {
  const slot = document.querySelector(`.file-slot[data-key="${key}"]`);
  if (!slot) return;
  slot.classList.remove("ready");
  slot.querySelector(".file-state").textContent = "未选择";
  slot.querySelector(".file-select").textContent = "选择文件";
  slot.querySelector(".file-clear").disabled = true;
  slot.querySelector("input").value = "";
}

function invalidateResult(message = "") {
  if (state.report) {
    state.report = null;
    results.classList.add("hidden");
    validation.classList.add("hidden");
  }
  if (message) toast(message, 3200);
}

function readHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeHistory(value) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(value));
  } catch {
    // History only affects retention comparison; report generation remains available.
  }
}

function updateDateHints() {
  const date = reportDateInput.value;
  if (!date) return;
  document.querySelector('[data-date-hint="current"]').textContent = `${displayShortDate(date)}基础数据`;
  document.querySelector('[data-date-hint="previous"]').textContent = `${displayShortDate(shiftDate(date, -1))}激活与次留`;
  document.querySelector('[data-date-hint="sevenDay"]').textContent = `${displayShortDate(shiftDate(date, -7))}激活与7日留存`;
}

function localIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function shiftDate(dateText, days) {
  const date = new Date(`${dateText}T12:00:00`);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function displayShortDate(dateText) {
  const [, month, day] = dateText.split("-").map(Number);
  return `${month}月${day}日`;
}

function transparent(color) { return !color || color === "transparent" || color === "rgba(0, 0, 0, 0)"; }
function money(value) { return Number.isFinite(value) ? value.toFixed(2) : "#DIV/0!"; }
function integer(value) { return Number.isFinite(value) ? Math.round(value).toString() : "#DIV/0!"; }
function percent(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "#DIV/0!"; }
function formatDate(value) { const [year, month, day] = value.split("-").map(Number); return `${year}/${month}/${day}`; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }

async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    toast(message);
  } catch {
    narrative.focus();
    narrative.select();
    toast(document.execCommand("copy") ? message : "浏览器未允许自动复制，文案已全选。", 4200);
  }
}

function toast(message, duration = 2200) {
  const element = document.querySelector("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), duration);
}
