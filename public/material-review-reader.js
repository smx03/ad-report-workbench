const MATERIAL_REQUIRED_HEADERS = ["视频素材ID", "消耗", "转化数"];
const OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export async function readMaterialWorkbook(input) {
  if (!globalThis.JSZip) throw new Error("Excel解压组件未加载，请刷新页面后重试。");
  const zip = await globalThis.JSZip.loadAsync(input);
  const [workbookDoc, relationDoc, sharedStrings] = await Promise.all([
    readXml(zip, "xl/workbook.xml"),
    readXml(zip, "xl/_rels/workbook.xml.rels"),
    readSharedStrings(zip),
  ]);
  const sheets = workbookSheets(workbookDoc, relationDoc);
  const taskSheet = sheets.find((sheet) => sheet.name === "任务") || sheets.find((sheet) => /任务/.test(sheet.name));
  const taskMap = taskSheet ? await readTaskMap(zip, taskSheet, sharedStrings) : new Map();
  const providerSheet = sheets.find((sheet) => sheet.name === "星广-抖音精选")
    || sheets.find((sheet) => /星广.*抖音精选/.test(sheet.name));
  const providerMaps = providerSheet
    ? await readProviderMaps(zip, providerSheet, sharedStrings)
    : { byMaterial: new Map(), byTask: new Map() };

  let candidates = sheets.filter((sheet) => /内广|外广|素材.*跑出|跑出.*素材/.test(sheet.name));
  if (!candidates.length) candidates = sheets;
  const materialSheets = [];
  for (const sheet of candidates) {
    if (!zip.file(sheet.path)) continue;
    const parsed = await readSheetRows(zip, sheet, sharedStrings);
    if (!isMaterialHeaders(parsed.headers)) continue;
    materialSheets.push({ ...sheet, ...parsed });
  }
  if (!materialSheets.length) throw new Error("未找到素材数据页。需要包含“视频素材ID、消耗、转化数”等表头。");

  const rows = materialSheets.flatMap((sheet) => materialRows(sheet, taskMap, providerMaps));
  if (!rows.length) throw new Error("已识别素材数据页，但没有读取到有效素材记录。");
  return {
    rows,
    weekLabel: inferWeekLabel(materialSheets.map((sheet) => sheet.name)),
    sourceSheets: materialSheets.map((sheet) => ({ name: sheet.name, placement: inferPlacement(sheet.name), rowCount: sheet.rows.length })),
    workbookSheetCount: sheets.length,
  };
}

async function readSharedStrings(zip) {
  const file = zip.file("xl/sharedStrings.xml");
  if (!file) return [];
  const document = parseXml(await file.async("string"));
  return [...elements(document, "si")].map((node) => node.textContent || "");
}

function workbookSheets(workbookDoc, relationDoc) {
  const paths = new Map([...elements(relationDoc, "Relationship")].map((node) => [node.getAttribute("Id"), normalizeWorksheetPath(node.getAttribute("Target"))]));
  return [...elements(workbookDoc, "sheet")].map((node) => {
    const relationId = node.getAttributeNS(OFFICE_REL_NS, "id") || node.getAttribute("r:id");
    return { name: node.getAttribute("name") || "", path: paths.get(relationId) || "" };
  }).filter((sheet) => sheet.path);
}

async function readTaskMap(zip, sheet, sharedStrings) {
  const parsed = await readSheetRows(zip, sheet, sharedStrings);
  const columns = headerColumns(parsed.headers);
  if (!columns.has("下单任务ID") || !columns.has("任务名称")) return new Map();
  const result = new Map();
  for (const row of parsed.rows) {
    const id = textValue(row[columns.get("下单任务ID")]);
    if (!id) continue;
    result.set(id, {
      provider: textValue(row[columns.get("服务商")]),
      taskType: textValue(row[columns.get("类型")]),
      channel: textValue(row[columns.get("对应渠道号")]),
      taskName: textValue(row[columns.get("任务名称")]),
    });
  }
  return result;
}

