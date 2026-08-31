/**
 * 本地 mock 上游，用于 wrangler dev 联调。
 *   node scripts/mock-upstream.mjs   # 监听 8788
 *
 * 同时扮演两种站点：
 *   /v1/chat/completions   通用 + DeepSeek（版本段在路径里）
 *   /chat/completions      火山方舟（版本号写在 base 里，无 /v1 段）
 * 响应里回显收到的内容，方便肉眼确认网关的转换结果。
 */

import http from 'node:http';

const PORT = 8788;

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const raw = await readBody(req);
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* 忽略 */
  }

  console.log(`\n[mock] ${req.method} ${url.pathname}`);
  console.log(JSON.stringify(body, null, 2).slice(0, 900));

  const send = (obj, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === '/v1/models' || url.pathname === '/models') {
    return send({ object: 'list', data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'ep-mock-endpoint' }] });
  }

  if (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions') {
    const isArk = url.pathname === '/chat/completions';
    const msgs = body.messages || [];
    const system = msgs.find((m) => m.role === 'system')?.content || '';
    const last = [...msgs].reverse().find((m) => m.role === 'user');
    const userText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    const toolCalls = [...msgs].reverse().find((m) => m.tool_calls)?.tool_calls;

    const echo = `[${isArk ? '方舟' : 'DeepSeek'}] 收到 ${msgs.length} 条消息｜user: ${String(userText).slice(0, 40)}${system ? `｜system: ${String(system).slice(0, 30)}` : ''}`;

    // 流式
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const id = 'chatcmpl-mock';

      // 推理模型先吐思维链，模拟 DeepSeek-R1 行为
      if (String(body.model || '').includes('reasoner')) {
        ev({ id, created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '先理一遍题意……' }, finish_reason: null }] });
      }

      if (body.tools?.length) {
        const name = body.tools[0].function?.name || 'tool';
        ev({ id, created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_mock', type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
        ev({ id, created: 1, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"echo":"' } }] }, finish_reason: null }] });
        ev({ id, created: 1, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ok"}' } }] }, finish_reason: null }] });
        ev({ id, created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        ev({ id, created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        for (const ch of echo) ev({ id, created: 1, model: body.model, choices: [{ index: 0, delta: { content: ch }, finish_reason: null }] });
        ev({ id, created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }

      ev({ id, created: 1, model: body.model, choices: [], usage: { prompt_tokens: 12, completion_tokens: echo.length, total_tokens: 12 + echo.length } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 非流式
    const message = { role: 'assistant', content: echo };
    if (String(body.model || '').includes('reasoner')) message.reasoning_content = '先理一遍题意……';
    if (body.tools?.length) {
      message.content = null;
      message.tool_calls = [
        { id: 'call_mock', type: 'function', function: { name: body.tools[0].function?.name || 'tool', arguments: '{"echo":"ok"}' } },
      ];
    }

    return send({
      id: 'chatcmpl-mock',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message, finish_reason: body.tools?.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: echo.length, total_tokens: 12 + echo.length },
    });
  }

  send({ error: { message: `mock 上游没有 ${url.pathname}`, type: 'invalid_request_error' } }, 404);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-upstream on http://127.0.0.1:${PORT}`);
  console.log('  /v1/chat/completions  通用 & DeepSeek');
  console.log('  /chat/completions     火山方舟风格（无版本段）');
});
