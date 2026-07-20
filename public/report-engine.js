const MAPPING_HEADERS = ["账户", "账户id", "推广目的", "联盟分类", "报表分类", "设备"];

export function generateDailyReport({ current, previous, sevenDay, mapping, reportDate, history = {}, config }) {
  if (!config) throw new Error("缺少日报规则配置。");
  const validation = validateInputs({ current, previous, sevenDay, mapping, config });
  const mappingById = new Map(mapping.rows.map((row) => [normalizeId(row["账户id"]), normalizeMapping(row, config)]));
  const currentById = indexRows(current.rows, config.fields.accountId);
  const previousById = indexRows(previous.rows, config.fields.accountId);
  const sevenDayById = indexRows(sevenDay.rows, config.fields.accountId);
  const accountIds = [...new Set([...currentById.keys(), ...previousById.keys(), ...sevenDayById.keys()])]
    .filter(Boolean)
    .sort(compareIds);
  const groups = new Map();
  const unmatched = [];

  for (const id of accountIds) {
    const currentRow = currentById.get(id);
    const previousRow = previousById.get(id);
    const sevenDayRow = sevenDayById.get(id);
    const sourceRow = currentRow ?? previousRow ?? sevenDayRow;
    const classification = mappingById.get(id);
    if (!classification) {
      const periodRows = [currentRow, previousRow, sevenDayRow];
      unmatched.push({
        id,
        account: clean(sourceRow?.[config.fields.account]),
        active: periodRows.some((row) => row && activity(row, config.fields) > 0),
        spend: periodRows.reduce((sum, row) => sum + number(row?.[config.fields.spend]), 0),
        periods: {
          current: periodActivity(currentRow, config.fields),
          previous: periodActivity(previousRow, config.fields),
          sevenDay: periodActivity(sevenDayRow, config.fields),
        },
      });
      continue;
    }
    const groupId = classify(classification, sourceRow, config);
    if (!groupId) continue;
    const aggregate = groups.get(groupId) ?? emptyAggregate();
    if (currentRow) addMetrics(aggregate.current, currentRow, config.fields);
    else aggregate.missingCurrent.push(id);
    if (previousRow) addMetrics(aggregate.previous, previousRow, config.fields);
    else aggregate.missingPrevious.push(id);
    if (sevenDayRow) addMetrics(aggregate.sevenDay, sevenDayRow, config.fields);
    else aggregate.missingSevenDay.push(id);
    aggregate.accounts += 1;
    groups.set(groupId, aggregate);
  }

  const activeUnmatched = unmatched.filter((item) => item.active);
  if (unmatched.length) {
    validation.warnings.push({
      code: activeUnmatched.length ? "UNMATCHED_ACTIVE_ACCOUNTS" : "UNMATCHED_ZERO_ACCOUNTS",
      level: activeUnmatched.length ? "error" : "warning",
      message: activeUnmatched.length
        ? `${activeUnmatched.length}个有数据账户未在分类库中，已停止生成。`
        : `${unmatched.length}个零消耗账户未匹配，已排除且不影响日报。`,
      details: unmatched,
    });
  }
  if (activeUnmatched.length) validation.ok = false;

  const retentionHistory = history.retentionByRow ?? {};
  const reports = Object.fromEntries(config.sections.map((section) => [
    section.slot,
    buildSection(section, groups, retentionHistory, config.discountRate),
  ]));
  const pull = reports.pull;
  const unload = reports.unload;
  const retentionByRow = Object.fromEntries([...pull.rows, ...unload.rows].map((row) => [row.id, row.metrics.retention]));

  return {
    reportDate,
    validation,
    stats: {
      currentRows: current.rows.length,
      previousRows: previous.rows.length,
      sevenDayRows: sevenDay.rows.length,
      mappingRows: mapping.rows.length,
      accountUniverseAccounts: accountIds.length,
      matchedAccounts: accountIds.length - unmatched.length,
      unmatchedAccounts: unmatched.length,
      activeUnmatchedAccounts: activeUnmatched.length,
    },
    pull,
    unload,
    retentionByRow,
    narrative: buildNarrative(reports, config),
  };
}

