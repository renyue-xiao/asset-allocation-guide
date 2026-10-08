import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateAllocation,
  validateInput,
  DEFAULT_STRESS,
  POLICY,
} from "../lib/allocation.mjs";
import { SAMPLE_CASES, getSample } from "../lib/samples.mjs";

function input() {
  return {
    assets: {
      cash: 100000,
      bonds: 100000,
      equities: 100000,
      gold: 0,
      locked: 500000,
      property: 1000000,
    },
    debts: {
      balance: 200000,
      monthlyPayment: 2000,
      apr: 4,
      dueWithinYear: 10000,
    },
    cashflow: { income: 20000, expense: 8000 },
    profile: {
      stability: "stable",
      correlatedIncome: false,
      experience: "experienced",
      horizonYears: 15,
      maxLossPct: 30,
      reserveMonths: 6,
    },
    goals: [
      { name: "明确消费目标", amount: 30000, months: 12, flexible: false },
    ],
    stress: {
      incomeDropPct: 100,
      months: 6,
      equityDropPct: 35,
      bondDropPct: 8,
      goldDropPct: 15,
    },
  };
}

const cents = (value) => Math.round(value * 100);
const totalCents = (object) =>
  Object.values(object).reduce((sum, value) => sum + cents(value), 0);

test("四个自编样例均可计算并且覆盖负债、退休、收入相关性", () => {
  assert.equal(SAMPLE_CASES.length, 4);
  for (const sample of SAMPLE_CASES) {
    const result = calculateAllocation(sample.input);
    assert.equal(result.status, "ready", sample.id);
    assert.equal(result.validation.errors.length, 0, sample.id);
    assert.equal(result.scenarios.length, 3, sample.id);
  }
});

test("资产负债表与现金流分开，月供只扣一次", () => {
  const result = calculateAllocation(input());
  assert.equal(result.summary.grossAssets, 1800000);
  assert.equal(result.summary.financialAssets, 800000);
  assert.equal(result.summary.liquidAssets, 300000);
  assert.equal(result.summary.netWorth, 1600000);
  assert.equal(result.summary.monthlySurplus, 10000);
  assert.equal(result.reserves.monthlyEssentials, 10000);
  assert.equal(result.summary.debtServicePct, 10);
});

test("储备仅含应急、短期目标、额外本金，不重复扣全部债务余额", () => {
  const result = calculateAllocation(input());
  assert.equal(result.reserves.emergencyTarget, 60000);
  assert.equal(result.reserves.nearTermGoals, 30000);
  assert.equal(result.reserves.extraDebtDue, 10000);
  assert.equal(result.reserves.target, 100000);
  assert.equal(result.reserves.longTermPool, 200000);
  assert.equal(result.goalFunding.initialGoalCapital, 230000);
});

test("锁定金融资产和房产不会增加可调配金额", () => {
  const value = input();
  const first = calculateAllocation(value);
  value.assets.locked += 10000000;
  value.assets.property += 10000000;
  const second = calculateAllocation(value);
  assert.equal(second.reserves.longTermPool, first.reserves.longTermPool);
  assert.equal(
    second.reserves.emergencyCashGap,
    first.reserves.emergencyCashGap,
  );
  assert.equal(second.summary.netWorth, first.summary.netWorth + 20000000);
});

test("空白、null 和缺失金额均不按 0 处理", () => {
  for (const absent of ["", "  ", null, undefined]) {
    const value = input();
    value.assets.cash = absent;
    const result = calculateAllocation(value);
    assert.equal(result.status, "incomplete");
    assert.equal(result.summary.liquidAssets, null);
    assert.equal(result.reserves.longTermPool, null);
    assert.equal(result.scenarios.length, 0);
    assert.ok(
      result.validation.missing.some((issue) => issue.path === "assets.cash"),
    );
  }
});

test("明确的 0 与字符串 0 都有效", () => {
  const value = input();
  value.debts = { balance: "0", monthlyPayment: 0, apr: 0, dueWithinYear: 0 };
  value.assets.gold = "0";
  value.profile.maxLossPct = 0;
  assert.equal(calculateAllocation(value).status, "ready");
});

