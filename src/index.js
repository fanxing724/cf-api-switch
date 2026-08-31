/**
 * cf-api-switch — 多渠道协议转换网关
 *
 * 对外统一暴露 OpenAI 新协议（Responses），也接受旧 chat 协议与 Anthropic 协议；
 * 后端按渠道把请求翻译成各家自己的格式打过去，再把响应翻译回来。
 *
 * 路由规则：
 *   /<渠道名>/v1/<端点>     指定渠道
 *   /v1/<端点>             按模型自动选渠道
 *   /_admin                管理面板
 *
 * 例：
 *   你的域名/deepseek/v1/responses        -> DeepSeek 的 chat 接口
 *   你的域名/ark/v1/chat/completions      -> 火山方舟的 chat 接口
 */

import { getSettings, listAllModels, buildUpstreamUrl, getChannelBySlug } from './store.js';
import { resolveChannels, dispatchToChannels, buildHeaders } from './channels.js';
import { resolveApiVersion } from './vendors/index.js';
import { chatToInternal, anthropicToInternal, responsesToInternal } from './convert/request.js';
import { responsesToChat, responsesToAnthropic, chatObjectToResponses, chatToChat, chatToAnthropic } from './convert/response.js';
import {
  responsesStreamToEvents,
  chatStreamToEvents,
  eventsToResponsesStream,
  eventsToOpenAIChatStream,
  eventsToAnthropicStream,
  anthropicMessageId,
} from './convert/stream.js';
import { corsHeaders, jsonResponse, sseHeaders, randomId, estimateTokens, safeJson } from './util.js';
import { handleAdminApi, handleAdminUi } from './admin/index.js';

