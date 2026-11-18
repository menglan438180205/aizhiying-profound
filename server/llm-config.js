'use strict';
/* =========================================================
   llm-config.js — 全栈大模型配置中心（后台管理）
   ---------------------------------------------------------
   为什么要有这一层：
     评论仿写、GEO 资产页、质检、文案……原来各自读 store.llm_cfg，
     只有一个模型、只能全局开或关，改一次要重启理解半天。这里把它
     收敛成「一份配置表 + 按用途选模型」：

       llm_cfg = [ { id, name, provider, base_url, api_key, model,
                     temperature, max_tokens, timeout_ms,
                     purposes:[...], enabled, isDefault, lastTest } ]

       · purposes 决定哪个环节用它（comment/geo/qa/chat），空数组=所有环节
       · 同一用途有多条时：isDefault 优先，其次最近更新
       · api_key 只在服务端出现，出网一律脱敏（sk-****abcd）
       · 全部停用时，各业务模块自动回退模板/本地仿真，功能不中断

   旧数据兼容：
     2026-11 之前存的是单个对象 { provider, base_url, api_key, model }，
     load 时自动升级成一条 id='llm_legacy'、isDefault=true 的记录。

   环境变量兜底（无后台配置时的最后一道）：
     LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_TEMPERATURE
     标记 source='env'，后台页面会提示「来自环境变量，未入库」。
   ========================================================= */

const MAX_PROFILES = 12;

const PURPOSES = [
  { id: 'comment', name: '评论仿写', desc: '评论区获客：按作品标题生成像真人的回复' },
  { id: 'geo', name: 'GEO 内容', desc: 'GEO 引擎：资产页正文、标题与信源' },
  { id: 'qa', name: '质检打分', desc: 'GEO 质检与内容合规判断' },
  { id: 'chat', name: '通用对话', desc: '其余场景的通用补位模型' }
];
const PURPOSE_IDS = PURPOSES.map(function (p) { return p.id; });