test("只缺风险资料仍可显示金额账，但不输出配置情景", () => {
  const value = input();
  value.profile.experience = "unknown";
  value.profile.correlatedIncome = null;
  const result = calculateAllocation(value);
  assert.equal(result.status, "incomplete");
  assert.equal(result.summary.netWorth, 1600000);
  assert.equal(result.reserves.longTermPool, 200000);
  assert.equal(result.risk.capacity.equityCapPct, null);
  assert.deepEqual(result.scenarios, []);
});

test("未知目标不能被视为无目标，明确空列表才是无目标", () => {
  const value = input();
  delete value.goals;
  const missing = calculateAllocation(value);
  assert.equal(missing.status, "incomplete");
  assert.equal(missing.reserves.nearTermGoals, null);
  value.goals = [];
  assert.equal(calculateAllocation(value).status, "ready");
});

test("拒绝非有限、负数、布尔值、十六进制和货币格式数字", () => {
  for (const bad of [
    NaN,
    Infinity,
    -1,
    true,
    false,
    "0x10",
    "10,000",
    {},
    [],
  ]) {
    const value = input();
    value.assets.cash = bad;
    const result = calculateAllocation(value);
    assert.equal(result.status, "invalid", String(bad));
    assert.equal(result.summary, null);
    assert.ok(
      result.validation.errors.some((issue) => issue.path === "assets.cash"),
    );
  }
});

test("每项数字约束都检查范围、精度及整数期限", () => {
  const mutations = [
    (value) => (value.assets.cash = POLICY.maxMoney + 1),
    (value) => (value.assets.bonds = 1.001),
    (value) => (value.debts.apr = 100.01),
    (value) => (value.profile.horizonYears = 61),
    (value) => (value.profile.maxLossPct = 101),
    (value) => (value.profile.reserveMonths = 3.5),
    (value) => (value.goals[0].months = 12.5),
    (value) => (value.goals[0].months = 721),
    (value) => (value.stress.months = 0),
    (value) => (value.stress.months = 121),
    (value) => (value.stress.equityDropPct = -1),
  ];
  for (const mutate of mutations) {
    const value = input();
    mutate(value);
    assert.equal(calculateAllocation(value).status, "invalid");
  }
});

test("布尔项和枚举项不能用看似合理的字符串代替", () => {
  for (const mutate of [
    (value) => (value.profile.correlatedIncome = "false"),
    (value) => (value.profile.stability = "normal"),
    (value) => (value.goals[0].flexible = 0),
  ]) {
    const value = input();
    mutate(value);
    assert.equal(calculateAllocation(value).status, "invalid");
  }
});

test("债务本金与月供边界冲突会阻止计算", () => {
  const value = input();
  value.debts.dueWithinYear = value.debts.balance + 0.01;
  assert.ok(
    validateInput(value).errors.some((issue) => issue.code === "debt-balance"),
  );
  value.debts = { balance: 0, monthlyPayment: 100, apr: 0, dueWithinYear: 0 };
  assert.equal(calculateAllocation(value).status, "invalid");
  value.debts = { balance: 0, monthlyPayment: 0, apr: 4, dueWithinYear: 0 };
  assert.equal(calculateAllocation(value).status, "invalid");
});

test("全年偿债额可超过剩余本金，不能误当作本金冲突", () => {
  const value = input();
  value.debts = {
    balance: 2000,
    monthlyPayment: 1000,
    apr: 20,
    dueWithinYear: 0,
  };
  assert.equal(calculateAllocation(value).status, "ready");
});

test("显式债务用途阻止重复计入，名称疑似债务会提示核对", () => {
  const value = input();
  value.goals[0].kind = "debt";
  assert.ok(
    validateInput(value).errors.some((issue) => issue.code === "debt-goal"),
  );
  delete value.goals[0].kind;
  value.goals[0].name = "提前还贷";
  assert.ok(
    calculateAllocation(value).validation.warnings.some(
      (issue) => issue.code === "possible-debt-duplicate",
    ),
  );
});

test("36 月边界全额预留，37 月目标留在长期池但缩短期限", () => {
  const value = input();
  value.goals = [
    { name: "短期边界", amount: 20000, months: 36, flexible: true },
    { name: "下一月目标", amount: 40000, months: 37, flexible: false },
  ];
  const result = calculateAllocation(value);
  assert.equal(result.reserves.nearTermGoals, 20000);
  assert.equal(result.reserves.longTermPool, 210000);
  assert.equal(result.reserves.effectiveHorizonYears, 3.08);
  assert.equal(result.risk.capacity.equityCapPct, 30);
  assert.equal(result.reserves.nearestLongTermGoal.name, "下一月目标");
});

