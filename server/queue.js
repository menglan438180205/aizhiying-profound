'use strict';
/* =========================================================
   queue.js — 渲染任务队列
   - 并发上限（CPU 密集，默认 1~2）
   - 指纹幂等：相同素材 + 相同配置复用同一任务，不重复渲染
   - 失败自动重试（指数退避），耗尽后进死信
   - 支持取消（渲染中检查中断信号）与删除
   ========================================================= */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const { renderJob } = require('./renderer');
const { ensureDir } = require('./store');

class RenderQueue {
  constructor(store, opts) {
    opts = opts || {};
    this.store = store;
    this.concurrency = Math.max(1, Number(opts.concurrency || process.env.RENDER_CONCURRENCY || 1));
    this.maxAttempts = Math.max(1, Number(process.env.RENDER_MAX_ATTEMPTS || 3));
    this.tmpRoot = opts.tmpRoot;
    this.outDir = opts.outDir;
    this.bgmDir = opts.bgmDir;
    this.running = new Map();   // jobId -> { abort }
    this.timers = new Map();
    this.deadLetter = [];
    this.onLog = opts.onLog || function () {};
    this.closed = false;
    /* K3：渲染默认放到子进程执行，主进程只做 API 与调度。
       RENDER_INLINE=1 时退回进程内（排障/单文件部署用）。 */
    this.useWorker = String(process.env.RENDER_INLINE || '0') !== '1';
    this.workers = [];          /* [{ child, busy }] */
    this.pending = new Map();   /* jobId -> { resolve, reject, hooks, slot, signal } */
  }

  /* ---------------- K3 · 渲染子进程池 ---------------- */
  _spawnWorkers() {
    if (!this.useWorker) return;
    while (this.workers.length < this.concurrency) {
      const child = fork(path.join(__dirname, 'render-worker.js'), [], {
        env: process.env,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
      });
      const slot = { child: child, busy: null };
      child.on('message', (m) => this._onWorkerMessage(slot, m));
      child.on('exit', (code) => this._onWorkerExit(slot, code));
      child.on('error', (e) => this.log('渲染子进程错误：' + ((e && e.message) || e), 'err'));
      this.workers.push(slot);
    }
  }

  _onWorkerMessage(slot, m) {
    if (!m || !m.id) return;
    const rec = this.pending.get(m.id);
    if (!rec) return;
    const h = rec.hooks || {};
    switch (m.type) {
      case 'log': if (h.log) h.log(m.level, m.msg); break;
      case 'output': if (h.onOutput) h.onOutput(m.output); break;
      case 'progress': if (h.onProgress) h.onProgress(m.done, m.total, m.stage); break;
      case 'stage': if (h.onStage) h.onStage(m.stage); break;
      case 'media': if (h.onMedia) h.onMedia(m.media); break;
      case 'done': this._settle(m.id, null, m.outputs || []); break;
      case 'error': {
        const err = new Error(m.message || '渲染失败');
        if (m.code) err.code = m.code;
        this._settle(m.id, err);
        break;
      }
      default: break;
    }
  }

  _onWorkerExit(slot, code) {
    const i = this.workers.indexOf(slot);
    if (i > -1) this.workers.splice(i, 1);
    if (slot.busy) {
      const err = new Error('渲染子进程异常退出（code=' + code + '）');
      err.code = 'WORKER_EXIT';
      this._settle(slot.busy, err);
    }
    if (this.closed) return;
    /* 子进程崩溃后自动补位，避免队列永久卡死 */
    const t = setTimeout(() => { try { this._spawnWorkers(); this.pump(); } catch (e) {} }, 500);
    if (t.unref) t.unref();
  }

  _settle(id, err, outputs) {
    const rec = this.pending.get(id);
    if (!rec) return;
    this.pending.delete(id);
    if (rec.signal && rec.onAbort) {
      try { rec.signal.removeEventListener('abort', rec.onAbort); } catch (e) {}
    }
    if (rec.slot) rec.slot.busy = null;
    if (err) rec.reject(err);
    else rec.resolve(outputs == null ? [] : outputs);
  }

