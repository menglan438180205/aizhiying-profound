
/* =========================================================
   AI数字人 · 三栏工作台
   · 左：数字人库（新建 / 选择）
   · 中：形象克隆 + 声音复刻 + 三种驱动（文本/音频/运镜）+ 预览
   · 右：产出台账 + 直播/对话会话
   数据全部来自 /v1/avatar/* 与 /dh/、/files/，页面不写死任何数字。
   ========================================================= */
(function dhConsole() {
  'use strict';
  var API = window.Api;
  if (!API) { console.warn('[dh] Api 未就绪，数字人工作台跳过初始化'); return; }

  var S = {
    cfg: {}, avatars: [], cur: null, renders: [], session: null,
    mode: 'text', audioFile: null,
    activeId: '', pollTimer: null, sessTimer: null, retries: 0, started: false,
    playIdx: -1
  };
  var KEY_LAST = 'aizy.dh.last';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function num(n) { return String(Math.round(Number(n) || 0)); }
  function secs(n) { return (Math.round((Number(n) || 0) * 10) / 10) + 's'; }
  function ago(ts) {
    if (!ts) return '—';
    var d = Date.now() - (typeof ts === 'number' ? ts : Date.parse(ts));
    if (!(d > 0)) return '刚刚';
    if (d < 60000) return Math.max(1, Math.round(d / 1000)) + ' 秒前';
    if (d < 3600000) return Math.round(d / 60000) + ' 分钟前';
    return Math.round(d / 3600000) + ' 小时前';
  }
  function fileUrl(u) { return u ? API.fileUrl(u) : ''; }
  function get(p) { return API.call(p, null, { method: 'GET', timeout: 20000 }); }
  function post(p, body) { return API.call(p, body || {}, { timeout: 60000 }); }
  function up(p, form) { return API.upload(p, form, { timeout: 300000 }); }

  function showBar(kind, title, sub) {
    var dot = $('dhDot');
    if (dot) dot.className = 'cc-dot ' + kind;
    if ($('dhStateText')) $('dhStateText').textContent = title;
    if ($('dhStateSub')) $('dhStateSub').textContent = sub || '';
  }

  /* ---------- 拉数据 ---------- */
  async function loadConfig() {
    var r = await get('/v1/avatar/config');
    if (r && r.ok && r.data) S.cfg = r.data;
  }
  async function loadAvatars(keepSel) {
    var r = await get('/v1/avatar/avatars');
    if (!(r && r.ok && r.data)) {
      showBar('err', '数字人服务不可达', (r && r.error) || '');
      return;
    }
    S.avatars = r.data.avatars || [];
    renderStats(r.data.stats);
    var sel = keepSel && S.cur ? S.cur.id : '';
    try {
      var last = localStorage.getItem(KEY_LAST);
      if (!sel && last) sel = last;
    } catch (e) {}
    S.cur = null;
    S.avatars.forEach(function (a) { if (a.id === sel) S.cur = a; });
    if (!S.cur && S.avatars.length) S.cur = S.avatars[0];
    if (S.cur) { try { localStorage.setItem(KEY_LAST, S.cur.id); } catch (e) {} }
    renderAvatarList();
    renderWorkspace();
  }
  async function loadRenders() {
    if (!S.cur) { S.renders = []; renderRenders(); return; }
    var r = await get('/v1/avatar/renders?avatarId=' + encodeURIComponent(S.cur.id) + '&limit=40');
    if (r && r.ok && r.data) {
      S.renders = r.data.renders || [];
      renderStats(r.data.stats);
      renderRenders();
      resumeActive();
    }
  }

  function renderStats(st) {
    st = st || {};
    var rs = st.renders || {};
    if ($('dhKpiAvatars')) $('dhKpiAvatars').textContent = num(st.avatars);
    if ($('dhKpiRenders')) $('dhKpiRenders').textContent = num(rs.done);
    if ($('dhKpiSeconds')) $('dhKpiSeconds').textContent = secs(st.totalSeconds);
    if ($('dhKpiSessions')) $('dhKpiSessions').textContent = num(st.sessions && st.sessions.running);
    var ok = S.avatars.length > 0;
    showBar(ok ? 'ok' : 'warn',
      ok ? '数字人服务已就绪' : '还没有数字人档案',
      ok ? ('成片 ' + num(rs.done) + ' · 失败 ' + num(rs.failed) + ' · 累计 ' + secs(st.totalSeconds))
        : '先新建档案 → 上传照片与语音样本 → 三种驱动渲染');
  }

  /* ---------- 左栏：数字人列表 ---------- */
  function renderAvatarList() {
    var box = $('dhAvatars');
    if (!box) return;
    if ($('dhAvCount')) $('dhAvCount').textContent = S.avatars.length ? S.avatars.length + ' 个' : '';
    if (!S.avatars.length) {
      box.innerHTML = '<div class="cc-empty">还没有数字人<br><b>点右上「新建数字人」开始</b></div>';
      return;
    }
    box.innerHTML = S.avatars.map(function (a) {
      return '<div class="dh-av' + (S.cur && S.cur.id === a.id ? ' on' : '') + '" data-id="' + esc(a.id) + '">' +
        (a.thumb ? '<img src="' + esc(fileUrl(a.thumb)) + '" alt="">'
          : '<div class="dh-av-ph">无形象</div>') +
        '<div class="dh-av-main"><b>' + esc(a.name) + '</b><span>' + esc(a.ratio) + ' · ' + ago(a.createdAt) + '</span>' +
        '<div class="dh-tags">' +
        '<span class="dh-tag' + (a.hasBase ? ' ok' : '') + '">' + (a.hasBase ? '形象✓' : '形象待传') + '</span>' +
        '<span class="dh-tag' + (a.hasVoice ? ' ok' : '') + '">' + (a.hasVoice ? '声线✓' : '声线待传') + '</span>' +
        (a.idle ? '<span class="dh-tag">待机片</span>' : '') +
        '</div></div>' +
        '<button class="cc-act ghost" data-del="' + esc(a.id) + '" title="删除">✕</button>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.dh-av'), function (el) {
      el.addEventListener('click', function (ev) {
        var del = ev.target.closest ? ev.target.closest('[data-del]') : null;
        if (del) { ev.stopPropagation(); removeAvatar(del.getAttribute('data-del')); return; }
        selectAvatar(el.getAttribute('data-id'));
      });
    });
  }

  function selectAvatar(id) {
    var hit = S.avatars.filter(function (a) { return a.id === id; })[0];
    if (!hit) return;
    S.cur = hit;
    try { localStorage.setItem(KEY_LAST, id); } catch (e) {}
    renderAvatarList();
    renderWorkspace();
    loadRenders();
    loadSessions();
  }

  async function removeAvatar(id) {
    if (!confirm('删除这个数字人？照片与语音样本会一并删除。')) return;
    var r = await API.call('/v1/avatar/avatars/' + encodeURIComponent(id), null, { method: 'DELETE', timeout: 30000 });
    if (!(r && r.ok)) { alert((r && r.error) || '删除失败'); return; }
    if (S.cur && S.cur.id === id) S.cur = null;
    loadAvatars();
  }

  async function createAvatar() {
    var name = ($('dhFormName') && $('dhFormName').value || '').trim();
    var ratio = ($('dhFormRatio') && $('dhFormRatio').value) || '9:16';
    if (!name) { if ($('dhFormErr')) $('dhFormErr').textContent = '请先起个名字'; return; }
    if ($('dhFormErr')) $('dhFormErr').textContent = '';
    var r = await post('/v1/avatar/avatars', { name: name, ratio: ratio });
    if (!(r && r.ok)) { if ($('dhFormErr')) $('dhFormErr').textContent = (r && r.error) || '创建失败'; return; }
    if ($('dhFormName')) $('dhFormName').value = '';
    $('dhForm').style.display = 'none';
    await loadAvatars();
    if (r.data && r.data.avatar) selectAvatar(r.data.avatar.id);
  }

  /* ---------- 中栏：资产 + 驱动 ---------- */
  function renderWorkspace() {
    var has = !!S.cur;
    if ($('dhEmpty')) $('dhEmpty').style.display = has ? 'none' : '';
    if ($('dhWorkspace')) $('dhWorkspace').style.display = has ? '' : 'none';
    if (!has) {
      if ($('dhCurName')) $('dhCurName').textContent = '未选择数字人';
      if ($('dhCurMeta')) $('dhCurMeta').textContent = '';
      return;
    }
    var a = S.cur;
    if ($('dhCurName')) $('dhCurName').textContent = a.name;
    if ($('dhCurMeta')) $('dhCurMeta').textContent = a.ratio + ' · 建于 ' + ago(a.createdAt);

    var img = $('dhBaseImg');
    if (img) {
      if (a.base) {
        img.innerHTML = '<img src="' + esc(fileUrl(a.base.url)) + '" style="width:100%;height:100%;object-fit:cover;border-radius:12px" alt="形象帧">';
      } else img.innerHTML = '形象帧<br>未生成';
    }
    if ($('dhPhotoMeta')) $('dhPhotoMeta').textContent = a.photos.length ? a.photos.length + ' 张照片' : '未上传';
    var im = $('dhImgMetrics');
    if (im) {
      im.innerHTML = a.base
        ? '<div class="dh-metric"><b>' + a.base.w + '×' + a.base.h + '</b><span>基准形象帧</span></div>' +
          '<div class="dh-metric"><b>' + a.photos.length + '</b><span>照片素材</span></div>'
        : '<div class="dh-metric"><b>—</b><span>形象帧未生成</span></div>' +
          '<div class="dh-metric"><b>' + a.photos.length + '</b><span>照片素材</span></div>';
    }
    var vm = $('dhVoiceMetrics');
    if (vm) {
      vm.innerHTML = a.voice
        ? '<div class="dh-metric"><b>' + a.voice.f0 + ' Hz</b><span>样本基频</span></div>' +
          '<div class="dh-metric"><b>' + esc(a.voice.baseVoice || '默认') + '</b><span>底嗓 · 变调×' + a.voice.pitchRatio + '</span></div>' +
          '<div class="dh-metric"><b>' + secs(a.voice.duration) + '</b><span>样本时长</span></div>' +
          '<div class="dh-metric"><b>' + Math.round((a.voice.voicedRatio || 0) * 100) + '%</b><span>有效发声</span></div>'
        : '<div class="dh-metric"><b>—</b><span>未上传语音样本</span></div>';
    }
    if ($('dhVoiceMeta')) $('dhVoiceMeta').textContent = a.voice ? '档案更新于 ' + ago(Date.parse(a.voice.analyzedAt)) : '未配置';
    if ($('dhIdleBtn')) $('dhIdleBtn').style.display = a.hasBase ? '' : 'none';
    setPreview(a.idle ? a.idle.url : (a.base ? a.base.url : ''), a.idle ? '待机循环片' : '基准形象帧', !a.idle);
  }

  var previewIsImg = false;
  function setPreview(url, meta, isImg) {
    previewIsImg = !!isImg;
    var p = $('dhPlayer');
    if (!p) return;
    if (!url) { p.removeAttribute('src'); p.load(); if ($('dhPreviewMeta')) $('dhPreviewMeta').textContent = meta || ''; return; }
    if (isImg) { p.removeAttribute('src'); p.load(); }
    else {
      p.src = fileUrl(url);
      try { p.play().catch(function () {}); } catch (e) {}
    }
    if ($('dhPreviewMeta')) $('dhPreviewMeta').textContent = meta || '';
  }

  /* ---- 上传 ---- */
  function bindFile(btnId, inputId, cb) {
    var btn = $(btnId), input = $(inputId);
    if (!btn || !input) return;
    btn.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { if (input.files && input.files.length) cb(input.files); });
  }

  async function uploadPhotos(files) {
    if (!S.cur) return;
    var fd = new FormData();
    for (var i = 0; i < files.length; i++) fd.append('photos', files[i], files[i].name);
    busy('dhPhotoBtn', true, '上传中…');
    var r = await up('/v1/avatar/avatars/' + S.cur.id + '/photos', fd);
    busy('dhPhotoBtn', false, '');
    if (!(r && r.ok)) { alert((r && (r.error || r.json && r.json.message)) || '照片上传失败'); return; }
    if (r.data && r.data.avatar) { S.cur = mergeAvatar(r.data.avatar); renderAvatarList(); renderWorkspace(); }
    var rej = (r.data && r.data.rejected || []);
    if (rej.length) alert('有 ' + rej.length + ' 张被拒：' + rej.map(function (x) { return x.name + '(' + x.reason + ')'; }).join('、'));
  }

  async function uploadVoice(files) {
    if (!S.cur) return;
    var fd = new FormData();
    fd.append('audio', files[0], files[0].name);
    busy('dhVoiceBtn', true, '分析中（约 10 秒）…');
    var r = await up('/v1/avatar/avatars/' + S.cur.id + '/voice', fd);
    busy('dhVoiceBtn', false, '');
    if (!(r && r.ok)) { alert((r && (r.error || r.json && r.json.message)) || '声线分析失败'); return; }
    if (r.data && r.data.avatar) { S.cur = mergeAvatar(r.data.avatar); renderAvatarList(); renderWorkspace(); }
  }

  function mergeAvatar(a) {
    for (var i = 0; i < S.avatars.length; i++) if (S.avatars[i].id === a.id) { S.avatars[i] = a; return a; }
    S.avatars.unshift(a);
    return a;
  }

  function busy(id, on, txt) {
    var b = $(id);
    if (!b) return;
    b.disabled = !!on;
    if (on && txt) b.textContent = txt;
    else b.removeAttribute('style');
  }

  async function buildIdle() {
    if (!S.cur) return;
    busy('dhIdleBtn', true, '生成中…');
    var r = await post('/v1/avatar/avatars/' + S.cur.id + '/idle', { seconds: 8, motion: 'breathe' });
    busy('dhIdleBtn', false, '');
    if (!(r && r.ok)) { alert((r && r.error) || '待机片生成失败'); return; }
    if (r.data && r.data.avatar) { S.cur = mergeAvatar(r.data.avatar); renderAvatarList(); renderWorkspace(); }
  }

  /* ---- 驱动渲染 ---- */
  function bindTabs() {
    var tabs = $('dhTabs');
    if (!tabs) return;
    Array.prototype.forEach.call(tabs.querySelectorAll('.dh-tab'), function (t) {
      t.addEventListener('click', function () {
        S.mode = t.getAttribute('data-mode');
        Array.prototype.forEach.call(tabs.querySelectorAll('.dh-tab'), function (x) { x.className = 'dh-tab' + (x === t ? ' on' : ''); });
        if ($('dhPaneText')) $('dhPaneText').style.display = S.mode === 'text' ? '' : 'none';
        if ($('dhPaneAudio')) $('dhPaneAudio').style.display = S.mode === 'audio' ? '' : 'none';
        if ($('dhPaneMotion')) $('dhPaneMotion').style.display = S.mode === 'motion' ? '' : 'none';
      });
    });
  }

  async function submitRender(payload, isForm) {
    if (!S.cur) { alert('先选择数字人'); return; }
    var r = isForm ? await up('/v1/avatar/renders', payload) : await post('/v1/avatar/renders', payload);
    if (!(r && r.ok && r.data && r.data.render)) {
      alert((r && (r.error || r.json && r.json.message)) || '提交失败');
      return;
    }
    S.activeId = r.data.render.id;
    trackActive();
    loadRenders();
  }

  async function trackActive() {
    if (!S.activeId) return;
    var wrap = $('dhProgWrap'), bar = $('dhProg'), txt = $('dhProgText');
    if (wrap) wrap.style.display = '';
    var r = await get('/v1/avatar/renders/' + encodeURIComponent(S.activeId));
    var job = r && r.ok && r.data && r.data.render;
    if (!job) { if (wrap) wrap.style.display = 'none'; S.activeId = ''; return; }
    if (bar) bar.style.width = Math.max(3, job.progress || 3) + '%';
    if (txt) txt.textContent = job.stage + ' · ' + (job.progress || 0) + '%';
    if (job.status === 'queued' || job.status === 'running') {
      clearTimeout(S.pollTimer);
      S.pollTimer = setTimeout(trackActive, 1500);
      return;
    }
    S.activeId = '';
    if (wrap) wrap.style.display = 'none';
    if (job.status === 'done' && job.out) {
      if (txt) txt.textContent = '成片 ' + secs(job.out.duration) + ' · ' + Math.round(job.out.bytes / 1024) + 'KB' +
        (job.match && job.match.outF0 ? ' · 声线回测 ' + job.match.outF0 + 'Hz（偏差 ' + job.match.delta + '%）' : '');
      setPreview(job.out.url, '成片 · ' + job.title);
    } else if (txt) {
      txt.textContent = '失败：' + (job.error || '未知原因');
    }
    loadRenders();
  }

  function resumeActive() {
    var act = S.renders.filter(function (r) { return r.status === 'queued' || r.status === 'running'; })[0];
    if (act && !S.activeId) { S.activeId = act.id; trackActive(); }
  }

  /* ---- 右栏：产出台账 ---- */
  function renderRenders() {
    var box = $('dhRenders');
    if (!box) return;
    if ($('dhOutMeta')) $('dhOutMeta').textContent = S.renders.length ? S.renders.length + ' 条' : '';
    if (!S.renders.length) {
      box.innerHTML = '<div class="cc-empty">还没有成片<br><b>在中栏选一种驱动开始</b></div>';
      return;
    }
    var MODE = { text: '文本', audio: '音频', motion: '运镜' };
    var ST = { queued: '排队', running: '渲染中', done: '完成', failed: '失败', canceled: '已取消' };
    box.innerHTML = S.renders.map(function (r) {
      return '<div class="dh-ri" data-id="' + esc(r.id) + '">' +
        '<div class="dh-ri-top"><span class="cc-tg-type">' + (MODE[r.mode] || r.mode) + '</span>' +
        '<b>' + esc(r.title) + '</b>' +
        '<span class="cc-st ' + (r.status === 'done' ? 'wechat' : r.status === 'failed' ? 'lost' : 'contacted') + '">' + (ST[r.status] || r.status) + '</span></div>' +
        '<div class="dh-ri-sub">' +
        (r.status === 'done' && r.out
          ? '时长 <em>' + secs(r.out.duration) + '</em> · ' + Math.round(r.out.bytes / 1024) + 'KB' +
            (r.match && r.match.outF0 ? ' · 回测 <em>' + r.match.outF0 + 'Hz</em>' + (r.match.delta != null ? '（偏差 ' + r.match.delta + '%）' : '') : '') +
            (r.subtitle && r.subtitle.ok ? ' · 有字幕' : '')
          : esc(r.stage || '') + (r.error ? ' · ' + esc(r.error) : '')) +
        ' · ' + ago(r.createdAt) + '</div></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.dh-ri'), function (el) {
      el.addEventListener('click', function () {
        var hit = S.renders.filter(function (r) { return r.id === el.getAttribute('data-id'); })[0];
        if (hit && hit.out) setPreview(hit.out.url, '成片 · ' + hit.title);
      });
    });
  }

  /* ---- 会话：直播 / 对话 ---- */
  async function loadSessions() {
    if (!S.cur) return;
    var r = await get('/v1/avatar/sessions');
    if (!(r && r.ok && r.data)) return;
    var mine = (r.data.sessions || []).filter(function (s) { return s.avatarId === S.cur.id; });
    var run = mine.filter(function (s) { return s.status === 'running'; })[0];
    S.session = run || mine[0] || null;
    renderSession();
  }

  async function openSession(mode) {
    if (!S.cur) { alert('先选择数字人'); return; }
    var playlist = [];
    if (mode === 'live') {
      playlist = S.renders.filter(function (r) { return r.status === 'done'; }).map(function (r) { return r.id; }).slice(0, 30);
      if (!playlist.length) { alert('直播会话需要至少一条已完成成片作循环播放内容'); return; }
    }
    var r = await post('/v1/avatar/sessions', { avatarId: S.cur.id, mode: mode, playlist: playlist });
    if (!(r && r.ok && r.data && r.data.session)) { alert((r && r.error) || '会话开启失败'); return; }
    S.session = r.data.session;
    renderSession();
    if (mode === 'live') playPlaylist();
  }

  function renderSession() {
    var s = S.session;
    var stop = $('dhSessStop');
    if (stop) stop.style.display = s && s.status === 'running' ? '' : 'none';
    if ($('dhSessMeta')) $('dhSessMeta').textContent = s ? (s.mode === 'live' ? '直播' : '对话') + ' · ' + ago(s.createdAt) : '';
    if ($('dhSessState')) {
      $('dhSessState').textContent = !s ? '未开启会话'
        : s.status !== 'running' ? '已结束'
        : s.mode === 'live' ? '直播中：循环播放成片，弹幕回复会用数字人的声音实时应答'
        : '对话中：输入文本，数字人用克隆声音回答';
    }
    var box = $('dhTurns');
    if (!box) return;
    var turns = (s && s.turns) || [];
    box.innerHTML = turns.length ? turns.map(function (t) {
      return '<div class="dh-turn"><b>' + esc(t.role === 'avatar' ? '数字人' : '访客') + '：</b>' + esc(t.text) +
        (t.audio ? '<audio controls preload="none" src="' + esc(fileUrl(t.audio)) + '"></audio>' : '') +
        (t.f0 ? '<div class="cc-ph-sub">基频 ' + t.f0 + 'Hz · ' + secs(t.duration) + '</div>' : '') +
        '</div>';
    }).join('') : '<div class="cc-ph-sub">暂无轮次</div>';
  }

  function playPlaylist() {
    var s = S.session;
    if (!s || !s.playlist || !s.playlist.length) return;
    S.playIdx = -1;
    playNext();
  }
  function playNext() {
    var s = S.session;
    if (!s || s.status !== 'running') return;
    var list = s.playlist || [];
    if (!list.length) return;
    S.playIdx = (S.playIdx + 1) % list.length;
    var item = list[S.playIdx];
    var p = $('dhPlayer');
    if (!p) return;
    previewIsImg = false;
    p.src = fileUrl(item.url);
    if ($('dhPreviewMeta')) $('dhPreviewMeta').textContent = '直播循环 · ' + item.title;
    try { p.play().catch(function () {}); } catch (e) {}
  }

  async function sendReply() {
    var input = $('dhSay');
    var text = (input && input.value || '').trim();
    if (!text || !S.session || S.session.status !== 'running') return;
    input.value = '';
    var r = await post('/v1/avatar/sessions/' + encodeURIComponent(S.session.id) + '/reply', { text: text });
    if (!(r && r.ok)) { alert((r && r.error) || '应答失败'); return; }
    await loadSessions();
    if (r.data && r.data.turn && r.data.turn.audio) {
      var au = new Audio(fileUrl(r.data.turn.audio));
      var p = $('dhPlayer');
      if (p && !previewIsImg) { try { p.pause(); } catch (e) {} }
      try { au.play().catch(function () {}); } catch (e) {}
    }
  }

  async function stopSession() {
    if (!S.session) return;
    await post('/v1/avatar/sessions/' + encodeURIComponent(S.session.id) + '/stop');
    loadSessions();
  }

  /* ---------- 轮询 ---------- */
  function tick() {
    if (document.hidden || !API.live()) return;
    loadConfig();
    loadAvatars(true);
    loadRenders();
    if (S.session && S.session.status === 'running') loadSessions();
  }

  async function boot() {
    if (S.started) return;
    S.started = true;
    await loadConfig();
    await loadAvatars(true);
    await loadRenders();
    await loadSessions();
    showBar(S.avatars.length ? 'ok' : 'warn', S.avatars.length ? '数字人服务已就绪' : '还没有数字人档案', '');
    setInterval(function () { if (!document.hidden && API.live()) tick(); }, 8000);
  }
  function ensureBoot() {
    if (S.started) return;
    if (API.live()) { boot(); return; }
    if (++S.retries > 8) return;
    setTimeout(ensureBoot, 1500);
  }

  /* ---------- 事件 ---------- */
  function bind() {
    if ($('dhNewBtn')) $('dhNewBtn').addEventListener('click', function () {
      var f = $('dhForm');
      if (f) f.style.display = f.style.display === 'none' ? '' : 'none';
    });
    if ($('dhFormOk')) $('dhFormOk').addEventListener('click', createAvatar);
    if ($('dhFormName')) $('dhFormName').addEventListener('keydown', function (e) { if (e.key === 'Enter') createAvatar(); });
    if ($('dhRefresh')) $('dhRefresh').addEventListener('click', function () { loadConfig(); loadAvatars(true); loadRenders(); loadSessions(); });
    if ($('dhIdleBtn')) $('dhIdleBtn').addEventListener('click', buildIdle);
    bindFile('dhPhotoBtn', 'dhPhotoInput', uploadPhotos);
    bindFile('dhVoiceBtn', 'dhVoiceInput', uploadVoice);
    bindTabs();
    if ($('dhGoText')) $('dhGoText').addEventListener('click', function () {
      var t = ($('dhText') && $('dhText').value || '').trim();
      if (!t) { alert('先输入要数字人说的话'); return; }
      submitRender({ avatarId: S.cur && S.cur.id, mode: 'text', text: t, rate: Number(($('dhRate') && $('dhRate').value) || 1) });
    });
    if ($('dhAudioBtn')) $('dhAudioBtn').addEventListener('click', function () { $('dhAudioInput').click(); });
    if ($('dhAudioInput')) $('dhAudioInput').addEventListener('change', function () {
      var f = this.files && this.files[0];
      S.audioFile = f || null;
      if ($('dhAudioMeta')) $('dhAudioMeta').textContent = f ? f.name + '（' + Math.round(f.size / 1024) + 'KB）' : '未选择';
    });
    if ($('dhGoAudio')) $('dhGoAudio').addEventListener('click', function () {
      if (!S.audioFile) { alert('先选择音频文件'); return; }
      var fd = new FormData();
      fd.append('avatarId', S.cur ? S.cur.id : '');
      fd.append('mode', 'audio');
      fd.append('audio', S.audioFile, S.audioFile.name);
      submitRender(fd, true);
    });
    if ($('dhGoMotion')) $('dhGoMotion').addEventListener('click', function () {
      submitRender({
        avatarId: S.cur && S.cur.id, mode: 'motion',
        motion: ($('dhMotion') && $('dhMotion').value) || 'breathe',
        seconds: Number(($('dhSeconds') && $('dhSeconds').value) || 8)
      });
    });
    if ($('dhSessLive')) $('dhSessLive').addEventListener('click', function () { openSession('live'); });
    if ($('dhSessDialog')) $('dhSessDialog').addEventListener('click', function () { openSession('dialog'); });
    if ($('dhSessStop')) $('dhSessStop').addEventListener('click', stopSession);
    if ($('dhSayGo')) $('dhSayGo').addEventListener('click', sendReply);
    if ($('dhSay')) $('dhSay').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendReply(); });
    var p = $('dhPlayer');
    if (p) p.addEventListener('ended', function () {
      if (S.session && S.session.status === 'running' && S.session.mode === 'live' && !previewIsImg) playNext();
    });
  }

  function init() {
    if (!$('dhAvatars')) return;
    bind();
    ensureBoot();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.__dhConsole = { refresh: function () { tick(); }, state: S };
})();