function nowIso() { return new Date().toISOString(); }
function clamp(n, min, max, dft) {
  const v = Number(n);
  if (!isFinite(v)) return dft;
  return Math.max(min, Math.min(max, v));
}
function mask(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '****';
  return k.slice(0, Math.min(6, k.length - 4)) + '****' + k.slice(-4);
}
function normPurpose(v) {
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  const out = [];
  arr.forEach(function (x) {
    const k = String(x || '').trim().toLowerCase();
    if (PURPOSE_IDS.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k);
  });
  return out;
}
function chatUrl(base) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  return /\/chat\/completions$/i.test(b) ? b : (b + '/chat/completions');
}
function modelsUrl(base) {
  const b = String(base || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return b ? (b + '/models') : '';
}

/* 把一条记录补齐成标准结构（不校验必填，只做形状归一） */
function full(c, i) {
  const o = Object.assign({}, c || {});
  return {
    id: String(o.id || ('llm_' + (i + 1))),
    name: String(o.name || o.provider || o.model || ('模型 ' + (i + 1))).slice(0, 40),
    provider: String(o.provider || 'custom').slice(0, 30),
    base_url: String(o.base_url || o.baseUrl || '').trim().slice(0, 300),
    api_key: String(o.api_key || o.apiKey || '').trim().slice(0, 300),
    model: String(o.model || '').trim().slice(0, 100),
    temperature: clamp(o.temperature, 0, 2, 0.7),
    max_tokens: clamp(o.max_tokens || o.maxTokens, 64, 16384, 2048),
    timeout_ms: clamp(o.timeout_ms || o.timeoutMs, 5000, 300000, 60000),
    purposes: normPurpose(o.purposes || o.purpose),
    enabled: o.enabled !== false,
    isDefault: !!o.isDefault,
    createdAt: o.createdAt || nowIso(),
    updatedAt: o.updatedAt || nowIso(),
    lastTest: o.lastTest && typeof o.lastTest === 'object' ? o.lastTest : null
  };
}

function envCfg() {
  const base = String(process.env.LLM_BASE_URL || '').trim();
  const key = String(process.env.LLM_API_KEY || '').trim();
  const model = String(process.env.LLM_MODEL || '').trim();
  if (!base || !key || !model) return null;
  return {
    id: 'llm_env', name: '环境变量配置', provider: 'env',
    base_url: base, api_key: key, model: model,
    temperature: clamp(process.env.LLM_TEMPERATURE, 0, 2, 0.7),
    max_tokens: 2048, timeout_ms: 60000,
    purposes: [], enabled: true, isDefault: false,
    createdAt: '', updatedAt: '', lastTest: null, source: 'env'
  };
}

/** 读出并就地升级旧格式；返回内部记录数组（含明文 key，勿直接出网） */
function rows(store) {
  const raw = store && store.data && store.data.llm_cfg;
  let arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  let changed = false;
  arr = arr.filter(function (x) { return x && typeof x === 'object'; });
  const list = arr.map(function (c, i) {
    const before = JSON.stringify(c);
    const f = full(c, i);
    if (before !== JSON.stringify(f)) changed = true;
    return f;
  });
  /* 旧库只有一条但没有 id/isDefault 时，补成默认模型 */
  if (list.length && !list.some(function (x) { return x.isDefault; })) {
    list[0].isDefault = true;
    changed = true;
  }
  if (changed) {
    store.data.llm_cfg = list;
    try { store.save(true, 'llm_cfg'); } catch (e) {}
  }
  return list;
}

/** 按用途选一条可用模型：isDefault 优先，其次最近更新；env 兜底 */
function resolve(store, purpose) {
  const want = String(purpose || '').trim();
  const usable = rows(store).filter(function (c) {
    return c.enabled && c.base_url && c.api_key && c.model;
  });
  /* 先按用途筛；一个都没匹配上就回落到全部可用模型（默认模型即兜底），
     否则「新增一个评论专用模型」会让 GEO 直接失去模型 —— 那是配置事故，不是功能。 */
  let list = want ? usable.filter(function (c) {
    return !c.purposes.length || c.purposes.indexOf(want) >= 0;
  }) : usable.slice();
  if (!list.length) list = usable.slice();
  if (list.length) {
    /* 选法：给定了用途时「专用」优先于「通用」—— 否则一个 isDefault 的
       全用途模型会把专用模型永远压住，按用途分配就白配了。
       同优先级里再比默认标记、最后比更新时间。 */
    const score = function (c) {
      if (!want) return 0;
      return c.purposes.length ? 2 : 1;
    };
    list.sort(function (a, b) {
      const sa = score(a), sb = score(b);
      if (sa !== sb) return sb - sa;
      if (!!b.isDefault !== !!a.isDefault) return b.isDefault ? 1 : -1;
      return (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0);
    });
    return list[0];
  }
  const env = envCfg();
  if (env && (!want || !env.purposes.length)) return env;
  return null;
}

function pub(c) {
  if (!c) return null;
  return {
    id: c.id, name: c.name, provider: c.provider,
    base_url: c.base_url, model: c.model,
    temperature: c.temperature, max_tokens: c.max_tokens, timeout_ms: c.timeout_ms,
    purposes: c.purposes || [], enabled: !!c.enabled, isDefault: !!c.isDefault,
    hasKey: !!c.api_key, keyMask: mask(c.api_key),
    lastTest: c.lastTest || null,
    createdAt: c.createdAt || '', updatedAt: c.updatedAt || '',
    source: c.source || 'store'
  };
}

function list(store) {
  const items = rows(store).map(pub);
  const env = envCfg();
  const active = resolve(store, '');
  return {
    items,
    purposes: PURPOSES,
    envConfigured: !!env,
    activeId: active ? active.id : '',
    activeName: active ? active.name : '',
    llmReady: !!active
  };
}

/** 保存一条（无 id 则新增）；apiKey 留空 = 保留原值 */
function save(store, body) {
  const b = body || {};
  const list0 = rows(store);
  let id = String(b.id || '').trim();
  if (!id) {
    if (list0.length >= MAX_PROFILES) {
      return { error: { code: 'TOO_MANY', message: '最多配置 ' + MAX_PROFILES + ' 个模型，请先删掉不用的' } };
    }
    id = 'llm_' + Date.now().toString(36);
  }
  let cur = list0.filter(function (c) { return c.id === id; })[0] || null;
  if (!cur && b.id) return { error: { code: 'NOT_FOUND', message: '模型不存在，可能已被删除' } };

  const baseUrl = String(b.base_url != null ? b.base_url : (cur && cur.base_url) || '').trim();
  const keyIn = String(b.api_key != null ? b.api_key : '').trim();
  const apiKey = keyIn ? keyIn : (cur ? cur.api_key : '');
  const model = String(b.model != null ? b.model : (cur && cur.model) || '').trim();

  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    return { error: { code: 'BAD_BASE_URL', message: '接口地址要以 http:// 或 https:// 开头' } };
  }
  if (!apiKey) return { error: { code: 'NO_KEY', message: '缺少 API Key（已保存过的模型留空表示不修改）' } };
  if (!model) return { error: { code: 'NO_MODEL', message: '缺少模型名，例如 gpt-4o-mini / qwen-plus / deepseek-chat' } };

  const rec = full(Object.assign({}, cur || {}, {
    id: id,
    name: String(b.name != null ? b.name : (cur && cur.name) || '').trim() || model,
    provider: String(b.provider != null ? b.provider : (cur && cur.provider) || 'custom').trim() || 'custom',
    base_url: baseUrl,
    api_key: apiKey,
    model: model,
    temperature: b.temperature != null ? b.temperature : (cur && cur.temperature),
    max_tokens: b.max_tokens != null ? b.max_tokens : (cur && cur.max_tokens),
    timeout_ms: b.timeout_ms != null ? b.timeout_ms : (cur && cur.timeout_ms),
    purposes: b.purposes != null ? b.purposes : (cur && cur.purposes) || [],
    enabled: b.enabled != null ? !!b.enabled : (cur ? cur.enabled : true),
    isDefault: b.isDefault != null ? !!b.isDefault : (cur ? cur.isDefault : false),
    updatedAt: nowIso(),
    createdAt: (cur && cur.createdAt) || nowIso()
  }), 0);

  /* 设为默认 → 其他条取消默认；第一条自动成为默认 */
  if (rec.isDefault) list0.forEach(function (c) { c.isDefault = false; });
  const next = list0.filter(function (c) { return c.id !== id; });
  next.push(rec);
  if (!next.some(function (c) { return c.isDefault; })) next[0].isDefault = true;

  store.data.llm_cfg = next;
  store.save(true, 'llm_cfg');
  return { item: pub(rec), list: list(store) };
}

