const state = { files: {}, report: null, baseNarrative: "", mappingStatus: null, pendingMappings: [], mappingImportPreview: null };
const fileSlots = [...document.querySelectorAll(".file-slot")];
const generateButton = document.querySelector("#generate");
const uploadSummary = document.querySelector("#upload-summary");
const validation = document.querySelector("#validation");
const results = document.querySelector("#results");
const narrative = document.querySelector("#narrative");
const reportDateInput = document.querySelector("#report-date");
const clearAllFilesButton = document.querySelector("#clear-all-files");
const pendingMappings = document.querySelector("#pending-mappings");
const pendingMappingRows = document.querySelector("#pending-mapping-rows");
const mappingImportInput = document.querySelector("#file-mapping-import");
const mappingImportLabel = document.querySelector("#mapping-import-label");
const mappingImportDialog = document.querySelector("#mapping-import-dialog");

reportDateInput.value = shiftDate(localIsoDate(), -1);
updateDateHints();
loadMappingStatus();
reportDateInput.addEventListener("change", () => {
  updateDateHints();
  invalidateResult("日报日期已更新，请上传对应日期文件后重新生成。");
});

fileSlots.forEach((slot) => {
  const input = slot.querySelector("input");
  const selectButton = slot.querySelector(".file-select");
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    const key = slot.dataset.key;
    selectButton.classList.add("loading");
    selectButton.textContent = "正在读取";
    try {
      state.files[key] = { name: file.name, data: await readFile(file) };
      slot.classList.add("ready");
      slot.querySelector(".file-state").textContent = file.name;
      slot.querySelector(".file-clear").disabled = false;
      selectButton.textContent = "替换文件";
      updateReadyState();
      invalidateResult();
    } catch (error) {
      toast(`文件读取失败：${error.message || "请重新选择"}`, 3600);
      selectButton.textContent = state.files[key] ? "替换文件" : "选择文件";
    } finally {
      selectButton.classList.remove("loading");
      input.value = "";
    }
  });
});

document.querySelectorAll(".file-clear").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearFile(button.dataset.clear);
  });
});
clearAllFilesButton.addEventListener("click", () => {
  Object.keys(state.files).forEach((key) => resetFileSlot(key));
  state.files = {};
  updateReadyState();
  invalidateResult("本次上传文件已全部清空。");
});

document.querySelector("#load-sample").addEventListener("click", () => {
  const date = reportDateInput.value;
  toast(`当前日报只需上传${displayShortDate(date)}、${displayShortDate(shiftDate(date, -1))}、${displayShortDate(shiftDate(date, -7))}三份数据，账户分类由本地库自动匹配。`, 4600);
});

generateButton.addEventListener("click", generate);
mappingImportInput.addEventListener("change", importMappingWorkbook);
document.querySelector("#cancel-mapping-import").addEventListener("click", closeMappingImportDialog);
document.querySelector("#cancel-mapping-import-icon").addEventListener("click", closeMappingImportDialog);
document.querySelector("#confirm-mapping-import").addEventListener("click", confirmMappingImport);
mappingImportDialog.addEventListener("close", () => { state.mappingImportPreview = null; });
document.querySelector("#save-pending-mappings").addEventListener("click", savePendingMappings);
document.querySelector("#action-tags").addEventListener("change", updateNarrative);
document.querySelector("#copy-narrative").addEventListener("click", () => copyText(narrative.value, "日报文案已复制"));
document.querySelectorAll("[data-download]").forEach((button) => button.addEventListener("click", () => downloadReport(button.dataset.download, button)));
document.querySelector("#download-all").addEventListener("click", downloadAllReports);

