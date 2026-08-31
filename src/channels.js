/**
 * 渠道调用与故障转移
 */

import { internalToResponses, internalToChat } from './convert/request.js';
import { getVendor, resolveApiVersion, applyDropParams } from './vendors/index.js';
import { buildUpstreamUrl, getChannelsForModel, getChannelBySlug } from './store.js';
import { intEnv } from './config.js';

/** 应用渠道自己的模型映射 */
export function mapModelForChannel(channel, model) {
  return channel.modelMapping?.[model] ?? model;
}

/** 把 internal 渲染成该渠道能吃的请求 */
export function buildRequest(channel, internal) {
  const model = mapModelForChannel(channel, internal.model);
  const ir = { ...internal, model };
  const vendor = getVendor(channel.vendor);

  if (channel.protocol === 'responses') {
    const apiVersion = channel.apiVersion === undefined || channel.apiVersion === null ? 'v1' : channel.apiVersion;
    return { endpoint: 'responses', apiVersion, payload: internalToResponses(ir, {}), protocol: 'responses' };
  }

  // 厂商补丁 -> 渠道上手动声明的剔除项，后者优先级最高
  let payload = vendor.transformRequest(internalToChat(ir, {}));
  payload = applyDropParams(payload, channel);
  return { endpoint: 'chat/completions', apiVersion: resolveApiVersion(channel), payload, protocol: 'openai-chat' };
}

/** 组装请求头 */
export function buildHeaders(channel) {
  const vendor = getVendor(channel.vendor);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (channel.apiKey) headers.set('authorization', `Bearer ${channel.apiKey}`);
  for (const [k, v] of Object.entries(vendor.extraHeaders(channel) || {})) headers.set(k, v);
  for (const [k, v] of Object.entries(channel.headers || {})) headers.set(k, v);
  return headers;
}

/** 选定渠道：优先按路径 slug，退化为按模型匹配 */
export async function resolveChannels(env, { slug, model }) {
  if (slug) {
    const ch = await getChannelBySlug(env, slug);
    if (!ch) return { channels: [], error: `渠道 "${slug}" 不存在或未启用`, status: 404 };
    if (!ch.enabled) return { channels: [], error: `渠道 "${slug}" 已被停用`, status: 403 };
    return { channels: [ch], source: 'slug' };
  }

  const list = await getChannelsForModel(env, model);
  if (!list.length) return { channels: [], error: `没有可用渠道能处理模型 "${model || '(空)'}"`, status: 404 };
  return { channels: list, source: 'model' };
}

/**
 * 依次尝试渠道，直到拿到可用响应。
 * 只在 5xx / 429 / 网络错误时切换下一个；4xx 视为请求或配置问题，直接返回。
 */
export async function dispatchToChannels(env, channels, internal) {
  const attempts = [];
  let lastResult = null;

  for (const channel of channels) {
    const { endpoint, apiVersion, payload, protocol } = buildRequest(channel, internal);
    const url = buildUpstreamUrl(channel, endpoint, apiVersion);
    const timeout = channel.timeoutMs || intEnv(env?.UPSTREAM_TIMEOUT_MS, 120000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(channel),
        body: JSON.stringify(payload),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeout) : undefined,
      });

      if (res.ok) return { channel, url, endpoint, payload, protocol, res, attempts };

      // 响应体只能读一次：在这里读出错误文本随结果带回，
      // 否则 index.js 再 res.text() 会因 body 已被消费而拿到空串，错误信息被吞。
      const errorText = await safeErrorText(res);
      const record = { channel, url, endpoint, payload, protocol, res, errorText };
      lastResult = record;

      const retryable = res.status >= 500 || res.status === 429;
      attempts.push({ channel: channel.slug, url, status: res.status, error: errorText });

      if (!retryable) return { ...record, attempts };
      // 可重试：继续下一个渠道
    } catch (err) {
      attempts.push({
        channel: channel.slug,
        url,
        status: 0,
        error: err?.name === 'TimeoutError' ? `请求超时（${timeout}ms）` : String(err?.message || err),
      });
    }
  }

  return {
    res: lastResult?.res || null,
    channel: lastResult?.channel || channels[0],
    url: lastResult?.url || '',
    endpoint: lastResult?.endpoint || 'chat/completions',
    payload: lastResult?.payload || null,
    protocol: lastResult?.protocol || 'openai-chat',
    errorText: lastResult?.errorText || '',
    attempts,
  };
}

async function safeErrorText(res) {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || text.slice(0, 300);
  } catch {
    return `HTTP ${res.status}`;
  }
}
