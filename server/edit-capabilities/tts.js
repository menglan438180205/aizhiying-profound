'use strict';
/* =========================================================
   tts.js — 本地语音合成（零 npm 依赖，不接第三方）
   ---------------------------------------------------------
   三平台都走「操作系统自带的语音合成」：
     win32  : PowerShell + System.Speech（Microsoft Huihui 等 zh-CN 语音）
     darwin : say（系统内置，Tingting 等中文语音）
     linux  : espeak-ng / espeak（多数发行版软件包）

   设计要点（三条，都是踩过的坑）：
   1. 逐句合成 —— 每句一个音频文件，用 ffprobe 量出**真实时长**，
      字幕时间轴由「累加真实时长」得到。配音文案是系统自己写的，
      所以**不需要语音识别（ASR）**。
   2. 文本经临时文件传给合成器，不走命令行参数 —— 规避引号 / $ /
      反斜杠在 PowerShell 里的转义地狱。
   3. 语速统一用 ffmpeg atempo 后处理，跨平台行为一致；
      SAPI 的 Rate 只有 -10..10 整数档，粒度太粗，做不到 1.1×。
   ========================================================= */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const ff = require('../ffmpeg');

/* 探测结果缓存：探测要 spawn 子进程，不能每句都探一次 */
const CACHE = { probed: false, ok: false, provider: '', reason: '', warning: '', voices: [], cjkVoice: '' };

/* 中文语音名特征（跨平台） */
const CJK_VOICE = /zh[-_]?(CN|Hans|TW|HK)|chinese|huihui|yaoyao|kangkang|tingting|sinji|meijia|puakw?ei|zh/i;
const DEFAULT_RATE = 1.1;

function run(cmd, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    let child;
    try { child = execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 30000, maxBuffer: 4 * 1024 * 1024 }); }
    catch (e) { return resolve({ code: -1, stdout: '', stderr: (e && e.message) || String(e) }); }
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => resolve({ code: -1, stdout: out, stderr: (e && e.message) || String(e) }));
    child.on('close', (code) => resolve({ code: code == null ? -1 : code, stdout: out, stderr: err }));
  });
}

/** PowerShell 脚本用 Base64 传入：彻底避开引号 / 换行 / 中文编码问题 */
function psArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/** 单引号字符串里，单引号自身要用两个表示 */
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

/* ---------------- 平台探测 ---------------- */

async function probeWindows() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'foreach ($v in $s.GetInstalledVoices()) {',
    "  Write-Output ('V|' + $v.VoiceInfo.Name + '|' + $v.VoiceInfo.Culture.Name + '|' + $v.Enabled)",
    '}'
  ].join('\n');
  const r = await run('powershell.exe', psArgs(script), { timeout: 40000 });
  if (r.code !== 0 && !/V\|/.test(r.stdout)) {
    return { ok: false, provider: 'windows-sapi', reason: '无法调用 PowerShell 语音合成：' + String(r.stderr || '').split('\n')[0].slice(0, 160) };
  }
  const voices = [];
  String(r.stdout).split(/\r?\n/).forEach((line) => {
    const m = /^V\|(.*)\|([^|]*)\|(True|False)\s*$/.exec(line.trim());
    if (!m) return;
    if (m[3] !== 'True') return;                       // 已禁用的语音不参与选择
    voices.push({ name: m[1], culture: m[2] || '', cjk: CJK_VOICE.test(m[1] + ' ' + m[2]) });
  });
  if (!voices.length) {
    return { ok: false, provider: 'windows-sapi', reason: '系统未安装任何可用语音包（可安装 zh-CN 语音后重试）' };
  }
  const cjk = voices.filter((v) => v.cjk)[0] || null;
  return { ok: true, provider: 'windows-sapi', voices, cjkVoice: cjk ? cjk.name : '' };
}

async function probeDarwin() {
  const r = await run('say', ['-v', '?'], { timeout: 20000 });
  if (r.code !== 0) return { ok: false, provider: 'macos-say', reason: '未找到 say 命令' };
  const voices = String(r.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const parts = l.split(/\s{2,}/);
    const name = parts[0] || '';
    const lang = (parts[1] || '').trim();
    return { name, culture: lang, cjk: CJK_VOICE.test(name + ' ' + lang) };
  });
  if (!voices.length) return { ok: false, provider: 'macos-say', reason: '未找到可用语音' };
  const cjk = voices.filter((v) => v.cjk)[0] || null;
  return { ok: true, provider: 'macos-say', voices, cjkVoice: cjk ? cjk.name : '' };
}

