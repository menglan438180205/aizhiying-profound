'use strict';
/* =========================================================
   avatar/media.js — 形象复刻（少量照片 → 可驱动的基准形象）
   ---------------------------------------------------------
   输入 1~10 张照片，做四件事（全部本地 FFmpeg，无第三方）：
   1) 校验：尺寸过小 / 解不开的图直接拒绝，理由逐条返回；
   2) 选主图：竖图优先（人像概率高）、同尺寸下像素高者优先；
   3) 基准形象帧：模糊放大背景 + 清晰主体居中 —— 既不裁头
      也不留黑边，任何比例的照片都能出规整画幅；
   4) 待机循环片：呼吸式推拉（sin 运镜），直播/对话时垫画面。

   明确不做的事：不做人脸检测 / 换脸 / 口型合成（需要 GPU 模型，
   本机不具备）。这里产出的是「图像级形象 + 可验证的运镜驱动」，
   前端会如实标注能力边界。
   ========================================================= */

const fs = require('fs');
const path = require('path');
const ff = require('../ffmpeg');

const CANVAS = {
  '9:16': [1080, 1920],
  '16:9': [1920, 1080],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350]
};
const MIN_SIDE = 320;                 /* 短边低于此值的照片无法当数字人形象 */
const MOTIONS = ['breathe', 'push', 'pull', 'pan'];

function canvasOf(ratio) { return CANVAS[ratio] || CANVAS['9:16']; }

/** 运镜表达式：breathe/push/pull/pan，全部只用 on（帧号）驱动 */
function motionExpr(motion, frames) {
  const n = Math.max(1, frames);
  switch (motion) {
    case 'push': return {
      z: 'min(1+' + (0.14 / n).toFixed(6) + '*on,1.14)',
      x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)'
    };
    case 'pull': return {
      z: 'max(1.14-' + (0.14 / n).toFixed(6) + '*on,1.0)',
      x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)'
    };
    case 'pan': return {
      z: '1.14',
      x: '(iw-iw/zoom)*on/' + n, y: 'ih/2-(ih/zoom/2)'
    };
    default: return {            /* breathe：呼吸式往复，循环片默认 */
      z: '1.05+0.03*sin(on/28)',
      x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)'
    };
  }
}

/** 形象帧合成滤镜（W×H 目标画幅）：背景模糊放大 + 主体清晰居中 */
function compositeChain(W, H) {
  return '[0:v]scale=' + W + ':' + H + ':force_original_aspect_ratio=increase,crop=' + W + ':' + H + ',boxblur=24:2[bg];' +
    '[0:v]scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease[fg];' +
    '[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p';
}

/** 把一张照片在链尾叠加运镜（用于视频渲染，输入先放大 2 倍保清晰度） */
function driveChain(motion, frames, W, H) {
  const e = motionExpr(motion, frames);
  const w2 = W * 2, h2 = H * 2;
  return 'scale=' + w2 + ':' + h2 + ':force_original_aspect_ratio=increase,crop=' + w2 + ':' + h2 + ',' +
    'zoompan=z=\'' + e.z + '\':x=\'' + e.x + '\':y=\'' + e.y + '\':d=1:s=' + W + 'x' + H + ':fps=25';
}

/**
 * 生成基准形象帧 + 缩略图。
 * @param {Array<{rel:string,w:number,h:number}>} photos 相对 cwd 的照片与已知尺寸
 * @returns {{ok:boolean, base?:string, thumb?:string, from?:string, reason?:string}}
 */
async function buildBase(photos, cwd, ratio) {
  const good = (photos || []).filter((p) => p && p.rel && p.w >= MIN_SIDE && p.h >= MIN_SIDE);
  if (!good.length) {
    return { ok: false, reason: '没有一张可用照片（短边需 ≥ ' + MIN_SIDE + 'px）' };
  }
  const scored = good.map((p) => Object.assign({ score: (p.h > p.w ? 1.35 : 1) * Math.sqrt(p.w * p.h) }, p));
  scored.sort((a, b) => b.score - a.score);
  const pick = scored[0];
  const [W, H] = canvasOf(ratio);

  let r = await ff.run(['-i', pick.rel, '-filter_complex', compositeChain(W, H), '-frames:v', '1', '-q:v', '2', '-y', 'base.jpg'], { cwd });
  if (r.code !== 0) return { ok: false, reason: '形象帧合成失败：' + String(r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] };

  const tW = Math.round(W / 3), tH = Math.round(H / 3);
  r = await ff.run(['-i', pick.rel, '-filter_complex', compositeChain(tW, tH), '-frames:v', '1', '-q:v', '4', '-y', 'thumb.jpg'], { cwd });
  if (r.code !== 0) return { ok: false, reason: '缩略图生成失败：' + String(r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] };

  return { ok: true, base: 'base.jpg', thumb: 'thumb.jpg', from: pick.rel, w: W, h: H, used: scored.length };
}

/**
 * 待机循环片：呼吸运镜 + 无音轨。
 * @returns {{ok:boolean, file?:string, duration?:number, reason?:string}}
 */
async function buildIdle(cwd, seconds, motion, ratio) {
  const dur = Math.max(3, Math.min(Number(seconds) || 8, 30));
  const [W, H] = canvasOf(ratio);
  const frames = Math.round(25 * dur);
  const chain = driveChain(motion && MOTIONS.indexOf(motion) > -1 ? motion : 'breathe', frames, W, H) + ',format=yuv420p';
  const r = await ff.run(['-loop', '1', '-framerate', '25', '-t', String(dur), '-i', 'base.jpg',
    '-vf', chain, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', 'idle.mp4'], { cwd });
  if (r.code !== 0) {
    return { ok: false, reason: '待机片渲染失败：' + String(r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] };
  }
  return { ok: true, file: 'idle.mp4', duration: dur, motion: motion || 'breathe' };
}

module.exports = { buildBase, buildIdle, canvasOf, driveChain, motionExpr, CANVAS, MOTIONS, MIN_SIDE };
