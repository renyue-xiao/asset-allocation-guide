/**
 * Deterministic, educational allocation scenarios. All internal money is in fen.
 * Thresholds below are software examples, not rules attributed to any author.
 */
export const DEFAULT_STRESS = Object.freeze({
  incomeDropPct: 100,
  months: 6,
  equityDropPct: 35,
  bondDropPct: 8,
  goldDropPct: 15,
});

export const POLICY = Object.freeze({
  version: "2026-10-08.1",
  shortTermMonths: 36,
  highAprPct: 6,
  maxMoney: 10_000_000_000,
  maxGoals: 100,
  description:
    "期限、比例、债务和压力阈值均为可检查的软件教学示例，不代表大卫翁的通用建议。",
});

const ASSET_KEYS = ["cash", "bonds", "equities", "gold", "locked", "property"];
const LIQUID_KEYS = ["cash", "bonds", "equities", "gold"];
const DEBT_KEYS = ["balance", "monthlyPayment", "apr", "dueWithinYear"];
const LABELS = {
  "assets.cash": "现金及可随时支取资金",
  "assets.bonds": "可变现债券类资产",
  "assets.equities": "可变现权益类资产",
  "assets.gold": "可变现黄金类资产",
  "assets.locked": "锁定或暂不可赎回的金融资产",
  "assets.property": "房产估值",
  "debts.balance": "债务余额",
  "debts.monthlyPayment": "每月偿债额",
  "debts.apr": "债务年利率",
  "debts.dueWithinYear": "一年内月供之外的额外到期本金",
  "cashflow.income": "每月收入",
  "cashflow.expense": "每月必要支出（不含月供）",
  "profile.stability": "收入稳定性",
  "profile.correlatedIncome": "职业收入是否与金融市场明显相关",
  "profile.experience": "投资经历",
  "profile.horizonYears": "剩余资金可投资年限",
  "profile.maxLossPct": "可变现资产可接受的一次性损失比例",
  "profile.reserveMonths": "应急金覆盖月数",
};

const TEMPLATES = [
  {
    id: "conservative",
    label: "偏防守情景",
    weights: { cash: 10, bonds: 65, equities: 15, gold: 10 },
  },
  {
    id: "balanced",
    label: "均衡情景",
    weights: { cash: 5, bonds: 45, equities: 40, gold: 10 },
  },
  {
    id: "growth",
    label: "偏成长情景",
    weights: { cash: 5, bonds: 25, equities: 65, gold: 5 },
  },
];

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isMissing = (value) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && value.trim() === "");
const yuan = (fen) => (fen === null ? null : fen / 100);
const fen = (value) => (value === null ? null : Math.round(value * 100));
const known = (...values) =>
  values.every((value) => value !== null && value !== undefined);
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const percentage = (amount, total) =>
  total > 0 ? round2((amount / total) * 100) : amount === 0 ? 0 : null;
