# cf-api-switch

跑在 Cloudflare Workers 上的**多渠道协议转换网关**。

你手上那些只认老 `chat/completions` 的站点（DeepSeek、火山方舟、各种 NewAPI / one-api 中转），
在这后面加一层，就统一变成 **OpenAI 新 Responses 协议**对外。老客户端不用改，新协议能力直接吃上。

```
客户端                          Worker                              上游站点
────────────────────────────  ──────────────────────────────────  ──────────────────
/v1/responses          ┐       ┌ 解析路径：<渠道名>/v1/<端点>        DeepSeek
/<渠道名>/v1/responses ├──────▶│ 入站协议 -> internal 中间表示   ──▶  火山方舟
/v1/chat/completions   │       │ internal -> 该渠道的原生格式        NewAPI 站
/v1/messages           ┘       └ 响应按入站协议翻译回去              OpenAI 官方
                                      ▲
                                      │ 渠道配置（Workers KV）
                              ┌───────┴────────┐
                              │  /_admin 面板   │
                              └────────────────┘
```

## 路由规则

```
https://<你的域名>/<渠道名>/v1/<端点>
```

斜杠后第一段是渠道标识（面板里配的「路径标识」），后面是标准端点。

| 例子 | 含义 |
| --- | --- |
| `你的域名/deepseek/v1/responses` | 用新协议打 DeepSeek |
| `你的域名/ark/v1/chat/completions` | 用旧协议打火山方舟 |
| `你的域名/v1/responses` | 不带渠道名，按请求里的 `model` 自动选渠道 |
| `你的域名/deepseek/v1/models` | 直接问该渠道要模型列表 |

**入站协议由最后一段决定，出站协议由渠道配置决定**，两者解耦 —— 所以同一个 DeepSeek 渠道，
你可以用新协议访问它，也可以让老客户端照旧用 chat 协议访问它。

## 快速开始

```bash
npm install

# 1. 建 KV（存渠道配置，必须）
npx wrangler kv namespace create cf_api_switch
#    把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]]，替换掉占位值

# 2. 部署
npm run deploy

# 3. 打开 https://<你的域名>/_admin
#    设置管理员密码 -> 新增渠道 -> 填上游地址和 Key -> 「测试」确认连通
```

本地联调：

```bash
cp .dev.vars.example .dev.vars    # 可选：预置渠道，省得每次手填
node scripts/mock-upstream.mjs    # 另开一个终端，8788 端口装成各家上游
npm run dev                       # 8787
```

自测（不联网，151 条断言）：

```bash
node scripts/check.mjs   # 协议字段映射 + 流式事件转换（71 条）
node scripts/e2e.mjs     # 面板鉴权 / 渠道 CRUD / 主链路 / 故障转移（80 条）
```

## 入站 × 出站 转换矩阵

入站三种协议都能接，出站按渠道配置渲染。已实现的组合：

| 入站 | 上游是 chat 协议 | 上游是新协议 |
| --- | --- | --- |
| `/v1/responses` | 新协议 → chat，响应转回 Responses | 直接管道透传，零损耗 |
| `/v1/chat/completions` | chat → chat，规范化后转发 | chat → Responses，响应转回 chat |
| `/v1/messages` | Anthropic → chat，响应转回 Anthropic 格式 | Anthropic → Responses |

三条入站路径都支持流式，客户端拿到的始终是自己那种协议的事件流。

## 字段映射（新协议 ↔ 老协议）

| Responses（新） | chat/completions（老） | 备注 |
| --- | --- | --- |
| `instructions` | `messages[role=system]` | 多条合并 |
| `input` 字符串 | `messages[role=user].content` | 单轮纯文本时压缩 |
| `input[]{type:message}` | `messages[]` | `input_text`↔`text`、`input_image`↔`image_url` |
| `input[]{type:function_call}` | `messages[].tool_calls` | `call_id` ↔ `id` |
| `input[]{type:function_call_output}` | `messages[role=tool]` | |
| `tools[]{type:function,name,...}` | `tools[]{type:function,function:{}}` | 扁平 ↔ 两层包装 |
| `max_output_tokens` | `max_tokens` | |
| `text.format` | `response_format` | `json_object` / `json_schema` |
| `reasoning.effort` | `reasoning_effort` | |
| `output[]{type:reasoning}` | `message.reasoning_content` | DeepSeek-R1 / 火山思考模型 / o1 系 |
| `output[]{type:function_call}` | `message.tool_calls` | |
| `usage.input_tokens` | `usage.prompt_tokens` | 含 `*_tokens_details` 回填 |

## 厂商：**自由填写**，预设仅供参考

面板里的「厂商」是个普通输入框，不是下拉枚举。填什么名字都行：

- 填 `deepseek` / `ark` → 命中预设，自动应用对应的差异处理
- 填 `zhipu` / `openrouter` / `随便起的名字` → 按通用 OpenAI 兼容转发，名字原样保存当备注用

