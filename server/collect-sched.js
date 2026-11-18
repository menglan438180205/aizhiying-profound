'use strict';
/* =========================================================
   collect-sched.js — 评论区采集「定时调度 + 队列 + Worker」
   ---------------------------------------------------------
   在此之前，采集只能由前端点「立即采集一轮」触发 —— 手工、不连续、
   关掉页面就停。生产形态必须是在服务端常驻的调度：

        ┌────────────┐   tick(30s)   ┌──────────────┐
        │ CronScheduler │ ───────────▶ │ 到点的任务队列 │
        └────────────┘               └──────┬───────┘
                                            │ 有界并发（COLLECT_CONCURRENCY）
                                            ▼
                                   collector.collect()  ──▶ 上游采集服务
                                            │
                       指纹去重（platform|nickname|comment）│
                                            ▼
                        collect_runs（本轮明细） + collect_leads（线索池）

   每个任务可指定采集通道与采集范围（二者共同决定实际走哪条上游）：
     channel  auto | official | crawler | vendor | local
              auto（默认）= 按 scope 的候选顺序挑第一条已配置的通道
     scope    auto | own（自有内容评论区）| keyword（关键词搜公开内容）
              默认 auto —— 只接了官方通道时也能自动落到官方通道上，
              不必让每个任务都手填 scope

   四条与采集器一致的铁律：
     1) 一条真实通道都没接且未显式打开 ALLOW_LOCAL_COLLECT 时，tick 直接返回，
        **不自动生成任何数据**；手动触发会如实记录 skipped 而不是成功。
     2) 任务显式指定了通道但该通道未接入 → 记 failed（配置错误），
        **绝不用模拟数据掩盖**；只有「一条通道都没接」才算 skipped。
     3) 本地模拟产生的数据一律带 source='local-simulated'，且 run.simulated=true。
     4) 同一个 (keyword) 只保留一条任务，避免重复配额消耗（接口层返回 409）。
   ========================================================= */

const crypto = require('crypto');
const collector = require('./collector');
const schedule = require('./schedule');
const registry = require('./collect-adapters/registry');
const { normPlatform } = require('./collect-devices');
const intent = require('./intent');
const tenantMod = require('./tenant');

const MAX_RUNS = 300;          /* 运行记录上限（超出后从尾部裁掉） */
const MAX_LEADS = 5000;        /* 线索池上限 */
const MAX_ITEMS_PER_RUN = 100; /* 单轮明细落库条数上限 */
const MAX_SEEN = 3000;         /* 单任务去重指纹记忆上限 */
const PLATFORMS = ['douyin', 'kuaishou', 'xhs', 'sph'];
/* 目标类型：决定「去哪里找评论」，与「找什么样的评论」分开
     keyword  按关键词搜公开内容（默认）
     author   盯某个博主（博主昵称或主页链接）的全部作品评论区
     video    盯某一条作品（作品链接或 ID）
     region   按地域扫同城内容
   前三种在上游都落到同一个契约（platform/keyword/limit/region），
   差异由 author / video 两个额外字段表达，桥侧识别，通用上游自动降级为关键词。 */
const TARGETS = ['keyword', 'author', 'video', 'region'];

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/**
 * 归一化任务的「采集通道 + 采集范围」。
 * channel=auto 时不写死具体通道，由 collector.resolveChannel 在运行时按
 * 当时的配置决定 —— 这样先上官方通道、后补爬虫，历史任务不用改。
 * @returns {{ok:true,channel:string,scope:string}|{ok:false,error:{code:string,message:string}}}
 */
function normalizeRoute(s) {
  const src = s || {};
  const rawCh = String(src.channel == null ? '' : src.channel).trim().toLowerCase();
  const ch = rawCh === '' ? 'auto' : rawCh;
  if (registry.CHANNEL_IDS.indexOf(ch) === -1) {
    return {
      ok: false,
      error: {
        code: 'CHANNEL_INVALID',
        message: '不支持的采集通道「' + rawCh + '」，可选：' + registry.CHANNEL_IDS.join(' / ')
      }
    };
  }
  const rawSc = String(src.scope == null ? '' : src.scope).trim().toLowerCase();
  let sc = rawSc === '' ? 'auto' : rawSc;
  if (registry.SCOPE_IDS.indexOf(sc) === -1) {
    return {
      ok: false,
      error: {
        code: 'SCOPE_INVALID',
        message: '不支持的采集范围「' + rawSc + '」，可选：' + registry.SCOPE_IDS.join(' / ')
      }
    };
  }
  /* 官方开放能力只能读自有账号作品，指定官方通道时把范围纠成 own，
     而不是让用户提交一个必然失败的组合 */
  if (ch === 'official' && sc === 'auto') sc = 'own';
  /* 反向同样纠偏：范围是 own 但通道写成 vendor（其契约里根本没有 scope
     字段，会静默按关键词搜公开内容），明确报错比运行期跑错更早暴露问题。
     local 与 crawler 都实现了 own 语义，允许。 */
  if (sc === 'own' && ch === 'vendor') {
    return {
      ok: false,
      error: {
        code: 'SCOPE_UNSUPPORTED',
        message: registry.def(ch).name + '不支持「自有内容评论区」范围，请改用 official 通道或把范围改为 keyword'
      }
    };
  }
  return { ok: true, channel: ch, scope: sc };
}