function buildSection(section, groups, history, discountRate) {
  const rows = section.rows.map((definition) => {
    const aggregate = sumAggregates((definition.groupIds ?? []).map((id) => group(groups, id)));
    const metrics = calculateMetrics(aggregate, history[definition.id], discountRate, definition.options ?? {});
    if (definition.sevenRetentionGroupIds) {
      const sevenAggregate = sumAggregates(definition.sevenRetentionGroupIds.map((id) => group(groups, id)));
      metrics.sevenRetention = ratio(sevenAggregate.sevenDay.sevenRetained, sevenAggregate.sevenDay.activations);
    }
    return {
      id: definition.id,
      channel: definition.channel,
      device: definition.device,
      assessment: definition.assessment,
      style: definition.style,
      metrics,
    };
  });
  return { kind: section.slot, title: section.title, rows, overallRowId: section.overallRowId };
}

function calculateMetrics(aggregate, historicalRetention, discountRate, options = {}) {
  const current = aggregate.current;
  const previous = aggregate.previous;
  const sevenDay = aggregate.sevenDay;
  const bookCost = ratio(current.spend, current.volume);
  const discountedCost = ratio(current.spend * discountRate, current.volume);
  const previousDiscountedCost = ratio(previous.spend * discountRate, previous.volume);
  const retention = ratio(previous.nextRetained, previous.activations);
  return {
    spend: current.spend,
    discountedSpend: current.spend * discountRate,
    volume: current.volume,
    volumeChange: change(current.volume, previous.volume),
    bookCost,
    discountedCost,
    costChange: change(discountedCost, previousDiscountedCost),
    retention,
    retentionChange: change(retention, historicalRetention),
    sevenRetention: ratio(sevenDay.sevenRetained, sevenDay.activations),
    ctr: options.ctrZero ? 0 : ratio(current.clicks, current.impressions),
    conversion: ratio(current.volume, current.clicks),
  };
}

function buildNarrative(reports, config) {
  const configuredSections = config.narrative?.sections ?? config.sections.map((section) => ({ slot: section.slot, details: [] }));
  const sectionMetrics = configuredSections.map((item) => {
    const report = reports[item.slot];
    const section = config.sections.find((candidate) => candidate.slot === item.slot);
    return { item, report, overall: report.rows.find((row) => row.id === section.overallRowId).metrics };
  });
  const combined = combineMetricRows(sectionMetrics.map((item) => item.overall), config.discountRate);
  const sentences = [`昨日整体量级环比${describeChange(combined.volumeChange)}，折后成本环比${describeChange(combined.costChange)}。`];
  for (const { item, report, overall } of sectionMetrics) {
    const details = (item.details ?? []).map((detail) => {
      const metrics = report.rows.find((row) => row.id === detail.rowId)?.metrics;
      return metrics ? `${detail.label}成本${describeChange(metrics.costChange)}` : "";
    }).filter(Boolean);
    sentences.push(`${report.title}量级${describeChange(overall.volumeChange)}、折后成本${describeChange(overall.costChange)}${details.length ? `，其中${details.join("，")}` : ""}。`);
  }
  if (sectionMetrics.length) {
    const retentionLead = config.narrative?.retentionLead || "留存方面";
    sentences.push(`${retentionLead}，${sectionMetrics.map(({ report, overall }) => `${report.title}为${formatRate(overall.retention)}（环比${formatSignedRate(overall.retentionChange)}）`).join("，")}。`);
  }
  return sentences.join("");
}

function classify(mapping, sourceRow, config) {
  const accountText = `${mapping.account} ${clean(sourceRow?.[config.fields.account])}`.toLowerCase();
  if ((config.excludeAccountPatterns ?? []).some((pattern) => accountText.includes(String(pattern).toLowerCase()))) return null;
  return config.rules.find((rule) => mappingMatches(mapping, rule.match))?.id ?? null;
}

function mappingMatches(mapping, match) {
  return Object.entries(match).every(([field, expected]) => {
    const actual = mapping[field];
    return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  });
}

function normalizeMapping(row, config) {
  return {
    account: clean(row["账户"]),
    purpose: clean(row["推广目的"]),
    alliance: clean(row["联盟分类"]),
    reportClass: clean(row["报表分类"]),
    device: normalizeDevice(row["设备"], config, row["账户"], row["账户标签"], row["备注"]),
  };
}

function normalizeDevice(value, config, ...fallbacks) {
  const direct = clean(value).toLowerCase();
  for (const option of config.deviceInference ?? []) {
    if ((option.aliases ?? []).some((alias) => String(alias).toLowerCase() === direct)) return option.value;
  }
  if (direct) return clean(value);
  const combined = fallbacks.map(clean).join(" ").toLowerCase();
  for (const option of config.deviceInference ?? []) {
    if ((option.patterns ?? []).some((pattern) => combined.includes(String(pattern).toLowerCase()))) return option.value;
  }
  return "";
}

