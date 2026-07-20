import {
  ONESTOP_LOG_KEY,
  ONESTOP_STORAGE_KEY,
  defaultDateRange,
  displayDate,
  formatTaskText,
  parseTaskText,
} from "./onestop-core.js?v=20260720-1";

const WEB_SOURCE = "doubao-onestop-web";
const EXTENSION_SOURCE = "doubao-onestop-extension";
const EXPECTED_EXTENSION_PROTOCOL = 3;
const EXPECTED_CONTENT_BUILD = "calendar-click-v3";
const state = {
  connected: false,
  extensionVersion: "",
  preview: [],
  running: false,
};

const elements = {
  extensionState: document.querySelector("#extension-state"),
  listUrl: document.querySelector("#onestop-list-url"),
  startDate: document.querySelector("#onestop-start-date"),
  endDate: document.querySelector("#onestop-end-date"),
  taskInput: document.querySelector("#onestop-task-input"),
  taskInputCount: document.querySelector("#task-input-count"),
  total: document.querySelector("#onestop-total"),
  pending: document.querySelector("#onestop-pending"),
  skipped: document.querySelector("#onestop-skipped"),
  lastRun: document.querySelector("#onestop-last-run"),
  summary: document.querySelector("#onestop-config-summary"),
  previewButton: document.querySelector("#preview-onestop"),
  previewPanel: document.querySelector("#onestop-preview"),
  previewSummary: document.querySelector("#onestop-preview-summary"),
  rows: document.querySelector("#onestop-task-rows"),
  selectAll: document.querySelector("#select-all-onestop"),
  executeButton: document.querySelector("#execute-onestop"),
  retryButton: document.querySelector("#retry-onestop"),
  progressTitle: document.querySelector("#run-progress-title"),
  progressDetail: document.querySelector("#run-progress-detail"),
  progressBar: document.querySelector("#run-progress-bar"),
  dialog: document.querySelector("#onestop-confirm-dialog"),
  confirmCopy: document.querySelector("#onestop-confirm-copy"),
  confirmCheck: document.querySelector("#onestop-confirm-check"),
  confirmButton: document.querySelector("#confirm-execute-onestop"),
};

initialize();

function initialize() {
  const defaults = defaultDateRange();
  const saved = readJson(ONESTOP_STORAGE_KEY, {});
  elements.startDate.value = saved.startDate || defaults.startDate;
  elements.endDate.value = defaults.endDate;
  elements.listUrl.value = saved.listUrl || elements.listUrl.value;
  elements.taskInput.value = formatTaskText(saved.tasks || []);
  const lastRun = readJson(ONESTOP_LOG_KEY, null);
  elements.lastRun.textContent = lastRun?.finishedAt ? shortDateTime(lastRun.finishedAt) : "--";
  updateInputState();
  bindEvents();
  window.addEventListener("message", handleExtensionEvent);
  setTimeout(checkExtension, 120);
}

function bindEvents() {
  elements.taskInput.addEventListener("input", updateInputState);
  elements.listUrl.addEventListener("change", saveSettings);
  elements.startDate.addEventListener("change", saveSettings);
  elements.endDate.addEventListener("change", resetPreview);
  document.querySelector("#save-onestop-tasks").addEventListener("click", () => {
    saveSettings();
    toast(`已在本机保存 ${currentTasks().length} 条任务`);
  });
  document.querySelector("#clear-onestop-tasks").addEventListener("click", () => {
    elements.taskInput.value = "";
    updateInputState();
    resetPreview();
    saveSettings();
  });
  document.querySelector("#scan-onestop-tasks").addEventListener("click", scanTasks);
  document.querySelector("#open-onestop").addEventListener("click", openOnestop);
  elements.previewButton.addEventListener("click", previewTasks);
  elements.selectAll.addEventListener("change", toggleAllPending);
  elements.rows.addEventListener("change", updateSelectionState);
  elements.executeButton.addEventListener("click", openConfirmDialog);
  elements.retryButton.addEventListener("click", retryFailed);
  elements.confirmCheck.addEventListener("change", () => {
    elements.confirmButton.disabled = !elements.confirmCheck.checked;
  });
  elements.confirmButton.addEventListener("click", executeSelected);
  document.querySelectorAll("[data-close-onestop-dialog]").forEach((button) => button.addEventListener("click", closeConfirmDialog));
}

