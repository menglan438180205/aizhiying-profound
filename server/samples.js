'use strict';
/**
 * 内置示例素材（真实图片）
 *
 * 为什么需要这个模块
 * ------------------
 * 「一键智能剪辑」要产出**可播放的真实成片**，前提是有一份能被 FFmpeg 解码的素材。
 * 而 AI智能剪辑界面上原生的示例素材只有元数据（名称 / 宽高 / 时长），既没有本地
 * File 对象，服务端也没有对应的二进制 —— 结果就是「没上传过文件就直接点剪辑」
 * 这条最常用的路径只能落回本地模拟，产出不可播放的参数预览。
 *
 * 这里用 FFmpeg 现场合成一组流量服务商主题的竖版图片素材（1080×1920），首次请求时
 * 生成并落盘缓存，之后直接复用。它们是货真价实的 JPEG：
 *   - 走完「FFmpeg 解码 → 缩放裁切 → zoompan 运镜 → 编码」的完整真实链路
 *   - 不需要用户上传任何文件，也不依赖第三方图库
 *   - 中文字形缺失时自动降级为纯色块图（不阻断渲染，只是没有文字）
 *
 * 与 index.js 的 DATA_DIR 约定保持一致（同一环境变量、同一默认值）。
 */
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const renderer = require('./renderer');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = require('./demo').root();
const SAMPLES_DIR = path.join(DATA_DIR, 'samples');

const W = 1080;
const H = 1920;

/**
 * 素材清单。c1 底色 / c2 顶部色带 / c3 色卡块，均为 0xRRGGBB。
 * 标题会烧进图里，便于在成片里一眼认出用的是哪条素材。
 */
const DEFS = [
  { id: 'sp-chenille',   name: '抖音代运营 · 案例拆解',   title: '抖音代运营',   sub: '案例拆解 · 6 家门店起量', c1: '0x1B2A4A', c2: '0x2E4A7D', c3: '0xE8C36A' },
  { id: 'sp-cushion',    name: '千川起量 · 投放后台',     title: '千川起量',     sub: '后台实拍 · ROI 可查',     c1: '0x2A1F3D', c2: '0x5B3F7A', c3: '0xD98CB0' },
  { id: 'sp-velvet',     name: '本地生活团购 · 门店探店', title: '本地生活团购', sub: '门店探店 · 核销闭环',     c1: '0x123A34', c2: '0x1F6B5A', c3: '0x8FD6A8' },
  { id: 'sp-factory',    name: '团队办公 · 每日复盘',     title: '投放复盘',     sub: '自有团队 · 每日复盘',     c1: '0x3A2412', c2: '0x6B4520', c3: '0xE0A85C' },
  { id: 'sp-colorwall',  name: '服务矩阵 · 全行业覆盖',   title: '服务矩阵',     sub: '全行业 · 可定制',         c1: '0x1F2430', c2: '0x3C4759', c3: '0xC8D2E0' },
  { id: 'sp-case',       name: '客户案例 · 增长曲线',     title: '客户案例',     sub: '真实数据 · 可验证',       c1: '0x331B24', c2: '0x6E3348', c3: '0xF0A6B8' }
];

const CACHE = { built: false, ok: false, dir: SAMPLES_DIR, items: [], reason: '' };

/** Windows 路径转义：反斜杠 → 斜杠、盘符冒号 → \:，供 FFmpeg 的 fontfile / 路径参数使用。
    原先这里还有一个同名 esc() 做完全相同的事（死代码），已删除，统一收敛到本函数。 */
function escapeWinPath(p) { return p.replace(/\\/g, '/').replace(':', '\\:'); }

/** 色块图（无字体可用时的降级：纯几何色卡，仍是可解码的真实图片） */
function boxesOnly(def) {
  const parts = [];
  parts.push(`drawbox=x=0:y=0:w=${W}:h=640:color=${def.c2}@0.55:t=fill`);
  parts.push(`drawbox=x=0:y=640:w=${W}:h=8:color=${def.c3}@0.9:t=fill`);
  const bw = Math.floor((W - 160) / 3);
  for (let i = 0; i < 3; i++) {
    parts.push(`drawbox=x=${80 + i * (bw + 20)}:y=1180:w=${bw}:h=${bw}:color=${def.c3}@0.${9 - i * 2}:t=fill`);
  }
  parts.push(`drawbox=x=0:y=${H - 190}:w=${W}:h=190:color=${def.c2}@0.75:t=fill`);
  return parts.join(',');
}

