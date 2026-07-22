export const HOURLY_CLIENT_TARGETS = Object.freeze({
  costs: Object.freeze({ dsp1: 7.5, dsp2: 7 }),
  retention: 0.34,
});

const SERIES = [
  { kind: "pull", kindLabel: "拉新", channel: "dsp1" },
  { kind: "pull", kindLabel: "拉新", channel: "dsp2" },
  { kind: "unload", kindLabel: "卸载", channel: "dsp1" },
  { kind: "unload", kindLabel: "卸载", channel: "dsp2" },
];

export function buildHourlyTargetRows(report, targets = HOURLY_CLIENT_TARGETS) {
  return SERIES.map((series) => {
    const metrics = findChannelMetrics(report?.[series.kind]?.rows ?? [], series.kind, series.channel);
    return {
      ...series,
      label: `${series.kindLabel} ${series.channel.toUpperCase()}`,
      metrics,
      costTarget: targets.costs[series.channel],
      retentionTarget: targets.retention,
    };
  });
}

export function assessHourlyTarget(actual, target, kind) {
  if (!Number.isFinite(actual) || !Number.isFinite(target)) return { pass: false, label: "暂无数据", text: "无法与目标比较" };
  const delta = actual - target;
  const pass = kind === "cost" ? delta <= 0 : delta >= 0;
  const distance = kind === "cost" ? `${Math.abs(delta).toFixed(2)}元` : `${(Math.abs(delta) * 100).toFixed(2)}个百分点`;
  return {
    pass,
    label: pass ? "已达标" : "待优化",
    text: `${delta <= 0 ? "低于" : "高于"}目标${distance}`,
  };
}

export function renderHourlyTargetDashboard({ report, summary, costChart, retentionChart, volumeChart }) {
  if (!report) return;
  const rows = buildHourlyTargetRows(report);
  const totalVolume = rows.reduce((sum, row) => sum + finite(row.metrics?.volume), 0);
  const maxVolume = Math.max(...rows.map((row) => finite(row.metrics?.volume)), 1);

  summary.innerHTML = rows.map(renderSummary).join("");
  costChart.innerHTML = rows.map((row) => renderTargetBar(row, "cost")).join("");
  retentionChart.innerHTML = rows.map((row) => renderTargetBar(row, "retention")).join("");
  volumeChart.innerHTML = rows.map((row) => renderVolumeBar(row, totalVolume, maxVolume)).join("");
}

function findChannelMetrics(rows, kind, channel) {
  const preferredStyle = kind === "pull" ? "channel-total" : "device-summary";
  return rows.find((row) => row.channel === channel && row.style === preferredStyle)?.metrics ?? null;
}

function renderSummary(row) {
  const cost = assessHourlyTarget(row.metrics?.discountCost, row.costTarget, "cost");
  const retention = assessHourlyTarget(row.metrics?.realtimeRetention, row.retentionTarget, "retention");
  const pass = cost.pass && retention.pass;
  const status = pass ? "成本、次留均达标" : !cost.pass && !retention.pass ? "成本、次留均待优化" : cost.pass ? "次留待优化" : "成本待优化";
  return `<div class="target-summary-item ${pass ? "pass" : "attention"}">
    <div><span>${row.kindLabel} · ${row.channel.toUpperCase()}</span><strong>${status}</strong></div>
    <p>折后成本 ${money(row.metrics?.discountCost)} / ${row.costTarget.toFixed(2)}元 · 次留 ${rate(row.metrics?.realtimeRetention)} / 34.00%</p>
  </div>`;
}

function renderTargetBar(row, kind) {
  const actual = kind === "cost" ? row.metrics?.discountCost : row.metrics?.realtimeRetention;
  const target = kind === "cost" ? row.costTarget : row.retentionTarget;
  const assessment = assessHourlyTarget(actual, target, kind);
  const max = Math.max(finite(actual), finite(target)) * 1.2 || 1;
  const actualWidth = Math.min(100, finite(actual) / max * 100);
  const targetLeft = Math.min(100, finite(target) / max * 100);
  const actualText = kind === "cost" ? `${money(actual)}元` : rate(actual);
  const targetText = kind === "cost" ? `≤ ${target.toFixed(2)}元` : `≥ ${(target * 100).toFixed(2)}%`;
  const metricLabel = kind === "cost" ? "折后成本" : "实时次留";
  return `<div class="target-bar-row ${assessment.pass ? "pass" : "attention"}">
    <div class="target-bar-label"><strong>${row.kindLabel}</strong><span>${row.channel.toUpperCase()}</span></div>
    <div class="target-track" role="img" aria-label="${row.label}${metricLabel}：实际${actualText}，目标${targetText}">
      <i class="target-marker" style="left:${targetLeft}%"><b>目标</b></i>
      <span class="target-actual" style="width:${actualWidth}%"></span>
    </div>
    <div class="target-bar-result"><strong>${assessment.label}</strong><span>${assessment.text}</span></div>
  </div>`;
}

function renderVolumeBar(row, totalVolume, maxVolume) {
  const volume = finite(row.metrics?.volume);
  const share = totalVolume ? volume / totalVolume : 0;
  const change = row.metrics?.volumeChange;
  const changeText = Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${(change * 100).toFixed(2)}%` : "暂无环比";
  return `<div class="hourly-volume-row">
    <div class="target-bar-label"><strong>${row.kindLabel}</strong><span>${row.channel.toUpperCase()}</span></div>
    <div class="hourly-volume-track" role="img" aria-label="${row.label}量级${Math.round(volume).toLocaleString("zh-CN")}，占总量${(share * 100).toFixed(1)}%">
      <span style="width:${Math.max(volume ? 2 : 0, volume / maxVolume * 100)}%"></span>
    </div>
    <div class="hourly-volume-result"><strong>${Math.round(volume).toLocaleString("zh-CN")}</strong><span>占比 ${(share * 100).toFixed(1)}% · 环比 ${changeText}</span></div>
  </div>`;
}

function money(value) { return Number.isFinite(value) ? value.toFixed(2) : "#DIV/0!"; }
function rate(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "#DIV/0!"; }
function finite(value) { return Number.isFinite(value) ? value : 0; }
