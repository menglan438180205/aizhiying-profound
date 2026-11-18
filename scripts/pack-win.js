#!/usr/bin/env node
'use strict';
/**
 * pack-win.js — 生成 Windows Server 部署包
 * -------------------------------------------------------------
 * 用法： node scripts/pack-win.js
 * 产出： release/aizhiying-win-<YYYYMMDD-HHmm>.zip
 *
 * 与 Linux 包的关键差异：
 *   1) 所有文本统一转 CRLF，.cmd/.bat 否则在 Windows 上可能执行异常；
 *   2) .ps1 加 UTF-8 BOM，否则 PowerShell 5.1 把中文按 GBK 解码成乱码；
 *   3) 剔除本地 .env.local —— 它是 HOST=127.0.0.1 的本机配置，
 *      带上会把服务器也绑成回环地址，导致公网访问不了；
 *   4) 剔除 .data（几百 MB 素材与成片）、.build、release 等运行时产物；
 *   5) 剔除 Dockerfile / nginx / *.sh 等 Linux 侧产物，避免误导。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildZip } = require('../server/zip.js');

const ROOT = path.resolve(__dirname, '..');
const EXCLUDE_DIRS = new Set(['.data', '.build', '.data-test', 'archive', 'deliverables', 'node_modules', 'release', '.git', '.workbuddy', '.vscode', '.idea']);
const EXCLUDE_FILES = new Set(['.env.local', '.env', '.DS_Store', 'Thumbs.db']);
const EXCLUDE_PATHS = [
  /^docker-compose\.yml$/,
  /^Dockerfile$/,
  /^\.dockerignore$/,
  /^\.gitignore$/,
  /^\.github\//,
  /^nginx\//,
  /^start-local\.sh$/,
  /^deploy\/[a-z0-9-]+\.sh$/i,
  /^scripts\/shot\.js$/,
  /\.genie$/,
  /^BOOTSTRAP\.md$/,
  // 非商用研究桥：MediaCrawler 导出 → BFF crawler 通道。明确禁止进发布包
  // （MediaCrawler 协议 NON-COMMERCIAL LEARNING LICENSE，禁止商用）。
  /^tools\/mediacrawler-bridge\//,
  // 本机/服务器一次性脚本与联调残留，不进发布包
  /^release\/cleanup-envtest\.js$/,
];

const BIN_EXT = /\.(png|jpe?g|gif|ico|zip|gz|tgz|mp4|mp3|wav|ogg|woff2?|ttf|otf|pdf)$/i;
const TEXT_EXT = /\.(js|json|html?|css|md|txt|ya?ml|csv|svg|env\.example)$/i;

function toCrlf(buf) {
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8');
}

function prep(full, rel) {
  const raw = fs.readFileSync(full);
  if (BIN_EXT.test(rel)) return raw;
  if (/\.ps1$/i.test(rel)) {
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), toCrlf(raw)]);
  }
  if (/\.sh$/i.test(rel)) return raw; // shell 脚本保持 LF
  if (!TEXT_EXT.test(rel) && !/\.(cmd|bat|example|conf)$/i.test(rel)) return raw;
  return toCrlf(raw);
}

function walk(dir, rel, out) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  names.sort();
  for (const name of names) {
    if (name === '.' || name === '..') continue;
    const full = path.join(dir, name);
    const r = rel ? rel + '/' + name : name;
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      if (EXCLUDE_PATHS.some((re) => re.test(r + '/'))) continue;
      out.push({ path: r + '/', dir: true });
      walk(full, r, out);
    } else {
      if (EXCLUDE_FILES.has(name)) continue;
      if (EXCLUDE_PATHS.some((re) => re.test(r))) continue;
      out.push({ path: r, data: prep(full, r), mtime: st.mtime });
    }
  }
}

/* 根目录转发脚本：让用户双击就能用，不用记 deploy\win 路径 */
const SHIMS = {
  'start.cmd': 'start.cmd',
  'stop.cmd': 'stop.cmd',
  'restart.cmd': 'restart.cmd',
  'status.cmd': 'status.cmd',
  'log.cmd': 'log.cmd',
  'run.cmd': 'run.cmd',
  'doctor.cmd': 'doctor.cmd',
};

function shimBody(target) {
  return [
    '@echo off',
    'call "%~dp0deploy\\win\\' + target + '"',
  ].join('\r\n') + '\r\n';
}

