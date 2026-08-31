# openai-protocol-bridge

跑在 Cloudflare Workers 上的协议转换网关。老客户端照旧发 `/v1/chat/completions`（或直接发 Anthropic `/v1/messages`），网关在边缘把它们翻译成 OpenAI 新的 **Responses API** 调用，再把响应翻译回客户端期望的格式。

不用改一行业务代码，就能让旧生态（Cherry Studio、NextChat、Claude Code、各类 OpenAI SDK）吃到新协议模型。

```
  旧客户端 / Claude Code                     Cloudflare Worker                    上游
┌────────────────────────┐            ┌───────────────────────────┐        ┌──────────────────┐
│ POST /v1/chat/completions │  ──────▶ │  1. 鉴权 + 模型别名        │ ──────▶ │ /v1/responses    │
│ POST /v1/messages         │          │  2. 归一为 internal 结构   │        │  api.openai.com  │
│ POST /v1/responses        │          │  3. 按前缀选上游 + 渲染     │ ──────▶ │ /v1/responses    │
└────────────────────────┘  ◀──────── │  4. SSE 事件流互转         │        │  grok / 自建网关  │
                                       └───────────────────────────┘        └──────────────────┘
```

## 快速开始

```bash
# 1. 装依赖
npm install

# 2. 配上游（路由表 + 密钥）
cp .dev.vars.example .dev.vars   # 本地开发
npx wrangler secret put UPSTREAM_KEY      # 生产
npx wrangler secret put UPSTREAM_ROUTES   # 生产

# 3. 本地跑
npm run dev      # http://127.0.0.1:8787

# 4. 部署
npm run deploy
```

本地自测（无需联网，会 mock 上游跑完 116 条断言）：

```bash
node scripts/check.mjs   # 协议字段映射 + 流式事件转换
node scripts/e2e.mjs     # Worker 路由 / 鉴权 / 错误处理
```

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI 兼容旧协议入口，转成 Responses 调用；响应按原格式返回 |
| POST | `/v1/messages` | Anthropic Messages 入口，转成 Responses 调用；响应按 Anthropic 格式返回 |
| POST | `/v1/messages/count_tokens` | Anthropic 客户端（如 Claude Code）会调用，返回估算值 |
| POST | `/v1/responses` | 新协议原生入口。上游支持就透传，不支持会自动降级为 chat/completions |
| GET | `/v1/models` | 模型列表透传 |
| GET | `/healthz` | 健康检查 |

## 字段映射

### 请求：chat/completions → Responses

| chat/completions | Responses | 备注 |
| --- | --- | --- |
| `messages[role=system\|developer]` | `instructions` | 多条会合并 |
| `messages[role=user].content[]` | `input[]{type:message,role:user}.content[]` | `text`→`input_text`，`image_url`→`input_image` |
| `messages[role=assistant].content` | `input[]{role:assistant}.content[]` | 用 `output_text` 而非 `input_text` |
| `messages[role=assistant].tool_calls` | `input[]{type:function_call}` | 从消息里拆成独立 item |
| `messages[role=tool]` | `input[]{type:function_call_output}` | `tool_call_id`→`call_id` |
| `tools[]{type:function,function:{}}` | `tools[]{type:function,name,...}` | 两层包装 → 扁平结构 |
| `tool_choice:{type:function,function:{name}}` | `tool_choice:{type:function,name}` | 字符串值 `none/auto/required` 直通 |
| `max_tokens` / `max_completion_tokens` | `max_output_tokens` | |
| `response_format:{type:json_object}` | `text.format:{type:json_object}` | `json_schema` 同理 |
| `reasoning_effort` / `reasoning` | `reasoning:{effort,summary}` | |
| `stream` | `stream` | 事件流在网关内互转 |
| `stop` | `instructions` 软提示 | 新协议无对应字段，见下方「已知取舍」 |
| `seed` / `logprobs` / `n` / `logit_bias` / `presence_penalty` / `frequency_penalty` | — | 新协议不支持，忽略并在 `X-Bridge-Warnings` 里提示 |

### 请求：Anthropic Messages → Responses

| Anthropic | Responses |
| --- | --- |
| `system`（string 或 blocks） | `instructions` |
| `content[]{type:image,source:{type:base64}}` | `input_image.image_url`（拼成 data URI） |
| `content[]{type:tool_use,id,name,input}` | `function_call{call_id,name,arguments}`（`input` 会被 `JSON.stringify`） |
| `content[]{type:tool_result}` | `function_call_output{call_id,output}` |
| `tools[]{name,input_schema}` | `tools[]{type:function,name,parameters}` |
| `tool_choice:{type:auto\|any\|tool}` | `tool_choice:"auto"\|"required"\|{type:function,name}` |
| `max_tokens` | `max_output_tokens` |
| `stop_sequences` | `instructions` 软提示 |
| `content[]{type:thinking}` | 跳过（思考由上游模型自己产出） |

### 响应：Responses → chat/completions

`output[]` 里的 `message` 取文本、`function_call` 收集成 `tool_calls`、`reasoning` 的摘要挂到 `message.reasoning_content`（国内客户端普遍支持这个字段）。

