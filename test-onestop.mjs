import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildEditUrl,
  defaultDateRange,
  formatTaskText,
  normalizeDate,
  parseTaskText,
} from "./public/onestop-core.js";

testTaskParsing();
testDatesAndUrls();
testExtensionManifest();
testVersionHandshake();
testCalendarAutomationGuardrails();
testStageErrors();
testWorkbenchWiring();
console.log("一站式日期助手单元测试通过");

function testTaskParsing() {
  const tasks = parseTaskText(`
48603528 雪-dsp2-and-每留-素材监控
48319990\t雪-dsp2-and-每留-4271-4275-卸载
https://usergrowth.com.cn/onestop/ad/ad_create/edit?_app_id=482431&id=48603528
无效行
  `);
  assert.deepEqual(tasks, [
    { id: "48603528", name: "雪-dsp2-and-每留-素材监控" },
    { id: "48319990", name: "雪-dsp2-and-每留-4271-4275-卸载" },
  ]);
  assert.match(formatTaskText(tasks), /^48603528\t/);
}

function testDatesAndUrls() {
  assert.equal(normalizeDate("2026/7/2"), "2026-07-02");
  assert.deepEqual(defaultDateRange(new Date("2026-07-20T12:00:00+08:00")), { startDate: "2026-06-01", endDate: "2026-07-20" });
  assert.deepEqual(defaultDateRange(new Date("2026-03-20T12:00:00+08:00")), { startDate: "2025-06-01", endDate: "2026-03-20" });
  const editUrl = buildEditUrl("https://usergrowth.com.cn/onestop/ad/ad_create?_app_id=482431&ad_platform=toutiao&owners%5B%5D=abc", "48603528");
  assert.equal(new URL(editUrl).pathname, "/onestop/ad/ad_create/edit");
  assert.equal(new URL(editUrl).searchParams.get("id"), "48603528");
  assert.equal(new URL(editUrl).searchParams.has("owners[]"), false);
}

function testExtensionManifest() {
  const manifest = JSON.parse(fs.readFileSync(new URL("./extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.3.0");
  assert.ok(manifest.host_permissions.includes("https://usergrowth.com.cn/*"));
  assert.ok(manifest.content_scripts.some((entry) => entry.js.includes("dashboard-bridge.js")));
  assert.ok(manifest.content_scripts.some((entry) => entry.js.includes("usergrowth-content.js")));
}

function testVersionHandshake() {
  const background = fs.readFileSync(new URL("./extension/background.js", import.meta.url), "utf8");
  const content = fs.readFileSync(new URL("./extension/usergrowth-content.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("./public/onestop-app.js", import.meta.url), "utf8");
  assert.match(background, /BACKGROUND_PROTOCOL = 3/);
  assert.match(background, /EXPECTED_CONTENT_BUILD = "calendar-click-v3"/);
  assert.match(background, /CONTENT_VERSION_MISMATCH/);
  assert.match(content, /CONTENT_PROTOCOL = 3/);
  assert.match(content, /CONTENT_BUILD = "calendar-click-v3"/);
  assert.match(app, /EXPECTED_EXTENSION_PROTOCOL = 3/);
  assert.match(app, /response\.stalePages/);
}

function testCalendarAutomationGuardrails() {
  const content = fs.readFileSync(new URL("./extension/usergrowth-content.js", import.meta.url), "utf8");
  assert.match(content, /selectCalendarDate/);
  assert.match(content, /arco-picker-cell-in-view/);
  assert.match(content, /normalizeDate\(latest\.end\.value\) === targetEnd/);
  assert.doesNotMatch(content, /function setInputValue/);
}

function testStageErrors() {
  const content = fs.readFileSync(new URL("./extension/usergrowth-content.js", import.meta.url), "utf8");
  for (const code of ["AD_CONFIG_NOT_READY", "DATE_FIELDS_NOT_READY", "CALENDAR_NOT_OPENED", "DATE_NOT_ACCEPTED", "CONFIG_NOT_CLOSED", "SUBMIT_NOT_FOUND"]) {
    assert.match(content, new RegExp(code));
  }
  assert.match(content, /waitForStage/);
}

function testWorkbenchWiring() {
  const html = fs.readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  assert.match(html, /data-page="onestop"/);
  assert.match(html, /id="onestop-task-rows"/);
  assert.match(html, /src="\.\/onestop-app\.js/);
}
