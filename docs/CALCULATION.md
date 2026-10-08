# 金额口径、输入契约与情景计算

本模块由本项目独立编写，采用零运行时依赖的 JavaScript ESM。比例、期限分界与压力阈值是**软件教学示例**，不代表大卫翁或任何嘉宾给出的通用配置。资料中的框架观点与这里的可计算假设应分别展示。

## 调用

```js
import { calculateAllocation, validateInput } from "./lib/allocation.mjs";
import { SAMPLE_CASES, getSample } from "./lib/samples.mjs";

const result = calculateAllocation(getSample("steady-family").input);
```

模块另外导出 `DEFAULT_STRESS`、`POLICY`。`getSample(id)` 返回深复制，未知 ID 返回 `null`。引擎无网络访问、无文件读写、不保存家庭信息、不调用模型，也不修改传入对象。

## 输入字段

所有金额以人民币元输入，允许数字或纯数字字符串，最多两位小数，单字段范围为 0 至 100 亿元。空字符串、空格、`null`、缺失字段均表示未知，不能替代明确的 0。拒绝负数、`NaN`、无穷大、布尔值、逗号数字格式及十六进制。

| 路径                       | 含义与规则                                                                 |
| -------------------------- | -------------------------------------------------------------------------- |
| `assets.cash`              | 现金及可随时支取资金；不把锁定存款或不能立即赎回的产品放在这里             |
| `assets.bonds`             | 用户已确认可变现的债券类资产当前估值；并非保证兑付金额                     |
| `assets.equities`          | 用户已确认可变现的权益类资产当前估值                                       |
| `assets.gold`              | 用户已确认可变现的黄金类资产当前估值                                       |
| `assets.locked`            | 暂不可赎回、受限或锁定金融资产；不进入可调配资产                           |
| `assets.property`          | 房产当前估值；不进入可调配资产                                             |
| `debts.balance`            | 当前债务余额，不能再从用途区重复扣除                                       |
| `debts.monthlyPayment`     | 每月合计偿债支出，含当期本金与利息                                         |
| `debts.apr`                | 债务年利率，0–100%；多笔债务仅能填汇总口径，不能替代逐笔合同分析           |
| `debts.dueWithinYear`      | 未来一年除月供之外的额外到期本金，不得超过债务余额                         |
| `cashflow.income`          | 每月收入，允许明确为 0                                                     |
| `cashflow.expense`         | 每月必要支出，**不含月供**                                                 |
| `profile.stability`        | `stable`、`variable`、`fragile`；`unknown` 视作资料缺失                    |
| `profile.correlatedIncome` | 职业收入是否与金融市场明显相关，必须为 `true` 或 `false`                   |
| `profile.experience`       | `none`、`some`、`experienced`；`unknown` 视作资料缺失                      |
| `profile.horizonYears`     | 剩余资金可投资年限，0–60 年，最多两位小数                                  |
| `profile.maxLossPct`       | 对**当前可变现资产**可接受的一次性损失比例，0–100%；分母不含房产或锁定资产 |
| `profile.reserveMonths`    | 用户明确选择的应急金覆盖月数，0–60 的整数；引擎不擅自补值                  |
| `goals`                    | 必须提供数组；明确无额外用途时填 `[]`                                      |
| `goals[].name`             | 1–80 字的用途名称                                                          |
| `goals[].amount`           | 用途目标金额                                                               |
| `goals[].months`           | 距现在多少个月用款，0–720 的整数，0 表示立即支出                           |
| `goals[].flexible`         | 是否允许另行讨论调整金额或日期；压力计算仍使用已填计划，不自动删去         |
| `stress.incomeDropPct`     | 收入下降比例，0–100%                                                       |
| `stress.months`            | 收入下降持续月数，也是本次逐月展示长度，1–120 的整数                       |
| `stress.equityDropPct`     | 权益资产期初一次性下跌比例，0–100%                                         |
| `stress.bondDropPct`       | 债券资产期初一次性下跌比例，0–100%                                         |
| `stress.goldDropPct`       | 黄金资产期初一次性下跌比例，0–100%                                         |

