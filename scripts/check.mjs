/**
 * 冒烟测试：不联网，只验证协议转换的正确性。
 *   node scripts/check.mjs
 */

import { chatToInternal, anthropicToInternal, internalToResponses, internalToChat } from '../src/convert/request.js';
import { responsesToChat, responsesToAnthropic, chatToAnthropic } from '../src/convert/response.js';
import {
  responsesStreamToEvents,
  chatStreamToEvents,
  eventsToOpenAIChatStream,
  eventsToAnthropicStream,
} from '../src/convert/stream.js';

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

function section(title) {
  console.log(`\n\x1b[36m${title}\x1b[0m`);
}

// 与线上默认一致：不配置 STOP_AS_HINT / STORE_RESPONSE 等可选变量
const env = {};

/* ------------------------------------------------------------------ */
section('2. chat/completions → Responses 请求');

{
  const chatBody = {
    model: 'gpt-5',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'developer', content: '用中文回答' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '这张图里有什么' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'high' } },
        ],
      },
      {
        role: 'assistant',
        content: '我来查一下天气',
        tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"吉安"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_abc', content: '{"temp":28}' },
    ],
    temperature: 0.7,
    max_tokens: 2048,
    stream: false,
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '查天气',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    ],
    tool_choice: 'auto',
    response_format: { type: 'json_object' },
    user: 'u-1',
    parallel_tool_calls: true,
  };

  const { internal, warnings } = chatToInternal(chatBody);
  const payload = internalToResponses(internal, env);

  check('system + developer 合并进 instructions', payload.instructions === '你是助手\n\n用中文回答', payload.instructions);
  check('input 长度正确（user / assistant / function_call / function_call_output）', payload.input.length === 4, payload.input.length);
  check('图片片段转成 input_image', payload.input[0].content[1].type === 'input_image' && payload.input[0].content[1].detail === 'high');
  check('assistant 文本用 output_text', payload.input[1].content[0].type === 'output_text');
  check('tool_calls 拆成 function_call item', payload.input[2].type === 'function_call' && payload.input[2].call_id === 'call_abc');
  check('function_call.arguments 保持字符串', typeof payload.input[2].arguments === 'string');
  check('tool 消息转成 function_call_output', payload.input[3].type === 'function_call_output' && payload.input[3].output === '{"temp":28}');
  check('tools 扁平化（无 function 包装）', payload.tools[0].type === 'function' && payload.tools[0].name === 'get_weather' && payload.tools[0].function === undefined);
  check('max_tokens → max_output_tokens', payload.max_output_tokens === 2048 && payload.max_tokens === undefined);
  check('response_format → text.format', payload.text?.format?.type === 'json_object');
  check('temperature / top_p / user / parallel_tool_calls 透传', payload.temperature === 0.7 && payload.user === 'u-1' && payload.parallel_tool_calls === true);
  check('默认 store=false', payload.store === false);
  check('受支持的字段不产生告警', warnings.length === 0, warnings);
}

{
  // 单轮纯文本应压缩成 input 字符串
  const { internal } = chatToInternal({ model: 'gpt-5', messages: [{ role: 'user', content: '你好' }] });
  const payload = internalToResponses(internal, env);
  check('单轮纯文本压缩为 input 字符串', typeof payload.input === 'string' && payload.input === '你好');
}

{
  // 不支持的字段应被记录
  const { warnings } = chatToInternal({ model: 'gpt-5', messages: [{ role: 'user', content: 'x' }], seed: 1, logprobs: true });
  check('新协议不支持的字段产生告警', warnings.some((w) => w.includes('seed')));
}

/* ------------------------------------------------------------------ */
section('3. Anthropic Messages → Responses 请求');

{
  const anthropicBody = {
    model: 'gpt-5',
    max_tokens: 1024,
    system: [{ type: 'text', text: '你是助手' }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAABBBB' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '调用工具' },
          { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'cloudflare' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '结果A' }] },
    ],
    tools: [{ name: 'search', description: '搜索', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'search' },
    stop_sequences: ['\n\nHuman:'],
    temperature: 0.5,
  };

  const { internal } = anthropicToInternal(anthropicBody);
  const payload = internalToResponses(internal, env);

  check('system blocks → instructions', payload.instructions.startsWith('你是助手'), payload.instructions);
  check('base64 图片 → data URI', payload.input[0].content[1].image_url === 'data:image/jpeg;base64,AAAABBBB');
  check('assistant 文本优先落 message', payload.input[1].type === 'message' && payload.input[1].role === 'assistant');
  check('tool_use → function_call 且 input 被 stringify', payload.input[2].type === 'function_call' && payload.input[2].arguments === '{"q":"cloudflare"}');
  check('tool_result → function_call_output', payload.input[3].type === 'function_call_output' && payload.input[3].call_id === 'toolu_1');
  check('input_schema → parameters', payload.tools[0].parameters.properties.q.type === 'string');
  check('tool_choice{tool} → {type:function,name}', payload.tool_choice.type === 'function' && payload.tool_choice.name === 'search');
  check('stop_sequences 作为软提示进入 instructions', payload.instructions.includes('Stop generating'), payload.instructions);
  check('max_tokens → max_output_tokens', payload.max_output_tokens === 1024);
}

