export const ONESTOP_STORAGE_KEY = "doubao-onestop-settings-v1";
export const ONESTOP_LOG_KEY = "doubao-onestop-last-run-v1";

export function parseTaskText(text) {
  const tasks = [];
  const seen = new Set();
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const urlId = extractIdFromUrl(line);
    const match = line.match(/(?:^|\D)(\d{6,})(?:\D|$)/);
    const id = urlId || match?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = line
      .replace(/https?:\/\/\S+/g, "")
      .replace(new RegExp(`(^|\\D)${id}(?=\\D|$)`), " ")
      .replace(/^[\s,，|｜:：\-]+|[\s,，|｜:：\-]+$/g, "")
      .trim();
    tasks.push({ id, name: name || `任务 ${id}` });
  }
  return tasks;
}

export function formatTaskText(tasks) {
  return (tasks || []).map((task) => `${task.id}\t${task.name || `任务 ${task.id}`}`).join("\n");
}

export function defaultDateRange(now = new Date()) {
  const endDate = localIsoDate(now);
  const startYear = now.getMonth() < 5 ? now.getFullYear() - 1 : now.getFullYear();
  return { startDate: `${startYear}-06-01`, endDate };
}

export function buildEditUrl(listUrl, taskId) {
  const url = new URL(listUrl);
  url.pathname = url.pathname.replace(/\/$/, "").replace(/\/edit$/, "") + "/edit";
  url.searchParams.set("id", String(taskId));
  url.searchParams.delete("owners[]");
  return url.toString();
}

export function normalizeDate(value) {
  const match = String(value || "").match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

export function displayDate(value) {
  const normalized = normalizeDate(value);
  return normalized ? normalized.replaceAll("-", "/") : "--";
}

function extractIdFromUrl(line) {
  try {
    if (!/^https?:\/\//.test(line)) return "";
    return new URL(line).searchParams.get("id") || "";
  } catch {
    return "";
  }
}

function localIsoDate(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