const ADMIN_PREFIX = '_admin';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, request.headers.get('origin')) });
    }

    const url = new URL(request.url);
    const segs = url.pathname.split('/').filter(Boolean);
    const baseHeaders = corsHeaders(env, request.headers.get('origin'));

    // ---- 管理面板 -----------------------------------------------------
    if (segs[0] === ADMIN_PREFIX) {
      return segs[1] === 'api' ? handleAdminApi(request, env, segs.slice(2)) : handleAdminUi(request, env, url);
    }

    // ---- 健康检查 -----------------------------------------------------
    if (!segs.length || segs[0] === 'healthz') {
      return jsonResponse(
        {
          ok: true,
          service: 'cf-api-switch',
          version: '2.0.0',
          usage: '把 /<渠道名>/v1/responses 打到网关，网关翻译成该渠道的原生格式',
          admin: '/_admin',
        },
        200,
        baseHeaders,
      );
    }

    try {
      // ---- 解析路径：<slug>/v1/<endpoint> ------------------------------
      const route = parseRoute(segs);
      if (route.error) return jsonResponse({ error: { message: route.error, type: 'invalid_request_error' } }, 404, baseHeaders);

      const { slug, endpoint } = route;

      // ---- 模型列表 ---------------------------------------------------
      if (request.method === 'GET' && endpoint === 'models') {
        return handleModels(request, env, slug, baseHeaders);
      }

      if (request.method !== 'POST') {
        return jsonError('只支持 POST 请求', 'invalid_request_error', 405, 'chat', baseHeaders);
      }

      // ---- 客户端鉴权 -------------------------------------------------
      const settings = await getSettings(env);
      if (settings.requireAuth && settings.clientKeys.length) {
        const key = extractKey(request);
        if (!settings.clientKeys.includes(key)) {
          return jsonError('Invalid API key', 'invalid_request_error', 401, inferInbound(endpoint), baseHeaders);
        }
      }

      const body = await readJsonBody(request);
      if (!body) return jsonError('请求体必须是合法 JSON', 'invalid_request_error', 400, inferInbound(endpoint), baseHeaders);

      const inbound = inferInbound(endpoint);
      if (!inbound) {
        return jsonError(`不支持的端点: ${endpoint}`, 'invalid_request_error', 404, 'chat', baseHeaders);
      }

      // ---- Anthropic 的 token 计数：本地估算，不打扰上游 ---------------
      if (endpoint === 'messages/count_tokens') {
        const { internal } = anthropicToInternal(body);
        let text = internal.instructions || '';
        for (const item of internal.input || []) {
          if (item.type === 'message') for (const c of item.content || []) if (c?.text) text += c.text;
          else if (item.type === 'function_call') text += `${item.name}${item.arguments ?? ''}`;
          else if (item.type === 'function_call_output') text += item.output ?? '';
        }
        for (const t of internal.tools || []) text += `${t.name}${t.description ?? ''}${JSON.stringify(t.parameters ?? {})}`;
        return jsonResponse({ input_tokens: estimateTokens(text) }, 200, baseHeaders);
      }

      // ---- 入站 -> internal -------------------------------------------
      const parsed = parseInbound(inbound, body);
      if (parsed.error) return jsonError(parsed.error, 'invalid_request_error', 400, inbound, baseHeaders);

      const internal = parsed.internal;
      const warnings = parsed.warnings || [];

      if (!internal.model) {
        return jsonError('请求缺少 model 字段，无法选择渠道', 'invalid_request_error', 400, inbound, baseHeaders);
      }

      // ---- 选渠道 -----------------------------------------------------
      const { channels, error: routeError, status } = await resolveChannels(env, { slug, model: internal.model });
      if (routeError) return jsonError(routeError, 'invalid_request_error', status || 404, inbound, baseHeaders);

      // ---- 打上游（带故障转移）----------------------------------------
      const result = await dispatchToChannels(env, channels, internal);
      const meta = {
        'X-Channel-Id': result.channel?.id || '',
        'X-Channel-Slug': result.channel?.slug || '',
        'X-Upstream-Base': result.channel?.baseUrl || '',
        'X-Upstream-Protocol': result.protocol || '',
        'X-Upstream-Model': result.payload?.model || internal.model,
        'X-Upstream-Url': result.url || '',
      };
      if (result.attempts?.length) meta['X-Fallback-Attempts'] = String(result.attempts.length);
      if (warnings.length) meta['X-Bridge-Warnings'] = encodeURIComponent(warnings.join(' | '));
      const headers = { ...baseHeaders, ...meta };

      if (!result.res) {
        return jsonError(
          `所有渠道均调用失败：${result.attempts.map((a) => `${a.channel}(${a.error})`).join('; ')}`,
          'upstream_error',
          502,
          inbound,
          headers,
        );
      }
      if (!result.res.ok) {
        const text = await result.res.text().catch(() => '');
        const parsedErr = safeJson(text, null);
        const message = parsedErr?.error?.message || parsedErr?.message || text.slice(0, 500) || `上游返回 ${result.res.status}`;
        return jsonError(message, parsedErr?.error?.type || 'upstream_error', result.res.status, inbound, headers);
      }

      // ---- 渲染响应 ---------------------------------------------------
      if (internal.stream) {
        return renderStream(result, { inbound, headers, model: internal.model });
      }

      const json = await result.res.json().catch(() => null);
      if (!json) return jsonError('上游返回了无法解析的响应', 'upstream_error', 502, inbound, headers);

      const out = renderObject(json, inbound, result.protocol, internal.model);
      if (out?.error) {
        return jsonError(out.error.message || '上游返回错误', out.error.type || 'upstream_error', 502, inbound, headers);
      }
      return jsonResponse(out, 200, headers);
    } catch (err) {
      return jsonError(`网关内部错误: ${err?.message || err}`, 'bridge_error', 500, 'chat', baseHeaders);
    }
  },
};

/* ------------------------------------------------------------------ */
/* 路径解析                                                            */
/* ------------------------------------------------------------------ */

function parseRoute(segs) {
  // /v1/<endpoint>
  if (segs[0] === 'v1' || segs[0] === 'v1beta') {
    const endpoint = segs.slice(1).join('/');
    return endpoint ? { slug: null, endpoint } : { error: '缺少端点' };
  }
  // /<slug>/v1/<endpoint>
  if (segs[1] === 'v1' || segs[1] === 'v1beta') {
    const endpoint = segs.slice(2).join('/');
    return endpoint ? { slug: segs[0].toLowerCase(), endpoint } : { error: '缺少端点' };
  }
  return { error: `路径格式应为 /<渠道名>/v1/<端点>，收到的是 /${segs.join('/')}` };
}

/** 端点 -> 入站协议 */
function inferInbound(endpoint) {
  if (endpoint === 'responses') return 'responses';
  if (endpoint === 'chat/completions' || endpoint === 'completions') return 'chat';
  if (endpoint === 'messages' || endpoint === 'messages/count_tokens') return 'anthropic';
  return null;
}

