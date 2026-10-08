const KEYS = ["cash", "bonds", "equities", "gold"];
const cents = (n) => Math.round(n * 100);
/** Compare a selected, explicit scenario with holdings; no orders are executed. */
export function compareRebalance({
  current,
  target,
  tolerancePct = 5,
  newCash = 0,
}) {
  const values = [
    ...KEYS.map((k) => current?.[k]),
    ...KEYS.map((k) => target?.[k]),
    newCash,
    tolerancePct,
  ];
  if (
    values.some(
      (v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 4e10,
    ) ||
    tolerancePct > 100 ||
    newCash > 1e10
  )
    throw new TypeError("请填写完整、非负的再平衡参数。");
  const currentFen = Object.fromEntries(
    KEYS.map((k) => [k, cents(current[k])]),
  );
  const targetFen = Object.fromEntries(KEYS.map((k) => [k, cents(target[k])]));
  const base = KEYS.reduce((s, k) => s + currentFen[k], 0);
  const targetSum = KEYS.reduce((s, k) => s + targetFen[k], 0);
  if (base !== targetSum)
    throw new RangeError("当前资产与目标金额总额必须一致。");
  if (base === 0)
    return {
      rows: [],
      triggered: false,
      newCashUsed: 0,
      unallocatedCash: newCash,
      note: "没有可比较的资产。",
    };
  let budget = cents(newCash);
  const rows = KEYS.map((key) => {
    const difference = targetFen[key] - currentFen[key];
    const deviationPct = ((currentFen[key] - targetFen[key]) / base) * 100;
    return {
      asset: key,
      current: currentFen[key] / 100,
      target: targetFen[key] / 100,
      difference: difference / 100,
      deviationPct: Math.round(deviationPct * 100) / 100,
      needsReview: Math.abs(deviationPct) > tolerancePct,
      newCashAllocation: 0,
    };
  });
  // This is a separate fixed-target comparison: new cash first fills the largest
  // shortfall; it never funds sales or expands the target a second time.
  for (const row of [...rows]
    .filter((r) => r.difference > 0)
    .sort((a, b) => b.difference - a.difference)) {
    const used = Math.min(budget, cents(row.difference));
    row.newCashAllocation = used / 100;
    budget -= used;
  }
  return {
    rows,
    triggered: rows.some((r) => r.needsReview),
    newCashUsed: (cents(newCash) - budget) / 100,
    unallocatedCash: budget / 100,
    note: "先用新增现金填补固定目标的缺口；未将新资金加入目标分母，剩余金额留在现金中。偏离阈值由你设定；差额供复核，不代表交易指令。",
  };
}
