/**
 * 端到端测试（v2 多渠道架构）
 *
 * 用内存 KV 模拟 Workers KV，mock 上游，直接调用 Worker 的 fetch()。
 *   node scripts/e2e.mjs
 */

import worker from '../src/index.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}`);
  }
}

function section(t) {
  console.log(`\n\x1b[36m${t}\x1b[0m`);
}

/** 内存版 Workers KV */
class MemoryKV {
  constructor() {
    this.m = new Map();
  }
  async get(k) {
    return this.m.has(k) ? this.m.get(k) : null;
  }
  async put(k, v) {
    this.m.set(k, v);
  }
  async delete(k) {
    this.m.delete(k);
  }
}

const env = {
  KV: new MemoryKV(),
  CHANNELS: '[]',
  SETTINGS: '{"requireAuth":false,"clientKeys":[]}',
  UPSTREAM_TIMEOUT_MS: '120000',
  CORS_ALLOW_ORIGIN: '*',
};

/* ------------------------- mock 上游 ------------------------- */

let captured = [];
let mockImpl = null;

globalThis.fetch = async (url, init) => {
  captured.push({
    url: String(url),
    method: init?.method || 'GET',
    headers: init?.headers instanceof Headers ? init.headers : new Headers(init?.headers || {}),
    body: init?.body ? JSON.parse(init.body) : null,
  });
  return mockImpl(String(url), init);
};

const jsonRes = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

