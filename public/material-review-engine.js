const DIRECTION_RULES = [
  ["户外建造", /荒野|建造|庇护|户外|露营|生存|野外|探险/i],
  ["影视长内容", /影视|长视频|解说|一口气|看完|纪录片|短剧|剧情|连续剧|电影/i],
  ["知识学习", /学习|知识|科普|干货|公开课|英语|成长|信息差|技巧|认知|读书|上课|宝藏博主/i],
  ["沉浸解压", /沉浸|助眠|解压|治愈|放松|舒心|声音|安静/i],
  ["美食生活", /美食|做饭|炒|吃|夜市|餐厅|烹饪|甜品|家常|生活日常|vlog/i],
  ["轻松娱乐", /搞笑|笑一笑|好笑|上才艺|萌娃|游戏|快乐|趣味|整活/i],
  ["运动兴趣", /足球|篮球|乒乓|骑行|健身|运动|赛事|钓鱼|汽车/i],
  ["美妆穿搭", /美妆|护肤|穿搭|妆容|口红|时尚|发型/i],
  ["情感共鸣", /情侣|单身|情感|恋爱|家庭|婚姻|朋友|房东|焦虑|内耗/i],
  ["产品价值表达", /抖音精选|细糠|精选app|听精选|优质内容|知识宝库|高质量|省心/i],
];

const AUDIENCE_BY_DIRECTION = {
  户外建造: "偏好户外、生存建造和沉浸过程的用户",
  影视长内容: "长视频党、影视解说和完整故事偏好用户",
  知识学习: "18-35岁、关注自我提升与实用知识的用户",
  沉浸解压: "通勤、睡前和需要放松陪伴的用户",
  美食生活: "关注生活方式、美食过程和真实日常的用户",
  轻松娱乐: "碎片化娱乐、搞笑剧情和轻内容偏好用户",
  运动兴趣: "有明确运动项目或垂类兴趣的用户",
  美妆穿搭: "关注形象管理、美妆技巧和审美趋势的用户",
  情感共鸣: "对关系、情绪和生活困境有共鸣的用户",
  产品价值表达: "对精选内容有需求、但尚未形成使用习惯的泛人群",
  泛内容探索: "尚未形成稳定偏好的泛内容用户",
};

export function buildMaterialReview(rows, options = {}) {
  const config = normalizeOptions(options);
  const materials = aggregateMaterialRows(rows).map((item) => enrichCreativeFeatures(item));
  const thresholds = buildThresholds(materials, config);
  for (const material of materials) classifyMaterial(material, thresholds[material.placement], config);

  const summary = summarizeMaterials(materials);
  const placementSummaries = Object.values(groupSummaries(materials, (item) => item.placement, summary.totalSpend));
  const directionSummaries = Object.values(groupSummaries(materials, (item) => item.direction, summary.totalSpend))
    .sort((a, b) => b.spend - a.spend || a.cpa - b.cpa);
  const briefs = generateNextWeekBriefs(materials, directionSummaries, config.weeklyCapacity);

  return {
    materials,
    summary,
    placementSummaries,
    directionSummaries,
    briefs,
    thresholds,
    warnings: buildWarnings(materials),
  };
}

export function normalizeMaterialRows(rows = []) {
  return rows.map((row) => ({
    materialId: String(row.materialId ?? "").trim(),
    videoUrl: String(row.videoUrl ?? "").trim(),
    title: String(row.title ?? "").trim(),
    taskId: String(row.taskId ?? "").trim(),
    taskName: String(row.taskName ?? "").trim(),
    placement: ["内广", "外广"].includes(row.placement) ? row.placement : "未分类",
    spend: finiteNumber(row.spend),
    conversions: finiteNumber(row.conversions),
    nextRetained: nullableNumber(row.nextRetained),
    taskType: String(row.taskType ?? "").trim(),
    provider: String(row.provider ?? "").trim(),
    channel: String(row.channel ?? "").trim(),
    sourceSheet: String(row.sourceSheet ?? "").trim(),
  })).filter((row) => row.materialId);
}