用途仅填写非债务事项。若提供可选字段 `goals[].kind: 'debt'`，引擎拒绝并要求迁回债务区；用途名称疑似偿债时给出重复登记提示。仅凭自然语言名称无法证明两个条目是不是同一笔债，软件不会把两笔金额自动合并。

没有债务时四个债务字段均明确填写 0。余额为 0 但月供或利率大于 0 属于冲突。有债务但月供与额外本金都为 0 会要求核对日程；引擎不推定免还。月供包含利息、剩余期限未知，所以不会机械要求“十二个月月供不超过剩余本金”。

省略 `stress` 或其中某个字段时，使用并标注软件默认压力情景：收入下降 100%、持续 6 个月、权益下跌 35%、债券下跌 8%、黄金下跌 15%。显式填写空值仍视作未知。`stress.defaultedFields` 列出实际采用默认值的字段。

## 输出契约

```text
{
  schemaVersion: '1.0',
  status: 'ready' | 'incomplete' | 'invalid',
  policy,
  validation: { errors: [{path,code,message}], missing: [{path,message}], warnings: [{code,message}] },
  summary, reserves, risk, scenarios, stress, sensitivity, goalFunding,
  assumptions: string[], notes: string[]
}
```

- `ready`：必需字段完整且格式有效。这个状态只表示可计算，不表示财务约束通过或配置可以执行。
- `incomplete`：只返回资料充分的金额字段；未知结果为 `null`，`scenarios` 为空，`stress` 和 `sensitivity` 为 `null`。例如风险经历未知仍能算净资产。
- `invalid`：存在格式、范围或矛盾输入；`summary`、`reserves`、`risk`、`stress`、`sensitivity`、`goalFunding` 均为 `null`，`scenarios` 为空。

金额统一以元输出，权重及百分比统一为 0–100 的数值。界面应使用 `null` 判断未知，不能用 `value || 0` 替换。

### `summary`

`grossAssets`、`liquidAssets`、`financialAssets`、`netWorth`、`monthlyIncome`、`monthlyExpense`、`monthlyDebtService`、`monthlySurplus`、`debtServicePct`、`debtServiceNoIncome`、`currentLiquidAmounts`、`currentLiquidWeights`。

`currentLiquidAmounts` 与 `currentLiquidWeights` 均按 `cash/bonds/equities/gold` 分项。零收入且有月供时，偿债比例未知为 `null` 并单独标记 `debtServiceNoIncome: true`，不会用无穷大或 0 隐藏问题。

### `reserves`

`monthlyEssentials`、`reserveMonths`、`emergencyTarget`、`emergencyCashGap`、`nearTermMonths`、`nearTermGoals`、`extraDebtDue`、`target`、`availableLiquidAssets`、`fundingGap`、`cashReserveGap`、`marketAssetsToRelease`、`fundedCashReserve`、`longTermPool`、`shortTermGoalDetails`、`effectiveHorizonYears`、`nearestLongTermGoal`。

### `risk`

- `capacity`：`equityCapPct`、`constraints[]`、有效/填写期限、收入稳定性、投资经历、职业关联、软件比较用储备月数。每条约束含 `key,label,limitPct,detail`。
- `willingness`：`maxLossPct,maxLossAmount,basis`。意愿缺失不抹掉已知能力结论，但阻止生成完整配置。
- `debtReview`：利率、是否达到软件 6% 核对阈值、可用于比较提前偿债的金额及说明。提前还款金额只供另行比较，没有从长期池自动再扣一次。

### `scenarios[]`

三个场景 ID 为 `conservative`、`balanced`、`growth`。每项含：

| 字段                                    | 含义                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `label,templateWeights`                 | 情景名与未经约束的教学模板                                                 |
| `weights,amounts,capital`               | **储备之外**资金的权重、金额、合计                                         |
| `totalLiquidAmounts,totalLiquidWeights` | 加回已划分现金储备后的全部可变现资产位置                                   |
| `reservedCash,equityCapPct,adjusted`    | 已划分储备、能力上限、是否调整了模板                                       |
| `eligible,reasons`                      | 是否通过本工具已检查的约束与损失意愿；不是适当性认证或交易许可             |
| `lossEstimate`                          | `amount,pctOfLongTermPool,pctOfLiquidAssets,withinWillingness,description` |
| `equityLossEstimate`                    | 仅权益部分在输入跌幅下的损失金额                                           |
| `changes[]`                             | 每类 `asset,current,target,difference`，与当前估值同一时点比较             |
| `implementationNote`                    | 未计变现时差、税费及产品条款                                               |