**所以适配一个没见过的新站点，不需要改代码。** 直接在面板上填，然后用「高级」里的三项兜底：

| 高级字段 | 用途 | 什么时候用 |
| --- | --- | --- |
| **URL 版本段** | 拼在地址与端点之间那段，默认 `v1` | 上游用 `v1beta` 之类的就改它 |
| **地址已含版本号** | 勾选后不再拼任何版本段 | 火山方舟（`/api/v3`）、把版本号写进地址的中转站 |
| **剔除参数** | 逗号分隔，发送前从请求体删掉 | 上游不认 `user` / `stream_options` / `logit_bias` 之类 |
| **自定义请求头** | JSON 对象，追加到上游请求 | 上游走 `x-api-key` 而不是 `Authorization: Bearer` |

举例，接一个地址是 `https://my.example.com/api/v9`、不认 `user` 字段、靠 `x-api-key` 鉴权的站：

```
厂商：随便填
上游地址：https://my.example.com/api/v9
☑ 地址已含版本号
剔除参数：user
自定义请求头：{"x-api-key": "xxx"}
```

### 预设厂商的差异处理

差异点收敛在 `src/vendors/index.js`，想固化某个厂商的行为就往里加一个对象：

| 厂商 | 差异处理 |
| --- | --- |
| **通用**（默认） | 直接转发。适用于 NewAPI / one-api / 各类中转站 |
| **DeepSeek** | R1 系列不向上游传 `temperature` / `top_p`（官方建议）；剔除 `logit_bias`、`n`；响应的 `reasoning_content` 映射成新协议的 reasoning 项 |
| **火山方舟** | URL 版本号写在 base 里（`/api/v3`），不重复拼 `/v1`；剔除 `logit_bias`、`user`；模型名填控制台的接入点 ID（`ep-xxxx`） |

渠道上手动填的「剔除参数」优先级最高，会覆盖厂商预设的行为。

## 管理面板

访问 `/_admin`：

- **渠道管理**：增删改查、启停、权重（同模型多渠道时大的优先）、超时
- **连通性测试**：发一个真实请求，区分「鉴权失败」和「已连通但请求被拒」
- **一键拉模型**：从上游 `/models` 拉真实列表回填到白名单
- **访问设置**：客户端 API Key（逗号分隔）+ 是否强制鉴权
- **改密码**

安全设计：

- 密码用 PBKDF2-SHA256 派生后存 KV，**不存明文**
- 登录态是 HMAC-SHA256 签名的 `HttpOnly` + `Secure` + `SameSite=Lax` cookie，12 小时过期
- 列表接口返回的 API Key **一律掩码**（`sk-dee****8888`），明文不回前端
- 写操作全部校验登录态，未初始化密码时返回明确引导而非笼统 401

## 故障转移

同一个模型配了多个渠道时，按权重降序依次尝试：

- **5xx / 429 / 网络超时** → 自动切下一个渠道
- **4xx** → 直接返回，不重试（是请求或配置问题，换渠道也没用）
- 重试次数写在响应头 `X-Fallback-Attempts` 里

## 调试

响应头会告诉你实际发生了什么：

| 响应头 | 内容 |
| --- | --- |
| `X-Channel-Slug` / `X-Channel-Id` | 命中的渠道 |
| `X-Upstream-Url` | 实际请求的完整上游地址 |
| `X-Upstream-Protocol` | 出站用的协议（`openai-chat` / `responses`） |
| `X-Fallback-Attempts` | 失败重试过几次 |
| `X-Bridge-Warnings` | 被丢弃或降级的字段（URL 编码） |

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `KV`（binding） | 渠道与设置的存储，**必须配置** |
| `CHANNELS` | 无 KV 时的兜底渠道配置（JSON 数组） |
| `SETTINGS` | 无 KV 时的兜底站点设置 |
| `UPSTREAM_TIMEOUT_MS` | 默认超时，渠道里可单独覆盖 |
| `CORS_ALLOW_ORIGIN` | 跨域来源 |

## 已知取舍

- **新协议没有 `stop`**：早前版本会把 `stop` 降级成 instructions 软提示；现在主链路是「新协议入站 → 老协议出站」，`stop` 由入站侧决定，用 `/v1/chat/completions` 入站时可正常使用。
- **`reasoning_content` 只做单向还原**：上游老协议 → 客户端新协议。反向（客户端在新协议里塞 reasoning 项进来）会被跳过。
- **未绑定 KV 时配置不持久化**：面板会顶部横幅警告。本地 dev 想持久化可以 `--persist-to .wrangler/state`。
- **流式中途失败无法回退**：故障转移只在「发起请求」阶段生效。一旦上游开始返回 200 并吐流，中途断了就只能把错误事件传给客户端。