test("短于三年配置全部现金，不以短期债券期限未知的资产代替", () => {
  const value = input();
  value.profile.horizonYears = 2.99;
  const result = calculateAllocation(value);
  for (const scenario of result.scenarios) {
    assert.deepEqual(scenario.weights, {
      cash: 100,
      bonds: 0,
      equities: 0,
      gold: 0,
    });
    assert.equal(scenario.lossEstimate.amount, 0);
  }
});

test("长期目标按最早非零用途检查，零金额目标不缩短期限", () => {
  const value = input();
  value.goals = [{ name: "占位目标", amount: 0, months: 37, flexible: true }];
  const result = calculateAllocation(value);
  assert.equal(result.reserves.effectiveHorizonYears, 15);
});

test("风险能力与损失意愿分开，低损失意愿不会伪装成能力低分", () => {
  const value = input();
  value.profile.maxLossPct = 0;
  const result = calculateAllocation(value);
  assert.equal(result.risk.capacity.equityCapPct, 75);
  assert.equal(result.risk.willingness.maxLossAmount, 0);
  assert.ok(result.scenarios.every((scenario) => scenario.eligible === false));
  assert.ok(
    result.scenarios.every((scenario) =>
      scenario.reasons.some((reason) => reason.includes("可接受")),
    ),
  );
});

test("意愿未知不会擦除已知能力结论，但会阻止完整配置", () => {
  const value = input();
  value.profile.maxLossPct = null;
  const result = calculateAllocation(value);
  assert.equal(result.status, "incomplete");
  assert.equal(result.risk.capacity.equityCapPct, 75);
  assert.equal(result.risk.willingness.maxLossAmount, null);
  assert.deepEqual(result.scenarios, []);
});

test("投资经验和职业市场关联各有可解释约束", () => {
  const value = input();
  value.profile.experience = "none";
  let result = calculateAllocation(value);
  assert.equal(result.risk.capacity.equityCapPct, 25);
  assert.equal(result.scenarios[2].weights.equities, 25);
  value.profile.experience = "experienced";
  value.profile.correlatedIncome = true;
  result = calculateAllocation(value);
  assert.equal(result.risk.capacity.equityCapPct, 40);
  assert.ok(
    result.risk.capacity.constraints.some(
      (item) => item.key === "correlated-income",
    ),
  );
});

test("高债务支出收紧能力，上限边界采用严格大于", () => {
  const value = input();
  value.debts.monthlyPayment = 7000;
  let result = calculateAllocation(value);
  assert.equal(result.summary.debtServicePct, 35);
  assert.equal(result.risk.capacity.equityCapPct, 75);
  value.debts.monthlyPayment = 7000.01;
  result = calculateAllocation(value);
  assert.equal(result.summary.debtServicePct, 35);
  assert.equal(result.risk.capacity.equityCapPct, 40);
  value.debts.monthlyPayment = 7100;
  result = calculateAllocation(value);
  assert.equal(result.risk.capacity.equityCapPct, 40);
  value.debts.monthlyPayment = 10100;
  result = calculateAllocation(value);
  assert.equal(result.risk.capacity.equityCapPct, 20);
});

test("高负债样例月度缺口和储备缺口同时存在，不能输出可执行候选", () => {
  const result = calculateAllocation(getSample("debt-pressure").input);
  assert.equal(result.summary.netWorth, 660000);
  assert.equal(result.summary.monthlySurplus, -4000);
  assert.equal(result.reserves.target, 616000);
  assert.equal(result.reserves.fundingGap, 456000);
  assert.equal(result.reserves.longTermPool, 0);
  assert.equal(result.risk.capacity.equityCapPct, 0);
  assert.ok(result.scenarios.every((scenario) => !scenario.eligible));
  assert.equal(result.stress.firstCashShortfallMonth, 1);
});

test("月结余为负但尚有长期池时也会拦截增加风险", () => {
  const value = input();
  value.cashflow.income = 9000;
  const result = calculateAllocation(value);
  assert.equal(result.reserves.longTermPool, 200000);
  assert.equal(result.summary.monthlySurplus, -1000);
  assert.ok(result.scenarios.every((scenario) => !scenario.eligible));
});

