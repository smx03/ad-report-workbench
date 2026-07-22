export const MATERIAL_PAGE_SIZE = 50;

export function paginateItems(items, requestedPage = 1, pageSize = MATERIAL_PAGE_SIZE) {
  const size = Math.max(1, Math.round(Number(pageSize) || MATERIAL_PAGE_SIZE));
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / size));
  const page = Math.min(totalPages, Math.max(1, Math.round(Number(requestedPage) || 1)));
  const startIndex = totalItems ? (page - 1) * size : 0;
  const endIndex = Math.min(totalItems, startIndex + size);
  return {
    page,
    pageSize: size,
    totalItems,
    totalPages,
    startIndex,
    endIndex,
    items: items.slice(startIndex, endIndex),
  };
}

export function paginationTokens(page, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages = new Set([1, totalPages, page - 1, page, page + 1]);
  if (page <= 4) [2, 3, 4, 5].forEach((value) => pages.add(value));
  if (page >= totalPages - 3) [totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1].forEach((value) => pages.add(value));
  const ordered = [...pages].filter((value) => value >= 1 && value <= totalPages).sort((a, b) => a - b);
  const tokens = [];
  ordered.forEach((value, index) => {
    const previous = ordered[index - 1];
    if (index && value - previous === 2) tokens.push(previous + 1);
    else if (index && value - previous > 2) tokens.push("ellipsis");
    tokens.push(value);
  });
  return tokens;
}

export function directionSpendBreakdown(materials, placement = "全部", limit = 6) {
  const filtered = filterByPlacement(materials, placement);
  const grouped = new Map();
  for (const material of filtered) {
    const direction = material.direction || "未分类";
    const current = grouped.get(direction) || { direction, spend: 0, conversions: 0, materialCount: 0 };
    current.spend += finite(material.spend);
    current.conversions += finite(material.conversions);
    current.materialCount += 1;
    grouped.set(direction, current);
  }
  const totalSpend = [...grouped.values()].reduce((sum, item) => sum + item.spend, 0);
  const sorted = [...grouped.values()].sort((a, b) => b.spend - a.spend);
  const top = sorted.slice(0, limit);
  const remaining = sorted.slice(limit);
  if (remaining.length) {
    top.push(remaining.reduce((other, item) => ({
      direction: "其他方向",
      spend: other.spend + item.spend,
      conversions: other.conversions + item.conversions,
      materialCount: other.materialCount + item.materialCount,
    }), { direction: "其他方向", spend: 0, conversions: 0, materialCount: 0 }));
  }
  return top.map((item) => ({
    ...item,
    spendShare: totalSpend > 0 ? item.spend / totalSpend : 0,
    cpa: item.conversions > 0 ? item.spend / item.conversions : null,
  }));
}

export function buildCpaSeries(materials, thresholds, placement = "全部", limit = 18) {
  return filterByPlacement(materials, placement)
    .filter((item) => Number.isFinite(item.cpa) && item.cpa > 0 && item.spend > 0)
    .sort((a, b) => b.spend - a.spend || a.cpa - b.cpa)
    .slice(0, limit)
    .map((item, index) => ({
      rank: index + 1,
      materialId: item.materialId,
      title: item.title,
      placement: item.placement,
      spend: item.spend,
      cpa: item.cpa,
      targetCpa: thresholds[item.placement]?.targetCpa ?? null,
      classification: item.classification,
    }));
}

function filterByPlacement(materials, placement) {
  return placement === "全部" ? materials : materials.filter((item) => item.placement === placement);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
