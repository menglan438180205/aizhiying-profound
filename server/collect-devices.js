'use strict';

/* 平台别名归一：服务端 ID 是 douyin/xhs/kuaishou/sph（collect-sched.PLATFORMS），
   但插件/桥可能上报站点名（xiaohongshu/channels/weixin）。匹配设备与
   入库前必须先归一，否则小红书任务永远匹配不到采集器（xhs ≠ xiaohongshu）。 */
const PLATFORM_ALIAS = {
  douyin: 'douyin', xhs: 'xhs', xiaohongshu: 'xhs', red: 'xhs',
  kuaishou: 'kuaishou', ks: 'kuaishou',
  sph: 'sph', channels: 'sph', weixin: 'sph', wechat: 'sph'
};
function normPlatform(p) {
  const k = String(p || '').toLowerCase().trim();
  return PLATFORM_ALIAS[k] || k;
}

/* =========================================================
   collect-devices.js — 浏览器采集器（本地采集端）中枢
   ---------------------------------------------------------
   为什么需要这一层：
     平台的登录态、住宅 IP、真人浏览器指纹，全都在「使用者这台
     电脑」上；服务器直连平台必被封。所以抓取永远发生在采集端，
     云端只负责三件事：发任务、收结果、判定入库。

   拓扑（采集端主动外连，云端不需要能访问它）：

     BFF(云端)                      本机桥(8801)              Chrome 扩展
     ─────────                      ─────────────              ──────────
     配对码 ──(页面 POST 127.0.0.1)──▶ claim ──┐
     任务队列 ◀──── GET /v1/device/jobs ───────┤
     结果入库 ◀──── POST .../result ───────────┘
                                            └─▶ /v1/plugin/poll ─▶ 抓页面
                                                /v1/plugin/result ◀── 回数据

   安全边界：
     · 配对码 6 位数字、10 分钟有效、一次性，只能由已登录的页面拿到
       （POST /v1/device/pair 走会话票鉴权）；拿到码还不能用 —— 必须
       在「本机浏览器」里把它交给 127.0.0.1 的桥，等于同时证明了
       「我登录了」和「我在那台机器上」。
     · 设备令牌只在采集端本地保存（bridge-config.json），云端只存哈希？——
       这里存明文是为了能按令牌查设备；它是随机 32 字节，
       泄露面只在 .data 目录，与 API_TOKEN 同级管控。
     · 任务只带关键词/数量这类参数，不带任何账号凭证。
   ========================================================= */

const crypto = require('crypto');

const ONLINE_MS = 25000;       /* 心跳窗口：超过即视为离线（桥 10s 一次心跳） */
const JOB_TTL_MS = 10 * 60e3;  /* 待领任务过期时间 */
const KEEP_MS = 2 * 3600e3;    /* 任务记录保留时长 */

function nowIso() { return new Date().toISOString(); }

class DeviceHub {
  constructor(store, opt) {
    this.store = store;
    this.opt = opt || {};
    this.pairs = new Map();     /* code -> {at, by} */
    this.waiters = new Map();   /* jobId -> [resolve] */
    this.pausedKinds = new Set();
    this.timer = setInterval(() => this.sweep(), 30000);
    if (this.timer.unref) this.timer.unref();
  }

  devices() { return this.store.data.collect_devices || (this.store.data.collect_devices = []); }
  jobs() { return this.store.data.collect_jobs || (this.store.data.collect_jobs = []); }
  job(id) { return this.jobs().filter((j) => j.id === id)[0] || null; }

  /* ---------- 配对 ---------- */
  newPair(by) {
    /* 6 位数字，避开 0 开头太难的读法 */
    const code = String(crypto.randomInt(100000, 1000000));
    this.pairs.set(code, { at: Date.now(), by: String(by || '') });
    /* 只保留最近 20 个未用码，避免内存堆积 */
    if (this.pairs.size > 20) {
      const oldest = Array.from(this.pairs.entries()).sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.pairs.delete(oldest[0]);
    }
    return { code, expiresIn: 600, at: nowIso() };
  }

