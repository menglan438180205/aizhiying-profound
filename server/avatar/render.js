'use strict';
/* =========================================================
   avatar/render.js — 数字人驱动渲染（文本 / 音频 / 动捕）
   ---------------------------------------------------------
   三种驱动共用同一条画面管线（基准形象帧 + 运镜）：
     · text   文案 → 逐句 TTS（底嗓）→ 变调对齐声线 → 字幕烧录
     · audio  直接使用上传音频 → 同画面（无字幕，因为没有转写）
     · motion 运镜脚本（breathe/push/pull/pan）→ 无声展示片

   产出统一 mp4（H.264 + AAC），与剪辑成片同库分发（/files/）。
   渲染完成后回测成片音轨的实际基频，与样本基频一起写进
   match 字段 —— 「声音像不像」用数字说话，不做主观承诺。
   ========================================================= */

const fs = require('fs');
const path = require('path');
const ff = require('../ffmpeg');
const ec = require('../edit-capabilities');
const renderer = require('../renderer');          /* 复用字体探测，不重复实现 */
const media = require('./media');
const voice = require('./voice');

const FPS = 25;
const FONT_FAMILY = process.platform === 'win32' ? 'SimHei'
  : process.platform === 'darwin' ? 'PingFang SC' : 'Noto Sans CJK SC';

function fontFile() {
  try { return renderer.pickFont(); } catch (e) { return ''; }
}

function styleLine() {
  return 'FontName=' + FONT_FAMILY + ',FontSize=18,PrimaryColour=&H00FFFFFF,' +
    'OutlineColour=&H00000000,BorderStyle=1,Outline=2.4,Shadow=0,MarginV=140,Alignment=2';
}

/**
 * @param {object} job {
 *   id, mode:'text'|'audio'|'motion', motion, ratio,
 *   avatar:{ base:'base.jpg', voice:{baseVoice,pitchRatio,f0} },
 *   input:{ text, rate, audioRel, seconds }
 * }
 * @param {object} ctx { dir, outDir, log, onStage, onProgress, signal }
 */