const sumKnown = (values) =>
  values.every((value) => value !== null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;

function scaleMoney(amount, pct) {
  // BigInt preserves cent rounding even at the largest permitted input values.
  const numerator = BigInt(amount) * BigInt(Math.round(pct * 100));
  const sign = numerator < 0n ? -1n : 1n;
  return Number(sign * ((numerator * sign + 5000n) / 10000n));
}

function parseInput(input) {
  const validation = { errors: [], missing: [], warnings: [] };
  const error = (path, code, message) =>
    validation.errors.push({ path, code, message });
  const missing = (path, message) => validation.missing.push({ path, message });
  const warn = (code, message) => validation.warnings.push({ code, message });
  const root = isRecord(input) ? input : {};
  if (!isRecord(input) && !isMissing(input))
    error("", "type", "输入必须是一个对象。");

  function group(name) {
    if (!isMissing(root[name]) && !isRecord(root[name]))
      error(name, "type", `${name} 必须是一个对象。`);
    return isRecord(root[name]) ? root[name] : {};
  }

  function number(
    value,
    path,
    {
      max = POLICY.maxMoney,
      integer = false,
      min = 0,
      places = 2,
      optional = false,
    } = {},
  ) {
    if (isMissing(value)) {
      if (!optional)
        missing(path, `请填写${LABELS[path] ?? path}；未知值不会按 0 计算。`);
      return null;
    }
    const normalized = typeof value === "string" ? value.trim() : value;
    if (
      (typeof normalized !== "number" && typeof normalized !== "string") ||
      (typeof normalized === "string" &&
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized))
    ) {
      error(path, "number", `${LABELS[path] ?? path}必须是有效数字。`);
      return null;
    }
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
      error(path, "number", `${LABELS[path] ?? path}必须是有限数字。`);
      return null;
    }
    if (parsed < min || parsed > max) {
      error(
        path,
        "range",
        `${LABELS[path] ?? path}应在 ${min} 至 ${max} 之间。`,
      );
      return null;
    }
    if (integer && !Number.isInteger(parsed)) {
      error(path, "integer", `${LABELS[path] ?? path}必须是整数。`);
      return null;
    }
    const factor = 10 ** places;
    if (
      Math.abs(parsed * factor - Math.round(parsed * factor)) >
      Math.max(0.00001, Number.EPSILON * Math.abs(parsed * factor) * 2)
    ) {
      error(
        path,
        "precision",
        `${LABELS[path] ?? path}最多保留 ${places} 位小数。`,
      );
      return null;
    }
    return Object.is(parsed, -0) ? 0 : parsed;
  }

  function choice(value, path, allowed) {
    if (isMissing(value) || value === "unknown") {
      missing(path, `请确认${LABELS[path] ?? path}。`);
      return null;
    }
    if (!allowed.includes(value)) {
      error(path, "choice", `${LABELS[path] ?? path}的选项无效。`);
      return null;
    }
    return value;
  }

  function boolean(value, path) {
    if (isMissing(value)) {
      missing(path, `请确认${LABELS[path] ?? path}。`);
      return null;
    }
    if (typeof value !== "boolean") {
      error(path, "boolean", `${LABELS[path] ?? path}必须明确选择是或否。`);
      return null;
    }
    return value;
  }

  const assetInput = group("assets");
  const debtInput = group("debts");
  const cashflowInput = group("cashflow");
  const profileInput = group("profile");
  const assets = Object.fromEntries(
    ASSET_KEYS.map((key) => [
      key,
      fen(number(assetInput[key], `assets.${key}`)),
    ]),
  );
  const debts = Object.fromEntries(
    DEBT_KEYS.map((key) => [
      key,
      key === "apr"
        ? number(debtInput[key], `debts.${key}`, { max: 100 })
        : fen(number(debtInput[key], `debts.${key}`)),
    ]),
  );
  const cashflow = Object.fromEntries(
    ["income", "expense"].map((key) => [
      key,
      fen(number(cashflowInput[key], `cashflow.${key}`)),
    ]),
  );
  const profile = {
    stability: choice(profileInput.stability, "profile.stability", [
      "stable",
      "variable",
      "fragile",
    ]),
    correlatedIncome: boolean(
      profileInput.correlatedIncome,
      "profile.correlatedIncome",
    ),
    experience: choice(profileInput.experience, "profile.experience", [
      "none",
      "some",
      "experienced",
    ]),
    horizonYears: number(profileInput.horizonYears, "profile.horizonYears", {
      max: 60,
    }),
    maxLossPct: number(profileInput.maxLossPct, "profile.maxLossPct", {
      max: 100,
    }),
    reserveMonths: number(profileInput.reserveMonths, "profile.reserveMonths", {
      max: 60,
      integer: true,
    }),
  };

  let goals = null;
  if (isMissing(root.goals)) {
    missing("goals", "请填写资金用途；明确没有额外目标时填写空列表。");
  } else if (!Array.isArray(root.goals)) {
    error("goals", "type", "资金用途必须是列表。");
  } else if (root.goals.length > POLICY.maxGoals) {
    error("goals", "length", `资金用途最多 ${POLICY.maxGoals} 项。`);
  } else {
    goals = root.goals.map((goal, index) => {
      const path = `goals[${index}]`;
      if (!isRecord(goal)) {
        error(path, "type", "每项资金用途必须是对象。");
        return null;
      }
      let name = null;
      if (isMissing(goal.name)) missing(`${path}.name`, "请填写资金用途名称。");
      else if (typeof goal.name !== "string" || goal.name.trim().length > 80)
        error(`${path}.name`, "name", "用途名称应为不超过 80 字的文字。");
      else name = goal.name.trim();
      if (goal.kind === "debt")
        error(
          `${path}.kind`,
          "debt-goal",
          "债务统一填写在债务区；用途区不能重复填写同笔偿债。",
        );
      return {
        name,
        amount: fen(number(goal.amount, `${path}.amount`)),
        months: number(goal.months, `${path}.months`, {
          max: 720,
          integer: true,
        }),
        flexible: boolean(goal.flexible, `${path}.flexible`),
      };
    });
    if (
      goals.some(
        (goal) =>
          goal === null || Object.values(goal).some((value) => value === null),
      )
    )
      goals = null;
  }

  if (
    known(debts.balance, debts.dueWithinYear) &&
    debts.dueWithinYear > debts.balance
  ) {
    error(
      "debts.dueWithinYear",
      "debt-balance",
      "额外到期本金不能超过债务余额。",
    );
  }
  if (debts.balance === 0) {
    if (debts.monthlyPayment > 0)
      error(
        "debts.monthlyPayment",
        "debt-conflict",
        "债务余额为 0 时，每月偿债额也应为 0。",
      );
    if (debts.apr > 0)
      error("debts.apr", "debt-conflict", "没有债务时，债务年利率请填 0。");
  } else if (
    debts.balance > 0 &&
    debts.monthlyPayment === 0 &&
    debts.dueWithinYear === 0
  ) {
    warn(
      "debt-schedule-unknown",
      "有债务但未列月供或一年内额外到期本金，请核对还款安排；本工具不会推定免还或自动计算摊还。",
    );
  }

  // Stress parameters are explicit software examples. Partial overrides retain
  // defaults only for omitted keys; an explicit blank remains unknown.
  const stressInput = root.stress === undefined ? {} : group("stress");
  const stress = {};
  const defaultedStressFields = [];
  for (const [key, defaultValue] of Object.entries(DEFAULT_STRESS)) {
    if (stressInput[key] === undefined) {
      stress[key] = defaultValue;
      defaultedStressFields.push(key);
    } else {
      stress[key] = number(
        stressInput[key],
        `stress.${key}`,
        key === "months" ? { max: 120, min: 1, integer: true } : { max: 100 },
      );
    }
  }
  if (root.stress === null || root.stress === "") {
    missing("stress", "压力情景为空；可省略该对象以使用明确的软件示例。");
  }
  return {
    assets,
    debts,
    cashflow,
    profile,
    goals,
    stress,
    defaultedStressFields,
    validation,
  };
}

