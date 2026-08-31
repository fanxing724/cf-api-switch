/**
 * 端到端测试：mock 上游，直接调用 Worker 的 fetch()，验证路由与协议协商。
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

const env = {
  UPSTREAM_ROUTES: JSON.stringify([
    { match: 'grok-', base: 'https://grok-up.test/v1', key: 'g2a_key', protocol: 'responses' },
    { match: 'legacy-', base: 'https://legacy-up.test/v1', key: 'legacy_key', protocol: 'chat' },
    { match: '*', base: 'https://openai-up.test/v1', key: 'sk-test', protocol: 'responses' },
  ]),
  ALWAYS_INCLUDE_USAGE: 'true',
  STOP_AS_HINT: 'true',
  STORE_RESPONSE: 'false',
  CORS_ALLOW_ORIGIN: '*',
};

/** 记录上游实际收到的请求，便于断言 */
let captured = [];
let mockImpl = null;

globalThis.fetch = async (url, init) => {
  captured.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
  return mockImpl(String(url), init);
};

function jsonRes(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

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

const okResponse = {
  id: 'resp_e2e',
  object: 'response',
  created_at: 1756000000,
  status: 'completed',
  model: 'gpt-5',
  output: [
    {
      type: 'message',
      id: 'msg_e2e',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '转换成功', annotations: [] }],
    },
  ],
  usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
};

