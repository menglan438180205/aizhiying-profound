'use strict';
/* =========================================================
   scripts/dh-e2e.js — AI数字人模块端到端自测
   前置：node server/index.js 已在本机跑起来（默认 127.0.0.1:8799）
   用法：node scripts/dh-e2e.js [port]
   覆盖：建档 → 照片→形象帧 → 语音→声线档案 → 待机片
         → 文本/运镜两种驱动渲染 → 会话应答 → 媒体可达性
   ========================================================= */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const PORT = Number(process.argv[2] || process.env.PORT || 8799);
const BASE = String(process.env.DH_BASE || ('http://127.0.0.1:' + PORT)).replace(/\/+$/, '');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-e2e-'));

let failed = 0;
const TOKEN = String(process.env.DH_TOKEN || '').replace(/\s/g, '');  /* 线上验证时经环境变量注入，绝不写进代码 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';  /* Cloudflare 拦非浏览器 UA */
function authHeaders(extra) {
  const h = Object.assign({ 'User-Agent': UA }, extra || {});
  if (TOKEN) h.Authorization = 'Bearer ' + TOKEN;
  return h;
}
function head(s) { console.log('\n== ' + s + ' =='); }
function step(name, cond, detail) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail ? ' · ' + detail : ''));
  if (!cond) failed++;
}
async function j(method, url, body) {
  const opt = { method, headers: authHeaders() };
  if (body !== undefined) {
    opt.body = JSON.stringify(body);
    opt.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + url, opt);
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}
async function upload(url, form) {
  const res = await fetch(BASE + url, { method: 'POST', body: form, headers: authHeaders() });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}
async function poll(url, until, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 180000)) {
    const r = await j('GET', url);
    const st = r.json && r.json.render && r.json.render.status;
    if (st && until.indexOf(st) > -1) return r.json.render;
    await new Promise((s) => setTimeout(s, 1500));
  }
  return null;
}

