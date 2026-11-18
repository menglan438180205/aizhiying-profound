'use strict';
/* =========================================================
   test/api.test.js — 服务端层 + 渲染 Worker 自动化测试
   零依赖，直接 node server/test/api.test.js
   覆盖：健康检查 / 素材入库与去重 / 真实渲染产出校验（含 mp4 文件头与
        ffprobe 元数据）/ 幂等复用 / Range 分发 / 错误路径 / 取消 / 删除 /
        订单幂等 / 采集器契约 / 路径穿越防护
   ========================================================= */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

/* 能力插件的纯函数级验证（不依赖服务进程） */
const ec = require(path.join(__dirname, '..', 'edit-capabilities'));
const ffmod = require(path.join(__dirname, '..', 'ffmpeg'));
const { RenderQueue } = require(path.join(__dirname, '..', 'queue'));

const PORT = Number(process.env.TEST_PORT || 18787);
const HOST = '127.0.0.1';
const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(__dirname, '..', 'index.js');
const DATA_DIR = path.join(os.tmpdir(), 'aizhiying-test-' + Date.now());
const WORK = path.join(DATA_DIR, 'fixtures');
const NODE = process.execPath;
const FF = process.env.FFMPEG_PATH || 'D:/ffmpeg/bin/ffmpeg.exe';

const R = [];
let pass = 0, failCount = 0;
let child = null;

function T(name, ok, info) {
  R.push(`${ok ? 'PASS' : 'FAIL'} | ${name}${info ? ' | ' + info : ''}`);
  if (ok) pass++; else failCount++;
  process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${name}${info ? '  → ' + info : ''}\n`);
}

/* ---------- HTTP 小工具（显式绕过代理，避免 http_proxy 干扰本地请求） ---------- */
function req(method, pathname, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const payload = opts.body == null ? null
      : (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body));
    const headers = Object.assign({}, opts.headers || {});
    if (payload) headers['Content-Length'] = payload.length;
    const r = http.request({ host: HOST, port: opts.port || PORT, method, path: pathname, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        const ct = String(res.headers['content-type'] || '');
        if (/json/.test(ct)) { try { json = JSON.parse(buf.toString('utf8')); } catch (e) {} }
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8'), json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起一个短命子进程并收集输出，用于验证「生产守卫拒绝启动」这类
 * 必须在进程级别观察的行为（不能用 require 代替）。
 */
function runChildExpectExit(env, timeoutMs) {
  return new Promise((resolve) => {
    const envs = Object.assign({}, process.env, env || {}, {
      NO_PROXY: '*', no_proxy: '*', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: ''
    });
    const c = spawn(NODE, [SERVER], { cwd: ROOT, env: envs, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d.toString('utf8'); });
    c.stderr.on('data', (d) => { out += d.toString('utf8'); });
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      try { c.kill('SIGKILL'); } catch (e) {}
      resolve({ code, out });
    };
    c.on('close', (code) => finish(code == null ? -1 : code));
    c.on('error', () => finish('SPAWN_ERROR'));
    setTimeout(() => finish('TIMEOUT'), timeoutMs || 25000);
  });
}

function multipart(fields, files) {
  const b = '----wbTest' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const parts = [];
  Object.keys(fields || {}).forEach((k) => {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${fields[k]}\r\n`, 'utf8'));
  });
  (files || []).forEach((f) => {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="assets"; filename="${f.name}"\r\nContent-Type: ${f.type || 'application/octet-stream'}\r\n\r\n`, 'utf8'));
    parts.push(f.data);
    parts.push(Buffer.from('\r\n', 'utf8'));
  });
  parts.push(Buffer.from(`--${b}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + b };
}

/* ---------- 造测试素材（用 ffmpeg 生成，不依赖外部文件） ---------- */
function ffRun(args, cwd) {
  return new Promise((resolve, reject) => {
    const c = spawn(FF, ['-hide_banner', '-loglevel', 'error', '-y'].concat(args), { cwd, windowsHide: true });
    let err = '';
    c.stderr.on('data', (d) => { err += d.toString('utf8'); });
    c.on('error', reject);
    c.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg 失败: ' + err.slice(-200))));
  });
}

async function makeFixtures() {
  fs.mkdirSync(WORK, { recursive: true });
  for (let i = 1; i <= 3; i++) {
    await ffRun(['-f', 'lavfi', '-i', `testsrc2=size=${1000 + i * 200}x${1400 + i * 100}:duration=1`,
      '-frames:v', '1', `p${i}.jpg`], WORK);
  }
  await ffRun(['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:duration=8:rate=25',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', 'clip.mp4'], WORK);
  return {
    imgs: [1, 2, 3].map((i) => ({ name: `p${i}.jpg`, type: 'image/jpeg', data: fs.readFileSync(path.join(WORK, `p${i}.jpg`)) })),
    clip: { name: 'clip.mp4', type: 'video/mp4', data: fs.readFileSync(path.join(WORK, 'clip.mp4')) }
  };
}

async function waitHealth(timeoutMs, port) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 30000)) {
    try {
      const r = await req('GET', '/v1/health', { port });
      if (r.status === 200 && r.json && r.json.ok) return r.json;
    } catch (e) { /* 还没起来 */ }
    await sleep(400);
  }
  return null;
}

async function waitJob(id, timeoutMs, stopWhen) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < (timeoutMs || 180000)) {
    const r = await req('GET', '/v1/edit/jobs/' + id);
    last = r.json && r.json.job;
    if (!last) return null;
    if (stopWhen && stopWhen(last)) return last;
    if (last.status === 'done' || last.status === 'failed' || last.status === 'canceled') return last;
    await sleep(600);
  }
  return last;
}

/**
 * 起一个临时实例（独立端口 / 独立数据目录 / 可覆盖环境变量），
 * 用于对比「通道已接」与「通道未接」两种截然不同的语义。
 */
async function withServer(envExtra, fn) {
  const port = PORT + 40 + Math.floor(Math.random() * 40);
  const dir = path.join(DATA_DIR, 'inst-' + port);
  const c = spawn(NODE, [SERVER], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST, DATA_DIR: dir, QUIET: '1',
      NO_PROXY: '*', no_proxy: '*', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: ''
    }, envExtra || {}),
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let lg = '';
  c.stdout.on('data', (d) => { lg += d.toString('utf8'); });
  c.stderr.on('data', (d) => { lg += d.toString('utf8'); });
  try {
    const h = await waitHealth(30000, port);
    if (!h) throw new Error('临时实例未就绪：' + lg.slice(-400));
    return await fn(port, h);
  } finally {
    try { c.kill('SIGKILL'); } catch (e) {}
  }
}

