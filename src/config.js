/**
 * 环境变量解析
 *
 * v2 起上游路由全部走 KV 渠道配置（store.js / channels.js），
 * 这里只留通用的 env 解析工具。
 */

export function boolEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const v = String(value).toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

export function intEnv(value, defaultValue) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}