const post = (path, body, headers = {}) =>
  worker.fetch(
    new Request(`https://bridge.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer client-key', ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );

/* ------------------------------------------------------------------ */
section('1. /v1/chat/completions 非流式 → Responses 上游');

{
  captured = [];
  mockImpl = async () => jsonRes(okResponse);
  const res = await post('/v1/chat/completions', {
    model: 'gpt-5',
    messages: [
      { role: 'system', content: '简短回答' },
      { role: 'user', content: '测试' },
    ],
  });
  const out = await res.json();

  check('HTTP 200', res.status === 200);
  check('打到 Responses 端点', captured[0].url === 'https://openai-up.test/v1/responses', captured[0].url);
  check('上游 Authorization 用路由 key 而非客户端 key', captured[0].init.headers.get('authorization') === 'Bearer sk-test', captured[0].init.headers.get('authorization'));
  check('上游收到 instructions', captured[0].body.instructions === '简短回答');
  check('上游收到 input 字符串', captured[0].body.input === '测试');
  check('上游 store=false', captured[0].body.store === false);
  check('响应 object=chat.completion', out.object === 'chat.completion');
  check('响应内容正确', out.choices[0].message.content === '转换成功');
  check('响应 usage 已换算', out.usage.prompt_tokens === 11 && out.usage.completion_tokens === 22);
  check('暴露上游元信息 header', res.headers.get('X-Upstream-Model') === 'gpt-5' && res.headers.get('X-Upstream-Base') === 'https://openai-up.test/v1');
  check('CORS header 存在', res.headers.get('Access-Control-Allow-Origin') === '*');
}

/* ------------------------------------------------------------------ */
section('2. /v1/chat/completions 流式');

{
  captured = [];
  mockImpl = async () =>
    sseRes([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_s","model":"gpt-5","created_at":1,"status":"in_progress","output":[]}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_s","role":"assistant","status":"in_progress","content":[]}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"流式"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"正常"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_s","status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":6,"total_tokens":11}}}\n\n',
    ]);

  const res = await post('/v1/chat/completions', { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], stream: true });
  const text = await res.text();

  check('Content-Type 为 text/event-stream', res.headers.get('content-type').includes('text/event-stream'));
  check('上游收到 stream=true', captured[0].body.stream === true);
  check('输出以 data: [DONE] 结束', text.trimEnd().endsWith('data: [DONE]'));
  const chunks = text.split('\n\n').filter(Boolean).map((b) => b.replace(/^data: /, '')).filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));
  check('文本增量拼接为「流式正常」', chunks.filter((c) => c.choices[0]?.delta?.content).map((c) => c.choices[0].delta.content).join('') === '流式正常');
  check('结束帧 finish_reason=stop', chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason === 'stop');
  check('末尾回传 usage', chunks.find((c) => c.usage)?.usage.total_tokens === 11);
}

/* ------------------------------------------------------------------ */
section('3. /v1/messages（Anthropic 入口）');

{
  captured = [];
  mockImpl = async () => jsonRes(okResponse);
  const res = await post(
    '/v1/messages',
    {
      model: 'gpt-5',
      max_tokens: 512,
      system: '你是助手',
      messages: [{ role: 'user', content: '你好' }],
    },
    { 'anthropic-version': '2023-06-01' },
  );
  const out = await res.json();

  check('HTTP 200', res.status === 200);
  check('打到 Responses 端点', captured[0].url.endsWith('/responses'));
  check('上游 instructions 来自 Anthropic system', captured[0].body.instructions.startsWith('你是助手'));
  check('max_tokens → max_output_tokens', captured[0].body.max_output_tokens === 512);
  check('响应 type=message', out.type === 'message' && out.role === 'assistant');
  check('响应 content 为 Anthropic 文本块', out.content[0].type === 'text' && out.content[0].text === '转换成功');
  check('响应 stop_reason=end_turn', out.stop_reason === 'end_turn');
  check('响应 usage 为 Anthropic 结构', out.usage.input_tokens === 11 && out.usage.output_tokens === 22);
}

{
  // Anthropic 流式
  captured = [];
  mockImpl = async () =>
    sseRes([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_a","model":"gpt-5","created_at":1,"status":"in_progress","output":[]}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"m","role":"assistant","status":"in_progress","content":[]}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Anthropic"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_a","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n',
    ]);
  const res = await post('/v1/messages', { model: 'gpt-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], stream: true });
  const text = await res.text();
  const types = text.split('\n\n').filter(Boolean).map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: ')).slice(6)).type);

  check('Anthropic 流首帧 message_start', types[0] === 'message_start');
  check('Anthropic 流含 content_block_start/delta/stop', types.includes('content_block_start') && types.includes('content_block_delta') && types.includes('content_block_stop'));
  check('Anthropic 流以 message_stop 结束', types[types.length - 1] === 'message_stop');
  check('Anthropic 流不含 [DONE]', !text.includes('[DONE]'));
  check('Anthropic 流文本正确', text.includes('"text":"Anthropic"'));
}

/* ------------------------------------------------------------------ */
section('4. 多上游路由');

{
  captured = [];
  mockImpl = async () => jsonRes(okResponse);
  await post('/v1/chat/completions', { model: 'grok-4', messages: [{ role: 'user', content: 'hi' }] });
  check('grok- 模型打到 grok 上游', captured[0].url === 'https://grok-up.test/v1/responses');
  check('grok 上游使用自己的 key', captured[0].init.headers.get('authorization') === 'Bearer g2a_key');
}

{
  // 上游只支持旧协议：应改打 chat/completions
  captured = [];
  mockImpl = async () =>
    jsonRes({
      id: 'chatcmpl-legacy',
      created: 1,
      model: 'legacy-model',
      choices: [{ index: 0, message: { role: 'assistant', content: '旧协议回复' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
  const res = await post('/v1/chat/completions', { model: 'legacy-model', messages: [{ role: 'user', content: 'hi' }] });
  const out = await res.json();
  check('旧协议上游 → /chat/completions 端点', captured[0].url === 'https://legacy-up.test/v1/chat/completions', captured[0].url);
  check('旧协议上游收到的仍是 messages 结构', Array.isArray(captured[0].body.messages));
  check('响应已规范化为 chat.completion', out.object === 'chat.completion' && out.choices[0].message.content === '旧协议回复');
}

/* ------------------------------------------------------------------ */
section('5. 错误处理与边界');

{
  captured = [];
  mockImpl = async () => new Response(JSON.stringify({ error: { message: '模型不存在', type: 'invalid_request_error' } }), { status: 404, headers: { 'content-type': 'application/json' } });
  const res = await post('/v1/chat/completions', { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });
  const out = await res.json();
  check('上游 404 被透传', res.status === 404);
  check('错误信息保留上游原始文案', out.error.message.includes('模型不存在'), out.error);
}

{
  const res = await worker.fetch(new Request('https://bridge.test/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ broken json' }), env);
  check('非法 JSON 返回 400', res.status === 400);
}

{
  const res = await worker.fetch(new Request('https://bridge.test/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5' }) }), env);
  check('缺少 messages 返回 400', res.status === 400);
}

{
  const res = await worker.fetch(new Request('https://bridge.test/v1/unknown', { method: 'POST', body: '{}' }), env);
  check('未知路由返回 404', res.status === 404);
}

{
  const res = await worker.fetch(new Request('https://bridge.test/healthz'), env);
  const out = await res.json();
  check('健康检查返回 ok', res.status === 200 && out.ok === true);
}

{
  const res = await worker.fetch(new Request('https://bridge.test/v1/chat/completions', { method: 'OPTIONS' }), env);
  check('CORS 预检返回 204', res.status === 204 && res.headers.get('Access-Control-Allow-Methods')?.includes('POST'));
}

{
  const res = await worker.fetch(
    new Request('https://bridge.test/v1/messages/count_tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: '一'.repeat(320) }] }) }),
    env,
  );
  const out = await res.json();
  check('count_tokens 返回估算值', res.status === 200 && out.input_tokens > 0, out);
}

/* ------------------------------------------------------------------ */
section('6. 鉴权');

{
  const authEnv = { ...env, REQUIRE_AUTH: 'true', CLIENT_API_KEY: 'key-a,key-b' };
  const bad = await worker.fetch(
    new Request('https://bridge.test/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: JSON.stringify({ model: 'gpt-5', messages: [] }) }),
    authEnv,
  );
  check('错误 key 被拒（401）', bad.status === 401);

  mockImpl = async () => jsonRes(okResponse);
  const good = await worker.fetch(
    new Request('https://bridge.test/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer key-b' }, body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'x' }] }) }),
    authEnv,
  );
  check('正确 key 放行', good.status === 200);
}

/* ------------------------------------------------------------------ */
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