  _renderInWorker(job, dir, hooks, signal) {
    this._spawnWorkers();
    const slot = this.workers.filter((w) => !w.busy)[0];
    if (!slot) {
      /* 池子还没就绪（极少见）：退回进程内，保证任务不丢 */
      return renderJob(job, Object.assign({ signal: signal }, hooks));
    }
    slot.busy = job.id;
    return new Promise((resolve, reject) => {
      const rec = { resolve: resolve, reject: reject, hooks: hooks, slot: slot, signal: signal };
      this.pending.set(job.id, rec);
      const onAbort = () => {
        try { slot.child.send({ type: 'cancel', id: job.id }); } catch (e) {}
      };
      if (signal) {
        rec.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        slot.child.send({
          type: 'render', id: job.id,
          payload: { job: job, dir: dir, outDir: this.outDir, bgmDir: this.bgmDir }
        });
      } catch (e) {
        this._settle(job.id, e);
      }
    });
  }

  /** 计算幂等指纹：素材指纹集合 + 归一化配置
   *  注意：任何影响画面 / 音轨 / 时长的新参数都必须加进 norm，
   *  否则「改了配音配置」会被错误判定为同一任务而复用旧成片。 */
  static fingerprint(assetFps, cfg) {
    const norm = {
      ratio: cfg.ratio || '9:16',
      count: Number(cfg.count) || 0,
      shotSeconds: Number(cfg.shotSeconds) || 2.5,
      motion: cfg.motion || 'kenburns',
      transition: cfg.transition || 'cut',
      dedupe: cfg.dedupe !== false,
      coverTitle: cfg.coverTitle !== false,
      cta: cfg.cta !== false,
      title: String(cfg.title || ''),
      voice: cfg.voice === true || cfg.voice === 'true',
      subtitle: cfg.subtitle !== false && cfg.subtitle !== 'false',
      voiceRate: Number(cfg.voiceRate) || 0,
      voiceText: String(cfg.voiceText || '')
    };
    const h = crypto.createHash('sha1');
    h.update(assetFps.slice().sort().join('|'));
    h.update('#' + JSON.stringify(norm));
    return h.digest('hex').slice(0, 20);
  }

  /** 提交任务；若命中同指纹的有效任务则直接复用 */
  submit(job, forceNew) {
    if (!forceNew) {
      const hit = this.store.findJobByKey(job.key);
      if (hit) {
        hit.deduped = (hit.deduped || 0) + 1;
        this.store.save(false, 'jobs');
        return { job: hit, reused: true };
      }
    }
    this.store.addJob(job);
    this.pump();
    return { job, reused: false };
  }

  size() {
    return this.store.jobs().filter((j) => ['queued', 'running'].indexOf(j.status) > -1).length;
  }

  stats() {
    const js = this.store.jobs();
    const by = (s) => js.filter((j) => j.status === s).length;
    return {
      total: js.length,
      queued: by('queued'), running: by('running'), done: by('done'),
      failed: by('failed'), canceled: by('canceled'),
      concurrency: this.concurrency,
      deadLetter: this.deadLetter.length,
      /* K3：隔离模式与子进程存活数，便于运维一眼看出渲染是进程内还是子进程 */
      mode: this.useWorker ? 'worker' : 'inline',
      workers: this.workers.length,
      workersBusy: this.workers.filter((w) => w.busy).length
    };
  }

  log(msg, level) {
    this.onLog(level || 'info', msg);
  }

  /** 调度：把排队任务投入执行，直到达到并发上限 */
  pump() {
    if (this.closed) return;
    const busy = this.running.size;
    const slots = this.concurrency - busy;
    if (slots <= 0) return;
    const queued = this.store.jobs()
      .filter((j) => j.status === 'queued')
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .slice(0, slots);
    queued.forEach((j) => this._run(j));
  }