function sseRes(lines) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 上游（chat 协议）普通响应 */
function chatResponse(text, extra = {}) {
  return {
    id: 'chatcmpl-up',
    created: 1756000000,
    model: 'up-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text, ...extra }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

const req = (path, init = {}) => worker.fetch(new Request(`https://gw.test${path}`, init), env);

const post = (path, body, headers = {}) =>
  req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

/* ================================================================== */
section('1. 面板：初始化与鉴权');

let adminCookie = null;

{
  const res = await req('/_admin/api/session');
  const out = await res.json();
  check('未初始化时 session 返回 initialized:false', out.initialized === false && out.authenticated === false, out);
  check('storage 识别为 kv', out.storage === 'kv');
}

{
  const res = await post('/_admin/api/channels', { name: 'x', slug: 'x', baseUrl: 'https://a.com' });
  check('未登录时写渠道被拒（401）', res.status === 401, res.status);
}

{
  const res = await post('/_admin/api/init', { password: 'abc' });
  check('密码过短被拒', res.status === 400);
}

{
  const res = await post('/_admin/api/init', { password: 'secret123' });
  const out = await res.json();
  const setCookie = res.headers.get('set-cookie') || '';
  check('初始化密码成功', res.status === 200 && out.ok === true, out);
  check('下发 HttpOnly + Secure cookie', setCookie.includes('HttpOnly') && setCookie.includes('Secure'), setCookie);
  adminCookie = setCookie.split(';')[0];
  check('cookie 可解析', adminCookie.startsWith('cfs_admin='), adminCookie);
}

{
  const res = await post('/_admin/api/init', { password: 'another' });
  check('重复初始化被拒', res.status === 400);
}

{
  const res = await post('/_admin/api/login', { password: 'wrong' });
  check('错误密码登录失败', res.status === 401);
}

{
  const res = await post('/_admin/api/login', { password: 'secret123' });
  check('正确密码登录成功', res.status === 200);
}

/* ================================================================== */
section('2. 面板：渠道 CRUD');

const authHeaders = () => ({ cookie: adminCookie });

let deepseekId = null;
let arkId = null;

{
  const res = await post('/_admin/api/channels', {
    name: 'DeepSeek 官方',
    slug: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-deepseek-8888',
    vendor: 'deepseek',
    protocol: 'openai-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  }, authHeaders());
  const out = await res.json();
  check('创建 deepseek 渠道', res.status === 200 && out.channel?.slug === 'deepseek', out);
  check('返回的 API Key 已掩码（中间被替换）', out.channel?.apiKey?.includes('****') && !out.channel.apiKey.includes('seek-8888'), out.channel?.apiKey);
  check('hasKey 标记为真', out.channel?.hasKey === true);
  deepseekId = out.channel?.id;
}

{
  const res = await post('/_admin/api/channels', {
    name: '火山方舟',
    slug: 'ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'ark-key-9999',
    vendor: 'ark',
    protocol: 'openai-chat',
    models: ['ep-20250101-abcdef'],
  }, authHeaders());
  const out = await res.json();
  check('创建 ark 渠道', res.status === 200 && out.channel?.slug === 'ark');
  arkId = out.channel?.id;
}

{
  const res = await req('/_admin/api/channels', { headers: authHeaders() });
  const out = await res.json();
  check('渠道列表返回 2 条', out.channels?.length === 2, out.channels?.length);
}

{
  // slug 重复时应视为更新而非新建
  const res = await post('/_admin/api/channels', {
    name: 'DeepSeek 改名',
    slug: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-deepseek-8888',
    vendor: 'deepseek',
    models: ['deepseek-chat'],
  }, authHeaders());
  const out = await res.json();
  check('同 slug 提交走更新', out.channel?.id === deepseekId && out.channel?.name === 'DeepSeek 改名', out.channel?.name);
}

{
  const res = await post('/_admin/api/channels', { name: '无 slug', baseUrl: 'https://x.com' }, authHeaders());
  check('缺少 slug 被拒', res.status === 500 || res.status === 400, res.status);
}

{
  mockImpl = async () => jsonRes(chatResponse('ok'));
  const res = await post(`/_admin/api/channel/${deepseekId}/test`, {}, authHeaders());
  const out = await res.json();
  check('连通性测试通过', out.ok === true && out.status === 200, out);
  check('测试返回延迟', typeof out.latency === 'number', out.latency);
}

{
  const res = await post(`/_admin/api/channel/${deepseekId}/toggle`, {}, authHeaders());
  const out = await res.json();
  check('停用渠道', out.channel?.enabled === false, out.channel?.enabled);
  await post(`/_admin/api/channel/${deepseekId}/toggle`, {}, authHeaders());
}

{
  const res = await post('/_admin/api/settings', { requireAuth: true, clientKeys: ['sk-client-1'] }, authHeaders());
  check('保存访问设置', res.status === 200);
  const get = await req('/_admin/api/settings', { headers: authHeaders() });
  const out = await get.json();
  check('设置读回一致', out.requireAuth === true && out.clientKeys.includes('sk-client-1'), out);
}

/* ================================================================== */
section('3. 客户端鉴权');

{
  mockImpl = async () => jsonRes(chatResponse('ok'));
  const bad = await post('/deepseek/v1/responses', { model: 'deepseek-chat', input: 'hi' }, { authorization: 'Bearer wrong' });
  check('客户端 key 错误被拒（401）', bad.status === 401, bad.status);

  const good = await post('/deepseek/v1/responses', { model: 'deepseek-chat', input: 'hi' }, { authorization: 'Bearer sk-client-1' });
  check('正确的客户端 key 放行', good.status === 200, good.status);

  await post('/_admin/api/settings', { requireAuth: false, clientKeys: [] }, authHeaders());
}

/* ================================================================== */
section('4. 主链路：responses 入站 → chat 上游');

{
  captured = [];
  mockImpl = async () => jsonRes(chatResponse('你好，我是 DeepSeek'));

  const res = await post('/deepseek/v1/responses', {
    model: 'deepseek-chat',
    instructions: '请简短回答',
    input: '介绍一下你自己',
    max_output_tokens: 500,
    temperature: 0.7,
  });
  const out = await res.json();

  check('HTTP 200', res.status === 200, out);
  check('按 slug 打到 deepseek 上游', captured[0].url === 'https://api.deepseek.com/v1/chat/completions', captured[0].url);
  check('上游收到 system 消息（来自 instructions）', captured[0].body.messages[0].role === 'system' && captured[0].body.messages[0].content === '请简短回答', captured[0].body.messages);
  check('上游收到 user 消息（来自 input 字符串）', captured[0].body.messages[1].role === 'user' && captured[0].body.messages[1].content === '介绍一下你自己');
  check('max_output_tokens → max_tokens', captured[0].body.max_tokens === 500, captured[0].body.max_tokens);
  check('temperature 透传', captured[0].body.temperature === 0.7);
  check('响应 object 为 response', out.object === 'response', out.object);
  check('响应 status=completed', out.status === 'completed');
  check('output 含 message 项', out.output?.[0]?.type === 'message' && out.output[0].role === 'assistant', out.output);
  check('正文正确', out.output?.[0]?.content?.[0]?.text === '你好，我是 DeepSeek', out.output);
  check('output_text 已填充', out.output_text === '你好，我是 DeepSeek');
  check('usage 已换算为新协议字段', out.usage?.input_tokens === 10 && out.usage?.output_tokens === 20, out.usage);
  check('响应头暴露渠道信息', res.headers.get('X-Channel-Slug') === 'deepseek' && res.headers.get('X-Upstream-Url')?.includes('deepseek'), res.headers.get('X-Upstream-Url'));
}

{
  // 火山方舟：版本号在 base 里，不能再拼 /v1
  captured = [];
  mockImpl = async () => jsonRes(chatResponse('方舟回复'));
  const res = await post('/ark/v1/responses', { model: 'ep-20250101-abcdef', input: 'hi' });
  const out = await res.json();
  check('方舟 URL 不重复版本号', captured[0].url === 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', captured[0].url);
  check('方舟响应正常', out.output?.[0]?.content?.[0]?.text === '方舟回复');
}

{
  // 不带 slug：按模型自动选渠道
  captured = [];
  mockImpl = async () => jsonRes(chatResponse('自动路由'));
  const res = await post('/v1/responses', { model: 'deepseek-chat', input: 'hi' });
  check('按模型自动路由到 deepseek 渠道', res.status === 200 && captured[0].url.includes('api.deepseek.com'), captured[0].url);

  const res2 = await post('/v1/responses', { model: '不存在的模型', input: 'hi' });
  check('无渠道可处理时返回 404', res2.status === 404, res2.status);
}

/* ================================================================== */
section('5. 思维链与工具调用');

{
  captured = [];
  mockImpl = async () =>
    jsonRes({
      id: 'chatcmpl-r1',
      created: 1,
      model: 'deepseek-reasoner',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '答案是 42', reasoning_content: '让我算一下……' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
    });

  const res = await post('/deepseek/v1/responses', { model: 'deepseek-reasoner', input: '1+1=?' });
  const out = await res.json();

  check('reasoning_content 变成 reasoning 项', out.output?.[0]?.type === 'reasoning', out.output);
  check('reasoning 内容保留', out.output?.[0]?.summary?.[0]?.text === '让我算一下……', out.output?.[0]);
  check('正文项紧随其后', out.output?.[1]?.type === 'message' && out.output[1].content[0].text === '答案是 42', out.output?.[1]);
  check('R1 模型不向上游传 temperature', captured[0].body.temperature === undefined, captured[0].body);
}

{
  captured = [];
  mockImpl = async () =>
    jsonRes({
      id: 'chatcmpl-tool',
      created: 1,
      model: 'deepseek-chat',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"吉安"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });

  const res = await post('/deepseek/v1/responses', {
    model: 'deepseek-chat',
    input: '天气',
    tools: [{ type: 'function', name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
  });
  const out = await res.json();

  check('新协议扁平 tools 转成 chat 两层结构', captured[0].body.tools[0].type === 'function' && !!captured[0].body.tools[0].function, captured[0].body.tools);
  check('上游收到 function.name', captured[0].body.tools[0].function.name === 'get_weather');
  const fc = out.output?.find((o) => o.type === 'function_call');
  check('响应含 function_call 项', !!fc, out.output);
  check('call_id 正确', fc?.call_id === 'call_1');
  check('arguments 保持字符串', typeof fc?.arguments === 'string' && JSON.parse(fc.arguments).city === '吉安', fc?.arguments);
}

{
  // 多轮：function_call + function_call_output 回到上游 chat 结构
  captured = [];
  mockImpl = async () => jsonRes(chatResponse('综合结果'));
  await post('/deepseek/v1/responses', {
    model: 'deepseek-chat',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '吉安天气' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"吉安"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '28度晴' },
    ],
  });
  const msgs = captured[0].body.messages;
  check('多轮回程：user 消息', msgs[0].role === 'user', msgs);
  check('多轮回程：assistant 带 tool_calls', msgs[1].role === 'assistant' && msgs[1].tool_calls?.[0]?.function?.name === 'get_weather', msgs[1]);
  check('多轮回程：tool 结果', msgs[2].role === 'tool' && msgs[2].content === '28度晴', msgs[2]);
}

/* ================================================================== */
section('6. 流式：responses 入站 → chat 上游');

{
  captured = [];
  mockImpl = async () =>
    sseRes([
      'data: {"id":"chatcmpl-s","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-s","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"流式"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-s","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"正常"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-s","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"reasoning_content":"思考中"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-s","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"chatcmpl-s","created":1,"model":"deepseek-chat","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}\n\n',
      'data: [DONE]\n\n',
    ]);

  const res = await post('/deepseek/v1/responses', { model: 'deepseek-chat', input: 'hi', stream: true });
  const text = await res.text();
  const events = text
    .split('\n\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => {
      const line = b.split('\n').find((l) => l.startsWith('data: '));
      return line ? JSON.parse(line.slice(6)) : null;
    })
    .filter(Boolean);
  const types = events.map((e) => e.type);

  check('Content-Type 为 event-stream', res.headers.get('content-type').includes('text/event-stream'));
  check('首个事件是 response.created', types[0] === 'response.created', types.slice(0, 3));
  check('含 output_text.delta 增量', types.includes('response.output_text.delta'));
  check('文本增量内容正确', events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('') === '流式正常');
  check('reasoning 走 reasoning_summary_text.delta', types.includes('response.reasoning_summary_text.delta'), types);
  check('最后是 response.completed', types[types.length - 1] === 'response.completed', types.slice(-2));
  const done = events[events.length - 1].response;
  check('completed 带 usage', done.usage?.input_tokens === 4 && done.usage?.output_tokens === 6, done.usage);
  check('completed 状态为 completed', done.status === 'completed');
}

/* ================================================================== */
section('7. 旧协议入站与故障转移');

{
  // 客户端用旧 chat 协议打到同一个渠道，上游也是 chat —— 应原样透传并规范化
  captured = [];
  mockImpl = async () => jsonRes(chatResponse('老协议回复'));
  const res = await post('/deepseek/v1/chat/completions', { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] });
  const out = await res.json();
  check('chat 入站 → chat 上游：object 正确', out.object === 'chat.completion', out.object);
  check('chat 入站 → chat 上游：内容透传', out.choices[0].message.content === '老协议回复');
  check('chat 入站 → chat 上游：上游收到 messages', Array.isArray(captured[0].body.messages));
}

{
  // Anthropic 客户端入站
  captured = [];
  mockImpl = async () => jsonRes(chatResponse('anthropic 回复'));
  const res = await post('/deepseek/v1/messages', { model: 'deepseek-chat', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
  const out = await res.json();
  check('Anthropic 入站 → chat 上游：type=message', out.type === 'message', out);
  check('Anthropic 入站 → chat 上游：content 块', out.content?.[0]?.type === 'text' && out.content[0].text === 'anthropic 回复', out.content);
}

{
  // 故障转移：第一个渠道 500，第二个 200
  const savedId = deepseekId;
  await post('/_admin/api/channels', {
    name: '备用 DeepSeek',
    slug: 'deepseek2',
    baseUrl: 'https://backup.deepseek.com',
    apiKey: 'sk-backup',
    vendor: 'generic',
    models: ['deepseek-chat'],
    weight: 50,
  }, authHeaders());

  let callCount = 0;
  mockImpl = async (url) => {
    callCount++;
    if (callCount === 1) return jsonRes({ error: { message: '上游炸了' } }, 500);
    return jsonRes(chatResponse('备用渠道接住了'));
  };

  captured = [];
  const res = await post('/v1/responses', { model: 'deepseek-chat', input: 'hi' });
  const out = await res.json();
  check('5xx 自动切到下一个渠道', res.status === 200 && out.output?.[0]?.content?.[0]?.text === '备用渠道接住了', out);
  check('实际尝试了 2 次', captured.length === 2, captured.length);
  check('响应头记录重试次数', res.headers.get('X-Fallback-Attempts') === '1', res.headers.get('X-Fallback-Attempts'));

  // 4xx 不重试
  callCount = 0;
  captured = [];
  mockImpl = async () => jsonRes({ error: { message: '模型不存在' } }, 404);
  const res2 = await post('/v1/responses', { model: 'deepseek-chat', input: 'hi' });
  check('4xx 不重试其他渠道', captured.length === 1, captured.length);
  check('4xx 状态透传', res2.status === 404, res2.status);

  // 清理：删掉备用渠道，避免影响后续用例
  const list = await (await req('/_admin/api/channels', { headers: authHeaders() })).json();
  const backup = list.channels.find((c) => c.slug === 'deepseek2');
  await req(`/_admin/api/channel/${backup.id}`, { method: 'DELETE', headers: authHeaders() });
  deepseekId = savedId;
}

/* ================================================================== */
section('8. 模型列表与错误处理');

{
  mockImpl = async () => jsonRes({ object: 'list', data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] });
  const res = await req('/deepseek/v1/models');
  const out = await res.json();
  check('指定渠道时透传上游模型列表', res.status === 200 && out.data?.length === 2, out);
}

{
  const res = await req('/v1/models');
  const out = await res.json();
  check('未指定渠道时聚合所有渠道模型', out.data?.some((m) => m.id === 'deepseek-chat') && out.data?.some((m) => m.id === 'ep-20250101-abcdef'), out.data);
}

{
  const res = await post('/deepseek/v1/responses', { model: 'deepseek-chat' });
  check('responses 缺少 input 返回 400', res.status === 400, res.status);
}

{
  const res = await post('/deepseek/v1/chat/completions', { model: 'deepseek-chat' });
  check('chat 缺少 messages 返回 400', res.status === 400, res.status);
}

{
  const res = await post('/deepseek/v1/responses', { model: 'deepseek-chat', input: 'hi' }, { 'content-type': 'application/json' });
  check('正常请求仍可通过', res.status === 200);
}

{
  const res = await post('/notexist/v1/responses', { model: 'deepseek-chat', input: 'hi' });
  const out = await res.json();
  check('未配置渠道的 slug 返回 404', res.status === 404, res.status);
  check('404 提示语包含渠道名', out.error?.message?.includes('notexist'), out.error);
}

{
  const res = await req('/_admin');
  const html = await res.text();
  check('面板 HTML 可访问', res.status === 200 && html.includes('<!DOCTYPE html>'));
  check('面板含登录/初始化逻辑', html.includes('boot()') && html.includes('_admin/api'));
}

/* ================================================================== */
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