function remove(store, id) {
  const list0 = rows(store);
  const target = list0.filter(function (c) { return c.id === id; })[0];
  if (!target) return { error: { code: 'NOT_FOUND', message: '模型不存在' } };
  const next = list0.filter(function (c) { return c.id !== id; });
  if (next.length && !next.some(function (c) { return c.isDefault; })) next[0].isDefault = true;
  store.data.llm_cfg = next;
  store.save(true, 'llm_cfg');
  return { removed: id, list: list(store) };
}

function enable(store, id, on) {
  const list0 = rows(store);
  const c = list0.filter(function (x) { return x.id === id; })[0];
  if (!c) return { error: { code: 'NOT_FOUND', message: '模型不存在' } };
  c.enabled = !!on;
  c.updatedAt = nowIso();
  if (c.enabled && !list0.some(function (x) { return x.isDefault && x.enabled; })) c.isDefault = true;
  store.data.llm_cfg = list0;
  store.save(true, 'llm_cfg');
  return { item: pub(c), list: list(store) };
}

function setDefault(store, id) {
  const list0 = rows(store);
  const c = list0.filter(function (x) { return x.id === id; })[0];
  if (!c) return { error: { code: 'NOT_FOUND', message: '模型不存在' } };
  list0.forEach(function (x) { x.isDefault = x.id === id; });
  c.enabled = true;
  c.updatedAt = nowIso();
  store.data.llm_cfg = list0;
  store.save(true, 'llm_cfg');
  return { list: list(store) };
}

/** 真实调一次 chat/completions：延迟、回显、用量都带回来 */
async function test(store, opt) {
  const o = opt || {};
  const inline = o.base_url || o.api_key || o.model;
  let cfg;
  if (inline) {
    const cur = o.id ? rows(store).filter(function (c) { return c.id === o.id; })[0] : null;
    cfg = {
      base_url: String(o.base_url != null ? o.base_url : (cur && cur.base_url) || '').trim(),
      api_key: String(o.api_key || (cur && cur.api_key) || '').trim(),
      model: String(o.model != null ? o.model : (cur && cur.model) || '').trim(),
      temperature: 0,
      max_tokens: 32,
      timeout_ms: clamp(o.timeout_ms, 5000, 120000, 30000)
    };
  } else {
    cfg = resolve(store, o.purpose || '');
  }
  if (!cfg || !cfg.base_url || !cfg.api_key || !cfg.model) {
    return { ok: false, error: '还没有可用的模型配置：先填接口地址、API Key 和模型名' };
  }
  const url = chatUrl(cfg.base_url);
  const ctl = new AbortController();
  const timeout = cfg.timeout_ms || 30000;
  const timer = setTimeout(function () { ctl.abort(); }, timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.api_key },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: '你是连通性探针，只回复两个字：可用' },
          { role: 'user', content: 'ping' }
        ],
        temperature: 0,
        max_tokens: 16,
        stream: false
      }),
      signal: ctl.signal
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    const txt = await res.text().catch(function () { return ''; });
    let j = null;
    try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = null; }
    if (!res.ok) {
      return { ok: false, ms: ms, model: cfg.model, error: 'HTTP ' + res.status + ' ' + String(txt || '').slice(0, 240) };
    }
    const content = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    return {
      ok: true, ms: ms, model: (j && j.model) || cfg.model,
      reply: String(content).slice(0, 80),
      usage: (j && j.usage) || null,
      url: url
    };
  } catch (e) {
    clearTimeout(timer);
    const msg = String((e && e.message) || e);
    return {
      ok: false, ms: Date.now() - t0, model: cfg.model,
      error: /abort/i.test(msg) ? ('超时（' + Math.round(timeout / 1000) + ' 秒）') : msg
    };
  }
}

