/**
 * 管理面板鉴权
 *
 * 密码用 PBKDF2-SHA256 派生后存 KV（不存明文），
 * 登录态是一个 HMAC-SHA256 签名的 HttpOnly cookie，密钥随机生成后存 KV。
 * 全部基于 Web Crypto，Workers 原生支持，无第三方依赖。
 */

import { getSettings, saveSettings } from './store.js';

const COOKIE_NAME = 'cfs_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const PBKDF2_ITERATIONS = 100000;

/* ----------------------------- 编码工具 ----------------------------- */

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toB64Url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(str) {
  const norm = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomHex(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

/** 恒定时间比较，避免时序侧信道 */
function safeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/* ----------------------------- 密码 ----------------------------- */

export async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return toHex(bits);
}

/** 初始化或重置管理员密码 */
export async function setAdminPassword(env, password) {
  if (!password || String(password).length < 6) throw new Error('密码至少 6 位');
  const salt = randomHex(16);
  const hash = await hashPassword(String(password), salt);
  await saveSettings(env, { adminPasswordHash: hash, adminSalt: salt, cookieSecret: randomHex(32) });
  return true;
}

/* ----------------------------- 会话 ----------------------------- */

async function secretKey(env, settings) {
  let secret = settings.cookieSecret;
  if (!secret) {
    secret = randomHex(32);
    await saveSettings(env, { cookieSecret: secret });
  }
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createSession(env, password) {
  const settings = await getSettings(env);
  if (!settings.adminPasswordHash) return { ok: false, reason: 'not_initialized' };

  const hash = await hashPassword(password, settings.adminSalt);
  if (!safeEqual(hash, settings.adminPasswordHash)) return { ok: false, reason: 'bad_password' };

  const payload = toB64Url(new TextEncoder().encode(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, n: randomHex(8) })));
  const key = await secretKey(env, settings);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return { ok: true, cookie: `${payload}.${toB64Url(sig)}`, maxAge: SESSION_TTL_MS / 1000 };
}

export async function verifySession(env, cookieValue) {
  const settings = await getSettings(env);
  if (!settings.adminPasswordHash || !cookieValue) return false;

  const [payload, sig] = String(cookieValue).split('.');
  if (!payload || !sig) return false;

  try {
    const key = await secretKey(env, settings);
    const ok = await crypto.subtle.verify('HMAC', key, fromB64Url(sig), new TextEncoder().encode(payload));
    if (!ok) return false;

    const data = JSON.parse(new TextDecoder().decode(fromB64Url(payload)));
    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

export function parseCookies(request) {
  const raw = request.headers.get('cookie') || '';
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function sessionCookie(value, maxAge) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Secure`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`;
}

export { COOKIE_NAME };