const QUICK = [
  'AI 智盈全栈系统 · Windows Server 部署包',
  '============================================================',
  '',
  '【一、首次部署】',
  '  1. 把本压缩包解压到 C:\\aizhiying（保持目录结构）',
  '  2. 管理员身份打开 PowerShell，执行：',
  '       powershell -NoProfile -ExecutionPolicy Bypass -File C:\\aizhiying\\deploy\\win\\setup.ps1',
  '     （脚本会装 Node 22 / FFmpeg、生成 .env.local、开防火墙、注册开机自启）',
  '  3. 腾讯云控制台 → 轻量应用服务器 → 防火墙 → 添加规则：TCP 8787',
  '     ▲ 这步不做，公网一定连不上（云防火墙在 Windows 防火墙之前）',
  '  4. 双击 C:\\aizhiying\\start.cmd',
  '',
  '【二、日常操作】直接双击根目录里的：',
  '  start.cmd    启动（后台常驻，关掉窗口也不停）',
  '  stop.cmd     停止',
  '  restart.cmd  重启（改完 .env.local 后用）',
  '  status.cmd   看状态与端口',
  '  log.cmd      实时看日志',
  '  run.cmd      前台运行（调试时能看到全部输出）',
  '  doctor.cmd   自检：Node / FFmpeg / 配置 / 本地连通',
  '',
  '【三、访问地址】',
  '  setup.ps1 结束时会打印带令牌的完整地址，形如：',
  '  http://118.25.44.79:8787/app/?token=xxxxxxxx',
  '  首次打开会自动写入 HttpOnly Cookie，之后直接访问 IP:8787/app/ 即可。',
  '  换了浏览器/清了 Cookie，用上面那个带 ?token= 的链接再开一次。',
  '',
  '【四、注意】',
  '  · 本机 .env.local 没有被打进包里，服务器那份是 setup.ps1 生成的，',
  '    里面 HOST=0.0.0.0（对外）且带随机 API_TOKEN，不要手工改回 127.0.0.1。',
  '  · 想换端口：改 C:\\aizhiying\\.env.local 的 PORT，然后云防火墙也要同步放行，',
  '    再跑一次 deploy\\win\\firewall.cmd。',
  '  · 视频渲染依赖 FFmpeg；doctor.cmd 里若显示未找到，渲染任务会失败，其它功能不受影响。',
  '',
].join('\r\n') + '\r\n';

function main() {
  console.log('[pack-win] 扫描文件…');
  const entries = [];
  walk(ROOT, '', entries);

  // 语法自检：包里不能有坏 JS
  let bad = 0;
  for (const e of entries) {
    if (!/\.js$/.test(e.path) || e.dir) continue;
    if (/\.build|node_modules/.test(e.path)) continue;
    const tmp = path.join(require('os').tmpdir(), 'packwin-check.js');
    fs.writeFileSync(tmp, e.data);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'ignore' });
    } catch (err) {
      bad++;
      console.log('  ✗ 语法错误： ' + e.path);
    }
  }
  if (bad) {
    console.error('\n[pack-win] 存在 ' + bad + ' 个语法错误，已中止打包。');
    process.exit(1);
  }
  console.log('  ✓ JS 语法自检通过（' + entries.filter((e) => /\.js$/.test(e.path) && !e.dir).length + ' 个文件）');

  for (const [name, target] of Object.entries(SHIMS)) {
    entries.push({ path: name, data: toCrlf(Buffer.from(shimBody(target), 'utf8')) });
  }
  entries.push({ path: 'README-START.txt', data: toCrlf(Buffer.from(QUICK, 'utf8')) });

  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  const out = path.join(ROOT, 'release', 'aizhiying-win-' + stamp + '.zip');
  fs.mkdirSync(path.dirname(out), { recursive: true });

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const buf = buildZip(entries);
  fs.writeFileSync(out, buf);

  const files = entries.filter((e) => !e.dir).length;
  console.log('  ✓ 文件 ' + files + ' 个，目录 ' + (entries.length - files) + ' 个');
  console.log('  ✓ 输出 ' + path.relative(ROOT, out) + '  (' + (buf.length / 1048576).toFixed(2) + ' MB)');
  console.log('\n[pack-win] 完成。');
}

main();
