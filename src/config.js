/**
 * 环境变量解析 + 上游路由
 */

import { safeJson } from './util.js';

const DEFAULT_ROUTES = [{ match: '*', base: 'https://api.openai.com/v1', protocol: 'responses' }];

function normalizeBase(base) {
  if (!base) return 'https://api.openai.com/v1';
  return String(base).replace(/\/+$/, '');
}

/**
 * 解析路由表。支持三种来源，优先级：
 *   UPSTREAM_ROUTES (JSON 数组) > UPSTREAM_BASE + UPSTREAM_KEY > 内置默认
 */
export function loadRoutes(env) {
  const parsed = safeJson(env?.UPSTREAM_ROUTES, null);
  if (Array.isArray(parsed) && parsed.length) {
    return parsed
      .filter((r) => r && r.base)
      .map((r) => ({
        match: String(r.match ?? '*'),
        base: normalizeBase(r.base),
        key: r.key || null,
        protocol: r.protocol === 'chat' ? 'chat' : 'responses',
        headers: r.headers && typeof r.headers === 'object' ? r.headers : null,
      }));
  }
  return [
    {
      match: '*',
      base: normalizeBase(env?.UPSTREAM_BASE || DEFAULT_ROUTES[0].base),
      key: env?.UPSTREAM_KEY || null,
      protocol: 'responses',
      headers: null,
    },
  ];
}

/** 是否为兜底规则 */
function isCatchAll(rule) {
  return rule.match === '*' || rule.match === 'default' || rule.match === '';
}

/**
 * 按模型名挑选上游。
 * 匹配策略：先找前缀完全命中的非兜底规则（取最长前缀，避免 gpt- 与 gpt-5- 冲突），
 * 再退到兜底规则。
 */
export function resolveUpstream(env, model) {
  const routes = loadRoutes(env);
  const name = String(model || '');
  let best = null;

  for (const rule of routes) {
    if (isCatchAll(rule)) continue;
    if (name.startsWith(rule.match)) {
      if (!best || rule.match.length > best.match.length) best = rule;
    }
  }
  const chosen = best || routes.find(isCatchAll) || routes[routes.length - 1];
  return {
    ...chosen,
    key: chosen.key || env?.UPSTREAM_KEY || null,
  };
}

/** 模型别名映射 */
export function mapModel(env, model) {
  const aliases = safeJson(env?.MODEL_ALIASES, null);
  if (aliases && typeof aliases === 'object' && Object.prototype.hasOwnProperty.call(aliases, model)) {
    return aliases[model];
  }
  return model;
}

export function boolEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const v = String(value).toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

export function intEnv(value, defaultValue) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/** 校验客户端密钥（未配置则不校验，方便本地调试） */
export function authorizeClient(env, request) {
  if (!boolEnv(env?.REQUIRE_AUTH, false)) return { ok: true };
  const allowed = String(env?.CLIENT_API_KEY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.length) return { ok: true };
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  const key = bearer ? bearer[1].trim() : request.headers.get('x-api-key') || '';
  if (allowed.includes(key)) return { ok: true };
  return { ok: false, status: 401, message: 'Invalid API key. 请检查 Authorization / x-api-key。' };
}
