/**
 * 渠道存储层
 *
 * 优先用 Workers KV；未绑定 KV 时回落到 env.CHANNELS（JSON 字符串），
 * 保证 `wrangler dev` 在不配 namespace 的情况下也能跑通。
 */

import { randomId, safeJson } from './util.js';

const CHANNELS_KEY = 'channels';
const SETTINGS_KEY = 'settings';

/** KV 是否可用 */
function kv(env) {
  return env?.KV && typeof env.KV.get === 'function' ? env.KV : null;
}

async function readJson(env, key, fallback) {
  const store = kv(env);
  if (store) {
    const raw = await store.get(key);
    if (!raw) return fallback;
    return safeJson(raw, fallback);
  }
  // fallback：环境变量里预置的渠道
  if (key === CHANNELS_KEY && env?.CHANNELS) {
    return safeJson(env.CHANNELS, fallback) ?? fallback;
  }
  if (key === SETTINGS_KEY && env?.SETTINGS) {
    return safeJson(env.SETTINGS, fallback) ?? fallback;
  }
  return fallback;
}

async function writeJson(env, key, value) {
  const store = kv(env);
  if (!store) {
    // 无 KV 时写不进去，直接返回（本地开发用环境变量配置即可）
    return false;
  }
  await store.put(key, JSON.stringify(value));
  return true;
}