/** 带标题的完整版式 */
function withText(def, font) {
  const f = escapeWinPath(font);
  const parts = [boxesOnly(def)];
  // 标题 / 副标题用 textfile 传入，避免中文在 filter 串里被分隔符截断
  parts.push(`drawtext=fontfile='${f}':textfile='title.txt':fontcolor=white:fontsize=86:`
    + `x=(w-text_w)/2:y=780:box=1:boxcolor=black@0.34:boxborderw=22`);
  parts.push(`drawtext=fontfile='${f}':textfile='sub.txt':fontcolor=0xF2F5FA:fontsize=44:`
    + `x=(w-text_w)/2:y=920:box=1:boxcolor=black@0.26:boxborderw=14`);
  parts.push(`drawtext=fontfile='${f}':text='ProFound · 示例素材':fontcolor=white@0.72:fontsize=36:`
    + `x=(w-text_w)/2:y=${H - 118}`);
  return parts.join(',');
}

/** 生成单张；已存在且体积合理则直接复用 */
async function buildOne(def) {
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  const out = path.join(SAMPLES_DIR, def.id + '.jpg');
  try {
    if (fs.existsSync(out) && fs.statSync(out).size > 2048) return out;
  } catch (e) { /* 缓存不可信，重新生成 */ }

  const font = renderer.pickFont();
  const txtTitle = path.join(SAMPLES_DIR, 'title.txt');
  const txtSub = path.join(SAMPLES_DIR, 'sub.txt');
  if (font) {
    fs.writeFileSync(txtTitle, def.title, 'utf8');
    fs.writeFileSync(txtSub, def.sub, 'utf8');
  }
  const vf = font ? withText(def, font) : boxesOnly(def);
  const r = await ff.run([
    '-f', 'lavfi', '-i', `color=c=${def.c1}:s=${W}x${H}`,
    '-vf', vf, '-frames:v', '1', '-q:v', '3', '-y', def.id + '.jpg'
  ], { cwd: SAMPLES_DIR });
  /* drawtext 的 textfile 只在生成期间需要，生成完即清理，保持素材目录干净 */
  if (font) {
    try { fs.unlinkSync(txtTitle); } catch (e) {}
    try { fs.unlinkSync(txtSub); } catch (e) {}
  }

  if (r.code !== 0 || !fs.existsSync(out)) {
    // 带文字的版式失败（常见于字体不可解析）→ 退回纯色块，图片本身仍可用
    if (font) {
      const r2 = await ff.run([
        '-f', 'lavfi', '-i', `color=c=${def.c1}:s=${W}x${H}`,
        '-vf', boxesOnly(def), '-frames:v', '1', '-q:v', '3', '-y', def.id + '.jpg'
      ], { cwd: SAMPLES_DIR });
      if (r2.code === 0 && fs.existsSync(out)) return out;
    }
    throw new Error('示例素材生成失败：' + String((r.stderr || '')).slice(-200));
  }
  return out;
}

/**
 * 确保示例素材齐备（幂等）。
 * force 为真时重新生成；生成过程无网络、无第三方依赖。
 */
async function ensure(force) {
  if (CACHE.built && !force) return CACHE;
  const items = [];
  let reason = '';
  for (const def of DEFS) {
    try {
      const p = await buildOne(def);
      const stat = fs.statSync(p);
      let meta = null;
      try { meta = await ff.probe(def.id + '.jpg', SAMPLES_DIR); } catch (e) { meta = null; }
      items.push({
        id: def.id, name: def.name, title: def.title, sub: def.sub,
        kind: 'image',
        file: def.id + '.jpg',
        url: '/v1/edit/samples/' + def.id + '.jpg',
        bytes: stat.size,
        width: (meta && meta.width) || W,
        height: (meta && meta.height) || H,
        duration: 0
      });
    } catch (e) {
      reason = (e && e.message) || String(e);
    }
  }
  CACHE.built = true;
  CACHE.ok = items.length > 0;
  CACHE.items = items;
  CACHE.reason = items.length ? '' : (reason || '示例素材生成失败');
  return CACHE;
}

/** 清单（不触发生成，供 config / preflight 快速取用） */
function list() {
  return CACHE.built ? CACHE.items.map((x) => Object.assign({}, x)) : [];
}

function ids() { return DEFS.map((d) => d.id); }
function has(id) { return DEFS.some((d) => d.id === id); }
function pathOf(id) { return has(id) ? path.join(SAMPLES_DIR, id + '.jpg') : ''; }

/** 把前端传来的示例素材 id 规整成可用列表（忽略未知 id，保序去重） */
function pick(arr) {
  const out = [];
  const seen = {};
  const src = Array.isArray(arr) ? arr : [];
  for (const raw of src) {
    const id = String(raw || '').trim();
    if (!id || seen[id] || !has(id)) continue;
    seen[id] = 1;
    out.push(id);
  }
  return out;
}

module.exports = {
  DIR: SAMPLES_DIR, W, H, DEFS,
  ensure, list, ids, has, pathOf, pick, buildOne
};
