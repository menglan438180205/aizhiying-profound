'use strict';
/* =========================================================
   preflight.js — 上线前自检（不占端口，可进 CI / K8s initContainer）
   ---------------------------------------------------------
   用法：
     node server/preflight.js              # 人类可读表格
     node server/preflight.js --json       # 机器可读，便于流水线断言
     node server/preflight.js --strict     # 告警也算失败
     NODE_ENV=production node server/preflight.js

   检查项：
     1. 环境变量收口（config.js 的守卫结果）
     2. Node 版本
     3. FFmpeg / FFprobe 可用性与编码/滤镜能力（libx264 / aac / drawtext / zoompan / concat）
     4. 渲染字体（是否找到 + 是否含中文字形；DejaVu 无 CJK，会渲染成豆腐块）
     5. 前端入口 index.html 是否随镜像带出
     6. DATA_DIR 是否可写（含原子写 rename 能力）

   退出码：0 通过 · 1 存在阻断项（或 --strict 下有告警）· 2 参数错误
   ========================================================= */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const ff = require('./ffmpeg');
const renderer = require('./renderer');

const ARGS = process.argv.slice(2);
const AS_JSON = ARGS.indexOf('--json') > -1;
const STRICT = ARGS.indexOf('--strict') > -1;

const NODE_MIN = 18;

/** @type {{level:'ok'|'warn'|'block', key:string, title:string, detail:string}[]} */
const items = [];
const add = (level, key, title, detail) => items.push({ level, key, title, detail: detail || '' });

function checkNode() {
  const major = Number(String(process.version).replace(/^v/, '').split('.')[0]);
  if (!isFinite(major) || major < NODE_MIN) {
    add('block', 'node', 'Node 版本过低', '当前 ' + process.version + '，要求 >= v' + NODE_MIN);
  } else {
    add('ok', 'node', 'Node ' + process.version, process.platform + '/' + process.arch);
  }
}

function checkConfig() {
  const s = config.snapshot();
  add('ok', 'env-mode', '运行模式 ' + s.mode, 'NODE_ENV=' + (process.env.NODE_ENV || '未设置'));
  add(s.token.set ? 'ok' : (s.production ? 'block' : 'warn'),
    'env-token',
    s.token.set ? ('API_TOKEN 已设置 ' + s.token.masked) : 'API_TOKEN 未设置（/v1/* 无鉴权）',
    s.token.set ? '' : 'API_TOKEN=$(openssl rand -hex 24)');
  s.guard.violations.forEach((v) => {
    if (v.key === 'API_TOKEN') return;    /* 上面已有专门一项，避免重复列出 */
    add(v.severity === 'block' ? 'block' : 'warn', 'env-' + v.key, v.key + ' · ' + v.message, v.fix);
  });
  if (!s.guard.violations.length) add('ok', 'env-flags', '危险开关均已关闭', 'QA_MODE / ALLOW_LOCAL_COLLECT / ALLOW_LOCAL_GEO');
  return s;
}

async function checkFfmpeg() {
  const st = await ff.status();
  if (!st.ok) {
    add('block', 'ffmpeg', '未找到 ffmpeg', st.version || '设置 FFMPEG_PATH 指向可执行文件');
    return;
  }
  add('ok', 'ffmpeg', 'ffmpeg 可用', (st.version || '').slice(0, 72));
  add(st.ffprobe ? 'ok' : 'warn', 'ffprobe',
    st.ffprobe ? 'ffprobe 可用' : '未找到 ffprobe（将退化为解析 ffmpeg -i 的 stderr）', '');

  const caps = await ff.capabilities();
  const need = ['libx264', 'aac', 'drawtext', 'zoompan', 'concat'];
  const missing = need.filter((k) => !caps[k]);
  if (missing.length) {
    add('warn', 'ffmpeg-caps', 'FFmpeg 缺少渲染所需能力：' + missing.join(' / '),
      '换成含 libx264 + libfreetype 的完整构建（Debian: ffmpeg；Alpine: ffmpeg 全功能包）');
  } else {
    add('ok', 'ffmpeg-caps', '编码与滤镜能力齐备', need.join(' / '));
  }
}