async function probeLinux() {
  for (const bin of ['espeak-ng', 'espeak']) {
    const r = await run('sh', ['-c', 'command -v ' + bin], { timeout: 10000 });
    if (r.code === 0 && String(r.stdout).trim()) {
      const v = await run(bin, ['--voices'], { timeout: 15000 });
      const voices = [];
      String(v.stdout).split(/\r?\n/).forEach((line) => {
        const m = /^\s*\d+\s+(\S+)\s+(\S+)?/.exec(line);
        if (m) voices.push({ name: m[1] + (m[2] ? ' (' + m[2] + ')' : ''), culture: m[2] || '', cjk: /^zh|cmn/i.test(m[2] || '') || /zh|chinese|mandarin|cmn/i.test(line) });
      });
      return { ok: true, provider: bin, voices, cjkVoice: '' };
    }
  }
  return { ok: false, provider: 'linux-espeak', reason: '未找到 espeak-ng / espeak（可 apt install espeak-ng）' };
}

/** 探测本机可用的本地语音合成；结果缓存，force 时重探 */
async function detect(force) {
  if (CACHE.probed && !force) return CACHE;

  /* 显式禁用（运维开关）：直接短路，不要每次都去 spawn 探测 */
  if (/^(1|true|yes|on)$/i.test(String(process.env.EDIT_TTS_DISABLE || '').trim())) {
    CACHE.probed = true; CACHE.ok = false; CACHE.provider = 'disabled';
    CACHE.reason = 'EDIT_TTS_DISABLE 已开启，配音被显式禁用';
    CACHE.warning = ''; CACHE.voices = []; CACHE.cjkVoice = '';
    return CACHE;
  }

  let r;
  try {
    r = process.platform === 'win32' ? await probeWindows()
      : process.platform === 'darwin' ? await probeDarwin()
        : await probeLinux();
  } catch (e) {
    r = { ok: false, provider: 'unknown', reason: (e && e.message) || String(e) };
  }

  let warning = '';
  const envVoice = String(process.env.EDIT_TTS_VOICE || '').trim();
  if (r.ok && envVoice) {
    const hit = (r.voices || []).filter((v) => v.name === envVoice)[0];
    if (hit) r.cjkVoice = hit.name;
    else warning = 'EDIT_TTS_VOICE 指定的语音「' + envVoice + '」未安装，已回落到 ' + (r.cjkVoice || '默认语音');
  }

  CACHE.probed = true;
  CACHE.ok = !!r.ok;
  CACHE.provider = r.provider || '';
  CACHE.reason = r.ok ? '' : (r.reason || '本机没有可用的语音合成');
  CACHE.warning = warning;
  CACHE.voices = r.voices || [];
  CACHE.cjkVoice = r.cjkVoice || '';
  return CACHE;
}

/** 给 /v1/edit/stats 与前端用的只读状态 */
async function status(force) {
  const d = await detect(force);
  return {
    ok: d.ok,
    provider: d.provider,
    reason: d.reason,
    warning: d.warning || '',
    voiceCount: d.voices.length,
    cjkVoice: d.cjkVoice || '',
    cjkAvailable: !!d.cjkVoice || d.voices.some((v) => v.cjk),
    voices: d.voices.map((v) => ({ name: v.name, culture: v.culture, cjk: !!v.cjk }))
  };
}

/* ---------------- 合成 ---------------- */

/**
 * 合成一句文本到 outFile（wav）。
 * @param {string} text
 * @param {string} outFile 绝对路径
 * @param {object} opt { voice, rate, dir }
 */
async function synthesize(text, outFile, opt) {
  opt = opt || {};
  const d = await detect();
  if (!d.ok) return { ok: false, code: 'TTS_UNAVAILABLE', message: d.reason };

  const txt = String(text || '').trim();
  if (!txt) return { ok: false, code: 'TTS_EMPTY', message: '配音文案为空' };

  const dir = opt.dir || path.dirname(outFile);
  const txtFile = outFile.replace(/\.wav$/i, '') + '.txt';
  fs.writeFileSync(txtFile, txt, 'utf8');

  if (d.provider === 'windows-sapi') {
    const voice = opt.voice || d.cjkVoice || '';
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      voice ? ('try { $s.SelectVoice(' + psQuote(voice) + ') } catch { }') : '',
      "$t = [System.IO.File]::ReadAllText(" + psQuote(txtFile) + ', [System.Text.Encoding]::UTF8)',
      'if (-not $t) { $t = ' + psQuote(txt) + ' }',
      '$s.SetOutputToWaveFile(' + psQuote(outFile) + ')',
      '$s.Speak($t)',
      '$s.Dispose()'
    ].filter(Boolean).join('\n');
    const r = await run('powershell.exe', psArgs(script), { timeout: opt.timeout || 90000 });
    if (!fs.existsSync(outFile)) {
      return { ok: false, code: 'TTS_FAILED', message: '语音合成失败：' + String(r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] };
    }
    return { ok: true, file: outFile, voice: voice || '(默认)' };
  }

  if (d.provider === 'macos-say') {
    const voice = opt.voice || d.cjkVoice || '';
    const args = ['-o', outFile, '--data-format=LEI16@22050'];
    if (voice) args.push('-v', voice);
    args.push('-f', txtFile);
    const r = await run('say', args, { timeout: 90000 });
    if (!fs.existsSync(outFile)) return { ok: false, code: 'TTS_FAILED', message: 'say 合成失败：' + String(r.stderr || '').slice(0, 160) };
    return { ok: true, file: outFile, voice: voice || '(默认)' };
  }

  const bin = d.provider === 'espeak' ? 'espeak' : 'espeak-ng';
  const r = await run(bin, ['-v', 'zh', '-w', outFile, '-f', txtFile], { timeout: 90000 });
  if (!fs.existsSync(outFile)) return { ok: false, code: 'TTS_FAILED', message: bin + ' 合成失败：' + String(r.stderr || '').slice(0, 160) };
  return { ok: true, file: outFile, voice: 'zh' };
}