export function validateInput(input) {
  return parseInput(input).validation;
}

function calculateBase(data) {
  const { assets: a, debts: d, cashflow: cf, profile: p, goals } = data;
  const gross = sumKnown(ASSET_KEYS.map((key) => a[key]));
  const liquid = sumKnown(LIQUID_KEYS.map((key) => a[key]));
  const financial = sumKnown([...LIQUID_KEYS, "locked"].map((key) => a[key]));
  const essentials = known(cf.expense, d.monthlyPayment)
    ? cf.expense + d.monthlyPayment
    : null;
  const surplus = known(cf.income, essentials) ? cf.income - essentials : null;
  const emergency = known(essentials, p.reserveMonths)
    ? essentials * p.reserveMonths
    : null;
  const shortGoals =
    goals === null
      ? null
      : goals
          .filter((goal) => goal.months <= POLICY.shortTermMonths)
          .reduce((sum, goal) => sum + goal.amount, 0);
  const target = known(emergency, shortGoals, d.dueWithinYear)
    ? emergency + shortGoals + d.dueWithinYear
    : null;
  const pool = known(target, liquid) ? Math.max(0, liquid - target) : null;
  const gap = known(target, liquid) ? Math.max(0, target - liquid) : null;
  const debtRatio = known(cf.income, d.monthlyPayment)
    ? percentage(d.monthlyPayment, cf.income)
    : null;
  const earliestLongGoal =
    goals === null
      ? null
      : (goals
          .filter(
            (goal) => goal.amount > 0 && goal.months > POLICY.shortTermMonths,
          )
          .sort((left, right) => left.months - right.months)[0] ?? null);
  const effectiveYears =
    p.horizonYears === null
      ? null
      : Math.min(
          p.horizonYears,
          earliestLongGoal ? earliestLongGoal.months / 12 : p.horizonYears,
        );
  return {
    gross,
    liquid,
    financial,
    essentials,
    surplus,
    emergency,
    shortGoals,
    target,
    pool,
    gap,
    effectiveYears,
    earliestLongGoal,
    summary: {
      grossAssets: yuan(gross),
      liquidAssets: yuan(liquid),
      financialAssets: yuan(financial),
      netWorth: known(gross, d.balance) ? yuan(gross - d.balance) : null,
      monthlyIncome: yuan(cf.income),
      monthlyExpense: yuan(cf.expense),
      monthlyDebtService: yuan(d.monthlyPayment),
      monthlySurplus: yuan(surplus),
      debtServicePct: debtRatio,
      debtServiceNoIncome: cf.income === 0 && d.monthlyPayment > 0,
      currentLiquidAmounts: Object.fromEntries(
        LIQUID_KEYS.map((key) => [key, yuan(a[key])]),
      ),
      currentLiquidWeights:
        liquid !== null
          ? Object.fromEntries(
              LIQUID_KEYS.map((key) => [key, percentage(a[key], liquid)]),
            )
          : null,
    },
    reserves: {
      monthlyEssentials: yuan(essentials),
      reserveMonths: p.reserveMonths,
      emergencyTarget: yuan(emergency),
      emergencyCashGap: known(emergency, a.cash)
        ? yuan(Math.max(0, emergency - a.cash))
        : null,
      nearTermMonths: POLICY.shortTermMonths,
      nearTermGoals: yuan(shortGoals),
      extraDebtDue: yuan(d.dueWithinYear),
      target: yuan(target),
      availableLiquidAssets: yuan(liquid),
      fundingGap: yuan(gap),
      cashReserveGap: known(target, a.cash)
        ? yuan(Math.max(0, target - a.cash))
        : null,
      marketAssetsToRelease: known(target, a.cash, liquid)
        ? yuan(Math.min(Math.max(0, target - a.cash), liquid - a.cash))
        : null,
      fundedCashReserve: known(target, liquid)
        ? yuan(Math.min(target, liquid))
        : null,
      longTermPool: yuan(pool),
      shortTermGoalDetails:
        goals
          ?.filter((goal) => goal.months <= POLICY.shortTermMonths)
          .map((goal) => ({ ...goal, amount: yuan(goal.amount) })) ?? null,
      effectiveHorizonYears:
        effectiveYears === null ? null : round2(effectiveYears),
      nearestLongTermGoal: earliestLongGoal
        ? { ...earliestLongGoal, amount: yuan(earliestLongGoal.amount) }
        : null,
    },
  };
}

