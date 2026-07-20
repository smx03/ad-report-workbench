const REQUIRED_HEADERS = ["时间-天", "时间-小时", "备注", "消耗", "激活数", "展示数", "点击数", "次留数"];
const EMPTY = Object.freeze({ spend: 0, activations: 0, impressions: 0, clicks: 0, retained: 0 });

export function buildHourlyReports(rows, reportDate, cutoffHour = 18, comparisonSnapshot = null) {
  validateRows(rows, reportDate, cutoffHour);
  const currentDate = normalizeDate(reportDate);
  const previousDate = shiftDate(currentDate, -1);
  const twoDaysAgo = shiftDate(currentDate, -2);
  const normalized = rows.map(normalizeRow).filter((row) => row.date);
  const definitions = {
    pull: [
      channel("dsp1", [device("and"), device("ios", "IOS")]),
      channel("dsp2", [device("and")]),
    ],
    unload: [channel("dsp1", [device("and")]), channel("dsp2", [device("and")])],
  };
  const report = {
    reportDate: currentDate,
    cutoffHour,
    sourceRows: normalized.length,
    availableDates: [...new Set(normalized.map((row) => row.date))].sort(),
    pull: buildReport("pull", definitions.pull, normalized, currentDate, previousDate, twoDaysAgo, cutoffHour),
    unload: buildReport("unload", definitions.unload, normalized, currentDate, previousDate, twoDaysAgo, cutoffHour),
  };
  if (comparisonSnapshot) applyHistoricalComparisons(report, comparisonSnapshot);
  report.comparisonSource = comparisonSnapshot ? "history" : "source";
  return report;
}

export function availableHourlyDates(rows) {
  return [...new Set(rows.map((row) => normalizeDate(row["时间-天"])).filter(Boolean))].sort();
}

export function assertHourlyHeaders(headers) {
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`源表缺少表头：${missing.join("、")}`);
}

function buildReport(kind, channels, rows, currentDate, previousDate, twoDaysAgo, cutoffHour) {
  const output = [];
  for (const definition of channels) {
    const channelRows = [];
    for (const deviceDefinition of definition.devices) {
      const each = calculateLeaf(rows, { kind, channel: definition.id, device: deviceDefinition.id, assessment: "每留" }, currentDate, previousDate, twoDaysAgo, cutoffHour);
      const seven = calculateLeaf(rows, { kind, channel: definition.id, device: deviceDefinition.id, assessment: "七留" }, currentDate, previousDate, twoDaysAgo, cutoffHour);
      channelRows.push(
        reportRow(kind, definition.id, deviceDefinition.id, deviceDefinition.label, "每留", "leaf", each),
        reportRow(kind, definition.id, deviceDefinition.id, deviceDefinition.label, "七留", "leaf", seven),
        reportRow(kind, definition.id, deviceDefinition.id, deviceDefinition.label, "汇总", "device-summary", combineMetrics([each, seven])),
      );
    }
    const total = combineMetrics(channelRows.filter((row) => row.style === "leaf").map((row) => row.metrics));
    output.push(...channelRows);
    if (kind === "pull") output.push(reportRow(kind, definition.id, "all", "", "合计", "channel-total", total));
  }
  output.push(reportRow(kind, "all", "all", "", kind === "pull" ? "汇总" : "合计", "overall", combineMetrics(output.filter((row) => row.style === "leaf").map((row) => row.metrics))));
  return { kind, rows: output };
}

function applyHistoricalComparisons(report, snapshot) {
  for (const kind of ["pull", "unload"]) {
    const baselines = new Map((snapshot[kind]?.rows ?? []).map((row) => [row.id, row.metrics]));
    for (const row of report[kind].rows) {
      const baseline = baselines.get(row.id);
      if (!baseline) continue;
      row.metrics.volumeChange = ratioChange(row.metrics.volume, baseline.volume);
      row.metrics.costChange = kind === "unload"
        ? legacyUnloadCostChange(row, baselines)
        : ratioChange(row.metrics.discountCost, baseline.discountCost);
      row.metrics.retentionChange = ratioChange(row.metrics.realtimeRetention, baseline.realtimeRetention);
    }
  }
}

// The 2606 unload template's cost comparison is shifted by one group. Preserve it so generated images match the sent report.
function legacyUnloadCostChange(row, baselines) {
  const baselineIds = {
    "unload:dsp2:and:每留": "unload:dsp1:and:每留",
    "unload:dsp2:and:汇总": "unload:dsp1:and:汇总",
    "unload:all:all:合计": "unload:dsp2:and:汇总",
  };
  if (row.id === "unload:dsp1:and:汇总") {
    row.metrics.costChangeError = "#VALUE!";
    return null;
  }
  const baselineId = baselineIds[row.id];
  return baselineId ? ratioChange(row.metrics.discountCost, baselines.get(baselineId)?.discountCost) : null;
}

function reportRow(kind, channelId, deviceId, deviceLabel, assessment, style, metrics) {
  return { id: `${kind}:${channelId}:${deviceId}:${assessment}`, channel: channelId === "all" ? "" : channelId, device: deviceLabel, assessment, style, metrics };
}