function fpOf(c) {
  return crypto.createHash('sha1')
    .update([c.platform || '', c.nickname || '', String(c.comment || '').slice(0, 80)].join('|'))
    .digest('hex').slice(0, 16);
}

class CollectScheduler {
  constructor(store, opt) {
    this.store = store;
    this.opt = opt || {};
    this.timer = null;
    this.running = false;
    this.inflight = 0;
    this.concurrency = clamp(Number(process.env.COLLECT_CONCURRENCY || 2), 1, 8);
    this.period = clamp(Number(process.env.COLLECT_TICK_MS || 30000), 5000, 600000);
    this.lastTickAt = 0;
    this.lastError = '';
    this.totalRuns = 0;
    this.totalLeads = 0;
  }

  /* ---------- 集合访问 ---------- */
  tasks() { return this.store.data.collect_tasks; }
  runs() { return this.store.data.collect_runs; }
  leads() { return this.store.data.collect_leads; }
  task(id) { return this.tasks().filter((t) => t.id === id)[0] || null; }
  runsOf(taskId, limit) {
    return this.runs().filter((r) => !taskId || r.taskId === taskId).slice(0, limit || 30);
  }

  /* ---------- 任务 CRUD ---------- */
  normalize(input) {
    const s = input || {};
    const target = TARGETS.indexOf(String(s.target || '').trim()) > -1 ? String(s.target).trim() : 'keyword';
    const ref = String(s.ref || '').trim().slice(0, 200);
    const platform = PLATFORMS.indexOf(String(s.platform || '')) > -1 ? String(s.platform) : 'douyin';
    const limit = clamp(Number(s.limit || 20), 1, 50);
    let region = String(s.region || '').trim().slice(0, 30);
    const pick = normalizeRoute(s);
    if (!pick.ok) return { ok: false, error: pick.error };
    const spec = {};
    if (s.cron) spec.cron = String(s.cron).trim();
    else spec.every = s.every || '1h';
    const v = schedule.validateSchedule(spec);
    if (!v.ok) return { ok: false, error: v };

    /* 目标必填校验：按类型分别要求，不再一律要关键词 ——
       「盯某个博主」本来就没有关键词，硬要一个只会逼用户乱填。 */
    if (target !== 'keyword' && !ref) {
      const label = { author: '博主昵称或主页链接', video: '作品链接或作品 ID', region: '城市名' }[target] || '目标';
      return { ok: false, error: { code: 'REF_REQUIRED', message: '请填写' + label } };
    }
    /* 地域目标把 ref 直接当采集地域用，少一个字段要填 */
    if (target === 'region') region = ref.slice(0, 30);

    let keyword = String(s.keyword || '').trim().slice(0, 60);
    /* 非关键词目标：关键词留空，上游契约里也不能是空串 ——
       用 ref 兜底，保证通用上游（只认 keyword）至少不会收到 undefined。 */
    if (!keyword) {
      if (target === 'keyword') {
        return { ok: false, error: { code: 'KEYWORD_REQUIRED', message: '请填写要监听的关键词' } };
      }
      keyword = ref.slice(0, 60);
    }

    /* 意向词：运营自己定义的最准，去重、截断、限量 */
    const words = (Array.isArray(s.intentWords) ? s.intentWords : [])
      .map((w) => String(w || '').trim().slice(0, 12))
      .filter(Boolean);
    const intentWords = Array.from(new Set(words)).slice(0, 20);

    /* 采集账号：留空 = 不绑定（走通道默认身份）；
       绑定了就必须存在、启用、且平台一致 —— 用错号采同一平台的另一种内容
       比没采集更糟，它会让「这条线索谁采的」彻底失真。 */
    const accountId = String(s.accountId == null ? '' : s.accountId).trim().slice(0, 40);
    if (accountId && this.opt.accounts) {
      const acc = this.opt.accounts.get(accountId);
      if (!acc) {
        return { ok: false, error: { code: 'ACCOUNT_NOT_FOUND', message: '绑定的采集账号不存在，请重新选择' } };
      }
      if (acc.status !== 'active') {
        return {
          ok: false,
          error: {
            code: 'ACCOUNT_INACTIVE',
            message: '账号「' + acc.nickname + '」当前状态为' + (acc.status === 'expired' ? '已过期' : '已停用') + '，请先恢复或换一个号'
          }
        };
      }
      if (acc.platform !== platform) {
        return {
          ok: false,
          error: {
            code: 'ACCOUNT_PLATFORM_MISMATCH',
            message: '账号「' + acc.nickname + '」属于 ' + acc.platform + '，与目标平台 ' + platform + ' 不一致'
          }
        };
      }
    }

    return {
      ok: true,
      value: {
        target, ref, keyword, platform, limit, region,
        intentWords, accountId,
        /* 战役归属：一场战役拆成多条任务，任务仍可独立暂停/审计 */
        campaignId: String(s.campaignId || '').trim().slice(0, 40),
        /* K1：任务归属租户。由接口层从会话票/请求头取，不由客户端自报 */
        tenant: tenantMod.norm(s.tenant),
        channel: pick.channel, scope: pick.scope,
        cron: spec.cron || '', every: spec.cron ? '' : String(spec.every),
        scheduleText: v.text,
        plan: v.ms || 0,
        enabled: s.enabled !== false,
        tags: Array.isArray(s.tags) ? s.tags.slice(0, 6).map((x) => String(x).slice(0, 16)) : []
      }
    };
  }

