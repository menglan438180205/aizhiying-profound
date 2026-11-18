'use strict';
/* =========================================================
   test/tenant.test.js — K1「租户计量闭环」验收
   ---------------------------------------------------------
   验的是完整一条链，而不是单个函数：
     任务归属（票 / 管理员请求头） → 执行（run.tenant） → 线索归属
     → billing_usage / billing.summary 各记各的账
   另外覆盖：
     · 票内 tenant 优先于 X-Tenant-Id（K2 的读侧规则在写侧同样成立）
     · 任务创建后不能通过 PATCH 改归属
     · 计量层对非法租户标识的拒绝（BAD_TENANT）
     · 存量任务在服务启动时补 tenant=default
     · scripts/backfill-tenant.js 的 dry-run / --apply 行为

   零依赖：node server/test/tenant.test.js
   运行前提：本机 127.0.0.1 可用；不需要 ffmpeg / 上游通道。
   ========================================================= */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.TENANT_TEST_PORT || 18987);
const HOST = '127.0.0.1';
const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(__dirname, '..', 'index.js');
const SCRIPT = path.join(ROOT, 'scripts', 'backfill-tenant.js');
const NODE = process.execPath;
const DIR = path.join(os.tmpdir(), 'aizhiying-tenant-' + Date.now());
const DATA_ROOT = path.join(DIR, 'demo');          /* NODE_ENV=test + DEMO_MODE=1 → DATA_DIR/demo */
const LOG = path.join(DIR, 'server.log');
const ADMIN = 'tenant-test-admin-0123456789abcdef';

const PHONE_A = '13800000001';
const PHONE_B = '13800000002';
const PWD = 'Passw0rd!';

const R = [];
let pass = 0;
let failCount = 0;
let child = null;
let logFd = null;

