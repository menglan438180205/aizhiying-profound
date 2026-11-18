'use strict';
/* =========================================================
   ProFound · 服务端层（BFF）+ 渲染 Worker 入口
   ---------------------------------------------------------
   零依赖 Node HTTP 服务。承载：
     · 素材接收与存储（前端不再需要把密钥/大文件逻辑放在浏览器）
     · 剪辑任务编排（幂等、重试、死信、取消）
     · FFmpeg 真实渲染（子进程 Worker）
     · 成片与封面静态分发（含 HTTP Range，支持播放器拖动）
     · 评论区采集契约透传
     · 订单创建与支付回调入口（密钥仅存在于服务端环境变量）
   运行：node server/index.js
   ========================================================= */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { URL } = require('url');

const ff = require('./ffmpeg');
const mp = require('./multipart');
const { Store, ensureDir } = require('./store');
const { RenderQueue } = require('./queue');
const { Billing } = require('./billing');
const collector = require('./collector');
const geo = require('./geo');
const geoEngineMod = require('./geo-engine');   /* GEO 优化引擎 v2（九级管线，纯增量） */
const config = require('./config');
const schedule = require('./schedule');
const renderer = require('./renderer');
const samples = require('./samples');   /* 内置示例素材：让「没上传文件」也能走真实渲染 */
const demo = require('./demo');         /* 演示环境开关：隔离演示数据与生产库 */
const dataSamples = require('./data-samples'); /* 生产系统的数据结构样例（非演示数据） */
const editCap = require('./edit-capabilities');
const { CollectScheduler, seedTasks: seedCollectTasks } = require('./collect-sched');
const { createAccounts } = require('./collect-accounts');  /* 采集账号：登录身份档案 */
const { createCampaigns } = require('./collect-campaigns'); /* 战役：关键词 × 平台 → 调度任务 */
const { DeviceHub, normPlatform } = require('./collect-devices');        /* 浏览器采集器：本机采集端的任务中枢 */
const { LoginRelay } = require('./login-relay');                         /* 扫码登录中转：本机桥 ↔ 云端 BFF */
const { createComments } = require('./collect-comments');                /* 作品评论：拟稿 → 排队 → 回执 */
const { createLikes } = require('./collect-likes');                      /* 作品点赞：与评论共用采集端队列 */
const llmConfig = require('./llm-config');                               /* 全栈大模型配置中心（后台管理） */
const { SiteStore, probe: probeDomain } = require('./sites');
const deploy = require('./deploy');
const { mimeOf, escHtml } = require('./util');   /* 共享小工具：MIME 查表 + HTML 转义 */
/* 2026-11-08：WorkBuddy 云服务同源中继已下线（cloud-relay.js 删除）。
   登录与业务数据全部走本服务，不再有以 .cloud 开头的外发通道。 */
const { createAuth } = require('./auth');        /* 本地账号：云端登录失效时的兜底进门路径 */
const { createUploadDirect } = require('./upload-direct'); /* 直连上传网关：素材走 443，不再挤隧道 */
const avatar = require('./avatar');              /* AI数字人：形象/声音复刻 + 多驱动渲染 */
const overview = require('./overview');          /* 首屏聚合：GET /v1/overview（只读快照） */
const tenantMod = require('./tenant');           /* K1：租户标识唯一收敛点（票/任务/计量同一套规则） */

/* =========================================================
   环境变量收口（必须最先执行）
   ---------------------------------------------------------
   enforce() 在 NODE_ENV=production 且存在阻断项时抛错；
   同时会把 QA_MODE 这类「测试后门」强制关掉 —— 所以必须在
   STATIC_BLOCK 等依赖它的常量之前调用。
   这里不直接 process.exit，而是把错误留给 CLI 分支处理，
   这样测试进程仍可 require 本模块去断言错误内容。
   ========================================================= */
let CONFIG = null;
let CONFIG_ERROR = null;
try { CONFIG = config.enforce(); } catch (e) { CONFIG_ERROR = e; }

const VERSION = '1.0.0';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname);
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, '.data');
/* 演示环境写入 DATA_DIR/demo/，生产库 DATA_DIR/db.json 与演示数据彻底隔离 */
const DATA_ROOT = demo.root();
demo.ensureRoot();
const ASSET_DIR = path.join(DATA_ROOT, 'assets');
const OUT_DIR = path.join(DATA_ROOT, 'out');
const TMP_DIR = path.join(DATA_ROOT, 'tmp');
const BGM_DIR = path.join(DATA_ROOT, 'bgm');
/* AI秒搭建站产物根目录：此处持久化的站点可通过 /site/<id>/ 直接 HTTP 访问 */
const SITES_DIR = path.join(DATA_ROOT, 'sites');
const DB_FILE = path.join(DATA_ROOT, 'db.json');
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES || 512 * 1024 * 1024);
const API_TOKEN = process.env.API_TOKEN || '';
const STARTED_AT = Date.now();

[ASSET_DIR, OUT_DIR, TMP_DIR, BGM_DIR, SITES_DIR].forEach(ensureDir);

const store = new Store(DB_FILE);
const sites = new SiteStore(SITES_DIR);

/* K1：存量任务补租户归属（幂等）。
   老库里的 collect_tasks / geo_tasks 没有 tenant 字段，调度执行时拿不到归属，
   计量只能记到 default。这里在调度器启动前一次性补齐，之后新任务由接口写入。 */
try {
  const bf = tenantMod.backfillTasks(store);
  if ((bf.filled || bf.invalid) && process.env.QUIET !== '1') {
    console.log('[tenant/info] 存量任务补租户：collect_tasks ' + bf.byTable.collect_tasks.filled
      + ' 条 · geo_tasks ' + bf.byTable.geo_tasks.filled + ' 条'
      + (bf.invalid ? ' · 非法租户 ' + bf.invalid + ' 条（保留原值待人工确认）' : ''));
  }
} catch (e) {
  console.error('[tenant/err] 存量任务补租户失败：' + ((e && e.message) || e));
}

/* ---------------- K5 · 事件流（SSE） ----------------
 * 旧实现：/v1/events 只返回最近 N 条快照，前端只能自己定时轮询。
 * 新实现：同一个 URL 支持 SSE —— 带 `Accept: text/event-stream` 或
 *         `?stream=1` 时挂长连接，其余调用方仍拿快照（向后兼容）。
 * 附带：15s 心跳防代理断连；200 条环形缓冲 + Last-Event-ID 支持断线补发。
 */
const SSE_CLIENTS = new Set();
const SSE_RING = [];
const SSE_RING_MAX = 200;
let SSE_SEQ = 0;

function sseWrite(res, id, event, data) {
  try {
    if (id) res.write('id: ' + id + '\n');
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  } catch (e) {}
}

function sseBroadcast(event, data) {
  if (!SSE_CLIENTS.size) return;            /* 无订阅者：零开销 */
  const id = ++SSE_SEQ;
  const rec = { id: id, event: event, data: data };
  SSE_RING.push(rec);
  if (SSE_RING.length > SSE_RING_MAX) SSE_RING.shift();
  SSE_CLIENTS.forEach((res) => sseWrite(res, id, event, data));
}

function sseAttach(req, res, u) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write('retry: 3000\n\n');
  /* 断线补发 */
  const last = Number(u.searchParams.get('lastEventId') || req.headers['last-event-id'] || 0);
  if (last > 0) SSE_RING.filter((x) => x.id > last).forEach((x) => sseWrite(res, x.id, x.event, x.data));
  /* 首帧：带上最近日志，前端无需再拉一次快照 */
  sseWrite(res, 0, 'hello', { at: new Date().toISOString(), events: store.data.events.slice(0, 20) });
  SSE_CLIENTS.add(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
  if (hb.unref) hb.unref();
  const done = () => { clearInterval(hb); SSE_CLIENTS.delete(res); };
  req.on('close', done);
  req.on('error', done);
}

/* store 的审计事件直接进流；采集/GEO 的进度事件由各自模块经 store.event 汇入 */
store.on('event', (rec) => sseBroadcast('log', rec));
const billing = new Billing(store, { dataRoot: DATA_ROOT });
const queue = new RenderQueue(store, {
  concurrency: Number(process.env.RENDER_CONCURRENCY || 1),
  tmpRoot: TMP_DIR, outDir: OUT_DIR, bgmDir: BGM_DIR,
  onLog: (lv, m) => { if (process.env.QUIET !== '1') console.log(`[render/${lv}] ${m}`); }
});

/* ---- 重启恢复 ----
 * pump() 只在「提交新任务」时被调用。进程一旦重启，队列里残留的 queued
 * 任务就没人唤醒，永远停在「排队等待渲染资源」——用户看到进度条不动。
 * 另外崩溃/强杀会把任务留在 running 态，同样再也回不到队列。
 * 这里启动后做两件事：把 running 归位成 queued，然后统一 pump 一次。
 */
setImmediate(() => {
  try {
    const jobs = store.jobs();
    let revived = 0;
    jobs.forEach((j) => {
      if (j.status === 'running') {
        j.status = 'queued';
        j.stage = '排队等待渲染资源（服务重启已恢复）';
        revived++;
      }
    });
    if (revived) store.save(true, 'jobs');
    const waiting = store.jobs().filter((j) => j.status === 'queued').length;
    if (waiting && process.env.QUIET !== '1') {
      console.log(`[render/info] 队列恢复：${waiting} 个待渲染任务重新入队` + (revived ? `（含 ${revived} 个中断任务）` : ''));
    }
    if (waiting) queue.pump();
  } catch (e) {
    console.error('[render/err] 队列恢复失败：' + ((e && e.message) || e));
  }
});

/* K1：调度器共用的计量入口。
   租户来自任务归属（见 collect-sched/geo 的 run.tenant），调用方不再能漏传；
   非法租户被 billing 拒绝时打一条明账，避免「用量悄悄没记上」查不出来。 */
function meter(kind, qty, meta) {
  const r = billing.charge((meta && meta.tenant) || 'default', kind, qty, meta);
  if (r && r.code === 'BAD_TENANT' && process.env.QUIET !== '1') {
    console.error('[billing/err] 计量被拒：' + r.message
      + ' · kind=' + kind + ' tenant=' + ((meta && meta.tenant) || '')
      + ' runId=' + ((meta && meta.runId) || ''));
  }
  return r;
}

/* ---- GEO（生成式引擎优化）AI 关键词监测 ---- */
const geoSched = new geo.GeoScheduler(store, {
  onLog: (lv, m) => { if (process.env.QUIET !== '1') console.log(`[geo/${lv}] ${m}`); },
  /* 计量：GEO 检测按次计额度（无订阅时只记账，不拦截） */
  meter: meter
});
/* 种子监测任务只在演示环境写入，且数据来自 demo/dataset.js —— 生产库不会被演示数据污染。
   GEO_NO_SEED=1 / DEMO_NO_SEED=1 可关闭（测试用）。 */
if (demo.enabled() && process.env.DEMO_NO_SEED !== '1' && process.env.GEO_NO_SEED !== '1') {
  try { geoSched.seedCount = geo.seedTasks(geoSched, demo.dataset().geoKeywords); } catch (e) {}
}
geoSched.start();

/* ---- GEO 优化引擎 v2：九级管线（复用 geoSched 作探针监测，纯增量） ---- */
const geoEngine = new geoEngineMod.GeoEngine(store, {
  geoSched,
  onLog: (lv, m) => { if (process.env.QUIET !== '1') console.log(`[geop/${lv}] ${m}`); }
});

/* ---- GEO 控制台：11 模块数据层（纯增量，不改上面任何路由） ---- */
const geoConsoleMod = require('./geo-console');
const geoConsole = new geoConsoleMod.GeoConsole(store, {
  geoEngine,
  geoSched,
  onLog: (lv, m) => { if (process.env.QUIET !== '1') console.log(`[geo2/${lv}] ${m}`); }
});

/* ---- 评论区采集：定时调度 + 队列 + Worker ---- */
/* 采集账号（登录身份）：通道回答「走哪条路」，账号回答「用谁的号」 */
const collectAccounts = createAccounts(store);
/* 浏览器采集器中枢：任务下发到「装着扩展的那台电脑」，结果回传入池。
   云端从不直接访问平台 —— 登录态与住宅 IP 都留在使用者本机。 */
const deviceHub = new DeviceHub(store, {
  onResult: (job) => {
    try { ingestNotes(job); } catch (e) { console.error('[device] 作品入库失败：' + ((e && e.message) || e)); }
    /* 评论任务回执：成功/失败都要写回 collect_comments，前端才认得出「已评论」 */
    try { if (collectComments) collectComments.onJobDone(job); }
    catch (e) { console.error('[device] 评论回执写入失败：' + ((e && e.message) || e)); }
    try { if (collectLikes) collectLikes.onJobDone(job); }
    catch (e) { console.error('[device] 点赞回执写入失败：' + ((e && e.message) || e)); }
  }
});
/* 扫码登录中转：只存内存，登录会话分钟级 */
const loginRelay = new LoginRelay(deviceHub);
/* 评论任务：拟稿 / 排队 / 回执。放在 deviceHub 之后创建（需要它发任务），
   但 onResult 里用的是变量引用，创建顺序不会造成闭包问题。 */
let collectComments = null;
collectComments = createComments(store, deviceHub, { accounts: collectAccounts });
/* 点赞：与评论共用采集端队列，节奏更轻（12~30s / 日限 200） */
let collectLikes = null;
collectLikes = createLikes(store, deviceHub);
collector.attachDevice(deviceHub);
/* registry 是叶子模块，用探针注入而不是反向 require，避免循环依赖。
   只有「桥在线 + 扩展连着」才算可用，否则任务自动顺延到爬虫/供应商。 */
require('./collect-adapters/registry').setDeviceProbe(() => deviceHub.ready());
const collectSched = new CollectScheduler(store, {
  accounts: collectAccounts,
  onLog: (lv, m) => { if (process.env.QUIET !== '1') console.log(`[collect/${lv}] ${m}`); },
  /* 计量：按新增线索条数扣额度（无订阅时只记账，不拦截） */
  meter: meter
});
if (demo.enabled() && process.env.DEMO_NO_SEED !== '1' && process.env.COLLECT_NO_SEED !== '1') {
  try { seedCollectTasks(collectSched, demo.dataset().collectTasks); } catch (e) {}
}
collectSched.start();
const collectCampaigns = createCampaigns(store, { sched: collectSched, accounts: collectAccounts, comments: collectComments });

/* ---- 计费巡检：待支付订单 2h 超时关闭 + 订阅/试用到期降级 ---- */
setInterval(() => {
  try {
    const r = billing.sweep();
    if (r.closed || r.expired) {
      store.event('info', 'billing', '计费巡检：关闭过期订单 ' + r.closed + ' 笔，到期订阅 ' + r.expired + ' 个');
    }
  } catch (e) {
    console.error('[billing] 巡检失败：' + ((e && e.message) || e));
  }
}, 10 * 60 * 1000).unref?.();

/* ---------------- 工具 ---------------- */

/* MIME 查表与 mimeOf 已收口到 ./util（见顶部 require），此处不再重复定义。 */

function cors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  if (origin) res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type,Authorization,X-Tenant-Id,X-Collect-Token,X-Pay-Sign,X-Request-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range,Accept-Ranges,Content-Length,X-Request-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function send(res, status, body, headers) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body == null ? {} : body), 'utf8');
  const h = Object.assign({
    'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store'
  }, headers || {});
  res.writeHead(status, h);
  if (res.req && res.req.method === 'HEAD') return res.end();
  res.end(data);
}

