#!/usr/bin/env node
'use strict';
/**
 * 部署前门禁（本地执行，零依赖）
 * ------------------------------------------------------------
 * 上线前必须全绿，任何一项失败即阻断部署。检查三类：
 *   1) 语法：server/*.js 逐个 parse；index.html 内联 <script> 逐个 new Function
 *   2) 标记：关键功能标记必须存在（防止「改了半截」或「回滚成旧版」误上线）
 *   3) 一致性：api 路由里引用的本地模块都存在
 *
 * 用法：node release/gate.js [--quiet]
 * 退出码：0 = 通过；1 = 失败
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const QUIET = process.argv.indexOf('--quiet') > -1;
const fail = [];
const warn = [];

function say() { if (!QUIET) console.log.apply(console, arguments); }

/* ---------------- 1. server js syntax ---------------- */
const srvDir = path.join(ROOT, 'server');
let jsCount = 0;
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (name !== 'node_modules' && name !== '.data') walk(p); continue; }
    if (!name.endsWith('.js')) continue;
    jsCount++;
    const code = fs.readFileSync(p, 'utf8');
    try {
      new vm.Script(code, { filename: p });
    } catch (e) {
      fail.push('SYNTAX server/' + path.relative(srvDir, p) + ' :: ' + e.message);
    }
  }
}
try { walk(srvDir); } catch (e) { fail.push('READ server/ :: ' + e.message); }
say('server js parsed: ' + jsCount);

/* ---------------- 2. index.html inline scripts ---------------- */
const idx = path.join(ROOT, 'index.html');
let html = '';
try { html = fs.readFileSync(idx, 'utf8'); } catch (e) { fail.push('READ index.html :: ' + e.message); }
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, n = 0;
while ((m = re.exec(html))) {
  if (!m[1].trim()) continue;
  n++;
  try { new Function(m[1]); } catch (e) { fail.push('SYNTAX index.html inline#' + n + ' :: ' + e.message); }
}
say('index.html inline scripts checked: ' + n + ' (' + Buffer.byteLength(html, 'utf8') + ' bytes)');

/* ---------------- 3b. 禁止出现的串（回归护栏） ----------------
   index.html 是公开静态资源（任何人 Ctrl+U 就能看到源码）。
   服务端主令牌一旦写进页面，等于把管理密钥公开：能导出客户手机号、批量加微、改风控。
   2026-11-04 已删除内嵌令牌并轮换密钥，这里加护栏防止「图省事」再加回去。 */
const FORBIDDEN = [
  ['data-bff-token-autoload', '前端内嵌服务端令牌的自动注入标记'],
  [/localStorage\.setItem\(\s*['"]pf\.(bff|auth)\.token['"]\s*,\s*['"][0-9a-fA-F]{24,}['"]/,
    '前端硬编码令牌/会话票（形如 setItem("pf.bff.token","<32位十六进制>")）'],
  /* 2026-11-04 决策：自动加微信（GUI RPA）整模块下线，包已归档到 deliverables/wechat-rpa-20261104.zip。
     禁止在前端/服务端重新长回来——真要做，另起独立程序，不要再耦合进本系统。 */
  ['id="v-wechat"', '已下线的自动加微信视图'],
  ['/v1/wechat/', '已下线的自动加微信接口（如需加回，先改这条护栏）']
];
for (const item of FORBIDDEN) {
  const key = item[0], desc = item[1];
  const hit = key instanceof RegExp ? key.test(html) : html.indexOf(key) > -1;
  if (hit) fail.push('FORBIDDEN ' + String(key) + ' (' + desc + ')');
}


/* ---------------- 3. required markers ---------------- */
/* 这些标记代表「当前线上必须具备的功能」。缺任一条说明拿错了版本，
   或某个补丁只在服务器上打过而本地没回捞。 */
const MARKERS = [
  ['pfBootGuard', '启动超时守卫（防卡在「正在进入」）'],
  ['/v1/auth/login', '本地账号登录'],
  ['localAuthWrap', '登录页本地账号入口'],
  ['authToken', '本地会话票优先'],
  ['g3Nav', 'GEO 十一模块导航'],
  ['geo3-layer', 'GEO 控制台前端层'],
  ['/v1/geo2/dashboard', 'GEO 控制台数据接口'],
  ['g3Body', 'GEO 模块内容容器'],
  ['__GEO', 'GEO 兼容层（AI秒搭建站）']
];
for (const item of MARKERS) {
  const key = item[0], desc = item[1], opt = item[2] && item[2].optional;
  const present = html.indexOf(key) > -1;
  if (!present) {
    if (opt) warn.push('OPTIONAL missing ' + key + ' (' + desc + ')');
    else fail.push('MARKER missing ' + key + ' (' + desc + ')');
  }
}
if (!QUIET) {
  const shown = MARKERS.filter(function (x) { return html.indexOf(x[0]) > -1; }).length;
  say('markers present: ' + shown + '/' + MARKERS.length);
}

/* ---------------- 4. server module wiring ---------------- */
/* index.js 里 require('./xxx') 的模块必须真实存在 */
try {
  const serverIndex = fs.readFileSync(path.join(srvDir, 'index.js'), 'utf8');
  const reqRe = /require\('\.\/([A-Za-z0-9_\-\/]+)'\)/g;
  let r;
  const seen = new Set();
  while ((r = reqRe.exec(serverIndex))) {
    const rel = r[1];
    if (seen.has(rel)) continue;
    seen.add(rel);
    const cand = path.join(srvDir, rel);
    if (!fs.existsSync(cand) && !fs.existsSync(cand + '.js')) {
      fail.push('MODULE missing server/' + rel + ' (required by index.js)');
    }
  }
  say('server requires checked: ' + seen.size);
} catch (e) { fail.push('READ server/index.js :: ' + e.message); }

/* ---------------- 5. stale temp files ---------------- */
const stale = fs.readdirSync(ROOT).filter(function (f) {
  return /\.(new|check\.js|tmp-\d+)$/.test(f);
});
if (stale.length) warn.push('STALE local temp files: ' + stale.join(', '));

/* ---------------- report ---------------- */
warn.forEach(function (w) { console.log('WARN  ' + w); });
if (fail.length) {
  console.log('');
  fail.forEach(function (f) { console.log('FAIL  ' + f); });
  console.log('\nGATE FAILED (' + fail.length + ' error' + (fail.length > 1 ? 's' : '') + ')');
  process.exit(1);
}
console.log('\nGATE PASSED');