  addTask(input) {
    const n = this.normalize(input);
    if (!n.ok) return n;
    const now = Date.now();
    const t = Object.assign({
      id: this.store.nextId('ct'),
      createdAt: new Date(now).toISOString(),
      lastRunAt: 0, nextRunAt: 0,
      runs: 0, got: 0, fresh: 0, total: 0,
      lastStatus: '', lastReason: '',
      seen: []
    }, n.value);
    t.nextRunAt = schedule.nextRun(t, now);
    this.tasks().unshift(t);
    this.store.save(true, 'collect_tasks');
    return { ok: true, task: t };
  }

  updateTask(id, patch) {
    const t = this.task(id);
    if (!t) return null;
    const p = patch || {};
    if (p.target != null && TARGETS.indexOf(String(p.target)) > -1) t.target = String(p.target);
    if (p.ref != null) t.ref = String(p.ref).trim().slice(0, 200);
    if (Array.isArray(p.intentWords)) {
      const words = p.intentWords.map((w) => String(w || '').trim().slice(0, 12)).filter(Boolean);
      t.intentWords = Array.from(new Set(words)).slice(0, 20);
    }
    if (p.keyword != null) t.keyword = String(p.keyword).trim().slice(0, 60) || t.keyword;
    if (p.platform != null && PLATFORMS.indexOf(String(p.platform)) > -1) t.platform = String(p.platform);
    if (p.limit != null) t.limit = clamp(Number(p.limit) || t.limit, 1, 50);
    if (p.region != null) t.region = String(p.region).slice(0, 30);
    /* 绑号 / 解绑（传空串即解绑）。校验与新建同口径，避免 PATCH 绕过校验 */
    if (p.accountId != null) {
      const id = String(p.accountId || '').trim().slice(0, 40);
      if (id && this.opt.accounts) {
        const acc = this.opt.accounts.get(id);
        if (!acc) return { error: { code: 'ACCOUNT_NOT_FOUND', message: '采集账号不存在' } };
        if (acc.status !== 'active') {
          return { error: { code: 'ACCOUNT_INACTIVE', message: '账号「' + acc.nickname + '」不可用，请先恢复或换号' } };
        }
        if (acc.platform !== t.platform) {
          return { error: { code: 'ACCOUNT_PLATFORM_MISMATCH', message: '账号平台与任务平台不一致' } };
        }
      }
      t.accountId = id;
    }
    if (p.channel != null || p.scope != null) {
      const pick = normalizeRoute({
        channel: p.channel != null ? p.channel : t.channel,
        scope: p.scope != null ? p.scope : t.scope
      });
      if (!pick.ok) return { error: pick.error };
      t.channel = pick.channel;
      t.scope = pick.scope;
    }
    if (p.cron != null || p.every != null) {
      const spec = p.cron ? { cron: String(p.cron).trim() } : { every: p.every || '1h' };
      const v = schedule.validateSchedule(spec);
      if (!v.ok) return { error: v };
      t.cron = spec.cron || '';
      t.every = spec.cron ? '' : String(spec.every);
      t.scheduleText = v.text;
      t.plan = v.ms || 0;
    }
    if (p.enabled != null) t.enabled = !!p.enabled;
    Object.keys(p).forEach((k) => { if (k === 'tags' && Array.isArray(p.tags)) t.tags = p.tags.slice(0, 6); });
    /* 启停或改频率后重算下一次执行 */
    if (t.enabled) t.nextRunAt = schedule.nextRun(t, Date.now());
    else t.nextRunAt = 0;
    this.store.save(true, 'collect_tasks');
    return t;
  }

