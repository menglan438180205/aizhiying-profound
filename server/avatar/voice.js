'use strict';
/* =========================================================
   avatar/voice.js — 声音复刻（零依赖，本地完成）
   ---------------------------------------------------------
   输入一小段语音样本（≥5s），输出一份「声线档案」：
     · f0          基频中位数（Hz）—— 音高的客观度量
     · energyDb    平均能量（dBFS）
     · voicedRatio 有效发声占比
     · pauseRate   停顿密度（次/秒）
     · baseVoice   从系统语音包里挑出的「最接近的底嗓」
     · pitchRatio  样本基频 / 底嗓基频，合成时用它做变调补偿

   复刻原理（诚实边界，不用任何第三方云服务）：
   1) 逐帧归一化自相关估计基频 —— 这是可复现、可验证的客观量；
   2) 用同一段探针文案把系统里每个候选语音各合成一遍、同样测基频，
      选出与样本基频最接近的底嗓；
   3) 合成结果再按 pitchRatio 做 asetrate+atempo 变调（保时长），
      最终成片的实际基频会回测并写入 match 字段 —— 克隆效果可验收。
   ========================================================= */

const fs = require('fs');
const path = require('path');
const os = require('os');
const ff = require('../ffmpeg');
const tts = require('../edit-capabilities/tts');

const SR = 16000;                       /* 分析统一降采样到 16k 单声道 */
const PROBE_TEXT = '大家好，这里是产品介绍，我们今天讲三个要点，先看第一个。';
const F0_MIN = 70, F0_MAX = 320;        /* 人声基频常规区间 */
const PROBE_DIR = path.join(os.tmpdir(), 'aizy-dh-probe');

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function median(list) {
  if (!list.length) return 0;
  const s = list.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** 解码为 16k 单声道 s16le PCM（cwd 内相对路径，规避盘符冒号转义） */
async function decodePcm(absIn, rel, cwd) {
  const r = await ff.run(['-i', absIn, '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-y', rel], { cwd });
  if (r.code !== 0) return null;
  const full = path.join(cwd, rel);
  if (!fs.existsSync(full) || fs.statSync(full).size < 2) return null;
  const buf = fs.readFileSync(full);
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}

/* 单帧基频：归一化自相关，取峰；清晰度不足返回 0 */
function frameF0(pcm, s, frame, minLag, maxLag) {
  let mean = 0;
  for (let i = 0; i < frame; i++) mean += pcm[s + i];
  mean /= frame;
  let e0 = 0;
  const x = new Float32Array(frame);
  for (let i = 0; i < frame; i++) {
    const v = (pcm[s + i] - mean) / 32768;
    x[i] = v; e0 += v * v;
  }
  if (e0 < 1e-7) return 0;
  let best = 0, bestLag = 0;
  for (let lag = minLag; lag <= maxLag && lag < frame; lag++) {
    let num = 0, e1 = 0;
    for (let i = 0; i + lag < frame; i++) {
      num += x[i] * x[i + lag];
      e1 += x[i + lag] * x[i + lag];
    }
    if (e1 < 1e-9) continue;
    const c = num / Math.sqrt(e0 * e1);
    if (c > best) { best = c; bestLag = lag; }
  }
  if (best < 0.34 || !bestLag) return 0;
  return SR / bestLag;
}

let seq = 0;

/**
 * 分析一段音频：基频 / 能量 / 发声占比 / 停顿密度。
 * @param {string} absIn 音频绝对路径（wav/mp3/m4a 均可，交给 ffmpeg 解码）
 * @param {string} cwd   工作目录（用于落 PCM 中间文件）
 */
async function analyze(absIn, cwd) {
  const rel = 'pcm_' + (++seq) + '.raw';
  const pcm = await decodePcm(absIn, rel, cwd);
  try { fs.unlinkSync(path.join(cwd, rel)); } catch (e) {}
  if (!pcm || pcm.length < SR * 2) {
    return { ok: false, reason: '有效音频不足 2 秒，无法分析声线' };
  }

  const frame = Math.round(SR * 0.04);          /* 40ms */
  const hop = Math.round(SR * 0.02);            /* 20ms 步进 */
  const minLag = Math.max(2, Math.floor(SR / F0_MAX));
  const maxLag = Math.min(frame - 1, Math.ceil(SR / F0_MIN));

  const rms = [];
  for (let s = 0; s + frame <= pcm.length; s += hop) {
    let e = 0;
    for (let i = 0; i < frame; i++) { const v = pcm[s + i] / 32768; e += v * v; }
    rms.push(Math.sqrt(e / frame));
  }
  const sorted = rms.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1] || 0;
  const gate = Math.max(0.008, p95 * 0.28);

  const f0s = [];
  let voicedFrames = 0, pauses = 0, inPause = true, energySum = 0, energyN = 0;
  for (let k = 0; k < rms.length; k++) {
    const isV = rms[k] >= gate;
    energySum += rms[k]; energyN++;
    if (isV) {
      voicedFrames++;
      if (inPause) { pauses++; inPause = false; }
      if (k % 2 === 0) {
        const f0 = frameF0(pcm, k * hop, frame, minLag, maxLag);
        if (f0) f0s.push(f0);
      }
    } else inPause = true;
  }

  const dur = pcm.length / SR;
  const voicedRatio = voicedFrames / rms.length;
  const energyDb = energyN ? Math.round(20 * Math.log10(Math.max(1e-6, energySum / energyN) / 32768) * 10) / 10 : -99;
  const f0 = median(f0s);
  if (!f0 || voicedRatio < 0.12) {
    return { ok: false, reason: '样本里几乎没有可辨识的人声（请换一段清晰说话的录音）' };
  }
  return {
    ok: true,
    duration: Number(dur.toFixed(2)),
    f0: Math.round(f0 * 10) / 10,
    f0Frames: f0s.length,
    energyDb,
    voicedRatio: Math.round(voicedRatio * 100) / 100,
    pauseRate: Math.round((pauses / dur) * 10) / 10
  };
}

