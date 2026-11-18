'use strict';
/* =========================================================
   geo.js — GEO（生成式引擎优化）AI 关键词监测层
   ---------------------------------------------------------
   职责：
     · 定义「AI 引擎」与「关键词监测」的统一契约
     · 真实上游转发（GEO_UPSTREAM + GEO_TOKEN）
     · 未配置上游时明确返回 501，不静默造数
     · 定时调度 + 变化检测（排名升降 / 新收录 / 掉出）→ 供 SSE 实时推送
     · 排名历史落点，供趋势图使用

   真实上游契约（生产方按此实现即可对接）：
     POST {GEO_UPSTREAM}/v1/geo/monitor
       Header  Authorization: Bearer <GEO_TOKEN>
       Body    { keyword, engines: ["doubao", ...], locale: "zh-CN" }
       Resp    { data: { results: [ { engine, rank, status, snippet, cited, at } ] } }
     其中 rank 为 1..N 的推荐排名（0 / null 表示未收录）；
     status ∈ covered | partial | absent

   ========================================================= */

const tenantMod = require('./tenant');   /* K1：任务归属租户 */

const ENGINE_LIST = [
  { id: 'doubao',   name: '豆包',       short: '豆', tone: '#4C3FE4,#8B5CF6', vendor: '字节跳动', weight: 1.00 },
  { id: 'yuanbao',  name: '腾讯元宝',    short: '元', tone: '#00a0e9,#0068d6', vendor: '腾讯',     weight: 0.94 },
  { id: 'wenxin',   name: '文心一言',    short: '文', tone: '#4285f4,#2b6cd4', vendor: '百度',     weight: 0.90 },
  { id: 'tongyi',   name: '通义千问',    short: '通', tone: '#F5A524,#D98A00', vendor: '阿里',     weight: 0.86 },
  { id: 'deepseek', name: 'DeepSeek',   short: 'D',  tone: '#161528,#3b4a6b', vendor: '深度求索', weight: 0.82 },
  { id: 'kimi',     name: 'Kimi',       short: 'K',  tone: '#8B5CF6,#5a2fd6', vendor: '月之暗面', weight: 0.78 }
];

const ENGINE_IDS = ENGINE_LIST.map((e) => e.id);

const INTERVAL = { '15m': 15 * 60e3, '30m': 30 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 };

const UPSTREAM = () => (process.env.GEO_UPSTREAM || '').replace(/\/+$/, '');
const TOKEN = () => process.env.GEO_TOKEN || '';
const TIMEOUT = Number(process.env.GEO_TIMEOUT_MS || 20000);
const ALLOW_LOCAL = () => require('./demo').allowLocalGeo();
/* 路径C：人工录入模式。设为 manual 时，监测轮次不再调用任何上游，
   而是接受「从透镜GEO免费版看到的真实结论」经 /v1/geo/manual 直接落盘。
   优先级：manual > upstream > local > unconfigured。 */
const GEO_MODE = () => (process.env.GEO_MODE || '').toLowerCase();

/* ---------------- 工具 ---------------- */

