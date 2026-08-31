/**
 * 流式转换
 *
 * 统一中间事件（IR）：
 *   { t:'start',            id, model, created }
 *   { t:'text_delta',       text }
 *   { t:'reasoning_delta',  text }
 *   { t:'refusal_delta',    text }
 *   { t:'tool_start',       idx, id, name }
 *   { t:'tool_delta',       idx, args }
 *   { t:'tool_end',         idx }
 *   { t:'finish',           reason, usage }
 *   { t:'error',            message, type }
 *
 * 上游事件 -> IR -> 目标协议 SSE，新增协议只需再写一个渲染器。
 */

import { resolveFinishReason, sseEncode, randomId } from '../util.js';

/* ------------------------------------------------------------------ */
/* SSE 解析                                                            */
/* ------------------------------------------------------------------ */

/** 解析单个 SSE 块（可能含多行 data） */
function parseBlock(raw) {
  let event = 'message';
  const dataLines = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    if (trimmed.startsWith(':')) continue; // 注释/心跳
    if (trimmed.startsWith('event:')) event = trimmed.slice(6).trim();
    else if (trimmed.startsWith('data:')) dataLines.push(trimmed.slice(5).replace(/^ /, ''));
  }
  if (!dataLines.length) return null;
  const data = dataLines.join('\n');
  if (data === '[DONE]') return { event: 'done', data, json: null };
  let json = null;
  try {
    json = JSON.parse(data);
  } catch {
    /* 非 JSON 负载，交给上层决定 */
  }
  return { event, data, json };
}

/** 把上游 Response 的 body 解析成 SSE 事件流 */
export async function* parseSSEStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const evt = parseBlock(raw);
        if (evt) yield evt;
      }
      // 兼容只用 \r\n\r\n 分隔的实现
      if (buffer.length > 64 * 1024 && buffer.indexOf('\n\n') === -1) {
        const evt = parseBlock(buffer);
        buffer = '';
        if (evt) yield evt;
      }
    }
    if (buffer.trim()) {
      const evt = parseBlock(buffer);
      if (evt) yield evt;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 已关闭 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 上游 Responses 流 → IR                                              */
/* ------------------------------------------------------------------ */

export async function* responsesStreamToEvents(upstreamBody) {
  const itemToIdx = new Map(); // item_id -> tool 序号
  let toolCounter = 0;
  let currentToolIdx = null;
  let hasToolCalls = false;
  let lastResponse = null;

  for await (const evt of parseSSEStream(upstreamBody)) {
    if (evt.event === 'done') break;
    const payload = evt.json;
    if (!payload) continue;
    const type = payload.type || evt.event;

    switch (type) {
      case 'response.created':
      case 'response.in_progress': {
        const r = payload.response;
        if (r) {
          lastResponse = r;
          yield { t: 'start', id: r.id, model: r.model, created: r.created_at };
        }
        break;
      }

      case 'response.output_item.added': {
        const item = payload.item || payload.output_item;
        if (!item) break;
        const itemId = item.id || `${payload.output_index}`;

        if (item.type === 'function_call') {
          const idx = toolCounter++;
          itemToIdx.set(itemId, idx);
          currentToolIdx = idx;
          hasToolCalls = true;
          yield { t: 'tool_start', idx, id: item.call_id || itemId, name: item.name ?? '' };
          if (item.arguments) yield { t: 'tool_delta', idx, args: item.arguments };
        } else if (item.type === 'reasoning') {
          // 思考摘要在后续 delta 里给出
        }
        break;
      }

      case 'response.content_part.added': {
        // 文本块的开始，无需对外暴露状态
        break;
      }

      case 'response.output_text.delta': {
        if (payload.delta) yield { t: 'text_delta', text: payload.delta };
        break;
      }

      case 'response.refusal.delta': {
        if (payload.delta) yield { t: 'refusal_delta', text: payload.delta };
        break;
      }

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        if (payload.delta) yield { t: 'reasoning_delta', text: payload.delta };
        break;
      }

      case 'response.function_call_arguments.delta': {
        if (payload.delta === undefined || payload.delta === null) break;
        const idx = itemToIdx.has(payload.item_id) ? itemToIdx.get(payload.item_id) : currentToolIdx;
        if (idx === null || idx === undefined) break;
        yield { t: 'tool_delta', idx, args: payload.delta };
        break;
      }

      case 'response.output_item.done': {
        const item = payload.item || payload.output_item;
        if (!item) break;
        if (item.type === 'function_call') {
          const itemId = item.id || `${payload.output_index}`;
          const idx = itemToIdx.has(itemId) ? itemToIdx.get(itemId) : currentToolIdx;
          if (idx !== null && idx !== undefined) yield { t: 'tool_end', idx };
        }
        break;
      }

      case 'response.completed':
      case 'response.incomplete': {
        const r = payload.response;
        if (r) {
          lastResponse = r;
          yield { t: 'finish', reason: resolveFinishReason(r, hasToolCalls), usage: r.usage };
        }
        return;
      }

      case 'response.failed': {
        const r = payload.response;
        const msg = r?.error?.message || r?.status_details?.error?.message || '上游响应失败';
        yield { t: 'error', message: msg, type: r?.error?.code || 'upstream_error' };
        return;
      }

      case 'error': {
        const msg = payload.message || payload.error?.message || '上游返回错误';
        yield { t: 'error', message: msg, type: payload.code || payload.error?.code || 'upstream_error' };
        return;
      }

      default:
        // 其余事件（annotation、file_search_call 等）暂不下发
        break;
    }
  }

  if (lastResponse && lastResponse.status && lastResponse.status !== 'completed') {
    yield { t: 'finish', reason: resolveFinishReason(lastResponse, hasToolCalls), usage: lastResponse.usage };
  }
}

