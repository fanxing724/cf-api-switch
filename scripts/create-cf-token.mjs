/**
 * 用本机已登录的 wrangler OAuth 凭据，通过官方 API 创建一个
 * 供 GitHub Actions 使用的 Cloudflare API Token（Workers 编辑 + KV 编辑 + 账户只读）。
 *
 * 用法：node scripts/create-cf-token.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || 'e2bb8f38b80d147cba6938ca42813b00';

const candidates = [
  join(homedir(), '.wrangler', 'config', 'default.toml'),
  join(homedir(), 'AppData', 'Roaming', 'xdg.config', '.wrangler', 'config', 'default.toml'),
];
const configPath = candidates.find((p) => existsSync(p));
if (!configPath) {
  console.error('找不到 wrangler 配置文件，请先 npx wrangler login');
  process.exit(1);
}
const config = readFileSync(configPath, 'utf8');
const oauth = config.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
if (!oauth) {
  console.error(`在 ${configPath} 里没找到 oauth_token，请先 npx wrangler login`);
  process.exit(1);
}

const H = { Authorization: `Bearer ${oauth}`, 'Content-Type': 'application/json' };

const groupsRes = await fetch('https://api.cloudflare.com/client/v4/user/tokens/permission_groups', { headers: H });
const groupsData = await groupsRes.json();
if (!groupsData.success) {
  console.error('拉取权限组失败（OAuth 权限可能不足）:', JSON.stringify(groupsData.errors).slice(0, 300));
  process.exit(1);
}

const groups = groupsData.result || [];
const byName = (kw, edit) => groups.filter((g) => g.name.toLowerCase().includes(kw)).find((g) => (edit ? /edit|write/i.test(g.name) : /read/i.test(g.name)));
const workersEdit = byName('worker script', true) || byName('worker', true);
const kvEdit = byName('worker kv', true);
const accountRead = byName('account settings', false) || groups.find((g) => /account settings/i.test(g.name) && /read/i.test(g.name));

const picked = [workersEdit, kvEdit, accountRead].filter(Boolean);
if (!picked.length) {
  console.error('未能识别所需的权限组，请手动在控制台创建 API Token');
  process.exit(1);
}

console.log('将授予以下权限组:');
for (const p of picked) console.log(`  - ${p.name} (${p.id})`);

const body = {
  name: 'cf-api-switch-github-actions',
  policies: [
    {
      effect: 'allow',
      resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: '*' },
      permission_groups: picked.map((p) => ({ id: p.id })),
    },
  ],
};

const tokenRes = await fetch('https://api.cloudflare.com/client/v4/user/tokens', {
  method: 'POST',
  headers: H,
  body: JSON.stringify(body),
});
const data = await tokenRes.json();

if (data.success) {
  console.log('\n✅ 创建成功。以下两个值填进 GitHub 仓库 Secrets：');
  console.log('\n  CLOUDFLARE_API_TOKEN =');
  console.log('  ' + data.result.value);
  console.log('\n  CLOUDFLARE_ACCOUNT_ID =');
  console.log('  ' + ACCOUNT);
  console.log('\n地址: https://github.com/fanxing724/cf-api-switch/settings/secrets/actions');
} else {
  console.error('\n创建失败:', JSON.stringify(data.errors, null, 2).slice(0, 800));
}
