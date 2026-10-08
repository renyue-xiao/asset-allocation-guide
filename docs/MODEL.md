# 资料问答与模型服务

本工具将本地起朱楼原文检索与模型综合问答连接起来。回答按“来源观点”“软件推演”“模型补充”分段，段落中的来源编号可展开查看标题、日期、说话人、段落定位和支持摘句。产品身份是基于资料的独立 AI 研究助手。

## 问答流程

1. 服务端接收问题；简短追问可带入最近一条用户问题。
2. 本地检索器在指定资料库中查找相关原文，每次最多四个来源、每个来源最多 1500 字。每段保留作者、说话人、归属依据和定位。
3. 服务端向模型发送本次问题、少量检索上下文及引用约束。
4. 模型组织直接回答、应用步骤和必要追问；服务端校验 JSON 结构、引用 ID、支持摘句及归属规则后返回页面。
5. 未配置模型、模型连接失败或回答未通过检查时，页面仍可展示可核对的资料摘述。无足够资料时明确说明不足。

已经人工精读整理的 `data/sources.json` 提供轻量主题检索入口，原文检索不可用时也能使用。完整书籍、会员内容和原文数据库留在用户本地，不随开源仓库分发。

## 接口

```js
import { createResearchAssistant } from "./lib/assistant.mjs";
import { createModelProvider } from "./lib/model-provider.mjs";
import { createRetriever } from "./lib/retrieval.mjs";

const assistant = createResearchAssistant({
  sources,
  provider: createModelProvider(),
  retriever: createRetriever(),
});
assistant.status();
await assistant.ask({
  question: "收入不稳定时，如何看待风险能力？",
  history: [],
});
```

`ask` 返回 `{mode, answer, sections, sources, limitations, retrieval, modelStatus}`。`mode` 为 `model`、`retrieval` 或 `insufficient`。`sections` 每段包含 `label`、`text`、`sourceIds` 和可选的 `evidence` 支持摘句。`sources` 包含来源信息与本次使用的 `evidenceSentences`。

页面应使用 `textContent` 或框架默认转义呈现这些普通字符串。公共链接仅保留 HTTP(S)，新窗口链接应设置 `rel="noopener noreferrer"`。

## 解释计算情景

用户明确选择“解释当前情景”时，服务端先重新运行确定性计算，再调用：

```js
await assistant.ask({
  question: "解释这次应急资金与长期配置安排。",
  calculationContext: {
    summary: { availableCapital: "180000元" },
    reserves: { emergency: "18000元" },
    risk: {
      equityCapPct: "55%",
      stability: "stable",
      experience: "some",
      constraints: [{ label: "投资经历", limitPct: "55%", binding: true }],
    },
    selectedScenario: { label: "示例情景", weights: { equities: "15%" } },
  },
});
```

`calculationContext` 只接受 `summary`、`reserves`、`risk`、`selectedScenario` 四个根字段，限制大小与层级。服务端提供已核算的数值、每项约束上限与生效标记。程序据此生成“计算说明”：决定权益上限的因素、所选比较方案、长期资金池与压力情景。模型仅接收情景名称、收入稳定性、投资经历等定性摘要，补充来源框架和核对方向。模型生成的计算数字与算法权重解释会被剔除。

纯资料问答发送用户的问题文字。情景解释需要用户明确点击，额外发送情景名称、收入稳定性和投资经历等定性摘要；资产金额由本地程序说明。用户自行写进问题的个人信息会随问题发送。

## 服务端配置

在独立服务进程环境中配置：

| 变量                           | 用途                               |
| ------------------------------ | ---------------------------------- |
| `ALLOCATION_MODEL_API_KEY`     | 获授权的模型凭据                   |
| `ALLOCATION_MODEL_BASE_URL`    | 模型服务基础地址                   |
| `ALLOCATION_MODEL`             | 明确的模型标识                     |
| `QIZHULOU_ROOT`、`QIZHULOU_DB` | 本地只读检索器路径，由检索模块解释 |

也接受 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`；项目变量优先。凭据只用于服务端请求头，不返回给浏览器或写进仓库。配置缺项时不会读取其他应用的登录资料。

本次使用 DeepSeek 官方基础地址 `https://api.deepseek.com` 与 `deepseek-flash`。按照官方 [Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/) 发送 `max_tokens: 2800`、`thinking: {type: 'disabled'}`、`temperature: 0.2` 和 `response_format: {type: 'json_object'}`。JSON 模式保障格式，业务 schema 及引用仍由本地代码检查。其他 OpenAI 兼容服务使用 `max_completion_tokens` 与 `store: false`，字段兼容性需实际验证。

单次请求默认超时 35 秒，响应最多 64 KiB，每次问答最多一次请求。远程端点使用 HTTPS，不跟随重定向。接口不提供模型工具调用或本地文件访问。程序只保留安全错误码及 token 数量；模型服务的数据处理政策需依实际服务确认。

## 能力状态

`assistant.status()` 给出身份、资料数量、检索状态和模型状态。模型 `state` 含义如下：

| state          | 含义                                         |
| -------------- | -------------------------------------------- |
| `unconfigured` | 模型尚未配置                                 |
| `configured`   | 配置完整，本进程还没有成功请求               |
| `ready`        | 最近一次 HTTP 请求得到完整、可解析的模型结果 |
| `error`        | 配置有误或最近一次请求失败                   |

`answerValidation` 单独标识应用检查：`not_attempted`、`passed`、`partial`、`rejected` 或 `failed`。`partial` 表示部分生成段落未通过检查，页面仅展示通过核验的内容；无法保留有依据的段落时回退资料检索。查看单次回答的 `mode`，即可区分模型问答、资料检索和证据不足。

## 证据与验证

应用层检查以下约束：

- 仅使用本次返回的真实来源 ID；支持摘句必须是命中段中的连续文本。
- 检索器保留相邻段供本地核对；发送模型和验证引文时仅使用命中段，避免把相邻说话人的发言混入。
- 来源观点的说话人要一致；嘉宾与说话人未知的段落不能支持归给大卫翁的肯定断言。
- 用户案例中的金额、来源中的个人比例和程序情景均保留各自含义。
- 数值按完整“数值+单位”核对，不能让16个月支持6个月。模型回答、源资料和用户输入都按不可信文本处理；无命中、伪引用和连接错误有明确返回状态。

这些检查能确认引文存在及基本归属边界，语义是否完整仍需结合展开的原文判断。检索覆盖、转写质量、来源日期以及说话人识别都会影响回答；应用不会把检索未命中解释成作者从未谈过。

运行 `node --test test/assistant.test.mjs` 可复现本地检查，包含引用伪造、归属错误、注入、计算摘要边界、原文检索降级和 HTTP 错误。真实联通与回答检查使用获授权服务单独进行；记录只保留合成问题、模式、引用核验和安全用量信息。