  _setStage(job, stage, progress) {
    job.stage = stage;
    if (typeof progress === 'number') job.progress = Math.max(job.progress || 0, Math.round(progress));
    this.store.save(false, 'jobs');
  }

  _pushLog(job, level, msg) {
    job.logs = job.logs || [];
    job.logs.push({ ts: new Date().toISOString(), level: level, msg: String(msg).slice(0, 300) });
    if (job.logs.length > 200) job.logs.shift();
    this.log(`[${job.id}] ${msg}`, level);
    this.store.save(false, 'jobs');
  }

  async _run(job) {
    const ac = new AbortController();
    this.running.set(job.id, { abort: () => ac.abort() });
    job.status = 'running';
    job.startedAt = Date.now();
    job.attempt = (job.attempt || 0) + 1;
    this.store.save(true, 'jobs');
    this._pushLog(job, 'info', `开始渲染（第 ${job.attempt}/${this.maxAttempts} 次尝试）· 并发 ${this.concurrency}`);

    const dir = path.join(this.tmpRoot, job.id);
    ensureDir(dir);
    ensureDir(this.outDir);
    // 素材复制/硬链接到任务目录，渲染以相对路径调用 ffmpeg
    const assets = [];
    try {
      const missing = [];
      for (const id of (job.request.assets || [])) {
        const a = this.store.asset(id);
        if (!a) continue;
        const src = this._resolveAssetFile(a);
        if (!src) { missing.push(a.name || a.file || id); continue; }
        const rel = 'a_' + assets.length + (path.extname(a.file || '') || '');
        const target = path.join(dir, rel);
        if (!fs.existsSync(target)) {
          try { fs.linkSync(src, target); } catch (e) { fs.copyFileSync(src, target); }
        }
        assets.push(Object.assign({}, a, { rel }));
      }
      /* 素材文件缺失不是网络抖动 —— 重试多少次都是同一个结果。
         直接判为不可重试，避免它反复占用并发槽。 */
      if (!assets.length) {
        const err = new Error('素材文件缺失，无法开始渲染：' + (missing.join('、') || '未指定素材'));
        err.fatal = true;
        throw err;
      }
      if (missing.length) this._pushLog(job, 'warn', '以下素材文件缺失，已跳过：' + missing.join('、'));
    } catch (e) {
      this._fail(job, '素材准备失败：' + ((e && e.message) || e), dir, { noRetry: !!(e && e.fatal) });
      /* 关键修复：这条路径必须自己收尾。
         原先这里直接 return，绕过了下方第二个 try 的 finally，
         running 槽位永不释放 —— 泄漏满 concurrency 后队列永久停摆，
         表现为「任务一直排队中、worker 却全空闲」。 */
      this.running.delete(job.id);
      if (process.env.RENDER_KEEP_TMP !== '1') {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) {}
      }
      this.store.save(true, 'jobs');
      this.pump();
      return;
    }
    job.assetCount = assets.length;

