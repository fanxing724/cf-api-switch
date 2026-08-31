/**
 * openai-protocol-bridge
 *
 * Cloudflare Worker：把旧的长青协议「翻译」成 OpenAI 新 Responses 协议。
 *
 *   入站                       出站（可路由到多个上游）
 *   POST /v1/chat/completions  ->  POST {upstream}/responses
 *   POST /v1/messages          ->  POST {upstream}/responses
 *   POST /v1/responses         ->  POST {upstream}/responses （原生透传）
 *
 * 上游若只支持旧协议（route.protocol = "chat"），会自动改打 /chat/completions。
 */

import { mapModel, resolveUpstream, authorizeClient, boolEnv, intEnv } from './config.js';
import { chatToInternal, anthropicToInternal, internalToResponses, internalToChat } from './convert/request.js';
import { responsesToChat, responsesToAnthropic, chatToChat, chatToAnthropic } from './convert/response.js';
import {
  responsesStreamToEvents,
  chatStreamToEvents,
  eventsToOpenAIChatStream,
  eventsToAnthropicStream,
  anthropicMessageId,
} from './convert/stream.js';
import { corsHeaders, jsonResponse, errorResponse, sseHeaders, randomId, estimateTokens, extractClientKey, safeJson } from './util.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- CORS 预检 -----------------------------------------------------
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, request.headers.get('origin')) });
    }

    const baseHeaders = corsHeaders(env, request.headers.get('origin'));

    // ---- 健康检查 -----------------------------------------------------
    if (path === '/' || path === '/healthz' || path === '/health') {
      return jsonResponse(
        {
          ok: true,
          service: 'openai-protocol-bridge',
          version: '1.0.0',
          endpoints: {
            'POST /v1/chat/completions': 'OpenAI 兼容旧协议入口 -> 新 Responses 协议',
            'POST /v1/messages': 'Anthropic Messages 入口 -> 新 Responses 协议',
            'POST /v1/responses': '新协议原生入口（透传 / 按上游降级）',
            'POST /v1/messages/count_tokens': 'Anthropic token 计数（估算）',
            'GET /v1/models': '模型列表透传',
          },
        },
        200,
        baseHeaders,
      );
    }

    // ---- 鉴权 ---------------------------------------------------------
    const auth = authorizeClient(env, request);
    if (!auth.ok) return errorResponse(auth.message, auth.status, 'invalid_request_error', baseHeaders);

    if (request.method !== 'POST' && request.method !== 'GET') {
      return errorResponse('Method not allowed', 405, 'invalid_request_error', baseHeaders);
    }

    try {
      if (path === '/v1/models' && request.method === 'GET') return handleModels(request, env, baseHeaders);
      if (path === '/v1/messages/count_tokens' && request.method === 'POST') return handleCountTokens(request, env, baseHeaders);
      if (path === '/v1/chat/completions') return handleChat(request, env, baseHeaders);
      if (path === '/v1/messages') return handleAnthropic(request, env, baseHeaders);
      if (path === '/v1/responses') return handleResponses(request, env, baseHeaders);
      if (path === '/v1/completions') {
        return errorResponse('/v1/completions（文本补全）已被 OpenAI 废弃，请改用 /v1/chat/completions 或 /v1/messages 入口。', 400, 'invalid_request_error', baseHeaders);
      }
      return errorResponse(`未知路由: ${path}`, 404, 'invalid_request_error', baseHeaders);
    } catch (err) {
      return errorResponse(`网关内部错误: ${err?.message || err}`, 500, 'bridge_error', baseHeaders);
    }
  },
};

/* ------------------------------------------------------------------ */
/* 通用：请求上游                                                       */
/* ------------------------------------------------------------------ */

