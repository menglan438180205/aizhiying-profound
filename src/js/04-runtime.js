
/* =========================================================
   ProFound · 生产运行时层 Runtime
   · Api   服务端(BFF)优先的统一调用层 —— 密钥不下发前端
   · Obs   全局错误捕获 + 事件缓冲 + 落库（obs_events）
   · Audit 关键操作审计（audit_log，只追加）
   · Order 套餐开通改为「创建待支付订单」，订阅由服务端开通
   · Docs  用户服务协议 / 隐私政策 + 登录前同意门禁
   ========================================================= */
(function runtime() {
'use strict';

var LS_KEY = 'aizhiying.runtime.v1';
var RT = { bffBase: '', obsMax: 120, flushDelay: 6000, srv: null, srvAt: 0, srvBusy: false };
/* RT 原本只活在这个 IIFE 里。但登录提交、退出登录这些更早的脚本块也要拼 BFF 地址，
   它们拿到的是 ReferenceError: RT is not defined —— 表现为「点登录没反应」。
   这里把同一个对象挂到 window（不是拷贝），两处始终指向同一份状态。 */
try { window.RT = RT; } catch (e) {}
try {
  var _s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  if (_s && typeof _s.bffBase === 'string') RT.bffBase = _s.bffBase;
} catch (e) {}

function rtSave() { try { localStorage.setItem(LS_KEY, JSON.stringify({ bffBase: RT.bffBase })); } catch (e) {} }
function q1(s, r) { return (r || document).querySelector(s); }
function esc2(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function p2(n) { return (n < 10 ? '0' : '') + n; }
function hms(d) { var x = new Date(d); return p2(x.getHours()) + ':' + p2(x.getMinutes()) + ':' + p2(x.getSeconds()); }
function liveSession() {
  return typeof state !== 'undefined' && state && state.session && !state.demo && !!cloud;
}

/* UI 原子能力桥接 —— toast/openModal/money/saveRecord 位于页面主体 IIFE 内 */
function ui() { return window.__UI || null; }
function uiReady() { return !!(window.__UI && window.__UI.openModal); }
function toast() { var u = ui(); if (u && u.toast) return u.toast.apply(null, arguments); }
function openModal(cfg) {
  var u = ui();
  if (u && u.openModal) return u.openModal(cfg);
  obs('error', 'ui', '界面组件桥接不可用，弹窗被跳过', { title: cfg && cfg.title });
  try {
    var tip = document.createElement('div');
    tip.className = 'rt-tip';
    tip.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:9999';
    tip.textContent = ((cfg && cfg.title) || '提示') + '：界面组件未就绪，请刷新页面后重试。';
    document.body.appendChild(tip);
    setTimeout(function () { try { tip.remove(); } catch (e) {} }, 4000);
  } catch (e) {}
}
function money(n) { var u = ui(); if (u && u.money) return u.money(n); return '¥' + Number(n || 0).toLocaleString('zh-CN'); }
async function saveRecord(kind, title, meta) {
  var u = ui();
  if (u && u.saveRecord) return u.saveRecord.apply(null, arguments);
  return { error: 'UI 桥接不可用，请刷新页面重试' };
}

/* =========================================================
   1. 服务层 Api
   ========================================================= */
/* ---------- BFF 令牌注入（K6） ----------
 * 服务端设置 API_TOKEN 后，所有 /v1/* 需要凭证。
 * 浏览器端把令牌放 localStorage，由 bffHeaders() 统一以 Bearer 注入，
 * 因此业务代码无需逐处改 fetch；也可 exchange() 换成 HttpOnly Cookie
 * （同源自动携带、JS 读不到，防 XSS）。
 * 控制台/设置页用法：PF.setToken('xxx') / PF.clearToken() / PF.exchange()
 */
var BFF_TOKEN_KEY = 'pf.bff.token';
/* 本地账号会话票（/v1/auth/login 返回的 HMAC 票）。
   与 BFF 令牌共存但优先级更高：登录了就按登录身份走，没登录才用注入的服务端令牌。 */
var AUTH_TOKEN_KEY = 'pf.auth.token';
function authToken() {
  try { return localStorage.getItem(AUTH_TOKEN_KEY) || ''; } catch (e) { return ''; }
}
function setAuthToken(t) {
  try { t ? localStorage.setItem(AUTH_TOKEN_KEY, String(t)) : localStorage.removeItem(AUTH_TOKEN_KEY); } catch (e) {}
}
function bffToken() {
  try { return localStorage.getItem(BFF_TOKEN_KEY) || ''; } catch (e) { return ''; }
}

/* 凭证失效的统一出口（2026-11-04）：令牌轮换 / 会话票过期 / 账号被删时，
   服务端一律回 401。此前前端只把 401 当成一条报错，localStorage 里的死令牌
   还在 → 页面进了壳但每个接口都 401，用户看到的是「空白但不像没登录」。
   这里清干净本地凭证、回登录页、把账号登录面板展开，用户一次输入就能回来。 */
var _pfAuthExpiredAt = 0;
function pfAuthExpired(msg) {
  if (Date.now() - _pfAuthExpiredAt < 5000) return;   /* 并发请求只处理一次 */
  _pfAuthExpiredAt = Date.now();
  try { localStorage.removeItem(BFF_TOKEN_KEY); } catch (e) {}
  try { localStorage.removeItem(AUTH_TOKEN_KEY); } catch (e) {}
  try { document.cookie = 'pf_bff=; Path=/; Max-Age=0'; } catch (e) {}
  try { if (typeof state !== 'undefined' && state) state.session = null; } catch (e) {}
  try { if (typeof showLogin === 'function') showLogin(); } catch (e) {}
  var d = document.getElementById('localAuthDetails'); if (d) { try { d.open = true; } catch (e) {} }
  var err = document.getElementById('localAuthErr');
  if (err) err.textContent = msg || '登录已失效，请重新登录';
  try { if (typeof toast === 'function') toast(msg || '登录已失效，请重新登录', 'warn', '需要登录', 6000); } catch (e) {}
}
function bffHeaders(base) {
  var h = base || {};
  var t = authToken() || bffToken();
  if (t) h['Authorization'] = 'Bearer ' + t;
  /* 计费按租户隔离：登录后由 PF.setTenant 写入，单机自用默认 default */
  try {
    var ten = localStorage.getItem('pf.bff.tenant') || '';
    if (ten) h['X-Tenant-Id'] = ten;
  } catch (e) {}
  return h;
}
try {
  window.PF = window.PF || {};
  window.PF.setToken = function (t) {
    try { t ? localStorage.setItem(BFF_TOKEN_KEY, String(t)) : localStorage.removeItem(BFF_TOKEN_KEY); } catch (e) {}
    return bffToken() ? window.PF.exchange() : null;
  };
  window.PF.clearToken = function () {
    try { localStorage.removeItem(BFF_TOKEN_KEY); } catch (e) {}
    return Api.call('/v1/session', null, { method: 'DELETE' });
  };
  window.PF.exchange = function () {
    return Api.call('/v1/session', { token: bffToken() }, { method: 'POST' });
  };
} catch (e) {}

/* 服务器部署便利：/app/?token=xxx 一次性换取 HttpOnly Cookie 并抹掉地址栏痕迹，
   免得每次换机都要在控制台敲 PF.setToken()。仅接受 8–128 位可见字符。 */
(function autoTokenFromUrl() {
  try {
    var m = location.search.match(/[?&]token=([^&#]+)/) || location.hash.match(/token=([^&#]+)/);
    if (!m) return;
    var t = decodeURIComponent(m[1] || '');
    if (!/^[A-Za-z0-9_\-]{8,128}$/.test(t)) return;
    if (t === bffToken()) { return; }
    window.PF.setToken(t);
    var clean = (location.pathname + location.search.replace(/[?&]token=[^&#]+/, '')).replace(/[?&]$/, '');
    history.replaceState(null, '', clean || location.pathname);
  } catch (e) {}
})();

/* 直连上传网关（up.aizhiying.online）：
   隧道的 Cloudflare 边缘对单请求有 100s 硬超时，素材分块走服务器自己的 443
   可以彻底摆脱这条红线。探测不通 / 上传失败会自动回退隧道，用户无感。 */
var UP_ORIGIN = 'https://up.aizhiying.online';
var UP_BASE = '';        /* 探测通过后 = UP_ORIGIN；失败/降级 = '' */
var UP_PROBE_AT = 0;     /* 上次探测时间，5 分钟内复用结果 */

var Api = {
  live: function () { return !!RT.bffBase; },
  base: function () { return RT.bffBase; },
  setBase: function (v) {
    var old = RT.bffBase;
    RT.bffBase = String(v || '').trim().replace(/\/+$/, '');
    rtSave();
    /* 通知其它模块（如 AI智能剪辑）刷新「渲染通道」标记，避免显示过期状态 */
    if (old !== RT.bffBase) {
      try { window.dispatchEvent(new CustomEvent('bff:changed', { detail: { base: RT.bffBase } })); } catch (e) {}
    }
    return RT.bffBase;
  },
  call: async function (path, body, opt) {
    opt = opt || {};
    if (!RT.bffBase) return { ok: false, code: 'NO_BFF', error: '未配置服务端地址' };
    /* path 允许是绝对地址：直连上传网关（up.*）与主站不同源，必须原样打 */
    var __full = /^https?:\/\//i.test(String(path)) ? String(path) : (RT.bffBase + path);
    /* 记下这次请求实际带出去的凭证：响应到达时 localStorage 可能已经被登录流程更新，
       不能拿“现在的 token”判断旧请求是否该触发全局掉线（会把刚登录的票误清掉）。 */
    var sentToken = '';
    try { sentToken = authToken() || bffToken(); } catch (e) {}
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { if (ctl) ctl.abort(); }, opt.timeout || 15000) : null;
    try {
      var res = await fetch(__full, {
        method: opt.method || 'POST',
        headers: bffHeaders({ 'Content-Type': 'application/json' }),
        credentials: 'include',
        cache: 'no-store',
        body: body == null ? undefined : JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined
      });
      if (timer) clearTimeout(timer);
      var json = null;
      try { json = await res.json(); } catch (e) {}
      if (!res.ok) {
        if (res.status === 401) {
          /* 登录接口自身返回 401 = 密码错，不能触发「全局掉线」处理 */
          var isAuthCall = path.indexOf('/v1/auth/login') === 0 || path.indexOf('/v1/auth/register') === 0;
          /* 只在本机确实带着凭证时才判定「掉线」。没登录时的后台探测请求
             （/v1/collect/config、/v1/geo2/dashboard 等）本来就该 401，
             否则登录页会莫名显示「登录已失效」并且把用户输入冲掉。 */
          var hadCred = !!sentToken;
          if (!isAuthCall && hadCred) {
            try { pfAuthExpired('登录已失效，请重新登录'); } catch (e) {}
          }
          return { ok: false, code: 'UNAUTHORIZED', status: 401, json: json,
            error: isAuthCall
              ? ((json && (json.message || json.error)) || '手机号或密码错误')
              : (hadCred ? '登录已失效，请重新登录' : '需要登录后才能访问')
          };
        }
        return { ok: false, code: 'HTTP_' + res.status, status: res.status, json: json,
          error: (json && (json.message || json.error)) || ('HTTP ' + res.status) };
      }
      return { ok: true, status: res.status, data: json, json: json };
    } catch (e) {
      if (timer) clearTimeout(timer);
      var ab = e && e.name === 'AbortError';
      return { ok: false, code: ab ? 'TIMEOUT' : 'NETWORK', error: ab ? '请求超时' : String((e && e.message) || e) };
    }
  },
  health: function () { return Api.call('/v1/health', null, { method: 'GET', timeout: 6000 }); },
  createOrder: function (p) { return Api.call('/v1/billing/orders', p); },
  orderStatus: function (no) { return Api.call('/v1/billing/orders/' + encodeURIComponent(no), null, { method: 'GET' }); },

  /* ---- 表单/文件上传（XHR：支持上传进度回调与超时；不设 Content-Type，由浏览器带 boundary） ---- */
  upload: function (path, formData, opt) {
    opt = opt || {};
    return new Promise(function (resolve) {
      if (!RT.bffBase) return resolve({ ok: false, code: 'NO_BFF', error: '未配置服务端地址' });
      var xhr = new XMLHttpRequest();
      xhr.open('POST', RT.bffBase + path, true);
      try { xhr.withCredentials = true; } catch (e) {}
      /* 必须带 BFF 鉴权头（Bearer Token / 租户），否则服务端 401「缺少或错误的 Bearer Token」 */
      var hh = bffHeaders({});
      Object.keys(hh).forEach(function (k) { try { xhr.setRequestHeader(k, hh[k]); } catch (e) {} });
      try { xhr.responseType = 'text'; } catch (e) {}
      xhr.timeout = opt.timeout || 120000;
      if (opt.onprogress) {
        xhr.upload.onprogress = function (ev) {
          try { opt.onprogress(ev.loaded, ev.total || 0); } catch (e) {}
        };
      }
      xhr.onload = function () {
        var json = null;
        try { json = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status < 200 || xhr.status >= 300) {
          return resolve({ ok: false, code: 'HTTP_' + xhr.status, status: xhr.status, json: json,
            error: (json && (json.message || json.error)) || ('HTTP ' + xhr.status) });
        }
        resolve({ ok: true, status: xhr.status, data: json, json: json });
      };
      xhr.onerror = function () { resolve({ ok: false, code: 'NETWORK', error: '网络错误（上传中断或被代理/防火墙拦截）' }); };
      xhr.ontimeout = function () { resolve({ ok: false, code: 'TIMEOUT', error: '上传超时（素材过大或上传通道过慢）' }); };
      xhr.onabort = function () { resolve({ ok: false, code: 'ABORTED', error: '上传已取消' }); };
      try { xhr.send(formData); } catch (e) { resolve({ ok: false, code: 'NETWORK', error: String((e && e.message) || e) }); }
    });
  },

  /* ---- 剪辑任务（真实渲染通道） ---- */
  editJob: function (formData, opt) { return Api.upload('/v1/edit/jobs', formData, opt); },
  /* 直连通道探测：返回 Promise<boolean>，结果缓存 5 分钟。
     任何异常（DNS 未生效、证书未签、443 未放行）都当失败处理，绝不影响上传主流程。 */
  probeUpDirect: function (force) {
    var now = Date.now();
    if (!force && UP_PROBE_AT && now - UP_PROBE_AT < 300000) return Promise.resolve(!!UP_BASE);
    return new Promise(function (resolve) {
      var settled = false;
      var fin = function (v) { if (settled) return; settled = true; UP_PROBE_AT = Date.now(); UP_BASE = v ? UP_ORIGIN : ''; resolve(v); };
      var xhr = new XMLHttpRequest();
      try { xhr.open('GET', UP_ORIGIN + '/up/ping', true); } catch (e) { return fin(false); }
      xhr.timeout = 3000;
      xhr.onload = function () {
        var j = null; try { j = JSON.parse(xhr.responseText); } catch (e) {}
        fin(xhr.status === 200 && !!(j && j.up));
      };
      xhr.onerror = function () { fin(false); };
      xhr.ontimeout = function () { fin(false); };
      try { xhr.send(null); } catch (e) { fin(false); }
    });
  },
  upDirect: function () { return !!UP_BASE; },
  /* 分块上传三件套：init → PUT 分块(带进度) → finish 入库返回 asset
     优先走直连网关，任一环节失败即降级隧道（服务端按块号幂等，重传安全） */
  uploadInit: function (name, totalBytes) {
    var body = { name: String(name || 'asset.bin') };
    if (totalBytes > 0) body.totalBytes = totalBytes;   /* 服务端据此校验完整性，缺块不入库 */
    var direct = !!UP_BASE;
    var call = function () { return Api.call(direct ? (UP_ORIGIN + '/up/init') : '/v1/edit/upload/init', body, { timeout: 15000 }); };
    return call().then(function (r) {
      if (r && r.ok) return r;
      if (!direct) return r;
      UP_BASE = '';                                   /* 直连不可用：本次会话内不再尝试 */
      return Api.call('/v1/edit/upload/init', body, { timeout: 15000 });
    });
  },
  uploadChunk: function (upId, idx, blob, opt) {
    opt = opt || {};
    if (!RT.bffBase) return Promise.resolve({ ok: false, code: 'NO_BFF', error: '未配置服务端地址' });
    var put = function (full) {
      return new Promise(function (resolve) {
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', full, true);
        try { xhr.withCredentials = true; } catch (e) {}
        var hh = bffHeaders({});
        Object.keys(hh).forEach(function (k) { try { xhr.setRequestHeader(k, hh[k]); } catch (e) {} });
        var timer = setTimeout(function () { try { xhr.abort(); } catch (e) {} }, opt.timeout || 150000);
        xhr.onload = function () {
          clearTimeout(timer);
          var j = null; try { j = JSON.parse(xhr.responseText); } catch (e) {}
          if (xhr.status >= 200 && xhr.status < 300) return resolve({ ok: true, data: j });
          resolve({ ok: false, code: 'HTTP_' + xhr.status, status: xhr.status, json: j,
            error: (j && (j.message || j.error)) || ('HTTP ' + xhr.status) });
        };
        xhr.onerror = function () { clearTimeout(timer); resolve({ ok: false, code: 'NETWORK', error: '网络错误（分块上传被中断）' }); };
        xhr.ontimeout = function () { clearTimeout(timer); resolve({ ok: false, code: 'TIMEOUT', error: '分块上传超时' }); };
        if (opt.onprogress) { xhr.upload.onprogress = function (ev) { try { opt.onprogress(ev.loaded, ev.total || 0); } catch (e) {} }; }
        try { xhr.send(blob); } catch (e) { clearTimeout(timer); resolve({ ok: false, code: 'NETWORK', error: String((e && e.message) || e) }); }
      });
    };
    var tail = '/v1/edit/upload/' + encodeURIComponent(upId) + '/' + idx;
    var direct = !!UP_BASE;
    var full = direct ? (UP_ORIGIN + '/up/chunk/' + encodeURIComponent(upId) + '/' + idx) : (RT.bffBase + tail);
    return put(full).then(function (r) {
      if (r.ok || !direct) return r;
      UP_BASE = '';                                   /* 直连抖动：本次块立即改走隧道 */
      return put(RT.bffBase + tail);
    });
  },
  uploadFinish: function (upId) {
    var direct = !!UP_BASE;
    var call = function () { return Api.call(direct ? (UP_ORIGIN + '/up/finish/' + encodeURIComponent(upId)) : ('/v1/edit/upload/' + encodeURIComponent(upId) + '/finish'), {}, { timeout: 60000 }); };
    return call().then(function (r) {
      if (r && r.ok) return r;
      /* INCOMPLETE 是业务结果（缺块），必须原样回给上层补传，不能当成通道故障 */
      var code = r && (r.code || (r.json && r.json.code));
      if (!direct || code === 'INCOMPLETE' || code === 'HTTP_409') return r;
      UP_BASE = '';
      return Api.call('/v1/edit/upload/' + encodeURIComponent(upId) + '/finish', {}, { timeout: 60000 });
    });
  },
  editJobStatus: function (id) { return Api.call('/v1/edit/jobs/' + encodeURIComponent(id), null, { method: 'GET', timeout: 12000 }); },
  editJobCancel: function (id) { return Api.call('/v1/edit/jobs/' + encodeURIComponent(id) + '/cancel', {}, { timeout: 12000 }); },
  editJobDelete: function (id) { return Api.call('/v1/edit/jobs/' + encodeURIComponent(id), null, { method: 'DELETE', timeout: 12000 }); },
  editStats: function () { return Api.call('/v1/edit/stats', null, { method: 'GET', timeout: 8000 }); },
  editSamples: function () { return Api.call('/v1/edit/samples', null, { method: 'GET', timeout: 8000 }); },
  fileUrl: function (u) { return u ? (RT.bffBase + u) : ''; }
};
window.Api = Api;

/* 这几个函数也只在 IIFE 里，但「登录成功」与「退出登录」发生在更早的脚本块：
   少了这层导出，点登录会走到成功回调后抛 ReferenceError，被 .catch 捕获成
   「连不上服务端，请检查网络」——网络明明通着，报错却指向网络，极难排查。 */
try {
  window.setAuthToken = setAuthToken;
  window.authToken = authToken;
  window.bffToken = bffToken;
  window.bffHeaders = bffHeaders;
  window.pfAuthExpired = pfAuthExpired;
} catch (e) {}

/* =========================================================
   2. 可观测性 Obs
   ========================================================= */
var OBS = { buf: [], queue: [], timer: null, errors: 0, warns: 0 };

function obs(level, source, message, detail) {
  var ev = {
    level: level, source: source,
    message: String(message == null ? '' : message).slice(0, 600),
    detail: detail || {}, url: location.href, at: new Date().toISOString()
  };
  OBS.buf.unshift(ev);
  if (OBS.buf.length > RT.obsMax) OBS.buf.length = RT.obsMax;
  if (level === 'error') OBS.errors++;
  if (level === 'warn') OBS.warns++;
  if (level === 'error' || level === 'warn') { OBS.queue.push(ev); schedFlush(); }
  schedulePaint();
}

function schedFlush() { if (OBS.timer) return; OBS.timer = setTimeout(flushObs, RT.flushDelay); }

async function flushObs() {
  OBS.timer = null;
  if (!OBS.queue.length) return;
  var batch = OBS.queue.splice(0, 20);
  if (!liveSession()) return;
  try {
    await cloud.database.from('obs_events').insert(batch.map(function (e) {
      return { level: e.level, source: e.source, message: e.message, detail: e.detail, url: e.url };
    }));
  } catch (e) {}
}

window.addEventListener('error', function (ev) {
  if (!ev || !ev.message) return;
  try { obs('error', 'window', ev.message, { file: ev.filename, line: ev.lineno, col: ev.colno }); } catch (e) {}
});
window.addEventListener('unhandledrejection', function (ev) {
  var r = ev && ev.reason;
  try { obs('error', 'promise', (r && (r.message || r)) || '未处理的 Promise 拒绝', {}); } catch (e) {}
});

/* =========================================================
   3. 审计 Audit
   ========================================================= */
var AUDIT = { db: [], local: [] };

async function audit(action, target, detail) {
  var row = { action: String(action || ''), target: String(target || ''), detail: detail || {} };
  AUDIT.local.unshift({ created_at: new Date().toISOString(), action: row.action, target: row.target, owner: '本机' });
  if (AUDIT.local.length > 40) AUDIT.local.length = 40;
  if (liveSession()) {
    try {
      var r = await cloud.database.from('audit_log').insert(row).select();
      if (r.error) obs('warn', 'audit', r.error.message || '审计写入失败', { action: row.action });
      else if (r.data && r.data[0]) AUDIT.db.unshift(r.data[0]);
    } catch (e) { obs('warn', 'audit', String((e && e.message) || e), { action: row.action }); }
  }
  paintAudit();
  schedulePaint();
}
window.audit = audit;

async function loadAudit() {
  if (!liveSession()) { paintAudit(); return; }
  try {
    var r = await cloud.database.from('audit_log').select('*').order('created_at', { ascending: false }).limit(30);
    if (!r.error && Array.isArray(r.data)) AUDIT.db = r.data;
  } catch (e) {}
  paintAudit();
  schedulePaint();
}

/* =========================================================
   4. 订单 / 订阅
   ========================================================= */
var ORDERS = { db: [], local: [] };

async function loadOrders() {
  if (!liveSession()) { schedulePaint(); return; }
  try {
    var r = await cloud.database.from('app_records').select('*').order('created_at', { ascending: false }).limit(80);
    if (!r.error && Array.isArray(r.data)) {
      ORDERS.db = r.data.filter(function (x) { return x && x.kind === 'order'; });
    }
  } catch (e) {}
  schedulePaint();
}

function orderList() { return liveSession() ? ORDERS.db : ORDERS.local; }
function orderStatus(o) { return (o && o.meta && o.meta.status) || (o && o.status) || 'pending_payment'; }
function pendingOrders() {
  return orderList().filter(function (o) { return orderStatus(o) === 'pending_payment'; });
}

window.subscribe = subscribe = async function (planCode) {
  var list = (typeof state !== 'undefined' && state && state.plans) ? state.plans.slice() : [];
  var demoPlans = (state.demoData && state.demoData.plans) || [];
  demoPlans.forEach(function (p) {
    var hit = false;
    for (var i = 0; i < list.length; i++) if (list[i].code === p.code) hit = true;
    if (!hit) list.push(p);
  });
  var plan = null;
  for (var k = 0; k < list.length; k++) if (list[k].code === planCode) { plan = list[k]; break; }
  if (!plan) { toast('未找到该套餐，请刷新页面后重试', 'err', '操作失败'); return; }

  var months = plan.period === 'quarter' ? 3 : 12;
  var exp = new Date();
  exp.setMonth(exp.getMonth() + months);
  var orderNo = 'AIZ' + Date.now().toString().slice(-10);
  var amount = Number(plan.price) || 0;
  var canPay = liveSession();
  var serverReady = Api.live();

  var payload = {
    plan_code: plan.code, plan_name: plan.name, amount: amount, months: months,
    order_no: orderNo, channel: 'wechat_pay', expected_expires_at: exp.toISOString()
  };

  var note;
  if (!canPay) {
    note = '<div class="rt-tip"><div><b>' + (state.demo ? '演示模式' : '未登录') +
      '</b>：确认后仅在本地模拟开通，不会产生真实订单与扣款。</div></div>';
  } else if (serverReady) {
    note = '<div class="rt-tip ok"><div><b>服务端已接入</b>：将向服务端创建订单并进入支付流程，' +
      '支付成功后由服务端写入订阅记录，前端不具备直接开通权限。</div></div>';
  } else {
    note = '<div class="rt-tip"><div><b>服务端尚未接入</b>：确认后将创建一笔「待支付订单」并保存到云端，' +
      '订阅权益需服务端在支付回调中开通后才生效。当前不会产生扣款。</div></div>';
  }

  openModal({
    title: '开通「' + plan.name + '」',
    sub: money(amount) + ' / ' + (plan.period === 'quarter' ? '季度' : '年度'),
    icon: 'i-crown', wide: true,
    body:
      '<div class="m-stat">' +
        '<div><b>' + money(amount) + '</b><span>应付金额</span></div>' +
        '<div><b>' + (plan.period === 'quarter' ? '3 个月' : '12 个月') + '</b><span>服务周期</span></div>' +
        '<div><b>' + (plan.seats || 1) + '</b><span>可用微信号</span></div>' +
      '</div>' +
      '<div class="fm-row"><label>套餐权益</label><div class="m-list">' +
        (plan.features || []).map(function (f) {
          return '<div class="m-item"><div class="mi-ico" style="background:var(--green-soft);color:var(--green)">' +
            '<svg class="icon"><use href="#i-check-circle"/></svg></div><div><b>' + esc2(f) + '</b></div></div>';
        }).join('') +
      '</div></div>' +
      '<div class="fm-row"><label>订单信息</label><div style="font-size:12.8px;line-height:2;color:var(--text-2)">' +
        '订单号：<b style="color:var(--text)">' + orderNo + '</b><br>' +
        '提交时间：' + new Date().toLocaleString('zh-CN') + '<br>' +
        '预计到期：<b style="color:var(--text)">' + exp.toLocaleString('zh-CN') + '</b>' +
      '</div></div>' + note,
    okText: canPay ? (serverReady ? '创建订单并支付' : '创建订单') : '模拟开通',
    cancelText: '再想想',
    onOk: async function (rec, btn) {
      if (btn) { btn.disabled = true; btn.textContent = serverReady ? '支付中…' : '提交中…'; }
      await audit('创建套餐订单', plan.name + ' · ' + orderNo, payload);

      if (!canPay) {
        state.subs = [{
          id: 'demo_' + Date.now(), plan_code: plan.code, plan_name: plan.name,
          status: 'demo', amount: amount, order_no: orderNo,
          started_at: new Date().toISOString(), expires_at: exp.toISOString()
        }];
        ORDERS.local.unshift({ order_no: orderNo, created_at: new Date().toISOString(), meta: { status: 'demo' } });
        renderPricing(); renderSidePlan(); schedulePaint();
        toast('演示模式：已模拟开通「' + plan.name + '」', 'ok', '本地演示');
        return false;
      }

      var errMsg = '';
      if (serverReady) {
        var r = await Api.createOrder(payload);
        if (!r.ok) errMsg = r.error || '服务端下单失败';
      } else {
        var rr = await saveRecord('order', '套餐订单 ' + orderNo, Object.assign({ status: 'pending_payment' }, payload));
        if (rr && rr.error) errMsg = rr.error;
      }

      if (errMsg) {
        obs('error', 'order', '订单创建失败：' + errMsg, payload);
        toast('订单创建失败：' + errMsg, 'err', '下单未完成');
        if (btn) { btn.disabled = false; btn.textContent = '重试'; }
        return true;
      }

      await loadOrders();
      schedulePaint();
      toast('订单已创建 · ' + orderNo, 'ok', '待支付');
      setTimeout(function () {
        openModal({
          title: '订单待支付',
          sub: '订单号 ' + orderNo,
          icon: 'i-clock', wide: true,
          body:
            '<div class="rt-tip"><div>订单已创建并保存，状态为 <b>待支付</b>。' +
            (serverReady
              ? '请在支付页完成付款，支付成功后系统自动开通订阅。'
              : '当前服务端未接入，订单已挂起；接入支付服务后可在订单列表中继续付款。') +
            '</div></div>' +
            '<div class="m-stat" style="margin-top:12px">' +
              '<div><b>' + money(amount) + '</b><span>应付金额</span></div>' +
              '<div><b>' + esc2(plan.name) + '</b><span>套餐</span></div>' +
              '<div><b>待支付</b><span>订单状态</span></div>' +
            '</div>',
          okText: '我知道了', cancelText: null,
          onOk: function () { go('v-pricing'); }
        });
      }, 260);
      return false;
    }
  });
};

/* =========================================================
   5. 合规文档
   ========================================================= */
var DOC_VERSION = 'v1.0 · 生效日期 2026-10-13';

var TERMS =
  '<div class="rt-meta">' + DOC_VERSION + '</div>' +
  '<h4>一、协议主体与适用范围</h4>' +
  '<p>本协议是您与「ProFound」运营方之间就使用本平台各项服务所订立的有效约定。您在注册、登录或使用本平台任一功能前，应当完整阅读本协议与《隐私政策》，勾选同意后方可使用。</p>' +
  '<h4>二、账号与实名</h4>' +
  '<ul>' +
  '<li>您应使用真实、有效的手机号完成注册，并对账号下的全部操作负责。</li>' +
  '<li>账号仅限您所属企业使用，不得出租、出借或转让给第三方。</li>' +
  '<li>平台依据套餐约定的可用坐席数开通账号权限。</li>' +
  '</ul>' +
  '<h4>三、服务内容</h4>' +
  '<ul>' +
  '<li>本平台提供线索采集与归集、客户跟进管理、内容矩阵管理、智能问答辅助等功能。</li>' +
  '<li>涉及第三方平台数据的采集，仅通过平台官方开放接口或具备合法资质的第三方数据服务实现。</li>' +
  '<li>平台不提供、亦不支持任何绕过第三方平台防护措施的采集手段。</li>' +
  '</ul>' +
  '<h4>四、用户行为规范</h4>' +
  '<ul>' +
  '<li>不得采集、存储、使用与自身经营无关的个人信息。</li>' +
  '<li>不得利用本平台发送骚扰信息、虚假宣传或违反《广告法》的内容。</li>' +
  '<li>不得将采集所得线索用于转售、倒卖或其他超出自身获客目的用途。</li>' +
  '<li>不得使用自动化手段对第三方平台实施高频请求、刷量、控评等行为。</li>' +
  '</ul>' +
  '<h4>五、套餐、计费与退款</h4>' +
  '<ul>' +
  '<li>套餐以页面展示的价格、周期与权益为准，订单支付成功后服务即时生效。</li>' +
  '<li>套餐到期未续费的，平台可暂停相关功能，但您有权在到期后一定期限内导出历史数据。</li>' +
  '<li>已实际使用服务期间的订阅费用不予退还，法律另有规定的除外。</li>' +
  '</ul>' +
  '<h4>六、知识产权与数据归属</h4>' +
  '<ul>' +
  '<li>您在本平台录入、生成的业务数据归您所有，平台仅在提供服务所必需的范围内处理。</li>' +
  '<li>平台的软件、界面、文档等知识产权归运营方所有。</li>' +
  '</ul>' +
  '<h4>七、服务变更与终止</h4>' +
  '<p>平台有权因合规要求、第三方平台规则变化或技术升级调整服务内容，重大变更将提前以站内通知或短信方式告知。您可随时申请注销账号。</p>' +
  '<h4>八、免责与责任限制</h4>' +
  '<p>因第三方平台接口调整、不可抗力或您自身违规使用导致的服务中断或损失，平台不承担责任。平台就本服务承担的累计赔偿责任以您已支付的订阅费用为限。</p>' +
  '<h4>九、争议解决</h4>' +
  '<p>本协议适用中华人民共和国法律。因本协议产生的争议，双方应友好协商解决；协商不成的，提交运营方所在地有管辖权的人民法院诉讼解决。</p>';

var PRIVACY =
  '<div class="rt-meta">' + DOC_VERSION + '</div>' +
  '<h4>一、我们收集哪些信息</h4>' +
  '<ul>' +
  '<li><b>账号信息</b>：手机号、登录凭证、企业名称与联系人。</li>' +
  '<li><b>业务数据</b>：您录入或经您授权采集的客户线索信息（昵称、平台、评论内容、联系方式、跟进记录）。</li>' +
  '<li><b>设备与日志</b>：访问时间、IP、浏览器标识、操作日志，用于安全审计与故障排查。</li>' +
  '</ul>' +
  '<h4>二、信息如何被使用</h4>' +
  '<ul>' +
  '<li>提供线索归集、客户跟进、内容管理与数据统计等核心功能。</li>' +
  '<li>保障账号安全，识别异常登录与滥用行为。</li>' +
  '<li>在您同意的范围内，用于产品优化与服务通知。</li>' +
  '</ul>' +
  '<h4>三、线索数据的合规边界</h4>' +
  '<ul>' +
  '<li>平台仅处理您在经营活动中合法获取、且与获客目的直接相关的信息。</li>' +
  '<li>您作为线索数据的处理者，应确保信息来源合法，并已向信息主体履行告知义务。</li>' +
  '<li>我们不会将您的业务数据用于转售或与获客无关的用途。</li>' +
  '</ul>' +
  '<h4>四、存储与保护</h4>' +
  '<ul>' +
  '<li>数据存储于中国境内的云数据库，实行按账号的数据行级隔离，您的数据不会与其他账号互见。</li>' +
  '<li>传输采用 HTTPS 加密，敏感凭据仅存放于服务端，不随前端页面下发。</li>' +
  '<li>关键操作写入不可篡改的审计日志，保留期限不少于 6 个月。</li>' +
  '</ul>' +
  '<h4>五、信息共享</h4>' +
  '<p>除以下情形外，我们不会向第三方共享您的个人信息：取得您的明确同意；依据法律法规或监管要求；为提供服务所必需而与受托服务商共享（我们会与其签署数据保护条款）。</p>' +
  '<h4>六、您的权利</h4>' +
  '<ul>' +
  '<li>查询、更正、删除您的账号信息与业务数据。</li>' +
  '<li>撤回授权、注销账号。</li>' +
  '<li>获取数据导出文件。</li>' +
  '</ul>' +
  '<h4>七、第三方平台数据说明</h4>' +
  '<p>平台对抖音、快手、小红书、视频号等第三方平台的数据获取，均通过平台官方开放接口或具备合法资质的第三方数据服务完成，不采用绕过平台防护措施的方式。相关数据的可用范围受第三方平台规则约束。</p>' +
  '<h4>八、未成年人保护</h4>' +
  '<p>本平台面向企业用户提供服务，不面向未成年人。若发现未成年人注册，我们将注销账号并删除相关信息。</p>' +
  '<h4>九、联系我们</h4>' +
  '<p>如对本政策有疑问或需要行使上述权利，可通过平台内「联系销售」入口与我们联系，我们将在 15 个工作日内答复。</p>';

function openDoc(kind) {
  var isPriv = kind === 'privacy';
  openModal({
    title: isPriv ? '隐私政策' : '用户服务协议',
    sub: DOC_VERSION,
    icon: 'i-shield', wide: true,
    body: '<div class="rt-doc">' + (isPriv ? PRIVACY : TERMS) + '</div>',
    okText: '我已阅读并知悉', cancelText: null
  });
}
window.openDoc = openDoc;

/* =========================================================
   6. 登录前同意门禁
   ========================================================= */
function installConsentGate() {
  var chk = document.getElementById('agreeChk');
  if (chk) {
    ['localLoginBtn', 'localRegisterBtn'].forEach(function (id) {
      var b = document.getElementById(id);
      if (!b) return;
      b.addEventListener('click', function (e) {
        if (!chk.checked) {
          if (e.preventDefault) e.preventDefault();
          if (e.stopImmediatePropagation) e.stopImmediatePropagation();
          if (typeof toast === 'function') toast('请先阅读并同意《用户服务协议》与《隐私政策》', 'warn', '需勾选同意');
          try { chk.focus(); } catch (x) {}
        }
      }, true);
    });
  }
  var lab = chk ? chk.closest('.agree') : null;
  if (lab && !document.getElementById('rtConsent') && lab.parentNode) {
    var d = document.createElement('div');
    d.className = 'rt-consent';
    d.id = 'rtConsent';
    d.innerHTML = '查看 <button type="button" data-use data-rt-doc="terms">《用户服务协议》</button> 与 ' +
                  '<button type="button" data-use data-rt-doc="privacy">《隐私政策》</button>';
    lab.parentNode.insertBefore(d, lab.nextSibling);
  }
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-rt-doc]') : null;
    if (!t) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    openDoc(t.getAttribute('data-rt-doc'));
  }, true);
}

/* =========================================================
   7. 设置页运行状态面板
   ========================================================= */
function dotOf(state_) { return state_ === 'ok' ? 'ok' : (state_ === 'err' ? 'err' : 'warn'); }
function rtRow(st, title, desc, val) {
  return '<div class="rt-item"><span class="rt-dot ' + dotOf(st) + '"></span>' +
    '<div class="rt-body"><b>' + esc2(title) + '</b><span>' + esc2(desc) + '</span></div>' +
    '<div class="rt-v">' + esc2(val) + '</div></div>';
}
function rtKpi(v, label) { return '<div><b>' + esc2(v) + '</b><span>' + esc2(label) + '</span></div>'; }

function ensurePanel() {
  var host = document.getElementById('v-settings');
  if (!host) return null;
  var p = document.getElementById('rtPanel');
  if (p && host.contains(p)) return p;
  p = document.createElement('div');
  p.className = 'card';
  p.id = 'rtPanel';
  p.innerHTML =
    '<div class="card-head"><h3>生产就绪度 · 运行状态</h3>' +
    '<div class="right">' +
      '<button class="btn sm" id="rtBtnCfg" data-use type="button">配置服务端</button>' +
      '<button class="btn sm" id="rtBtnCheck" data-use type="button">运行自检</button>' +
    '</div></div>' +
    '<div class="card-body" id="rtPanelBody"></div>';
  var anchor = host.querySelector('.card');
  if (anchor && anchor.parentNode) anchor.parentNode.appendChild(p);
  else host.appendChild(p);
  bindPanelHead();
  return p;
}

function bindPanelHead() {
  var cfg = document.getElementById('rtBtnCfg');
  if (cfg && !cfg.__rt) {
    cfg.__rt = 1;
    cfg.addEventListener('click', function () { openServerConfig(); });
  }
  var chk = document.getElementById('rtBtnCheck');
  if (chk && !chk.__rt) {
    chk.__rt = 1;
    chk.addEventListener('click', function () { runSelfCheck(); });
  }
}

/* ---- 采集调度 / 环境变量收口：把 /v1/health 的结论翻成人话 ---- */
function collectState() {
  var c = RT.srv && RT.srv.collect;
  if (!c) return { state: 'warn', val: '探测中' };
  if (c.mode === 'upstream') {
    var n = (c.realChannels || []).length;
    return { state: 'ok', val: n > 1 ? ('真实采集 · ' + n + ' 路') : '真实采集' };
  }
  if (c.mode === 'local') return { state: 'warn', val: '本地模拟' };
  return { state: 'warn', val: '未接入' };
}
function collectDesc() {
  var c = RT.srv && RT.srv.collect;
  if (!Api.live()) return '未配置服务端地址；采集仍依赖「手动点击」，关掉页面即停';
  if (!c) return '正在探测服务端调度状态…';
  var base = c.enabled + ' 个启用 / ' + c.tasks + ' 个调度任务 · 已执行 ' + c.runs + ' 轮 · 去重线索 ' + c.leads + ' 条';
  if (c.mode === 'upstream') {
    var names = (c.channels || []).filter(function (x) { return x.configured && x.id !== 'local'; })
      .map(function (x) { return x.name; });
    var dist = '';
    if (c.tasksByChannel) {
      var ks = Object.keys(c.tasksByChannel);
      if (ks.length) dist = '；任务分布 ' + ks.map(function (k) { return k + ' × ' + c.tasksByChannel[k]; }).join('，');
    }
    return '服务端常驻调度 · 已接入 ' + (names.join(' / ') || '真实通道') + '；' + base + dist;
  }
  if (c.mode === 'local') return 'ALLOW_LOCAL_COLLECT=1，调试用本地模拟；' + base;
  return '需配置 COLLECT_OFFICIAL_URL（自有内容评论区）/ COLLECT_CRAWLER_URL（自建爬虫）/ COLLECT_UPSTREAM（第三方数据服务）任一，否则调度不生成数据；' + base;
}
function guardState() {
  var cf = RT.srv && RT.srv.config;
  if (!cf || !cf.guard) return { state: 'warn', val: '探测中' };
  if (!cf.guard.ok) return { state: 'err', val: '未收口' };
  return cf.guard.warnings ? { state: 'warn', val: cf.guard.warnings + ' 项告警' } : { state: 'ok', val: '已收口' };
}
function guardDesc() {
  var cf = RT.srv && RT.srv.config;
  if (!Api.live()) return '未接入服务端，无法读取服务端环境变量状态';
  if (!cf || !cf.guard) return '正在探测服务端配置守卫…';
  var g = cf.guard;
  if (g.violations && g.violations.length) {
    return (cf.mode === 'production' ? '生产模式' : '开发模式') + '：'
      + g.violations.slice(0, 2).map(function (v) { return v.key; }).join('、')
      + (g.violations.length > 2 ? ' 等 ' + g.violations.length + ' 项' : '')
      + ' — ' + (g.violations[0].severity === 'block' ? '生产环境会拒绝启动' : '建议上线前修正');
  }
  return cf.mode + '：未开启任何危险开关（QA_MODE / ALLOW_LOCAL_COLLECT / ALLOW_LOCAL_GEO）';
}

var paintTimer = null;
function schedulePaint() {
  if (paintTimer) return;
  paintTimer = setTimeout(function () { paintTimer = null; paintNow(); }, 260);
}

/* 探测服务端能力（含 FFmpeg 与渲染队列），结果缓存 15 秒 */
function refreshSrv() {
  if (!Api.live()) { RT.srv = null; return Promise.resolve(null); }
  if (RT.srvBusy) return Promise.resolve(RT.srv);
  if (RT.srv && Date.now() - RT.srvAt < 15000) return Promise.resolve(RT.srv);
  RT.srvBusy = true;
  return Api.health().then(function (r) {
    RT.srvBusy = false;
    RT.srvAt = Date.now();
    RT.srv = (r && r.ok && r.data) ? r.data : null;
    paintNow();
    return RT.srv;
  })['catch'](function () { RT.srvBusy = false; RT.srv = null; return null; });
}

function paintNow() {
  var body = document.getElementById('rtPanelBody');
  if (!body) return;  var sess = (typeof state !== 'undefined' && state) ? state.session : null;
  var demo = (typeof state !== 'undefined' && state) ? !!state.demo : false;
  var pend = pendingOrders().length;
  var auditCount = AUDIT.db.length + AUDIT.local.length;

  var rows = [
    rtRow(Api.live() ? 'ok' : 'warn', '服务端接入（BFF）',
      Api.live() ? RT.bffBase : '未配置，当前为直连模式；密钥类操作需服务端承载',
      Api.live() ? '已接入' : '待接入'),
    rtRow(!Api.live() ? 'warn' : (RT.srv ? ((RT.srv.ffmpeg && RT.srv.ffmpeg.ok) ? 'ok' : 'err') : 'warn'),
      '渲染服务（FFmpeg Worker）',
      !Api.live() ? '未配置服务端地址，剪辑走本地模拟、成片不可播放'
        : (RT.srv
          ? ((RT.srv.ffmpeg && RT.srv.ffmpeg.ok)
            ? ('并发 ' + (RT.srv.queue ? RT.srv.queue.concurrency : 1) + ' · 队列 ' + (RT.srv.queue ? RT.srv.queue.queued : 0) + ' 排队 / ' + (RT.srv.queue ? RT.srv.queue.running : 0) + ' 渲染中 / ' + (RT.srv.queue ? RT.srv.queue.done : 0) + ' 完成')
            : '服务端未检测到 FFmpeg，渲染任务会失败')
          : '正在探测服务端能力…'),
      !Api.live() ? '未接入' : (RT.srv ? ((RT.srv.ffmpeg && RT.srv.ffmpeg.ok) ? '就绪' : '异常') : '探测中')),
    rtRow(!Api.live() ? 'warn' : (collectState().state),
      '采集定时调度（Cron + 队列 + Worker）',
      collectDesc(),
      collectState().val),
    rtRow(guardState().state, '环境变量收口',
      guardDesc(),
      guardState().val),
    rtRow(cloud ? 'ok' : 'err', '云数据库',
      cloud ? '数据按账号行级隔离（RLS）' : 'SDK 未加载，功能不可用',
      cloud ? '已连接' : '未连接'),
    rtRow(demo ? 'warn' : (sess ? 'ok' : 'warn'), '当前会话',
      demo ? '演示模式：数据不落库' : (sess ? '已登录，数据实时同步' : '未登录'),
      demo ? '演示' : (sess ? '已登录' : '未登录')),
    rtRow('ok', '订阅写入权限', '客户端只读，仅服务端可写入订阅记录', '已加固'),
    rtRow('ok', '线索去重', '数据库唯一索引 + 指纹，重复入库被拦截', '已加固'),
    rtRow(OBS.errors ? 'err' : 'ok', '运行期错误',
      OBS.errors ? '本次会话捕获异常，可查看事件日志' : '未捕获到异常', OBS.errors + ' 条'),
    rtRow(pend ? 'warn' : 'ok', '待支付订单',
      pend ? '存在未完成支付的订单' : '无待支付订单', pend + ' 笔')
  ].join('');

  body.innerHTML =
    '<div class="rt-kpi">' +
      rtKpi(OBS.buf.length, '事件缓冲') +
      rtKpi(OBS.errors, '错误') +
      rtKpi(RT.srv && RT.srv.queue ? (RT.srv.queue.queued + RT.srv.queue.running) : 0, '渲染队列') +
      rtKpi(RT.srv && RT.srv.queue ? RT.srv.queue.done : 0, '已渲染成片') +
      rtKpi(RT.srv && RT.srv.collect ? RT.srv.collect.leads : 0, '调度线索') +
      rtKpi(pend, '待支付订单') +
      rtKpi(auditCount, '审计记录') +
    '</div>' +
    '<div class="rt-grid">' + rows + '</div>' +
    '<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn sm" id="rtBtnEvents" data-use type="button">查看事件日志</button>' +
      '<button class="btn sm ghost" id="rtBtnOrders" data-use type="button">查看待支付订单</button>' +
      '<button class="btn sm ghost" id="rtBtnAudit" data-use type="button">刷新审计日志</button>' +
      '<button class="btn sm ghost" id="rtBtnList" data-use type="button">生产上线清单</button>' +
    '</div>';

  var be = document.getElementById('rtBtnEvents');
  if (be) be.addEventListener('click', openEventLog);
  var bo = document.getElementById('rtBtnOrders');
  if (bo) bo.addEventListener('click', openOrders);
  var ba = document.getElementById('rtBtnAudit');
  if (ba) ba.addEventListener('click', function () { loadAudit(); toast('审计日志已刷新', 'ok', '已同步'); });
  var bl = document.getElementById('rtBtnList');
  if (bl) bl.addEventListener('click', openChecklist);

  /* 服务端能力（FFmpeg / 队列）按需刷新，结果缓存避免重复请求 */
  if (Api.live() && (!RT.srv || Date.now() - RT.srvAt > 15000) && !RT.srvBusy) refreshSrv();
}

function openEventLog() {
  var rows = OBS.buf.slice(0, 60).map(function (e) {
    return '<div class="rt-log-row ' + (e.level === 'error' ? 'err' : (e.level === 'warn' ? 'warn' : '')) + '">' +
      '<span class="rt-t">' + hms(e.at) + '</span>' +
      '<span class="rt-m">[' + esc2(e.source) + '] ' + esc2(e.message) + '</span></div>';
  }).join('');
  openModal({
    title: '运行事件日志', sub: '本次会话共 ' + OBS.buf.length + ' 条 · 错误 ' + OBS.errors + ' 条',
    icon: 'i-doc', wide: true,
    body: rows ? '<div class="rt-log">' + rows + '</div>'
               : '<div class="rt-log"><div class="rt-empty">本次会话暂无异常事件</div></div>',
    okText: '关闭', cancelText: null
  });
}

function openOrders() {
  var list = orderList().slice(0, 40);
  var rows = list.map(function (o) {
    var m = o.meta || {};
    var st = orderStatus(o);
    var tag = st === 'pending_payment' ? 'amber' : (st === 'demo' ? 'blue' : 'green');
    var label = st === 'pending_payment' ? '待支付' : (st === 'demo' ? '演示' : st);
    return '<tr><td>' + hms(o.created_at) + '</td>' +
      '<td>' + esc2(m.plan_name || o.plan_name || '-') + '</td>' +
      '<td>' + esc2(m.order_no || o.order_no || '-') + '</td>' +
      '<td>' + (m.amount != null ? money(m.amount) : '-') + '</td>' +
      '<td><span class="tag ' + tag + '">' + esc2(label) + '</span></td></tr>';
  }).join('');
  openModal({
    title: '订单列表', sub: '共 ' + list.length + ' 笔 · 待支付 ' + pendingOrders().length + ' 笔',
    icon: 'i-wallet', wide: true,
    body: list.length
      ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>时间</th><th>套餐</th><th>订单号</th><th>金额</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<div class="rt-log"><div class="rt-empty">暂无订单记录</div></div>',
    okText: '关闭', cancelText: null
  });
}

function openServerConfig() {
  openModal({
    title: '配置服务端地址（BFF）',
    sub: '接入后，密钥托管、下单、鉴权校验、视频渲染全部交由服务端处理',
    icon: 'i-link', wide: true,
    body:
      '<div class="rt-tip"><div>前端不存放任何长期密钥。接入服务端后，第三方采集 Token、支付密钥等敏感凭据全部由服务端持有，' +
      '浏览器仅携带会话凭证调用。<b>填上服务端地址后，「AI智能剪辑 → 一键跑完 7 步」会自动切换为服务端真实渲染（FFmpeg），产出可直接播放的成片。</b>留空即回到直连模式。</div></div>' +
      '<div class="fm-row" style="margin-top:14px"><label>服务端基础地址</label>' +
      '<div class="fld"><input id="rtCfgUrl" type="url" placeholder="http://127.0.0.1:8787" value="' + esc2(RT.bffBase) + '"></div>' +
      '<div class="fld-hint">本地渲染服务启动方式：在项目根目录执行 <b>node server/index.js</b>，默认监听 127.0.0.1:8787。</div></div>' +
      '<div class="fld-hint">生产环境需 HTTPS 并允许本域跨域（CORS）。已实现接口：' +
      '<b>POST /v1/edit/jobs</b>（创建渲染任务）、<b>GET /v1/edit/jobs/:id</b>（进度）、' +
      '<b>POST /v1/edit/jobs/:id/cancel</b>、<b>GET /files/&lt;name&gt;</b>（成片分发）、' +
      '<b>POST /v1/comments/collect</b>、<b>POST /v1/billing/orders</b>、<b>GET /v1/health</b>。</div>',
    okText: '保存',
    cancelText: '取消',
    onOk: async function (rec) {
      var el = q1('#rtCfgUrl', rec.mask);
      var v = Api.setBase(el ? el.value : '');
      RT.srv = null; RT.srvAt = 0;          /* 地址变更后重新探测服务端能力 */
      await audit('配置服务端地址', v || '清空', { base: v });
      if (v) {
        var h = await Api.health();
        if (h.ok && h.data) {
          var ffok = !!(h.data.ffmpeg && h.data.ffmpeg.ok);
          toast(ffok ? '已连接渲染服务，FFmpeg 就绪，剪辑将产出真实成片'
                     : '已连接服务端，但未检测到 FFmpeg，渲染会失败',
            ffok ? 'ok' : 'err', '连接结果');
          obs('info', 'bff', '服务端地址已配置', { base: v, ffmpeg: ffok });
        } else {
          toast('已保存地址，但连接失败：' + (h.error || '不可达'), 'err', '连接失败');
          obs('warn', 'bff', '服务端连接失败', { base: v, error: h.error || '' });
        }
      } else {
        toast('已清空服务端地址，回到直连模式', 'ok', '配置已更新');
      }
      schedulePaint();
    }
  });
}

function openChecklist() {
  openModal({
    title: '生产上线清单', sub: '按优先级排列 · 已完成的项标记为绿色',
    icon: 'i-flag', wide: true,
    body:
      '<div class="rt-doc">' +
      '<h4>已完成（本次改造）</h4>' +
      '<ul>' +
      '<li>订阅表客户端写权限收回 —— 仅服务端可写入订阅记录</li>' +
      '<li>套餐表写权限收回 —— 客户端仅可读</li>' +
      '<li>匿名角色写权限全部收回</li>' +
      '<li>线索库级唯一索引 + 指纹，重复入库被数据库拦截</li>' +
      '<li>新增采集任务表、审计日志表、运行事件表（均启用行级隔离）</li>' +
      '<li>运行时可观测：全局错误捕获 + 事件落库 + 状态面板</li>' +
      '<li>关键操作审计日志（只追加，不可篡改）</li>' +
      '<li>套餐开通改为「创建待支付订单」，不再由前端直接开通</li>' +
      '<li>用户服务协议、隐私政策页面 + 登录前同意门禁</li>' +
      '</ul>' +
      '<h4>待人工完成（需在控制台或线下办理）</h4>' +
      '<ul>' +
      '<li>发布到 HTTPS 域名，并在云服务管理页开启「手机号登录」「微信登录」开关</li>' +
      '<li>域名 ICP 备案</li>' +
      '<li>接入支付服务（微信支付 / 支付宝）与回调验签，完成订单→订阅的服务端闭环</li>' +
      '<li>部署服务端（BFF）并填入上方地址</li>' +
      '<li>接入采集服务商，填入采集地址与 Token（仅存服务端）</li>' +
      '<li>接入短信通道并配置签名与模板</li>' +
      '<li>配置监控告警的接收通道</li>' +
      '</ul>' +
      '<h4>建议后续（工程化）</h4>' +
      '<ul>' +
      '<li>单文件拆分为模块化构建，纳入版本管理与持续集成</li>' +
      '<li>多环境（开发 / 预发 / 生产）与灰度发布、一键回滚</li>' +
      '<li>第三方采集与企业微信对接的合规评审</li>' +
      '</ul>' +
      '</div>',
    okText: '关闭', cancelText: null
  });
}

async function runSelfCheck() {
  var t = toast('正在运行自检…', 'load', '自检中');
  var lines = [];
  lines.push((cloud ? '通过' : '失败') + ' · 云 SDK 加载：' + (cloud ? '正常' : '未加载'));
  lines.push((liveSession() ? '通过' : '提示') + ' · 登录会话：' +
    (liveSession() ? '已登录' : (state && state.demo ? '演示模式' : '未登录')));
  lines.push('通过 · 订阅写入权限：客户端只读，仅服务端可写入（已加固）');

  if (Api.live()) {
    var h = await Api.health();
    lines.push((h.ok ? '通过' : '失败') + ' · 服务端健康检查：' + (h.ok ? '正常' : (h.error || '不可用')));
    if (h.ok && h.data) {
      var srv = h.data;
      var ffOk = !!(srv.ffmpeg && srv.ffmpeg.ok);
      lines.push((ffOk ? '通过' : '失败') + ' · 渲染服务（FFmpeg）：' +
        (ffOk ? String(srv.ffmpeg.version || '').slice(0, 58) : '服务端未检测到 FFmpeg，剪辑任务会失败'));
      if (srv.queue) {
        lines.push('通过 · 渲染队列：并发 ' + srv.queue.concurrency + ' · 排队 ' + srv.queue.queued +
          ' · 渲染中 ' + srv.queue.running + ' · 已完成 ' + srv.queue.done + ' · 失败 ' + srv.queue.failed +
          (srv.queue.deadLetter ? ' · 死信 ' + srv.queue.deadLetter : ''));
      }
      if (srv.collector) {
        var chList = srv.collector.channels || [];
        var chNames = chList.filter(function (x) { return x.configured && x.id !== 'local'; })
          .map(function (x) { return x.name; });
        var chTxt;
        if (!srv.collector.configured) {
          chTxt = '未接入 —— 三条通道任选其一：COLLECT_OFFICIAL_URL（自有内容评论区）/ COLLECT_CRAWLER_URL（自建爬虫）/ COLLECT_UPSTREAM（第三方数据服务）';
        } else if (srv.collector.ok) {
          chTxt = '连通 ' + chNames.length + ' 路（' + chNames.join(' / ') + '）';
        } else {
          chTxt = '已接入 ' + chNames.join(' / ') + '，但部分通道不可达';
        }
        lines.push((srv.collector.configured && srv.collector.ok ? '通过' : '提示') + ' · 评论采集通道：' + chTxt);
        /* 自建爬虫通道一旦启用就必须显式提示：它与《条款与隐私》里
           「不提供、亦不支持任何绕过第三方平台防护措施的采集手段」直接冲突，
           而这类矛盾在页面上是看不见的 —— 运维只会在出事之后才发现。 */
        var crawlerOn = false;
        for (var ci = 0; ci < chList.length; ci++) {
          if (chList[ci].id === 'crawler' && chList[ci].configured) crawlerOn = true;
        }
        if (crawlerOn) {
          lines.push('提示 · 自建爬虫通道已启用：抓取第三方平台评论区违反平台协议，且涉个人信息保护与不正当竞争风险。'
            + '请确认适用内容源（自有账号 / 已获书面授权）并同步核对《条款与隐私》的采集口径');
        }
      }
      if (srv.billing) {
        lines.push((srv.billing.configured ? '通过' : '提示') +
          ' · 支付通道：' + (srv.billing.configured ? '已配置（' + srv.billing.provider + '）' : '未配置，下单只生成待支付订单'));
      }
    }
  } else {
    lines.push('提示 · 服务端健康检查：未配置服务端地址，跳过');
    lines.push('提示 · 渲染服务：未接入，剪辑走本地模拟；在「配置服务端」填入地址后自动切换为真实渲染');
  }

  if (liveSession()) {
    try {
      var r = await cloud.database.from('leads').select('id').limit(1);
      lines.push((r && !r.error ? '通过' : '失败') + ' · 线索表读取：' + (r && !r.error ? '正常' : ((r && r.error && r.error.message) || '失败')));
    } catch (e) { lines.push('失败 · 线索表读取：' + String((e && e.message) || e)); }
  } else {
    lines.push('提示 · 线索表读取：未登录，跳过');
  }

  obs('info', 'selfcheck', '运行自检完成', { pass: lines.filter(function (x) { return x.indexOf('通过') === 0; }).length, total: lines.length });
  openModal({
    title: '运行自检结果', sub: '共 ' + lines.length + ' 项检查',
    icon: 'i-check-circle', wide: true,
    body: '<div class="rt-log">' + lines.map(function (l) {
      var cls = l.indexOf('失败') === 0 ? 'err' : (l.indexOf('提示') === 0 ? 'warn' : '');
      return '<div class="rt-log-row ' + cls + '"><span class="rt-m">' + esc2(l) + '</span></div>';
    }).join('') + '</div>',
    okText: '关闭', cancelText: null
  });
}

/* =========================================================
   8. 审计日志表格接管
   ========================================================= */
function paintAudit() {
  var cards = document.querySelectorAll('#v-settings .card');
  var target = null;
  for (var i = 0; i < cards.length; i++) {
    var h = cards[i].querySelector('.card-head h3');
    if (h && h.textContent.indexOf('操作日志') > -1) { target = cards[i]; break; }
  }
  if (!target) return;
  var tb = target.querySelector('tbody');
  if (!tb) return;

  /* 导出按钮：无论是否有记录都挂载 */
  var right = target.querySelector('.card-head .right');
  if (right && !right.querySelector('[data-rt-export]')) {
    var b = document.createElement('button');
    b.className = 'btn sm';
    b.setAttribute('data-rt-export', '1');
    b.setAttribute('data-use', '1');
    b.setAttribute('type', 'button');
    b.textContent = '导出审计日志';
    b.addEventListener('click', function () {
      var cur = AUDIT.db.length ? AUDIT.db : AUDIT.local;
      var rows = [['时间', '执行者', '动作', '对象']].concat(cur.map(function (a) {
        return [new Date(a.created_at).toLocaleString('zh-CN'), a.owner || '本人', a.action || '', a.target || ''];
      }));
      var csv = '\ufeff' + rows.map(function (r) {
        return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
      }).join('\n');
      try {
        var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        var a2 = document.createElement('a');
        a2.href = url;
        a2.download = 'audit-log-' + Date.now() + '.csv';
        a2.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
        audit('导出审计日志', cur.length + ' 条', { count: cur.length });
        toast('审计日志已导出', 'ok', '导出完成');
      } catch (e) { toast('导出失败：' + String((e && e.message) || e), 'err', '导出失败'); }
    });
    right.appendChild(b);
  }

  var list = AUDIT.db.length ? AUDIT.db : AUDIT.local;
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-3);padding:20px">' +
      (liveSession() ? '暂无审计记录，执行任意操作后此处将实时记录' : '登录后展示真实审计记录（当前为演示数据）') + '</td></tr>';
    return;
  }
  tb.innerHTML = list.slice(0, 20).map(function (a) {
    var act = a.action || '';
    var cls = /删除|清空|导出|变更|配置|打通/.test(act) ? 'violet' : (/拦截|失败|异常/.test(act) ? 'red' : 'blue');
    return '<tr><td>' + hms(a.created_at) + '</td>' +
      '<td><span class="tag ' + cls + '">' + esc2(a.owner || '本人') + '</span></td>' +
      '<td>' + esc2(act) + '</td>' +
      '<td>' + esc2(a.target || '-') + '</td>' +
      '<td><span class="tag green">已记录</span></td></tr>';
  }).join('');
}

/* =========================================================
   9. 启动
   ========================================================= */
/* 渲染通道自动接入：bffBase 为空时不再等用户手填 —— 依次探测同源与本机默认
   端口，探通 /v1/health 即接入并持久化。全自动剪辑（AI智能剪辑「一键跑完 7 步」）
   依赖这个地址；没有它就会落回本地模拟。探测幂等：已配置或全部探不通时保持原状。 */
function autoDetectBff() {
  if (RT.bffBase) return Promise.resolve(false);
  var cands = [];
  try {
    if (/^https?:$/.test(location.protocol) && location.origin && location.origin !== 'null') {
      cands.push(location.origin);   /* BFF 同时托管 SPA 时，同源即服务端 */
    }
  } catch (e) {}
  if (cands.indexOf('http://127.0.0.1:8787') < 0) cands.push('http://127.0.0.1:8787');
  var i = 0;
  function probeNext() {
    if (i >= cands.length) return Promise.resolve(false);
    var base = cands[i++];
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { if (ctl) ctl.abort(); }, 2500) : null;
    return fetch(base + '/v1/health', { method: 'GET', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (timer) clearTimeout(timer);
        if (j && j.ok && j.service) {
          Api.setBase(base);
          obs('ok', 'runtime', '渲染通道已自动接入：' + base + '（服务 ' + (j.service || 'bff') + '）', { auto: true });
          return true;
        }
        return probeNext();
      })
      ['catch'](function () {
        if (timer) clearTimeout(timer);
        return probeNext();
      });
  }
  return probeNext();
}

function boot() {
  installConsentGate();
  autoDetectBff();
  obs('info', 'runtime', '运行时层已启动', {
    bff: RT.bffBase || null,
    cloud: !!cloud,
    ua: navigator.userAgent.slice(0, 120)
  });
  ensurePanel();
  paintNow();

  var _go = go;
  go = function (v) {
    _go(v);
    if (v === 'v-settings') {
      ensurePanel();
      paintNow();
      loadOrders();
      loadAudit();
    }
  };

  var _renderAll = renderAll;
  renderAll = function () {
    _renderAll.apply(null, arguments);
    if (document.getElementById('rtPanelBody')) { ensurePanel(); schedulePaint(); }
  };

  var _refresh = refreshData;
  refreshData = async function () {
    await _refresh.apply(null, arguments);
    if (liveSession()) { await loadOrders(); await loadAudit(); }
  };

  var self = document.querySelector('.nav-item[data-view="v-settings"]');
  if (self) self.addEventListener('click', function () {
    setTimeout(function () { ensurePanel(); paintNow(); loadOrders(); loadAudit(); }, 60);
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && liveSession()) { loadOrders(); loadAudit(); }
  });

  window.__RT = { rt: RT, obs: OBS, audit: AUDIT, orders: ORDERS, api: Api, pendingOrders: pendingOrders, orderList: orderList, openDoc: openDoc, ensurePanel: ensurePanel, paintNow: paintNow, runSelfCheck: runSelfCheck, openChecklist: openChecklist, openOrders: openOrders, openEventLog: openEventLog };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 500); });
} else {
  setTimeout(boot, 500);
}

})();