  removeTask(id) {
    const i = this.tasks().findIndex((t) => t.id === id);
    if (i < 0) return false;
    this.tasks().splice(i, 1);
    /* 历史运行记录与线索池保留，便于事后追溯「这条线索是哪次采集来的」 */
    this.store.save(true, 'collect_tasks');
    return true;
  }

  /* ---------- 单次执行 ---------- */
  /**
   * 执行一个任务的一轮采集。
   * @param {object} task
   * @param {{manual?:boolean}} [meta]
   */
  async runOnce(task, meta) {
    const startedAt = Date.now();
    const channel = task.channel || 'auto';
    const scope = task.scope || 'auto';
    /* K1：本轮消耗记在「任务归属租户」名下，而不是进程级 default。
       任务在创建时落 tenant；存量任务由启动迁移补 default，所以这里兜底取 default。 */
    const runTenant = tenantMod.ofTask(task);
    /* 本轮用哪个号跑：任务没绑号就留空（走通道默认身份），
       绑了就记进 run —— 事后追溯「这条线索是哪次、哪个号采的」。 */
    const acc = (task.accountId && this.opt.accounts) ? this.opt.accounts.get(task.accountId) : null;
    if (task.accountId && !acc) {
      /* 账号被删了但任务还指着它：如实失败，别静默换成别的号采 */
      const run0 = {
        id: this.store.nextId('cr'), taskId: task.id, keyword: task.keyword,
        tenant: runTenant,
        platform: task.platform, limit: task.limit, region: task.region || '',
        channel: channel, scope: scope, at: new Date(startedAt).toISOString(),
        manual: !!(meta && meta.manual), status: 'failed', source: '', simulated: false,
        got: 0, fresh: 0, dup: 0, byLevel: { high: 0, mid: 0, low: 0, noise: 0 },
        ms: 0, reason: 'ACCOUNT_MISSING', accountId: task.accountId, accountName: '',
        items: []
      };
      task.lastRunAt = startedAt;
      task.nextRunAt = task.enabled ? schedule.nextRun(task, startedAt) : 0;
      return this._record(task, run0, startedAt, {
        status: 'failed', reason: 'ACCOUNT_MISSING',
        note: '任务绑定的采集账号已不存在，请在左侧重新绑定（不会自动换号）'
      });
    }
    const run = {
      id: this.store.nextId('cr'),
      taskId: task.id,
      tenant: runTenant,
      keyword: task.keyword,
      platform: task.platform,
      limit: task.limit,
      region: task.region || '',
      channel: channel,
      scope: scope,
      accountId: acc ? acc.id : '',
      accountName: acc ? acc.nickname : '',
      at: new Date(startedAt).toISOString(),
      manual: !!(meta && meta.manual),
      status: 'running',
      source: '',
      simulated: false,
      got: 0, fresh: 0, dup: 0,
      byLevel: { high: 0, mid: 0, low: 0, noise: 0 },
      ms: 0, reason: '', items: []
    };

    /* 排期推进放在最前面：即使这一轮失败也不会锁死任务 */
    task.lastRunAt = startedAt;
    task.runs = (task.runs || 0) + 1;
    task.nextRunAt = task.enabled ? schedule.nextRun(task, startedAt) : 0;

    /* 配额闸门：单号每小时最多采 quotaPerHour 条。
       超限就跳过本轮，而不是硬跑 —— 平台的限流是按账号算的，
       同一小时里把号跑废，后面所有任务一起停摆。 */
    if (acc) {
      const used = this.opt.accounts.usedLastHour(acc.id, this.runs());
      if (used >= acc.quotaPerHour) {
        this.opt.accounts.touch(acc.id, run.at);
        return this._record(task, run, startedAt, {
          status: 'skipped', reason: 'ACCOUNT_QUOTA',
          note: '账号「' + acc.nickname + '」近 1 小时已采 ' + used + ' 条，达到上限 ' + acc.quotaPerHour + ' 条，本轮跳过'
        });
      }
      this.opt.accounts.touch(acc.id, run.at);
    }

    try {
      /* 目标类型 → 上游参数：
         keyword 走 keyword；author / video 额外带同名字段（桥侧识别）；
         不识别这两个字段的上游会自动忽略，退化成 keyword 搜索，不会报错。 */
      const payload = {
        platform: task.platform, keyword: task.keyword, limit: task.limit,
        region: task.region, channel: channel, scope: scope,
        campaignId: task.campaignId || '',
        target: task.target || 'keyword'
      };
      if (task.target === 'author' && task.ref) payload.author = task.ref;
      if (task.target === 'video' && task.ref) payload.video = task.ref;
      /* 注释：plugin 通道靠这个把「云端任务」和「本机执行记录」对上 */
      const r = await collector.collect(payload, {}, { taskId: task.id });
      /* 本地兜底由 collector.resolveChannel 内部完成（无真实通道且
         ALLOW_LOCAL_COLLECT=1 时落 local），这里不再手工回落 ——
         否则「任务指定了未接入的真实通道」会被模拟数据掩盖成成功。 */

      if (r.status === 501 && r.body && r.body.code === 'CHANNEL_NOT_CONFIGURED') {
        /* 通道写错属于配置错误，如实失败并给出修复指引 */
        return this._record(task, run, startedAt, {
          status: 'failed', reason: 'CHANNEL_NOT_CONFIGURED',
          note: (r.body.message || '指定的采集通道未接入') + (r.body.fix ? '（' + r.body.fix + '）' : '')
        });
      }
      if (r.status === 501 && r.body && r.body.code === 'CHANNEL_UNKNOWN') {
        return this._record(task, run, startedAt, {
          status: 'failed', reason: 'CHANNEL_UNKNOWN',
          note: r.body.message || '未知采集通道'
        });
      }
      if (r.status === 501) {
        /* 一条真实通道都没接：明确「跳过」，绝不伪造成成功 */
        return this._record(task, run, startedAt, {
          status: 'skipped', reason: 'UPSTREAM_NOT_CONFIGURED',
          note: '未接入任何采集通道，本轮未采集（不生成模拟数据）'
        });
      }
      if (r.status !== 200 || !r.body || !r.body.ok) {
        return this._record(task, run, startedAt, {
          status: 'failed',
          reason: (r.body && r.body.code) || ('HTTP_' + r.status),
          note: (r.body && r.body.message) || '采集失败'
        });
      }

      /* 上游返回 200 但结构漂移 —— http-provider 已判定为 502，
         这里会走到上面的失败分支；此处再兜一层，防止其他适配器漏判：
         采集结果为空 + 归一化诊断显示结构异常 → 判失败，不记 ok。 */
      const nDiag = r.body.normalize;
      if (nDiag && (nDiag.status === 'shape_changed' || nDiag.status === 'invalid_body')) {
        return this._record(task, run, startedAt, {
          status: 'failed',
          reason: 'UPSTREAM_SHAPE_CHANGED',
          note: nDiag.reason || '上游返回结构无法识别'
        });
      }

      const list = (r.body.data && r.body.data.comments) || [];
      const simulated = r.body.source === 'local-simulated';
      run.channel = r.body.channel || channel;
      run.scope = r.body.scope || scope;
      const seen = new Set(task.seen || []);
      const items = [];
      const byLevel = { high: 0, mid: 0, low: 0, noise: 0 };
      let dup = 0;
      for (const c of list) {
        const norm = {
          platform: normPlatform(c.platform || task.platform),
          nickname: c.nickname || '匿名用户',
          comment: c.comment || '',
          video: c.video_title || '',
          likes: Number(c.likes || 0),
          /* 时间缺失时留空，不再伪造当前时间 ——
             伪造时间会让旧线索看起来刚发布，直接误导销售判断新鲜度。
             at 留空时用 'unknown' 占位以保证指纹稳定。 */
          at: c.at || 'unknown',
          /* 来源回链：销售要能一键跳回原视频接着语境私信，
             缺了这三个字段，线索就只是一句没有出处的话。 */
          video_url: c.video_url || '',
          author: c.author || '',
          cid: String(c.cid || c.comment_id || ''),
          region: c.region || task.region || ''
        };
        const fp = fpOf(norm);
        if (seen.has(fp)) { dup++; continue; }
        seen.add(fp);
        /* 打分在这里做一次，流和台账共用同一份结果，避免两处算法漂移 */
        const sc = intent.score(norm.comment, task.intentWords);
        byLevel[sc.level] = (byLevel[sc.level] || 0) + 1;
        items.push(Object.assign({ fp }, norm, {
          score: sc.score, level: sc.level, intent: sc.intent,
          hits: sc.hits, why: sc.reason,
          target: task.target || 'keyword'
        }));
      }
      /* 记忆指纹（保留最近 MAX_SEEN 个） */
      task.seen = Array.from(seen).slice(-MAX_SEEN);

      run.items = items.slice(0, MAX_ITEMS_PER_RUN);
      run.got = list.length;
      run.dup = dup;
      run.fresh = items.length;
      run.byLevel = byLevel;
      run.source = r.body.source || 'upstream';
      run.simulated = simulated;
      /* 作品卡数量单独留痕：卡片区没内容时能立刻判断是「没抓到作品」还是「没采到评论」 */
      if (Array.isArray(r.body.notes)) run.notes = r.body.notes.length;
      if (r.body.device) run.device = r.body.device.name || r.body.device.host || '';
      /* 归一化诊断留存，便于事后判断「空」是真没有还是读失败 */
      if (nDiag) run.normalize = nDiag;

      /* 关键：上游连一条都没返回时，不能记 'ok'。
         销售看到「采集成功」但线索池是空的 —— 这就是砸口碑的故障。
         真没有评论是合法结果，但要如实标成 empty，让前端能提示。 */
      if (!list.length) {
        return this._record(task, run, startedAt, {
          status: 'empty',
          reason: 'NO_ITEMS',
          note: (nDiag && nDiag.reason) || ('上游本轮返回 0 条（' + (nDiag && nDiag.shell ? '壳层 ' + nDiag.shell : '结构可识别') + '）')
        });
      }

      return this._record(task, run, startedAt, {
        status: 'ok',
        note: items.length
          ? ('新增 ' + items.length + ' 条（重复 ' + dup + ' 条已拦截）')
          : ('本轮无新增（共 ' + list.length + ' 条，均为历史重复）')
      });
    } catch (e) {
      this.lastError = String((e && e.message) || e);
      return this._record(task, run, startedAt, {
        status: 'failed', reason: 'EXCEPTION', note: this.lastError.slice(0, 200)
      });
    }
  }