function validateInputs({ current, previous, sevenDay, mapping, config }) {
  const warnings = [];
  const sourceHeaders = [...new Set(Object.values(config.fields))];
  const sources = [
    ["日报日", current, sourceHeaders],
    ["前一日", previous, sourceHeaders],
    ["七日前", sevenDay, sourceHeaders],
  ];
  for (const [label, source, required] of [...sources, ["分类库", mapping, MAPPING_HEADERS]]) {
    const missing = required.filter((header) => !source.headers.includes(header));
    if (missing.length) warnings.push({ code: "MISSING_HEADERS", level: "error", message: `${label}缺少表头：${missing.join("、")}` });
    const idField = label === "分类库" ? "账户id" : config.fields.accountId;
    const duplicates = duplicateIds(source.rows, idField);
    if (duplicates.length) warnings.push({ code: "DUPLICATE_IDS", level: "error", message: `${label}包含${duplicates.length}个重复账户ID`, details: duplicates.slice(0, 30) });
  }

  if (!mapping.rows.length) warnings.push({ code: "EMPTY_MAPPING_LIBRARY", level: "error", message: "账户分类库为空，请先导入分类表。" });

  for (const [label, source] of sources) {
    if (!source.headers.includes(config.fields.accountId)) continue;
    const missingIds = source.rows.filter((row) => !normalizeId(row[config.fields.accountId]) && hasSourceData(row, config.fields));
    if (missingIds.length) {
      warnings.push({
        code: "MISSING_ACCOUNT_ID",
        level: "error",
        message: `${label}包含${missingIds.length}行有数据但没有账户ID，请检查导出文件。`,
        details: missingIds.slice(0, 30).map((row) => clean(row[config.fields.account]) || "未命名账户"),
      });
    }
  }

  const sourceSets = Object.fromEntries(sources.map(([label, source]) => [label, idSet(source.rows, config.fields.accountId)]));
  const sourceIdsAvailable = sources.every(([, source]) => source.headers.includes(config.fields.accountId));
  if (sourceIdsAvailable && (!sameSet(sourceSets["日报日"], sourceSets["前一日"]) || !sameSet(sourceSets["日报日"], sourceSets["七日前"]))) {
    warnings.push({
      code: "ACCOUNT_UNIVERSE_MISMATCH",
      level: "error",
      message: "三份数据的账户范围不一致，请重新导出相同范围的全部账户。",
      details: {
        counts: Object.fromEntries(Object.entries(sourceSets).map(([label, ids]) => [label, ids.size])),
        currentNotPrevious: setDifference(sourceSets["日报日"], sourceSets["前一日"]),
        previousNotCurrent: setDifference(sourceSets["前一日"], sourceSets["日报日"]),
        currentNotSevenDay: setDifference(sourceSets["日报日"], sourceSets["七日前"]),
        sevenDayNotCurrent: setDifference(sourceSets["七日前"], sourceSets["日报日"]),
      },
    });
  }

  const mappingIds = idSet(mapping.rows, "账户id");
  const minCoverage = config.validation?.minMappingCoverage ?? 0.98;
  if (sourceIdsAvailable && mapping.headers.includes("账户id") && mappingIds.size) {
    for (const [label] of sources) {
      const covered = intersectionSize(sourceSets[label], mappingIds);
      const coverage = covered / mappingIds.size;
      if (coverage < minCoverage) {
        warnings.push({
          code: "INCOMPLETE_ACCOUNT_EXPORT",
          level: "error",
          message: `${label}仅覆盖分类库账户的${formatPercentage(coverage)}（${covered}/${mappingIds.size}），疑似未导出全部账户。`,
          details: { label, covered, mappingAccounts: mappingIds.size, coverage },
        });
      }
    }
  }
  return { ok: !warnings.some((item) => item.level === "error"), warnings };
}

function combineMetricRows(rows, discountRate) {
  const currentVolume = rows.reduce((sum, row) => sum + row.volume, 0);
  const currentSpend = rows.reduce((sum, row) => sum + row.spend, 0);
  const previousVolume = rows.reduce((sum, row) => sum + previousValue(row.volume, row.volumeChange), 0);
  const previousSpend = rows.reduce((sum, row) => sum + previousSpendValue(row, discountRate), 0);
  const currentCost = ratio(currentSpend * discountRate, currentVolume);
  const previousCost = ratio(previousSpend * discountRate, previousVolume);
  return { volumeChange: change(currentVolume, previousVolume), costChange: change(currentCost, previousCost) };
}