状态映射：`completed` → `stop`（有工具调用时 `tool_calls`）；`incomplete/max_output_tokens` → `length`；`incomplete/content_filter` → `content_filter`。

usage 双向换算：`input_tokens ↔ prompt_tokens`、`output_tokens ↔ completion_tokens`，并回填 `*_tokens_details`。

### 流式

一条统一中间事件流，两种渲染器：

```
上游 Responses SSE  ─┐
                     ├─▶ IR 事件 ─┬─▶ chat.completion.chunk 流（带 [DONE]）
上游 chat SSE       ─┘            └─▶ Anthropic 事件流（message_start → … → message_stop）
```

- 工具调用按下游协议重新编号，arguments 增量能拼回合法 JSON
- 结束帧带 `finish_reason`，随后补一帧 `choices: []` 的 usage（可用 `ALWAYS_INCLUDE_USAGE=false` 关掉）
- Anthropic 侧不发 `[DONE]`，符合其规范

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `UPSTREAM_ROUTES` | OpenAI 官方 | JSON 数组路由表，见下 |
| `UPSTREAM_BASE` | `https://api.openai.com/v1` | 未配路由表时的兜底上游 |
| `UPSTREAM_KEY` | — | 兜底上游密钥；路由未单独配置时使用 |
| `CLIENT_API_KEY` | — | 客户端密钥，逗号分隔；需配合 `REQUIRE_AUTH=true` |
| `REQUIRE_AUTH` | `false` | 是否校验客户端密钥 |
| `MODEL_ALIASES` | `{}` | 模型别名，如 `{"claude-sonnet-4":"gpt-5"}` |
| `ALWAYS_INCLUDE_USAGE` | `true` | 流式末尾是否总是补 usage 帧 |
| `STOP_AS_HINT` | `true` | 把 `stop` / `stop_sequences` 作为软提示写进 instructions |
| `STORE_RESPONSE` | `false` | 对应 Responses 的 `store` 字段 |
| `UPSTREAM_TIMEOUT_MS` | `600000` | 上游超时 |
| `CORS_ALLOW_ORIGIN` | `*` | 跨域来源 |

### 路由表

按 `match` 前缀**顺序匹配**，第一个命中生效；建议把更具体的前缀放在前面。`"*"` 为兜底。

```json
[
  { "match": "gpt-5-",  "base": "https://api.openai.com/v1", "protocol": "responses" },
  { "match": "grok-",   "base": "https://grok.example.com/v1", "key": "g2a_xxx", "protocol": "responses" },
  { "match": "deepseek","base": "https://api.deepseek.com/v1", "key": "sk-xxx", "protocol": "chat" },
  { "match": "*",       "base": "https://api.openai.com/v1", "key": "sk-xxx", "protocol": "responses" }
]
```

- `protocol: "responses"`（默认）——上游说新协议，网关做 chat → Responses 转换
- `protocol: "chat"` ——上游只认旧协议，网关**直接透传**原请求，不做无谓的来回转换，字段零损耗
- `headers` 可选，用于那些不走 `Authorization: Bearer` 的上游（如 `{"x-api-key": "..."}`）

## 客户端接入

**OpenAI SDK / 任何 OpenAI 兼容客户端**

```python
from openai import OpenAI
client = OpenAI(base_url="https://<your-worker>.workers.dev/v1", api_key="任意值")
print(client.chat.completions.create(model="gpt-5", messages=[{"role": "user", "content": "hi"}]).choices[0].message.content)
```

**Claude Code**

```bash
export ANTHROPIC_BASE_URL="https://<your-worker>.workers.dev"
export ANTHROPIC_AUTH_TOKEN="任意值"
export ANTHROPIC_MODEL="gpt-5"        # 或配 MODEL_ALIASES 让 claude-* 自动映射
claude
```

**curl**

```bash
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer any" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"一句话介绍 Cloudflare Workers"}]}'
```

调不通时看响应头：`X-Upstream-Base` / `X-Upstream-Protocol` / `X-Upstream-Model` 告诉你实际打到哪，`X-Bridge-Warnings`（URL 编码）告诉你哪些字段被丢弃了。

## 已知取舍

- **`stop` 无对应字段**：新协议取消了 `stop`，默认降级成 instructions 里的软提示（不保证 100% 停住）。想要严格截断就把 `STOP_AS_HINT` 关掉，自己在后置处理里切。
- **单轮纯文本会压缩成 `input` 字符串**：省 token 也更贴近手写调用；多轮/多模态仍走数组。
- **`store` 默认 `false`**：网关定位是转发，默认不让上游落库。要用 `previous_response_id` 做多轮续接就设成 `true`。
- **一张图大约 0.5–2KB 的 base64 会原样转发**，Workers 请求体上限 100MB，正常用量无碍。
- **Responses 原生工具**（`web_search_preview`、`file_search`、`computer_use` 等）不在 `tools[]` 里做转换，原样透传。
- **Anthropic 的 `thinking` 块不回放**，由上游模型自行产出 reasoning。