  _record(task, run, startedAt, patch) {
    Object.assign(run, patch, { ms: Date.now() - startedAt });
    /* 明细只保留必要字段，避免 db.json 无限膨胀 */
    if (run.items && run.items.length) {
      this._ingestLeads(run);
    }
    /* K4：运行记录走 NDJSON 追加（上限由 store 的 cap 兜底） */
    this.store.push('collect_runs', run);

    task.lastStatus = run.status;
    task.lastReason = run.reason || '';
    task.got = run.got;
    task.fresh = run.fresh;
    task.total = (task.total || 0) + (run.status === 'ok' ? run.fresh : 0);
    /* empty 是「跑了但没数据」，不是失败；但也不能算成功 —— 要留痕，
       否则用户以为一直在正常采集，实际一条都没进来。 */
    if (run.status !== 'ok') task.lastErrorAt = new Date().toISOString();

    this.totalRuns++;
    if (run.status === 'ok') this.totalLeads += run.fresh;
    this.store.save(true, 'collect_tasks');

    /* ok=info / skipped=warn / empty=warn / failed=err */
    const lv = run.status === 'ok' ? 'info'
      : (run.status === 'skipped' || run.status === 'empty' ? 'warn' : 'err');
    this.log(lv, '采集「' + task.keyword + '」' + run.status + ' · ' + run.note +
      (run.simulated ? '（本地模拟数据，非真实抓取）' : ''));
    return run;
  }