async function checkExtension() {
  setConnectionState("checking", "正在检测执行扩展", "确认本机执行能力");
  try {
    const response = await requestExtension("PING", {}, 1800);
    state.extensionVersion = response.version || "unknown";
    if (response.protocol !== EXPECTED_EXTENSION_PROTOCOL || response.expectedContentBuild !== EXPECTED_CONTENT_BUILD) {
      state.connected = false;
      setConnectionState(
        "disconnected",
        `扩展 ${state.extensionVersion} 版本不匹配`,
        `当前协议 ${response.protocol ?? "旧版"}，需要协议 ${EXPECTED_EXTENSION_PROTOCOL}。请重新加载扩展`,
      );
      updateInputState();
      return;
    }
    if ((response.stalePages || 0) > 0) {
      state.connected = false;
      setConnectionState(
        "disconnected",
        `执行扩展 v${state.extensionVersion} 已更新`,
        `${response.stalePages} 个一站式页面脚本过期，刷新这些页面后再试`,
      );
      updateInputState();
      return;
    }
    state.connected = true;
    const loginCopy = response.usergrowthTabs > 0
      ? `协议 ${response.protocol} · 页面脚本 ${response.readyPages}/${response.usergrowthTabs} 最新`
      : `协议 ${response.protocol} · 新任务将校验 ${response.expectedContentBuild}`;
    setConnectionState("connected", `执行扩展 v${state.extensionVersion} 已连接`, loginCopy);
  } catch (error) {
    state.connected = false;
    setConnectionState("disconnected", "未连接Chrome扩展", error.message || "安装后刷新当前页面");
  }
  updateInputState();
}

async function openOnestop() {
  if (!state.connected) {
    window.open(elements.listUrl.value, "_blank", "noopener");
    toast("已打开一站式；安装扩展后才能扫描和执行");
    return;
  }
  try {
    await requestExtension("OPEN_LIST", { listUrl: elements.listUrl.value });
  } catch (error) {
    toast(error.message, 4200);
  }
}

async function scanTasks() {
  if (!state.connected) return toast("请先安装并连接Chrome扩展", 3600);
  const button = document.querySelector("#scan-onestop-tasks");
  setBusy(button, true, "正在扫描列表");
  elements.summary.textContent = "正在读取一站式当前筛选结果和分页，请保持登录状态。";
  try {
    const response = await requestExtension("SCAN_TASKS", { listUrl: elements.listUrl.value }, 90000);
    const merged = mergeTasks(currentTasks(), response.tasks || []);
    elements.taskInput.value = formatTaskText(merged);
    updateInputState();
    saveSettings();
    resetPreview();
    toast(`扫描完成，共保存 ${merged.length} 条任务`);
  } catch (error) {
    elements.summary.textContent = error.message;
    toast(error.message, 4800);
  } finally {
    setBusy(button, false);
  }
}

async function previewTasks() {
  const tasks = currentTasks();
  if (!tasks.length) return;
  if (!state.connected) return toast("请先连接Chrome扩展");
  saveSettings();
  state.preview = tasks.map((task) => ({ ...task, status: "reading", result: "等待读取" }));
  renderPreview();
  setPreviewBusy(true);
  elements.previewPanel.classList.remove("hidden");
  elements.previewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const response = await requestExtension("PREVIEW_TASKS", buildRequestPayload(tasks), 240000);
    state.preview = response.results || [];
    renderPreview();
  } catch (error) {
    state.preview = state.preview.map((task) => task.status === "reading" ? { ...task, status: "failed", result: error.message } : task);
    renderPreview();
    toast(error.message, 5000);
  } finally {
    setPreviewBusy(false);
  }
}

