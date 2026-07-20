const USERGROWTH_PATTERN = "https://usergrowth.com.cn/onestop/*";
const BACKGROUND_PROTOCOL = 3;
const EXPECTED_CONTENT_PROTOCOL = 3;
const EXPECTED_CONTENT_BUILD = "calendar-click-v3";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.channel !== "ONESTOP_DASHBOARD") return false;
  handleDashboardRequest(message.action, message.payload || {}, sender.tab?.id)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: userMessage(error), code: error.code, stage: error.stage }));
  return true;
});

async function handleDashboardRequest(action, payload, dashboardTabId) {
  if (action === "PING") {
    const tabs = await chrome.tabs.query({ url: USERGROWTH_PATTERN });
    const pages = await Promise.all(tabs.map(probePageBuild));
    return {
      version: chrome.runtime.getManifest().version,
      protocol: BACKGROUND_PROTOCOL,
      expectedContentProtocol: EXPECTED_CONTENT_PROTOCOL,
      expectedContentBuild: EXPECTED_CONTENT_BUILD,
      usergrowthTabs: tabs.length,
      pages,
      readyPages: pages.filter((page) => page.ready).length,
      stalePages: pages.filter((page) => !page.ready).length,
    };
  }
  if (action === "OPEN_LIST") {
    const tab = await findOrOpenListTab(payload.listUrl, true);
    return { tabId: tab.id };
  }
  if (action === "SCAN_TASKS") return scanTasks(payload.listUrl, dashboardTabId);
  if (action === "PREVIEW_TASKS") return processTasks("preview", payload, dashboardTabId);
  if (action === "EXECUTE_TASKS") return processTasks("execute", payload, dashboardTabId);
  throw new Error("不支持的扩展操作。");
}

async function scanTasks(listUrl, dashboardTabId) {
  const tab = await findOrOpenListTab(listUrl, false);
  await ensurePageReady(tab.id);
  await sendPageMessage(tab.id, { type: "GO_FIRST_PAGE" });
  const taskMap = new Map();
  for (let page = 1; page <= 20; page += 1) {
    const result = await sendPageMessage(tab.id, { type: "SCAN_LIST_PAGE" });
    for (const task of result.tasks || []) taskMap.set(String(task.id), task);
    notifyProgress(dashboardTabId, { completed: page, total: result.hasNext ? page + 1 : page, label: `已扫描第 ${page} 页` });
    if (!result.hasNext) break;
    const moved = await sendPageMessage(tab.id, { type: "GO_NEXT_PAGE", signature: result.signature });
    if (!moved.changed) break;
  }
  await sendPageMessage(tab.id, { type: "GO_FIRST_PAGE" }).catch(() => undefined);
  return { tasks: [...taskMap.values()] };
}

async function processTasks(mode, payload, dashboardTabId) {
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  if (!tasks.length) return { results: [] };
  let runner = null;
  let keepRunnerForLogin = false;
  const results = [];
  try {
    runner = await chrome.tabs.create({ url: "about:blank", active: false });
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      notifyProgress(dashboardTabId, {
        completed: index,
        total: tasks.length,
        label: mode === "preview" ? `正在读取 ${task.name || task.id}` : `正在更新 ${task.name || task.id}`,
        task: { ...task, status: mode === "preview" ? "reading" : "running", result: mode === "preview" ? "正在读取编辑页" : "正在提交" },
      });
      try {
        const editUrl = buildEditUrl(payload.listUrl, task.id);
        await navigateAndWait(runner.id, editUrl);
        const result = await sendPageMessage(runner.id, {
          type: mode === "preview" ? "PREVIEW_TASK" : "EXECUTE_TASK",
          task,
          startDate: payload.startDate,
          endDate: payload.endDate,
        });
        if (mode === "execute" && result.status === "success") await delay(1800);
        const normalized = { ...task, ...result };
        results.push(normalized);
        notifyProgress(dashboardTabId, { completed: index + 1, total: tasks.length, label: statusLabel(normalized), task: normalized });
      } catch (error) {
        const failed = { ...task, status: "failed", result: userMessage(error), code: error.code || "PAGE_ERROR", stage: error.stage || "unknown" };
        results.push(failed);
        notifyProgress(dashboardTabId, { completed: index + 1, total: tasks.length, label: `任务 ${task.id} 失败`, task: failed });
        if (error.code === "AUTH_REQUIRED" || error.code === "CAPTCHA_REQUIRED") {
          keepRunnerForLogin = true;
          await chrome.tabs.update(runner.id, { active: true }).catch(() => undefined);
          for (const remaining of tasks.slice(index + 1)) {
            results.push({ ...remaining, status: "failed", result: "已因登录或验证中断，未执行", code: "ABORTED" });
          }
          break;
        }
      }
    }
  } finally {
    if (runner?.id && !keepRunnerForLogin) await chrome.tabs.remove(runner.id).catch(() => undefined);
  }
  return { results };
}

