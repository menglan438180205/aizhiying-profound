'use strict';
/* =========================================================
   collect-campaigns.js — 战役层
   ---------------------------------------------------------
   一场战役 = 一个行业/城市 + 一组关键词 + 一组平台 + 一组竞品。
   战役本身不直接抓数据：开始时把「关键词 × 平台」拆成 collect_tasks，
   由现有调度器/本机采集器执行。这样读写链路仍然分开，任务可单独暂停、
   重跑、审计。

   账号选择：优先用该平台「有效且已登录」的账号；没有就留空走通道默认。
   ========================================================= */

const PLATFORMS = ['douyin', 'xhs', 'kuaishou', 'sph'];
const MAX_KEYWORDS = 20;
const MAX_COMPETITORS = 20;
const MAX_INTENTS = 20;

function listOf(v, max) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\n,，、;；]+/);
  const out = [];
  const seen = {};
  for (const x of arr) {
    const s = String(x || '').trim().slice(0, 120);
    if (!s || seen[s]) continue;
    seen[s] = true;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function nowIso() { return new Date().toISOString(); }

function createCampaigns(store, opt) {
  const sched = opt.sched;
  const accounts = opt.accounts;
  const comments = opt.comments;

  function campaigns() {
    if (!Array.isArray(store.data.collect_campaigns)) store.data.collect_campaigns = [];
    return store.data.collect_campaigns;
  }
  function get(id) { return campaigns().filter((c) => c.id === id)[0] || null; }

  function save(input, tenant, id) {
    const s = input || {};
    const keywords = listOf(s.keywords, MAX_KEYWORDS);
    if (!keywords.length) {
      return { error: { code: 'KEYWORDS_REQUIRED', message: '至少填一个关键词' } };
    }
    const platforms = listOf(s.platforms, 4).filter((p) => PLATFORMS.indexOf(p) > -1);
    if (!platforms.length) {
      return { error: { code: 'PLATFORMS_REQUIRED', message: '至少选择一个平台' } };
    }
    const name = String(s.name || '').trim().slice(0, 40)
      || (String(s.industry || '').trim() ? String(s.industry).trim().slice(0, 12) + ' · ' : '')
        + keywords[0].slice(0, 16);
    /* 账号绑定：每个平台可选一个有效账号；不选则开始时自动挑已登录的 */
    const accountIds = {};
    if (s.accountIds && typeof s.accountIds === 'object') {
      for (const p of platforms) {
        const id = String(s.accountIds[p] || '').trim().slice(0, 40);
        if (!id || !accounts || !accounts.get) continue;
        const a = accounts.get(id);
        if (a && a.platform === p && a.status === 'active') accountIds[p] = id;
      }
    }
    const rec = {
      id: id || store.nextId('cc'),
      name: name,
      industry: String(s.industry || '').trim().slice(0, 30),
      city: String(s.city || '').trim().slice(0, 30),
      keywords: keywords,
      competitors: listOf(s.competitors, MAX_COMPETITORS),
      platforms: platforms,
      accountIds: accountIds,
      dailyLimit: Math.max(1, Math.min(200, Number(s.dailyLimit) || 40)),
      intentWords: listOf(s.intentWords, MAX_INTENTS),
      every: String(s.every || '1h').slice(0, 20),
      status: id ? (get(id) || {}).status || 'draft' : 'draft',
      taskIds: id ? ((get(id) || {}).taskIds || []) : [],
      tenant: tenant || (id ? (get(id) || {}).tenant : 'default') || 'default',
      createdAt: id ? (get(id) || {}).createdAt || nowIso() : nowIso(),
      updatedAt: nowIso(),
      lastStartedAt: id ? (get(id) || {}).lastStartedAt || '' : ''
    };
    const list = campaigns();
    if (id) {
      const i = list.findIndex((c) => c.id === id);
      if (i < 0) return { error: { code: 'NOT_FOUND', message: '战役不存在' } };
      list[i] = rec;
    } else {
      list.unshift(rec);
    }
    store.save(true, 'collect_campaigns');
    return { campaign: rec };
  }

  function pickAccount(platform) {
    const all = accounts && accounts.list ? accounts.list() : [];
    const active = all.filter((a) => a.platform === platform && a.status === 'active');
    return active.filter((a) => a.profileDir)[0] || active[0] || null;
  }

  function start(id) {
    const c = get(id);
    if (!c) return { error: { code: 'NOT_FOUND', message: '战役不存在' } };
    const tasks = sched.tasks();
    const out = { created: 0, reused: 0, skipped: 0, skippedPlatforms: [], taskIds: [] };
    const seen = {};
    for (const platform of c.platforms) {
      const bound = c.accountIds && c.accountIds[platform] ? accounts.get(c.accountIds[platform]) : null;
      const acc = (bound && bound.status === 'active' && bound.platform === platform) ? bound : pickAccount(platform);
      /* 没登录的平台上没有可用账号：跳过，别建任务去弹平台登录页 */
      if (!acc) {
        out.skipped += c.keywords.length;
        out.skippedPlatforms.push(platform);
        /* 该平台旧任务也停掉，避免继续弹登录页 */
        tasks.filter((t) => t.campaignId === c.id && t.platform === platform)
          .forEach((t) => { t.enabled = false; });
        continue;
      }
      for (const keyword of c.keywords) {
        const key = platform + '|' + keyword;
        if (seen[key]) continue;
        seen[key] = true;
        let t = tasks.filter((x) => x.campaignId === c.id && x.platform === platform && x.keyword === keyword)[0];
        if (t) {
          t.enabled = true;
          t.nextRunAt = Date.now();
          if (acc) t.accountId = acc.id;
          out.reused++;
          out.taskIds.push(t.id);
          continue;
        }
        const r = sched.addTask({
          target: 'keyword',
          platform: platform,
          keyword: keyword,
          every: c.every || '1h',
          limit: 20,
          region: c.city || '',
          intentWords: c.intentWords || [],
          accountId: acc ? acc.id : '',
          campaignId: c.id,
          tenant: c.tenant,
          tags: ['战役:' + c.name.slice(0, 16)]
        });
        if (r.ok) {
          r.task.nextRunAt = Date.now();
          out.created++;
          out.taskIds.push(r.task.id);
        } else {
          out.skipped++;
        }
      }
    }
    c.taskIds = Array.from(new Set((c.taskIds || []).concat(out.taskIds)));
    c.status = 'running';
    c.lastStartedAt = nowIso();
    c.updatedAt = nowIso();
    store.save(true, 'collect_campaigns');
    store.save(true, 'collect_tasks');
    return { campaign: c, result: out, tasks: out.taskIds.map((tid) => sched.task(tid)).filter(Boolean) };
  }

  function setEnabled(id, enabled) {
    const c = get(id);
    if (!c) return { error: { code: 'NOT_FOUND', message: '战役不存在' } };
    const tasks = sched.tasks().filter((t) => t.campaignId === c.id);
    tasks.forEach((t) => {
      t.enabled = !!enabled;
      if (enabled) t.nextRunAt = Date.now();
    });
    c.status = enabled ? 'running' : 'paused';
    c.updatedAt = nowIso();
    store.save(true, 'collect_campaigns');
    store.save(true, 'collect_tasks');
    return { campaign: c, tasks: tasks.length };
  }

  function remove(id) {
    const list = campaigns();
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) return false;
    /* 删除战役时同时移除它拆出来的任务；历史 runs/leads 保留便于追溯 */
    const tasks = sched.tasks();
    let removedTasks = 0;
    for (let k = tasks.length - 1; k >= 0; k--) {
      if (tasks[k] && tasks[k].campaignId === id) { tasks.splice(k, 1); removedTasks++; }
    }
    list.splice(i, 1);
    store.save(true, 'collect_campaigns');
    if (removedTasks) store.save(true, 'collect_tasks');
    return { removed: id, tasks: removedTasks };
  }

  /** 战役战果：作品、高意向线索、评论队列/失败数 */
  function stats(id) {
    const c = get(id);
    if (!c) return null;
    const taskIds = new Set(c.taskIds || []);
    const notes = (store.data.collect_notes || []).filter((n) =>
      n && (n.campaignId === id || taskIds.has(n.taskId)));
    const leads = (store.data.collect_leads || []).filter((l) =>
      l && (l.campaignId === id || taskIds.has(l.taskId)));
    const cmts = (store.data.collect_comments || []).filter((x) => x && x.campaignId === id);
    const cTasks = sched.tasks().filter((t) => t && t.campaignId === id);
    const taskSet = new Set(cTasks.map((t) => t.id));
    const runs = sched.runs().filter((r) => r && taskSet.has(r.taskId))
      .sort((a, b) => (Date.parse(b.at || 0) || 0) - (Date.parse(a.at || 0) || 0));
    const lastRun = runs[0] || null;
    const count = (arr, status) => arr.filter((x) => x.status === status).length;
    return {
      works: notes.length,
      leads: leads.length,
      high: leads.filter((l) => (l.level || 'noise') === 'high').length,
      comments: cmts.length,
      pending: count(cmts, 'pending'),
      sent: count(cmts, 'sent'),
      failed: count(cmts, 'failed'),
      taskCount: cTasks.length,
      taskFailed: cTasks.filter((t) => t.lastStatus === 'failed').length,
      lastRunStatus: lastRun ? (lastRun.status || '') : '',
      lastRunReason: lastRun ? (lastRun.reason || '') : '',
      lastRunNote: lastRun ? (lastRun.note || '') : '',
      lastRunAt: lastRun ? (lastRun.at || '') : ''
    };
  }

  /** 战役 → 触达任务：把该战役的作品/B 端高意向线索交给评论队列 */
  async function engage(id, opts) {
    const c = get(id);
    if (!c) return { error: { code: 'NOT_FOUND', message: '战役不存在' } };
    if (!comments) return { error: { code: 'COMMENTS_UNAVAILABLE', message: '评论队列未启动' } };
    const taskIds = new Set(c.taskIds || []);
    const notes = (store.data.collect_notes || []).filter((n) =>
      n && n.url && (n.campaignId === id || taskIds.has(n.taskId)));
    const items = [];
    const seen = new Set();
    const accFor = (platform) => {
      const bound = c.accountIds && c.accountIds[platform] ? accounts.get(c.accountIds[platform]) : null;
      return (bound && bound.status === 'active' && bound.platform === platform) ? bound : pickAccount(platform);
    };
    const add = (n) => {
      const url = String(n.url || n.video_url || '');
      if (!url || seen.has(url)) return;
      seen.add(url);
      const platform = n.platform || c.platforms[0] || 'douyin';
      const acc = accFor(platform);
      items.push({
        noteKey: (n.note_id || n.noteId || url),
        note_id: n.note_id || '',
        platform: platform,
        url: url,
        title: n.title || '',
        author: n.author || '',
        keyword: n.keyword || '',
        campaignId: c.id,
        accountId: acc ? acc.id : ''
      });
    };
    notes.forEach(add);
    /* 没有作品索引时，用高意向线索的 video_url 兜底 */
    if (!items.length) {
      (store.data.collect_leads || [])
        .filter((l) => l && l.video_url && (l.campaignId === id || taskIds.has(l.taskId)))
        .sort((a, b) => (b.level === 'high' ? 1 : 0) - (a.level === 'high' ? 1 : 0))
        .forEach((l) => add({
          note_id: l.cid || '', platform: l.platform, url: l.video_url,
          title: l.video_title || l.video || '', author: l.author || '',
          keyword: l.keyword || ''
        }));
    }
    const limit = Math.max(1, Math.min(Number(opts && opts.limit) || 1, 10));
    const take = items.slice(0, limit);
    if (!take.length) {
      return { error: { code: 'NO_WORKS', message: '这场战役还没有可触达的作品；先等一轮采集完成' } };
    }
    const r = await comments.batch({ mode: (opts && opts.mode) || 'ai', campaignId: c.id, items: take });
    return { result: r, stats: stats(id), limit: take.length };
  }

  async function retryFailed(id, opts) {
    const c = get(id);
    if (!c) return { error: { code: 'NOT_FOUND', message: '战役不存在' } };
    if (!comments) return { error: { code: 'COMMENTS_UNAVAILABLE', message: '评论队列未启动' } };
    const list = comments.list({ campaignId: id, status: 'failed', limit: 20 }).items || [];
    const out = { retried: 0, skipped: 0 };
    for (const cRec of list.slice(0, 10)) {
      const r = comments.retry(cRec.noteKey);
      if (r && !r.error) out.retried++; else out.skipped++;
    }
    return { result: out, stats: stats(id) };
  }

  function listWithStats() { return campaigns().map((c) => Object.assign({}, c, { stats: stats(c.id) })); }

  return { list: campaigns, listWithStats, get, save, start, pause: (id) => setEnabled(id, false), resume: (id) => setEnabled(id, true), remove, stats, engage, retryFailed, PLATFORMS };
}

module.exports = { createCampaigns, PLATFORMS };