    const t0 = Date.now();
    try {
      const hooks = {
        log: (lv, m) => this._pushLog(job, lv, m),
        onOutput: (o) => {
          job.outputs = (job.outputs || []).concat([o]);
          this._pushLog(job, 'plain', `成片 ${job.outputs.length}/${job.request.count || '?'} 已进入成片库`);
          this.store.save(false, 'jobs');
        },
        onProgress: (done, total, stage) => {
          job.progress = Math.min(96, Math.round((done / total) * 92) + 4);
          job.stage = stage || '渲染中';
          this.store.save(false, 'jobs');
        },
        onStage: (st) => { job.stage = st; this.store.save(false, 'jobs'); },
        onMedia: (m) => { job.media = m; this.store.save(false, 'jobs'); }
      };
      const payload = Object.assign({}, job, { assets: assets });
      const outputs = this.useWorker
        ? await this._renderInWorker(payload, dir, hooks, ac.signal)
        : await renderJob(payload, Object.assign({ dir: dir, outDir: this.outDir, bgmDir: this.bgmDir, signal: ac.signal }, hooks));
      job.outputs = outputs;
      /* 产出条数校验：请求要 N 条却只产出 0 条，不能记成功。
         旧实现无条件 status='done'，一条都没产出也算「渲染完成」——
         用户在成片列表里看到空列表，只有在点开时才发。
         条数以 job.request.count 为准（任务对象本身没有顶层 count，
         取 job.count 会永远是 0，让这段校验形同虚设）。 */
      const wantCount = Number((job.request && job.request.count) || job.outputsCount || 0);
      if (!outputs || !outputs.length) {
        throw new Error('渲染未产出任何成片（期望 ' + (wantCount || '若干') + ' 条，实际 0 条）');
      }
      if (wantCount > 0 && outputs.length < wantCount) {
        throw new Error('渲染产出不足：期望 ' + wantCount + ' 条，实际 ' + outputs.length + ' 条');
      }
      job.status = 'done';
      job.progress = 100;
      job.stage = '已完成';
      job.finishedAt = Date.now();
      job.elapsedMs = job.finishedAt - t0;
      job.error = null;
      this._pushLog(job, 'ok', `渲染完成：产出 ${outputs.length} 条成片，用时 ${(job.elapsedMs / 1000).toFixed(1)}s`);
      this.store.event('info', 'render', `任务 ${job.id} 完成，产出 ${outputs.length} 条`, { outputs: outputs.length, ms: job.elapsedMs });
    } catch (e) {
      const code = e && e.code;
      if (code === 'CANCELED' || ac.signal.aborted) {
        job.status = 'canceled';
        job.stage = '已取消';
        this._pushLog(job, 'warn', '任务已取消');
      } else {
        this._fail(job, (e && e.message) || String(e), dir);
      }
    } finally {
      this.running.delete(job.id);
      // 清理任务临时目录（成片已落在 outDir）
      if (process.env.RENDER_KEEP_TMP !== '1') {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
      }
      this.store.save(true, 'jobs');
      this.pump();
    }
  }

