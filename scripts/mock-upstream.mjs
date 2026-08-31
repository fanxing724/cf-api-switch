/**
 * 本地 mock 上游，用于 wrangler dev 联调。
 *   node scripts/mock-upstream.mjs   # 监听 8788
 *
 * 它把收到的请求体回显到响应文本里，方便肉眼确认转换结果。
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

  console.log(`\n[mock-upstream] ${req.method} ${url.pathname}`);
  console.log(JSON.stringify(body, null, 2).slice(0, 1200));

  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }, { id: 'gpt-5-mini', object: 'model' }] }));
    return;
  }

  if (url.pathname === '/v1/responses') {
    // 回显转换结果，肉眼可验证
    const echo =
      typeof body.input === 'string'
        ? `收到 input 字符串: ${body.input}`
        : `收到 ${body.input?.length ?? 0} 个 input item`;
    const instructions = body.instructions ? `｜instructions: ${body.instructions.slice(0, 60)}` : '';
    const tools = body.tools?.length ? `｜tools: ${body.tools.map((t) => t.name).join(',')}` : '';
    const text = `[mock] ${echo}${instructions}${tools}`;

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);

      send('response.created', { response: { id: 'resp_mock', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: body.model, output: [] } });

      if (body.tools?.length && body.tool_choice !== 'none') {
        // 演示工具调用分支
        send('response.output_item.added', {
          output_index: 0,
          item: { type: 'function_call', id: 'fc_mock', call_id: 'call_mock', name: body.tools[0].name, arguments: '', status: 'in_progress' },
        });
        send('response.function_call_arguments.delta', { output_index: 0, item_id: 'fc_mock', delta: '{"echo":"' });
        send('response.function_call_arguments.delta', { output_index: 0, item_id: 'fc_mock', delta: text.replace(/"/g, '') + '"}' });
        send('response.output_item.done', {
          output_index: 0,
          item: { type: 'function_call', id: 'fc_mock', call_id: 'call_mock', name: body.tools[0].name, arguments: '{"echo":"ok"}', status: 'completed' },
        });
      } else {
        send('response.output_item.added', {
          output_index: 0,
          item: { type: 'message', id: 'msg_mock', role: 'assistant', status: 'in_progress', content: [] },
        });
        for (const ch of text) {
          send('response.output_text.delta', { output_index: 0, content_index: 0, delta: ch });
        }
        send('response.output_item.done', {
          output_index: 0,
          item: { type: 'message', id: 'msg_mock', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
        });
      }

      send('response.completed', {
        response: {
          id: 'resp_mock',
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          status: 'completed',
          model: body.model,
          output: [],
          usage: { input_tokens: 42, output_tokens: text.length, total_tokens: 42 + text.length },
        },
      });
      res.end();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    const output = body.tools?.length && body.tool_choice !== 'none'
      ? [{ type: 'function_call', id: 'fc_mock', call_id: 'call_mock', name: body.tools[0].name, arguments: '{"echo":"ok"}', status: 'completed' }]
      : [{ type: 'message', id: 'msg_mock', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }];

    res.end(
      JSON.stringify({
        id: 'resp_mock',
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        model: body.model,
        output,
        output_text: text,
        usage: { input_tokens: 42, output_tokens: text.length, total_tokens: 42 + text.length, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      }),
    );
    return;
  }

  if (url.pathname === '/v1/chat/completions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `[legacy-mock] 收到 ${body.messages?.length ?? 0} 条消息` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 },
      }),
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `mock 上游没有 ${url.pathname}`, type: 'invalid_request_error' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-upstream listening on http://127.0.0.1:${PORT}`);
});
