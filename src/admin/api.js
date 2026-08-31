/**
 * 管理面板后端 API
 *
 * 全部挂在 /_admin/api 下，除 login / init / session 外都需要登录态。
 */

import {
  listChannels,
  upsertChannel,
  deleteChannel,
  getChannelById,
  getSettings,
  saveSettings,
  maskKey,
  storageMode,
  buildUpstreamUrl,
  normalizeChannel,
} from '../store.js';
import { buildHeaders, buildRequest } from '../channels.js';
import { VENDOR_LIST, resolveApiVersion } from '../vendors/index.js';
import { createSession, verifySession, parseCookies, sessionCookie, clearCookie, setAdminPassword, COOKIE_NAME } from '../auth.js';
import { getStats } from '../stats.js';
import { jsonResponse } from '../util.js';

const PUBLIC_ROUTES = new Set(['login', 'init', 'session']);

export async function handleAdminApi(request, env, segs) {
  const action = segs[0] || '';
  const cors = {
    'Access-Control-Allow-Origin': new URL(request.url).origin,
    'Access-Control-Allow-Credentials': 'true',
    'Cache-Control': 'no-store',
  };

  const settings = await getSettings(env);
  const cookies = parseCookies(request);
  const authed = await verifySession(env, cookies[COOKIE_NAME]);

  if (!PUBLIC_ROUTES.has(action) && !authed) {
    // 未初始化密码时给一个明确的引导，而不是笼统的 401
    const reason = settings.adminPasswordHash ? 'not_authenticated' : 'not_initialized';
    return jsonResponse({ error: reason }, 401, cors);
  }

  try {
    switch (action) {
      case 'session':
        return jsonResponse(
          { authenticated: authed, initialized: !!settings.adminPasswordHash, storage: storageMode(env) },
          200,
          cors,
        );

      case 'init': {
        if (settings.adminPasswordHash) return jsonResponse({ error: 'already_initialized' }, 400, cors);
        const body = await readJson(request);
        if (!body?.password || String(body.password).length < 6) {
          return jsonResponse({ error: '密码至少 6 位' }, 400, cors);
        }
        if (storageMode(env) !== 'kv') {
          return jsonResponse({ error: '未绑定 KV，无法持久化管理员密码。请先在 wrangler.toml 配置 kv_namespaces 并部署。' }, 400, cors);
        }
        await setAdminPassword(env, body.password);
        const session = await createSession(env, body.password);
        return jsonResponse({ ok: true }, 200, { ...cors, 'Set-Cookie': sessionCookie(session.cookie, session.maxAge) });
      }

      case 'login': {
        const body = await readJson(request);
        const session = await createSession(env, body?.password || '');
        if (!session.ok) return jsonResponse({ error: session.reason === 'not_initialized' ? '尚未设置管理员密码' : '密码错误' }, 401, cors);
        return jsonResponse({ ok: true }, 200, { ...cors, 'Set-Cookie': sessionCookie(session.cookie, session.maxAge) });
      }

      case 'logout':
        return jsonResponse({ ok: true }, 200, { ...cors, 'Set-Cookie': clearCookie() });

      case 'vendors':
        return jsonResponse({ vendors: VENDOR_LIST }, 200, cors);

      case 'probe': {
        // 不依赖已保存渠道：直接用表单里的临时值去上游探测（拉模型 / 测连通）。
        // 传了 id 则优先用服务器上已保存的渠道，表单里新填的字段再覆盖。
        const body = await readJson(request) || {};
        if (!body.id && !body.baseUrl) {
          return jsonResponse({ error: '请先填写上游地址（或选择已保存的渠道）' }, 400, cors);
        }

        let channel = null;
        if (body.id) channel = await getChannelById(env, body.id);
        if (!channel) channel = normalizeChannel({ name: 'probe', slug: 'probe' });
        if (body.baseUrl !== undefined && body.baseUrl !== '') channel.baseUrl = body.baseUrl;
        if (body.apiKey !== undefined && body.apiKey !== '') channel.apiKey = body.apiKey;
        if (body.vendor !== undefined && body.vendor !== '') channel.vendor = body.vendor;
        if (body.apiVersion !== undefined) channel.apiVersion = body.apiVersion;
        if (body.dropParams !== undefined) channel.dropParams = body.dropParams;

        const op = segs[1];
        if (op === 'models') return jsonResponse(await fetchUpstreamModels(channel), 200, cors);
        if (op === 'test') return jsonResponse(await testChannel(channel), 200, cors);
        return jsonResponse({ error: 'probe 需要 models 或 test 操作' }, 404, cors);
      }

      case 'channels': {
        if (request.method === 'GET') {
          const list = await listChannels(env);
          // stats 逐渠道并行拉取，渠道多时面板不被串行 KV 读拖慢
          const withStats = await Promise.all(
            list.map(async (ch) => ({ ...redact(ch), stats: await getStats(env, ch.id) })),
          );
          return jsonResponse({ channels: withStats }, 200, cors);
        }
        if (request.method === 'POST') {
          const body = await readJson(request);
          if (!body) return jsonResponse({ error: '请求体必须是合法 JSON' }, 400, cors);
          const saved = await upsertChannel(env, body);
          return jsonResponse({ channel: redact(saved) }, 200, cors);
        }
        return jsonResponse({ error: 'method not allowed' }, 405, cors);
      }

      case 'channel': {
        const id = segs[1];
        const op = segs[2];

        if (request.method === 'DELETE' && !op) {
          const ok = await deleteChannel(env, id);
          return jsonResponse({ ok }, ok ? 200 : 404, cors);
        }

        if (op === 'test' && request.method === 'POST') {
          const channel = await getChannelById(env, id);
          if (!channel) return jsonResponse({ error: '渠道不存在' }, 404, cors);
          return jsonResponse(await testChannel(channel), 200, cors);
        }

        if (op === 'toggle' && request.method === 'POST') {
          const channel = await getChannelById(env, id);
          if (!channel) return jsonResponse({ error: '渠道不存在' }, 404, cors);
          const saved = await upsertChannel(env, { ...channel, enabled: !channel.enabled });
          return jsonResponse({ channel: redact(saved) }, 200, cors);
        }

        if (op === 'models' && request.method === 'GET') {
          const channel = await getChannelById(env, id);
          if (!channel) return jsonResponse({ error: '渠道不存在' }, 404, cors);
          return jsonResponse(await fetchUpstreamModels(channel), 200, cors);
        }

        return jsonResponse({ error: 'unknown operation' }, 404, cors);
      }

      case 'settings': {
        if (request.method === 'GET') {
          return jsonResponse(
            { requireAuth: settings.requireAuth, clientKeys: settings.clientKeys, storage: storageMode(env) },
            200,
            cors,
          );
        }
        if (request.method === 'POST') {
          const body = await readJson(request) || {};
          const patch = {};
          if (typeof body.requireAuth === 'boolean') patch.requireAuth = body.requireAuth;
          if (Array.isArray(body.clientKeys)) patch.clientKeys = body.clientKeys.map((k) => String(k).trim()).filter(Boolean);
          await saveSettings(env, patch);
          return jsonResponse({ ok: true }, 200, cors);
        }
        return jsonResponse({ error: 'method not allowed' }, 405, cors);
      }

      case 'password': {
        if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405, cors);
        const body = await readJson(request);
        if (!body?.password || String(body.password).length < 6) {
          return jsonResponse({ error: '密码至少 6 位' }, 400, cors);
        }
        await setAdminPassword(env, body.password);
        return jsonResponse({ ok: true }, 200, cors);
      }

      default:
        return jsonResponse({ error: `unknown action: ${action}` }, 404, cors);
    }
  } catch (err) {
    return jsonResponse({ error: String(err?.message || err) }, 500, cors);
  }
}