/** 渠道默认字段 */
export function normalizeChannel(input) {
  const slug = String(input.slug || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const baseUrl = normalizeBaseUrl(input.baseUrl);

  return {
    id: input.id || `ch_${randomId('').replace(/^_/, '') || Math.random().toString(36).slice(2, 10)}`,
    name: String(input.name || slug || '未命名渠道').trim(),
    slug,
    baseUrl,
    apiKey: input.apiKey ?? '',
    protocol: input.protocol === 'responses' ? 'responses' : 'openai-chat',
    // 厂商可自由填写：预设值只是建议，未知的按通用 OpenAI 兼容处理
    vendor: String(input.vendor || 'generic').trim() || 'generic',
    // null/undefined 表示「跟随厂商默认」，空字符串表示「不插版本段」
    apiVersion: input.apiVersion === undefined || input.apiVersion === null ? undefined : String(input.apiVersion).trim(),
    dropParams: Array.isArray(input.dropParams)
      ? input.dropParams.map((p) => String(p).trim()).filter(Boolean)
      : typeof input.dropParams === 'string'
        ? input.dropParams.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
    models: Array.isArray(input.models) ? input.models.filter(Boolean) : [],
    enabled: input.enabled !== false,
    weight: Number.isFinite(Number(input.weight)) ? Number(input.weight) : 100,
    timeoutMs: Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : 120000,
    headers: input.headers && typeof input.headers === 'object' ? input.headers : {},
    modelMapping: input.modelMapping && typeof input.modelMapping === 'object' ? input.modelMapping : {},
    createdAt: input.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * 归一化 baseUrl：去掉结尾斜杠与冗余的 /v1。
 * 这样面版里填 `https://api.deepseek.com` 或 `https://api.deepseek.com/v1` 都可以，
 * 网关内部统一拼 `/v1/<endpoint>`。
 */
export function normalizeBaseUrl(baseUrl) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  base = base.replace(/\/v1(?:beta)?$/, '');
  return base;
}

/**
 * 拼接上游完整地址。
 * apiVersion 为空串时不插版本号，用于火山方舟这类把版本号写在 base 里的
 * （https://ark.cn-beijing.volces.com/api/v3 + /chat/completions）。
 */
export function buildUpstreamUrl(channel, endpoint, apiVersion = 'v1') {
  const base = normalizeBaseUrl(channel.baseUrl);
  return apiVersion ? `${base}/${apiVersion}/${endpoint}` : `${base}/${endpoint}`;
}

export async function listChannels(env) {
  const raw = await readJson(env, CHANNELS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeChannel);
}

export async function saveChannels(env, channels) {
  return writeJson(env, CHANNELS_KEY, channels);
}

export async function getChannelBySlug(env, slug) {
  const target = String(slug || '').toLowerCase();
  const list = await listChannels(env);
  return list.find((c) => c.slug === target) || null;
}

export async function getChannelById(env, id) {
  const list = await listChannels(env);
  return list.find((c) => c.id === id) || null;
}

/** 路由保留字：这些 slug 会与网关自身路径冲突，禁止用作渠道标识 */
const RESERVED_SLUGS = new Set(['_admin', 'v1', 'v1beta', 'healthz']);

export async function upsertChannel(env, input) {
  const list = await listChannels(env);
  const normalized = normalizeChannel(input);

  if (!normalized.slug) throw new Error('渠道标识（slug）不能为空，且只能包含小写字母、数字、连字符');
  if (RESERVED_SLUGS.has(normalized.slug)) {
    throw new Error(`渠道标识 "${normalized.slug}" 是系统保留字（_admin / v1 / v1beta / healthz），请换一个`);
  }
  if (!normalized.baseUrl) throw new Error('上游地址不能为空');

  const idx = list.findIndex((c) => c.id === normalized.id);
  if (idx >= 0) {
    normalized.createdAt = list[idx].createdAt;
    normalized.apiKey = preserveApiKey(list[idx], normalized.apiKey);
    list[idx] = normalized;
  } else {
    // 同 slug 已存在则视为更新。必须沿用原有 id，
    // 否则后续按 id 的测试 / 启停 / 删除操作都会找不到渠道。
    const bySlug = list.findIndex((c) => c.slug === normalized.slug);
    if (bySlug >= 0) {
      normalized.id = list[bySlug].id;
      normalized.createdAt = list[bySlug].createdAt;
      normalized.apiKey = preserveApiKey(list[bySlug], normalized.apiKey);
      list[bySlug] = normalized;
    } else {
      list.push(normalized);
    }
  }

  await saveChannels(env, list);
  return normalized;
}

/**
 * 更新渠道时保护已存密匙：
 * 面板编辑不重填 key 的情况下，前端可能回传空值或列表里的掩码值
 * （sk-xxx****xxxx），这两种都不能覆盖服务端已存的真实 key。
 */
function preserveApiKey(existing, incoming) {
  if (!incoming) return existing.apiKey;
  if (incoming === existing.apiKey) return existing.apiKey;
  if (incoming === maskKey(existing.apiKey)) return existing.apiKey;
  return incoming;
}

export async function deleteChannel(env, id) {
  const list = await listChannels(env);
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return false;
  await saveChannels(env, next);
  return true;
}

/**
 * 按模型名挑选可用渠道，返回按权重降序的列表（供故障转移逐个尝试）。
 * 匹配顺序：精确匹配 models > 前缀匹配 > 配置了空 models（视为全模型通吃）
 */
export async function getChannelsForModel(env, model) {
  const list = (await listChannels(env)).filter((c) => c.enabled);
  const name = String(model || '');
  const scored = [];

  for (const ch of list) {
    let score = -1;
    if (!ch.models.length) score = 1; // 不限制模型
    else if (ch.models.includes(name)) score = 100;
    else if (ch.models.some((m) => name.startsWith(m))) score = 50;
    if (score >= 0) scored.push({ ch, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || b.ch.weight - a.ch.weight)
    .map((s) => s.ch);
}

/** 聚合所有渠道的模型列表 */
export async function listAllModels(env) {
  const list = (await listChannels(env)).filter((c) => c.enabled);
  const seen = new Map();
  for (const ch of list) {
    for (const m of ch.models) {
      if (!seen.has(m)) seen.set(m, { id: m, object: 'model', owned_by: ch.name });
    }
  }
  return [...seen.values()];
}

/** API Key 掩码，面板展示用 */
export function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 8) return '****';
  return `${s.slice(0, 6)}****${s.slice(-4)}`;
}

/* --------------------------- 站点设置 --------------------------- */

const DEFAULT_SETTINGS = {
  adminPasswordHash: null,
  adminSalt: null,
  clientKeys: [],
  requireAuth: false,
  cookieSecret: null,
};

export async function getSettings(env) {
  const raw = await readJson(env, SETTINGS_KEY, null);
  return { ...DEFAULT_SETTINGS, ...(raw || {}) };
}

export async function saveSettings(env, patch) {
  const current = await getSettings(env);
  const next = { ...current, ...patch };
  const ok = await writeJson(env, SETTINGS_KEY, next);
  return { settings: next, persisted: ok };
}

/** 存储后端说明，面板上展示 */
export function storageMode(env) {
  return kv(env) ? 'kv' : 'env';
}