function calculateRisk(data, base) {
  const { profile: p, debts: d, cashflow: cf } = data;
  const constraints = [];
  const add = (key, label, limitPct, detail) =>
    constraints.push({ key, label, limitPct, detail });
  if (base.effectiveYears !== null) {
    const years = base.effectiveYears;
    add(
      "horizon",
      "资金期限",
      years < 3 ? 0 : years < 5 ? 30 : years < 10 ? 55 : 75,
      `按 ${round2(years)} 年评估；不足 3 年权益上限 0%，3 至不足 5 年为 30%，5 至不足 10 年为 55%，10 年及以上为 75%。`,
    );
  }
  if (p.stability !== null) {
    add(
      "stability",
      "收入稳定性",
      { stable: 75, variable: 55, fragile: 30 }[p.stability],
      "软件示例对稳定、波动、脆弱收入分别使用 75%、55%、30% 的权益上限。",
    );
  }
  if (p.experience !== null) {
    add(
      "experience",
      "投资经历",
      { none: 25, some: 55, experienced: 75 }[p.experience],
      "软件示例对无经验、有一些经验、经历过完整波动周期分别使用 25%、55%、75% 的权益上限；经历不能替代风险意愿。",
    );
  }
  if (p.correlatedIncome === true)
    add(
      "correlated-income",
      "职业与市场同向风险",
      40,
      "收入与市场明显相关，权益上限示例收紧至 40%；没有把人力资产估成可投资现金。",
    );
  if (base.summary.debtServiceNoIncome)
    add(
      "debt-service",
      "没有收入覆盖月供",
      0,
      "当前没有收入却有固定偿债支出，先确认偿债资金安排。",
    );
  else if (
    known(cf.income, d.monthlyPayment) &&
    d.monthlyPayment * 100 > cf.income * 50
  )
    add(
      "debt-service",
      "偿债支出较高",
      20,
      "月供超过收入的 50%，软件示例将权益上限收紧至 20%。",
    );
  else if (
    known(cf.income, d.monthlyPayment) &&
    d.monthlyPayment * 100 > cf.income * 35
  )
    add(
      "debt-service",
      "偿债挤占结余",
      40,
      "月供超过收入的 35%，软件示例将权益上限收紧至 40%。",
    );
  if (base.surplus < 0)
    add(
      "negative-surplus",
      "日常现金流缺口",
      0,
      "每月收入无法覆盖必要支出与月供，当前不能把剩余资金直接视为可增加风险的结余。",
    );
  if (base.gap > 0)
    add(
      "reserve-gap",
      "储备尚未覆盖",
      0,
      "可变现资产不足以覆盖应急、短期用途和额外到期本金。",
    );
  if (base.summary.netWorth < 0)
    add(
      "negative-networth",
      "净资产为负",
      0,
      "先核对债务及资产处置安排，再讨论增加风险资产。",
    );
  const capacityInputsComplete = [
    p.stability,
    p.correlatedIncome,
    p.experience,
    p.horizonYears,
    p.reserveMonths,
  ].every((value) => value !== null);
  const equityCapPct =
    capacityInputsComplete &&
    known(base.surplus, base.gap, d.balance, cf.income)
      ? Math.min(75, ...constraints.map((constraint) => constraint.limitPct))
      : null;
  const exampleReserve =
    p.stability === null
      ? null
      : { stable: 6, variable: 9, fragile: 12 }[p.stability];
  return {
    capacity: {
      equityCapPct,
      constraints,
      effectiveHorizonYears:
        base.effectiveYears === null ? null : round2(base.effectiveYears),
      statedHorizonYears: p.horizonYears,
      stability: p.stability,
      experience: p.experience,
      correlatedIncome: p.correlatedIncome,
      exampleReserveMonths: exampleReserve,
      reserveBelowExample: known(p.reserveMonths, exampleReserve)
        ? p.reserveMonths < exampleReserve
        : null,
    },
    willingness: {
      maxLossPct: p.maxLossPct,
      maxLossAmount: known(base.liquid, p.maxLossPct)
        ? yuan(scaleMoney(base.liquid, p.maxLossPct))
        : null,
      basis:
        "当前可变现资产：现金、可变现债券、权益、黄金；不含房产及锁定资产。",
    },
    debtReview: {
      apr: d.apr,
      highCostDebt:
        d.apr === null || d.balance === null
          ? null
          : d.balance > 0 && d.apr >= POLICY.highAprPct,
      exampleAprThreshold: POLICY.highAprPct,
      repaymentComparisonAmount: known(d.balance, d.dueWithinYear, base.pool)
        ? yuan(Math.min(Math.max(0, d.balance - d.dueWithinYear), base.pool))
        : null,
      note: "6% 仅是触发核对的软件阈值。提前还款需另核对合同、费用、剩余期限与资金用途；未假定全部债务立即偿还。",
    },
  };
}