export function aggregateMaterialRows(rows = []) {
  const grouped = new Map();
  for (const row of normalizeMaterialRows(rows)) {
    const key = `${row.placement}||${row.materialId}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        materialId: row.materialId,
        placement: row.placement,
        videoUrl: row.videoUrl,
        title: row.title,
        spend: 0,
        conversions: 0,
        nextRetained: 0,
        retentionConversions: 0,
        knownRetentionRows: 0,
        sourceRows: 0,
        taskIds: [],
        taskNames: [],
        taskTypes: [],
        providers: [],
        sourceSheets: [],
      });
    }
    const item = grouped.get(key);
    item.spend += row.spend;
    item.conversions += row.conversions;
    if (row.nextRetained != null) {
      item.nextRetained += row.nextRetained;
      item.retentionConversions += row.conversions;
      item.knownRetentionRows += 1;
    }
    item.sourceRows += 1;
    if (!item.videoUrl && row.videoUrl) item.videoUrl = row.videoUrl;
    if (!item.title && row.title) item.title = row.title;
    addUnique(item.taskIds, row.taskId);
    addUnique(item.taskNames, row.taskName);
    addUnique(item.taskTypes, row.taskType);
    addUnique(item.providers, row.provider);
    addUnique(item.sourceSheets, row.sourceSheet);
  }

  return [...grouped.values()].map((item) => ({
    ...item,
    taskName: item.taskNames[0] || "",
    cpa: item.conversions > 0 ? item.spend / item.conversions : null,
    retentionRate: item.retentionConversions > 0 ? item.nextRetained / item.retentionConversions : null,
    retentionAnomaly: item.nextRetained > item.retentionConversions,
  }));
}

export function inferCreativeFeatures(title = "") {
  const normalized = String(title).trim();
  const direction = DIRECTION_RULES.find(([, expression]) => expression.test(normalized))?.[0] || "泛内容探索";
  const hashtags = [...new Set(normalized.match(/#[^#\s，,。！？!?]+/g) || [])];
  let hookType = "直给内容";
  if (/为什么|怎么|谁还|你也|你们|吗[？?]?|[？?]/i.test(normalized)) hookType = "提问悬念";
  else if (/原来|居然|竟然|没想到|第一次|假如|真相|打破|反常识/i.test(normalized)) hookType = "反差认知";
  else if (/终于|不再|白忙|焦虑|内耗|续命|救星|避坑|别再/i.test(normalized)) hookType = "痛点转折";
  else if (/一口气|沉浸|看不停|超长|完整|好爽|任君选/i.test(normalized)) hookType = "体验承诺";
  else if (/学会|轻松|省心|带你|让你|涨知识|技巧|干货/i.test(normalized)) hookType = "收益承诺";
  return { direction, hookType, hashtags };
}

export function generateNextWeekBriefs(materials, directionSummaries, weeklyCapacity) {
  const capacity = Math.max(1, Math.round(finiteNumber(weeklyCapacity) || 30));
  const candidates = [];
  const chosen = new Set();

  addBriefCandidates(candidates, chosen, directionSummaries.filter((item) => item.winnerCount > 0), "放大已验证方向", 2);
  addBriefCandidates(candidates, chosen, directionSummaries.filter((item) => item.optimizeCount > 0), "优化高消耗方向", 1);
  addBriefCandidates(candidates, chosen, directionSummaries.filter((item) => item.potentialCount > 0), "验证高效潜力", 1);
  addBriefCandidates(candidates, chosen, directionSummaries, "保留探索位", 4);

  const selected = candidates.slice(0, Math.min(4, capacity));
  if (!selected.length) return [];
  const weights = selected.map((item) => strategyWeight(item.strategy));
  const quantities = allocateIntegerTotal(capacity, weights);

  return selected.map((candidate, index) => {
    const directionMaterials = materials.filter((item) => item.direction === candidate.direction)
      .sort((a, b) => classificationRank(a.classification) - classificationRank(b.classification) || b.spend - a.spend);
    const references = directionMaterials.filter((item) => item.conversions > 0).slice(0, 3);
    const dominantHook = mode(references.map((item) => item.hookType)) || "直给内容";
    return {
      direction: candidate.direction,
      strategy: candidate.strategy,
      quantity: quantities[index],
      priority: index < 2 ? "高优先级" : "中优先级",
      audience: AUDIENCE_BY_DIRECTION[candidate.direction] || AUDIENCE_BY_DIRECTION.泛内容探索,
      hook: hookRecommendation(dominantHook, candidate.direction),
      structure: structureRecommendation(candidate.direction),
      tests: testRecommendation(candidate.strategy),
      evidence: `${candidate.materialCount}条素材累计消耗${formatMoney(candidate.spend)}，成本${formatMoney(candidate.cpa)}，次留率${formatPercent(candidate.retentionRate)}；跑量优质${candidate.winnerCount}条，高效潜力${candidate.potentialCount}条`,
      referenceIds: references.map((item) => item.materialId),
    };
  });
}

function enrichCreativeFeatures(item) {
  const features = inferCreativeFeatures(item.title);
  return { ...item, ...features, classification: "", status: "", evidence: "", inference: "标题与标签语义推断" };
}

function normalizeOptions(options) {
  return {
    targets: options.targets || {},
    minSpend: Math.max(0, finiteNumber(options.minSpend) || 500),
    minConversions: Math.max(1, Math.round(finiteNumber(options.minConversions) || 10)),
    weeklyCapacity: Math.max(1, Math.round(finiteNumber(options.weeklyCapacity) || 30)),
  };
}

function buildThresholds(materials, config) {
  const placements = [...new Set(materials.map((item) => item.placement))];
  return Object.fromEntries(placements.map((placement) => {
    const items = materials.filter((item) => item.placement === placement);
    const spend = sum(items, "spend");
    const conversions = sum(items, "conversions");
    const retained = sum(items, "nextRetained");
    const eligible = items.filter((item) => item.conversions >= config.minConversions || item.spend >= config.minSpend);
    const automaticTarget = conversions > 0 ? spend / conversions : null;
    const requestedTarget = finiteNumber(config.targets[placement]);
    return [placement, {
      placement,
      targetCpa: requestedTarget > 0 ? requestedTarget : automaticTarget,
      targetSource: requestedTarget > 0 ? "业务目标" : "本周加权基线",
      scaleSpend: Math.max(config.minSpend, percentile(eligible.map((item) => item.spend), .8)),
      retentionBaseline: retentionSummary(items),
      totalSpend: spend,
      totalConversions: conversions,
    }];
  }));
}

function classifyMaterial(material, threshold, config) {
  const target = threshold?.targetCpa;
  const scaleSpend = threshold?.scaleSpend ?? config.minSpend;
  const baselineRetention = threshold?.retentionBaseline;
  const enoughSample = material.conversions >= config.minConversions || material.spend >= config.minSpend;
  let classification = "稳态观察";
  let status = "steady";

  if (!enoughSample) {
    classification = "数据不足";
    status = "insufficient";
  } else if (material.spend >= scaleSpend && material.cpa != null && target != null && material.cpa <= target) {
    classification = "跑量优质";
    status = "scale_winner";
  } else if (material.spend >= scaleSpend) {
    classification = "跑量待优化";
    status = "scale_optimize";
  } else if (material.conversions >= config.minConversions && material.cpa != null && target != null && material.cpa <= target * .85 && material.retentionRate != null && !material.retentionAnomaly && (baselineRetention == null || material.retentionRate >= baselineRetention * .9)) {
    classification = "高效潜力";
    status = "scale_candidate";
  } else if (material.spend >= config.minSpend && (material.cpa == null || (target != null && material.cpa > target * 1.2))) {
    classification = "低效观察";
    status = "inefficient";
  }

  material.classification = classification;
  material.status = status;
  material.evidence = classificationEvidence(material, threshold, config);
}

function classificationEvidence(material, threshold, config) {
  const target = threshold?.targetCpa;
  const scale = threshold?.scaleSpend ?? config.minSpend;
  const retentionCopy = material.retentionAnomaly ? `次留率异常${formatPercent(material.retentionRate)}` : `次留率${formatPercent(material.retentionRate)}`;
  const metrics = `消耗${formatMoney(material.spend)}，${formatNumber(material.conversions)}个转化，成本${formatMoney(material.cpa)}，${retentionCopy}`;
  if (material.classification === "跑量优质") return `${metrics}；达到${material.placement}跑量线${formatMoney(scale)}，且成本不高于${threshold.targetSource}${formatMoney(target)}`;
  if (material.classification === "跑量待优化") return `${metrics}；达到${material.placement}跑量线${formatMoney(scale)}，但成本高于${threshold?.targetSource || "目标"}${formatMoney(target)}`;
  if (material.classification === "高效潜力") return `${metrics}；样本已达${config.minConversions}个转化，成本较${threshold.targetSource}至少低15%，建议增加验证量`;
  if (material.classification === "低效观察") return `${metrics}；已有至少${formatMoney(config.minSpend)}消耗，但成本高于基线20%或尚无转化`;
  if (material.classification === "数据不足") return `${metrics}；未同时达到${formatMoney(config.minSpend)}消耗或${config.minConversions}个转化的判断门槛`;
  return `${metrics}；已有有效样本，但暂未形成明确的放大或止损信号`;
}

function summarizeMaterials(materials) {
  const totalSpend = sum(materials, "spend");
  const totalConversions = sum(materials, "conversions");
  const totalRetained = sum(materials.filter((item) => !item.retentionAnomaly), "nextRetained");
  const retentionConversions = sum(materials.filter((item) => !item.retentionAnomaly), "retentionConversions");
  return {
    totalMaterials: materials.length,
    uniqueMaterialIds: new Set(materials.map((item) => item.materialId)).size,
    sourceRows: sum(materials, "sourceRows"),
    totalSpend,
    totalConversions,
    totalRetained,
    retentionConversions,
    cpa: totalConversions > 0 ? totalSpend / totalConversions : null,
    retentionRate: retentionConversions > 0 ? totalRetained / retentionConversions : null,
    winnerCount: countByClassification(materials, "跑量优质"),
    potentialCount: countByClassification(materials, "高效潜力"),
    optimizeCount: countByClassification(materials, "跑量待优化"),
    insufficientCount: countByClassification(materials, "数据不足"),
  };
}

function groupSummaries(materials, keySelector, totalSpend) {
  const result = {};
  for (const material of materials) {
    const key = keySelector(material);
    if (!result[key]) result[key] = { direction: key, placement: key, materialCount: 0, spend: 0, conversions: 0, nextRetained: 0, retentionConversions: 0, winnerCount: 0, potentialCount: 0, optimizeCount: 0 };
    const group = result[key];
    group.materialCount += 1;
    group.spend += material.spend;
    group.conversions += material.conversions;
    if (!material.retentionAnomaly) {
      group.nextRetained += material.nextRetained;
      group.retentionConversions += material.retentionConversions;
    }
    group.winnerCount += material.classification === "跑量优质" ? 1 : 0;
    group.potentialCount += material.classification === "高效潜力" ? 1 : 0;
    group.optimizeCount += material.classification === "跑量待优化" ? 1 : 0;
  }
  for (const group of Object.values(result)) {
    group.cpa = group.conversions > 0 ? group.spend / group.conversions : null;
    group.retentionRate = group.retentionConversions > 0 ? group.nextRetained / group.retentionConversions : null;
    group.spendShare = totalSpend > 0 ? group.spend / totalSpend : 0;
  }
  return result;
}

function addBriefCandidates(target, chosen, summaries, strategy, limit) {
  let added = 0;
  for (const summary of summaries) {
    if (chosen.has(summary.direction)) continue;
    chosen.add(summary.direction);
    target.push({ ...summary, strategy });
    added += 1;
    if (added >= limit || target.length >= 4) break;
  }
}

function allocateIntegerTotal(total, weights) {
  const allocations = weights.map(() => 1);
  let remaining = total - allocations.length;
  if (remaining <= 0) return allocations.map((value, index) => index < total ? value : 0);
  const weightTotal = weights.reduce((sumValue, value) => sumValue + value, 0);
  const raw = weights.map((weight) => remaining * weight / weightTotal);
  raw.forEach((value, index) => { allocations[index] += Math.floor(value); });
  remaining = total - allocations.reduce((sumValue, value) => sumValue + value, 0);
  const order = raw.map((value, index) => ({ index, remainder: value - Math.floor(value) })).sort((a, b) => b.remainder - a.remainder);
  for (let index = 0; index < remaining; index += 1) allocations[order[index % order.length].index] += 1;
  return allocations;
}

function strategyWeight(strategy) {
  if (strategy === "放大已验证方向") return 4;
  if (strategy === "优化高消耗方向") return 2.5;
  if (strategy === "验证高效潜力") return 2;
  return 1.5;
}

function hookRecommendation(hookType, direction) {
  const examples = {
    提问悬念: `前三秒直接抛出${direction}相关问题，先给冲突再揭示答案`,
    反差认知: `用“原来/没想到”的认知反差开场，前置最意外的信息`,
    痛点转折: `先说具体痛点，再立即给出内容解决方案，避免背景铺垫`,
    体验承诺: `直给完整观看收益，用“一口气/沉浸式”明确体验预期`,
    收益承诺: `先给用户可获得的具体收益，再用内容片段证明`,
    直给内容: `前三秒展示最强内容片段，并同步说明为什么值得继续看`,
  };
  return examples[hookType] || examples.直给内容;
}

function structureRecommendation(direction) {
  const structures = {
    户外建造: "最终成果前置 → 建造难点 → 关键过程 → 完成效果 → 精选内容承接",
    影视长内容: "高潮片段 → 故事冲突 → 内容完整性证明 → 长内容价值 → 行动引导",
    知识学习: "认知问题 → 关键知识点 → 应用示例 → 收益总结 → 行动引导",
    沉浸解压: "强感官片段 → 连续过程 → 情绪放松点 → 完整内容承接",
    产品价值表达: "用户痛点 → 精选内容解决方案 → 内容证据 → 使用收益 → 行动引导",
  };
  return structures[direction] || "强内容片段 → 用户兴趣点 → 价值证明 → 完整内容承接 → 行动引导";
}

function testRecommendation(strategy) {
  if (strategy === "放大已验证方向") return "保留题材和核心卖点，分别测试开场句、人物、场景与证明片段";
  if (strategy === "优化高消耗方向") return "保留跑量题材，重点替换前三秒表达、信息密度和行动引导";
  if (strategy === "验证高效潜力") return "同一脚本做2-3个开场变体，小批量验证是否能扩大消耗";
  return "每条只测试一个新变量，并保留已验证的产品承接方式作为对照";
}

function buildWarnings(materials) {
  const warnings = [];
  const missingTitle = materials.filter((item) => !item.title).length;
  const missingTask = materials.filter((item) => !item.taskNames.length).length;
  const retentionAnomalies = materials.filter((item) => item.retentionAnomaly).length;
  if (missingTitle) warnings.push(`${missingTitle}条素材缺少标题，未参与准确的内容方向识别。`);
  if (missingTask) warnings.push(`${missingTask}条素材未匹配任务名称，但不影响消耗和转化聚合。`);
  if (retentionAnomalies) warnings.push(`${retentionAnomalies}条素材的次留数大于对应转化数，已标记异常且不参与潜力判断。`);
  return warnings;
}

function countByClassification(materials, classification) { return materials.filter((item) => item.classification === classification).length; }
function classificationRank(value) { return ({ 跑量优质: 0, 高效潜力: 1, 跑量待优化: 2, 稳态观察: 3, 低效观察: 4, 数据不足: 5 })[value] ?? 9; }
function percentile(values, fraction) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.round((sorted.length - 1) * fraction)]; }
function mode(values) { const counts = new Map(); values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1)); return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || null; }
function sum(items, key) { return items.reduce((total, item) => total + finiteNumber(item[key]), 0); }
function finiteNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function nullableNumber(value) { if (value == null || String(value).trim() === "") return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function retentionSummary(items) { const valid = items.filter((item) => !item.retentionAnomaly); const numerator = sum(valid, "nextRetained"); const denominator = sum(valid, "retentionConversions"); return denominator > 0 ? numerator / denominator : null; }
function addUnique(target, value) { if (value && !target.includes(value)) target.push(value); }
function formatNumber(value) { return Math.round(finiteNumber(value)).toLocaleString("zh-CN"); }
function formatMoney(value) { return Number.isFinite(value) ? `¥${Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}` : "--"; }
function formatPercent(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "--"; }