function calculateLeaf(rows, filter, currentDate, previousDate, twoDaysAgo, cutoffHour) {
  const selected = rows.filter((row) => matches(row, filter));
  const current = sum(selected.filter((row) => row.date === currentDate));
  const previousComparable = sum(selected.filter((row) => row.date === previousDate));
  const previousFull = sum(selected.filter((row) => row.date === previousDate));
  const twoDaysFull = sum(selected.filter((row) => row.date === twoDaysAgo));
  const twoDaysRetentionComparable = twoDaysFull;
  return metricsFromPeriods(current, previousComparable, previousFull, twoDaysFull, twoDaysRetentionComparable);
}

function combineMetrics(items) {
  const periods = ["current", "previousComparable", "previousFull", "twoDaysFull", "twoDaysRetentionComparable"];
  const combined = Object.fromEntries(periods.map((period) => [period, sumMetrics(items.map((item) => item.periods[period]))]));
  return metricsFromPeriods(combined.current, combined.previousComparable, combined.previousFull, combined.twoDaysFull, combined.twoDaysRetentionComparable);
}

function metricsFromPeriods(current, previousComparable, previousFull, twoDaysFull, twoDaysRetentionComparable) {
  const discountSpend = current.spend * 0.8;
  const previousDiscountCost = divide(previousComparable.spend * 0.8, previousComparable.activations);
  const discountCost = divide(discountSpend, current.activations);
  const realtimeRetention = divide(previousFull.retained, previousFull.activations);
  const comparisonRetention = divide(twoDaysRetentionComparable.retained, twoDaysFull.activations);
  return {
    spend: current.spend,
    discountSpend,
    volume: current.activations,
    volumeChange: ratioChange(current.activations, previousComparable.activations),
    accountCost: divide(current.spend, current.activations),
    discountCost,
    costChange: ratioChange(discountCost, previousDiscountCost),
    realtimeRetention,
    retentionChange: realtimeRetention != null && comparisonRetention != null ? realtimeRetention - comparisonRetention : null,
    ctr: divide(current.clicks, current.impressions),
    conversionRate: divide(current.activations, current.clicks),
    periods: { current, previousComparable, previousFull, twoDaysFull, twoDaysRetentionComparable },
  };
}

function matches(row, filter) {
  const unload = row.remark.includes("卸载");
  if ((filter.kind === "unload") !== unload) return false;
  const channel = row.remarkLower.includes("dsp2") ? "dsp2" : (row.remarkLower.includes("穿山甲") || row.remarkLower.includes("dsp1") ? "dsp1" : "");
  return channel === filter.channel && row.device === filter.device && row.assessment === filter.assessment;
}

function normalizeRow(row) {
  const remark = String(row["备注"] ?? "").trim();
  const lower = remark.toLowerCase();
  return {
    date: normalizeDate(row["时间-天"]),
    hour: normalizeHour(row["时间-小时"]),
    remark,
    remarkLower: lower,
    device: /(?:^|-)ios(?:-|$)/i.test(remark) ? "ios" : /(?:^|-)(?:hm|harmony)(?:-|$)/i.test(remark) ? "harmony" : "and",
    assessment: remark.includes("七留") ? "七留" : "每留",
    spend: number(row["消耗"]),
    activations: number(row["激活数"]),
    impressions: number(row["展示数"]),
    clicks: number(row["点击数"]),
    retained: number(row["次留数"]),
  };
}

function validateRows(rows, reportDate, cutoffHour) {
  if (!rows.length) throw new Error("源表没有可读取的数据行");
  if (!reportDate) throw new Error("请选择时报日期");
  if (!Number.isInteger(cutoffHour) || cutoffHour < 1 || cutoffHour > 24) throw new Error("截止时刻应为1:00至24:00");
  const dates = availableHourlyDates(rows);
  if (!dates.includes(reportDate)) throw new Error(`源表不包含${shortDate(reportDate)}的数据`);
  const previousDate = shiftDate(reportDate, -1);
  if (!dates.includes(previousDate)) throw new Error(`计算实时次留还需要${shortDate(previousDate)}的数据`);
}

function sum(rows) { return sumMetrics(rows); }
function sumMetrics(rows) {
  return rows.reduce((total, row) => ({
    spend: total.spend + number(row.spend), activations: total.activations + number(row.activations),
    impressions: total.impressions + number(row.impressions), clicks: total.clicks + number(row.clicks), retained: total.retained + number(row.retained),
  }), { ...EMPTY });
}
function channel(id, devices) { return { id, devices }; }
function device(id, label = id) { return { id, label }; }
function divide(numerator, denominator) { return denominator ? numerator / denominator : null; }
function ratioChange(current, previous) { return current != null && previous ? current / previous - 1 : null; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function normalizeHour(value) {
  if (value instanceof Date) return value.getUTCHours();
  if (typeof value === "number" && value >= 0 && value < 1) return Math.floor(value * 24);
  const match = String(value ?? "").match(/(?:\s|^)(\d{1,2}):\d{2}/);
  return match ? Number(match[1]) : NaN;
}
function normalizeDate(value) {
  if (value instanceof Date) return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  if (typeof value === "number") { const date = new Date(Math.round((value - 25569) * 86400000)); return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`; }
  const match = String(value ?? "").match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  return match ? `${match[1]}-${pad(match[2])}-${pad(match[3])}` : "";
}
function shiftDate(value, days) { const date = new Date(`${value}T12:00:00`); date.setDate(date.getDate() + days); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
function shortDate(value) { const [, month, day] = value.split("-"); return `${Number(month)}月${Number(day)}日`; }
function pad(value) { return String(value).padStart(2, "0"); }
