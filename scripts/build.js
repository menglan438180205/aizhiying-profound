'use strict';
/* =========================================================
   build.js — 前端源码 ⇄ 单文件产物
   ---------------------------------------------------------
   方向已反转（2026-11-08）：
       以前 index.html 是唯一真相，src/ 是只读镜像 —— 改代码要在
       19,025 行里大海捞针，一个全局变量名能被 12 个脚本层同时占用。

       现在 src/ 是唯一真相，index.html 是构建产物：
           src/tpl/index.tpl.html   页面骨架 + 各块占位
           src/js/01..13-*.js       13 个内联脚本层
           src/css/01..05-*.css     5 个样式块

   发布形态完全不变：仍是单个 index.html，deploy/gate 一行都不用改。

   用法：
       node scripts/build.js              src/ → index.html
       node scripts/build.js --extract    index.html → src/（迁移/回捞用）
       node scripts/build.js --check      校验产物与源码是否一致

   --extract 之后必须能 build 回**字节完全相同**的文件，否则说明
   抽取逻辑有损，脚本会直接报错退出。
   ========================================================= */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const SRC = path.join(ROOT, 'src');
const TPL = path.join(SRC, 'tpl', 'index.tpl.html');

/* 顺序即页面里出现的顺序；数量对不上说明页面结构变了，必须人工确认 */
const JS_FILES = [
  'js/01-app.js',
  'js/02-qr.js',
  'js/03-interact.js',
  'js/04-runtime.js',
  'js/05-collect.js',
  'js/06-avatar.js',
  'js/07-matrix.js',
  'js/08-geo3.js',
  'js/09-geosite.js',
  'js/10-colsd.js',
  'js/11-fold.js',
  'js/12-bootguard.js',
  'js/13-llm.js'
];

const CSS_FILES = [
  'css/01-base.css',
  'css/02-geo3.css',
  'css/03-geobuild.css',
  'css/04-skin-bright.css',
  'css/05-refresh.css'
];

const MARK = (rel) => '<!--@bundle:' + rel + '-->';
const MARK_RE = /<!--@bundle:([^>]+?)-->/g;

/* 收集所有内联块（script 内有 src 的跳过，ld+json 也算块） */
function scan(html) {
  const blocks = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    const open = m.index + m[0].indexOf('>') + 1;
    blocks.push({ kind: 'js', start: open, end: open + m[2].length, body: m[2] });
  }
  const re2 = /<style(\s[^>]*)?>([\s\S]*?)<\/style>/g;
  while ((m = re2.exec(html))) {
    const open = m.index + m[0].indexOf('>') + 1;
    blocks.push({ kind: 'css', start: open, end: open + m[2].length, body: m[2] });
  }
  blocks.sort((a, b) => a.start - b.start);

  /* 只保留最外层块。页面里有一段 <style></style> 是写在 JS 字符串模板里的，
     它落在某个 <script> 区间内部；若两块都拆，倒序替换会让外层覆盖内层，
     产物凭空多出十几字节（2026-11-08 实测过，别退回去）。 */
  const outer = [];
  let lastEnd = -1;
  blocks.forEach((b) => {
    if (b.start >= lastEnd) { outer.push(b); lastEnd = b.end; }
    else { console.log('  跳过嵌套块：' + b.kind + ' @' + b.start + '（位于上一块内部）'); }
  });
  return outer;
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function extract() {
  /* 防呆（R5）：迁移完成后 src/ 才是唯一真相，模板里已经带 @bundle 标记。
     这时再按「块数量配对」回捞会把 src/ 覆盖成 index.html 的内容，
     丢失标记结构；必须先备份并显式 --force 才能继续。 */
  if (fs.existsSync(TPL) && /<!--@bundle:/.test(fs.readFileSync(TPL, 'utf8'))) {
    console.error('src/ 已迁移为唯一真相（模板含 <!--@bundle:--> 标记）。');
    console.error('--extract 会用 index.html 覆盖 src/，请先备份 src/，确认后加 --force 重跑。');
    if (process.argv.indexOf('--force') < 0) process.exit(2);
  }
  const html = fs.readFileSync(HTML, 'utf8');
  const blocks = scan(html);
  const js = blocks.filter((b) => b.kind === 'js');
  const css = blocks.filter((b) => b.kind === 'css');

  if (js.length !== JS_FILES.length) {
    console.error('内联脚本块数量不符：页面 ' + js.length + ' 个，映射表 ' + JS_FILES.length + ' 个');
    process.exit(2);
  }
  if (css.length !== CSS_FILES.length) {
    console.error('样式块数量不符：页面 ' + css.length + ' 个，映射表 ' + CSS_FILES.length + ' 个');
    process.exit(2);
  }

  [...JS_FILES, ...CSS_FILES].forEach((rel) => {
    fs.mkdirSync(path.join(SRC, path.dirname(rel)), { recursive: true });
  });

  /* 倒序替换，避免偏移量失效 */
  let out = html;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    const pool = b.kind === 'js' ? js : css;
    const map = b.kind === 'js' ? JS_FILES : CSS_FILES;
    const rel = map[pool.indexOf(b)];
    fs.writeFileSync(path.join(SRC, rel), b.body, 'utf8');
    out = out.slice(0, b.start) + MARK(rel) + out.slice(b.end);
  }

  fs.mkdirSync(path.dirname(TPL), { recursive: true });
  fs.writeFileSync(TPL, out, 'utf8');

  console.log('已拆分：' + js.length + ' 个脚本块 + ' + css.length + ' 个样式块 → src/');
  console.log('模板：src/tpl/index.tpl.html');
  blocks.forEach((b) => {
    const pool = b.kind === 'js' ? js : css;
    const map = b.kind === 'js' ? JS_FILES : CSS_FILES;
    const rel = map[pool.indexOf(b)];
    console.log('  ' + String(Math.round(b.body.length / 1024)).padStart(5) + ' KB  ' + rel);
  });
}

function build(write) {
  if (!fs.existsSync(TPL)) {
    console.error('缺少模板 src/tpl/index.tpl.html，先跑 node scripts/build.js --extract');
    process.exit(2);
  }
  const tpl = fs.readFileSync(TPL, 'utf8');
  const missing = [];
  const out = tpl.replace(MARK_RE, (all, rel) => {
    const p = path.join(SRC, rel);
    if (!fs.existsSync(p)) { missing.push(rel); return all; }
    return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  });
  if (missing.length) {
    console.error('模板引用了不存在的文件：' + missing.join(', '));
    process.exit(2);
  }
  if (write) {
    fs.writeFileSync(HTML, out, 'utf8');
    console.log('已生成 index.html（' + (out.length / 1024).toFixed(0) + ' KB）');
  } else {
    const cur = fs.readFileSync(HTML, 'utf8');
    if (cur === out) {
      console.log('一致：index.html 等于 src/ 构建结果');
      return 0;
    }
    console.error('不一致：index.html 与 src/ 构建结果不同，请跑 node scripts/build.js');
    return 1;
  }
  return 0;
}

function main() {
  const arg = process.argv[2] || '';
  if (arg === '--extract') { extract(); return; }
  if (arg === '--check') { process.exit(build(false)); }
  build(true);
}

main();