async function callUpstream(env, upstream, endpoint, payload, extraWarnings = []) {
  const target = `${upstream.base}/${endpoint}`;
  const timeout = intEnv(env?.UPSTREAM_TIMEOUT_MS, 600000);

  const headers = new Headers({ 'content-type': 'application/json' });
  if (upstream.key) headers.set('authorization', `Bearer ${upstream.key}`);
  if (upstream.headers) {
    for (const [k, v] of Object.entries(upstream.headers)) headers.set(k, v);
  }

  const res = await fetch(target, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeout) : undefined,
  });

  const metaHeaders = {
    'X-Upstream-Base': upstream.base,
    'X-Upstream-Protocol': upstream.protocol,
    'X-Upstream-Model': String(payload.model ?? ''),
  };
  if (extraWarnings.length) {
    metaHeaders['X-Bridge-Warnings'] = encodeURIComponent(extraWarnings.join(' | '));
  }

  return { res, metaHeaders, target };
}

/** 上游报错时，按目标协议封装错误体 */
async function relayUpstreamError(res, target) {
  const text = await res.text().catch(() => '');
  const parsed = safeJson(text, null);
  const message =
    parsed?.error?.message || parsed?.message || text?.slice(0, 2000) || `上游返回 ${res.status}`;
  return { status: res.status, message: `上游 ${res.status} · ${message}`, type: parsed?.error?.type || 'upstream_error', target };
}

function protocolError(message, status, type, extraHeaders, target = 'openai') {
  if (target === 'anthropic') {
    return jsonResponse(
      { type: 'error', error: { type: type === 'invalid_api_key' ? 'authentication_error' : 'api_error', message } },
      status,
      extraHeaders,
    );
  }
  return errorResponse(message, status, type, extraHeaders);
}

/* ------------------------------------------------------------------ */
/* 入口 1：/v1/chat/completions                                         */
/* ------------------------------------------------------------------ */

async function handleChat(request, env, baseHeaders) {
  const body = await readJsonBody(request);
  if (!body) return errorResponse('请求体必须是合法 JSON', 400, 'invalid_request_error', baseHeaders);
  if (!Array.isArray(body.messages)) {
    return errorResponse('缺少 messages 字段', 400, 'invalid_request_error', baseHeaders);
  }

  const clientModel = body.model || 'gpt-5';
  const model = mapModel(env, clientModel);
  const upstream = resolveUpstream(env, model);
  const warnings = [];

  // 上游只支持旧协议：直接透传，避免无谓的来回转换损失字段
  const payload =
    upstream.protocol === 'chat'
      ? { ...body, model }
      : (() => {
          const { internal, warnings: w } = chatToInternal({ ...body, model });
          warnings.push(...w);
          return internalToResponses(internal, env);
        })();

  const stream = !!body.stream;
  const { res, metaHeaders } = await callUpstream(
    env,
    upstream,
    upstream.protocol === 'chat' ? 'chat/completions' : 'responses',
    payload,
    warnings,
  );

  const headers = { ...baseHeaders, ...metaHeaders };
  if (!res.ok) {
    const err = await relayUpstreamError(res);
    return protocolError(err.message, err.status, err.type, headers);
  }

  if (stream) {
    const id = randomId('chatcmpl');
    const includeUsage = boolEnv(env?.ALWAYS_INCLUDE_USAGE, true) || body.stream_options?.include_usage === true;
    const events = upstream.protocol === 'chat' ? chatStreamToEvents(res.body) : responsesStreamToEvents(res.body);
    const out = eventsToOpenAIChatStream(events, {
      id,
      created: Math.floor(Date.now() / 1000),
      model: clientModel,
      includeUsage,
    });
    return new Response(out, { status: 200, headers: sseHeaders(headers) });
  }

  const json = await res.json().catch(() => null);
  if (!json) return errorResponse('上游返回了无法解析的响应', 502, 'upstream_error', headers);

  const converted = upstream.protocol === 'chat' ? chatToChat(json, clientModel) : responsesToChat(json, clientModel);
  if (converted.error) {
    return errorResponse(converted.error.message || '上游返回错误', 502, converted.error.type || 'upstream_error', headers);
  }
  return jsonResponse(converted, 200, headers);
}

/* ------------------------------------------------------------------ */
/* 入口 2：/v1/messages（Anthropic）                                    */
/* ------------------------------------------------------------------ */