/* ------------------------------------------------------------------ */
/* 上游 chat 流 → IR                                                   */
/* ------------------------------------------------------------------ */

export async function* chatStreamToEvents(upstreamBody) {
  const openTools = new Set();
  let usage = null;
  let finishReason = null;

  for await (const evt of parseSSEStream(upstreamBody)) {
    if (evt.event === 'done') break;
    const chunk = evt.json;
    if (!chunk) continue;

    if (chunk.error) {
      yield { t: 'error', message: chunk.error.message || '上游返回错误', type: chunk.error.type || 'upstream_error' };
      return;
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta || {};

    if (chunk.id) yield { t: 'start', id: chunk.id, model: chunk.model, created: chunk.created };

    if (typeof delta.content === 'string' && delta.content) yield { t: 'text_delta', text: delta.content };
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      yield { t: 'reasoning_delta', text: delta.reasoning_content };
    }
    if (typeof delta.refusal === 'string' && delta.refusal) yield { t: 'refusal_delta', text: delta.refusal };

    for (const call of delta.tool_calls || []) {
      const idx = call.index ?? 0;
      if (call.id || call.function?.name) {
        if (!openTools.has(idx)) {
          openTools.add(idx);
          yield { t: 'tool_start', idx, id: call.id || '', name: call.function?.name ?? '' };
        } else if (call.function?.name) {
          yield { t: 'tool_start', idx, id: call.id || '', name: call.function?.name };
        }
      }
      if (call.function?.arguments) yield { t: 'tool_delta', idx, args: call.function.arguments };
    }

    if (chunk.usage) usage = chunk.usage;

    // 注意：当 stream_options.include_usage 打开时，usage 单独占一帧且排在
    // finish_reason 之后，因此这里不能直接结束，要继续读到流尾。
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }

  for (const idx of openTools) yield { t: 'tool_end', idx };
  yield { t: 'finish', reason: finishReason || 'stop', usage };
}

/* ------------------------------------------------------------------ */
/* IR → OpenAI chat.completion.chunk 流                                */
/* ------------------------------------------------------------------ */