  claim(code, info, ip) {
    const c = String(code || '').replace(/\D/g, '');
    const rec = this.pairs.get(c);
    if (!rec) return { error: 'PAIR_CODE_INVALID', message: '配对码不存在或已被使用' };
    if (Date.now() - rec.at > 10 * 60e3) {
      this.pairs.delete(c);
      return { error: 'PAIR_CODE_EXPIRED', message: '配对码已过期（10 分钟），请在页面上重新生成' };
    }
    this.pairs.delete(c);
    const i = info || {};
    const token = 'dv_' + crypto.randomBytes(24).toString('hex');
    const dev = {
      id: this.store.nextId('dv'),
      name: String(i.name || i.host || '本机采集器').slice(0, 60),
      host: String(i.host || '').slice(0, 60),
      version: String(i.version || '').slice(0, 20),
      platforms: Array.isArray(i.platforms) ? i.platforms.slice(0, 8).map((x) => String(x).slice(0, 16)) : [],
      token,
      ip: String(ip || '').slice(0, 60),
      pairedBy: rec.by,
      createdAt: nowIso(),
      lastSeenAt: 0,
      jobs: 0,
      comments: 0,
      notes: 0
    };
    this.devices().unshift(dev);
    this.store.save(true, 'collect_devices');
    return { device: this.pub(dev), token };
  }

  pub(d) {
    if (!d) return null;
    return {
      id: d.id, name: d.name, host: d.host, version: d.version,
      platforms: d.platforms || [], online: this.isOnline(d),
      lastSeenAt: d.lastSeenAt || 0, createdAt: d.createdAt,
      jobs: d.jobs || 0, comments: d.comments || 0, notes: d.notes || 0
    };
  }

  auth(token) {
    const t = String(token || '').trim();
    if (!t) return null;
    return this.devices().filter((d) => d.token === t)[0] || null;
  }

  isOnline(d) {
    return !!(d && d.lastSeenAt && Date.now() - d.lastSeenAt < ONLINE_MS);
  }

  hello(dev, info) {
    const i = info || {};
    dev.lastSeenAt = Date.now();
    if (i.version) dev.version = String(i.version).slice(0, 20);
    if (i.host) dev.host = String(i.host).slice(0, 60);
    if (Array.isArray(i.platforms) && i.platforms.length) {
      dev.platforms = i.platforms.slice(0, 8).map((x) => normPlatform(x).slice(0, 16));
    }
    if (i.plugin === false) dev.pluginAt = 0;
    if (i.plugin === true) dev.pluginAt = Date.now();
    this.store.save(false, 'collect_devices');
    return this.pub(dev);
  }

  /** 扩展是否连着（决定「能不能发任务」，与设备心跳分开：桥在跑但扩展没装也是白搭） */
  pluginAlive(dev) {
    if (dev && dev.pluginAt) return Date.now() - dev.pluginAt < ONLINE_MS;
    return this.devices().some((d) => this.isOnline(d) && d.pluginAt && Date.now() - d.pluginAt < ONLINE_MS);
  }

  /** 选一台能干活、且支持该平台的采集器 */
  pick(platform) {
    const want = normPlatform(platform);
    const online = this.devices().filter((d) => this.isOnline(d));
    /* 平台为空 = 「任意一台在线的就行」（探针走这条）；
       设备上报的平台也要归一再比（老设备可能还存着 xiaohongshu） */
    const fit = online.filter((d) =>
      !want || !d.platforms || !d.platforms.length ||
      d.platforms.some((x) => normPlatform(x) === want));
    return fit[0] || null;
  }

  online() { return this.devices().some((d) => this.isOnline(d)); }
  ready(platform) { const d = this.pick(platform); return !!(d && this.pluginAlive(d)); }

