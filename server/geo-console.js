'use strict';
/* =========================================================
   geo-console.js — GEO 优化引擎 · 11 模块控制台数据层
   ---------------------------------------------------------
   模块：仪表盘 / 企业身份 / 词库话题包 / 内容创作中心 / 站点矩阵
        全域渠道分发 / 探针采集 / 报告中心 / 页面诊断 / 客户权限 / 系统设置

   设计原则（与 geo-engine.js 保持一致，稳定性优先）：
     · 零新依赖：LLM 走 geo-engine 的 OpenAI 兼容层，HTTP 用 Node18+ 自带 fetch
     · 所有写入走 ProFound Store（NDJSON 分表），失败不抛、返回 {ok:false}
     · 无上游数据时明确返回 empty/未接入，不伪造真实指标；示例数据单独标记 demo
     · 不改动 /v1/geo/* 与 /v1/geop/* 既有路由（本模块纯增量）
   ========================================================= */

const ENGINE_NAMES = {
  doubao: '豆包', yuanbao: '腾讯元宝', wenxin: '文心一言',
  tongyi: '通义千问', deepseek: 'DeepSeek', kimi: 'Kimi'
};
const ENGINES = Object.keys(ENGINE_NAMES);

/* 词分区：按最近 14 天命中情况判定 */
const ZONE_LABEL = { advantage: '优势区', enemy: '敌占区', blank: '空白区', risk: '风险区' };

function nowISO() { return new Date().toISOString(); }
function dayKey(ts) { return String(ts || '').slice(0, 10); }
function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function rnd(seed) { return (hash32(seed) % 10000) / 10000; }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function arr(v, max) { return Array.isArray(v) ? v.slice(0, max || 500) : []; }
function str(v, max) { return String(v == null ? '' : v).slice(0, max || 300); }

/* 简易 HTML 文本化（诊断用） */
function htmlText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 40 项 GEO 诊断打分表 → 可自动检测的 13 项（权重合计 100） */
const DIAG_RULES = [
  { key: 'title', label: 'Title 标题（10-60 字，含核心问句）', w: 8 },
  { key: 'desc', label: 'Meta Description 摘要', w: 6 },
  { key: 'h1', label: '唯一 H1 主标题', w: 6 },
  { key: 'answer', label: '前置 Answer 答案块（结论先行）', w: 12 },
  { key: 'h2q', label: 'H2 问句式小标题 ≥2 个', w: 10 },
  { key: 'table', label: '参数 / 对比表格', w: 8 },
  { key: 'faq', label: 'FAQ 问答区块', w: 8 },
  { key: 'schema', label: 'Schema JSON-LD 结构化数据', w: 12 },
  { key: 'canonical', label: 'Canonical 规范链接', w: 5 },
  { key: 'links', label: '站内语义内链 ≥3 条', w: 5 },
  { key: 'imgalt', label: '图片 alt 文本覆盖率', w: 5 },
  { key: 'viewport', label: '移动端 viewport 声明', w: 5 },
  { key: 'words', label: '正文有效字数 ≥600', w: 10 }
];

class GeoConsole {
  /**
   * @param {object} store ProFound Store
   * @param {object} opt   { geoEngine, geoSched, onLog, meter }
   */
  constructor(store, opt) {
    this.store = store;
    this.opt = opt || {};
  }

  log(lv, m) { if (this.opt.onLog) this.opt.onLog(lv, '[geo2] ' + m); }

  /* ---------------- 表 ---------------- */
  _t(name) { return this.store.data[name] || (this.store.data[name] = []); }
  sites() { return this._t('geo_sites'); }
  channels() { return this._t('geo_channels'); }
  pubq() { return this._t('geo_pubq'); }
  snaps() { return this._t('geo_snaps'); }
  diags() { return this._t('geo_diag'); }
  tenants() { return this._t('geo_tenants'); }
  kb() { return this._t('geo_kb'); }
  settings() {
    const a = this.store.data.geo_settings;
    return (Array.isArray(a) && a.length) ? a[0] : null;
  }
  save(name, sync) { try { this.store.save(!!sync, name); } catch (e) { this.log('error', 'save ' + name + ' 失败：' + e.message); } }

  /* ================= 1 仪表盘 ================= */
  dashboard(rangeDays) {
    const days = clamp(Number(rangeDays) || 14, 7, 90);
    const snaps = this.snaps();
    const since = Date.now() - days * 86400000;
    const recent = snaps.filter(s => (Date.parse(s.at) || 0) >= since);
    const demo = recent.length ? recent.every(s => s.demo) : false;

    const agg = (list) => {
      const total = list.length;
      if (!total) return { total: 0, mentionRate: 0, firstRate: 0, top3Rate: 0, sentiment: 0, compShare: 0 };
      const brand = list.filter(s => s.brandHit).length;
      const first = list.filter(s => s.brandHit && Number(s.rank) === 1).length;
      const top3 = list.filter(s => s.brandHit && Number(s.rank) >= 1 && Number(s.rank) <= 3).length;
      const comp = list.filter(s => s.compHit).length;
      const senti = list.reduce((a, s) => a + (Number(s.sentiment) || 0), 0) / total;
      return {
        total,
        mentionRate: Math.round(brand / total * 1000) / 10,
        firstRate: Math.round(first / total * 1000) / 10,
        top3Rate: Math.round(top3 / total * 1000) / 10,
        sentiment: Math.round((senti + 1) / 2 * 1000) / 10,
        compShare: Math.round(comp / Math.max(1, brand + comp) * 1000) / 10
      };
    };

    const models = ENGINES.map(id => {
      const list = recent.filter(s => s.model === id);
      return Object.assign({ id, name: ENGINE_NAMES[id] || id, hasData: list.length > 0 }, agg(list));
    });

    /* 趋势：按天聚合提及率 / 首推率 */
    const trend = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = dayKey(new Date(Date.now() - i * 86400000).toISOString());
      const list = recent.filter(s => dayKey(s.at) === d);
      const a = agg(list);
      trend.push({ day: d.slice(5), total: a.total, mentionRate: a.mentionRate, firstRate: a.firstRate });
    }