/** 拉模型列表（很多网关不实现，失败不算错）
    inline 允许表单还没保存时就拉：{ base_url, api_key } */
async function models(store, id, inline) {
  let cfg = null;
  if (inline && inline.base_url) {
    const cur = id ? rows(store).filter(function (c) { return c.id === id; })[0] : null;
    cfg = {
      base_url: String(inline.base_url || '').trim(),
      api_key: String(inline.api_key || (cur && cur.api_key) || '').trim()
    };
  } else {
    cfg = id ? rows(store).filter(function (c) { return c.id === id; })[0] : resolve(store, '');
  }
  if (!cfg || !cfg.base_url || !cfg.api_key) return { ok: false, items: [], error: '配置不完整（需要接口地址 + API Key）' };
  const url = modelsUrl(cfg.base_url);
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, 15000);
  try {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + cfg.api_key }, signal: ctl.signal });
    clearTimeout(timer);
    const j = await res.json().catch(function () { return null; });
    if (!res.ok) return { ok: false, items: [], error: 'HTTP ' + res.status };
    const arr = (j && (j.data || j.models)) || [];
    const items = arr.map(function (x) { return String((x && (x.id || x.name)) || '') }).filter(Boolean).slice(0, 200);
    return { ok: true, items: items, url: url };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, items: [], error: String((e && e.message) || e) };
  }
}

/** 记录最近一次测试结果（列表页显示「上次可用 · 320ms」） */
function markTest(store, id, r) {
  const list0 = rows(store);
  const c = list0.filter(function (x) { return x.id === id; })[0];
  if (!c) return;
  c.lastTest = { ok: !!r.ok, ms: r.ms || 0, at: nowIso(), msg: String(r.error || r.reply || '').slice(0, 160) };
  store.data.llm_cfg = list0;
  store.save(true, 'llm_cfg');
}

/* ---------------- 旧接口兼容（/v1/geo2/llm 与 /v1/geop/llm 的单表单） ----------------
   老前端只认 baseUrl/apiKey/model 三个字段，写的是「全局唯一模型」。
   这里把它翻译成默认模型：已有默认就更新它，没有就新建一条。 */
function saveLegacy(store, b) {
  const body = b || {};
  const baseUrl = String(body.baseUrl || body.base_url || '').trim();
  const apiKey = String(body.apiKey || body.api_key || '').trim();
  const model = String(body.model || '').trim();
  if (!baseUrl && !apiKey && !model) return disableAll(store);
  const cur = resolve(store, 'geo') || resolve(store, '');
  return save(store, {
    id: (cur && cur.source !== 'env') ? cur.id : '',
    name: (cur && cur.name) || (model || '默认模型'),
    provider: body.provider || (cur && cur.provider) || 'custom',
    base_url: baseUrl || (cur && cur.base_url) || '',
    api_key: apiKey || '',
    model: model || (cur && cur.model) || '',
    temperature: body.temperature,
    max_tokens: body.maxTokens || body.max_tokens,
    timeout_ms: body.timeoutMs || body.timeout_ms,
    purposes: [],
    isDefault: true
  });
}

/** 全部停用（旧语义「清空」）：业务模块自动回退模板，配置记录本身不丢 */
function disableAll(store) {
  const list0 = rows(store);
  list0.forEach(function (c) { c.enabled = false; c.updatedAt = nowIso(); });
  store.data.llm_cfg = list0;
  store.save(true, 'llm_cfg');
  return { list: list(store), disabled: list0.length };
}

module.exports = {
  PURPOSES, PURPOSE_IDS, rows, resolve, list, pub, save, remove, enable, setDefault,
  test, models, markTest, mask, chatUrl, modelsUrl, envCfg, saveLegacy, disableAll
};