async function handleAnthropic(request, env, baseHeaders) {
  const body = await readJsonBody(request);
  if (!body) return protocolError('请求体必须是合法 JSON', 400, 'invalid_request_error', baseHeaders, 'anthropic');
  if (!Array.isArray(body.messages)) {
    return protocolError('缺少 messages 字段', 400, 'invalid_request_error', baseHeaders, 'anthropic');
  }

  const clientModel = body.model || 'gpt-5';
  const model = mapModel(env, clientModel);
  const upstream = resolveUpstream(env, model);

  const { internal, warnings } = anthropicToInternal({ ...body, model });
  if (internal.maxOutputTokens === undefined) internal.maxOutputTokens = 4096;

  const payload = upstream.protocol === 'chat' ? internalToChat(internal, env) : internalToResponses(internal, env);

  const stream = !!body.stream;
  const { res, metaHeaders } = await callUpstream(
    env,
    upstream,
    upstream.protocol === 'chat' ? 'chat/completions' : 'responses',
    payload,
    warnings,
  );

  const headers = { ...baseHeaders, ...metaHeaders };
  if (!res.ok) {
    const err = await relayUpstreamError(res);
    return protocolError(err.message, err.status, err.type, headers, 'anthropic');
  }

  if (stream) {
    const id = anthropicMessageId();
    const events = upstream.protocol === 'chat' ? chatStreamToEvents(res.body) : responsesStreamToEvents(res.body);
    const out = eventsToAnthropicStream(events, { id, model: clientModel, includeUsage: true });
    return new Response(out, { status: 200, headers: sseHeaders(headers) });
  }

  const json = await res.json().catch(() => null);
  if (!json) return protocolError('上游返回了无法解析的响应', 502, 'upstream_error', headers, 'anthropic');

  const converted = upstream.protocol === 'chat' ? chatToAnthropic(json, clientModel) : responsesToAnthropic(json, clientModel);
  if (converted.error) {
    return protocolError(converted.error.message || '上游返回错误', 502, converted.error.type || 'upstream_error', headers, 'anthropic');
  }
  return jsonResponse(converted, 200, headers);
}

/* ------------------------------------------------------------------ */
/* 入口 3：/v1/responses（新协议原生入口）                              */
/* ------------------------------------------------------------------ */

async function handleResponses(request, env, baseHeaders) {
  const body = await readJsonBody(request);
  if (!body) return errorResponse('请求体必须是合法 JSON', 400, 'invalid_request_error', baseHeaders);

  const model = mapModel(env, body.model || 'gpt-5');
  const upstream = resolveUpstream(env, model);

  // 上游不支持新协议时，降级为 chat/completions
  let payload = { ...body, model };
  let endpoint = 'responses';
  if (upstream.protocol === 'chat') {
    const { internal } = chatToInternal(responsesBodyToChatShape(body, model));
    payload = internalToChat(internal, env);
    endpoint = 'chat/completions';
  }

  const { res, metaHeaders } = await callUpstream(env, upstream, endpoint, payload, []);
  const headers = { ...baseHeaders, ...metaHeaders };

  if (!res.ok) {
    const err = await relayUpstreamError(res);
    return errorResponse(err.message, err.status, err.type, headers);
  }

  // 降级场景下把 chat 响应还原成 Responses 形状，保证客户端拿到一致结构
  if (upstream.protocol === 'chat') {
    if (body.stream) {
      const events = chatStreamToEvents(res.body);
      // 客户端要的是 Responses 事件流，这里直接把上游 chat 流转成 responses 事件
      const out = chatEventsToResponsesStream(events, model);
      return new Response(out, { status: 200, headers: sseHeaders(headers) });
    }
    const json = await res.json().catch(() => null);
    if (!json) return errorResponse('上游返回了无法解析的响应', 502, 'upstream_error', headers);
    return jsonResponse(chatObjectToResponses(json, model), 200, headers);
  }

  if (body.stream) {
    return new Response(res.body, { status: 200, headers: sseHeaders(headers) });
  }
  const json = await res.json().catch(() => null);
  return jsonResponse(json ?? {}, 200, headers);
}