function distribute(pool, weights) {
  const parts = LIQUID_KEYS.map((key, index) => {
    const numerator = BigInt(pool) * BigInt(weights[key]);
    return {
      key,
      index,
      amount: Number(numerator / 100n),
      remainder: Number(numerator % 100n),
    };
  });
  let unallocated = pool - parts.reduce((sum, part) => sum + part.amount, 0);
  const ranked = [...parts].sort(
    (left, right) =>
      right.remainder - left.remainder || left.index - right.index,
  );
  for (const part of ranked) {
    if (unallocated-- <= 0) break;
    part.amount += 1;
  }
  return Object.fromEntries(parts.map(({ key, amount }) => [key, amount]));
}

function marketLoss(amounts, stress) {
  return (
    scaleMoney(amounts.equities, stress.equityDropPct) +
    scaleMoney(amounts.bonds, stress.bondDropPct) +
    scaleMoney(amounts.gold, stress.goldDropPct)
  );
}

function allocationScenarios(data, base, risk) {
  const acceptableLoss = scaleMoney(base.liquid, data.profile.maxLossPct);
  return TEMPLATES.map((template) => {
    const weights = { ...template.weights };
    weights.equities = Math.min(weights.equities, risk.capacity.equityCapPct);
    weights.cash += template.weights.equities - weights.equities;
    // A sub-three-year horizon is a cash-only comparison: the input does not
    // describe bond duration, credit quality, or redemption terms.
    if (base.effectiveYears < 3)
      Object.assign(weights, { cash: 100, bonds: 0, equities: 0, gold: 0 });
    const amounts = distribute(base.pool, weights);
    const loss = marketLoss(amounts, data.stress);
    const reasons = [];
    if (base.pool === 0) reasons.push("预留必要储备后没有剩余可配置资金。");
    if (base.gap > 0) reasons.push("应急、短期目标与额外到期本金仍有缺口。");
    if (base.surplus < 0)
      reasons.push("月度结余为负，需要先制定现金流或提取安排。");
    if (base.summary.netWorth < 0)
      reasons.push("净资产为负，需要先核对债务安排。");
    if (loss > acceptableLoss)
      reasons.push("本次示例压力损失超过你填写的可接受金额。");
    const totalAmounts = {
      ...amounts,
      cash: amounts.cash + Math.min(base.target, base.liquid),
    };
    const totalWeights = Object.fromEntries(
      LIQUID_KEYS.map((key) => [
        key,
        percentage(totalAmounts[key], base.liquid),
      ]),
    );
    return {
      id: template.id,
      label: template.label,
      templateWeights: { ...template.weights },
      weights,
      amounts: Object.fromEntries(
        LIQUID_KEYS.map((key) => [key, yuan(amounts[key])]),
      ),
      totalLiquidAmounts: Object.fromEntries(
        LIQUID_KEYS.map((key) => [key, yuan(totalAmounts[key])]),
      ),
      totalLiquidWeights: totalWeights,
      capital: yuan(base.pool),
      reservedCash: yuan(Math.min(base.target, base.liquid)),
      equityCapPct: risk.capacity.equityCapPct,
      adjusted: LIQUID_KEYS.some(
        (key) => weights[key] !== template.weights[key],
      ),
      eligible: reasons.length === 0,
      reasons,
      lossEstimate: {
        amount: yuan(loss),
        pctOfLongTermPool: percentage(loss, base.pool),
        pctOfLiquidAssets: percentage(loss, base.liquid),
        withinWillingness: loss <= acceptableLoss,
        description:
          "指定跌幅的一次性教学压力情景；不是最大损失估计，也不是损失上限保证。",
      },
      equityLossEstimate: yuan(
        scaleMoney(amounts.equities, data.stress.equityDropPct),
      ),
      changes: LIQUID_KEYS.map((key) => ({
        asset: key,
        current: yuan(data.assets[key]),
        target: yuan(totalAmounts[key]),
        difference: yuan(totalAmounts[key] - data.assets[key]),
      })),
      implementationNote:
        "金额展示完成储备划分后的假设位置，不是立即交易指令；变现时间、税费和产品条款尚未纳入。",
    };
  });
}

