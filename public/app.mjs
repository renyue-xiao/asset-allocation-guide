import { calculateAllocation, DEFAULT_STRESS } from "./lib/allocation.mjs";
import { SAMPLE_CASES } from "./lib/samples.mjs";
import { compareRebalance } from "./lib/discipline.mjs";

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fmt = (n) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "待填写"
    : new Intl.NumberFormat("zh-CN", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(n);
const money = (n) =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : `¥ ${fmt(n)}`;
const names = {
  cash: "现金",
  bonds: "债券类",
  equities: "权益类",
  gold: "黄金类",
};
const kinds = {
  book: "书籍",
  podcast: "播客/转写",
  article: "文章",
  qa: "问答/文字稿",
};
const clone = (obj) => structuredClone(obj);
const blankInput = () => ({
  assets: {
    cash: null,
    bonds: null,
    equities: null,
    gold: null,
    locked: null,
    property: null,
  },
  debts: {
    balance: null,
    monthlyPayment: null,
    apr: null,
    dueWithinYear: null,
  },
  cashflow: { income: null, expense: null },
  profile: {
    stability: "unknown",
    correlatedIncome: null,
    experience: "unknown",
    horizonYears: null,
    maxLossPct: null,
    reserveMonths: null,
  },
  goals: null,
  stress: { ...DEFAULT_STRESS },
});
let state = {
  input: blankInput(),
  step: 0,
  view: "planner",
  sample: null,
  scenario: "balanced",
  sources: [],
  chat: [],
  busy: false,
  journal: [],
  discipline: { tolerancePct: 5, newCash: 0, reviewDate: "", reason: "" },
};
let result = calculateAllocation(state.input);
let toastTimer;
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 4300);
}
function get(path) {
  return path.split(".").reduce((v, k) => v?.[k], state.input);
}
function set(path, value) {
  const keys = path.split(".");
  let target = state.input;
  for (const key of keys.slice(0, -1)) target = target[key];
  target[keys.at(-1)] = value;
}
function inputField(path, label, hint = "", unit = "元", options = {}) {
  const val = get(path);
  return `<label class="form-field"><span>${esc(label)}</span><div class="input-wrap"><input type="number" inputmode="decimal" data-path="${path}" id="field-${path.replaceAll(".", "-")}" value="${val ?? ""}" min="0" step="${options.integer ? "1" : ".01"}" ${options.max ? `max="${options.max}"` : ""} placeholder="未知留空" aria-describedby="hint-${path.replaceAll(".", "-")}"><em>${unit}</em></div><small id="hint-${path.replaceAll(".", "-")}">${esc(hint || "没有此项，请明确填 0。")}</small></label>`;
}
function selectField(path, label, choices, hint = "") {
  const val = get(path);
  return `<label class="form-field"><span>${esc(label)}</span><select data-path="${path}" ${path === "profile.correlatedIncome" ? 'data-boolean="true"' : ""}><option value="unknown">尚不确定</option>${choices.map(([v, t]) => `<option value="${v}" ${String(val) === String(v) ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>${hint ? `<small>${esc(hint)}</small>` : ""}</label>`;
}
function renderSummary() {
  result = calculateAllocation(state.input);
  const s = result.summary || {},
    r = result.reserves || {};
  $("#live-summary").innerHTML =
    `<dl><div class="summary-item"><dt>总资产</dt><dd>${money(s.grossAssets)}</dd></div><div class="summary-item ${s.netWorth < 0 ? "negative" : ""}"><dt>净资产</dt><dd>${money(s.netWorth)}</dd></div><div class="summary-item emphasis"><dt>可变现资产</dt><dd>${money(s.liquidAssets)}</dd></div><div class="summary-item ${s.monthlySurplus < 0 ? "negative" : ""}"><dt>每月结余</dt><dd>${money(s.monthlySurplus)}</dd></div><div class="summary-item"><dt>应急目标</dt><dd>${money(r.emergencyTarget)}</dd></div><div class="summary-item emphasis"><dt>预留后剩余</dt><dd>${money(r.longTermPool)}</dd></div></dl><p class="summary-caption">${result.status === "ready" ? "已具备情景计算所需的信息。" : result.status === "invalid" ? "有输入冲突，请核对后继续。" : `还需确认 ${result.validation.missing.length} 项信息；空白不按零处理。`}</p>`;
  $("#sample-label").textContent = state.sample
    ? `当前：虚构样例 · ${state.sample}`
    : "当前：我的规划";
}
function renderStep() {
  renderSummary();
  const labels = ["家庭底账", "资金目标", "风险边界", "配置情景"];
  $("#stepper").innerHTML = labels
    .map(
      (l, i) =>
        `<button class="step-tab ${i === state.step ? "active" : ""}" data-step="${i}" ${i === state.step ? 'aria-current="step"' : ""}><span>0${i + 1}</span>${l}</button>`,
    )
    .join("");
  const intros = [
    [
      "先把家庭看作一张完整的表。",
      "金额均为人民币元。填当前估值；未知可留空，没有此项请填 0。",
    ],
    [
      "给每一笔钱，写上用途与期限。",
      "应急储备独立保留。生活与购置目标填在这里；贷款还款统一填在债务区。",
    ],
    [
      "愿意承担，与能够承担，分别确认。",
      "收入稳定性、市场关联、投资经历与期限各自约束情景；不会被合并成一个分数。",
    ],
  ];
  let inner = "";
  if (state.step < 3) {
    inner = `<div class="step-intro"><span class="step-number">0${state.step + 1}</span><div><h3>${intros[state.step][0]}</h3><p>${intros[state.step][1]}</p></div></div>`;
  }
  if (state.step === 0) {
    inner += `<section class="form-section"><div class="form-section-heading"><h4>01 / 资产 · 不重复计算</h4><span class="small">当前可变现与暂不能变现分开</span></div><div class="form-grid">${inputField("assets.cash", "现金及随时可支取资金", "现金、活期等；不含已列在其他类别的金额。")}${inputField("assets.bonds", "可变现债券类资产", "包括债券基金；不代表保本或即时到账。")}${inputField("assets.equities", "可变现权益类资产", "股票、股票型基金等当前市值。")}${inputField("assets.gold", "可变现黄金类资产", "填可估值、可变现部分；避免重复。")}${inputField("assets.locked", "锁定 / 暂不可赎回金融资产", "只进入总资产，不进入可调配资金。")}${inputField("assets.property", "房产估值", "只进入总资产，不视作当下现金。")}</div></section><section class="form-section"><div class="form-section-heading"><h4>02 / 负债 · 本金与月供分别记录</h4><button class="text-button" data-zero="debts">明确没有债务</button></div><div class="form-grid">${inputField("debts.balance", "债务余额")}${inputField("debts.monthlyPayment", "每月偿债额", "每月实际还款，包含本金与利息。")}${inputField("debts.apr", "债务年利率", "多笔债务请填需优先核对的最高年利率。", "%", { max: 100 })}${inputField("debts.dueWithinYear", "一年内额外到期本金", "不含已计入月供的本金；无额外到期填 0。")}</div></section><section class="form-section"><div class="form-section-heading"><h4>03 / 收支 · 使用相同的月度口径</h4></div><div class="form-grid">${inputField("cashflow.income", "每月税后收入", "含工资、经营等经常性收入。")}${inputField("cashflow.expense", "每月必要支出", "不含月供；需要时将年度必要开支按月分摊。")}</div></section><div class="inline-note">可变现 ≠ 随时可支用。后续会单独检查现金缺口，并保留赎回时间与产品条款的核对项。</div>`;
  } else if (state.step === 1) {
    inner += `<section class="form-section"><div class="form-section-heading"><h4>先留出生活底座</h4></div><div class="form-grid">${inputField("profile.reserveMonths", "应急金覆盖月数", "以必要支出 + 月供为基数，由你自行设定。", "个月", { integer: true, max: 60 })}<div class="inline-note" style="margin-top:0">${result.reserves?.emergencyTarget != null ? `按当前支出，对应应急目标 <strong>${money(result.reserves.emergencyTarget)}</strong>。` : "填好收支、月供与月数后，将显示应急目标。"}<br>可在最后一步比较收入中断情景。</div></div></section><div class="form-section-heading"><h4>再写下未来的具体用途</h4><button class="text-button" id="no-goals">明确暂无其他目标</button></div>${goalsMarkup()}<button class="add-goal" id="add-goal">＋ 添加一项资金用途</button><div class="inline-note">36 个月内的目标按全额预留，是本工具的保守示例规则。可延期目标也先按原计划计算；你可修改期限后对照结果。</div>`;
  } else if (state.step === 2) {
    inner += `<div class="form-grid">${selectField(
      "profile.stability",
      "收入稳定性",
      [
        ["stable", "较稳定，可预期"],
        ["variable", "有波动，收入不固定"],
        ["fragile", "较脆弱，容易中断"],
      ],
      "根据实际收入来源判断，不按职业名称推断。",
    )}${selectField(
      "profile.correlatedIncome",
      "收入与金融市场是否明显同向",
      [
        [false, "关联不明显"],
        [true, "明显相关 / 同一行业风险"],
      ],
      "例如奖金、雇主股权与持仓依赖同一市场。",
    )}${selectField(
      "profile.experience",
      "投资经历",
      [
        ["none", "尚无投资经验"],
        ["some", "有一些经验"],
        ["experienced", "经历过完整涨跌周期"],
      ],
      "经历用于提示认知边界，不等于更愿意亏损。",
    )}${inputField("profile.horizonYears", "剩余资金可投资年限", "目标中更早的用款时间可能缩短该期限。", "年", { max: 60 })}${inputField("profile.maxLossPct", "可变现资产可接受的一次性损失", "基数为现金、债券、权益、黄金合计，不含房产。", "%", { max: 100 })}<div class="inline-note" style="margin-top:0">${result.risk?.willingness?.maxLossAmount != null ? `你填写的损失意愿对应 <strong>${money(result.risk.willingness.maxLossAmount)}</strong>。` : "同时想一想：损失发生后，目标还能按时完成吗？"}<br>压力测试的跌幅是假设，不是亏损上限。</div></div><div class="inline-note">风险意愿来自你的回答；风险能力还受现金流、期限、偿债压力和收入集中影响。两者冲突时，会分别展示原因。</div><button class="source-cite" data-ask="大卫翁怎样区分风险认知边界和风险承受边界？">查阅：书中怎样讨论风险边界 ↗</button>`;
  } else {
    inner = resultsMarkup();
  }
  $("#step-content").innerHTML =
    `<div class="step-inner">${inner}</div><div class="step-footer"><button class="text-button" id="previous-step">${state.step === 0 ? "回到页首 ↑" : "← 上一步"}</button>${state.step < 3 ? `<button class="button primary" id="next-step">${state.step === 2 ? "查看配置情景" : "继续 · " + labels[state.step + 1]} <span>→</span></button>` : '<button class="button" id="result-export">导出这份规划 ↗</button>'}</div>`;
  bindStep();
}
function goalsMarkup() {
  if (!state.input.goals?.length)
    return `<div class="empty-goals">${state.input.goals === null ? "资金目标尚未确认。添加目标，或明确选择暂无其他目标。" : "已明确：暂无应急储备之外的资金目标。"}</div>`;
  return state.input.goals
    .map(
      (g, i) =>
        `<article class="goal-card"><div class="goal-head"><span>GOAL ${String(i + 1).padStart(2, "0")}</span><button class="text-button" data-remove-goal="${i}" aria-label="移除第 ${i + 1} 个目标">移除</button></div><div class="form-grid"><label class="form-field full"><span>资金用途</span><input type="text" maxlength="80" data-goal="${i}" data-key="name" value="${esc(g.name)}" placeholder="如：孩子的学费、两年后的购车预算"></label><label class="form-field"><span>所需金额 / 元</span><div class="input-wrap"><input type="number" inputmode="decimal" min="0" step=".01" data-goal="${i}" data-key="amount" value="${g.amount ?? ""}" placeholder="未知留空"></div></label><label class="form-field"><span>距用款还有 / 月</span><div class="input-wrap"><input type="number" inputmode="numeric" min="0" max="720" step="1" data-goal="${i}" data-key="months" value="${g.months ?? ""}" placeholder="0 表示现在"></div></label></div><label class="checkbox-row"><input type="checkbox" data-goal="${i}" data-key="flexible" ${g.flexible ? "checked" : ""}>用途或期限可以调整</label></article>`,
    )
    .join("");
}
function issuesMarkup() {
  const v = result.validation;
  let out = "";
  if (v.errors.length)
    out += `<div class="alert danger"><h4>请先修正 ${v.errors.length} 处输入冲突</h4><ul>${v.errors.map((i) => `<li>${esc(i.message)}</li>`).join("")}</ul></div>`;
  if (v.missing.length)
    out += `<div class="alert"><h4>还需要确认 ${v.missing.length} 项信息</h4><p>已知数据可以继续查看；填写完整后才生成配置情景。</p><ul>${v.missing.map((i) => `<li>${esc(i.message)}</li>`).join("")}</ul></div>`;
  if (v.warnings.length)
    out += `<details class="alert" open><summary>有 ${v.warnings.length} 项需要优先核对</summary><ul>${v.warnings.map((i) => `<li>${esc(i.message)}</li>`).join("")}</ul></details>`;
  return out;
}
function resultsMarkup() {
  let html = `<div class="results-title"><p class="eyebrow">ALLOCATION SCENARIOS</p><h3>约束下的配置情景</h3><p>先留足生活与目标的钱，再比较剩余资金。所有比例均为软件示例。</p></div>${issuesMarkup()}`;
  const r = result.reserves,
    s = result.summary;
  if (!s) return html;
  if (r)
    html += `<div class="money-flow"><div class="flow-row"><span>当前可变现资产</span><strong>${money(s.liquidAssets)}</strong></div><div class="flow-row"><span>− 应急储备 <small>${r.reserveMonths ?? "待填"} 个月 × 必要支出与月供</small></span><strong>${money(r.emergencyTarget)}</strong></div><div class="flow-row"><span>− 36 个月内目标</span><strong>${money(r.nearTermGoals)}</strong></div><div class="flow-row"><span>− 一年内额外到期本金</span><strong>${money(r.extraDebtDue)}</strong></div><div class="flow-row"><span>剩余可配置资金</span><strong>${money(r.longTermPool)}</strong></div></div>`;
  if (result.status !== "ready")
    return (
      html + `<button class="button" data-step="0">返回填写底账 →</button>`
    );
  const risk = result.risk;
  html += `<div class="risk-pair"><div><h4>风险能力 · 财务约束</h4><p>有效期限 ${fmt(r.effectiveHorizonYears)} 年；软件示例将权益占剩余资金的比例限制在 ${fmt(risk.capacity.equityCapPct)}% 内。</p><details><summary class="small">展开每项约束</summary><ul>${risk.capacity.constraints.map((c) => `<li><strong>${esc(c.label)}</strong>：${esc(c.detail)}</li>`).join("")}</ul></details></div><div><h4>风险意愿 · 你的回答</h4><p>可接受损失 ${fmt(risk.willingness.maxLossPct)}%，对应 ${money(risk.willingness.maxLossAmount)}。</p><p>${esc(risk.willingness.basis)}</p></div></div><div class="subheading"><h3>三个不同侧重的情景</h3><span>配比仅针对剩余资金<br>${money(r.longTermPool)}</span></div><div class="scenario-grid">${result.scenarios
    .map(
      (c, i) =>
        `<article class="scenario ${c.id === state.scenario ? "selected" : ""}"><span class="scenario-kicker">SCENARIO 0${i + 1}</span><h4>${esc(c.label)}</h4><p class="big-pct">${c.weights.equities}%<small>权益占比</small></p><div class="stacked-bar" role="img" aria-label="${Object.entries(
          c.weights,
        )
          .map(([k, v]) => `${names[k]}${v}%`)
          .join("，")}">${Object.entries(c.weights)
          .map(
            ([k, v]) => `<span class="asset-${k}" style="width:${v}%"></span>`,
          )
          .join("")}</div>${Object.entries(c.weights)
          .map(
            ([k, v]) =>
              `<div class="weight-row"><span><i class="swatch asset-${k}"></i>${names[k]}</span><span>${v}% · ${money(c.amounts[k])}</span></div>`,
          )
          .join(
            "",
          )}<p class="scenario-state ${c.eligible ? "" : "blocked"}">${c.eligible ? "本情景通过已填约束检查" : esc(c.reasons[0] || "需要进一步核对")}<br>压力损失 ${money(c.lossEstimate.amount)}</p><button data-scenario="${c.id}" aria-pressed="${c.id === state.scenario}">${c.id === state.scenario ? "正在查看此情景" : "比较此情景"} →</button><details><summary>为何得到这个比例</summary><p>${c.adjusted ? "原始模板已按上面的权益上限调整；减少的权益转入现金。" : "本情景沿用软件示例模板，尚未触及输入约束。"}</p><p>原模板：${Object.entries(
          c.templateWeights,
        )
          .map(([k, v]) => `${names[k]} ${v}%`)
          .join(
            " / ",
          )}。</p>${c.reasons.map((x) => `<p>${esc(x)}</p>`).join("")}</details></article>`,
    )
    .join(
      "",
    )}</div><p class="result-note">这些情景用来比较风险分布，未优化收益。债券类仍有利率、信用和赎回风险；具体工具尚未筛选。</p><div id="selected-scenario">${selectedMarkup()}</div><div class="explain-action"><button class="button" id="explain-plan">请助手解释当前情景 ↗</button><p class="small">向 DeepSeek 发送情景名称、收入稳定性和投资经历；金额由程序说明。</p></div><div class="stress-box"><div class="subheading" style="margin-top:0"><h3>如果生活或市场变了</h3><span>可调整的压力假设</span></div>${rangeField("incomeDropPct", "收入下降", 0, 100, "%")}${rangeField("months", "持续时间", 1, 24, "个月")}${rangeField("equityDropPct", "权益资产下跌", 0, 70, "%")}<details><summary class="small">调整债券与黄金跌幅</summary>${rangeField("bondDropPct", "债券类资产下跌", 0, 40, "%")}${rangeField("goldDropPct", "黄金类资产下跌", 0, 70, "%")}</details><div id="stress-results">${stressMarkup()}</div></div><div id="goal-results">${goalResultsMarkup()}</div><div class="discipline-box"><div class="subheading" style="margin-top:0"><h3>把纪律写在波动之前</h3><button class="text-button" data-ask="如何制定投资纪律和再平衡规则？">查看框架出处 ↗</button></div><p class="small">选择上面的情景作为一次复核基准。阈值由你设定，不等于作者的统一规则。</p><div class="form-grid"><label class="form-field"><span>允许的权重偏离 / 百分点</span><input type="number" min="0" max="100" step=".1" id="tolerance" value="${state.discipline.tolerancePct}"></label><label class="form-field"><span>本次新增现金 / 元</span><input type="number" min="0" step=".01" id="new-cash" value="${state.discipline.newCash}"></label></div><div id="rebalance-results">${rebalanceMarkup()}</div><div class="form-grid"><label class="form-field"><span>下次复核日期</span><input type="date" id="review-date" value="${esc(state.discipline.reviewDate)}"></label><label class="form-field"><span>选择理由 / 何时需要改变</span><textarea id="plan-reason" rows="2" maxlength="500" placeholder="例如：目标提前、收入改变时重新检查">${esc(state.discipline.reason)}</textarea></label></div><button class="button" id="save-note" style="margin-top:17px">记录这一版计划 ↗</button><div id="journal">${journalMarkup()}</div></div><details class="method-details" style="margin:22px 0 0"><summary>查看本次计算的全部假设</summary>${[...result.assumptions, ...(result.stress?.assumptions || [])].map((x) => `<p>${esc(x)}</p>`).join("")}</details>`;
  return html;
}
function rangeField(key, label, min, max, unit) {
  return `<label class="range-field"><span>${label}<output id="output-${key}">${state.input.stress[key]} ${unit}</output></span><input type="range" min="${min}" max="${max}" step="1" value="${state.input.stress[key]}" data-stress="${key}" data-unit="${unit}" aria-label="${label}"></label>`;
}
function selectedMarkup() {
  const c =
    result.scenarios.find((x) => x.id === state.scenario) ||
    result.scenarios[0];
  if (!c) return "";
  return `<div class="subheading"><h3>${esc(c.label)} · 全部可变现资产</h3><span>此处包含预留现金</span></div><div class="table-scroll"><table><thead><tr><th>资产类别</th><th>当前金额</th><th>情景金额</th><th>全口径占比</th></tr></thead><tbody>${Object.keys(
    names,
  )
    .map(
      (k) =>
        `<tr><td>${names[k]}</td><td>${money(result.summary.currentLiquidAmounts[k])}</td><td>${money(c.totalLiquidAmounts[k])}</td><td>${fmt(c.totalLiquidWeights[k])}%</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table></div><p class="result-note">其中 ${money(c.reservedCash)} 是应急、短期目标和额外本金的预留资金。${esc(c.implementationNote)}</p>`;
}
function stressMarkup() {
  const s = result.stress;
  if (!s) return "";
  const series = s.series;
  const max = Math.max(1, ...series.map((x) => Math.abs(x.endCash)));
  const selected = result.scenarios.find((x) => x.id === state.scenario);
  return `<div class="stress-metrics"><div><strong>${money(s.additionalCashNeeded)}</strong><span>维持现有现金位置，需要补足的现金</span></div><div><strong>${s.firstCashShortfallMonth === null ? "未出现" : `第 ${s.firstCashShortfallMonth} 个月`}</strong><span>现有现金首次出现缺口</span></div></div><div class="stress-chart" role="img" aria-label="现有现金逐月轨迹：${series.map((x) => `第${x.month}月${fmt(x.endCash)}元`).join("；")}">${series.map((x) => `<span class="${x.endCash < 0 ? "negative" : ""}" style="height:${Math.max(2, (Math.abs(x.endCash) / max) * 74)}px" data-month="${x.month}" title="第${x.month}月：${money(x.endCash)}"></span>`).join("")}</div><p class="stress-footnote">蓝色表示仍有现金，红色表示资金缺口。负数仅代表尚未覆盖的支付需求。</p><div class="table-scroll"><table><thead><tr><th>压力口径</th><th>期末余额</th><th>需补充金额</th></tr></thead><tbody><tr><td>现有现金</td><td>${money(s.endingCash)}</td><td>${money(s.additionalCashNeeded)}</td></tr><tr><td>完成预留后的现金</td><td>${money(s.endingPlannedReserveCash)}</td><td>${money(s.plannedReserveAdditionalCashNeeded)}</td></tr><tr><td>现有可变现资产承压后</td><td>${money(s.endingLiquidAssetsAfterShock)}</td><td>${money(Math.max(0, -s.minimumLiquidAssetsAfterShock))}</td></tr></tbody></table></div><p class="result-note">三条轨迹各自独立，不相加。额外本金因缺确切日期，保守安排在第 1 个月；未自动卖出资产补现金。</p><details style="margin-top:15px"><summary class="small">展开所选情景的敏感性比较</summary><div class="table-scroll"><table><thead><tr><th>权益下跌</th><th>组合损失</th><th>占可变现资产</th><th>损失意愿</th></tr></thead><tbody>${result.sensitivity.market
    .filter((x) => x.scenarioId === selected?.id)
    .map(
      (x) =>
        `<tr><td>${x.equityDropPct}%</td><td>${money(x.lossAmount)}</td><td>${x.lossPctOfLiquidAssets}%</td><td>${x.withinWillingness ? "在填写范围内" : "超出范围"}</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table></div><p class="result-note">债券下跌 ${state.input.stress.bondDropPct}%，黄金下跌 ${state.input.stress.goldDropPct}%，均为假设；更严重损失仍可能发生。</p><div class="table-scroll"><table><thead><tr><th>收入下降持续</th><th>现有现金期末</th><th>期间补现金需求</th></tr></thead><tbody>${result.sensitivity.income.map((x) => `<tr><td>${x.months} 个月</td><td>${money(x.endingCash)}</td><td>${money(x.additionalCashNeeded)}</td></tr>`).join("")}</tbody></table></div></details>`;
}
function goalResultsMarkup() {
  const g = result.goalFunding;
  if (!g?.rows.length) return "";
  return `<div class="subheading"><h3>目标资金能否接得上</h3><span>假设无投资收益、月结余不变</span></div><div class="table-scroll"><table><thead><tr><th>用途</th><th>到期月</th><th>支付后可用余额</th><th>资金缺口</th></tr></thead><tbody>${g.rows.map((r) => `<tr><td>${esc(r.names.join("、"))}</td><td>${r.month}</td><td>${money(r.balance)}</td><td>${money(r.fundingGap)}</td></tr>`).join("")}</tbody></table></div><p class="result-note">${esc(g.assumption)}</p>`;
}
function rebalanceMarkup() {
  const c = result.scenarios.find((x) => x.id === state.scenario);
  if (!c) return "";
  let r;
  try {
    r = compareRebalance({
      current: result.summary.currentLiquidAmounts,
      target: c.totalLiquidAmounts,
      ...state.discipline,
    });
  } catch {
    return '<p class="small">请填写有效的偏离阈值和新增现金金额。</p>';
  }
  return `<p class="inline-note">${r.triggered ? "有资产类别偏离超过你设定的阈值，可开始复核原因。" : "当前偏离未超过你设定的阈值。"}${c.eligible ? "" : " 所选情景尚未通过全部约束，先处理前面的缺口。"}</p><div class="table-scroll"><table><thead><tr><th>资产类别</th><th>当前−目标权重</th><th>目标−当前金额</th><th>新增现金可补</th></tr></thead><tbody>${r.rows.map((x) => `<tr><td>${names[x.asset]}</td><td>${x.deviationPct > 0 ? "+" : ""}${x.deviationPct} pp</td><td>${x.difference > 0 ? "+" : ""}${fmt(x.difference)}</td><td>${money(x.newCashAllocation)}</td></tr>`).join("")}</tbody></table></div><p class="result-note">${esc(r.note)} 剩余新增现金：${money(r.unallocatedCash)}。</p>`;
}
function journalMarkup() {
  return state.journal
    .map(
      (j, i) =>
        `<div class="journal-entry"><small>VERSION ${String(i + 1).padStart(2, "0")} · ${esc(new Date(j.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }))} · 复核 ${esc(j.reviewDate)}</small><p>${esc(j.scenarioLabel)}：${esc(j.reason)}</p></div>`,
    )
    .join("");
}
function bindStep() {
  document.querySelectorAll("[data-path]").forEach((el) =>
    el.addEventListener("input", () => {
      const value = el.dataset.boolean
        ? el.value === "unknown"
          ? null
          : el.value === "true"
        : el.type === "number"
          ? el.value === ""
            ? null
            : Number(el.value)
          : el.value;
      set(el.dataset.path, value);
      state.sample = null;
      renderSummary();
      const issue = result.validation.errors.find(
        (e) => e.path === el.dataset.path,
      );
      el.setAttribute("aria-invalid", String(Boolean(issue)));
    }),
  );
  document.querySelectorAll("[data-goal]").forEach((el) =>
    el.addEventListener("input", () => {
      state.input.goals[Number(el.dataset.goal)][el.dataset.key] =
        el.type === "checkbox"
          ? el.checked
          : el.type === "number"
            ? el.value === ""
              ? null
              : Number(el.value)
            : el.value;
      state.sample = null;
      renderSummary();
    }),
  );
  $("#add-goal")?.addEventListener("click", () => {
    if ((state.input.goals?.length || 0) >= 10) {
      toast("界面支持最多 10 项目标。");
      return;
    }
    state.input.goals ??= [];
    state.input.goals.push({
      name: "",
      amount: null,
      months: null,
      flexible: false,
    });
    renderStep();
  });
  $("#no-goals")?.addEventListener("click", () => {
    state.input.goals = [];
    state.sample = null;
    renderStep();
  });
  document.querySelectorAll("[data-remove-goal]").forEach((el) =>
    el.addEventListener("click", () => {
      state.input.goals.splice(Number(el.dataset.removeGoal), 1);
      renderStep();
    }),
  );
  document.querySelectorAll("[data-zero]").forEach((el) =>
    el.addEventListener("click", () => {
      state.input.debts = {
        balance: 0,
        monthlyPayment: 0,
        apr: 0,
        dueWithinYear: 0,
      };
      state.sample = null;
      renderStep();
    }),
  );
  $("#next-step")?.addEventListener("click", () => changeStep(state.step + 1));
  $("#previous-step")?.addEventListener("click", () => {
    if (state.step) changeStep(state.step - 1);
    else window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("#result-export")?.addEventListener("click", exportPlan);
  $("#explain-plan")?.addEventListener("click", () =>
    ask(
      "请结合我的计算摘要，解释当前资产配置情景如何考虑现金流、目标期限和风险承受。指出应优先处理的约束，并给出下一步核对方向。",
      { input: clone(state.input), scenarioId: state.scenario },
    ),
  );
  document.querySelectorAll("[data-scenario]").forEach((el) =>
    el.addEventListener("click", () => {
      state.scenario = el.dataset.scenario;
      renderStep();
    }),
  );
  document.querySelectorAll("[data-stress]").forEach((el) =>
    el.addEventListener("input", () => {
      state.input.stress[el.dataset.stress] = Number(el.value);
      $(`#output-${el.dataset.stress}`).textContent =
        `${el.value} ${el.dataset.unit}`;
      renderSummary();
      $("#stress-results").innerHTML = stressMarkup();
      $("#selected-scenario").innerHTML = selectedMarkup();
      $("#rebalance-results").innerHTML = rebalanceMarkup();
      document.querySelector(".scenario-grid").outerHTML =
        extractScenarioGrid();
      bindScenarioButtons();
    }),
  );
  $("#tolerance")?.addEventListener("input", (e) => {
    state.discipline.tolerancePct =
      e.target.value === "" ? NaN : Number(e.target.value);
    $("#rebalance-results").innerHTML = rebalanceMarkup();
  });
  $("#new-cash")?.addEventListener("input", (e) => {
    state.discipline.newCash =
      e.target.value === "" ? NaN : Number(e.target.value);
    $("#rebalance-results").innerHTML = rebalanceMarkup();
  });
  $("#review-date")?.addEventListener(
    "input",
    (e) => (state.discipline.reviewDate = e.target.value),
  );
  $("#plan-reason")?.addEventListener(
    "input",
    (e) => (state.discipline.reason = e.target.value),
  );
  $("#save-note")?.addEventListener("click", () => {
    if (state.journal.length >= 100) {
      toast("本份规划已保存 100 个版本，请先导出留存，再开始新的规划。");
      return;
    }
    if (!state.discipline.reviewDate || !state.discipline.reason.trim()) {
      toast("请写下复核日期和选择理由，再记录这一版。");
      return;
    }
    const c = result.scenarios.find((x) => x.id === state.scenario);
    state.journal.push({
      createdAt: new Date().toISOString(),
      reviewDate: state.discipline.reviewDate,
      reason: state.discipline.reason,
      scenarioId: c.id,
      scenarioLabel: c.label,
      eligible: c.eligible,
      policyVersion: result.policy.version,
      input: clone(state.input),
      weights: clone(c.weights),
      target: clone(c.totalLiquidAmounts),
      discipline: clone(state.discipline),
    });
    $("#journal").innerHTML = journalMarkup();
    toast("已记录新版本。导出规划可保存所有版本。");
  });
}
function extractScenarioGrid() {
  const t = document.createElement("template");
  t.innerHTML = resultsMarkup();
  return t.content.querySelector(".scenario-grid").outerHTML;
}
function bindScenarioButtons() {
  document.querySelectorAll("[data-scenario]").forEach((el) =>
    el.addEventListener("click", () => {
      state.scenario = el.dataset.scenario;
      renderStep();
    }),
  );
}
function changeStep(i) {
  state.step = Math.max(0, Math.min(3, Number(i)));
  renderStep();
  $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
}
function changeView(view) {
  state.view = view;
  for (const name of ["planner", "assistant"])
    $(`#${name}-view`).hidden = name !== view;
  document
    .querySelectorAll(".nav-link")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (view === "assistant") $("#chat-input").focus({ preventScroll: true });
}
function chooseSample(id) {
  const c = SAMPLE_CASES.find((x) => x.id === id) || SAMPLE_CASES[0];
  state.input = clone(c.input);
  state.input.stress = { ...DEFAULT_STRESS, ...state.input.stress };
  state.sample = c.name;
  state.step = 0;
  state.scenario = "balanced";
  state.journal = [];
  state.discipline = {
    tolerancePct: 5,
    newCash: 0,
    reviewDate: "",
    reason: "",
  };
  renderStep();
  document
    .querySelectorAll(".sample-pill")
    .forEach((b) => b.classList.toggle("active", b.dataset.sample === c.id));
  $("#workspace").scrollIntoView({ behavior: "smooth" });
  toast("已载入自编虚构样例，可修改任意字段。");
}
function exportPlan() {
  const calculated = calculateAllocation(state.input);
  const d = state.discipline;
  if (
    calculated.status === "invalid" ||
    !Number.isFinite(d.tolerancePct) ||
    d.tolerancePct < 0 ||
    d.tolerancePct > 100 ||
    !Number.isFinite(d.newCash) ||
    d.newCash < 0 ||
    d.newCash > 1e10
  ) {
    toast("请先修正输入冲突，并填好再平衡阈值与新增现金，再导出规划。");
    return;
  }
  const body = {
    format: "youdu-allocation-plan",
    version: 1,
    exportedAt: new Date().toISOString(),
    input: state.input,
    selectedScenario: state.scenario,
    discipline: state.discipline,
    journal: state.journal,
    result: calculated,
  };
  const blob = new Blob([JSON.stringify(body, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `有度-资产配置规划-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("规划已导出到你的设备，包含填写的家庭信息，请自行妥善保管。");
}
async function importPlan(file) {
  if (!file) return;
  if (file.size > 2000000) {
    toast("文件过大，请选择本工具导出的规划。");
    return;
  }
  try {
    const data = JSON.parse(await file.text());
    if (
      data.format !== "youdu-allocation-plan" ||
      data.version !== 1 ||
      !data.input
    )
      throw Error();
    const parsed = calculateAllocation(data.input);
    if (parsed.status === "invalid") throw Error();
    const clean = blankInput();
    for (const group of ["assets", "debts", "cashflow", "profile", "stress"])
      for (const key of Object.keys(clean[group]))
        if (Object.hasOwn(data.input[group] || {}, key))
          clean[group][key] = data.input[group][key];
    if (data.input.goals === null) clean.goals = null;
    else if (Array.isArray(data.input.goals) && data.input.goals.length <= 10)
      clean.goals = data.input.goals.map((g) => ({
        name: g.name,
        amount: g.amount,
        months: g.months,
        flexible: g.flexible,
      }));
    else throw Error();
    let discipline = {
      tolerancePct: 5,
      newCash: 0,
      reviewDate: "",
      reason: "",
    };
    const d = data.discipline;
    if (d) {
      if (
        !Number.isFinite(d.tolerancePct) ||
        d.tolerancePct < 0 ||
        d.tolerancePct > 100 ||
        !Number.isFinite(d.newCash) ||
        d.newCash < 0 ||
        d.newCash > 1e10
      )
        throw Error();
      discipline = {
        tolerancePct: d.tolerancePct,
        newCash: d.newCash,
        reviewDate:
          typeof d.reviewDate === "string" ? d.reviewDate.slice(0, 10) : "",
        reason: typeof d.reason === "string" ? d.reason.slice(0, 500) : "",
      };
    }
    if (
      data.journal !== undefined &&
      (!Array.isArray(data.journal) || data.journal.length > 100)
    )
      throw Error();
    const journal = (data.journal || []).map((j) => {
      if (
        !j ||
        typeof j.createdAt !== "string" ||
        !Number.isFinite(Date.parse(j.createdAt)) ||
        typeof j.reason !== "string" ||
        typeof j.reviewDate !== "string"
      )
        throw Error();
      return {
        ...j,
        reason: j.reason.slice(0, 500),
        scenarioLabel: String(j.scenarioLabel || "").slice(0, 60),
      };
    });
    state = {
      ...state,
      input: clean,
      sample: null,
      discipline,
      journal,
      step: 0,
      scenario: ["conservative", "balanced", "growth"].includes(
        data.selectedScenario,
      )
        ? data.selectedScenario
        : "balanced",
    };
    document
      .querySelectorAll(".sample-pill")
      .forEach((b) => b.classList.remove("active"));
    renderStep();
    toast("已载入规划。请核对金额与日期是否仍适用。");
  } catch {
    toast("无法导入：需要本工具导出的有效规划，金额与结构须符合要求。");
  }
}
function sourceDetail(source) {
  const link =
    source.publicUrl && /^https?:\/\//.test(source.publicUrl)
      ? `<p style="margin-top:18px"><a href="${esc(source.publicUrl)}" target="_blank" rel="noreferrer">打开来源页面 ↗</a></p>`
      : "";
  return `<h2>${esc(source.title)}</h2><p class="source-meta">${esc(kinds[source.kind] || source.kind)} · ${esc(source.date || "日期未记录")}<br>作者：${esc(source.author || "未标注")} · 发言归属：${esc(source.speaker || "未确认")}</p>${(source.evidenceSentences || []).map((text) => `<blockquote class="source-excerpt">${esc(text)}</blockquote>`).join("")}<details class="source-context"><summary>查看相邻上下文</summary><p>${esc(source.summary)}</p></details><div class="source-locator">${esc(source.docId)} · ${esc(source.anchor)}</div><p class="small" style="margin-top:14px">归属说明：${esc(source.attribution)}<br>证据边界：${esc(source.evidenceLimitations)}</p>${link}<p class="small" style="margin-top:18px">检索片段仅覆盖本次问题相关上下文。完整语境请按定位回查原资料。</p>`;
}
function showSource(id, turn) {
  const source = (
    turn !== undefined ? state.chat[Number(turn)]?.data?.sources : state.sources
  )?.find((s) => s.id === id);
  if (!source) return;
  $("#source-dialog-content").innerHTML = sourceDetail(source);
  $("#source-dialog").showModal();
}
function renderChat() {
  if (!state.chat.length) return;
  $("#chat-messages").innerHTML =
    state.chat
      .map((item, turnIndex) =>
        item.role === "user"
          ? `<div class="chat-question"><p>${esc(item.content)}</p></div>`
          : `<article class="chat-answer"><div class="answer-meta"><strong>资料研究助手</strong><span>${item.data.mode === "model" ? "DeepSeek Flash · 来源已关联" : item.data.mode === "retrieval" ? "来源检索" : "证据不足"}</span></div>${item.data.sections.length ? item.data.sections.map((s) => `<div class="answer-section"><h4>${esc(s.label)}</h4><p>${esc(s.text)}</p>${s.sourceIds.map((id) => `<button class="source-cite" data-source="${esc(id)}" data-turn="${turnIndex}">[${esc(id)}] ${esc((item.data.sources.find((x) => x.id === id) || {}).title || "查看证据")} ↗</button>`).join("")}</div>`).join("") : `<div class="answer-section"><p>${esc(item.data.answer)}</p></div>`}<div class="answer-limit">${item.data.limitations.map(esc).join("<br>")}</div></article>`,
      )
      .join("") +
    (state.busy
      ? '<div class="chat-pending"><span class="pending-dot"></span>正在核对资料与出处…</div>'
      : "");
}
async function ask(question, plan) {
  question = question.trim();
  if (!question || state.busy) return;
  changeView("assistant");
  const history = state.chat
    .filter((x) => x.role === "user")
    .slice(-4)
    .map((x) => ({ role: "user", content: x.content }));
  state.chat.push({ role: "user", content: question });
  state.busy = true;
  $("#send-question").disabled = true;
  $("#chat-input").value = "";
  renderChat();
  try {
    const response = await fetch("./api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history, ...(plan ? { plan } : {}) }),
      signal: AbortSignal.timeout(70000),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const message =
        response.status === 401
          ? "网站登录已过期，请刷新页面重新登录。"
          : typeof failure.error === "string" && failure.error.length <= 180
            ? failure.error
            : response.status === 429
              ? "问题较多，请稍后再试。"
              : "资料助手暂时无法连接，请稍后重试。";
      throw Error(message);
    }
    const data = await response.json();
    for (const s of data.sources)
      if (!state.sources.some((x) => x.id === s.id)) state.sources.push(s);
    state.chat.push({ role: "assistant", data });
    $("#assistant-status").textContent = modelLabel(data.modelStatus);
  } catch (error) {
    state.chat.push({
      role: "assistant",
      data: {
        mode: "insufficient",
        answer:
          error.name === "TimeoutError"
            ? "请求超时，尚未取得回答，请稍后再试。"
            : error.message,
        sections: [],
        sources: [],
        limitations: ["计算工具仍可独立使用。本次没有生成来源结论。"],
      },
    });
  } finally {
    state.busy = false;
    $("#send-question").disabled = false;
    renderChat();
    $("#chat-messages").lastElementChild?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }
}
function modelLabel(status) {
  if (status?.available && status?.answerValidation === "partial")
    return "模型问答可用 · 已保留通过检查的段落";
  if (status?.available && status?.answerValidation === "passed")
    return "DeepSeek Flash 已连接";
  if (status?.available && status?.answerValidation === "rejected")
    return "DeepSeek Flash 已连接 · 本次采用来源检索";
  if (status?.configured && status?.state === "error")
    return "模型暂不可用 · 来源检索可用";
  if (status?.configured) return "模型已配置 · 等待首次问答";
  return "来源检索可用";
}
document.addEventListener("click", (event) => {
  const v = event.target.closest("[data-view]");
  if (v) changeView(v.dataset.view);
  const step = event.target.closest("[data-step]");
  if (step) changeStep(step.dataset.step);
  const source = event.target.closest("[data-source]");
  if (source) showSource(source.dataset.source, source.dataset.turn);
  const q = event.target.closest("[data-ask]");
  if (q) ask(q.dataset.ask);
});
$("#sample-buttons").innerHTML = SAMPLE_CASES.map(
  (s) =>
    `<button class="sample-pill" data-sample="${esc(s.id)}" title="${esc(s.description)}">${esc(s.name)} ↗</button>`,
).join("");
document
  .querySelectorAll("[data-sample]")
  .forEach((b) =>
    b.addEventListener("click", () => chooseSample(b.dataset.sample)),
  );
$("#reset-button").addEventListener("click", () => {
  state.input = blankInput();
  state.step = 0;
  state.sample = null;
  state.journal = [];
  state.discipline = {
    tolerancePct: 5,
    newCash: 0,
    reviewDate: "",
    reason: "",
  };
  document
    .querySelectorAll(".sample-pill")
    .forEach((b) => b.classList.remove("active"));
  renderStep();
  toast("本页规划已清空。已导出的文件不受影响。");
});
$("#export-button").addEventListener("click", exportPlan);
$("#import-button").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", (e) => {
  importPlan(e.target.files[0]);
  e.target.value = "";
});
$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  ask($("#chat-input").value);
});
$("#close-source").addEventListener("click", () => $("#source-dialog").close());
$("#source-dialog").addEventListener("click", (e) => {
  if (e.target === $("#source-dialog")) {
    const r = e.target.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      e.target.close();
  }
});
$("#quick-question").addEventListener("submit", (e) => {
  e.preventDefault();
  ask($("#quick-input").value);
});
$("#open-help").addEventListener("click", () => $("#help-dialog").showModal());
$("#close-help").addEventListener("click", () => $("#help-dialog").close());
$("#clear-chat").addEventListener("click", () => {
  if (state.busy) return;
  state.chat = [];
  $("#chat-messages").innerHTML =
    '<div class="chat-welcome"><h2>开始一个新问题</h2><p>输入具体困惑，助手将查阅相关资料。</p></div>';
});
renderStep();
try {
  const response = await fetch("./api/bootstrap");
  if (!response.ok) throw Error();
  const data = await response.json();
  state.sources = [];
  $("#service-status").textContent = "计算已就绪";
  $("#assistant-status").textContent = modelLabel(data.assistant.modelStatus);
  $("#coverage-note").textContent = data.assistant.coverage;
} catch {
  $("#service-status").textContent = "来源连接中断";
  $("#coverage-note").textContent = "来源暂未载入。计算工具可独立使用。";
  toast("来源服务连接失败，可继续使用配置计算。");
}
