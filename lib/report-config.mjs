import fs from "node:fs/promises";
import path from "node:path";

export async function loadReportConfig(rootDir) {
  const encoded = String(process.env.REPORT_CONFIG_BASE64 || "").trim();
  const inline = String(process.env.REPORT_CONFIG_JSON || "").trim();
  const configuredPath = String(process.env.REPORT_CONFIG_PATH || "").trim();
  let source = "example";
  let text;

  if (encoded) {
    text = Buffer.from(encoded, "base64").toString("utf8");
    source = "environment-base64";
  } else if (inline) {
    text = inline;
    source = "environment-json";
  } else if (configuredPath) {
    text = await fs.readFile(path.resolve(configuredPath), "utf8");
    source = "private-file";
  } else {
    if (process.env.REQUIRE_PRIVATE_CONFIG === "true") {
      throw new Error("当前部署要求私密规则，请设置REPORT_CONFIG_BASE64环境变量。");
    }
    text = await fs.readFile(path.join(rootDir, "config", "report-rules.example.json"), "utf8");
  }

  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error("日报规则配置不是有效JSON。");
  }
  validateReportConfig(config);
  return { config: deepFreeze(config), source };
}

export function validateReportConfig(config) {
  if (!config || typeof config !== "object") throw new Error("日报规则配置不能为空。");
  const requiredFields = ["account", "accountId", "spend", "volume", "activation", "nextRetained", "sevenRetained", "impressions", "clicks"];
  for (const field of requiredFields) {
    if (!clean(config.fields?.[field])) throw new Error(`日报规则缺少fields.${field}。`);
  }
  if (!Number.isFinite(config.discountRate) || config.discountRate <= 0) throw new Error("discountRate必须是正数。");
  if (!Array.isArray(config.rules) || !config.rules.length) throw new Error("日报规则至少需要一条分类规则。");
  if (!Array.isArray(config.sections) || config.sections.length !== 2) throw new Error("日报规则必须定义两个输出区块。");

  const ruleIds = new Set();
  for (const rule of config.rules) {
    if (!clean(rule.id) || ruleIds.has(rule.id)) throw new Error("分类规则ID为空或重复。");
    if (!rule.match || typeof rule.match !== "object") throw new Error(`分类规则${rule.id}缺少match。`);
    ruleIds.add(rule.id);
  }

  const slots = new Set();
  const rowIds = new Set();
  for (const section of config.sections) {
    if (!["pull", "unload"].includes(section.slot) || slots.has(section.slot)) throw new Error("输出区块slot必须分别为pull和unload。");
    if (!clean(section.title) || !Array.isArray(section.rows) || !section.rows.length) throw new Error(`输出区块${section.slot}配置不完整。`);
    slots.add(section.slot);
    for (const row of section.rows) {
      if (!clean(row.id) || rowIds.has(row.id)) throw new Error("输出行ID为空或重复。");
      for (const groupId of row.groupIds ?? []) {
        if (!ruleIds.has(groupId)) throw new Error(`输出行${row.id}引用了未知规则${groupId}。`);
      }
      for (const groupId of row.sevenRetentionGroupIds ?? []) {
        if (!ruleIds.has(groupId)) throw new Error(`输出行${row.id}引用了未知七留规则${groupId}。`);
      }
      rowIds.add(row.id);
    }
    if (!rowIds.has(section.overallRowId)) throw new Error(`输出区块${section.slot}缺少有效overallRowId。`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function clean(value) {
  return String(value ?? "").trim();
}