function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function rand01(seed) {
  // mulberry32：同一 seed 恒定输出，保证「同一关键词同一天结果稳定」
  let t = (seed + 0x6D2B79F5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function dayIndex(ts) {
  return Math.floor((ts || Date.now()) / 86400000);
}

function engineOf(id) {
  return ENGINE_LIST.filter((e) => e.id === id)[0] || null;
}

function statusOf(rank) {
  if (!rank || rank <= 0) return 'absent';
  return rank <= 5 ? 'covered' : 'partial';
}

/* 内容形态：AI 引用时的呈现位置，用于前端展示「引用片段」 */
const SNIPPET_TPL = [
  '{kw} 方面，可关注具备自有织造与现货仓的厂家，交付周期更可控。',
  '关于 {kw}，建议优先选择提供免费色卡与打样的供应商。',
  '{kw} 的常见误区是只看单价，实际需综合克重、色牢度与起订量。',
  '在 {kw} 领域，具备 OEKO-TEX 等认证的厂商更值得合作。',
  '若关注 {kw}，可对比纱线密度与后整理工艺，再看批量交付能力。'
];

/* ---------------- 真实上游 ---------------- */

/**
 * 执行一次监测（走真实上游）
 * @returns {Promise<{status:number, body:object}>}
 */
async function monitor(payload, reqHeaders) {
  const up = UPSTREAM();
  if (!up) {
    return {
      status: 501,
      body: {
        ok: false,
        code: 'UPSTREAM_NOT_CONFIGURED',
        message: '本服务未接入 AI 关键词监测通道。请在服务端配置 GEO_UPSTREAM（监测服务地址）与 GEO_TOKEN（鉴权令牌）后重试。',
        contract: 'POST {GEO_UPSTREAM}/v1/geo/monitor  Body { keyword, engines, locale }  Resp { data: { results: [{ engine, rank, status, snippet, at }] } }'
      }
    };
  }
  const token = TOKEN() || String((reqHeaders && reqHeaders['x-geo-token']) || '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(up + '/v1/geo/monitor', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {}),
      body: JSON.stringify({
        keyword: payload.keyword,
        engines: (payload.engines && payload.engines.length) ? payload.engines : ENGINE_IDS,
        locale: payload.locale || 'zh-CN'
      }),
      signal: ctl.signal
    });
    clearTimeout(timer);
    let json = null;
    try { json = await res.json(); } catch (e) {}
    if (!res.ok) {
      return { status: 502, body: { ok: false, code: 'UPSTREAM_ERROR', upstreamStatus: res.status, message: '监测服务返回错误', raw: json } };
    }
    return { status: 200, body: { ok: true, source: 'upstream', upstream: up, data: { results: normalize(json, payload) } } };
  } catch (e) {
    clearTimeout(timer);
    const ab = e && e.name === 'AbortError';
    return { status: 504, body: { ok: false, code: ab ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE', message: ab ? '监测服务超时' : String((e && e.message) || e) } };
  }
}

/** 多别名归一化：兼容 results / list / items / data / engines 等结构 */
function normalize(json, payload) {
  if (!json) return [];
  let arr = null;
  const probes = [
    json.data && json.data.results, json.data && json.data.list, json.data && json.data.items,
    json.results, json.list, json.items, json.engines,
    Array.isArray(json.data) ? json.data : null, Array.isArray(json) ? json : null
  ];
  for (const p of probes) { if (Array.isArray(p)) { arr = p; break; } }
  if (!arr) return [];
  const wanted = (payload && payload.engines && payload.engines.length) ? payload.engines : ENGINE_IDS;
  const out = [];
  for (const eid of wanted) {
    const hit = arr.filter((r) => String(r.engine || r.id || r.name || '').toLowerCase().indexOf(eid) > -1)[0];
    const rank = hit ? Number(hit.rank || hit.position || hit.pos || 0) || 0 : 0;
    out.push({
      engine: eid,
      rank,
      status: (hit && hit.status) || statusOf(rank),
      snippet: (hit && (hit.snippet || hit.quote || hit.text)) || '',
      cited: !!(hit && (hit.cited || hit.mentioned)),
      at: (hit && (hit.at || hit.time)) || new Date().toISOString()
    });
  }
  return out;
}

/** 上游健康检查 */
async function upstreamHealth() {
  const up = UPSTREAM();
  if (!up) return { configured: false, ok: false, message: '未配置 GEO_UPSTREAM' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(up + '/v1/health', {
      headers: TOKEN() ? { Authorization: 'Bearer ' + TOKEN() } : {}, signal: ctl.signal
    });
    clearTimeout(timer);
    return { configured: true, ok: res.ok, status: res.status, upstream: up };
  } catch (e) {
    clearTimeout(timer);
    return { configured: true, ok: false, upstream: up, message: String((e && e.message) || e) };
  }
}

/* ---------------- 本地探测（仅 ALLOW_LOCAL_GEO=1 时启用） ---------------- */

/**
 * 确定性本地探测：同一 (关键词, 引擎, 天) 恒定输出，随天数推进逐步改善。
 * 这不是真实抓取，只用于在没有监测上游时跑通「任务 → 轮次 → 变化流 → 趋势」链路。
 */
function localProbe(payload) {
  const kw = String((payload && payload.keyword) || '').trim() || '抖音代运营';
  const engines = (payload && payload.engines && payload.engines.length) ? payload.engines : ENGINE_IDS;
  const day = dayIndex();
  const results = engines.map((eid) => {
    const eng = engineOf(eid) || { weight: 0.8 };
    const base = rand01(hash32(kw + '|' + eid));
    // 关键词自身的「优化上限」：hash 决定该词能不能被这个引擎收录
    const ceiling = 0.34 + base * 0.62;
    // 曝光随天数缓慢爬升（模拟内容建设见效）
    const maturity = Math.min(1, 0.25 + (day % 90) * 0.008);
    const score = ceiling * eng.weight * maturity + rand01(hash32(kw + '|' + eid + '|' + day)) * 0.34;
    let rank = 0;
    if (score > 0.72) rank = 1 + Math.floor(rand01(hash32('r' + kw + eid + day)) * 3);
    else if (score > 0.55) rank = 4 + Math.floor(rand01(hash32('r' + kw + eid + day)) * 4);
    else if (score > 0.40) rank = 8 + Math.floor(rand01(hash32('r' + kw + eid + day)) * 5);
    return {
      engine: eid,
      rank,
      status: statusOf(rank),
      snippet: rank ? SNIPPET_TPL[hash32(kw + eid) % SNIPPET_TPL.length].replace(/\{kw\}/g, kw) : '',
      cited: rank > 0 && rank <= 8,
      at: new Date().toISOString()
    };
  });
  return {
    status: 200,
    body: {
      ok: true, source: 'local-simulated',
      warning: '本地模拟监测数据，非真实 AI 引擎抓取',
      data: { results }
    }
  };
}

/* ---------------- 内容方案（可用于产出 GEO 内容建设清单） ---------------- */

const PLAN_TPL = [
  { type: '行业问答长文', platform: '知乎 + 百家号', why: 'AI 最常引用的问答型内容', items: ['「{kw}」选型避坑指南', '{kw} 报价构成拆解', '{kw} 与常见替代品对比'] },
  { type: '结构化产品页', platform: '官网 + schema.org', why: '让引擎抓到参数与联系方式', items: ['产品参数表（克重/门幅/色牢度）', '起订量与交期说明', 'OEM 定制流程'] },
  { type: '客户案例与实拍', platform: '小红书 + 视频号', why: '真实场景图引用率最高', items: ['{kw} 落地实拍 9 图', '客户案例：从打样到量产', '工厂产线实拍'] },
  { type: '权威背书', platform: '行业媒体 / 展会报道', what: '', items: ['OEKO-TEX 等认证展示', '行业展会参展报道', '企业百科词条完善'] }
];

function buildPlan(keyword) {
  const kw = String(keyword || '').trim() || '抖音代运营';
  return PLAN_TPL.map((t, i) => ({
    id: 'p' + (i + 1),
    type: t.type,
    platform: t.platform,
    why: t.why,
    items: t.items.map((x) => x.replace(/\{kw\}/g, kw)),
    priority: i === 0 ? 'P0' : (i === 1 ? 'P0' : (i === 2 ? 'P1' : 'P2')),
    eta: ['3 天', '5 天', '7 天', '14 天'][i] || '7 天'
  }));
}

/* ---------------- 变化检测 ---------------- */

/**
 * 对比上一轮结果，产出「变化事件」（供实时推送）
 * @param {object} prev 上一轮 { engine: {rank, status} }
 * @param {Array}  next 本轮 results
 */
function diff(prev, next, keyword) {
  const changes = [];
  const at = new Date().toISOString();
  for (const r of (next || [])) {
    const p = prev && prev[r.engine];
    const pr = p ? Number(p.rank || 0) : 0;
    const nr = Number(r.rank || 0);
    if (pr === 0 && nr > 0) {
      changes.push({ at, keyword, engine: r.engine, kind: 'new', from: 0, to: nr, text: '首次被收录，排名第 ' + nr });
    } else if (pr > 0 && nr === 0) {
      changes.push({ at, keyword, engine: r.engine, kind: 'lost', from: pr, to: 0, text: '掉出 AI 答案（原排名第 ' + pr + '）' });
    } else if (pr > 0 && nr > 0 && nr !== pr) {
      const up = nr < pr;
      changes.push({
        at, keyword, engine: r.engine, kind: up ? 'up' : 'down',
        from: pr, to: nr, text: (up ? '排名上升 ' : '排名下降 ') + Math.abs(pr - nr) + ' 位（' + pr + ' → ' + nr + '）'
      });
    }
  }
  return changes;
}

/* ---------------- 定时调度 ---------------- */

class GeoScheduler {
  /**
   * @param {object} store  Store 实例
   * @param {object} opt    { onEvent(evt), onLog(lv,msg) }
   */
  constructor(store, opt) {
    this.store = store;
    this.opt = opt || {};
    this.timer = null;
    this.running = false;
    this.lastTickAt = 0;
    this.clients = new Set();     // SSE 订阅者
  }

  /* ---- 任务 CRUD ---- */
  tasks() { return this.store.data.geo_tasks || (this.store.data.geo_tasks = []); }
  task(id) { return this.tasks().filter((t) => t.id === id)[0] || null; }

  addTask(input) {
    const every = INTERVAL[input.every] ? input.every : '1h';
    const engines = (input.engines && input.engines.length ? input.engines : ENGINE_IDS).filter((e) => ENGINE_IDS.indexOf(e) > -1);
    const t = {
      id: this.store.nextId('gt'),
      keyword: String(input.keyword || '').trim().slice(0, 40),
      /* K1：监测任务的归属租户。执行时按它计量，不再一律记 default */
      tenant: tenantMod.norm(input.tenant),
      engines: engines.length ? engines : ENGINE_IDS.slice(),
      every,
      enabled: input.enabled !== false,
      alertDrop: Math.max(0, Math.min(20, Number(input.alertDrop) || 3)),
      alertNew: input.alertNew !== false,
      createdAt: new Date().toISOString(),
      lastRunAt: 0,
      nextRunAt: Date.now() + (INTERVAL[every] || INTERVAL['1h']),
      runs: 0,
      hits: 0
    };
    this.tasks().unshift(t);
    this.store.save(true, 'geo_tasks');
    return t;
  }

  updateTask(id, patch) {
    const t = this.task(id);
    if (!t) return null;
    if (patch.enabled != null) {
      t.enabled = !!patch.enabled;
      t.nextRunAt = t.enabled ? Date.now() + (INTERVAL[t.every] || 3600e3) : 0;
    }
    if (patch.every && INTERVAL[patch.every]) { t.every = patch.every; t.nextRunAt = Date.now() + INTERVAL[patch.every]; }
    if (patch.engines && patch.engines.length) t.engines = patch.engines.filter((e) => ENGINE_IDS.indexOf(e) > -1);
    if (patch.alertDrop != null) t.alertDrop = Number(patch.alertDrop) || 0;
    this.store.save(true, 'geo_tasks');
    return t;
  }

  removeTask(id) {
    const arr = this.tasks();
    const i = arr.findIndex((t) => t.id === id);
    if (i < 0) return false;
    arr.splice(i, 1);
    this.store.save(true, 'geo_tasks');
    return true;
  }

  /* ---- 运行记录 ---- */
  runs() { return this.store.data.geo_runs || (this.store.data.geo_runs = []); }
  points() { return this.store.data.geo_points || (this.store.data.geo_points = []); }
  changes() { return this.store.data.geo_changes || (this.store.data.geo_changes = []); }

  /* ---- 执行一轮 ---- */
  async runOnce(keyword, engines, meta) {
    meta = meta || {};
    /* K1：先定归属——任务自己的 tenant 最可信（管理员代跑也记在任务主名下），
       没有任务（临时监测）才用调用方传入的 tenant，最后兜底 default。 */
    const taskRec = meta.taskId ? this.task(meta.taskId) : null;
    const runTenant = tenantMod.norm((taskRec && taskRec.tenant) || meta.tenant);
    let res;
    if (meta.manual && Array.isArray(meta.results) && meta.results.length) {
      /* 人工录入通道（路径C）：results 已由调用方校验，直接落盘，不调任何上游 */
      res = { ok: true, status: 200, body: { ok: true, source: 'manual', data: { results: meta.results } } };
    } else {
      const payload = { keyword, engines };
      res = await monitor(payload, null);
      if (res.status === 501 && ALLOW_LOCAL()) res = localProbe(payload);
    }
    if (!res.ok && res.status !== 200) return { ok: false, status: res.status, code: res.body && res.body.code, message: res.body && res.body.message };

    const results = (res.body.data && res.body.data.results) || [];
    const src = res.body.source || 'upstream';

    /* 与上一轮对比 → 变化事件 */
    const key = String(keyword);
    const prev = this.lastByKeyword(key);
    const chs = diff(prev, results, key);
    const now = Date.now();
    const day = dayIndex(now);

    const run = {
      id: this.store.nextId('gr'),
      taskId: meta.taskId || '',
      tenant: runTenant,
      keyword: key,
      engines: engines.slice(),
      startedAt: new Date(now).toISOString(),
      ms: meta.ms || 0,
      source: src,
      results,
      changes: chs,
      covered: results.filter((r) => r.rank > 0).length
    };
    /* K4：轮次记录走 NDJSON 追加（cap 400 由 store 兜底） */
    this.store.push('geo_runs', run);
    /* 计费：一次 GEO 检测 = 1 次额度（无订阅时只记账不拦截）。
       K1：记在任务归属租户；K10：同一轮 run 只结算一次。 */
    try {
      if (this.opt.meter) {
        this.opt.meter('geo', 1, {
          keyword: key, runId: run.id,
          tenant: runTenant,
          dedupeKey: 'geo:' + run.id
        });
      }
    } catch (e) {}

    /* 排名落点（按天聚合，供趋势图） */
    for (const r of results) {
      const cur = this.points().filter((p) => p.keyword === key && p.engine === r.engine && p.day === day)[0];
      if (cur) { cur.rank = r.rank; cur.status = r.status; cur.at = now; }
      else this.points().unshift({ keyword: key, engine: r.engine, day, rank: r.rank, status: r.status, at: now });
    }
    if (this.points().length > 6000) this.points().length = 6000;

    /* 变化流 */
    for (const c of chs) {
      this.changes().unshift(c);
      this.emit({ type: 'change', data: c });
    }
    if (this.changes().length > 300) this.changes().length = 300;

    /* 命中统计 */
    const t = taskRec;
    if (t) {
      t.lastRunAt = now;
      t.runs = (t.runs || 0) + 1;
      t.hits = (t.hits || 0) + chs.length;
      if (t.enabled) t.nextRunAt = now + (INTERVAL[t.every] || 3600e3);
    }
    /* K4：只落盘本轮真正改动的三张表，不再整库重写 */
    this.store.save(false, 'geo_points');
    this.store.save(false, 'geo_changes');
    if (t) this.store.save(false, 'geo_tasks');

    this.emit({ type: 'run', data: { id: run.id, keyword: key, covered: run.covered, total: results.length, changes: chs.length, source: src } });
    this.log('info', '监测轮次完成：' + key + ' · 收录 ' + run.covered + '/' + results.length + ' · 变化 ' + chs.length);
    return { ok: true, run };
  }

  /** 取某关键词最近一轮的引擎排名（用于变化对比） */
  lastByKeyword(keyword) {
    const last = this.runs().filter((r) => r.keyword === keyword)[0];
    if (!last) return null;
    const map = {};
    for (const r of last.results) map[r.engine] = { rank: r.rank, status: r.status };
    return map;
  }

  /* ---- SSE ---- */
  subscribe(res, req) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    res.write('event: hello\ndata: ' + JSON.stringify({ at: new Date().toISOString(), engines: ENGINE_LIST.map((e) => e.id) }) + '\n\n');
    const client = { res, timer: null };
    client.timer = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
    if (client.timer.unref) client.timer.unref();
    this.clients.add(client);
    const clean = () => {
      clearInterval(client.timer);
      this.clients.delete(client);
    };
    req.on('close', clean);
    req.on('error', clean);
    res.on('error', clean);
    return client;
  }

  emit(evt) {
    const line = 'event: ' + evt.type + '\ndata: ' + JSON.stringify(evt.data) + '\n\n';
    for (const c of Array.from(this.clients)) {
      try { c.res.write(line); } catch (e) { this.clients.delete(c); }
    }
  }

  broadcastStats() {
    this.emit({ type: 'stats', data: this.stats() });
  }

  stats() {
    const tasks = this.tasks();
    return {
      tasks: tasks.length,
      enabled: tasks.filter((t) => t.enabled).length,
      runs: this.runs().length,
      changes: this.changes().length,
      subscribers: this.clients.size,
      mode: GEO_MODE() === 'manual' ? 'manual' : (UPSTREAM() ? 'upstream' : (ALLOW_LOCAL() ? 'local' : 'unconfigured')),
      manualMode: GEO_MODE() === 'manual',
      upstreamConfigured: !!UPSTREAM(),
      localAllowed: ALLOW_LOCAL(),
      nextRunAt: tasks.filter((t) => t.enabled && t.nextRunAt).map((t) => t.nextRunAt).sort()[0] || 0
    };
  }

  log(lv, m) { if (this.opt.onLog) this.opt.onLog(lv, m); }

  /* ---- 调度循环 ---- */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 30000);
    if (this.timer.unref) this.timer.unref();
    this.log('info', 'GEO 监测调度已启动（30s 巡检）· 通道 ' + this.stats().mode);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const c of Array.from(this.clients)) {
      try { clearInterval(c.timer); c.res.end(); } catch (e) {}
      this.clients.delete(c);
    }
  }

  async tick() {
    this.lastTickAt = Date.now();
    if (this.running) return;
    if (!UPSTREAM() && !ALLOW_LOCAL()) return;   // 未接通道时不自动跑，避免假数据
    const now = Date.now();
    const due = this.tasks().filter((t) => t.enabled && t.nextRunAt && t.nextRunAt <= now);
    if (!due.length) return;
    this.running = true;
    try {
      for (const t of due) {
        const t0 = Date.now();
        await this.runOnce(t.keyword, t.engines, { taskId: t.id, ms: 0 });
        /* 防止批量任务阻塞过久 */
        if (Date.now() - t0 > 8000) break;
        await new Promise((r) => setTimeout(r, 120));
      }
      this.broadcastStats();
    } catch (e) {
      this.log('warn', '调度执行异常：' + ((e && e.message) || e));
    } finally {
      this.running = false;
    }
  }
}