  /* ---------- 任务 ---------- */
  enqueue(payload, meta) {
    const p = payload || {};
    const m = meta || {};
    const rawKind = String(p.kind || 'collect');
    const kind = rawKind === 'comment' ? 'comment' : (rawKind === 'like' ? 'like' : 'collect');
    const job = {
      id: this.store.nextId('dj'),
      kind,
      taskId: String(m.taskId || ''),
      campaignId: String(p.campaignId || ''),
      deviceId: m.deviceId || '',
      platform: String(p.platform || 'douyin'),
      keyword: String(p.keyword || '').slice(0, 60),
      limit: Math.max(1, Math.min(50, Number(p.limit) || 20)),
      region: String(p.region || '').slice(0, 30),
      target: String(p.target || 'keyword').slice(0, 16),
      author: String(p.author || '').slice(0, 120),
      video: String(p.video || '').slice(0, 200),
      /* 评论任务：直接给作品链接 + 正文，不再走关键词搜索 */
      url: String(p.url || '').slice(0, 400),
      text: String(p.text || '').slice(0, 200),
      title: String(p.title || '').slice(0, 120),
      commentId: String(m.commentId || ''),
      likeId: String(m.likeId || ''),
      /* 评论任务可顺带点赞：一次打开页面把两件事做完，少一次页面加载 */
      withLike: !!p.withLike,
      /* 试运行：真打开页面、真定位输入框，但不写入不发送（链路体检用） */
      dryRun: !!p.dryRun,
      /* 节奏控制：批量评论按 40~90 秒铺开，别像脚本一样连发 */
      notBefore: Number(p.notBefore || 0),
      maxVideos: Math.max(0, Math.min(8, Number(p.maxVideos != null ? p.maxVideos : (process.env.PLUGIN_MAX_VIDEOS || 3)))),
      status: 'pending',
      createdAt: nowIso(),
      claimedAt: 0,
      finishedAt: 0,
      /* 执行过程：采集端每做一步就追加一条，前端在中栏卡片里实时展示。
         step: open(打开页面) locate(定位输入框) type(写入) submit(发送)
               like(点赞) done/fail；msg 是给人看的一句话。 */
      steps: [],
      result: null,
      error: ''
    };
    this.store.push('collect_jobs', job);
    return job;
  }

  /** 采集端上报一步执行过程（幂等：同一步同状态重复上报只更新时间） */
  progress(jobId, step) {
    const j = this.job(String(jobId || ''));
    if (!j) return { error: 'JOB_NOT_FOUND' };
    const s = step || {};
    const name = String(s.step || '').slice(0, 20);
    if (!name) return { error: 'STEP_REQUIRED' };
    const status = ['run', 'ok', 'fail'].indexOf(String(s.status || '')) >= 0 ? String(s.status) : 'ok';
    const rec = {
      step: name,
      status: status,
      msg: String(s.msg || '').slice(0, 120),
      at: nowIso()
    };
    if (!Array.isArray(j.steps)) j.steps = [];
    const last = j.steps[j.steps.length - 1];
    if (last && last.step === name && last.status === status) {
      last.msg = rec.msg || last.msg;
      last.at = rec.at;
    } else {
      j.steps.push(rec);
      if (j.steps.length > 40) j.steps.splice(0, j.steps.length - 40);
    }
    if (status === 'run' && j.status === 'pending') { j.status = 'claimed'; j.claimedAt = Date.now(); }
    this.store.upsert('collect_jobs', j);
    return { job: { id: j.id, status: j.status }, steps: j.steps.length };
  }

