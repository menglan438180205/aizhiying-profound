
/* =========================================================
   评论区获客 · 三栏控制台
   · 左：监控目标（关键词 / 博主 / 作品 / 同城）+ 意向词
   · 中：评论流（来源回链、意向分、命中词高亮）
   · 右：线索台账（跟进阶段流转）
   数据全部来自 /v1/collect/*，页面不写死任何数字。
   ========================================================= */
(function commentConsole() {
  'use strict';
  var API = window.Api;
  if (!API) { console.warn('[cc] Api 未就绪，控制台跳过初始化'); return; }

  /* 本机采集桥：二维码要弹在「使用者这台电脑」上，所以前端优先直连本机桥
     （http://127.0.0.1:8801）。连不上才回退到 BFF 转发 —— 那种情况下浏览器
     会弹在跑 BFF 的那台机器上，远程使用时看不到，UI 必须如实说清楚。 */
  var BRIDGE_URL = 'http://127.0.0.1:8801';
  var BRIDGE_TIP = 'tools\\mediacrawler-bridge\\start-local.cmd';

  var S = {
    tasks: [], feed: [], leads: [], notes: [], noteSource: '',
    comments: [], likes: [], cmtIdx: -1, cmtMode: 'manual', cmtDrafting: false, withLike: true,
    lastPoll: 0,
    notesShowAll: false, notesPage: 1, notesCleared: false, loginSession: null,
    loginPanel: null, qrTimer: null, pendingStart: '',
    accounts: [], accBusy: false, campaigns: [], campBusy: false, campAccSel: {},
    editAccId: '',
    exceptions: [], excCounts: {}, excBusy: false,
    campaignFilter: '', funnel: null, funnelErr: '',
    cmtPaused: false, cmtPending: 0,
    stats: {}, cfg: {}, chan: null,
    level: '', stage: '', taskId: '', view: 'notes',
    words: [], wordsOpen: false,
    bridge: { url: BRIDGE_URL, ok: false, host: '', at: 0, checking: false },
    device: null, pairCode: '', pairBusy: false, pairUrl: '',
    gateBusy: false, omniPf: 'douyin',
    timer: null, busy: false, started: false, retries: 0
  };
  var KEY_WORDS = 'aizy.cc.words';
  var KEY_CAMP = 'aizy.cc.campaign';
  var PF = { douyin: ['抖', '抖音'], kuaishou: ['快', '快手'], xhs: ['红', '小红书'], sph: ['视', '视频号'] };
  var TARGET_LABEL = { keyword: '关键词', author: '博主', video: '作品', region: '同城' };
  var LEVEL_LABEL = { high: '高意向', mid: '中意向', low: '低意向', noise: '噪音' };
  var STAGE_LABEL = { new: '待跟进', contacted: '已联系', wechat: '已加微', won: '已成交', lost: '无效' };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function ago(ts) {
    if (!ts) return '—';
    var t = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!t || isNaN(t)) return '—';
    var d = Date.now() - t;
    if (d < 0) return '刚刚';
    if (d < 60000) return Math.max(1, Math.round(d / 1000)) + ' 秒前';
    if (d < 3600000) return Math.round(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.round(d / 3600000) + ' 小时前';
    return Math.round(d / 86400000) + ' 天前';
  }
  function isToday(ts) {
    var t = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!t || isNaN(t)) return false;
    var a = new Date(t), b = new Date();
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function num(n) { return String(Math.round(Number(n) || 0)); }

  /* 命中词高亮：先转义再替换，避免评论文本里的尖括号注入 */
  function highlight(text, hits) {
    var out = esc(text);
    (hits || []).slice(0, 4).forEach(function (h) {
      if (!h || !h.word || h.weight <= 0) return;
      if (h.word === '疑问句' || h.word.length < 2) return;
      var w = esc(h.word);
      out = out.split(w).join('<mark>' + w + '</mark>');
    });
    return out;
  }

  function loadWords() {
    try {
      var raw = localStorage.getItem(KEY_WORDS);
      if (raw) { var arr = JSON.parse(raw); if (Array.isArray(arr)) return arr; }
    } catch (e) {}
    return ['多少钱', '报价', '怎么收费', '怎么联系', '加微信', '预算', '求推荐', '能上门', '加盟', '怎么合作'];
  }
  function saveWords() {
    try { localStorage.setItem(KEY_WORDS, JSON.stringify(S.words)); } catch (e) {}
  }

  /* ---------- 拉数据 ---------- */
  function get(path) { return API.call(path, null, { method: 'GET', timeout: 20000 }); }

  async function loadConfig() {
    var r = await get('/v1/collect/config');
    if (r && r.ok !== false && r.data) {
      S.cfg = r.data;
      S.tasks = (r.data.tasks && r.data.tasks.tasks) ? r.data.tasks.tasks : [];
      S.stats = (r.data.stats) || {};
      S.chan = r.data.upstream || null;
      S.accounts = Array.isArray(r.data.accounts) ? r.data.accounts : [];
    } else if (r && r.error) {
      showBar('err', '采集服务不可达', r.error);
      return;
    }
    /* config 返回的 tasks 可能是数组也可能在 stats 里，兜一层 */
    if (!S.tasks.length) {
      var t = await get('/v1/collect/tasks');
      if (t && t.data && Array.isArray(t.data.tasks)) S.tasks = t.data.tasks;
      if (t && t.data && t.data.stats) S.stats = t.data.stats;
    }
    /* 账号单独拉一次：config 里带的是快照，账号块要能独立刷新（探测后立刻见结果） */
    await loadAccounts();
    renderTargets();
    renderWords();
    renderChan();
    renderRunBar();
  }

  async function loadAccounts() {
    var r = await get('/v1/collect/accounts');
    if (r && r.data && Array.isArray(r.data.accounts)) S.accounts = r.data.accounts;
    renderAccounts();
    renderRunBar();
  }

  /* ---------- 异常队列：任务失败 + 评论失败，一个入口 ---------- */
  async function loadExceptions() {
    try {
      var r = await get('/v1/collect/exceptions?limit=80');
      S.exceptions = (r && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
      S.excCounts = (r && r.data && r.data.counts) || {};
    } catch (e) {
      S.exceptions = S.exceptions || [];
    }
    var cnt = $('ccExcCnt');
    if (cnt) cnt.textContent = String((S.excCounts && S.excCounts.total) || 0);
    renderExceptions();
  }

  function renderExceptions() {
    var box = $('ccExcList');
    var sub = $('ccExcSub');
    if (sub) sub.textContent = ((S.excCounts && S.excCounts.total) || 0) + ' 条 · 任务 '
      + ((S.excCounts && S.excCounts.task) || 0) + ' · 评论 ' + ((S.excCounts && S.excCounts.comment) || 0);
    if (!box) return;
    if (!S.exceptions.length) {
      box.innerHTML = '<div class="cc-exc-empty">没有待处理异常。登录墙、平台改版、评论失败都会收在这里。</div>';
      return;
    }
    box.innerHTML = S.exceptions.map(function (x, i) {
      return '<div class="cc-exc-item">' +
        '<span class="exc-type">' + (x.type === 'task' ? '任务' : '评论') + '</span>' +
        '<div class="exc-main">' +
          '<div class="exc-title">' + esc(x.title || '') + '</div>' +
          '<div class="exc-msg">' + esc((x.reason ? x.reason + ' · ' : '') + (x.message || '')) + '</div>' +
          '<div class="exc-msg">' + esc(ago(x.at)) + (x.platform ? ' · ' + esc(platLabel(x.platform)) : '') + '</div>' +
        '</div>' +
        '<button type="button" data-exc-i="' + i + '">重试</button>' +
      '</div>';
    }).join('');
  }

  async function openExceptions() {
    var mask = $('ccExcMask');
    if (mask) mask.style.display = 'flex';
    renderExceptions();
    await loadExceptions();
  }

  function closeExceptions() {
    var mask = $('ccExcMask');
    if (mask) mask.style.display = 'none';
  }

  async function clearExceptions() {
    if (S.excBusy) return;
    S.excBusy = true;
    var b = $('ccExcClear');
    if (b) { b.disabled = true; b.textContent = '清空中…'; }
    try {
      var r = await API.call('/v1/collect/exceptions/clear', {}, { timeout: 20000 });
      if (r && r.ok === false) {
        if (window.toast) toast(apiErr(r), 'err', '异常');
        return;
      }
      var d = r.data || {};
      S.exceptions = [];
      if (window.toast) toast('已清空异常：任务 ' + (d.tasks || 0) + ' · 评论 ' + (d.comments || 0), 'ok', '异常');
      await loadExceptions();
    } finally {
      S.excBusy = false;
      if (b) { b.disabled = false; b.textContent = '清空记录'; }
    }
  }

  async function retryException(item) {
    if (!item || S.excBusy) return;
    S.excBusy = true;
    try {
      var r = null;
      if (item.type === 'task') {
        r = await API.call('/v1/collect/tasks/' + encodeURIComponent(item.taskId) + '/run', {}, { timeout: 90000 });
      } else {
        r = await API.call('/v1/collect/comments/' + encodeURIComponent(item.noteKey) + '/retry', {}, { timeout: 30000 });
      }
      if (r && r.ok === false) {
        if (window.toast) toast(apiErr(r), 'err', '异常重试');
      } else if (window.toast) {
        toast('已重新排队', 'ok', '异常重试');
      }
      await loadExceptions();
      await loadComments();
    } finally {
      S.excBusy = false;
    }
  }

  async function loadCampaigns() {
    try {
      var r = await get('/v1/collect/campaigns');
      S.campaigns = (r && r.data && Array.isArray(r.data.campaigns)) ? r.data.campaigns : [];
      try {
        var saved = localStorage.getItem(KEY_CAMP) || '';
        if (saved === 'all') {
          S.campaignFilter = '';
        } else if (saved && S.campaigns.some(function (c) { return c.id === saved; })) {
          S.campaignFilter = saved;
        } else if (!saved) {
          /* 第一次打开：默认看最新一场进行中的战役，别把历史小红书作品混进来 */
          var running = S.campaigns.filter(function (c) { return c.status === 'running'; })[0];
          if (running) S.campaignFilter = running.id;
        }
      } catch (e) {}
    } catch (e) { S.campaigns = S.campaigns || []; }
    renderCampaigns();
  }

  function renderCampaigns() {
    var box = $('ccCampList');
    if (!box) return;
    var list = S.campaigns || [];
    if (!list.length) {
      box.innerHTML = '<div class="cc-camp-empty">还没有战役。填好上面的关键词、选平台，点「开始获客」。</div>';
      return;
    }
    box.innerHTML = list.map(function (c) {
      var running = c.status === 'running';
      var status = running ? '运行中' : (c.status === 'paused' ? '已暂停' : '草稿');
      var cls = running ? 'on' : (c.status === 'paused' ? 'pause' : '');
      var pfs = (c.platforms || []).map(function (p) { return (PF[p] || ['', p])[1]; }).join(' / ');
      var st = c.stats || {};
      var statsLine = '作品 ' + (st.works || 0) + ' · 高意向 ' + (st.high || 0)
        + ' · 评论 ' + (st.sent || 0) + '/' + (st.comments || 0)
        + (st.failed ? ' · 失败 ' + st.failed : '')
        + (st.taskFailed ? ' · 任务失败 ' + st.taskFailed : (st.lastRunStatus === 'failed' ? ' · 最近任务失败' : ''))
        + (st.lastRunStatus === 'skipped'
          ? ' · 任务跳过' + (st.lastRunReason === 'ACCOUNT_QUOTA' ? '（账号采集额度）' : (st.lastRunReason ? '（' + esc(st.lastRunReason) + '）' : ''))
          : '');
      return '<div class="cc-camp-item">' +
        '<div class="cc-camp-hd"><b>' + esc(c.name || '未命名战役') + '</b><span class="cc-camp-st ' + cls + '">' + status + '</span></div>' +
        '<div class="cc-camp-meta">' + esc(pfs) + ' · ' + (c.keywords || []).length + ' 个关键词 · ' + ((c.taskIds || []).length) + ' 条任务</div>' +
        '<div class="cc-camp-meta cc-camp-stats" title="' + esc(st.lastRunNote || '') + '">' + statsLine + '</div>' +
        '<div class="cc-camp-acts">' +
          (running
            ? '<button type="button" data-camp-act="pause" data-camp-id="' + esc(c.id) + '">暂停</button>'
            : '<button type="button" data-camp-act="start" data-camp-id="' + esc(c.id) + '">' + (c.status === 'paused' ? '继续' : '开始') + '</button>') +
          ((st.works || 0) > 0 ? '<button type="button" class="primary" data-camp-act="engage" data-camp-id="' + esc(c.id) + '">生成触达任务</button>' : '') +
          ((st.failed || 0) > 0 ? '<button type="button" data-camp-act="retry" data-camp-id="' + esc(c.id) + '">重试失败</button>' : '') +
          '<button type="button" class="danger" data-camp-act="delete" data-camp-id="' + esc(c.id) + '">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-camp-act]'), function (el) {
      el.addEventListener('click', function () {
        campaignAct(el.getAttribute('data-camp-id'), el.getAttribute('data-camp-act'));
      });
    });
    renderCampaignFilter();
  }

  function renderCampaignFilter() {
    var sel = $('ccCampFilter');
    if (!sel) return;
    var cur = S.campaignFilter || '';
    sel.innerHTML = '<option value="">全部战役</option>' + (S.campaigns || []).map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.name || '未命名战役') + '</option>';
    }).join('');
    sel.value = cur;
    if (sel.value !== cur) {
      S.campaignFilter = '';
      try { localStorage.setItem(KEY_CAMP, 'all'); } catch (e) {}
    }
  }

  async function campaignAct(id, act) {
    if (S.campBusy) return;
    if (act === 'delete') {
      if (!window.confirm('删除这场战役及它拆出来的任务？历史作品和线索会保留。')) return;
      S.campBusy = true;
      try {
        var d = await API.call('/v1/collect/campaigns/' + encodeURIComponent(id), null, { method: 'DELETE', timeout: 20000 });
        if (d && d.ok === false) {
          if (window.toast) toast(apiErr(d), 'err', '战役');
          return;
        }
        if (window.toast) toast('战役和任务已删除', 'ok', '战役');
        await loadCampaigns();
        await loadConfig();
      } finally {
        S.campBusy = false;
      }
      return;
    }
    if ((act === 'start' || act === 'engage') && !devReady()) {
      if (window.toast) toast('先启动本机桥并连接扩展，再开始战役/触达', 'warn', '战役');
      return;
    }
    S.campBusy = true;
    try {
      var action = act === 'pause' ? 'pause' : (act === 'resume' ? 'resume' : act);
      var r = await API.call('/v1/collect/campaigns/' + encodeURIComponent(id) + '/' + action, {}, { timeout: 60000 });
      if (r && r.ok === false) {
        if (window.toast) toast(apiErr(r), 'err', '战役');
        return;
      }
      if (act === 'start') {
        var d = (r && r.data) || {};
        var n = (d.result && (d.result.created + d.result.reused)) || 0;
        var sp = (d.result && d.result.skippedPlatforms) || [];
        var spText = sp.length ? '；跳过 ' + sp.map(function (pf) { return (PF[pf] || ['', pf])[1]; }).join(' / ') + '（无已登录账号）' : '';
        if (window.toast) toast('战役已开始：' + n + ' 条任务' + spText, sp.length ? 'warn' : 'ok', '战役');
        if (d.campaign && d.campaign.id) {
          S.campaignFilter = d.campaign.id;
          try { localStorage.setItem(KEY_CAMP, S.campaignFilter); } catch (e) {}
          S.notesPage = 1;
          renderCampaignFilter();
          await loadNotes();
          await loadLeads();
          await loadFunnel();
        }
      } else if (act === 'engage') {
        var q = (r.data && r.data.result && r.data.result.queued) || [];
        var sk = (r.data && r.data.result && r.data.result.skipped) || [];
        if (window.toast) toast('已生成触达任务：' + q.length + ' 条' + (sk.length ? '，跳过 ' + sk.length + ' 条' : ''), q.length ? 'ok' : 'warn', '触达');
        await loadComments();
      } else if (act === 'retry') {
        var rr = (r.data && r.data.result) || {};
        if (window.toast) toast('已重试 ' + (rr.retried || 0) + ' 条' + (rr.skipped ? '，跳过 ' + rr.skipped : ''), 'ok', '异常');
        await loadComments();
      }
      await loadCampaigns();
      await loadConfig();
    } finally {
      S.campBusy = false;
    }
  }

  async function saveCampaign() {
    if (S.campBusy) return;
    var kwText = ($('ccCampKeywords') || {}).value || '';
    var keywords = kwText.split(/[\n,，、;；]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!keywords.length) {
      if (window.toast) toast('先填至少一个关键词', 'warn', '战役');
      return;
    }
    var platforms = [];
    Array.prototype.forEach.call(document.querySelectorAll('#ccCampPlats input:checked'), function (el) {
      platforms.push(el.value);
    });
    if (!platforms.length) {
      if (window.toast) toast('至少选一个平台', 'warn', '战役');
      return;
    }
    var industry = String(($('ccCampIndustry') || {}).value || '').trim();
    var name = String(($('ccCampName') || {}).value || '').trim()
      || ((industry ? industry + ' · ' : '') + keywords[0]);
    var accountIds = {};
    platforms.forEach(function (pf) {
      var el = $('ccCampAcc_' + pf);
      var id = el ? el.value : (S.campAccSel[pf] || '');
      if (id) { accountIds[pf] = id; S.campAccSel[pf] = id; }
    });
    var body = {
      name: name, industry: industry,
      city: String(($('ccCampCity') || {}).value || '').trim(),
      keywords: keywords,
      competitors: String(($('ccCampCompetitors') || {}).value || '').split(/[\n,，、;；]+/).map(function (s) { return s.trim(); }).filter(Boolean),
      platforms: platforms,
      accountIds: accountIds,
      dailyLimit: Number(($('ccCampDaily') || {}).value || 40),
      intentWords: S.words,
      every: '1h'
    };
    var btn = $('ccCampStart');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    try {
      var r = await API.call('/v1/collect/campaigns', body, { timeout: 30000 });
      if (!r || r.ok === false) {
        if (window.toast) toast((r && (r.error || r.message)) || '保存战役失败', 'err', '战役');
        return;
      }
      var c = (r.data && r.data.campaign) || null;
      await loadCampaigns();
      if (!devReady()) {
        if (window.toast) toast('战役已保存；启动本机桥/扩展后，在下面点「开始」', 'warn', '战役');
        return;
      }
      if (c && c.id) await campaignAct(c.id, 'start');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '开始获客'; }
    }
  }

  /* ---------- 本机采集桥：二维码弹在「这台电脑」上 ---------- */
  /** 探一次本机桥；silent=true 时不弹提示（页面加载/轮询用） */
  async function probeBridge(silent) {
    if (S.bridge.checking) return S.bridge.ok;
    /* 失败退避：本机桥没装时，6 秒一次的探测会在控制台刷满 ERR_CONNECTION_REFUSED。
       静默轮询按 8s→16s→32s→60s 退避；用户手动点「重新检测」立即重试。 */
    if (silent && S.bridge.nextAt && Date.now() < S.bridge.nextAt) return false;
    S.bridge.checking = true;
    var ok = false, host = '', info = null;
    try {
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var to = ctrl ? setTimeout(function () { ctrl.abort(); }, 1500) : 0;
      var res = await fetch(BRIDGE_URL + '/v1/ping', {
        method: 'GET', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined
      });
      if (to) clearTimeout(to);
      if (res && res.ok) {
        info = await res.json().catch(function () { return null; });
        if (info && info.ok) { ok = true; host = info.host || ''; }
      }
    } catch (e) { ok = false; }
    S.bridge.checking = false;
    S.bridge.ok = ok;
    S.bridge.host = host;
    S.bridge.info = info;
    S.bridge.at = Date.now();
    if (ok) {
      S.bridge.fail = 0;
      S.bridge.nextAt = 0;
    } else {
      S.bridge.fail = (S.bridge.fail || 0) + 1;
      S.bridge.nextAt = Date.now() + Math.min(60000, 8000 * Math.pow(2, S.bridge.fail - 1));
    }
    renderBridge();
    if (!silent && !ok && window.toast) {
      toast('本机采集桥没启动：双击项目里的 ' + BRIDGE_TIP + '，窗口留着别关', 'warn', '扫码登录');
    }
    return ok;
  }

  function renderBridge() {
    var box = $('ccBridge');
    if (!box) return;
    var online = !!(S.device && (S.device.bridge || S.device.online > 0));
    if (online) {
      box.innerHTML = '<span class="cc-dot ok"></span>' +
        '<span>登录二维码会显示在中间栏（<b>' + esc((S.device && (S.device.device || S.device.host)) || '本机') + '</b> 的浏览器里也能扫）</span>' +
        '<button type="button" data-bridge="recheck">重新检测</button>';
    } else {
      box.innerHTML = '<span class="cc-dot idle"></span>' +
        '<span>本机桥未连接 · 需要先启动本机桥并配对</span>' +
        '<button type="button" data-bridge="how">怎么启动</button>';
    }
  }

  /* ---------- 中间栏扫码登录卡 ---------- */
  function pfLabel(pf) { return (PF[pf] || ['', pf])[1]; }

  function stopQrRefresh() {
    if (S.qrTimer) { clearInterval(S.qrTimer); S.qrTimer = null; }
  }

  function paintQrData(dataUrl) {
    var img = $('ccLoginQr');
    if (!img) return;
    var box = $('ccLoginQrBox');
    var ph = $('ccLoginQrPh');
    if (!dataUrl) {
      if (box) box.classList.remove('has');
      img.style.display = 'none';
      if (ph) { ph.style.display = 'block'; ph.textContent = '二维码还没出来，稍等…'; }
      return;
    }
    img.onload = function () {
      if (box) box.classList.add('has');
      if (ph) ph.style.display = 'none';
      img.style.display = 'block';
    };
    img.onerror = function () {
      if (box) box.classList.remove('has');
      img.style.display = 'none';
      if (ph) { ph.style.display = 'block'; ph.textContent = '二维码解析失败，可扫本机浏览器窗口'; }
    };
    if (img.getAttribute('src') === dataUrl && img.complete && img.naturalWidth > 0) {
      img.onload();
      return;
    }
    img.src = dataUrl;
  }

  function startQrRefresh() {
    stopQrRefresh();
    var panel = S.loginPanel;
    if (panel && panel.qrData) {
      paintQrData(panel.qrData);
      return;
    }
    var img = $('ccLoginQr');
    if (img) { img.style.display = 'none'; img.removeAttribute('src'); }
    var box = $('ccLoginQrBox');
    if (box) box.classList.remove('has');
    var ph = $('ccLoginQrPh');
    if (ph) { ph.style.display = 'block'; ph.textContent = '正在通知本机桥…'; }
  }

  function showLoginCard(a) {
    var box = $('ccLogin');
    if (!box) return;
    S.loginPanel = { accId: a.id, platform: a.platform, status: 'starting', loginId: '', qrData: '' };
    box.style.display = 'flex';
    box.innerHTML =
      '<div class="cc-login-qr" id="ccLoginQrBox">' +
        '<div class="ph" id="ccLoginQrPh">正在打开平台登录页…</div>' +
        '<img id="ccLoginQr" alt="扫码登录二维码">' +
      '</div>' +
      '<div class="cc-login-main">' +
        '<div class="cc-login-hd"><b>扫码登录</b>' +
          '<span class="pf">' + esc(pfLabel(a.platform)) + '</span>' +
          '<span class="cc-login-st" id="ccLoginSt"><span class="dot"></span><span id="ccLoginStTxt">启动中…</span></span>' +
        '</div>' +
        '<div class="cc-login-msg" id="ccLoginMsg">用「' + esc(pfLabel(a.platform)) + '」App 扫一扫。登录态会保存在这台电脑，下次不用再扫。</div>' +
        '<div class="cc-login-acts">' +
          '<button type="button" id="ccLoginCancel">取消登录</button>' +
          '<button type="button" id="ccLoginRetry" style="display:none">重新检测</button>' +
        '</div>' +
      '</div>';
    var c = $('ccLoginCancel');
    if (c) c.onclick = function () { cancelLogin(a.id); };
    var r = $('ccLoginRetry');
    if (r) r.onclick = function () { qrLogin(a.id, true); };
    startQrRefresh();
    try { box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
  }

  function paintLogin(status, msg) {
    if (S.loginPanel) { S.loginPanel.status = status; S.loginPanel.message = msg || ''; }
    var st = $('ccLoginSt');
    var txt = $('ccLoginStTxt');
    var m = $('ccLoginMsg');
    var retry = $('ccLoginRetry');
    var label = status === 'ok' ? '登录成功'
      : status === 'failed' ? '登录失败'
      : status === 'timeout' ? '等待超时'
      : status === 'canceled' ? '已取消'
      : '等待扫码…';
    if (txt) txt.textContent = label;
    if (st) st.className = 'cc-login-st' + (status === 'ok' ? ' ok' : (status === 'failed' || status === 'timeout' ? ' err' : ''));
    if (m && msg) m.textContent = msg;
    if (retry) retry.style.display = (status === 'failed' || status === 'timeout') ? 'inline-block' : 'none';
  }

  function hideLoginCard() {
    stopQrRefresh();
    var box = $('ccLogin');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
    S.loginPanel = null;
  }

  async function cancelLogin(id) {
    stopLoginPoll();
    S.pendingStart = '';
    var loginId = S.loginPanel && S.loginPanel.loginId;
    if (loginId) {
      try { await API.call('/v1/collect/login/' + encodeURIComponent(loginId) + '/cancel', {}, { timeout: 10000 }); } catch (e) {}
    }
    if (S.loginSession && S.loginSession.accId === id) {
      S.loginSession.status = 'canceled';
      S.loginSession.message = '已取消登录';
    }
    paintLogin('canceled', '已取消本次扫码');
    renderAccounts();
    setTimeout(hideLoginCard, 900);
  }

  function resumePending() {
    if (!S.pendingStart) return;
    var text = S.pendingStart;
    S.pendingStart = '';
    var inp = $('ccOmni');
    if (inp) inp.value = text;
    setTimeout(function () { startFromOmni(); }, 300);
  }

  /** 给当前平台找一个账号；没有就自动建一个，然后在本机桥里开登录 */
  async function ensureAccountLogin(pf, opts) {
    opts = opts || {};
    var a = S.accounts.filter(function (x) { return x.platform === pf && x.status === 'active'; })[0]
      || S.accounts.filter(function (x) { return x.platform === pf; })[0];
    if (a && a.status === 'active' && a.profileDir && !opts.force) {
      if (window.toast) toast(pfLabel(pf) + ' 已登录，可直接开始获客', 'ok', '扫码登录');
      return a;
    }
    if (!a) {
      var r = await API.call('/v1/collect/accounts', {
        platform: pf, nickname: pfLabel(pf) + ' 账号', quotaPerHour: 30
      }, { timeout: 20000 });
      var code = (r && (r.code || (r.json && r.json.code))) || '';
      if (r && r.ok === false && code !== 'ACCOUNT_EXISTS') {
        if (window.toast) toast(r.error || r.message || '创建账号失败', 'err', '扫码登录');
        return null;
      }
      await loadAccounts();
      a = S.accounts.filter(function (x) { return x.platform === pf; })[0];
    }
    if (!a) {
      if (window.toast) toast('没有可用的' + pfLabel(pf) + '账号', 'err', '扫码登录');
      return null;
    }
    qrLogin(a.id, !!opts.force);
    return a;
  }

  /* ---------- 浏览器采集器：抓取跑在「使用者自己的浏览器」里 ---------- */
  /** 同时问两边：本机桥（扩展在不在）与云端（设备配对/在线）。两边都绿才算就绪。 */
  async function probeDevice() {
    /* 与 probeBridge 同一套退避：桥不在时不再每 6 秒打一次 /v1/bridge/status */
    if (S.devNextAt && Date.now() < S.devNextAt) return S.device;
    var local = null, cloud = null;
    /* 连续两次确认桥没起：不再请求本机地址（否则每次都在控制台留 ERR_CONNECTION_REFUSED），
       只查云端设备状态；用户点「重新检测」会把 fail 清零后重新探测。 */
    var skipLocal = !S.bridge.ok && (S.bridge.fail || 0) >= 2;
    try {
      if (skipLocal) throw new Error('bridge_down');
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var to = ctrl ? setTimeout(function () { ctrl.abort(); }, 1600) : 0;
      var res = await fetch(BRIDGE_URL + '/v1/bridge/status', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      if (to) clearTimeout(to);
      if (res && res.ok) local = await res.json().catch(function () { return null; });
    } catch (e) { local = null; }
    try {
      var c = await get('/v1/device/status');
      cloud = (c && c.data) || null;
    } catch (e) { cloud = null; }
    var hub = (cloud && cloud.hub) || {};
    /* 两台设备时优先取在线那台，别拿旧 1.3.0 的版本/平台误导页面 */
    var hubDev = (hub.devices || []).filter(function (d) { return d && d.online; })[0]
      || (hub.devices || [])[0] || {};
    S.device = {
      bridge: !!local,
      host: (local && local.host) || hubDev.host || '',
      device: (local && local.device && local.device.name) || hubDev.name || '',
      cloud: (local && local.cloud) || '',
      paired: !!(local && local.paired) || !!hub.paired,
      plugin: !!(local && local.plugin && local.plugin.online) || !!hub.plugin,
      online: Number(hub.online || 0),
      queued: (local && local.plugin && local.plugin.queued) || 0,
      today: hub.today || null,
      platforms: hubDev.platforms || [],
      version: hubDev.version || '',
      jobs: Number(hub.pending || 0),
      at: Date.now()
    };
    renderDevice();
    renderBridge();
    renderRunBar();
    /* HTTPS 页面 fetch 本机 http 地址会被浏览器拦，local 永远是 null；
       只要云端说设备在线，就不该按“本机探测失败”退避 60 秒，否则页面会假离线。 */
    if (local || Number(hub.online || 0) > 0 || hub.plugin) {
      S.devFail = 0;
      S.devNextAt = 0;
    } else {
      S.devFail = (S.devFail || 0) + 1;
      S.devNextAt = Date.now() + Math.min(60000, 8000 * Math.pow(2, S.devFail - 1));
    }
    return S.device;
  }

  function devReady() {
    return !!(S.device && S.device.paired && (S.device.plugin || S.device.online > 0));
  }

  function renderDevChip(d) {
    var state = $('ccDevState'), btn = $('ccBtnBridgeStart'), hint = $('ccDevHint');
    if (!state) return;
    var text = '○ 未连接', color = 'var(--text-3)', btnText = '启动并连接', hintText = '首次使用先点「启动并连接」；没反应就点「安装/说明」。';
    if (d && d.plugin && d.online > 0 && d.version && d.version !== '1.3.8') {
      text = '● 扩展 ' + d.version + ' 过旧'; color = 'var(--amber)'; btnText = '重新检测';
      hintText = '刷新扩展到 1.3.8；如果 Chrome 里还有旧版扩展，先停用它。';
    } else if (d && d.plugin && d.online > 0) {
      text = '● 在线'; color = 'var(--green)'; btnText = '已在线 · 重新检测';
      hintText = '任务会由你本机的 Chrome 执行。';
    } else if (d && d.paired && d.online > 0) {
      text = '● 扩展未连接'; color = 'var(--amber)'; btnText = '检测扩展';
      hintText = '本机桥在线，但 Chrome 扩展没连上；刷新扩展 1.3.8。';
    } else if (d && d.paired) {
      text = '● 离线'; color = 'var(--amber)'; btnText = '启动并重连';
      hintText = '本机桥窗口可能关了；点「启动并重连」。';
    }
    state.textContent = text;
    state.style.color = color;
    if (btn) btn.textContent = btnText;
    if (hint) {
      if (S.pairUrl && !(d && d.plugin && d.online > 0)) {
        hint.innerHTML = '没自动打开配对页？<a href="' + esc(S.pairUrl) + '" target="_blank" rel="noopener">点这里完成配对</a>';
      } else {
        hint.textContent = hintText;
      }
    }
  }

  function launchBridgeProtocol() {
    try {
      var a = document.createElement('a');
      a.href = 'aizhiying://start';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { a.remove(); } catch (e) {} }, 1200);
    } catch (e) {}
  }

  function renderDevice() {
    var box = $('ccDev'), sub = $('ccDevSub'), btn = $('ccBtnPair');
    var d = S.device || {};
    renderDevChip(d);
    if (!box) return;
    var html = '';
    if (!d.bridge && !(d.online > 0) && !d.paired) {
      var httpsPage = location.protocol === 'https:';
      if (sub) sub.textContent = httpsPage ? '本机桥未配对' : '本机桥未启动';
      html = '<div class="row"><span class="dot warn"></span><b>' +
        (httpsPage ? '本机桥还没连上云端' : '本机桥没启动') + '</b></div>' +
        '<div class="tip">双击项目里的 <b>tools/mediacrawler-bridge/start-local.cmd</b>，黑窗口留着别关，然后点下面「连接」配对。</div>' +
        '<div class="acts"><button type="button" data-dev="pair">连接</button></div>';
    } else if (!d.paired) {
      if (sub) sub.textContent = '未配对';
      html = '<div class="row"><span class="dot on"></span><b>本机桥在线</b><span>· ' + esc(d.host || '') + '</span></div>' +
        '<div class="row"><span class="dot"></span>还没和云端配对</div>' +
        (S.pairCode
          ? '<div class="code"><b>' + esc(S.pairCode) + '</b><span>把上面的码交给本机桥（已在自动提交）</span></div>'
          : '<div class="tip">点「连接」会自动配对，不需要复制任何令牌。</div>') +
        (S.pairUrl ? '<div class="tip">没自动打开配对页？<a href="' + esc(S.pairUrl) + '" target="_blank" rel="noopener">点这里完成配对</a></div>' : '') +
        '<div class="acts"><button type="button" data-dev="pair">连接本机采集器</button></div>';
    } else if (!(d.online > 0) && !d.plugin) {
      if (sub) sub.textContent = '本机桥离线';
      html = '<div class="row"><span class="dot warn"></span><b>已配对，但本机桥离线</b></div>' +
        '<div class="tip">双击项目里的 <b>tools/mediacrawler-bridge/start-local.cmd</b>，黑窗口留着别关；启动后如果这里仍显示离线，点「重新连接」重新配对。</div>' +
        (S.pairUrl ? '<div class="tip">没自动打开配对页？<a href="' + esc(S.pairUrl) + '" target="_blank" rel="noopener">点这里完成配对</a></div>' : '') +
        '<div class="acts"><button type="button" data-dev="pair">重新连接</button></div>';
    } else if (!d.plugin) {
      if (sub) sub.textContent = '等待扩展';
      html = '<div class="row"><span class="dot on"></span><b>已配对</b><span>· ' + esc(d.device || d.host || '本机') + '</span></div>' +
        '<div class="row"><span class="dot warn"></span>浏览器扩展没连上</div>' +
        '<div class="tip">Chrome 打开 <b>chrome://extensions</b> → 右上「开发者模式」→「加载已解压的扩展程序」→ 选 <b>tools/browser-collector</b>。装好后这里会自动变绿。</div>' +
        '<div class="acts"><button type="button" data-dev="check">检测扩展</button></div>';
    } else {
      var t = d.today || {};
      var plats = Array.isArray(d.platforms) ? d.platforms : [];
      if (sub) sub.textContent = '已连接';
      html = '<div class="row"><span class="dot on"></span><b>采集器已连接</b><span>· ' + esc(d.device || d.host || '本机') + '</span></div>' +
        '<div class="row"><span class="dot on"></span>' +
          (plats.length ? '登录态：' + plats.map(function (p) { return (PF[p] || ['', p])[1] + ' ✓'; }).join(' · ') : '用这个 Chrome 的登录态读页面') +
        '</div>' +
        '<div class="row"><span class="dot ' + ((t.comments || 0) > 0 ? 'on' : '') + '"></span>近 24 小时：作品 <b>' + (t.notes || 0) + '</b> · 评论 <b>' + (t.comments || 0) + '</b></div>' +
        (d.queued ? '<div class="row"><span class="dot warn"></span>执行中：' + d.queued + ' 个任务</div>' : '') +
        '<div class="tip">保持这个 Chrome 打开即可。任务来了会在后台标签页自动打开搜索页读数据，读完自动关掉。</div>' +
        '<div class="acts"><button type="button" data-dev="unpair">解除配对</button></div>';
    }
    box.innerHTML = html;
    /* 顶部的「连接」是旧入口，和卡片里的按钮重复；统一收进卡片 */
    if (btn) btn.style.display = 'none';
    /* 采集器上下线直接决定「能不能开跑」，运行条跟着变 */
    renderRunBar();
    Array.prototype.forEach.call(box.querySelectorAll('[data-dev]'), function (el) {
      el.addEventListener('click', function () {
        var act = el.getAttribute('data-dev');
        if (act === 'check') {
          S.devNextAt = 0;
          probeDevice().then(function (x) {
            if (window.toast) toast(x.plugin ? '采集器在线' : (x.bridge ? '本机桥在线，等扩展连上' : '本机桥没启动'), x.plugin ? 'ok' : 'warn', '采集器');
          });
        }
        if (act === 'pair') pairDevice();
        if (act === 'how') showDevHow();
        if (act === 'unpair') unpairDevice();
      });
    });
  }

  /** 一键配对：页面取码 → 本机桥换设备令牌。HTTPS 页面用顶层窗口打开本机桥配对页。 */
  async function pairDevice() {
    if (S.pairBusy) return;
    S.pairBusy = true;
    try {
      var d = await probeDevice();
      if (d.paired && d.online > 0 && d.plugin) {
        if (window.toast) toast('本机采集器已经配对过了', 'info', '采集器');
        return;
      }
      var r = await API.call('/v1/device/pair', {}, { timeout: 15000 });
      if (!r || r.ok === false) {
        if (window.toast) toast((r && r.message) || '取配对码失败', 'err', '采集器');
        return;
      }
      var code = (r.data && r.data.pair && r.data.pair.code) || '';
      S.pairCode = code;
      renderDevice();
      var ok = false;
      /* 本地直接 POST：只有本机页面（http://127.0.0.1）能这么做 */
      if (d.bridge) {
        try {
          var res = await fetch(BRIDGE_URL + '/v1/pair', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: code, cloud: location.origin })
          });
          var j = await res.json().catch(function () { return null; });
          if (j && j.ok) ok = true;
        } catch (e) { /* 转顶层窗口 */ }
      }
      /* HTTPS 页面不能 fetch localhost，但可以顶层打开本机桥的配对页 */
      if (!ok) {
        var cloud = (API && typeof API.base === 'function' && API.base()) || location.origin;
        var url = BRIDGE_URL + '/v1/pair?code=' + encodeURIComponent(code) + '&cloud=' + encodeURIComponent(cloud);
        S.pairUrl = url;
        renderDevice();
        var w = null;
        try { w = window.open(url, '_blank'); } catch (e) { w = null; }
        if (!w) {
          var hint = $('ccDevHint');
          if (hint) {
            hint.innerHTML = '浏览器拦了新窗口：<a href="' + esc(url) + '" target="_blank" rel="noopener">点这里完成配对</a>';
          }
          if (window.toast) toast('浏览器拦了新窗口：点左栏「点这里完成配对」', 'warn', '采集器');
        } else {
          if (window.toast) toast('已打开本机桥配对页，配对完成后回来会自动检测', 'info', '采集器');
        }
        for (var i = 0; i < 8 && !ok; i++) {
          await new Promise(function (resolve) { setTimeout(resolve, 1500); });
          var p = await probeDevice();
          if (p && p.online > 0) ok = true;
        }
      }
      if (ok) {
        S.pairCode = '';
        S.pairUrl = '';
        if (window.toast) toast('配对成功：本机采集器已连上云端', 'ok', '采集器');
        await probeDevice();
      } else if (window.toast) {
        toast('还没配对成功：确认本机桥黑窗口开着，再点一次「连接」', 'warn', '采集器');
      }
    } catch (e) {
      if (window.toast) toast('配对失败：' + ((e && e.message) || e), 'err', '采集器');
    } finally {
      S.pairBusy = false;
    }
  }

  async function unpairDevice() {
    var d = S.device || {};
    if (!d.paired) return;
    var r = await get('/v1/device/status');
    var dev = (r && r.data && r.data.hub && r.data.hub.devices && r.data.hub.devices[0]) || null;
    if (!dev) { if (window.toast) toast('云端没有这台采集器的记录', 'warn', '采集器'); return; }
    await API.call('/v1/device/unpair', { id: dev.id }, { timeout: 12000 });
    if (window.toast) toast('已解除配对，本机桥需要重新连接', 'ok', '采集器');
    probeDevice();
  }

  function showDevHow() {
    if (!window.toast) return;
    var d = S.device || {};
    if (!d.bridge) toast('① 双击 tools\\mediacrawler-bridge\\start-local.cmd ② 回页面点连接', 'info', '采集器');
    else if (d.paired) toast('chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → tools/browser-collector', 'info', '采集器');
    else toast('点「连接本机采集器」会自动配对，不用填令牌', 'info', '采集器');
  }

  /* ---------- 运行条：建目标即开跑，这里只报状态 + 一个「再扫一轮」 ---------- */
  function runningTasks() {
    return S.tasks.filter(function (t) { return t.enabled !== false; });
  }

  function renderRunBar() {
    var box = $('ccRunTxt'), btn = $('ccBtnRescan');
    if (!box) return;
    var run = runningTasks();
    var st = S.stats || {};
    var lastScan = st.lastScanAt ? ago(st.lastScanAt) : '还没跑过';
    var miss = [];
    if (!devReady()) miss.push('连接浏览器采集器');
    if (!run.length) miss.push('输入一句话开始获客');
    box.innerHTML = miss.length
      ? '<span class="miss">还差：' + esc(miss.join('；')) + '</span>'
      : '<span class="ok">' + run.length + ' 个目标在跑</span> · 上次扫描 ' + esc(lastScan);
    if (btn) {
      btn.disabled = !run.length || !!S.gateBusy;
      btn.textContent = S.gateBusy ? '扫描中…' : '立即再扫一轮';
    }
  }

  /* 平台胶囊：默认抖音，粘贴链接时自动切；用户也能手动点 */
  function setOmniPlatform(pf, silent) {
    if (!PF[pf]) return;
    S.omniPf = pf;
    var box = $('ccPlats');
    if (box) Array.prototype.forEach.call(box.querySelectorAll('[data-pf]'), function (el) {
      el.className = 'cc-plat' + (el.getAttribute('data-pf') === pf ? ' on' : '');
    });
    if (!silent) {
      var hint = $('ccOmniHint');
      if (hint && !($('ccOmni') || {}).value) hint.textContent = '当前平台：' + (PF[pf] || ['', pf])[1] + ' · 默认每小时一轮';
    }
  }

  /* 一句话识别：链接 → 按域名定平台、按路径定类型；纯文字 → 关键词 */
  function detectTarget(text) {
    var pf = S.omniPf || 'douyin';
    var type = 'keyword';
    var t = String(text || '').trim();
    if (/^https?:\/\//i.test(t) || /xhslink\.com|v\.douyin\.com/i.test(t)) {
      var u = t.toLowerCase();
      if (u.indexOf('xiaohongshu') > -1 || u.indexOf('xhslink') > -1) pf = 'xhs';
      else if (u.indexOf('kuaishou') > -1) pf = 'kuaishou';
      else if (u.indexOf('weixin') > -1 || u.indexOf('channels') > -1) pf = 'sph';
      else if (u.indexOf('douyin') > -1) pf = 'douyin';
      type = /\/(user|profile|people)\//.test(u) ? 'author' : 'video';
    }
    return { type: type, platform: pf };
  }

  /* 输入一句话 → 建目标（默认已启用）→ 立刻跑首轮 → 中栏出结果 */
  async function startFromOmni() {
    var inp = $('ccOmni');
    if (!inp || S.gateBusy) return;
    var text = String(inp.value || '').trim();
    if (!text) {
      if (window.toast) toast('先输入关键词，或粘贴博主 / 作品链接', 'warn', '评论区获客');
      inp.focus();
      return;
    }
    /* 没有执行端时建目标毫无意义：任务会一直排队，用户以为系统坏了 */
    if (!devReady()) {
      if (window.toast) toast('先连接浏览器采集器（本机桥 + 扩展），否则没人干活', 'warn', '评论区获客');
      return;
    }
    var d = detectTarget(text);
    /* 没有该平台的有效登录态：先把二维码送到中间栏，登录成功后自动接着开跑 */
    var activeAcc = S.accounts.filter(function (x) { return x.platform === d.platform && x.status === 'active' && x.profileDir; })[0];
    if (!activeAcc) {
      S.pendingStart = text;
      ensureAccountLogin(d.platform, {});
      return;
    }
    var body = { target: d.type, platform: d.platform, every: '1h', limit: 20, intentWords: S.words, enabled: true };
    if (d.type === 'keyword') body.keyword = text;
    else {
      body.ref = text;
      body.keyword = text;
      if (d.type === 'region') body.region = text;
    }
    S.gateBusy = true;
    var btn = $('ccBtnGo');
    if (btn) { btn.disabled = true; btn.textContent = '开始中…'; }
    renderRunBar();
    try {
      var r = await API.call('/v1/collect/tasks', body, { timeout: 20000 });
      /* 业务错误码可能落在 r.code，也可能在 HTTP 4xx 的 body.code 里 */
      var code = (r && (r.code || (r.json && r.json.code))) || '';
      if (r && r.ok === false) {
        /* 同平台同目标已存在：不算失败，直接把已有目标跑一轮，用户要的是结果 */
        var existId = r.json && r.json.data && r.json.data.taskId;
        if (code === 'TASK_EXISTS' && existId) {
          if (window.toast) toast('这个目标已经在监控里，直接跑一轮', 'info', '评论区获客');
          await runTask(existId);
        } else {
          if (window.toast) toast(r.error || r.message || '创建失败', 'err', '评论区获客');
          return;
        }
      } else {
        var task = (r && r.data && r.data.task) || null;
        inp.value = '';
        if (window.toast) toast('已开跑：' + text.slice(0, 18) + '（' + (PF[d.platform] || ['', d.platform])[1] + ' · 每小时）', 'ok', '评论区获客');
        await loadConfig();
        if (task && task.id) {
          S.taskId = task.id;
          renderTargets();
          await runTask(task.id);
        }
      }
      await loadConfig();
      await loadFeed();
      await loadLeads();
      await loadNotes();
    } finally {
      S.gateBusy = false;
      if (btn) { btn.disabled = false; btn.textContent = '开始获客'; }
      renderRunBar();
    }
  }

  /* ---------- ① 采集账号 ---------- */
  var ACC_STATUS = { active: ['有效', 'active'], expired: ['已过期', 'expired'], disabled: ['已停用', 'disabled'] };

  function accName(id) {
    var a = S.accounts.filter(function (x) { return x.id === id; })[0];
    return a ? a.nickname : '';
  }

  function renderAccountMatrix() {
    var by = {};
    S.accounts.forEach(function (a) {
      var b = by[a.platform] || (by[a.platform] = { n: 0, active: 0 });
      b.n++;
      if (a.status === 'active' && a.profileDir) b.active++;
    });
    var html = '<div class="cc-acc-matrix">';
    Object.keys(PF).forEach(function (pf) {
      var b = by[pf] || { n: 0, active: 0 };
      var on = b.active > 0;
      html += '<button type="button" class="cc-acc-chip' + (on ? ' on' : '') + '" data-matrix-pf="' + pf + '">' +
        '<b>' + esc(PF[pf][1]) + '</b><span>' + (on ? '已登录' : (b.n ? '待登录' : '未添加')) + '</span></button>';
    });
    return html + '</div>';
  }

  /** 战役账号绑定：每个勾选平台一个下拉，空 = 自动选有效账号 */
  function renderCampAccounts() {
    var box = $('ccCampAccounts');
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('select[data-camp-pf]'), function (el) {
      S.campAccSel[el.getAttribute('data-camp-pf')] = el.value;
    });
    var pfs = [];
    Array.prototype.forEach.call(document.querySelectorAll('#ccCampPlats input:checked'), function (el) {
      pfs.push(el.value);
    });
    if (!pfs.length) { box.innerHTML = ''; return; }
    box.innerHTML = pfs.map(function (pf) {
      var opts = S.accounts.filter(function (a) { return a.platform === pf && a.status === 'active'; });
      var sel = S.campAccSel[pf] || '';
      var options = '<option value="">自动选已登录账号</option>' + opts.map(function (a) {
        return '<option value="' + esc(a.id) + '"' + (a.id === sel ? ' selected' : '') + '>' +
          esc(a.nickname) + (a.profileDir ? ' · 已登录' : '') + '</option>';
      }).join('');
      return '<label class="cc-camp-acc"><span>' + esc(PF[pf][1]) + '</span>' +
        '<select id="ccCampAcc_' + pf + '" data-camp-pf="' + pf + '">' + options + '</select></label>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('select[data-camp-pf]'), function (el) {
      el.onchange = function () { S.campAccSel[el.getAttribute('data-camp-pf')] = el.value; };
    });
  }

  function renderAccounts() {
    var box = $('ccAccs');
    if (!box) return;
    renderBridge();
    var st = (S.stats && S.stats.accounts) || null;
    if ($('ccAccCnt')) {
      $('ccAccCnt').textContent = S.accounts.length
        ? S.accounts.length + ' 个' + (st && st.active != null ? ' · 有效 ' + st.active : '')
        : '0 个';
    }
    var matrix = renderAccountMatrix();
    if (!S.accounts.length) {
      box.innerHTML = matrix + '<div class="cc-acc-empty"><b>还没有采集账号</b>点右上「添加」，填平台和昵称即可，浏览器目录不用填。<br>保存后点「扫码登录」，二维码会显示在中间栏，扫一次就记住登录态。</div>';
    } else {
      box.innerHTML = matrix + S.accounts.map(function (a) {
      var pf = PF[a.platform] || ['?', a.platform];
      var sc = ACC_STATUS[a.status] || ACC_STATUS.active;
      var used = a.lastUsedAt ? ago(a.lastUsedAt) + '用过' : '还没跑过';
      var quota = '采集/小时 <em>' + num(a.quotaPerHour) + '</em> 条'
        + (Number(a.commentQuotaPerHour) > 0 ? ' · 评论/小时 <em>' + num(a.commentQuotaPerHour) + '</em> 条' : '');
      var chk = a.lastCheckAt
        ? ((a.checkLevel === 'unknown' || /MC_BROWSER_ROOT|相对目录/.test(String(a.checkDetail || '')))
          ? '登录态：本机桥确认'
          : '检测：' + esc(a.checkDetail || sc[0]))
        : '未检测';
      var lg = (S.loginSession && S.loginSession.accId === a.id) ? S.loginSession : null;
      var loginLine = lg ? '<div class="cc-acc-login' + (lg.status === 'ok' ? ' ok' : '') + '">' +
        (lg.status === 'waiting' ? '◉ 二维码已显示在中间栏，等待扫码…'
          : lg.status === 'ok' ? '✓ 登录成功，登录态已保存'
          : lg.status === 'timeout' ? '等待扫码超时：浏览器没关的话，扫完点「检测」'
          : '✗ ' + esc(lg.message || '登录未完成')) + '</div>' : '';
      return '<div class="cc-acc" data-aid="' + esc(a.id) + '">' +
        '<div class="cc-acc-hd">' +
          '<span class="cc-acc-pf">' + esc(pf[1]) + '</span>' +
          '<span class="cc-acc-nm" title="' + esc(a.nickname) + '">' + esc(a.nickname) + '</span>' +
          '<span class="cc-acc-dot ' + sc[1] + '" title="' + sc[0] + '"></span>' +
        '</div>' +
        '<div class="cc-acc-sub">' + used + ' · ' + quota + '<br>' + chk + '</div>' +
        loginLine +
        '<div class="cc-acc-acts">' +
          '<button type="button" data-acc-act="login">' + (a.status === 'active' && a.profileDir ? '重新扫码' : '扫码登录') + '</button>' +
          '<details class="cc-acc-more"><summary>更多</summary>' +
            '<div class="cc-acc-more-body">' +
              '<button type="button" data-acc-act="edit">编辑</button>' +
              '<button type="button" data-acc-act="probe">检测</button>' +
              '<button type="button" data-acc-act="toggle">' + (a.status === 'active' ? '停用' : '启用') + '</button>' +
              '<button type="button" data-acc-act="del">删除</button>' +
            '</div>' +
          '</details>' +
        '</div>' +
      '</div>';
      }).join('');
    }
    Array.prototype.forEach.call(box.querySelectorAll('[data-matrix-pf]'), function (el) {
      el.addEventListener('click', function () {
        ensureAccountLogin(el.getAttribute('data-matrix-pf'), {});
      });
    });
    var lb = $('ccBtnLogin');
    if (lb) lb.style.display = S.accounts.some(function (a) { return a.status === 'active' && a.profileDir; }) ? 'none' : '';
    renderCampAccounts();
  }

  async function saveAccount() {
    var hint = $('ccAFHint');
    var body = {
      platform: ($('ccAFPlatform') || {}).value || 'douyin',
      nickname: String(($('ccAFNick') || {}).value || '').trim(),
      profileDir: String(($('ccAFDir') || {}).value || '').trim(),
      quotaPerHour: Number(($('ccAFQuota') || {}).value || 30),
      commentQuotaPerHour: Number(($('ccAFCommentQuota') || {}).value || 0),
      note: String(($('ccAFNote') || {}).value || '').trim()
    };
    if (!body.nickname) { if (hint) hint.textContent = '请填写账号昵称'; return; }
    var btn = $('ccAFSave');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    var editing = !!S.editAccId;
    var r = await API.call('/v1/collect/accounts' + (editing ? '/' + encodeURIComponent(S.editAccId) : ''), body,
      editing ? { method: 'PATCH', timeout: 20000 } : { timeout: 20000 });
    if (btn) { btn.disabled = false; btn.textContent = editing ? '保存修改' : '保存账号'; }
    if (r && r.ok === false) {
      if (hint) hint.textContent = (r.code === 'ACCOUNT_EXISTS' ? '这个平台下已经有同名账号' : (r.error || '保存失败'));
      return;
    }
    if (hint) hint.textContent = '';
    var f = $('ccAccForm');
    if (f) f.style.display = 'none';
    ['ccAFNick', 'ccAFDir', 'ccAFNote', 'ccAFCommentQuota'].forEach(function (id) { var e = $(id); if (e) e.value = ''; });
    if (btn) btn.textContent = '保存账号';
    S.editAccId = '';
    await loadAccounts();
    if (window.toast) toast(editing ? '账号已更新' : '采集账号已添加', 'ok', '采集');
  }

  /** 扫码登录：本机桥领任务 → 二维码回传 BFF → 中间栏显示（HTTPS 页面也能用） */
  var loginTimer = null;
  function stopLoginPoll() { if (loginTimer) { clearInterval(loginTimer); loginTimer = null; } }

  async function qrLogin(id, force) {
    var a = S.accounts.filter(function (x) { return x.id === id; })[0];
    if (!a) return;
    S.loginSession = { accId: id, status: 'starting', message: '正在通知本机桥…' };
    showLoginCard(a);
    renderAccounts();
    return qrLoginLocal(a, force);
  }

  /** BFF 中转：页面只读同源接口，不直连 localhost（HTTPS 下会被浏览器拦） */
  async function qrLoginLocal(a, force) {
    var dir = a.profileDir || ('aizy_' + a.platform + '_' + a.id);
    var r = await API.call('/v1/collect/login/start', {
      platform: a.platform, accountId: a.id, profileDir: dir, force: !!force
    }, { timeout: 20000 });
    var code = (r && (r.code || (r.json && r.json.code))) || '';
    if (!r || r.ok === false || !r.data || !r.data.loginId) {
      var msg = (code === 'NO_DEVICE' || code === 'DEVICE_OFFLINE')
        ? '本机采集器不在线：双击 ' + BRIDGE_TIP + '（黑窗口别关），回到本页点「连接」配对，再点「重新检测」。'
        : ((r && (r.error || r.message)) || '启动扫码登录失败');
      S.loginSession = { accId: a.id, status: 'failed', message: msg };
      paintLogin('failed', msg);
      renderAccounts();
      if (window.toast) toast(msg, 'warn', '扫码登录');
      return;
    }
    S.loginPanel.loginId = r.data.loginId;
    var s = r.data.session || {};
    S.loginSession = {
      accId: a.id, sessionId: s.id, status: s.status || 'pending',
      message: s.message || '等待本机桥领取…'
    };
    paintLogin(S.loginSession.status, S.loginSession.message);
    renderAccounts();
    startQrRefresh();
    stopLoginPoll();
    var ticks = 0;
    loginTimer = setInterval(async function () {
      ticks++;
      var st = '', msg = '';
      try {
        var p = await API.call('/v1/collect/login/' + encodeURIComponent(r.data.loginId) + '/status', null,
          { method: 'GET', timeout: 12000 });
        var ss = p && p.data && p.data.session;
        if (ss) {
          st = ss.status || '';
          msg = ss.message || '';
          if (ss.qr && ss.qr !== S.loginSession.qrData) {
            S.loginSession.qrData = ss.qr;
            var durl = 'data:' + (ss.qrMime || 'image/png') + ';base64,' + ss.qr;
            if (S.loginPanel) S.loginPanel.qrData = durl;
            paintQrData(durl);
          }
        }
      } catch (e) { /* 网络抖动：下一轮再试 */ }
      if (st && st !== S.loginSession.status) {
        S.loginSession.status = st;
        S.loginSession.message = msg;
        paintLogin(st, msg);
        renderAccounts();
        if (st === 'ok' || st === 'timeout' || st === 'failed' || st === 'canceled') {
          stopLoginPoll();
          stopQrRefresh();
          if (st === 'ok') {
            await API.call('/v1/collect/accounts/' + encodeURIComponent(a.id),
              { status: 'active', profileDir: dir }, { method: 'PATCH', timeout: 15000 });
            paintLogin('ok', msg || '登录成功，登录态已保存');
            if (window.toast) toast('登录成功，登录态已保存在这台电脑', 'ok', '扫码登录');
            setTimeout(hideLoginCard, 1200);
            await loadAccounts();
            renderRunBar();
            resumePending();
          } else {
            paintLogin(st, msg || '登录未完成，可点「重新检测」');
          }
        }
      }
      if (ticks > 90) {
        stopLoginPoll();
        stopQrRefresh();
        paintLogin('timeout', '等待扫码超时，可点「重新检测」');
      }
    }, 2000);
  }

  function openAccountEdit(a) {
    S.editAccId = a.id;
    if ($('ccAFPlatform')) $('ccAFPlatform').value = a.platform || 'douyin';
    if ($('ccAFNick')) $('ccAFNick').value = a.nickname || '';
    if ($('ccAFDir')) $('ccAFDir').value = a.profileDir || '';
    if ($('ccAFQuota')) $('ccAFQuota').value = a.quotaPerHour || 30;
    if ($('ccAFCommentQuota')) $('ccAFCommentQuota').value = a.commentQuotaPerHour || 0;
    if ($('ccAFNote')) $('ccAFNote').value = a.note || '';
    var f = $('ccAccForm');
    if (f) f.style.display = '';
    var btn = $('ccAFSave');
    if (btn) btn.textContent = '保存修改';
    var hint = $('ccAFHint');
    if (hint) hint.textContent = '修改后保存；评论/小时填 0 表示只受全局日限';
    if (f && f.scrollIntoView) f.scrollIntoView({ block: 'nearest' });
  }

  async function accountAct(id, act) {
    var a = S.accounts.filter(function (x) { return x.id === id; })[0];
    if (!a) return;
    if (act === 'login') { qrLogin(id, a.status === 'active'); return; }
    if (act === 'edit') { openAccountEdit(a); return; }
    if (act === 'probe') {
      S.accBusy = true;
      var r = await API.call('/v1/collect/accounts/' + encodeURIComponent(id) + '/probe', null, { timeout: 20000 });
      S.accBusy = false;
      if (r && r.data && r.data.probe && window.toast) {
        var lv = r.data.probe.level;
        toast(r.data.probe.message, lv === 'ok' ? 'ok' : (lv === 'missing' ? 'warn' : 'info'), '账号检测');
      }
      await loadAccounts();
      return;
    }
    if (act === 'toggle') {
      var next = a.status === 'active' ? 'disabled' : 'active';
      await API.call('/v1/collect/accounts/' + encodeURIComponent(id), { status: next }, { method: 'PATCH', timeout: 20000 });
      await loadAccounts();
      return;
    }
    if (act === 'del') {
      if (!window.confirm('删除账号「' + a.nickname + '」？绑定了它的监控目标会解除绑定，不会自动换号。')) return;
      await API.call('/v1/collect/accounts/' + encodeURIComponent(id), null, { method: 'DELETE', timeout: 20000 });
      await loadAccounts();
      await loadConfig();
    }
  }

  async function loadFeed() {
    var q = '/v1/collect/feed?limit=80';
    if (S.level) q += '&level=' + encodeURIComponent(S.level);
    if (S.taskId) q += '&taskId=' + encodeURIComponent(S.taskId);
    var r = await get(q);
    if (r && r.data) {
      S.feed = r.data.items || [];
      if (r.data.stats) S.stats = r.data.stats;
    }
    renderBar();
    renderStream();
  }

  async function loadLeads() {
    var q = '/v1/collect/leads?limit=200';
    if (S.stage) q += '&status=' + encodeURIComponent(S.stage);
    if (S.campaignFilter) q += '&campaignId=' + encodeURIComponent(S.campaignFilter);
    var r = await get(q);
    if (r && r.data) S.leads = r.data.leads || [];
    renderLedger();
  }

  async function loadFunnel() {
    S.funnelErr = '';
    try {
      var q = '/v1/collect/funnel';
      if (S.campaignFilter) q += '?campaignId=' + encodeURIComponent(S.campaignFilter);
      var r = await get(q);
      if (!r || r.ok === false) {
        S.funnel = null;
        S.funnelErr = (r && (r.error || r.message)) || '登录失效或服务端不可用';
      } else {
        S.funnel = r.data || null;
      }
    } catch (e) {
      S.funnel = null;
      S.funnelErr = String((e && e.message) || e);
    }
    renderFunnel();
  }

  function renderFunnel() {
    var box = $('ccFunnel');
    if (!box) return;
    var f = S.funnel;
    if (!f) {
      box.innerHTML = S.funnelErr
        ? '<span class="cc-funnel-err">漏斗加载失败：' + esc(S.funnelErr) + '（请确认已登录）</span>'
        : '<span>漏斗加载中…</span>';
      return;
    }
    box.innerHTML =
      '<span>作品 <b>' + num(f.works) + '</b></span><span class="arrow">→</span>' +
      '<span>高意向 <b>' + num(f.high) + '</b></span><span class="arrow">→</span>' +
      '<span>已触达 <b>' + num(f.sent) + '</b></span><span class="arrow">→</span>' +
      '<span>已联系 <b>' + num(f.contacted) + '</b></span><span class="arrow">→</span>' +
      '<span>加微 <b>' + num(f.wechat) + '</b></span><span class="arrow">→</span>' +
      '<span>成交 <b>' + num(f.won) + '</b></span>' +
      (f.pending ? '<span class="warn">· 待发 ' + num(f.pending) + '</span>' : '') +
      (f.failed ? '<span class="danger">· 失败 ' + num(f.failed) + '</span>' : '');
  }

  /* 搜到的作品：桥返回作品索引（标题/作者/封面/互动数）+ 本池线索统计 */
  async function loadNotes() {
    if (!S._notesClearedInit) {
      S._notesClearedInit = true;
      try { S.notesCleared = localStorage.getItem('aizy.cc.notesCleared') === '1'; } catch (e) {}
    }
    var qs = '/v1/collect/notes?limit=800';
    if (S.campaignFilter) qs += '&campaignId=' + encodeURIComponent(S.campaignFilter);
    /* 清空后禁止回退到 crawler 的旧作品缓存，否则清完又从上游冒出来 */
    if (S.notesCleared) qs += '&cleared=1';
    var r = await get(qs);
    if (r && r.data && r.data.ok) {
      S.notes = r.data.notes || [];
      S.noteSource = r.data.source || '';
    }
    if (S.view === 'notes') {
      await loadComments();
      renderNotes();
    }
  }

  function fmtPub(s) {
    if (!s) return '';
    var t = Number(s);
    if (t && !isNaN(t)) {
      /* 10 位秒级时间戳 → 毫秒 */
      if (t < 1e12) t *= 1000;
      var d = new Date(t);
      if (!isNaN(d.getTime())) return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    return String(s).slice(0, 10);
  }

  function platLabel(p) {
    return (PF[p] && PF[p][1]) || (p === 'xiaohongshu' ? '小红书' : (p ? p : '未知'));
  }

  /* ---------- 评论：作品卡状态 + 抽屉 + 批量排队 ---------- */

  /* 作品唯一键：与服务端 collect-comments.noteKeyOf 保持同一算法 */
  function noteKeyOf(n) {
    return String(n.platform || '') + '|' + String(n.note_id || n.url || '');
  }

  function cmtOf(n) {
    var k = noteKeyOf(n);
    for (var i = 0; i < S.comments.length; i++) {
      if (S.comments[i] && S.comments[i].noteKey === k) return S.comments[i];
    }
    return null;
  }

  function fmtEta(ts) {
    var t = Number(ts) - Date.now();
    if (!ts || isNaN(t)) return '稍后';
    if (t <= 0) return '马上';
    if (t < 60000) return Math.round(t / 1000) + ' 秒后';
    return Math.round(t / 60000) + ' 分钟后';
  }

  function cmtBadge(n) {
    var c = cmtOf(n);
    if (!c) return null;
    if (c.status === 'sent') return { cls: ' done', text: '已评论', tip: c.text || '已发布' };
    if (c.status === 'pending') return { cls: ' wait', text: '排队中', tip: '预计 ' + fmtEta(c.notBefore) + '发出：' + (c.text || '') };
    return { cls: ' err', text: '重发', tip: c.error || '上次没发出去' };
  }

  /* ---------- 点赞：与评论同一套队列，状态独立 ---------- */
  function likeOf(n) {
    var k = noteKeyOf(n);
    for (var i = 0; i < S.likes.length; i++) {
      if (S.likes[i] && S.likes[i].noteKey === k) return S.likes[i];
    }
    return null;
  }

  function likeBadge(n) {
    var l = likeOf(n);
    if (!l) return null;
    if (l.status === 'sent') return { cls: ' done', text: l.already ? '已赞过' : '已点赞', tip: '点赞完成' };
    if (l.status === 'pending') return { cls: ' wait', text: '待点赞', tip: '预计 ' + fmtEta(l.notBefore) + '执行' };
    return { cls: ' err', text: '重赞', tip: l.error || '上次没点成功' };
  }

  async function loadComments() {
    var r = await get('/v1/collect/comments?limit=300');
    if (r && r.data) S.comments = r.data.items || [];
  }

  async function loadCmtQueue() {
    try {
      var r = await get('/v1/collect/comments/queue');
      if (r && r.data) {
        S.cmtPaused = !!r.data.paused;
        S.cmtPending = Number(r.data.pending) || 0;
      }
    } catch (e) {}
    renderCmtPause();
  }

  function renderCmtPause() {
    var btn = $('ccBtnCmtPause');
    if (!btn) return;
    btn.textContent = S.cmtPaused ? '继续评论' : '暂停评论';
    btn.classList.toggle('paused', S.cmtPaused);
    btn.title = S.cmtPaused
      ? '自动评论已暂停；已排队任务保留，点这里继续'
      : '暂停后扩展不再领取新的评论任务，已发出的不受影响';
  }

  async function toggleCmtPause() {
    var next = !S.cmtPaused;
    try {
      var r = await API.call('/v1/collect/comments/pause', { paused: next }, { timeout: 15000 });
      if (r && r.ok === false) {
        if (window.toast) toast(apiErr(r), 'err', '评论队列');
        return;
      }
      S.cmtPaused = !!(r.data && r.data.paused);
      S.cmtPending = Number(r.data && r.data.pending) || 0;
      renderCmtPause();
      if (window.toast) toast(S.cmtPaused ? '自动评论已暂停' : '自动评论已继续', 'ok', '评论队列');
    } catch (e) {
      if (window.toast) toast('操作失败', 'err', '评论队列');
    }
  }

  async function clearCmtQueue() {
    var btn = $('ccBtnCmtClear');
    if (btn) { btn.textContent = '清空中…'; btn.disabled = true; }
    try {
      var r = await API.call('/v1/collect/notes/clear', { campaignId: S.campaignFilter || '', pause: true }, { timeout: 30000 });
      if (r && r.ok === false) {
        if (window.toast) toast(apiErr(r), 'err', '清空');
        return;
      }
      var d = r.data || {};
      var works = d.works || 0;
      var leads = d.leads || 0;
      var n = d.cleared || 0;
      var m = d.clearedLikes || 0;
      var paused = d.paused || 0;
      /* 上游 crawler 回退的作品不在服务端表里，清空接口会返回 works=0；
         但页面上确实有 N 张卡，提示要按页面上看到的数量报，别让用户以为没清。 */
      var shownWorks = works || (S.notes ? S.notes.length : 0);
      S.notes = [];
      S.leads = [];
      S.notesCleared = true;
      try { localStorage.setItem('aizy.cc.notesCleared', '1'); } catch (e) {}
      if (window.toast) {
        if (works || leads || n || m || paused || shownWorks) {
          toast('已清空：作品 ' + shownWorks + ' 个 · 线索 ' + leads + ' 条 · 评论排队 ' + n + ' 条 · 点赞排队 ' + m + ' 条'
            + (paused ? ' · 已暂停 ' + paused + ' 场战役' : ''), 'ok', '清空');
        } else {
          toast('当前筛选下没有可清空的内容；要清整个作品池，把顶部筛选切到「全部战役」再点', 'warn', '清空');
        }
      }
      await loadCampaigns();
      await loadNotes();
      await loadLeads();
      await loadFunnel();
      await loadCmtQueue();
      await loadComments();
      await loadLikes();
      renderNotes();
    } catch (e) {
      if (window.toast) toast('清空失败', 'err', '清空');
    } finally {
      if (btn) { btn.textContent = '清空作品+排队'; btn.disabled = false; }
    }
  }

  async function loadLikes() {
    var r = await get('/v1/collect/likes?limit=300');
    if (r && r.data) S.likes = r.data.items || [];
  }

  /* ---------- 执行过程：把服务端 steps 画成一条时间线 ----------
     一条任务在页面上经历：打开页面 → 定位评论区 →（点赞）→ 写入 → 发送。
     排队阶段没有 steps，就显示预计时间；失败那一步的原因直接摊开写出来。 */
  var STEP_LABEL = {
    open: '打开页面', locate: '定位评论区', like: '点赞', type: '写入内容',
    submit: '发送', done: '完成', fail: '失败'
  };

  function stepsOf(n) {
    var c = cmtOf(n), l = likeOf(n);
    if (c && c.steps && c.steps.length) return c.steps;
    if (l && l.steps && l.steps.length) return l.steps;
    return [];
  }

  function traceHtml(n) {
    var c = cmtOf(n), l = likeOf(n);
    var steps = stepsOf(n);
    var pending = (c && c.status === 'pending') || (l && l.status === 'pending');
    if (!steps.length) {
      if (!pending) return '';
      var eta = (c && c.status === 'pending') ? c.notBefore : (l && l.notBefore);
      return '<div class="cc-trace"><span class="cc-tr-wait"><i></i>排队中 · 预计 ' + fmtEta(eta) + ' 在本机浏览器执行</span></div>';
    }
    var html = '<div class="cc-trace">';
    steps.forEach(function (s) {
      var cls = s.status === 'fail' ? 'fail' : (s.status === 'run' ? 'run' : 'ok');
      var label = STEP_LABEL[s.step] || s.step || '';
      var time = String(s.at || '').slice(11, 19);
      html += '<span class="cc-tr ' + cls + '" title="' + esc(s.msg || '') + '"><i></i>' + esc(label)
        + (time ? '<em>' + esc(time) + '</em>' : '') + '</span>';
    });
    html += '</div>';
    var bad = null;
    for (var i = steps.length - 1; i >= 0; i--) if (steps[i].status === 'fail') { bad = steps[i]; break; }
    if (bad && bad.msg) html += '<div class="cc-tr-err">' + esc(bad.msg) + '</div>';
    return html;
  }

  function runningOf(n) {
    var steps = stepsOf(n);
    if (!steps.length) return false;
    return steps[steps.length - 1].status === 'run';
  }

  /* 有任务正在执行时把轮询提到 2~3 秒：过程要「看得见」，30 秒一跳等于看不见 */
  function hasActive() {
    var now = Date.now();
    var hot = function (x) {
      if (!x) return false;
      if (x.status === 'sent') return false;
      if (x.status === 'failed') return false;
      if (x.jobStatus === 'claimed') return true;
      if (Array.isArray(x.steps) && x.steps.length && x.steps[x.steps.length - 1].status === 'run') return true;
      return x.status === 'pending' && Number(x.notBefore || 0) <= now + 1500;
    };
    return S.comments.some(hot) || S.likes.some(hot);
  }

  function renderNotesBar() {
    var bar = $('ccNotesBar'), sub = $('ccNotesSub'), btn = $('ccBtnBatch');
    if (!bar) return;
    renderCmtPause();
    bar.style.display = S.view === 'notes' ? '' : 'none';
    var sent = 0, pending = 0, liked = 0, lpend = 0;
    S.notes.forEach(function (n) {
      var b = cmtBadge(n);
      if (b) {
        if (b.cls.indexOf('done') >= 0) sent++;
        if (b.cls.indexOf('wait') >= 0) pending++;
      }
      var l = likeBadge(n);
      if (l) {
        if (l.cls.indexOf('done') >= 0) liked++;
        if (l.cls.indexOf('wait') >= 0) lpend++;
      }
    });
    if (sub) {
      sub.textContent = '共 ' + S.notes.length + ' 个作品 · 已评论 ' + sent
        + (pending ? ' · 评论排队 ' + pending : '')
        + ' · 已点赞 ' + liked + (lpend ? ' · 点赞排队 ' + lpend : '')
        + (S.cmtPaused ? ' · 评论已暂停' : '');
    }
    if (btn) {
      var todo = S.notes.filter(function (n) { return n.url; }).length;
      btn.disabled = !todo;
      btn.textContent = '逐条评论（一次一条）';
    }
  }

  function renderNotes() {
    var box = $('ccNotes');
    if (!box) return;
    renderNotesBar();
    if (S.view === 'notes') {
      var live = $('ccLive');
      if (live) live.textContent = hasActive() ? '执行中 · 实时刷新' : '30 秒自动刷新';
    }
    if (!S.notes.length) {
      box.innerHTML = '<div class="cc-note-empty"><b>还没有搜到作品</b><br>在上面输入关键词并点「开始获客」，跑完一轮后这里会以横排卡片列出搜到的视频：点赞、评论数、作者，右侧可直接点赞、评论或回原片。</div>';
      return;
    }
    var size = 20;
    var total = Math.max(1, Math.ceil(S.notes.length / size));
    if (!S.notesPage || S.notesPage < 1) S.notesPage = 1;
    if (S.notesPage > total) S.notesPage = total;
    var page = S.notesPage;
    var start = (page - 1) * size;
    var list = S.notes.slice(start, start + size);
    var html = '<div class="cc-note-list">';
    list.forEach(function (n, i) {
      var gi = start + i;
      var title = n.title || '（无标题）';
      var initial = (title.replace(/\s/g, '')[0] || '作');
      var cover = n.cover
        ? '<img src="' + esc(n.cover) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
        : '';
      var high = Number(n.highCount) || 0;
      var badge = cmtBadge(n);
      var lbadge = likeBadge(n);
      var running = runningOf(n);
      var actCls = 'cc-n-act' + (badge ? badge.cls : '');
      var actTxt = badge ? badge.text : '写评论';
      var actTip = badge ? (badge.tip || '') : '打开评论抽屉';
      var disabled = !n.url;
      var likeCls = 'cc-n-like' + (lbadge ? lbadge.cls : '');
      var likeTxt = lbadge ? lbadge.text : '点赞';
      var likeTip = lbadge ? (lbadge.tip || '') : '用本机浏览器点一个赞';
      html += '<div class="cc-note' + (running ? ' running' : '') + '">'
        + '<div class="cc-note-cover">' + cover + esc(initial)
        + '<span class="cc-note-plat">' + esc(platLabel(n.platform)) + '</span>'
        + (high ? '<span class="cc-note-high">高意向 ' + high + '</span>' : '')
        + '</div>'
        + '<div class="cc-note-body">'
        + '<div class="cc-note-title" title="' + esc(title) + '">' + esc(title) + '</div>'
        + '<div class="cc-note-meta"><span class="cc-n-author">@' + esc(n.author || '未知作者') + '</span>'
        + (n.publishAt ? '<span>' + esc(fmtPub(n.publishAt)) + '</span>' : '')
        + (n.keyword ? '<span class="cc-note-kw" title="' + esc(n.keyword) + '">' + esc(n.keyword) + '</span>' : '')
        + '</div>'
        + '<div class="cc-note-stats">'
        + '<span>评论 <b>' + num(n.comments) + '</b></span>'
        + '<span>点赞 <b>' + num(n.liked) + '</b></span>'
        + (n.collected ? '<span>收藏 <b>' + num(n.collected) + '</b></span>' : '')
        + (n.commentCount ? '<span>已采 <b>' + num(n.commentCount) + '</b></span>' : '')
        + (lbadge && lbadge.cls.indexOf('done') >= 0 ? '<span class="cc-n-done">本机已赞</span>' : '')
        + '</div>'
        + traceHtml(n)
        + '</div>'
        + '<div class="cc-note-acts">'
        + '<button type="button" class="' + likeCls + '" data-like="' + gi + '" title="' + esc(likeTip) + '"'
        + (disabled ? ' disabled title="这条作品没有链接，无法打开作品页"' : '') + '>' + esc(likeTxt) + '</button>'
        + '<button type="button" class="' + actCls + '" data-cmt="' + gi + '" title="' + esc(actTip) + '"'
        + (disabled ? ' disabled title="这条作品没有链接，无法打开评论"' : '') + '>' + esc(actTxt) + '</button>'
        + (n.url ? '<a class="cc-n-link" href="' + esc(n.url) + '" target="_blank" rel="noopener">原片 ↗</a>' : '')
        + '</div>'
        + '</div>';
    });
    html += '</div>';
    if (total > 1) {
      var opts = '';
      for (var pg = 1; pg <= total; pg++) {
        opts += '<option value="' + pg + '"' + (pg === page ? ' selected' : '') + '>' + pg + '</option>';
      }
      html += '<div class="cc-pager">' +
        '<button type="button" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
        '<span>第 <b>' + page + '</b> / ' + total + ' 页 · 每页 ' + size + ' 条</span>' +
        '<select id="ccNotesPageSel" aria-label="选择页码">' + opts + '</select>' +
        '<button type="button" data-page="' + (page + 1) + '"' + (page >= total ? ' disabled' : '') + '>下一页</button>' +
        '</div>';
    }
    if (S.noteSource === 'pool') {
      html += '<div class="cc-note-empty" style="padding-top:12px">作品索引来自已采集线索池（采集通道未接上游作品清单）。跑一轮采集后自动补全。</div>';
    }
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('[data-page]'), function (el) {
      el.addEventListener('click', function () {
        var p = Number(el.getAttribute('data-page')) || 1;
        if (p < 1 || p > total) return;
        S.notesPage = p;
        renderNotes();
        if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
      });
    });
    var pageSel = $('ccNotesPageSel');
    if (pageSel) pageSel.onchange = function () {
      S.notesPage = Number(pageSel.value) || 1;
      renderNotes();
    };
  }

  /* 单独点赞：与评论共用采集端队列，排队后由本机浏览器执行 */
  async function postLike(i) {
    var n = S.notes[i];
    if (!n || !n.url) return;
    var r = await API.call('/v1/collect/likes', {
      noteKey: noteKeyOf(n), note_id: n.note_id, platform: n.platform, url: n.url,
      title: n.title, author: n.author
    }, { timeout: 20000 });
    if (r && r.ok === false) {
      var code = (r.json && r.json.code) || r.code || '';
      if (code === 'ALREADY_LIKED' || code === 'LIKE_QUEUED') {
        if (window.toast) toast(apiErr(r), 'info', '点赞');
        await loadLikes(); renderNotes();
      } else {
        if (window.toast) toast(apiErr(r), 'err', '点赞');
      }
      return;
    }
    if (window.toast) toast('已排队点赞，' + fmtEta(r.data && r.data.job && r.data.job.notBefore) + '由本机浏览器执行', 'ok', '点赞');
    await loadLikes();
    renderNotes();
  }

  /* ---------- 评论抽屉 ---------- */
  function openCmt(i, fromBadge) {
    var n = S.notes[i];
    if (!n) return;
    if (!n.url) {
      if (window.toast) toast('这条作品没有链接：先跑一轮采集补齐作品地址', 'warn', '评论');
      return;
    }
    var c = cmtOf(n);
    if (c && c.status === 'sent') {
      if (window.toast) toast('这条已经评论过了：' + (c.text || ''), 'info', '评论');
      return;
    }
    S.cmtIdx = i;
    var mask = $('ccCmtMask');
    var box = $('ccCmtNote');
    if (box) {
      box.innerHTML = '<b>' + esc(n.title || '（无标题）') + '</b><br>@' + esc(n.author || '未知作者')
        + ' · ' + esc(platLabel(n.platform))
        + ' · 评论 ' + num(n.comments) + ' / 点赞 ' + num(n.liked);
    }
    var ta = $('ccCmtText');
    if (ta) { ta.value = ''; ta.disabled = false; }
    var sug = $('ccCmtSug');
    if (sug) sug.innerHTML = '';
    var hint = $('ccCmtHint');
    if (hint) {
      hint.textContent = (c && c.status === 'failed')
        ? '上次没发出去：' + (c.error || '未知原因') + ' · 可改一句再发'
        : '以本机 Chrome 里已登录的账号发布 · 单条间隔 45~90 秒 · 内容合规由你确认';
    }
    S.cmtMode = 'manual';
    var lkBox = $('ccCmtLike');
    if (lkBox) {
      var hadLike = likeOf(n);
      lkBox.checked = !(hadLike && hadLike.status === 'sent');
      S.withLike = lkBox.checked;
    }
    updateCmtCnt();
    if (mask) mask.style.display = 'flex';
    if (ta) setTimeout(function () { try { ta.focus(); } catch (e) {} }, 60);
  }

  function closeCmt() {
    var mask = $('ccCmtMask');
    if (mask) mask.style.display = 'none';
    S.cmtIdx = -1;
  }

  function updateCmtCnt() {
    var ta = $('ccCmtText'), c = $('ccCmtCnt');
    if (c && ta) c.textContent = String((ta.value || '').length) + '/120';
  }

  function apiErr(r) {
    if (!r) return '网络未就绪，稍后重试';
    var j = r.json || (r.data && r.data.ok === false ? r.data : null);
    return (j && (j.message || j.error)) || r.error || r.message || '操作失败';
  }

  async function aiDraft() {
    var n = S.notes[S.cmtIdx];
    if (!n) return;
    var btn = $('ccCmtAi');
    if (S.cmtDrafting) return;
    S.cmtDrafting = true;
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    try {
      var r = await API.call('/v1/collect/comments/draft', {
        noteKey: noteKeyOf(n), note_id: n.note_id, platform: n.platform,
        title: n.title, author: n.author, keyword: n.keyword, count: 3
      }, { timeout: 40000 });
      var d = r && r.data;
      if (!d || !d.items || !d.items.length) {
        if (window.toast) toast(apiErr(r), 'err', 'AI 仿写');
        return;
      }
      var sug = $('ccCmtSug');
      if (sug) {
        sug.innerHTML = d.items.map(function (it, k) {
          return '<button type="button" class="cc-cmt-sg" data-sug="' + k + '">'
            + '<i>' + (d.source === 'llm' ? 'AI' : '本地仿真') + '</i>' + esc(it.text) + '</button>';
        }).join('');
        Array.prototype.forEach.call(sug.querySelectorAll('.cc-cmt-sg'), function (el) {
          el.addEventListener('click', function () {
            var idx = Number(el.getAttribute('data-sug')) || 0;
            var it = d.items[idx];
            var ta = $('ccCmtText');
            if (ta && it) { ta.value = it.text; S.cmtMode = (d.source === 'llm' ? 'ai' : 'local'); updateCmtCnt(); ta.focus(); }
          });
        });
      }
      if (window.toast) {
        toast(d.source === 'llm' ? '已按标题生成 3 条，点一条填进去' : '未配模型，用本地仿真生成 3 条（配置 LLM 后更像人）', 'ok', 'AI 仿写');
      }
    } finally {
      S.cmtDrafting = false;
      if (btn) { btn.disabled = false; btn.textContent = 'AI 仿写'; }
    }
  }

  async function sendCmt() {
    var n = S.notes[S.cmtIdx];
    if (!n) return;
    var ta = $('ccCmtText');
    var text = String((ta && ta.value) || '').trim();
    if (text.length < 2) {
      if (window.toast) toast('写一句再发（至少 2 个字）', 'warn', '评论');
      return;
    }
    var btn = $('ccCmtSend');
    if (btn) { btn.disabled = true; btn.textContent = '排队中…'; }
    try {
      var r = await API.call('/v1/collect/comments', {
        noteKey: noteKeyOf(n), note_id: n.note_id, platform: n.platform, url: n.url,
        title: n.title, author: n.author, keyword: n.keyword, text: text, mode: S.cmtMode || 'manual',
        withLike: !!S.withLike
      }, { timeout: 20000 });
      if (r && r.ok === false) {
        var code = (r.json && r.json.code) || r.code || '';
        if (code === 'ALREADY_COMMENTED' || code === 'COMMENT_QUEUED') {
          if (window.toast) toast(apiErr(r), 'info', '评论');
          closeCmt();
        } else {
          if (window.toast) toast(apiErr(r), 'err', '评论');
        }
        return;
      }
      closeCmt();
      if (window.toast) toast('已排队，' + fmtEta(r.data && r.data.job && r.data.job.notBefore) + '由本机浏览器发出', 'ok', '评论');
      await loadComments();
      renderNotes();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '发布评论'; }
    }
  }

  async function batchComment() {
    if (S.cmtPaused) {
      if (window.toast) toast('评论已暂停，先点「继续评论」', 'warn', '评论');
      return;
    }
    if (S.cmtPending > 0) {
      if (window.toast) toast('还有一条在排队/执行，等它结束再点下一条', 'warn', '评论');
      return;
    }
    var todo = S.notes.filter(function (n) {
      var c = cmtOf(n);
      return n.url && (!c || c.status === 'failed');
    });
    if (!todo.length) {
      if (window.toast) toast('没有待评论的作品（都已发过或没有链接）', 'info', '评论');
      return;
    }
    /* 严格一次只排一条：打开一条 → 评论 → 关页 → 用户再点下一条 */
    var take = todo.slice(0, 1);
    var btn = $('ccBtnBatch');
    if (btn) { btn.disabled = true; btn.textContent = '排队中…'; }
    try {
      var r = await API.call('/v1/collect/comments/batch', {
        mode: 'ai',
        items: take.map(function (n) {
          return {
            noteKey: noteKeyOf(n), note_id: n.note_id, platform: n.platform, url: n.url,
            title: n.title, author: n.author, keyword: n.keyword
          };
        })
      }, { timeout: 60000 });
      var d = r && r.data;
      if (!d || !d.queued) {
        if (window.toast) toast(apiErr(r), 'err', '逐条评论');
        return;
      }
      if (window.toast) {
        var first = d.queued[0];
        toast('已排队 1 条，' + fmtEta(first && first.notBefore) + '打开这条；成功后回来点「下一条」', 'ok', '逐条评论');
      }
      await loadComments();
      await loadCmtQueue();
      renderNotes();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '逐条评论（一次一条）'; }
    }
  }

  /* ---------- 顶栏 ---------- */
  function showBar(kind, title, sub) {
    var dot = $('ccDot');
    if (dot) dot.className = 'cc-dot ' + kind;
    if ($('ccStateText')) $('ccStateText').textContent = title;
    if ($('ccStateSub')) $('ccStateSub').textContent = sub || '';
  }

  function renderBar() {
    var st = S.stats || {};
    var last = st.lastRun || null;
    var mode = st.mode || (S.cfg && S.cfg.stats && S.cfg.stats.mode) || 'unconfigured';
    var kind = mode === 'upstream' ? 'ok' : (mode === 'local' ? 'warn' : 'err');
    var title = mode === 'upstream' ? '采集通道已接入'
      : (mode === 'local' ? '本地模拟通道（非真实采集）' : '未配置采集通道');
    var sub = last
      ? ('最近一轮 ' + ago(last.at) + ' · ' + (last.status === 'ok' ? '新增 ' + num(last.fresh) + ' 条' : ('状态 ' + last.status)) +
         (last.channel ? ' · 通道 ' + last.channel : ''))
      : '还没有跑过一轮。新建目标后点「全部扫一轮」即可。';
    if (kind === 'err') sub += ' · 采集通道未接入时不会生成模拟数据';
    showBar(kind, title, sub);

    var today = (S.leads.length ? S.leads : S.feed).filter(function (l) { return isToday(l.created_at); }).length;
    if ($('ccKpiNew')) $('ccKpiNew').textContent = num(today);
    if ($('ccKpiHigh')) $('ccKpiHigh').textContent = num((st.byLevel && st.byLevel.high) || 0);
    if ($('ccKpiPool')) $('ccKpiPool').textContent = num(st.byStatus ? Object.keys(st.byStatus).reduce(function (a, k) { return a + st.byStatus[k]; }, 0) : S.leads.length);
    if ($('ccKpiScan')) $('ccKpiScan').textContent = last ? ago(last.at) : '—';
  }

  /* ---------- 左：目标 ---------- */
  function renderTargets() {
    var box = $('ccTargets');
    if (!box) return;
    if ($('ccTargetCnt')) $('ccTargetCnt').textContent = S.tasks.length + ' 个';
    if (!S.tasks.length) {
      box.innerHTML = '<div class="cc-empty" style="padding:26px 12px"><b>还没有监控目标</b>点右上「新建」加第一个</div>';
      return;
    }
    box.innerHTML = S.tasks.map(function (t) {
      var pf = PF[t.platform] || ['?', t.platform];
      var on = S.taskId === t.id ? ' on' : '';
      var name = t.target === 'keyword' ? t.keyword : (t.ref || t.keyword);
      return '<div class="cc-tg' + on + '" data-tid="' + esc(t.id) + '">' +
        '<div class="cc-tg-top">' +
          '<span class="cc-tg-type">' + esc(TARGET_LABEL[t.target || 'keyword'] || '关键词') + '</span>' +
          '<span class="cc-tg-name" title="' + esc(name) + '">' + esc(name) + '</span>' +
          '<span class="cc-tg-acts">' +
            '<button type="button" data-tg-act="run" title="立即跑一轮">▶</button>' +
            '<button type="button" data-tg-act="del" title="删除这个目标">×</button>' +
          '</span>' +
        '</div>' +
        '<div class="cc-tg-meta">' +
          '<span class="cc-pf ' + esc(t.platform) + '" style="align-self:center">' + pf[0] + '</span>' +
          '<span>' + esc(t.scheduleText || (t.every || '')) + '</span>' +
          '<span>累计 <i>' + num(t.total) + '</i></span>' +
          (t.enabled === false ? '<span style="color:var(--amber)">待开启</span>'
            : '<span>上次 <i>' + esc(t.lastStatus || '未跑') + '</i></span>') +
          (t.accountId ? '<span title="采集账号">@<i>' + esc(accName(t.accountId) || '已删除') + '</i></span>' : '') +
        '</div>' +
      '</div>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('.cc-tg'), function (el) {
      var id = el.getAttribute('data-tid');
      el.addEventListener('click', function (e) {
        var act = e.target && e.target.closest ? e.target.closest('[data-tg-act]') : null;
        if (act) {
          e.stopPropagation();
          var kind = act.getAttribute('data-tg-act');
          if (kind === 'run') runTask(id);
          else if (kind === 'del') delTarget(id);
          return;
        }
        S.taskId = (S.taskId === id) ? '' : id;
        renderTargets();
        loadFeed();
      });
    });
  }

  /** 删目标：线索台账保留（这条线索是哪次采集来的，删目标也要能追溯） */
  async function delTarget(id) {
    var t = S.tasks.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var name = t.target === 'keyword' ? t.keyword : (t.ref || t.keyword);
    if (!window.confirm('删除监控目标「' + name + '」？已采到的线索会留在台账里。')) return;
    var r = await API.call('/v1/collect/tasks/' + encodeURIComponent(id), null, { method: 'DELETE', timeout: 20000 });
    if (r && r.ok === false) {
      if (window.toast) toast(r.error || '删除失败', 'err', '监控目标');
      return;
    }
    if (S.taskId === id) S.taskId = '';
    await loadConfig();
    renderRunBar();
    if (window.toast) toast('已删除「' + name + '」', 'ok', '监控目标');
  }

  function renderWords() {
    var box = $('ccWords');
    if (!box) return;
    /* 词本体不可点，× 悬停才出现：一排词看着干净，也不会误删。
       超过 8 个先收进「+N」，展开后 × 常显，方便一次性清理。 */
    var LIMIT = 8;
    var all = S.words || [];
    if ($('ccWordCnt')) $('ccWordCnt').textContent = String(all.length);
    var collapsed = !S.wordsOpen && all.length > LIMIT;
    var show = collapsed ? all.slice(0, LIMIT) : all;
    box.className = 'cc-words' + (S.wordsOpen ? ' open' : '');
    var html = show.map(function (w) {
      return '<span class="cc-word">' + esc(w) + '<i data-w="' + esc(w) + '" title="移除">×</i></span>';
    }).join('');
    if (all.length > LIMIT) {
      html += '<span class="cc-word more" data-more="1">' +
        (S.wordsOpen ? '收起' : '+' + (all.length - LIMIT)) + '</span>';
    }
    box.innerHTML = html || '<span class="cc-ph-sub">还没有意向词</span>';
    Array.prototype.forEach.call(box.querySelectorAll('.cc-word i'), function (el) {
      el.addEventListener('click', function () {
        var w = el.getAttribute('data-w');
        S.words = S.words.filter(function (x) { return x !== w; });
        saveWords(); renderWords(); renderChan(); renderRunBar(); publishWords();
      });
    });
    var more = box.querySelector('[data-more]');
    if (more) more.addEventListener('click', function () {
      S.wordsOpen = !S.wordsOpen;
      renderWords();
    });
  }

  /* ---------- ④ 运行状态 ---------- */
  function renderChan() {
    var box = $('ccChan');
    if (!box) return;
    var ch = (S.cfg && S.cfg.channels) || [];
    /* dormant = 代码里还有、但从未接线的空壳（官方通道/第三方服务），
       不能算进「已接入」，否则用户会以为数据来自官方接口。 */
    var real = ch.filter(function (c) { return c.configured && !c.dormant && c.id !== 'local'; });
    var st = S.stats || {};
    var lastScan = st.lastScanAt ? ago(st.lastScanAt) : '还没跑过';
    var bound = st.boundTasks || 0;
    var broken = st.brokenBindings || 0;
    box.innerHTML =
      '<div><b>通道</b>：' + (real.length ? real.map(function (c) { return esc(c.name || c.id); }).join(' / ') : '未接入') +
        ' <span class="cc-dot ' + (real.length ? 'ok' : 'idle') + '" style="display:inline-block;vertical-align:middle"></span></div>' +
      '<div><b>轮询</b>：' + (st.tickMs ? Math.round(st.tickMs / 1000) + ' 秒' : '30 秒') + ' · 并发 ' + (st.concurrency || 2) + '</div>' +
      '<div><b>上次扫描</b>：' + esc(lastScan) + '</div>' +
      '<div><b>绑号</b>：' + bound + ' / ' + (st.tasks || S.tasks.length) + ' 个目标已指定账号' +
        (broken ? ' · <span style="color:var(--red,#e24b4a)">' + broken + ' 个绑到了已删除的号</span>' : '') + '</div>' +
      '<div><b>意向词</b>：' + S.words.length + ' 个（命中 +22 分）</div>' +
      '<div><b>运行</b>：' + (S.tasks.some(function (t) { return t.enabled !== false; })
        ? '<span style="color:var(--green)">已开启</span>'
        : '未开启（点目标右侧 ▶ 跑一轮）') + '</div>' +
      '<button class="cc-run-btn" type="button" id="ccBtnProbe">测试通道连通</button>';
    var b = $('ccBtnProbe');
    if (b) b.addEventListener('click', probeChannel);
  }

  async function probeChannel() {
    var b = $('ccBtnProbe');
    if (b) { b.disabled = true; b.textContent = '探测中…'; }
    var r = await get('/v1/collect/channels?probe=1');
    if (b) { b.disabled = false; b.textContent = '测试通道连通'; }
    if (!r || !r.data) {
      if (window.toast) toast('探测失败：服务端不可达', 'err', '通道');
      return;
    }
    var list = r.data.probe || [];
    if (!list.length) {
      if (window.toast) toast('没有可探测的通道，请先接入采集服务', 'warn', '通道');
      return;
    }
    /* 只要有一条通道探测通，就算「能用」；全部不通如实说是哪条断了 */
    var up = list.filter(function (p) { return p.ok; });
    var msg = list.map(function (p) {
      return (p.name || p.id) + '：' + (p.ok ? '通' : '断（' + (p.message || '无响应') + '）');
    }).join('；');
    if (window.toast) toast(msg, up.length ? 'ok' : 'err', '通道探测');
  }

  /* ---------- 中：评论流 ---------- */
  function renderStream() {
    var box = $('ccStream');
    if (!box) return;
    if (!S.feed.length) {
      box.innerHTML = '<div class="cc-empty"><b>' + (S.level ? '这个档位还没有评论' : '还没有抓到评论') + '</b>' +
        '新建一个监控目标，点「全部扫一轮」；<br>或先确认采集通道已接入。</div>';
      return;
    }
    box.innerHTML = S.feed.map(function (c) {
      var pf = PF[c.platform] || ['?', c.platform];
      var lv = c.level || 'noise';
      var src = [];
      if (c.author) src.push('@' + esc(c.author));
      if (c.video) src.push(esc(c.video));
      if (c.video_url) src.push('<a href="' + esc(c.video_url) + '" target="_blank" rel="noopener">看原视频</a>');
      src.push(esc(ago(c.at && String(c.at).length > 10 ? c.at : (c.created_at || ''))));
      return '<div class="cc-item" data-lid="' + esc(c.id) + '">' +
        '<div class="cc-av">' + esc(String(c.nickname || '匿').slice(0, 1)) + '</div>' +
        '<div class="cc-body">' +
          '<div class="cc-line1">' +
            '<span class="cc-nick" title="' + esc(c.nickname) + '">' + esc(c.nickname) + '</span>' +
            '<span class="cc-pf ' + esc(c.platform) + '">' + pf[0] + '</span>' +
            '<span class="cc-score ' + lv + '" title="' + esc(c.why || '') + '">' + esc(LEVEL_LABEL[lv] || lv) + ' ' + num(c.score) + '</span>' +
          '</div>' +
          '<div class="cc-text">' + highlight(c.comment, c.hits) + '</div>' +
          '<div class="cc-src">' + src.join(' · ') + '</div>' +
          '<div class="cc-acts">' +
            '<button class="cc-act" data-op="contacted">标为已联系</button>' +
            '<button class="cc-act" data-op="wechat">已加微</button>' +
            '<button class="cc-act ghost" data-op="lost">忽略</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('.cc-item'), function (el) {
      var lid = el.getAttribute('data-lid');
      Array.prototype.forEach.call(el.querySelectorAll('.cc-act'), function (b) {
        b.addEventListener('click', function () { setStage(lid, b.getAttribute('data-op'), b); });
      });
    });
  }

  /* ---------- 右：台账 ---------- */
  function renderLedger() {
    var box = $('ccLedger');
    if (!box) return;
    if ($('ccLeadTotal')) $('ccLeadTotal').textContent = S.leads.length + ' 条';
    if (!S.leads.length) {
      box.innerHTML = '<div class="cc-empty" style="padding:30px 12px"><b>台账为空</b>流里标为「已联系 / 已加微」的线索会落到这里</div>';
      return;
    }
    box.innerHTML = S.leads.slice(0, 60).map(function (l) {
      var st = l.status || 'new';
      var lv = l.level || 'noise';
      var camp = l.campaignId ? (S.campaigns || []).filter(function (c) { return c.id === l.campaignId; })[0] : null;
      var steps = ['contacted', 'wechat', 'won', 'lost'].map(function (k) {
        return '<button class="cc-step" data-st="' + k + '">' + esc(STAGE_LABEL[k]) + '</button>';
      }).join('');
      return '<div class="cc-ld" data-lid="' + esc(l.id) + '">' +
        '<div class="cc-ld-top">' +
          '<span class="cc-ld-name" title="' + esc(l.nickname) + '">' + esc(l.nickname) + '</span>' +
          '<span class="cc-st ' + esc(st) + '">' + esc(STAGE_LABEL[st] || st) + '</span>' +
        '</div>' +
        '<div class="cc-ld-sub">' +
          '<em>' + esc(l.intent || '待判定') + '</em> · ' + num(l.score) + ' 分 · ' + esc(LEVEL_LABEL[lv] || lv) +
          (camp ? ' · 战役：' + esc(camp.name) : '') + '<br>' +
          esc(String(l.comment || '').slice(0, 42)) +
        '</div>' +
        '<div class="cc-steps">' + steps + '</div>' +
      '</div>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('.cc-ld'), function (el) {
      var lid = el.getAttribute('data-lid');
      Array.prototype.forEach.call(el.querySelectorAll('.cc-step'), function (b) {
        b.addEventListener('click', function () { setStage(lid, b.getAttribute('data-st'), b); });
      });
    });
  }

  /* ---------- 写操作 ---------- */
  async function setStage(id, status, btn) {
    if (!id || !status) return;
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    var r = await API.call('/v1/collect/leads/' + encodeURIComponent(id) + '/status', { status: status }, { timeout: 15000 });
    if (btn) { btn.disabled = false; }
    if (r && r.ok !== false) {
      loadLeads();
      loadFeed();
      if (window.toast) toast('已标为「' + (STAGE_LABEL[status] || status) + '」', 'ok', '线索台账');
    } else {
      if (btn) btn.textContent = STAGE_LABEL[status] || status;
      if (window.toast) toast('状态更新失败：' + ((r && (r.error || r.message)) || '未知错误'), 'warn', '线索台账');
    }
  }

  async function runTask(id) {
    /* 采集器要在用户浏览器里真开页面读 DOM，一轮 25~40 秒，
       所以这里的等待上限放到 75 秒（云端代理是 100 秒，留余量）。 */
    var r = await API.call('/v1/collect/tasks/' + encodeURIComponent(id) + '/run', {}, { timeout: 75000 });
    var run = r && r.data && r.data.run;
    if (window.toast) {
      if (run && run.status === 'ok') toast('本轮新增 ' + run.fresh + ' 条（重复 ' + run.dup + ' 条已拦截）', 'ok', '采集');
      else if (run && run.note) toast(run.note, 'warn', '采集');
      else toast('已提交，稍后刷新查看', 'info', '采集');
    }
    return r;
  }

  async function scanAll() {
    var list = S.tasks.filter(function (t) { return t.enabled !== false; });
    if (!list.length) {
      if (window.toast) toast(S.tasks.length ? '目标都是停用态：点目标右侧 ▶ 跑一轮' : '先在上面输入一句话开始获客', 'warn', '采集');
      return;
    }
    var btn = $('ccBtnScan');
    if (btn) { btn.disabled = true; btn.textContent = '扫描中…'; }
    var i = 0;
    /* 采集器是单线程开页面，多个目标并行只会互相排队到超时；
       走采集器时串行跑，走爬虫/供应商时才并行 */
    var lanes = devReady() ? 1 : 3;
    var worker = async function () {
      while (i < list.length) {
        var t = list[i++];
        try { await runTask(t.id); } catch (e) {}
      }
    };
    var arr = [];
    for (var k = 0; k < lanes; k++) arr.push(worker());
    await Promise.all(arr);
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="icon"><use href="#i-radar"/></svg>全部扫一轮'; }
    await loadConfig();
    await loadFeed();
    await loadLeads();
    /* 作品卡也立刻刷：不然跑完要等 30 秒轮询才看得到新抓到的作品 */
    await loadNotes();
  }

  function publishWords() {
    /* 意向词是打分的输入：词表变了就把所有任务的词表同步一遍，
       否则已有目标还在用旧词库，流里的分数会和左栏看到的不一致。 */
    var tasks = S.tasks.filter(function (t) {
      var cur = Array.isArray(t.intentWords) ? t.intentWords : [];
      return cur.join('|') !== S.words.join('|');
    });
    tasks.forEach(function (t) {
      API.call('/v1/collect/tasks/' + encodeURIComponent(t.id), { intentWords: S.words }, { method: 'PATCH', timeout: 15000 });
    });
  }

  function addWord() {
    var inp = $('ccWordInput');
    if (!inp) return;
    var w = String(inp.value || '').trim().slice(0, 12);
    if (!w) return;
    if (S.words.indexOf(w) < 0) S.words.push(w);
    inp.value = '';
    saveWords(); renderWords(); renderChan(); renderRunBar(); publishWords();
  }

  /* ---------- 事件 ---------- */
  function bind() {
    var b;
    if ((b = $('ccBtnRefresh'))) b.addEventListener('click', function () { refreshAll(); });
    if ((b = $('ccBtnBridgeStart'))) b.addEventListener('click', function () {
      var d = S.device || {};
      if (d.plugin && d.online > 0) {
        S.devNextAt = 0;
        probeDevice().then(function (x) {
          if (window.toast) toast(x.plugin ? '执行端在线' : '执行端离线', x.plugin ? 'ok' : 'warn', '执行端');
        });
        return;
      }
      launchBridgeProtocol();
      if (window.toast) toast('正在启动本机桥…', 'info', '执行端');
      setTimeout(function () {
        S.devNextAt = 0;
        probeDevice().then(function (x) {
          if (!x || !(x.online > 0)) pairDevice();
        });
      }, 2600);
    });
    if ((b = $('ccBtnBridgeHelp'))) b.addEventListener('click', function () {
      var h = $('ccHelp');
      if (h) {
        h.open = true;
        try { h.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      }
    });
    if ((b = $('ccBtnExceptions'))) b.addEventListener('click', openExceptions);
    if ((b = $('ccExcClear'))) b.addEventListener('click', clearExceptions);
    if ((b = $('ccExcClose'))) b.addEventListener('click', closeExceptions);
    var excMask = $('ccExcMask');
    if (excMask) excMask.addEventListener('click', function (e) { if (e.target === excMask) closeExceptions(); });
    var excList = $('ccExcList');
    if (excList) excList.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-exc-i]') : null;
      if (!t) return;
      retryException(S.exceptions[Number(t.getAttribute('data-exc-i')) || 0]);
    });
    if ((b = $('ccBtnScan'))) b.addEventListener('click', function () { scanAll(); });
    if ((b = $('ccBtnGo'))) b.addEventListener('click', startFromOmni);
    if ((b = $('ccCampStart'))) b.addEventListener('click', saveCampaign);
    var cp = $('ccCampPlats');
    if (cp) cp.addEventListener('change', renderCampAccounts);
    var cf = $('ccCampFilter');
    if (cf) cf.addEventListener('change', async function () {
      S.campaignFilter = cf.value || '';
      try {
        if (S.campaignFilter) localStorage.setItem(KEY_CAMP, S.campaignFilter);
        else localStorage.setItem(KEY_CAMP, 'all');
      } catch (e) {}
      S.notesPage = 1;
      await loadNotes();
      await loadLeads();
      await loadFunnel();
    });
    if ((b = $('ccBtnRescan'))) b.addEventListener('click', function () { scanAll(); });
    /* 作品卡：卡片每次渲染都重建，所以评论按钮走事件委托，不逐张绑 */
    var nb = $('ccNotes');
    if (nb) nb.addEventListener('click', function (e) {
      var lk = e.target && e.target.closest ? e.target.closest('[data-like]') : null;
      if (lk && !lk.disabled) { postLike(Number(lk.getAttribute('data-like')) || 0); return; }
      var t = e.target && e.target.closest ? e.target.closest('[data-cmt]') : null;
      if (!t || t.disabled) return;
      openCmt(Number(t.getAttribute('data-cmt')) || 0);
    });
    if ((b = $('ccBtnBatch'))) b.addEventListener('click', batchComment);
    if ((b = $('ccBtnCmtPause'))) b.addEventListener('click', toggleCmtPause);
    if ((b = $('ccBtnCmtClear'))) b.addEventListener('click', clearCmtQueue);
    if ((b = $('ccCmtClose'))) b.addEventListener('click', closeCmt);
    if ((b = $('ccCmtCancel'))) b.addEventListener('click', closeCmt);
    if ((b = $('ccCmtSend'))) b.addEventListener('click', sendCmt);
    if ((b = $('ccCmtAi'))) b.addEventListener('click', aiDraft);
    if ((b = $('ccCmtLike'))) b.addEventListener('change', function () { S.withLike = !!b.checked; });
    if ((b = $('ccCmtText'))) {
      b.addEventListener('input', updateCmtCnt);
      /* Ctrl/Cmd+Enter 直接发：写长句时手不用离开键盘 */
      b.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendCmt(); }
      });
    }
    var cmtMask = $('ccCmtMask');
    if (cmtMask) cmtMask.addEventListener('click', function (e) { if (e.target === cmtMask) closeCmt(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.cmtIdx >= 0) closeCmt();
    });
    /* 一句话输入：回车开跑；粘贴链接时实时切平台并在提示行说清识别结果 */
    if ((b = $('ccOmni'))) {
      b.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); startFromOmni(); }
      });
      b.addEventListener('input', function () {
        var val = String(b.value || '');
        var d = detectTarget(val);
        if (val && d.type !== 'keyword') setOmniPlatform(d.platform, true);
        var hint = $('ccOmniHint');
        if (hint) {
          hint.textContent = !val ? '粘贴链接自动识别平台与类型 · 默认每小时一轮'
            : '识别为' + (TARGET_LABEL[d.type] || '关键词') + ' · ' + (PF[d.platform] || ['', d.platform])[1] + ' · 每小时一轮';
        }
      });
    }
    if ((b = $('ccPlats'))) b.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-pf]') : null;
      if (t) setOmniPlatform(t.getAttribute('data-pf'));
    });
    if ((b = $('ccWordInput'))) b.addEventListener('keydown', function (e) { if (e.key === 'Enter') addWord(); });
    /* 本机桥状态行：重新检测 / 怎么启动 */
    if ((b = $('ccBridge'))) b.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-bridge]') : null;
      if (!t) return;
      if (t.getAttribute('data-bridge') === 'how') {
        if (window.toast) toast('双击项目里的 ' + BRIDGE_TIP + '（黑窗口别关），回来点「重新检测」', 'info', '本机采集桥');
      } else probeBridge();
    });

    /* 采集账号：添加表单 + 列表操作（事件委托，重渲染后仍然有效） */
    if ((b = $('ccBtnPair'))) b.addEventListener('click', pairDevice);
    if ((b = $('ccBtnLogin'))) b.addEventListener('click', function () { ensureAccountLogin(S.omniPf, {}); });
    if ((b = $('ccBtnNewAcc'))) b.addEventListener('click', function () {
      var f = $('ccAccForm');
      if (!f) return;
      var opening = f.style.display === 'none';
      f.style.display = opening ? '' : 'none';
      if (opening) {
        S.editAccId = '';
        if ($('ccAFSave')) $('ccAFSave').textContent = '保存账号';
        ['ccAFNick', 'ccAFDir', 'ccAFNote', 'ccAFCommentQuota'].forEach(function (id) { var e = $(id); if (e) e.value = ''; });
      }
      var hint = $('ccAFHint');
      if (hint) hint.textContent = '登录态在采集机的浏览器配置目录里；填了目录服务端才能替你检测。';
    });
    if ((b = $('ccAFCancel'))) b.addEventListener('click', function () { $('ccAccForm').style.display = 'none'; });
    if ((b = $('ccAFSave'))) b.addEventListener('click', saveAccount);
    if ((b = $('ccAccs'))) b.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-acc-act]') : null;
      if (!t) return;
      var card = t.closest('.cc-acc');
      if (!card) return;
      accountAct(card.getAttribute('data-aid'), t.getAttribute('data-acc-act'));
    });
    var lt = $('ccLevelTabs');
    if (lt) Array.prototype.forEach.call(lt.querySelectorAll('.cc-tab'), function (el) {
      el.addEventListener('click', function () {
        Array.prototype.forEach.call(lt.querySelectorAll('.cc-tab'), function (x) { x.classList.remove('on'); });
        el.classList.add('on');
        S.level = el.getAttribute('data-level') || '';
        loadFeed();
      });
    });
    var st = $('ccStageTabs');
    if (st) Array.prototype.forEach.call(st.querySelectorAll('.cc-tab'), function (el) {
      el.addEventListener('click', function () {
        Array.prototype.forEach.call(st.querySelectorAll('.cc-tab'), function (x) { x.classList.remove('on'); });
        el.classList.add('on');
        S.stage = el.getAttribute('data-stage') || '';
        loadLeads();
      });
    });

    /* 中栏视图切换：评论流 / 搜到的作品 */
    var vt = $('ccViewTabs');
    if (vt) Array.prototype.forEach.call(vt.querySelectorAll('.cc-tab'), function (el) {
      el.addEventListener('click', function () {
        Array.prototype.forEach.call(vt.querySelectorAll('.cc-tab'), function (x) { x.classList.remove('on'); });
        el.classList.add('on');
        switchView(el.getAttribute('data-view') || 'stream');
      });
    });
  }

  function switchView(v) {
    S.view = v;
    var stream = $('ccStream'), notes = $('ccNotes'), bar = $('ccLevelBar'), title = $('ccMidTitle');
    if (stream) stream.style.display = v === 'stream' ? '' : 'none';
    if (notes) notes.style.display = v === 'notes' ? '' : 'none';
    if (bar) bar.style.display = v === 'stream' ? '' : 'none';
    if (title) title.textContent = v === 'notes' ? '搜到的作品' : '新增评论';
    var nb = $('ccNotesBar');
    if (nb) nb.style.display = v === 'notes' ? '' : 'none';
    if (v === 'notes') {
      if (S.notes.length) renderNotes(); else loadNotes();
    }
  }

  async function refreshAll() {
    if (S.busy) return;
    /* 页面启动时服务端地址还在探测（boot 会逐个候选 ping），
       这时 Api.call 会返回 NO_BFF —— 不是服务挂了，是还没轮到我们。
       遇到就短间隔重试，最多 8 次（约 12 秒），别把「没就绪」当成故障。 */
    if (!window.RT || !RT.bffBase) {
      if (S.retries < 8) {
        S.retries++;
        setTimeout(refreshAll, 1500);
        return;
      }
      showBar('err', '服务端地址未就绪', '刷新页面重试；若持续出现请检查登录状态');
      return;
    }
    S.retries = 0;
    S.busy = true;
    try {
      await loadConfig();
      await loadCampaigns();
      await loadExceptions();
      await loadFunnel();
      await loadFeed();
      await loadLeads();
      await loadNotes();
      await loadComments();
      await loadCmtQueue();
      await loadLikes();
      if (S.view === 'notes') renderNotes();
      renderBar();
    } finally { S.busy = false; }
  }

  function boot() {
    if (S.started) return;
    S.started = true;
    S.words = loadWords();
    bind();
    renderWords();
    renderChan();
    renderBridge();
    renderRunBar();
    renderDevice();
    /* 页面起来先探本机桥：探到就说明扫码窗口会弹在用户眼前 */
    setTimeout(function () { probeBridge(true); }, 900);
    /* 采集器状态：首探 + 6 秒轮询（扩展装上/连上后无需刷新页面就能变绿） */
    setTimeout(function () { probeDevice(); }, 1400);
    S.devTimer = setInterval(function () {
      if (document.hidden || !window.RT || !RT.bffBase) return;
      probeDevice();
    }, 6000);
    /* 延 1.2 秒首刷：给 boot 的服务端地址探测让路，避免 NO_BFF 空转 */
    setTimeout(refreshAll, 1200);
    /* 自适应轮询：有任务在跑就 2.5 秒一跳（过程看得见），空闲时 25 秒一跳。
       固定 30 秒的话，用户点完「点赞」要等半分钟才看到第一步。 */
    S.timer = setInterval(function () {
      if (document.hidden || !window.RT || !RT.bffBase) return;
      if (S.busy) return;
      var active = hasActive();
      if (!active && Date.now() - (S.lastPoll || 0) < 25000) return;
      S.lastPoll = Date.now();
      loadFeed(); loadLeads();
      loadNotes().then(function () { return loadComments(); })
        .then(function () { return loadLikes(); })
        .then(function () { if (S.view === 'notes') renderNotes(); });
    }, 2500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* 切到本视图时补一次刷新，避免长期在别的页面停留导致数据陈旧 */
  document.addEventListener('click', function (e) {
    var n = e.target && e.target.closest ? e.target.closest('[data-view="v-content"]') : null;
    if (n) setTimeout(refreshAll, 260);
  });
  window.__ccConsole = { refresh: refreshAll, state: S };
})();