async function readProviderMaps(zip, sheet, sharedStrings) {
  const parsed = await readSheetRows(zip, sheet, sharedStrings);
  const columns = headerColumns(parsed.headers);
  const materialColumn = columns.get("素材ID");
  const taskColumn = columns.get("任务ID");
  const providerColumn = columns.get("服务商名称") ?? columns.get("服务商");
  if (!materialColumn || !providerColumn) return { byMaterial: new Map(), byTask: new Map() };

  const byMaterial = new Map();
  const taskProviders = new Map();
  for (const row of parsed.rows) {
    const materialId = textValue(row[materialColumn]);
    const taskId = textValue(row[taskColumn]);
    const provider = textValue(row[providerColumn]);
    const supplierGroup = normalizeSupplierGroup(provider);
    if (!materialId || !provider) continue;
    if (!byMaterial.has(materialId)) byMaterial.set(materialId, { supplierGroup, provider });
    if (taskId) {
      if (!taskProviders.has(taskId)) taskProviders.set(taskId, new Map());
      taskProviders.get(taskId).set(supplierGroup, provider);
    }
  }

  const byTask = new Map();
  for (const [taskId, providers] of taskProviders) {
    if (providers.size === 1) {
      const [supplierGroup, provider] = providers.entries().next().value;
      byTask.set(taskId, { supplierGroup, provider, mixed: false });
    } else {
      byTask.set(taskId, { supplierGroup: "混合", provider: [...providers.values()].join("、"), mixed: true });
    }
  }
  return { byMaterial, byTask };
}

async function readSheetRows(zip, sheet, sharedStrings) {
  const document = await readXml(zip, sheet.path);
  const xmlRows = [...elements(document, "row")];
  if (!xmlRows.length) return { headers: [], rows: [] };
  const headerValues = rowValues(xmlRows[0], sharedStrings);
  const width = Math.max(0, ...Object.keys(headerValues).map(Number));
  const headers = Array.from({ length: width }, (_, index) => cleanHeader(headerValues[index + 1]));
  const rows = xmlRows.slice(1).map((node) => rowValues(node, sharedStrings)).filter((row) => Object.values(row).some((value) => value !== "" && value != null));
  return { headers, rows };
}

function rowValues(rowNode, sharedStrings) {
  const result = {};
  for (const cell of elements(rowNode, "c")) {
    const reference = cell.getAttribute("r") || "A1";
    const column = columnIndex(reference);
    const type = cell.getAttribute("t");
    const valueNode = elements(cell, "v")[0];
    const inlineNode = elements(cell, "is")[0];
    if (type === "s" && valueNode) result[column] = sharedStrings[Number(valueNode.textContent)] ?? "";
    else if (type === "inlineStr" && inlineNode) result[column] = inlineNode.textContent || "";
    else if (valueNode) result[column] = valueNode.textContent ?? "";
    else result[column] = "";
  }
  return result;
}

function materialRows(sheet, taskMap, providerMaps) {
  const columns = headerColumns(sheet.headers);
  const placement = inferPlacement(sheet.name);
  return sheet.rows.map((row) => {
    const materialId = textValue(row[columns.get("视频素材ID") ?? columns.get("视频id")]);
    if (!materialId) return null;
    const taskId = textValue(row[columns.get("星广主任务ID") ?? columns.get("任务id")]);
    const task = taskMap.get(taskId) || {};
    const taskName = textValue(row[columns.get("任务名称")]) || task.taskName || "";
    const supplier = resolveSupplier(materialId, taskId, task, taskName, providerMaps);
    return {
      materialId,
      videoUrl: textValue(row[columns.get("视频链接")]),
      title: textValue(row[columns.get("视频标题") ?? columns.get("抖音视频标题")]),
      taskId,
      taskName,
      placement,
      spend: numberValue(row[columns.get("消耗")]),
      conversions: numberValue(row[columns.get("转化数")]),
      reportedCpa: numberValue(row[columns.get("转化成本")]),
      nextRetained: nullableNumberValue(row[columns.get("次留数")]),
      taskType: task.taskType || "",
      provider: task.provider || "",
      channel: task.channel || "",
      supplierGroup: supplier.supplierGroup,
      supplierEvidence: supplier.supplierEvidence,
      supplierConfidence: supplier.supplierConfidence,
      priceType: inferPriceType(task.taskType, taskName),
      sourceSheet: sheet.name,
    };
  }).filter(Boolean);
}

