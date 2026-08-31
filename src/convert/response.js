/**
 * 响应侧转换（非流式）
 *
 * 支持四种组合：
 *   upstream responses -> chat / anthropic
 *   upstream chat      -> chat / anthropic
 */

import { randomId, resolveFinishReason, usageToChat, usageToAnthropic, usageToResponses } from '../util.js';

/** 从 Responses 的 output 数组里提取文本、工具调用、思考内容 */
export function extractResponsesOutput(output) {
  const textParts = [];
  const reasoningParts = [];
  const toolCalls = [];

  for (const item of output || []) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part?.type === 'output_text') textParts.push(part.text ?? '');
        else if (part?.type === 'refusal') textParts.push(part.refusal ?? '');
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id || '',
        type: 'function',
        function: {
          name: item.name ?? '',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      });
    } else if (item.type === 'reasoning') {
      for (const s of item.summary || []) {
        if (typeof s === 'string') reasoningParts.push(s);
        else if (s?.text) reasoningParts.push(s.text);
      }
    }
  }

  return {
    text: textParts.join('') || null,
    reasoning: reasoningParts.join('\n\n') || null,
    toolCalls: toolCalls.length ? toolCalls : null,
  };
}

/** Responses 响应对象 → chat.completion 对象 */
export function responsesToChat(resp, requestModel) {
  if (resp?.error) {
    return { error: resp.error };
  }

  const { text, reasoning, toolCalls } = extractResponsesOutput(resp.output);
  const finishReason = resolveFinishReason(resp, !!toolCalls);

  const message = { role: 'assistant', content: text };
  if (toolCalls) message.tool_calls = toolCalls;
  if (reasoning) message.reasoning_content = reasoning;
  if (resp.output?.some((i) => i?.type === 'message' && (i.content || []).some((c) => c?.type === 'refusal'))) {
    message.refusal = text;
    message.content = null;
  }

  return {
    id: resp.id || randomId('chatcmpl'),
    object: 'chat.completion',
    created: resp.created_at ?? Math.floor(Date.now() / 1000),
    model: resp.model || requestModel,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: usageToChat(resp.usage),
    service_tier: resp.service_tier ?? null,
    system_fingerprint: resp.system_fingerprint ?? '',
  };
}

/** Responses 响应对象 → Anthropic message 对象 */
export function responsesToAnthropic(resp, requestModel) {
  if (resp?.error) {
    return { error: resp.error };
  }

  const content = [];
  for (const item of resp.output || []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part?.type === 'output_text') {
          if (part.text) content.push({ type: 'text', text: part.text });
        } else if (part?.type === 'refusal') {
          content.push({ type: 'text', text: part.refusal ?? '' });
        }
      }
    } else if (item.type === 'function_call') {
      let input = {};
      try {
        input = typeof item.arguments === 'string' ? JSON.parse(item.arguments || '{}') : item.arguments ?? {};
      } catch {
        input = {};
      }
      content.push({ type: 'tool_use', id: item.call_id || item.id || '', name: item.name ?? '', input });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const toolUsed = content.some((c) => c.type === 'tool_use');
  let stopReason = 'end_turn';
  if (toolUsed) stopReason = 'tool_use';
  else if (resp.status === 'incomplete' && resp.incomplete_details?.reason === 'max_output_tokens') stopReason = 'max_tokens';

  return {
    id: resp.id?.startsWith('msg_') ? resp.id : `msg_${(resp.id || randomId('msg')).replace(/^resp_/, '')}`,
    type: 'message',
    role: 'assistant',
    model: resp.model || requestModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usageToAnthropic(resp.usage),
  };
}

/* ------------------------------------------------------------------ */
/* 上游 chat 响应 → Responses 响应对象                                  */
/* ------------------------------------------------------------------ */

/**
 * chat.completion 对象 → Responses 对象。
 * 这是「老协议上游 → 新协议客户端」的主路径，reasoning_content
 * （DeepSeek-R1 / 火山思考模型 / o1 系）会被还原成 reasoning 项。
 */
