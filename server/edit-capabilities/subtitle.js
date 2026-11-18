'use strict';
/* =========================================================
   subtitle.js — 字幕分句与时间轴（零依赖，纯函数）
   ---------------------------------------------------------
   为什么不需要语音识别（ASR）：
   配音的文案是系统自己生成的，逐句合成语音后每句的**真实时长**
   可由 ffprobe 量出，累加即得时间轴。ASR 只在「转写素材自带人声」
   时才需要，那是另一条可选链路。

   本模块全部是纯函数（不碰文件系统），便于单测。
   ========================================================= */

const DEFAULT_MAX_LEN = 18;

/* 断句标点：中英文都覆盖。逗号也在内 —— 短视频字幕一行太长会读不过来 */
const SPLIT_RE = /[。！？!?；;…\n]+|(?<=[，,、])/;

/**
 * 把一段文案切成若干短句。
 * 先用标点切，再对仍然过长的片段按最大字数硬切（尽量落在标点处）。
 * @param {string} text
 * @param {number} maxLen 单句最大字数
 * @returns {string[]}
 */
function split(text, maxLen) {
  const max = Math.max(4, Number(maxLen) || DEFAULT_MAX_LEN);
  const raw = String(text || '').replace(/\r/g, '');
  if (!raw.trim()) return [];

  const pieces = raw.split(SPLIT_RE)
    .map((s) => s.replace(/^[\s，,、。]+/, '').trim())
    .filter(Boolean);

  const out = [];
  for (const p of pieces) {
    if (p.length <= max) { out.push(p); continue; }
    let rest = p;
    while (rest.length > max) {
      // 在 max 附近找一个自然断点（，、/ 空格），找不到就硬切
      let cut = -1;
      for (let i = max; i >= Math.floor(max * 0.6); i--) {
        if (/[，,、\s]/.test(rest[i - 1] || '')) { cut = i; break; }
      }
      if (cut < 0) cut = max;
      out.push(rest.slice(0, cut).replace(/[，,、\s]+$/, ''));
      rest = rest.slice(cut).replace(/^[，,、\s]+/, '');
    }
    if (rest.trim()) out.push(rest.trim());
  }
  // 短视频字幕惯例：不留句末标点（截图/烧录后读起来更干净）
  return out
    .map((s) => String(s).replace(/[，,、。！？!?；;…：:]+$/, '').trim())
    .filter(Boolean);
}

/** 秒 → SRT 时间戳 00:00:01,234 */
function fmtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  return pad(h) + ':' + pad(m) + ':' + pad(ss) + ',' + pad(Math.min(999, ms), 3);
}

/**
 * 按比例缩放整条时间轴（配音长于视频时使用）。
 * @param {Array} segments [{text,start,end}]
 * @param {number} factor
 */
function scaleTimeline(segments, factor) {
  const f = Number(factor) > 0 ? Number(factor) : 1;
  return (segments || []).map((s) => ({
    text: s.text,
    start: Number((s.start * f).toFixed(3)),
    end: Number((s.end * f).toFixed(3))
  }));
}

/**
 * 生成 SRT 文本。
 * @param {Array} segments [{text,start,end}]
 * @param {object} opt { maxEnd } 超出该时长的时间轴一并裁剪
 */
function toSrt(segments, opt) {
  opt = opt || {};
  const list = (segments || []).filter((s) => s && String(s.text || '').trim() && s.end > s.start);
  const lines = [];
  list.forEach((s, i) => {
    const end = opt.maxEnd && s.end > opt.maxEnd ? opt.maxEnd : s.end;
    if (end <= s.start) return;
    lines.push(String(lines.length / 4 + 1));
    lines.push(fmtTime(s.start) + ' --> ' + fmtTime(end));
    lines.push(String(s.text).trim());
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * drawtext 降级链：libass 不可用时，用已有的 drawtext 能力逐条烧字幕。
 * 文案经 textfile 传入（规避转义），因此调用方需要先把每条字幕写盘。
 * @param {Array} items [{text,start,end,file}] file 为相对工作目录的文本文件名
 * @param {object} opt { W,H,font }
 */
function toDrawtextChain(items, opt) {
  opt = opt || {};
  const W = opt.W || 720; const H = opt.H || 1280;
  if (!opt.font) return '';
  const ffPath = String(opt.font).replace(/\\/g, '/').replace(':', '\\:');
  return (items || []).filter((x) => x && x.file).map((x) => {
    const a = Number(x.start || 0).toFixed(3);
    const b = Number(x.end || 0).toFixed(3);
    const size = Math.round(W / 22);
    return "drawtext=fontfile='" + ffPath + "':textfile='" + x.file + "':fontcolor=white:fontsize=" + size
      + ':x=(w-text_w)/2:y=h-' + Math.round(H / 8)
      + ':box=1:boxcolor=black@0.55:boxborderw=' + Math.round(W / 60)
      + ":enable='between(t," + a + ',' + b + ')\'';
  }).join(',');
}

module.exports = { split, fmtTime, scaleTimeline, toSrt, toDrawtextChain, DEFAULT_MAX_LEN };