function renderPreview() {
  const targetRange = `${displayDate(elements.startDate.value)} - ${displayDate(elements.endDate.value)}`;
  elements.rows.innerHTML = state.preview.map((task) => {
    const selectable = task.status === "pending";
    const checked = selectable && task.selected !== false;
    const currentRange = task.currentStart || task.currentEnd ? `${displayDate(task.currentStart)} - ${displayDate(task.currentEnd)}` : "--";
    return `<tr data-task-id="${escapeHtml(task.id)}">
      <td class="select-cell"><input class="task-select" type="checkbox" aria-label="选择任务 ${escapeHtml(task.id)}" ${checked ? "checked" : ""} ${selectable ? "" : "disabled"}></td>
      <td><span class="task-identity"><strong>${escapeHtml(task.name || `任务 ${task.id}`)}</strong><code>${escapeHtml(task.id)}</code></span></td>
      <td class="date-range">${currentRange}</td>
      <td class="date-range">${targetRange}</td>
      <td>${statusChip(task.status)}</td>
      <td class="result-copy">${escapeHtml(task.result || statusCopy(task.status))}${task.code ? `<small>${escapeHtml(task.code)} · ${escapeHtml(task.stage || "unknown")}</small>` : ""}</td>
    </tr>`;
  }).join("");
  const pending = state.preview.filter((task) => task.status === "pending").length;
  const skipped = state.preview.filter((task) => task.status === "skipped").length;
  const failed = state.preview.filter((task) => task.status === "failed").length;
  elements.pending.textContent = String(pending);
  elements.skipped.textContent = String(skipped);
  elements.previewSummary.textContent = `共 ${state.preview.length} 条，${pending} 条待更新，${skipped} 条已是目标日期，${failed} 条读取失败。`;
  elements.retryButton.classList.toggle("hidden", failed === 0);
  updateSelectionState();
}

function openConfirmDialog() {
  const selected = selectedTasks();
  if (!selected.length || state.running) return;
  elements.confirmCopy.textContent = `将逐条提交 ${selected.length} 个一站式任务，结束日期更新为 ${displayDate(elements.endDate.value)}。执行过程中如遇登录失效或页面结构异常将停止。`;
  elements.confirmCheck.checked = false;
  elements.confirmButton.disabled = true;
  elements.dialog.showModal();
}

function closeConfirmDialog() {
  if (!state.running) elements.dialog.close();
}

async function executeSelected() {
  const tasks = selectedTasks();
  if (!tasks.length || !elements.confirmCheck.checked) return;
  elements.dialog.close();
  state.running = true;
  setRunProgress(0, tasks.length, "准备执行");
  elements.executeButton.disabled = true;
  elements.previewButton.disabled = true;
  try {
    const response = await requestExtension("EXECUTE_TASKS", buildRequestPayload(tasks), 480000);
    mergeExecutionResults(response.results || []);
    const succeeded = response.results?.filter((item) => item.status === "success").length || 0;
    const failed = response.results?.filter((item) => item.status === "failed").length || 0;
    writeJson(ONESTOP_LOG_KEY, { finishedAt: new Date().toISOString(), succeeded, failed, total: tasks.length });
    elements.lastRun.textContent = shortDateTime(new Date().toISOString());
    setRunProgress(tasks.length, tasks.length, failed ? "执行完成，存在失败项" : "全部更新完成");
    toast(failed ? `完成 ${succeeded} 条，失败 ${failed} 条` : `已完成 ${succeeded} 条任务更新`, 4800);
  } catch (error) {
    setRunProgress(0, tasks.length, error.message);
    toast(error.message, 5000);
  } finally {
    state.running = false;
    elements.previewButton.disabled = !state.connected || currentTasks().length === 0;
    renderPreview();
  }
}

function handleExtensionEvent(event) {
  const message = event.data;
  if (event.source !== window || message?.source !== EXTENSION_SOURCE || message?.kind !== "progress") return;
  const progress = message.payload || {};
  if (progress.task) updateTaskFromProgress(progress.task);
  setRunProgress(progress.completed || 0, progress.total || 1, progress.label || "正在执行");
}

function updateTaskFromProgress(task) {
  state.preview = state.preview.map((item) => item.id === task.id ? { ...item, ...task } : item);
  renderPreview();
}

function mergeExecutionResults(results) {
  const map = new Map(results.map((item) => [String(item.id), item]));
  state.preview = state.preview.map((item) => map.has(String(item.id)) ? { ...item, ...map.get(String(item.id)) } : item);
}

function retryFailed() {
  state.preview = state.preview.map((task) => task.status === "failed" ? { ...task, status: "pending", selected: true, result: "等待重试" } : { ...task, selected: false });
  renderPreview();
}

function toggleAllPending() {
  document.querySelectorAll("#onestop-task-rows .task-select:not(:disabled)").forEach((checkbox) => {
    checkbox.checked = elements.selectAll.checked;
  });
  updateSelectionState();
}

function updateSelectionState() {
  const available = [...document.querySelectorAll("#onestop-task-rows .task-select:not(:disabled)")];
  const selected = available.filter((item) => item.checked);
  elements.selectAll.checked = available.length > 0 && selected.length === available.length;
  elements.selectAll.indeterminate = selected.length > 0 && selected.length < available.length;
  elements.executeButton.disabled = state.running || selected.length === 0;
  elements.progressTitle.textContent = selected.length ? `已选择 ${selected.length} 条待更新任务` : "等待确认";
  elements.progressDetail.textContent = selected.length ? `将更新至 ${displayDate(elements.endDate.value)}` : "勾选需要更新的任务后执行";
}

