'use strict';
/* =========================================================
   avatar/index.js — AI数字人领域层
   ---------------------------------------------------------
   数据模型（三张表，接入主 Store 分表持久化）：
     dh_avatars   形象档案（照片 / 基准形象帧 / 待机片 / 声线档案）
     dh_renders   驱动渲染任务（text / audio / motion，NDJSON）
     dh_sessions  直播 / 对话会话（播放清单 + 实时应答轮次）

   与剪辑队列完全独立：数字人渲染是「1 输出」的短任务，
   串行执行即可，避免和批量剪辑抢 CPU。对外只暴露 attach(ctx)，
   HTTP 契约全部用 route() 注册，不往主 if 链里塞一行。
   ========================================================= */

const fs = require('fs');
const path = require('path');
const mp = require('../multipart');
const ff = require('../ffmpeg');
const media = require('./media');
const voice = require('./voice');
const { renderDrive } = require('./render');

const PHOTOS_MAX = 10;
const PHOTO_BYTES = 15 * 1024 * 1024;
const AUDIO_BYTES = 40 * 1024 * 1024;
const AVATARS_CAP = 50;
const RENDERS_CAP = 500;

/* ---------------- 小工具 ---------------- */
function esc(s) { return String(s == null ? '' : s); }
function clamp(v, a, b) { return Math.min(b, Math.max(a, Number(v) || 0)); }
function nowIso() { return new Date().toISOString(); }
function safeName(name, fallbackExt) {
  let n = path.basename(String(name || '')).replace(/[^A-Za-z0-9._-]/g, '_');
  if (!/\.[A-Za-z0-9]{2,5}$/.test(n)) n += (fallbackExt || '.bin');
  return n.slice(0, 80);
}
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

/* =========================================================
   attach：注入宿主能力（路由 / 存储 / 目录 / 发文件）
   ========================================================= */