function goalFunding(data, base) {
  if (
    data.goals === null ||
    !known(base.liquid, base.emergency, base.surplus, data.debts.dueWithinYear)
  )
    return null;
  const events = new Map();
  for (const goal of data.goals) {
    const event = events.get(goal.months) ?? {
      names: [],
      amount: 0,
      flexible: true,
    };
    event.names.push(goal.name);
    event.amount += goal.amount;
    event.flexible &&= goal.flexible;
    events.set(goal.months, event);
  }
  // Reserve the entire extra principal once, up front. Do not subtract it again
  // from goal events or subtract debt balance from liquid assets a second time.
  const initial = base.liquid - base.emergency - data.debts.dueWithinYear;
  let cumulativeGoals = 0;
  const rows = [...events]
    .sort(([left], [right]) => left - right)
    .map(([month, event]) => {
      cumulativeGoals += event.amount;
      const balance = initial + base.surplus * month - cumulativeGoals;
      const requiredMonthly =
        month > 0
          ? Math.max(0, Math.ceil((cumulativeGoals - initial) / month))
          : null;
      return {
        month,
        names: event.names,
        amount: yuan(event.amount),
        cumulativeGoalAmount: yuan(cumulativeGoals),
        balance: yuan(balance),
        fundingGap: yuan(Math.max(0, -balance)),
        requiredMonthlySurplus: yuan(requiredMonthly),
        flexible: event.flexible,
      };
    });
  return {
    initialGoalCapital: yuan(initial),
    monthlySurplusAssumed: yuan(base.surplus),
    rows,
    firstGapMonth: rows.find((row) => row.fundingGap > 0)?.month ?? null,
    assumption:
      "仅检查当前月度结余持续不变且投资收益为 0 的情景。收入、支出、月供均不预测变化，实际债务期限未输入；结果不是长期财富预测。应急金和额外到期本金仅预留一次。",
  };
}