  /** 把新评论写入线索池（按指纹全局去重） */
  /**
   * 全局指纹账本（内存 Set，store 里的 collect_fp 是它的持久化形态）。
   * 为什么不用线索池判重：collect_leads 只有 5000 条容量，旧线索被淘汰时
   * 指纹一起消失，同一条评论会在几天后重新入池。账本只存 fp（60000 条上限），
   * 容量大一个数量级，且不会被业务数据挤出。
   */
  _fpSetRef() {
    if (this._fpSet) return this._fpSet;
    const rows = this.store.data.collect_fp || [];
    const s = new Set();
    for (let i = 0; i < rows.length; i++) if (rows[i] && rows[i].fp) s.add(rows[i].fp);
    this._fpSet = s;
    return s;
  }

  _ingestLeads(run) {
    const known = this._fpSetRef();
    const fresh = [];
    for (const it of run.items) {
      if (known.has(it.fp)) continue;
      known.add(it.fp);
      fresh.push({
        id: this.store.nextId('cl'),
        fp: it.fp,
        /* K1：线索跟着任务的租户走，便于事后对账「这条线索是谁的额度」 */
        tenant: tenantMod.norm(run.tenant),
        platform: it.platform,
        keyword: run.keyword,
        target: it.target || 'keyword',
        taskId: run.taskId,
        campaignId: (this.task(run.taskId) || {}).campaignId || '',
        nickname: it.nickname,
        comment: it.comment,
        video: it.video,
        video_url: it.video_url || '',
        author: it.author || '',
        cid: it.cid || '',
        region: it.region || '',
        likes: it.likes,
        at: it.at,
        /* 意向判定结果随线索一起落库：前端流、台账、导出共用同一份，
           不要在展示层再算一遍，否则两处分数会漂移。 */
        score: it.score || 0,
        level: it.level || 'noise',
        intent: it.intent || '',
        hits: it.hits || [],
        why: it.why || '',
        runId: run.id,
        /* 来源可追溯：这条线索是哪条通道、哪个范围采到的 */
        channel: run.channel || '',
        scope: run.scope || '',
        source: run.source || '',
        simulated: !!run.simulated,
        status: 'new',
        statusAt: new Date().toISOString(),
        created_at: new Date().toISOString()
      });
    }
    /* K4：线索池是高频追加表，逐条 append 而非重写整表 */
    this.store.pushMany('collect_leads', fresh);
    /* 指纹账本同步追加：与线索入池同一次写，避免「线索进了、账本没进」
       导致下一轮重复收录同一条。 */
    if (fresh.length) {
      const at = new Date().toISOString();
      this.store.pushMany('collect_fp', fresh.map((f) => ({ fp: f.fp, at: at })));
    }
    /* 计费：按新增线索条数计（无订阅时只记账不拦截）。
       K1：tenant 取本轮任务的归属，A 客户的采集不会再扣到 default 头上；
       K10：dedupeKey 用 run.id，同一轮被重复结算时只记一次。 */
    try {
      if (this.opt.meter && fresh.length) {
        this.opt.meter('leads', fresh.length, {
          keyword: run.keyword, runId: run.id,
          tenant: tenantMod.norm(run.tenant),
          dedupeKey: 'collect:' + run.id
        });
      }
    } catch (e) {}
    return fresh.length;
  }