async function renderDrive(job, ctx) {
  const dir = ctx.dir;
  const baseRel = 'base.jpg';
  if (!fs.existsSync(path.join(dir, baseRel))) {
    throw Object.assign(new Error('形象帧缺失，无法渲染'), { code: 'NO_BASE' });
  }
  const [W, H] = media.canvasOf(job.ratio);
  const mode = ['text', 'audio', 'motion'].indexOf(job.mode) > -1 ? job.mode : 'text';
  const preset = process.env.RENDER_PRESET || 'veryfast';
  const crf = Number(process.env.RENDER_CRF || 23);
  const log = ctx.log || function () {};

  let audioRel = '';                 /* 相对 dir 的最终音轨 */
  let duration = 0;
  let segments = [];
  let srtText = '';
  const voiceInfo = { ok: false, channel: mode === 'text' ? 'clone-tts' : 'source-audio' };
  const subInfo = { ok: false, mode: 'none', reason: mode !== 'text' ? '该驱动无文案，不生成字幕' : '' };

  /* ---------------- 1. 音轨 ---------------- */
  if (mode === 'text') {
    if (typeof ctx.onStage === 'function') ctx.onStage('正在合成数字人语音');
    const text = String((job.input && job.input.text) || '').trim();
    if (!text) throw Object.assign(new Error('文案为空'), { code: 'EMPTY_TEXT' });
    const vp = job.avatar && job.avatar.voice ? job.avatar.voice : {};
    const rate = Math.max(0.5, Math.min(Number(job.input && job.input.rate) || 1.0, 2.0));
    const rv = await ec.tts.build(ec.subtitle.split(text), dir, { voice: vp.baseVoice || '', rate, signal: ctx.signal });
    if (!rv.ok) throw Object.assign(new Error('语音合成失败：' + (rv.message || rv.code)), { code: 'TTS_FAILED' });

    const raw = rv.file;                             /* tts/narration.wav */
    /* 闭环校准：档案里的 pitchRatio 是「档案时刻」的静态比；
       实际合成音的基频会随文案内容波动，这里先测本次成音的真实基频，
       再按「样本基频 / 本次基频」现算变调比 —— 回测偏差从两位数降到个位数。 */
    let ratio = (vp && vp.pitchRatio) || 1;
    const rawA = await voice.analyze(path.join(dir, raw), dir).catch(() => null);
    if (rawA && rawA.ok && vp && vp.f0) {
      ratio = Math.max(0.8, Math.min(vp.f0 / rawA.f0, 1.25));
      voiceInfo.calibrated = true;
      voiceInfo.rawF0 = rawA.f0;
    }
    const vr = await voice.pitchShift(raw, 'narration_v.wav', ratio, dir, ctx.signal);
    if (!vr.ok) throw Object.assign(new Error('声线变调失败：' + vr.error), { code: 'PITCH_FAILED' });

    audioRel = 'narration_v.wav';
    duration = rv.duration;
    segments = rv.segments;
    voiceInfo.ok = true;
    voiceInfo.provider = rv.provider;
    voiceInfo.baseVoice = rv.voice || vp.baseVoice || '';
    voiceInfo.pitchRatio = Math.round(vr.ratio * 1000) / 1000;
    voiceInfo.rate = rv.rate;
    voiceInfo.duration = duration;
    voiceInfo.sentences = segments.length;
    log('ok', '语音已合成：' + segments.length + ' 句 · ' + duration + 's · 底嗓 ' + voiceInfo.baseVoice + ' · 变调 ×' + vr.ratio);
    if (typeof ctx.onProgress === 'function') ctx.onProgress(0.35);
  } else if (mode === 'audio') {
    audioRel = String(job.input.audioRel || '');
    if (!audioRel || !fs.existsSync(path.join(dir, audioRel))) {
      throw Object.assign(new Error('音频驱动缺少音频文件'), { code: 'NO_AUDIO' });
    }
    const meta = await ff.probe(path.join(dir, audioRel), dir);
    duration = meta && meta.duration ? meta.duration : 0;
    if (!duration) throw Object.assign(new Error('无法读取音频时长'), { code: 'BAD_AUDIO' });
    voiceInfo.ok = true;
    voiceInfo.duration = Number(duration.toFixed(2));
    log('info', '音频驱动：' + duration.toFixed(1) + 's');
    if (typeof ctx.onProgress === 'function') ctx.onProgress(0.35);
  } else {
    duration = Math.max(2, Math.min(Number(job.input && job.input.seconds) || 8, 120));
    log('info', '运镜驱动：' + (job.motion || 'breathe') + ' · ' + duration + 's');
  }

  /* ---------------- 2. 字幕 ---------------- */
  if (mode === 'text' && segments.length) {
    srtText = ec.subtitle.toSrt(segments);
    fs.writeFileSync(path.join(dir, 'subs.srt'), srtText, 'utf8');
    subInfo.mode = fontFile() ? 'libass' : 'none';
    subInfo.ok = subInfo.mode === 'libass';
    subInfo.reason = subInfo.ok ? '' : '未找到中文字体，成片将无字幕';
  }

  /* ---------------- 3. 画面 + 封装 ---------------- */
  if (typeof ctx.onStage === 'function') ctx.onStage('正在渲染数字人画面');
  const frames = Math.max(FPS, Math.round(FPS * duration));
  const motion = job.motion && media.MOTIONS.indexOf(job.motion) > -1 ? job.motion : 'breathe';
  const chain = media.driveChain(motion, frames, W, H);

  const tryEncode = (withSub) => {
    const vf = chain + (withSub && srtText
      ? ',subtitles=subs.srt:force_style=\'' + styleLine() + '\'' : '') + ',format=yuv420p';
    const args = ['-loop', '1', '-framerate', String(FPS), '-t', String(duration), '-i', baseRel];
    if (audioRel) args.push('-i', audioRel);
    args.push('-filter_complex', '[0:v]' + vf + '[v]', '-map', '[v]', '-t', String(duration));
    if (audioRel) args.push('-map', '1:a', '-c:a', 'aac', '-b:a', '128k', '-shortest');
    else args.push('-an');
    args.push('-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', 'out.mp4');
    return args;
  };

  const onProg = (ratio) => {
    if (typeof ctx.onProgress === 'function') ctx.onProgress(0.45 + ratio * 0.5);
  };
  let r = await ff.run(tryEncode(!!srtText && subInfo.ok), { cwd: dir, signal: ctx.signal, totalSeconds: duration, onProgress: onProg });
  if (r.code !== 0 && srtText && subInfo.ok) {
    log('warn', '带字幕渲染失败，降级为无字幕重渲：' + String(r.stderr || '').split('\n').filter(Boolean).slice(-1)[0]);
    subInfo.ok = false; subInfo.mode = 'none';
    subInfo.reason = '字幕滤镜执行失败，已按无字幕交付';
    r = await ff.run(tryEncode(false), { cwd: dir, signal: ctx.signal, totalSeconds: duration, onProgress: onProg });
  }
  if (r.code !== 0) {
    throw Object.assign(new Error('画面渲染失败：' + String(r.stderr || '').split('\n').filter(Boolean).slice(-1)[0]), { code: 'RENDER_FAILED' });
  }

  /* ---------------- 4. 产物校验 + 基频回测 ---------------- */
  const outAbs = path.join(dir, 'out.mp4');
  const stat = fs.existsSync(outAbs) ? fs.statSync(outAbs) : null;
  if (!stat || stat.size < 1024) {
    throw Object.assign(new Error('成片异常（' + ((stat && stat.size) || 0) + ' 字节）'), { code: 'BAD_OUTPUT' });
  }
  const meta = await ff.probe(outAbs, dir);

  let match = null;
  if (audioRel) {
    const a = await voice.analyze(path.join(dir, audioRel), dir).catch(() => null);
    if (a && a.ok) {
      const sampleF0 = job.avatar && job.avatar.voice ? job.avatar.voice.f0 : 0;
      match = {
        outF0: a.f0,
        sampleF0: sampleF0 || null,
        delta: sampleF0 ? Math.round(Math.abs(a.f0 - sampleF0) / sampleF0 * 1000) / 10 : null
      };
    }
  }

  if (typeof ctx.onStage === 'function') ctx.onStage('正在抽封面');
  const cover = job.id + '_cover.jpg';
  await ff.run(['-ss', '0.5', '-i', 'out.mp4', '-frames:v', '1', '-q:v', '3', '-y', cover], { cwd: dir });

  return {
    file: 'out.mp4',
    duration: Number((meta && meta.duration || duration).toFixed(2)),
    bytes: stat.size,
    voice: voiceInfo,
    subtitle: subInfo,
    match
  };
}

module.exports = { renderDrive };