function attach(ctx) {
  const route = ctx.route;
  const ok = ctx.ok, fail = ctx.fail;
  const readBody = ctx.readBody;
  const sendFile = ctx.sendFile;
  const store = ctx.store;
  const tenantOf = ctx.tenantOf || function () { return 'default'; };
  const onCharge = ctx.onCharge || null;
  const log = ctx.log || function () {};

  /* 边界收敛：宿主传入的目录一律转绝对路径。
     FFmpeg 子进程的 -i 相对路径按「子进程 cwd」解析，宿主侧 cwd 与
     数据目录不一致时（如 DATA_DIR=../x）输入就会神秘失踪。 */
  const DATA_ROOT = path.resolve(ctx.DATA_ROOT);
  const OUT_DIR = path.resolve(ctx.OUT_DIR);
  const TMP_DIR = path.resolve(ctx.TMP_DIR);
  const AVATAR_DIR = path.join(DATA_ROOT, 'avatars');
  ensureDir(AVATAR_DIR);

  /* ---------------- 数据访问 ---------------- */
  const avatars = () => store.data.dh_avatars;
  const renders = () => store.data.dh_renders;
  const sessions = () => store.data.dh_sessions;
  const avatarOf = (id) => avatars().filter((a) => a.id === id)[0] || null;
  const renderOf = (id) => renders().filter((r) => r.id === id)[0] || null;
  const sessionOf = (id) => sessions().filter((s) => s.id === id)[0] || null;
  const dirOf = (id) => path.join(AVATAR_DIR, id);

  function upsertAvatar(a) { store.save(false, 'dh_avatars'); return a; }
  function upsertRender(r) { store.upsert('dh_renders', r); return r; }
  function saveSessions() { store.save(false, 'dh_sessions'); }

  /* ---------------- 视图（不含本地绝对路径） ---------------- */
  function publicAvatar(a) {
    return {
      id: a.id, name: a.name, ratio: a.ratio || '9:16',
      photos: (a.photos || []).map((p) => ({ name: p.name, w: p.w, h: p.h, url: '/dh/' + a.id + '/' + p.file })),
      base: a.base ? Object.assign({}, a.base, { url: '/dh/' + a.id + '/' + a.base.file }) : null,
      thumb: a.thumb ? '/dh/' + a.id + '/' + a.thumb : '',
      idle: a.idle ? Object.assign({}, a.idle, { url: '/dh/' + a.id + '/' + a.idle.file }) : null,
      voice: a.voice ? {
        ok: !!a.voice.ok, duration: a.voice.duration, f0: a.voice.f0,
        energyDb: a.voice.energyDb, voicedRatio: a.voice.voicedRatio, pauseRate: a.voice.pauseRate,
        baseVoice: a.voice.baseVoice, baseF0: a.voice.baseF0, pitchRatio: a.voice.pitchRatio,
        sampleUrl: a.voice.file ? '/dh/' + a.id + '/' + a.voice.file : '',
        analyzedAt: a.voice.analyzedAt
      } : null,
      hasBase: !!a.base, hasVoice: !!(a.voice && a.voice.ok),
      ready: !!a.base && !!(a.voice && a.voice.ok),
      createdAt: a.createdAt, updatedAt: a.updatedAt
    };
  }
  function publicRender(r) {
    return {
      id: r.id, avatarId: r.avatarId, avatarName: r.avatarName, mode: r.mode, motion: r.motion,
      title: r.title, status: r.status, progress: r.progress || 0, stage: r.stage || '',
      input: { text: r.input && r.input.text ? String(r.input.text).slice(0, 120) : '', seconds: r.input && r.input.seconds, audioName: r.input && r.input.audioName },
      out: r.out && r.out.file ? {
        url: '/files/' + r.out.file, cover: r.out.cover ? '/files/' + r.out.cover : '',
        duration: r.out.duration, bytes: r.out.bytes
      } : null,
      voice: r.voice || null, subtitle: r.subtitle || null, match: r.match || null,
      error: r.error || null, logs: (r.logs || []).slice(-40),
      createdAt: r.createdAt, finishedAt: r.finishedAt || null, elapsedMs: r.elapsedMs || null
    };
  }
  function publicSession(s) {
    const av = avatarOf(s.avatarId);
    return {
      id: s.id, avatarId: s.avatarId, avatarName: av ? av.name : s.avatarId,
      mode: s.mode, status: s.status,
      playlist: (s.playlist || []).map((rid) => {
        const r = renderOf(rid);
        return r && r.out && r.out.file ? { renderId: rid, url: '/files/' + r.out.file, title: r.title, duration: r.out.duration } : null;
      }).filter(Boolean),
      turns: (s.turns || []).map((t) => ({ role: t.role, text: t.text, audio: t.audio || '', duration: t.duration || 0, f0: t.f0 || null, at: t.at })),
      createdAt: s.createdAt, stoppedAt: s.stoppedAt || null
    };
  }
  function stats() {
    const rs = renders();
    const by = (k) => rs.filter((r) => r.status === k).length;
    const byMode = {};
    rs.forEach((r) => { byMode[r.mode] = (byMode[r.mode] || 0) + 1; });
    const durations = rs.filter((r) => r.out && r.out.duration).map((r) => r.out.duration);
    return {
      avatars: avatars().length,
      renders: { total: rs.length, queued: by('queued'), running: by('running'), done: by('done'), failed: by('failed'), canceled: by('canceled') },
      byMode,
      totalSeconds: Math.round(durations.reduce((s, d) => s + d, 0) * 10) / 10,
      sessions: { total: sessions().length, running: sessions().filter((s) => s.status === 'running').length }
    };
  }

  /* ---------------- 渲染队列（串行 + 取消） ---------------- */
  const running = new Map();                     /* renderId -> AbortController */
  let active = null;

  function pushLog(r, level, msg) {
    r.logs = r.logs || [];
    r.logs.push({ ts: nowIso(), level: level, msg: String(msg).slice(0, 300) });
    if (r.logs.length > 120) r.logs.shift();
    log('[dh/' + r.id + '] ' + msg, level);
  }

  function submitRender(rec) {
    renders().unshift(rec);
    if (renders().length > RENDERS_CAP) renders().length = RENDERS_CAP;
    store.save(true, 'dh_renders');
    pump();
    return rec;
  }

  function pump() {
    if (active) return;
    const job = renders().filter((r) => r.status === 'queued')
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
    if (!job) return;
    active = job.id;
    runRender(job).catch((e) => {
      try { failRender(job, (e && e.message) || String(e)); } catch (e2) {}
    }).finally(() => { active = null; pump(); });
  }

  function failRender(r, msg) {
    r.status = 'failed';
    r.stage = '失败';
    r.error = String(msg).slice(0, 300);
    r.finishedAt = Date.now();
    r.elapsedMs = r.finishedAt - (r.startedAt || r.createdAt);
    upsertRender(r);
    store.event('error', 'avatar', '数字人渲染失败 ' + r.id, { error: r.error });
  }

  async function runRender(r) {
    const av = avatarOf(r.avatarId);
    const ac = new AbortController();
    running.set(r.id, ac);
    r.status = 'running';
    r.progress = 2;
    r.stage = '准备素材';
    r.startedAt = Date.now();
    upsertRender(r);

    const finish = (patch) => {
      r.status = patch.status;
      r.stage = patch.stage;
      if (patch.error) r.error = patch.error;
      if (patch.out) r.out = patch.out;
      if (patch.voice) r.voice = patch.voice;
      if (patch.subtitle) r.subtitle = patch.subtitle;
      if (patch.match) r.match = patch.match;
      r.progress = patch.status === 'done' ? 100 : (r.progress || 0);
      r.finishedAt = Date.now();
      r.elapsedMs = r.finishedAt - r.startedAt;
      upsertRender(r);
    };
    const failRender2 = (msg) => {
      pushLog(r, 'err', '渲染失败：' + msg);
      failRender(r, msg);
    };

    try {
      if (!av) return failRender2('数字人不存在');
      if (!av.base) return failRender2('还没有基准形象帧，请先上传照片');

      const dir = path.join(TMP_DIR, r.id);
      ensureDir(dir);
      const avDir = dirOf(av.id);
      fs.copyFileSync(path.join(avDir, av.base.file), path.join(dir, 'base.jpg'));
      r.progress = 6; upsertRender(r);

      if (r.mode === 'audio') {
        const src = r.input.audioPath;
        if (!src || !fs.existsSync(src)) return failRender2('音频文件已丢失，请重新上传');
        fs.copyFileSync(src, path.join(dir, 'voice_in.wav'));
      }

      const out = await renderDrive({
        id: r.id, mode: r.mode, motion: r.motion, ratio: av.ratio || '9:16',
        avatar: { voice: av.voice || null },
        input: { text: r.input.text, rate: r.input.rate, seconds: r.input.seconds, audioRel: r.mode === 'audio' ? 'voice_in.wav' : '' }
      }, {
        dir, outDir: OUT_DIR,
        signal: ac.signal,
        log: (lv, m) => { pushLog(r, lv, m); },
        onStage: (st) => { r.stage = st; upsertRender(r); },
        onProgress: (p) => { r.progress = clamp(6 + p * 88, 6, 94); upsertRender(r); }
      });

      /* 产物落成片库（与剪辑成片同一目录、同一分发通道） */
      const outName = r.id + '.mp4';
      const coverName = r.id + '_cover.jpg';
      fs.copyFileSync(path.join(dir, out.file), path.join(OUT_DIR, outName));
      const coverSrc = path.join(dir, coverName);
      const cover = fs.existsSync(coverSrc) ? (fs.copyFileSync(coverSrc, path.join(OUT_DIR, coverName)), coverName) : '';

      finish({
        status: 'done', stage: '已完成',
        out: { file: outName, cover, duration: out.duration, bytes: out.bytes },
        voice: out.voice, subtitle: out.subtitle, match: out.match
      });
      pushLog(r, 'ok', '成片 ' + outName + ' · ' + out.duration + 's · ' + Math.round(out.bytes / 1024) + 'KB');
      if (onCharge) {
        try { onCharge(r.owner, 'minutes', Math.max(0.1, Math.round(out.duration / 60 * 10) / 10), { jobId: r.id, kind: 'avatar' }); } catch (e) {}
      }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    } catch (e) {
      if (ac.signal.aborted || (e && e.code === 'CANCELED')) {
        finish({ status: 'canceled', stage: '已取消' });
        pushLog(r, 'warn', '任务已取消');
      } else {
        failRender2((e && e.message) || String(e));
      }
      try { fs.rmSync(path.join(TMP_DIR, r.id), { recursive: true, force: true }); } catch (e2) {}
    } finally {
      running.delete(r.id);
      if (r.input && r.input.audioPath) {
        try { fs.unlinkSync(r.input.audioPath); } catch (e) {}
      }
    }
  }

  /* 启动自愈：重启后 running 状态的任务不可能还在跑 */
  (function revive() {
    const stuck = renders().filter((r) => r.status === 'running');
    stuck.forEach((r) => {
      r.status = 'failed';
      r.stage = '失败';
      r.error = '服务重启，渲染中断（重新提交即可）';
      upsertRender(r);
    });
    if (stuck.length) store.save(true, 'dh_renders');
    /* 孤儿上传音频清理（> 1 天） */
    try {
      const day = 86400000;
      fs.readdirSync(TMP_DIR).filter((n) => /^dhup-/.test(n)).forEach((n) => {
        const f = path.join(TMP_DIR, n);
        try { if (Date.now() - fs.statSync(f).mtimeMs > day) fs.unlinkSync(f); } catch (e) {}
      });
    } catch (e) {}
  })();

  /* ---------------- 请求体解析（JSON 与 multipart 二合一） ---------------- */
  async function readPayload(req, cap) {
    const ctype = String(req.headers['content-type'] || '');
    const buf = await readBody(req, cap);
    if (/multipart\/form-data/i.test(ctype)) {
      const b = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
      const parts = mp.parse(buf, b ? (b[1] || b[2]).trim() : '');
      return {
        field: (n) => mp.field(parts, n),
        files: (n) => mp.files(parts, n),
        json: null
      };
    }
    let j = {};
    try { j = JSON.parse(buf.toString('utf8') || '{}') || {}; } catch (e) {}
    return { field: (n) => (j[n] == null ? '' : String(j[n])), files: () => [], json: j };
  }

  /* ---------------- 会话：实时应答（文本 → 克隆声音） ---------------- */
  let replySeq = 0;
  async function synthesizeReply(av, text) {
    const dir = path.join(TMP_DIR, 'dh-reply-' + Date.now() + '-' + (++replySeq));
    ensureDir(dir);
    try {
      const vp = av.voice || {};
      const ecTts = require('../edit-capabilities').tts;
      const built = await ecTts.build([text], dir, { voice: vp.baseVoice || '', rate: 1.0 });
      if (!built.ok) return { ok: false, reason: built.message || built.code };
      /* 与录播同一条闭环校准：先测本次合成音实际基频，再算变调比 */
      let ratio = vp.pitchRatio || 1;
      const rawA = await voice.analyze(path.join(dir, built.file), dir).catch(() => null);
      if (rawA && rawA.ok && vp.f0) {
        ratio = Math.max(0.8, Math.min(vp.f0 / rawA.f0, 1.25));
      }
      const pr = await voice.pitchShift(built.file, 'reply_v.wav', ratio, dir);
      if (!pr.ok) return { ok: false, reason: '变调失败：' + pr.error };
      const n = (av.replyCount = (av.replyCount || 0) + 1);
      const name = 'reply_' + n + '.wav';
      fs.copyFileSync(path.join(dir, 'reply_v.wav'), path.join(dirOf(av.id), name));
      av.updatedAt = nowIso();
      upsertAvatar(av);
      const m = await voice.analyze(path.join(dir, 'reply_v.wav'), dir).catch(() => null);
      return { ok: true, file: name, duration: built.duration, f0: m && m.ok ? m.f0 : null };
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
  }

  /* =========================================================
     路由
     ========================================================= */

  /* 媒体分发：给 <img>/<video>/<audio> 直连用，免鉴权（与 /files/ 同一策略） */
  route('GET', /^\/dh\/([A-Za-z0-9_-]{4,40})\/([A-Za-z0-9_.-]+)$/, (req, res, m) => {
    const av = avatarOf(m[1]);
    if (!av) return fail(res, 404, 'NOT_FOUND', '数字人不存在');
    const name = path.basename(decodeURIComponent(m[2]));
    const full = path.join(dirOf(m[1]), name);
    if (!full.startsWith(AVATAR_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return fail(res, 404, 'NOT_FOUND', '文件不存在');
    }
    return sendFile(req, res, full, { range: /\.(mp4|wav)$/i.test(name), maxAge: 600 });
  }, { public: true, desc: '数字人媒体文件（照片/形象帧/待机片/应答音频）' });

  route('GET', /^\/v1\/avatar\/config$/, (req, res) => {
    return ok(res, {
      ratios: Object.keys(media.CANVAS),
      motions: media.MOTIONS,
      modes: [
        { id: 'text', label: '文本驱动', need: '文案 → 克隆声音 + 字幕成片' },
        { id: 'audio', label: '音频驱动', need: '上传音频 → 同画面成片' },
        { id: 'motion', label: '运镜驱动', need: 'breathe/push/pull/pan → 展示片' }
      ],
      photoLimit: PHOTOS_MAX,
      voiceSampleMinSec: 5,
      renderSecondsMax: 120,
      stats: stats()
    });
  }, { desc: '数字人模块能力与统计' });

  /* ---- 形象档案 ---- */
  route('GET', /^\/v1\/avatar\/avatars$/, (req, res) => {
    return ok(res, { avatars: avatars().map(publicAvatar), stats: stats() });
  }, { desc: '数字人列表' });

  route('POST', /^\/v1\/avatar\/avatars$/, async (req, res) => {
    const body = await readPayload(req, 64 * 1024);
    const name = String(body.field('name') || '').trim().slice(0, 24);
    const ratio = String(body.field('ratio') || '9:16');
    if (!name) return fail(res, 400, 'BAD_NAME', '请给数字人起个名字');
    if (!media.CANVAS[ratio]) return fail(res, 400, 'BAD_RATIO', '画幅仅支持 ' + Object.keys(media.CANVAS).join('/'));
    if (avatars().length >= AVATARS_CAP) return fail(res, 400, 'TOO_MANY', '最多 ' + AVATARS_CAP + ' 个数字人档案');
    const rec = {
      id: store.nextId('dh'), owner: tenantOf(req), name, ratio,
      photos: [], base: null, thumb: '', idle: null, voice: null,
      createdAt: Date.now(), created_at: nowIso(), updatedAt: nowIso()
    };
    avatars().unshift(rec);
    ensureDir(dirOf(rec.id));
    upsertAvatar(rec);
    store.event('info', 'avatar', '创建数字人 ' + rec.name, { id: rec.id, ratio });
    return ok(res, { avatar: publicAvatar(rec) });
  }, { desc: '创建数字人档案' });

  route('GET', /^\/v1\/avatar\/avatars\/([A-Za-z0-9_-]{4,40})$/, (req, res, m) => {
    const av = avatarOf(m[1]);
    if (!av) return fail(res, 404, 'NOT_FOUND', '数字人不存在');
    return ok(res, { avatar: publicAvatar(av) });
  }, { desc: '数字人详情' });

  route('DELETE', /^\/v1\/avatar\/avatars\/([A-Za-z0-9_-]{4,40})$/, (req, res, m) => {
    const av = avatarOf(m[1]);
    if (!av) return fail(res, 404, 'NOT_FOUND', '数字人不存在');
    const activeR = renders().filter((r) => r.avatarId === av.id && ['queued', 'running'].indexOf(r.status) > -1);
    if (activeR.length) return fail(res, 409, 'BUSY', '该数字人有渲染任务在进行，请先取消');
    avatars().splice(avatars().indexOf(av), 1);
    store.save(true, 'dh_avatars');
    try { fs.rmSync(dirOf(av.id), { recursive: true, force: true }); } catch (e) {}
    store.event('info', 'avatar', '删除数字人 ' + av.name, { id: av.id });
    return ok(res, { deleted: av.id });
  }, { desc: '删除数字人（连同照片与音频）' });

  /* ---- 照片上传 → 形象复刻 ---- */
  route('POST', /^\/v1\/avatar\/avatars\/([A-Za-z0-9_-]{4,40})\/photos$/, async (req, res, m) => {
    const av = avatarOf(m[1]);
    if (!av) return fail(res, 404, 'NOT_FOUND', '数字人不存在');
    const body = await readPayload(req, PHOTOS_MAX * PHOTO_BYTES + 1024 * 1024);
    const files = body.files('photos').slice(0, PHOTOS_MAX);
    if (!files.length) return fail(res, 400, 'NO_PHOTOS', '请选择 1~' + PHOTOS_MAX + ' 张照片（字段名 photos）');

    const dir = dirOf(av.id);
    const photos = [];
    const rejected = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.data.length > PHOTO_BYTES) { rejected.push({ name: f.filename, reason: '超过 15MB' }); continue; }
      const name = 'p' + Date.now().toString(36) + i + path.extname(safeName(f.filename, '.jpg'));
      fs.writeFileSync(path.join(dir, name), f.data);
      const probe = await ff.probe(path.join(dir, name), dir);
      if (!probe || !probe.width || !probe.height) {
        try { fs.unlinkSync(path.join(dir, name)); } catch (e) {}
        rejected.push({ name: f.filename, reason: '无法识别的图片' }); continue;
      }
      if (Math.min(probe.width, probe.height) < media.MIN_SIDE) {
        try { fs.unlinkSync(path.join(dir, name)); } catch (e) {}
        rejected.push({ name: f.filename, reason: '尺寸过小（短边 ≥ ' + media.MIN_SIDE + 'px）' }); continue;
      }
      photos.push({ name: f.filename, file: name, w: probe.width, h: probe.height, bytes: f.data.length });
    }
    if (!photos.length) return fail(res, 400, 'ALL_REJECTED', '没有可用照片', { rejected });

    const built = await media.buildBase(photos.map((p) => ({ rel: p.file, w: p.w, h: p.h })), dir, av.ratio || '9:16');
    if (!built.ok) return fail(res, 400, 'BASE_FAILED', built.reason, { rejected });

    av.photos = (av.photos || []).concat(photos);
    av.base = { file: built.base, w: built.w, h: built.h, from: built.from };
    av.thumb = built.thumb;
    av.updatedAt = nowIso();
    upsertAvatar(av);
    store.event('info', 'avatar', '形象复刻完成 ' + av.name, { photos: av.photos.length, from: built.from });
    return ok(res, { avatar: publicAvatar(av), added: photos.length, rejected });
  }, { desc: '上传照片并重建基准形象帧' });

  /* ---- 声音样本上传 → 声音复刻 ---- */
  route('POST', /^\/v1\/avatar\/avatars\/([A-Za-z0-9_-]{4,40})\/voice$/, async (req, res, m) => {
    const av = avatarOf(m[1]);
    if (!av) return fail(res, 404, 'NOT_FOUND', '数字人不存在');
    const body = await readPayload(req, AUDIO_BYTES + 1024 * 1024);
    const f = body.files('audio')[0];
    if (!f) return fail(res, 400, 'NO_AUDIO', '请上传一段 ≥5 秒的清晰说话录音（字段名 audio）');
    if (f.data.length > AUDIO_BYTES) return fail(res, 400, 'TOO_LARGE', '语音样本不能超过 40MB');

    const dir = dirOf(av.id);
    const name = 'sample' + Date.now().toString(36) + path.extname(safeName(f.filename, '.wav'));
    fs.writeFileSync(path.join(dir, name), f.data);
    const probe = await ff.probe(path.join(dir, name), dir);
    if (!probe || !probe.duration || probe.duration < 4) {
      try { fs.unlinkSync(path.join(dir, name)); } catch (e) {}
      return fail(res, 400, 'TOO_SHORT', '语音样本太短（需 ≥4 秒，建议 10~30 秒）');
    }

    const a = await voice.analyze(path.join(dir, name), dir);
    if (!a.ok) return fail(res, 400, 'ANALYZE_FAILED', a.reason || '声线分析失败');

    const mv = await voice.matchVoice(a.f0);
    av.voice = {
      ok: true, file: name, duration: a.duration, f0: a.f0,
      energyDb: a.energyDb, voicedRatio: a.voicedRatio, pauseRate: a.pauseRate,
      baseVoice: mv.voice, baseF0: mv.baseF0, pitchRatio: Math.round(mv.pitchRatio * 1000) / 1000,
      reason: mv.reason || '', analyzedAt: nowIso()
    };
    av.updatedAt = nowIso();
    upsertAvatar(av);
    store.event('info', 'avatar', '声线复刻完成 ' + av.name,
      { f0: a.f0, baseVoice: mv.voice, pitchRatio: mv.pitchRatio });
    return ok(res, { avatar: publicAvatar(av) });
  }, { desc: '上传语音样本并重建声线档案' });

  /* ---- 待机循环片 ---- */
  route('POST', /^\/v1\/avatar\/avatars\/([A-Za-z0-9_-]{4,40})\/idle$/, async (req, res, m) => {
    const av = avatarOf(m[1]);
    if (!av) return fail(res, 404, 'NOT_FOUND', '数字人不存在');
    if (!av.base) return fail(res, 400, 'NO_BASE', '请先上传照片生成形象帧');
    const body = await readPayload(req, 64 * 1024);
    const r = await media.buildIdle(dirOf(av.id), body.field('seconds'), body.field('motion'), av.ratio || '9:16');
    if (!r.ok) return fail(res, 500, 'IDLE_FAILED', r.reason);
    av.idle = { file: r.file, duration: r.duration, motion: r.motion };
    av.updatedAt = nowIso();
    upsertAvatar(av);
    return ok(res, { avatar: publicAvatar(av) });
  }, { desc: '生成数字人待机循环片' });

  /* ---- 驱动渲染 ---- */
  route('POST', /^\/v1\/avatar\/renders$/, async (req, res) => {
    const body = await readPayload(req, AUDIO_BYTES + 1024 * 1024);
    const av = avatarOf(String(body.field('avatarId') || ''));
    if (!av) return fail(res, 400, 'BAD_AVATAR', '请指定要驱动的数字人');
    if (!av.base) return fail(res, 400, 'NO_BASE', '该数字人还没有形象帧，请先上传照片');
    const mode = String(body.field('mode') || 'text');
    if (['text', 'audio', 'motion'].indexOf(mode) < 0) return fail(res, 400, 'BAD_MODE', '驱动方式仅支持 text/audio/motion');

    let audioPath = '', audioName = '';
    if (mode === 'audio') {
      const f = body.files('audio')[0];
      if (!f) return fail(res, 400, 'NO_AUDIO', '音频驱动需要上传音频（字段名 audio）');
      if (f.data.length > AUDIO_BYTES) return fail(res, 400, 'TOO_LARGE', '音频不能超过 40MB');
      audioPath = path.join(TMP_DIR, 'dhup-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + path.extname(safeName(f.filename, '.wav')));
      fs.writeFileSync(audioPath, f.data);
      audioName = path.basename(f.filename || 'audio');
    }

    const text = String(body.field('text') || '').trim().slice(0, 2000);
    if (mode === 'text' && !text) return fail(res, 400, 'EMPTY_TEXT', '请输入要数字人说的话');

    const rec = {
      id: store.nextId('dhr'), owner: tenantOf(req), avatarId: av.id, avatarName: av.name,
      mode, motion: String(body.field('motion') || 'breathe'),
      title: String(body.field('title') || '').trim().slice(0, 40) ||
        av.name + ' · ' + ({ text: '文本驱动', audio: '音频驱动', motion: '运镜驱动' }[mode]),
      status: 'queued', progress: 0, stage: '排队等待渲染资源',
      input: { text, rate: clamp(body.field('rate') || 1.0, 0.5, 2), seconds: clamp(body.field('seconds') || 8, 2, 120), audioName, audioPath },
      out: null, voice: null, subtitle: null, match: null,
      logs: [], error: null,
      createdAt: Date.now(), created_at: nowIso()
    };
    submitRender(rec);
    store.event('info', 'avatar', '提交数字人渲染 ' + rec.id, { mode, avatar: av.name });
    return ok(res, { render: publicRender(rec), queue: { running: running.size, active: !!active } });
  }, { desc: '提交驱动渲染（text/audio/motion）' });

  route('GET', /^\/v1\/avatar\/renders$/, (req, res, m) => {
    const u = new URL(req.url, 'http://x');
    let list = renders();
    const avId = u.searchParams.get('avatarId');
    const st = u.searchParams.get('status');
    const mode = u.searchParams.get('mode');
    if (avId) list = list.filter((r) => r.avatarId === avId);
    if (st) list = list.filter((r) => r.status === st);
    if (mode) list = list.filter((r) => r.mode === mode);
    return ok(res, { renders: list.slice(0, Number(u.searchParams.get('limit') || 50)).map(publicRender), stats: stats() });
  }, { desc: '渲染任务列表' });

  route('GET', /^\/v1\/avatar\/renders\/([A-Za-z0-9_-]{4,40})$/, (req, res, m) => {
    const r = renderOf(m[1]);
    if (!r) return fail(res, 404, 'NOT_FOUND', '渲染任务不存在');
    return ok(res, { render: publicRender(r) });
  }, { desc: '渲染任务详情（轮询进度用）' });

  route('POST', /^\/v1\/avatar\/renders\/([A-Za-z0-9_-]{4,40})\/cancel$/, (req, res, m) => {
    const r = renderOf(m[1]);
    if (!r) return fail(res, 404, 'NOT_FOUND', '渲染任务不存在');
    if (['done', 'failed', 'canceled'].indexOf(r.status) > -1) {
      return fail(res, 409, 'ALREADY_DONE', '任务已结束（' + r.status + '）');
    }
    const ac = running.get(r.id);
    if (ac) ac.abort();
    r.status = 'canceled'; r.stage = '已取消';
    pushLog(r, 'warn', '收到取消请求');
    upsertRender(r);
    return ok(res, { render: publicRender(r) });
  }, { desc: '取消渲染任务' });

  route('DELETE', /^\/v1\/avatar\/renders\/([A-Za-z0-9_-]{4,40})$/, (req, res, m) => {
    const r = renderOf(m[1]);
    if (!r) return fail(res, 404, 'NOT_FOUND', '渲染任务不存在');
    if (r.status === 'running') return fail(res, 409, 'BUSY', '渲染中，请先取消');
    if (r.out && r.out.file) { try { fs.unlinkSync(path.join(OUT_DIR, r.out.file)); } catch (e) {} }
    if (r.out && r.out.cover) { try { fs.unlinkSync(path.join(OUT_DIR, r.out.cover)); } catch (e) {} }
    renders().splice(renders().indexOf(r), 1);
    store.save(true, 'dh_renders');
    return ok(res, { deleted: r.id });
  }, { desc: '删除渲染任务与成片' });

  /* ---- 会话（直播 / 对话） ---- */
  route('GET', /^\/v1\/avatar\/sessions$/, (req, res) => {
    return ok(res, { sessions: sessions().map(publicSession), stats: stats() });
  }, { desc: '会话列表' });

  route('POST', /^\/v1\/avatar\/sessions$/, async (req, res) => {
    const body = await readPayload(req, 64 * 1024);
    const av = avatarOf(String(body.field('avatarId') || ''));
    if (!av) return fail(res, 400, 'BAD_AVATAR', '请指定数字人');
    const mode = String(body.field('mode') || 'dialog');
    if (['live', 'dialog'].indexOf(mode) < 0) return fail(res, 400, 'BAD_MODE', '会话仅支持 live/dialog');
    let playlist = [];
    try { playlist = JSON.parse(body.field('playlist') || '[]'); } catch (e) {}
    playlist = (Array.isArray(playlist) ? playlist : [])
      .filter((rid) => { const r = renderOf(rid); return r && r.status === 'done'; }).slice(0, 30);
    const rec = {
      id: store.nextId('dhs'), owner: tenantOf(req), avatarId: av.id, mode,
      playlist, turns: [], status: 'running',
      createdAt: Date.now(), created_at: nowIso()
    };
    sessions().unshift(rec);
    if (sessions().length > 100) sessions().length = 100;
    saveSessions();
    store.event('info', 'avatar', '开启' + (mode === 'live' ? '直播' : '对话') + '会话 ' + av.name, { id: rec.id, playlist: playlist.length });
    return ok(res, { session: publicSession(rec) });
  }, { desc: '开启直播/对话会话' });

  route('GET', /^\/v1\/avatar\/sessions\/([A-Za-z0-9_-]{4,40})$/, (req, res, m) => {
    const s = sessionOf(m[1]);
    if (!s) return fail(res, 404, 'NOT_FOUND', '会话不存在');
    return ok(res, { session: publicSession(s) });
  }, { desc: '会话详情（轮询轮次）' });

  route('POST', /^\/v1\/avatar\/sessions\/([A-Za-z0-9_-]{4,40})\/stop$/, (req, res, m) => {
    const s = sessionOf(m[1]);
    if (!s) return fail(res, 404, 'NOT_FOUND', '会话不存在');
    s.status = 'stopped'; s.stoppedAt = nowIso();
    saveSessions();
    return ok(res, { session: publicSession(s) });
  }, { desc: '结束会话' });

  route('POST', /^\/v1\/avatar\/sessions\/([A-Za-z0-9_-]{4,40})\/reply$/, async (req, res, m) => {
    const s = sessionOf(m[1]);
    if (!s) return fail(res, 404, 'NOT_FOUND', '会话不存在');
    if (s.status !== 'running') return fail(res, 409, 'STOPPED', '会话已结束');
    const av = avatarOf(s.avatarId);
    if (!av) return fail(res, 404, 'NOT_FOUND', '数字人不存在');
    const body = await readPayload(req, 64 * 1024);
    const text = String(body.field('text') || '').trim().slice(0, 300);
    if (!text) return fail(res, 400, 'EMPTY_TEXT', '请输入要说的话');

    const t0 = Date.now();
    const r = await synthesizeReply(av, text);
    if (!r.ok) return fail(res, 500, 'REPLY_FAILED', r.reason || '应答合成失败');
    const turn = { role: 'avatar', text, audio: '/dh/' + av.id + '/' + r.file, duration: r.duration, f0: r.f0, at: nowIso() };
    s.turns = (s.turns || []).concat([turn]).slice(-100);
    saveSessions();
    store.event('info', 'avatar', '数字人应答', { session: s.id, ms: Date.now() - t0 });
    return ok(res, { turn, elapsedMs: Date.now() - t0 });
  }, { desc: '数字人实时应答（文本 → 克隆声音）' });

  return { stats, publicAvatar, publicRender, pump };
}

module.exports = { attach };
