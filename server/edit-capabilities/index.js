'use strict';
/* =========================================================
   edit-capabilities/index.js — 本地剪辑能力插件出口
   ---------------------------------------------------------
   与 server/collect-adapters/ 同一套写法：能力插件挂在既有渲染引擎
   之上，引擎（FFmpeg 管线）本身不替换。缺哪个能力就降级，并如实上报。

   这里只做「汇总与判定」，不碰渲染细节。
   ========================================================= */

const ff = require('../ffmpeg');
const tts = require('./tts');
const subtitle = require('./subtitle');

/* 配音通道：目前只有「系统自带语音合成」一条真实通道，
   将来接本地神经 TTS 时在这里追加（与采集通道同样支持多通道并存）。 */
const VOICE_CHANNELS = [
  { id: 'system-tts', name: '系统语音合成', note: '操作系统自带，离线运行，零安装' },
  { id: 'none', name: '未接入', note: '不会产生配音与字幕' }
];

const SUBTITLE_MODES = [
  { id: 'libass', name: 'subtitles 滤镜', note: '需要 FFmpeg 带 libass' },
  { id: 'drawtext', name: 'drawtext 烧录', note: '降级路径，需要中文字体' },
  { id: 'none', name: '未接入', note: '不烧录字幕' }
];

/**
 * 汇总当前可用的剪辑能力。
 * @param {object} opt { font: 字体绝对路径（由 renderer.pickFont 传入，避免循环依赖） }
 */
async function abilities(opt) {
  opt = opt || {};
  const t = await tts.status();
  const caps = await ff.capabilities().catch(() => null);
  const fontOk = opt.font !== undefined ? !!opt.font : true;

  const libass = !!(caps && caps.subtitles);
  const drawtext = !!(caps && caps.drawtext);
  const subOk = fontOk && (libass || drawtext);
  const subMode = !subOk ? 'none' : (libass ? 'libass' : 'drawtext');

  const subReason = !fontOk ? '未找到可用中文字体，字幕会渲染成方块，已跳过'
    : libass ? '' : drawtext ? 'FFmpeg 缺 libass，已降级为 drawtext 逐条烧录' : 'FFmpeg 缺 subtitles 与 drawtext 滤镜';

  return {
    voice: {
      ok: !!t.ok,
      channel: t.ok ? 'system-tts' : 'none',
      channelName: t.ok ? '系统语音合成' : '未接入',
      provider: t.provider || '',
      voice: t.cjkVoice || '',
      cjk: !!t.cjkAvailable,
      voiceCount: t.voiceCount || 0,
      rate: tts.DEFAULT_RATE,
      reason: t.ok ? '' : (t.reason || '本机没有可用的语音合成'),
      warning: t.warning || ''
    },
    subtitle: {
      ok: subOk,
      mode: subMode,
      modeName: (SUBTITLE_MODES.filter((m) => m.id === subMode)[0] || {}).name || '未接入',
      libass: libass,
      font: fontOk ? (opt.font || '') : '',
      reason: subReason
    },
    channels: VOICE_CHANNELS,
    modes: SUBTITLE_MODES
  };
}

module.exports = { tts, subtitle, abilities, VOICE_CHANNELS, SUBTITLE_MODES, DEFAULT_RATE: tts.DEFAULT_RATE };