function resolveSupplier(materialId, taskId, task, taskName, providerMaps) {
  const exact = providerMaps.byMaterial.get(materialId);
  if (exact) return {
    supplierGroup: exact.supplierGroup,
    supplierEvidence: `星广素材库按素材ID精确匹配：${exact.provider}`,
    supplierConfidence: "高",
  };

  const taskProvider = textValue(task.provider);
  if (taskProvider) return {
    supplierGroup: normalizeSupplierGroup(taskProvider),
    supplierEvidence: `任务表服务商字段：${taskProvider}`,
    supplierConfidence: taskProvider.includes("混合") ? "待核验" : "高",
  };

  const historical = providerMaps.byTask.get(taskId);
  if (historical) return {
    supplierGroup: historical.supplierGroup,
    supplierEvidence: historical.mixed
      ? `该任务ID历史出现多家服务商：${historical.provider}`
      : `该任务ID在星广素材库仅出现于：${historical.provider}`,
    supplierConfidence: historical.mixed ? "待核验" : "中",
  };

  const inferred = inferSupplierFromTaskName(taskName);
  if (inferred) return {
    supplierGroup: inferred,
    supplierEvidence: `任务名称缩写推断：${taskName}`,
    supplierConfidence: "低",
  };
  return { supplierGroup: "待识别", supplierEvidence: "素材ID、任务表和历史任务均无单一服务商证据", supplierConfidence: "待核验" };
}

export function normalizeSupplierGroup(value) {
  const provider = textValue(value);
  if (!provider) return "待识别";
  if (/优矩/i.test(provider) && /禾也|禾悦/i.test(provider)) return "混合";
  if (/优矩/i.test(provider)) return "优矩";
  if (/禾也|禾悦/i.test(provider)) return "禾也/禾悦";
  if (/混合/i.test(provider)) return "混合";
  return "其他历史服务商";
}

export function inferPriceType(taskType = "", taskName = "") {
  const source = `${textValue(taskType)} ${textValue(taskName)}`;
  if (/一口价\s*[-_—]?二剪|一口价二剪|二剪.*一口价/i.test(source)) return "一口价二剪";
  if (/一口价/i.test(source)) return "一口价原素材";
  return "常规素材";
}

function inferSupplierFromTaskName(taskName) {
  const source = textValue(taskName);
  if (!source) return null;
  if (/禾也|禾悦|(?:^|[-_【\s])HY(?:[-_】\s]|$)/i.test(source)) return "禾也/禾悦";
  if (/UJU[-_x]UJU/i.test(source)) return "优矩";
  return null;
}

function isMaterialHeaders(headers) {
  return MATERIAL_REQUIRED_HEADERS.every((header) => headers.includes(header))
    && (headers.includes("视频链接") || headers.includes("视频标题") || headers.includes("抖音视频标题"));
}

function headerColumns(headers) {
  const result = new Map();
  headers.forEach((header, index) => { if (header && !result.has(header)) result.set(header, index + 1); });
  return result;
}

function elements(node, localName) {
  return [...node.getElementsByTagNameNS("*", localName)];
}

async function readXml(zip, path) {
  const file = zip.file(path);
  if (!file) throw new Error(`Excel内部缺少${path}`);
  return parseXml(await file.async("string"));
}

function parseXml(text) {
  const document = new DOMParser().parseFromString(text, "application/xml");
  const error = document.querySelector("parsererror");
  if (error) throw new Error("Excel XML结构无法解析，请尝试重新导出文件。");
  return document;
}

function normalizeWorksheetPath(target) {
  const normalized = String(target || "").replace(/^\//, "");
  return normalized.startsWith("xl/") ? normalized : `xl/${normalized.replace(/^\.\//, "")}`;
}

function columnIndex(reference) {
  const letters = String(reference).match(/[A-Z]+/)?.[0] || "A";
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

function textValue(value) { return String(value ?? "").trim(); }
function numberValue(value) { const parsed = Number(String(value ?? "").replace(/[,￥¥%\s]/g, "")); return Number.isFinite(parsed) ? parsed : 0; }
function nullableNumberValue(value) { if (value == null || String(value).trim() === "") return null; const parsed = numberValue(value); return Number.isFinite(parsed) ? parsed : null; }

function inferPlacement(sheetName) {
  if (String(sheetName).includes("外广")) return "外广";
  if (String(sheetName).includes("内广")) return "内广";
  return "未分类";
}

function inferWeekLabel(sheetNames) {
  for (const name of sheetNames) {
    const match = String(name).match(/(\d{2})(\d{2})\s*[-至~—]\s*(\d{2})(\d{2})/);
    if (match) return `${match[1]}.${match[2]} - ${match[3]}.${match[4]}`;
  }
  return "本周";
}

function cleanHeader(value) { return String(value ?? "").replace(/\s+/g, "").trim(); }