  /** 采集端来领活：只领自己平台匹配、且没被别人抢走的 pending */
  claimNext(dev) {
    const list = this.jobs();
    for (let i = list.length - 1; i >= 0; i--) {
      const j = list[i];
      if (!j || j.status !== 'pending') continue;
      /* 全局暂停某类队列（例如自动评论）：已入队的任务保留，恢复后继续领 */
      if (this.pausedKinds.has(j.kind)) continue;
      if (j.deviceId && j.deviceId !== dev.id) continue;
      if (Date.now() - Date.parse(j.createdAt || 0) > JOB_TTL_MS) {
        j.status = 'expired'; j.finishedAt = Date.now();
        this.store.upsert('collect_jobs', j);
        continue;
      }
      /* 节奏闸门：批量评论按时间铺开，没到点的不发（否则一轮连发几条即被判机器） */
      if (j.notBefore && Date.now() < Number(j.notBefore)) continue;
      const p = normPlatform(j.platform);
      if (dev.platforms && dev.platforms.length &&
          !dev.platforms.some((x) => normPlatform(x) === p)) continue;
      j.status = 'claimed';
      j.deviceId = dev.id;
      j.claimedAt = Date.now();
      this.store.upsert('collect_jobs', j);
      return j;
    }
    return null;
  }

  finish(jobId, result) {
    const j = this.job(String(jobId || ''));
    if (!j) return { error: 'JOB_NOT_FOUND' };
    const r = result || {};
    const ok = r.ok !== false;
    j.status = ok ? 'done' : 'failed';
    j.finishedAt = Date.now();
    j.ms = j.claimedAt ? (j.finishedAt - j.claimedAt) : 0;
    j.error = ok ? '' : String(r.code || r.error || '采集失败').slice(0, 120);
    j.result = {
      comments: Array.isArray(r.comments) ? r.comments.slice(0, 500) : [],
      notes: Array.isArray(r.notes) ? r.notes.slice(0, 100) : [],
      stats: r.stats && typeof r.stats === 'object' ? r.stats : {},
      /* 评论任务的回执：posted=是否确认发出去了，reason=失败的具体原因 */
      comment: r.comment && typeof r.comment === 'object' ? {
        posted: !!r.comment.posted,
        text: String(r.comment.text || '').slice(0, 200),
        reason: String(r.comment.reason || '').slice(0, 200),
        debug: String(r.comment.debug || '').slice(0, 200)
      } : null,
      /* 点赞回执：liked=本次点成功，already=本来就已赞（也算完成） */
      like: r.like && typeof r.like === 'object' ? {
        liked: !!r.like.liked,
        already: !!r.like.already,
        reason: String(r.like.reason || '').slice(0, 200),
        debug: String(r.like.debug || '').slice(0, 200)
      } : null,
      /* 采集端若没逐步上报，至少把它最终带回来的步骤补上 */
      steps: Array.isArray(r.steps) ? r.steps.slice(0, 40).map(function (s) {
        return { step: String(s.step || '').slice(0, 20), status: String(s.status || 'ok').slice(0, 6), msg: String(s.msg || '').slice(0, 120), at: String(s.at || nowIso()).slice(0, 30) };
      }) : [],
      message: String(r.message || '').slice(0, 200)
    };
    if (j.result.steps.length) j.steps = j.result.steps;
    if (!ok && j.result.steps.length && j.result.steps[j.result.steps.length - 1].status !== 'fail') {
      j.steps.push({ step: 'fail', status: 'fail', msg: j.error || '任务失败', at: nowIso() });
    }
    this.store.upsert('collect_jobs', j);

    const dev = this.devices().filter((d) => d.id === j.deviceId)[0];
    if (dev) {
      dev.jobs = (dev.jobs || 0) + 1;
      dev.comments = (dev.comments || 0) + j.result.comments.length;
      dev.notes = (dev.notes || 0) + j.result.notes.length;
      dev.lastSeenAt = Date.now();
      this.store.save(false, 'collect_devices');
    }

    /* 通知等待方（runOnce 正阻塞在这个 job 上） */
    const ws = this.waiters.get(j.id);
    if (ws) { this.waiters.delete(j.id); ws.forEach((fn) => { try { fn(j); } catch (e) {} }); }

    /* 结果落库：作品索引写进 collect_notes（作品卡片的数据源），
       评论由调用方（调度器）入池 —— 这里不重复处理，避免两套去重。 */
    try { if (this.opt.onResult) this.opt.onResult(j); } catch (e) {}
    return { job: j };
  }

