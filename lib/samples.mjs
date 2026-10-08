/** Entirely fictional teaching examples, authored for this software. */
export const SAMPLE_CASES = [
  {
    id: "steady-family",
    name: "双职工家庭 · 教育与长期积累",
    description:
      "近期有教育支出，长期资金还要为十年后的教育目标服务；体现目标期限如何改变配置。",
    input: {
      assets: {
        cash: 180000,
        bonds: 320000,
        equities: 300000,
        gold: 50000,
        locked: 120000,
        property: 3000000,
      },
      debts: {
        balance: 1000000,
        monthlyPayment: 8000,
        apr: 3.5,
        dueWithinYear: 0,
      },
      cashflow: { income: 35000, expense: 16000 },
      profile: {
        stability: "stable",
        correlatedIncome: false,
        experience: "some",
        horizonYears: 15,
        maxLossPct: 20,
        reserveMonths: 6,
      },
      goals: [
        {
          name: "两年内教育与家庭支出",
          amount: 150000,
          months: 24,
          flexible: false,
        },
        {
          name: "十年后的教育准备",
          amount: 500000,
          months: 120,
          flexible: false,
        },
      ],
      stress: {
        incomeDropPct: 100,
        months: 6,
        equityDropPct: 35,
        bondDropPct: 8,
        goldDropPct: 15,
      },
    },
  },
  {
    id: "debt-pressure",
    name: "高负债家庭 · 现金优先",
    description:
      "净资产为正但月度收支为负，同时有到期本金和近期购置目标；愿意冒险也无法填补现金缺口。",
    input: {
      assets: {
        cash: 30000,
        bonds: 50000,
        equities: 80000,
        gold: 0,
        locked: 100000,
        property: 2000000,
      },
      debts: {
        balance: 1600000,
        monthlyPayment: 14000,
        apr: 8.4,
        dueWithinYear: 100000,
      },
      cashflow: { income: 20000, expense: 10000 },
      profile: {
        stability: "fragile",
        correlatedIncome: false,
        experience: "some",
        horizonYears: 10,
        maxLossPct: 60,
        reserveMonths: 9,
      },
      goals: [
        {
          name: "十八个月后购置计划",
          amount: 300000,
          months: 18,
          flexible: true,
        },
      ],
      stress: {
        incomeDropPct: 100,
        months: 6,
        equityDropPct: 35,
        bondDropPct: 8,
        goldDropPct: 15,
      },
    },
  },
  {
    id: "retirement",
    name: "退休家庭 · 支出与波动承受",
    description:
      "退休金覆盖日常支出，八年后有大额照护用途；较低损失意愿会排除部分比较情景。",
    input: {
      assets: {
        cash: 350000,
        bonds: 1200000,
        equities: 650000,
        gold: 200000,
        locked: 300000,
        property: 3000000,
      },
      debts: { balance: 0, monthlyPayment: 0, apr: 0, dueWithinYear: 0 },
      cashflow: { income: 18000, expense: 14000 },
      profile: {
        stability: "stable",
        correlatedIncome: false,
        experience: "experienced",
        horizonYears: 15,
        maxLossPct: 15,
        reserveMonths: 12,
      },
      goals: [
        {
          name: "两年内旅行与居家改善",
          amount: 200000,
          months: 24,
          flexible: true,
        },
        { name: "八年后照护储备", amount: 500000, months: 96, flexible: false },
      ],
      stress: {
        incomeDropPct: 50,
        months: 12,
        equityDropPct: 35,
        bondDropPct: 8,
        goldDropPct: 15,
      },
    },
  },
  {
    id: "correlated-career",
    name: "收入随市场波动 · 人力资产视角",
    description:
      "资产较多但部分锁定，职业收入与市场相关；比较收入下降与市场下跌同时发生的影响。",
    input: {
      assets: {
        cash: 500000,
        bonds: 300000,
        equities: 700000,
        gold: 100000,
        locked: 1500000,
        property: 4000000,
      },
      debts: {
        balance: 2000000,
        monthlyPayment: 12000,
        apr: 4.2,
        dueWithinYear: 100000,
      },
      cashflow: { income: 60000, expense: 28000 },
      profile: {
        stability: "variable",
        correlatedIncome: true,
        experience: "experienced",
        horizonYears: 10,
        maxLossPct: 25,
        reserveMonths: 12,
      },
      goals: [
        {
          name: "十八个月后家庭支出",
          amount: 400000,
          months: 18,
          flexible: true,
        },
      ],
      stress: {
        incomeDropPct: 50,
        months: 6,
        equityDropPct: 35,
        bondDropPct: 8,
        goldDropPct: 15,
      },
    },
  },
];

export function getSample(id) {
  const sample = SAMPLE_CASES.find((candidate) => candidate.id === id);
  return sample ? structuredClone(sample) : null;
}