async function main() {
  head('环境');
  const cfg = await j('GET', '/v1/avatar/config');
  step('config 可达', cfg.status === 200 && cfg.json.ok, JSON.stringify(cfg.json.stats || {}));

  /* 1. 建档 */
  head('1. 创建数字人档案');
  const av = await j('POST', '/v1/avatar/avatars', { name: '主播小织', ratio: '9:16' });
  step('创建成功', av.status === 200 && av.json.avatar, av.json.avatar && av.json.avatar.id);
  const id = av.json.avatar.id;

  /* 2. 造三张测试照片（模拟"少量照片"），上传并复刻形象 */
  head('2. 形象复刻（3 张照片 → 基准形象帧）');
  const photos = [];
  const sizes = [[900, 1200], [1400, 1000], [700, 700]];
  sizes.forEach((s, i) => {
    const f = path.join(WORK, 'p' + i + '.jpg');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'gradients=s=' + s[0] + 'x' + s[1] + ':c0=0x27405e:c1=0x9fd0ff:d=1',
      '-frames:v', '1', f]);
    photos.push(f);
  });
  let fd = new FormData();
  photos.forEach((f) => fd.append('photos', new Blob([fs.readFileSync(f)]), path.basename(f)));
  const ph = await upload('/v1/avatar/avatars/' + id + '/photos', fd);
  step('照片上传', ph.status === 200, 'rejected=' + JSON.stringify(ph.json.rejected || []));
  step('形象帧生成', !!(ph.json.avatar && ph.json.avatar.base),
    ph.json.avatar && ph.json.avatar.base && (ph.json.avatar.base.w + 'x' + ph.json.avatar.base.h));

  /* 3. 声音复刻：用本地 TTS 造一段"本人录音"再回传分析 */
  head('3. 声音复刻（语音样本 → 声线档案）');
  const tts = require('../server/edit-capabilities/tts');
  const sample = path.join(WORK, 'sample.wav');
  const st = await tts.status(true);
  step('本机有可用语音包', st.ok, st.cjkVoice || st.reason);
  const syn = await tts.synthesize(
    '各位老板好，今天我们聊聊本地生活团购怎么做出效果，一共三个要点，先说第一个，选品要贴合商圈半径三公里内的真实需求。',
    sample, {});
  step('样本合成（模拟本人录音）', syn.ok, syn.voice);
  fd = new FormData();
  fd.append('audio', new Blob([fs.readFileSync(sample)]), 'sample.wav');
  const vc = await upload('/v1/avatar/avatars/' + id + '/voice', fd);
  const vp = vc.json && vc.json.avatar && vc.json.avatar.voice;
  step('声线档案生成', !!vp && vp.ok,
    vp ? ('f0=' + vp.f0 + 'Hz 底嗓=' + vp.baseVoice + ' 变调×' + vp.pitchRatio) : JSON.stringify(vc.json));

  /* 4. 待机循环片 */
  head('4. 待机循环片');
  const idle = await j('POST', '/v1/avatar/avatars/' + id + '/idle', { seconds: 4, motion: 'breathe' });
  step('待机片生成', !!(idle.json.avatar && idle.json.avatar.idle),
    idle.json.avatar && idle.json.avatar.idle && (idle.json.avatar.idle.duration + 's'));

  /* 5. 文本驱动渲染 */
  head('5. 文本驱动渲染');
  const rt = await j('POST', '/v1/avatar/renders', {
    avatarId: id, mode: 'text', title: '数字人自测 · 文本驱动',
    text: '各位老板好，欢迎来到直播间。今天我们聊三个要点：选品、投放、核销闭环。想要方案的，评论区扣一个一，我把案例发给你。'
  });
  step('任务提交', rt.status === 200 && rt.json.render, rt.json.render && rt.json.render.id);
  const doneT = await poll('/v1/avatar/renders/' + rt.json.render.id, ['done', 'failed', 'canceled']);
  step('文本驱动完成', !!doneT && doneT.status === 'done',
    doneT ? ('stage=' + doneT.stage + ' out=' + (doneT.out && doneT.out.url)) : '超时');
  if (doneT && doneT.status === 'done') {
    step('克隆声线回测', !!(doneT.match && doneT.match.outF0),
      doneT.match ? ('样本 ' + doneT.match.sampleF0 + 'Hz → 成片 ' + doneT.match.outF0 + 'Hz（偏差 ' + doneT.match.delta + '%）') : '');
    step('字幕烧录', !!(doneT.subtitle && doneT.subtitle.ok), doneT.subtitle && doneT.subtitle.mode);
  }

  /* 6. 运镜驱动渲染 */
  head('6. 运镜驱动渲染');
  const rm = await j('POST', '/v1/avatar/renders', { avatarId: id, mode: 'motion', motion: 'push', seconds: 4 });
  const doneM = await poll('/v1/avatar/renders/' + rm.json.render.id, ['done', 'failed', 'canceled']);
  step('运镜驱动完成', !!doneM && doneM.status === 'done', doneM && doneM.out && ('时长 ' + doneM.out.duration + 's'));

  /* 7. 会话（直播/对话）：实时应答 */
  head('7. 会话与实时应答');
  const ss = await j('POST', '/v1/avatar/sessions', { avatarId: id, mode: 'dialog' });
  step('会话开启', ss.status === 200 && ss.json.session, ss.json.session && ss.json.session.id);
  const sid = ss.json.session.id;
  const t0 = Date.now();
  const rp = await j('POST', '/v1/avatar/sessions/' + sid + '/reply', { text: '好的，我现在把合作案例发给你，请留意私信。' });
  step('实时应答', rp.status === 200 && rp.json.turn && rp.json.turn.audio,
    rp.json.turn ? ('音频 ' + rp.json.turn.audio + ' · ' + rp.json.elapsedMs + 'ms') : JSON.stringify(rp.json));
  const av2 = await j('GET', '/v1/avatar/avatars/' + id);
  step('媒体可达（形象帧）', (await fetch(BASE + av2.json.avatar.base.url)).status === 200);
  if (rp.json.turn && rp.json.turn.audio) {
    const au = await fetch(BASE + rp.json.turn.audio);
    step('媒体可达（应答音频）', au.status === 200, Math.round((await au.arrayBuffer()).byteLength / 1024) + 'KB');
  }
  if (doneT && doneT.out) {
    const vid = await fetch(BASE + doneT.out.url, { headers: { Range: 'bytes=0-1023' } });
    step('成片可拖动播放（206 Range）', vid.status === 206, doneT.out.url);
  }

  /* 8. 列表与统计 */
  head('8. 统计');
  const ls = await j('GET', '/v1/avatar/renders');
  console.log('  renders:', JSON.stringify(ls.json.stats.renders), 'byMode:', JSON.stringify(ls.json.stats.byMode));

  console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 全部通过'));
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