/** 临时改写当前进程的环境变量（config.snapshot 读的是 process.env） */
function withEnv(kv, fn) {
  const saved = {};
  Object.keys(kv).forEach((k) => { saved[k] = process.env[k]; process.env[k] = kv[k]; });
  const restore = () => Object.keys(kv).forEach((k) => {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
    restore();
    return r;
  } catch (e) { restore(); throw e; }
}

/* ============================ 用例 ============================ */

async function main() {
  console.log('\n=== AI智盈 服务端 + 渲染 Worker 自动化测试 ===\n');
  console.log('数据目录 :', DATA_DIR);

  child = spawn(NODE, [SERVER], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST, DATA_DIR, QUIET: '1',
      ALLOW_LOCAL_GEO: '1', ALLOW_LOCAL_COLLECT: '1',
      NO_PROXY: '*', no_proxy: '*', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: ''
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let bootLog = '';
  child.stdout.on('data', (d) => { bootLog += d.toString('utf8'); });
  child.stderr.on('data', (d) => { bootLog += d.toString('utf8'); });

  const health = await waitHealth(40000);
  T('服务启动并可访问 /v1/health', !!health, health ? `v${health.version}` : '30s 内未就绪');
  if (!health) { console.error(bootLog.slice(-1500)); return; }
  T('FFmpeg 就绪', !!(health.ffmpeg && health.ffmpeg.ok), (health.ffmpeg && health.ffmpeg.version || '').slice(0, 60));
  T('队列统计可用', !!health.queue && typeof health.queue.concurrency === 'number', JSON.stringify(health.queue));
  T('采集器未配置时如实上报', health.collector && health.collector.configured === false, health.collector && health.collector.message);
  T('支付未配置时如实上报', health.billing && health.billing.configured === false, health.billing && health.billing.provider);

  const fx = await makeFixtures();
  T('测试素材生成', fx.imgs.length === 3 && fx.clip.data.length > 1000,
    `${fx.imgs.length} 图 + 1 视频`);

  /* ---------- 素材与任务 ---------- */
  const mpBody = multipart({ params: JSON.stringify({
    title: '雪尼尔沙发巾 · 图文成片', count: 3, ratio: '9:16', shotSeconds: 2,
    motion: 'kenburns', transition: 'fade'
  }) }, fx.imgs.concat([fx.clip]));

  const created = await req('POST', '/v1/edit/jobs', { body: mpBody.body, headers: { 'Content-Type': mpBody.contentType } });
  const job = created.json && created.json.job;
  T('multipart 提交剪辑任务成功', created.status === 201 && !!job, `http=${created.status} job=${job && job.id}`);
  if (!job) { console.error(created.text.slice(0, 500)); return; }
  T('素材全部入库', created.json.assets.length === 4, created.json.assets.map((a) => a.kind).join(','));
  T('参数被正确归一化', job.request.ratio === '9:16' && job.request.count === 3, JSON.stringify(job.request));

  const done = await waitJob(job.id, 240000);
  T('渲染任务完成', done && done.status === 'done', done ? `${done.status} · ${done.elapsedMs}ms` : '超时');
  T('产出成片数量正确', done && done.outputCount === 3, done && String(done.outputCount));
  if (done && done.outputs && done.outputs.length) {
    const o1 = done.outputs[0];
    T('成片元数据有效（分辨率 / 时长 / 体积）',
      o1.width === 720 && o1.height === 1280 && o1.duration > 3 && o1.bytes > 20000,
      `${o1.width}x${o1.height} ${o1.duration}s ${(o1.bytes / 1048576).toFixed(2)}MB`);
    T('成片含音轨标记', o1.audio === true, 'audio=' + o1.audio);
    T('三条成片内容互不相同',
      new Set(done.outputs.map((o) => o.file)).size === 3, done.outputs.map((o) => o.file).join(' '));
  }

  /* ---------- 成片分发 ---------- */
  const fname = done.outputs[0].file;
  const got = await req('GET', '/files/' + fname);
  T('成片可通过 HTTP 下载', got.status === 200 && got.buf.length > 20000, `${got.buf.length} bytes`);
  T('返回的是合法 MP4（ftyp 文件头）', got.buf.slice(4, 8).toString('ascii') === 'ftyp',
    got.buf.slice(4, 12).toString('hex'));

  const rng = await req('GET', '/files/' + fname, { headers: { Range: 'bytes=0-1023' } });
  T('支持 Range 请求（206 + Content-Range）',
    rng.status === 206 && /^bytes 0-1023\//.test(String(rng.headers['content-range'] || '')),
    `http=${rng.status} ${rng.headers['content-range']}`);

  const cov = await req('GET', '/files/' + done.outputs[0].coverFile);
  T('封面抽帧可访问且为 JPEG', cov.status === 200 && cov.buf[0] === 0xFF && cov.buf[1] === 0xD8,
    `${cov.buf.length} bytes`);

  T('路径穿越被拒绝', (await req('GET', '/files/..%2f..%2findex.html')).status === 404, '');

  /* ---------- 幂等 ---------- */
  const again = await req('POST', '/v1/edit/jobs', { body: mpBody.body, headers: { 'Content-Type': mpBody.contentType } });
  T('相同素材 + 相同配置 → 幂等复用同一任务',
    again.json && again.json.reused === true && again.json.job.id === job.id,
    again.json ? `reused=${again.json.reused} job=${again.json.job.id}` : '');
  T('重复上传同一素材 → 素材层复用',
    !!(again.json && again.json.assets.every((a) => a.reused === true)), '');

  /* ---------- 错误路径 ---------- */
  const badMp = multipart({ params: JSON.stringify({ count: 1 }) }, [{ name: 'bad.txt', type: 'text/plain', data: Buffer.from('not media') }]);
  const badR = await req('POST', '/v1/edit/jobs', { body: badMp.body, headers: { 'Content-Type': badMp.contentType } });
  T('不支持的格式被明确拒绝', badR.status === 400 && badR.json.code === 'ASSET_INVALID',
    `${badR.status} ${badR.json && badR.json.code}`);

  const noAsset = multipart({ params: JSON.stringify({ count: 1 }) }, []);
  const naR = await req('POST', '/v1/edit/jobs', { body: noAsset.body, headers: { 'Content-Type': noAsset.contentType } });
  T('无素材时返回 NO_ASSET', naR.status === 400 && naR.json.code === 'NO_ASSET', `${naR.status} ${naR.json && naR.json.code}`);

  const badJson = await req('POST', '/v1/edit/jobs', { body: '{not json', headers: { 'Content-Type': 'application/json' } });
  T('非法 JSON 被拒绝', badJson.status === 400 && badJson.json.code === 'BAD_JSON', String(badJson.status));

  T('未知接口返回 404', (await req('GET', '/v1/nope')).status === 404, '');

  /* ---------- JSON base64 通道 ---------- */
  const b64 = {
    params: { title: 'JSON 通道 · 图文成片', count: 1, ratio: '1:1', shotSeconds: 2, motion: 'pan', transition: 'cut' },
    assets: [{ name: 'p1.jpg', dataUrl: 'data:image/jpeg;base64,' + fx.imgs[0].data.toString('base64') }]
  };
  const jr = await req('POST', '/v1/edit/jobs', { body: JSON.stringify(b64), headers: { 'Content-Type': 'application/json' } });
  T('JSON base64 上传通道可用', jr.status === 201 && jr.json.job.request.ratio === '1:1',
    jr.json ? `${jr.status} ratio=${jr.json.job.request.ratio}` : String(jr.status));
  if (jr.json && jr.json.job) {
    const jd = await waitJob(jr.json.job.id, 120000);
    T('JSON 通道任务渲染完成且为方形画布',
      jd && jd.status === 'done' && jd.outputs[0] && jd.outputs[0].width === 960 && jd.outputs[0].height === 960,
      jd && jd.outputs[0] ? `${jd.status} ${jd.outputs[0].width}x${jd.outputs[0].height}` : (jd && jd.status));
  }

  /* ---------- 内置示例素材（无上传文件也能真实渲染） ---------- */
  const smp = await req('GET', '/v1/edit/samples');
  T('示例素材清单可用', smp.status === 200 && Array.isArray(smp.json.items) && smp.json.items.length >= 4,
    smp.json ? (smp.json.items.length + ' 条') : String(smp.status));
  T('示例素材字段齐全（id / kind / url / 尺寸）',
    !!smp.json.items.length && smp.json.items.every((i) => i.id && i.kind === 'image'
      && /^\/v1\/edit\/samples\/.+\.jpg$/.test(i.url) && i.width > 0 && i.height > 0 && i.bytes > 2048),
    smp.json.items.map((i) => i.id).join(','));
  const sImg = await req('GET', smp.json.items[0].url);
  T('示例图可免鉴权获取且为 JPEG', sImg.status === 200 && sImg.buf[0] === 0xFF && sImg.buf[1] === 0xD8,
    `${sImg.status} ${sImg.buf.length} bytes`);
  T('示例图路径穿越被拒绝', (await req('GET', '/v1/edit/samples/..%2f..%2findex.html')).status === 404, '');

  /* =========================================================
     AI秒搭建站 · 生产链路
     ---------------------------------------------------------
     原先这段根本不存在：产物只活在浏览器内存，域名从不被校验，
     于是「填了真实域名」和「填了假域名」对系统来说毫无区别。
     这里守住三件事：产物可持久化、可真实 HTTP 托管、不可路径穿越。
     ========================================================= */
  const stmod = require(path.join(__dirname, '..', 'sites'));
  T('文件名白名单拒绝可执行文件', stmod.safeName('evil.exe') === null, '');
  T('文件名白名单拒绝绝对路径', stmod.safeName('/etc/passwd') === null, '');
  T('文件名白名单保留合法子路径', stmod.safeName('assets/style.css') === 'assets/style.css',
    String(stmod.safeName('assets/style.css')));
  T('域名归一化去掉协议与路径', stmod.safeDomain('https://WWW.Example.COM/a/b') === 'www.example.com',
    stmod.safeDomain('https://WWW.Example.COM/a/b'));

  const noSuchDomain = 'not-exist-domain-' + Date.now() + '.com';
  const probeR = await req('GET', '/v1/sites/probe?domain=' + encodeURIComponent(noSuchDomain));
  T('未注册域名探测判定为未解析',
    probeR.status === 200 && probeR.json.probe && probeR.json.probe.dns.resolved === false
      && probeR.json.probe.level === 'err',
    probeR.json && probeR.json.probe ? probeR.json.probe.verdict.slice(0, 40) : String(probeR.status));

  const siteFiles = [
    { name: 'index.html', text: '<!doctype html><h1>hi</h1>', group: '页面' },
    { name: 'assets/style.css', text: 'body{color:#000}', group: '资源' },
    { name: 'robots.txt', text: 'User-agent: GPTBot\nAllow: /', group: 'GEO' }
  ];
  const sv1 = await req('POST', '/v1/sites', {
    body: JSON.stringify({ brand: 'UT品牌', domain: 'https://www.example.com/x', industry: 'agency',
      industryLabel: '流量服务商', date: '2026-10-18', score: 90, ldCount: 4, keywords: ['哪家好'],
      pages: [{ file: 'index.html', crumb: '首页', title: 't', desc: 'd' }], files: siteFiles }),
    headers: { 'Content-Type': 'application/json' }
  });
  T('站点保存成功并返回托管地址',
    sv1.status === 200 && sv1.json.record && /\/site\/[a-z0-9]+\/index\.html$/.test(sv1.json.previewUrl || ''),
    sv1.json && sv1.json.record ? sv1.json.previewUrl : String(sv1.status));

  const sid = sv1.json && sv1.json.record ? sv1.json.record.id : '';
  if (sid) {
    T('域名归一化后入库', sv1.json.record.domain === 'www.example.com', sv1.json.record.domain);
    const hIdx = await req('GET', '/site/' + sid + '/index.html');
    T('托管首页可访问且为 HTML', hIdx.status === 200 && /text\/html/.test(hIdx.headers['content-type'] || ''),
      `${hIdx.status} ${hIdx.buf.length}B`);
    const hCss = await req('GET', '/site/' + sid + '/assets/style.css');
    T('托管子目录资源可访问', hCss.status === 200, String(hCss.status));
    T('托管路径穿越被拒绝', (await req('GET', '/site/' + sid + '/..%2f..%2f..%2f.env.local')).status === 404, '');
    T('托管非法扩展名被拒绝', (await req('GET', '/site/' + sid + '/shell.exe')).status === 404, '');
    T('托管不存在的站点返回 404', (await req('GET', '/site/nosuchsite/index.html')).status === 404, '');
    const detail = await req('GET', '/v1/sites/' + sid);
    T('站点详情含全部文件正文',
      detail.status === 200 && detail.json.files && detail.json.files['robots.txt'] === 'User-agent: GPTBot\nAllow: /',
      String(detail.status));

    const sv2 = await req('POST', '/v1/sites', {
      body: JSON.stringify({ brand: 'UT品牌', domain: 'www.example.com', files: siteFiles, pages: [], score: 80 }),
      headers: { 'Content-Type': 'application/json' }
    });
    T('同品牌+域名重复保存走幂等（不产生第二个站点）',
      sv2.status === 200 && sv2.json.record.id === sid, sv2.json.record ? sv2.json.record.id : String(sv2.status));

    const lst = await req('GET', '/v1/sites');
    T('列表返回站点且带 previewUrl',
      lst.status === 200 && lst.json.items.length === 1 && !!lst.json.items[0].previewUrl,
      String(lst.json.total));
    const badSave = await req('POST', '/v1/sites', {
      body: JSON.stringify({ brand: 'UT品牌2', domain: 'a.com', files: [{ name: '../evil.html', text: 'x' }], pages: [] }),
      headers: { 'Content-Type': 'application/json' }
    });
    T('非法文件名整体拒绝写库',
      badSave.status === 400 && badSave.json.code === 'BAD_NAME',
      badSave.json ? badSave.json.code + ' · ' + badSave.json.message : String(badSave.status));
    T('删除站点成功', (await req('DELETE', '/v1/sites/' + sid)).status === 200, '');
    T('删除后不可再访问', (await req('GET', '/site/' + sid + '/index.html')).status === 404, '');
  }

  const sIds = smp.json.items.slice(0, 3).map((i) => i.id);
  const sJob = await req('POST', '/v1/edit/jobs', {
    body: JSON.stringify({ params: { title: '示例素材 · 真实渲染', count: 2, ratio: '9:16', shotSeconds: 2, samples: sIds } }),
    headers: { 'Content-Type': 'application/json' }
  });
  T('纯示例素材提交渲染成功（无需上传任何文件）',
    sJob.status === 201 && sJob.json.job && sJob.json.job.assetCount === 3,
    sJob.json && sJob.json.job ? `assetCount=${sJob.json.job.assetCount}` : String(sJob.status));
  if (sJob.json && sJob.json.job) {
    const sDone = await waitJob(sJob.json.job.id, 240000);
    T('示例素材真实渲染完成', sDone && sDone.status === 'done', sDone ? `${sDone.status} · ${sDone.elapsedMs}ms` : '超时');
    T('示例素材成片可下载且为合法 MP4',
      sDone && sDone.status === 'done' && sDone.outputs[0] && sDone.outputs[0].width === 720,
      sDone && sDone.outputs[0] ? `${sDone.outputs[0].width}x${sDone.outputs[0].height}` : String(sDone && sDone.status));
    const sAgain = await req('POST', '/v1/edit/jobs', {
      body: JSON.stringify({ params: { title: '示例素材 · 真实渲染', count: 2, ratio: '9:16', shotSeconds: 2, samples: sIds } }),
      headers: { 'Content-Type': 'application/json' }
    });
    T('重复提交示例素材 → 素材层复用 + 任务幂等',
      sAgain.json && sAgain.json.reused === true && sAgain.json.assets.every((a) => a.reused === true),
      sAgain.json ? `reused=${sAgain.json.reused}` : '');
  }

  const mixJob = await req('POST', '/v1/edit/jobs', {
    body: JSON.stringify({
      params: { title: '混合来源', count: 1, ratio: '9:16', shotSeconds: 2, samples: ['nope-unknown', sIds[0]] },
      assets: [{ name: 'm1.jpg', dataUrl: 'data:image/jpeg;base64,' + fx.imgs[0].data.toString('base64') }]
    }),
    headers: { 'Content-Type': 'application/json' }
  });
  T('未知示例 id 被忽略，已知 id 与上传素材正常合并',
    mixJob.status === 201 && mixJob.json.job && mixJob.json.job.assetCount === 2,
    mixJob.json && mixJob.json.job ? `assetCount=${mixJob.json.job.assetCount}` : String(mixJob.status));

  const emptyS = await req('POST', '/v1/edit/jobs', {
    body: JSON.stringify({ params: { count: 1, samples: [] } }),
    headers: { 'Content-Type': 'application/json' }
  });
  T('samples 为空且无上传文件 → NO_ASSET', emptyS.status === 400 && emptyS.json.code === 'NO_ASSET',
    `${emptyS.status} ${emptyS.json.code}`);

  /* ---------- 取消 ---------- */
  const bigMp = multipart({ params: JSON.stringify({ title: '取消测试', count: 10, shotSeconds: 3 }) }, fx.imgs);
  const bigR = await req('POST', '/v1/edit/jobs', { body: bigMp.body, headers: { 'Content-Type': bigMp.contentType } });
  const bigId = bigR.json.job.id;
  // 等到至少产出 1 条成片后再取消，才能验证“部分产出被保留”
  const mid = await waitJob(bigId, 90000, (j) => j.status === 'running' && j.outputCount >= 1);
  T('长任务进入渲染中状态并已产出部分成片', !!mid && mid.status === 'running' && mid.outputCount >= 1,
    mid ? `${mid.progress}% · 已产出 ${mid.outputCount} 条` : '未捕获');
  const cancelR = await req('POST', `/v1/edit/jobs/${bigId}/cancel`);
  T('取消请求被接受', cancelR.status === 200 && cancelR.json.job.status === 'canceled', String(cancelR.status));
  const afterCancel = await waitJob(bigId, 20000, (j) => j.status === 'canceled');
  T('取消后任务终态为 canceled', afterCancel.status === 'canceled', afterCancel.stage);
  T('取消后仍保留已产出成片', afterCancel.outputCount >= 1, afterCancel.outputCount + ' 条');
  const cancel2 = await req('POST', `/v1/edit/jobs/${bigId}/cancel`);
  T('重复取消被拒绝', cancel2.status === 409 && cancel2.json.code === 'CANCEL_FAILED', String(cancel2.status));

  /* ---------- 删除 ---------- */
  const delR = await req('DELETE', '/v1/edit/jobs/' + bigId);
  T('删除任务成功', delR.status === 200, String(delR.status));
  T('删除后查询返回 404', (await req('GET', '/v1/edit/jobs/' + bigId)).status === 404, '');

  /* ---------- 列表 / 统计 / 事件 ---------- */
  const list = await req('GET', '/v1/edit/jobs?limit=10');
  T('任务列表可查询', list.status === 200 && Array.isArray(list.json.jobs) && list.json.jobs.length > 0,
    (list.json.jobs || []).length + ' 条');

  const stats = await req('GET', '/v1/edit/stats');
  T('队列统计结构与死信视图可用', stats.status === 200 && stats.json.queue.done >= 2,
    JSON.stringify(stats.json.queue));

  /* ---------- 本地配音与字幕（能力插件，全部本地、不接第三方） ---------- */
  const abil = stats.json && stats.json.abilities;
  T('edit/stats 返回本地能力现状（配音 / 字幕）',
    abil && abil.voice && typeof abil.voice.channel === 'string' && abil.subtitle && typeof abil.subtitle.mode === 'string',
    abil ? 'voice=' + abil.voice.channel + ' · subtitle=' + abil.subtitle.mode : '缺失');

  // 幂等指纹必须包含配音参数：否则「改了配音配置」会被错误判定为同一任务而复用旧成片
  const fpsA = ['xfp1', 'xfp2'];
  const fpVoice = RenderQueue.fingerprint(fpsA, { title: 't', voice: true, voiceText: '你好' });
  const fpNoVoice = RenderQueue.fingerprint(fpsA, { title: 't' });
  const fpVoiceText = RenderQueue.fingerprint(fpsA, { title: 't', voice: true, voiceText: '你好啊' });
  T('配音开关与文案参与幂等指纹（改配置不复用旧成片）',
    fpVoice !== fpNoVoice && fpVoice !== fpVoiceText,
    fpVoice.slice(0, 8) + ' / ' + fpNoVoice.slice(0, 8) + ' / ' + fpVoiceText.slice(0, 8));

  // 字幕分句：标点断句、不留句末标点、长句二次切分
  const sents = ec.subtitle.split('家纺面料源头厂家，评论区扣一拿批发价。支持一件代发！', 18);
  T('配音文案按标点分句且不留句末标点',
    sents.length === 3 && sents.every((s) => !/[，,、。！？!?；;…]$/.test(s)),
    sents.join(' | '));
  const longCut = ec.subtitle.split('一'.repeat(40), 18);
  T('超长句按最大字数二次切分', longCut.length >= 2, longCut.length + ' 段');

  // SRT：时间轴由「逐句真实时长累加」得到（不需要语音识别）；支持按时长裁剪
  const srt = ec.subtitle.toSrt([
    { text: '第一句', start: 0, end: 1.5 },
    { text: '第二句', start: 1.5, end: 3.25 }
  ], { maxEnd: 2.0 });
  T('SRT 生成含时间轴且按时长裁剪尾部',
    /00:00:00,000 --> 00:00:01,500/.test(srt) && /--> 00:00:02,000/.test(srt) && !/00:00:03/.test(srt),
    (srt.split('\n')[1] || '').slice(0, 40));
  const scaled = ec.subtitle.scaleTimeline([{ text: 'x', start: 2, end: 4 }], 0.5);
  T('字幕时间轴可按比例缩放', scaled[0].start === 1 && scaled[0].end === 2, JSON.stringify(scaled[0]));

  // TTS 探测：CI / Linux 容器可能没有语音包，只断言结构完整，不断言 ok
  const ttsSt = await ec.tts.status(true);
  T('本地 TTS 探测返回完整结构（ok 为 false 也必须带原因）',
    typeof ttsSt.ok === 'boolean' && typeof ttsSt.provider === 'string' && Array.isArray(ttsSt.voices)
      && (ttsSt.ok || !!ttsSt.reason),
    'provider=' + ttsSt.provider + ' ok=' + ttsSt.ok + (ttsSt.cjkVoice ? ' voice=' + ttsSt.cjkVoice : ''));

  // FFmpeg 可选能力：subtitles / amix 缺失只降级，不阻断镜像构建
  const capsX = await ffmod.capabilities();
  T('FFmpeg 可选能力纳入探测且不进 REQUIRED（缺失只降级）',
    Array.isArray(capsX.optional) && capsX.optional.indexOf('subtitles') > -1
      && typeof capsX.subtitles === 'boolean' && typeof capsX.amix === 'boolean'
      && capsX.required.indexOf('subtitles') === -1,
    'subtitles=' + capsX.subtitles + ' amix=' + capsX.amix
      + ' 可选缺失=' + ((capsX.optionalMissing || []).join(',') || '无'));

  const ev = await req('GET', '/v1/events?limit=5');
  T('运行事件（审计）可查询', ev.status === 200 && Array.isArray(ev.json.events) && ev.json.events.length > 0,
    (ev.json.events || []).length + ' 条');

  /* ---------- 订单 ---------- */
  const plans = await req('GET', '/v1/plans');
  T('套餐列表可用', plans.status === 200 && plans.json.plans.length === 4, (plans.json.plans || []).length + ' 个');
  const ordBody = JSON.stringify({ planId: 'standard' });
  const o1 = await req('POST', '/v1/billing/orders', { body: ordBody, headers: { 'Content-Type': 'application/json' } });
  T('下单成功且状态为待支付', o1.status === 201 && o1.json.order.status === 'pending_payment',
    o1.json && o1.json.order.orderNo);
  const o2 = await req('POST', '/v1/billing/orders', { body: ordBody, headers: { 'Content-Type': 'application/json' } });
  T('同套餐重复下单复用同一待支付订单', o2.json.reused === true && o2.json.order.orderNo === o1.json.order.orderNo,
    o2.json && o2.json.order.orderNo);
  const og = await req('GET', '/v1/billing/orders/' + o1.json.order.orderNo);
  T('订单可查询', og.status === 200 && og.json.order.amount === 12800, og.json && String(og.json.order.amount));
  T('支付通道未配置时如实返回 not_configured',
    o1.json.payment.status === 'not_configured', o1.json.payment.message.slice(0, 40));
  const nf = await req('POST', '/v1/billing/notify', { body: '{}', headers: { 'Content-Type': 'application/json' } });
  T('支付回调未配置密钥时明确拒绝', nf.status === 400 && nf.json.code === 'NOT_CONFIGURED', String(nf.status));
  const badPlan = await req('POST', '/v1/billing/orders', { body: JSON.stringify({ planId: 'nope' }), headers: { 'Content-Type': 'application/json' } });
  T('未知套餐被拒绝', badPlan.status === 400 && badPlan.json.code === 'BAD_PLAN', String(badPlan.status));

  /* ---------- GEO（生成式引擎优化）AI 关键词监测 ---------- */
  const gcfg = await req('GET', '/v1/geo/config');
  T('GEO 引擎清单可用（6 个 AI 引擎）', gcfg.status === 200 && gcfg.json.engines.length === 6,
    (gcfg.json.engines || []).map((e) => e.name).join('/'));
  T('GEO 频率选项可用', Array.isArray(gcfg.json.intervals) && gcfg.json.intervals.length >= 4,
    (gcfg.json.intervals || []).join(','));
  T('GEO 种子监测任务已写入', gcfg.json.stats.tasks === 6 && gcfg.json.stats.enabled > 0,
    `共 ${gcfg.json.stats.tasks} 个 · 启用 ${gcfg.json.stats.enabled} 个`);
  T('GEO 未配置上游时如实上报', gcfg.json.upstream && gcfg.json.upstream.configured === false,
    gcfg.json.upstream && gcfg.json.upstream.message);
  /* 通道面板依赖这两个字段判定文案，必须与 mode 自洽 */
  T('GEO config 返回通道判定字段（上游/本地回退）',
    gcfg.json.stats.upstreamConfigured === false && gcfg.json.stats.localAllowed === true &&
    gcfg.json.stats.mode === 'local',
    `upstream=${gcfg.json.stats.upstreamConfigured} local=${gcfg.json.stats.localAllowed} mode=${gcfg.json.stats.mode}`);
  T('GEO config 返回调度器计数（subscribers / nextRunAt）',
    typeof gcfg.json.stats.subscribers === 'number' && typeof gcfg.json.stats.nextRunAt === 'number',
    `subs=${gcfg.json.stats.subscribers} next=${gcfg.json.stats.nextRunAt}`);

  const gTasks = await req('GET', '/v1/geo/tasks');
  T('GEO 任务列表可查询', gTasks.status === 200 && gTasks.json.tasks.length === 6,
    (gTasks.json.tasks || []).length + ' 个');

  const gNew = await req('POST', '/v1/geo/tasks', {
    body: JSON.stringify({ keyword: '奶油风沙发面料 推荐', engines: ['doubao', 'kimi'], every: '30m' }),
    headers: { 'Content-Type': 'application/json' }
  });
  T('GEO 新建监测任务成功', gNew.status === 201 && gNew.json.task.keyword === '奶油风沙发面料 推荐',
    gNew.json && gNew.json.task.id);
  const gNewId = gNew.json && gNew.json.task && gNew.json.task.id;
  T('GEO 任务参数被规范化', gNew.json.task.every === '30m' && gNew.json.task.engines.length === 2,
    `${gNew.json.task.every} · ${gNew.json.task.engines.join('+')}`);

  const gDup = await req('POST', '/v1/geo/tasks', {
    body: JSON.stringify({ keyword: '奶油风沙发面料 推荐' }), headers: { 'Content-Type': 'application/json' }
  });
  T('GEO 重复关键词被拒绝', gDup.status === 409 && gDup.json.code === 'TASK_EXISTS', String(gDup.status));

  const gEmpty = await req('POST', '/v1/geo/tasks', {
    body: JSON.stringify({ keyword: '   ' }), headers: { 'Content-Type': 'application/json' }
  });
  T('GEO 空关键词被拒绝', gEmpty.status === 400 && gEmpty.json.code === 'KEYWORD_REQUIRED', String(gEmpty.status));

  const gOne = await req('GET', '/v1/geo/tasks/' + gNewId);
  T('GEO 单个任务可查询（路由不串）', gOne.status === 200 && gOne.json.task && gOne.json.task.id === gNewId,
    gOne.json && gOne.json.task ? gOne.json.task.id : '无');

  const gPause = await req('PATCH', '/v1/geo/tasks/' + gNewId, {
    body: JSON.stringify({ enabled: false }), headers: { 'Content-Type': 'application/json' }
  });
  T('GEO 任务可暂停', gPause.status === 200 && gPause.json.task.enabled === false, String(gPause.json.task.enabled));

  const gBadPatch = await req('PATCH', '/v1/geo/tasks/nope', {
    body: JSON.stringify({ enabled: true }), headers: { 'Content-Type': 'application/json' }
  });
  T('GEO 不存在任务返回 404', gBadPatch.status === 404, String(gBadPatch.status));

  /* 执行一轮监测 */
  const gMon = await req('POST', '/v1/geo/monitor', {
    body: JSON.stringify({ keyword: '雪尼尔沙发巾 厂家推荐' }), headers: { 'Content-Type': 'application/json' }
  });
  T('GEO 监测轮次可执行', gMon.status === 200 && gMon.json.run && gMon.json.run.results.length === 6,
    gMon.json && gMon.json.run ? `收录 ${gMon.json.run.covered}/${gMon.json.run.results.length} · 来源 ${gMon.json.run.source}` : '无');
  T('GEO 本地探测标记为模拟数据',
    gMon.json.run.source === 'local-simulated',
    gMon.json.run.source);
  T('GEO 结果含引擎/排名/片段结构',
    gMon.json.run.results.every((r) => typeof r.engine === 'string' && typeof r.rank === 'number' && typeof r.status === 'string'),
    JSON.stringify(gMon.json.run.results[0]));

  /* 第二轮 → 变化事件 */
  const gMon2 = await req('POST', '/v1/geo/monitor', {
    body: JSON.stringify({ keyword: '抱枕面料 OEM 定制' }), headers: { 'Content-Type': 'application/json' }
  });
  const gMon3 = await req('POST', '/v1/geo/monitor', {
    body: JSON.stringify({ keyword: '抱枕面料 OEM 定制' }), headers: { 'Content-Type': 'application/json' }
  });
  T('GEO 相同关键词可获得稳定排名（确定性探测）',
    gMon3.status === 200 && gMon3.json.run.results.length === 6, String(gMon3.status));
  const gChanges = await req('GET', '/v1/geo/changes?limit=20');
  T('GEO 变化流可查询', gChanges.status === 200 && Array.isArray(gChanges.json.changes),
    (gChanges.json.changes || []).length + ' 条');
  T('GEO 变化事件结构完整', (gChanges.json.changes || []).every((c) => c.keyword && c.engine && c.kind && c.text),
    JSON.stringify((gChanges.json.changes || [])[0] || {}));

  const gRuns = await req('GET', '/v1/geo/runs?limit=5');
  T('GEO 运行记录可查询', gRuns.status === 200 && gRuns.json.runs.length >= 3,
    (gRuns.json.runs || []).length + ' 条');

  const gHist = await req('GET', '/v1/geo/history?keyword=' + encodeURIComponent('雪尼尔沙发巾 厂家推荐'));
  T('GEO 排名历史可查询', gHist.status === 200 && gHist.json.points.length === 6,
    (gHist.json.points || []).length + ' 个落点');

  const gOverview = await req('GET', '/v1/geo/overview');
  T('GEO 总览接口可用', gOverview.status === 200 && typeof gOverview.json.coverageRate === 'number',
    '覆盖率 ' + gOverview.json.coverageRate + '%');

  const gPlan = await req('POST', '/v1/geo/plan', {
    body: JSON.stringify({ keyword: '荷兰绒沙发套' }), headers: { 'Content-Type': 'application/json' }
  });
  T('GEO 内容方案可生成', gPlan.status === 200 && gPlan.json.plan.length === 4,
    (gPlan.json.plan || []).map((p) => p.priority + p.type).join(' / '));
  T('GEO 方案选题已代入关键词', /荷兰绒沙发套/.test(gPlan.json.plan[0].items[0]), gPlan.json.plan[0].items[0]);

  /* SSE 实时通道 */
  const sse = await new Promise((resolve) => {
    const r = http.request({ host: HOST, port: PORT, method: 'GET', path: '/v1/geo/stream', agent: false }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d.toString('utf8');
        if (/event: hello/.test(buf)) { resolve({ status: res.statusCode, ct: res.headers['content-type'], buf }); try { r.destroy(); } catch (e) {} }
      });
      setTimeout(() => resolve({ status: res.statusCode, ct: res.headers['content-type'], buf }), 2500);
    });
    r.on('error', () => resolve({ status: 0, buf: '' }));
    r.end();
  });
  T('GEO SSE 通道建立并推送握手事件',
    sse.status === 200 && /text\/event-stream/.test(String(sse.ct)) && /event: hello/.test(sse.buf),
    String(sse.ct));

  const gDel = await req('DELETE', '/v1/geo/tasks/' + gNewId);
  T('GEO 任务可删除', gDel.status === 200, String(gDel.status));
  T('GEO 删除后查询返回 404', (await req('GET', '/v1/geo/tasks/' + gNewId)).status === 404, '');

  /* ---------- GEO 纯函数（未配置上游 → 明确 501，不静默造数） ---------- */
  const geoMod = require('../geo');
  const upstreamRes = await geoMod.monitor({ keyword: 'x', engines: ['doubao'] });
  T('GEO 未配置上游时返回 501 而非空数据',
    upstreamRes.status === 501 && upstreamRes.body.code === 'UPSTREAM_NOT_CONFIGURED' && /GEO_UPSTREAM/.test(upstreamRes.body.message),
    upstreamRes.body.code);
  const d1 = geoMod.diff(null, [{ engine: 'doubao', rank: 3, status: 'covered' }], 'kw');
  T('GEO 变化检测：首轮识别为新收录', d1.length === 1 && d1[0].kind === 'new' && d1[0].to === 3, JSON.stringify(d1[0]));
  const d2 = geoMod.diff({ doubao: { rank: 8 } }, [{ engine: 'doubao', rank: 2, status: 'covered' }], 'kw');
  T('GEO 变化检测：识别排名上升', d2.length === 1 && d2[0].kind === 'up' && d2[0].from === 8 && d2[0].to === 2, JSON.stringify(d2[0]));
  const d3 = geoMod.diff({ doubao: { rank: 1 } }, [{ engine: 'doubao', rank: 0, status: 'absent' }], 'kw');
  T('GEO 变化检测：识别掉出答案', d3.length === 1 && d3[0].kind === 'lost', JSON.stringify(d3[0]));
  const d4 = geoMod.diff({ doubao: { rank: 4 } }, [{ engine: 'doubao', rank: 4, status: 'covered' }], 'kw');
  T('GEO 变化检测：无变化不产事件', d4.length === 0, String(d4.length));
  const norm = geoMod.normalize({ data: { results: [{ engine: 'doubao', position: 5, quote: 'abc' }] } }, { engines: ['doubao', 'kimi'] });
  T('GEO 结果归一化兼容别名与缺省',
    norm.length === 2 && norm[0].rank === 5 && norm[0].snippet === 'abc' && norm[1].status === 'absent',
    JSON.stringify(norm));
  T('GEO 排名状态分档正确',
    geoMod.statusOf(0) === 'absent' && geoMod.statusOf(3) === 'covered' && geoMod.statusOf(9) === 'partial',
    'absent/covered/partial');

  /* ---------- 采集器契约（本实例带 ALLOW_LOCAL_COLLECT，走本地兜底） ---------- */
  const col = await req('POST', '/v1/comments/collect',
    { body: JSON.stringify({ platform: 'douyin', keyword: '沙发面料', limit: 5 }), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' } });
  T('采集本地兜底时返回 200 并明确标注来源',
    col.status === 200 && col.json.source === 'local-simulated' && /模拟/.test(col.json.warning || ''),
    col.json && (col.json.source + ' / ' + col.json.warning));
  T('本地兜底数据条数与 limit 一致', col.status === 200 && col.json.data.comments.length === 5,
    col.json && (col.json.data.comments.length + ' 条'));
  T('本地兜底评论字段完整', col.status === 200 && !!col.json.data.comments[0].nickname
    && !!col.json.data.comments[0].comment && col.json.data.comments[0].platform === 'douyin',
    col.json && col.json.data.comments[0].comment);

  /* =========================================================
     采集定时调度（Cron + 队列 + Worker）
     ========================================================= */
  const ccfg = await req('GET', '/v1/collect/config');
  T('采集调度配置接口可用', ccfg.status === 200 && !!ccfg.json.stats && !!ccfg.json.platforms,
    ccfg.json && JSON.stringify((ccfg.json.stats || {}).mode));
  T('种子调度任务已写入', ccfg.status === 200 && ccfg.json.stats.tasks >= 5,
    ccfg.json && (ccfg.json.stats.tasks + ' 个任务'));
  T('调度模式如实上报为本地模拟', ccfg.json.stats.mode === 'local',
    'mode=' + ccfg.json.stats.mode + ' localAllowed=' + ccfg.json.stats.localAllowed);
  T('调度给出 Cron 预设与频率白名单',
    Array.isArray(ccfg.json.cronPresets) && ccfg.json.cronPresets.length >= 3
    && ccfg.json.intervals.indexOf('1h') > -1,
    ccfg.json.cronPresets.map((x) => x.cron).join(' | '));

  const cList = await req('GET', '/v1/collect/tasks');
  T('调度任务列表可读', cList.status === 200 && Array.isArray(cList.json.tasks),
    cList.json.tasks.length + ' 个');

  const cNew = await req('POST', '/v1/collect/tasks',
    { body: JSON.stringify({ keyword: '荷兰绒 沙发套 定做', platform: 'sph', every: '30m', limit: 12 }), headers: { 'Content-Type': 'application/json' } });
  const cTask = cNew.json && cNew.json.task;
  T('新建调度任务（固定间隔）返回 201', cNew.status === 201 && !!cTask, `http=${cNew.status} ${cTask && cTask.id}`);
  T('新建后已排期并归一化参数',
    !!cTask && cTask.nextRunAt > Date.now() && cTask.limit === 12 && cTask.every === '30m' && cTask.enabled === true,
    cTask && ('下次 ' + new Date(cTask.nextRunAt).toISOString()));

  const cDup = await req('POST', '/v1/collect/tasks',
    { body: JSON.stringify({ keyword: '荷兰绒 沙发套 定做', platform: 'sph', every: '30m' }), headers: { 'Content-Type': 'application/json' } });
  T('同关键词同平台重复新建返回 409', cDup.status === 409 && cDup.json.code === 'TASK_EXISTS', cDup.json && cDup.json.code);

  const cCron = await req('POST', '/v1/collect/tasks',
    { body: JSON.stringify({ keyword: 'cron 排期任务', platform: 'douyin', cron: '0 9 * * 1-5' }), headers: { 'Content-Type': 'application/json' } });
  const cCronTask = cCron.json && cCron.json.task;
  T('新建调度任务（Cron）可用', cCron.status === 201 && !!cCronTask && cCronTask.cron === '0 9 * * 1-5',
    cCronTask && cCronTask.scheduleText);
  T('Cron 任务排到未来某天',
    !!cCronTask && cCronTask.nextRunAt > Date.now() && cCronTask.nextRunAt < Date.now() + 8 * 86400000,
    cCronTask && new Date(cCronTask.nextRunAt).toISOString());

  const cBad = await req('POST', '/v1/collect/tasks',
    { body: JSON.stringify({ keyword: '坏表达式', cron: '* * * *' }), headers: { 'Content-Type': 'application/json' } });
  T('非法 Cron 被拒绝', cBad.status === 400 && cBad.json.code === 'CRON_FIELDS', cBad.json && cBad.json.code);

  const cEmpty = await req('POST', '/v1/collect/tasks',
    { body: JSON.stringify({ keyword: '   ' }), headers: { 'Content-Type': 'application/json' } });
  T('空关键词被拒绝', cEmpty.status === 400 && cEmpty.json.code === 'KEYWORD_REQUIRED', cEmpty.json && cEmpty.json.code);

  const cTiny = await req('POST', '/v1/collect/tasks',
    { body: JSON.stringify({ keyword: '过密', every: '10s' }), headers: { 'Content-Type': 'application/json' } });
  T('过短间隔被拒绝（保护上游配额）', cTiny.status === 400 && cTiny.json.code === 'EVERY_TOO_SMALL', cTiny.json && cTiny.json.code);

  const cPrev = await req('POST', '/v1/collect/preview',
    { body: JSON.stringify({ cron: '0 9,15,21 * * *' }), headers: { 'Content-Type': 'application/json' } });
  T('排期预览返回未来 5 次时刻',
    cPrev.status === 200 && Array.isArray(cPrev.json.times) && cPrev.json.times.length === 5
    && cPrev.json.times.every((t) => t > Date.now()),
    cPrev.json && (cPrev.json.schedule || {}).text);
  const cPrevBad = await req('POST', '/v1/collect/preview',
    { body: JSON.stringify({ cron: 'nope nope' }), headers: { 'Content-Type': 'application/json' } });
  T('排期预览对非法表达式返回 400', cPrevBad.status === 400, cPrevBad.json && cPrevBad.json.code);

  /* ---- 立即执行一轮（本地模拟通道，如实标注 simulated） ---- */
  const cRun = await req('POST', '/v1/collect/tasks/' + encodeURIComponent(cTask.id) + '/run', { body: '{}', headers: { 'Content-Type': 'application/json' } });
  const run1 = cRun.json && cRun.json.run;
  T('立即执行一轮成功', cRun.status === 200 && run1 && run1.status === 'ok', run1 && `fresh=${run1.fresh} got=${run1.got}`);
  T('模拟数据被如实标注来源',
    !!run1 && run1.source === 'local-simulated' && run1.simulated === true,
    run1 && (run1.source + ' simulated=' + run1.simulated));
  T('执行耗时被记录', !!run1 && typeof run1.ms === 'number' && run1.ms >= 0, run1 && (run1.ms + 'ms'));

  const cRun2 = await req('POST', '/v1/collect/tasks/' + encodeURIComponent(cTask.id) + '/run', { body: '{}', headers: { 'Content-Type': 'application/json' } });
  const run2 = cRun2.json && cRun2.json.run;
  T('第二轮对重复评论做指纹去重',
    !!run2 && typeof run2.dup === 'number' && run2.dup >= 0 && (run2.fresh + run2.dup) === run2.got,
    run2 && `got=${run2.got} fresh=${run2.fresh} dup=${run2.dup}`);

  const cRuns = await req('GET', '/v1/collect/runs?limit=5');
  T('运行记录可读且倒序', cRuns.status === 200 && cRuns.json.runs.length >= 2
    && Date.parse(cRuns.json.runs[0].at) >= Date.parse(cRuns.json.runs[1].at),
    cRuns.json.runs.length + ' 条');

  const cLeads = await req('GET', '/v1/collect/leads?limit=5');
  T('线索池已入池且给出总数', cLeads.status === 200 && cLeads.json.total >= 1,
    'total=' + cLeads.json.total);
  T('线索字段完整（平台/关键词/评论/指纹）',
    !!cLeads.json.leads[0] && !!cLeads.json.leads[0].fp && !!cLeads.json.leads[0].keyword
    && !!cLeads.json.leads[0].comment && cLeads.json.leads[0].platform === 'sph',
    cLeads.json.leads[0] && cLeads.json.leads[0].comment.slice(0, 20));
  const cLeadsDedup = cLeads.json.leads.map((l) => l.fp);
  T('线索池内指纹唯一（无重复入库）', new Set(cLeadsDedup).size === cLeadsDedup.length, cLeadsDedup.length + ' 条');

  /* ---- 启停 / 改频率 / 删除 ---- */
  const cPause = await req('PATCH', '/v1/collect/tasks/' + encodeURIComponent(cCronTask.id),
    { body: JSON.stringify({ enabled: false }), headers: { 'Content-Type': 'application/json' } });
  T('停用任务后清空下次执行', cPause.status === 200 && cPause.json.task.enabled === false && cPause.json.task.nextRunAt === 0,
    'nextRunAt=' + cPause.json.task.nextRunAt);

  const cFreq = await req('PATCH', '/v1/collect/tasks/' + encodeURIComponent(cCronTask.id),
    { body: JSON.stringify({ every: '2h', enabled: true }), headers: { 'Content-Type': 'application/json' } });
  T('改成固定间隔后重新排期',
    cFreq.status === 200 && cFreq.json.task.every === '2h' && cFreq.json.task.cron === ''
    && cFreq.json.task.nextRunAt > Date.now(),
    cFreq.json.task.scheduleText);

  const cBadPatch = await req('PATCH', '/v1/collect/tasks/' + encodeURIComponent(cCronTask.id),
    { body: JSON.stringify({ cron: '99 99 * * *' }), headers: { 'Content-Type': 'application/json' } });
  T('改成非法排期被拒绝', cBadPatch.status === 400, cBadPatch.json && cBadPatch.json.code);

  const cOne = await req('GET', '/v1/collect/tasks/' + encodeURIComponent(cTask.id));
  T('单任务详情带最近运行记录', cOne.status === 200 && cOne.json.task.id === cTask.id && Array.isArray(cOne.json.runs),
    cOne.json.runs.length + ' 条运行记录');

  const cTick = await req('POST', '/v1/collect/tick', { body: '{}', headers: { 'Content-Type': 'application/json' } });
  T('手动巡检接口可用', cTick.status === 200 && typeof cTick.json.executed === 'number',
    '本轮执行 ' + cTick.json.executed + ' 个');

  const cDel = await req('DELETE', '/v1/collect/tasks/' + encodeURIComponent(cTask.id));
  T('删除调度任务成功', cDel.status === 200 && cDel.json.removed === cTask.id, '剩余 ' + cDel.json.stats.tasks + ' 个');
  const cDel2 = await req('DELETE', '/v1/collect/tasks/' + encodeURIComponent(cTask.id));
  T('重复删除返回 404', cDel2.status === 404, cDel2.json && cDel2.json.code);
  const cUnknown = await req('GET', '/v1/collect/nope');
  T('未知调度子路由返回 404', cUnknown.status === 404, cUnknown.json && cUnknown.json.code);

  /* =========================================================
     schedule.js 纯函数单测（不依赖服务进程）
     ========================================================= */
  const sch = require('../schedule');
  T('间隔换算：语义档位与纯秒数',
    sch.everyMs('15m') === 900000 && sch.everyMs('realtime') === 60000
    && sch.everyMs('600') === 600000 && sch.everyMs('2h') === 7200000
    && sch.everyMs('30分钟') === 1800000 && sch.everyMs('乱写') === 0,
    '15m/realtime/600/2h/30分钟');

  const T0 = Date.parse('2026-10-13T09:03:20+08:00');
  T('cron 步长排期正确', sch.nextCron('*/15 * * * *', T0) === Date.parse('2026-10-13T09:15:00+08:00'),
    new Date(sch.nextCron('*/15 * * * *', T0)).toISOString());
  T('cron 工作日排期正确', sch.nextCron('0 9 * * 1-5', T0) === Date.parse('2026-10-14T09:00:00+08:00'),
    new Date(sch.nextCron('0 9 * * 1-5', T0)).toISOString());
  T('cron 每月定点排期正确', sch.nextCron('30 2 1 * *', T0) === Date.parse('2026-11-01T02:30:00+08:00'),
    new Date(sch.nextCron('30 2 1 * *', T0)).toISOString());
  T('cron 闰年 2/29 可解', sch.nextCron('0 0 29 2 *', T0) === Date.parse('2028-02-29T00:00:00+08:00'),
    new Date(sch.nextCron('0 0 29 2 *', T0)).toISOString());
  T('cron 永不匹配时返回 0 而不是死循环', sch.nextCron('0 0 31 2 *', T0) === 0, '返回 0');
  T('cron 周日 7 等价于 0', sch.nextCron('0 8 * * 7', T0) === sch.nextCron('0 8 * * 0', T0), '等价');
  T('cron 月/周英文简写可用', sch.nextCron('0 0 * * sun', T0) === Date.parse('2026-10-18T00:00:00+08:00'),
    new Date(sch.nextCron('0 0 * * sun', T0)).toISOString());
  T('cron 描述可读', /每周一/.test(sch.describeCron('0 9 * * 1-5')) && /每 6 小时/.test(sch.describeCron('0 */6 * * *'))
    && /每月 1\/15 号/.test(sch.describeCron('0 0 1,15 * *')),
    sch.describeCron('0 9 * * 1-5') + ' / ' + sch.describeCron('0 */6 * * *'));
  T('cron 段数与越界被拒绝',
    (() => { try { sch.parseCron('* * * *'); return false; } catch (e) { return e.code === 'CRON_FIELDS'; } })()
    && (() => { try { sch.parseCron('99 * * * *'); return false; } catch (e) { return e.code === 'CRON_RANGE'; } })(),
    'CRON_FIELDS / CRON_RANGE');
  T('排期校验：非法与非法规格都给出明确错误码',
    sch.validateSchedule({ every: 'zzz' }).code === 'EVERY_INVALID'
    && sch.validateSchedule({ every: '10s' }).code === 'EVERY_TOO_SMALL'
    && sch.validateSchedule({ cron: '0 9 * * *' }).ok === true,
    'EVERY_INVALID / EVERY_TOO_SMALL / ok');
  T('nextRun 优先 cron、否则按间隔顺推',
    sch.nextRun({ cron: '0 9 * * *' }, T0) === Date.parse('2026-10-14T09:00:00+08:00')
    && sch.nextRun({ every: '1h' }, T0) === T0 + 3600000,
    'cron 优先');
  T('preview 返回严格递增的 5 个时刻',
    (() => { const p = sch.preview({ cron: '0 9 * * *' }, 5, T0); return p.length === 5 && p.every((v, i) => i === 0 || v > p[i - 1]); })(),
    '递增');

  /* =========================================================
     config.js 环境变量收口（开发模式：告警不阻断）
     ========================================================= */
  const cfgMod = require('../config');
  const snap = cfgMod.snapshot();
  T('开发模式下不阻断启动', snap.production === false && snap.guard.ok === true,
    'mode=' + snap.mode + ' blockers=' + snap.guard.blocked);
  T('未设 API_TOKEN 时给出告警与修复命令',
    snap.guard.violationKeys.indexOf('API_TOKEN') > -1
    && snap.guard.violations.some((v) => /openssl rand/.test(v.fix)),
    'violations=' + snap.guard.violationKeys.join(','));
  T('服务端 health 如实标出本实例开着两个危险开关',
    !!health.config && health.config.flags.ALLOW_LOCAL_COLLECT === true
    && health.config.flags.ALLOW_LOCAL_GEO === true
    && health.config.guard.violationKeys.indexOf('ALLOW_LOCAL_COLLECT') > -1
    && health.config.guard.violationKeys.indexOf('ALLOW_LOCAL_GEO') > -1,
    health.config && health.config.guard.violationKeys.join(','));

  /* 直接注入生产环境变量，验证「四项阻断全部点名 + 每项都带修复命令」 */
  const prodSnap = withEnv({
    NODE_ENV: 'production', API_TOKEN: '',
    QA_MODE: '1', ALLOW_LOCAL_COLLECT: '1', ALLOW_LOCAL_GEO: '1'
  }, () => cfgMod.snapshot());
  T('生产模式下四项阻断被全部点名',
    prodSnap.guard.blocked === 4 && prodSnap.guard.ok === false
    && ['API_TOKEN', 'QA_MODE', 'ALLOW_LOCAL_COLLECT', 'ALLOW_LOCAL_GEO'].every((k) => prodSnap.guard.violationKeys.indexOf(k) > -1),
    'blocked=' + prodSnap.guard.blocked + ' ' + prodSnap.guard.violationKeys.join(','));
  T('每个阻断项都给出可执行的修复方式',
    prodSnap.guard.violations.filter((v) => v.severity === 'block').every((v) => !!v.fix),
    prodSnap.guard.actionable.join(' ; ').slice(0, 96));
  T('生产模式未设 DATA_DIR 被列为告警（容器重建即丢数据）',
    prodSnap.guard.violationKeys.indexOf('DATA_DIR') > -1
    && prodSnap.guard.violations.filter((v) => v.key === 'DATA_DIR')[0].severity === 'warn',
    'warnings=' + prodSnap.guard.warnings);

  /* HOST 告警只在「对外可达 + 未声明反代」时才出现，所以必须单独构造该场景 */
  const exposeEnv = {
    NODE_ENV: 'production', API_TOKEN: 'x'.repeat(48),
    QA_MODE: '', ALLOW_LOCAL_COLLECT: '', ALLOW_LOCAL_GEO: '',
    DATA_DIR: path.join(DATA_DIR, 'prod-expose'), HOST: '0.0.0.0'
  };
  const exposeSnap = withEnv(Object.assign({ TRUST_PROXY: '' }, exposeEnv), () => cfgMod.snapshot());
  T('生产模式监听 0.0.0.0 且未声明 TRUST_PROXY 被列为告警',
    exposeSnap.guard.violationKeys.indexOf('HOST') > -1 && exposeSnap.guard.blocked === 0,
    'warnings=' + exposeSnap.guard.warnings + ' keys=' + exposeSnap.guard.violationKeys.join(','));
  T('声明 TRUST_PROXY 后该告警消失（收口干净）',
    withEnv(Object.assign({ TRUST_PROXY: '1' }, exposeEnv), () => cfgMod.snapshot())
      .guard.violationKeys.indexOf('HOST') === -1,
    'ok');
  const devSnap = withEnv({ NODE_ENV: 'development', API_TOKEN: 'x'.repeat(48), QA_MODE: '', ALLOW_LOCAL_COLLECT: '', ALLOW_LOCAL_GEO: '' },
    () => cfgMod.snapshot());
  T('收口干净时无阻断无告警', devSnap.guard.ok === true && devSnap.guard.warnings === 0,
    'violations=' + (devSnap.guard.violationKeys.join(',') || '无'));

  T('敏感值已脱敏（不回显完整令牌）',
    withEnv({ API_TOKEN: 'abcdefghijklmnopqrstuvwxyz0123456789' }, () => cfgMod.snapshot()).token.masked.indexOf('****') > -1,
    withEnv({ API_TOKEN: 'abcdefghijklmnopqrstuvwxyz0123456789' }, () => cfgMod.snapshot()).token.masked);
  T('health 暴露的收口结论与快照一致',
    !!health.config && health.config.guard.ok === true && health.config.mode === 'development',
    'mode=' + (health.config && health.config.mode));

  /* =========================================================
     ffmpeg 能力探测与渲染字体（生产环境的两大隐性坑）
     ========================================================= */
  T('FFmpeg 能力探测已暴露在 health',
    !!(health.ffmpeg && health.ffmpeg.capabilities) && health.ffmpeg.capabilities.ready === true,
    health.ffmpeg && health.ffmpeg.capabilities
      ? ('缺 ' + (health.ffmpeg.capabilities.missing.join(',') || '无'))
      : '未暴露');
  T('libx264 / aac / drawtext / zoompan / concat 齐备',
    ['libx264', 'aac', 'drawtext', 'zoompan', 'concat'].every((k) => health.ffmpeg.capabilities[k]),
    'required=' + health.ffmpeg.capabilities.required.join('/'));
  T('渲染字体状态已暴露且含中文字形',
    !!(health.ffmpeg && health.ffmpeg.font) && health.ffmpeg.font.ok === true,
    health.ffmpeg && health.ffmpeg.font ? (health.ffmpeg.font.path + ' cjk=' + health.ffmpeg.font.cjk) : '未暴露');

  /* =========================================================
     未接通道的实例：必须明确 501，且绝不生成假数据
     ========================================================= */
  await withServer({ ALLOW_LOCAL_COLLECT: '', ALLOW_LOCAL_GEO: '', COLLECT_NO_SEED: '1' }, async (port, h) => {
    T('未接通道实例自述 unconfigured（采集）', h.collect.mode === 'unconfigured',
      'mode=' + h.collect.mode + ' localAllowed=' + h.collect.localAllowed);
    T('未接通道实例自述 unconfigured（GEO）', h.geo.mode === 'unconfigured', 'mode=' + h.geo.mode);

    const c1 = await req('POST', '/v1/comments/collect', {
      port, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'douyin', keyword: '沙发面料', limit: 5 })
    });
    T('采集上游未配置时返回 501 并给出配置指引',
      c1.status === 501 && c1.json.code === 'UPSTREAM_NOT_CONFIGURED' && /COLLECT_UPSTREAM/.test(c1.json.message),
      c1.json && c1.json.code);

    const mk = await req('POST', '/v1/collect/tasks', {
      port, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: '未接通道测试', platform: 'douyin', every: '1h' })
    });
    T('未接通道时仍可创建调度任务（只是不会产出数据）', mk.status === 201 && !!mk.json.task.id,
      mk.json && mk.json.task.id);
    const tid = mk.json.task.id;

    const r1 = await req('POST', '/v1/collect/tasks/' + encodeURIComponent(tid) + '/run',
      { port, headers: { 'Content-Type': 'application/json' }, body: '{}' });
    T('上游未配置时立即执行被拒（501，不伪造数据）',
      r1.status === 501 && r1.json.code === 'UPSTREAM_NOT_CONFIGURED', r1.json && r1.json.code);

    const tk = await req('POST', '/v1/collect/tick', { port, headers: { 'Content-Type': 'application/json' }, body: '{}' });
    T('未接通道时自动巡检执行 0 个任务', tk.status === 200 && tk.json.executed === 0, 'executed=' + tk.json.executed);

    const lz = await req('GET', '/v1/collect/leads?limit=5', { port });
    T('未接通道时线索池保持为空（没有假数据）', lz.status === 200 && lz.json.total === 0, 'total=' + lz.json.total);

    const rz = await req('GET', '/v1/collect/runs?limit=5', { port });
    T('未接通道时不留运行记录（不虚报成功）', rz.status === 200 && rz.json.runs.length === 0, rz.json.runs.length + ' 条');
  });

  /* =========================================================
     多通道采集：自有内容评论区（官方）与自建爬虫并存
     ---------------------------------------------------------
     构造「已接入爬虫、未接入官方与供应商」的实例，验证：
       · 通道清单如实上报配置态与缺失的环境变量
       · ?probe=1 真的去连上游，并把不可达如实报出来
       · 任务默认 auto，在 keyword 范围下跳过未接入的供应商落到爬虫
       · 显式指定未接入的通道 → 501，且绝不降级成模拟数据
       · 通道 × 范围的非法组合在任务创建阶段就被拒
       · 指定官方通道时 scope 自动纠为 own
     ========================================================= */
  await withServer({
    ALLOW_LOCAL_COLLECT: '', ALLOW_LOCAL_GEO: '', COLLECT_NO_SEED: '1',
    COLLECT_CRAWLER_URL: 'http://127.0.0.1:1', COLLECT_OFFICIAL_URL: '', COLLECT_UPSTREAM: ''
  }, async (port, h) => {
    T('接入一条真实通道后模式转为 upstream', h.collect.mode === 'upstream', 'mode=' + h.collect.mode);

    const chz = await req('GET', '/v1/collect/channels', { port });
    T('通道清单接口列出四条通道',
      chz.status === 200 && chz.json.channels.length === 4,
      (chz.json.channels || []).map((c) => c.id).join(','));
    const byId = {};
    (chz.json.channels || []).forEach((c) => { byId[c.id] = c; });
    T('已配置的通道如实报 configured 且无缺失项',
      byId.crawler && byId.crawler.configured === true && byId.crawler.missing.length === 0,
      'crawler configured=' + (byId.crawler && byId.crawler.configured));
    T('未配置的通道点名缺失的环境变量',
      byId.vendor && byId.vendor.configured === false && byId.vendor.missing.indexOf('COLLECT_UPSTREAM') > -1,
      (byId.vendor && byId.vendor.missing.join('/')) || '—');

    const pr = await req('GET', '/v1/collect/channels?probe=1', { port });
    T('探测模式真的连上游并如实返回不可达',
      pr.status === 200 && pr.json.probed === true && pr.json.probe.length === 1 && pr.json.probe[0].ok === false,
      'probe=' + ((pr.json.probe[0] || {}).id) + ' ok=' + ((pr.json.probe[0] || {}).ok));

    const auto = await req('POST', '/v1/collect/tasks', {
      port, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: '自动选通道', platform: 'douyin', every: '1h' })
    });
    T('任务默认通道 auto、默认范围 auto（不写死具体通道）',
      auto.status === 201 && auto.json.task.channel === 'auto' && auto.json.task.scope === 'auto',
      auto.json.task.channel + '/' + auto.json.task.scope);

    const one = await req('POST', '/v1/collect/tasks', {
      port, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: '指定爬虫', platform: 'douyin', every: '1h', channel: 'crawler', scope: 'keyword' })
    });
    T('任务可显式指定采集通道与范围',
      one.status === 201 && one.json.task.channel === 'crawler' && one.json.task.scope === 'keyword',
      one.json.task.channel + '/' + one.json.task.scope);

    const op = await req('POST', '/v1/comments/collect', {
      port, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'douyin', keyword: '自有内容', channel: 'official', scope: 'own' })
    });
    T('显式指定未接入的通道 → 501 且不降级成模拟数据',
      op.status === 501 && op.json.code === 'CHANNEL_NOT_CONFIGURED' && /COLLECT_OFFICIAL_URL/.test(op.json.message),
      op.json.code);

    const unk = await req('POST', '/v1/comments/collect', {
      port, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'douyin', keyword: 'x', channel: 'nope' })
    });
    T('未知采集通道被拒绝', unk.status === 501 && unk.json.code === 'CHANNEL_UNKNOWN', unk.json.code);

    const badMix = await req('POST', '/v1/collect/tasks', {
      port, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: '非法组合', platform: 'douyin', channel: 'vendor', scope: 'own' })
    });
    T('通道与范围不匹配在任务创建阶段即被拒',
      badMix.status === 400 && badMix.json.code === 'SCOPE_UNSUPPORTED', badMix.json.code);

    const badCh = await req('POST', '/v1/collect/tasks', {
      port, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: '非法通道', platform: 'douyin', channel: 'selenium' })
    });
    T('未知通道在任务创建阶段即被拒', badCh.status === 400 && badCh.json.code === 'CHANNEL_INVALID', badCh.json.code);

    const offTask = await req('POST', '/v1/collect/tasks', {
      port, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: '官方自有内容', platform: 'douyin', channel: 'official', scope: 'auto' })
    });
    T('指定官方通道时范围自动纠为 own（官方只能读自有内容）',
      offTask.status === 201 && offTask.json.task.scope === 'own', offTask.json.task.scope);

    /* 爬虫地址故意指向 127.0.0.1:1（必然拒连）→ 必须如实失败 */
    const run = await req('POST', '/v1/collect/tasks/' + encodeURIComponent(one.json.task.id) + '/run',
      { port, headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const rn = (run.json && run.json.run) || {};
    T('爬虫不可达时如实失败，不伪造成功也不回落模拟',
      rn.status === 'failed' && rn.simulated === false && rn.reason === 'UPSTREAM_UNREACHABLE',
      rn.status + ' / ' + rn.reason + ' simulated=' + rn.simulated);
    T('运行记录标注本次使用的通道与范围',
      rn.channel === 'crawler' && rn.scope === 'keyword', rn.channel + '/' + rn.scope);

    const runOff = await req('POST', '/v1/collect/tasks/' + encodeURIComponent(offTask.json.task.id) + '/run',
      { port, headers: { 'Content-Type': 'application/json' }, body: '{}' });
    T('任务指定了未接入的通道 → 记 failed（配置错误不掩盖成「未接通道」）',
      !!runOff.json.run && runOff.json.run.status === 'failed' && runOff.json.run.reason === 'CHANNEL_NOT_CONFIGURED',
      (runOff.json.run || {}).status + ' / ' + (runOff.json.run || {}).reason);

    const lst = await req('GET', '/v1/collect/tasks', { port });
    T('任务列表回带通道与范围，任务分布可统计',
      lst.status === 200 && Array.isArray(lst.json.tasks)
      && !!lst.json.stats.tasksByChannel
      && lst.json.stats.tasksByChannel.crawler >= 1,
      JSON.stringify(lst.json.stats.tasksByChannel));

    const hz = await req('GET', '/v1/health', { port });
    T('health 暴露多通道清单与未接通道的缺失项',
      !!(hz.json.collector && Array.isArray(hz.json.collector.channels))
      && !!hz.json.collect
      && Array.isArray(hz.json.collect.channels),
      '通道数=' + ((hz.json.collect.collect === undefined && (hz.json.collector.channels || []).length) || 0));
  });

  /* =========================================================
     调度器单元级：核心不变量「未接通道绝不自动执行」
     （比接口层更直接：把任务强制改成已到点，看 tick 是否动手）
     ========================================================= */
  const { CollectScheduler } = require('../collect-sched');
  const { Store } = require('../store');
  const unitDir = path.join(DATA_DIR, 'sched-unit');
  fs.mkdirSync(unitDir, { recursive: true });
  const uSched = new CollectScheduler(new Store(path.join(unitDir, 'db.json')), {});
  const mkU = uSched.addTask({ keyword: '单元测试关键词', platform: 'douyin', every: '1h' });
  T('调度器单元：任务可创建并完成排期',
    mkU.ok && mkU.task.nextRunAt > Date.now(), mkU.ok ? mkU.task.scheduleText : mkU.error.message);
  T('调度器单元：纯函数排期与 nextRun 一致（同一语义两条路径）',
    mkU.task.nextRunAt === sch.nextRun(mkU.task, Date.parse(mkU.task.createdAt)),
    new Date(mkU.task.nextRunAt).toISOString());

  mkU.task.nextRunAt = Date.now() - 1000;                    /* 强制到点 */
  const offRuns = await withEnv(
    { ALLOW_LOCAL_COLLECT: '', COLLECT_UPSTREAM: '', COLLECT_TOKEN: '' },
    () => uSched.tick());
  T('调度器单元：通道未接时即使到点也不执行', offRuns === 0, 'executed=' + offRuns);
  T('调度器单元：未接通道不污染线索池', uSched.leads().length === 0, uSched.leads().length + ' 条');
  T('调度器单元：未接通道不留运行记录', uSched.runs().length === 0, uSched.runs().length + ' 条');

  mkU.task.nextRunAt = Date.now() - 1000;
  /* mode 是「读的时候按当前 env 推导」的，所以快照必须落在 withEnv 有效期内取 */
  const onRes = await withEnv({ ALLOW_LOCAL_COLLECT: '1' }, async () => {
    const n = await uSched.tick();
    return { n, st: uSched.stats() };
  });
  T('调度器单元：显式开启本地模拟后按排期执行', onRes.n === 1 && uSched.runs().length === 1,
    'executed=' + onRes.n);
  T('调度器单元：执行后线索入池且任务累计更新',
    uSched.leads().length > 0 && uSched.tasks()[0].total > 0 && uSched.tasks()[0].lastStatus === 'ok',
    '线索 ' + uSched.leads().length + ' 条 · total=' + uSched.tasks()[0].total);
  T('调度器单元：执行后自动推进下次排期',
    uSched.tasks()[0].nextRunAt > Date.now(), new Date(uSched.tasks()[0].nextRunAt).toISOString());
  T('调度器单元：stats 如实汇报通道与进度',
    onRes.st.mode === 'local' && onRes.st.runs === 1 && onRes.st.leads > 0,
    JSON.stringify({ mode: onRes.st.mode, runs: onRes.st.runs, leads: onRes.st.leads }));
  T('调度器单元：撤掉豁免开关后通道自述回落到 unconfigured（不残留 local）',
    uSched.stats().mode === 'unconfigured', 'mode=' + uSched.stats().mode);

  const delRes = uSched.removeTask(mkU.task.id);
  T('调度器单元：删除任务后运行记录与线索保留（可追溯）',
    delRes === true && uSched.tasks().length === 0 && uSched.runs().length === 1 && uSched.leads().length > 0,
    '任务 0 / 运行记录 1 / 线索 ' + uSched.leads().length);

  const badU = uSched.addTask({ keyword: '非法排期', cron: '99 * * * *' });
  T('调度器单元：非法排期在 addTask 阶段即被拒', badU.ok === false && badU.error.code === 'CRON_RANGE',
    badU.ok ? '未拦截' : badU.error.code);

  /* ---------- 采集通道 × 采集范围（纯函数，不依赖上游） ---------- */
  const { normalizeRoute } = require('../collect-sched');
  T('路由归一化：不指定时回落 auto / auto（运行时再按配置决定）',
    normalizeRoute({}).channel === 'auto' && normalizeRoute({}).scope === 'auto', 'auto/auto');
  T('路由归一化：指定官方通道时范围纠为 own（官方只能读自有内容）',
    normalizeRoute({ channel: 'official' }).scope === 'own', 'own');
  T('路由归一化：供应商 + 自有内容范围被拒（其契约里没有 scope）',
    normalizeRoute({ channel: 'vendor', scope: 'own' }).error.code === 'SCOPE_UNSUPPORTED', 'SCOPE_UNSUPPORTED');
  T('路由归一化：未知通道 / 未知范围都被拒',
    normalizeRoute({ channel: 'selenium' }).error.code === 'CHANNEL_INVALID'
    && normalizeRoute({ scope: 'private' }).error.code === 'SCOPE_INVALID', 'CHANNEL_INVALID / SCOPE_INVALID');
  T('路由归一化：本地模拟允许自有内容范围（演示双模式用）',
    normalizeRoute({ channel: 'local', scope: 'own' }).ok === true, 'ok');

  /* =========================================================
     生产守卫：子进程验证「未收口就拒绝启动」
     ========================================================= */
  const guardRun = await runChildExpectExit({
    NODE_ENV: 'production', PORT: String(PORT + 1), DATA_DIR: path.join(DATA_DIR, 'prod1'),
    API_TOKEN: '', QUIET: '1'
  });
  T('生产模式缺 API_TOKEN 时拒绝启动（退出码 78）', guardRun.code === 78,
    'exit=' + guardRun.code);
  T('拒绝启动时打印阻断项与修复方式',
    /API_TOKEN/.test(guardRun.out) && /修复/.test(guardRun.out) && /拒绝启动/.test(guardRun.out),
    guardRun.out.split('\n').filter(Boolean).slice(-1)[0]);

  const guardRun2 = await runChildExpectExit({
    NODE_ENV: 'production', PORT: String(PORT + 2), DATA_DIR: path.join(DATA_DIR, 'prod2'),
    API_TOKEN: '0123456789abcdef0123456789abcdef', QA_MODE: '1', ALLOW_LOCAL_GEO: '1', QUIET: '1'
  });
  T('生产模式带危险开关时拒绝启动', guardRun2.code === 78, 'exit=' + guardRun2.code);
  T('拒绝启动时报出全部阻断项',
    /QA_MODE/.test(guardRun2.out) && /ALLOW_LOCAL_GEO/.test(guardRun2.out),
    guardRun2.out.split('\n').filter((l) => /✗/.test(l)).length + ' 项阻断');
}

/* ---------- 收尾 ---------- */
function cleanup() {
  if (child && !child.killed) { try { child.kill('SIGKILL'); } catch (e) {} }
  setTimeout(() => {
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }, 300);
}

main().then(() => {
  const total = pass + failCount;
  console.log('\n==============================================');
  console.log(` 服务端 + 渲染 Worker 测试：${pass}/${total} 通过`);
  console.log('==============================================\n');
  const fails = R.filter((l) => l.startsWith('FAIL'));
  if (fails.length) { console.log('未通过项：'); fails.forEach((f) => console.log('  ' + f)); console.log(''); }
  try { fs.writeFileSync(path.join(ROOT, '.build', 'server_qa_report.txt'), R.join('\n') + `\n\n合计 ${pass}/${total}\n`, 'utf8'); } catch (e) {}
  cleanup();
  setTimeout(() => process.exit(failCount ? 1 : 0), 500);
}).catch((e) => {
  console.error('\n测试异常终止：', e);
  T('测试运行未抛出异常', false, String((e && e.message) || e));
  cleanup();
  setTimeout(() => process.exit(1), 500);
});