test("完全收入中断逐月扣款，并且额外到期本金只在月一扣一次", () => {
  const result = calculateAllocation(input());
  assert.equal(result.stress.series.length, 7);
  assert.equal(result.stress.series[0].endCash, 100000);
  assert.equal(result.stress.series[1].endCash, 80000);
  assert.equal(result.stress.series[2].endCash, 70000);
  assert.equal(result.stress.endingCash, 30000);
  assert.equal(
    result.stress.series.reduce((sum, row) => sum + row.extraDebt, 0),
    10000,
  );
  assert.equal(result.stress.marketLossOnCurrentHoldings, 43000);
  assert.equal(result.stress.endingLiquidAssetsAfterShock, 187000);
});

test("即期目标在月零扣一次，灵活目标仍按输入计划支付", () => {
  const value = input();
  value.goals = [
    { name: "立即支出", amount: 110000, months: 0, flexible: true },
  ];
  const result = calculateAllocation(value);
  assert.equal(result.stress.series[0].endCash, -10000);
  assert.equal(result.stress.firstCashShortfallMonth, 0);
  assert.equal(result.stress.series[1].goalOutflow, 0);
  assert.equal(
    result.stress.series.reduce((sum, row) => sum + row.goalOutflow, 0),
    110000,
  );
});

test("现金不足与变现后资产充足分别展示，未自动假定卖出持仓", () => {
  const value = input();
  value.assets.cash = 5000;
  value.assets.bonds = 195000;
  const result = calculateAllocation(value);
  assert.equal(result.reserves.emergencyCashGap, 55000);
  assert.equal(result.reserves.fundingGap, 0);
  assert.equal(result.reserves.marketAssetsToRelease, 95000);
  assert.equal(result.stress.firstCashShortfallMonth, 1);
  assert.equal(result.stress.firstReserveShortfallMonth, null);
  assert.equal(result.stress.firstLiquidShortfallMonth, null);
});

test("现金负数表示缺口，不将每月同一缺口重复累计", () => {
  const value = input();
  value.assets.cash = 0;
  const result = calculateAllocation(value);
  assert.equal(result.stress.endingCash, -70000);
  assert.equal(result.stress.additionalCashNeeded, 70000);
});

test("收入仅下降一半时按降幅计算，不全额中断", () => {
  const value = input();
  value.stress.incomeDropPct = 50;
  const result = calculateAllocation(value);
  assert.equal(result.stress.reducedMonthlyIncome, 10000);
  assert.equal(result.stress.monthlyCashBurn, 0);
  assert.equal(result.stress.endingCash, 90000);
});

test("敏感性比较多个权益跌幅并保留自定义情景", () => {
  const value = input();
  value.stress.equityDropPct = 42;
  const result = calculateAllocation(value);
  assert.deepEqual(
    [...new Set(result.sensitivity.market.map((row) => row.equityDropPct))],
    [20, 35, 42, 50],
  );
  const growth = result.sensitivity.market.filter(
    (row) => row.scenarioId === "growth",
  );
  assert.ok(growth[0].lossAmount < growth[1].lossAmount);
  assert.ok(growth[1].lossAmount < growth[2].lossAmount);
  assert.deepEqual(
    result.sensitivity.income.map((row) => row.months),
    [3, 6, 12],
  );
});

test("整分分配保持金额守恒，即使长期池只有一分钱", () => {
  const value = input();
  value.assets = {
    cash: 0.01,
    bonds: 0,
    equities: 0,
    gold: 0,
    locked: 0,
    property: 0,
  };
  value.debts = { balance: 0, monthlyPayment: 0, apr: 0, dueWithinYear: 0 };
  value.cashflow = { income: 0, expense: 0 };
  value.goals = [];
  const result = calculateAllocation(value);
  assert.equal(result.status, "ready");
  for (const scenario of result.scenarios) {
    assert.equal(totalCents(scenario.amounts), 1);
    assert.equal(totalCents(scenario.totalLiquidAmounts), 1);
    assert.equal(
      Object.values(scenario.weights).reduce((sum, weight) => sum + weight, 0),
      100,
    );
  }
});

test("普通样例金额守恒，现持仓差额的总和为零", () => {
  for (const sample of SAMPLE_CASES) {
    const result = calculateAllocation(sample.input);
    for (const scenario of result.scenarios) {
      assert.equal(
        totalCents(scenario.amounts),
        cents(result.reserves.longTermPool),
      );
      assert.equal(
        totalCents(scenario.totalLiquidAmounts),
        cents(result.summary.liquidAssets),
      );
      assert.equal(
        scenario.changes.reduce((sum, row) => sum + cents(row.difference), 0),
        0,
      );
    }
  }
});