/* ------------------------------------------------------------------ */
section('4. Responses 响应 → chat / Anthropic');

const sampleResponse = {
  id: 'resp_abc123',
  object: 'response',
  created_at: 1756000000,
  status: 'completed',
  model: 'gpt-5',
  output: [
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '先确认城市' }] },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '吉安今天 28 度', annotations: [] }],
    },
  ],
  usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 8 } },
};

{
  const chat = responsesToChat(sampleResponse, 'gpt-5');
  check('object 为 chat.completion', chat.object === 'chat.completion');
  check('文本内容正确', chat.choices[0].message.content === '吉安今天 28 度');
  check('finish_reason = stop', chat.choices[0].finish_reason === 'stop');
  check('reasoning 落到 reasoning_content', chat.choices[0].message.reasoning_content === '先确认城市');
  check('usage 字段映射', chat.usage.prompt_tokens === 120 && chat.usage.completion_tokens === 30 && chat.usage.total_tokens === 150);
  check('usage details 映射', chat.usage.prompt_tokens_details.cached_tokens === 20 && chat.usage.completion_tokens_details.reasoning_tokens === 8);
}

{
  const withTools = {
    ...sampleResponse,
    output: [
      { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '查一下', annotations: [] }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_x', name: 'get_weather', arguments: '{"city":"吉安"}', status: 'completed' },
    ],
  };
  const chat = responsesToChat(withTools, 'gpt-5');
  check('function_call → tool_calls', chat.choices[0].message.tool_calls?.[0]?.function?.name === 'get_weather');
  check('tool_call id 用 call_id', chat.choices[0].message.tool_calls?.[0]?.id === 'call_x');
  check('有工具调用时 finish_reason = tool_calls', chat.choices[0].finish_reason === 'tool_calls');

  const anth = responsesToAnthropic(withTools, 'gpt-5');
  check('Anthropic: text + tool_use 两个 content block', anth.content.length === 2 && anth.content[1].type === 'tool_use');
  check('Anthropic: tool_use.input 已反序列化', anth.content[1].input.city === '吉安');
  check('Anthropic: stop_reason = tool_use', anth.stop_reason === 'tool_use');
  check('Anthropic: usage 结构正确', anth.usage.input_tokens === 120 && anth.usage.output_tokens === 30);
}

{
  const truncated = { ...sampleResponse, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  check('incomplete/max_output_tokens → length', responsesToChat(truncated, 'gpt-5').choices[0].finish_reason === 'length');
}

{
  const chatResp = {
    id: 'chatcmpl-9',
    created: 1756000000,
    model: 'gpt-5',
    choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  };
  const anth = chatToAnthropic(chatResp, 'gpt-5');
  check('chat 响应 → Anthropic 文本块', anth.content[0].type === 'text' && anth.content[0].text === '你好');
  check('chat 响应 → Anthropic stop_reason', anth.stop_reason === 'end_turn');
  check('chat 响应 → Anthropic usage', anth.usage.input_tokens === 5 && anth.usage.output_tokens === 7);
}

/* ------------------------------------------------------------------ */
section('5. internal → chat 回程（上游仅支持旧协议）');

{
  const original = {
    model: 'gpt-5',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '天气' },
      {
        role: 'assistant',
        content: '查一下',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"吉安"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '28度' },
    ],
    response_format: { type: 'json_object' },
  };
  const { internal } = chatToInternal(original);
  const back = internalToChat(internal, env);

  check('回程 system 消息还原', back.messages[0].role === 'system' && back.messages[0].content === '你是助手');
  check('回程 assistant + tool_calls 合并为一条', back.messages[2].role === 'assistant' && back.messages[2].tool_calls[0].function.name === 'get_weather');
  check('回程 tool 消息还原', back.messages[3].role === 'tool' && back.messages[3].tool_call_id === 'call_1');
  check('回程 response_format 还原', back.response_format.type === 'json_object');
}

/* ------------------------------------------------------------------ */
section('6. 流式：Responses SSE → chat.completion.chunk');

function makeStream(lines) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
}

const responsesSSE = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5","created_at":1756000000,"status":"in_progress","output":[]}}\n\n',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[]}}\n\n',
  'event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"你好"}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"，世界"}\n\n',
  'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"你好，世界","annotations":[]}]}}\n\n',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_time","arguments":"","status":"in_progress"}}\n\n',
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_1","delta":"{\\"tz\\":"}\n\n',
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_1","delta":"\\"UTC\\"}"}\n\n',
  'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_time","arguments":"{\\"tz\\":\\"UTC\\"}","status":"completed"}}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":20,"total_tokens":30}}}\n\n',
];