`weights` 在整数百分比层面合计 100%；实际金额按分分配，细小金额可能使实际占比偏离名义权重。`totalLiquidWeights` 独立保留两位小数，显示合计可能存在 0.01 个百分点的舍入差。

### `stress`

主要字段：`parameters`、`defaultedFields`、`reducedMonthlyIncome`、`monthlyCashBurn`、当前持仓损失、三种资金轨迹的首次缺口月份、最低余额、期末余额、额外现金需求和 `series`。

`series` 从第 0 月开始，每行含 `month,income,expense,debtPayment,extraDebt,goalOutflow,endCash,endPlannedReserveCash,endLiquidAssetsAfterShock,cashShortfall`。

`monthlyCashBurn = 必要支出 + 月供 − 压力收入`；负数表示压力下仍有月度结余。首次缺口月份 `null` 表示展示期内没出现，不等于以后不会出现。

### `sensitivity`

- `market[]`：每个场景分别比较权益跌幅 20%、35%、50%，同时保留用户自定跌幅；债券与黄金跌幅保持输入值。列出损失金额、占可变现资产比例及是否超过意愿。
- `income[]`：比较收入下降持续 3、6、12 个月，同时保留用户设定的月份数。沿用用户设定收入降幅与目标日程。

### `goalFunding`

`initialGoalCapital,monthlySurplusAssumed,rows,firstGapMonth,assumption`。每行按到期月份汇总：`month,names,amount,cumulativeGoalAmount,balance,fundingGap,requiredMonthlySurplus,flexible`。

## 计算顺序与公式

所有货币运算先转换为整数分。百分比乘法使用 `BigInt` 完成分级四舍五入；场景金额先向下取整，再依小数余数从大到小补足剩余分，余数相同时按现金、债券、权益、黄金顺序。任何场景的分类金额均精确合计到应配置金额。

1. `可变现资产 = 现金 + 债券 + 权益 + 黄金`。
2. `金融资产 = 可变现资产 + 锁定金融资产`；`总资产 = 金融资产 + 房产`；`净资产 = 总资产 − 债务余额`。
3. `月度必要流出 = 必要支出 + 月供`；`月结余 = 收入 − 月度必要流出`。
4. `应急目标 = 月度必要流出 × 用户选择的覆盖月数`。
5. `短期目标储备 = 36 个月内（含当月）目标金额之和`，即使目标可调整也不自动删除。
6. `储备目标 = 应急目标 + 短期目标储备 + 额外到期本金`。
7. `储备缺口 = max(储备目标 − 可变现资产, 0)`。
8. `剩余可配置金额 = max(可变现资产 − 储备目标, 0)`。
9. `应急现金缺口 = max(应急目标 − 已有现金, 0)`，与总储备缺口分开显示。
10. `配置评估期限 = min(用户填写期限, 最近一笔非零长期目标的用款期限)`；没有长期目标时只用用户期限。

没有先从可变现资产扣除整个债务余额再扣月供。债务余额仅用于净资产；月供计入日常流出；额外本金单列预留。房产、公司估值与人力资产没有被当作现金填入长期池。

## 能力约束与意愿检查

这些不是收益最优化模型或法规门槛，全部写在 `POLICY` 与输出说明中。权益能力上限取所有适用条件的最低值，各项仍分别展示。

| 软件比较条件                                     | 权益上限                                                 |
| ------------------------------------------------ | -------------------------------------------------------- |
| 不足 3 年                                        | 全部剩余资金暂按现金情景比较，因为缺少债券期限及信用信息 |
| 3 至不足 5 年                                    | 30%                                                      |
| 5 至不足 10 年                                   | 55%                                                      |
| 至少 10 年                                       | 75%                                                      |
| 稳定 / 波动 / 脆弱收入                           | 75% / 55% / 30%                                          |
| 无经验 / 一些经验 / 经历过完整波动周期           | 25% / 55% / 75%                                          |
| 职业收入与市场明显相关                           | 40%                                                      |
| 月供严格超过收入的 35% / 50%                     | 40% / 20%                                                |
| 零收入且有月供、月结余为负、储备缺口、净资产为负 | 0%，相关情景同时显示约束原因                             |