  /* ---------- 调度循环 ---------- */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick(); }, this.period);
    if (this.timer.unref) this.timer.unref();
    this.log('info', '采集调度已启动（' + (this.period / 1000) + 's 巡检 · 并发 ' + this.concurrency + '）· 通道 ' + this.stats().mode);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 到点任务批量执行；returns 本轮实际执行的任务数 */
  async tick() {
    this.lastTickAt = Date.now();
    if (this.running) return 0;
    /* 未接通道时不自动跑，避免生成假数据 */
    if (this.stats().mode === 'unconfigured') return 0;
    const now = Date.now();
    const due = this.tasks().filter((t) => t.enabled && t.nextRunAt && t.nextRunAt <= now);
    if (!due.length) return 0;

    this.running = true;
    let done = 0;
    try {
      for (let i = 0; i < due.length; i += this.concurrency) {
        const slice = due.slice(i, i + this.concurrency);
        this.inflight = slice.length;
        await Promise.all(slice.map((t) => this.runOnce(t, { manual: false }).catch(() => null)));
        this.inflight = 0;
        done += slice.length;
      }
    } catch (e) {
      this.lastError = String((e && e.message) || e);
      this.log('warn', '调度执行异常：' + this.lastError);
    } finally {
      this.running = false;
    }
    return done;
  }

  /* ---------- 兼容层：给没打过分的历史线索补分数 ----------
     打分字段是后加的，此前入库的线索（含早期模拟数据）没有 score/level，
     前端会显示成一片 0 分。这里按同一套规则补算，只在内存里补，
     不改写已落库的行 —— 分数是纯函数，每次算结果一致，没必要写盘。 */
  ensureScores() {
    const pool = this.leads();
    let n = 0;
    for (let i = 0; i < pool.length; i++) {
      const l = pool[i];
      if (l && l.score !== undefined && l.level) continue;
      const sc = intent.score(l.comment || '', []);
      l.score = sc.score;
      l.level = sc.level;
      l.intent = sc.intent;
      l.hits = sc.hits;
      l.why = sc.reason;
      n++;
    }
    if (n) this.needScoreFix = true;
    return n;
  }

  /* ---------- 统计 ---------- */
  stats() {
    const mode = collector.mode();
    const tasks = this.tasks();
    const enabled = tasks.filter((t) => t.enabled);
    const nextRunAt = enabled.filter((t) => t.nextRunAt).map((t) => t.nextRunAt).sort()[0] || 0;
    const lastRun = this.runs()[0] || null;
    /* 任务按通道分布：让「官方通道跑几个、爬虫跑几个」一眼可见 */
    const byChannel = {};
    tasks.forEach((t) => {
      const k = t.channel || 'auto';
      byChannel[k] = (byChannel[k] || 0) + 1;
    });
    /* 线索按来源通道分布 */
    const leadsByChannel = {};
    this.leads().forEach((l) => {
      const k = l.channel || (l.simulated ? 'local' : 'unknown');
      leadsByChannel[k] = (leadsByChannel[k] || 0) + 1;
    });
    /* 意向分档与跟进阶段分布：三栏页面的「流」和「台账」顶部都要这个数 */
    const leadsByLevel = { high: 0, mid: 0, low: 0, noise: 0 };
    const leadsByStatus = {};
    this.leads().forEach((l) => {
      const lv = l.level || 'noise';
      leadsByLevel[lv] = (leadsByLevel[lv] || 0) + 1;
      const st = l.status || 'new';
      leadsByStatus[st] = (leadsByStatus[st] || 0) + 1;
    });
    /* 目标按类型分布 */
    const tasksByTarget = {};
    tasks.forEach((t) => {
      const k = t.target || 'keyword';
      tasksByTarget[k] = (tasksByTarget[k] || 0) + 1;
    });
    /* 账号使用情况：几个目标绑了号、哪个号在跑、有没有绑到失效号 */
    const tasksByAccount = {};
    tasks.forEach((t) => {
      const k = t.accountId || 'unbound';
      tasksByAccount[k] = (tasksByAccount[k] || 0) + 1;
    });
    const accounts = this.opt.accounts ? this.opt.accounts.stats(this.runs()) : null;
    const boundTasks = tasks.filter((t) => !!t.accountId).length;
    const brokenBindings = this.opt.accounts
      ? tasks.filter((t) => t.accountId && !this.opt.accounts.get(t.accountId)).length
      : 0;
    return {
      mode,
      upstreamConfigured: collector.configured(),
      localAllowed: process.env.ALLOW_LOCAL_COLLECT === '1',
      /* 多通道概览：已接入哪些、分别缺什么 */
      channels: collector.channels(),
      realChannels: collector.channels().filter((c) => c.configured && c.id !== 'local').map((c) => c.id),
      tasksByChannel: byChannel,
      tasksByTarget: tasksByTarget,
      tasksByAccount: tasksByAccount,
      accounts: accounts,
      boundTasks: boundTasks,
      brokenBindings: brokenBindings,
      leadsByChannel,
      leadsByLevel,
      leadsByStatus,
      defaultScope: 'auto',
      tasks: tasks.length,
      enabled: enabled.length,
      concurrency: this.concurrency,
      tickMs: this.period,
      running: this.running,
      inflight: this.inflight,
      lastTickAt: this.lastTickAt,
      nextRunAt,
      runs: this.runs().length,
      leads: this.leads().length,
      newLeads: this.leads().filter((l) => l.status === 'new').length,
      lastRun: lastRun ? {
        id: lastRun.id, keyword: lastRun.keyword, at: lastRun.at, status: lastRun.status,
        source: lastRun.source, channel: lastRun.channel || '', scope: lastRun.scope || '',
        fresh: lastRun.fresh, ms: lastRun.ms, reason: lastRun.reason || ''
      } : null,
      lastError: this.lastError ? this.lastError.slice(0, 160) : '',
      supportedEvery: schedule.EVERY_KEYS,
      cronSupported: true
    };
  }

  log(lv, m) { if (this.opt.onLog) this.opt.onLog(lv, m); }
}

