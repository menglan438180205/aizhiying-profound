'use strict';
/* =========================================================
   ffmpeg.js — FFmpeg / FFprobe 二进制发现与执行封装
   - 零依赖（仅 node 内置模块）
   - 全部使用「异步 spawn」：部分受限环境下 spawnSync 会直接返回 EBUSY
   - 通过 -progress pipe:1 读取真实渲染进度
   - 所有调用以 job 目录为 cwd、传相对路径，规避 Windows 盘符冒号转义问题
   ========================================================= */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXTRA_DIRS = [
  'D:/ffmpeg/bin', 'C:/ffmpeg/bin', 'D:/ffmpeg', 'C:/ffmpeg',
  'C:/Program Files/ffmpeg/bin', 'C:/ProgramData/chocolatey/bin',
  '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/snap/bin'
];

/** 把 Git-Bash 风格路径 /d/ffmpeg/bin 转成 Windows 路径 D:/ffmpeg/bin */
function toWin(p) {
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  return m ? m[1].toUpperCase() + ':/' + m[2] : p;
}

function candidates(kind) {
  const envs = kind === 'ffmpeg'
    ? [process.env.FFMPEG_PATH, process.env.FFMPEG_BIN]
    : [process.env.FFPROBE_PATH, process.env.FFPROBE_BIN];
  const names = kind === 'ffmpeg' ? ['ffmpeg', 'ffmpeg.exe'] : ['ffprobe', 'ffprobe.exe'];
  const list = [];

  envs.filter(Boolean).forEach((v) => list.push(v));
  names.forEach((n) => list.push(n));                       // 依赖系统 PATH
  EXTRA_DIRS.forEach((d) => names.forEach((n) => list.push(path.join(d, n))));

  // 扫描 PATH，把 POSIX 风格路径一起纳入
  const sep = process.platform === 'win32' ? ';' : ':';
  String(process.env.PATH || '').split(sep).forEach((dir) => {
    if (!dir) return;
    const d = toWin(dir);
    names.forEach((n) => list.push(path.join(d, n)));
  });
  // 去重并保持顺序
  const seen = new Set();
  return list.filter((c) => { const k = c.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

const cache = { ffmpeg: null, ffprobe: null, version: '', ffprobeVersion: '', triedAt: 0, caps: null };
let discovering = null;

function tryRun(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { windowsHide: true }); }
    catch (e) { return resolve(null); }
    let out = '', err = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} finish(null); }, timeoutMs || 15000);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? { out, err } : null);
    });
  });
}

async function discover() {
  if (discovering) return discovering;
  discovering = (async () => {
    for (const c of candidates('ffmpeg')) {
      const r = await tryRun(c, ['-version'], 15000);
      if (r && /ffmpeg version/i.test(r.out)) {
        cache.ffmpeg = c;
        cache.version = (r.out.split('\n')[0] || '').trim();
        break;
      }
    }
    for (const c of candidates('ffprobe')) {
      const r = await tryRun(c, ['-version'], 15000);
      if (r && /ffprobe version/i.test(r.out)) {
        cache.ffprobe = c;
        cache.ffprobeVersion = (r.out.split('\n')[0] || '').trim();
        break;
      }
    }
    cache.triedAt = Date.now();
    return cache;
  })();
  return discovering;
}

async function run(args, opt) {
  opt = opt || {};
  await discover();
  if (!cache.ffmpeg) {
    throw Object.assign(new Error('未找到 ffmpeg 可执行文件。请安装 FFmpeg，或设置环境变量 FFMPEG_PATH 指向 ffmpeg.exe。'),
      { code: 'FFMPEG_MISSING' });
  }
  const argv = ['-hide_banner', '-nostdin', '-loglevel', 'error'].concat(args);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let out = '', err = '';
    let child;
    try { child = spawn(cache.ffmpeg, argv, { cwd: opt.cwd || process.cwd(), windowsHide: true }); }
    catch (e) { return reject(e); }

    let killed = false;
    const onAbort = () => { killed = true; try { child.kill('SIGKILL'); } catch (e) {} };
    if (opt.signal) {
      if (opt.signal.aborted) { onAbort(); return; }
      opt.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      out += s;
      if (typeof opt.onProgress === 'function' && opt.totalSeconds > 0) {
        // -progress pipe:1 输出形如 out_time_us=1234567
        const re = /out_time_us=(\d+)/g;
        let mm, last = null;
        while ((mm = re.exec(s)) !== null) last = Number(mm[1]);
        if (last != null && isFinite(last)) {
          const ratio = Math.max(0, Math.min(1, (last / 1e6) / opt.totalSeconds));
          try { opt.onProgress(ratio); } catch (e) {}
        }
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString('utf8');
      if (err.length > 20000) err = err.slice(-20000);
    });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (killed) return reject(Object.assign(new Error('渲染已取消'), { code: 'CANCELED' }));
      resolve({ code: code == null ? -1 : code, stdout: out, stderr: err, durationMs: Date.now() - t0 });
    });
  });
}

