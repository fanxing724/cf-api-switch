/**
 * 厂商适配器
 *
 * 各家站点本质上都是 OpenAI 兼容的 chat 格式，差异集中在三处：
 *   1. URL 版本段的写法
 *   2. 不支持 / 行为不同的参数
 *   3. 响应里多出来的字段（如思维链）
 *
 * 因此这里不做整套重写，只针对差异点打补丁，默认走 generic。
 */

const generic = {
  name: 'generic',
  label: '通用 OpenAI 兼容',
  hint: 'NewAPI / one-api / 各类中转站，以及大部分国产大模型官方接口',
  apiVersion: 'v1',
  /** 默认填入面板的 baseUrl 占位提示 */
  basePlaceholder: 'https://api.example.com/v1',

  transformRequest(payload) {
    return payload;
  },

  extraHeaders() {
    return {};
  },
};

const deepseek = {
  ...generic,
  name: 'deepseek',
  label: 'DeepSeek',
  hint: '官方接口。R1 系列会返回 reasoning_content 思维链，会自动映射成新协议的 reasoning 项',
  basePlaceholder: 'https://api.deepseek.com',

  transformRequest(payload) {
    const out = { ...payload };

    // R1 系列官方建议不要传 temperature / top_p，传了会被忽略或影响推理质量
    const model = String(out.model || '');
    if (model.includes('reasoner') || model.includes('r1')) {
      delete out.temperature;
      delete out.top_p;
    }

    // DeepSeek 不支持这两个参数
    delete out.logit_bias;
    delete out.n;

    return out;
  },
};

const ark = {
  ...generic,
  name: 'ark',
  label: '火山方舟（豆包）',
  hint: '模型名请填方舟控制台里的接入点 ID（ep-xxxxxxxx）',
  apiVersion: '', // 版本号已在 base 里：/api/v3
  basePlaceholder: 'https://ark.cn-beijing.volces.com/api/v3',

  transformRequest(payload) {
    const out = { ...payload };
    // 方舟部分模型不支持这两个字段
    delete out.logit_bias;
    delete out.user;
    return out;
  },
};

const REGISTRY = { generic, deepseek, ark };

export function getVendor(name) {
  return REGISTRY[name] || generic;
}

export const VENDOR_LIST = Object.values(REGISTRY).map(({ name, label, hint, basePlaceholder }) => ({
  name,
  label,
  hint,
  basePlaceholder,
}));