test("高额输入仍保留整分金额与精确损失核算", () => {
  const value = input();
  value.assets = {
    cash: POLICY.maxMoney,
    bonds: POLICY.maxMoney,
    equities: POLICY.maxMoney,
    gold: POLICY.maxMoney,
    locked: 0,
    property: 0,
  };
  value.debts = { balance: 0, monthlyPayment: 0, apr: 0, dueWithinYear: 0 };
  value.cashflow = { income: 0, expense: 0 };
  value.goals = [];
  value.stress = {
    incomeDropPct: 100,
    months: 120,
    equityDropPct: 99.99,
    bondDropPct: 99.99,
    goldDropPct: 99.99,
  };
  const result = calculateAllocation(value);
  assert.equal(result.status, "ready");
  assert.equal(result.stress.marketLossOnCurrentHoldings, 29997000000);
  for (const scenario of result.scenarios)
    assert.equal(totalCents(scenario.amounts), cents(4 * POLICY.maxMoney));
});

test("目标资金检查无收益假设，期限顺序累计、同月目标合并", () => {
  const value = input();
  value.goals = [
    { name: "较后目标", amount: 300000, months: 24, flexible: false },
    { name: "同月甲", amount: 100000, months: 12, flexible: true },
    { name: "同月乙", amount: 100000, months: 12, flexible: false },
  ];
  const result = calculateAllocation(value);
  const rows = result.goalFunding.rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].month, 12);
  assert.equal(rows[0].balance, 150000);
  assert.equal(rows[0].flexible, false);
  assert.equal(rows[1].balance, -30000);
  assert.equal(rows[1].fundingGap, 30000);
  assert.equal(rows[1].requiredMonthlySurplus, 11250);
});

test("未给压力对象时显示实际使用的软件默认值，显式空值保持未知", () => {
  const value = input();
  delete value.stress;
  const result = calculateAllocation(value);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.stress.parameters, DEFAULT_STRESS);
  assert.equal(result.stress.defaultedFields.length, 5);
  value.stress = { months: null };
  assert.equal(calculateAllocation(value).status, "incomplete");
});

test("退休样例按意愿剔除高损失情景，不用年龄单独决定比例", () => {
  const result = calculateAllocation(getSample("retirement").input);
  assert.equal(result.reserves.longTermPool, 2032000);
  assert.equal(result.risk.capacity.equityCapPct, 55);
  assert.equal(result.risk.willingness.maxLossAmount, 360000);
  assert.deepEqual(
    result.scenarios.map((scenario) => scenario.eligible),
    [true, false, false],
  );
});

test("零资产、零收入仍是有效输入，无 NaN 或伪造可投金额", () => {
  const value = input();
  value.assets = Object.fromEntries(
    Object.keys(value.assets).map((key) => [key, 0]),
  );
  value.debts = { balance: 0, monthlyPayment: 0, apr: 0, dueWithinYear: 0 };
  value.cashflow = { income: 0, expense: 0 };
  value.goals = [];
  const result = calculateAllocation(value);
  assert.equal(result.status, "ready");
  assert.equal(result.reserves.longTermPool, 0);
  assert.ok(result.scenarios.every((scenario) => !scenario.eligible));
  assert.equal(result.summary.debtServicePct, 0);
  assert.ok(!JSON.stringify(result).includes("NaN"));
});

test("输入和样例不被计算或外部样例副本修改", () => {
  const value = input();
  const before = structuredClone(value);
  assert.deepEqual(calculateAllocation(value), calculateAllocation(value));
  assert.deepEqual(value, before);
  const sample = getSample("steady-family");
  sample.input.assets.cash = 1;
  assert.equal(getSample("steady-family").input.assets.cash, 180000);
  assert.equal(getSample("missing"), null);
});
test("大额两位小数不因二进制浮点误差被判为超精度", () => {
  const input = structuredClone(SAMPLE_CASES[0].input);
  input.assets.cash = 9999999999.97;
  const r = calculateAllocation(input);
  assert.equal(r.status, "ready");
  assert.equal(r.summary.currentLiquidAmounts.cash, 9999999999.97);
  input.assets.cash = 9999999999.971;
  assert.equal(calculateAllocation(input).status, "invalid");
});