function checkFont() {
  const f = renderer.fontStatus();
  if (!f.ok) {
    add('warn', 'font', '未找到任何可用字体，成片字幕会被跳过',
      '安装中文字体：apt-get install -y fonts-noto-cjk 或设置 RENDER_FONT=/path/to/font.ttf');
    return;
  }
  if (!f.cjk) {
    add('warn', 'font', '当前字体可能不含中文字形：' + f.path,
      '中文字幕会渲染成方块，请安装 fonts-noto-cjk 并设置 RENDER_FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc');
  } else {
    add('ok', 'font', '渲染字体就绪（含中文字形）', f.path);
  }
}

function checkFrontend() {
  const root = process.env.STATIC_ROOT || path.resolve(__dirname, '..');
  const idx = path.join(root, 'index.html');
  const exists = fs.existsSync(idx);
  const size = exists ? fs.statSync(idx).size : 0;
  add(exists ? 'ok' : 'block', 'frontend',
    exists ? ('前端入口就绪 ' + (size / 1024).toFixed(0) + ' KB') : '未找到 ' + idx,
    exists ? idx : '构建产物 index.html 必须随镜像一起带出（/app 静态托管依赖它）');
}

function checkDataDir() {
  const dir = process.env.DATA_DIR || path.resolve(__dirname, '.data');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.preflight-' + process.pid);
    const tmp = probe + '.tmp';
    fs.writeFileSync(tmp, 'ok', 'utf8');
    fs.renameSync(tmp, probe);           /* 原子写依赖 rename，必须真的试一次 */
    fs.unlinkSync(probe);
    add('ok', 'data-dir', '数据目录可写（含原子 rename）', dir);
  } catch (e) {
    add('block', 'data-dir', '数据目录不可写：' + dir, String((e && e.message) || e));
  }
}

function checkStoragePlan() {
  const dir = process.env.DATA_DIR || path.resolve(__dirname, '.data');
  let free = 0;
  try {
    /* fs.statfs 在 Node 18.15+ 可用；不支持时跳过 */
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(dir);
      free = Number(st.bavail) * Number(st.bsize);
    }
  } catch (e) { /* ignore */ }
  if (free > 0) {
    const gb = free / 1024 / 1024 / 1024;
    add(gb < 2 ? 'warn' : 'ok', 'disk',
      '可用磁盘 ' + gb.toFixed(1) + ' GB', gb < 2 ? '成片与素材都落本机磁盘，空间不足会导致渲染失败' : dir);
  }
}

function render() {
  const blocks = items.filter((i) => i.level === 'block');
  const warns = items.filter((i) => i.level === 'warn');

  if (AS_JSON) {
    process.stdout.write(JSON.stringify({
      ok: blocks.length === 0 && (!STRICT || warns.length === 0),
      strict: STRICT,
      blocked: blocks.length,
      warnings: warns.length,
      items,
      time: new Date().toISOString()
    }, null, 2) + '\n');
    return blocks.length === 0 && (!STRICT || warns.length === 0) ? 0 : 1;
  }

  const icon = { ok: '✓', warn: '⚠', block: '✗' };
  console.log('\n==============================================================');
  console.log(' ProFound · 服务端上线前自检（preflight）');
  console.log('==============================================================');
  items.forEach((i) => {
    console.log(' ' + icon[i.level] + ' ' + String(i.title));
    if (i.detail) console.log('     ' + i.detail);
  });
  console.log('--------------------------------------------------------------');
  console.log(' 阻断 ' + blocks.length + ' 项 · 告警 ' + warns.length + ' 项 · 检查 ' + items.length + ' 项');
  if (blocks.length || (STRICT && warns.length)) {
    console.log(STRICT && !blocks.length
      ? ' 结果：--strict 模式下不允许存在告警，未通过。\n'
      : ' 结果：存在阻断项，禁止上线。\n');
    return 1;
  }
  console.log(' 结果：通过，可以启动服务。\n');
  return 0;
}

(async function main() {
  checkNode();
  checkConfig();
  await checkFfmpeg();
  checkFont();
  checkFrontend();
  checkDataDir();
  checkStoragePlan();
  const code = render();
  /* enforce 只在生产下才会真的抛错，这里显式跑一次，把守卫语义带进 CI */
  if (config.isProduction()) {
    try { config.enforce(); }
    catch (e) {
      if (!AS_JSON) console.error(' \u2717 ' + e.message + '\n');
      process.exit(1);
    }
  }
  process.exit(code);
})();
