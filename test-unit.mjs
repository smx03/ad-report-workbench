import assert from "node:assert/strict";
import { buildHourlyReports } from "./public/hourly-engine.js";
import { extractHourlyHistory, findComparisonSnapshot } from "./public/hourly-history.js";
import { assessHourlyTarget, buildHourlyTargetRows } from "./public/hourly-target-view.js";
import { generateDailyReport } from "./public/report-engine.js";
import { REPORT_CONFIG } from "./public/report-config.js";
import fs from "node:fs";

testDailyReport();
testHourlyReport();
testHourlyHistory();
testHourlyTargets();
testUploadListenerIsolation();
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
  const history = {
    pull: { rows: [{ id: "pull:all:all:汇总", metrics: { volume: 10, discountCost: 10, realtimeRetention: 0.25 } }] },
    unload: { rows: [{ id: "unload:dsp1:and:汇总", metrics: { volume: 1, discountCost: 10, realtimeRetention: 0.25 } }] },
  };
  const historicalReport = buildHourlyReports(rows, "2026-07-20", 18, history);
  const historicalPull = historicalReport.pull.rows.find((row) => row.style === "overall").metrics;
  assert.ok(Math.abs(historicalPull.volumeChange - 0.2) < 1e-12);
  assert.ok(Math.abs(historicalPull.costChange - -0.2) < 1e-12);
  assert.ok(Math.abs(historicalPull.retentionChange - 0.2) < 1e-12);
  const historicalUnload = historicalReport.unload.rows.find((row) => row.id === "unload:dsp1:and:汇总").metrics;
  assert.equal(historicalUnload.costChange, null);
  assert.equal(historicalUnload.costChangeError, "#VALUE!");
  const dateRows = [
    { "时间-天": new Date("2026-07-18T00:00:00Z"), "时间-小时": new Date("2026-07-18T19:00:00Z"), "备注": "穿山甲-and-每留", "消耗": 80, "激活数": 8, "展示数": 100, "点击数": 10, "次留数": 2 },
    { "时间-天": new Date("2026-07-19T00:00:00Z"), "时间-小时": new Date("2026-07-19T19:00:00Z"), "备注": "穿山甲-and-每留", "消耗": 100, "激活数": 10, "展示数": 100, "点击数": 10, "次留数": 3 },
    { "时间-天": new Date("2026-07-20T00:00:00Z"), "时间-小时": new Date("2026-07-20T19:00:00Z"), "备注": "穿山甲-and-每留", "消耗": 120, "激活数": 12, "展示数": 100, "点击数": 10, "次留数": 0 },
    { "时间-天": new Date("2026-07-20T00:00:00Z"), "时间-小时": new Date("2026-07-20T21:00:00Z"), "备注": "穿山甲-and-每留", "消耗": 30, "激活数": 3, "展示数": 30, "点击数": 3, "次留数": 0 },
  ];
  assert.equal(buildHourlyReports(dateRows, "2026-07-20", 21).pull.rows.at(-1).metrics.spend, 150);
  assert.equal(buildHourlyReports(dateRows, "2026-07-20", 21).unload.rows.length, 7);
}

function testHourlyHistory() {
  const workbook = fakeHistoryWorkbook();
  const history = extractHourlyHistory(workbook);
  const snapshot = history["2026-07-19|20"];
  assert.ok(snapshot?.pull);
  assert.ok(snapshot?.unload);
  assert.equal(snapshot.pull.rows.length, 12);
  assert.equal(snapshot.unload.rows.length, 7);
  assert.equal(snapshot.pull.rows[0].metrics.volume, 100);
  assert.equal(snapshot.unload.rows.at(-1).metrics.volume, 206);
  const nightFallback = findComparisonSnapshot({
    "2026-07-19|15": snapshot,
    "2026-07-19|18": snapshot,
    "2026-07-19|20": snapshot,
  }, "2026-07-19", 21);
  assert.equal(nightFallback.hour, 20);
  assert.equal(nightFallback.exact, false);
  assert.equal(findComparisonSnapshot({ "2026-07-19|15": snapshot }, "2026-07-19", 14).hour, 15);
  assert.equal(findComparisonSnapshot({ "2026-07-19|15": snapshot }, "2026-07-19", 16).hour, 15);
  assert.equal(findComparisonSnapshot({ "2026-07-19|14": snapshot, "2026-07-19|15": snapshot }, "2026-07-19", 14).hour, 14);
  const invalidSnapshot = JSON.parse(JSON.stringify(snapshot));
  invalidSnapshot.pull.rows.find((row) => row.id === "pull:all:all:汇总").metrics.volume = 0;
  assert.equal(findComparisonSnapshot({ "2026-07-19|14": invalidSnapshot, "2026-07-19|15": snapshot }, "2026-07-19", 14).hour, 15);
  assert.equal(findComparisonSnapshot({ "2026-07-19|14": invalidSnapshot }, "2026-07-19", 14), null);
  const noCrossBatchFallback = findComparisonSnapshot({
    "2026-07-19|15": snapshot,
    "2026-07-19|22": snapshot,
  }, "2026-07-19", 18);
  assert.equal(noCrossBatchFallback, null);
}