/**
 * 逐句合成 → 标准化（语速 / 采样率）→ 拼接成一条旁白音轨。
 * 返回的 segments 带真实起止时间，可直接生成 SRT（不需要 ASR）。
 *
 * @param {string[]} sentences
 * @param {string} dir  工作目录（任务目录）
 * @param {object} opt  { voice, rate, cwd, signal }
 */
async function build(sentences, dir, opt) {
  opt = opt || {};
  const d = await detect();
  if (!d.ok) return { ok: false, code: 'TTS_UNAVAILABLE', message: d.reason };

  const list = (sentences || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!list.length) return { ok: false, code: 'TTS_EMPTY', message: '没有可配音的文案' };

  const rate = Math.max(0.5, Math.min(Number(opt.rate) || DEFAULT_RATE, 3.0));
  const workDir = path.join(dir, 'tts');
  fs.mkdirSync(workDir, { recursive: true });

  const segments = [];
  const normFiles = [];
  let cursor = 0;

  for (let i = 0; i < list.length; i++) {
    if (opt.signal && opt.signal.aborted) return { ok: false, code: 'CANCELED', message: '已取消' };
    const raw = path.join(workDir, 'raw_' + i + '.wav');
    const norm = 'tts/n_' + i + '.wav';
    const normAbs = path.join(dir, norm);

    const s = await synthesize(list[i], raw, { voice: opt.voice, dir: workDir });
    if (!s.ok) return { ok: false, code: s.code, message: s.message };

    // 一步到位：变速（保音调）+ 统一采样率/声道，便于后续 concat 与混音
    const args = ['-i', 'tts/raw_' + i + '.wav',
      '-filter:a', 'atempo=' + rate.toFixed(3), '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', '-y', norm];
    const r = await ff.run(args, { cwd: dir, signal: opt.signal });
    if (r.code !== 0) return { ok: false, code: 'TTS_NORMALIZE_FAILED', message: '配音标准化失败：' + String(r.stderr || '').slice(-160) };

    const meta = await ff.probe(path.join(dir, norm), dir);
    const dur = meta && meta.duration ? Number(meta.duration.toFixed(3)) : 0;
    if (!dur) return { ok: false, code: 'TTS_NO_DURATION', message: '无法读取第 ' + (i + 1) + ' 句配音时长' };

    segments.push({ text: list[i], start: Number(cursor.toFixed(3)), end: Number((cursor + dur).toFixed(3)) });
    normFiles.push(norm);
    cursor += dur;
  }

  // 拼接：格式已统一，直接 stream copy
  const listFile = path.join(workDir, 'list.txt');
  fs.writeFileSync(listFile, normFiles.map((f) => "file '" + path.basename(f) + "'").join('\n') + '\n', 'utf8');
  const rcat = await ff.run(['-f', 'concat', '-safe', '0', '-i', 'tts/list.txt', '-c', 'copy', '-y', 'tts/narration.wav'],
    { cwd: dir, signal: opt.signal });
  if (rcat.code !== 0) return { ok: false, code: 'TTS_CONCAT_FAILED', message: '配音拼接失败：' + String(rcat.stderr || '').slice(-160) };

  return {
    ok: true,
    file: 'tts/narration.wav',
    abs: path.join(dir, 'tts', 'narration.wav'),
    duration: Number(cursor.toFixed(3)),
    rate,
    voice: opt.voice || d.cjkVoice || '',
    provider: d.provider,
    segments
  };
}

module.exports = { detect, status, synthesize, build, DEFAULT_RATE, CACHE };
