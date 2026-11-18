'use strict';
/* =========================================================
   store.js — 分表持久化（K4）
   ---------------------------------------------------------
   旧实现：所有表住在一个 db.json，任何一次 save() 都要
           JSON.stringify 整个库（jobs+assets+orders+5000 线索
           +6000 GEO 采样 ≈ 3–6 MB），写放大严重。

   新实现：
   1) 每张表独立文件 —— save(true, 'collect_tasks') 只写这一张表；
   2) 高频追加表（线索池 / 运行记录）用 NDJSON —— 新增一条就是
      append 一行，O(1)，不再重写整表；
   3) JSON 表仍是「tmp + rename」原子写 + 400ms 合并；
   4) 启动时若发现旧版 db.json，自动拆分成分表并归档原文件。

   对外接口保持不变：外部代码照旧直接读写 store.data.<表>，
   老调用 save() / save(true) 仍可用（退化为写全部表）。
   ========================================================= */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} }

/* kind: json = 整表重写；ndjson = 追加写
   cap:  内存保留条数（与原业务常量一致）
   key:  NDJSON 去重键（后写覆盖先写） */
const SCHEMA = {
  jobs: { kind: 'json' },
  assets: { kind: 'json' },
  orders: { kind: 'json' },
  events: { kind: 'json' },
  geo_tasks: { kind: 'json' },
  geo_points: { kind: 'json' },
  geo_changes: { kind: 'json' },
  collect_tasks: { kind: 'json' },
  /* 采集账号：登录身份档案（平台/昵称/浏览器配置目录/配额） */
  collect_accounts: { kind: 'json' },
  /* 浏览器采集器：已配对的采集端（本机桥）与下发过的任务 */
  collect_devices: { kind: 'json' },
  collect_jobs: { kind: 'ndjson', cap: 600, key: 'id' },
  /* 搜到的作品索引（作品卡片数据源，按 platform|note_id 去重后写覆盖） */
  collect_notes: { kind: 'ndjson', cap: 1500, key: 'key' },
  collect_runs: { kind: 'ndjson', cap: 300, key: 'id' },
  geo_runs: { kind: 'ndjson', cap: 400, key: 'id' },
  collect_leads: { kind: 'ndjson', cap: 5000, key: 'id' },
  /* 去重账本：只存指纹，不存内容。独立于线索池的 5000 上限，
     否则旧线索被淘汰后，同一条评论会被再次当成新线索入池。 */
  collect_fp: { kind: 'ndjson', cap: 60000, key: 'fp' },
  /* 评论任务：作品 → 拟发正文 → 排队 → 采集端发布 → 回执。
     key = noteKey，同一作品只留一条最新记录（重发会覆盖状态）。 */
  collect_comments: { kind: 'ndjson', cap: 2000, key: 'noteKey' },
  /* 作品点赞：同一作品只留一条最新记录（重复点会变成取消赞） */
  collect_likes: { kind: 'ndjson', cap: 2000, key: 'noteKey' },
  /* 计费：订阅 / 钱包（加量包）/ 流水 / 用量 */
  billing_subscriptions: { kind: 'json' },
  billing_wallets: { kind: 'json' },
  billing_ledger: { kind: 'ndjson', cap: 2000, key: 'id' },
  billing_usage: { kind: 'ndjson', cap: 5000, key: 'id' },
  /* GEO 优化引擎 v2（管线式：身份/词包/资产/分发/报表/LLM 配置） */
  geo_org: { kind: 'json' },
  geo_packs: { kind: 'json' },
  geo_assets: { kind: 'json' },
  geo_dists: { kind: 'json' },
  geo_reports: { kind: 'json' },
  llm_cfg: { kind: 'json' },
  /* GEO 控制台（11 模块：站点/渠道/发布队列/探针快照/页面诊断/客户/设置/知识库） */
  geo_sites: { kind: 'json' },
  geo_channels: { kind: 'json' },
  geo_pubq: { kind: 'json' },
  geo_snaps: { kind: 'json' },
  geo_diag: { kind: 'json' },
  geo_tenants: { kind: 'json' },
  geo_settings: { kind: 'json' },
  geo_kb: { kind: 'json' },
  /* AI数字人：形象档案 / 驱动渲染 / 直播与对话会话 */
  dh_avatars: { kind: 'json' },
  dh_renders: { kind: 'ndjson', cap: 500, key: 'id' },
  dh_sessions: { kind: 'json' }
};