/* ---------------- 素材路径自愈 ----------------
  * 历史数据里的 a.path 是「上传那一刻」的路径。DEMO_MODE 切换数据根
  *（.data → .data/demo）后，这些旧路径会整体失效，报 ENOENT copyfile ——
  * 任务必然失败，且与素材内容无关，重试毫无意义。
  * 这里按「记录路径 → 当前数据根 assets → 相邻数据根 assets」依次探测。
  *
  * ⚠️ 安全约束（原先缺失）：
  *   a.path / a.file 来自存储层，属于**外部可影响的输入**（历史数据、
  *   迁移进来的库、未来的导入功能）。旧实现直接把 a.path 交给
  *   path.resolve(a.path) 拼进 copyFileSync，一个带 '../' 的路径就能
  *   把根目录之外的文件复制进成片目录 —— 既能读任意文件，
  *   也可能把服务器上的敏感文件带进可下载的成片里。
  *   所以：所有候选路径必须落在允许的根目录之内，否则直接拒绝。
  */

  /** 判断 p 是否位于 root 之内（含 root 本身），且是合法的绝对路径 */
  _within(root, p) {
    if (!root || !p) return false;
    try {
      const r = path.resolve(root);
      const t = path.resolve(p);
      if (t === r) return true;
      return t.startsWith(r + path.sep);
    } catch (e) {
      return false;
    }
  }

  /** 允许的素材根目录：当前数据根与相邻数据根 */
  _assetRoots() {
    const roots = [];
    if (this.tmpRoot) roots.push(path.dirname(this.tmpRoot));
    if (this.outDir) roots.push(path.dirname(this.outDir));
    return roots.filter(Boolean);
  }

  _resolveAssetFile(a) {
    const cands = [];
    const roots = this._assetRoots();

    /* a.path：只有在允许根目录之内才采信 */
    if (a.path) {
      try {
        const resolved = path.resolve(a.path);
        if (roots.some((r) => this._within(r, resolved))) cands.push(resolved);
      } catch (e) {}
    }

    /* a.file：只取「纯文件名」，去掉任何目录成分，
       再拼到各 root 的 assets 下 —— 这样 '../' 天然失效。 */
    if (a.file) {
      const safeName = path.basename(String(a.file));
      if (safeName && safeName !== '.' && safeName !== '..' && !safeName.includes(path.sep)) {
        roots.forEach((r) => {
          cands.push(path.join(r, 'assets', safeName));         // 当前数据根
          cands.push(path.join(r, '..', 'assets', safeName));   // 相邻数据根（demo ↔ 生产）
        });
      }
    }

    for (const c of cands) {
      try {
        if (!c) continue;
        /* 最终闸：存在性检查之外，再确认仍在允许根内 */
        const inRoot = roots.some((r) => this._within(r, c));
        if (inRoot && fs.existsSync(c)) return c;
      } catch (e) {}
    }
    return null;
  }

  _fail(job, msg, dir, opts) {
    this._pushLog(job, 'err', '渲染失败：' + msg);
    const noRetry = !!(opts && opts.noRetry);
    if (!noRetry && job.attempt < this.maxAttempts) {
      job.status = 'queued';
      job.stage = `失败重试中（第 ${job.attempt + 1}/${this.maxAttempts} 次）`;
      job.error = msg;
      const delay = Math.min(8000, 800 * Math.pow(2, job.attempt - 1));
      const t = setTimeout(() => { this.timers.delete(job.id); this.store.save(true, 'jobs'); this.pump(); }, delay);
      if (t.unref) t.unref();
      this.timers.set(job.id, t);
      this._pushLog(job, 'warn', `${delay}ms 后重试`);
    } else {
      job.status = 'failed';
      job.stage = '失败';
      job.error = msg;
      job.finishedAt = Date.now();
      this.deadLetter.unshift({ id: job.id, title: job.title, error: msg, at: new Date().toISOString() });
      if (this.deadLetter.length > 100) this.deadLetter.length = 100;
      this.store.event('error', 'render', `任务 ${job.id} 渲染失败`, { error: msg });
      this._pushLog(job, 'err', `已达最大重试次数（${this.maxAttempts}），任务转入死信队列`);
    }
  }

  /** 取消任务：排队中直接标记，渲染中触发中断 */
  cancel(id) {
    const job = this.store.job(id);
    if (!job) return { ok: false, error: '任务不存在' };
    if (['done', 'failed', 'canceled'].indexOf(job.status) > -1) {
      return { ok: false, error: '任务已结束，无法取消', status: job.status };
    }
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
    const r = this.running.get(id);
    if (r) { r.abort(); }
    job.status = 'canceled';
    job.stage = '已取消';
    this._pushLog(job, 'warn', '收到取消请求');
    this.store.save(true, 'jobs');
    return { ok: true, job };
  }

  /** 删除任务（含成片文件） */
  remove(id) {
    const job = this.store.job(id);
    if (!job) return { ok: false, error: '任务不存在' };
    if (job.status === 'running') return { ok: false, error: '任务渲染中，请先取消' };
    (job.outputs || []).forEach((o) => {
      [o.file, o.coverFile].forEach((f) => {
        if (!f) return;
        try { fs.unlinkSync(path.join(this.outDir, f)); } catch (e) {}
      });
    });
    this.store.removeJob(id);
    return { ok: true };
  }

  close() {
    this.closed = true;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.running.forEach((r) => r.abort());
    /* K3：关闭时终止渲染子进程，避免孤儿进程占住 FFmpeg */
    this.workers.forEach((w) => { try { w.child.kill(); } catch (e) {} });
    this.workers = [];
    this.pending.clear();
  }
}

module.exports = { RenderQueue };
