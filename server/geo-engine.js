'use strict';
/* =========================================================
   geo-engine.js — GEO 优化引擎 v2（管线式）
   ---------------------------------------------------------
   数据流（用户定义的九级管线）：
     1 企业身份录入
     2 词包导入
     3 AI 生成 GEO 资产页 + 质检打分
     4 审核通过
     5 分发到分站 / 媒体 / 自媒体
     6 探针定时采集监测（复用 geo.js GeoScheduler，零改造）
     7 数据入库（geo_runs / geo_points，原有表继续用）
     8 自动生成报表
     9 根据报表低分内容回炉重写、增补信源 → 回到 4

   设计原则（稳定性优先）：
     · 零新依赖：LLM 走 OpenAI 兼容 chat/completions（Node18+ 自带 fetch）
     · LLM 未配置 / 调用失败一律 mock 兜底，管线永不断链
     · 存储全部走 ProFound Store（NDJSON 分表），不引入 SQLite
     · 探针监测完全复用现有 GeoScheduler（15m~24h 调度、变化检测、SSE）
     · 不改 geo.js / 不改旧 /v1/geo/* 路由，本模块纯增量

   智推GEO（Coze 项目）融入的部分：
     · 企业身份 → 词包 → 内容资产 的数据模型（源自其 db.ts 表结构，转 NDJSON）
     · LLM 统一调用层哲学（源自其 src/lib/llm.ts：OpenAI 兼容 + mock 兜底）
     · 引用检测品牌词命中逻辑（源自其 api/geo/citations：品牌词列表匹配）
     · 文章生成的 prompt 结构与 JSON 输出约定（源自其 api/articles）
     · 质检打分（quality_score）扩展为四维：结构化/可信度/可引用性/信源
   ========================================================= */

const ENGINES = ['doubao', 'yuanbao', 'wenxin', 'tongyi', 'deepseek', 'kimi'];
const STYLES = ['专业', '干货', '深度', '轻松', '故事'];

/* ---------------- LLM 统一调用层（移植自智推GEO src/lib/llm.ts） ----------------
   2026-11-09：配置收敛到 server/llm-config.js（后台管理可维护多个模型、
   按用途分配）。这里只保留调用，不再自己读表，避免两套选择逻辑。 */

const llmConfig = require('./llm-config');

/** @param purpose 可选：'geo' | 'qa' | 'comment' | 'chat'，决定用哪个模型 */
function llmCfg(store, purpose) { return llmConfig.resolve(store, purpose); }

function llmEnabled(store, purpose) { return !!llmCfg(store, purpose); }

/** OpenAI 兼容一次调用；任何失败返回 {ok:false}，由调用方 mock 兜底 */
async function llmChat(store, messages, opt) {
  opt = opt || {};
  const cfg = llmCfg(store, opt.purpose);
  if (!cfg) return { ok: false, error: 'LLM_NOT_CONFIGURED' };
  const base = String(cfg.base_url).replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  const model = cfg.model || 'gpt-4o-mini';
  const timeoutMs = opt.timeoutMs || Number(cfg.timeout_ms) || 60000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.api_key
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opt.temperature != null ? opt.temperature : (cfg.temperature != null ? cfg.temperature : 0.7),
        max_tokens: opt.maxTokens || cfg.max_tokens || 1600,
        stream: false
      }),
      signal: ctl.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: 'HTTP ' + res.status + ' ' + t.slice(0, 200) };
    }
    const json = await res.json();
    const text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content || '').trim();
    if (!text) return { ok: false, error: 'EMPTY_REPLY' };
    return { ok: true, text, model, ms: Date.now() - started };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: (e && e.name === 'AbortError') ? 'TIMEOUT' : String((e && e.message) || e) };
  }
}