偿债比例条件直接用整数分比较，不使用显示时四舍五入后的百分比。三种长期池模板为：

| 情景   | 现金 | 债券 | 权益 | 黄金 |
| ------ | ---: | ---: | ---: | ---: |
| 偏防守 |  10% |  65% |  15% |  10% |
| 均衡   |   5% |  45% |  40% |  10% |
| 偏成长 |   5% |  25% |  65% |   5% |

超过能力上限的权益份额转为现金。债券与黄金仍可能下跌，不能因为权益较少就被描述成保本。若有效期限不足 3 年，三个模板都退到 100% 现金，会显示为相同的受约束结果。

`可接受损失金额 = 可变现资产 × maxLossPct`。压力损失使用场景分类金额与填写跌幅逐项计算，再与可接受金额比较。通过该次压力比较也不能证明最大损失被限制在此；用户若要求更低损失，可能三个场景都不通过，软件不强行给一个答案。

稳定、波动、脆弱收入分别提供 6、9、12 个月应急覆盖比较值，只作可解释提醒，不替换用户选择。债务 APR 达到 6% 触发提前还款核对，未假定提前还款无费用，也未预测投资收益超过债务成本。

## 压力现金流与目标核对

收入中断按月逐行计算，必要支出与月供保持输入值；所有目标按月支付一次，额外到期本金因缺少具体日期而保守放在第 1 个月。第 0 月仅支付即时目标，不计收入或日常月支出。

三条轨迹各自独立：

- **现有现金**：从当前现金出发，不自动卖出持仓，最直接说明是否需要变现或调整支出。
- **划分储备后的现金**：假设已把 `min(储备目标,可变现资产)` 留在现金，再观察现金够不够。这是另一个操作前提，不与现有现金相加。
- **现有资产受冲击后的总流动金额**：当前权益、债券与黄金先一次性按指定跌幅重估，再计入收入和支出。不是完成新配置后的组合路径。

负余额是资金需求，工具没有执行借款。`additionalCashNeeded` 取整个轨迹的最大缺口，不能把每个月同一缺口重复累加。

长期目标核对不假设投资收益：先从可变现资产预留应急与额外本金，再按当前月结余持续积累，依次扣除到期用途。同月目标合并。用途只在到期时扣一次，没有先扣目标储备再扣用途。负余额指出在**现金流不变、收益为 0**的假设下存在缺口。

长期投影没有债务到期日、未来收入/支出变化和退休时间信息，因此只是一项条件检查：月供也假设维持当前水平，不能冒充真实摊还表或财富预测。对于长期提取计划、不同期限的多笔资金、产品赎回与债务细则，需要补充资料后另建更细模型。

## 合成案例与复算基准

所有案例均为项目自编，与真实用户无关。

| 案例         | 可变现资产 | 月结余 | 储备目标 | 剩余可配置 | 关键结果                                                  |
| ------------ | ---------: | -----: | -------: | ---------: | --------------------------------------------------------- |
| 双职工家庭   |    850,000 | 11,000 |  294,000 |    556,000 | 最近长期目标为 10 年；经历限制权益上限为 55%              |
| 高负债家庭   |    160,000 | -4,000 |  616,000 |          0 | 储备缺口 456,000；第 1 月现金出现缺口                     |
| 退休家庭     |  2,400,000 |  4,000 |  368,000 |  2,032,000 | 有效期限 8 年；15% 损失意愿下仅偏防守情景通过本次压力比较 |
| 市场相关职业 |  1,600,000 | 20,000 |  980,000 |    620,000 | 职业关联约束权益上限为 40%                                |

在项目根目录运行：

```sh
node --test test/allocation.test.mjs
```

测试覆盖合成案例、缺失/零值、数字类型与范围、债务冲突、期限边界、现金/非现金区别、能力/意愿分离、经验和职业关联、收入中断、即期目标、跌幅敏感性、分级舍入、金额守恒、高额边界、目标合并与无副作用。
