import assert from "node:assert/strict";
import { buildHourlyReports } from "./public/hourly-engine.js";
import { generateDailyReport } from "./public/report-engine.js";
import { REPORT_CONFIG } from "./public/report-config.js";

testDailyReport();
testHourlyReport();
console.log("纯前端单元测试通过");

function testDailyReport() {
  const current = source([dataRow("1001", "拉新账户", 100, 20, 10, 0, 0, 1000, 100), dataRow("1002", "卸载账户", 50, 9, 5, 0, 0, 500, 50)]);
  const previous = source([dataRow("1001", "拉新账户", 80, 16, 8, 4, 0, 800, 80), dataRow("1002", "卸载账户", 40, 8, 4, 1, 0, 400, 40)]);
  const sevenDay = source([dataRow("1001", "拉新账户", 0, 0, 5, 0, 2, 0, 0), dataRow("1002", "卸载账户", 0, 0, 2, 0, 1, 0, 0)]);
  const mapping = mappingSource([
    mappingRow("1001", "拉新账户", "拉新", "穿山甲", "穿山甲-每留", "and"),
    mappingRow("1002", "卸载账户", "卸载", "dsp2", "dsp2-卸载-每留", "and"),
  ]);
  const report = generateDailyReport({ current, previous, sevenDay, mapping, reportDate: "2026-07-19", config: { ...REPORT_CONFIG, validation: { minMappingCoverage: 1 } } });
  assert.equal(report.validation.ok, true);
  const pull = report.pull.rows.find((row) => row.id === "pull:overall").metrics;
  assert.equal(pull.spend, 100);
  assert.equal(pull.discountedSpend, 80);
  assert.equal(pull.volume, 20);
  assert.equal(pull.bookCost, 5);
  assert.equal(pull.discountedCost, 4);
  assert.equal(pull.retention, 0.5);
  assert.equal(pull.sevenRetention, 0.4);
}

function testHourlyReport() {
  const rows = [];
  for (const [date, spend, activations, retained] of [["2026-07-18", 80, 8, 2], ["2026-07-19", 100, 10, 3], ["2026-07-20", 120, 12, 0]]) {
    rows.push({ "时间-天": date, "时间-小时": `${date} 10:00:00`, "备注": "穿山甲-and-每留", "消耗": spend, "激活数": activations, "展示数": 1000, "点击数": 100, "次留数": retained });
  }
  const report = buildHourlyReports(rows, "2026-07-20", 18);
  const pull = report.pull.rows.find((row) => row.style === "overall").metrics;
  assert.equal(pull.spend, 120);
  assert.equal(pull.volume, 12);
  assert.equal(pull.discountSpend, 96);
  assert.ok(Math.abs(pull.volumeChange - 0.2) < 1e-12);
  assert.ok(Math.abs(pull.retentionChange - 0.05) < 1e-12);
}

function source(rows) { return { sheetName: "数据", headers: ["账户", "账户id", "消耗", "转化数", "激活数", "次留数", "7日留存数", "展示数", "点击数"], rows }; }
function dataRow(id, account, spend, volume, activations, nextRetained, sevenRetained, impressions, clicks) { return { "账户": account, "账户id": id, "消耗": spend, "转化数": volume, "激活数": activations, "次留数": nextRetained, "7日留存数": sevenRetained, "展示数": impressions, "点击数": clicks }; }
function mappingSource(rows) { return { sheetName: "账户分类库", headers: ["账户", "账户id", "推广目的", "联盟分类", "报表分类", "设备", "备注", "账户标签"], rows }; }
function mappingRow(id, account, purpose, alliance, reportClass, device) { return { "账户": account, "账户id": id, "推广目的": purpose, "联盟分类": alliance, "报表分类": reportClass, "设备": device, "备注": "", "账户标签": "" }; }