function cashSimulation(data, base, stress) {
  const a = data.assets;
  const income = scaleMoney(data.cashflow.income, 100 - stress.incomeDropPct);
  const shock = marketLoss(a, stress);
  const reserveCash = Math.min(base.target, base.liquid);
  let cash = a.cash;
  let plannedCash = reserveCash;
  let liquid = base.liquid - shock;
  let firstCashShortfallMonth = null;
  let firstReserveShortfallMonth = null;
  let firstLiquidShortfallMonth = null;
  let minimumCash = cash;
  let minimumPlannedCash = plannedCash;
  let minimumLiquid = liquid;
  const series = [];
  for (let month = 0; month <= stress.months; month += 1) {
    const goalOutflow = data.goals
      .filter((goal) => goal.months === month)
      .reduce((sum, goal) => sum + goal.amount, 0);
    const extraDebt = month === 1 ? data.debts.dueWithinYear : 0;
    const currentIncome = month === 0 ? 0 : income;
    const expense = month === 0 ? 0 : data.cashflow.expense;
    const debtPayment = month === 0 ? 0 : data.debts.monthlyPayment;
    const change =
      currentIncome - expense - debtPayment - extraDebt - goalOutflow;
    cash += change;
    plannedCash += change;
    liquid += change;
    if (cash < 0 && firstCashShortfallMonth === null)
      firstCashShortfallMonth = month;
    if (plannedCash < 0 && firstReserveShortfallMonth === null)
      firstReserveShortfallMonth = month;
    if (liquid < 0 && firstLiquidShortfallMonth === null)
      firstLiquidShortfallMonth = month;
    minimumCash = Math.min(minimumCash, cash);
    minimumPlannedCash = Math.min(minimumPlannedCash, plannedCash);
    minimumLiquid = Math.min(minimumLiquid, liquid);
    series.push({
      month,
      income: yuan(currentIncome),
      expense: yuan(expense),
      debtPayment: yuan(debtPayment),
      extraDebt: yuan(extraDebt),
      goalOutflow: yuan(goalOutflow),
      endCash: yuan(cash),
      endPlannedReserveCash: yuan(plannedCash),
      endLiquidAssetsAfterShock: yuan(liquid),
      cashShortfall: yuan(Math.max(0, -cash)),
    });
  }
  return {
    parameters: { ...stress },
    reducedMonthlyIncome: yuan(income),
    monthlyCashBurn: yuan(base.essentials - income),
    marketLossOnCurrentHoldings: yuan(shock),
    startLiquidAssetsAfterShock: yuan(base.liquid - shock),
    firstCashShortfallMonth,
    firstReserveShortfallMonth,
    firstLiquidShortfallMonth,
    minimumCashBalance: yuan(minimumCash),
    minimumPlannedReserveCash: yuan(minimumPlannedCash),
    minimumLiquidAssetsAfterShock: yuan(minimumLiquid),
    additionalCashNeeded: yuan(Math.max(0, -minimumCash)),
    plannedReserveAdditionalCashNeeded: yuan(Math.max(0, -minimumPlannedCash)),
    endingCash: yuan(cash),
    endingPlannedReserveCash: yuan(plannedCash),
    endingLiquidAssetsAfterShock: yuan(liquid),
    series,
    assumptions: [
      "收入降幅持续整个输入月份数，支出与月供保持当前水平，未自动借款或卖出资产。",
      "额外本金只有“一年内”信息，保守放在第 1 个月支出；若已知到期日，应另核对实际现金日历。",
      "用途在输入月份一次性支付；第 0 个月表示立即支付。灵活目标仍按原计划计入。",
      "现有现金轨迹、完成储备划分后的现金轨迹、现有持仓受冲击后的可变现资产轨迹是三条独立比较口径，不相加。",
      "市场跌幅在期初一次发生；现金按面值、锁定资产与房产不变现，不包含税费、赎回限制、后续收益或偿债本金摊还。",
      "负数表示尚未覆盖的资金需求，不表示已经获得借款；损失情景不是最坏情况保证。",
    ],
  };
}

function sensitivities(data, base, scenarios) {
  const equityDrops = [
    ...new Set([20, 35, 50, data.stress.equityDropPct]),
  ].sort((left, right) => left - right);
  const lossLimit = scaleMoney(base.liquid, data.profile.maxLossPct);
  const market = scenarios.flatMap((scenario) =>
    equityDrops.map((equityDropPct) => {
      const amounts = Object.fromEntries(
        LIQUID_KEYS.map((key) => [key, fen(scenario.amounts[key])]),
      );
      const loss = marketLoss(amounts, { ...data.stress, equityDropPct });
      return {
        scenarioId: scenario.id,
        equityDropPct,
        bondDropPct: data.stress.bondDropPct,
        goldDropPct: data.stress.goldDropPct,
        lossAmount: yuan(loss),
        lossPctOfLiquidAssets: percentage(loss, base.liquid),
        withinWillingness: loss <= lossLimit,
      };
    }),
  );
  const income = [...new Set([3, 6, 12, data.stress.months])]
    .sort((left, right) => left - right)
    .map((months) => {
      const result = cashSimulation(data, base, { ...data.stress, months });
      return {
        months,
        incomeDropPct: data.stress.incomeDropPct,
        endingCash: result.endingCash,
        additionalCashNeeded: result.additionalCashNeeded,
        endingPlannedReserveCash: result.endingPlannedReserveCash,
        plannedReserveAdditionalCashNeeded:
          result.plannedReserveAdditionalCashNeeded,
        firstCashShortfallMonth: result.firstCashShortfallMonth,
        endingLiquidAssetsAfterShock: result.endingLiquidAssetsAfterShock,
      };
    });
  return { market, income };
}