async function generate() {
  generateButton.disabled = true;
  generateButton.lastChild.textContent = " 正在读取与校验";
  validation.className = "validation-band";
  validation.innerHTML = `<div class="spinner">↻</div><div><strong>正在读取全部账户</strong><span>校验账户范围，自动按账户ID合并三日数据…</span></div>`;
  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportDate: document.querySelector("#report-date").value, files: state.files }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "生成失败");
    state.report = data;
    renderValidation(data);
    if (!data.validation.ok) {
      results.classList.add("hidden");
      renderPendingMappings(data);
      return;
    }
    hidePendingMappings();
    renderReport("pull", data.pull);
    renderReport("unload", data.unload);
    document.querySelector("#result-date").textContent = formatDate(data.reportDate);
    state.baseNarrative = data.narrative;
    updateNarrative();
    results.classList.remove("hidden");
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    validation.className = "validation-band error";
    validation.innerHTML = `<div>!</div><div><strong>生成失败</strong><span>${escapeHtml(error.message)}</span></div>`;
    results.classList.add("hidden");
  } finally {
    generateButton.disabled = false;
    generateButton.lastChild.textContent = " 校验并生成日报";
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
  validation.innerHTML = `<div>✓</div><div><strong>校验通过：已读取${data.stats.accountUniverseAccounts}个账户，${data.stats.matchedAccounts}个已匹配</strong><span>${warnings.length ? warnings.map((item) => escapeHtml(item.message)).join("；") : "三份数据表头、账户ID与匹配关系正常。"}</span></div>`;
}

async function loadMappingStatus() {
  try {
    const response = await fetch("/api/mappings/status");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取分类库失败");
    state.mappingStatus = data;
    renderMappingStatus(data);
    updateReadyState();
  } catch (error) {
    document.querySelector("#mapping-library").classList.add("empty");
    document.querySelector("#mapping-library-state").textContent = "分类库读取失败";
    document.querySelector("#mapping-library-detail").textContent = error.message;
    updateReadyState();
  }
}

function renderMappingStatus(status) {
  const library = document.querySelector("#mapping-library");
  const detail = document.querySelector("#mapping-library-detail");
  const label = document.querySelector("#mapping-library-state");
  library.classList.toggle("empty", !status.initialized);
  label.textContent = status.initialized ? `已保存${status.count}个账户` : "尚未导入匹配表";
  detail.textContent = status.lastImport
    ? `最近导入：${status.lastImport.filename} · ${formatTimestamp(status.lastImport.importedAt)}`
    : "首次使用请导入现有匹配表";
  fillDatalist("purpose-options", status.options?.purposes ?? []);
  fillDatalist("alliance-options", status.options?.alliances ?? []);
  fillDatalist("report-class-options", status.options?.reportClasses ?? []);
  fillDatalist("device-options", status.options?.devices ?? []);
}

