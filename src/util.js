/**
 * 通用工具函数
 */

const HEX = 'abcdef0123456789';

/** 生成带前缀的随机 ID，风格贴近各家协议（chatcmpl- / resp- / msg-） */
export function randomId(prefix = 'id') {
  let s = '';
  for (let i = 0; i < 24; i++) s += HEX[Math.floor(Math.random() * 16)];
  return `${prefix}_${s}`;
}

/** 安全 JSON 解析，失败返回 fallback */
export function safeJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 安全 JSON 序列化（arguments 字段本身就是字符串，不能二次 stringify） */
export function stringifyIfNeeded(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

export function corsHeaders(env, origin) {
  const allow = env?.CORS_ALLOW_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': allow === '*' ? '*' : origin || allow,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-api-key, anthropic-version, anthropic-beta, openai-beta, x-request-id',
    'Access-Control-Expose-Headers': 'X-Upstream-Base, X-Upstream-Protocol, X-Upstream-Model, X-Request-Id, X-Bridge-Warnings, openai-processing-ms',
    'Access-Control-Max-Age': '86400',
  };
}

export function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function errorResponse(message, status = 502, type = 'upstream_error', extraHeaders = {}) {
  return jsonResponse(
    {
      error: {
        message,
        type,
        code: status === 401 ? 'invalid_api_key' : status === 429 ? 'rate_limit_exceeded' : null,
      },
    },
    status,
    extraHeaders,
  );
}

export function sseHeaders(extraHeaders = {}) {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...extraHeaders,
  };
}

/** 把一段文本按 SSE 规范编码（多行 data 需逐行加前缀） */
export function sseEncode(event, data) {
  let payload = typeof data === 'string' ? data : JSON.stringify(data);
  payload = payload.replace(/\r\n/g, '\n');
  const lines = payload.split('\n').map((l) => `data: ${l}`).join('\n');
  return event ? `event: ${event}\n${lines}\n\n` : `${lines}\n\n`;
}

/**
 * 粗略估算 token 数，用于 Anthropic count_tokens 与降级场景。
 * 中英文混排下按 ~3.2 字符/token 估，比 /4 更贴近实际。
 */
export function estimateTokens(input) {
  if (input === null || input === undefined) return 0;
  let text = '';
  if (typeof input === 'string') {
    text = input;
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') text += item;
      else if (item && typeof item === 'object') {
        text += item.text || item.content || item.output || '';
        if (item.arguments) text += stringifyIfNeeded(item.arguments);
        if (item.input) text += stringifyIfNeeded(item.input);
      }
    }
  } else if (typeof input === 'object') {
    text = input.text || input.content || input.output || '';
  }
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3.2));
}

/** 从 Authorization / x-api-key 提取客户端密钥 */
export function extractClientKey(request) {
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return request.headers.get('x-api-key') || '';
}

/** 判定 finish_reason */
export function resolveFinishReason(responseObj, hasToolCalls) {
  if (!responseObj) return 'stop';
  const status = responseObj.status;
  if (status === 'incomplete') {
    const reason = responseObj.incomplete_details?.reason;
    if (reason === 'max_output_tokens') return 'length';
    if (reason === 'content_filter') return 'content_filter';
    return hasToolCalls ? 'tool_calls' : 'stop';
  }
  if (status === 'failed' || status === 'cancelled') return 'stop';
  return hasToolCalls ? 'tool_calls' : 'stop';
}

/** 把 Responses 的 usage 转成 chat 协议的 usage */
export function usageToChat(usage) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    prompt_tokens_details: {
      cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0,
    },
    completion_tokens_details: {
      reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

/** 把 chat 协议的 usage 转成 Responses 的 usage */
export function usageToResponses(usage) {
  if (!usage) return undefined;
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: usage.total_tokens ?? input + output,
    input_tokens_details: {
      cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    },
    output_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

/**
 * 把 Responses（input/output_tokens）或 chat（prompt/completion_tokens）的 usage
 * 统一转成 Anthropic 的 usage
 */
export function usageToAnthropic(usage, fallbackInput = 0) {
  const input = usage?.input_tokens ?? usage?.prompt_tokens ?? fallbackInput ?? 0;
  const output = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const cached = usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}