function previousValue(current, delta) {
  return Number.isFinite(delta) ? current / (1 + delta) : 0;
}

function previousSpendValue(metrics, discountRate) {
  const previousCost = Number.isFinite(metrics.costChange) ? metrics.discountedCost / (1 + metrics.costChange) : 0;
  return previousCost * previousValue(metrics.volume, metrics.volumeChange) / discountRate;
}

function describeChange(value) {
  if (!Number.isFinite(value)) return "暂无可比数据";
  if (Math.abs(value) < 0.00005) return "基本持平";
  return `${value > 0 ? "提升" : "下降"}${formatRate(Math.abs(value))}`;
}

function formatRate(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "#DIV/0!";
}

function formatSignedRate(value) {
  if (!Number.isFinite(value)) return "#DIV/0!";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function group(groups, key) {
  return groups.get(key) ?? emptyAggregate();
}

function sumAggregates(aggregates) {
  const result = emptyAggregate();
  for (const aggregate of aggregates) {
    result.accounts += aggregate.accounts;
    for (const period of ["current", "previous", "sevenDay"]) {
      for (const metric of Object.keys(result[period])) result[period][metric] += aggregate[period][metric];
    }
  }
  return result;
}

function emptyAggregate() {
  return {
    accounts: 0,
    current: emptyMetrics(),
    previous: emptyMetrics(),
    sevenDay: emptyMetrics(),
    missingCurrent: [],
    missingPrevious: [],
    missingSevenDay: [],
  };
}

function emptyMetrics() {
  return { spend: 0, volume: 0, activations: 0, nextRetained: 0, sevenRetained: 0, impressions: 0, clicks: 0 };
}

function addMetrics(target, row, fields) {
  target.spend += number(row[fields.spend]);
  target.volume += number(row[fields.volume]);
  target.activations += number(row[fields.activation]);
  target.nextRetained += number(row[fields.nextRetained]);
  target.sevenRetained += number(row[fields.sevenRetained]);
  target.impressions += number(row[fields.impressions]);
  target.clicks += number(row[fields.clicks]);
}

function indexRows(rows, idField) {
  return new Map(rows.map((row) => [normalizeId(row[idField]), row]));
}

function duplicateIds(rows, idField) {
  const seen = new Set();
  const duplicates = new Set();
  for (const row of rows) {
    const id = normalizeId(row[idField]);
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

function idSet(rows, idField) {
  return new Set(rows.map((row) => normalizeId(row[idField])).filter(Boolean));
}

function compareIds(left, right) {
  const leftId = normalizeId(left);
  const rightId = normalizeId(right);
  if (/^\d+$/.test(leftId) && /^\d+$/.test(rightId)) {
    const leftNumber = BigInt(leftId);
    const rightNumber = BigInt(rightId);
    if (leftNumber < rightNumber) return -1;
    if (leftNumber > rightNumber) return 1;
    return leftId.localeCompare(rightId);
  }
  return leftId.localeCompare(rightId, "zh-CN", { numeric: true });
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function setDifference(left, right, limit = 30) {
  return [...left].filter((id) => !right.has(id)).sort(compareIds).slice(0, limit);
}

function intersectionSize(left, right) {
  let total = 0;
  for (const id of left) if (right.has(id)) total += 1;
  return total;
}

function formatPercentage(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function hasSourceData(row, fields) {
  return clean(row[fields.account]) !== "" || activity(row, fields) > 0;
}

function periodActivity(row, fields) {
  if (!row) return { exists: false, active: false, spend: 0 };
  return { exists: true, active: activity(row, fields) > 0, spend: number(row[fields.spend]) };
}

function activity(row, fields) {
  return number(row[fields.spend]) + number(row[fields.volume]) + number(row[fields.activation]) + number(row[fields.nextRetained]) + number(row[fields.sevenRetained]) + number(row[fields.clicks]) + number(row[fields.impressions]);
}

function normalizeId(value) {
  return String(value ?? "").replace(/\s+/g, "").replace(/\.0$/, "");
}

function clean(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function change(current, previous) {
  return Number.isFinite(current) && Number.isFinite(previous) && previous !== 0 ? (current - previous) / previous : null;
}