/** 读取媒体元数据（宽高 / 时长） */
async function probe(file, cwd) {
  await discover();
  if (cache.ffprobe) {
    const r = await tryRun(cache.ffprobe, ['-hide_banner', '-v', 'error',
      '-show_entries', 'stream=codec_type,width,height,duration',
      '-show_entries', 'format=duration', '-of', 'json', file], 20000);
    if (r && r.out) {
      try {
        const j = JSON.parse(r.out);
        const v = (j.streams || []).filter((s) => s.codec_type === 'video')[0] || {};
        const dur = Number((j.format && j.format.duration) || v.duration || 0) || 0;
        return { width: Number(v.width) || 0, height: Number(v.height) || 0, duration: dur };
      } catch (e) { /* 落到下面 */ }
    }
  }
  // 无 ffprobe：用 ffmpeg -i 的 stderr 解析
  const rr = await run(['-i', file], { cwd }).catch(() => null);
  if (!rr) return null;
  const s = rr.stderr || '';
  const dim = /(\d{2,5})x(\d{2,5})/.exec(s);
  const du = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
  return {
    width: dim ? Number(dim[1]) : 0,
    height: dim ? Number(dim[2]) : 0,
    duration: du ? (Number(du[1]) * 3600 + Number(du[2]) * 60 + Number(du[3])) : 0
  };
}

/** 同步快照（仅用于启动横幅，未完成发现时返回“检测中”） */
function snapshot() {
  return {
    ok: !!cache.ffmpeg,
    ffmpeg: cache.ffmpeg,
    ffprobe: cache.ffprobe,
    version: cache.version || '检测中…',
    ffprobeVersion: cache.ffprobeVersion
  };
}

async function status() {
  await discover();
  return {
    ok: !!cache.ffmpeg,
    ffmpeg: cache.ffmpeg,
    ffprobe: cache.ffprobe,
    version: cache.version || '未找到 ffmpeg 可执行文件。请安装 FFmpeg，或设置 FFMPEG_PATH。',
    ffprobeVersion: cache.ffprobeVersion || ''
  };
}

/* ---------------- 能力探测 ---------------- */
/* 生产环境最大的隐性坑是「ffmpeg 在，但缺少某个编码器或滤镜」：
   renderer 会在跑了一会儿之后才失败。这里一次性探明并缓存，
   让启动横幅、/v1/health 与 preflight 都能提前报出来。 */

const REQUIRED_CAPS = ['libx264', 'aac', 'drawtext', 'zoompan', 'concat'];
/* 可选能力：缺了只让对应功能降级，**不让镜像构建失败**。
   subtitles 缺 = 字幕退回 drawtext 逐条烧录；
   amix/adelay 缺 = 配音与背景乐无法混音；ebur128/astats = 节拍/响度分析用。 */
const OPTIONAL_CAPS = ['subtitles', 'ass', 'amix', 'adelay', 'apad', 'atrim', 'ebur128', 'astats'];

async function capabilities() {
  await discover();
  if (!cache.ffmpeg) {
    return { ok: false, ready: false, reason: 'FFMPEG_MISSING', missing: REQUIRED_CAPS.slice(), required: REQUIRED_CAPS.slice() };
  }
  if (cache.caps) return cache.caps;

  const [enc, filt, ver] = await Promise.all([
    tryRun(cache.ffmpeg, ['-hide_banner', '-encoders'], 20000),
    tryRun(cache.ffmpeg, ['-hide_banner', '-filters'], 20000),
    tryRun(cache.ffmpeg, ['-hide_banner', '-version'], 20000)
  ]);
  const e = (enc && enc.out) || '';
  const f = (filt && filt.out) || '';
  const v = (ver && ver.out) || cache.version || '';

  const caps = {
    ok: true,
    libx264: /\blibx264\b/.test(e),
    aac: /\baac\b/.test(e),
    drawtext: /\bdrawtext\b/.test(f),
    zoompan: /\bzoompan\b/.test(f),
    concat: /\bconcat\b/.test(f),
    scale: /\bscale\b/.test(f),
    fade: /\bfade\b/.test(f),
    subtitles: /\bsubtitles\b/.test(f),
    ass: /\bass\b/.test(f),
    amix: /\bamix\b/.test(f),
    adelay: /\badelay\b/.test(f),
    apad: /\bapad\b/.test(f),
    atrim: /\batrim\b/.test(f),
    ebur128: /\bebur128\b/.test(f),
    astats: /\bastats\b/.test(f),
    libfreetype: /--enable-libfreetype/.test(v),
    libfontconfig: /--enable-libfontconfig/.test(v),
    hardware: {
      nvenc: /\bh264_nvenc\b/.test(e),
      qsv: /\bh264_qsv\b/.test(e),
      videotoolbox: /\bh264_videotoolbox\b/.test(e)
    },
    version: (v.split('\n')[0] || '').trim(),
    checkedAt: new Date().toISOString()
  };
  caps.required = REQUIRED_CAPS.slice();
  caps.optional = OPTIONAL_CAPS.slice();
  caps.missing = REQUIRED_CAPS.filter((k) => !caps[k]);
  caps.optionalMissing = OPTIONAL_CAPS.filter((k) => !caps[k]);
  caps.ready = caps.missing.length === 0;
  cache.caps = caps;
  return caps;
}

module.exports = {
  run, probe, status, snapshot, discover, capabilities,
  REQUIRED_CAPS, OPTIONAL_CAPS
};