export function chatObjectToResponses(resp, requestModel) {
  if (resp?.error) return { error: resp.error };

  const msg = resp.choices?.[0]?.message ?? {};
  const finish = resp.choices?.[0]?.finish_reason;
  const output = [];

  // 1. 思维链 -> reasoning 项
  if (msg.reasoning_content) {
    output.push({
      type: 'reasoning',
      id: randomId('rs'),
      summary: [{ type: 'summary_text', text: msg.reasoning_content }],
      status: 'completed',
    });
  }

  // 2. 正文 -> message 项
  const text = typeof msg.content === 'string' ? msg.content : extractChatText(msg.content);
  if (text) {
    output.push({
      type: 'message',
      id: randomId('msg'),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }

  // 3. 工具调用 -> function_call 项
  for (const call of msg.tool_calls || []) {
    output.push({
      type: 'function_call',
      id: randomId('fc'),
      call_id: call.id || randomId('call'),
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '',
      status: 'completed',
    });
  }

  if (msg.refusal) {
    output.push({
      type: 'message',
      id: randomId('msg'),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'refusal', refusal: msg.refusal }],
    });
  }

  const status = finish === 'length' || finish === 'content_filter' ? 'incomplete' : 'completed';
  const incompleteReason = finish === 'length' ? 'max_output_tokens' : finish === 'content_filter' ? 'content_filter' : null;

  return {
    id: resp.id?.startsWith('resp_') ? resp.id : `resp_${(resp.id || randomId('resp')).replace(/^chatcmpl-?/, '')}`,
    object: 'response',
    created_at: resp.created ?? Math.floor(Date.now() / 1000),
    status,
    ...(incompleteReason ? { incomplete_details: { reason: incompleteReason } } : {}),
    model: resp.model || requestModel,
    output,
    output_text: text || '',
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: usageToResponses(resp.usage),
  };
}

function extractChatText(content) {
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* 上游为 chat 协议的响应转换                                           */
/* ------------------------------------------------------------------ */

/** chat.completion 对象 → chat.completion 对象（规范化 + 补字段） */
export function chatToChat(resp, requestModel) {
  if (resp?.error) return { error: resp.error };

  const choice = resp.choices?.[0] ?? {};
  return {
    id: resp.id || randomId('chatcmpl'),
    object: 'chat.completion',
    created: resp.created ?? Math.floor(Date.now() / 1000),
    model: resp.model || requestModel,
    choices: [
      {
        index: 0,
        message: choice.message ?? { role: 'assistant', content: null },
        logprobs: choice.logprobs ?? null,
        finish_reason: choice.finish_reason ?? 'stop',
      },
    ],
    usage: resp.usage,
    service_tier: resp.service_tier ?? null,
    system_fingerprint: resp.system_fingerprint ?? '',
  };
}

/** chat.completion 对象 → Anthropic message 对象 */
export function chatToAnthropic(resp, requestModel) {
  if (resp?.error) return { error: resp.error };

  const msg = resp.choices?.[0]?.message ?? {};
  const content = [];

  if (msg.reasoning_content) content.push({ type: 'thinking', thinking: msg.reasoning_content, signature: '' });
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  else if (Array.isArray(msg.content)) {
    for (const c of msg.content) {
      if (c?.type === 'text') content.push({ type: 'text', text: c.text ?? '' });
    }
  }

  for (const call of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function?.name ?? '', input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const finish = resp.choices?.[0]?.finish_reason;
  let stopReason = 'end_turn';
  if (finish === 'tool_calls') stopReason = 'tool_use';
  else if (finish === 'length') stopReason = 'max_tokens';

  return {
    id: `msg_${(resp.id || randomId('msg')).replace(/^chatcmpl-/, '')}`,
    type: 'message',
    role: 'assistant',
    model: resp.model || requestModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usageToAnthropic(resp.usage),
  };
}