/* ------------------------------------------------------------------ */
/* 入站解析                                                            */
/* ------------------------------------------------------------------ */

function parseInbound(inbound, body) {
  if (inbound === 'responses') {
    if (body.input === undefined && !body.instructions && !body.previous_response_id) {
      return { error: 'Responses 请求缺少 input 字段' };
    }
    return responsesToInternal(body);
  }
  if (inbound === 'anthropic') {
    if (!Array.isArray(body.messages)) return { error: '缺少 messages 字段' };
    return anthropicToInternal(body);
  }
  if (!Array.isArray(body.messages)) return { error: '缺少 messages 字段' };
  return chatToInternal(body);
}

/* ------------------------------------------------------------------ */
/* 响应渲染                                                            */
/* ------------------------------------------------------------------ */

/** 非流式：上游协议 × 入站协议 -> 目标对象 */
function renderObject(json, inbound, upstreamProtocol, model) {
  if (upstreamProtocol === 'responses') {
    if (inbound === 'responses') return json; // 双端都是新协议，原样透传
    return inbound === 'chat' ? responsesToChat(json, model) : responsesToAnthropic(json, model);
  }
  // 上游是老 chat 协议
  if (inbound === 'responses') return chatObjectToResponses(json, model);
  if (inbound === 'chat') return chatToChat(json, model);
  return chatToAnthropic(json, model);
}

/** 流式：按入站协议选渲染器 */
function renderStream(result, { inbound, headers, model }) {
  const meta = {
    id: inbound === 'anthropic' ? anthropicMessageId() : randomId(inbound === 'responses' ? 'resp' : 'chatcmpl'),
    model,
    created: Math.floor(Date.now() / 1000),
    includeUsage: true,
  };

  // 双端都是新协议，直接管道透传，零损耗
  if (inbound === 'responses' && result.protocol === 'responses') {
    return new Response(result.res.body, { status: 200, headers: sseHeaders(headers) });
  }

  const events = result.protocol === 'responses' ? responsesStreamToEvents(result.res.body) : chatStreamToEvents(result.res.body);

  let stream;
  if (inbound === 'responses') stream = eventsToResponsesStream(events, meta);
  else if (inbound === 'chat') stream = eventsToOpenAIChatStream(events, meta);
  else stream = eventsToAnthropicStream(events, meta);

  return new Response(stream, { status: 200, headers: sseHeaders(headers) });
}

/* ------------------------------------------------------------------ */
/* 模型列表                                                            */
/* ------------------------------------------------------------------ */

async function handleModels(request, env, slug, baseHeaders) {
  // 指定渠道时直接问上游要，结果最准
  if (slug) {
    const channel = await getChannelBySlug(env, slug);
    if (!channel) return jsonResponse({ error: { message: `渠道 "${slug}" 不存在`, type: 'invalid_request_error' } }, 404, baseHeaders);
    if (!channel.enabled) return jsonResponse({ error: { message: `渠道 "${slug}" 已停用`, type: 'invalid_request_error' } }, 403, baseHeaders);

    const url = buildUpstreamUrl(channel, 'models', resolveApiVersion(channel));
    try {
      const res = await fetch(url, { headers: buildHeaders(channel) });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return jsonResponse({ error: { message: `上游返回 ${res.status}: ${text.slice(0, 300)}`, type: 'upstream_error' } }, res.status, baseHeaders);
      }
      const json = await res.json();
      return jsonResponse(json, 200, { ...baseHeaders, 'X-Channel-Slug': channel.slug });
    } catch (err) {
      return jsonResponse({ error: { message: `拉取失败: ${err?.message || err}`, type: 'upstream_error' } }, 502, baseHeaders);
    }
  }

  // 未指定渠道：聚合所有渠道声明的模型
  const data = await listAllModels(env);
  return jsonResponse({ object: 'list', data }, 200, baseHeaders);
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function extractKey(request) {
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return request.headers.get('x-api-key') || '';
}

/** 按入站协议封装错误体 */
function jsonError(message, type, status, inbound, extraHeaders = {}) {
  if (inbound === 'anthropic') {
    return jsonResponse(
      { type: 'error', error: { type: status === 401 ? 'authentication_error' : 'api_error', message } },
      status,
      extraHeaders,
    );
  }
  return jsonResponse({ error: { message, type, code: status === 401 ? 'invalid_api_key' : null } }, status, extraHeaders);
}