function T(name, ok, info) {
  R.push(`${ok ? 'PASS' : 'FAIL'} | ${name}${info ? ' | ' + info : ''}`);
  if (ok) pass++; else failCount++;
  process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${name}${info ? '  → ' + info : ''}\n`);
}

/* ---------- HTTP ---------- */
function req(method, pathname, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const payload = opts.body == null ? null
      : (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body));
    const headers = Object.assign({}, opts.headers || {});
    if (payload) headers['Content-Length'] = payload.length;
    const r = http.request({ host: HOST, port: PORT, method, path: pathname, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        if (/json/.test(String(res.headers['content-type'] || ''))) {
          try { json = JSON.parse(buf.toString('utf8')); } catch (e) {}
        }
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const get = (p, h) => req('GET', p, { headers: h });
const post = (p, body, h) => req('POST', p, {
  body: JSON.stringify(body || {}),
  headers: Object.assign({ 'Content-Type': 'application/json' }, h || {})
});
const patch = (p, body, h) => req('PATCH', p, {
  body: JSON.stringify(body || {}),
  headers: Object.assign({ 'Content-Type': 'application/json' }, h || {})
});

const asAdmin = (tenant) => {
  const h = { Authorization: 'Bearer ' + ADMIN };
  if (tenant) h['X-Tenant-Id'] = tenant;
  return h;
};
const asUser = (token, tenant) => {
  const h = { Authorization: 'Bearer ' + token };
  if (tenant) h['X-Tenant-Id'] = tenant;
  return h;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await get('/v1/health');
      if (r.status === 200 && r.json && r.json.service === 'aizhiying-bff') return r.json;
    } catch (e) {}
    await sleep(300);
  }
  return null;
}

/* ---------- 造一个带租户的本地账号（users.ndjson 与 auth.js 同格式） ---------- */
function pwdHash(pwd) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pwd, salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}
function seedUser(phone, tenant) {
  const h = pwdHash(PWD);
  return {
    id: 'u' + phone, phone: phone, name: tenant, salt: h.salt, hash: h.hash,
    role: 'member', tenant: tenant, createdAt: new Date().toISOString(), lastLoginAt: ''
  };
}
function writeJson(file, val) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(val, null, 2), 'utf8');
}

/* ============================ 用例 ============================ */

async function main() {
  fs.mkdirSync(path.join(DATA_ROOT, 'db'), { recursive: true });
  fs.writeFileSync(path.join(DATA_ROOT, 'users.ndjson'),
    [seedUser(PHONE_A, 'acme'), seedUser(PHONE_B, 'beta')].map((u) => JSON.stringify(u)).join('\n') + '\n',
    'utf8');

  /* 预置两个「老任务」：没有 tenant 字段，用来验证启动迁移 */
  writeJson(path.join(DATA_ROOT, 'db', 'collect_tasks.json'), [{
    id: 'ct_legacy', keyword: '历史采集任务', platform: 'douyin', limit: 5,
    enabled: false, nextRunAt: 0, createdAt: new Date().toISOString(), runs: 0
  }]);
  writeJson(path.join(DATA_ROOT, 'db', 'geo_tasks.json'), [{
    id: 'gt_legacy', keyword: '历史 GEO 词', engines: ['doubao'], every: '1h',
    enabled: false, nextRunAt: 0, createdAt: new Date().toISOString()
  }]);

  logFd = fs.openSync(LOG, 'a');
  child = spawn(NODE, [SERVER], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST, DATA_DIR: DIR, QUIET: '1',
      NODE_ENV: 'test', DEMO_MODE: '1', DEMO_NO_SEED: '1',
      API_TOKEN: ADMIN,
      ALLOW_LOCAL_COLLECT: '1', ALLOW_LOCAL_GEO: '1',
      COLLECT_NO_SEED: '1', GEO_NO_SEED: '1',
      GEO_UPSTREAM: '', GEO_TOKEN: '', COLLECT_UPSTREAM: '', COLLECT_TOKEN: '', COLLECT_CRAWLER_URL: '',
      NO_PROXY: '*', no_proxy: '*', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: ''
    }),
    /* 沙箱下子进程不能用管道捕获输出，直接写日志文件（fd 不是命名管道） */
    stdio: ['ignore', logFd, logFd],
    windowsHide: true
  });
  child.on('error', (e) => { console.error('服务启动失败：' + (e && e.message)); });

  const health = await waitHealth(40000);
  T('租户测试实例启动', !!health, health ? 'v' + health.version : '40s 内未就绪，日志：' + LOG);
  if (!health) return;

  /* ---- 1. 存量任务补租户（启动迁移） ---- */
  const ct = await get('/v1/collect/tasks', asAdmin());
  const legacyC = ct.json && (ct.json.tasks || []).filter((t) => t.id === 'ct_legacy')[0];
  T('存量 collect_task 启动时补 tenant=default', !!legacyC && legacyC.tenant === 'default',
    legacyC && ('tenant=' + legacyC.tenant));

  const gt = await get('/v1/geo/tasks', asAdmin());
  const legacyG = gt.json && (gt.json.tasks || []).filter((t) => t.id === 'gt_legacy')[0];
  T('存量 geo_task 启动时补 tenant=default', !!legacyG && legacyG.tenant === 'default',
    legacyG && ('tenant=' + legacyG.tenant));

  /* ---- 2. 登录两个租户账号 ---- */
  const la = await post('/v1/auth/login', { phone: PHONE_A, password: PWD });
  const lb = await post('/v1/auth/login', { phone: PHONE_B, password: PWD });
  T('租户账号可登录并拿到会话票', la.status === 200 && !!la.json.token && lb.status === 200 && !!lb.json.token,
    'acme=' + la.status + ' beta=' + lb.status);

  /* ---- 3. 建任务：票内租户优先于 X-Tenant-Id ---- */
  const ca = await post('/v1/collect/tasks',
    { keyword: '租户A 雪尼尔沙发套', platform: 'douyin', every: '1h', limit: 5 },
    asUser(la.json.token, 'evil'));
  const taskA = ca.json && ca.json.task;
  T('采集任务按票内租户落库（伪造请求头无效）',
    ca.status === 201 && !!taskA && taskA.tenant === 'acme',
    taskA && ('tenant=' + taskA.tenant + ' id=' + taskA.id));

  const cb = await post('/v1/collect/tasks',
    { keyword: '租户B 荷兰绒沙发巾', platform: 'kuaishou', every: '1h', limit: 5 },
    asAdmin('beta'));
  const taskB = cb.json && cb.json.task;
  T('管理员可用 X-Tenant-Id 代建任务', cb.status === 201 && !!taskB && taskB.tenant === 'beta',
    taskB && ('tenant=' + taskB.tenant));

  /* ---- 4. 任务归属不可被 PATCH 改写 ---- */
  const pa = await patch('/v1/collect/tasks/' + encodeURIComponent(taskA.id), { tenant: 'beta' }, asAdmin('beta'));
  T('PATCH 不能改写任务租户', pa.status === 200 && pa.json.task.tenant === 'acme',
    'tenant=' + (pa.json && pa.json.task && pa.json.task.tenant));

  /* ---- 5. 各跑一轮：run.tenant 跟着任务走 ---- */
  const runA = await post('/v1/collect/tasks/' + encodeURIComponent(taskA.id) + '/run', {}, asAdmin());
  const rA = runA.json && runA.json.run;
  T('A 租户任务执行成功且 run.tenant=acme',
    runA.status === 200 && !!rA && rA.tenant === 'acme' && rA.fresh > 0,
    rA && ('tenant=' + rA.tenant + ' fresh=' + rA.fresh));

  const runB = await post('/v1/collect/tasks/' + encodeURIComponent(taskB.id) + '/run', {}, asAdmin());
  const rB = runB.json && runB.json.run;
  T('B 租户任务执行成功且 run.tenant=beta',
    runB.status === 200 && !!rB && rB.tenant === 'beta' && rB.fresh > 0,
    rB && ('tenant=' + rB.tenant + ' fresh=' + rB.fresh));

  /* ---- 6. 线索带上归属租户 ---- */
  const leads = await get('/v1/collect/leads?limit=200', asAdmin());
  const all = (leads.json && leads.json.leads) || [];
  const leadA = all.filter((l) => l.keyword === '租户A 雪尼尔沙发套');
  const leadB = all.filter((l) => l.keyword === '租户B 荷兰绒沙发巾');
  T('A 的线索全部标 acme', leadA.length > 0 && leadA.every((l) => l.tenant === 'acme'),
    leadA.length + ' 条');
  T('B 的线索全部标 beta', leadB.length > 0 && leadB.every((l) => l.tenant === 'beta'),
    leadB.length + ' 条');

  /* ---- 7. 用量各记各的账（K1 的核心验收） ---- */
  const sumA = await get('/v1/billing/summary', asAdmin('acme'));
  const sumB = await get('/v1/billing/summary', asAdmin('beta'));
  const sumD = await get('/v1/billing/summary', asAdmin());
  T('acme 的 leads 用量 = 自己这轮的条数',
    sumA.json.monthUsage.leads === rA.fresh && sumA.json.monthUsage.leads > 0,
    'acme leads=' + sumA.json.monthUsage.leads + ' 应为 ' + rA.fresh);
  T('beta 的 leads 用量 = 自己这轮的条数',
    sumB.json.monthUsage.leads === rB.fresh && sumB.json.monthUsage.leads > 0,
    'beta leads=' + sumB.json.monthUsage.leads + ' 应为 ' + rB.fresh);
  T('default 没有被别的租户扣走额度', sumD.json.monthUsage.leads === 0,
    'default leads=' + sumD.json.monthUsage.leads);

  /* ---- 8. GEO：任务归属 + 计量 ---- */
  const ga = await post('/v1/geo/tasks', { keyword: '租户A GEO 词', every: '1h' }, asAdmin('acme'));
  const gTaskA = ga.json && ga.json.task;
  T('GEO 监测任务落 tenant=acme', ga.status === 201 && !!gTaskA && gTaskA.tenant === 'acme',
    ga.status + ' tenant=' + (gTaskA && gTaskA.tenant));

  const gm = await post('/v1/geo/monitor', { taskId: gTaskA.id }, asAdmin());
  const gRun = gm.json && gm.json.run;
  T('GEO 监测 run.tenant=acme 且成功', gm.status === 200 && !!gRun && gRun.tenant === 'acme',
    gRun && ('tenant=' + gRun.tenant + ' covered=' + gRun.covered));

  const sumA2 = await get('/v1/billing/summary', asAdmin('acme'));
  const sumB2 = await get('/v1/billing/summary', asAdmin('beta'));
  T('acme 的 geo 用量 +1', sumA2.json.monthUsage.geo === 1, 'acme geo=' + sumA2.json.monthUsage.geo);
  T('beta 的 geo 用量不受 acme 影响', sumB2.json.monthUsage.geo === 0, 'beta geo=' + sumB2.json.monthUsage.geo);

  /* ---- 9. GEO 控制台探针（ensureProbe 新建任务带租户） ---- */
  const pr = await post('/v1/geo2/probes/run', { word: '租户B 探针词' }, asAdmin('beta'));
  T('GEO2 探针跑通', pr.status === 200 && !!(pr.json && pr.json.run), pr.status + ' ' + (pr.json && pr.json.code || ''));
  const gt2 = await get('/v1/geo/tasks', asAdmin());
  const probeTask = ((gt2.json && gt2.json.tasks) || []).filter((t) => t.keyword === '租户B 探针词')[0];
  T('探针自动建的监测任务归 beta', !!probeTask && probeTask.tenant === 'beta',
    probeTask && ('tenant=' + probeTask.tenant));
  const sumB3 = await get('/v1/billing/summary', asAdmin('beta'));
  T('beta 的 geo 用量 +1（探针也记在自己账上）', sumB3.json.monthUsage.geo === 1,
    'beta geo=' + sumB3.json.monthUsage.geo);

  /* ---- 10. 计量层白名单（进程内单测，不起服务） ---- */
  const { Billing } = require('../billing');
  const stub = (() => {
    const data = { billing_subscriptions: [], billing_wallets: [], billing_usage: [], billing_ledger: [], orders: [] };
    return {
      data,
      push(name, rec) { (data[name] = data[name] || []).push(rec); },
      save() {},
      event() {},
      orders() { return data.orders; }
    };
  })();
  const bill = new Billing(stub, { dataRoot: path.join(DIR, 'unit-billing') });
  const bad1 = bill.charge('bad tenant!', 'leads', 1);
  const bad2 = bill.charge('__proto__', 'leads', 1);
  T('非法租户标识被计费层拒绝（空格/符号）', bad1.ok === false && bad1.code === 'BAD_TENANT', bad1.code);
  T('非法租户标识被计费层拒绝（原型链键）', bad2.ok === false && bad2.code === 'BAD_TENANT', bad2.code);
  const good = bill.charge('acme', 'leads', 3);
  T('合法租户正常记账', good.ok === true && bill.summary('acme').monthUsage.leads === 3,
    'acme leads=' + bill.summary('acme').monthUsage.leads);
  T('记账没有落到 default', bill.summary('default').monthUsage.leads === 0,
    'default leads=' + bill.summary('default').monthUsage.leads);

  /* ---- 11. scripts/backfill-tenant.js（dry-run 不写盘，--apply 补齐） ---- */
  const MDIR = path.join(DIR, 'migrate');
  const mfile = path.join(MDIR, 'db', 'collect_tasks.json');
  writeJson(mfile, [
    { id: 'ct1', keyword: '旧任务一', platform: 'douyin', enabled: false },
    { id: 'ct2', keyword: '旧任务二', platform: 'douyin', enabled: false, tenant: 'beta' }
  ]);
  writeJson(path.join(MDIR, 'db', 'geo_tasks.json'), []);
  const menv = Object.assign({}, process.env, { DATA_DIR: MDIR, NODE_ENV: 'production', QUIET: '1' });
  const dry = spawnSync(NODE, [SCRIPT], { env: menv, stdio: 'ignore', windowsHide: true });
  const afterDry = JSON.parse(fs.readFileSync(mfile, 'utf8'));
  T('迁移脚本 dry-run 不改数据', dry.status === 0 && !afterDry[0].tenant,
    'status=' + dry.status + ' tenant=' + afterDry[0].tenant);
  const app = spawnSync(NODE, [SCRIPT, '--apply'], { env: menv, stdio: 'ignore', windowsHide: true });
  const afterApp = JSON.parse(fs.readFileSync(mfile, 'utf8'));
  T('迁移脚本 --apply 补 default 且不动已有值',
    app.status === 0 && afterApp[0].tenant === 'default' && afterApp[1].tenant === 'beta',
    'status=' + app.status + ' [0]=' + afterApp[0].tenant + ' [1]=' + afterApp[1].tenant);
}

/* ============================ 收尾 ============================ */

main().catch((e) => {
  console.error('\n用例异常：' + ((e && e.stack) || e));
  failCount++;
}).then(() => {
  if (child) { try { child.kill('SIGKILL'); } catch (e) {} }
  if (logFd != null) { try { fs.closeSync(logFd); } catch (e) {} }
  console.log('\n===== 租户闭环（K1）测试结果 =====');
  console.log('通过 ' + pass + ' / 共 ' + (pass + failCount) + (failCount ? ' · 失败 ' + failCount : ''));
  if (failCount) {
    console.log('\n失败详情：');
    R.filter((x) => x.indexOf('FAIL') === 0).forEach((x) => console.log('  ' + x));
    try { console.log('\n服务端日志尾部：\n' + fs.readFileSync(LOG, 'utf8').slice(-3000)); } catch (e) {}
  }
  process.exitCode = failCount ? 1 : 0;
});