async function findOrOpenListTab(listUrl, active) {
  const tabs = await chrome.tabs.query({ url: "https://usergrowth.com.cn/onestop/ad/ad_create*" });
  const listTab = tabs.find((tab) => tab.url && !tab.url.includes("/edit"));
  if (listTab) {
    if (active) await chrome.tabs.update(listTab.id, { active: true });
    return listTab;
  }
  const created = await chrome.tabs.create({ url: listUrl, active });
  await waitForTabComplete(created.id);
  return created;
}

async function navigateAndWait(tabId, url) {
  await chrome.tabs.update(tabId, { url, active: false });
  await waitForTabComplete(tabId);
  const tab = await chrome.tabs.get(tabId);
  if (tab.url?.includes("/onestop/login")) throw codedError("一站式登录已失效，请在打开的页面完成登录后重试。", "AUTH_REQUIRED");
  await ensurePageReady(tabId);
}

function waitForTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("页面加载超时。")), timeout);
    const listener = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId)
      .then((existing) => { if (existing?.status === "complete") finish(); })
      .catch((error) => finish(error));
    function finish(error) {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    }
  });
}

async function ensurePageReady(tabId) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "PING_PAGE" });
      if (response?.ok) {
        const page = response.data || {};
        if (page.protocol !== EXPECTED_CONTENT_PROTOCOL || page.contentBuild !== EXPECTED_CONTENT_BUILD) {
          throw codedError(
            `一站式页面脚本版本不一致：当前 ${page.contentBuild || "旧版"}，需要 ${EXPECTED_CONTENT_BUILD}。请重新加载扩展并刷新一站式页面。`,
            "CONTENT_VERSION_MISMATCH",
            "version_check",
          );
        }
        return page;
      }
    } catch (error) {
      if (error?.code === "CONTENT_VERSION_MISMATCH") throw error;
      // Content script may still be attaching after navigation.
    }
    await delay(250);
  }
  throw codedError("一站式页面脚本未就绪，请刷新页面后重试。", "PAGE_BRIDGE_TIMEOUT", "version_check");
}

async function probePageBuild(tab) {
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "PING_PAGE" });
    const page = response?.data || {};
    const ready = Boolean(response?.ok && page.protocol === EXPECTED_CONTENT_PROTOCOL && page.contentBuild === EXPECTED_CONTENT_BUILD);
    return { tabId: tab.id, url: tab.url, ready, protocol: page.protocol ?? null, contentBuild: page.contentBuild || "unknown" };
  } catch {
    return { tabId: tab.id, url: tab.url, ready: false, protocol: null, contentBuild: "unreachable" };
  }
}

async function sendPageMessage(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    if (!response?.ok) {
      const error = codedError(response?.error || "一站式页面执行失败。", response?.code || "PAGE_ERROR", response?.stage);
      throw error;
    }
    return response.data || {};
  } catch (error) {
    if (error?.code) throw error;
    throw new Error(error?.message || "无法向一站式页面发送指令。");
  }
}

function buildEditUrl(listUrl, taskId) {
  const url = new URL(listUrl);
  url.pathname = url.pathname.replace(/\/$/, "").replace(/\/edit$/, "") + "/edit";
  url.searchParams.set("id", String(taskId));
  url.searchParams.delete("owners[]");
  return url.toString();
}

function notifyProgress(tabId, payload) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { channel: "ONESTOP_PROGRESS", payload }).catch(() => undefined);
}

function statusLabel(task) {
  if (task.status === "success") return `${task.name || task.id} 已提交`;
  if (task.status === "skipped") return `${task.name || task.id} 无需更新`;
  if (task.status === "pending") return `${task.name || task.id} 待更新`;
  return `${task.name || task.id} 已处理`;
}

function codedError(message, code, stage = code) {
  const error = new Error(message);
  error.code = code;
  error.stage = stage;
  return error;
}

function userMessage(error) {
  return error?.message || "扩展执行失败。";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