async function drain(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

{
  const events = responsesStreamToEvents(makeStream(responsesSSE));
  const stream = eventsToOpenAIChatStream(events, { id: 'chatcmpl-test', created: 1756000000, model: 'gpt-5', includeUsage: true });
  const raw = await drain(stream);
  const chunks = raw
    .split('\n\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => b.replace(/^data: /, ''))
    .filter((d) => d !== '[DONE]')
    .map((d) => JSON.parse(d));

  check('输出以 [DONE] 结束', raw.trimEnd().endsWith('data: [DONE]'));
  check('首帧带 role=assistant', chunks[0].choices[0].delta.role === 'assistant');
  check('文本增量正确', chunks.filter((c) => c.choices[0]?.delta?.content).map((c) => c.choices[0].delta.content).join('') === '你好，世界');
  const toolStart = chunks.find((c) => c.choices[0]?.delta?.tool_calls?.[0]?.function?.name);
  check('工具调用起始帧带 name', toolStart?.choices[0].delta.tool_calls[0].function.name === 'get_time');
  check('工具调用 index 从 0 开始', toolStart?.choices[0].delta.tool_calls[0].index === 0);
  const argsJoined = chunks
    .filter((c) => c.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments)
    .map((c) => c.choices[0].delta.tool_calls[0].function.arguments)
    .join('');
  check('工具参数增量拼回合法 JSON', argsJoined === '{"tz":"UTC"}' && JSON.parse(argsJoined).tz === 'UTC');
  const finishChunk = chunks.find((c) => c.choices[0]?.finish_reason);
  check('结束帧 finish_reason = tool_calls', finishChunk?.choices[0].finish_reason === 'tool_calls');
  const usageChunk = chunks.find((c) => c.usage);
  check('usage 帧存在且 choices 为空', !!usageChunk && usageChunk.choices.length === 0 && usageChunk.usage.total_tokens === 30);
}

/* ------------------------------------------------------------------ */
section('7. 流式：Responses SSE → Anthropic 事件流');

{
  const events = responsesStreamToEvents(makeStream(responsesSSE));
  const stream = eventsToAnthropicStream(events, { id: 'msg_test', model: 'gpt-5', includeUsage: true });
  const raw = await drain(stream);
  const payloads = raw
    .split('\n\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => {
      const dataLine = b.split('\n').find((l) => l.startsWith('data: '));
      return dataLine ? JSON.parse(dataLine.slice(6)) : null;
    })
    .filter(Boolean);

  const types = payloads.map((p) => p.type);
  check('首个事件是 message_start', types[0] === 'message_start');
  check('包含 ping', types.includes('ping'));
  check('文本块 start/delta/stop 顺序正确', types.indexOf('content_block_start') < types.indexOf('content_block_delta') && types.indexOf('content_block_delta') < types.indexOf('content_block_stop'));
  const textDeltas = payloads.filter((p) => p.type === 'content_block_delta' && p.delta.type === 'text_delta');
  check('文本增量拼接正确', textDeltas.map((p) => p.delta.text).join('') === '你好，世界');

  const toolStarts = payloads.filter((p) => p.type === 'content_block_start' && p.content_block.type === 'tool_use');
  check('存在一个 tool_use 块', toolStarts.length === 1 && toolStarts[0].content_block.name === 'get_time');
  const jsonDelta = payloads.filter((p) => p.type === 'content_block_delta' && p.delta.type === 'input_json_delta');
  check('input_json_delta 可拼成合法 JSON', JSON.parse(jsonDelta.map((p) => p.delta.partial_json).join('')).tz === 'UTC');
  check('文本块 index=0，工具块 index=1', toolStarts[0].index === 1 && jsonDelta.every((p) => p.index === 1));

  const msgDelta = payloads.find((p) => p.type === 'message_delta');
  check('message_delta stop_reason = tool_use', msgDelta?.delta.stop_reason === 'tool_use');
  check('message_delta 带 output_tokens', msgDelta?.usage.output_tokens === 20);
  check('以 message_stop 结束（不发 [DONE]）', types[types.length - 1] === 'message_stop' && !raw.includes('[DONE]'));
}

/* ------------------------------------------------------------------ */
section('8. 流式：上游 chat 流 → IR → chat chunk');

{
  const chatSSE = [
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5","choices":[{"index":0,"delta":{"content":"呀"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"f","arguments":""}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n',
    'data: [DONE]\n\n',
  ];
  const events = chatStreamToEvents(makeStream(chatSSE));
  const stream = eventsToOpenAIChatStream(events, { id: 'chatcmpl-out', created: 1, model: 'gpt-5', includeUsage: true });
  const raw = await drain(stream);
  const chunks = raw
    .split('\n\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => b.replace(/^data: /, ''))
    .filter((d) => d !== '[DONE]')
    .map((d) => JSON.parse(d));

  const text = chunks.filter((c) => c.choices[0]?.delta?.content).map((c) => c.choices[0].delta.content).join('');
  check('chat 上游文本透传', text === '你好呀', text);
  const tc = chunks.find((c) => c.choices[0]?.delta?.tool_calls?.[0]?.function?.name);
  check('chat 上游工具名透传', tc?.choices[0].delta.tool_calls[0].function.name === 'f');
  check('chat 上游 finish_reason 透传', chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason === 'tool_calls');
  const u = chunks.find((c) => c.usage);
  check('chat 上游 usage 回传', u?.usage.total_tokens === 7);
}

/* ------------------------------------------------------------------ */
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
