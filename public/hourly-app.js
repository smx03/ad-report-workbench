import { assertHourlyHeaders, availableHourlyDates, buildHourlyReports } from "./hourly-engine.js";

const state = { file: null, rows: [], report: null };
const input = document.querySelector("#hourly-file");
const slot = document.querySelector("#hourly-file-slot");
const dateInput = document.querySelector("#hourly-date");
const hourSelect = document.querySelector("#hourly-hour");
const generateButton = document.querySelector("#generate-hourly");
const validation = document.querySelector("#hourly-validation");
const results = document.querySelector("#hourly-results");

input.addEventListener("change", readWorkbook);
document.querySelector("#clear-hourly-file").addEventListener("click", clearFile);
generateButton.addEventListener("click", generate);
document.querySelector("#download-all-hourly").addEventListener("click", downloadAll);
document.querySelectorAll("[data-hourly-download]").forEach((button) => button.addEventListener("click", () => downloadReport(button.dataset.hourlyDownload, button)));

async function readWorkbook() {
  const file = input.files[0];
  if (!file) return;
  const label = slot.querySelector(".file-select");
  label.textContent = "正在读取";
  label.classList.add("loading");
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("Excel中没有可读取的工作表");
    const headers = sheet.getRow(1).values.slice(1).map((value) => String(value ?? "").trim());
    assertHourlyHeaders(headers);
    const rows = [];
    sheet.eachRow((row, index) => {
      if (index === 1) return;
      const record = Object.fromEntries(headers.map((header, column) => [header, unwrap(row.getCell(column + 1).value)]));
      if (Object.values(record).some((value) => value !== null && value !== "")) rows.push(record);
    });
    const dates = availableHourlyDates(rows);
    if (dates.length < 3) throw new Error("源表至少需要包含今天、昨天和前天三天数据");
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
    showValidation("error", "文件读取失败", error.message);
    label.textContent = state.file ? "替换文件" : "选择文件";
  } finally {
    label.classList.remove("loading");
    input.value = "";
  }
}

function generate() {
  generateButton.disabled = true;
  try {
    const report = buildHourlyReports(state.rows, dateInput.value, Number(hourSelect.value));
    state.report = report;
    renderReport("pull", report.pull);
    renderReport("unload", report.unload);
    const label = `${formatDate(report.reportDate)} ${pad(report.cutoffHour)}:00`;
    document.querySelector("#hourly-result-date").textContent = label;
    document.querySelector("#hourly-pull-title").textContent = `${label} 拉新时报`;
    document.querySelector("#hourly-unload-title").textContent = `${label} 卸载时报`;
    showValidation("success", "校验通过", `已按${pad(report.cutoffHour)}:00前的完整小时数据生成，源表共读取${report.sourceRows.toLocaleString("zh-CN")}行。`);
    results.classList.remove("hidden");
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    results.classList.add("hidden");
    showValidation("error", "校验未通过", error.message);
  } finally {
    generateButton.disabled = !state.file;
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
    percent(metrics.costChange), percent(metrics.realtimeRetention), percent(metrics.retentionChange), percent(metrics.ctr), percent(metrics.conversionRate),
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
function money(value) { return value == null ? "#DIV/0!" : Number(value).toFixed(2); }
function integer(value) { return Math.round(Number(value) || 0).toString(); }
function percent(value) { return value == null || !Number.isFinite(value) ? "#DIV/0!" : `${(value * 100).toFixed(2)}%`; }
function formatDate(value) { const [, month, day] = value.split("-"); return `${Number(month)}月${Number(day)}日`; }
function pad(value) { return String(value).padStart(2, "0"); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function toast(message, duration = 2200) { const node = document.querySelector("#toast"); node.textContent = message; node.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), duration); }
function saveBlob(blob, filename) { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

async function tableToPng(table) {
  await document.fonts.ready;
  const rect = table.getBoundingClientRect();
  const width = Math.ceil(Math.max(table.scrollWidth, rect.width));
  const height = Math.ceil(Math.max(table.scrollHeight, rect.height));
  const clone = table.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  const style = document.createElement("style");
  style.textContent = `.hourly-report{width:${width}px;table-layout:fixed;border-collapse:collapse;background:#fff;font-family:"PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;color:#17211d}.hourly-report th,.hourly-report td{height:28px;padding:3px 5px;border:1px solid #222;text-align:center;white-space:nowrap}.hourly-report th{background:#b8caf4;font-weight:500}.hourly-report.unload th{background:#8edc83}.hourly-report th.report-kind{color:#ed5151;font-weight:700}.hourly-report td.channel{font-weight:700}.hourly-report tr.device-summary td{background:#fff366;font-weight:700}.hourly-report.unload tr.device-summary td{background:#d5efd1}.hourly-report tr.channel-total td,.hourly-report tr.overall td{font-weight:700}.hourly-report.pull tr.overall td{background:#dce5fa}.hourly-report.unload tr.overall td{background:#f7f8f7}`;
  const wrapper = document.createElement("div"); wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml"); wrapper.style.background = "white"; wrapper.append(style, clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(wrapper)}</foreignObject></svg>`;
  const image = new Image(); const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("图片渲染失败")); image.src = url; });
  const scale = 2; const canvas = document.createElement("canvas"); canvas.width = width * scale; canvas.height = height * scale;
  const context = canvas.getContext("2d"); context.scale(scale, scale); context.fillStyle = "#fff"; context.fillRect(0, 0, width, height); context.drawImage(image, 0, 0); URL.revokeObjectURL(url);
  return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG生成失败")), "image/png"));
}