    /* 词包状态 / 词分区 */
    const packs = (this.opt.geoEngine ? this.opt.geoEngine.packs() : []) || [];
    const assets = (this.opt.geoEngine ? this.opt.geoEngine.assets() : []) || [];
    const pubq = this.pubq();
    const sites = this.sites();
    let wordTotal = 0;
    const packStat = packs.map(p => {
      const ws = arr(p.words, 500);
      wordTotal += ws.length;
      const hit = ws.filter(w => recent.some(s => s.word === w.word && s.brandHit)).length;
      return {
        id: p.id, name: p.name, words: ws.length, hitWords: hit,
        monitoring: p.monitoring !== false,
        coverage: ws.length ? Math.round(hit / ws.length * 100) : 0
      };
    });

    const zoneCount = { advantage: 0, enemy: 0, blank: 0, risk: 0 };
    packs.forEach(p => arr(p.words, 500).forEach(w => {
      const list = recent.filter(s => s.word === w.word);
      const z = this.zoneOf(list);
      zoneCount[z] = (zoneCount[z] || 0) + 1;
    }));

    const tasks = {
      pendingCollect: packs.reduce((n, p) => n + (p.monitoring === false ? 0 : arr(p.words, 500).filter(w => !recent.some(s => s.word === w.word)).length), 0),
      pendingAudit: assets.filter(a => a.status === 'draft').length,
      pendingPublish: pubq.filter(q => q.status === 'queued').length,
      failedPublish: pubq.filter(q => q.status === 'failed').length,
      brokenSites: sites.filter(s => s.status && s.status.ok === false).length,
      sites: sites.length,
      packs: packs.length,
      words: wordTotal,
      assets: assets.length,
      published: assets.filter(a => a.status === 'published').length
    };

    const alerts = [];
    if (!snaps.length) alerts.push({ lv: 'info', text: '尚无探针快照：先配置监测上游，或载入示例数据看大盘效果。' });
    if (tasks.pendingAudit) alerts.push({ lv: 'warn', text: tasks.pendingAudit + ' 篇资产页待审核，通过后才可进入发布队列。' });
    if (tasks.failedPublish) alerts.push({ lv: 'err', text: tasks.failedPublish + ' 条发布任务失败，请到「全域渠道分发」重试。' });
    if (tasks.brokenSites) alerts.push({ lv: 'err', text: tasks.brokenSites + ' 个分站抓取异常，可能影响收录。' });
    if (assets.filter(a => a.qa && a.qa.score < 70).length) alerts.push({ lv: 'warn', text: assets.filter(a => a.qa && a.qa.score < 70).length + ' 篇资产页质检低于 70 分，建议回炉重写。' });