function testHourlyTargets() {
  const report = {
    pull: { rows: [targetRow("dsp1", "channel-total", 6.8, 0.35, 120, 0.1), targetRow("dsp2", "channel-total", 7.2, 0.33, 80, -0.05)] },
    unload: { rows: [targetRow("dsp1", "device-summary", 7.4, 0.34, 50, 0), targetRow("dsp2", "device-summary", 6.9, 0.36, 30, 0.2)] },
  };
  const rows = buildHourlyTargetRows(report);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].costTarget, 7.5);
  assert.equal(rows[1].costTarget, 7);
  assert.equal(rows[2].metrics.volume, 50);
  assert.equal(assessHourlyTarget(7.2, 7, "cost").text, "高于目标0.20元");
  assert.equal(assessHourlyTarget(0.33, 0.34, "retention").text, "低于目标1.00个百分点");
  assert.equal(assessHourlyTarget(0.35, 0.34, "retention").pass, true);
}

function testUploadListenerIsolation() {
  const dailyApp = fs.readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
  assert.match(dailyApp, /#daily-page \.file-slot\[data-key\]/);
  assert.match(dailyApp, /#daily-page \.file-clear\[data-clear\]/);
}

function source(rows) { return { sheetName: "数据", headers: ["账户", "账户id", "消耗", "转化数", "激活数", "次留数", "7日留存数", "展示数", "点击数"], rows }; }
function dataRow(id, account, spend, volume, activations, nextRetained, sevenRetained, impressions, clicks) { return { "账户": account, "账户id": id, "消耗": spend, "转化数": volume, "激活数": activations, "次留数": nextRetained, "7日留存数": sevenRetained, "展示数": impressions, "点击数": clicks }; }
function mappingSource(rows) { return { sheetName: "账户分类库", headers: ["账户", "账户id", "推广目的", "联盟分类", "报表分类", "设备", "备注", "账户标签"], rows }; }
function mappingRow(id, account, purpose, alliance, reportClass, device) { return { "账户": account, "账户id": id, "推广目的": purpose, "联盟分类": alliance, "报表分类": reportClass, "设备": device, "备注": "", "账户标签": "" }; }
function targetRow(channel, style, discountCost, realtimeRetention, volume, volumeChange) { return { channel, style, metrics: { discountCost, realtimeRetention, volume, volumeChange } }; }

function fakeHistoryWorkbook() {
  const sheets = new Map([
    ["时报拉新-2606", fakeHistorySheet("拉新", 12, 100)],
    ["时报卸载-2606", fakeHistorySheet("卸载", 7, 200)],
  ]);
  return { getWorksheet(name) { return sheets.get(name); } };
}

function fakeHistorySheet(title, rowCount, base) {
  const rows = Array.from({ length: rowCount + 2 }, () => Array(31).fill(null));
  rows[1][1] = new Date("2026-07-19T00:00:00Z");
  rows[1][2] = new Date("1899-12-30T20:00:00Z");
  rows[1][3] = title;
  rows[1][5] = "消耗";
  rows[1][16] = new Date("2026-07-19T00:00:00Z");
  rows[1][17] = new Date("1899-12-30T20:00:00Z");
  rows[1][18] = title;
  rows[1][20] = "消耗";
  for (let offset = 0; offset < rowCount; offset += 1) {
    rows[offset + 2][7] = base + offset;
    rows[offset + 2][10] = 5 + offset;
    rows[offset + 2][12] = 0.2 + offset / 100;
    rows[offset + 2][22] = base + offset;
    rows[offset + 2][25] = 5 + offset;
    rows[offset + 2][27] = 0.2 + offset / 100;
  }
  return {
    rowCount: rows.length - 1,
    getRow(index) { return { getCell(column) { return { value: rows[index]?.[column] ?? null }; } }; },
  };
}
