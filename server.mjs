import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { MappingStore } from "./lib/mapping-store.mjs";
import { loadReportConfig } from "./lib/report-config.mjs";
import { readWorkbookRows } from "./lib/spreadsheet-reader.mjs";
import { generateDailyReport } from "./lib/report-engine.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));
const historyPath = path.join(dataDir, "history.json");
const mappingDatabasePath = path.join(dataDir, "report-workbench.db");
const port = Number(process.env.PORT || 4319);
const host = process.env.HOST || "0.0.0.0";
const maxRequestMb = Number(process.env.MAX_REQUEST_MB || 20);
const maxRequestBytes = maxRequestMb * 1024 * 1024;
const appUsername = process.env.APP_USERNAME || "admin";
const appPassword = process.env.APP_PASSWORD || "";
const pendingDownloads = new Map();
const pendingMappingImports = new Map();

if (process.env.NODE_ENV === "production" && !appPassword) {
  throw new Error("生产环境必须设置APP_PASSWORD，避免业务数据暴露在公网。");
}
if (!Number.isFinite(maxRequestBytes) || maxRequestBytes <= 0) throw new Error("MAX_REQUEST_MB必须是正数");
await fs.mkdir(dataDir, { recursive: true });
await ensureJsonFile(historyPath, {});
const { config: reportConfig, source: reportConfigSource } = await loadReportConfig(root);
const mappingStore = new MappingStore(mappingDatabasePath);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJson(response, 200, { ok: true, service: "ad-report-workbench" });
    }
    if (!isAuthorized(request)) return requestAuthentication(response);

    if (request.method === "POST" && url.pathname === "/api/generate") {
      const body = await readJson(request);
      validateGenerateBody(body);
      const historyData = await readHistory();
      const [current, previous, sevenDay] = await Promise.all([
        readWorkbookRows(decodeDataUrl(body.files.current.data)),
        readWorkbookRows(decodeDataUrl(body.files.previous.data)),
        readWorkbookRows(decodeDataUrl(body.files.sevenDay.data)),
      ]);
      const mapping = mappingStore.asWorkbookSource();
      const previousDate = shiftDate(body.reportDate, -1);
      const report = generateDailyReport({
        current,
        previous,
        sevenDay,
        mapping,
        reportDate: body.reportDate,
        history: historyData[previousDate] ?? {},
        config: reportConfig,
      });
      if (report.validation.ok) {
        historyData[body.reportDate] = { retentionByRow: report.retentionByRow };
        await writeJsonAtomic(historyPath, historyData);
      }
      return sendJson(response, 200, report);
    }

    if (request.method === "GET" && url.pathname === "/api/mappings/status") {
      return sendJson(response, 200, mappingStore.getStatus());
    }

    if (request.method === "POST" && url.pathname === "/api/mappings/import-preview") {
      const body = await readJson(request);
      const source = await readWorkbookRows(decodeDataUrl(body.file.data));
      const filename = safeImportFilename(body.file.name);
      const preview = mappingStore.previewImport(source, filename);
      const token = crypto.randomUUID();
      pendingMappingImports.set(token, { source, filename, createdAt: Date.now() });
      cleanupMappingImports();
      return sendJson(response, 200, { token, ...preview });
    }

    if (request.method === "POST" && url.pathname === "/api/mappings/import-confirm") {
      const body = await readJson(request);
      const pending = pendingMappingImports.get(String(body.token));
      if (!pending) return sendJson(response, 404, { error: "本次导入预览已失效，请重新选择匹配表。" });
      pendingMappingImports.delete(String(body.token));
      return sendJson(response, 200, mappingStore.importWorkbook(pending.source, pending.filename));
    }

    if (request.method === "POST" && url.pathname === "/api/mappings/save") {
      const body = await readJson(request);
      return sendJson(response, 200, mappingStore.saveMappings(body.mappings));
    }

    if (request.method === "POST" && url.pathname === "/api/prepare-download") {
      const body = await readJson(request);
      const content = decodeDataUrl(body.data);
      if (!content.length || content.length > 12 * 1024 * 1024) throw new Error("图片数据无效或超过12MB");
      const token = crypto.randomUUID();
      const filename = safeFilename(body.filename || "日报.png");
      pendingDownloads.set(token, { content, filename, createdAt: Date.now() });
      cleanupDownloads();
      return sendJson(response, 200, { url: `/api/download/${token}` });
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/download/")) {
      const token = url.pathname.split("/").pop();
      const prepared = pendingDownloads.get(token);
      if (!prepared) return sendJson(response, 404, { error: "下载已失效，请重新点击下载" });
      pendingDownloads.delete(token);
      writeHead(response, 200, {
        "Content-Type": "image/png",
        "Content-Length": prepared.content.length,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(prepared.filename)}`,
        "Cache-Control": "no-store",
      });
      return response.end(prepared.content);
    }

    if (request.method === "GET") {
      const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const filePath = safePublicPath(relative);
      const content = await fs.readFile(filePath);
      writeHead(response, 200, {
        "Content-Type": mime(filePath),
        "Cache-Control": path.extname(filePath) === ".html" ? "no-store" : "public, max-age=3600",
      });
      return response.end(content);
    }
    writeHead(response, 405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
  } catch (error) {
    console.error(error);
    if (response.headersSent) return response.end();
    sendJson(response, error.statusCode || (error.code === "ENOENT" ? 404 : 500), { error: error.message || "服务器错误" });
  }
});

server.listen(port, host, () => {
  console.log(`广告日报自动化工作台已启动：http://${host}:${port}`);
  console.log(`数据目录：${dataDir}`);
  console.log(`规则来源：${reportConfigSource}`);
  if (!appPassword) console.warn("当前未设置APP_PASSWORD，仅适合本机开发使用。");
});

