import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { MappingStore } from "./lib/mapping-store.mjs";
import { generateDailyReport } from "./lib/report-engine.mjs";
import { loadReportConfig } from "./lib/report-config.mjs";
import { readWorkbookRows } from "./lib/spreadsheet-reader.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const { config } = await loadReportConfig(root);

await testSpreadsheetReader();
await testReportEngine();
await testMappingStore();
console.log("公开脱敏版单元测试通过");

async function testSpreadsheetReader() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("数据");
  sheet.addRow(["账户", "账户id", "消耗", "激活数"]);
  sheet.addRow(["测试账户", "9999999999999999", 123.45, 8]);
  const source = await readWorkbookRows(await workbook.xlsx.writeBuffer());
  assert.equal(source.sheetName, "数据");
  assert.equal(source.rows[0]["账户id"], "9999999999999999");
  assert.equal(source.rows[0]["消耗"], 123.45);
}

async function testReportEngine() {
  const current = source([
    dataRow("1001", "示例账户一", 100, 10, 0, 0, 1000, 100),
    dataRow("1002", "示例账户二", 50, 5, 0, 0, 500, 50),
  ]);
  const previous = source([
    dataRow("1001", "示例账户一", 80, 8, 4, 0, 800, 80),
    dataRow("1002", "示例账户二", 40, 4, 1, 0, 400, 40),
  ]);
  const sevenDay = source([
    dataRow("1001", "示例账户一", 0, 5, 0, 2, 0, 0),
    dataRow("1002", "示例账户二", 0, 2, 0, 1, 0, 0),
  ]);
  const mapping = mappingSource([
    mappingRow("1001", "示例账户一", "业务一", "渠道甲", "类型一", "终端A"),
    mappingRow("1002", "示例账户二", "业务二", "渠道乙", "类型一", "终端A"),
  ]);
  const report = generateDailyReport({ current, previous, sevenDay, mapping, reportDate: "2026-07-19", config });
  assert.equal(report.validation.ok, true);

  const pull = report.pull.rows.find((row) => row.id === "primary_overall").metrics;
  assert.equal(pull.spend, 100);
  assert.equal(pull.discountedSpend, 100);
  assert.equal(pull.volume, 10);
  assert.equal(pull.discountedCost, 10);
  assert.equal(pull.retention, 0.5);
  assert.equal(pull.sevenRetention, 0.4);
  assert.equal(pull.ctr, 0.1);
  assert.equal(pull.conversion, 0.1);

  const unload = report.unload.rows.find((row) => row.id === "secondary_overall").metrics;
  assert.equal(unload.spend, 50);
  assert.equal(unload.volume, 5);
  assert.equal(unload.retention, 0.25);
  assert.equal(unload.sevenRetention, 0.5);
}

async function testMappingStore() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ad-report-test-"));
  const store = new MappingStore(path.join(directory, "mapping.db"));
  try {
    const imported = store.importWorkbook(mappingSource([
      mappingRow("1001", "示例账户一", "业务一", "渠道甲", "类型一", "终端A"),
    ]), "test.xlsx");
    assert.equal(imported.inserted, 1);
    assert.equal(store.getStatus().count, 1);

    store.saveMappings([{
      accountId: "1002",
      accountName: "示例账户二",
      purpose: "业务二",
      alliance: "渠道乙",
      reportClass: "类型一",
      device: "终端A",
    }]);
    assert.equal(store.getStatus().count, 2);
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function source(rows) {
  return { sheetName: "数据", headers: ["账户", "账户id", "消耗", "转化数", "激活数", "次留数", "7日留存数", "展示数", "点击数"], rows };
}

function dataRow(id, account, spend, activations, nextRetained, sevenRetained, impressions, clicks) {
  return { "账户": account, "账户id": id, "消耗": spend, "转化数": activations, "激活数": activations, "次留数": nextRetained, "7日留存数": sevenRetained, "展示数": impressions, "点击数": clicks };
}

function mappingSource(rows) {
  return { sheetName: "账户分类库", headers: ["账户", "账户id", "推广目的", "联盟分类", "报表分类", "设备", "备注", "账户标签"], rows };
}

function mappingRow(id, account, purpose, alliance, reportClass, device) {
  return { "账户": account, "账户id": id, "推广目的": purpose, "联盟分类": alliance, "报表分类": reportClass, "设备": device, "备注": "", "账户标签": "" };
}