/* ---------------- 种子任务 ---------------- */
/* 与前端采集器里那几个关键词保持一致，保证页面开箱有可调度对象 */

const SEED = [
  { keyword: '抖音代运营 报价', platform: 'douyin', every: '1h', limit: 20 },
  { keyword: '千川投流 服务商', platform: 'douyin', every: '1h', limit: 20 },
  { keyword: '本地生活 团购 代运营', platform: 'xhs', every: '6h', limit: 15 },
  { keyword: '短视频 拍摄 外包', platform: 'kuaishou', every: '6h', limit: 15 },
  { keyword: '精准客源 CPL 线索', platform: 'douyin', cron: '0 9,15,21 * * *', limit: 20, enabled: false },
  /* 自有内容评论区：scope=own 会优先走 official 通道（平台官方开放能力）。
     默认暂停，等配置好 COLLECT_OFFICIAL_URL 与 COLLECT_OFFICIAL_OWNER 再启用。 */
  { keyword: '自有作品评论区巡检', platform: 'douyin', every: '24h', limit: 30,
    channel: 'auto', scope: 'own', enabled: false,
    tags: ['自有内容', '官方通道'] }
];

/** 仅在库为空时写入；COLLECT_NO_SEED=1 可关闭（测试用） */
function seedTasks(sched, seeds) {
  if (sched.tasks().length) return 0;
  const list = (Array.isArray(seeds) && seeds.length) ? seeds : SEED;
  list.forEach((s) => {
    const r = sched.addTask(s);
    if (r.ok) r.task.tags = ['种子任务'];
  });
  sched.store.save(true, 'collect_tasks');
  return sched.tasks().length;
}

module.exports = {
  CollectScheduler, seedTasks, SEED, fpOf, normalizeRoute,
  PLATFORMS, TARGETS, MAX_RUNS, MAX_LEADS,
  CHANNEL_IDS: registry.CHANNEL_IDS, SCOPE_IDS: registry.SCOPE_IDS
};