/* ---------------- 默认种子数据 ---------------- */

const SEED_KEYWORDS = [
  { kw: '抖音代运营 哪家好', intent: '采购', vol: 2400 },
  { kw: '千川投流服务商 哪家好', intent: '采购', vol: 1900 },
  { kw: '本地生活 团购代运营', intent: '代运营', vol: 880 },
  { kw: '千川代投 报价', intent: '定制', vol: 720 },
  { kw: 'CPL 线索 一手资源', intent: '货源', vol: 1500 },
  { kw: '信息流代投 服务商', intent: '采购', vol: 640 }
];

/** 生成初始监测任务（仅在库为空时写入，保证「有东西可监测」） */
function seedTasks(sched, seeds) {
  if (sched.tasks().length) return 0;
  const list = (Array.isArray(seeds) && seeds.length) ? seeds : SEED_KEYWORDS;
  const plan = [
    ['15m', ['doubao', 'yuanbao']],
    ['1h', ['doubao', 'wenxin', 'tongyi']],
    ['6h', ENGINE_IDS.slice()],
    ['24h', ENGINE_IDS.slice()],
    ['1h', ['deepseek', 'kimi']]
  ];
  list.forEach((k, i) => {
    const p = plan[i % plan.length];
    const t = sched.addTask({ keyword: k.kw, engines: p[1], every: p[0], enabled: i < 4 });
    t.intent = k.intent;
    t.vol = k.vol;
  });
  sched.store.save(true, 'geo_tasks');
  return list.length;
}

module.exports = {
  ENGINE_LIST, ENGINE_IDS, INTERVAL,
  monitor, normalize, upstreamHealth, localProbe, buildPlan, diff,
  GeoScheduler, seedTasks, SEED_KEYWORDS, statusOf, engineOf
};