/* ---------------- 底嗓匹配 ---------------- */

const PROBE_F0 = new Map();                     /* 语音名 → 探针基频（进程内缓存） */

async function probeVoiceF0(voiceName) {
  if (PROBE_F0.has(voiceName)) return PROBE_F0.get(voiceName);
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const wav = path.join(PROBE_DIR, 'p_' + Buffer.from(String(voiceName)).toString('hex').slice(0, 32) + '.wav');
  const s = await tts.synthesize(PROBE_TEXT, wav, { voice: voiceName, dir: PROBE_DIR });
  if (!s.ok) { PROBE_F0.set(voiceName, 0); return 0; }
  const a = await analyze(wav, PROBE_DIR);
  const f0 = a && a.ok ? a.f0 : 0;
  PROBE_F0.set(voiceName, f0);
  return f0;
}

/**
 * 从系统语音包里挑与 targetF0 最接近的底嗓。
 * 探针合成每个候选只要一次，结果缓存 —— 换样本不再重复测。
 */
async function matchVoice(targetF0) {
  const st = await tts.status();
  const all = (st.voices || []).slice();
  const cjk = all.filter((v) => v.cjk);
  const rest = all.filter((v) => !v.cjk);
  const cands = cjk.concat(rest).slice(0, 4);
  let best = null;
  for (const v of cands) {
    const f0 = await probeVoiceF0(v.name);
    if (!f0) continue;
    const d = Math.abs(Math.log(f0 / targetF0));
    if (!best || d < best.d) {
      best = { voice: v.name, baseF0: f0, d, pitchRatio: clamp(targetF0 / f0, 0.8, 1.25) };
    }
  }
  if (!best) {
    return { voice: st.cjkVoice || '', baseF0: 0, pitchRatio: 1, reason: st.ok ? '候选语音探测失败，按默认底嗓合成' : (st.reason || '本机无可用语音包') };
  }
  return best;
}

/**
 * 变调（保时长）：asetrate 抬/降基频，atempo 拉回原速。
 * @param {string} inRel  输入相对 cwd
 * @param {string} outRel 输出相对 cwd
 * @param {number} ratio  目标基频 / 当前基频
 */
async function pitchShift(inRel, outRel, ratio, cwd, signal) {
  const r = clamp(Number(ratio) || 1, 0.8, 1.25);
  if (Math.abs(r - 1) < 0.02) {
    const c = await ff.run(['-i', inRel, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', '-y', outRel], { cwd, signal });
    return { ok: c.code === 0, ratio: 1, applied: false, error: c.code === 0 ? '' : String(c.stderr || '').slice(-160) };
  }
  const f = 'asetrate=44100*' + r.toFixed(4) + ',aresample=44100,atempo=' + (1 / r).toFixed(4);
  const c = await ff.run(['-i', inRel, '-filter:a', f, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', '-y', outRel], { cwd, signal });
  return { ok: c.code === 0, ratio: r, applied: true, error: c.code === 0 ? '' : String(c.stderr || '').slice(-160) };
}

module.exports = { analyze, matchVoice, pitchShift, PROBE_TEXT };