  waitJob(jobId, ms) {
    const j = this.job(jobId);
    if (!j) return Promise.resolve(null);
    if (j.status === 'done' || j.status === 'failed' || j.status === 'expired') return Promise.resolve(j);
    return new Promise((resolve) => {
      const arr = this.waiters.get(jobId) || [];
      arr.push(resolve);
      this.waiters.set(jobId, arr);
      const t = setTimeout(() => {
        const list = this.waiters.get(jobId) || [];
        const i = list.indexOf(resolve);
        if (i >= 0) list.splice(i, 1);
        resolve(this.job(jobId));
      }, Math.max(1000, ms));
      if (t.unref) t.unref();
    });
  }

  /** 待办/在办数量：前端状态卡用 */
  pauseKind(kind, paused) {
    const k = String(kind || 'comment');
    if (paused) this.pausedKinds.add(k); else this.pausedKinds.delete(k);
    return this.pausedKinds.has(k);
  }

  isPaused(kind) { return this.pausedKinds.has(String(kind || 'comment')); }

  pendingKind(kind) {
    const k = String(kind || '');
    /* pending 之外把 claimed 也算上：正在执行的那一条也要占住队列，
       否则页面会以为空了，又排一条，变成一次多条。 */
    return this.jobs().filter((j) => (j.status === 'pending' || j.status === 'claimed') && (!k || j.kind === k)).length;
  }

  /** 取消某类还没被领取的任务（用于清空积压的旧评论队列） */
  cancelPending(kind, campaignId) {
    const k = String(kind || '');
    const cid = String(campaignId || '');
    let n = 0;
    for (const j of this.jobs()) {
      if (j.status !== 'pending' || (k && j.kind !== k)) continue;
      if (cid && String(j.campaignId || '') !== cid) continue;
      j.status = 'canceled';
      j.finishedAt = Date.now();
      j.error = 'CANCELED_BY_USER';
      this.store.upsert('collect_jobs', j);
      n++;
    }
    return n;
  }

  pending() { return this.jobs().filter((j) => j.status === 'pending' || j.status === 'claimed').length; }

  today() {
    const t0 = Date.now() - 24 * 3600e3;
    let jobs = 0; let comments = 0; let notes = 0;
    for (const j of this.jobs()) {
      if (!j.finishedAt || j.finishedAt < t0) continue;
      jobs++;
      if (j.result) { comments += (j.result.comments || []).length; notes += (j.result.notes || []).length; }
    }
    return { jobs, comments, notes };
  }

  status() {
    const devs = this.devices().map((d) => this.pub(d));
    const online = devs.filter((d) => d.online);
    return {
      paired: devs.length,
      online: online.length,
      devices: devs,
      plugin: this.devices().some((d) => this.pluginAlive(d)),
      pending: this.pending(),
      commentsPending: this.pendingKind('comment'),
      commentsPaused: this.isPaused('comment'),
      today: this.today(),
      onlineWindow: ONLINE_MS / 1000
    };
  }

  sweep() {
    const now = Date.now();
    for (const j of this.jobs()) {
      if (j.status === 'pending' && now - Date.parse(j.createdAt || 0) > JOB_TTL_MS) {
        j.status = 'expired'; j.finishedAt = now;
        this.store.upsert('collect_jobs', j);
      }
    }
    /* 只回收内存里的旧记录，磁盘由 ndjson cap 兜底 */
    const arr = this.jobs();
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].finishedAt && now - arr[i].finishedAt > KEEP_MS) arr.splice(i, 1);
    }
    for (const [code, v] of this.pairs) {
      if (now - v.at > 10 * 60e3) this.pairs.delete(code);
    }
  }
}

module.exports = { DeviceHub, ONLINE_MS, normPlatform };
