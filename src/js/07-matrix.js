
/* =========================================================
   AI智能剪辑 · 素材库 / 智能剪辑 / 成片结果 / 发布排期
   独立增强层：接管「批量上传」「一键智能剪辑」，补齐
   素材数据层 → 剪辑引擎 → 成片库 → 发布排期 的完整链路
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- 0. 依赖与工具 ---------------- */
  function ui() { return window.__UI || {}; }
  function fn(o, k) { return o && typeof o[k] === 'function'; }

  function appToast(msg, kind, title, ms) {
    var u = ui();
    if (fn(u, 'toast')) { try { return u.toast(msg, kind || 'info', title, ms); } catch (e) {} }
    mxLog(kind === 'err' ? 'err' : 'info', msg);
  }
  function appModal(cfg) {
    var u = ui();
    if (fn(u, 'openModal')) { try { return u.openModal(cfg); } catch (e) {} }
    return null;
  }
  function appConfirm(cfg) {
    var u = ui();
    if (fn(u, 'confirmDlg')) { try { return u.confirmDlg(cfg); } catch (e) {} }
    if (window.confirm) { if (window.confirm(cfg.msg || cfg.title)) { if (fn(cfg, 'onOk')) cfg.onOk(); } }
    return null;
  }

  function q(s, r) { return (r || document).querySelector(s); }
  function qa(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escA(s) { return esc(s).replace(/`/g, '&#96;'); }
  function uid(p) { return (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function bytes(n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }
  function mmss(sec) {
    sec = Math.round(Number(sec) || 0);
    return ('0' + Math.floor(sec / 60)).slice(-2) + ':' + ('0' + (sec % 60)).slice(-2);
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function getCloud() { try { return (typeof cloud !== 'undefined') ? cloud : null; } catch (e) { return null; } }
  function getState() { try { return (typeof state !== 'undefined') ? state : null; } catch (e) { return null; } }
  function liveCloud() { var s = getState(); return !!getCloud() && !(s && s.demo); }
  function audit(action, target) {
    var r = window.__RT;
    if (r && fn(r.audit, 'audit')) { try { r.audit(action, target); return; } catch (e) {} }
  }
  function obs(level, msg, detail) {
    var r = window.__RT;
    if (r && fn(r.obs, 'obs')) { try { r.obs(level, 'matrix', msg, detail); return; } catch (e) {} }
  }

  /* ---------------- 1. 状态 ---------------- */
  var MX = {
    materials: [],   /* {id,name,kind,url,w,h,dur,uses,size,theme,picked,ts} */
    files: {},       /* id -> File：真实渲染上传用（仅内存，刷新即失效） */
    jobs: [],        /* {id,title,status,progress,note,step,total,mats[]} */
    outputs: [],     /* {id,title,cover,theme,kind,du,ratio,mats,shots,srcName,pushed,ts} */
    schedule: [],    /* [{d,chips:[{pf,t,time}]}] */
    cfg: {
      dedupe: true, voice: true, coverTitle: true, cta: true,
      imgMotion: 'kenburns', transition: 'smart', ratio: '9:16', count: '1'
    },
    /* 7 步工作流的手动调节参数（每步可独立开关） */
    wf: null,
    wfOpen: 'video',
    wfRun: null,          /* 正在执行的步骤 key */
    wfDone: {},           /* 本次已完成的步骤 key */
    logs: [],
    stats: { committed: 0, rounds: 0, pushed: 0, rendered: 0 },
    abilities: null   /* 服务端 /v1/edit/stats.abilities —— 本地配音/字幕的真实可用状态 */
  };

  /* 演示模式开关：仅 URL 显式带 demosim=1 时才允许本地模拟（默认自动剪辑一律走真实渲染通道） */
  var DEMO_SIM = /(?:^|[?&])demosim=1/.test(String(location.search || ''));

  var RATIO_LABEL = { '9:16': '9:16 竖版（抖音/快手/视频号）', '16:9': '16:9 横版（B站/视频号横屏）', '1:1': '1:1 方版（小红书/朋友圈）' };
  var MOTION_LABEL = { kenburns: 'Ken Burns 推拉摇移', zoom: '缓慢放大', pan: '左右平移', none: '静态不动' };
  var TRANS_LABEL = { smart: '智能（按节拍切）', cut: '硬切', fade: '淡入淡出', slide: '滑动转场' };

  var STEPS = [
    { p: 6, t: '解析素材元数据' },
    { p: 16, t: '计算镜头切分点' },
    { p: 28, t: '执行去重（镜像 / 变速 / 抽帧）' },
    { p: 40, t: '生成字幕轨' },
    { p: 52, t: '合成 AI 配音' },
    { p: 64, t: '套用转场与图片运镜' },
    { p: 76, t: '渲染输出成片' },
    { p: 88, t: '生成封面与标题' },
    { p: 100, t: '写入成片库' }
  ];

  var TITLE_POOL = {
    video: ['智能混剪', '口播讲解版', '案例专场', '客户案例合集', '团队实力展示'],
    image: ['图文成片', '案例图集 · 运镜版', '服务图讲解', '投放数据图集']
  };

  /* ---------------- 1.5 七步剪辑工作流（市场通用标准流程） ----------------
     学习对标 → 改写文案 → 声音生成 → 视频生成 → 网感剪辑 → 标题封面 → 一键发布
     每一步都能独立开关 + 调参；参数最终映射为服务端真实渲染参数。 */
  var WF_STEPS = [
    {
      key: 'learn', n: 1, t: '学习对标', d: '拆解对标视频的选题、结构与话术', icon: 'i-radar',
      fields: [
        { k: 'ref', type: 'text', label: '对标视频 / 账号链接', ph: '粘贴抖音、小红书或视频号链接（留空则用行业热门结构）', wide: true },
        { k: 'dim', type: 'chips', label: '拆解维度', opts: ['选题', '开头 3 秒', '内容结构', '话术', '节奏', '结尾引导'], wide: true },
        { k: 'depth', type: 'select', label: '拆解深度', opts: [['quick', '快速 · 1 条'], ['std', '标准 · 3 条'], ['deep', '深度 · 5 条']] }
      ]
    },
    {
      key: 'script', n: 2, t: '改写文案', d: '生成口播文案，可手动改写', icon: 'i-doc',
      fields: [
        { k: 'tone', type: 'select', label: '文案风格', opts: [['pro', '专业讲解'], ['hot', '情绪爆点'], ['story', '故事口吻'], ['dry', '干货直给']] },
        { k: 'len', type: 'select', label: '文案长度', opts: [['s', '短 · 约 60 字'], ['m', '中 · 约 120 字'], ['l', '长 · 约 200 字']] },
        { k: 'text', type: 'textarea', label: '口播文案（可直接改写，会烧录进配音与字幕）', wide: true }
      ]
    },
    {
      key: 'voice', n: 3, t: '声音生成', d: 'AI 配音音色、语速与字幕', icon: 'i-mic',
      fields: [
        { k: 'timbre', type: 'select', label: '音色', opts: [['female', '女声 · 专业'], ['male', '男声 · 沉稳'], ['warm', '女声 · 亲和'], ['power', '男声 · 激情']] },
        { k: 'rate', type: 'range', label: '语速', min: 0.8, max: 1.5, step: 0.1, unit: '×' },
        { k: 'subtitle', type: 'switch', label: '字幕烧录' }
      ]
    },
    {
      key: 'video', n: 4, t: '视频生成', d: '画面比例、镜头时长与运镜', icon: 'i-video',
      fields: [
        { k: 'ratio', type: 'select', label: '画面比例', opts: [['9:16', '9:16 竖版'], ['16:9', '16:9 横版'], ['1:1', '1:1 方版']] },
        { k: 'shot', type: 'range', label: '单镜头时长', min: 1.5, max: 6, step: 0.5, unit: ' 秒' },
        { k: 'motion', type: 'select', label: '图片运镜', opts: [['kenburns', '推拉摇移'], ['zoom', '缓慢放大'], ['pan', '左右平移'], ['none', '静态']] }
      ]
    },
    {
      key: 'edit', n: 5, t: '网感剪辑', d: '转场、去重与整体节奏', icon: 'i-scissors',
      fields: [
        { k: 'trans', type: 'select', label: '转场方式', opts: [['smart', '智能 · 按节拍'], ['fade', '淡入淡出'], ['cut', '硬切'], ['slide', '滑动']] },
        { k: 'rhythm', type: 'select', label: '剪辑节奏', opts: [['fast', '快节奏'], ['std', '标准'], ['slow', '舒缓']] },
        { k: 'dedupe', type: 'switch', label: '智能去重' }
      ]
    },
    {
      key: 'cover', n: 6, t: '标题封面', d: '标题模板、话题标签与封面', icon: 'i-image',
      fields: [
        { k: 'tpl', type: 'select', label: '标题模板', opts: [['case', '案例式'], ['q', '疑问式'], ['num', '数字式'], ['pain', '痛点式']] },
        { k: 'tags', type: 'text', label: '话题标签', ph: '#全行业获客 #AI智能剪辑' },
        { k: 'cta', type: 'switch', label: '结尾引导评论' }
      ]
    },
    {
      key: 'publish', n: 7, t: '一键发布', d: '成片直发账号矩阵或加入排期', icon: 'i-send',
      fields: [
        { k: 'pf', type: 'chips', label: '发布平台', opts: ['抖音', '快手', '小红书', '视频号'], wide: true },
        { k: 'when', type: 'select', label: '发布时机', opts: [['now', '成片即发'], ['t18', '今日 18:00'], ['t09', '明日 09:30'], ['plan', '加入排期不直发']] }
      ]
    }
  ];

  var WF_DEFAULT = {
    learn:   { on: true,  ref: '', dim: ['选题', '开头 3 秒', '内容结构'], depth: 'std' },
    script:  { on: true,  tone: 'pro', len: 'm', text: '' },
    voice:   { on: true,  timbre: 'female', rate: 1.1, subtitle: true },
    video:   { on: true,  ratio: '9:16', shot: 2.5, motion: 'kenburns' },
    edit:    { on: true,  trans: 'smart', rhythm: 'std', dedupe: true },
    cover:   { on: true,  tpl: 'case', tags: '#全行业获客 #AI智能剪辑', cta: true },
    publish: { on: false, pf: ['抖音'], when: 'plan' }
  };

  function wfAll() {
    if (!MX.wf) MX.wf = JSON.parse(JSON.stringify(WF_DEFAULT));
    Object.keys(WF_DEFAULT).forEach(function (k) {
      if (!MX.wf[k]) { MX.wf[k] = JSON.parse(JSON.stringify(WF_DEFAULT[k])); return; }
      Object.keys(WF_DEFAULT[k]).forEach(function (f) {
        if (MX.wf[k][f] === undefined) MX.wf[k][f] = JSON.parse(JSON.stringify(WF_DEFAULT[k][f]));
      });
    });
    return MX.wf;
  }
  function wfStep(key) { return WF_STEPS.filter(function (s) { return s.key === key; })[0] || null; }
  function wfFieldDef(step, k) { return step.fields.filter(function (f) { return f.k === k; })[0] || {}; }
  function wfReset() { MX.wf = JSON.parse(JSON.stringify(WF_DEFAULT)); }

  /* ---------------- 2. 种子数据 ---------------- */
  function seedAll() {
    if (MX.materials.length) return;
    MX.materials = [
      { id: 'm-seed1', name: '抖音代运营 · 案例拆解', kind: 'video', w: 1920, h: 1080, dur: 18, uses: 24, size: 18600000, theme: 1, ts: Date.now() },
      { id: 'm-seed2', name: '千川起量 · 后台实拍', kind: 'video', w: 1920, h: 1080, dur: 26, uses: 18, size: 24100000, theme: 2, ts: Date.now() },
      { id: 'm-seed3', name: '本地生活团购 · 门店探店', kind: 'video', w: 1080, h: 1920, dur: 32, uses: 31, size: 32800000, theme: 3, ts: Date.now() },
      { id: 'm-seed4', name: '团队办公 · 投放复盘', kind: 'video', w: 1080, h: 1920, dur: 15, uses: 12, size: 14500000, theme: 4, ts: Date.now() }
    ];
    MX.jobs = [
      { id: 'j-seed1', title: '千川起量 · 口播讲解版 10 条', status: 'done', progress: 100, total: 10, note: '已完成 · 已进入发布排期（今日 18:00 / 20:30）', step: '已写入成片库', seeded: true },
      { id: 'j-seed2', title: '团队实力展示 · 20 条', status: 'queued', progress: 0, total: 20, note: '等待 GPU 资源 · 队列第 1 位', seeded: true }
    ];
    var D = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    var raw = [
      [['douyin', '抖', '09:30'], ['xhs', '红', '20:00']],
      [['kuaishou', '快', '12:00'], ['sph', '视', '19:00']],
      [['douyin', '抖', '09:30'], ['douyin', '抖', '18:30'], ['xhs', '红', '20:00']],
      [['xhs', '红', '21:00'], ['kuaishou', '快', '12:00']],
      [['douyin', '抖', '10:00'], ['sph', '视', '20:00'], ['xhs', '红', '20:00'], ['douyin', '抖', '21:30']],
      [['douyin', '抖', '11:00'], ['xhs', '红', '20:30']],
      [['douyin', '抖', '已发'], ['kuaishou', '快', '18:00'], ['xhs', '红', '20:30'], ['sph', '视', '20:30']]
    ];
    MX.schedule = D.map(function (d, i) {
      return { d: d, chips: raw[i].map(function (c) { return { pf: c[0], t: c[1], time: c[2] }; }) };
    });
  }
  function todayIdx() { return (new Date().getDay() + 6) % 7; }

  /* ---------------- 3. 运行日志 ---------------- */
  function mxLog(kind, msg) {
    var t = new Date();
    var ts = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2);
    MX.logs.push({ k: kind || 'plain', ts: ts, m: String(msg) });
    if (MX.logs.length > 200) MX.logs.shift();
    paintLog();
    var line = q('#mxLogLast');
    if (line) line.textContent = ts + '  ' + msg;
  }
  function paintLog() {
    var box = q('#mxLog');
    if (!box) return;
    var rows = MX.logs.slice(-60);
    box.innerHTML = rows.length
      ? rows.map(function (l) { return '<div><i>' + l.ts + '</i><span class="' + l.k + '">' + esc(l.m) + '</span></div>'; }).join('')
      : '<div><span class="plain">暂无日志。上传素材或执行智能剪辑后，这里会实时记录每一步。</span></div>';
    var st = q('#mxLogStat'); if (st) st.textContent = MX.logs.length + ' 条';
    box.scrollTop = box.scrollHeight;
  }

  /* ---------------- 3.5 七步工作流渲染与交互（左步骤 / 中配置 / 右预览） ---------------- */
  var WF_RATIO_DIM = { '9:16': [140, 249], '16:9': [246, 138], '1:1': [196, 196] };
  var WF_WHEN_TXT = { now: '成片即发', t18: '今日 18:00', t09: '明日 09:30', plan: '加入排期' };

  function wfOptLabel(stepKey, fk, v) {
    var s = wfStep(stepKey);
    if (!s) return v;
    var f = wfFieldDef(s, fk);
    if (!f || !f.opts) return v;
    for (var i = 0; i < f.opts.length; i++) {
      if (String(f.opts[i][0]) === String(v)) return f.opts[i][1];
    }
    return v;
  }

  /* 步骤左侧导航的第二行：把该步当前配置压成一句话 */
  function wfSummary(key, st) {
    if (key === 'learn') return st.ref ? '已填对标链接' : ((st.dim && st.dim.length) ? st.dim.length + ' 个拆解维度' : '未设拆解维度');
    if (key === 'script') return wfOptLabel('script', 'len', st.len) + (st.text ? ' · 已手写' : '');
    if (key === 'voice') return wfOptLabel('voice', 'timbre', st.timbre) + ' · ' + st.rate + '×' + (st.subtitle ? ' · 字幕' : '');
    if (key === 'video') return st.ratio + ' · ' + st.shot + ' 秒/镜';
    if (key === 'edit') return wfOptLabel('edit', 'rhythm', st.rhythm) + (st.dedupe ? ' · 去重' : '');
    if (key === 'cover') return wfOptLabel('cover', 'tpl', st.tpl) + '标题';
    if (key === 'publish') return (st.pf && st.pf.length ? st.pf.join(' / ') : '未选平台') + ' · ' + wfOptLabel('publish', 'when', st.when);
    return '已启用';
  }

  function paintWfRail() {
    var W = wfAll();
    var onN = WF_STEPS.filter(function (s) { return W[s.key].on; }).length;
    var flow = q('#mxFlow');
    if (!flow) return;
    flow.innerHTML =
      '<div class="wf-rail-head"><span>剪辑流程</span><em>' + onN + '/7 启用</em></div>' +
      WF_STEPS.map(function (s) {
        var st = W[s.key] || {};
        var cls = 'wf-node ' + (st.on ? 'on' : 'off') +
          (MX.wfOpen === s.key ? ' cur' : '') +
          (MX.wfRun === s.key ? ' run' : '') +
          (MX.wfDone[s.key] ? ' done' : '');
        var sub = MX.wfDone[s.key] ? '已完成' : (MX.wfRun === s.key ? '执行中…' : (st.on ? wfSummary(s.key, st) : '已跳过'));
        return '<div class="' + cls + '" data-wf="' + s.key + '" role="button" tabindex="0" title="' + escA(s.d) + '">' +
          '<span class="n"><svg class="icon"><use href="#' + s.icon + '"/></svg></span>' +
          '<span class="tx"><b>0' + s.n + ' ' + s.t + '</b><em>' + esc(sub) + '</em></span>' +
          '<span class="st"></span>' +
          '</div>';
      }).join('') +
      '<div class="wf-rail-foot">点步骤切换 · 中间调参 · 底部「上一步 / 下一步」逐步检查</div>';
  }

  function renderWorkflow() {
    var W = wfAll();
    var onN = WF_STEPS.filter(function (s) { return W[s.key].on; }).length;
    paintWfRail();
    paintWfPanel();
    paintWfNote();
    paintWfPreview();
    paintWfSum();

    var chan = q('#mxFlowChan');
    if (chan) {
      var up = renderUp();
      chan.className = 'mx-chip' + (up ? ' on' : '');
      chan.innerHTML = '渲染通道 <b>' + (up ? '真实渲染' : '未接入') + '</b>';
    }

    /* 底部进度条与上/下一步可用性 */
    var dn = WF_STEPS.filter(function (s) { return W[s.key].on && MX.wfDone[s.key]; }).length;
    var prog = q('#wfProg');
    if (prog) prog.style.width = Math.round(dn / Math.max(1, onN) * 100) + '%';
    var idx = WF_STEPS.map(function (s) { return s.key; }).indexOf(MX.wfOpen);
    var pb = q('#wfPrevBtn'), nb = q('#wfNextBtn');
    if (pb) pb.disabled = idx <= 0;
    if (nb) nb.disabled = idx >= WF_STEPS.length - 1;
    var rl = q('#wfRunLabel');
    if (rl) rl.textContent = W.publish.on ? '按当前配置生成并发布' : '按当前配置开始';
  }

  function paintWfPanel() {
    var box = q('#mxFlowPanel');
    if (!box) return;
    var W = wfAll();
    var s = wfStep(MX.wfOpen) || WF_STEPS[0];
    var st = W[s.key] || {};
    box.innerHTML =
      '<div class="ph">' +
        '<span class="ic"><svg class="icon"><use href="#' + s.icon + '"/></svg></span>' +
        '<div class="pt"><b>0' + s.n + ' · ' + s.t + '</b><p>' + s.d + '</p></div>' +
        '<div class="right">' +
          '<span class="tag' + (st.on ? ' green' : '') + '">' + (st.on ? '已启用' : '已跳过') + '</span>' +
          '<button class="btn sm ghost" data-wfskip="' + s.key + '" type="button">' + (st.on ? '跳过此步' : '启用此步') + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="wf-block">' +
        '<div class="wf-block-h"><b>' + s.t + '参数</b><span>' +
          (st.on ? '调整后立即生效，并同步到本次渲染' : '该步骤已跳过，开启后参数才生效') +
        '</span></div>' +
        '<div class="wf-fields">' + s.fields.map(function (f) { return wfField(s, st, f); }).join('') + '</div>' +
      '</div>';
    bindWfPanel();
  }

  function wfField(s, st, f) {
    var v = st[f.k];
    var body = '';
    if (f.type === 'select') {
      body = '<select data-wff="' + f.k + '">' + f.opts.map(function (o) {
        return '<option value="' + escA(o[0]) + '"' + (String(v) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select>';
    } else if (f.type === 'text') {
      body = '<input type="text" data-wff="' + f.k + '" value="' + escA(v == null ? '' : v) + '" placeholder="' + escA(f.ph || '') + '">';
    } else if (f.type === 'textarea') {
      body = '<textarea data-wff="' + f.k + '" placeholder="留空则按素材与文案风格自动生成">' + esc(v == null ? '' : v) + '</textarea>';
    } else if (f.type === 'range') {
      body = '<div class="rg"><input type="range" data-wff="' + f.k + '" min="' + f.min + '" max="' + f.max +
        '" step="' + f.step + '" value="' + v + '"><b data-wfr="' + f.k + '">' + v + (f.unit || '') + '</b></div>';
    } else if (f.type === 'chips') {
      body = '<div class="wf-chips">' + f.opts.map(function (o) {
        var on = Array.isArray(v) && v.indexOf(o) > -1;
        return '<button type="button" class="' + (on ? 'on' : '') + '" data-wfc="' + f.k + '" data-wfv="' + escA(o) + '">' + esc(o) + '</button>';
      }).join('') + '</div>';
    } else if (f.type === 'switch') {
      body = '<span class="sw2' + (v ? ' on' : '') + '" data-wfs="' + f.k + '" role="button" tabindex="0"><i></i>' +
        (v ? '已开启' : '已关闭') + '</span>';
    }
    return '<div class="wf-f' + (f.wide ? ' wide' : '') + '"><label>' + esc(f.label) + '</label>' + body + '</div>';
  }

  function bindWfPanel() {
    var box = q('#mxFlowPanel');
    if (!box) return;
    var s = wfStep(MX.wfOpen) || WF_STEPS[0];
    var st = wfAll()[s.key] || {};

    qa('[data-wff]', box).forEach(function (el) {
      var k = el.getAttribute('data-wff');
      var def = wfFieldDef(s, k);
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () {
        var val = el.value;
        if (el.type === 'range') {
          val = Number(val);
          var b = q('[data-wfr="' + k + '"]', box);
          if (b) b.textContent = val + (def.unit || '');
        }
        st[k] = val;
        if (el.tagName === 'SELECT') {
          mxLog('info', '工作流 · ' + s.t + '：' + (def.label || k) + ' → ' + el.options[el.selectedIndex].text);
          audit('剪辑工作流调参', s.t + ' · ' + (def.label || k) + ' → ' + el.options[el.selectedIndex].text);
        }
        syncCfgFromWf();
        paintWfRail();
        paintWfNote();
        paintWfSum();
        if (k === 'ratio') paintWfPreview();
        saveCfg();
      });
    });
    qa('[data-wfc]', box).forEach(function (el) {
      el.addEventListener('click', function () {
        var k = el.getAttribute('data-wfc'), v = el.getAttribute('data-wfv');
        if (!Array.isArray(st[k])) st[k] = [];
        var i = st[k].indexOf(v);
        if (i > -1) st[k].splice(i, 1); else st[k].push(v);
        syncCfgFromWf(); paintWfPanel(); paintWfRail(); paintWfNote(); paintWfSum(); saveCfg();
      });
    });
    qa('[data-wfs]', box).forEach(function (el) {
      el.addEventListener('click', function () {
        var k = el.getAttribute('data-wfs');
        st[k] = !st[k];
        mxLog('info', '工作流 · ' + s.t + '：' + (wfFieldDef(s, k).label || k) + ' → ' + (st[k] ? '开启' : '关闭'));
        syncCfgFromWf(); paintWfPanel(); paintWfRail(); paintWfNote(); paintWfSum(); saveCfg();
      });
    });

    /* 跳过 / 启用当前步骤 */
    var sk = q('[data-wfskip]', box);
    if (sk) sk.addEventListener('click', function () {
      var k = sk.getAttribute('data-wfskip');
      if (k === 'video') { appToast('「视频生成」是成片必经步骤，不能跳过', 'warn', '该步骤必选'); return; }
      var W = wfAll();
      W[k].on = !W[k].on;
      var ss = wfStep(k);
      mxLog('info', '工作流 · ' + (ss ? ss.t : k) + ' → ' + (W[k].on ? '启用' : '跳过'));
      audit('剪辑工作流步骤开关', (ss ? ss.t : k) + (W[k].on ? ' 启用' : ' 跳过'));
      syncCfgFromWf(); renderWorkflow(); saveCfg();
    });
  }

  /* 把工作流参数同步回 MX.cfg，保证渲染 / 统计等既有逻辑口径一致 */
  function syncCfgFromWf() {
    var W = wfAll();
    MX.cfg.ratio = W.video.ratio;
    MX.cfg.imgMotion = W.video.motion;
    MX.cfg.transition = W.edit.trans;
    MX.cfg.dedupe = !!(W.edit.on && W.edit.dedupe);
    MX.cfg.voice = !!W.voice.on;
    MX.cfg.coverTitle = !!W.cover.on;
    MX.cfg.cta = !!(W.cover.on && W.cover.cta);
    MX.cfg.count = '1';
  }

  /* 右列预览：优先显示最近一条真实成片，否则显示即将参与剪辑的首条素材 */
  function paintWfPreview() {
    var frame = q('#wfPrevFrame');
    if (!frame) return;
    var W = wfAll();
    var r = W.video.ratio || '9:16';
    var dim = WF_RATIO_DIM[r] || WF_RATIO_DIM['9:16'];
    frame.style.width = dim[0] + 'px';
    frame.style.height = dim[1] + 'px';
    var chip = q('#wfPrevRatio');
    if (chip) chip.textContent = r;

    var pool = pickPool();
    var o = MX.outputs.length ? MX.outputs[0] : null;
    var meta = q('#wfPrevMeta');
    var titleEl = q('#wfPrevTitle');

    if (o && o.rendered && (o.coverUrl || o.cover)) {
      var src = o.coverUrl || o.cover;
      var isVid = /\.mp4(\?|$)/i.test(src) || (!o.coverUrl && o.kind === 'video');
      if (titleEl) titleEl.textContent = '成片预览';
      frame.innerHTML =
        (isVid ? '<video src="' + escA(src) + '" muted playsinline preload="metadata"></video>'
               : '<img src="' + escA(src) + '" alt="">') +
        '<span class="pf-tag">最近成片</span>' +
        '<span class="pf-dur">' + mmss(o.du || 0) + '</span>' +
        '<span class="pf-play"><span><svg class="icon"><use href="#i-play"/></svg></span></span>';
      if (meta) meta.innerHTML = '<b>' + esc(o.title || '成片') + '</b>' +
        esc((o.width || '') + '×' + (o.height || '') + ' · ' + (o.shots || 0) + ' 段镜头 · ' + (o.ratio || r));
      return;
    }

    if (pool.length) {
      var m = pool[0];
      if (titleEl) titleEl.textContent = '素材预览';
      frame.innerHTML = matCover(m) +
        '<span class="pf-tag">' + (m.kind === 'image' ? '图片' : '视频') + '</span>' +
        '<span class="pf-dur">' + (m.kind === 'video' ? mmss(m.dur) : '静帧') + '</span>' +
        '<span class="pf-play"><span><svg class="icon"><use href="#i-play"/></svg></span></span>';
      if (meta) meta.innerHTML = '<b>' + esc(m.name) + '</b>' +
        esc('参与剪辑 ' + pool.length + ' 条 · 输出 1 条 · ' + (m.kind === 'video' ? '视频混剪' : '图片运镜'));
      return;
    }

    if (titleEl) titleEl.textContent = '成片预览';
    frame.innerHTML = '<div class="wf-prev-empty">' +
      '<svg class="icon"><use href="#i-video"/></svg>' +
      '<b>还没有可预览的成片</b>' +
      '<span>先在素材池上传素材，<br>再点「一键跑完 7 步」生成</span>' +
      '</div>';
    if (meta) meta.innerHTML = '<b>等待素材</b>素材池为空，无法生成成片';
  }

  /* 右列底部：本次渲染参数摘要（把散落在 7 步里的选择汇总成一眼可读的清单） */
  function paintWfSum() {
    var box = q('#wfSum');
    if (!box) return;
    var W = wfAll();
    var rows = [
      ['画布', (RATIO_LABEL[W.video.ratio] || W.video.ratio) + ' · ' + W.video.shot + ' 秒/镜 · ' + wfOptLabel('video', 'motion', W.video.motion)],
      ['剪辑', wfOptLabel('edit', 'trans', W.edit.trans) + ' · ' + wfOptLabel('edit', 'rhythm', W.edit.rhythm) + (W.edit.dedupe ? ' · 去重' : '')],
      ['文案', W.script.on ? (wfOptLabel('script', 'tone', W.script.tone) + ' · ' + wfOptLabel('script', 'len', W.script.len)) : '不生成'],
      ['配音', W.voice.on ? (wfOptLabel('voice', 'timbre', W.voice.timbre) + ' · ' + W.voice.rate + '×' + (W.voice.subtitle ? ' · 字幕' : '')) : '不使用'],
      ['标题', W.cover.on ? (wfOptLabel('cover', 'tpl', W.cover.tpl) + (W.cover.cta ? ' · 带引导' : '')) : '不使用'],
      ['发布', W.publish.on ? ((W.publish.pf.join(' / ') || '未选平台') + ' · ' + (WF_WHEN_TXT[W.publish.when] || '')) : '不自动发布']
    ];
    box.innerHTML = '<h5>本次渲染参数</h5>' + rows.map(function (r) {
      return '<div class="r"><span>' + r[0] + '</span><b title="' + escA(r[1]) + '">' + esc(r[1]) + '</b></div>';
    }).join('');
  }

  function paintWfNote() {
    var n = q('#mxFlowNote');
    if (!n) return;
    var W = wfAll();
    var pool = pickPool();
    var onN = WF_STEPS.filter(function (s) { return W[s.key].on; }).length;
    var vs = voiceState();
    var vt = !W.voice.on ? '无配音'
      : (!renderUp() ? '配音需真实渲染'
        : (!vs.known ? '配音检测中…'
          : (vs.ok ? '配音 + 字幕（' + vs.label + ' · ' + W.voice.rate + '×）' : '配音未接入 · 输出无配音成片')));
    var pub = !W.publish.on ? '不自动发布'
      : ((W.publish.pf.join(' / ') || '未选平台') + ' · ' + (WF_WHEN_TXT[W.publish.when] || W.publish.when));
    n.innerHTML =
      '本次产出 <b>1 条</b> · 启用 <b>' + onN + '/7</b> 步 · 素材 <b>' + pool.length + '</b> 条 · ' +
      '<b>' + esc(RATIO_LABEL[W.video.ratio] || W.video.ratio) + '</b> · 镜头 <b>' + W.video.shot + ' 秒/个</b> · ' +
      esc(vt) + ' · 发布 <b>' + esc(pub) + '</b>';
  }

  /* 逐步推进：前 3 步本地即时完成，第 4 步提交真实渲染，收尾步骤由完成时统一标记 */
  function runWfSteps(job, onVideoStep) {
    var W = wfAll();
    MX.wfDone = {};
    var seq = WF_STEPS.filter(function (s) { return W[s.key].on && s.key !== 'video' && s.key !== 'publish'; })
      .map(function (s) { return s.key; });
    var i = 0;
    (function next() {
      if (i >= seq.length) {
        MX.wfRun = 'video';
        renderWorkflow();
        job.step = '视频生成';
        onVideoStep();
        return;
      }
      var s = wfStep(seq[i]);
      MX.wfRun = seq[i];
      renderWorkflow();
      job.stage = '步骤 ' + s.n + '/7 · ' + s.t;
      job.step = s.t;
      renderQueue();
      mxLog('plain', '[' + job.title + '] 步骤 ' + s.n + '/7 · ' + s.t +
        (seq[i] === 'learn' && W.learn.ref ? '（对标：' + W.learn.ref + '）' : ''));
      i++;
      setTimeout(function () { MX.wfDone[seq[i - 1]] = 1; next(); }, 340);
    })();
  }

  function wfFinish(job) {
    var W = wfAll();
    ['video', 'edit', 'cover'].forEach(function (k) { if (W[k].on) MX.wfDone[k] = 1; });
    MX.wfRun = null;
    renderWorkflow();
    if (!W.publish.on) return;
    var mine = MX.outputs.filter(function (o) { return o.jobId === job.id; });
    if (!mine.length) return;
    if (W.publish.when === 'plan') {
      mxLog('info', '发布步骤：已按设置加入排期（' + (W.publish.pf.join('/') || '未选平台') + '）');
      return;
    }
    mxLog('info', '发布步骤：平台 ' + (W.publish.pf.join('/') || '未选') + ' · ' +
      ({ now: '成片即发', t18: '今日 18:00', t09: '明日 09:30' }[W.publish.when] || '按排期') +
      ' · 排期通道按账号矩阵实际绑定写入，可在「批量发布」调整平台与时段');
    mine.forEach(function (o) { pushOutput(o); });
    MX.wfDone.publish = 1;
    renderWorkflow();
  }

  /* ---------------- 4. 素材库 ---------------- */
  function themeCls(n) { return n === 2 ? ' v2' : (n === 3 ? ' v3' : (n === 4 ? ' v4' : '')); }
  function outThemeCls(n) { return n === 2 ? ' c2' : (n === 3 ? ' c3' : (n === 4 ? ' c4' : '')); }

  function matCover(m, big) {
    if (m.url && m.kind === 'image') return '<img src="' + escA(m.url) + '" alt="">';
    if (m.url && m.kind === 'video') return '<video src="' + escA(m.url) + '" muted playsinline preload="metadata"></video>';
    return '<svg class="icon"><use href="#i-' + (m.kind === 'image' ? 'image' : 'video') + '"/></svg>';
  }

  /* 素材池头部只保留「已选」一处计数，其余操作按钮为静态节点 */
  function renderTools() {
    var chip = q('#mxPickChip');
    if (!chip) return;
    var n = MX.materials.length;
    var picked = MX.materials.filter(function (m) { return m.picked; }).length;
    chip.className = 'mx-chip' + (picked ? ' on' : '');
    chip.textContent = picked ? '已选 ' + picked + ' / ' + n : '已选 0 / ' + n;
  }

  function renderMaterials() {
    var g = q('#matGrid');
    if (!g) return;
    if (!MX.materials.length) {
      g.classList.add('mx-empty');
      g.innerHTML = '<div class="mx-empty">' +
        '<svg class="icon"><use href="#i-image"/></svg>' +
        '<b>素材池还是空的</b>' +
        '<p>先上传图片或视频，再点「一键跑完 7 步」生成成片。</p>' +
        '<button class="btn primary" data-use="mx" data-mx="upload" type="button">上传素材</button>' +
        '</div>';
    } else {
      g.classList.remove('mx-empty');
      g.innerHTML = MX.materials.map(function (m) {
        var meta = m.kind === 'image'
          ? '图片 · ' + m.w + '×' + m.h + ' · 已用 ' + (m.uses || 0) + ' 次'
          : m.w + '×' + m.h + ' · 已用 ' + (m.uses || 0) + ' 次';
        return '<div class="material' + (m.picked ? ' picked' : '') + '" data-mid="' + escA(m.id) + '">' +
          '<div class="mat-thumb' + themeCls(m.theme) + '">' + matCover(m) +
          '<span class="dur">' + (m.kind === 'video' ? mmss(m.dur) : '图片') + '</span>' +
          '<span class="mat-kind">' + (m.kind === 'image' ? 'IMG' : 'VID') + '</span>' +
          '<span class="pick" title="勾选参与剪辑"></span>' +
          '<button class="mat-del" type="button" data-use="mx" data-del="' + escA(m.id) + '" title="删除素材">&#215;</button>' +
          '</div>' +
          '<div class="mat-info"><b>' + esc(m.name) + '</b><span>' + esc(meta) + '</span></div>' +
          '</div>';
      }).join('') +
        '<button class="wf-add" data-use="mx" data-mx="upload" type="button">' +
        '<svg class="icon"><use href="#i-plus"/></svg>添加素材</button>';
    }
    var hint = q('#matHint');
    if (hint) {
      var imgs = MX.materials.filter(function (m) { return m.kind === 'image'; }).length;
      hint.textContent = '共 ' + MX.materials.length + ' 条';
      hint.title = '图片 ' + imgs + ' / 视频 ' + (MX.materials.length - imgs) + ' · 点缩略图勾选参与剪辑';
    }
    renderTools();
    paintWfPreview();
  }

  function togglePick(id) {
    var m = MX.materials.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    m.picked = !m.picked;
    renderMaterials();
  }
  function delMaterial(id) {
    var m = MX.materials.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    appConfirm({
      title: '删除素材', html: '确认从素材池移除「<b>' + esc(m.name) + '</b>」？<br>已生成的成片不受影响。',
      okText: '删除', onOk: function () {
        MX.materials = MX.materials.filter(function (x) { return x.id !== id; });
        renderMaterials();
        mxLog('warn', '已移除素材「' + m.name + '」');
        appToast('素材已移除', 'warn', '已删除');
      }
    });
  }

  /* ---------------- 5. 上传 ---------------- */
  function mxUpload() {
    var staged = [];
    var rec = appModal({
      title: '批量上传素材', sub: '图片 jpg/png/webp · 视频 mp4/mov · 单个不超过 500MB',
      icon: 'i-image', okText: '确认入库', wide: true,
      body:
        '<div class="mx-drop" id="mxDrop">' +
          '<svg class="icon"><use href="#i-image"/></svg>' +
          '<b>点击选择文件，或拖拽到此处</b>' +
          '<p>图片建议 ≥ 800px，会按运镜合成为竖版视频；视频建议 9:16 竖版 1080×1920，会自动切片去重</p>' +
        '</div>' +
        '<input type="file" id="mxInput" multiple accept="video/*,image/*" style="display:none">' +
        '<div id="mxList" style="margin-top:12px"></div>' +
        '<div class="mx-sum" id="mxSum" style="display:none"></div>' +
        '<div style="margin-top:12px;text-align:center">' +
          '<button class="btn sm ghost" id="mxDemo" type="button">没有素材？用 4 个示例素材演示</button>' +
        '</div>' +
        '<div class="mx-alert blue" id="mxChan"></div>',
      onOk: function () {
        var ok = staged.filter(function (x) { return x.status === 'ready' || x.status === 'done'; });
        if (!ok.length) { appToast('请先选择可用的素材文件', 'warn', '没有可入库的素材', 2600); return true; }
        rec && rec.close();
        commitMaterials(ok);
        return true;
      }
    });
    if (!rec) return;

    var mask = rec.mask;
    var chan = q('#mxChan', mask);
    if (chan) {
      var ch1 = liveCloud()
        ? '当前存储通道：<b>云端</b>（已登录）。入库记录会写入你的账号数据，受行级安全保护。'
        : '当前存储通道：<b>本地暂存</b>（演示 / 未部署状态）。素材只在本页会话内可见，刷新后需重新上传；部署并接入存储服务后可切换为云端持久化。';
      var ch2 = renderUp()
        ? '渲染通道：<b>真实渲染</b>（已接入服务端）。点「一键跑完 7 步」会上传素材到服务端用 FFmpeg 合成可播放成片。'
        : '渲染通道：<b>未接入</b>。自动剪辑必须走服务端 FFmpeg 真实渲染；页面已自动探测（同源 + 本机 8787），探通即自动接入，也可在系统设置手动填写。';
      chan.innerHTML = ch1 + '<br>' + ch2;
    }

    function paintStaged() {
      var list = q('#mxList', mask);
      if (!list) return;
      list.innerHTML = staged.map(function (it, i) {
        var st = { wait: ['校验中', 'wait'], ready: ['待入库', 'wait'], done: ['已入库', 'ok'], err: ['失败：' + (it.err || ''), 'err'], up: ['上传中 ' + it.progress + '%', 'warn'] }[it.status] || ['', 'wait'];
        var thumb = it.url && it.kind === 'image'
          ? '<img src="' + escA(it.url) + '" alt="">'
          : '<svg class="icon"><use href="#i-' + (it.kind === 'image' ? 'image' : 'video') + '"/></svg>';
        var dim = it.w && it.h ? it.w + '×' + it.h : '解析中';
        var dur = it.kind === 'video' && it.dur ? ' · ' + mmss(it.dur) : '';
        return '<div class="mx-up-item">' +
          '<div class="mx-up-thumb">' + thumb + '</div>' +
          '<div class="mx-up-main">' +
            '<div class="mx-up-name">' + esc(it.name) + '</div>' +
            '<div class="mx-up-meta">' + bytes(it.size) + ' · ' + (it.kind === 'image' ? '图片' : '视频') + ' · ' + dim + dur + '</div>' +
            (it.status === 'up' ? '<div class="mx-up-bar"><i style="width:' + it.progress + '%"></i></div>' : '') +
          '</div>' +
          '<span class="mx-up-st ' + st[1] + '">' + esc(st[0]) + '</span>' +
          '<button class="mx-up-x" type="button" data-use="mx" data-i="' + i + '" title="移除">&#215;</button>' +
          '</div>';
      }).join('');

      var ready = staged.filter(function (x) { return x.status === 'ready' || x.status === 'done'; });
      var imgN = ready.filter(function (x) { return x.kind === 'image'; }).length;
      var vidN = ready.length - imgN;
      var total = ready.reduce(function (a, b) { return a + (Number(b.size) || 0); }, 0);
      var est = clamp(Math.round(ready.length * 2.5), ready.length ? 3 : 0, 30);
      var sum = q('#mxSum', mask);
      if (sum) {
        sum.style.display = ready.length ? 'flex' : 'none';
        sum.innerHTML = '可入库 <b>' + ready.length + '</b> 个（图片 ' + imgN + ' · 视频 ' + vidN + '） · 合计 <b>' + bytes(total) + '</b>' +
          ' · 预计可生成 <b>' + est + '</b> 条成片' +
          (staged.length - ready.length ? ' · <span style="color:var(--amber)">' + (staged.length - ready.length) + ' 个不可用</span>' : '');
      }
    }

    function probe(it) {
      if (!it.url) { it.status = 'ready'; it.w = it.w || 1080; it.h = it.h || 1920; paintStaged(); return; }
      if (it.kind === 'image') {
        var im = new Image();
        im.onload = function () { it.w = im.naturalWidth; it.h = im.naturalHeight; it.status = 'ready'; paintStaged(); };
        im.onerror = function () { it.status = 'err'; it.err = '图片解码失败'; paintStaged(); };
        im.src = it.url;
      } else {
        var v = document.createElement('video');
        v.preload = 'metadata'; v.muted = true;
        v.onloadedmetadata = function () { it.w = v.videoWidth; it.h = v.videoHeight; it.dur = v.duration || 0; it.status = 'ready'; paintStaged(); };
        v.onerror = function () { it.status = 'err'; it.err = '视频无法解析'; paintStaged(); };
        v.src = it.url;
      }
    }

    function stage(list) {
      Array.prototype.slice.call(list || []).forEach(function (f) {
        var kind = /^image\//.test(f.type) ? 'image' : (/^video\//.test(f.type) ? 'video' : '');
        if (!kind) kind = /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name) ? 'image' : (/\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(f.name) ? 'video' : '');
        var it = { name: f.name, size: f.size, kind: kind || 'video', status: 'wait', progress: 0, url: '', file: f };
        if (!kind) { it.status = 'err'; it.err = '不支持的格式'; staged.push(it); return; }
        if (f.size > 500 * 1048576) { it.status = 'err'; it.err = '超过 500MB'; staged.push(it); return; }
        try { it.url = URL.createObjectURL(f); } catch (e) {}
        staged.push(it);
        probe(it);
      });
      paintStaged();
      mxLog('info', '已选择 ' + staged.length + ' 个文件，正在校验格式与尺寸');
    }

    var drop = q('#mxDrop', mask), inp = q('#mxInput', mask), demo = q('#mxDemo', mask);
    if (drop && inp) {
      drop.addEventListener('click', function () { inp.click(); });
      drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.style.borderColor = 'var(--primary)'; drop.style.background = 'var(--primary-soft)'; });
      drop.addEventListener('dragleave', function () { drop.style.borderColor = ''; drop.style.background = ''; });
      drop.addEventListener('drop', function (e) {
        e.preventDefault(); drop.style.borderColor = ''; drop.style.background = '';
        stage(e.dataTransfer && e.dataTransfer.files);
      });
    }
    if (inp) inp.addEventListener('change', function () { stage(inp.files); });
    if (demo) demo.addEventListener('click', function () {
      staged = staged.concat([
        { name: '抖音代运营 · 案例拆解.mp4', size: 18600000, kind: 'video', status: 'ready', progress: 0, url: '', w: 1920, h: 1080, dur: 18 },
        { name: '千川起量 · 后台实拍.mp4', size: 24100000, kind: 'video', status: 'ready', progress: 0, url: '', w: 1920, h: 1080, dur: 26 },
        { name: '团购门店探店 · 01.jpg', size: 3600000, kind: 'image', status: 'ready', progress: 0, url: '', w: 1080, h: 1440, dur: 0 },
        { name: '投放数据图 · 02.png', size: 2900000, kind: 'image', status: 'ready', progress: 0, url: '', w: 1200, h: 1600, dur: 0 }
      ]);
      paintStaged();
    });
    mask.addEventListener('click', function (e) {
      var x = e.target.closest('.mx-up-x');
      if (!x) return;
      var i = Number(x.dataset.i);
      if (staged[i] && staged[i].url) { try { URL.revokeObjectURL(staged[i].url); } catch (er) {} }
      staged.splice(i, 1);
      paintStaged();
    });
  }

  function commitMaterials(items) {
    var added = 0;
    items.forEach(function (it) {
      var id = uid('m');
      /* 保留原始 File：接入渲染服务时用它上传，实现真实剪辑 */
      if (it.file) { try { MX.files[id] = it.file; } catch (e) {} }
      MX.materials.unshift({
        id: id, name: String(it.name || '未命名素材').replace(/\.[a-z0-9]+$/i, ''), rawName: it.name || '',
        kind: it.kind, url: it.url || '', w: it.w || 1080, h: it.h || 1920, dur: it.dur || 0,
        uses: 0, size: it.size || 0, theme: (MX.materials.length % 4) + 1, picked: true, ts: Date.now(), fresh: true,
        hasFile: !!it.file
      });
      added++;
    });
    MX.stats.committed += added;
    renderMaterials();
    saveMaterials();
    mxLog('ok', '素材入库完成：新增 ' + added + ' 条，素材池共 ' + MX.materials.length + ' 条（已自动勾选，可直接剪辑）');
    obs('info', '素材入库', { added: added, total: MX.materials.length });
    audit('素材入库', added + ' 条');
    appToast('已入库 ' + added + ' 条素材，已自动勾选，可直接点「一键跑完 7 步」', 'ok', '入库完成', 3200);
    var g = q('#matGrid');
    if (g) qa('.material.mat-new', g).forEach(function (x) { x.classList.remove('mat-new'); });
  }

  /* ---------------- 6. 剪辑引擎 ---------------- */
  function pickPool() {
    var on = MX.materials.filter(function (m) { return m.picked; });
    return on.length ? on : MX.materials.slice();
  }
  /* 单次剪辑固定产出 1 条成片：按用户工作流设定，不再批量灌水 */
  function estimateCount(pool) { return 1; }
  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h;
  }
  /* 确定性命名：同素材 + 同规则产出同名。
     标题会烧进成片画面，因此必须参与服务端幂等键；用随机标题会导致
     同一批素材每次剪辑都被判定为新任务，重复消耗渲染算力。 */
  function makeTitle(pool, hasImg) {
    var base = String(pool[0] && pool[0].name || '案例素材').split('·')[0].trim().slice(0, 12) || '案例素材';
    var arr = hasImg ? TITLE_POOL.image : TITLE_POOL.video;
    var seed = hashStr(pool.map(function (m) { return m.name || m.id || ''; }).join('|'));
    return base + ' · ' + arr[seed % arr.length];
  }

  function mxCut() {
    var pool = pickPool();
    if (!pool.length) {
      appToast('素材池为空，请先上传素材', 'warn', '无法开始剪辑', 2800);
      mxLog('err', '剪辑中止：素材池为空');
      setTimeout(mxUpload, 320);
      return;
    }
    var pickedN = MX.materials.filter(function (m) { return m.picked; }).length;
    if (!pickedN) mxLog('warn', '未勾选素材，已自动使用全部 ' + pool.length + ' 条');

    syncCfgFromWf();
    var W = wfAll();
    var hasImg = pool.some(function (m) { return m.kind === 'image'; });
    var count = estimateCount(pool);
    var title = makeTitle(pool, hasImg);
    var job = {
      id: uid('j'), title: title, status: 'running', progress: 0, total: count, step: STEPS[0].t,
      note: '素材 ' + pool.length + ' 个 · ' + W.video.ratio + ' · ' + (hasImg ? '图片运镜成片' : '智能混剪') +
            ' · 产出 1 条 · ' + voicePlanLabel(),
      mats: pool.map(function (m) { return m.id; }), created_at: new Date().toISOString()
    };
    MX.jobs.unshift(job);
    renderQueue();
    mxLog('info', '创建剪辑任务「' + title + '」· 素材 ' + pool.length + ' 个 · 目标 1 条 · 比例 ' + W.video.ratio);
    obs('info', '剪辑任务开始', { title: title, mats: pool.length, count: count, hasImg: hasImg });
    persistJob(job);

    /* 自动剪辑一律走真实渲染通道。本地模拟仅在 URL 显式带 demosim=1 的演示场景可用，
       未接入渲染服务时如实报错并给出修复指引 —— 不再静默产出不可播放的假成片。 */
    var giveUpNoRender = function () {
      job.status = 'failed';
      job.errorText = '渲染通道未接入';
      job.stage = '未接入渲染服务';
      job.note = '自动剪辑需要服务端 FFmpeg 渲染通道。已自动探测（页面同源 + 本机 8787）均未探通，请确认服务端已启动，或在「系统设置 → 运行时」填写服务端地址';
      MX.wfRun = null;
      renderQueue(); renderWorkflow(); persistJob(job);
      mxLog('err', '剪辑中止：未接入渲染服务（自动剪辑必须走真实渲染通道，不产出模拟成片）');
      obs('warn', '剪辑中止：渲染通道未接入', {});
      appToast('渲染服务未探通（页面同源与 127.0.0.1:8787 均失败）：请在「系统设置 → 运行时」填服务地址（如 http://118.25.44.79:8787），或确认服务端已启动后重试', 'err', '渲染通道未接入', 6000);
    };

    var proceed = function () {
      /* remoteCut 是 async 函数：必须接住它的返回值与异常。
         旧写法只判断返回值真假（`if (remoteCut(...)) return;`），一旦函数体
         在第一个 await 之前抛错（例如引用了未声明变量），async 会把它变成
         rejected Promise —— 没人 catch，界面既不报错也不清理流程条，
         表现为「04 视频生成」永远执行中，服务端却连一个请求都收不到。 */
      Promise.resolve(remoteCut(job, pool, hasImg)).then(function (started) {
        if (started) return;
        /* remoteCut 返回 false：素材来源问题已在函数内如实提示 */
        job.status = 'failed';
        job.stage = '素材无法渲染';
        job.note = '所选素材没有可渲染的来源，请上传素材或使用示例素材';
        MX.wfRun = null;
        renderQueue(); renderWorkflow(); persistJob(job);
      })['catch'](function (e) {
        var msg = String((e && e.message) || e);
        job.status = 'failed';
        job.errorText = msg;
        job.stage = '渲染任务启动失败';
        job.note = '渲染任务启动失败：' + msg + '（任务已如实标记失败，未产出任何成片）';
        MX.wfRun = null;   /* 启动失败是终态：必须清理流程条运行标记 */
        renderQueue(); renderWorkflow(); persistJob(job);
        mxLog('err', '渲染任务启动失败：' + msg);
        obs('error', '渲染任务启动失败', { error: msg });
        appToast('渲染任务启动失败：' + msg.slice(0, 60), 'err', '无法开始渲染', 4200);
      });
    };

    var submit = function () {
      if (DEMO_SIM) {
        mxLog('warn', '演示模式（demosim=1）→ 本次为本地模拟渲染，成片不可播放');
        localSimulate(job, pool, hasImg);
        return;
      }
      if (renderUp()) { proceed(); return; }
      /* 页面可能先于服务端启动，或服务端刚重启：boot 期自动探测只跑一次且不重试，
         这里补探一次再判定，避免一次瞬时失败就废掉整次剪辑 */
      job.stage = '正在探测渲染服务…';
      renderQueue(); renderWorkflow();
      mxLog('info', '渲染通道未接入 → 补探一次服务端地址');
      var probe = (typeof window.autoDetectBff === 'function')
        ? window.autoDetectBff().then(function () { return renderUp(); }, function () { return false; })
        : Promise.resolve(false);
      probe.then(function (up) {
        if (up || renderUp()) { proceed(); return; }
        giveUpNoRender();
      });
    };

    runWfSteps(job, submit);
  }

  /* 本地模拟：保留原有 9 阶段推进，用于未接入服务端时跑通界面链路 */
  function localSimulate(job, pool, hasImg) {
    job.sim = true;
    job.stage = STEPS[0].t;
    var i = 0;
    var timer = setInterval(function () {
      var st = STEPS[i];
      job.progress = st.p;
      job.step = st.t;
      job.stage = st.t;
      renderQueue();
      mxLog(st.p >= 100 ? 'ok' : 'plain', '[' + job.title + '] ' + st.t + ' · ' + st.p + '%');
      i++;
      if (i >= STEPS.length) { clearInterval(timer); finishJob(job, pool, hasImg); }
    }, 620);
  }

  /* ---------------- 6.5 真实渲染通道（BFF + FFmpeg Worker） ---------------- */

  function api() { try { return window.Api || null; } catch (e) { return null; } }
  function renderUp() {
    var a = api();
    return !!(a && typeof a.live === 'function' && a.live() && typeof a.editJob === 'function');
  }
  function apiBase() { var a = api(); return (a && typeof a.base === 'function' && a.base()) || ''; }

  /* ---------------- 6.6 本地配音 / 字幕能力（显示真实状态，不撒谎） ---------------- */
  function voiceState() {
    /* 未接渲染服务时直接给结论，不挂「检测中」—— 本地模拟不产出配音，这是事实 */
    if (!renderUp()) return { known: true, ok: false, label: '需真实渲染', detail: '配音与字幕随服务端真实渲染提供；本地模拟不产出配音' };
    var ab = MX.abilities;
    if (!ab || !ab.voice) return { known: false, ok: false, label: '检测中…', detail: '' };
    var v = ab.voice;
    if (!v.ok) return { known: true, ok: false, label: '未接入', detail: v.reason || '本机没有可用的语音合成' };
    var sub = ab.subtitle || {};
    return {
      known: true, ok: true,
      label: (v.voice || '系统语音') + (v.cjk ? '' : '（无中文语音）'),
      detail: (v.provider || '') + ' · 语速 ' + (v.rate || 1.1) + '× · 字幕 ' + (sub.modeName || '未接入') + (v.warning ? ' · ' + v.warning : '')
    };
  }
  /* 开着配音开关、但服务端没有可用 TTS 时，必须如实说明后果 */
  function voicePlanLabel() {
    if (!MX.cfg.voice) return '无配音';
    if (!renderUp()) return '配音需真实渲染（当前本地模拟）';
    var vs = voiceState();
    if (!vs.known) return '配音通道检测中…';
    if (!vs.ok) return '配音未接入 · 将输出无配音成片';
    return '配音 + 字幕（' + vs.label + '）';
  }
  function refreshAbilities() {
    var a = api();
    if (!a || !renderUp() || typeof a.editStats !== 'function') return;
    a.editStats().then(function (r) {
      var ab = r && r.ok && r.data && r.data.abilities;
      if (!ab) return;
      var prevOk = MX.abilities && MX.abilities.voice && MX.abilities.voice.ok;
      MX.abilities = ab;
      renderTools();
      paintCfgExtra();
      var nowOk = ab.voice && ab.voice.ok;
      if (!prevOk && nowOk) mxLog('ok', '本地配音已就绪：' + (ab.voice.voice || '系统语音') + ' · 字幕 ' + ((ab.subtitle && ab.subtitle.modeName) || ''));
      if (prevOk && !nowOk && ab.voice.reason) mxLog('warn', '本地配音不可用了：' + ab.voice.reason);
    })['catch'](function () { /* 服务端不可达时保持上次状态 */ });
  }

  /* ---------------- 6.7 服务端内置示例素材（真实图片，可直接参与渲染） ----------------
     种子素材原本只有元数据（没有文件、服务端也没有二进制），以前这类素材点剪辑
     只能落回本地模拟。现在渲染通道可用时，把种子素材绑定到服务端内置示例图：
     它们是真实 JPEG，走完整的「解码 → 运镜 → 编码」链路，产出可播放成片。
     只绑定不追加：素材数量保持稳定，云端恢复与统计口径都不受影响。 */
  var SEED_SID = { 'm-seed1': 'sp-chenille', 'm-seed2': 'sp-cushion', 'm-seed3': 'sp-velvet', 'm-seed4': 'sp-factory' };
  var SAMPLING = false;
  function refreshSamples() {
    var a = api();
    if (!renderUp() || SAMPLING || !a || typeof a.editSamples !== 'function') return;
    SAMPLING = true;
    a.editSamples().then(function (r) {
      SAMPLING = false;
      var items = r && r.ok && r.data && r.data.items;
      if (!Array.isArray(items) || !items.length) return;
      var bound = 0;
      items.forEach(function (it) {
        MX.materials.forEach(function (m) {
          if (SEED_SID[m.id] === it.id && m.sid !== it.id) {
            m.sid = it.id;
            m.url = apiBase() + it.url;   /* 缩略图直接显示服务端真实图 */
            m.w = it.width || m.w; m.h = it.height || m.h;
            bound++;
          }
        });
      });
      if (bound) {
        renderMaterials();
        mxLog('ok', '示例素材已绑定服务端真实图片（' + bound + ' 条可直接参与真实渲染，无需上传）');
      }
    })['catch'](function () { SAMPLING = false; });
  }

  /* ---------------- 6.8 素材的渲染来源 ----------------
     三类来源都能走真实渲染：本地 File（上传）、服务端示例（sid）、都无则不可渲染。 */
  function renderSources(pool) {
    var files = [];
    var sids = [];
    var dead = 0;
    pool.forEach(function (m) {
      if (MX.files[m.id]) { files.push(m); return; }
      if (m.sid) { if (sids.indexOf(m.sid) < 0) sids.push(m.sid); return; }
      dead++;
    });
    return { files: files, sids: sids, dead: dead };
  }

  async function remoteCut(job, pool, hasImg) {
    var a = api();
    var src = renderSources(pool);
    if (!src.files.length && !src.sids.length) {
      mxLog('err', '所选素材没有可渲染的来源（既无本地文件、也不是服务端示例素材）→ 真实渲染无法进行');
      appToast('所选素材无法真实渲染：没有本地文件，也不是服务端示例素材。请重新上传素材', 'err', '无法渲染', 4200);
      return false;
    }
    var list = src.files;
    if (src.dead) mxLog('warn', '有 ' + src.dead + ' 条素材缺少渲染来源（云端恢复且未上传过文件），已跳过');
    if (src.sids.length) mxLog('info', '含 ' + src.sids.length + ' 条服务端示例素材（无本地文件，由服务端直接渲染）');

    /* 七步工作流 → 服务端渲染参数映射（成片条数固定 1 条） */
    var W = wfAll();
    syncCfgFromWf();
    var scriptText = String(W.script.text || '').trim();
    var ctaText = W.cover.cta ? '评论区扣 1 拿投放报价 · 全行业服务商' : '';
    var voiceText = scriptText || ((job.title || '') + '。' + ctaText);
    var shotSec = Number(W.video.shot) || 2.5;
    /* 快节奏镜头更短、舒缓更长，让「网感剪辑」的节奏选择真正落到时间轴上 */
    if (W.edit.rhythm === 'fast') shotSec = Math.max(1.5, shotSec * 0.72);
    else if (W.edit.rhythm === 'slow') shotSec = Math.min(6, shotSec * 1.35);
    shotSec = Math.round(shotSec * 10) / 10;

    var renderParams = {
      title: job.title,
      count: 1,
      ratio: W.video.ratio,
      shotSeconds: shotSec,
      motion: W.video.motion,
      transition: (W.edit.trans === 'cut') ? 'cut' : 'fade',
      dedupe: !!(W.edit.on && W.edit.dedupe),
      coverTitle: !!W.cover.on,
      cta: !!(W.cover.on && W.cover.cta),
      voice: !!W.voice.on,
      subtitle: !!(W.voice.on && W.voice.subtitle),
      voiceRate: Number(W.voice.rate) || 1.1,
      voiceText: voiceText,
      tags: String(W.cover.tags || '').trim()
    };
    /* 注意：FormData 在下方「素材全部入库后」才构造（那时才知道 assetIds）。
       这里不能再提前 append —— 旧代码在这里引用未声明的 fd，直接抛
       ReferenceError，让整条剪辑流程静默停住。 */

    job.remote = true;
    job.stage = '提交素材到渲染服务';
    job.progress = 3;

    /* ── 根治 HTTP 524（Cloudflare 边缘 100s 响应超时）──
       任何单个请求都不再携带整包素材：所有本地素材一律走
       init → 自适应分块 → finish（每个请求秒级返回，重传按块号幂等覆盖），
       渲染任务提交只带 assetIds + samples 的微小 JSON。
       分块大小按实测吞吐动态调整（目标单块 ≤20s 传完，超时上限 95s < 100s 红线），
       即使外网通道吞吐只有几十 KB/s，单请求也不会触发 100s 边缘超时。 */
    var totalBytes = 0;
    list.forEach(function (m) { var f = MX.files[m.id]; if (f && f.size) totalBytes += f.size; });
    /* 先探直连上传网关（服务器 443）：通了就彻底绕开隧道 100s 红线，不通静默回退 */
    var direct = false;
    try { direct = !!(await a.probeUpDirect()); } catch (e) { direct = false; }
    var CHUNK_MIN = 64 * 1024, CHUNK_MAX = (direct ? 8 : 4) * 1048576;
    var chunkBytes = direct ? 1024 * 1024 : 128 * 1024;   /* 直连起步 1MB，隧道起步 128KB */
    var CONC = direct ? 4 : 3;                            /* 直连 4 路，隧道 3 路 */
    var TARGET_SEC = direct ? 25 : 20;                    /* 单块目标耗时 */
    var CHUNK_TIMEOUT = direct ? 150000 : 95000;          /* 单块上限：直连没有边缘红线，可放宽 */
    mxLog('info', '已接入渲染服务 → ' + list.length + ' 个本地素材（共 ' + (totalBytes / 1048576).toFixed(1) + ' MB，' +
      (direct ? '直连网关 ' + CONC + ' 路并发' : '隧道自适应分块 · ' + CONC + ' 路并发直传') + '）' +
      (src.sids.length ? ' + ' + src.sids.length + ' 条服务端示例' : '') + '，交由服务端 FFmpeg 真实合成');
    var sent = 0;
    var tp = 0;                              /* 实测聚合吞吐（字节/秒） */
    var ids = [];
    var setP = function (done) {
      var pct = Math.min(100, Math.round(done / (totalBytes || 1) * 100));
      job.progress = 3 + Math.round(pct * 0.25);   /* 上传段占进度 3%→28% */
      job.stage = '分块上传 ' + pct + '%';
      job.note = '分块上传中 ' + (done / 1048576).toFixed(1) + ' / ' + (totalBytes / 1048576).toFixed(1) + ' MB（块大小 ' + Math.round(chunkBytes / 1048576 * 10) / 10 + ' MB）…';
      renderQueue();
    };
    /* 单请求自动重试：弱网/代理中断常见；服务端按块号幂等落盘，重传安全 */
    var withRetry = function (label, fn, tries) {
      var go = function (left) {
        return fn().then(function (r) {
          if (r && r.ok) return r;
          if (left > 0) {
            mxLog('warn', label + ' 失败（' + ((r && (r.error || r.code)) || '未知') + '），2s 后自动重试…');
            return new Promise(function (res) { setTimeout(function () { res(go(left - 1)); }, 2000); });
          }
          return r;
        });
      };
      return go(tries === undefined ? 2 : tries);
    };
    var uploadOne = function (m) {
      var f = MX.files[m.id];
      var fname = m.rawName || f.name || (m.name + (m.kind === 'image' ? '.jpg' : '.mp4'));
      return withRetry('初始化「' + fname + '」', function () { return a.uploadInit(fname, f.size); }).then(function (r0) {
        if (!r0 || !r0.ok) throw new Error('初始化上传失败：' + ((r0 && (r0.error || r0.message)) || '未知'));
        var upId = r0.data.uploadId;
        var fileT0 = Date.now();
        var done = 0;                       /* 本文件已确认落盘字节 */
        var loaded = {};                    /* 在途块已发送字节，用于平滑进度 */
        var parts = {};                     /* 块号 → [起始偏移, 长度]，供缺块补传 */
        var sumLoaded = function () { var t = 0; for (var k in loaded) t += loaded[k]; return t; };
        var putChunk = function (i2, off2, sz) {
          var to = Math.min(CHUNK_TIMEOUT, Math.max(45000, tp ? Math.round(sz * CONC / tp * 4000) : 60000));
          return withRetry('分块上传「' + fname + '」第 ' + (i2 + 1) + ' 块', function () {
            return a.uploadChunk(upId, i2, f.slice(off2, off2 + sz), {
              timeout: to,
              onprogress: function (l) { loaded[i2] = l; setP(sent + done + sumLoaded()); }
            });
          }).then(function (rc) {
            if (!rc || !rc.ok) throw new Error('分块上传失败（' + fname + ' 第 ' + (i2 + 1) + ' 块）：' + ((rc && (rc.error || rc.message)) || '未知'));
            delete loaded[i2];
            return rc;
          });
        };
        var cursor = 0, idx = 0, aborted = false;
        var worker = function () {
          if (aborted || cursor >= f.size) return Promise.resolve();
          var off2 = cursor;
          var sz = Math.min(chunkBytes, f.size - off2);
          cursor += sz;
          var i2 = idx++;
          parts[i2] = [off2, sz];
          return putChunk(i2, off2, sz).then(function () {
            done += sz;
            var dt = (Date.now() - fileT0) / 1000;
            if (dt > 0.5) tp = done / dt;   /* 聚合吞吐 = 已完成字节 / 已耗时 */
            /* 每块目标 ≤20s（含并发重叠），区间 [64KB, 4MB] */
            if (tp) chunkBytes = Math.max(CHUNK_MIN, Math.min(CHUNK_MAX, Math.round(tp * TARGET_SEC / CONC)));
            setP(sent + done);
            return worker();                /* 该连接继续取下一块 */
          });
        };
        var workers = [];
        for (var w = 0; w < CONC; w++) workers.push(worker());
        /* 入库；若服务端报 INCOMPLETE（某块 502 漏传），按缺失块号补传后重试（最多 2 轮） */
        var finishWithRepair = function (round) {
          return a.uploadFinish(upId).then(function (rf) {
            if (rf && rf.ok) return rf;
            var d = (rf && rf.data) || {};
            if (rf && rf.code === 'INCOMPLETE' && round < 2 && (d.missing || []).length) {
              mxLog('warn', '素材「' + fname + '」缺 ' + d.missing.length + ' 块（收到 ' + d.have + '/' + d.expect + ' 字节），补传后重试…');
              var back = Promise.resolve();
              d.missing.forEach(function (i3) {
                back = back.then(function () {
                  var p = parts[i3];
                  if (!p) return Promise.reject(new Error('无法定位缺失块 ' + i3));
                  return putChunk(i3, p[0], p[1]);
                });
              });
              return back.then(function () { return finishWithRepair(round + 1); });
            }
            return rf;
          });
        };
        return Promise.all(workers)['catch'](function (e) { aborted = true; throw e; }).then(function () {
          return finishWithRepair(0);
        }).then(function (rf) {
          if (!rf || !rf.ok) throw new Error('素材入库失败：' + ((rf && (rf.error || rf.message)) || '未知'));
          var as = (rf.data && rf.data.asset) || {};
          sent += f.size || 0; setP(sent);
          mxLog('info', '素材已上传入库：' + (as.name || fname) + ' → ' + as.id);
          ids.push(as.id);
        });
      });
    };
    var startJob = function (r) {
      if (!r || !r.ok) {
        var m2 = (r && (r.error || r.message)) || (r && r.code) || '未知错误';
        throw new Error(typeof m2 === 'string' ? m2 : JSON.stringify(m2));
      }
      var d = r.data || {};
      (d.rejected || []).forEach(function (x) { mxLog('warn', '服务端拒绝素材「' + x.name + '」：' + x.error); });
      if (d.reused) mxLog('info', '服务端命中幂等：素材与规则未变，直接复用已渲染结果（不重复消耗算力）');
      job.remoteId = d.job.id;
      job.stage = d.reused && d.job.status === 'done' ? '复用已完成渲染' : '服务端渲染中…';
      job.note = '服务端任务 ' + d.job.id + ' · 队列 ' + ((d.queue && d.queue.queued) || 0) + ' 排队 / ' + ((d.queue && d.queue.running) || 0) + ' 渲染中';
      renderQueue();
      mxLog('ok', '渲染任务已受理：' + d.job.id + '（并发 ' + ((d.queue && d.queue.concurrency) || 1) + '）');
      audit('提交真实渲染', job.title + ' · ' + (list.length + src.sids.length) + ' 素材 · ' + job.total + ' 条');
      pollRemote(job, a, 0);
    };
    var failJob = function (e) {
      /* fail-loud：渲染服务不可用是真实故障，不回退模拟产出假成片 */
      var msg = String((e && e.message) || e);
      job.status = 'failed';
      job.errorText = msg;
      job.stage = '渲染服务调用失败';
      job.note = '渲染服务调用失败：' + msg + ' · 请确认服务端已启动或服务地址正确';
      MX.wfRun = null;   /* 终态必须同步清理流程条，否则「04 视频生成」永远显示执行中 */
      renderQueue(); renderWorkflow(); persistJob(job);
      mxLog('err', '调用渲染服务失败：' + msg + '（任务已如实标记失败，不产出模拟成片）');
      obs('error', '渲染服务调用失败', { error: msg });
      appToast('渲染服务调用失败：' + msg.slice(0, 60), 'err', '服务不可用', 4200);
    };
    job.note = '正在提交 ' + (list.length + src.sids.length) + ' 个素材到服务端（真实 FFmpeg 合成）…';
    renderQueue();

    /* 逐素材顺序分块直传 → 全部入库后按 assetIds 提交微小渲染任务 */
    var chain = Promise.resolve();
    list.forEach(function (m) { chain = chain.then(function () { return uploadOne(m); }); });
    chain.then(function () {
      var fd = new FormData();
      fd.append('params', JSON.stringify(Object.assign({}, renderParams, { assetIds: ids })));
      if (src.sids.length) fd.append('samples', JSON.stringify(src.sids));
      job.stage = '提交渲染任务';
      job.note = '素材已全部入库，提交渲染任务…';
      renderQueue();
      return a.editJob(fd, { timeout: 60000 }).then(startJob);
    })['catch'](failJob);
    return true;
  }

  function pollRemote(job, a, n) {
    if (n > 900) {                       /* 约 18 分钟上限 */
      job.status = 'done'; job.progress = 100; job.stage = '渲染超时';
      job.note = '渲染服务长时间未返回，请到服务端查看任务 ' + job.remoteId;
      MX.wfRun = null;   /* 超时也是终态：清理流程条运行标记 */
      renderQueue(); renderWorkflow(); persistJob(job);
      mxLog('err', '渲染超时：服务端任务 ' + job.remoteId + ' 长时间未返回');
      return;
    }
    if (job.canceled) return;
    a.editJobStatus(job.remoteId).then(function (r) {
      var sj = (r && r.ok && r.data && r.data.job) || null;
      if (!sj) {
        /* 连续多次查不到任务（服务端重启/记录被清）→ 快速失败，不再空转 18 分钟 */
        job.__miss = (job.__miss || 0) + 1;
        if (job.__miss > 15) {
          job.status = 'failed';
          job.errorText = '服务端查不到任务 ' + job.remoteId;
          job.stage = '渲染任务丢失';
          job.note = '服务端没有该任务记录（服务端可能刚重启或任务被清理），请重新发起剪辑';
          MX.wfRun = null;
          renderQueue(); renderWorkflow(); persistJob(job);
          mxLog('err', '渲染任务丢失：服务端查不到 ' + job.remoteId + '（已停止轮询，请重新发起剪辑）');
          appToast('服务端查不到渲染任务，已停止等待。请重新点「一键跑完 7 步」', 'err', '任务丢失', 4200);
          return;
        }
        setTimeout(function () { pollRemote(job, a, n + 1); }, 2000); return;
      }
      job.__miss = 0;
      job.progress = Math.max(job.progress, Math.min(99, sj.progress || 0));
      job.stage = sj.stage || '服务端渲染中';
      job.note = '服务端任务 ' + sj.id + ' · ' + (sj.stage || '') + ' · 已产出 ' + sj.outputCount + '/' +
        ((sj.request && sj.request.count) || job.total) + ' 条 · 已尝试 ' + (sj.attempt || 1) + ' 次';
      mergeRemoteOutputs(job, sj);
      renderQueue();
      if (sj.status === 'done') { onRemoteDone(job, sj); return; }
      if (sj.status === 'failed') { onRemoteFail(job, sj); return; }
      if (sj.status === 'canceled') {
        job.status = 'done'; job.stage = '服务端已取消';
        job.note = '渲染任务在服务端被取消';
        MX.wfRun = null;   /* 取消是终态：清理流程条运行标记 */
        renderQueue(); renderWorkflow(); persistJob(job);
        mxLog('warn', '服务端任务已取消');
        return;
      }
      setTimeout(function () { pollRemote(job, a, n + 1); }, 1200);
    })['catch'](function () { setTimeout(function () { pollRemote(job, a, n + 1); }, 2500); });
  }

  /* 服务端每产出一条成片就立刻进入成片库，可边渲染边预览 */
  function mergeRemoteOutputs(job, sj) {
    var adds = [];
    (sj.outputs || []).forEach(function (o) {
      var rid = 'ro_' + o.id;
      var base = apiBase();
      var item = {
        id: rid, title: job.title + ' · 第 ' + o.index + ' 条',
        cover: '', videoUrl: base + o.url, coverUrl: base + o.coverUrl,
        theme: ((o.index - 1) % 4) + 1, kind: 'video',
        du: o.duration, ratio: o.ratio,
        mats: (o.sources || []).length || sj.assetCount || 1, shots: o.shots,
        srcName: (o.sources || [])[0] || '', pushed: false, ts: Date.now(),
        jobId: job.id, rendered: true, remoteId: o.id,
        width: o.width, height: o.height, bytes: o.bytes
      };
      var exist = MX.outputs.filter(function (x) { return x.id === rid; })[0];
      if (exist) { Object.assign(exist, item); return; }
      adds.push(item);
      job.outputsLoaded = (job.outputsLoaded || 0) + 1;
      mxLog('ok', '成片入库：' + o.file + ' · ' + o.duration + 's · ' + o.width + '×' + o.height +
        ' · ' + (o.bytes / 1048576).toFixed(2) + 'MB' + (o.bgm ? ' · 含背景音乐' : ''));
    });
    if (adds.length) {
      MX.outputs = adds.concat(MX.outputs);
      MX.stats.rendered += adds.length;
      renderOutputs();
      saveOutputs();
    }
  }

  function onRemoteDone(job, sj) {
    job.status = 'done';
    job.progress = 100;
    job.stage = '已完成（真实渲染）';
    job.note = '真实渲染完成 · ' + sj.outputCount + ' 条成片 · 用时 ' + ((sj.elapsedMs || 0) / 1000).toFixed(1) + 's · 已落盘服务端';
    MX.stats.rounds++;
    renderQueue(); renderOutputs(); persistJob(job); saveOutputs();
    if (sj.media) {
      var mv = sj.media.voice || {}, msb = sj.media.subtitle || {};
      if (mv.ok) mxLog('ok', '本单配音：' + (mv.voice || '系统语音') + ' · ' + (mv.sentences || 0) + ' 句 · ' + (mv.duration || 0) + 's · 语速 ' + (mv.rate || 1.1) + '×');
      else if (MX.cfg.voice) mxLog('warn', '本单未生成配音：' + (mv.reason || '未知原因') + '（成片为无配音版本，未假装有配音）');
      if (msb.ok) mxLog('info', '本单字幕：' + (msb.mode === 'libass' ? 'subtitles 滤镜烧录' : msb.mode === 'drawtext' ? 'drawtext 逐条烧录（降级）' : '未烧录'));
    }
    mxLog('ok', '真实渲染完成：「' + job.title + '」产出 ' + sj.outputCount + ' 条可播放成片（服务端 FFmpeg 合成）');
    obs('info', '真实渲染完成', { task: sj.id, outputs: sj.outputCount, ms: sj.elapsedMs });
    audit('真实渲染完成', job.title + ' · ' + sj.outputCount + ' 条');
    appToast('真实渲染完成，「' + job.title + '」产出 ' + sj.outputCount + ' 条可播放成片', 'ok', '渲染完成', 3600);
    wfFinish(job);
    var card = q('#mxOutCard');
    if (card) { try { card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {} }
  }

  /* 取消任务：本地模拟直接停表；服务端任务同时通知服务端终止 */
  function cancelJob(jobId) {
    var job = MX.jobs.filter(function (j) { return j.id === jobId; })[0];
    if (!job) return;
    appConfirm({
      title: '取消渲染', html: '确认取消「<b>' + esc(job.title) + '</b>」？<br>已产出的成片会保留在成片库中。',
      okText: '取消渲染', cancelText: '继续渲染',
      onOk: function () {
        job.canceled = true;
        if (job.remoteId && api()) {
          api().editJobCancel(job.remoteId).then(function (r) {
            if (r && r.ok) mxLog('warn', '已通知服务端终止任务 ' + job.remoteId);
            else mxLog('warn', '服务端取消失败：' + ((r && (r.error || r.code)) || '未知'));
          })['catch'](function () { mxLog('warn', '服务端取消请求异常'); });
        }
        job.status = 'done';
        job.progress = 100;
        job.stage = '已取消';
        job.note = '任务已取消，已产出 ' + MX.outputs.filter(function (o) { return o.jobId === job.id; }).length + ' 条成片已保留';
        MX.wfRun = null;   /* 取消是终态：清理流程条运行标记 */
        renderQueue(); renderWorkflow();
        mxLog('warn', '任务已取消：「' + job.title + '」');
        audit('取消渲染任务', job.title);
        appToast('已取消渲染任务，已产出的成片仍保留', 'warn', '已取消', 2800);
      }
    });
  }

  function onRemoteFail(job, sj) {
    job.status = 'done';
    job.progress = 100;
    job.stage = '渲染失败';
    job.errorText = String(sj.error || '未知原因');
    job.note = '服务端渲染失败：' + job.errorText + '（已保留此前产出的成片）';
    MX.wfRun = null;   /* 失败也是终态：清理流程条运行标记，否则「04 视频生成」永远执行中 */
    renderQueue(); renderWorkflow(); persistJob(job);
    mxLog('err', '服务端渲染失败：' + job.errorText);
    obs('error', '服务端渲染失败', { task: sj.id, error: job.errorText });
    appToast('服务端渲染失败：' + job.errorText.slice(0, 60), 'err', '渲染失败', 4200);
    var logs = (sj.logs || []).slice(-12).map(function (l) {
      return '<div>· ' + esc(String(l.msg || '').slice(0, 120)) + '</div>';
    }).join('');
    appModal({
      title: '渲染失败', sub: '服务端任务 ' + (job.remoteId || ''), icon: 'i-warning', okText: '知道了',
      body: '<div class="mx-alert red">' + esc(job.errorText) + '</div>' +
        '<div class="mx-stage-note">已自动重试至上限后转入死信。已产出的成片仍保留在成片库中，可直接使用。</div>' +
        (logs ? '<div style="margin-top:10px;font-weight:600;font-size:12.5px">服务端日志</div><div class="mx-srvlog">' + logs + '</div>' : '') +
        '<div class="mx-render-info">常见原因：素材损坏、磁盘空间不足、FFmpeg 缺失或编码器不可用。' +
        '到服务端目录执行 <b>node server/index.js</b> 可查看完整日志；配置 <b>RENDER_KEEP_TMP=1</b> 可保留中间文件排查。</div>'
    });
  }

  function finishJob(job, pool, hasImg) {
    job.status = 'done'; job.progress = 100; job.step = '已写入成片库';
    job.stage = '已完成（本地模拟）';
    job.note = '本地模拟完成 · 生成 ' + job.total + ' 条分镜预览（' + MX.cfg.ratio + '）· 未接入渲染服务，成片不可播放';
    pool.forEach(function (m) { m.uses = (m.uses || 0) + 1; });
    var outs = makeOutputs(job, pool, hasImg);
    MX.outputs = outs.concat(MX.outputs);
    MX.stats.rounds++;
    renderQueue(); renderMaterials(); renderOutputs();
    persistJob(job); saveOutputs();
    mxLog('warn', '剪辑完成（本地模拟）：「' + job.title + '」生成 ' + outs.length + ' 条分镜预览 · 配置渲染服务地址后可产出可播放成片');
    obs('info', '剪辑任务完成（模拟）', { title: job.title, outputs: outs.length });
    audit('智能剪辑完成（模拟）', job.title + ' · ' + outs.length + ' 条');
    wfFinish(job);
    appToast('剪辑完成，「' + job.title + '」生成 ' + outs.length + ' 条分镜预览（本地模拟，不可播放）', 'warn', '模拟完成', 3600);
    var card = q('#mxOutCard');
    if (card) { try { card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {} }
  }

  function makeOutputs(job, pool, hasImg) {
    var arr = [];
    for (var i = 0; i < job.total; i++) {
      var m = pool[i % pool.length];
      arr.push({
        id: uid('o'), title: job.title + ' · 第 ' + (i + 1) + ' 条',
        cover: m.url || '', theme: m.theme || ((i % 4) + 1), kind: m.kind,
        du: m.kind === 'image' ? (8 + (i % 3) * 2) : clamp(Math.round((m.dur || 18) * (0.8 + (i % 3) * 0.25)), 8, 45),
        ratio: MX.cfg.ratio, mats: pool.length, shots: clamp(pool.length + (i % 3), 1, 12),
        srcName: m.name, srcId: m.id, pushed: false, ts: Date.now(), jobId: job.id,
        rendered: false, sim: true
      });
    }
    return arr;
  }

  function renderQueue() {
    var box = q('#mxTaskList');
    if (!box) return;
    if (!MX.jobs.length) {
      box.innerHTML = '<div style="text-align:center;color:var(--text-3);padding:34px 16px;font-size:13px">' +
        '暂无剪辑任务。上传素材后点「一键跑完 7 步」创建第一个任务。</div>';
    } else {
      box.innerHTML = MX.jobs.slice(0, 5).map(function (t) {
        var isRemote = !!t.remoteId;
        var st = t.status === 'done'
          ? (t.sim ? { tag: 'amber', text: '模拟完成', cls: 'a' } : { tag: 'blue', text: '已渲染 · 待发布', cls: 'g' })
          : (t.status === 'running'
            ? { tag: 'violet', text: (isRemote ? '真实渲染 ' : '模拟剪辑 ') + (t.progress || 0) + '%', cls: '' }
            : { tag: 'amber', text: '排队中', cls: 'a' });
        var ico = t.status === 'done' ? 'i-check' : (t.status === 'running' ? 'i-scissors' : 'i-clock');
        var icoStyle = t.status === 'running'
          ? 'background:var(--violet-soft);color:var(--violet)'
          : (t.status === 'done' ? 'background:var(--green-soft);color:var(--green)' : 'background:var(--amber-soft);color:var(--amber)');
        var line = t.stage || t.step || '';
        return '<div class="task-row">' +
          '<div class="task-ico" style="' + icoStyle + '"><svg class="icon"><use href="#' + ico + '"/></svg></div>' +
          '<div style="flex:1;min-width:0">' +
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><b style="font-size:12.8px">' + esc(t.title) + '</b>' +
            '<span class="tag ' + st.tag + '">' + st.text + '</span>' +
            (isRemote ? '<span class="tag blue">服务端</span>' : '') + '</div>' +
            '<div class="progress ' + st.cls + '"><i style="width:' + (t.progress || 0) + '%"></i></div>' +
            '<div style="font-size:11px;color:var(--text-3);margin-top:6px">' + esc(line) + '</div>' +
            (t.note ? '<div style="font-size:11px;color:var(--text-3);margin-top:2px">' + esc(t.note) + '</div>' : '') +
            (t.errorText ? '<div style="font-size:11px;color:var(--red,#d33);margin-top:2px">失败：' + esc(String(t.errorText).slice(0, 90)) + '</div>' : '') +
          '</div>' +
          '<div class="mx-rowacts">' +
            (t.status === 'done' ? '<button class="btn sm ghost" data-use="mx" data-mxjob="out" type="button">看成片</button>' : '') +
            (t.status === 'running' && isRemote ? '<button class="btn sm ghost" data-use="mx" data-mxjob="cancel" data-mxid="' + escA(t.id) + '" type="button">取消</button>' : '') +
          '</div>' +
        '</div>';
      }).join('');
    }
    var tag = q('#mxLiveTag');
    if (tag) {
      var run = MX.jobs.filter(function (j) { return j.status === 'running'; }).length;
      var qd = MX.jobs.filter(function (j) { return j.status === 'queued'; }).length;
      tag.innerHTML = '<span class="dot-live pulse"></span>' + (run ? run + ' 个进行中' : '队列空闲') + (qd ? ' · 排队 ' + qd : '') +
        (MX.stats.rendered ? ' · 已渲染 ' + MX.stats.rendered : '');
      tag.className = 'tag ' + (run ? 'violet' : (qd ? 'amber' : 'green'));
    }
  }

  /* ---------------- 7. 成片结果 ---------------- */
  function renderOutputs() {
    var g = q('#mxOutGrid');
    if (!g) return;
    if (!MX.outputs.length) {
      g.innerHTML = '<div class="mx-empty" style="grid-column:1/-1">' +
        '<svg class="icon"><use href="#i-scissors"/></svg>' +
        '<b>还没有成片</b>' +
        '<p>素材池勾选素材后点「一键跑完 7 步」，成片会随进度实时产出（单次 1 条）。</p>' +
        '</div>';
    } else {
      g.innerHTML = MX.outputs.map(function (o) {
        var cover;
        if (o.coverUrl) cover = '<img src="' + escA(o.coverUrl) + '" alt="">';
        else if (o.cover && o.kind === 'image') cover = '<img src="' + escA(o.cover) + '" alt="">';
        else if (o.cover && o.kind === 'video') cover = '<video src="' + escA(o.cover) + '" muted playsinline preload="metadata"></video>';
        else cover = '';
        var badge = o.rendered
          ? '<span class="rd"><i></i>已渲染</span><span class="play"><span><svg class="icon"><use href="#i-play"/></svg></span></span>'
          : '';
        var meta = o.rendered
          ? (o.shots + ' 段镜头 · ' + o.width + '×' + o.height + ' · 真实成片')
          : (o.shots + ' 段镜头 · 素材 ' + o.mats + ' 个 · ' + (o.kind === 'image' ? '图片运镜' : '视频混剪') + '（模拟）');
        return '<div class="mx-out" data-oid="' + escA(o.id) + '">' +
          '<div class="mx-out-cover' + outThemeCls(o.theme) + '">' +
            (cover || '<svg class="icon"><use href="#i-video"/></svg>') + badge +
            '<span class="n">' + (o.pushed ? '已排期' : '待发布') + '</span>' +
            '<span class="lbl"><em>' + mmss(o.du) + '</em><em>' + esc(o.ratio) + '</em></span>' +
          '</div>' +
          '<div class="mx-out-body">' +
            '<b title="' + escA(o.title) + '">' + esc(o.title) + '</b>' +
            '<div class="m">' + esc(meta) + '</div>' +
            '<div class="a">' +
              '<button type="button" data-use="mx" data-mxout="prev" data-oid="' + escA(o.id) + '">预览</button>' +
              (o.pushed
                ? '<button type="button" data-use="mx" class="ok" data-mxout="push" data-oid="' + escA(o.id) + '">已排期</button>'
                : '<button type="button" data-use="mx" data-mxout="push" data-oid="' + escA(o.id) + '">推送发布</button>') +
              '<button type="button" data-use="mx" class="dg" data-mxout="del" data-oid="' + escA(o.id) + '">删除</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }
    var tools = q('#mxOutTools');
    if (tools) {
      var pending = MX.outputs.filter(function (o) { return !o.pushed; }).length;
      var realN = MX.outputs.filter(function (o) { return o.rendered; }).length;
      tools.innerHTML =
        '<span class="mx-chip">成片 <b>' + MX.outputs.length + '</b> 条</span>' +
        '<span class="mx-chip' + (realN ? ' on' : '') + '">已渲染 <b>' + realN + '</b></span>' +
        '<span class="mx-chip' + (pending ? ' on' : '') + '">待发布 <b>' + pending + '</b></span>' +
        '<button class="btn sm" data-use="mx" data-mxout="pushall" type="button">全部推送发布</button>' +
        '<button class="btn sm ghost" data-use="mx" data-mxout="export" type="button">导出成片清单</button>' +
        '<button class="btn sm ghost" data-use="mx" data-mxout="clear" type="button">清空成片</button>';
    }
    paintWfPreview();
  }

  function findOut(id) { return MX.outputs.filter(function (o) { return o.id === id; })[0] || null; }

  function previewOutput(o) {
    if (!o) return;
    var shots = MX.materials.slice(0, o.shots).map(function (m) {
      return '<div class="mx-shot"><div class="s">' +
        (m.url && m.kind === 'image' ? '<img src="' + escA(m.url) + '" alt="">' : '<svg class="icon"><use href="#i-' + (m.kind === 'image' ? 'image' : 'video') + '"/></svg>') +
        '</div>' + esc(String(m.name).slice(0, 6)) + '</div>';
    }).join('');

    /* 真实渲染成片：用原生播放器直接播放服务端产出的 MP4 */
    var stage;
    if (o.videoUrl) {
      stage = '<div class="mx-prev-stage playing">' +
        '<video src="' + escA(o.videoUrl) + '" poster="' + escA(o.coverUrl || '') + '" controls playsinline preload="metadata"></video>' +
        '<div class="cap" style="z-index:3">真实渲染成片 · 可直接播放与下载</div>' +
        '</div>';
    } else {
      var cover = o.cover && o.kind === 'image' ? '<img src="' + escA(o.cover) + '" alt="">' : '';
      stage = '<div class="mx-prev-stage">' + cover +
        '<div class="ph"><svg class="icon"><use href="#i-play"/></svg>' + esc(o.ratio) + ' · ' + mmss(o.du) + '</div>' +
        '<div class="cap">评论区扣 1 拿投放报价 · 全行业服务商</div>' +
        '<div class="mx-prev-bar"><span>00:00</span><i><s></s></i><span>' + mmss(o.du) + '</span></div>' +
        '</div>';
    }

    var sub = o.videoUrl
      ? '服务端 FFmpeg 真实合成 · ' + (o.width || '') + '×' + (o.height || '') + ' · ' + mmss(o.du)
      : '以下为成片参数预览（接入渲染服务后可播放真实成片）';

    var extra = o.rendered
      ? '<div class="r"><span>成片文件</span><b>' + esc(o.remoteId || o.id) + '.mp4 · ' + ((o.bytes || 0) / 1048576).toFixed(2) + 'MB</b></div>' +
        '<div class="r"><span>分辨率</span><b>' + (o.width || '') + '×' + (o.height || '') + ' · H.264 + AAC</b></div>' +
        '<div class="r"><span>下载</span><b><a href="' + escA(o.videoUrl) + '" target="_blank" rel="noopener" style="color:var(--primary)">打开成片直链</a></b></div>'
      : '<div class="r"><span>渲染通道</span><b>未接入（自动剪辑需服务端 FFmpeg）</b></div>';

    appModal({
      title: '成片预览', sub: sub, icon: 'i-play', wide: true,
      okText: '推送发布', cancelText: '关闭',
      body: '<div class="mx-prev">' +
        stage +
        '<div>' +
          '<div class="mx-kv">' +
            '<div class="r"><span>成片标题</span><b>' + esc(o.title) + '</b></div>' +
            '<div class="r"><span>画面比例</span><b>' + esc(RATIO_LABEL[o.ratio] || o.ratio) + '</b></div>' +
            '<div class="r"><span>时长</span><b>' + mmss(o.du) + '</b></div>' +
            '<div class="r"><span>镜头数</span><b>' + o.shots + ' 段（素材 ' + o.mats + ' 个）</b></div>' +
            extra +
            '<div class="r"><span>去重处理</span><b>' + (MX.cfg.dedupe ? '镜像 + 变速 + 抽帧' : '未开启') + '</b></div>' +
            '<div class="r"><span>配音字幕</span><b>' + esc(voicePlanLabel()) + '</b></div>' +
            '<div class="r"><span>转场 / 运镜</span><b>' + (TRANS_LABEL[MX.cfg.transition] || '') + ' · ' + (MOTION_LABEL[MX.cfg.imgMotion] || '') + '</b></div>' +
            '<div class="r"><span>发布状态</span><b>' + (o.pushed ? '已进入发布排期' : '待推送') + '</b></div>' +
          '</div>' +
          '<div style="font-size:12px;color:var(--text-2);margin-top:14px;font-weight:600">分镜（取自素材池）</div>' +
          '<div class="mx-shots">' + shots + '</div>' +
        '</div>' +
      '</div>',
      onOk: function () { pushOutput(o); }
    });
  }

  function pushOutput(o) {
    if (!o) return;
    if (o.pushed) { appToast('该成片已在发布排期中', 'info', '无需重复推送', 2200); return; }
    var idx = todayIdx();
    MX.schedule[idx].chips.push({ pf: 'douyin', t: '抖', time: '待排', out: o.id });
    o.pushed = true;
    MX.stats.pushed++;
    renderSchedule(); renderOutputs();
    saveOutputs();
    mxLog('ok', '成片「' + o.title + '」已推送到发布排期（' + MX.schedule[idx].d + '）');
    audit('推送发布', o.title);
    appToast('已推送到「批量发布」的发布排期，可在那里调整时段', 'ok', '推送成功', 3000);
  }

  function pushAll() {
    var list = MX.outputs.filter(function (o) { return !o.pushed; });
    if (!list.length) { appToast('没有待发布的成片', 'info', '已全部排期', 2200); return; }
    list.forEach(function (o) {
      MX.schedule[todayIdx()].chips.push({ pf: 'douyin', t: '抖', time: '待排', out: o.id });
      o.pushed = true; MX.stats.pushed++;
    });
    renderSchedule(); renderOutputs(); saveOutputs();
    mxLog('ok', '批量推送 ' + list.length + ' 条成片到发布排期');
    audit('批量推送发布', list.length + ' 条');
    appToast('已批量推送 ' + list.length + ' 条成片到发布排期', 'ok', '推送完成', 3000);
  }

  function exportOutputs() {
    if (!MX.outputs.length) { appToast('还没有成片可导出', 'warn', '无数据', 2200); return; }
    var lines = [['成片编号', '标题', '时长(秒)', '比例', '分辨率', '镜头数', '素材数', '源素材', '渲染方式', '成片直链', '发布状态', '生成时间'].join(',')];
    MX.outputs.forEach(function (o, i) {
      lines.push([i + 1, o.title, o.du, o.ratio, o.rendered ? ((o.width || '') + 'x' + (o.height || '')) : '',
        o.shots, o.mats, o.srcName, o.rendered ? '服务端 FFmpeg 真实渲染' : '本地模拟',
        o.videoUrl || '', o.pushed ? '已排期' : '待发布',
        new Date(o.ts).toLocaleString('zh-CN')].map(function (c) {
        return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"';
      }).join(','));
    });
    try {
      var url = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
      var a = document.createElement('a');
      a.href = url; a.download = 'matrix-outputs-' + Date.now() + '.csv'; a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      mxLog('ok', '导出成片清单 ' + MX.outputs.length + ' 条');
      audit('导出成片清单', MX.outputs.length + ' 条');
      appToast('成片清单已导出', 'ok', '导出完成');
    } catch (e) { appToast('导出失败：' + ((e && e.message) || e), 'err', '导出失败'); }
  }

  /* ---------------- 8. 发布排期 ---------------- */
  function renderSchedule() {
    var box = q('#mxSchedule');
    if (!box) return;
    var ti = todayIdx();
    box.innerHTML = MX.schedule.map(function (day, i) {
      var shown = day.chips.slice(0, 3);
      var more = day.chips.length - shown.length;
      return '<div class="sch-day"><div class="d' + (i === ti ? ' today' : '') + '">' + day.d + (i === ti ? ' · 今天' : '') + '</div>' +
        '<div class="sch-slot"' + (i === ti ? ' style="border-color:var(--primary-2);background:var(--primary-soft)"' : '') + '>' +
        (shown.length
          ? shown.map(function (c) {
              return '<div class="sch-chip" style="background:var(--' + c.pf + ')">' + esc(c.t) + '<em>' + esc(c.time) + '</em></div>';
            }).join('')
          : '<div style="font-size:10.5px;color:var(--text-3);text-align:center;padding:8px 0">空闲</div>') +
        (more > 0 ? '<div class="sch-more">+' + more + ' 条' + (i === ti ? '待发' : '') + '</div>' : '') +
        '</div></div>';
    }).join('');
    var st = q('#mxSchedStat');
    if (st) {
      var total = MX.schedule.reduce(function (a, d) { return a + d.chips.length; }, 0);
      st.textContent = '本周共 ' + total + ' 条排期';
    }
  }

  /* ---------------- 9. 规则配置 ---------------- */
  var CFG_ROWS = [
    { key: 'dedupe', label: '智能去重', desc: '画面镜像 / 变速 / 抽帧，规避重复判定' },
    { key: 'voice', label: 'AI 配音 + 字幕', desc: '通用行业女声，语速 1.1×' },
    { key: 'coverTitle', label: '自动封面 + 标题', desc: '按平台自动生成标题与话题标签' },
    { key: 'cta', label: '结尾引导评论', desc: '「评论区扣 1 拿投放报价」' }
  ];

  /* 原「剪辑规则配置」卡片已并入七步工作流的参数面板，这里仅做兼容转发 */
  function renderCfg() {
    var body = q('#mxCfgBody');
    if (!body) { renderWorkflow(); return; }
    /* 绑定原有 4 个开关 */
    qa('.set-row', body).slice(0, 4).forEach(function (row, i) {
      var conf = CFG_ROWS[i];
      if (!conf) return;
      var sw = q('.switch', row);
      if (!sw || sw.dataset.mxBound) return;
      sw.dataset.mxBound = '1';
      sw.classList.toggle('on', !!MX.cfg[conf.key]);
      sw.addEventListener('click', function (e) {
        e.stopPropagation();
        var now = !sw.classList.contains('on');
        sw.classList.toggle('on', now);
        MX.cfg[conf.key] = now;
        mxLog('info', '剪辑规则：' + conf.label + ' → ' + (now ? '开启' : '关闭'));
        audit('剪辑规则变更', conf.label + (now ? ' 开启' : ' 关闭'));
        saveCfg();
        renderTools();
        paintCfgExtra();
      });
    });
    /* 追加扩展规则 */
    if (q('#mxCfgExtra')) { paintCfgExtra(); return; }
    var extra = document.createElement('div');
    extra.id = 'mxCfgExtra';
    extra.innerHTML =
      '<div class="set-row"><div class="s-main"><b>成片条数</b><p>一次剪辑生成多少条成片</p></div>' +
        '<select class="mx-sel" id="mxCfgCount"></select></div>' +
      '<div class="set-row"><div class="s-main"><b>画面比例</b><p>决定导出成片的画布尺寸</p></div>' +
        '<select class="mx-sel" id="mxCfgRatio"></select></div>' +
      '<div class="set-row"><div class="s-main"><b>图片运镜</b><p>图片素材合成视频时的镜头运动</p></div>' +
        '<select class="mx-sel" id="mxCfgMotion"></select></div>' +
      '<div class="set-row"><div class="s-main"><b>转场方式</b><p>镜头之间的衔接效果</p></div>' +
        '<select class="mx-sel" id="mxCfgTrans"></select></div>' +
      '<div class="mx-note" id="mxCfgNote"></div>';
    body.appendChild(extra);
    paintCfgExtra();
    bindCfgSelect('#mxCfgCount', 'count', [['auto', '自动按素材数'], ['5', '5 条'], ['10', '10 条'], ['20', '20 条'], ['30', '30 条']], '成片条数');
    bindCfgSelect('#mxCfgRatio', 'ratio', [['9:16', '9:16 竖版'], ['16:9', '16:9 横版'], ['1:1', '1:1 方版']], '画面比例');
    bindCfgSelect('#mxCfgMotion', 'imgMotion', [['kenburns', 'Ken Burns 推拉摇移'], ['zoom', '缓慢放大'], ['pan', '左右平移'], ['none', '静态不动']], '图片运镜');
    bindCfgSelect('#mxCfgTrans', 'transition', [['smart', '智能（按节拍切）'], ['cut', '硬切'], ['fade', '淡入淡出'], ['slide', '滑动转场']], '转场方式');
  }

  function paintCfgExtra() {
    /* 把「AI 配音 + 字幕」行的说明换成真实能力状态，而不是承诺文案 */
    var cfgBody = q('#mxCfgBody');
    if (!cfgBody) { paintWfNote(); return; }
    var rows = qa('.set-row', cfgBody);
    if (rows && rows[1]) {
      var p = q('p', rows[1]);
      if (p) {
        var vs = voiceState();
        p.textContent = !renderUp() ? '需接入渲染服务后可用（当前未接入，页面会自动探测）'
          : !vs.known ? '正在检测本机语音能力…'
            : vs.ok ? '系统语音合成 · ' + vs.label + ' · 语速 1.1× · 字幕同步烧录'
              : '未接入：' + vs.detail + '（开启后成片将无配音，界面如实标注）';
      }
    }
    var note = q('#mxCfgNote');
    if (!note) return;
    var pool = pickPool();
    note.innerHTML =
      '当前规则预计产出：<b>' + estimateCount(pool) + ' 条</b> 成片 · 使用 <b>' + pool.length + '</b> 条素材 · 画布 <b>' +
      esc(RATIO_LABEL[MX.cfg.ratio] || MX.cfg.ratio) + '</b><br>' +
      '渲染通道：<b>' + (renderUp() ? '服务端渲染队列（真实 FFmpeg 合成）' : '未接入（自动剪辑需服务端，页面自动探测接入）') + '</b> · ' +
      '素材存储：<b>' + (liveCloud() ? '云端持久化' : '本地暂存') + '</b>';
  }

  function bindCfgSelect(sel, key, opts, label) {
    var el = q(sel);
    if (!el || el.dataset.mxBound) return;
    el.dataset.mxBound = '1';
    el.innerHTML = opts.map(function (o) {
      return '<option value="' + escA(o[0]) + '"' + (String(MX.cfg[key]) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('');
    el.addEventListener('change', function () {
      MX.cfg[key] = el.value;
      mxLog('info', '剪辑规则：' + label + ' → ' + el.options[el.selectedIndex].text);
      audit('剪辑规则变更', label + ' → ' + el.options[el.selectedIndex].text);
      paintCfgExtra(); saveCfg();
    });
  }

  /* ---------------- 10. 持久化 ---------------- */
  function saveRecordSafe(kind, title, meta) {
    var u = ui();
    if (fn(u, 'saveRecord')) { try { return u.saveRecord(kind, title, meta); } catch (e) {} }
    return null;
  }
  function saveMaterials() {
    if (!liveCloud()) return;
    var slim = MX.materials.map(function (m) {
      return { id: m.id, name: m.name, kind: m.kind, sid: m.sid || '', w: m.w, h: m.h, dur: m.dur, size: m.size, uses: m.uses, theme: m.theme };
    });
    saveRecordSafe('matrix_material', '素材库快照', { count: slim.length, items: slim.slice(0, 60) });
  }
  function saveOutputs() {
    if (!liveCloud()) return;
    var slim = MX.outputs.slice(0, 60).map(function (o) {
      return {
        id: o.id, title: o.title, du: o.du, ratio: o.ratio, shots: o.shots, mats: o.mats,
        srcName: o.srcName, pushed: o.pushed, ts: o.ts,
        rendered: !!o.rendered, videoUrl: o.videoUrl || '', coverUrl: o.coverUrl || '',
        width: o.width || 0, height: o.height || 0, bytes: o.bytes || 0, remoteId: o.remoteId || ''
      };
    });
    saveRecordSafe('matrix_output', '成片库快照', { count: slim.length, items: slim });
  }
  function saveCfg() {
    if (!liveCloud()) return;
    saveRecordSafe('matrix_cfg', '剪辑规则', JSON.parse(JSON.stringify(MX.cfg)));
    saveRecordSafe('matrix_wf', '剪辑工作流参数', JSON.parse(JSON.stringify(wfAll())));
  }
  function persistJob(job) {
    var c = getCloud();
    if (!c || !liveCloud()) return;
    try {
      c.database.from('content_tasks').insert({
        title: job.title, task_type: 'edit', status: job.status, progress: job.progress | 0, note: job.note
      }).select().then(function (r) {
        if (r && r.error) mxLog('warn', '任务落库失败：' + r.error.message);
      })['catch'](function (e) { mxLog('warn', '任务落库异常：' + ((e && e.message) || e)); });
    } catch (e) { mxLog('warn', '任务落库异常：' + ((e && e.message) || e)); }
  }

  function mxLoad() {
    var c = getCloud();
    if (!c || !liveCloud()) { mxLog('info', '演示 / 未部署状态：素材与成片仅保存在当前会话'); return; }
    try {
      c.database.from('app_records').select('*')
        .in('kind', ['matrix_material', 'matrix_output', 'matrix_cfg', 'matrix_wf'])
        .order('created_at', { ascending: false }).limit(30)
        .then(function (r) {
          if (!r || r.error || !Array.isArray(r.data)) return;
          var got = { mat: 0, out: 0, cfg: 0, wf: 0 };
          r.data.forEach(function (row) {
            var meta = row.meta || {};
            if (row.kind === 'matrix_cfg' && meta && !got.cfg) {
              ['dedupe', 'voice', 'coverTitle', 'cta', 'imgMotion', 'transition', 'ratio', 'count'].forEach(function (k) {
                if (meta[k] !== undefined) MX.cfg[k] = meta[k];
              });
              got.cfg = 1;
            }
            if (row.kind === 'matrix_wf' && meta && !got.wf) {
              got.wf = 1;
              var src = meta.wf || meta;
              Object.keys(WF_DEFAULT).forEach(function (k) { if (src[k]) MX.wf[k] = src[k]; });
              MX.cfg.count = '1';
              renderWorkflow();
              mxLog('info', '已从云端恢复七步工作流参数');
            }
            if (row.kind === 'matrix_material' && Array.isArray(meta.items) && !got.mat) {
              got.mat = 1;
              if (meta.items.length > MX.materials.length) {
                MX.materials = meta.items.map(function (m) {
                  return { id: m.id, name: m.name, kind: m.kind, url: m.url || '', sid: m.sid || '', w: m.w, h: m.h, dur: m.dur, uses: m.uses || 0, size: m.size || 0, theme: m.theme || 1, picked: false, ts: Date.now() };
                });
                renderMaterials();
                mxLog('ok', '已从云端恢复素材池 ' + MX.materials.length + ' 条');
                refreshSamples();   /* 恢复的种子素材重新绑定服务端示例图（sid 可能刚恢复回来） */
              }
            }
            if (row.kind === 'matrix_output' && Array.isArray(meta.items) && !got.out) {
              got.out = 1;
              if (meta.items.length > MX.outputs.length) {
                MX.outputs = meta.items;
                renderOutputs();
                mxLog('ok', '已从云端恢复成片 ' + MX.outputs.length + ' 条');
              }
            }
          });
        })['catch'](function () {});
    } catch (e) {}
  }

  /* ---------------- 11. 事件绑定 ---------------- */
  function bind() {
    var upBtn = q('#mxBtnUpload');
    if (upBtn) upBtn.addEventListener('click', function (e) { e.preventDefault(); mxUpload(); });
    var cutBtn = q('#mxBtnCut');
    if (cutBtn) cutBtn.addEventListener('click', function (e) { e.preventDefault(); mxCut(); });
    var runBtn = q('#mxBtnRun');
    if (runBtn) runBtn.addEventListener('click', function (e) { e.preventDefault(); mxCut(); });
    var rsBtn = q('#mxBtnReset');
    if (rsBtn) rsBtn.addEventListener('click', function (e) {
      e.preventDefault();
      wfReset(); syncCfgFromWf(); renderWorkflow(); saveCfg();
      mxLog('info', '工作流参数已恢复默认（7 步全部重置）');
      appToast('已恢复默认工作流参数', 'info', '已重置');
    });

    /* 工作流左栏：点步骤切换中间配置面板 */
    var flow = q('#mxFlow');
    if (flow) {
      flow.addEventListener('click', function (e) {
        var node = e.target.closest('[data-wf]');
        if (!node) return;
        MX.wfOpen = node.getAttribute('data-wf');
        renderWorkflow();
      });
      flow.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var node = e.target.closest && e.target.closest('[data-wf]');
        if (!node) return;
        e.preventDefault();
        MX.wfOpen = node.getAttribute('data-wf');
        renderWorkflow();
      });
    }

    /* 底部：上一步 / 下一步 */
    function wfJump(dir) {
      var keys = WF_STEPS.map(function (s) { return s.key; });
      var i = keys.indexOf(MX.wfOpen);
      var j = Math.max(0, Math.min(keys.length - 1, (i < 0 ? 0 : i) + dir));
      if (j === i) return;
      MX.wfOpen = keys[j];
      renderWorkflow();
    }
    var wfPrev = q('#wfPrevBtn'), wfNext = q('#wfNextBtn');
    if (wfPrev) wfPrev.addEventListener('click', function () { wfJump(-1); });
    if (wfNext) wfNext.addEventListener('click', function () { wfJump(1); });

    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-mx],[data-mxout],[data-mxjob],[data-del],.material');
      if (!t) return;
      var mx = t.getAttribute('data-mx');
      if (mx) {
        if (mx === 'upload') { mxUpload(); return; }
        if (mx === 'clearlog') { MX.logs = []; paintLog(); return; }
        if (mx === 'all') { MX.materials.forEach(function (m) { m.picked = true; }); renderMaterials(); mxLog('info', '已全选 ' + MX.materials.length + ' 条素材'); return; }
        if (mx === 'none') { MX.materials.forEach(function (m) { m.picked = false; }); renderMaterials(); mxLog('info', '已取消全部勾选'); return; }
        if (mx === 'del') {
          var picked = MX.materials.filter(function (m) { return m.picked; });
          if (!picked.length) { appToast('请先勾选要删除的素材', 'warn', '未选中', 2200); return; }
          appConfirm({
            title: '删除选中素材', html: '确认删除勾选的 <b>' + picked.length + '</b> 条素材？', okText: '删除',
            onOk: function () {
              MX.materials = MX.materials.filter(function (m) { return !m.picked; });
              renderMaterials(); saveMaterials();
              mxLog('warn', '已删除选中素材 ' + picked.length + ' 条');
              appToast('已删除 ' + picked.length + ' 条素材', 'warn', '已删除');
            }
          });
          return;
        }
      }
      var dd = t.getAttribute('data-del');
      if (dd) { e.stopPropagation(); delMaterial(dd); return; }
      var mo = t.getAttribute('data-mxout');
      if (mo) {
        var oid = t.getAttribute('data-oid');
        if (mo === 'prev') return previewOutput(findOut(oid));
        if (mo === 'push') return pushOutput(findOut(oid));
        if (mo === 'del') {
          var o = findOut(oid);
          return appConfirm({
            title: '删除成片', html: '确认删除「<b>' + esc(o ? o.title : '') + '</b>」？', okText: '删除',
            onOk: function () {
              MX.outputs = MX.outputs.filter(function (x) { return x.id !== oid; });
              renderOutputs(); saveOutputs();
              mxLog('warn', '已删除成片「' + (o ? o.title : '') + '」');
            }
          });
        }
        if (mo === 'pushall') return pushAll();
        if (mo === 'export') return exportOutputs();
        if (mo === 'clear') {
          return appConfirm({
            title: '清空成片', html: '确认清空全部 <b>' + MX.outputs.length + '</b> 条成片？发布排期不受影响。', okText: '清空',
            onOk: function () {
              var n = MX.outputs.length;
              MX.outputs = []; renderOutputs(); saveOutputs();
              mxLog('warn', '已清空成片 ' + n + ' 条');
            }
          });
        }
      }
      var mj = t.getAttribute('data-mxjob');
      if (mj === 'out') {
        var card = q('#mxOutCard');
        if (card) { try { card.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (er) {} }
        appToast('成片已列在「成片结果」区，可预览或推送发布', 'info', '成片已就绪', 2600);
        return;
      }
      if (mj === 'cancel') {
        e.stopPropagation();
        cancelJob(t.getAttribute('data-mxid'));
        return;
      }
      if (t.classList && t.classList.contains('material')) {
        var mid = t.getAttribute('data-mid');
        if (mid) togglePick(mid);
      }
    });

    /* 切到矩阵页时刷新一次（主题 / 通道标记） */
    var nav = q('.nav-item[data-view="v-matrix"]');
    if (nav && !nav.__mx) {
      nav.__mx = 1;
      nav.addEventListener('click', function () { setTimeout(refreshView, 90); });
    }

    /* 服务端地址变更（配置渲染服务）后立即刷新渲染通道标记，避免显示过期状态 */
    window.addEventListener('bff:changed', function () { setTimeout(refreshView, 120); });
    window.addEventListener('hashchange', function () {
      if (/#?v-matrix/.test(location.hash)) setTimeout(refreshView, 120);
    });
  }

  function refreshView() {
    syncCfgFromWf();
    renderWorkflow();
    renderTools(); renderCfg(); renderMaterials(); renderQueue(); renderOutputs(); renderSchedule();
    if (renderUp()) {
      mxLog('ok', '渲染通道已切换为「真实渲染」· 剪辑将上传素材到服务端 FFmpeg 合成可播放成片');
      refreshSamples();   /* 通道刚接通：示例素材此刻才能绑定服务端真实图片 */
    }
  }

  /* ---------------- 12. 启动 ---------------- */
  function boot() {
    seedAll();
    syncCfgFromWf();
    renderWorkflow();
    renderMaterials();
    renderQueue();
    renderOutputs();
    renderSchedule();
    renderCfg();
    paintLog();
    bind();
    /* 任务与流程条看门狗（5s 一次）：
       ① 任务长时间没有任何进度/阶段变化 → 如实判失败，避免无限「执行中」。
          上传/提交阶段（还没拿到服务端任务号）5 分钟；已提交渲染 8 分钟。
          旧逻辑只看任务状态，不看进度 —— 上传或提交静默挂起时永远等下去。
       ② 「执行中」只允许伴随真实 running/queued 的任务存在；任务都进终态了
          就清理流程条，任何遗漏的终态清理都会被这里兜住。 */
    setInterval(function () {
      var now = Date.now();
      MX.jobs.forEach(function (j) {
        if (j.status !== 'running' && j.status !== 'queued') return;
        var sig = (j.progress | 0) + '|' + (j.stage || '');
        if (j.__beatSig !== sig) { j.__beatSig = sig; j.__beatAt = now; return; }
        if (!j.__beatAt) { j.__beatAt = now; return; }
        var limit = j.remoteId ? 480000 : 300000;
        if (now - j.__beatAt <= limit) return;
        var mins = Math.round(limit / 60000);
        j.status = 'failed';
        j.errorText = '任务长时间无进展（' + mins + ' 分钟）';
        j.stage = '任务已挂起';
        j.note = '超过 ' + mins + ' 分钟没有任何进度或服务端回执，已停止等待（不产出假成片）。请确认服务端可用后重新发起。';
        MX.wfRun = null;
        renderQueue(); renderWorkflow(); persistJob(j);
        mxLog('err', '任务「' + j.title + '」超过 ' + mins + ' 分钟无进展，已判失败');
        appToast('渲染任务长时间无进展，已停止等待', 'err', '任务已挂起', 4200);
      });
      if (!MX.wfRun) return;
      var alive = MX.jobs.some(function (j) { return j.status === 'running' || j.status === 'queued'; });
      if (!alive) { MX.wfRun = null; renderWorkflow(); }
    }, 5000);
    refreshAbilities();   /* 拉取本地配音 / 字幕的真实可用状态（服务端可达时），界面据此如实显示 */
    refreshSamples();     /* 绑定服务端内置示例素材（渲染通道可用时，种子素材直接可真实渲染） */
    mxLog('info', 'AI智能剪辑增强层已就绪 · 素材池 ' + MX.materials.length + ' 条 · 成片 ' + MX.outputs.length + ' 条 · 存储通道 ' + (liveCloud() ? '云端' : '本地暂存'));
    setTimeout(mxLoad, 1500);
  }

  /* 供页面其它逻辑（新建排期）写入排期表 */
  function scheduleAdd(day, pf, time, mat) {
    var key = String(day || '').split('·')[0].trim();
    var i = -1;
    MX.schedule.forEach(function (d, ix) { if (d.d === key) i = ix; });
    if (i < 0) i = todayIdx();
    var shortMap = { douyin: '抖', kuaishou: '快', xhs: '红', sph: '视' };
    MX.schedule[i].chips.push({ pf: pf || 'douyin', t: shortMap[pf] || '抖', time: time || '待排', mat: mat || '' });
    renderSchedule();
    mxLog('info', '新建排期：' + key + ' ' + (time || '') + ' 发布到 ' + (shortMap[pf] || '抖音'));
    return true;
  }

  window.__MATRIX = {
    mx: MX, cut: mxCut, upload: mxUpload, load: mxLoad, scheduleAdd: scheduleAdd,
    simulate: function () {   /* 显式本地模拟入口（演示用）：正常剪辑一律走真实渲染通道 */
      var pool = pickPool();
      if (!pool.length) { appToast('素材池为空，无法演示', 'warn', '无法演示', 2400); return; }
      var hasImg = pool.some(function (m) { return m.kind === 'image'; });
      var job = { id: uid('j'), title: makeTitle(pool, hasImg) + '（演示）', status: 'running', progress: 0, total: estimateCount(pool), step: STEPS[0].t, mats: pool.map(function (m) { return m.id; }), created_at: new Date().toISOString() };
      MX.jobs.unshift(job); renderQueue();
      localSimulate(job, pool, hasImg);
    },
    render: function () {
      renderMaterials(); renderQueue(); renderOutputs(); renderSchedule(); renderCfg(); paintLog();
      refreshAbilities(); refreshSamples();
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