function selectedTasks() {
  const ids = new Set([...document.querySelectorAll("#onestop-task-rows tr")]
    .filter((row) => row.querySelector(".task-select")?.checked)
    .map((row) => row.dataset.taskId));
  return state.preview.filter((task) => ids.has(String(task.id)));
}

function buildRequestPayload(tasks) {
  return {
    tasks: tasks.map(({ id, name }) => ({ id, name })),
    listUrl: elements.listUrl.value,
    startDate: elements.startDate.value,
    endDate: elements.endDate.value,
  };
}

function updateInputState() {
  const tasks = currentTasks();
  elements.taskInputCount.textContent = `${tasks.length} 条`;
  elements.total.textContent = String(tasks.length);
  elements.previewButton.disabled = !state.connected || tasks.length === 0;
  elements.summary.textContent = tasks.length
    ? `已准备 ${tasks.length} 条任务。预览只读取日期，不会提交修改。`
    : "先连接Chrome扩展，再扫描或粘贴任务ID。";
}

function currentTasks() {
  return parseTaskText(elements.taskInput.value);
}

function saveSettings() {
  writeJson(ONESTOP_STORAGE_KEY, {
    listUrl: elements.listUrl.value,
    startDate: elements.startDate.value,
    tasks: currentTasks(),
  });
  updateInputState();
}

function resetPreview() {
  state.preview = [];
  elements.previewPanel.classList.add("hidden");
  elements.pending.textContent = "-";
  elements.skipped.textContent = "-";
  elements.progressBar.style.width = "0";
}

function setConnectionState(kind, title, detail) {
  elements.extensionState.className = `extension-state ${kind}`;
  elements.extensionState.querySelector("strong").textContent = title;
  elements.extensionState.querySelector("small").textContent = detail;
}

function setPreviewBusy(busy) {
  elements.previewButton.disabled = busy;
  elements.previewButton.innerHTML = busy
    ? `<span class="button-spinner" aria-hidden="true"></span>正在读取任务`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.5"/></svg>生成更新预览`;
}

function setBusy(button, busy, label = "") {
  if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
  button.disabled = busy;
  button.innerHTML = busy ? `<span class="button-spinner" aria-hidden="true"></span>${escapeHtml(label)}` : button.dataset.originalHtml;
}

function setRunProgress(completed, total, label) {
  const safeTotal = Math.max(1, total);
  const percent = Math.min(100, Math.round((completed / safeTotal) * 100));
  elements.progressBar.style.width = `${percent}%`;
  elements.progressTitle.textContent = label;
  elements.progressDetail.textContent = `${completed} / ${total} 条`;
}

function requestExtension(action, payload, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const requestId = `onestop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Chrome扩展无响应，请确认已安装并刷新页面。"));
    }, timeout);
    function onMessage(event) {
      const message = event.data;
      if (event.source !== window || message?.source !== EXTENSION_SOURCE || message?.requestId !== requestId || message?.kind !== "response") return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (message.ok) resolve(message.data || {});
      else reject(new Error(message.error || "扩展执行失败"));
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ source: WEB_SOURCE, kind: "request", requestId, action, payload }, window.location.origin);
  });
}

function statusChip(status) {
  const mapping = {
    reading: ["running", "读取中"], running: ["running", "执行中"], pending: ["pending", "待更新"],
    skipped: ["skipped", "无需更新"], success: ["success", "已更新"], failed: ["failed", "失败"],
  };
  const [className, label] = mapping[status] || ["skipped", "待检查"];
  return `<span class="status-chip ${className}">${label}</span>`;
}

function statusCopy(status) {
  return ({ reading: "正在打开编辑页", pending: "等待人工确认", skipped: "结束日期已是目标日期", running: "正在提交", success: "已提交修改", failed: "需要检查" })[status] || "--";
}

function mergeTasks(left, right) {
  const map = new Map();
  [...left, ...right].forEach((task) => map.set(String(task.id), { id: String(task.id), name: task.name || `任务 ${task.id}` }));
  return [...map.values()];
}

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Local storage may be disabled. */ }
}

function shortDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function toast(message, duration = 2600) {
  const node = document.querySelector("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), duration);
}