function addWarnings(data, base, risk) {
  const warnings = data.validation.warnings;
  const add = (code, message) => warnings.push({ code, message });
  if (base.surplus < 0)
    add(
      "negative-surplus",
      `每月资金缺口 ${yuan(-base.surplus)} 元，请先核对支出、收入与偿债安排。`,
    );
  if (base.gap > 0)
    add(
      "reserve-gap",
      `必要储备仍差 ${yuan(base.gap)} 元；房产与锁定资产不能用于填补当前现金缺口。`,
    );
  if (base.reserves.emergencyCashGap > 0)
    add(
      "emergency-cash-gap",
      "现有现金不足应急目标，即使总资产足够，仍需核对变现时间与资金安排。",
    );
  if (risk.capacity.reserveBelowExample)
    add(
      "reserve-below-example",
      `所选应急金月数低于软件对该收入类型提供的 ${risk.capacity.exampleReserveMonths} 个月比较值，可在压力情景中自行比较。`,
    );
  if (risk.debtReview.highCostDebt)
    add(
      "debt-cost-review",
      "债务利率达到软件核对阈值，应把提前偿债作为待核对选项，与投资情景并列比较。",
    );
  if (base.earliestLongGoal && data.profile.horizonYears > base.effectiveYears)
    add(
      "goal-shortens-horizon",
      `“${base.earliestLongGoal.name}”的用款时间把配置评估期限缩短至 ${round2(base.effectiveYears)} 年。`,
    );
  if (base.summary.netWorth < 0)
    add("negative-networth", "债务余额大于已填资产估值，净资产为负。");
  if (
    data.goals?.some((goal) =>
      /偿债|还款|偿还|提前还|还贷|归还本金/.test(goal.name),
    )
  )
    add(
      "possible-debt-duplicate",
      "资金用途名称包含偿债内容：请确认它未与月供或额外到期本金重复；债务请统一在债务区填写。",
    );
}

export function calculateAllocation(input) {
  const data = parseInput(input);
  const common = {
    schemaVersion: "1.0",
    policy: { ...POLICY },
    validation: data.validation,
    assumptions: [
      "金额以人民币元输入与展示，以整数分核算；各类资产使用用户填写的当前估值。",
      "现金、可变现债券、权益、黄金可用于调配；房产与锁定资产只计入资产负债表。产品可变现性需要用户确认。",
      "必要支出不含月供；一年内额外本金不含已在月供列入的款项；用途列表不重复登记债务。",
      "36 个月内目标即使可调整也先全额预留。剩余资金的评估期限取用户期限与最近长期目标期限中的较短者。",
      "任何比例、风险阈值与压力跌幅都是软件教学示例，不能归属于资料作者；没有预测未来收益。",
    ],
    notes: [
      "先核对现金流与目标约束，再比较多种资产类别情景；期限、收入约束与损失意愿分别检查。",
      "风险意愿以可变现资产的可接受损失金额单独检查；示例压力通过不意味着不会超出该损失。",
      "持仓调整为相同估值时点的情景差额，实际操作还需要产品期限、税费、赎回与债务合同信息。",
    ],
  };
  if (data.validation.errors.length) {
    return {
      ...common,
      status: "invalid",
      summary: null,
      reserves: null,
      risk: null,
      scenarios: [],
      stress: null,
      sensitivity: null,
      goalFunding: null,
    };
  }
  const base = calculateBase(data);
  const risk = calculateRisk(data, base);
  addWarnings(data, base, risk);
  if (data.validation.missing.length) {
    return {
      ...common,
      status: "incomplete",
      summary: base.summary,
      reserves: base.reserves,
      risk,
      scenarios: [],
      stress: null,
      sensitivity: null,
      goalFunding: goalFunding(data, base),
    };
  }
  const scenarios = allocationScenarios(data, base, risk);
  const stress = cashSimulation(data, base, data.stress);
  stress.defaultedFields = data.defaultedStressFields;
  return {
    ...common,
    status: "ready",
    summary: base.summary,
    reserves: base.reserves,
    risk,
    scenarios,
    stress,
    sensitivity: sensitivities(data, base, scenarios),
    goalFunding: goalFunding(data, base),
  };
}