const ok = (res, data, extra) => send(res, 200, Object.assign({ ok: true }, data || {}), extra);
const fail = (res, status, code, message, extra) =>
  send(res, status, Object.assign({ ok: false, code, message }, extra || {}));

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > (cap || MAX_UPLOAD)) {
        reject(Object.assign(new Error(`请求体超过上限 ${(cap || MAX_UPLOAD) / 1048576}MB`), { code: 'TOO_LARGE' }));
        try { req.destroy(); } catch (e) {}
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 读取并解析 JSON 请求体（解析失败按空对象处理） */
async function jsonBody(req, cap) {
  const raw = await readBody(req, cap || 1024 * 1024);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')) || {}; } catch (e) { return {}; }
}

/** 快速指纹：体积 + 首尾各 512KB 摘要（大文件不必全量哈希） */
function fingerprint(buf) {
  const h = crypto.createHash('sha1');
  h.update(String(buf.length));
  h.update(buf.slice(0, Math.min(524288, buf.length)));
  if (buf.length > 524288) h.update(buf.slice(-524288));
  return h.digest('hex').slice(0, 24);
}

const EXT_OK = /\.(jpe?g|png|webp|gif|bmp|mp4|mov|m4v|webm|mkv|avi)$/i;
function kindOf(name, contentType) {
  if (/^image\//.test(contentType || '')) return 'image';
  if (/^video\//.test(contentType || '')) return 'video';
  if (/\.(jpe?g|png|webp|gif|bmp)$/i.test(name || '')) return 'image';
  if (/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(name || '')) return 'video';
  return '';
}

/* ---------------- 素材落盘 ---------------- */

async function saveAssets(files, owner) {
  const out = [];
  const tnt = String(owner || 'default').slice(0, 64);
  for (const f of files) {
    const name = path.basename(f.name || 'asset');
    if (!EXT_OK.test(name)) {
      out.push({ name, error: '不支持的格式（仅支持 jpg/png/webp/gif/bmp 与 mp4/mov/webm/mkv）' });
      continue;
    }
    const kind = kindOf(name, f.contentType);
    if (!kind) { out.push({ name, error: '无法识别素材类型' }); continue; }

    const fp = fingerprint(f.data);
    const exist = store.assets().filter((a) => a.fingerprint === fp)[0];
    if (exist) { out.push(Object.assign({}, exist, { reused: true })); continue; }

    const id = store.nextId('as');
    const ext = path.extname(name).toLowerCase() || (kind === 'image' ? '.jpg' : '.mp4');
    const file = id + ext;
    const full = path.join(ASSET_DIR, file);
    fs.writeFileSync(full, f.data);

    const meta = await ff.probe(file, ASSET_DIR).catch(() => null);
    const rec = {
      id, owner: tnt, name: name.replace(/\.[^.]+$/, ''), file, path: full,
      kind, bytes: f.data.length, fingerprint: fp,
      width: meta ? meta.width : 0,
      height: meta ? meta.height : 0,
      duration: meta && meta.duration ? Number(meta.duration.toFixed(2)) : 0,
      createdAt: Date.now()
    };
    store.addAsset(rec);
    out.push(rec);
  }
  return out;
}

/* ---------------- 分块上传（绕开 Cloudflare 外网通道单请求 100s / 100MB 限制） ---------------- */

const CHUNK_CAP = 32 * 1024 * 1024;   /* 服务端单块上限 32MB，前端按 8MB 切 */
const UPLOAD_DIR = path.join(TMP_DIR, 'upload');

function uploadInit(req, res) {
  return jsonBody(req).then((b) => {
    const name = path.basename(String((b && b.name) || 'asset.bin'));
    if (!EXT_OK.test(name)) return fail(res, 400, 'BAD_NAME', '不支持的文件格式（仅图片/视频扩展名）');
    const id = 'up' + crypto.randomBytes(6).toString('hex');
    ensureDir(path.join(UPLOAD_DIR, id));
    fs.writeFileSync(path.join(UPLOAD_DIR, id, 'name.txt'), name);
    /* 期望总字节数：finish 时校验，缺块/截断绝不入库（并发上传时单块 502 会漏块） */
    const totalBytes = Number((b && b.totalBytes) || 0);
    if (totalBytes > 0) fs.writeFileSync(path.join(UPLOAD_DIR, id, 'meta.json'), JSON.stringify({ totalBytes }));
    /* 顺手清理 24h 前的僵尸会话（客户端中断后 init 目录会残留） */
    try {
      const day = 24 * 3600 * 1000;
      for (const d of fs.readdirSync(UPLOAD_DIR)) {
        const st = fs.statSync(path.join(UPLOAD_DIR, d));
        if (st.isDirectory() && Date.now() - st.mtimeMs > day) fs.rmSync(path.join(UPLOAD_DIR, d), { recursive: true, force: true });
      }
    } catch (e) {}
    return ok(res, { uploadId: id });
  });
}

function uploadChunk(req, res, upId, idx) {
  const dir = path.join(UPLOAD_DIR, String(upId).replace(/[^A-Za-z0-9-]/g, ''));
  if (!fs.existsSync(dir)) return fail(res, 404, 'NO_UPLOAD', '上传会话不存在（服务端可能重启，请重新发起剪辑）');
  return readBody(req, CHUNK_CAP).then((buf) => {
    if (!buf.length) return fail(res, 400, 'EMPTY_CHUNK', '分块为空');
    /* 按块号独立落盘（幂等）：同一块重传直接覆盖，不会像 append 一样把文件写坏 */
    fs.writeFileSync(path.join(dir, `chunk-${String(idx).padStart(5, '0')}.bin`), buf);
    const total = fs.readdirSync(dir).reduce((n, f) => (f.startsWith('chunk-') ? n + fs.statSync(path.join(dir, f)).size : n), 0);
    return ok(res, { received: idx, bytes: buf.length, total });
  }).catch((e) => {
    if (e && e.code === 'TOO_LARGE') return fail(res, 413, 'TOO_LARGE', `单块超过 ${(CHUNK_CAP / 1048576)}MB 上限`);
    throw e;
  });
}

async function uploadFinish(req, res, upId) {
  const dir = path.join(UPLOAD_DIR, String(upId).replace(/[^A-Za-z0-9-]/g, ''));
  const nameF = path.join(dir, 'name.txt');
  if (!fs.existsSync(dir) || !fs.existsSync(nameF)) return fail(res, 404, 'NO_UPLOAD', '上传会话不存在或未收到任何分块');
  const chunks = fs.readdirSync(dir).filter((f) => /^chunk-\d{5}\.bin$/.test(f)).sort();
  if (!chunks.length) return fail(res, 400, 'NO_UPLOAD', '未收到任何分块');
  /* 完整性校验：缺块（并发上传时某块 502）就拒绝入库，绝不产出截断的素材 */
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) || {}; } catch (e) {}
  const have = chunks.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  if (meta.totalBytes > 0 && have !== meta.totalBytes) {
    const idxs = chunks.map((f) => Number(f.slice(6, 11)));
    const missing = [];
    for (let i = 0; i <= Math.max.apply(null, idxs); i++) if (idxs.indexOf(i) < 0) missing.push(i);
    return fail(res, 409, 'INCOMPLETE',
      `素材不完整：收到 ${have}/${meta.totalBytes} 字节，缺失块 ${missing.join(',') || '（尺寸不符）'}`,
      { have, expect: meta.totalBytes, missing, uploadId: String(upId) });
  }
  const buf = Buffer.concat(chunks.map((f) => fs.readFileSync(path.join(dir, f))));
  const name = fs.readFileSync(nameF).toString('utf8');
  const saved = await saveAssets([{ name, data: buf, contentType: '' }], tenantOf(req));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  const good = saved.filter((a) => !a.error);
  if (!good.length) return fail(res, 400, 'ASSET_INVALID', '素材不可用', { rejected: saved.filter((a) => a.error) });
  return ok(res, { asset: good[0], assets: saved });
}

/* ---------------- 剪辑任务 ---------------- */

async function createEditJob(req, res) {
  const ctype = String(req.headers['content-type'] || '');
  let files = [];
  let params = {};

  const raw = await readBody(req);
  if (/multipart\/form-data/i.test(ctype)) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
    const boundary = m ? (m[1] || m[2]).trim() : '';
    const parts = mp.parse(raw, boundary);
    files = mp.files(parts, 'assets').concat(mp.files(parts, 'files')).map((p) => ({
      name: p.filename, contentType: p.contentType, data: p.data
    }));
    const pj = mp.field(parts, 'params');
    if (pj) { try { params = JSON.parse(pj); } catch (e) { return fail(res, 400, 'BAD_PARAMS', 'params 不是合法 JSON'); } }
    // 示例素材 id 列表（JSON 数组字面量），与 params 分开传，避免整包 params 解析失败殃及
    const sj = mp.field(parts, 'samples');
    if (sj) { try { params.samples = JSON.parse(sj); } catch (e) { return fail(res, 400, 'BAD_SAMPLES', 'samples 不是合法 JSON 数组'); } }
    ['title', 'count', 'ratio', 'shotSeconds', 'motion', 'transition', 'dedupe', 'coverTitle', 'cta', 'ctaText',
      'voice', 'subtitle', 'voiceRate', 'voiceText', 'beatSync']
      .forEach((k) => { const v = mp.field(parts, k); if (v) params[k] = v; });
  } else {
    let body = {};
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
    catch (e) { return fail(res, 400, 'BAD_JSON', '请求体不是合法 JSON'); }
    params = body.params || body;
    const arr = body.assets || body.files || [];
    for (const a of arr) {
      const decoded = mp.dataUrl(a.dataUrl || a.data || '');
      if (!decoded) return fail(res, 400, 'BAD_ASSET', `素材 ${a.name || ''} 的 dataUrl 无法解析`);
      files.push({ name: a.name || 'asset', contentType: a.contentType || decoded.contentType, data: decoded.data });
    }
  }

  const refIds = Array.isArray(params.assetIds) ? params.assetIds.map((x) => String(x)) : [];
  const refAssets = refIds.length
    ? refIds.map((id) => store.assets().filter((a) => a.id === id)[0]).filter(Boolean).map((a) => Object.assign({}, a, { reused: true }))
    : [];
  if (refIds.length && refAssets.length !== refIds.length) {
    const missing = refIds.filter((id) => !refAssets.some((a) => a.id === id));
    return fail(res, 400, 'ASSET_MISSING', '引用的上传素材不存在（服务端可能清理过素材库）：' + missing.join(','));
  }

  if (!files.length && !samples.pick(params.samples).length && !refAssets.length) {
    return fail(res, 400, 'NO_ASSET', '未收到任何素材（multipart 字段名 assets，或 JSON 字段 assets[].dataUrl；也可传 samples=[内置示例素材 id] 或 params.assetIds=[已上传素材 id]）');
  }
  if (files.length > 60) return fail(res, 400, 'TOO_MANY_ASSET', '单次最多 60 个素材');

  const saved = await saveAssets(files, tenantOf(req));
  const bad = saved.filter((a) => a.error);
  const sampleAssets = await materializeSamples(params.samples);
  const good = saved.filter((a) => !a.error).concat(sampleAssets, refAssets);
  if (!good.length) {
    return fail(res, 400, 'ASSET_INVALID', '所有素材均不可用', { rejected: bad });
  }

  // 归一化参数（带合法值校验，避免脏参数进渲染层）
  const RATIOS = ['9:16', '16:9', '1:1', '4:5'];
  const MOTIONS = ['kenburns', 'zoom', 'pan', 'none'];
  const TRANS = ['cut', 'fade', 'smart', 'slide'];
  // 布尔归一化：未传时取默认值；前端可能传 'false' / '0' / false
  const boolOf = (v, dflt) => (v === undefined || v === '' || v === null ? dflt
    : !(v === false || v === 'false' || v === '0' || v === 0));
  const cfg = {
    ratio: RATIOS.indexOf(params.ratio) > -1 ? params.ratio : '9:16',
    count: Math.max(1, Math.min(Number(params.count) || Math.min(6, good.length * 2), 20)),
    shotSeconds: Math.max(1, Math.min(Number(params.shotSeconds) || 2.5, 8)),
    motion: MOTIONS.indexOf(params.motion) > -1 ? params.motion : 'kenburns',
    transition: TRANS.indexOf(params.transition) > -1 ? params.transition : 'fade',
    dedupe: params.dedupe === false || params.dedupe === 'false' ? false : true,
    coverTitle: params.coverTitle === false || params.coverTitle === 'false' ? false : true,
    cta: params.cta === false || params.cta === 'false' ? false : true,
    ctaText: params.ctaText || '',
    /* 本地配音与字幕（默认关闭，保持既有 API 行为不变；前端会显式传 true） */
    voice: boolOf(params.voice, false),
    subtitle: boolOf(params.subtitle, true),
    voiceRate: Math.max(0.5, Math.min(Number(params.voiceRate) || editCap.DEFAULT_RATE, 3.0)),
    voiceText: String(params.voiceText || '').slice(0, 600),
    beatSync: boolOf(params.beatSync, false)
  };
  const title = String(params.title || '').trim() ||
    (String(good[0].name).split(/[·\-—]/)[0].trim().slice(0, 12) || '案例素材') + ' · ' + (good[0].kind === 'image' ? '图文成片' : '智能混剪');

  /* 计费：按「成片时长」预估算，额度不足直接 402，不静默成功 */
  const estMin = Math.max(0.1, Math.round((cfg.count * cfg.shotSeconds / 60) * 10) / 10);
  const quotaLeft = billing.summary(tenantOf(req)).left;
  if (quotaLeft && quotaLeft.minutes != null && quotaLeft.minutes >= 0 && quotaLeft.minutes < estMin) {
    return fail(res, 402, 'QUOTA_EXCEEDED',
      '剪辑额度不足：本月剩余 ' + quotaLeft.minutes + ' 分钟，本单约需 ' + estMin + ' 分钟。请升级套餐或购买加量包。',
      { need: estMin, left: quotaLeft.minutes });
  }

  const key = RenderQueue.fingerprint(good.map((a) => a.fingerprint), Object.assign({ title }, cfg));
  const job = {
    id: store.nextId('rj'),
    key,
    owner: tenantOf(req),          /* K10：任务归属客户，供后续按租户隔离查询 */
    title,
    status: 'queued',
    progress: 0,
    stage: '排队等待渲染资源',
    attempt: 0,
    request: Object.assign({ assets: good.map((a) => a.id) }, cfg),
    assetNames: good.map((a) => a.name),
    assetCount: good.length,
    outputs: [],
    logs: [],
    media: null,
    error: null,
    createdAt: Date.now(),
    created_at: new Date().toISOString()
  };
  const r = queue.submit(job, params.forceNew === true || params.forceNew === 'true');
  /* 幂等复用不重复扣额度 */
  if (!r.reused) billing.charge(tenantOf(req), 'minutes', estMin, { jobId: r.job.id });
  store.event('info', 'render', `提交剪辑任务 ${r.job.id}（${r.reused ? '幂等复用' : '新建'}）`, { assets: good.length, count: cfg.count });
  return send(res, r.reused ? 200 : 201, {
    ok: true, reused: r.reused, job: publicJob(r.job), assets: good.map((a) => ({ id: a.id, name: a.name, kind: a.kind, reused: !!a.reused })),
    rejected: bad, queue: queue.stats()
  });
}

function publicJob(j) {
  return {
    id: j.id, title: j.title, status: j.status, progress: j.progress, stage: j.stage,
    attempt: j.attempt, error: j.error || null,
    assetCount: j.assetCount, assetNames: j.assetNames || [],
    outputs: j.outputs || [],
    outputCount: (j.outputs || []).length,
    request: {
      count: j.request.count, ratio: j.request.ratio, shotSeconds: j.request.shotSeconds,
      motion: j.request.motion, transition: j.request.transition, dedupe: j.request.dedupe,
      voice: !!j.request.voice, subtitle: j.request.subtitle !== false, voiceRate: j.request.voiceRate || 0
    },
    media: j.media || null,
    createdAt: j.createdAt, finishedAt: j.finishedAt || null, elapsedMs: j.elapsedMs || null,
    logs: (j.logs || []).slice(-40)
  };
}

/* ---------------- 静态成片（含 Range） ---------------- */

/* 成片与示例素材共用同一套发文件逻辑：Range 只在需要拖拽播放的成片上开启。 */
function sendStaticFile(req, res, full, opt) {
  opt = opt || {};
  const stat = fs.statSync(full);
  const type = opt.type || mimeOf(path.basename(full));
  const maxAge = opt.maxAge || 3600;
  const range = opt.range ? req.headers.range : '';
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=' + maxAge
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(full, { start, end }).pipe(res);
  }
  const headers = {
    'Content-Type': type, 'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=' + maxAge
  };
  if (opt.range) headers['Accept-Ranges'] = 'bytes';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).pipe(res);
}

function serveOutFile(req, res, name) {
  const safe = path.basename(decodeURIComponent(name));
  const full = path.join(OUT_DIR, safe);
  if (!full.startsWith(OUT_DIR) || !fs.existsSync(full)) return fail(res, 404, 'NOT_FOUND', '文件不存在');
  return sendStaticFile(req, res, full, { range: true, maxAge: 3600 });
}

/* ---------------- 内置示例素材（免鉴权：与成片一样由 <img> 直连加载） ---------------- */

function serveSampleFile(req, res, name) {
  const safe = path.basename(decodeURIComponent(name));
  if (!/\.jpe?g$/i.test(safe) || !samples.has(safe.replace(/\.jpe?g$/i, ''))) {
    return fail(res, 404, 'NOT_FOUND', '示例素材不存在');
  }
  const full = path.join(samples.DIR, safe);
  if (!full.startsWith(samples.DIR) || !fs.existsSync(full)) return fail(res, 404, 'NOT_FOUND', '文件不存在');
  return sendStaticFile(req, res, full, { type: 'image/jpeg', maxAge: 86400 });
}

/**
 * 取请求所属租户。
 * K2：租户不再由请求头单独决定，优先级：
 *   ① 未启用鉴权（本地/演示，API_TOKEN 为空）→ 请求头优先，保持开发便利；
 *   ② 持有 API_TOKEN（运维/管理员）→ 允许请求头显式指定；
 *   ③ 普通会话票 → 以票内 tenant 为准，票里没有就 default，请求头一律忽略。
 * 这样「改个 X-Tenant-Id 就能读别人数据」不再成立。
 */
function tenantOf(req) {
  const hdr = String((req && req.headers && req.headers['x-tenant-id']) || '').trim().slice(0, 64);
  if (!API_TOKEN) return tenantMod.norm(hdr);
  const auth = String((req && req.headers && req.headers.authorization) || '');
  const isAdmin = auth === 'Bearer ' + API_TOKEN || readCookie(req, COOKIE_NAME) === API_TOKEN;
  if (isAdmin) return tenantMod.norm(hdr);
  let claims = null;
  try {
    const bt = bearerOf(req);
    if (bt && localAuth && typeof localAuth.claims === 'function') claims = localAuth.claims(bt);
  } catch (e) {}
  if (claims && claims.tenant) return tenantMod.norm(claims.tenant);
  return 'default';
}

/**
 * 把示例素材 id 规整为正式 asset 并入库（与上传素材同一张表）：
 *  - 指纹固定为 `sample-<id>`，重复提交直接复用，不重复生成/入库
 *  - path 指向 samples 目录的 JPEG，queue 准备阶段照常硬链接进任务目录
 * 这样 queue.js 与 renderer.js 零改动：示例素材和上传素材走完全相同的渲染链路。
 */
async function materializeSamples(ids) {
  const out = [];
  for (const id of samples.pick(ids)) {
    const fp = 'sample-' + id;
    const exist = store.assets().filter((a) => a.fingerprint === fp)[0];
    if (exist) {
      /* 路径自愈：素材记录可能来自旧数据目录 / 旧工作目录，
         文件不在原位时按当前样例目录纠正，避免渲染阶段才报 ENOENT。 */
      if (!fs.existsSync(exist.path)) {
        const fixed = samples.pathOf(id);
        if (fixed && fs.existsSync(fixed)) {
          exist.path = fixed;
          store.save(true, 'assets');
        }
      }
      if (fs.existsSync(exist.path)) { out.push(Object.assign({}, exist, { reused: true })); continue; }
    }
    await samples.ensure();
    const item = samples.list().filter((x) => x.id === id)[0];
    if (!item) continue;
    const rec = {
      id: store.nextId('as'), name: item.name, file: item.file, path: samples.pathOf(id),
      kind: 'image', bytes: item.bytes, fingerprint: fp,
      width: item.width, height: item.height, duration: 0,
      sample: true, createdAt: Date.now()
    };
    store.addAsset(rec);
    out.push(rec);
  }
  return out;
}

/* ---------------- 前端静态托管 ---------------- */
/* 生产形态：BFF 同时对外提供 SPA 与 API，前端与接口同源，无跨域问题 */
const STATIC_ROOT = process.env.STATIC_ROOT || ROOT.replace(/[\\/]server$/, '');
/* 黑名单：QA_MODE 下额外允许 .build（自动化测试页面放在那里），生产环境始终屏蔽 */
const STATIC_BLOCK = process.env.QA_MODE === '1'
  ? /(^|[\\/])(\.workbuddy|node_modules|\.data|\.git)([\\/]|$)/i
  : /(^|[\\/])(\.build|\.workbuddy|node_modules|\.data|\.git)([\\/]|$)/i;

/* ---------------- K0 · 静态白名单 ----------------
 * 之前 STATIC_ROOT 指向项目根、只靠黑名单过滤，导致 /app/.env.local、
 * /app/server/*.js 可被匿名下载（静态托管发生在鉴权之前，等于绕过鉴权）。
 * 改为「白名单 + 拒绝回溯」两道：只放行前端产物与其自有资源。
 * 需要新增静态资源时，请显式扩展 STATIC_ALLOW，不要放宽为目录直通。
 */
const STATIC_ALLOW = /^\/(?:index\.html|favicon\.ico|assets\/[\w.\-/]+)$/i;
const STATIC_ALLOW_QA = /^\/\.build\/[\w.\-/]+\.(?:html|js|css|png|jpe?g|svg)$/i;