class Store extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;                                   /* 旧库路径，仅用于一次性迁移 */
    this.dir = path.join(path.dirname(file), 'db');
    ensureDir(this.dir);
    this.data = { seq: 1, bgm: '' };
    Object.keys(SCHEMA).forEach((k) => { this.data[k] = []; });
    this._dirty = new Set();
    this._timer = null;
    this._lines = {};                                    /* ndjson 已写行数，用于触发压缩 */
    const fresh = !fs.existsSync(this._p('meta'));
    this.load();
    if (fresh && fs.existsSync(this.file)) this._adoptLegacy();
  }

  /* ---------------- 路径 ---------------- */
  _p(name, ext) {
    const kind = SCHEMA[name] ? SCHEMA[name].kind : 'json';
    return path.join(this.dir, name + '.' + (ext || (kind === 'ndjson' ? 'ndjson' : 'json')));
  }

  /* ---------------- 加载 ---------------- */
  load() {
    Object.keys(SCHEMA).forEach((name) => {
      const v = SCHEMA[name].kind === 'ndjson'
        ? this._readNdjson(name)
        : this._readJson(this._p(name), []);
      this.data[name] = Array.isArray(v) ? v : [];
    });
    const meta = this._readJson(this._p('meta'), null) || {};
    this.data.seq = Number(meta.seq) || 1;
    this.data.bgm = meta.bgm || '';
    /* K10：存量数据在内存里补租户标记（不落盘，避免一次性写放大）。
       新写入的记录由创建方显式带 owner；读到没有 owner 的历史数据按 default 处理。 */
    Object.keys(SCHEMA).forEach((name) => {
      (this.data[name] || []).forEach((x) => {
        if (x && typeof x === 'object' && x.owner == null) x.owner = 'default';
      });
    });
  }

  /* ---------------- K10 · 租户视图（读隔离） ----------------
   * byOwner('jobs', 'acme') 只返回该客户的记录；owner 传空表示不限（超管/运维视角）。
   * 存量接口签名不动，需要隔离的调用点再切过来，避免一次性改遍所有查询。
   */
  byOwner(name, owner) {
    const list = this.data[name] || [];
    if (!owner) return list;
    return list.filter((x) => ((x && x.owner) || 'default') === owner);
  }

  countsByOwner(name) {
    const out = {};
    (this.data[name] || []).forEach((x) => {
      const k = (x && x.owner) || 'default';
      out[k] = (out[k] || 0) + 1;
    });
    return out;
  }

  _readJson(file, dft) {
    try {
      if (!fs.existsSync(file)) return dft;
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return j == null ? dft : j;
    } catch (e) {
      /* 数据损坏不阻塞启动：归档后重建 */
      try { fs.renameSync(file, file + '.broken-' + Date.now()); } catch (e2) {}
      return dft;
    }
  }

  _readNdjson(name) {
    const spec = SCHEMA[name];
    const cap = spec.cap || 5000;
    const key = spec.key || 'id';
    const file = this._p(name);
    let text = '';
    try { if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
    const lines = text.split('\n');
    const seen = new Set();
    const out = [];
    let n = 0;
    let bad = 0;
    /* 文件顺序 = 写入顺序（旧→新）；数组语义 = 新的在前，因此倒序遍历，
       并对同一 key 只取最后一次写入（等价于覆盖更新）。 */
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      n++;
      let rec;
      try { rec = JSON.parse(line); } catch (e) { bad++; continue; }
      if (!rec || typeof rec !== 'object') { bad++; continue; }
      const k = rec[key];
      if (k && seen.has(k)) continue;
      if (k) seen.add(k);
      if (out.length < cap) out.push(rec);
    }
    /* 只有「可解析的行」才计入行数 —— 原来把坏行也算进去，
       会让压缩判断（行数 > 2×cap）提前触发，且行数与实际有效记录数长期漂移。 */
    this._lines[name] = n - bad;
    if (bad) {
      console.warn('[store] ' + name + ' 有 ' + bad + ' 行无法解析（已跳过），可能是写入时进程被杀');
    }
    return out;
  }

  /* 旧版单文件 → 分表，只执行一次 */
  _adoptLegacy() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      Object.keys(SCHEMA).forEach((name) => {
        if (Array.isArray(j[name]) && j[name].length) this.data[name] = j[name];
      });
      this.data.seq = Number(j.seq) || this.data.seq;
      this.data.bgm = j.bgm || '';
      fs.renameSync(this.file, this.file + '.migrated-' + Date.now());
      this.save(true);
      console.log('[store] 旧库已拆分到 ' + this.dir + '（原 db.json 已归档）');
    } catch (e) {
      console.error('[store] 旧库迁移失败，按空库启动：', e && e.message);
    }
  }

  /* ---------------- 保存 ----------------
   * save(true)           → 立即落盘全部表（兼容旧调用）
   * save(true, 'jobs')   → 立即落盘指定表（推荐）
   * save()               → 400ms 合并后落盘全部表（兼容旧调用）
   * save(false, 'jobs')  → 合并后只落盘 jobs
   */
  save(immediate, table) {
    if (table) this._dirty.add(table);
    else Object.keys(SCHEMA).forEach((k) => this._dirty.add(k));
    this._dirty.add('meta');
    if (immediate) {
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      this._flush();
      return;
    }
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._flush(); }, 400);
    if (this._timer.unref) this._timer.unref();
  }

  _flush() {
    const dirty = this._dirty;
    this._dirty = new Set();
    dirty.forEach((name) => {
      try {
        if (name === 'meta') {
          return this._writeJson(this._p('meta'), { seq: this.data.seq, bgm: this.data.bgm });
        }
        const spec = SCHEMA[name];
        if (!spec) return;
        /* 显式 save 必须落盘：push 自己会 append，只有迁移/外部改内存时才走到这里 */
        if (spec.kind === 'ndjson') return this._compact(name, true);
        this._writeJson(this._p(name), this.data[name]);
      } catch (e) {
        console.error('[store] 持久化失败 ' + name + ':', e && e.message);
      }
    });
  }

  _writeJson(file, val) {
    const tmp = file + '.tmp';
    /* 加 fsync：tmp+rename 保证读者只看到完整文件，
       但没有 fsync 时，掉电可能得到「已改名但内容未落盘」的空文件。
       这是业务数据（线索池 / 订单），代价是一次 fsync 值得。 */
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(val, null, 0), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  /* NDJSON：追加一行；行数超过 2×cap 时自动压缩 */
  _append(name, rec) {
    try {
      /* 同样加 fsync：appendFileSync 默认不保证落盘，
         崩溃时最后几行（往往正是刚采到的线索）会丢。 */
      const fd = fs.openSync(this._p(name), 'a');
      try {
        fs.writeFileSync(fd, JSON.stringify(rec) + '\n', 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this._lines[name] = (this._lines[name] || 0) + 1;
      const spec = SCHEMA[name];
      if (spec.cap && this._lines[name] > spec.cap * 2) this._compact(name, true);
    } catch (e) {
      console.error('[store] 追加失败 ' + name + ':', e && e.message);
    }
  }

  /* 按内存顺序重写 NDJSON（数组新→旧，文件写旧→新） */
  _compact(name, force) {
    const spec = SCHEMA[name];
    const arr = this.data[name] || [];
    if (!force && (this._lines[name] || 0) <= (spec.cap || 5000)) return;
    try {
      const tmp = this._p(name) + '.tmp';
      const buf = [];
      for (let i = arr.length - 1; i >= 0; i--) buf.push(JSON.stringify(arr[i]));
      fs.writeFileSync(tmp, buf.length ? buf.join('\n') + '\n' : '', 'utf8');
      fs.renameSync(tmp, this._p(name));
      this._lines[name] = arr.length;
    } catch (e) {
      console.error('[store] 压缩失败 ' + name + ':', e && e.message);
    }
  }

  /* ---------------- 追加写入（高频表专用） ----------------
   * 用法：store.push('collect_leads', rec)
   * 内存 unshift（新的在前）+ 磁盘 append 一行，写入成本与表大小无关。
   */
  push(name, rec) {
    const spec = SCHEMA[name];
    if (!spec || spec.kind !== 'ndjson') throw new Error('push 仅支持 NDJSON 表：' + name);
    const arr = this.data[name];
    arr.unshift(rec);
    if (spec.cap && arr.length > spec.cap) arr.length = spec.cap;
    this._append(name, rec);
    return rec;
  }

  pushMany(name, recs) {
    const list = recs || [];
    for (let i = list.length - 1; i >= 0; i--) this.push(name, list[i]);  /* 保持入参顺序：先入的在前 */
    return list.length;
  }

  /* 内存记录被改动后，把新版本写进 NDJSON（后写覆盖） */
  upsert(name, rec) {
    const spec = SCHEMA[name];
    if (!spec || spec.kind !== 'ndjson') throw new Error('upsert 仅支持 NDJSON 表：' + name);
    const arr = this.data[name];
    const key = spec.key || 'id';
    const i = arr.findIndex((x) => x && x[key] === rec[key]);
    if (i >= 0) arr[i] = rec;
    else arr.unshift(rec);
    this._append(name, rec);
    return rec;
  }

  nextId(prefix) {
    const n = this.data.seq++;
    this._dirty.add('meta');
    return prefix + Date.now().toString(36) + n.toString(36).padStart(2, '0');
  }

  /* ---- jobs ---- */
  jobs() { return this.data.jobs; }
  job(id) { return this.data.jobs.filter((j) => j.id === id)[0] || null; }
  addJob(j) { this.data.jobs.unshift(j); this.save(false, 'jobs'); return j; }
  removeJob(id) {
    const i = this.data.jobs.findIndex((j) => j.id === id);
    if (i < 0) return false;
    this.data.jobs.splice(i, 1);
    this.save(true, 'jobs');
    return true;
  }
  findJobByKey(key) {
    return this.data.jobs.filter((j) => j.key === key && ['queued', 'running', 'done'].indexOf(j.status) > -1)[0] || null;
  }

  /* ---- assets ---- */
  assets() { return this.data.assets; }
  asset(id) { return this.data.assets.filter((a) => a.id === id)[0] || null; }
  addAsset(a) { this.data.assets.push(a); this.save(false, 'assets'); return a; }
  pruneAssets(keepIds) {
    const before = this.data.assets.length;
    this.data.assets = this.data.assets.filter((a) => keepIds.indexOf(a.id) > -1);
    if (this.data.assets.length !== before) this.save(true, 'assets');
    return before - this.data.assets.length;
  }

  /* ---- orders ---- */
  orders() { return this.data.orders; }
  order(no) { return this.data.orders.filter((o) => o.orderNo === no)[0] || null; }
  addOrder(o) { this.data.orders.unshift(o); this.save(true, 'orders'); return o; }

  /* ---- events（审计 / 运行事件） ---- */
  event(level, source, message, detail) {
    this.data.events.unshift({
      id: this.nextId('ev'),
      level: level || 'info', source: source || 'server',
      message: String(message || ''), detail: detail || {},
      created_at: new Date().toISOString()
    });
    if (this.data.events.length > 500) this.data.events.length = 500;
    this.save(false, 'events');
    /* K5：事件同时推给 SSE 订阅方（无订阅者时开销为 0） */
    try { this.emit('event', this.data.events[0]); } catch (e) {}
    return this.data.events[0];
  }

  /* ---- 运维信息 ---- */
  stats() {
    const out = { dir: this.dir, tables: {} };
    Object.keys(SCHEMA).forEach((name) => {
      out.tables[name] = {
        kind: SCHEMA[name].kind,
        rows: (this.data[name] || []).length,
        lines: this._lines[name] || 0
      };
    });
    return out;
  }
}

module.exports = { Store, ensureDir, SCHEMA };
