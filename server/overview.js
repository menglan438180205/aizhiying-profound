'use strict';
/* =========================================================
   overview.js — 首屏聚合（GET /v1/overview）
   ---------------------------------------------------------
   改造前：看板一次刷新要串 2 个请求
       GET /v1/collect/leads?limit=80   （线索 + 打分）
       GET /v1/billing/summary          （订阅 + 额度）
   两份数据各自到达、各自渲染，前端还要自己再统计一遍分档/平台/
   今日新增；两个接口的「口径」也就此分成两套。

   现在只暴露一个只读快照：线索、统计、GEO 管线、剪辑队列、计费
   一次取回，数字全部来自服务端同一时刻的同一份数据。旧的两个接口
   保留不动（外部脚本、桥、老页面还在用），本接口是纯增量。

   设计约束：
     · 纯读：不写库、不发事件、不触发采集/渲染；
     · 单次遍历线索：统计与列表用同一份数组，避免「列表 80 条、
       统计按全量」被误读成两套数据；
     · 每个子块独立容错：GEO/计费任何一块抛错只让该块降级为 null，
       不能因为一个模块没初始化就把整个看板打成 500。
   ========================================================= */

/* 线索统计：只遍历一次，结果与 leads 列表同源 */
function leadsStats(leads, now) {
  const t0 = new Date(now);
  t0.setHours(0, 0, 0, 0);
  const dayStart = t0.getTime();
  const weekStart = dayStart - 6 * 864e5;
  const by = { level: {}, status: {}, platform: {}, channel: {} };
  let today = 0;
  let week = 0;
  let scored = 0;
  let withOrigin = 0;
  let scoreSum = 0;
  let amount = 0;

  (leads || []).forEach((l) => {
    if (!l) return;
    const at = Date.parse(l.created_at || l.at || '') || 0;
    if (at >= dayStart) today++;
    if (at >= weekStart) week++;
    const lv = l.level || 'noise';
    by.level[lv] = (by.level[lv] || 0) + 1;
    const st = l.status || 'new';
    by.status[st] = (by.status[st] || 0) + 1;
    const pf = l.platform || 'unknown';
    by.platform[pf] = (by.platform[pf] || 0) + 1;
    const ch = l.channel || (l.simulated ? 'local' : 'unknown');
    by.channel[ch] = (by.channel[ch] || 0) + 1;
    if (l.score !== undefined && l.score !== null) { scored++; scoreSum += Number(l.score) || 0; }
    /* 「含原始评论」口径：有 comment 原文才算，不是有线索就算 */
    if (String(l.comment || '').trim()) withOrigin++;
    amount += Number(l.amount) || 0;
  });

  const total = (leads || []).length;
  /* 阶段口径：服务端原始状态和前端阶段两套词表都可能出现在库里
     （前端写入过 sent/nego/deal，服务端种子是 contacted/won/lost），
     这里把「加微及以上」与「已成交」按并集统计，避免漏算。 */
  const addedStatus = ['wechat', 'won', 'nego', 'deal'];
  const added = addedStatus.reduce((s, k) => s + (by.status[k] || 0), 0);
  const deals = (by.status.won || 0) + (by.status.deal || 0);
  return {
    total: total,
    today: today,
    week: week,
    scored: scored,
    withOrigin: withOrigin,
    avgScore: scored ? Math.round(scoreSum / scored) : 0,
    newCount: by.status.new || 0,
    touched: total - (by.status.new || 0),
    added: added,
    deals: deals,
    amount: amount,
    byLevel: by.level,
    byStatus: by.status,
    byPlatform: by.platform,
    byChannel: by.channel
  };
}

/* 每个块单独兜底：某块炸了返回 null，绝不拖垮整份快照 */
function safe(fn) {
  try { return fn(); } catch (e) { return null; }
}

/**
 * @param {object} deps  { store, collectSched, geoEngine, billing, queue }
 * @param {object} opts  { tenant, leadLimit, now }
 */
function buildOverview(deps, opts) {
  const d = deps || {};
  const o = opts || {};
  const now = Number(o.now) || Date.now();
  const tenant = o.tenant || 'default';
  const limit = Math.max(1, Math.min(500, Number(o.leadLimit) || 80));

  const all = (d.collectSched && d.collectSched.leads) ? d.collectSched.leads() : [];
  const stats = leadsStats(all, now);

  const geo = d.geoEngine && typeof d.geoEngine.overview === 'function'
    ? safe(() => {
      const g = d.geoEngine.overview() || {};
      const org = g.org || null;
      return {
        stages: g.stages || null,
        llm: g.llm || null,
        orgName: (org && (org.name || org.brand || org.company)) || '',
        lastReportAt: (g.lastReport && (g.lastReport.createdAt || g.lastReport.at)) || ''
      };
    })
    : null;

  const edit = d.queue && typeof d.queue.stats === 'function' ? safe(() => d.queue.stats()) : null;
  const billing = d.billing && typeof d.billing.summary === 'function' ? safe(() => d.billing.summary(tenant)) : null;

  return {
    generatedAt: new Date(now).toISOString(),
    tenant: tenant,
    /* 与 GET /v1/collect/leads 完全相同的行结构：前端不必为聚合接口再写一套映射 */
    leads: (all || []).slice(0, limit),
    leadStats: stats,
    geo: geo,
    edit: edit,
    billing: billing,
    /* 口径声明：前端「数据来源」标签直接读它，不靠猜 */
    sources: {
      leads: 'collect_leads（去重后的采集线索池）',
      geo: 'geo_engine（GEO 九级管线）',
      edit: 'render_queue（剪辑渲染队列，进程内）',
      billing: 'billing_subscriptions / billing_usage',
      generatedAt: new Date(now).toISOString()
    }
  };
}

module.exports = { buildOverview, leadsStats };