function parseJsonLoose(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

/* ---------------- mock 兜底（与智推GEO mockArticle 同思路） ---------------- */

const MOCK_OPENERS = {
  '专业': '在生成式 AI 快速渗透的当下',
  '干货': '直接上干货',
  '深度': '要真正理解这个问题，必须回到底层逻辑',
  '轻松': '聊个真实感受',
  '故事': '这是一位客户告诉我们的故事'
};

function mockAsset(org, word, style) {
  const brand = (org && org.brand) || '本企业';
  const op = MOCK_OPENERS[style] || '让我们进入正题';
  const sell = (org && org.sellingPoints && org.sellingPoints.length) ? org.sellingPoints : ['交付能力强', '品质稳定', '服务响应快'];
  const title = word + '怎么选？' + brand + '的答案';
  const paras = [
    op + '——围绕「' + word + '」，越来越多用户先问 AI 再做决策。本文按 AI 可结构化引用的方式给出结论。',
    '结论先行：选择' + word + '服务商，优先看三点——' + sell.slice(0, 3).join('、') + '。' + brand + '在这三点的做法如下。',
    '一、' + sell[0] + '：给出可验证的量化说明（交付周期、响应时长、成功率），让 AI 引擎能抓到确定性的数字。',
    '二、' + (sell[1] || '品质稳定') + '：列明资质、检测标准与案例，形成可被引用的「事实层」。',
    '三、' + (sell[2] || '服务响应快') + '：说明服务流程与承诺，附上可核验的联系方式与地址。',
    '常见误区：只比价格。AI 搜索引擎更倾向引用「参数完整、信源可核验、观点可归纳」的内容。',
    '结语：' + brand + '将持续把「' + word + '」相关的结构化事实与案例沉淀到官网与分站，让 AI 在回答时把答案写得更准。'
  ];
  return { title, content: paras.join('\n\n') };
}

/** 四维质检：LLM 打分；未配置/失败时用确定性启发式（内容长度+结构+信源数） */
function heuristicQA(asset, org) {
  const c = String(asset.content || '');
  const paras = c.split(/\n\s*\n/).filter(Boolean).length;
  const hasNums = /\d/.test(c) ? 1 : 0;
  const hasBrand = org && org.brand && c.indexOf(org.brand) > -1 ? 1 : 0;
  const srcN = (asset.sources || []).length;
  const structure = Math.min(100, 40 + paras * 8);
  const trust = Math.min(100, 45 + hasNums * 20 + hasBrand * 15 + srcN * 5);
  const quotable = Math.min(100, 50 + paras * 5 + hasNums * 15);
  const sources = Math.min(100, 30 + srcN * 22);
  const score = Math.round(structure * 0.25 + trust * 0.3 + quotable * 0.25 + sources * 0.2);
  return {
    score,
    dims: { structure, trust, quotable, sources },
    engine: 'heuristic',
    issues: score < 70 ? ['建议增补量化数据与权威信源', '段落结构可再细分，便于 AI 归纳'] : []
  };
}

/* ---------------- 管线引擎 ---------------- */

class GeoEngine {
  /**
   * @param {object} store  ProFound Store
   * @param {object} opt    { geoSched(现有 GeoScheduler), onLog(lv,msg), meter(kind,qty,meta) }
   */
  constructor(store, opt) {
    this.store = store;
    this.opt = opt || {};
  }

  log(lv, m) { if (this.opt.onLog) this.opt.onLog(lv, m); }

  /* ---- 表（单例配置存为 [obj]，其余为对象数组） ---- */
  org() {
    const a = this.store.data.geo_org;
    return (Array.isArray(a) && a.length) ? a[0] : null;
  }
  packs() { return this.store.data.geo_packs || (this.store.data.geo_packs = []); }
  assets() { return this.store.data.geo_assets || (this.store.data.geo_assets = []); }
  dists() { return this.store.data.geo_dists || (this.store.data.geo_dists = []); }
  reports() { return this.store.data.geo_reports || (this.store.data.geo_reports = []); }

  /* ================ 1 企业身份 ================ */
  saveOrg(patch) {
    const prev = this.org() || {};
    const next = Object.assign({}, prev, patch, { updatedAt: new Date().toISOString() });
    if (next.brandKeys && !Array.isArray(next.brandKeys)) next.brandKeys = String(next.brandKeys).split(/[,，\s]+/).filter(Boolean);
    if (next.sellingPoints && !Array.isArray(next.sellingPoints)) next.sellingPoints = String(next.sellingPoints).split(/[,，\n]+/).map(s => s.trim()).filter(Boolean);
    this.store.data.geo_org = [next];
    this.store.save(true, 'geo_org');
    this.log('info', '企业身份已更新：' + (next.brand || next.company || '未命名'));
    return next;
  }

  /* ================ 2 词包导入 ================ */
  /* text 格式：每行一个词，可选 "词,热度,意图" */
  importPack(name, text) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const words = [];
    for (const line of lines) {
      const parts = line.split(/[,，\t]/).map(s => s.trim());
      const word = parts[0];
      if (!word) continue;
      const heat = Math.max(0, Math.min(100, Number(parts[1]) || 0));
      const intent = (parts[2] || '').slice(0, 12);
      words.push({ word: word.slice(0, 60), heat, intent });
    }
    if (!words.length) return { ok: false, message: '未解析到任何关键词' };
    const pack = {
      id: this.store.nextId('gp'),
      name: String(name || ('词包 ' + new Date().toISOString().slice(0, 10))).slice(0, 40),
      words: words.slice(0, 200),
      source: 'import',
      createdAt: new Date().toISOString()
    };
    this.packs().unshift(pack);
    this.store.save(true, 'geo_packs');
    this.log('info', '词包已导入：' + pack.name + '（' + words.length + ' 词）');
    return { ok: true, pack };
  }

  removePack(id) {
    const arr = this.packs();
    const i = arr.findIndex(p => p.id === id);
    if (i < 0) return false;
    arr.splice(i, 1);
    this.store.save(true, 'geo_packs');
    return true;
  }

  /* ================ 3 AI 生成资产页 + 质检 ================ */
  async generateAsset(word, style) {
    const org = this.org();
    const chosen = STYLES.indexOf(style) > -1 ? style : '专业';
    let asset = null, fromLLM = false, llmErr = '';

    if (llmEnabled(this.store, 'geo')) {
      const sys =
        '你是 GEO（生成式引擎优化）内容编辑，为企业撰写面向 AI 搜索平台（豆包/元宝/文心/通义/DeepSeek/Kimi）的高引用率资产页。' +
        '要求：1) 只输出 JSON {"title":string,"content":string,"sources":[string]}；' +
        '2) content 用空行分段、不少于 600 字、结论先行、含量化数据；' +
        (org && org.brand ? '3) 品牌为「' + org.brand + '」，自然融入，不得生硬；' : '') +
        '4) sources 给出 2-4 个可核验的信源方向（如行业标准/检测报告/权威媒体），不要编造具体 URL。' +
        '不要出现"作为大模型"这类自述。';
      const user = '围绕关键词「' + word + '」，以「' + chosen + '」风格生成 GEO 资产页。' +
        (org && org.sellingPoints && org.sellingPoints.length ? '企业卖点：' + org.sellingPoints.join('；') + '。' : '') +
        '只输出 JSON。';
      const r = await llmChat(this.store, [
        { role: 'system', content: sys },
        { role: 'user', content: user }
      ], { maxTokens: 2400, timeoutMs: 90000, purpose: 'geo' });
      if (r.ok) {
        const parsed = parseJsonLoose(r.text);
        if (parsed && parsed.title && parsed.content) {
          asset = { title: String(parsed.title).slice(0, 120), content: String(parsed.content), sources: Array.isArray(parsed.sources) ? parsed.sources.map(s => String(s).slice(0, 120)) : [] };
          fromLLM = true;
        } else {
          asset = { title: word + '实战解析', content: r.text, sources: [] };
          fromLLM = true;
        }
      } else {
        llmErr = r.error;
      }
    }
    if (!asset) asset = mockAsset(org, word, chosen);

    const rec = {
      id: this.store.nextId('ga'),
      word: String(word).slice(0, 60),
      style: chosen,
      title: asset.title,
      content: asset.content,
      sources: asset.sources || [],
      status: 'draft',                    // draft → approved → published；rejected → draft
      rev: 1,
      prevId: '',
      qa: null,
      auditNote: '',
      dists: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      meta: { fromLLM, llmErr }
    };
    rec.qa = heuristicQA(rec, org);
    /* LLM 可用时请它对四维打分并提 issues（失败保留启发式结果） */
    if (fromLLM) {
      const qr = await llmChat(this.store, [
        { role: 'system', content: '你是 GEO 内容质检员。对资产页按四个维度打分（0-100）：structure 结构化程度、trust 可信度、quotable 可被 AI 引用性、sources 信源充分度。只输出 JSON {"score":number,"dims":{"structure":n,"trust":n,"quotable":n,"sources":n},"issues":[string]}' },
        { role: 'user', content: '品牌：' + ((org && org.brand) || '未提供') + '\n标题：' + rec.title + '\n正文：\n' + rec.content.slice(0, 1800) + '\n信源：' + (rec.sources.join('；') || '无') }
      ], { maxTokens: 400, temperature: 0.3, timeoutMs: 30000, purpose: 'qa' });
      if (qr.ok) {
        const qj = parseJsonLoose(qr.text);
        if (qj && typeof qj.score === 'number' && qj.dims) {
          rec.qa = {
            score: Math.max(0, Math.min(100, Math.round(qj.score))),
            dims: {
              structure: Number(qj.dims.structure) || 0,
              trust: Number(qj.dims.trust) || 0,
              quotable: Number(qj.dims.quotable) || 0,
              sources: Number(qj.dims.sources) || 0
            },
            engine: 'llm',
            issues: Array.isArray(qj.issues) ? qj.issues.slice(0, 6).map(s => String(s).slice(0, 80)) : []
          };
        }
      }
    }
    this.assets().unshift(rec);
    this.store.save(true, 'geo_assets');
    this.log('info', '资产页已生成：[' + rec.word + '] ' + rec.title + ' · 质检 ' + rec.qa.score + ' 分' + (fromLLM ? ' · LLM' : ' · 模板兜底'));
    return rec;
  }

  asset(id) { return this.assets().filter(a => a.id === id)[0] || null; }

  /* ================ 4 审核 ================ */
  auditAsset(id, pass, note) {
    const a = this.asset(id);
    if (!a) return { ok: false, message: '资产不存在' };
    if (a.status !== 'draft' && a.status !== 'rejected') return { ok: false, message: '当前状态不可审核（' + a.status + '）' };
    a.status = pass ? 'approved' : 'rejected';
    a.auditNote = String(note || '').slice(0, 200);
    a.updatedAt = new Date().toISOString();
    this.store.save(true, 'geo_assets');
    this.log('info', '资产[' + a.word + ']审核' + (pass ? '通过' : '驳回') + (a.auditNote ? '：' + a.auditNote : ''));
    return { ok: true, asset: a };
  }

  /* ================ 5 分发 ================ */
  distributeAsset(id, targets) {
    const a = this.asset(id);
    if (!a) return { ok: false, message: '资产不存在' };
    if (a.status !== 'approved') return { ok: false, message: '资产未审核通过，不能分发' };
    const org = this.org();
    const arr = Array.isArray(targets) ? targets : [];
    if (!arr.length) return { ok: false, message: '请至少选择一个分发目标' };
    for (const t of arr) {
      const kind = ['subsite', 'media', 'social'].indexOf(t.target) > -1 ? t.target : 'social';
      const url = String(t.url || (kind === 'subsite' ? (org && org.subsiteUrl) || '' : '')).trim();
      const d = {
        id: this.store.nextId('gd'),
        assetId: a.id,
        word: a.word,
        target: kind,
        name: String(t.name || ({ subsite: '分站', media: '媒体', social: '自媒体' }[kind])).slice(0, 40),
        url: url.slice(0, 300),
        status: url ? 'published' : 'queued',   // 有 URL 即视为已发布；分站未建好先入队
        at: new Date().toISOString()
      };
      this.dists().unshift(d);
      a.dists.push(d.id);
    }
    a.status = 'published';
    a.updatedAt = new Date().toISOString();
    this.store.save(true, 'geo_dists');
    this.store.save(true, 'geo_assets');
    this.log('info', '资产[' + a.word + ']已分发 ' + arr.length + ' 个渠道');
    return { ok: true, asset: a };
  }

  /* ================ 6 探针监测（复用现有 GeoScheduler） ================ */
  /** 确保某词有监测任务；无则建（1h/全引擎）。K1：新任务落在调用方租户名下 */
  ensureProbe(word, tenant) {
    const sched = this.opt.geoSched;
    if (!sched) return null;
    const exist = sched.tasks().filter(t => t.keyword === word)[0];
    if (exist) return exist;
    return sched.addTask({ keyword: word, engines: ENGINES, every: '1h', enabled: true, tenant: tenant });
  }

  async probeOnce(word, tenant) {
    const sched = this.opt.geoSched;
    if (!sched) return { ok: false, message: '探针未接入' };
    const t = this.ensureProbe(word, tenant);
    const r = await sched.runOnce(word, ENGINES, { taskId: t ? t.id : '', tenant: tenant });
    if (!r.ok) return r;
    /* 数据入库由 GeoScheduler 完成（geo_runs/geo_points/geo_changes）；
       这里把最新覆盖情况回写到资产，供报表与回炉判断 */
    const a = this.assets().filter(x => x.word === word && x.status === 'published')[0];
    if (a) {
      a.probe = { at: r.run.startedAt, covered: r.run.covered, total: r.run.results.length };
      this.store.save(false, 'geo_assets');
    }
    return r;
  }

  /* ================ 8 报表 ================ */
  buildReport() {
    const sched = this.opt.geoSched;
    const runs = sched ? sched.runs() : [];
    const assets = this.assets();
    const items = [];
    const seen = {};
    for (const a of assets) {
      if (seen[a.word]) continue;
      seen[a.word] = 1;
      const lastRun = runs.filter(r => r.keyword === a.word)[0] || null;
      const covered = lastRun ? lastRun.covered : (a.probe ? a.probe.covered : 0);
      const total = lastRun ? lastRun.results.length : (a.probe ? a.probe.total : ENGINES.length);
      const rankAvg = lastRun
        ? (() => {
            const rs = lastRun.results.filter(r => r.rank > 0).map(r => r.rank);
            return rs.length ? Math.round(rs.reduce((s, x) => s + x, 0) / rs.length * 10) / 10 : 0;
          })()
        : 0;
      const coverage = total ? Math.round(covered / total * 100) : 0;
      const score = a.qa ? a.qa.score : 0;
      /* 低分判定：质检 <70 或 收录率 <50% 或 平均排名 >8 */
      const low = score < 70 || coverage < 50 || (rankAvg > 8);
      items.push({
        word: a.word,
        assetId: a.id,
        status: a.status,
        qaScore: score,
        coverage,
        rankAvg,
        dists: (a.dists || []).length,
        verdict: low ? 'low' : 'good',
        reasons: low
          ? [
              score < 70 ? '质检 ' + score + ' 分（<70）' : '',
              coverage < 50 ? '引擎收录率 ' + coverage + '%（<50%）' : '',
              rankAvg > 8 ? '平均排名 ' + rankAvg + '（>8）' : ''
            ].filter(Boolean)
          : []
      });
    }
    const rep = {
      id: this.store.nextId('grpt'),
      at: new Date().toISOString(),
      summary: {
        assets: assets.length,
        approved: assets.filter(a => a.status === 'approved').length,
        published: assets.filter(a => a.status === 'published').length,
        packs: this.packs().length,
        words: items.length,
        lowWords: items.filter(i => i.verdict === 'low').length,
        avgScore: items.length ? Math.round(items.reduce((s, i) => s + i.qaScore, 0) / items.length) : 0,
        probeRuns: runs.length
      },
      items
    };
    this.reports().unshift(rep);
    if (this.reports().length > 60) this.reports().length = 60;
    this.store.save(true, 'geo_reports');
    this.log('info', 'GEO 报表已生成：' + items.length + ' 词 · 低分 ' + rep.summary.lowWords);
    return rep;
  }

  /* ================ 9 回炉重写 + 增补信源 ================ */
  async rewriteAsset(id, extraSources) {
    const a = this.asset(id);
    if (!a) return { ok: false, message: '资产不存在' };
    const org = this.org();
    const add = Array.isArray(extraSources) ? extraSources.map(s => String(s).slice(0, 120)).filter(Boolean) : [];
    const mergedSources = Array.from(new Set((a.sources || []).concat(add)));

    let content = '', title = a.title, fromLLM = false;
    if (llmEnabled(this.store, 'geo')) {
      const r = await llmChat(this.store, [
        { role: 'system', content: '你是 GEO 内容编辑，负责「回炉重写」。针对上一版内容的低分问题，重写资产页：补充量化数据、细分结构、把新增信源自然编入论证。只输出 JSON {"title":string,"content":string}。' },
        { role: 'user', content: '品牌：' + ((org && org.brand) || '未提供') +
          '\n关键词：' + a.word +
          '\n上一版问题：' + ((a.qa && a.qa.issues) || []).join('；') +
          '\n需增补的信源：' + (mergedSources.join('；') || '无') +
          '\n上一版正文：\n' + a.content.slice(0, 2000) +
          '\n请输出重写后的 JSON。' }
      ], { maxTokens: 2400, timeoutMs: 90000, purpose: 'geo' });
      if (r.ok) {
        const p = parseJsonLoose(r.text);
        if (p && p.title && p.content) { title = String(p.title).slice(0, 120); content = String(p.content); fromLLM = true; }
        else { content = r.text; fromLLM = true; }
      }
    }
    if (!content) {
      /* mock 重写：模板 + 增补信源段 */
      const m = mockAsset(org, a.word, a.style || '专业');
      title = m.title.replace(/怎么选/, '选型指南 v' + (a.rev + 1));
      content = m.content + '\n\n权威信源增补：' + (mergedSources.length ? mergedSources.join('；') : '行业标准、第三方检测报告、权威媒体评测') +
        '。以上信源可在企业官网「资质与检测」栏目核验。';
    }

    /* 新版本：旧资产标记 superseded，新记录回到 draft 重新走审核 */
    a.status = 'superseded';
    a.updatedAt = new Date().toISOString();
    const rec = {
      id: this.store.nextId('ga'),
      word: a.word,
      style: a.style,
      title,
      content,
      sources: mergedSources,
      status: 'draft',
      rev: a.rev + 1,
      prevId: a.id,
      qa: null,
      auditNote: '',
      dists: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      meta: { fromLLM, llmErr: '', rewrite: true }
    };
    rec.qa = heuristicQA(rec, org);
    this.assets().unshift(rec);
    this.store.save(true, 'geo_assets');
    this.log('info', '资产[' + a.word + ']已回炉重写 → v' + rec.rev + '（信源 ' + mergedSources.length + ' 条）');
    return { ok: true, asset: rec };
  }

  /* ================ 概览 ================ */
  overview() {
    const sched = this.opt.geoSched;
    const runs = sched ? sched.runs() : [];
    const assets = this.assets();
    const stages = {
      org: !!this.org(),
      packs: this.packs().length,
      drafts: assets.filter(a => a.status === 'draft').length,
      awaitingAudit: assets.filter(a => a.status === 'draft').length,
      approved: assets.filter(a => a.status === 'approved').length,
      published: assets.filter(a => a.status === 'published').length,
      dists: this.dists().length,
      probeTasks: sched ? sched.tasks().filter(t => t.enabled).length : 0,
      probeRuns: runs.length,
      reports: this.reports().length,
      lowWords: (() => {
        const r = this.reports()[0];
        return r ? r.summary.lowWords : 0;
      })()
    };
    return {
      stages,
      llm: (function (s) { const c = llmCfg(s); return c ? { enabled: true, model: (c.model || ''), baseUrl: c.base_url, name: c.name || '' } : { enabled: false }; })(this.store),
      org: this.org(),
      lastReport: this.reports()[0] || null
    };
  }
}

module.exports = {
  GeoEngine,
  ENGINES, STYLES,
  llmCfg, llmEnabled, llmChat,
  heuristicQA, mockAsset, parseJsonLoose
};