async function importMappingWorkbook() {
  const file = mappingImportInput.files[0];
  if (!file) return;
  const original = mappingImportLabel.textContent;
  mappingImportLabel.classList.add("loading");
  mappingImportLabel.textContent = "正在导入";
  try {
    const response = await fetch("/api/mappings/import-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: { name: file.name, data: await readFile(file) } }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "导入失败");
    state.mappingImportPreview = data;
    renderMappingImportPreview(data);
    mappingImportDialog.showModal();
  } catch (error) {
    toast(`匹配表导入失败：${error.message}`, 5200);
  } finally {
    mappingImportInput.value = "";
    mappingImportLabel.classList.remove("loading");
    mappingImportLabel.textContent = original;
  }
}

function renderMappingImportPreview(preview) {
  document.querySelector("#sync-summary").textContent = `${preview.filename} 将作为最新版完整账户表同步到本地分类库。`;
  document.querySelector("#sync-current").textContent = preview.currentCount;
  document.querySelector("#sync-final").textContent = preview.finalCount;
  document.querySelector("#sync-inserted").textContent = preview.inserted;
  document.querySelector("#sync-updated").textContent = preview.updated;
  document.querySelector("#sync-deleted").textContent = preview.deleted;
  const warning = document.querySelector("#sync-delete-warning");
  warning.classList.toggle("hidden", preview.deleted === 0);
  warning.textContent = preview.deleted
    ? `确认后将删除${preview.deleted}个不在最新版表中的旧账户，账户总数将由${preview.currentCount}变为${preview.finalCount}。`
    : "";
  const sampleGroups = [
    ["新增示例", preview.insertedSample],
    ["更新示例", preview.updatedSample],
    ["删除示例", preview.deletedSample],
  ].filter(([, items]) => items?.length);
  document.querySelector("#sync-change-samples").innerHTML = sampleGroups.map(([label, items]) =>
    `<div><strong>${label}：</strong>${items.map((item) => `${escapeHtml(item.accountName || "未命名账户")}（${escapeHtml(item.accountId)}）`).join("、")}</div>`
  ).join("");
  document.querySelector("#confirm-mapping-import").textContent = preview.deleted ? `确认同步并删除${preview.deleted}个账户` : "确认同步";
}

function closeMappingImportDialog() {
  state.mappingImportPreview = null;
  mappingImportDialog.close();
}

async function confirmMappingImport(event) {
  const preview = state.mappingImportPreview;
  if (!preview) return;
  const button = event.currentTarget;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "正在同步";
  try {
    const response = await fetch("/api/mappings/import-confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: preview.token }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "同步失败");
    state.mappingStatus = data.status;
    renderMappingStatus(data.status);
    updateReadyState();
    state.mappingImportPreview = null;
    mappingImportDialog.close();
    toast(`分类库已同步为${data.status.count}个账户：新增${data.inserted}个，更新${data.updated}个，删除${data.deleted}个。`, 5600);
  } catch (error) {
    toast(`匹配表同步失败：${error.message}`, 5200);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function renderPendingMappings(data) {
  const warning = data.validation.warnings.find((item) => item.code === "UNMATCHED_ACTIVE_ACCOUNTS");
  if (!warning?.details?.length) {
    hidePendingMappings();
    return;
  }
  state.pendingMappings = warning.details.filter((item) => item.active);
  pendingMappingRows.innerHTML = state.pendingMappings.map((item) => `
    <tr data-account-id="${escapeHtml(item.id)}">
      <td class="account-id">${escapeHtml(item.id)}</td>
      <td class="account-name">${escapeHtml(item.account || "未命名账户")}</td>
      <td><input data-field="purpose" list="purpose-options" value="" placeholder="选择业务类型"></td>
      <td><input data-field="alliance" list="alliance-options" value="" placeholder="选择渠道分类"></td>
      <td><input data-field="reportClass" list="report-class-options" value="" placeholder="选择报表分类"></td>
      <td><input data-field="device" list="device-options" value="" placeholder="选择设备分类"></td>
    </tr>
  `).join("");
  document.querySelector("#pending-count").textContent = `${state.pendingMappings.length}个新账户`;
  pendingMappings.classList.remove("hidden");
  pendingMappings.scrollIntoView({ behavior: "smooth", block: "start" });
}

function hidePendingMappings() {
  state.pendingMappings = [];
  pendingMappingRows.innerHTML = "";
  pendingMappings.classList.add("hidden");
}

async function savePendingMappings(event) {
  const button = event.currentTarget;
  const rows = [...pendingMappingRows.querySelectorAll("tr")];
  const mappings = rows.map((row) => {
    const source = state.pendingMappings.find((item) => item.id === row.dataset.accountId);
    const value = (field) => row.querySelector(`[data-field="${field}"]`).value.trim();
    return {
      accountId: row.dataset.accountId,
      accountName: source?.account ?? "",
      purpose: value("purpose"),
      alliance: value("alliance"),
      reportClass: value("reportClass"),
      device: value("device"),
    };
  });
  const incomplete = mappings.find((item) => !item.purpose || !item.alliance || !item.reportClass || !item.device);
  if (incomplete) {
    toast(`账户${incomplete.accountId}的分类信息未填写完整。`, 4200);
    return;
  }
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "正在保存";
  try {
    const response = await fetch("/api/mappings/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mappings }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "保存失败");
    state.mappingStatus = data.status;
    renderMappingStatus(data.status);
    hidePendingMappings();
    toast(`已保存${data.saved}个新账户，正在重新生成日报。`, 3200);
    await generate();
  } catch (error) {
    toast(`保存失败：${error.message}`, 4600);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function renderReport(kind, report) {
  const container = document.querySelector(`#${kind}-report`);
  const date = formatDate(state.report.reportDate);
  const rows = report.rows;
  document.querySelector(`#${kind}-report-title`).textContent = `${report.title}日报`;
  const spans = computeSpans(rows);
  const headers = ["日期", report.title, "版位", "版位", "账面消耗", "折后消耗", "量级", "量级环比", "账面成本", "折后成本", "成本环比", "次留", "次留环比", "完整7留", "点击率", "转化率"];
  let html = `<table class="daily-report ${kind}" data-report="${kind}"><colgroup><col style="width:108px"><col style="width:105px"><col style="width:106px"><col style="width:106px">${"<col style=\"width:105px\">".repeat(12)}</colgroup><thead><tr>${headers.map((header, index) => `<th class="${index === 1 ? "report-kind" : ""}">${header}</th>`).join("")}</tr></thead><tbody>`;
  rows.forEach((row, index) => {
    html += `<tr class="${row.style}">`;
    if (index === 0) html += `<td class="date" rowspan="${rows.length}">${date}</td>`;
    if (spans.channel[index]) html += `<td class="channel" rowspan="${spans.channel[index]}">${row.channel || ""}</td>`;
    if (spans.device[index]) html += `<td class="device" rowspan="${spans.device[index]}">${row.device || ""}</td>`;
    html += `<td class="assessment">${row.assessment}</td>`;
    html += metricCells(row.metrics);
    html += `</tr>`;
  });
  html += "</tbody></table>";
  container.innerHTML = html;
}

function computeSpans(rows) {
  const channel = {};
  const device = {};
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (row.style === "overall") { channel[index] = 1; device[index] = 1; index += 1; continue; }
    if (row.style === "channel-total") { channel[index] = 1; device[index] = 1; index += 1; continue; }
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
    if (!blob) throw new Error("图片生成失败");
    const reportTitle = state.report[kind]?.title || (kind === "pull" ? "业务一" : "业务二");
    const filename = `${state.report.reportDate}-${reportTitle}日报.png`;
    const data = await blobToDataUrl(blob);
    const response = await fetch("/api/prepare-download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, data }),
    });
    const prepared = await response.json();
    if (!response.ok) throw new Error(prepared.error || "下载准备失败");
    const link = document.createElement("a");
    link.href = prepared.url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
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
  if (!state.report) {
    toast("请先生成日报");
    return;
  }
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
    const x = rect.left - tableRect.left;
    const y = rect.top - tableRect.top;
    context.fillStyle = transparent(style.backgroundColor) ? "#ffffff" : style.backgroundColor;
    context.fillRect(x, y, rect.width, rect.height);
  }

  context.strokeStyle = "#222222";
  context.lineWidth = 1;
  for (const cell of cells) {
    const rect = cell.getBoundingClientRect();
    const x = Math.round(rect.left - tableRect.left) + 0.5;
    const y = Math.round(rect.top - tableRect.top) + 0.5;
    context.strokeRect(x, y, Math.max(0, Math.round(rect.width) - 1), Math.max(0, Math.round(rect.height) - 1));
  }

  for (const cell of cells) {
    const rect = cell.getBoundingClientRect();
    const style = getComputedStyle(cell);
    const x = rect.left - tableRect.left;
    const y = rect.top - tableRect.top;
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
    context.fillText(text, x + rect.width / 2, y + rect.height / 2, availableWidth);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG生成失败")), "image/png");
  });
}

function transparent(color) {
  return !color || color === "transparent" || color === "rgba(0, 0, 0, 0)";
}

function updateReadyState() {
  const count = Object.keys(state.files).length;
  const libraryReady = Boolean(state.mappingStatus?.initialized);
  uploadSummary.textContent = count === 3 ? "3个数据文件已就绪" : `已上传${count}/3个数据文件`;
  if (!libraryReady) uploadSummary.textContent += "，请先导入账户匹配表";
  generateButton.disabled = count !== 3 || !libraryReady;
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
  hidePendingMappings();
  if (message) toast(message, 3200);
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
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDate(dateText, days) {
  const date = new Date(`${dateText}T12:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function displayShortDate(dateText) {
  const [, month, day] = dateText.split("-").map(Number);
  return `${month}月${day}日`;
}

function formatTimestamp(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function fillDatalist(id, values) {
  document.querySelector(`#${id}`).innerHTML = values.map((value) => `<option value="${escapeHtml(value)}"></option>`).join("");
}

function readFile(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
}
function money(value) { return Number.isFinite(value) ? value.toFixed(2) : "#DIV/0!"; }
function integer(value) { return Number.isFinite(value) ? Math.round(value).toString() : "#DIV/0!"; }
function percent(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "#DIV/0!"; }
function formatDate(value) { const [year, month, day] = value.split("-").map(Number); return `${year}/${month}/${day}`; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    toast(message);
  } catch (error) {
    narrative.focus();
    narrative.select();
    const copied = document.execCommand("copy");
    if (copied) {
      toast(message);
    } else {
      toast("浏览器未允许自动复制，文案已全选，请按⌘C复制。", 4200);
    }
  }
}
function toast(message, duration = 2200) { const element = document.querySelector("#toast"); element.textContent = message; element.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove("show"), duration); }