function serveStatic(req, res, urlPath) {
  let rel = urlPath.replace(/^\/app\/?/, '');
  if (!rel) rel = 'index.html';
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch (e) {
    return fail(res, 400, 'BAD_PATH', '路径无法解析');
  }
  /* 归一化之前先拒绝回溯与空字节，避免 assets/../.env 这类绕过 */
  if (decoded.indexOf('..') > -1 || decoded.indexOf('\u0000') > -1) {
    return fail(res, 404, 'NOT_FOUND', '页面或资源不存在');
  }
  const reqPath = '/' + decoded.replace(/^\/+/, '');
  const qaAllow = process.env.QA_MODE === '1' && STATIC_ALLOW_QA.test(reqPath);
  if (!STATIC_ALLOW.test(reqPath) && !qaAllow) {
    return fail(res, 404, 'NOT_FOUND', '页面或资源不存在');
  }
  const full = path.normalize(path.join(STATIC_ROOT, decoded));
  if (!full.startsWith(STATIC_ROOT) || STATIC_BLOCK.test(full) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return fail(res, 404, 'NOT_FOUND', '页面或资源不存在');
  }
  const stat = fs.statSync(full);
  res.writeHead(200, {
    'Content-Type': mimeOf(full) + (/^(text|application\/json)/.test(mimeOf(full)) ? '; charset=utf-8' : ''),
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).pipe(res);
}

/* ---------------- 官网静态（GEO 标准官网） ----------------
 * 官网是独立产物（web/ 目录），与工作台 SPA（项目根 index.html）互不干扰：
 *   / 与 /index.html → web/index.html
 *   /robots.txt /sitemap.xml /llms.txt → web/ 同名文件
 *   /assets/* → web/assets/* 优先命中，未命中回退工作台 assets
 * 不复用 serveStatic：那是给 SPA 的白名单（只认 index.html/assets），
 * 官网是另一套根目录。安全模型仍为三段：拒绝回溯 → 归一化前缀校验 → 扩展名白名单。
 */
const WEB_ROOT = path.join(STATIC_ROOT, 'web');
const WEB_EXT = /\.(?:html|txt|xml|svg|png|jpe?g|webp|ico|css|js|woff2?)$/i;

/** 命中并已发送响应返回 true；未命中返回 false（供调用方回退，绝不抛错） */
function tryWebFile(req, res, rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch (e) { return false; }
  if (!decoded || decoded.indexOf('..') > -1 || decoded.indexOf('\u0000') > -1) return false;
  if (!WEB_EXT.test(decoded)) return false;
  const full = path.normalize(path.join(WEB_ROOT, decoded));
  if (!full.startsWith(WEB_ROOT) || STATIC_BLOCK.test(full)) return false;
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return false;
  const stat = fs.statSync(full);
  const type = mimeOf(full);
  const isText = /^(text\/(html|plain)|application\/(json|xml))/.test(type);
  res.writeHead(200, {
    'Content-Type': type + (isText ? '; charset=utf-8' : ''),
    'Content-Length': stat.size,
    /* 官网要给 AI 爬虫拿到最新口径：HTML/文本不缓存，静态资源短缓存 */
    'Cache-Control': isText ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff'
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(full).pipe(res);
  return true;
}

/* ---------------- AI秒搭建站产物托管 ----------------
   serveStatic 是给「应用自身资源」用的白名单静态服务；
   这里服务的是**运行时生成**的站点产物，根目录不同、来源不同，
   因此单独实现，但沿用同样的三段式防御：
     归一化前拒绝 ..  → id 字符集白名单 → 文件名扩展名白名单
 */
function serveSiteFile(req, res, raw) {
  const idx = raw.indexOf('/');
  const id = idx > -1 ? raw.slice(0, idx) : raw;
  const rel = idx > -1 ? raw.slice(idx + 1) : '';
  const hit = sites.resolveStatic(id, rel);
  if (!hit) return fail(res, 404, 'NOT_FOUND', '站点或文件不存在');
  const stat = fs.statSync(hit.full);
  const isText = /^(text|application\/(json|javascript|xml))/.test(hit.mime);
  res.writeHead(200, {
    'Content-Type': hit.mime + (isText ? '; charset=utf-8' : ''),
    'Content-Length': stat.size,
    /* 托管产物允许缓存，但 robots/sitemap/llms 需要更新即生效 */
    'Cache-Control': /^(robots\.txt|sitemap\.xml|llms\.txt)$/.test(String(rel)) ? 'no-cache' : 'public, max-age=300'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(hit.full).pipe(res);
}

/* ---------------- 状态页 ---------------- */

function statusPage(ffst) {
  const q = queue.stats();
  const jobs = store.jobs().slice(0, 8);
  const cfg = CONFIG || config.snapshot();
  const cs = collectSched.stats();
  const font = renderer.fontStatus();
  const rows = jobs.map((j) => `<tr><td>${j.id}</td><td>${esc(j.title)}</td><td>${j.status}</td><td>${j.progress}%</td><td>${(j.outputs || []).length}</td><td>${j.stage || ''}</td></tr>`).join('');
  const guard = cfg.guard || { ok: true, blocked: 0, warnings: 0, violations: [] };
  const guardRows = (guard.violations || []).map((v) =>
    `<li><b class="${v.severity === 'block' ? 'bad' : 'warn'}">${v.severity === 'block' ? '阻断' : '告警'}</b> <code>${esc(v.key)}</code> ${esc(v.message)}<br><span style="color:#8b90a0">修复：${esc(v.fix)}</span></li>`
  ).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>ProFound · 渲染服务</title><style>
body{font:14px/1.6 -apple-system,"Microsoft YaHei",sans-serif;margin:0;padding:28px;background:#0f1117;color:#e6e8ef}
h1{font-size:18px;margin:0 0 4px}.sub{color:#8b90a0;margin-bottom:20px}
.card{background:#171a23;border:1px solid #242835;border-radius:10px;padding:16px;margin-bottom:14px}
.kv{display:flex;gap:10px;flex-wrap:wrap}.kv span{background:#1e2230;padding:4px 10px;border-radius:6px;font-size:12.5px}
.ok{color:#3ddc97}.bad{color:#ff6b6b}.warn{color:#f5a524}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #242835}
code{background:#1e2230;padding:2px 6px;border-radius:4px}
ul{margin:6px 0 0;padding-left:20px}li{margin:4px 0;font-size:12.5px}
a{color:#8ab4ff}
</style></head><body>
<h1>ProFound · 服务端层（BFF）与渲染 Worker</h1>
<div class="sub">v${VERSION} · 运行 ${((Date.now() - STARTED_AT) / 1000).toFixed(0)}s · ${os.platform()} ${os.arch()} · ${esc(cfg.mode)}</div>
<div class="card"><b>运行状态</b><div class="kv">
<span>FFmpeg <b class="${ffst.ok ? 'ok' : 'bad'}">${ffst.ok ? '就绪' : '缺失'}</b></span>
<span>字体 <b class="${font.ok ? (font.cjk ? 'ok' : 'warn') : 'bad'}">${font.ok ? (font.cjk ? '中文可用' : '缺中文字形') : '未找到'}</b></span>
<span>队列 ${q.queued} 排队 / ${q.running} 渲染中 / ${q.done} 完成 / ${q.failed} 失败</span>
<span>并发 ${q.concurrency}</span><span>死信 ${q.deadLetter}</span>
<span>GEO 监测 <b class="${geoSched.stats().mode === 'unconfigured' ? 'warn' : 'ok'}">${{ upstream: '上游', local: '本地模拟', unconfigured: '未接入' }[geoSched.stats().mode]}</b> · ${geoSched.stats().enabled} 启用 / ${geoSched.stats().tasks} 任务</span>
<span>采集调度 <b class="${cs.mode === 'unconfigured' ? 'warn' : 'ok'}">${{ upstream: '上游', local: '本地模拟', unconfigured: '未接入' }[cs.mode]}</b> · ${cs.enabled} 启用 / ${cs.tasks} 任务 · 已执行 ${cs.runs} 轮 · 线索 ${cs.leads}</span>
</div><div style="margin-top:8px;color:#8b90a0;font-size:12px">${esc(ffst.version)}</div></div>
<div class="card"><b>环境变量收口</b>
<div class="kv" style="margin-top:6px">
<span>模式 <b class="${cfg.production ? 'warn' : ''}">${esc(cfg.mode)}</b></span>
<span>API_TOKEN <b class="${cfg.token && cfg.token.set ? 'ok' : 'warn'}">${cfg.token && cfg.token.set ? '已设置' : '未设置（无鉴权）'}</b></span>
<span>阻断 ${guard.blocked} 项</span><span>告警 ${guard.warnings} 项</span>
</div>
${guardRows ? '<ul>' + guardRows + '</ul>' : '<div style="margin-top:8px" class="ok">安全自检通过：无阻断项、无告警。</div>'}
</div>
<div class="card"><b>最近任务</b><table><tr><th>ID</th><th>标题</th><th>状态</th><th>进度</th><th>成片</th><th>阶段</th></tr>${rows || '<tr><td colspan="6">暂无任务</td></tr>'}</table></div>
<div class="card"><b>接口</b><div class="kv">
<span><a href="/app">/app</a> 前端页面（与 API 同源）</span>
<span><a href="/v1/health">/v1/health</a> 健康检查</span>
<span><code>POST /v1/edit/jobs</code> 创建剪辑任务</span>
<span><code>GET /v1/edit/jobs/:id</code> 任务状态</span>
<span><code>POST /v1/edit/jobs/:id/cancel</code> 取消</span>
<span><code>GET /files/&lt;name&gt;</code> 成片分发（HTTP Range）</span>
<span><code>POST /v1/comments/collect</code> 评论采集（手动，可指定 channel）</span>
<span><code>GET /v1/collect/channels</code> 采集通道清单与连通性（?probe=1 真连）</span>
<span><code>GET /v1/collect/tasks</code> 采集调度任务</span>
<span><code>POST /v1/collect/tasks/:id/run</code> 立即执行一轮</span>
<span><code>GET /v1/collect/leads</code> 采集线索池</span>
<span><code>GET /v1/geo/tasks</code> GEO 监测任务</span>
<span><code>POST /v1/geo/monitor</code> 执行监测轮次</span>
<span><code>GET /v1/geo/stream</code> 变化实时推送（SSE）</span>
<span><code>POST /v1/billing/orders</code> 下单</span>
<span><code>POST /v1/billing/notify</code> 支付回调</span>
</div></div>
</body></html>`;
}

const esc = escHtml; /* HTML 转义统一走 ./util.escHtml，保留原名以兼容下方调用点 */

/* ---------------- 路由 ---------------- */

/* ---------------- 鉴权（K6） ----------------
 * 三种等价凭证，覆盖三类调用方：
 *   1) Authorization: Bearer <token>  —— 脚本 / 跨域 / 前端 Api.call 自动注入
 *   2) Cookie: pf_bff=<token>（HttpOnly）—— 浏览器同源，无需 JS 参与，不怕 XSS 读走
 *   3) ?token=<token>                 —— EventSource 等无法自定义请求头的场景
 * 注意：静态托管在鉴权之前，所以静态白名单必须独立收口（见 serveStatic）。
 */
const COOKIE_NAME = 'pf_bff';

/* 本地账号实例（在下方 createAuth 注册区创建）。
   用 var 声明而不是 const，是为了让 authed() 这个函数声明在「实例尚未创建」
   的极早期调用下也不会踩 TDZ —— 此时它只是拿不到本地票而已。 */
var localAuth = null;

/* 直连上传网关实例（UPLOAD_DIRECT=1 且证书就绪时才有值） */
var upDirect = null;

/* 从 Authorization 头里取 Bearer 值（本地票校验用） */
function bearerOf(req) {
  const h = String(req.headers.authorization || '');
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : '';
}

/* 请求真实来源 IP：只有显式声明 TRUST_PROXY 才认 X-Forwarded-For，
   否则任何人都能伪造该头绕过登录失败限流。 */
function clientIpOf(req) {
  const trust = /^(1|true|yes|on)$/i.test(String(process.env.TRUST_PROXY || '').trim());
  if (trust) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return String((req.socket && req.socket.remoteAddress) || '') || 'unknown';
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  if (!raw) return '';
  const parts = raw.split(';');
  for (let i = 0; i < parts.length; i++) {
    const kv = parts[i].trim();
    const eq = kv.indexOf('=');
    if (eq > 0 && kv.slice(0, eq) === name) {
      const v = kv.slice(eq + 1);
      try { return decodeURIComponent(v); } catch (e) { return v; }
    }
  }
  return '';
}

function authed(req) {
  if (!API_TOKEN) return true;
  const h = String(req.headers.authorization || '');
  if (h === 'Bearer ' + API_TOKEN) return true;
  if (readCookie(req, COOKIE_NAME) === API_TOKEN) return true;
  /* 第四种凭证：本地账号会话票（HMAC 签名，无状态）。
     与 API_TOKEN 同权限级 —— 登录成功即等价于持有服务端令牌。
     校验全包在 try 里：auth 模块任何异常都不该让鉴权入口崩溃。 */
  if (localAuth) {
    const bt = bearerOf(req);
    if (bt) { try { if (localAuth.verifyToken(bt)) return true; } catch (e) {} }
  }
  /* SSE（EventSource）无法自定义请求头，允许以查询参数携带令牌 */
  try {
    const q = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (q && q === API_TOKEN) return true;
  } catch (e) {}
  return false;
}

/* 严格管理员：API_TOKEN 本身视为所有者；本地票只认 role=owner/admin。
   邀请码属于“能决定谁能进门”的权限，不能给普通 member。 */
function isOwner(req) {
  if (!API_TOKEN) return true;
  const h = String(req.headers.authorization || '');
  if (h === 'Bearer ' + API_TOKEN) return true;
  if (readCookie(req, COOKIE_NAME) === API_TOKEN) return true;
  if (localAuth) {
    const bt = bearerOf(req);
    if (bt) {
      try {
        const c = localAuth.claims(bt);
        if (c && (c.role === 'owner' || c.role === 'admin')) return true;
      } catch (e) {}
    }
  }
  return false;
}

/* ---------------- K7 · 表驱动路由 ----------------
 * 存量 60+ 分支仍是 if 链（暂不动，避免大面积回归）；
 * 新增端点一律登记在 ROUTES：method + 正则 + handler + 是否鉴权。
 * 好处有两个：
 *   1) 加接口不用在 1000 行的 handle() 里挑位置；
 *   2) 鉴权变成显式字段，不再靠「代码写在 authed() 前还是后」隐式决定。
 * 用法：route('GET', /^\/v1\/metrics$/, (req, res) => ok(res, metricsSnapshot()), { public: true })
 */
const ROUTES = [];
function route(method, pattern, handler, opts) {
  ROUTES.push({
    method: method,
    pattern: pattern,
    handler: handler,
    auth: !(opts && opts.public),
    desc: (opts && opts.desc) || ''
  });
}

async function matchRoute(method, p, req, res) {
  for (let i = 0; i < ROUTES.length; i++) {
    const r = ROUTES[i];
    if (r.method !== method) continue;
    const m = r.pattern.exec(p);
    if (!m) continue;
    if (r.auth && !authed(req)) {
      fail(res, 401, 'UNAUTHORIZED', '缺少或错误的 Bearer Token（服务端已开启 API_TOKEN 校验）');
      return true;
    }
    await r.handler(req, res, m);
    return true;
  }
  return false;
}

/* 注册：本地账号（前端不再内嵌任何令牌，这里是唯一的进门通道）
   账号表落 DATA_ROOT/users.ndjson；会话票用 API_TOKEN 作 HMAC 密钥，
   换 API_TOKEN = 所有已发会话票立即失效（应急下线手段）。
   ADMIN_PHONE / ADMIN_PASSWORD：启动时保证管理员账号存在（注册默认关闭，否则没人进得来）。
   REGISTER_CODE：配置后才允许自助注册，且必须带对邀请码。 */
localAuth = createAuth({
  dataDir: DATA_ROOT,
  secret: API_TOKEN || 'pf-local-auth-fallback',
  adminPhone: process.env.ADMIN_PHONE || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  registerCode: process.env.REGISTER_CODE || '',
  log: (lv, m) => { if (process.env.QUIET !== '1') console.log(`[auth/${lv}] ${m}`); }
});
localAuth.registerRoutes({
  route, ok, fail, jsonBody, authed, ownerOnly: isOwner,
  bearerOf: bearerOf,
  clientIp: clientIpOf
});

/* ---------------- AI数字人（独立领域模块，全部经 ROUTES 注册） ----------------
 * 形象复刻（照片→基准形象帧）+ 声音复刻（语音样本→声线档案）
 * + 文本/音频/运镜三种驱动 → mp4，覆盖录播成片、直播与对话会话。 */
avatar.attach({
  route, ok, fail, readBody,
  sendFile: sendStaticFile,
  store, DATA_ROOT, OUT_DIR, TMP_DIR,
  tenantOf,
  onCharge: (owner, kind, qty, meta) => billing.charge(owner, kind, qty, meta),
  log: (msg, lv) => { if (process.env.QUIET !== '1') console.log('[avatar/' + (lv || 'info') + '] ' + msg); }
});


/* ---------------- K11 · 运行指标 ----------------
 * 之前只有内存里 500 条事件，客户报「卡」时无法回答「慢在哪、错多少」。
 * 这里用 request 的 finish 事件做三件事：计数、状态码分布、耗时分位。
 * 只保留最近 500 次样本，内存开销可忽略。
 */
const METRICS = { total: 0, byStatus: {}, dur: [], startedAt: Date.now() };

function metricsSnapshot() {
  const d = METRICS.dur.slice().sort((a, b) => a - b);
  const q = (r) => (d.length ? d[Math.min(d.length - 1, Math.floor(d.length * r))] : 0);
  return {
    uptime: Math.floor((Date.now() - METRICS.startedAt) / 1000),
    requests: METRICS.total,
    status: METRICS.byStatus,
    latencyMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), samples: d.length },
    queue: queue.stats(),
    storage: store.stats(),
    sseClients: SSE_CLIENTS.size,
    memoryMB: Math.round(process.memoryUsage().rss / 1048576)
  };
}

function metricsProm() {
  const m = metricsSnapshot();
  const lines = [
    '# HELP profound_requests_total 累计请求数',
    '# TYPE profound_requests_total counter',
    'profound_requests_total ' + m.requests,
    '# HELP profound_request_duration_ms 请求耗时分位',
    '# TYPE profound_request_duration_ms gauge',
    'profound_request_duration_ms{quantile="0.5"} ' + m.latencyMs.p50,
    'profound_request_duration_ms{quantile="0.95"} ' + m.latencyMs.p95,
    'profound_request_duration_ms{quantile="0.99"} ' + m.latencyMs.p99,
    '# HELP profound_queue_running 渲染中任务数',
    '# TYPE profound_queue_running gauge',
    'profound_queue_running ' + m.queue.running,
    '# HELP profound_memory_rss_mb 常驻内存',
    '# TYPE profound_memory_rss_mb gauge',
    'profound_memory_rss_mb ' + m.memoryMB
  ];
  return lines.join('\n') + '\n';
}

/* 注册：租户视图（K10 验收口——两个客户的数据必须互不可见）
   K2 收口：这是管理员视图，会列出每张表的记录数。此前任何登录用户都能读，
   等于给了「猜别人有多少数据」的侧信道。现在只认 API_TOKEN 或票内 role=admin。 */
route('GET', /^\/v1\/tenants$/, (req, res) => {
  const auth = String(req.headers.authorization || '');
  let isAdmin = !API_TOKEN || auth === 'Bearer ' + API_TOKEN || readCookie(req, COOKIE_NAME) === API_TOKEN;
  if (!isAdmin) {
    try {
      const bt = bearerOf(req);
      const c = bt && localAuth && typeof localAuth.claims === 'function' ? localAuth.claims(bt) : null;
      if (c && c.role === 'admin') isAdmin = true;
    } catch (e) {}
  }
  if (!isAdmin) return fail(res, 403, 'FORBIDDEN', '仅管理员可查看租户统计');
  const tables = {};
  Object.keys(require('./store').SCHEMA).forEach((t) => { tables[t] = store.countsByOwner(t); });
  return ok(res, { tables: tables, hint: '请求头带 X-Tenant-Id 即可写入对应客户；byOwner() 提供读隔离' });
}, { desc: '按租户统计各表记录数（仅管理员）' });

/* 注册：指标端点（公开，便于探针直接抓） */
route('GET', /^\/v1\/metrics$/, (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.searchParams.get('format') === 'prom') {
    const body = Buffer.from(metricsProm(), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Content-Length': body.length });
    return res.end(body);
  }
  return ok(res, metricsSnapshot());
}, { public: true, desc: '运行指标（JSON / Prometheus 文本）' });

/* 注册：首屏聚合（R4）
   看板原来要串 /v1/collect/leads + /v1/billing/summary 两个请求，
   数字还要前端各算一遍。这里给一份同一时刻的只读快照；两个旧接口
   保持不变（桥、脚本、老页面仍在用），属于纯增量。 */
route('GET', /^\/v1\/overview$/, (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const limit = Math.max(1, Math.min(500, Number(u.searchParams.get('limit') || 80)));
  if (typeof collectSched.ensureScores === 'function') collectSched.ensureScores();
  return ok(res, overview.buildOverview(
    { store, collectSched, geoEngine, billing, queue },
    { tenant: tenantOf(req), leadLimit: limit }
  ));
}, { desc: '首屏聚合：线索 + 统计 + GEO 管线 + 剪辑队列 + 计费' });

/* =========================================================
   AI秒搭建站 · 生产链路
   ---------------------------------------------------------
   原先这段完全缺失：前端 buildSite() 在浏览器里拼出 HTML，
   产物既没有落盘也没有服务端托管，「域名」只是拼进 canonical
   的字符串。结果是填了真实域名也永远停在样例状态。

   这里补上服务端三件事：
     1) probe  —— 域名真实性探测（DNS / HTTPS / 线上 GEO 文件）
     2) save   —— 产物落盘持久化
     3) hosts  —— /site/<id>/ 真实 HTTP 托管（免鉴权，同 /app 白名单制）
   ========================================================= */

/* 域名真实性探测：前端域名输入框失焦即调用，决定「可被抓取」是否真就绪 */
route('GET', /^\/v1\/sites\/probe$/, async (req, res, m) => {
  const u = new URL(req.url, 'http://localhost');
  const domain = String(u.searchParams.get('domain') || '').trim();
  if (!domain) return fail(res, 400, 'BAD_REQUEST', '缺少 domain 参数');
  const fetch = u.searchParams.get('fetch') !== '0';
  try {
    const r = await probeDomain(domain, { withFetch: fetch });
    return ok(res, { probe: r });
  } catch (e) {
    return fail(res, 500, 'PROBE_FAILED', '域名探测失败：' + ((e && e.message) || e));
  }
}, { desc: '域名真实性探测（DNS / HTTPS / 线上 GEO 文件）' });

/* 站点列表 */
route('GET', /^\/v1\/sites$/, (req, res) => {
  const list = sites.list(50);
  const base = (req.headers['x-forwarded-proto'] || 'http') + '://' + (req.headers.host || 'localhost');
  return ok(res, {
    items: list.map((s) => Object.assign({}, s, { previewUrl: `${base}/site/${s.id}/index.html` })),
    total: list.length
  });
}, { desc: '站点列表（含托管预览地址）' });

/* 保存 / 更新站点（幂等：同 brand+domain 复用 id） */
route('POST', /^\/v1\/sites$/, async (req, res) => {
  const body = await jsonBody(req, 12 * 1024 * 1024);
  const r = sites.save(body);
  if (r.error) return fail(res, 400, r.error, r.message);
  const base = (req.headers['x-forwarded-proto'] || 'http') + '://' + (req.headers.host || 'localhost');
  store.event('info', 'geo.site.persist', `${r.record.brand} · ${r.record.files} 个文件已落盘`);
  return ok(res, {
    record: r.record,
    previewUrl: `${base}/site/${r.record.id}/index.html`,
    filesUrl: `${base}/v1/sites/${r.record.id}`,
    bytes: r.totalBytes
  });
}, { desc: '持久化站点产物' });

/* 站点详情（含文件正文） */
route('GET', /^\/v1\/sites\/([A-Za-z0-9_-]{1,64})$/, (req, res, m) => {
  const meta = sites.meta(m[1]);
  if (!meta) return fail(res, 404, 'NOT_FOUND', '站点不存在');
  const u = new URL(req.url, 'http://localhost');
  const only = String(u.searchParams.get('file') || '');
  if (only) {
    const text = sites.readFile(m[1], only);
    if (text == null) return fail(res, 404, 'NOT_FOUND', '文件不存在或路径非法');
    return ok(res, { id: m[1], name: only, text: text });
  }
  const files = {};
  (meta.files || []).forEach((f) => { files[f.name] = sites.readFile(m[1], f.name); });
  return ok(res, { meta: meta, files: files });
}, { desc: '站点详情 / 单文件源码' });

/* 删除站点 */
route('DELETE', /^\/v1\/sites\/([A-Za-z0-9_-]{1,64})$/, (req, res, m) => {
  const done = sites.remove(m[1]);
  if (!done) return fail(res, 404, 'NOT_FOUND', '站点不存在');
  return ok(res, { id: m[1], removed: true });
}, { desc: '删除站点' });

/* ---------------- 一键部署到 CloudBase ----------------
 * 产物不再需要人工下载 zip 再手动上传：导出 → 按目标域改域 → 直推云托管 → 前端自动校验。
 * 目标桶与地域来自 TCB_BUCKET / TCB_REGION，由 scripts/cb-doctor.js 探测确认。
 */

/* 部署能力自检（未配密钥时前端据此禁用按钮并给出提示） */
route('GET', /^\/v1\/deploy\/status$/, (req, res) => {
  return ok(res, deploy.status());
}, { desc: 'CloudBase 部署配置自检' });

/* 部署：覆盖指定站点到目标桶根目录 */
route('POST', /^\/v1\/sites\/([A-Za-z0-9_-]{1,64})\/deploy$/, async (req, res, m) => {
  let body = {};
  try { body = await jsonBody(req, 256 * 1024); } catch (e) { body = {}; }
  try {
    const r = await deploy.deploySite({
      siteId: m[1],
      domain: body.domain,
      bucket: body.bucket,
      region: body.region,
      prefix: body.prefix,
      concurrency: body.concurrency
    });
    store.event('info', 'geo.site.deploy', `${r.brand} · ${r.uploaded} 个文件已推到 ${r.domain}`);
    return ok(res, { deploy: r });
  } catch (e) {
    const code = (e && e.code) || 'DEPLOY_FAILED';
    const payload = { code, message: (e && e.message) || '部署失败' };
    if (e && e.detail) payload.deploy = e.detail;
    const status = (code === 'NO_TARGET' || code === 'NO_DOMAIN' || code === 'NO_SITE') ? 400 : 502;
    store.event('error', 'geo.site.deploy.fail', `${code}: ${payload.message}`);
    return fail(res, status, code, payload.message, payload);
  }
}, { desc: '把站点产物一键部署到 CloudBase（覆盖目标桶）' });

/* =========================================================
   浏览器采集器（device）
   ---------------------------------------------------------
   采集端在用户电脑上，云端连不到它 —— 所以全是「采集端主动来」：
     pair   （会话票）  页面取配对码
     claim  （公网）    本机桥拿码换设备令牌（码即凭证，10 分钟一次性）
     hello  （设备票）  心跳
     jobs   （设备票）  领任务
     result （设备票）  回传结果
   ========================================================= */

/** 作品索引入库：中栏「搜到的作品」卡片的数据源。
    按 platform|note_id 去重写覆盖（store.upsert），同一作品重复采到不会堆重复卡。 */
function ingestNotes(job) {
  const notes = job && job.result && job.result.notes;
  if (!Array.isArray(notes) || !notes.length) return 0;
  const at = new Date().toISOString();
  let n = 0;
  for (const raw of notes) {
    if (!raw || typeof raw !== 'object') continue;
    const platform = normPlatform(raw.platform || job.platform);
    const url = String(raw.url || raw.video_url || '').slice(0, 500);
    const nid = String(raw.note_id || raw.id || '').slice(0, 64);
    if (!url && !nid) continue;
    const key = platform + '|' + (nid || url);
    store.upsert('collect_notes', {
      key,
      note_id: nid,
      title: String(raw.title || '').slice(0, 200),
      url,
      author: String(raw.author || '').slice(0, 60),
      keyword: String(raw.keyword || job.keyword || '').slice(0, 60),
      platform,
      cover: String(raw.cover || '').slice(0, 600),
      publishAt: String(raw.publishAt || raw.publish_time || '').slice(0, 40),
      liked: Number(raw.liked || 0) || 0,
      comments: Number(raw.comments || raw.comment_count || 0) || 0,
      collected: Number(raw.collected || 0) || 0,
      taskId: job.taskId || '',
      campaignId: (job.campaignId || ((job.taskId && collectSched.task(job.taskId)) || {}).campaignId || ''),
      deviceId: job.deviceId || '',
      at,
      updatedAt: at
    });
    n++;
  }
  return n;
}

function deviceOfReq(req) {
  const h = String(req.headers['x-device-token'] || '').trim();
  return deviceHub.auth(h || bearerOf(req));
}

route('POST', /^\/v1\/device\/pair$/, async (req, res) => {
  const p = deviceHub.newPair(readCookie(req, COOKIE_NAME) ? 'cookie' : 'session');
  return ok(res, { pair: p, seconds: 600 });
}, { desc: '生成采集器配对码（已登录页面）' });

route('POST', /^\/v1\/device\/claim$/, async (req, res) => {
  const body = await jsonBody(req, 32 * 1024);
  const r = deviceHub.claim(body.code, {
    name: body.name, host: body.host, version: body.version, platforms: body.platforms
  }, clientIpOf(req));
  if (r.error) return fail(res, 400, r.error, r.message);
  store.event('info', 'collect.device', '采集器已配对：' + r.device.name + '（' + (r.device.host || '?') + '）');
  return ok(res, { device: r.device, token: r.token });
}, { public: true, desc: '本机桥用配对码换取设备令牌' });

route('POST', /^\/v1\/device\/hello$/, async (req, res) => {
  const dev = deviceOfReq(req);
  if (!dev) return fail(res, 401, 'DEVICE_UNAUTHORIZED', '设备令牌无效，请重新配对');
  const body = await jsonBody(req, 32 * 1024);
  return ok(res, { device: deviceHub.hello(dev, body), hub: deviceHub.status() });
}, { public: true, desc: '采集器心跳（设备票鉴权）' });

route('GET', /^\/v1\/device\/jobs$/, async (req, res) => {
  const dev = deviceOfReq(req);
  if (!dev) return fail(res, 401, 'DEVICE_UNAUTHORIZED', '设备令牌无效，请重新配对');
  deviceHub.hello(dev, { plugin: true });
  const job = deviceHub.claimNext(dev);
  return ok(res, { job: job || null, pending: deviceHub.pending() });
}, { public: true, desc: '采集器领任务（设备票鉴权）' });

route('POST', /^\/v1\/device\/jobs\/([A-Za-z0-9_-]{4,64})\/result$/, async (req, res, m) => {
  const dev = deviceOfReq(req);
  if (!dev) return fail(res, 401, 'DEVICE_UNAUTHORIZED', '设备令牌无效，请重新配对');
  const job = deviceHub.job(m[1]);
  if (!job) return fail(res, 404, 'JOB_NOT_FOUND', '任务不存在');
  if (job.deviceId && job.deviceId !== dev.id) return fail(res, 403, 'JOB_OWNED_BY_OTHER', '任务属于另一台采集器');
  const body = await jsonBody(req, 4 * 1024 * 1024);
  const r = deviceHub.finish(m[1], body);
  if (r.error) return fail(res, 404, r.error, '任务不存在');
  return ok(res, { job: { id: r.job.id, status: r.job.status, notes: (r.job.result.notes || []).length, comments: (r.job.result.comments || []).length } });
}, { public: true, desc: '采集器回传结果（设备票鉴权）' });

/* 采集端执行过程：扩展每做一步（打开页面/定位输入框/写入/点赞/发送）就报一条，
   云端只追加到 job.steps，前端中栏卡片据此画步骤条。设备票鉴权，写不了别的东西。 */
route('POST', /^\/v1\/device\/jobs\/([A-Za-z0-9_-]{4,64})\/progress$/, async (req, res, m) => {
  const dev = deviceOfReq(req);
  if (!dev) return fail(res, 401, 'DEVICE_UNAUTHORIZED', '设备令牌无效，请重新配对');
  const job = deviceHub.job(m[1]);
  if (!job) return fail(res, 404, 'JOB_NOT_FOUND', '任务不存在');
  if (job.deviceId && job.deviceId !== dev.id) return fail(res, 403, 'JOB_OWNED_BY_OTHER', '任务属于另一台采集器');
  const body = await jsonBody(req, 8 * 1024);
  const r = deviceHub.progress(m[1], body);
  if (r.error) return fail(res, 400, r.error, '缺少步骤名');
  return ok(res, r);
}, { public: true, desc: '采集端上报执行步骤（设备票鉴权）' });

/* ---------------- 扫码登录中转（本机桥 ↔ 云端 BFF） ----------------
   HTTPS 页面不能直连 http://127.0.0.1，所以由本机桥主动来领登录任务、
   回传二维码 PNG 与状态；页面只读同源 BFF。设备票鉴权，不暴露给公众。 */
route('GET', /^\/v1\/device\/login\/next$/, async (req, res) => {
  const dev = deviceOfReq(req);
  if (!dev) return fail(res, 401, 'DEVICE_UNAUTHORIZED', '设备令牌无效，请重新配对');
  deviceHub.hello(dev, {});
  const s = loginRelay.next(dev);
  return ok(res, { login: s ? loginRelay.view(s) : null });
}, { public: true, desc: '本机桥领取扫码登录任务（设备票鉴权）' });

route('POST', /^\/v1\/device\/login\/([A-Za-z0-9_]+)\/qr$/, async (req, res, m) => {
  const dev = deviceOfReq(req);
  if (!dev) return fail(res, 401, 'DEVICE_UNAUTHORIZED', '设备令牌无效，请重新配对');
  const body = await jsonBody(req, 4 * 1024 * 1024);
  const b64 = String(body.png || '');
  if (!b64 || b64.length > 4 * 1024 * 1024) return fail(res, 400, 'BAD_QR', '二维码数据为空或过大');
  let buf = null;
  try { buf = Buffer.from(b64, 'base64'); } catch (e) { buf = null; }
  if (!buf || !buf.length || buf.length > 3 * 1024 * 1024) return fail(res, 400, 'BAD_QR', '二维码数据无效');
  const r = loginRelay.qr(m[1], dev, buf, body.mime);
  if (r.error) return fail(res, 404, r.error.code, r.error.message);
  return ok(res, { bytes: buf.length });
}, { public: true, desc: '本机桥回传二维码 PNG（设备票鉴权）' });

route('POST', /^\/v1\/device\/login\/([A-Za-z0-9_]+)\/status$/, async (req, res, m) => {
  const dev = deviceOfReq(req);
  if (!dev) return fail(res, 401, 'DEVICE_UNAUTHORIZED', '设备令牌无效，请重新配对');
  const body = await jsonBody(req, 32 * 1024);
  const r = loginRelay.update(m[1], dev, body);
  if (r.error) return fail(res, 404, r.error.code, r.error.message);
  return ok(res, { ok: true });
}, { public: true, desc: '本机桥回传登录状态（设备票鉴权）' });

route('GET', /^\/v1\/device\/login\/([A-Za-z0-9_]+)\/state$/, async (req, res, m) => {
  const dev = deviceOfReq(req);
  if (!dev) return fail(res, 401, 'DEVICE_UNAUTHORIZED', '设备令牌无效，请重新配对');
  const s = loginRelay.state(m[1], dev);
  if (!s) return fail(res, 404, 'NOT_FOUND', '登录会话不存在');
  return ok(res, s);
}, { public: true, desc: '本机桥查询取消状态（设备票鉴权）' });

route('POST', /^\/v1\/collect\/login\/start$/, async (req, res) => {
  const body = await jsonBody(req, 64 * 1024);
  const r = loginRelay.start(body, body.deviceId);
  if (r.error) {
    const status = r.error.code === 'NO_DEVICE' ? 409 : 400;
    return fail(res, status, r.error.code, r.error.message);
  }
  store.event('info', 'collect.login', '扫码登录：' + r.session.platform + ' / ' + r.session.accountId);
  return send(res, 201, { ok: true, loginId: r.session.id, session: loginRelay.view(r.session), device: r.device });
}, { desc: '创建扫码登录会话（页面）' });

route('GET', /^\/v1\/collect\/login\/([A-Za-z0-9_]+)\/status$/, async (req, res, m) => {
  const s = loginRelay.get(m[1]);
  if (!s) return fail(res, 404, 'NOT_FOUND', '登录会话不存在或已过期');
  return ok(res, { session: loginRelay.view(s, true) });
}, { desc: '扫码登录状态（页面，带二维码 data URL）' });

route('GET', /^\/v1\/collect\/login\/([A-Za-z0-9_]+)\/qr$/, (req, res, m) => {
  const s = loginRelay.get(m[1]);
  if (!s || !s.qr) return fail(res, 404, 'NO_QR', '二维码还没准备好');
  res.writeHead(200, {
    'Content-Type': s.qrMime || 'image/png',
    'Content-Length': s.qr.length,
    'Cache-Control': 'no-store'
  });
  return res.end(s.qr);
}, { desc: '扫码登录二维码 PNG（页面，同源 Cookie 鉴权）' });

route('POST', /^\/v1\/collect\/login\/([A-Za-z0-9_]+)\/cancel$/, async (req, res, m) => {
  const s = loginRelay.cancel(m[1]);
  if (!s) return fail(res, 404, 'NOT_FOUND', '登录会话不存在');
  return ok(res, { session: loginRelay.view(s) });
}, { desc: '取消扫码登录（页面）' });

/* ---------------- 后台管理：全栈大模型配置 ----------------
   只出脱敏信息（sk-****abcd），明文 key 永远不离开服务端。 */
route('GET', /^\/v1\/admin\/llm$/, async (req, res) => {
  return ok(res, llmConfig.list(store));
}, { desc: '大模型配置列表（脱敏）' });

route('POST', /^\/v1\/admin\/llm$/, async (req, res) => {
  const body = await jsonBody(req, 32 * 1024);
  const r = llmConfig.save(store, body);
  if (r.error) return fail(res, 400, r.error.code, r.error.message);
  store.event('info', 'admin.llm', '大模型配置已保存：' + r.item.name + '（' + r.item.model + '）');
  return ok(res, r);
}, { desc: '新增大模型 / 修改配置' });

route('POST', /^\/v1\/admin\/llm\/test$/, async (req, res) => {
  const body = await jsonBody(req, 32 * 1024);
  const r = await llmConfig.test(store, body);
  if (body && body.id) llmConfig.markTest(store, body.id, r);
  return ok(res, r);
}, { desc: '测试模型连通性（真实调用一次）' });

/* 用 POST 而不是 GET：key 走查询串会进访问日志与浏览器历史 */
route('POST', /^\/v1\/admin\/llm\/models$/, async (req, res) => {
  const body = await jsonBody(req, 16 * 1024);
  const r = await llmConfig.models(store, String(body.id || ''), {
    base_url: String(body.base_url || ''),
    api_key: String(body.api_key || '')
  });
  return ok(res, r);
}, { desc: '拉取模型清单（网关不实现时返回空）' });

route('POST', /^\/v1\/admin\/llm\/enable$/, async (req, res) => {
  const body = await jsonBody(req, 8 * 1024);
  const r = llmConfig.enable(store, String(body.id || ''), body.enabled !== false);
  if (r.error) return fail(res, 404, r.error.code, r.error.message);
  return ok(res, r);
}, { desc: '启用 / 停用某个模型' });

route('POST', /^\/v1\/admin\/llm\/default$/, async (req, res) => {
  const body = await jsonBody(req, 8 * 1024);
  const r = llmConfig.setDefault(store, String(body.id || ''));
  if (r.error) return fail(res, 404, r.error.code, r.error.message);
  return ok(res, r);
}, { desc: '设为默认模型' });

route('DELETE', /^\/v1\/admin\/llm\/([A-Za-z0-9_-]{3,40})$/, async (req, res, m) => {
  const r = llmConfig.remove(store, m[1]);
  if (r.error) return fail(res, 404, r.error.code, r.error.message);
  store.event('warn', 'admin.llm', '大模型配置已删除：' + m[1]);
  return ok(res, r);
}, { desc: '删除模型配置' });

route('GET', /^\/v1\/device\/status$/, async (req, res) => {
  return ok(res, { hub: deviceHub.status(), channel: collector.channels().filter((c) => c.id === 'plugin')[0] || null });
}, { desc: '采集器在线状态（前端状态卡）' });

route('POST', /^\/v1\/device\/unpair$/, async (req, res) => {
  const body = await jsonBody(req, 8 * 1024);
  const id = String(body.id || '');
  const list = deviceHub.devices();
  const i = list.findIndex((d) => d.id === id);
  if (i < 0) return fail(res, 404, 'NOT_FOUND', '采集器不存在');
  list.splice(i, 1);
  store.save(true, 'collect_devices');
  return ok(res, { removed: id, hub: deviceHub.status() });
}, { desc: '解除采集器配对' });


async function handle(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname.replace(/\/+$/, '') || '/';

  /* K7：先走表驱动路由（新端点），未命中再落到存量 if 链 */
  if (await matchRoute(req.method, p, req, res)) return;
  const seg = p.split('/').filter(Boolean);

  /* 官网首页：GEO 标准官网优先；未部署时回退到原状态页，保证根路径永远有响应 */
  if ((p === '/' || p === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
    if (tryWebFile(req, res, 'index.html')) return;
    if (p === '/index.html') return fail(res, 404, 'NOT_FOUND', '页面或资源不存在');
  }
  /* 官网开放文件：给搜索引擎与 AI 爬虫的 robots / sitemap / llms 摘要 */
  if (/^\/(robots\.txt|sitemap\.xml|llms\.txt)$/.test(p) && (req.method === 'GET' || req.method === 'HEAD')) {
    if (tryWebFile(req, res, p.slice(1))) return;
    return fail(res, 404, 'NOT_FOUND', '文件不存在');
  }

  // 无需鉴权
  if ((p === '/' || p === '/status') && req.method === 'GET') {
    const html = Buffer.from(statusPage(await ff.status()), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
    return res.end(html);
  }
  if (p === '/v1/health' && req.method === 'GET') {
    const ffst = await ff.status();
    const caps = await ff.capabilities().catch(() => null);
    const cfg = CONFIG || config.snapshot();
    return ok(res, {
      service: 'aizhiying-bff', version: VERSION, uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
      ffmpeg: {
        ok: ffst.ok, version: ffst.version, ffprobe: !!ffst.ffprobe,
        capabilities: caps,
        font: renderer.fontStatus()
      },
      queue: queue.stats(),
      edit: { abilities: await editCap.abilities({ font: renderer.pickFont() }) },
      collector: await collector.upstreamHealth(),
      collect: Object.assign(
        { configured: collector.configured(), upstream: collector.mode() },
        collectSched.stats()
      ),
      geo: Object.assign({ upstream: await geo.upstreamHealth() }, geoSched.stats()),
      billing: Object.assign(billing.stats(), {
        enforce: true,
        plansFile: billing._cfgFile ? billing._cfgFile() : '',
        providerOk: !!(billing.provider && billing.provider.configured && billing.provider.configured())
      }),
      storage: { assets: store.assets().length, dataDir: DATA_ROOT, demoDir: demo.info().dataRoot },
      demo: demo.info(),
      dataSamples: { dir: 'data-samples/', entities: dataSamples.list().length },
      auth: API_TOKEN ? 'bearer' : 'open',
      /* 环境变量收口结果：设置页的「生产就绪度」直接读这里 */
      config: {
        mode: cfg.mode, production: cfg.production, node: cfg.node, platform: cfg.platform,
        token: cfg.token ? { set: cfg.token.set, length: cfg.token.length } : { set: false, length: 0 },
        flags: cfg.flags, guard: cfg.guard,
        bootError: CONFIG_ERROR ? String(CONFIG_ERROR.message).slice(0, 400) : ''
      },
      time: new Date().toISOString()
    });
  }
  /* ---- 演示数据集（仅 DEMO_MODE=1；生产返回 404，前端据此回落到空状态） ---- */
  if (p === '/v1/demo/status' && req.method === 'GET') {
    return ok(res, { demo: demo.info() });
  }
  if (p === '/v1/demo/dataset' && req.method === 'GET') {
    if (!demo.enabled()) {
      return fail(res, 404, 'DEMO_DISABLED',
        '演示数据仅在 DEMO_MODE=1 时可用。生产环境请使用 /v1/data-samples 的数据结构样例，'
        + '或接入真实数据源。');
    }
    return ok(res, { demo: demo.info(), dataset: demo.dataset() });
  }

  /* ---- 生产系统的数据结构样例（只读、无模拟业务数据） ---- */
  if (p === '/v1/data-samples' && req.method === 'GET') {
    return ok(res, { dir: 'data-samples/', samples: dataSamples.list() });
  }
  if (p.startsWith('/v1/data-samples/') && req.method === 'GET') {
    const name = p.slice('/v1/data-samples/'.length);
    const doc = dataSamples.get(name);
    return doc ? ok(res, { sample: doc }) : fail(res, 404, 'SAMPLE_NOT_FOUND', '没有该数据样例：' + name);
  }

  /* ---- 会话：用 API_TOKEN 换取 HttpOnly Cookie（K6，免鉴权，因为本身就是换票） ---- */
  if (p === '/v1/session') {
    if (req.method === 'GET') {
      return ok(res, { auth: API_TOKEN ? (authed(req) ? 'ok' : 'required') : 'open' });
    }
    if (req.method === 'DELETE') {
      res.setHeader('Set-Cookie', COOKIE_NAME + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return ok(res, { cleared: true });
    }
    if (req.method === 'POST') {
      const raw = await readBody(req, 8 * 1024);
      let payload = {};
      try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch (e) {}
      if (API_TOKEN && String(payload.token || '') !== API_TOKEN) {
        return fail(res, 401, 'BAD_TOKEN', '令牌不正确');
      }
      if (API_TOKEN) {
        res.setHeader('Set-Cookie',
          COOKIE_NAME + '=' + encodeURIComponent(API_TOKEN)
          + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800'
          + (req.socket && req.socket.encrypted ? '; Secure' : ''));
      }
      return ok(res, { auth: API_TOKEN ? 'cookie' : 'open' });
    }
    return fail(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET / POST / DELETE');
  }

  if (p.startsWith('/files/') && (req.method === 'GET' || req.method === 'HEAD')) {
    return serveOutFile(req, res, p.slice('/files/'.length));
  }
  if (p.startsWith('/v1/edit/samples/') && (req.method === 'GET' || req.method === 'HEAD')) {
    return serveSampleFile(req, res, p.slice('/v1/edit/samples/'.length));
  }
  if ((p === '/app' || p.startsWith('/app/')) && (req.method === 'GET' || req.method === 'HEAD')) {
    return serveStatic(req, res, p);
  }
  if (p.startsWith('/assets/') && (req.method === 'GET' || req.method === 'HEAD')) {
    /* 官网资源优先（web/assets），未命中回退工作台 assets —— 两条链路都保持原行为 */
    if (tryWebFile(req, res, p.slice(1))) return;
    return serveStatic(req, res, p);
  }
  if (p === '/favicon.ico' && (req.method === 'GET' || req.method === 'HEAD')) {
    return serveStatic(req, res, p);
  }

  /* AI秒搭建站产物托管：/site/<id>/index.html
     免鉴权（预览 iframe 带不了自定义头），安全性靠 SiteStore 的
     id 字符集 + 文件名白名单两层收敛，只读静态，不可写不可遍历 */
  if (p.startsWith('/site/') && (req.method === 'GET' || req.method === 'HEAD')) {
    return serveSiteFile(req, res, p.slice('/site/'.length));
  }

  /* 人工录入页（路径C：透镜GEO免费版人工验证通道，免鉴权访问；提交走 /v1/geo/manual 带 Bearer Token） */
  if (p === '/geo-manual' && req.method === 'GET') {
    const file = path.join(__dirname, 'geo-manual.html');
    if (!fs.existsSync(file)) return fail(res, 404, 'NOT_FOUND', '录入页未部署');
    try {
      const html = fs.readFileSync(file, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    } catch (e) { return fail(res, 500, 'READ_FAIL', '录入页读取失败'); }
  }

  if (!authed(req)) return fail(res, 401, 'UNAUTHORIZED', '缺少或错误的 Bearer Token（服务端已开启 API_TOKEN 校验）');

  // ---- 剪辑任务 ----
  if (p === '/v1/edit/samples' && req.method === 'GET') {
    // 内置示例素材清单：前端素材库据此把示例素材绑定为可渲染的真实图片
    const r = await samples.ensure();
    return ok(res, { ok: r.ok, items: r.items, reason: r.reason || '' });
  }
  if (p === '/v1/edit/jobs' && req.method === 'POST') return createEditJob(req, res);
  /* 分块上传（大素材走外网通道时规避 Cloudflare 100s/100MB 单请求限制） */
  if (p === '/v1/edit/upload/init' && req.method === 'POST') return uploadInit(req, res);
  {
    const mUp = /^\/v1\/edit\/upload\/([A-Za-z0-9-]{6,64})(?:\/(\d{1,5}|finish))?$/.exec(p);
    if (mUp && mUp[2] === 'finish' && req.method === 'POST') return uploadFinish(req, res, mUp[1]);
    if (mUp && mUp[2] !== undefined && mUp[2] !== 'finish' && req.method === 'PUT') return uploadChunk(req, res, mUp[1], Number(mUp[2]));
  }
  if (p === '/v1/edit/jobs' && req.method === 'GET') {
    return ok(res, {
      jobs: store.jobs().slice(0, Number(u.searchParams.get('limit') || 50)).map(publicJob),
      queue: queue.stats()
    });
  }
  if (seg[0] === 'v1' && seg[1] === 'edit' && seg[2] === 'jobs' && seg[3]) {
    const id = seg[3];
    const job = store.job(id);
    if (!job) return fail(res, 404, 'NOT_FOUND', '任务不存在');
    if (seg[4] === 'cancel' && req.method === 'POST') {
      const r = queue.cancel(id);
      return r.ok ? ok(res, { job: publicJob(r.job) }) : fail(res, 409, 'CANCEL_FAILED', r.error);
    }
    if (!seg[4] && req.method === 'GET') return ok(res, { job: publicJob(job) });
    if (!seg[4] && req.method === 'DELETE') {
      const r = queue.remove(id);
      return r.ok ? ok(res, { removed: id }) : fail(res, 409, 'DELETE_FAILED', r.error);
    }
  }
  if (p === '/v1/edit/stats' && req.method === 'GET') {
    // 死信视图：以持久化的 failed 任务为准，合并本次进程内的死信记录
    const persisted = store.jobs()
      .filter((j) => j.status === 'failed')
      .map((j) => ({ id: j.id, title: j.title, error: j.error || '', at: j.finishedAt ? new Date(j.finishedAt).toISOString() : j.created_at }));
    const seen = new Set(persisted.map((x) => x.id));
    const merged = persisted.concat(queue.deadLetter.filter((x) => !seen.has(x.id))).slice(0, 20);
    return ok(res, {
      queue: queue.stats(),
      deadLetter: merged,
      // 本地能力插件现状：前端据此如实显示「配音/字幕」是否真的可用
      abilities: await editCap.abilities({ font: renderer.pickFont() })
    });
  }

  // ---- 采集器 ----
  if (p === '/v1/comments/collect' && req.method === 'POST') {
    const raw = await readBody(req, 4 * 1024 * 1024);
    let body = {};
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch (e) {}
    /* 通道选择（含「无真实通道时落本地模拟」）全部由 collector 内部完成，
       这里不再手工回落 —— 否则「指定了未接入的通道」会被模拟数据掩盖 */
    const r = await collector.collect(body, req.headers);
    return send(res, r.status, r.body);
  }

  /* ---- 采集定时调度（Cron + 队列 + Worker） ----
     与「手动点击采集」并存：手动路径走上面的 /v1/comments/collect，
     常驻路径由 collectSched 按 cron / 间隔自动执行，并落到
     collect_runs（运行明细）与 collect_leads（去重后的线索池）。 */
  if (seg[0] === 'v1' && seg[1] === 'collect') {
    const act = seg[2] || '';
    /* 历史线索没有打分字段（打分是后加的），先补算再统计，
       否则 byLevel 全是 0，前端会以为一条意向都没有 */
    if (typeof collectSched.ensureScores === 'function') collectSched.ensureScores();

    if (act === 'config' && req.method === 'GET') {
      return ok(res, {
        stats: collectSched.stats(),
        upstream: await collector.upstreamHealth(),
        /* 多通道：official（自有内容评论区）/ crawler（自建爬虫）/
           vendor（第三方数据服务）/ local（本地模拟） */
        channels: collector.channels(),
        channelIds: collector.CHANNEL_IDS,
        scopes: collector.SCOPE_IDS,
        defaultChannel: String(process.env.COLLECT_DEFAULT_CHANNEL || 'auto'),
        defaultScope: 'auto',
        platforms: require('./collect-sched').PLATFORMS,
        /* 目标类型：关键词 / 博主 / 作品 / 地域 —— 前端「新建目标」据此渲染表单 */
        targets: require('./collect-sched').TARGETS,
        intentWords: require('./intent').DEFAULT_WORDS,
        leadStatuses: ['new', 'contacted', 'wechat', 'won', 'lost'],
        /* 采集账号：页面第一块要显示「哪个号在采、还活着吗」 */
        accounts: collectAccounts.list(),
        accountStats: collectAccounts.stats(collectSched.runs()),
        accountPlatforms: collectAccounts.PLATFORMS,
        accountStatuses: collectAccounts.STATUS,
        browserRoot: String(process.env.MC_BROWSER_ROOT || ''),
        intervals: schedule.EVERY_KEYS,
        minIntervalMs: schedule.MIN_EVERY_MS,
        cronSupported: true,
        cronPresets: [
          { cron: '*/15 * * * *', text: schedule.describeCron('*/15 * * * *') },
          { cron: '0 * * * *', text: schedule.describeCron('0 * * * *') },
          { cron: '0 9,15,21 * * *', text: schedule.describeCron('0 9,15,21 * * *') },
          { cron: '0 9 * * 1-5', text: schedule.describeCron('0 9 * * 1-5') }
        ]
      });
    }

    /* ---- 采集账号（登录身份档案）----
       账号回答「用谁的号采」，与通道（走哪条路）正交。
       登录态持久化在 MediaCrawler 的浏览器配置目录里，这里只做登记 + 探测 + 配额。 */
    if (act === 'accounts') {
      if (!seg[3] && req.method === 'GET') {
        return ok(res, {
          accounts: collectAccounts.list(),
          stats: collectAccounts.stats(collectSched.runs()),
          platforms: collectAccounts.PLATFORMS,
          statuses: collectAccounts.STATUS,
          platformLabel: collectAccounts.PLATFORM_LABEL,
          browserRoot: String(process.env.MC_BROWSER_ROOT || '')
        });
      }
      if (!seg[3] && req.method === 'POST') {
        const body = await jsonBody(req, 32 * 1024);
        const r = collectAccounts.add(body);
        if (!r.ok) return fail(res, 400, r.code, r.message, { accountId: r.accountId });
        return send(res, 201, { ok: true, account: r.account, stats: collectAccounts.stats(collectSched.runs()) });
      }
      const accId = seg[3];
      if (accId && !seg[4] && req.method === 'GET') {
        const a = collectAccounts.get(accId);
        return a ? ok(res, { account: a }) : fail(res, 404, 'NOT_FOUND', '账号不存在');
      }
      if (accId && !seg[4] && req.method === 'PATCH') {
        const body = await jsonBody(req, 32 * 1024);
        const r = collectAccounts.update(accId, body);
        if (!r) return fail(res, 404, 'NOT_FOUND', '账号不存在');
        if (r.error) return fail(res, 400, r.error.code, r.error.message);
        return ok(res, { account: r, stats: collectAccounts.stats(collectSched.runs()) });
      }
      if (accId && !seg[4] && req.method === 'DELETE') {
        /* 解绑：删号前把引用它的任务置回 auto，避免任务指向不存在的账号 */
        collectSched.tasks().forEach((t) => {
          if (t.accountId === accId) { t.accountId = ''; }
        });
        collectSched.store.save(true, 'collect_tasks');
        return collectAccounts.remove(accId)
          ? ok(res, { removed: accId, stats: collectAccounts.stats(collectSched.runs()) })
          : fail(res, 404, 'NOT_FOUND', '账号不存在');
      }
      if (accId && seg[4] === 'probe' && req.method === 'POST') {
        const r = collectAccounts.probe(accId);
        return r ? ok(res, r) : fail(res, 404, 'NOT_FOUND', '账号不存在');
      }
      /* ---- 扫码登录 ----
         二维码只能弹在「有屏幕的采集机」上，所以这里只是转发：
         BFF → crawler 通道（桥） → 桥在本机弹出浏览器 → 用户扫码 → Cookies
         落进 profileDir。profileDir 由系统自动管理，用户不需要填路径。 */
      if (accId && seg[4] === 'login' && (req.method === 'POST' || req.method === 'GET')) {
        const a = collectAccounts.get(accId);
        if (!a) return fail(res, 404, 'NOT_FOUND', '账号不存在');
        const registry2 = require('./collect-adapters/registry');
        const base = registry2.urlOf('crawler');
        if (!base) {
          return fail(res, 409, 'NO_CRAWLER_CHANNEL',
            '采集通道未接入，扫码登录需要采集机上运行桥服务（COLLECT_CRAWLER_URL）');
        }
        /* profileDir 自动管理：没填就按账号分配一个，落库后探测/采集共用 */
        if (!a.profileDir) {
          const auto = 'aizy_' + a.platform + '_' + a.id;
          collectAccounts.update(accId, { profileDir: auto });
          a.profileDir = auto;
        }
        const headers = { 'Content-Type': 'application/json' };
        const token = registry2.tokenOf('crawler');
        if (token) headers.Authorization = 'Bearer ' + token;
        const upstream = req.method === 'POST'
          ? { path: '/v1/login/start', body: { platform: a.platform, profileDir: a.profileDir } }
          : { path: '/v1/login/status?session=' + encodeURIComponent(String(u.searchParams.get('session') || '')), body: undefined };
        try {
          const fr = await fetch(base + upstream.path, {
            method: req.method === 'POST' ? 'POST' : 'GET',
            headers,
            body: upstream.body ? JSON.stringify(upstream.body) : undefined,
            signal: AbortSignal.timeout(15000)
          });
          const j = await fr.json().catch(() => ({}));
          if (!fr.ok || j.ok === false) {
            return send(res, fr.status || 502, {
              ok: false, code: j.code || 'LOGIN_UPSTREAM_FAIL',
              message: j.message || '采集机登录服务返回异常'
            });
          }
          /* 登录成功 → 回写探测结果，账号状态直接转有效（这是客观证据，不是猜的） */
          const s = j.session || {};
          if (s.status === 'ok') {
            const pr = collectAccounts.probe(accId);
            if (pr && pr.level === 'ok') collectAccounts.update(accId, { status: 'active' });
          }
          return ok(res, { session: s, account: collectAccounts.get(accId) });
        } catch (e) {
          return fail(res, 502, 'LOGIN_UNREACHABLE',
            '连不上采集机的登录服务（' + base + '）：' + ((e && e.message) || e));
        }
      }
      if (accId && seg[4] === 'login' && req.method === 'DELETE') {
        /* 取消等待中的扫码 */
        const registry3 = require('./collect-adapters/registry');
        const base3 = registry3.urlOf('crawler');
        if (base3) {
          try { await fetch(base3 + '/v1/login/cancel', { method: 'POST', signal: AbortSignal.timeout(8000) }); } catch (e) {}
        }
        return ok(res, { canceled: true });
      }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的账号操作');
    }

    /* 运行时切换采集通道地址（免改环境变量 / 免重启）。
       前端「采集服务配置」保存与「一键体验」都走这里：
         Body { channel: 'crawler'|'official'|'vendor', url, token }
         url = '__EXP__' → 解析为体验桥地址（COLLECT_EXPERIENCE_URL，默认 127.0.0.1:8802）
         url = ''       → 清空覆盖，回退到环境变量 / 未配置态
       覆盖项落盘到 .data/collect-override.json，进程重启后仍生效。 */
    if (act === 'config' && req.method === 'POST') {
      const body = await jsonBody(req, 32 * 1024);
      const channel = String(body.channel || 'crawler').trim().toLowerCase();
      if (['official', 'crawler', 'vendor'].indexOf(channel) < 0) {
        return fail(res, 400, 'CHANNEL_UNKNOWN', '仅支持 official / crawler / vendor，收到：' + channel);
      }
      if (typeof collector.setOverride !== 'function') {
        return fail(res, 500, 'NO_OVERRIDE', '当前版本不支持运行时通道配置，请升级后重试');
      }
      const expUrl = String(process.env.COLLECT_EXPERIENCE_URL || 'http://127.0.0.1:8802').replace(/\/+$/, '');
      let url = String(body.url || '').trim();
      const isExp = url === '__EXP__';
      if (isExp) url = expUrl;
      const token = String(body.token || '').trim();
      collector.setOverride(channel, url, token);
      const ch = collector.channels().filter((c) => c.id === channel)[0] || {};
      return ok(res, {
        channel,
        url: ch.upstream || url,
        experience: isExp,
        mode: collector.mode(),
        configured: collector.configured(),
        channels: collector.channels()
      });
    }

    /* 通道清单与连通性探测。默认只回配置态（不打上游），?probe=1 才真连 */
    if (act === 'channels' && req.method === 'GET') {
      const doProbe = String(u.searchParams.get('probe') || '') === '1';
      const probe = doProbe ? await collector.channelHealth() : [];
      return ok(res, {
        mode: collector.mode(),
        configured: collector.configured(),
        channels: collector.channels(),
        channelIds: collector.CHANNEL_IDS,
        scopes: collector.SCOPE_IDS,
        defaultChannel: String(process.env.COLLECT_DEFAULT_CHANNEL || 'auto'),
        probe: probe,
        probed: doProbe
      });
    }

    if (act === 'preview' && req.method === 'POST') {
      const body = await jsonBody(req, 64 * 1024);
      const v = schedule.validateSchedule({ cron: body.cron || '', every: body.every });
      if (!v.ok) return fail(res, 400, v.code, v.message);
      return ok(res, { schedule: v, times: schedule.preview({ cron: body.cron || '', every: body.every }, 5) });
    }

    /* ---- 战役层：关键词 × 平台 → 多条调度任务 ---- */
    if (act === 'campaigns' && !seg[3] && req.method === 'GET') {
      return ok(res, { campaigns: collectCampaigns.listWithStats() });
    }
    if (act === 'campaigns' && !seg[3] && req.method === 'POST') {
      const body = await jsonBody(req, 128 * 1024);
      const r = collectCampaigns.save(body, tenantOf(req));
      if (r.error) return fail(res, 400, r.error.code, r.error.message);
      return send(res, 201, { ok: true, campaign: r.campaign });
    }
    if (act === 'campaigns' && seg[3]) {
      const id = seg[3];
      if (req.method === 'POST' && seg[4] === 'start') {
        const r = collectCampaigns.start(id);
        if (r.error) return fail(res, 404, r.error.code, r.error.message);
        return ok(res, { campaign: r.campaign, result: r.result, tasks: r.tasks, stats: collectCampaigns.stats(id) });
      }
      if (req.method === 'POST' && (seg[4] === 'pause' || seg[4] === 'resume')) {
        const r = seg[4] === 'pause' ? collectCampaigns.pause(id) : collectCampaigns.resume(id);
        if (r.error) return fail(res, 404, r.error.code, r.error.message);
        return ok(res, { campaign: r.campaign, tasks: r.tasks, stats: collectCampaigns.stats(id) });
      }
      /* 读 → 写：跑完采集后，用这场战役的作品生成触达任务 */
      if (req.method === 'POST' && seg[4] === 'engage') {
        const body = await jsonBody(req, 32 * 1024);
        const r = await collectCampaigns.engage(id, body);
        if (r.error) return fail(res, 400, r.error.code, r.error.message);
        return ok(res, r);
      }
      if (req.method === 'POST' && seg[4] === 'retry') {
        const r = await collectCampaigns.retryFailed(id);
        if (r.error) return fail(res, 400, r.error.code, r.error.message);
        return ok(res, r);
      }
      if (req.method === 'DELETE' && !seg[4]) {
        return collectCampaigns.remove(id)
          ? ok(res, { removed: id })
          : fail(res, 404, 'NOT_FOUND', '战役不存在');
      }
    }

    /* ---- 异常队列：任务失败 + 评论失败，统一一个入口 ---- */
    if (act === 'exceptions' && !seg[3] && req.method === 'GET') {
      const items = [];
      const runs = collectSched.runs().filter((r) => r && r.status === 'failed' && !r.acknowledgedAt).slice(0, 60);
      runs.forEach((r) => {
        const t = collectSched.task(r.taskId) || {};
        items.push({
          type: 'task', id: r.id, taskId: r.taskId,
          title: (t.keyword || r.keyword || '采集任务') + ' · ' + (r.platform || t.platform || ''),
          platform: r.platform || t.platform || '',
          reason: r.reason || 'FAILED', message: r.note || '',
          campaignId: t.campaignId || '', at: r.at || ''
        });
      });
      const cms = (store.data.collect_comments || []).filter((c) => c && c.status === 'failed' && !c.acknowledgedAt).slice(0, 60);
      cms.forEach((c) => {
        items.push({
          type: 'comment', id: c.id, noteKey: c.noteKey,
          title: c.title || c.url || '评论任务',
          platform: c.platform || '',
          reason: 'COMMENT_FAILED', message: c.error || '',
          campaignId: c.campaignId || '', at: c.at || c.sentAt || c.createdAt || ''
        });
      });
      items.sort((a, b) => (Date.parse(b.at || 0) || 0) - (Date.parse(a.at || 0) || 0));
      return ok(res, {
        items: items.slice(0, 80),
        counts: { total: items.length, task: runs.length, comment: cms.length }
      });
    }
    /* 清空异常记录：只做确认标记，保留失败记录供「重试」使用 */
    if (act === 'exceptions' && seg[3] === 'clear' && req.method === 'POST') {
      const at = new Date().toISOString();
      let tasks = 0;
      collectSched.runs().forEach((r) => {
        if (r && r.status === 'failed' && !r.acknowledgedAt) { r.acknowledgedAt = at; tasks++; }
      });
      if (tasks) store.save(true, 'collect_runs');
      let comments = 0;
      (store.data.collect_comments || []).forEach((c) => {
        if (c && c.status === 'failed' && !c.acknowledgedAt) { c.acknowledgedAt = at; comments++; }
      });
      if (comments) store.save(true, 'collect_comments');
      store.event('info', 'collect.exceptions', '清空异常记录：任务 ' + tasks + ' · 评论 ' + comments);
      return ok(res, { tasks, comments, total: tasks + comments });
    }

    if (act === 'tasks' && !seg[3] && req.method === 'GET') {
      return ok(res, { tasks: collectSched.tasks(), stats: collectSched.stats() });
    }
    if (act === 'tasks' && !seg[3] && req.method === 'POST') {
      const body = await jsonBody(req, 256 * 1024);
      const kw = String(body.keyword || '').trim();
      const target = String(body.target || 'keyword').trim();
      const ref = String(body.ref || '').trim();
      /* 关键词目标必须有关键词；博主/作品/地域目标靠 ref，关键词可空 */
      if (target === 'keyword' && !kw) return fail(res, 400, 'KEYWORD_REQUIRED', '请填写要监听的关键词');
      const dup = collectSched.tasks().filter((t) =>
        (t.target || 'keyword') === target
        && (t.ref || '') === ref
        && t.keyword === (kw || ref)
        && (!body.platform || t.platform === body.platform));
      if (dup.length) return fail(res, 409, 'TASK_EXISTS', '该目标（同一平台）已在监控列表中', { taskId: dup[0].id });
      const r = collectSched.addTask(Object.assign({}, body, { tenant: tenantOf(req) }));
      if (!r.ok) return fail(res, 400, r.error.code, r.error.message);
      return send(res, 201, { ok: true, task: r.task, stats: collectSched.stats() });
    }
    if (act === 'tasks' && seg[3]) {
      const id = seg[3];
      if (req.method === 'GET' && !seg[4]) {
        const t = collectSched.task(id);
        return t ? ok(res, { task: t, runs: collectSched.runsOf(id, 10) }) : fail(res, 404, 'NOT_FOUND', '调度任务不存在');
      }
      if (req.method === 'PATCH' && !seg[4]) {
        const body = await jsonBody(req, 64 * 1024);
        const t = collectSched.updateTask(id, body);
        if (!t) return fail(res, 404, 'NOT_FOUND', '调度任务不存在');
        if (t.error) return fail(res, 400, t.error.code, t.error.message);
        return ok(res, { task: t, stats: collectSched.stats() });
      }
      if (req.method === 'DELETE' && !seg[4]) {
        return collectSched.removeTask(id)
          ? ok(res, { removed: id, stats: collectSched.stats() })
          : fail(res, 404, 'NOT_FOUND', '调度任务不存在');
      }
      /* 手动立即执行一轮（不影响既有排期） */
      if (seg[4] === 'run' && req.method === 'POST') {
        const t = collectSched.task(id);
        if (!t) return fail(res, 404, 'NOT_FOUND', '调度任务不存在');
        if (collectSched.stats().mode === 'unconfigured') {
          return fail(res, 501, 'UPSTREAM_NOT_CONFIGURED',
            '未接入任何采集通道。自有内容评论区请配置 COLLECT_OFFICIAL_URL（+ COLLECT_OFFICIAL_OWNER），'
            + '自建爬虫请配置 COLLECT_CRAWLER_URL，第三方数据服务请配置 COLLECT_UPSTREAM + COLLECT_TOKEN'
            + '（仅本地验证可设 ALLOW_LOCAL_COLLECT=1 走模拟通道）');
        }
        const run = await collectSched.runOnce(t, { manual: true });
        /* ok=200 / skipped=501（未配置）/ empty=502（跑了但没数据）/ 其他=502
           empty 归到 502 是刻意的：它对销售而言是「没拿到名单」，
           前端必须能把它和正常成功区分开。 */
        const code = run.status === 'ok' ? 200 : (run.status === 'skipped' ? 501 : 502);
        return send(res, code, { ok: run.status === 'ok', run, stats: collectSched.stats() });
      }
    }

    if (act === 'runs' && req.method === 'GET') {
      const taskId = String(u.searchParams.get('taskId') || '');
      const limit = Math.max(1, Math.min(200, Number(u.searchParams.get('limit') || 30)));
      return ok(res, { runs: collectSched.runsOf(taskId, limit), stats: collectSched.stats() });
    }

    /* ---- 评论流：三栏页面的中栏数据源 ----
       直接读线索池（已含打分与来源回链），按时间倒序。
       与台账共用同一份数据 —— 「流里有、台账没有」是最伤信任的割裂。 */
    if (act === 'feed' && req.method === 'GET') {
      const limit = Math.max(1, Math.min(200, Number(u.searchParams.get('limit') || 60)));
      const level = String(u.searchParams.get('level') || '');
      const platform = String(u.searchParams.get('platform') || '');
      const taskId = String(u.searchParams.get('taskId') || '');
      const since = Number(u.searchParams.get('since') || 0);
      /* 线索池是 unshift 入池（新的在前），但 upsert 改状态会打乱顺序，
         所以按 created_at 显式排序，别依赖数组顺序 —— 流里出现「旧评论排最前」
         会让人以为采集停了。 */
      const all = collectSched.leads().slice().sort(function (a, b) {
        return (Date.parse(b.created_at || 0) || 0) - (Date.parse(a.created_at || 0) || 0);
      });
      let list = all;
      if (level) list = list.filter((l) => (l.level || 'noise') === level);
      if (platform) list = list.filter((l) => l.platform === platform);
      if (taskId) list = list.filter((l) => l.taskId === taskId);
      if (since) list = list.filter((l) => Date.parse(l.created_at || 0) >= since);
      const st = collectSched.stats();
      return ok(res, {
        items: list.slice(0, limit),
        total: list.length,
        poolTotal: all.length,
        stats: {
          byLevel: st.leadsByLevel,
          byStatus: st.leadsByStatus,
          lastScanAt: st.lastRun ? st.lastRun.at : '',
          lastRun: st.lastRun,
          mode: st.mode,
          tasks: st.tasks,
          enabled: st.enabled,
          nextRunAt: st.nextRunAt,
          concurrency: st.concurrency,
          tickMs: st.tickMs
        }
      });
    }

    if (act === 'leads' && req.method === 'GET') {
      const status = String(u.searchParams.get('status') || '');
      const level = String(u.searchParams.get('level') || '');
      const campaignId = String(u.searchParams.get('campaignId') || '');
      const limit = Math.max(1, Math.min(500, Number(u.searchParams.get('limit') || 100)));
      const all = collectSched.leads().filter((l) =>
        (!status || l.status === status)
        && (!level || (l.level || 'noise') === level)
        && (!campaignId || String(l.campaignId || '') === campaignId));
      return ok(res, {
        total: collectSched.leads().length,
        matched: all.length,
        leads: all.slice(0, limit)
      });
    }

    /* ---- 线索漏斗：作品 → 高意向 → 触达 → 联系/加微/成交 ---- */
    if (act === 'funnel' && req.method === 'GET') {
      const campaignId = String(u.searchParams.get('campaignId') || '');
      const tasks = collectSched.tasks().filter((t) => !campaignId || t.campaignId === campaignId);
      const taskIds = new Set(tasks.map((t) => t.id));
      const leads = collectSched.leads().filter((l) =>
        !campaignId || l.campaignId === campaignId || taskIds.has(l.taskId));
      const notes = (store.data.collect_notes || []).filter((n) =>
        !campaignId || n.campaignId === campaignId || taskIds.has(n.taskId));
      const cmts = (store.data.collect_comments || []).filter((c) =>
        !campaignId || c.campaignId === campaignId);
      const byStatus = {};
      leads.forEach((l) => { byStatus[l.status || 'new'] = (byStatus[l.status || 'new'] || 0) + 1; });
      const countC = (s) => cmts.filter((c) => c.status === s).length;
      return ok(res, {
        campaignId: campaignId,
        works: notes.length,
        high: leads.filter((l) => (l.level || 'noise') === 'high').length,
        leads: leads.length,
        contacted: (byStatus.contacted || 0) + (byStatus.wechat || 0) + (byStatus.won || 0),
        wechat: (byStatus.wechat || 0) + (byStatus.won || 0),
        won: byStatus.won || 0,
        lost: byStatus.lost || 0,
        comments: cmts.length,
        sent: countC('sent'),
        pending: countC('pending'),
        failed: countC('failed'),
        byStatus: byStatus
      });
    }

    /* ---- 作品评论：拟稿 / 排队 / 回执 ----
       这是整套系统里唯一「对外写」的动作：以使用者自己账号在平台公开发言。
       所以服务端强制三道闸门（节奏 45~90s、日限额、重复判定），
       前端只能提交「哪条作品 + 什么话」，改不了节奏。 */
    if (act === 'comments') {
      const key = seg[3] || '';

      if (!key && req.method === 'GET') {
        return ok(res, collectComments.list({
          limit: u.searchParams.get('limit'),
          platform: u.searchParams.get('platform'),
          status: u.searchParams.get('status'),
          campaignId: u.searchParams.get('campaignId')
        }));
      }
      /* 自动评论全局暂停键：已排队的任务保留，只是不再让扩展领取 */
      if (key === 'queue' && req.method === 'GET') {
        return ok(res, { paused: deviceHub.isPaused('comment'), pending: deviceHub.pendingKind('comment') });
      }
      if (key === 'pause' && req.method === 'POST') {
        const body = await jsonBody(req, 8 * 1024);
        const paused = deviceHub.pauseKind('comment', !!body.paused);
        store.event('info', 'collect.comments', paused ? '自动评论已暂停' : '自动评论已继续');
        return ok(res, { paused, pending: deviceHub.pendingKind('comment') });
      }
      if (key === 'clear' && req.method === 'POST') {
        const cleared = collectComments.clearPending();
        const clearedLikes = collectLikes.clearPending();
        const jobs = deviceHub.cancelPending('comment') + deviceHub.cancelPending('like');
        store.event('info', 'collect.comments', '手动清空排队：评论 ' + cleared + ' 条 · 点赞 ' + clearedLikes + ' 条');
        return ok(res, { cleared, clearedLikes, jobs, pending: deviceHub.pendingKind('comment'), likesPending: deviceHub.pendingKind('like') });
      }
      if (key === 'draft' && req.method === 'POST') {
        const body = await jsonBody(req, 64 * 1024);
        const r = await collectComments.draft(body);
        return ok(res, r);
      }
      if (key === 'batch' && req.method === 'POST') {
        const body = await jsonBody(req, 256 * 1024);
        const r = await collectComments.batch(body);
        if (r.error && !r.queued.length) return fail(res, 400, r.error.code, r.error.message);
        return send(res, 201, { ok: true, queued: r.queued, skipped: r.skipped, today: r.today, cap: r.cap });
      }
      if (!key && req.method === 'POST') {
        const body = await jsonBody(req, 64 * 1024);
        /* 没配采集器就直接说清楚：评论必须由本机浏览器带着登录态发出去 */
        if (!deviceHub.ready()) {
          return fail(res, 409, 'NO_DEVICE',
            '浏览器采集器不在线：评论要由你本机的 Chrome 发出，请先启动本机采集器并连接');
        }
        const r = collectComments.create(body);
        if (r.error) return fail(res, r.error.code === 'DAILY_CAP' ? 429 : 409, r.error.code, r.error.message, r.error.comment || {});
        return send(res, 201, { ok: true, comment: r.comment, job: r.job });
      }
      if (key && seg[4] === 'retry' && req.method === 'POST') {
        const r = collectComments.retry(decodeURIComponent(key));
        if (r.error) return fail(res, 409, r.error.code, r.error.message);
        return send(res, 201, { ok: true, comment: r.comment, job: r.job });
      }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的评论操作');
    }

    /* ---- 作品点赞：比评论轻，但同样排队 + 限速 + 去重 ----
       点赞和评论共用采集端队列（一次只干一个），所以不会互相打架；
       前端卡片上「点赞」是一个独立动作，也可以在评论抽屉里勾「同时点赞」。 */
    if (act === 'likes') {
      const key = seg[3] || '';
      if (!key && req.method === 'GET') {
        return ok(res, collectLikes.list({
          limit: u.searchParams.get('limit'),
          platform: u.searchParams.get('platform')
        }));
      }
      if (key && seg[4] === 'retry' && req.method === 'POST') {
        const r = collectLikes.retry(decodeURIComponent(key));
        if (r.error) return fail(res, 409, r.error.code, r.error.message);
        return send(res, 201, { ok: true, like: r.like, job: r.job });
      }
      if (!key && req.method === 'POST') {
        const body = await jsonBody(req, 32 * 1024);
        if (!deviceHub.ready()) {
          return fail(res, 409, 'NO_DEVICE', '浏览器采集器不在线：点赞要由你本机的 Chrome 点，请先连接本机采集器');
        }
        const r = collectLikes.create(body);
        if (r.error) return fail(res, r.error.code === 'DAILY_CAP' ? 429 : 409, r.error.code, r.error.message, r.error.like || {});
        return send(res, 201, { ok: true, like: r.like, job: r.job });
      }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的点赞操作');
    }

    /* ---- 作品池 / 排队一键清空 ----
       清作品时连带清它对应的线索，否则作品池会从线索兜底聚合又冒出来。 */
    if (act === 'notes' && seg[3] === 'clear' && req.method === 'POST') {
      const body = await jsonBody(req, 16 * 1024);
      const cid = String(body.campaignId || '');
      /* 只清作品不暂停，运行中的战役会立刻又采一批回来；
         所以默认先暂停目标战役，再清池，保证页面真的能归零。 */
      let paused = 0;
      if (body.pause !== false) {
        const targets = cid ? [collectCampaigns.get(cid)].filter(Boolean) : collectCampaigns.list();
        targets.forEach((c) => {
          if (c && c.status === 'running') { collectCampaigns.pause(c.id); paused++; }
        });
      }
      const notes = (store.data.collect_notes || []);
      const leads = (store.data.collect_leads || []);
      const keepNotes = cid ? notes.filter((n) => String(n.campaignId || '') !== cid) : [];
      const keepLeads = cid ? leads.filter((l) => String(l.campaignId || '') !== cid) : [];
      const works = notes.length - keepNotes.length;
      const leadCount = leads.length - keepLeads.length;
      store.data.collect_notes = keepNotes;
      store.data.collect_leads = keepLeads;
      store.save(true, 'collect_notes');
      store.save(true, 'collect_leads');
      const cleared = collectComments.clearPending(cid);
      const clearedLikes = collectLikes.clearPending(cid);
      const jobs = deviceHub.cancelPending('comment', cid) + deviceHub.cancelPending('like', cid);
      store.event('info', 'collect.notes', '清空作品池：作品 ' + works + ' · 线索 ' + leadCount
        + ' · 评论排队 ' + cleared + ' · 点赞排队 ' + clearedLikes + ' · 暂停战役 ' + paused);
      return ok(res, { works, leads: leadCount, cleared, clearedLikes, jobs, paused, pending: deviceHub.pendingKind('comment') });
    }

    /* ---- 搜到的作品：中栏「作品」卡片数据源 ----
       上游是桥的 /v1/notes（作品索引：标题/链接/作者/封面/互动数），
       再合并本池线索统计（每作品采到多少评论、多少高意向）。
       桥不可用或未配置 crawler 时，回退为「从线索池聚合出作品」，
       保证卡片视图永远有内容 —— 线索本来就带 video_url。 */
    if (act === 'notes' && req.method === 'GET') {
      const limit = Math.max(1, Math.min(800, Number(u.searchParams.get('limit') || 40)));
      const platform = String(u.searchParams.get('platform') || '');
      const campaignId = String(u.searchParams.get('campaignId') || '');
      const leads = collectSched.leads();
      /* 本池统计：按 video_url 聚合（线索级） */
      const byUrl = {};
      for (const l of leads) {
        const k = String(l.video_url || '');
        if (!k) continue;
        const b = byUrl[k] || (byUrl[k] = { comments: 0, high: 0 });
        b.comments++;
        if ((l.level || 'noise') === 'high') b.high++;
      }
      let source = 'plugin';
      let notesArr = [];
      /* 1) 本地采集器回传的作品索引（最准：标题/封面/互动数都是页面上读到的） */
      const stored = (store.data.collect_notes || [])
        .filter((n) => n && (n.url || n.note_id)
          && (!platform || String(n.platform || '') === platform)
          && (!campaignId || String(n.campaignId || '') === campaignId))
        .sort((a, b) => Date.parse(b.updatedAt || b.at || 0) - Date.parse(a.updatedAt || a.at || 0));
      if (stored.length) {
        notesArr = stored.slice(0, limit).map((n) => ({
          note_id: n.note_id || '', title: n.title || '', url: n.url || '',
          author: n.author || '', keyword: n.keyword || '', platform: n.platform || '',
          cover: n.cover || '', publishAt: n.publishAt || '',
          liked: n.liked || 0, comments: n.comments || 0, collected: n.collected || 0,
          deviceId: n.deviceId || '', campaignId: n.campaignId || '',
          updatedAt: n.updatedAt || n.at || ''
        }));
      }
      /* 2) 没装采集器（或它还没跑过）时，退回桥的作品索引 */
      if (!notesArr.length && u.searchParams.get('cleared') !== '1') {
        source = 'upstream';
        try {
          const registry = require('./collect-adapters/registry');
          const base = registry.urlOf('crawler');
          if (base && registry.configured('crawler')) {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), registry.timeoutOf('crawler'));
            const r = await fetch(base + '/v1/notes?limit=' + limit
              + (platform ? '&platform=' + encodeURIComponent(platform) : ''), { signal: ctl.signal });
            clearTimeout(timer);
            const j = await r.json().catch(() => null);
            if (j && j.ok && Array.isArray(j.notes)) notesArr = j.notes;
          }
        } catch (e) { /* 回退到线索聚合 */ }
      }
      if (!notesArr.length && u.searchParams.get('cleared') !== '1') {
        source = 'pool';
        const seen = {};
        for (const l of leads.slice().sort((a, b) =>
          (Date.parse(b.created_at || 0) || 0) - (Date.parse(a.created_at || 0) || 0))) {
          const k = String(l.video_url || '');
          if (!k || seen[k]) continue;
          seen[k] = true;
          notesArr.push({
            note_id: String(l.cid || ''),
            title: String(l.video_title || ''),
            url: k,
            author: String(l.author || ''),
            keyword: String(l.keyword || ''),
            platform: String(l.platform || ''),
            cover: '',
            publishAt: '',
            liked: 0, comments: 0, collected: 0,
            campaignId: String(l.campaignId || ''),
            commentCount: byUrl[k] ? byUrl[k].comments : 0,
            highCount: byUrl[k] ? byUrl[k].high : 0
          });
          if (notesArr.length >= limit) break;
        }
      } else {
        for (const n of notesArr) {
          const b = byUrl[String(n.url || '')];
          n.highCount = b ? b.high : 0;
          /* 采到多少条评论以本池为准（作品在平台上总共多少条是另一个字段 comments） */
          n.commentCount = b ? b.comments : (n.commentCount || 0);
        }
      }
      return ok(res, { ok: true, source, total: notesArr.length, notes: notesArr });
    }
    if (act === 'leads' && seg[3] && seg[4] === 'status' && req.method === 'POST') {
      const body = await jsonBody(req, 32 * 1024);
      const l = collectSched.leads().filter((x) => x.id === seg[3])[0];
      if (!l) return fail(res, 404, 'NOT_FOUND', '线索不存在');
      /* K5：只接受一套状态词表（new/contacted/wechat/won/lost）。
         前端历史版本发的是 sent/nego/deal/sleep，这里做一次归一，
         原文保留在 statusRaw，方便回滚与排查；真正的错值直接 400。 */
      const raw = String(body.status || 'new').slice(0, 16);
      const ALIAS = { sent: 'contacted', nego: 'contacted', deal: 'won', sleep: 'lost' };
      const canonical = ALIAS[raw] || raw;
      const VALID = ['new', 'contacted', 'wechat', 'won', 'lost'];
      if (VALID.indexOf(canonical) < 0) {
        return fail(res, 400, 'INVALID_STATUS', '未知线索状态：' + raw + '（可用：' + VALID.join('/') + '）');
      }
      if (canonical !== raw) l.statusRaw = raw;
      l.status = canonical;
      l.statusAt = new Date().toISOString();
      if (body.note != null) l.note = String(body.note).slice(0, 200);
      /* K4：线索是 NDJSON 表，改字段需写一条新版本（后写覆盖），否则重启丢失 */
      collectSched.store.upsert('collect_leads', l);
      return ok(res, { lead: l });
    }

    /* 调度巡检：手动踢一次 tick，便于本地验证与运维排障 */
    if (act === 'tick' && req.method === 'POST') {
      const n = await collectSched.tick();
      return ok(res, { executed: n, stats: collectSched.stats() });
    }

    return fail(res, 404, 'NOT_FOUND', '未知的采集调度接口：' + p);
  }

  // ---- 订单与套餐（计费） ----
  const bTenant = tenantOf(req);

  if (p === '/v1/plans' && req.method === 'GET') {
    return ok(res, {
      plans: billing.listPlans(),
      packs: billing.listPacks(),
      cycles: billing.cycles ? billing.cycles() : [],
      provider: billing.providerId
    });
  }
  if (p === '/v1/billing/summary' && req.method === 'GET') {
    return ok(res, billing.summary(bTenant));
  }
  if (p === '/v1/billing/health' && req.method === 'GET') {
    return ok(res, Object.assign(billing.health(), { stats: billing.stats() }));
  }
  if (p === '/v1/billing/ledger' && req.method === 'GET') {
    const rows = billing.ledgerRows().filter((x) => x.tenant === bTenant).slice(0, 100);
    return ok(res, { ledger: rows });
  }
  if (p === '/v1/billing/trial' && req.method === 'POST') {
    const r = billing.startTrial(bTenant);
    if (!r.ok) return fail(res, 400, r.code, r.message);
    return send(res, 201, { ok: true, subscription: r.subscription, summary: billing.summary(bTenant) });
  }
  if (p === '/v1/billing/orders' && req.method === 'POST') {
    const raw = await readBody(req, 1024 * 1024);
    let body = {};
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch (e) {}
    const r = await billing.create(body, bTenant);
    if (!r.ok) return fail(res, 400, r.code, r.message);
    return send(res, r.reused ? 200 : 201, { ok: true, reused: r.reused, order: r.order, payUrl: r.order.payUrl, payment: r.order.payment });
  }
  if (seg[0] === 'v1' && seg[1] === 'billing' && seg[2] === 'orders' && seg[3] && seg[4] === 'pay' && req.method === 'POST') {
    /* 主动确认到账：仅 mock 通道可自助，manual 需人工，wechat 走回调 */
    const o = billing.get(seg[3]);
    if (!o.ok) return fail(res, 404, o.code, o.message);
    const mode = (o.order.payment && o.order.payment.payMode) || billing.providerId;
    if (mode === 'wechat') {
      return fail(res, 400, 'USE_NOTIFY', '微信支付请等待异步回调，不能在此直接确认');
    }
    const r = billing.markPaid(seg[3], { channel: mode, transactionId: 'manual-' + Date.now() });
    if (!r.ok) return fail(res, 400, r.code, r.message);
    return ok(res, { ok: true, order: r.order, summary: billing.summary(bTenant) });
  }
  if (seg[0] === 'v1' && seg[1] === 'billing' && seg[2] === 'orders' && seg[3] && req.method === 'GET') {
    const r = billing.get(seg[3]);
    return r.ok ? ok(res, { order: r.order, payUrl: r.order.payUrl, payment: r.order.payment }) : fail(res, 404, r.code, r.message);
  }
  if (p === '/v1/billing/notify' && req.method === 'POST') {
    /* 验签必须用原始报文，不能先 JSON.parse 再序列化 */
    const raw = await readBody(req, 1024 * 1024);
    const rawText = raw.toString('utf8');
    let body = {};
    try { body = rawText.length ? JSON.parse(rawText) : {}; } catch (e) {}
    const r = billing.notify(body, req.headers, rawText);
    return r.ok ? ok(res, r) : fail(res, 400, r.code, r.message);
  }

  // ---- GEO（生成式引擎优化）AI 关键词监测 ----
  if (seg[0] === 'v1' && seg[1] === 'geo') {
    const act = seg[2] || '';

    /* K9 暂缓：v1 写接口仍被「兼容层 + 项目用例」使用（api.test.js 明确断言
       PATCH /v1/geo/tasks/:id 生效），直接 410 会打断回归。
       下线前必须先做两件事：① 08-geo3.js 的 addTask 兼容层迁到 /v1/geo2；
       ② 用例改成断言 410。本轮只加弃用标记，不改行为。 */
    if (req.method !== 'GET') res.setHeader('X-Deprecated-Api', '/v1/geo -> /v1/geo2');

    if (act === 'config' && req.method === 'GET') {
      return ok(res, {
        engines: geo.ENGINE_LIST,
        intervals: Object.keys(geo.INTERVAL),
        stats: geoSched.stats(),
        upstream: await geo.upstreamHealth()
      });
    }

    if (act === 'stream' && req.method === 'GET') {
      return geoSched.subscribe(res, req);
    }

    if (act === 'tasks' && !seg[3] && req.method === 'GET') {
      return ok(res, { tasks: geoSched.tasks(), stats: geoSched.stats() });
    }
    if (act === 'tasks' && !seg[3] && req.method === 'POST') {
      const body = await jsonBody(req, 256 * 1024);
      const kw = String(body.keyword || '').trim();
      if (!kw) return fail(res, 400, 'KEYWORD_REQUIRED', '请填写要监测的关键词');
      if (geoSched.tasks().filter((t) => t.keyword === kw).length) return fail(res, 409, 'TASK_EXISTS', '该关键词已在监测列表中');
      return send(res, 201, { ok: true, task: geoSched.addTask(Object.assign({}, body, { tenant: tenantOf(req) })) });
    }
    if (act === 'tasks' && seg[3]) {
      const id = seg[3];
      if (req.method === 'PATCH') {
        const body = await jsonBody(req, 64 * 1024);
        const t = geoSched.updateTask(id, body);
        if (!t) return fail(res, 404, 'NOT_FOUND', '监测任务不存在');
        geoSched.broadcastStats();
        return ok(res, { task: t });
      }
      if (req.method === 'DELETE') {
        return geoSched.removeTask(id) ? ok(res, { removed: id }) : fail(res, 404, 'NOT_FOUND', '监测任务不存在');
      }
      if (req.method === 'GET') {
        const t = geoSched.task(id);
        return t ? ok(res, { task: t }) : fail(res, 404, 'NOT_FOUND', '监测任务不存在');
      }
    }

    if (act === 'monitor' && req.method === 'POST') {
      const body = await jsonBody(req, 256 * 1024);
      const task = body.taskId ? geoSched.task(body.taskId) : null;
      const kw = String(body.keyword || (task && task.keyword) || '').trim();
      if (!kw) return fail(res, 400, 'KEYWORD_REQUIRED', '请提供 keyword 或 taskId');
      const engines = (body.engines && body.engines.length)
        ? body.engines.filter((e) => geo.ENGINE_IDS.indexOf(e) > -1)
        : ((task && task.engines) || geo.ENGINE_IDS.slice());
      /* K1：带上请求租户——runOnce 优先用任务自己的 tenant，任务不存在时用这个 */
      const r = await geoSched.runOnce(kw, engines.length ? engines : geo.ENGINE_IDS.slice(), { taskId: (task && task.id) || '', tenant: tenantOf(req) });
      if (!r.ok) return send(res, r.status || 502, { ok: false, code: r.code, message: r.message,
        hint: r.code === 'UPSTREAM_NOT_CONFIGURED' ? '配置 GEO_UPSTREAM 与 GEO_TOKEN，或设置 ALLOW_LOCAL_GEO=1 启用本地模拟监测' : '' });
      return ok(res, { run: r.run, stats: geoSched.stats() });
    }

    /* 路径C：人工录入通道（透镜GEO免费版看到的真实结论直接落盘，不调任何上游） */
    if (act === 'manual' && req.method === 'POST') {
      const body = await jsonBody(req, 256 * 1024);
      const kw = String(body.keyword || '').trim();
      if (!kw) return fail(res, 400, 'KEYWORD_REQUIRED', '请提供 keyword');
      const raw = Array.isArray(body.results) ? body.results : [];
      if (!raw.length) return fail(res, 400, 'RESULTS_REQUIRED', '请提供 results 数组');
      const results = [];
      for (const r of raw) {
        const eid = String(r.engine || r.id || '');
        if (geo.ENGINE_IDS.indexOf(eid) < 0) return fail(res, 400, 'BAD_ENGINE', '未知引擎：' + eid);
        const rank = Math.max(0, Math.min(50, Math.floor(Number(r.rank || 0) || 0)));
        results.push({
          engine: eid,
          rank,
          status: r.status || geo.statusOf(rank),
          snippet: String(r.snippet || r.quote || '').slice(0, 200),
          cited: !!(r.cited || r.mentioned),
          at: r.at || new Date().toISOString()
        });
      }
      const task = body.taskId ? geoSched.task(body.taskId) : null;
      const r = await geoSched.runOnce(kw, results.map((x) => x.engine), { manual: true, results, taskId: (task && task.id) || '', tenant: tenantOf(req) });
      if (!r.ok) return send(res, r.status || 502, { ok: false, code: r.code, message: r.message });
      geoSched.broadcastStats();
      return ok(res, { run: r.run, stats: geoSched.stats() });
    }

    if (act === 'runs' && req.method === 'GET') {
      return ok(res, { runs: geoSched.runs().slice(0, Number(u.searchParams.get('limit') || 30)) });
    }
    if (act === 'changes' && req.method === 'GET') {
      return ok(res, { changes: geoSched.changes().slice(0, Number(u.searchParams.get('limit') || 50)) });
    }
    if (act === 'history' && req.method === 'GET') {
      const kw = String(u.searchParams.get('keyword') || '');
      const eng = String(u.searchParams.get('engine') || '');
      const days = Math.max(1, Math.min(90, Number(u.searchParams.get('days') || 30)));
      const from = Date.now() - days * 86400000;
      const pts = geoSched.points().filter((p) =>
        (!kw || p.keyword === kw) && (!eng || p.engine === eng) && p.at >= from);
      pts.sort((a, b) => a.at - b.at);
      return ok(res, { keyword: kw, engine: eng, days, points: pts });
    }
    if (act === 'overview' && req.method === 'GET') {
      const tasks = geoSched.tasks();
      const runs = geoSched.runs();
      const lastRun = runs[0] || null;
      const covered = lastRun ? lastRun.results.filter((r) => r.rank > 0).length : 0;
      const total = lastRun ? lastRun.results.length : 0;
      return ok(res, {
        stats: geoSched.stats(),
        keywords: tasks.length,
        monitored: tasks.filter((t) => t.enabled).length,
        lastRun: lastRun ? { id: lastRun.id, keyword: lastRun.keyword, at: lastRun.startedAt, covered: lastRun.covered, total: lastRun.results.length, source: lastRun.source } : null,
        coverageRate: total ? Math.round(covered / total * 100) : 0,
        changes: geoSched.changes().slice(0, 10)
      });
    }
    if (act === 'plan' && req.method === 'POST') {
      const body = await jsonBody(req, 128 * 1024);
      return ok(res, { keyword: String(body.keyword || '').trim(), plan: geo.buildPlan(body.keyword) });
    }

    return fail(res, 404, 'NOT_FOUND', '未知的 GEO 接口：' + p);
  }

  // ---- GEO 控制台 v3（11 模块：仪表盘/身份/词库/创作/站点/分发/探针/报告/质检/客户/设置） ----
  if (seg[0] === 'v1' && seg[1] === 'geo2') {
    const act = seg[2] || '';
    const sub = seg[3] || '';
    const sub2 = seg[4] || '';

    /* 1 仪表盘 */
    if (act === 'dashboard' && req.method === 'GET') {
      const uq = new URL(req.url, 'http://127.0.0.1');
      return ok(res, geoConsole.dashboard(uq.searchParams.get('days')));
    }
    if (act === 'demo') {
      if (sub === 'seed' && req.method === 'POST') return ok(res, geoConsole.seedDemo());
      if (sub === 'seed' && req.method === 'DELETE') return ok(res, geoConsole.clearDemo());
    }

    /* 2 企业身份 */
    if (act === 'org') {
      if (sub === 'kb' && req.method === 'POST') {
        const b = await jsonBody(req, 512 * 1024);
        const r = geoConsole.addKb(b || {});
        return r.ok ? ok(res, { item: r.item }) : fail(res, 400, 'KB_EMPTY', r.message);
      }
      if (sub === 'kb' && sub2 && req.method === 'DELETE') {
        return geoConsole.delKb(sub2) ? ok(res, { removed: sub2 }) : fail(res, 404, 'NOT_FOUND', '资料不存在');
      }
      if (sub === 'consistency' && req.method === 'GET') return ok(res, geoConsole.consistency());
      if (!sub && req.method === 'GET') return ok(res, geoConsole.orgBundle());
      if (!sub && req.method === 'POST') {
        const b = await jsonBody(req, 256 * 1024);
        return ok(res, { org: geoEngine.saveOrg(b || {}) });
      }
    }

    /* 3 词库 / 话题包 */
    if (act === 'packs') {
      if (!sub && req.method === 'GET') return ok(res, { packs: geoConsole.packsView(), zones: geoConsoleMod.ZONE_LABEL });
      if (!sub && req.method === 'POST') {
        const b = await jsonBody(req, 1024 * 1024);
        const r = geoEngine.importPack(b.name, b.text);
        return r.ok ? send(res, 201, { ok: true, pack: r.pack }) : fail(res, 400, 'PACK_EMPTY', r.message);
      }
      if (sub && !sub2 && req.method === 'DELETE') {
        return geoEngine.removePack(sub) ? ok(res, { removed: sub }) : fail(res, 404, 'NOT_FOUND', '词包不存在');
      }
      if (sub && sub2 === 'toggle' && req.method === 'POST') {
        const b = await jsonBody(req, 16 * 1024).catch(() => ({}));
        return ok(res, geoConsole.togglePack(sub, !(b && b.off)));
      }
      if (sub && sub2 === 'copy' && req.method === 'POST') {
        const r = geoConsole.copyPack(sub);
        return r.ok ? send(res, 201, { ok: true, pack: r.pack }) : fail(res, 404, 'NOT_FOUND', r.message);
      }
    }
    if (act === 'words' && sub === 'trend' && req.method === 'GET') {
      const uq = new URL(req.url, 'http://127.0.0.1');
      return ok(res, { word: uq.searchParams.get('word') || '', trend: geoConsole.wordTrend(uq.searchParams.get('word') || '', uq.searchParams.get('days')) });
    }

    /* 4 内容创作中心 */
    if (act === 'assets') {
      if (!sub && req.method === 'GET') return ok(res, { assets: geoEngine.assets().slice(0, 200) });
      if (!sub && req.method === 'POST') {
        const b = await jsonBody(req, 128 * 1024);
        const word = String(b.word || '').trim();
        if (!word) return fail(res, 400, 'WORD_REQUIRED', '请提供关键词');
        const asset = await geoEngine.generateAsset(word, b.style);
        return ok(res, { asset, fromLLM: !!(asset.meta && asset.meta.fromLLM), llmErr: (asset.meta && asset.meta.llmErr) || '' });
      }
      if (sub && !sub2 && req.method === 'GET') {
        const a = geoEngine.asset(sub);
        return a ? ok(res, { asset: a }) : fail(res, 404, 'NOT_FOUND', '资产不存在');
      }
      if (sub && sub2 === 'audit' && req.method === 'POST') {
        const b = await jsonBody(req, 64 * 1024).catch(() => ({}));
        const r = geoEngine.auditAsset(sub, !!(b && b.pass), (b && b.note) || '');
        return r.ok ? ok(res, r) : fail(res, 400, 'AUDIT_FAIL', r.message);
      }
      if (sub && sub2 === 'variants' && req.method === 'POST') {
        const b = await jsonBody(req, 32 * 1024).catch(() => ({}));
        const r = geoConsole.variants(sub, b && b.count);
        return r.ok ? ok(res, { variants: r.variants }) : fail(res, 404, 'NOT_FOUND', r.message);
      }
      if (sub && sub2 === 'preview' && req.method === 'GET') return ok(res, geoConsole.preview(sub));
      if (sub && sub2 === 'rewrite' && req.method === 'POST') {
        const b = await jsonBody(req, 128 * 1024).catch(() => ({}));
        const r = await geoEngine.rewriteAsset(sub, b && b.sources);
        return r.ok ? ok(res, r) : fail(res, 400, 'REWRITE_FAIL', r.message);
      }
    }

    /* 5 站点矩阵 */
    if (act === 'sites') {
      if (!sub && req.method === 'GET') return ok(res, { sites: geoConsole.sites() });
      if (!sub && req.method === 'POST') {
        const b = await jsonBody(req, 64 * 1024);
        const r = geoConsole.addSite(b || {});
        return r.ok ? send(res, 201, { ok: true, site: r.site }) : fail(res, 400, 'SITE_INVALID', r.message);
      }
      if (sub && !sub2 && (req.method === 'PATCH' || req.method === 'PUT')) {
        const b = await jsonBody(req, 64 * 1024).catch(() => ({}));
        const r = geoConsole.updateSite(sub, b || {});
        return r.ok ? ok(res, r) : fail(res, 404, 'NOT_FOUND', r.message);
      }
      if (sub && !sub2 && req.method === 'DELETE') {
        return geoConsole.delSite(sub) ? ok(res, { removed: sub }) : fail(res, 404, 'NOT_FOUND', '站点不存在');
      }
      if (sub && sub2 === 'check' && req.method === 'POST') return ok(res, await geoConsole.checkSite(sub));
    }

    /* 6 全域渠道分发 */
    if (act === 'channels') {
      if (!sub && req.method === 'GET') return ok(res, { channels: geoConsole.channels() });
      if (!sub && req.method === 'POST') {
        const b = await jsonBody(req, 64 * 1024);
        return send(res, 201, { ok: true, channel: geoConsole.addChannel(b || {}) });
      }
      if (sub && sub2 === 'authed' && req.method === 'POST') {
        const b = await jsonBody(req, 16 * 1024).catch(() => ({}));
        const r = geoConsole.authChannel(sub, b && b.on !== false);
        return r.ok ? ok(res, r) : fail(res, 404, 'NOT_FOUND', r.message);
      }
      if (sub && !sub2 && req.method === 'DELETE') {
        return geoConsole.delChannel(sub) ? ok(res, { removed: sub }) : fail(res, 404, 'NOT_FOUND', '渠道不存在');
      }
    }
    if (act === 'pubq' && req.method === 'GET') return ok(res, { queue: geoConsole.pubq().slice(0, 200), stats: geoConsole.publishStats ? geoConsole.publishStats() : {} });
    if (act === 'publish' && req.method === 'POST') {
      const b = await jsonBody(req, 128 * 1024);
      const r = geoConsole.publish(b.assetId, b.targets, b.scheduledAt);
      return r.ok ? ok(res, r) : fail(res, 400, 'PUBLISH_FAIL', r.message);
    }
    if (act === 'pubq' && sub && sub2 === 'retry' && req.method === 'POST') {
      const r = geoConsole.retryPublish(sub);
      return r.ok ? ok(res, r) : fail(res, 404, 'NOT_FOUND', r.message);
    }

    /* 7 探针采集 */
    if (act === 'probes') {
      if (sub === 'run' && req.method === 'POST') {
        const b = await jsonBody(req, 16 * 1024);
        const word = String(b.word || '').trim();
        if (!word) return fail(res, 400, 'WORD_REQUIRED', '请提供问句');
        const r = await geoConsole.runProbe(word, tenantOf(req));
        if (!r.ok) return send(res, r.status || 502, { ok: false, code: r.code || 'PROBE_FAIL', message: r.message || '探针未接入' });
        return ok(res, { run: r.run });
      }
      if (!sub && req.method === 'GET') return ok(res, geoConsole.probes());
    }
    if (act === 'snapshots') {
      if (!sub && req.method === 'GET') {
        const uq = new URL(req.url, 'http://127.0.0.1');
        return ok(res, geoConsole.snapshots({
          q: uq.searchParams.get('q') || '',
          model: uq.searchParams.get('model') || '',
          limit: uq.searchParams.get('limit')
        }));
      }
      if (sub && req.method === 'GET') {
        const one = geoConsole.snaps().filter(s => s.id === sub)[0];
        return one ? ok(res, { snapshot: one }) : fail(res, 404, 'NOT_FOUND', '快照不存在');
      }
    }

    /* 8 报告中心 */
    if (act === 'reports') {
      if (sub === 'kinds' && req.method === 'GET') return ok(res, { kinds: geoConsole.reportKinds() });
      if (!sub && req.method === 'GET') return ok(res, { reports: geoEngine.reports().slice(0, 60), kinds: geoConsole.reportKinds() });
      if (!sub && req.method === 'POST') {
        const b = await jsonBody(req, 64 * 1024).catch(() => ({}));
        return ok(res, { report: geoConsole.buildReport(b && b.kind, b || {}) });
      }
      if (sub && sub2 === 'csv' && req.method === 'GET') {
        const csv = geoConsole.reportCsv(sub);
        if (!csv) return fail(res, 404, 'NOT_FOUND', '报告不存在');
        return send(res, 200, '\ufeff' + csv, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="geo-report-' + sub + '.csv"'
        });
      }
    }

    /* 9 页面诊断质检 */
    if (act === 'diag') {
      if (req.method === 'POST') {
        const b = await jsonBody(req, 2 * 1024 * 1024);
        const r = await geoConsole.diag(b || {});
        return r.ok ? ok(res, { result: r.result }) : fail(res, 400, 'DIAG_FAIL', r.message);
      }
      if (req.method === 'GET') return ok(res, { history: geoConsole.diags().slice(0, 50), rules: geoConsoleMod.DIAG_RULES });
    }

    /* 10 客户 & 权限 */
    if (act === 'tenants') {
      if (!sub && req.method === 'GET') return ok(res, { tenants: geoConsole.tenants() });
      if (!sub && req.method === 'POST') {
        const b = await jsonBody(req, 64 * 1024);
        return send(res, 201, { ok: true, tenant: geoConsole.addTenant(b || {}) });
      }
      if (sub && sub2 === 'subs' && req.method === 'POST') {
        const b = await jsonBody(req, 32 * 1024).catch(() => ({}));
        const r = geoConsole.addSub(sub, b || {});
        return r.ok ? ok(res, r) : fail(res, 404, 'NOT_FOUND', r.message);
      }
      if (sub && !sub2 && req.method === 'DELETE') {
        return geoConsole.delTenant(sub) ? ok(res, { removed: sub }) : fail(res, 404, 'NOT_FOUND', '客户不存在');
      }
    }

    /* 11 系统设置 */
    if (act === 'settings') {
      if (req.method === 'GET') return ok(res, geoConsole.getSettings());
      if (req.method === 'POST') {
        const b = await jsonBody(req, 64 * 1024);
        return ok(res, { settings: geoConsole.saveSettings(b || {}) });
      }
    }

    /* 模型网关（OpenAI 兼容，脱敏返回） */
    if (act === 'llm') {
      if (req.method === 'GET') {
        const c = llmConfig.resolve(store, 'geo') || llmConfig.resolve(store, '');
        return ok(res, {
          enabled: !!c, provider: (c && c.provider) || '', model: (c && c.model) || '',
          baseUrl: (c && c.base_url) || '', name: (c && c.name) || '', source: (c && c.source) || ''
        });
      }
      if (req.method === 'POST') {
        const b = await jsonBody(req, 32 * 1024);
        const r = llmConfig.saveLegacy(store, b || {});
        if (r.error) return fail(res, 400, r.error.code, r.error.message);
        const c = llmConfig.resolve(store, 'geo') || llmConfig.resolve(store, '');
        return ok(res, { enabled: !!c, model: (c && c.model) || '' });
      }
    }

    return fail(res, 404, 'NOT_FOUND', '未知的 GEO 控制台接口：' + p);
  }

  // ---- GEO 优化引擎 v2（/v1/geop）已于 R4 下线 ----
  /* 三代 GEO 接口并存时，v3（/v1/geop）只有已归档的旧控制台在用；
     前端自改造起全部走 /v1/geo2。这里保留 410（Gone）+ 迁移提示，
     让老脚本能区分「接口下线」和「服务没起来」。
     注意：数据层 geo-console.js 仍被 /v1/geo2 使用，没有删。 */
  if (seg[0] === 'v1' && seg[1] === 'geop') {
    return fail(res, 410, 'GONE', '/v1/geop/* 已下线，请改用 /v1/geo2/*（同一套九级管线与数据）', {
      replacement: '/v1/geo2'
    });
  }

  // ---- 运行事件 ----
  if (p === '/v1/events' && req.method === 'GET') {
    const wantsStream = /text\/event-stream/i.test(String(req.headers.accept || ''))
      || u.searchParams.get('stream') === '1';
    if (wantsStream) return sseAttach(req, res, u);      /* K5：长连接推送 */
    return ok(res, {
      events: store.data.events.slice(0, Number(u.searchParams.get('limit') || 50)),
      stream: '/v1/events?stream=1'
    });
  }

  /* ---- 前端自动化测试报告回收（仅 QA_MODE=1 时启用，生产默认关闭） ---- */
  if (process.env.QA_MODE === '1' && p === '/v1/qa/report') {
    const file = path.join(DATA_DIR, 'front-report.json');
    if (req.method === 'POST') {
      const raw = await readBody(req, 8 * 1024 * 1024);
      fs.writeFileSync(file, raw.toString('utf8'), 'utf8');
      return ok(res, { saved: raw.length });
    }
    if (req.method === 'GET') {
      if (!fs.existsSync(file)) return fail(res, 404, 'NO_REPORT', '尚未收到测试报告');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': fs.statSync(file).size });
      return fs.createReadStream(file).pipe(res);
    }
  }

  return fail(res, 404, 'NO_ROUTE', `未知接口：${req.method} ${p}`);
}

const server = http.createServer((req, res) => {
  /* K11：请求级指标（finish 时记账，不影响响应路径） */
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    try {
      METRICS.total++;
      const code = res.statusCode || 0;
      METRICS.byStatus[code] = (METRICS.byStatus[code] || 0) + 1;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      METRICS.dur.push(Math.round(ms));
      if (METRICS.dur.length > 500) METRICS.dur.shift();
    } catch (e) {}
  });
  handle(req, res).catch((e) => {
    const code = e && e.code;
    store.event('error', 'server', String((e && e.message) || e));
    if (code === 'TOO_LARGE') return fail(res, 413, 'TOO_LARGE', String(e.message));
    try { fail(res, 500, 'SERVER_ERROR', String((e && e.stack) || e).slice(0, 400)); } catch (e2) {}
  });
});

server.requestTimeout = 0;
server.headersTimeout = 0;

async function boot() {
  /* 直连上传通道：素材分块上传改走服务器自己的 443，绕开隧道边缘 100s 硬超时。
     证书缺失 / 端口被占 ⇒ createUploadDirect 返回 null，主服务照常启动。 */
  if (process.env.UPLOAD_DIRECT === '1') {
    upDirect = createUploadDirect({
      port: Number(process.env.UPLOAD_PORT || 443),
      host: process.env.UPLOAD_HOST || '0.0.0.0',
      domain: process.env.UPLOAD_DOMAIN || 'up.aizhiying.online',
      certDir: process.env.UPLOAD_CERT_DIR || path.join(__dirname, '..', '.certs'),
      targetHost: HOST === '0.0.0.0' ? '127.0.0.1' : HOST,
      targetPort: PORT,
      strict: String(process.env.UPLOAD_STRICT || '') === '1',
      verify: (t) => { try { return !!(localAuth && localAuth.verifyToken(t)); } catch (e) { return false; } },
      log: (lv, m) => console.log(m)
    });
  }
  const ffst = await ff.status();
  const caps = await ff.capabilities().catch(() => null);
  const font = renderer.fontStatus();
  const cs = collectSched.stats();
  const cfg = CONFIG || config.snapshot();
  const ab = await editCap.abilities({ font: renderer.pickFont() });
  console.log('\n==============================================');
  console.log(' ProFound · BFF 服务层 + 渲染 Worker  v' + VERSION);
  console.log('==============================================');
  console.log(' 地址        http://' + HOST + ':' + PORT);
  console.log(' 直连上传    ' + (upDirect
    ? 'https://' + upDirect.domain + ':' + upDirect.port + '（素材走 443，不经隧道）'
    : (process.env.UPLOAD_DIRECT === '1'
      ? '未启动 — 检查 UPLOAD_CERT_DIR 证书是否存在、443 是否被占用'
      : '未启用（UPLOAD_DIRECT≠1，素材走隧道）')));
  console.log(' 前端页面    http://' + HOST + ':' + PORT + '/app');
  console.log(' FFmpeg      ' + (ffst.ok ? '就绪 — ' + ffst.version : '未找到！' + ffst.version));
  if (caps && caps.ok) {
    console.log(' 编码/滤镜   ' + (caps.ready ? '齐备（' + caps.required.join(' / ') + '）'
      : '缺少 ' + caps.missing.join(' / ') + ' — 渲染会失败'));
  }
  console.log(' 渲染字体    ' + (font.ok ? (font.cjk ? '含中文字形 — ' : '⚠ 缺中文字形 — ') + font.path
    : '未找到（字幕会被跳过）— 设置 RENDER_FONT'));
  console.log(' 配音字幕    ' + (ab.voice.ok
    ? '本地合成可用 — ' + (ab.voice.voice || '默认语音') + '（' + ab.voice.provider + '）· 字幕 ' + ab.subtitle.modeName + (ab.voice.warning ? ' ⚠ ' + ab.voice.warning : '')
    : '未接入 — ' + (ab.voice.reason || '本机没有可用的语音合成') + '，成片将输出无配音版本'));
  console.log(' 数据目录    ' + DATA_ROOT + (demo.enabled() ? '（演示环境，独立于生产库 ' + DATA_DIR + '）' : '（生产库）'));
  console.log(' 演示数据    ' + (demo.enabled()
    ? '已启用 · GET /v1/demo/dataset · 生产库不受影响'
    : '关闭（DEMO_MODE=0）· 数据样例见 /v1/data-samples'));
  console.log(' 渲染并发    ' + queue.concurrency + '   （RENDER_CONCURRENCY 可调）');
  config.summaryLines(CONFIG).forEach((l) => console.log(l));
  console.log(' 采集通道    ' + (function () {
    const list = collector.channels().filter((x) => x.configured && x.id !== 'local');
    if (!list.length) {
      return demo.allowLocalCollect()
        ? '本地模拟（演示环境 · ALLOW_LOCAL_COLLECT=1）'
        : '未接入 · 配 COLLECT_OFFICIAL_URL / COLLECT_CRAWLER_URL / COLLECT_UPSTREAM 任一';
    }
    return list.map((x) => x.name + ' ' + x.upstream + (x.missing.length ? '（缺 ' + x.missing.join('/') + '）' : '')).join(' · ');
  })());
  console.log(' 采集调度    ' + ({ upstream: '上游', local: '本地模拟', unconfigured: '未接入' }[cs.mode])
    + ' · ' + cs.enabled + ' 个启用 / ' + cs.tasks + ' 个任务 · 并发 ' + cs.concurrency
    + '（通道分布 ' + (Object.keys(cs.tasksByChannel || {}).map((k) => k + '×' + cs.tasksByChannel[k]).join(' ') || '—') + '）');
  console.log(' GEO 监测    ' + (process.env.GEO_UPSTREAM ? ('上游 ' + process.env.GEO_UPSTREAM)
    : (demo.allowLocalGeo() ? '本地模拟（演示环境 · ALLOW_LOCAL_GEO=1）' : '未接入 · 配置 GEO_UPSTREAM 与 GEO_TOKEN')));
  console.log(' GEO 任务    ' + geoSched.stats().enabled + ' 个启用 / ' + geoSched.stats().tasks + ' 个监测中');
  console.log(' 支付通道    ' + ((billing.provider && billing.provider.id) || 'none')
    + ' · ' + ((billing.provider && billing.provider.configured && billing.provider.configured()) ? '已就绪' : '未配置'));
  console.log('==============================================\n');
  if (!ffst.ok) {
    console.error('⚠ 未检测到 FFmpeg，渲染任务将全部失败。请安装 FFmpeg 或设置 FFMPEG_PATH。\n');
  } else if (caps && caps.ok && !caps.ready) {
    console.error('⚠ FFmpeg 缺少 ' + caps.missing.join(' / ') + '，渲染任务会失败。请换用完整构建。\n');
  }
  if (font.ok && !font.cjk) {
    console.error('⚠ 当前渲染字体不含中文字形（' + font.path + '），中文字幕会变成方块。请安装 fonts-noto-cjk。\n');
  }
  if (cfg.production && cfg.guard && cfg.guard.blocked) {
    console.error('⚠ 以 ALLOW_INSECURE_BOOT=1 在生产模式下启动：原环境存在 ' + cfg.guard.blocked
      + ' 项阻断级配置问题'
      + (cfg.guard.forcedOff && cfg.guard.forcedOff.length
        ? '，已强制关闭 ' + cfg.guard.forcedOff.join('、') + '；其余问题请尽快修正。' : '。')
      + '\n');
  }
}

/* ---------- 生产守卫：不放行就不监听端口 ---------- */
if (require.main === module) {
  if (CONFIG_ERROR) {
    console.error('\n==============================================');
    console.error(' ✗ 启动被拒绝：生产环境变量未收口');
    console.error('==============================================');
    console.error(CONFIG_ERROR.message);
    console.error('\n 提示：本地开发请勿设置 NODE_ENV=production。');
    console.error('       生产部署请对照 .env.example 逐项补齐。\n');
    process.exit(78);   /* EX_CONFIG */
  }
  server.listen(PORT, HOST, boot);
} else {
  module.exports = {
    server, store, queue, billing, collector, geoSched, collectSched,
    config, schedule, boot, PORT, HOST,
    CONFIG_ERROR
  };
}

['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => {
  console.log('\n[server] 收到 ' + sig + '，正在优雅退出…');
  queue.close();
  try { if (upDirect) upDirect.close(); } catch (e) {}
  try { geoSched.stop(); } catch (e) {}
  try { collectSched.stop(); } catch (e) {}
  try { store.save(true); } catch (e) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}));
