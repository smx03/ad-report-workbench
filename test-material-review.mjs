import assert from "node:assert/strict";
import { aggregateMaterialRows, buildMaterialReview, inferCreativeFeatures } from "./public/material-review-engine.js";
import { buildCpaSeries, directionSpendBreakdown, paginateItems, paginationTokens } from "./public/material-review-view.js";

const rows = [
  row("7547533469179641908", "外广", 500, 25, null, "荒野建造全过程 #抖音精选", "task-a"),
  row("7547533469179641908", "外广", 500, 25, 25, "荒野建造全过程 #抖音精选", "task-a"),
  row("7561731382671605823", "外广", 1500, 20, 10, "一口气看完优质影视解说", "task-b"),
  row("7660085379745775616", "外广", 200, 20, 15, "学会三个实用知识技巧", "task-c"),
  row("7564378344189526062", "外广", 800, 0, null, "轻松发现优质内容", "task-d"),
  row("7648912854939910178", "外广", 10, 0, null, "普通内容", "task-e"),
];

const aggregated = aggregateMaterialRows(rows);
assert.equal(aggregated.length, 5);
const repeated = aggregated.find((item) => item.materialId === "7547533469179641908");
assert.equal(repeated.materialId, "7547533469179641908");
assert.equal(repeated.sourceRows, 2);
assert.equal(repeated.spend, 1000);
assert.equal(repeated.conversions, 50);
assert.equal(repeated.retentionRate, 1, "missing retention cells must not be treated as zero");

const review = buildMaterialReview(rows, {
  targets: { 外广: 30 },
  minSpend: 100,
  minConversions: 5,
  weeklyCapacity: 17,
});

assert.equal(review.summary.sourceRows, 6);
assert.equal(review.summary.totalMaterials, 5);
assert.equal(review.summary.totalSpend, 3510);
assert.equal(review.summary.totalConversions, 90);
assert.equal(review.materials.find((item) => item.materialId === "7547533469179641908").classification, "跑量优质");
assert.equal(review.materials.find((item) => item.materialId === "7561731382671605823").classification, "跑量待优化");
assert.equal(review.materials.find((item) => item.materialId === "7660085379745775616").classification, "高效潜力");
assert.equal(review.materials.find((item) => item.materialId === "7564378344189526062").classification, "低效观察");
assert.equal(review.materials.find((item) => item.materialId === "7648912854939910178").classification, "数据不足");
assert.equal(review.briefs.reduce((sum, item) => sum + item.quantity, 0), 17);
assert.ok(review.briefs.every((item) => item.referenceIds.every((id) => typeof id === "string")));

const page = paginateItems(Array.from({ length: 123 }, (_, index) => index + 1), 3, 50);
assert.deepEqual({ page: page.page, totalPages: page.totalPages, startIndex: page.startIndex, endIndex: page.endIndex, first: page.items[0], last: page.items.at(-1) }, { page: 3, totalPages: 3, startIndex: 100, endIndex: 123, first: 101, last: 123 });
assert.deepEqual(paginationTokens(6, 12), [1, "ellipsis", 5, 6, 7, "ellipsis", 12]);
const directions = directionSpendBreakdown(review.materials, "外广");
assert.ok(Math.abs(directions.reduce((sum, item) => sum + item.spendShare, 0) - 1) < 1e-12);
const cpaSeries = buildCpaSeries(review.materials, review.thresholds, "外广", 3);
assert.equal(cpaSeries.length, 3);
assert.ok(cpaSeries[0].spend >= cpaSeries[1].spend);
assert.equal(cpaSeries[0].targetCpa, 30);

assert.deepEqual(inferCreativeFeatures("为什么一口气看完这部影视解说？ #抖音精选"), {
  direction: "影视长内容",
  hookType: "提问悬念",
  hashtags: ["#抖音精选"],
});

const anomalyReview = buildMaterialReview([
  row("9999999999999999999", "内广", 1000, 10, 20, "知识科普", "task-z"),
], { targets: { 内广: 100 }, minSpend: 100, minConversions: 5, weeklyCapacity: 1 });
assert.equal(anomalyReview.materials[0].retentionAnomaly, true);
assert.ok(anomalyReview.warnings.some((warning) => warning.includes("次留数大于")));

console.log("素材周度复盘单元测试通过");

function row(materialId, placement, spend, conversions, nextRetained, title, taskId) {
  return {
    materialId,
    placement,
    spend,
    conversions,
    nextRetained,
    title,
    taskId,
    taskName: `任务-${taskId}`,
    videoUrl: `https://www.iesdouyin.com/share/video/${materialId}`,
    taskType: "内容",
    provider: "服务商",
    sourceSheet: `${placement}素材跑出情况`,
  };
}
