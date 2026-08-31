/**
 * 重置（或首次设置）管理面板密码，直接写入 Workers KV。
 *
 * 用法：
 *   node scripts/reset-admin-password.mjs                 # 生成随机密码并写入线上 KV
 *   node scripts/reset-admin-password.mjs myPassword      # 用指定密码
 *   node scripts/reset-admin-password.mjs myPassword local # 写入本地 dev 的 KV
 *
 * 为什么需要它：面板的 /_admin/api/init 是公开的，谁先访问谁就是管理员。
 * 部署后如果没能立刻初始化，就存在被抢占的窗口。用这个脚本可以离线把密码写进去，
 * 完全不经过 HTTP，窗口直接关闭。
 *
 * 算法必须与 src/auth.js 保持一致：PBKDF2-SHA256，100000 轮，256 位。
 */

import { webcrypto as crypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const PBKDF2_ITERATIONS = 100000;

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function generatePassword(len = 20) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => chars[b % chars.length]).join('');
}

const argv = process.argv.slice(2);
const target = argv.find((a) => a === 'local') ? '--local' : null;
const explicit = argv.find((a) => a !== 'local');

const password = explicit || generatePassword();
if (password.length < 6) {
  console.error('密码至少 6 位');
  process.exit(1);
}

const salt = randomHex(16);
const hash = await hashPassword(password, salt);
const settings = {
  adminPasswordHash: hash,
  adminSalt: salt,
  cookieSecret: randomHex(32),
  clientKeys: [],
  requireAuth: false,
};

const args = ['npx', 'wrangler', 'kv', 'key', 'put', '--binding', 'KV', 'settings', JSON.stringify(settings)];
if (target) args.push(target);

try {
  execFileSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', args.join(' ')], {
    stdio: 'pipe',
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  });
} catch (err) {
  console.error('写入 KV 失败：', err.stderr?.toString() || err.message);
  process.exit(1);
}

console.log('\n管理面板密码已写入 KV' + (target ? '（本地）' : '（线上）'));
console.log(`\n  密码：${password}\n`);
if (!explicit) console.log('  这是随机生成的，登录后可自行修改。请立即保存。\n');