export function eventsToOpenAIChatStream(events, meta) {
  const { id, created, model, includeUsage } = meta;
  const encoder = new TextEncoder();

  const build = (delta, finishReason = null, usage = undefined) => {
    const chunk = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
    if (usage !== undefined) chunk.usage = usage;
    return sseEncode(null, chunk);
  };

  return new ReadableStream({
    async start(controller) {
      let sentRole = false;
      const ensureRole = () => {
        if (sentRole) return {};
        sentRole = true;
        return { role: 'assistant' };
      };

      try {
        for await (const ev of events) {
          switch (ev.t) {
            case 'start':
              // 用一个空 delta 打开流，便于客户端尽早建连
              controller.enqueue(encoder.encode(build({ role: 'assistant', content: '' })));
              sentRole = true;
              break;

            case 'text_delta':
              controller.enqueue(encoder.encode(build({ ...ensureRole(), content: ev.text })));
              break;

            case 'reasoning_delta':
              controller.enqueue(encoder.encode(build({ ...ensureRole(), reasoning_content: ev.text })));
              break;

            case 'refusal_delta':
              controller.enqueue(encoder.encode(build({ ...ensureRole(), refusal: ev.text })));
              break;

            case 'tool_start':
              controller.enqueue(
                encoder.encode(
                  build(
                    {
                      ...ensureRole(),
                      tool_calls: [{ index: ev.idx, id: ev.id, type: 'function', function: { name: ev.name, arguments: '' } }],
                    },
                    null,
                  ),
                ),
              );
              break;

            case 'tool_delta':
              controller.enqueue(
                encoder.encode(build({ tool_calls: [{ index: ev.idx, function: { arguments: ev.args } }] })),
              );
              break;

            case 'tool_end':
              break;

            case 'finish': {
              controller.enqueue(encoder.encode(build({}, ev.reason)));
              if (includeUsage) {
                const usage = ev.usage
                  ? {
                      prompt_tokens: ev.usage.input_tokens ?? ev.usage.prompt_tokens ?? 0,
                      completion_tokens: ev.usage.output_tokens ?? ev.usage.completion_tokens ?? 0,
                      total_tokens:
                        ev.usage.total_tokens ??
                        (ev.usage.input_tokens ?? ev.usage.prompt_tokens ?? 0) + (ev.usage.output_tokens ?? ev.usage.completion_tokens ?? 0),
                    }
                  : null;
                if (usage) {
                  const chunk = { id, object: 'chat.completion.chunk', created, model, choices: [], usage };
                  controller.enqueue(encoder.encode(sseEncode(null, chunk)));
                }
              }
              break;
            }

            case 'error':
              controller.enqueue(
                encoder.encode(sseEncode(null, { error: { message: ev.message, type: ev.type || 'upstream_error' } })),
              );
              break;

            default:
              break;
          }
        }
      } catch (err) {
        controller.enqueue(encoder.encode(sseEncode(null, { error: { message: String(err?.message || err), type: 'bridge_error' } })));
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* IR → Anthropic Messages 流                                          */
/* ------------------------------------------------------------------ */

export function eventsToAnthropicStream(events, meta) {
  const { id, model, includeUsage } = meta;
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const emit = (event, data) => controller.enqueue(encoder.encode(sseEncode(event, data)));

      let blockIndex = 0;
      let textBlockOpen = false;
      const toolBlockIndex = new Map(); // IR idx -> Anthropic content block index
      let usage = null;
      let stopReason = 'end_turn';

      // 先开消息头。Responses 的 usage 只在 completed 事件里出现，
      // 所以 input_tokens 先给 0，稍后由 message_delta 补 output_tokens。
      emit('message_start', {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });
      emit('ping', { type: 'ping' });

      try {
        for await (const ev of events) {
          switch (ev.t) {
            case 'start':
              break;

            case 'reasoning_delta':
            case 'text_delta': {
              if (!textBlockOpen) {
                emit('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
                textBlockOpen = true;
              }
              emit('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: ev.text },
              });
              break;
            }

            case 'refusal_delta': {
              if (!textBlockOpen) {
                emit('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
                textBlockOpen = true;
              }
              emit('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: ev.text },
              });
              break;
            }

            case 'tool_start': {
              if (textBlockOpen) {
                emit('content_block_stop', { type: 'content_block_stop', index: blockIndex });
                textBlockOpen = false;
                blockIndex += 1;
              }
              const idx = textBlockOpen ? blockIndex : blockIndex + ev.idx;
              toolBlockIndex.set(ev.idx, idx);
              emit('content_block_start', {
                type: 'content_block_start',
                index: idx,
                content_block: { type: 'tool_use', id: ev.id, name: ev.name, input: {} },
              });
              break;
            }

            case 'tool_delta': {
              const idx = toolBlockIndex.has(ev.idx) ? toolBlockIndex.get(ev.idx) : blockIndex + ev.idx;
              emit('content_block_delta', {
                type: 'content_block_delta',
                index: idx,
                delta: { type: 'input_json_delta', partial_json: ev.args },
              });
              break;
            }

            case 'tool_end': {
              const idx = toolBlockIndex.get(ev.idx);
              if (idx !== undefined) emit('content_block_stop', { type: 'content_block_stop', index: idx });
              break;
            }

            case 'finish': {
              if (textBlockOpen) {
                emit('content_block_stop', { type: 'content_block_stop', index: blockIndex });
                textBlockOpen = false;
              }
              if (ev.reason === 'tool_calls') stopReason = 'tool_use';
              else if (ev.reason === 'length') stopReason = 'max_tokens';
              else stopReason = 'end_turn';
              if (ev.usage) usage = ev.usage;
              break;
            }

            case 'error':
              emit('error', { type: 'error', error: { type: ev.type || 'api_error', message: ev.message } });
              break;

            default:
              break;
          }
        }

        const outTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
        const inTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
        emit('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: includeUsage
            ? { input_tokens: inTokens, output_tokens: outTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
            : { output_tokens: outTokens },
        });
        emit('message_stop', { type: 'message_stop' });
      } catch (err) {
        emit('error', { type: 'error', error: { type: 'api_error', message: String(err?.message || err) } });
        emit('message_stop', { type: 'message_stop' });
      } finally {
        controller.close();
      }
    },
  });
}

/** 生成一个 Anthropic 风格的消息 id（流式场景下上游 id 到达前就要用） */
export function anthropicMessageId() {
  return `msg_${randomId('msg').replace(/^msg_/, '')}`;
}

/* ------------------------------------------------------------------ */
/* IR → Responses API 事件流                                           */
/* ------------------------------------------------------------------ */

/**
 * 把统一 IR 事件渲染成 Responses API 的 SSE 流。
 * 用于「上游 chat 协议 → 客户端新协议」的场景：客户端拿到的是标准的
 * response.created / output_text.delta / response.completed 事件序列。
 */
export function eventsToResponsesStream(events, meta) {
  const { id, model, created } = meta;
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const emit = (type, payload) =>
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`));

      let outputIndex = 0;
      let textItem = null; // { id, contentIndex }
      let reasoningItem = null;
      const tools = new Map(); // IR idx -> { itemId, outputIndex, name, callId }
      let usage = null;
      let status = 'completed';
      let incompleteReason = null;

      emit('response.created', {
        response: { id, object: 'response', created_at: created, status: 'in_progress', model, output: [], parallel_tool_calls: true, tool_choice: 'auto', tools: [] },
      });
      emit('response.in_progress', { response: { id, object: 'response', created_at: created, status: 'in_progress', model, output: [] } });

      const closeText = () => {
        if (!textItem) return;
        emit('response.content_part.done', {
          output_index: textItem.outputIndex,
          content_index: textItem.contentIndex,
          part: { type: 'output_text', text: '', annotations: [] },
        });
        emit('response.output_item.done', {
          output_index: textItem.outputIndex,
          item: { type: 'message', id: textItem.id, role: 'assistant', status: 'completed', content: [] },
        });
        textItem = null;
        outputIndex += 1;
      };

      const closeReasoning = () => {
        if (!reasoningItem) return;
        emit('response.output_item.done', {
          output_index: reasoningItem.outputIndex,
          item: { type: 'reasoning', id: reasoningItem.id, summary: [], status: 'completed' },
        });
        reasoningItem = null;
        outputIndex += 1;
      };

      try {
        for await (const ev of events) {
          switch (ev.t) {
            case 'start':
              break;

            case 'reasoning_delta': {
              if (!reasoningItem) {
                reasoningItem = { id: randomId('rs'), outputIndex };
                emit('response.output_item.added', {
                  output_index: outputIndex,
                  item: { type: 'reasoning', id: reasoningItem.id, summary: [], status: 'in_progress' },
                });
              }
              emit('response.reasoning_summary_text.delta', {
                output_index: reasoningItem.outputIndex,
                item_id: reasoningItem.id,
                summary_index: 0,
                delta: ev.text,
              });
              break;
            }

            case 'text_delta': {
              closeReasoning();
              if (!textItem) {
                textItem = { id: randomId('msg'), outputIndex, contentIndex: 0 };
                emit('response.output_item.added', {
                  output_index: outputIndex,
                  item: { type: 'message', id: textItem.id, role: 'assistant', status: 'in_progress', content: [] },
                });
                emit('response.content_part.added', {
                  output_index: outputIndex,
                  content_index: 0,
                  part: { type: 'output_text', text: '', annotations: [] },
                });
              }
              emit('response.output_text.delta', {
                output_index: textItem.outputIndex,
                content_index: textItem.contentIndex,
                item_id: textItem.id,
                delta: ev.text,
              });
              break;
            }

            case 'refusal_delta': {
              closeReasoning();
              if (!textItem) {
                textItem = { id: randomId('msg'), outputIndex, contentIndex: 0 };
                emit('response.output_item.added', {
                  output_index: outputIndex,
                  item: { type: 'message', id: textItem.id, role: 'assistant', status: 'in_progress', content: [] },
                });
              }
              emit('response.refusal.delta', { output_index: textItem.outputIndex, item_id: textItem.id, delta: ev.text });
              break;
            }

            case 'tool_start': {
              closeReasoning();
              closeText();
              const itemId = randomId('fc');
              tools.set(ev.idx, { itemId, outputIndex, name: ev.name, callId: ev.id });
              emit('response.output_item.added', {
                output_index: outputIndex,
                item: { type: 'function_call', id: itemId, call_id: ev.id, name: ev.name, arguments: '', status: 'in_progress' },
              });
              break;
            }

            case 'tool_delta': {
              const t = tools.get(ev.idx);
              if (!t) break;
              emit('response.function_call_arguments.delta', {
                output_index: t.outputIndex,
                item_id: t.itemId,
                delta: ev.args,
              });
              break;
            }

            case 'tool_end': {
              const t = tools.get(ev.idx);
              if (!t) break;
              emit('response.function_call_arguments.done', {
                output_index: t.outputIndex,
                item_id: t.itemId,
                name: t.name,
                arguments: '',
              });
              emit('response.output_item.done', {
                output_index: t.outputIndex,
                item: { type: 'function_call', id: t.itemId, call_id: t.callId, name: t.name, arguments: '', status: 'completed' },
              });
              outputIndex += 1;
              break;
            }

            case 'finish': {
              closeReasoning();
              closeText();
              if (ev.reason === 'length') {
                status = 'incomplete';
                incompleteReason = 'max_output_tokens';
              } else if (ev.reason === 'content_filter') {
                status = 'incomplete';
                incompleteReason = 'content_filter';
              }
              if (ev.usage) usage = ev.usage;
              break;
            }

            case 'error':
              emit('error', { message: ev.message, code: ev.type || 'upstream_error' });
              break;

            default:
              break;
          }
        }

        const normalizedUsage = usage
          ? {
              input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
              output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
              total_tokens:
                usage.total_tokens ??
                (usage.input_tokens ?? usage.prompt_tokens ?? 0) + (usage.output_tokens ?? usage.completion_tokens ?? 0),
              input_tokens_details: { cached_tokens: usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0 },
              output_tokens_details: { reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0 },
            }
          : undefined;

        const response = {
          id,
          object: 'response',
          created_at: created,
          status,
          ...(incompleteReason ? { incomplete_details: { reason: incompleteReason } } : {}),
          model,
          output: [],
          parallel_tool_calls: true,
          tool_choice: 'auto',
          tools: [],
          usage: normalizedUsage,
        };
        emit('response.completed', { response });
      } catch (err) {
        emit('error', { message: String(err?.message || err), code: 'bridge_error' });
      } finally {
        controller.close();
      }
    },
  });
}