async function readJson(request) {
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxRequestBytes) throw httpError(413, `上传文件总大小超过${maxRequestMb}MB`);
    chunks.push(chunk);
  }
  if (!chunks.length) throw new Error("请求内容为空");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求内容不是有效JSON");
  }
}

function decodeDataUrl(data) {
  const value = String(data || "");
  const separator = value.indexOf(",");
  if (separator < 0 || !value.slice(0, separator).includes(";base64")) throw new Error("上传文件编码无效");
  const encoded = value.slice(separator + 1);
  return Buffer.from(encoded, "base64");
}

function safeFilename(value) {
  const cleaned = String(value).replace(/[\\/:*?"<>|\r\n]/g, "-").trim();
  return cleaned.endsWith(".png") ? cleaned : `${cleaned || "日报"}.png`;
}

function safeImportFilename(value) {
  return String(value || "匹配表.xlsx").replace(/[\\/:*?"<>|\r\n]/g, "-").trim().slice(0, 180) || "匹配表.xlsx";
}

function cleanupDownloads() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [token, item] of pendingDownloads) {
    if (item.createdAt < cutoff) pendingDownloads.delete(token);
  }
}

function cleanupMappingImports() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [token, item] of pendingMappingImports) {
    if (item.createdAt < cutoff) pendingMappingImports.delete(token);
  }
}

function sendJson(response, status, value) {
  writeHead(response, status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function writeHead(response, status, headers = {}) {
  response.writeHead(status, {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...headers,
  });
}

function isAuthorized(request) {
  if (!appPassword) return true;
  const authorization = String(request.headers.authorization || "");
  if (!authorization.startsWith("Basic ")) return false;
  let username = "";
  let password = "";
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    username = decoded.slice(0, separator);
    password = decoded.slice(separator + 1);
  } catch {
    return false;
  }
  return safeEqual(username, appUsername) && safeEqual(password, appPassword);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requestAuthentication(response) {
  writeHead(response, 401, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "WWW-Authenticate": 'Basic realm="Ad Report Workbench", charset="UTF-8"',
  });
  response.end("需要登录后访问");
}

function validateGenerateBody(body) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body?.reportDate || ""))) throw new Error("日报日期无效");
  for (const key of ["current", "previous", "sevenDay"]) {
    if (!body?.files?.[key]?.data) throw new Error("请上传完整的三份数据文件");
  }
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safePublicPath(relative) {
  const normalized = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, "");
  const resolved = path.resolve(publicDir, normalized);
  if (resolved !== publicDir && !resolved.startsWith(`${publicDir}${path.sep}`)) throw new Error("请求路径无效");
  return resolved;
}

async function ensureJsonFile(filePath, initialValue) {
  try {
    await fs.access(filePath);
  } catch {
    await writeJsonAtomic(filePath, initialValue);
  }
}

async function readHistory() {
  try {
    return JSON.parse(await fs.readFile(historyPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("历史数据文件损坏，请检查服务器数据目录");
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

function shutdown(signal) {
  console.log(`收到${signal}，正在关闭服务。`);
  server.close(() => {
    mappingStore.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function shiftDate(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mime(filePath) {
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" })[path.extname(filePath)] || "application/octet-stream";
}