/** Responses 请求体 -> chat 请求体形状（降级路径复用 chatToInternal） */
function responsesBodyToChatShape(body, model) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });

  const items = Array.isArray(body.input) ? body.input : typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }] : [];

  let pendingAssistant = null;
  const flush = () => {
    if (pendingAssistant) {
      const m = { role: 'assistant', content: pendingAssistant.text || null };
      if (pendingAssistant.toolCalls.length) m.tool_calls = pendingAssistant.toolCalls;
      messages.push(m);
      pendingAssistant = null;
    }
  };

  for (const item of items) {
    if (item?.type === 'message' && item.role === 'user') {
      flush();
      const parts = (Array.isArray(item.content) ? item.content : [{ type: 'input_text', text: String(item.content) }])
        .map((c) => (c?.type === 'input_image' ? { type: 'image_url', image_url: { url: c.image_url } } : { type: 'text', text: c?.text ?? '' }));
      messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
    } else if (item?.type === 'message' && item.role === 'assistant') {
      flush();
      pendingAssistant = {
        text: (item.content || []).map((c) => c?.text ?? '').join(''),
        toolCalls: [],
      };
    } else if (item?.type === 'function_call') {
      if (!pendingAssistant) pendingAssistant = { text: '', toolCalls: [] };
      pendingAssistant.toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '' } });
    } else if (item?.type === 'function_call_output') {
      flush();
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output ?? '' });
    }
  }
  flush();

  const out = { model, messages, stream: !!body.stream };
  if (body.max_output_tokens) out.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((t) =>
      t?.type === 'function'
        ? { type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? {} } }
        : t,
    );
  }
  if (body.tool_choice !== undefined) {
    out.tool_choice =
      typeof body.tool_choice === 'string' ? body.tool_choice : { type: 'function', function: { name: body.tool_choice.name } };
  }
  if (body.text?.format?.type === 'json_object') out.response_format = { type: 'json_object' };
  return out;
}

