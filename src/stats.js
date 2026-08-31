/**
 * 渠道请求统计
 *
 * 每次调用在 KV 里记一笔（累计计数 + 最近一次状态）。
 * KV 无原子自增，个人使用场景下的并发丢失可忽略；
 * 统计写入失败不影响主链路（全部 try/catch 包裹）。
 */

import { safeJson } from './util.js';

const PREFIX = 'stats:';

const EMPTY = () => ({
  count: 0,
  ok: 0,
  fail: 0,
  lastAt: null,
  lastModel: null,
  lastStatus: null,
  lastError: null,
});

export async function getStats(env, channelId) {
  const kv = env?.KV;
  if (!kv || !channelId) return EMPTY();
  try {
    const raw = await kv.get(PREFIX + channelId);
    if (!raw) return EMPTY();
    return { ...EMPTY(), ...safeJson(raw, {}) };
  } catch {
    return EMPTY();
  }
}

export async function recordRequest(env, channelId, { ok, status, model, error }) {
  const kv = env?.KV;
  if (!kv || !channelId) return;
  try {
    const stats = await getStats(env, channelId);
    stats.count += 1;
    if (ok) stats.ok += 1;
    else stats.fail += 1;
    stats.lastAt = Date.now();
    if (model) stats.lastModel = model;
    stats.lastStatus = status ?? null;
    if (error) stats.lastError = String(error).slice(0, 200);
    await kv.put(PREFIX + channelId, JSON.stringify(stats));
  } catch {
    // 统计失败不打断请求
  }
}
