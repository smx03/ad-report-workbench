const SHEETS = { pull: "时报拉新-2606", unload: "时报卸载-2606" };
const REPORT_BATCHES = [
  { id: "morning", label: "第一批", hours: [11, 12] },
  { id: "evening", label: "第二批", hours: [18, 19] },
  { id: "night", label: "第三批", hours: [20, 21, 22] },
];
const LAYOUT = {
  pull: [
    row("dsp1", "and", "每留"), row("dsp1", "and", "七留"), row("dsp1", "and", "汇总"),
    row("dsp1", "ios", "每留"), row("dsp1", "ios", "七留"), row("dsp1", "ios", "汇总"),
    row("dsp1", "all", "合计"), row("dsp2", "and", "每留"), row("dsp2", "and", "七留"),
    row("dsp2", "and", "汇总"), row("dsp2", "all", "合计"), row("all", "all", "汇总"),
  ],
  unload: [
    row("dsp1", "and", "每留"), row("dsp1", "and", "七留"), row("dsp1", "and", "汇总"),
    row("dsp2", "and", "每留"), row("dsp2", "and", "七留"), row("dsp2", "and", "汇总"),
    row("all", "all", "合计"),
  ],
};

export function extractHourlyHistory(workbook) {
  const snapshots = {};
  for (const kind of ["pull", "unload"]) {
    const sheet = workbook.getWorksheet(SHEETS[kind]);
    if (!sheet) throw new Error(`历史工作簿缺少“${SHEETS[kind]}”`);
    scanSide(sheet, kind, { date: 1, hour: 2, title: 3, metricsStart: 5 }, snapshots);
    scanSide(sheet, kind, { date: 16, hour: 17, title: 18, metricsStart: 20 }, snapshots);
  }
  return snapshots;
}

export function snapshotFromReport(report) {
  return {
    reportDate: report.reportDate,
    cutoffHour: report.cutoffHour,
    pull: compact(report.pull),
    unload: compact(report.unload),
  };
}

export function historyKey(date, hour) { return `${date}|${hour}`; }

export function findComparisonSnapshot(history, date, hour) {
  const batch = REPORT_BATCHES.find((item) => item.hours.includes(hour));
  if (!batch) return null;
  const candidates = Object.entries(history).flatMap(([key, snapshot]) => {
    const [snapshotDate, snapshotHour] = key.split("|");
    const parsedHour = Number(snapshotHour);
    return snapshotDate === date && batch.hours.includes(parsedHour) && snapshot?.pull && snapshot?.unload
      ? [{ snapshot, hour: parsedHour, exact: parsedHour === hour, batch }]
      : [];
  });
  candidates.sort((left, right) => Math.abs(left.hour - hour) - Math.abs(right.hour - hour) || left.hour - right.hour);
  return candidates[0] ?? null;
}

export function reportBatchForHour(hour) {
  return REPORT_BATCHES.find((item) => item.hours.includes(hour)) ?? null;
}

function scanSide(sheet, kind, columns, snapshots) {
  let currentDate = "";
  for (let rowIndex = 1; rowIndex <= sheet.rowCount; rowIndex += 1) {
    const dateValue = unwrap(sheet.getRow(rowIndex).getCell(columns.date).value);
    const normalizedDate = excelDate(dateValue);
    if (normalizedDate) currentDate = normalizedDate;
    const title = String(unwrap(sheet.getRow(rowIndex).getCell(columns.title).value) ?? "").trim();
    const spendHeader = String(unwrap(sheet.getRow(rowIndex).getCell(columns.metricsStart).value) ?? "").trim();
    if (title !== (kind === "pull" ? "拉新" : "卸载") || spendHeader !== "消耗" || !currentDate) continue;
    const hour = excelHour(unwrap(sheet.getRow(rowIndex).getCell(columns.hour).value));
    if (!hour) continue;
    const rows = LAYOUT[kind].map((definition, offset) => {
      const source = sheet.getRow(rowIndex + offset + 1);
      return {
        id: `${kind}:${definition.channel}:${definition.device}:${definition.assessment}`,
        metrics: {
          volume: numeric(source.getCell(columns.metricsStart + 2).value),
          discountCost: numeric(source.getCell(columns.metricsStart + 5).value),
          realtimeRetention: numeric(source.getCell(columns.metricsStart + 7).value),
        },
      };
    });
    const key = historyKey(currentDate, hour);
    snapshots[key] ??= { reportDate: currentDate, cutoffHour: hour };
    snapshots[key][kind] = { rows };
  }
}

function compact(report) {
  return { rows: report.rows.map((row) => ({ id: row.id, metrics: { volume: row.metrics.volume, discountCost: row.metrics.discountCost, realtimeRetention: row.metrics.realtimeRetention } })) };
}
function row(channel, device, assessment) { return { channel, device, assessment }; }
function unwrap(value) { return value && typeof value === "object" && "result" in value ? value.result : value; }
function numeric(value) { const parsed = Number(unwrap(value)); return Number.isFinite(parsed) ? parsed : null; }
function excelHour(value) {
  if (value instanceof Date) return value.getUTCHours();
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return number > 0 && number <= 1 ? Math.round(number * 24) : Math.round(number);
}
function excelDate(value) {
  if (value instanceof Date) return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  const number = Number(value);
  if (Number.isFinite(number) && number > 40000) {
    const date = new Date(Math.round((number - 25569) * 86400000));
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }
  const match = String(value ?? "").match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  return match ? `${match[1]}-${pad(match[2])}-${pad(match[3])}` : "";
}
function pad(value) { return String(value).padStart(2, "0"); }