/** chat.completion 对象 -> Responses 对象 */
function chatObjectToResponses(resp, model) {
  const msg = resp.choices?.[0]?.message ?? {};
  const output = [];
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    for (const call of msg.tool_calls) {
      output.push({
        type: 'function_call',
        id: `fc_${call.id}`,
        call_id: call.id,
        name: call.function?.name ?? '',
        arguments: call.function?.arguments ?? '',
        status: 'completed',
      });
    }
  }
  const text = typeof msg.content === 'string' ? msg.content : '';
  if (text) {
    output.push({
      type: 'message',
      id: randomId('msg'),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  return {
    id: resp.id || randomId('resp'),
    object: 'response',
    created_at: resp.created ?? Math.floor(Date.now() / 1000),
    status: 'completed',
    model: resp.model || model,
    output,
    output_text: text,
    usage: resp.usage
      ? {
          input_tokens: resp.usage.prompt_tokens ?? 0,
          output_tokens: resp.usage.completion_tokens ?? 0,
          total_tokens: resp.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

/** chat 事件流 -> Responses 事件流（降级路径） */
function chatEventsToResponsesStream(events, model) {
  const encoder = new TextEncoder();
  const id = randomId('resp');
  const created = Math.floor(Date.now() / 1000);

  return new ReadableStream({
    async start(controller) {
      const emit = (type, payload) =>
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`));

      try {
        let outputIndex = 0;
        let textItemId = null;
        let textStarted = false;
        const toolItems = new Map();

        emit('response.created', { response: { id, object: 'response', created_at: created, status: 'in_progress', model, output: [] } });

        for await (const ev of events) {
          if (ev.t === 'text_delta') {
            if (!textStarted) {
              textItemId = randomId('msg');
              emit('response.output_item.added', {
                output_index: outputIndex,
                item: { type: 'message', id: textItemId, role: 'assistant', status: 'in_progress', content: [] },
              });
              emit('response.content_part.added', { output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
              textStarted = true;
            }
            emit('response.output_text.delta', { output_index: outputIndex, content_index: 0, delta: ev.text });
          } else if (ev.t === 'tool_start') {
            if (textStarted) {
              emit('response.content_part.done', { output_index, content_index: 0, part: { type: 'output_text', text: '' } });
              emit('response.output_item.done', { output_index, item: { type: 'message', id: textItemId, role: 'assistant', status: 'completed', content: [] } });
              outputIndex += 1;
              textStarted = false;
            }
            const itemId = randomId('fc');
            toolItems.set(ev.idx, { itemId, outputIndex, name: ev.name, callId: ev.id });
            emit('response.output_item.added', {
              output_index: outputIndex,
              item: { type: 'function_call', id: itemId, call_id: ev.id, name: ev.name, arguments: '', status: 'in_progress' },
            });
          } else if (ev.t === 'tool_delta') {
            const t = toolItems.get(ev.idx);
            if (t) emit('response.function_call_arguments.delta', { output_index: t.outputIndex, item_id: t.itemId, delta: ev.args });
          } else if (ev.t === 'tool_end') {
            const t = toolItems.get(ev.idx);
            if (t) {
              emit('response.output_item.done', {
                output_index: t.outputIndex,
                item: { type: 'function_call', id: t.itemId, call_id: t.callId, name: t.name, arguments: '', status: 'completed' },
              });
              outputIndex += 1;
            }
          } else if (ev.t === 'finish') {
            if (textStarted) {
              emit('response.content_part.done', { output_index, content_index: 0, part: { type: 'output_text', text: '' } });
              emit('response.output_item.done', { output_index, item: { type: 'message', id: textItemId, role: 'assistant', status: 'completed', content: [] } });
            }
            emit('response.completed', {
              response: {
                id,
                object: 'response',
                created_at: created,
                status: 'completed',
                model,
                output: [],
                usage: ev.usage
                  ? {
                      input_tokens: ev.usage.prompt_tokens ?? 0,
                      output_tokens: ev.usage.completion_tokens ?? 0,
                      total_tokens: ev.usage.total_tokens ?? 0,
                    }
                  : undefined,
              },
            });
          } else if (ev.t === 'error') {
            emit('error', { message: ev.message, code: ev.type });
          }
        }
      } catch (err) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: 'error', message: String(err?.message || err) })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* 辅助路由                                                             */
/* ------------------------------------------------------------------ */

async function handleModels(request, env, baseHeaders) {
  const upstream = resolveUpstream(env, 'gpt-5');
  const clientKey = extractClientKey(request);
  const headers = new Headers({ 'content-type': 'application/json' });
  const key = upstream.key || env?.UPSTREAM_KEY || clientKey;
  if (key) headers.set('authorization', `Bearer ${key}`);

  try {
    const res = await fetch(`${upstream.base}/models`, { headers });
    if (!res.ok) {
      const err = await relayUpstreamError(res);
      return errorResponse(err.message, err.status, err.type, { ...baseHeaders, 'X-Upstream-Base': upstream.base });
    }
    const json = await res.json();
    return jsonResponse(json, 200, { ...baseHeaders, 'X-Upstream-Base': upstream.base });
  } catch (err) {
    return errorResponse(`拉取模型列表失败: ${err?.message || err}`, 502, 'upstream_error', baseHeaders);
  }
}

async function handleCountTokens(request, env, baseHeaders) {
  const body = await readJsonBody(request);
  if (!body) return protocolError('请求体必须是合法 JSON', 400, 'invalid_request_error', baseHeaders, 'anthropic');

  const { internal } = anthropicToInternal(body);
  let text = internal.instructions || '';
  for (const item of internal.input || []) {
    if (item.type === 'message') {
      for (const c of item.content || []) if (c?.text) text += c.text;
    } else if (item.type === 'function_call') text += `${item.name}${item.arguments ?? ''}`;
    else if (item.type === 'function_call_output') text += item.output ?? '';
  }
  for (const t of internal.tools || []) text += `${t.name}${t.description ?? ''}${JSON.stringify(t.parameters ?? {})}`;

  return jsonResponse({ input_tokens: estimateTokens(text) }, 200, baseHeaders);
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