/* ------------------------------------------------------------------ */

/** 面板返回的渠道里，API Key 一律掩码 */
function redact(channel) {
  return { ...channel, apiKey: maskKey(channel.apiKey), hasKey: !!channel.apiKey };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** 连通性测试：发一个极短的真实请求，看上游是否认这个 key */
async function testChannel(channel) {
  const url = buildUpstreamUrl(channel, 'chat/completions', resolveApiVersion(channel));
  const started = Date.now();

  // 没填模型就用一个通用名字，多数站点会因模型不存在返回 400/404——
  // 那也算「连通」，说明 key 通过了鉴权层。
  const model = channel.models?.[0] || 'gpt-4o-mini';
  const payload = {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
    stream: false,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(channel),
      body: JSON.stringify(payload),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(20000) : undefined,
    });
    const latency = Date.now() - started;
    const text = await res.text().catch(() => '');
    const parsed = safeParse(text);

    if (res.ok) {
      return { ok: true, status: res.status, latency, message: '连通正常，上游返回了完整响应' };
    }

    const msg = parsed?.error?.message || parsed?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    const authFailed = res.status === 401 || res.status === 403 || /key|auth|token|unauthor/i.test(msg);
    return {
      ok: !authFailed,
      status: res.status,
      latency,
      message: authFailed ? `鉴权失败：${msg}` : `已连通，但请求被拒：${msg}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latency: Date.now() - started,
      message: err?.name === 'TimeoutError' ? '请求超时（20s）' : `网络错误：${err?.message || err}`,
    };
  }
}

/** 拉取上游真实模型列表，面板上一键回填 */
async function fetchUpstreamModels(channel) {
  const url = buildUpstreamUrl(channel, 'models', resolveApiVersion(channel));
  try {
    // 轻量 GET，固定 20s 超时，防止上游挂起吊死面板请求
    const res = await fetch(url, {
      headers: buildHeaders(channel),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(20000) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, message: `上游返回 ${res.status}: ${text.slice(0, 200)}` };
    }
    const json = await res.json();
    const ids = (json?.data || []).map((m) => m.id || m.name).filter(Boolean);
    return { ok: true, models: ids };
  } catch (err) {
    return { ok: false, message: err?.name === 'TimeoutError' ? '拉取模型超时（20s）' : String(err?.message || err) };
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