    return {
      ok: true,
      empty: !snaps.length,
      demo,
      rangeDays: days,
      all: agg(recent),
      models,
      trend,
      packs: packStat,
      zones: zoneCount,
      zoneLabels: ZONE_LABEL,
      tasks,
      alerts,
      engines: ENGINES.map(id => ({ id, name: ENGINE_NAMES[id] })),
      upstream: { configured: !!(process.env.GEO_UPSTREAM || process.env.GEO_TOKEN) || process.env.GEO_MODE === 'manual' }
    };
  }

  zoneOf(list) {
    if (!list.length) return 'blank';
    const hit = list.filter(s => s.brandHit).length;
    const top3 = list.filter(s => s.brandHit && Number(s.rank) <= 3).length;
    const compTop = list.filter(s => s.compHit && Number(s.rank) <= 3).length;
    if (top3 / list.length >= 0.5) return 'advantage';
    if (compTop > 0 && hit === 0) return 'enemy';
    if (hit === 0) return 'blank';
    if (compTop > top3) return 'risk';
    return 'blank';
  }

  /* 历史词效曲线（单问句） */
  wordTrend(word, days) {
    const d = clamp(Number(days) || 14, 7, 90);
    const list = this.snaps().filter(s => s.word === word && (Date.parse(s.at) || 0) >= Date.now() - d * 86400000);
    const out = [];
    for (let i = d - 1; i >= 0; i--) {
      const day = dayKey(new Date(Date.now() - i * 86400000).toISOString());
      const today = list.filter(s => dayKey(s.at) === day);
      out.push({
        day: day.slice(5),
        mention: today.length ? Math.round(today.filter(s => s.brandHit).length / today.length * 100) : 0,
        first: today.length ? Math.round(today.filter(s => s.brandHit && Number(s.rank) === 1).length / today.length * 100) : 0
      });
    }
    return out;
  }

  /* ================= 2 企业身份 ================= */
  orgBundle() {
    const org = this.opt.geoEngine ? this.opt.geoEngine.org() : null;
    return {
      org: org || null,
      kb: this.kb().slice(0, 60),
      consistency: this.consistency()
    };
  }

  addKb(item) {
    const rec = {
      id: this.store.nextId('gk'),
      name: str(item.name || '未命名资料', 60),
      type: str(item.type || 'doc', 20),
      size: Number(item.size) || 0,
      text: str(item.text || '', 20000),
      at: nowISO()
    };
    if (!rec.text && !rec.name) return { ok: false, message: '请提供资料名称或正文' };
    this.kb().unshift(rec);
    if (this.kb().length > 200) this.kb().length = 200;
    this.save('geo_kb', true);
    return { ok: true, item: rec };
  }

  delKb(id) {
    const i = this.kb().findIndex(x => x.id === id);
    if (i < 0) return false;
    this.kb().splice(i, 1);
    this.save('geo_kb', true);
    return true;
  }

  /** 实体一致性：检查资产页正文里出现的电话 / 品牌名版本是否与标准实体冲突 */
  consistency() {
    const org = (this.opt.geoEngine && this.opt.geoEngine.org()) || {};
    const assets = (this.opt.geoEngine && this.opt.geoEngine.assets()) || [];
    const stdPhone = String(org.phone || '').replace(/[^\d]/g, '');
    const stdBrand = String(org.brand || '').trim();
    const issues = [];
    assets.slice(0, 80).forEach(a => {
      const c = String(a.content || '');
      const phones = (c.match(/1[3-9]\d{9}|0\d{2,3}-?\d{7,8}/g) || [])
        .map(p => p.replace(/[^\d]/g, '')).filter(p => p.length >= 7);
      const bad = Array.from(new Set(phones.filter(p => stdPhone && p !== stdPhone)));
      if (bad.length) issues.push({ assetId: a.id, word: a.word, type: 'phone', detail: '出现非标准电话：' + bad.slice(0, 3).join(' / '), at: a.updatedAt || a.createdAt });
      if (stdBrand) {
        const near = (c.match(/[\u4e00-\u9fa5A-Za-z]{2,12}(?:科技|实业|集团|有限公司)/g) || [])
          .filter(n => n.indexOf(stdBrand) < 0 && n.length >= 4);
        const uniq = Array.from(new Set(near)).slice(0, 2);
        if (uniq.length) issues.push({ assetId: a.id, word: a.word, type: 'name', detail: '疑似实体名不一致：' + uniq.join(' / '), at: a.updatedAt || a.createdAt });
      }
    });
    return { checked: assets.length, issues: issues.slice(0, 30), ok: issues.length === 0 };
  }

  /* ================= 3 词库 / 话题包 ================= */
  packsView() {
    const packs = (this.opt.geoEngine && this.opt.geoEngine.packs()) || [];
    const snaps = this.snaps();
    return packs.map(p => {
      const ws = arr(p.words, 500);
      const zones = { advantage: 0, enemy: 0, blank: 0, risk: 0 };
      const words = ws.map(w => {
        const list = snaps.filter(s => s.word === w.word && (Date.parse(s.at) || 0) >= Date.now() - 14 * 86400000);
        const z = this.zoneOf(list);
        zones[z]++;
        return Object.assign({}, w, { zone: z, zoneLabel: ZONE_LABEL[z], hits: list.filter(s => s.brandHit).length, total: list.length });
      });
      return Object.assign({}, p, { words, zones, monitoring: p.monitoring !== false, count: ws.length });
    });
  }

  togglePack(id, on) {
    const p = ((this.opt.geoEngine && this.opt.geoEngine.packs()) || []).filter(x => x.id === id)[0];
    if (!p) return { ok: false, message: '词包不存在' };
    p.monitoring = !!on;
    p.updatedAt = nowISO();
    this.save('geo_packs', true);
    return { ok: true, pack: p };
  }

  copyPack(id) {
    const p = ((this.opt.geoEngine && this.opt.geoEngine.packs()) || []).filter(x => x.id === id)[0];
    if (!p) return { ok: false, message: '词包不存在' };
    const rec = Object.assign({}, p, {
      id: this.store.nextId('gp'),
      name: str(p.name + ' · 副本', 40),
      createdAt: nowISO(),
      updatedAt: nowISO()
    });
    this.opt.geoEngine.packs().unshift(rec);
    this.save('geo_packs', true);
    return { ok: true, pack: rec };
  }

  /* ================= 4 内容创作中心 ================= */
  /** 同义变体：同一问句生成 n 版差异化开头/结构，用于分站分发防同质化 */
  variants(assetId, n) {
    const a = (this.opt.geoEngine && this.opt.geoEngine.asset(assetId)) || null;
    if (!a) return { ok: false, message: '资产不存在' };
    const count = clamp(Number(n) || 3, 2, 6);
    const openings = [
      '先说结论：', '直接回答：', '一句话答案：', '核心结论：', '结论前置：', '快速回答：'
    ];
    const tails = [
      '（以下为可核验的事实与数据）', '（附参数对照，便于 AI 直接引用）', '（含常见误区与判断标准）',
      '（按决策路径逐条说明）', '（附行业口径与检测依据）', '（含服务流程与承诺）'
    ];
    const body = String(a.content || '');
    const paras = body.split(/\n\s*\n/).filter(Boolean);
    const out = [];
    for (let i = 0; i < count; i++) {
      const title = a.title.replace(/[（(].*?[)）]/g, '') + (i ? '（版本 ' + (i + 1) + '）' : '');
      const content = openings[i % openings.length] + paras.slice(0, 2).join(' ').replace(/^[^：:]{0,10}[：:]/, '') +
        '\n\n' + paras.slice(2).join('\n\n') + '\n\n' + tails[i % tails.length];
      const rec = {
        id: this.store.nextId('gv'),
        assetId: a.id,
        word: a.word,
        title,
        content,
        variant: i + 1,
        qa: { score: clamp((a.qa && a.qa.score || 70) - i * 2, 40, 100), dims: (a.qa && a.qa.dims) || {} },
        at: nowISO()
      };
      out.push(rec);
    }
    a.variants = out;
    a.updatedAt = nowISO();
    this.save('geo_assets', true);
    return { ok: true, variants: out };
  }

  /** 模拟爬虫抓取：返回 AI 能提取到的纯文本与结构摘要 */
  preview(assetId) {
    const a = (this.opt.geoEngine && this.opt.geoEngine.asset(assetId)) || null;
    if (!a) return { ok: false, message: '资产不存在' };
    const c = String(a.content || '');
    const paras = c.split(/\n\s*\n/).filter(Boolean);
    return {
      ok: true,
      crawlerText: [a.title].concat(paras).join('\n\n').slice(0, 4000),
      stats: {
        chars: c.length,
        paras: paras.length,
        hasNumbers: /\d/.test(c),
        answerBlock: /^(先说结论|结论|一句话|答案|核心)/.test(paras[0] || ''),
        sources: (a.sources || []).length
      }
    };
  }

  /* ================= 5 站点矩阵 ================= */
  addSite(body) {
    const url = str(body.url, 300).trim();
    if (!url) return { ok: false, message: '请填写站点地址' };
    const rec = {
      id: this.store.nextId('gs'),
      name: str(body.name || url.replace(/^https?:\/\//, '').split('/')[0], 60),
      url,
      type: body.type === 'industry' ? 'industry' : 'city',
      group: str(body.group || '默认分组', 30),
      weight: ['core', 'aux', 'backup'].indexOf(body.weight) > -1 ? body.weight : 'aux',
      apiKey: str(body.apiKey || '', 80),
      status: { ok: null, checkedAt: '', msg: '未检测' },
      createdAt: nowISO()
    };
    this.sites().unshift(rec);
    if (this.sites().length > 300) this.sites().length = 300;
    this.save('geo_sites', true);
    return { ok: true, site: rec };
  }

  updateSite(id, patch) {
    const s = this.sites().filter(x => x.id === id)[0];
    if (!s) return { ok: false, message: '站点不存在' };
    ['name', 'url', 'group', 'apiKey'].forEach(k => { if (patch[k] != null) s[k] = str(patch[k], 300); });
    if (patch.type) s.type = patch.type === 'industry' ? 'industry' : 'city';
    if (patch.weight && ['core', 'aux', 'backup'].indexOf(patch.weight) > -1) s.weight = patch.weight;
    s.updatedAt = nowISO();
    this.save('geo_sites', true);
    return { ok: true, site: s };
  }

  delSite(id) {
    const arr0 = this.sites();
    const i = arr0.findIndex(x => x.id === id);
    if (i < 0) return false;
    arr0.splice(i, 1);
    this.save('geo_sites', true);
    return true;
  }

  /** 站点健康：抓首页看状态码 / title / sitemap 提示；失败如实记录 */
  async checkSite(id) {
    const s = this.sites().filter(x => x.id === id)[0];
    if (!s) return { ok: false, message: '站点不存在' };
    const started = Date.now();
    let status = { ok: false, checkedAt: nowISO(), msg: '', ms: 0 };
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10000);
      const res = await fetch(s.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
        signal: ctl.signal,
        redirect: 'follow'
      });
      clearTimeout(timer);
      const html = (await res.text()).slice(0, 200000);
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
      const noindex = /<meta[^>]+name=["']robots["'][^>]+noindex/i.test(html);
      const hasSitemap = /sitemap/i.test(s.url) || /<link[^>]+sitemap/i.test(html);
      status = {
        ok: res.ok && !noindex,
        code: res.status,
        checkedAt: nowISO(),
        ms: Date.now() - started,
        title: str(htmlText(title), 80),
        noindex,
        sitemap: hasSitemap,
        msg: noindex ? 'robots 声明 noindex，AI 抓取会被拒' : (res.ok ? '抓取正常' : 'HTTP ' + res.status)
      };
    } catch (e) {
      status = { ok: false, checkedAt: nowISO(), ms: Date.now() - started, msg: (e && e.name === 'AbortError') ? '抓取超时（10s）' : String(e.message || e).slice(0, 120) };
    }
    s.status = status;
    this.save('geo_sites', true);
    return { ok: true, site: s };
  }

  /* ================= 6 全域渠道分发 ================= */
  addChannel(body) {
    const rec = {
      id: this.store.nextId('gc'),
      kind: ['subsite', 'media', 'social', 'video'].indexOf(body.kind) > -1 ? body.kind : 'media',
      name: str(body.name || '未命名渠道', 60),
      account: str(body.account || '', 80),
      status: body.status === 'active' ? 'active' : 'pending',
      meta: {
        price: Number(body.price) || 0,
        region: str(body.region || '', 30),
        note: str(body.note || '', 120)
      },
      createdAt: nowISO()
    };
    this.channels().unshift(rec);
    if (this.channels().length > 300) this.channels().length = 300;
    this.save('geo_channels', true);
    return rec;
  }

  authChannel(id, on) {
    const c = this.channels().filter(x => x.id === id)[0];
    if (!c) return { ok: false, message: '渠道不存在' };
    c.status = on ? 'active' : 'pending';
    c.authedAt = on ? nowISO() : '';
    this.save('geo_channels', true);
    return { ok: true, channel: c };
  }

  delChannel(id) {
    const a = this.channels();
    const i = a.findIndex(x => x.id === id);
    if (i < 0) return false;
    a.splice(i, 1);
    this.save('geo_channels', true);
    return true;
  }

  /** 发布：资产必须 approved；按渠道类型入队，有 url 视为已发布 */
  publish(assetId, targets, scheduleAt) {
    const engine = this.opt.geoEngine;
    const a = engine && engine.asset(assetId);
    if (!a) return { ok: false, message: '资产不存在' };
    if (a.status !== 'approved') return { ok: false, message: '资产未审核通过，不能发布' };
    const list = arr(targets, 20);
    if (!list.length) return { ok: false, message: '请至少选择一个渠道' };
    const created = [];
    for (const t of list) {
      const kind = ['subsite', 'media', 'social', 'video'].indexOf(t.kind) > -1 ? t.kind : 'media';
      const rec = {
        id: this.store.nextId('gq'),
        assetId: a.id,
        word: a.word,
        kind,
        name: str(t.name || kind, 60),
        url: str(t.url || '', 300),
        status: t.url ? 'published' : 'queued',
        scheduledAt: str(scheduleAt || '', 40) || nowISO(),
        tries: 0,
        err: '',
        at: nowISO()
      };
      this.pubq().unshift(rec);
      created.push(rec);
    }
    a.status = 'published';
    a.dists = (a.dists || []).concat(created.map(x => x.id));
    a.updatedAt = nowISO();
    this.save('geo_pubq', true);
    this.save('geo_assets', true);
    this.log('info', '资产[' + a.word + '] 已入发布队列 ' + created.length + ' 条');
    return { ok: true, created, asset: a };
  }

  retryPublish(id) {
    const q = this.pubq().filter(x => x.id === id)[0];
    if (!q) return { ok: false, message: '任务不存在' };
    q.tries = (q.tries || 0) + 1;
    q.status = 'queued';
    q.err = '';
    q.at = nowISO();
    this.save('geo_pubq', true);
    return { ok: true, job: q };
  }

  /* ================= 7 探针采集 ================= */
  probes() {
    const packs = (this.opt.geoEngine && this.opt.geoEngine.packs()) || [];
    const snaps = this.snaps();
    const rows = [];
    packs.forEach(p => arr(p.words, 200).forEach(w => {
      const list = snaps.filter(s => s.word === w.word);
      const last = list.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))[0];
      rows.push({
        word: w.word, pack: p.name, packId: p.id,
        monitoring: p.monitoring !== false,
        lastAt: last ? last.at : '',
        lastCovered: last ? (last.brandHit ? 1 : 0) : 0,
        total: list.length
      });
    }));
    rows.sort((a, b) => (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0));
    return {
      rows: rows.slice(0, 300),
      stats: {
        words: rows.length,
        monitoring: rows.filter(r => r.monitoring).length,
        neverRun: rows.filter(r => !r.lastAt).length,
        snapshots: snaps.length,
        models: ENGINES.length
      }
    };
  }

  async runProbe(word, tenant) {
    const engine = this.opt.geoEngine;
    if (!engine) return { ok: false, message: '引擎未加载' };
    const r = await engine.probeOnce(String(word || '').trim(), tenant);
    return r;
  }

  snapshots(opt) {
    opt = opt || {};
    const q = String(opt.q || '').trim().toLowerCase();
    const model = String(opt.model || '').trim();
    const limit = clamp(Number(opt.limit) || 50, 1, 300);
    let list = this.snaps();
    if (model) list = list.filter(s => s.model === model);
    if (q) list = list.filter(s => (String(s.word) + ' ' + String(s.answer)).toLowerCase().indexOf(q) > -1);
    list = list.slice().sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
    return { total: list.length, list: list.slice(0, limit) };
  }

  /* ================= 8 报告中心 ================= */
  reportKinds() {
    return [
      { id: 'brand', name: '品牌综合诊断报告', desc: '指标趋势 + 竞品对比 + 信源分析 + 优化建议' },
      { id: 'vs', name: '竞品对标报告', desc: '逐词对比品牌与竞品的提及率、首推率' },
      { id: 'weekly', name: '周报', desc: '本周变化 + 新增收录 + 待办清单' },
      { id: 'monthly', name: '月报', desc: '月度趋势、词分区迁移、ROI 复盘' },
      { id: 'topic', name: '专项话题报告', desc: '指定词包/话题的深度分析' }
    ];
  }

  buildReport(kind, opt) {
    opt = opt || {};
    const d = this.dashboard(opt.rangeDays || 30);
    const packs = this.packsView();
    const assets = (this.opt.geoEngine && this.opt.geoEngine.assets()) || [];
    const lowAssets = assets.filter(a => a.qa && a.qa.score < 70).map(a => ({ id: a.id, word: a.word, title: a.title, score: a.qa.score }));
    const rep = {
      id: this.store.nextId('grpt'),
      kind: kind || 'brand',
      kindName: (this.reportKinds().filter(k => k.id === (kind || 'brand'))[0] || {}).name || '品牌综合诊断报告',
      at: nowISO(),
      rangeDays: d.rangeDays,
      summary: {
        mentionRate: d.all.mentionRate,
        firstRate: d.all.firstRate,
        top3Rate: d.all.top3Rate,
        sentiment: d.all.sentiment,
        compShare: d.all.compShare,
        words: d.tasks.words,
        assets: d.tasks.assets,
        published: d.tasks.published,
        lowAssets: lowAssets.length,
        snapshots: d.all.total
      },
      models: d.models,
      trend: d.trend,
      zones: d.zones,
      packs: packs.map(p => ({ id: p.id, name: p.name, words: p.count, zones: p.zones })),
      lowAssets: lowAssets.slice(0, 20),
      suggestions: this.suggestions(d, packs, lowAssets)
    };
    const arr0 = (this.opt.geoEngine && this.opt.geoEngine.reports()) || [];
    arr0.unshift(rep);
    if (arr0.length > 60) arr0.length = 60;
    this.save('geo_reports', true);
    this.log('info', '报告已生成：' + rep.kindName + ' · 快照 ' + rep.summary.snapshots);
    return rep;
  }

  suggestions(d, packs, lowAssets) {
    const out = [];
    if (!d.all.total) out.push('尚无探针快照，先接入监测上游或导入词包并启动采集，指标才有意义。');
    if (d.all.mentionRate < 30) out.push('整体提及率偏低：优先补「空白区」问句的资产页，并在高权重分站首发。');
    if (d.all.firstRate < 15) out.push('首推率不足：加强前置 Answer 答案块与参数表格，让 AI 有可直接摘取的结论。');
    if (d.all.compShare > 40) out.push('竞品占比偏高：针对敌占区问句做差异化对比内容，并加密媒体通稿信源。');
    if (lowAssets.length) out.push(lowAssets.length + ' 篇资产页质检 <70 分，建议回炉重写（补量化数据与权威信源）。');
    const blank = packs.reduce((n, p) => n + (p.zones && p.zones.blank || 0), 0);
    if (blank) out.push('有 ' + blank + ' 个问句处于空白区，是本期最值得投入的增量。');
    if (!out.length) out.push('当前结构健康，保持词包周更与探针高频采集即可。');
    return out.slice(0, 8);
  }

  /** 报告导出 CSV（明细，便于对账交付） */
  reportCsv(id) {
    const rep = ((this.opt.geoEngine && this.opt.geoEngine.reports()) || []).filter(r => r.id === id)[0];
    if (!rep) return null;
    const rows = [['指标', '数值']];
    Object.keys(rep.summary).forEach(k => rows.push([k, rep.summary[k]]));
    rows.push([]);
    rows.push(['模型', '样本数', '提及率%', '首推率%', 'TOP3率%', '情感分', '竞品占比%']);
    rep.models.forEach(m => rows.push([m.name, m.total, m.mentionRate, m.firstRate, m.top3Rate, m.sentiment, m.compShare]));
    rows.push([]);
    rows.push(['词包', '词数', '优势区', '敌占区', '空白区', '风险区']);
    rep.packs.forEach(p => rows.push([p.name, p.words, p.zones.advantage || 0, p.zones.enemy || 0, p.zones.blank || 0, p.zones.risk || 0]));
    return rows.map(r => r.map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\n');
  }

  /* ================= 9 页面诊断 ================= */
  async diag(input) {
    let html = '';
    let url = str(input.url, 300).trim();
    if (input.html) html = String(input.html).slice(0, 800000);
    if (!html && url) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 12000);
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
          signal: ctl.signal, redirect: 'follow'
        });
        clearTimeout(timer);
        if (!res.ok) return { ok: false, message: '抓取失败：HTTP ' + res.status + '（可改为粘贴页面 HTML 诊断）' };
        html = (await res.text()).slice(0, 800000);
      } catch (e) {
        return { ok: false, message: '抓取失败：' + ((e && e.name === 'AbortError') ? '超时（12s）' : String(e.message || e)) + '。可改为粘贴 HTML 诊断。' };
      }
    }
    if (!html) return { ok: false, message: '请填写页面 URL 或粘贴 HTML' };

    const text = htmlText(html);
    const h2s = (html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/gi) || []).map(x => htmlText(x));
    const h1s = html.match(/<h1[^>]*>/gi) || [];
    const title = htmlText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '';
    const links = (html.match(/<a\s[^>]*href=["'][^"'#]+["']/gi) || []).length;
    const imgs = html.match(/<img\s[^>]*>/gi) || [];
    const imgAlt = imgs.filter(i => /alt=["'][^"']+["']/i.test(i)).length;
    const firstBlock = text.slice(0, 260);
    const answerKeywords = /(先说结论|结论|答案是|一句话|核心答案|总的来说|简而言之|直接回答)/;

    const checks = {
      title: title.length >= 8 && title.length <= 70,
      desc: desc.length >= 30,
      h1: h1s.length === 1,
      answer: answerKeywords.test(firstBlock) || text.slice(0, 600).split(/[。！？]/).some(s => s.length > 60 && /\d|建议|推荐/.test(s)),
      h2q: h2s.filter(h => /[?？]|怎么|如何|哪些|为什么|多少|是否/.test(h)).length >= 2,
      table: /<table[\s>]/i.test(html),
      faq: /(FAQ|常见问题|问答)/i.test(html) && /<h2|<h3/i.test(html),
      schema: /application\/ld\+json/i.test(html),
      canonical: /rel=["']canonical["']/i.test(html),
      links: links >= 3,
      imgalt: imgs.length === 0 ? false : (imgAlt / imgs.length) >= 0.6,
      viewport: /name=["']viewport["']/i.test(html),
      words: text.replace(/\s/g, '').length >= 600
    };

    const items = DIAG_RULES.map(r => ({
      key: r.key, label: r.label, weight: r.w, ok: !!checks[r.key],
      detail: this.diagDetail(r.key, { title, desc, h1: h1s.length, h2q: h2s.length, links, imgs: imgs.length, imgAlt, chars: text.replace(/\s/g, '').length })
    }));
    const score = items.reduce((s, i) => s + (i.ok ? i.weight : 0), 0);
    const rec = {
      id: this.store.nextId('gdg'),
      url: url || '(粘贴 HTML)',
      score,
      grade: score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D',
      items,
      fixes: items.filter(i => !i.ok).sort((a, b) => b.weight - a.weight).map(i => '【' + i.weight + '分】' + i.label + '：' + i.detail),
      chars: text.replace(/\s/g, '').length,
      at: nowISO()
    };
    this.diags().unshift(rec);
    if (this.diags().length > 100) this.diags().length = 100;
    this.save('geo_diag', true);
    this.log('info', '页面诊断完成：' + rec.url + ' · ' + score + ' 分（' + rec.grade + '）');
    return { ok: true, result: rec };
  }

  diagDetail(key, ctx) {
    switch (key) {
      case 'title': return '当前标题 ' + ctx.title.length + ' 字：' + (ctx.title.slice(0, 40) || '（缺失）');
      case 'desc': return ctx.desc ? '摘要 ' + ctx.desc.length + ' 字' : '缺少 meta description';
      case 'h1': return 'H1 数量 ' + ctx.h1;
      case 'answer': return '首屏未见「结论先行」的答案块';
      case 'h2q': return 'H2 共 ' + ctx.h2q + ' 个，问句式不足 2 个';
      case 'table': return '未检测到参数/对比表格';
      case 'faq': return '未检测到 FAQ 问答区块';
      case 'schema': return '未挂载 JSON-LD 结构化数据';
      case 'canonical': return '缺少 canonical 规范链接';
      case 'links': return '站内链接 ' + ctx.links + ' 条（建议 ≥3）';
      case 'imgalt': return '图片 ' + ctx.imgs + ' 张，alt 覆盖 ' + ctx.imgAlt + ' 张';
      case 'viewport': return '缺少移动端 viewport';
      case 'words': return '正文有效字数 ' + ctx.chars + '（建议 ≥600）';
      default: return '';
    }
  }

  /* ================= 10 客户 & 权限 ================= */
  addTenant(body) {
    const rec = {
      id: this.store.nextId('gt'),
      name: str(body.name || '未命名客户', 60),
      plan: str(body.plan || '标准版', 20),
      contact: str(body.contact || '', 40),
      quota: {
        assets: clamp(Number(body.assets) || 50, 1, 100000),
        media: clamp(Number(body.media) || 20, 0, 100000),
        probeGb: clamp(Number(body.probeGb) || 5, 0, 10000)
      },
      used: { assets: Number(body.usedAssets) || 0, media: Number(body.usedMedia) || 0, probeGb: Number(body.usedProbe) || 0 },
      subs: [],
      status: 'active',
      createdAt: nowISO()
    };
    this.tenants().unshift(rec);
    this.save('geo_tenants', true);
    return rec;
  }

  addSub(tenantId, body) {
    const t = this.tenants().filter(x => x.id === tenantId)[0];
    if (!t) return { ok: false, message: '客户不存在' };
    const role = ['admin', 'ops', 'cs', 'viewer'].indexOf(body.role) > -1 ? body.role : 'viewer';
    const s = { id: this.store.nextId('gu'), name: str(body.name || '子账号', 40), role, at: nowISO() };
    t.subs = (t.subs || []).concat(s);
    this.save('geo_tenants', true);
    return { ok: true, sub: s };
  }

  delTenant(id) {
    const a = this.tenants();
    const i = a.findIndex(x => x.id === id);
    if (i < 0) return false;
    a.splice(i, 1);
    this.save('geo_tenants', true);
    return true;
  }

  /* ================= 11 系统设置 ================= */
  getSettings() {
    const s = this.settings() || {};
    const llmCfg = (() => {
      try { return require('./geo-engine').llmCfg(this.store); } catch (e) { return null; }
    })();
    return {
      settings: {
        watermark: s.watermark !== false,
        notifyWebhook: s.notifyWebhook || '',
        notifyEmail: s.notifyEmail || '',
        retentionDays: Number(s.retentionDays) || 90,
        storageDir: s.storageDir || '.data',
        gateway: s.gateway || { models: ENGINES, fallback: true }
      },
      llm: llmCfg ? { enabled: true, model: llmCfg.model || '', baseUrl: llmCfg.base_url || '' } : { enabled: false },
      env: {
        geoUpstream: !!process.env.GEO_UPSTREAM,
        geoToken: !!process.env.GEO_TOKEN,
        geoMode: process.env.GEO_MODE || '',
        mode: process.env.NODE_ENV || 'development'
      }
    };
  }

  saveSettings(patch) {
    const prev = this.settings() || {};
    const next = Object.assign({}, prev, patch || {}, { updatedAt: nowISO() });
    if (next.retentionDays != null) next.retentionDays = clamp(Number(next.retentionDays) || 90, 7, 3650);
    this.store.data.geo_settings = [next];
    this.save('geo_settings', true);
    return next;
  }

  /* ================= 示例数据（明确标记 demo） ================= */
  seedDemo() {
    const packs = (this.opt.geoEngine && this.opt.geoEngine.packs()) || [];
    let words = [];
    packs.forEach(p => arr(p.words, 500).forEach(w => words.push(w.word)));
    if (!words.length) words = ['高端女装定制', '杭州婚纱摄影', '企业宣传片拍摄', '短视频代运营', '厂房环氧地坪'];
    words = words.slice(0, 8);

    const snaps = [];
    const days = 30;
    for (let i = days - 1; i >= 0; i--) {
      const at = new Date(Date.now() - i * 86400000).toISOString();
      words.forEach(w => {
        ENGINES.slice(0, 5).forEach(m => {
          const seed = w + m + i;
          const base = 0.35 + 0.35 * Math.sin((i / days) * 3.14);
          const p = clamp(base + (rnd(seed) - 0.5) * 0.35, 0.05, 0.95);
          const brandHit = rnd(seed + 'h') < p;
          const compHit = rnd(seed + 'c') < 0.55;
          const rank = brandHit ? (rnd(seed + 'r') < 0.28 ? 1 : 1 + Math.floor(rnd(seed + 'rr') * 8)) : 0;
          snaps.push({
            id: this.store.nextId('gn'),
            word: w, model: m, rank, brandHit, compHit,
            sentiment: brandHit ? (rnd(seed + 's') < 0.75 ? 1 : 0) : (rnd(seed + 's2') < 0.3 ? -1 : 0),
            answer: brandHit
              ? '在回答「' + w + '」时，' + (this.opt.geoEngine && this.opt.geoEngine.org() && this.opt.geoEngine.org().brand || '某品牌') + ' 因参数完整、案例可核验被列为第 ' + rank + ' 位推荐。'
              : '在回答「' + w + '」时，主要引用行业门户与竞品内容，未出现本品牌。',
            citations: [{ url: 'https://example.com/' + encodeURIComponent(w), title: '示例信源 · ' + w }],
            at, demo: true
          });
        });
      });
    }
    this.store.data.geo_snaps = snaps.concat(this.snaps().filter(s => !s.demo)).slice(0, 5000);
    this.save('geo_snaps', true);

    if (!this.sites().length) {
      this.store.data.geo_sites = [
        { id: this.store.nextId('gs'), name: '杭州站', url: 'https://hz.example.com', type: 'city', group: '华东', weight: 'core', apiKey: '', status: { ok: true, checkedAt: nowISO(), msg: '抓取正常' }, createdAt: nowISO() },
        { id: this.store.nextId('gs'), name: '苏州站', url: 'https://sz.example.com', type: 'city', group: '华东', weight: 'aux', apiKey: '', status: { ok: true, checkedAt: nowISO(), msg: '抓取正常' }, createdAt: nowISO() },
        { id: this.store.nextId('gs'), name: '行业站 · 婚纱摄影', url: 'https://wedding.example.com', type: 'industry', group: '垂类', weight: 'core', apiKey: '', status: { ok: false, checkedAt: nowISO(), msg: 'robots 声明 noindex' }, createdAt: nowISO() }
      ];
      this.save('geo_sites', true);
    }
    if (!this.channels().length) {
      this.store.data.geo_channels = [
        { id: this.store.nextId('gc'), kind: 'media', name: '中国网 · 生活频道', account: '', status: 'active', meta: { price: 680, region: '全国' }, createdAt: nowISO() },
        { id: this.store.nextId('gc'), kind: 'media', name: '杭州日报 · 城市版', account: '', status: 'active', meta: { price: 480, region: '杭州' }, createdAt: nowISO() },
        { id: this.store.nextId('gc'), kind: 'social', name: '百家号 · 品牌号', account: 'brand-baijia', status: 'active', meta: {}, createdAt: nowISO() },
        { id: this.store.nextId('gc'), kind: 'social', name: '知乎 · 机构号', account: 'brand-zhihu', status: 'pending', meta: {}, createdAt: nowISO() },
        { id: this.store.nextId('gc'), kind: 'video', name: '视频号 · 主号', account: 'brand-sph', status: 'active', meta: {}, createdAt: nowISO() }
      ];
      this.save('geo_channels', true);
    }
    if (!this.tenants().length) {
      this.store.data.geo_tenants = [
        { id: this.store.nextId('gt'), name: '示例客户 · 智推全域', plan: '旗舰版', contact: '138****0000', quota: { assets: 200, media: 60, probeGb: 20 }, used: { assets: 64, media: 18, probeGb: 6.2 }, subs: [{ id: this.store.nextId('gu'), name: '运营小王', role: 'ops', at: nowISO() }], status: 'active', createdAt: nowISO() }
      ];
      this.save('geo_tenants', true);
    }
    this.log('info', '示例数据已载入（demo）：快照 ' + snaps.length + ' 条');
    return { ok: true, snapshots: snaps.length, demo: true };
  }

  clearDemo() {
    this.store.data.geo_snaps = this.snaps().filter(s => !s.demo);
    this.save('geo_snaps', true);
    return { ok: true, remaining: this.snaps().length };
  }
}

module.exports = { GeoConsole, DIAG_RULES, ENGINE_NAMES, ENGINES, ZONE_LABEL };
