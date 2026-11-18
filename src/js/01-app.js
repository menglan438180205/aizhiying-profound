
/* =========================================================
   ProFound · 前端应用逻辑
   鉴权：本机 BFF /v1/auth/*（手机号 + 密码）→ HMAC 会话票
   数据：本机 BFF（leads / content_tasks / plans / subscriptions）
   ========================================================= */

/* 云端 SDK 已于 2026-11-08 下线（assets/sdk.js、server/cloud-relay.js 均已删除）。
   这里保留一个恒为 null 的 cloud 变量：其它模块仍有一批
   `if (state.demo || !cloud) …` 的历史分支，靠它稳定走本地路径。
   属于后续清理范围，先别删变量，否则那些分支会 ReferenceError。 */
var cloud = null;

/* 本机地址判定：IP 版登录页要据此决定是否显示「服务端令牌」入口 */
function isLoopbackHost() {
  var h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/* ---------- 减少动画（系统偏好 或 URL 加 ?noanim，便于自动截图） ---------- */
if (location.search.indexOf('noanim') > -1) document.body.classList.add('no-anim');

/* ---------- 小工具 ---------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
const yuan = n => '¥' + Number(n || 0).toLocaleString('zh-CN');
const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STAGES = ['new', 'sent', 'wechat', 'nego', 'deal', 'sleep'];
const STAGE_META = {
  new:    { label: '新线索', color: '#8E8DA5' },
  sent:   { label: '已私信', color: '#4C3FE4' },
  wechat: { label: '已加微', color: '#12A150' },
  nego:   { label: '洽谈中', color: '#F5A524' },
  deal:   { label: '已成交', color: '#8B5CF6' },
  sleep:  { label: '待唤醒', color: '#E5484D' }
};
const PF = {
  douyin:   { label: '抖音',   cls: 'dy',  short: '抖' },
  kuaishou: { label: '快手',   cls: 'ks',  short: '快' },
  xhs:      { label: '小红书', cls: 'xhs', short: '红' },
  sph:      { label: '视频号', cls: 'sph', short: '视' }
};

/* ---------- 应用状态 ---------- */
const state = {
  stage: 'boot',      // boot | login | app
  demo: false,
  session: null,
  leads: [],
  plans: [],
  subs: [],
  tasks: [],
  demoData: null,
  /* 计费：当前计费周期 + 服务端额度概览（/v1/billing/summary） */
  billingCycle: 'year',
  billingSummary: null,
  billingAt: 0,     /* 额度快照时间：跨账号复用时必须判新鲜度 */
  billing: null
};

/* ---------- 演示数据（唯一来源：demo/dataset.js → GET /v1/demo/dataset） ----------
   页面不再内嵌任何模拟业务数据；只有进入 DEMO 演示模式时才拉取。
   生产环境该接口返回 404（DEMO_DISABLED），页面走真实数据与空状态。 */
function demoBaseCandidates() {
  const out = [];
  try {
    const raw = localStorage.getItem('aizhiying.runtime.v1');
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && saved.bffBase) out.push(String(saved.bffBase).replace(/\/+$/, ''));
  } catch (e) {}
  try { if (location.origin && /^https?:/.test(location.origin)) out.push(location.origin); } catch (e) {}
  out.push('http://127.0.0.1:8787');
  return out.filter((v, i) => out.indexOf(v) === i);
}

async function loadDemoDataset() {
  for (const base of demoBaseCandidates()) {
    try {
      const r = await fetch(base + '/v1/demo/dataset', { cache: 'no-store' });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.ok && j.dataset) return j.dataset;
    } catch (e) {}
  }
  return null;
}

function demoSlice(key) {
  return (state.demoData && Array.isArray(state.demoData[key])) ? state.demoData[key]
    : ((state.demoData && state.demoData[key]) || []);
}

/* ---------- 视图元信息 ---------- */
const META = {
  'v-dashboard': ['数据中台', 'AI灵讯 + GEO直通车 + DeepWork智伴 三线合一的增长数据中枢'],
  'v-content':   ['AI灵讯 · 评论区获客', '抖音 / 快手 / 小红书 / 视频号 评论区意向客户扫描'],
  'v-more':      ['AI灵讯 · 更多获客', '已开通渠道总览 · 待开通渠道扩展'],
  'v-matrix':    ['DeepWork智伴 · AI智能剪辑', '剪辑 → 分发 → 采集 三环流水线 · 自动字幕配音'],
  'v-employee':  ['经营支撑 · AI 智能员工', '5 位 AI 员工 24 小时接管微信、客服与投放复盘'],
  'v-geo':       ['GEO 优化引擎 · 11 模块控制台', '仪表盘 / 企业身份 / 词库 / 创作 / 站点 / 分发 / 探针 / 报告 / 诊断 / 客户 / 设置'],
  'v-geobuild':  ['GEO直通车 · AI秒搭建站', '按 GEO 五原则一键生成可被抓取、可引用、可被信任的官网'],
  'v-live':      ['DeepWork智伴 · AI数字人', '形象+声音克隆 · 直播/录播/对话三驱动'],
  'v-crm':       ['经营支撑 · 客户管理 CRM', '从线索到成交的全生命周期跟进'],
  'v-pricing':   ['经营支撑 · 会员套餐', '季度版 / 基础版 / 标准版 / 旗舰版 · 按栏目开通'],
  'v-settings':  ['风控与设置', '合规策略 · 团队权限 · 操作日志']
};

/* =========================================================
   视图切换
   ========================================================= */
const navItems = $$('.nav-item');
const views = $$('.view');
const contentEl = $('#content');

function go(viewId) {
  if (!META[viewId]) return;
  views.forEach(v => v.classList.toggle('active', v.id === viewId));
  navItems.forEach(n => n.classList.toggle('active', n.dataset.view === viewId));
  $('#pageTitle').textContent = META[viewId][0];
  $('#pageSub').textContent = META[viewId][1];
  if (contentEl) contentEl.scrollTop = 0;
  /* 套餐页每次进入都拉一次服务端额度，避免展示过期配额 */
  if (viewId === 'v-pricing' && typeof refreshBilling === 'function') {
    try { refreshBilling(); } catch (e) {}
  }
  try { if (location.hash.slice(1) !== viewId) location.hash = viewId; } catch (e) {}
  /* F5 后回到原页面：即使 hash 丢失，也能按上次停留的视图恢复 */
  try { localStorage.setItem('pf.view', viewId); } catch (e) {}
  if (window.innerWidth <= 1024) closeDrawer();
}

/* ---------- 通用折叠：日志 / 长列表默认收起，点开才展开 ---------- */
(function initFoldCards() {
  function bind() {
    document.querySelectorAll('.fold-card[data-fold]').forEach(function (box) {
      if (box.__fold) return;
      box.__fold = 1;
      const head = box.querySelector('.fold-card-head');
      if (!head) return;
      function toggle() {
        const on = !box.classList.contains('open');
        box.classList.toggle('open', on);
        head.setAttribute('aria-expanded', on ? 'true' : 'false');
      }
      head.addEventListener('click', function (ev) {
        /* 头部的「清空 / 导出」等按钮不触发折叠 */
        if (ev.target.closest && ev.target.closest('button,a,input,select')) return;
        toggle();
      });
      head.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  /* 动态插入的 fold-card 可再调一次（幂等） */
  window.bindFoldCards = bind;
})();

navItems.forEach(item => item.addEventListener('click', () => go(item.dataset.view)));
document.addEventListener('click', e => {
  const b = e.target.closest('[data-go]');
  if (b) { e.preventDefault(); go(b.dataset.go); }
  /* 计费卡上的动作按钮（动态渲染，统一委托） */
  const tr = e.target.closest('[data-trial]');
  if (tr) { e.preventDefault(); startTrial(); return; }
  const pk = e.target.closest('[data-pack]');
  if (pk) { e.preventDefault(); openPackPicker(); return; }
});

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (META[id] && state.stage === 'app') go(id);
});

/* ---------- 抽屉 / 手机预览 ---------- */
const sidebar = $('#sidebar');
const backdrop = $('#backdrop');
function openDrawer() { sidebar.classList.add('open'); backdrop.classList.add('show'); }
function closeDrawer() { sidebar.classList.remove('open'); backdrop.classList.remove('show'); }
$('#menuBtn').addEventListener('click', () => {
  sidebar.classList.contains('open') ? closeDrawer() : openDrawer();
});
backdrop.addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

const deviceBtn = $('#deviceBtn');
deviceBtn.addEventListener('click', () => {
  const on = document.body.classList.toggle('device-mode');
  deviceBtn.innerHTML = on
    ? '<svg class="icon"><use href="#i-monitor"/></svg>'
    : '<svg class="icon"><use href="#i-smartphone"/></svg>';
  deviceBtn.title = on ? '切回电脑视图' : '切到手机预览';
});

/* ---------- 顶栏铃铛：系统通知面板 ---------- */
const bellBtn = $('#bellBtn');
const bellPanel = $('#bellPanel');
async function bellRefresh() {
  const list = $('#bellList');
  const items = [];
  try {
    const h = await (window.Api ? Api.call('/v1/health', null, { method: 'GET' }) : Promise.reject(new Error('no api')));
    const q = (h && h.queue) || {};
    const queued = Number(q.queued || 0), running = Number(q.running || 0);
    items.push({ cls: running ? 'ok' : '', t: '渲染队列', s: running ? running + ' 个任务渲染中' + (queued ? ' · ' + queued + ' 个排队' : '') : (queued ? queued + ' 个任务排队等待' : '队列空闲，一切正常') });
    const ff = (h && h.ffmpeg) || {};
    items.push({ cls: ff.ok ? 'ok' : 'err', t: '视频渲染引擎', s: ff.ok ? 'FFmpeg 就绪，成片可正常合成' : 'FFmpeg 未就绪，渲染任务会失败' });
    const col = (h && h.collect) || {};
    if (col && (col.configured === false || col.mode === 'unconfigured')) items.push({ cls: 'warn', t: '采集通道', s: '未接入上游，评论采集暂不可用' });
  } catch (e) {
    items.push({ cls: 'warn', t: '服务状态', s: '暂时取不到服务端状态（网络或令牌问题），稍后自动重试' });
  }
  items.push({ cls: 'ok', t: '欢迎使用 ProFound', s: '系统告警与任务提醒会出现在这里' });
  $('#bellCount').textContent = String(items.length);
  list.innerHTML = items.map(function (it) {
    return '<div class="bell-item ' + (it.cls || '') + '"><span class="bi-dot"></span><div><b>' + it.t + '</b><span>' + it.s + '</span></div></div>';
  }).join('');
}
if (bellBtn && bellPanel) {
  bellBtn.addEventListener('click', async function (e) {
    e.stopPropagation();
    const show = !bellPanel.classList.contains('show');
    bellPanel.classList.toggle('show', show);
    bellPanel.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (show) { bellPanel.classList.add('show'); await bellRefresh(); }
  });
  document.addEventListener('click', function (e) {
    if (!bellPanel.classList.contains('show')) return;
    if (e.target.closest('#bellPanel') || e.target.closest('#bellBtn')) return;
    bellPanel.classList.remove('show');
    bellPanel.setAttribute('aria-hidden', 'true');
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { bellPanel.classList.remove('show'); } });
}

/* ---------- 页内组件交互 ---------- */
$$('.mat-tab').forEach(t => {
  t.addEventListener('click', () => {
    $$('.mat-tab').forEach(x => x.classList.remove('active'));
    $$('.mat-pane').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const pane = document.getElementById(t.dataset.mp);
    if (pane) pane.classList.add('active');
  });
});
$$('.tabs .tab').forEach(t => {
  t.addEventListener('click', () => {
    t.parentElement.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
  });
});
document.addEventListener('click', e => {
  const sw = e.target.closest('.switch');
  if (sw) sw.classList.toggle('on');
});
$$('.slider-row input[type=range]').forEach(r => {
  const out = r.parentElement.querySelector('b');
  const render = () => {
    const label = r.previousElementSibling ? r.previousElementSibling.textContent : '';
    const u = label.indexOf('间隔') > -1 ? ' 秒' : (label.indexOf('上限') > -1 || label.indexOf('私信') > -1 ? ' 条' : '');
    out.textContent = r.value + u;
  };
  r.addEventListener('input', render);
  render();
});

/* =========================================================
   登录 / 会话
   ========================================================= */
const loginView = $('#loginView');
const bootView = $('#boot');

function setStage(next) {
  state.stage = next;
  document.body.classList.remove('pre-auth');
  bootView.style.display = 'none';
  if (next === 'login') {
    loginView.classList.add('show');
    $('#app').style.display = 'none';
  } else {
    loginView.classList.remove('show');
    $('#app').style.display = 'flex';
  }
}

/* ---------- 退出 ---------- */
async function signOut() {
  /* 本地凭证必须一起清：只清云端会话的话，localStorage 里的令牌/会话票还在，
     F5 一次又被 boot 自动送进应用 —— 表现为「退出登录无效」。 */
  try { localStorage.removeItem('pf.bff.token'); } catch (e) {}
  try { localStorage.removeItem('pf.auth.token'); } catch (e) {}
  try { await fetch(((window.RT && RT.bffBase) || '') + '/v1/auth/logout', { method: 'POST', credentials: 'include' }); } catch (e) {}
  try { await fetch(((window.RT && RT.bffBase) || '') + '/v1/session', { method: 'DELETE', credentials: 'include' }); } catch (e) {}
  state.session = null;
  state.demo = false;
  document.body.classList.remove('demo-mode');
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  setStage('login');
}

/* =========================================================
   数据加载
   ========================================================= */
async function loadPlans() {
  /* 套餐唯一数据源：服务端 /v1/plans（价目表落 .data/billing-plans.json，改价不用发版）。
     连不上 BFF 时退到示例数据，保证离线也能看页面。
     2026-11-08：去掉了「读 WorkBuddy 云数据库 plans」这一段 —— 那是一条
     并行的第二数据源，改价时两边不同步，用户会看到两个价格。 */
  if (Api.live()) {
    try {
      const r = await Api.call('/v1/plans', null, { method: 'GET', timeout: 6000 });
      if (r.ok && r.data && Array.isArray(r.data.plans) && r.data.plans.length) {
        state.billing = { packs: r.data.packs || [], provider: r.data.provider || '' };
        return r.data.plans;
      }
    } catch (e) {}
  }
  return demoSlice('plans');
}
/* 2026-11-08：不再读 WorkBuddy 云数据库。
   云端原本是第二条数据源（leads / subscriptions / content_tasks），
   与本地采集表并存 —— 结果「看板的数字」和「采集到的线索」永远对不上，
   销售在两个页面上看到的意向数不一样。现在统一读本服务的表：
     collect_leads  = 真实采集结果（含打分与阶段）
     billing/summary = 真实订阅与额度
   函数名保留，避免十几处调用点全部改名。 */
/* 服务端线索状态 → 前端阶段。
   两套词表一直并存：服务端 collect_leads.status 是 new/contacted/wechat/won/lost，
   前端 STAGE_META 是 new/sent/wechat/nego/deal/sleep。之前直接 stage=status，
   结果「已成交(won)」在页面显示成「新线索」，成交数与加微转化永远统计不到。
   这里只做展示归一，不改写入值（写接口仍按调用方原值存）。 */
const STATUS_TO_STAGE = { contacted: 'sent', won: 'deal', lost: 'sleep' };

/* 线索行映射：/v1/collect/leads 与 /v1/overview 返回同一结构，共用一份映射，
   避免两个入口对同一条线索给出不同字段（以前就是在这里分叉的）。 */
function mapLeadRow(l) {
  const st = l.status || 'new';
  return {
    id: l.id,
    nickname: l.nickname || '',
    comment: l.comment || '',
    platform: l.platform || '',
    keyword: l.keyword || '',
    intent_score: Number(l.score || 0),
    level: l.level || 'noise',
    stage: STATUS_TO_STAGE[st] || st,
    video_title: l.video || '',
    video_url: l.video_url || '',
    created_at: l.created_at || l.at || ''
  };
}
/* 计费摘要 → 侧栏套餐行（唯一来源：billing/summary 或 overview.billing） */
function mapSubscription(summary) {
  const sub = summary && summary.subscription;
  return sub ? [{
    status: sub.status === 'trial' ? 'trialing' : sub.status,
    plan_name: sub.planName || sub.planId || '',
    cycle: sub.cycle || '',
    period_end: sub.periodEnd || '',
    left_days: sub.leftDays
  }] : [];
}

async function loadCloudData() {
  const api = window.Api;
  if (!api || typeof api.call !== 'function') { state.leads = state.leads || []; return; }
  /* 首屏聚合（R4）：一个请求拿回线索 + 统计 + 计费 + GEO/剪辑概览。
     服务端未升级（404）时回退到原来的两个接口，页面不受影响。 */
  try {
    const r = await api.call('/v1/overview?limit=80', null, { method: 'GET', timeout: 8000 });
    if (r && r.ok && r.data && Array.isArray(r.data.leads)) {
      state.leads = r.data.leads.map(mapLeadRow);
      state.subs = mapSubscription(r.data.billing);
      state.billingSummary = r.data.billing || null;
      state.billingAt = Date.now();
      state.overview = r.data;
      /* 内容任务表本地没有等价物：留空，页面显示「暂无」，不编造数字 */
      state.tasks = [];
      return;
    }
  } catch (e) {}
  try {
    const r = await api.call('/v1/collect/leads?limit=80', null, { method: 'GET' });
    const list = (r && r.data && r.data.leads) || [];
    state.leads = list.map(mapLeadRow);
  } catch (e) {
    state.leads = state.leads || [];
  }
  try {
    const b = await api.call('/v1/billing/summary', null, { method: 'GET' });
    state.subs = mapSubscription(b && b.data);
    state.billingSummary = (b && b.data) || null;
    state.billingAt = Date.now();
  } catch (e) {
    state.subs = [];
  }
  /* 内容任务表本地没有等价物：留空，页面显示「暂无」，不编造数字 */
  state.tasks = [];
}

/* =========================================================
   渲染
   ========================================================= */
function stageTag(stage) {
  const m = STAGE_META[stage] || STAGE_META.new;
  return '<span class="tag" style="background:' + m.color + '1F;color:' + m.color + '">' + m.label + '</span>';
}
function pfTag(p) {
  const m = PF[p] || PF.douyin;
  return '<span class="pf ' + m.cls + '">' + m.short + '</span>';
}
function scoreBar(n, color) {
  return '<span class="score" style="color:' + color + '"><span class="score-bar"><i style="width:' + Math.min(100, n) + '%;background:' + color + '"></i></span>' + n + '</span>';
}
function scoreColor(n) { return n >= 85 ? 'var(--red)' : (n >= 70 ? 'var(--amber)' : 'var(--text-2)'); }
function avatarClass(i) { return 'av a' + ((i % 5) + 1); }
function initials(name) { return (name || '客').trim().charAt(0); }

/* ---- KPI ----
   数据流：state.leads 是唯一真相（来自 /v1/collect/leads 或 demo dataset），
   这里同时驱动「今日意向客户」等 4 张卡与侧栏徽标，避免出现
   「徽标 128、卡片 0」这种两套数据源的错觉。 */
function renderKPIs() {
  const wrap = $('#v-dashboard');
  if (!wrap) return;
  const kpis = $$('.kpi', wrap);
  if (kpis.length < 4) return;
  const leads = state.leads;
  /* 口径优先用服务端聚合（/v1/overview 的 leadStats）：它统计的是全量线索。
     state.leads 只有前 80 条，线索超过 80 时按它算 KPI 会系统性少算——
     演示态或旧服务端没有 leadStats 时才退回本地计算。 */
  const ov = (state.overview && state.overview.leadStats) || null;
  /* 旧服务端的 leadStats 没有 added/deals/amount 三个字段，缺任意一个就整体
     退回本地计算，避免「接口在、字段缺」时把 KPI 直接写成 0。 */
  const ovOk = !!(ov && ov.total != null && ov.added != null && ov.deals != null && ov.amount != null);
  let total, today, week, touched, added, dealCount, amount;
  if (ovOk) {
    total = Number(ov.total) || 0;
    today = Number(ov.today) || 0;
    week = Number(ov.week) || 0;
    touched = Number(ov.touched != null ? ov.touched : (total - (Number(ov.newCount) || 0)));
    added = Number(ov.added) || 0;
    dealCount = Number(ov.deals) || 0;
    amount = Number(ov.amount) || 0;
  } else {
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    total = leads.length;
    today = leads.filter(l => (Date.parse(l.created_at || '') || 0) >= t0.getTime()).length;
    week = leads.filter(l => l.created_at && (Date.now() - new Date(l.created_at).getTime()) < 7 * 864e5).length;
    touched = leads.filter(l => l.stage !== 'new').length;
    added = leads.filter(l => ['wechat', 'nego', 'deal'].indexOf(l.stage) > -1).length;
    const deals = leads.filter(l => l.stage === 'deal');
    dealCount = deals.length;
    amount = deals.reduce((s, l) => s + Number(l.amount || 0), 0);
  }
  const rate = total ? Math.round(added / total * 100) : 0;

  const set = (i, val, foot) => {
    $('.k-val', kpis[i]).innerHTML = val;
    $('.k-foot', kpis[i]).innerHTML = foot;
  };
  set(0, today + '<small class="unit">人</small>',
      '<span class="trend up"><svg class="icon"><use href="#i-arrow-up"/></svg>' + week + '</span><span class="vs">近 7 天新增</span>');
  set(1, touched + '<small class="unit">条</small>',
      '<span class="trend flat">待触达 ' + (total - touched) + '</span>');
  set(2, added + '<small class="unit">人</small>',
      '<span class="trend up">' + rate + '%</span><span class="vs">加微转化率</span>');
  set(3, '<small>¥</small>' + amount.toLocaleString('zh-CN'),
      '<span class="trend flat">成交 ' + dealCount + ' 单</span>');

  /* 侧栏徽标与卡片同源：0 条时隐藏，不显示假数字 */
  const badge = document.getElementById('navLeadBadge');
  if (badge) {
    const pending = ovOk ? (Number(ov.newCount) || 0) : leads.filter(l => l.stage === 'new').length;
    if (pending > 0) {
      badge.textContent = pending > 99 ? '99+' : String(pending);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }
}

/* ---- 看板：实时线索流 ---- */
function renderLeadTable() {
  const t = $('#leadTable');
  if (!t) return;
  const body = t.querySelector('tbody');
  if (!body) return;
  const rows = state.leads.slice(0, 6);
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-3);padding:28px">暂无线索数据</td></tr>';
    return;
  }
  body.innerHTML = rows.map((l, i) => {
    const m = PF[l.platform] || PF.douyin;
    const sc = l.intent_score || 0;
    const acts = l.stage === 'new'
      ? '<button class="btn sm primary" data-act="send" data-id="' + l.id + '">立即私信</button>'
      : '<button class="btn sm" data-act="advance" data-id="' + l.id + '">推进</button>';
    return '<tr>' +
      '<td><div class="cell-user"><div class="' + avatarClass(i) + '">' + esc(initials(l.nickname)) + '</div><div><b>' + esc(l.nickname) + '</b><span>' + esc(l.keyword || '—') + '</span></div></div></td>' +
      '<td><div style="display:flex;align-items:center;gap:6px">' + pfTag(l.platform) + m.label + '</div></td>' +
      '<td style="color:var(--text-2)">' + esc((l.comment || '').slice(0, 30)) + '</td>' +
      '<td>' + scoreBar(sc, scoreColor(sc)) + '</td>' +
      '<td>' + stageTag(l.stage) + '</td>' +
      '<td>' + acts + '</td>' +
    '</tr>';
  }).join('');
}

/* ---------- CRM：KPI 与客户明细 ----------
   与「评论区获客 · 高意向线索」「线索池」共用 state.leads。
   改造前这里的 2,486 人 / 86 单 / ¥864,200 是写死的装饰数字，已全部改为真实统计。 */
function renderCrmKpis() {
  const box = document.getElementById('crmKpis');
  if (!box) return;
  const leads = state.leads || [];
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  let today = 0, deals = [], amount = 0;
  leads.forEach(l => {
    const ts = Date.parse(l.created_at || l.updated_at || '') || 0;
    if (ts >= t0.getTime()) today++;
    if (l.stage === 'deal') { deals.push(l); amount += Number(l.amount || 0); }
  });
  const set = (k, v) => { const el = box.querySelector('[data-k="' + k + '"]'); if (el) el.innerHTML = v; };
  set('total', leads.length + '<small class="unit">人</small>');
  set('deal', deals.length + '<small class="unit">单</small>');
  set('amount', '<small>¥</small>' + Number(amount).toLocaleString('zh-CN'));
  set('avg', deals.length ? ('<small>¥</small>' + Math.round(amount / deals.length).toLocaleString('zh-CN')) : '—');
  const rateEl = box.querySelector('[data-k="dealRate"]');
  if (rateEl) rateEl.textContent = leads.length ? Math.round(deals.length / leads.length * 100) + '%' : '—';
  const todayEl = box.querySelector('[data-k="today"]');
  if (todayEl) todayEl.textContent = '+' + today;
}

function renderCrmTable() {
  const body = document.getElementById('crmRows');
  if (!body) return;
  const rows = (state.leads || []).slice(0, 40);
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-3);padding:28px">暂无线索。去「评论区获客」采集一轮，命中的评论会自动出现在这里。</td></tr>';
    return;
  }
  body.innerHTML = rows.map((l, i) => {
    const m = PF[l.platform] || PF.douyin;
    const sc = l.intent_score || 0;
    const acts = l.stage === 'new'
      ? '<button class="btn sm primary" data-act="send" data-id="' + l.id + '">立即私信</button>'
      : '<button class="btn sm" data-act="advance" data-id="' + l.id + '">推进</button>';
    return '<tr>' +
      '<td><div class="cell-user"><div class="' + avatarClass(i) + '">' + esc(initials(l.nickname)) + '</div>' +
        '<div><b>' + esc(l.nickname || '—') + '</b><span>' + esc(l.wechat_note || l.keyword || '—') + '</span></div></div></td>' +
      '<td><span class="tag blue">' + m.label + '</span></td>' +
      '<td style="color:var(--text-2)">' + esc(l.requirement || (l.comment || '').slice(0, 24) || '—') + '</td>' +
      '<td>' + scoreBar(sc, scoreColor(sc)) + '</td>' +
      '<td>' + stageTag(l.stage) + '</td>' +
      '<td>' + acts + '</td>' +
    '</tr>';
  }).join('');
}

/* ---- 评论区获客：线索流 ---- */
function renderLeadFeed() {
  const card = $('#leadFeedCard');
  if (!card) return;
  const rows = state.leads.slice().sort((a, b) => (b.intent_score || 0) - (a.intent_score || 0)).slice(0, 6);
  if (!rows.length) {
    card.innerHTML = '<div class="card-body" style="text-align:center;color:var(--text-3);padding:40px 20px;font-size:13px">暂无线索。开启关键词监听任务后，AI 会自动把高意向客户送到这里。</div>';
    return;
  }
  card.innerHTML = rows.map((l, i) => {
    const m = PF[l.platform] || PF.douyin;
    const sc = l.intent_score || 0;
    const cmt = esc(l.comment || '').replace(/(报价|预算|ROI|起量|代运营|投放|团购|CPL|线索|加个微信|留个电话|年框|合作)/g, '<em>$1</em>');
    const acts = l.stage === 'new'
      ? '<button class="btn sm primary" data-act="send" data-id="' + l.id + '"><svg class="icon"><use href="#i-send"/></svg>AI 代发私信</button>' +
        '<button class="btn sm" data-act="advance" data-id="' + l.id + '">加入 CRM</button>'
      : '<button class="btn sm" data-act="advance" data-id="' + l.id + '">推进到下一阶段</button>' +
        '<button class="btn sm ghost" data-act="drop" data-id="' + l.id + '">移入待唤醒</button>';
    const nick = l.wechat_note
      ? '<span class="tag green" style="margin-top:9px">备注：' + esc(l.wechat_note) + '</span>'
      : '<span class="tag" style="margin-top:9px">未加微</span>';
    return '<div class="lead">' +
      '<div class="' + avatarClass(i) + '" style="width:34px;height:34px;font-size:12px">' + esc(initials(l.nickname)) + '</div>' +
      '<div class="lead-body">' +
        '<div class="lead-top"><b>' + esc(l.nickname) + '</b><span class="tag green">意向 ' + sc + '</span>' + stageTag(l.stage) + '</div>' +
        '<div class="lead-cmt">“' + cmt + '”</div>' +
        '<div class="src-line">' + pfTag(l.platform) + m.label + ' · 关键词「' + esc(l.keyword || '—') + '」· 需求：' + esc(l.requirement || '—') + '</div>' +
        '<div class="lead-acts" style="margin-top:9px">' + acts + '</div>' +
        nick +
      '</div>' +
    '</div>';
  }).join('');
}

/* ---- CRM 看板 ---- */
function renderKanban() {
  const root = $('#kanbanRoot');
  if (!root) return;
  root.innerHTML = STAGES.map(st => {
    const m = STAGE_META[st];
    const rows = state.leads.filter(l => l.stage === st);
    const cards = rows.slice(0, 3).map((l, i) => {
      const pf = PF[l.platform] || PF.douyin;
      const foot = l.amount
        ? '<span class="tag" style="background:' + m.color + '1F;color:' + m.color + '">' + yuan(l.amount) + '</span>'
        : '<span class="tag">意向 ' + (l.intent_score || 0) + '</span>';
      return '<div class="kcard">' +
        '<b>' + esc(l.nickname) + '</b>' +
        '<div class="kline">' + pfTag(l.platform) + pf.label + ' · ' + esc(l.requirement || l.keyword || '—') + '</div>' +
        '<div class="kfoot">' + foot + '</div>' +
      '</div>';
    }).join('');
    const more = rows.length > 3 ? '<div style="text-align:center;font-size:11px;color:var(--text-3);padding:4px 0">还有 ' + (rows.length - 3) + ' 位</div>' : '';
    return '<div class="col">' +
      '<div class="col-head"><i style="background:' + m.color + '"></i>' + m.label + '<span class="cnt">' + rows.length + '</span></div>' +
      (cards || '<div style="text-align:center;font-size:11.5px;color:var(--text-3);padding:18px 0">暂无</div>') + more +
    '</div>';
  }).join('');
}

/* ---- 矩阵：剪辑任务 ---- */
function renderTasks() {
  const box = $('#taskList');
  if (!box) return;
  const rows = state.tasks.length ? state.tasks : [];
  if (!rows.length) {
    box.innerHTML = '<div style="text-align:center;color:var(--text-3);padding:34px 16px;font-size:13px">暂无剪辑任务。点击「一键跑完 7 步」创建第一个任务。</div>';
    return;
  }
  box.innerHTML = rows.slice(0, 4).map(t => {
    const st = t.status === 'done'
      ? { tag: 'blue', text: '待发布', cls: 'g' }
      : (t.status === 'running' ? { tag: 'violet', text: '剪辑中 ' + t.progress + '%', cls: '' }
                                : { tag: 'amber', text: '排队中', cls: 'a' });
    return '<div class="task-row">' +
      '<div class="task-ico" style="background:var(--primary-soft);color:var(--primary)"><svg class="icon"><use href="#i-scissors"/></svg></div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:8px"><b style="font-size:12.8px">' + esc(t.title) + '</b><span class="tag ' + st.tag + '">' + st.text + '</span></div>' +
        '<div class="progress ' + st.cls + '"><i style="width:' + (t.progress || 0) + '%"></i></div>' +
        '<div style="font-size:11px;color:var(--text-3);margin-top:6px">' + esc(t.note || '') + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

/* ---- 会员套餐 ---- */
function currentSub() {
  /* 服务端订单/订阅是唯一真相（/v1/billing/summary）；云端旧表只作兜底 */
  const s = state.billingSummary && state.billingSummary.subscription;
  if (s) {
    return {
      plan_code: s.planId,
      plan_name: s.planName,
      status: s.trial ? 'trial' : (s.status || 'active'),
      trial: !!s.trial,
      started_at: s.periodStart ? new Date(s.periodStart).toISOString() : '',
      expires_at: s.periodEnd ? new Date(s.periodEnd).toISOString() : '',
      order_no: s.orderNo || ''
    };
  }
  return state.subs.find(s2 => s2.status === 'active') || state.subs[0] || null;
}
function daysLeft(sub) {
  if (!sub || !sub.expires_at) return null;
  return Math.max(0, Math.ceil((new Date(sub.expires_at).getTime() - Date.now()) / 864e5));
}

/* ---- 计费：周期选择 ---- */
function currentCycle() {
  const pl = state.plans || [];
  const want = state.billingCycle || 'year';
  if (pl.some(p => p.prices && p.prices[want] != null)) return want;
  if (pl.some(p => p.prices && p.prices.year != null)) return 'year';
  if (pl.some(p => p.period === 'quarter')) return 'quarter';
  return 'year';
}
function pickCycle(p) {
  const prices = p.prices || {};
  const want = state.billingCycle || 'year';
  if (prices[want] != null) return want;
  if (prices.year != null) return 'year';
  if (prices.quarter != null) return 'quarter';
  if (prices.month != null) return 'month';
  return p.period || 'year';
}

/* ---- 计费：额度概览 ---- */
async function loadBillingSummary() {
  if (!Api.live()) return null;
  const r = await Api.call('/v1/billing/summary', null, { method: 'GET', timeout: 6000 });
  if (!r.ok || !r.data) return null;
  state.billingSummary = r.data;
  state.billingAt = Date.now();
  return r.data;
}

function quotaBar(label, left, quota, unit) {
  if (quota == null) return '';
  const un = Number(quota) < 0;
  const pct = un ? 100 : Math.max(0, Math.min(100, quota > 0 ? Math.round(left / quota * 100) : 0));
  const color = un ? 'var(--green)' : (pct <= 15 ? 'var(--red)' : (pct <= 40 ? 'var(--amber, #F5A524)' : 'var(--primary)'));
  const txt = un ? '不限量' : (left + ' / ' + quota + ' ' + (unit || ''));
  return '<div style="flex:1;min-width:150px">' +
    '<div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-3);margin-bottom:5px">' +
    '<span>' + label + '</span><span style="color:' + color + '">' + txt + '</span></div>' +
    '<div style="height:6px;border-radius:99px;background:var(--border);overflow:hidden">' +
    '<i style="display:block;height:100%;width:' + pct + '%;background:' + color + '"></i></div></div>';
}

function renderPayQuota() {
  const box = $('#payQuotaBox');
  if (!box) return;
  const s = state.billingSummary;
  if (!s || !Api.live()) { box.innerHTML = ''; return; }
  const sub = s.subscription;
  if (!sub) {
    box.innerHTML = '<div class="cur-plan" style="margin-bottom:16px"><div class="cp-ico"><svg class="icon"><use href="#i-wallet"/></svg></div>' +
      '<div><h3>尚未开通套餐 · 当前按体验额度放行</h3>' +
      '<p>采集与 GEO 会正常执行并记账，但不做拦截。开通后按套餐额度计量，超额前会明确提示。</p></div>' +
      '<div class="cp-right">' + (s.trialUsed ? '' : '<button class="btn primary" data-trial="1">免费试用 14 天</button>') + '</div></div>';
    return;
  }
  const left = s.left || {};
  const q = s.quota || {};
  const statusTxt = sub.trial ? '试用中' : '生效中';
  const need = sub.leftDays <= 7 && !sub.trial;
  box.innerHTML = '<div class="card" style="margin-bottom:16px"><div class="card-body" style="padding:16px 18px">' +
    '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px">' +
      '<b style="font-size:14px">' + esc(sub.planName) + '</b>' +
      '<span class="tag ' + (need ? 'amber' : 'green') + '">' + statusTxt + ' · 剩余 ' + sub.leftDays + ' 天</span>' +
      '<span style="font-size:11.5px;color:var(--text-3)">到期 ' + new Date(sub.periodEnd).toLocaleDateString('zh-CN') + '</span>' +
      '<span style="flex:1"></span>' +
      '<button class="btn w" data-pack="leads_1000">买加量包</button>' +
    '</div>' +
    '<div style="display:flex;gap:18px;flex-wrap:wrap">' +
      quotaBar('线索', left.leads, q.leads, '条') +
      quotaBar('剪辑', left.minutes, q.minutes, '分钟') +
      quotaBar('GEO', left.geo, q.geo, '次') +
    '</div>' +
    (s.packs && (s.packs.leads || s.packs.minutes || s.packs.geo)
      ? '<div style="font-size:11.5px;color:var(--text-3);margin-top:10px">加量包余额：' +
        [s.packs.leads ? s.packs.leads + ' 线索' : '', s.packs.minutes ? s.packs.minutes + ' 分钟' : '', s.packs.geo ? s.packs.geo + ' 次 GEO' : ''].filter(Boolean).join(' · ') + '</div>'
      : '') +
  '</div></div>';
}

function renderSidePlan() {
  const box = $('#sidePlan');
  if (!box) return;
  const sub = currentSub();
  if (state.demo) {
    box.innerHTML = '<b>演示模式</b><p>数据为样例，不会保存到云端</p><button data-go="v-pricing">查看套餐</button>';
  } else if (sub) {
    const d = daysLeft(sub);
    box.innerHTML = '<b>' + esc(sub.plan_name) + ' · 生效中</b><p>' + (d !== null ? '剩余 ' + d + ' 天' : '长期有效') + '</p><button data-go="v-pricing">管理套餐</button>';
  } else {
    box.innerHTML = '<b>尚未开通套餐</b><p>开通后解锁全部 AI 员工</p><button data-go="v-pricing">去开通</button>';
  }
}

function renderPricing() {
  const grid = $('#planGrid');
  if (!grid) return;
  const sub = currentSub();
  const curCode = sub ? sub.plan_code : null;
  const plans = state.plans.length ? state.plans : demoSlice('plans');

  /* 当前套餐卡 */
  const cur = $('#currentPlanBox');
  if (cur) {
    if (state.demo) {
      cur.innerHTML = '<div class="cur-plan"><div class="cp-ico"><svg class="icon"><use href="#i-spark"/></svg></div>' +
        '<div><h3>演示模式 · 未登录</h3><p>当前浏览的是样例数据。登录后可开通套餐，数据将保存到你的账号下。</p></div>' +
        '<div class="cp-right"><button class="btn w" data-login-now>登录后开通</button></div></div>';
    } else if (sub) {
      const d = daysLeft(sub);
      cur.innerHTML = '<div class="cur-plan"><div class="cp-ico"><svg class="icon"><use href="#i-crown"/></svg></div>' +
        '<div><h3>当前套餐：' + esc(sub.plan_name) + '</h3>' +
        '<p>订单号 ' + esc(sub.order_no || '—') + ' · 开通于 ' + (sub.started_at ? new Date(sub.started_at).toLocaleDateString('zh-CN') : '—') +
        (d !== null ? ' · 剩余 ' + d + ' 天' : '') + '</p></div>' +
        '<div class="cp-right"><button class="btn" data-go="v-settings">管理账号</button><button class="btn w" data-plan="' + esc(curCode) + '">续费</button></div></div>';
    } else {
      cur.innerHTML = '<div class="cur-plan"><div class="cp-ico"><svg class="icon"><use href="#i-crown"/></svg></div>' +
        '<div><h3>你还没有开通套餐</h3><p>免费试用数据中台与三大产品线；开通后解锁 5 位 AI 员工与云端数据保存。</p></div>' +
        '<div class="cp-right"><button class="btn w" data-plan="standard">推荐标准版</button></div></div>';
    }
  }

  /* 计费周期切换（服务端价目表里有哪档就显示哪档） */
  const sw = $('#cycleSwitch');
  if (sw) {
    const cyc = currentCycle();
    const CYC = [{ id: 'month', label: '月付' }, { id: 'quarter', label: '季付' }, { id: 'year', label: '年付' }];
    const avail = CYC.filter(c => plans.some(p => p.prices && p.prices[c.id] != null) || plans.some(p => p.period === c.id));
    if (avail.length > 1) {
      sw.innerHTML = avail.map(c => {
        const on = c.id === cyc;
        return '<button type="button" data-cycle="' + c.id + '" style="padding:6px 14px;border-radius:999px;font-size:12.5px;cursor:pointer;' +
          'border:1px solid ' + (on ? 'var(--primary)' : 'var(--border)') + ';' +
          'background:' + (on ? 'var(--primary-soft)' : 'transparent') + ';' +
          'color:' + (on ? 'var(--primary)' : 'var(--text-2)') + ';font-weight:' + (on ? '600' : '400') + '">' + c.label + '</button>';
      }).join('') + '<span style="font-size:11.5px;color:var(--text-3);margin-left:6px">年付按 10 个月计价，折合约 8.3 折</span>';
    } else {
      sw.innerHTML = '';
    }
  }

  /* 套餐卡片 */
  grid.innerHTML = plans.map(p => {
    const isCur = curCode === p.code;
    const prices = p.prices || {};
    const cyc = pickCycle(p);
    const price = prices[cyc] != null ? Number(prices[cyc]) : Number(p.price || 0);
    const unit = cyc === 'quarter' ? '季' : (cyc === 'month' ? '月' : '年');
    const per = '每' + unit + ' · ' + (p.seats || 1) + ' 个微信号';
    const hot = p.highlight && !isCur;
    const badge = isCur ? '<span class="cur-badge">当前套餐</span>' : (hot ? '<span class="plan-tag">最受欢迎</span>' : '');
    const save = cyc === 'year'
      ? '<div class="plan-save">折合 ' + yuan(Math.round(price / 12)) + ' / 月</div>'
      : (cyc === 'quarter'
        ? '<div class="plan-save" style="color:var(--text-3)">按季付，适合短期验证</div>'
        : '<div class="plan-save" style="color:var(--text-3)">按月付，随时可停</div>');
    const feats = (Array.isArray(p.features) ? p.features : []).map(f =>
      '<li><svg class="icon"><use href="#i-check"/></svg>' + esc(f) + '</li>').join('');
    const q = p.quota || {};
    const qLine = (q.leads != null || q.minutes != null)
      ? '<div style="font-size:11.5px;color:var(--text-3);margin-top:6px">' +
        (q.leads < 0 ? '线索不限' : (Number(q.leads).toLocaleString('zh-CN') + ' 线索/月')) + ' · ' +
        (q.minutes < 0 ? '剪辑不限' : (q.minutes + ' 分钟/月')) + ' · ' +
        (q.geo < 0 ? 'GEO 不限' : (q.geo + ' 次 GEO/月')) + '</div>'
      : '';
    const btn = isCur
      ? '<button class="btn lg" style="pointer-events:none;opacity:.6">当前使用中</button>'
      : '<button class="btn primary lg" data-plan="' + esc(p.code || p.id) + '">立即开通</button>';
    return '<div class="plan' + (hot ? ' hot' : '') + (isCur ? ' cur' : '') + '">' + badge +
      '<div class="plan-name">' + esc(p.name) + '</div>' +
      '<div class="plan-per">' + per + '</div>' +
      '<div class="plan-price"><em>¥</em><b>' + price.toLocaleString('zh-CN') + '</b><span>/ ' + unit + '</span></div>' +
      save + qLine +
      '<div class="plan-btn">' + btn + '</div>' +
      '<ul class="plan-feats">' + feats + '</ul>' +
    '</div>';
  }).join('');

  /* 权益对比 */
  const mt = $('#matrixTable');
  if (mt) {
    const codes = plans.map(p => p.code);
    const head = '<tr><th>权益项</th>' + plans.map(p => '<th>' + esc(p.name) + '</th>').join('') + '</tr>';
    mt.querySelector('thead').innerHTML = head;
    const ROWS = [
      ['微信号托管', { quarter: '1 个', basic: '2 个', standard: '5 个', flagship: '20 个' }],
      ['平台接入',   { quarter: '1 个', basic: '2 个', standard: '4 个全开', flagship: '4 个全开' }],
      ['线索额度',   { quarter: '500/月', basic: '2000/月', standard: '10000/月', flagship: '不设上限' }],
      ['AI 员工',    { quarter: '客服 + 销售', basic: '5 位全开', standard: '5 位全开', flagship: '5 位全开' }],
      ['评论区获客', { quarter: '✓', basic: '✓', standard: '✓', flagship: '✓' }],
      ['AI智能剪辑', { quarter: '—', basic: '30 条/月', standard: '200 条/月', flagship: '不限量' }],
      ['GEO直通车', { quarter: '—', basic: '—', standard: '方案', flagship: '全案 + 背书' }],
      ['AI 自动直播', { quarter: '—', basic: '—', standard: '—', flagship: '✓' }],
      ['服务支持',   { quarter: '工单', basic: '1v1 客服', standard: '专属运营顾问', flagship: '7×24 客户成功' }]
    ];
    mt.querySelector('tbody').innerHTML = ROWS.map(([k, m]) =>
      '<tr><td>' + k + '</td>' + codes.map(c => {
        const v = m[c] || '—';
        return '<td>' + (v === '✓' ? '<b>✓</b>' : (v === '—' ? '<span style="color:var(--text-3)">—</span>' : v)) + '</td>';
      }).join('') + '</tr>').join('');
  }

  /* 计费说明 / FAQ */
  const notes = $('#billingNotes');
  if (notes) {
    notes.innerHTML = [
      ['i-wallet', '支持对公转账、微信支付、支付宝；开通后立即生效。'],
      ['i-refresh', '套餐到期前 7 天自动提醒，可随时升级到更高版本，差价按剩余天数折算。'],
      ['i-shield', '7 天无理由退款（未使用线索额度超过 20% 的情况下）。'],
      ['i-flag', '线索额度按月重置，未用完不结转；旗舰版不设上限。']
    ].map(([ic, txt]) =>
      '<div class="note-row"><svg class="icon"><use href="#' + ic + '"/></svg><div>' + txt + '</div></div>').join('');
  }
  const faq = $('#faqBox');
  if (faq) {
    faq.innerHTML = [
      ['季度版和年付版的区别？', '功能一致，区别在托管微信号数量、平台数量与线索额度。季度版适合先验证效果，年付版折算下来平均每月更便宜。'],
      ['可以中途升级吗？', '可以。升级时按剩余天数折算差价，补完即生效，不会浪费已付费用。'],
      ['超额线索怎么算？', '超出当月额度后自动暂停采集，不会额外扣费；可随时升级套餐或等待次月重置。'],
      ['数据安全吗？', '所有客户数据按账号隔离存储，仅你本人可见；AI 通话与聊天记录全部留痕可追溯。']
    ].map(([q, a]) => '<div class="faq-q">' + q + '</div><div class="faq-a">' + a + '</div>').join('');
  }

  /* 阻止切换阶段的推进按钮误触发 */
  $$('[data-plan]', grid).forEach(b => b.addEventListener('click', () => subscribe(b.dataset.plan)));
  const rp = $('#currentPlanBox');
  if (rp) $$('[data-plan]', rp).forEach(b => b.addEventListener('click', () => subscribe(b.dataset.plan)));
  if (sw) $$('[data-cycle]', sw).forEach(b => b.addEventListener('click', () => {
    state.billingCycle = b.dataset.cycle;
    renderPricing();
  }));
  /* 演示态「登录后开通」 */
  if (rp) $$('[data-login-now]', rp).forEach(b => b.addEventListener('click', () => {
    document.body.classList.remove('demo-mode');
    state.demo = false;
    setStage('login');
  }));
  renderPayQuota();
}

/* =========================================================
   写操作
   ========================================================= */
const NEXT_STAGE = { new: 'sent', sent: 'wechat', wechat: 'nego', nego: 'deal', deal: 'deal', sleep: 'wechat' };

async function updateLead(id, patch) {
  if (state.demo || !cloud) {
    const l = state.leads.find(x => String(x.id) === String(id));
    if (l) Object.assign(l, patch);
    renderAll();
    return;
  }
  const r = await cloud.database.from('leads').update(patch).eq('id', id).select();
  if (r.error) { alert('操作失败：' + r.error.message); return; }
  if (!Array.isArray(r.data) || !r.data.length) { alert('这条线索不属于当前账号，未做修改。'); return; }
  await refreshData();
}

async function handleLeadAction(act, id) {
  const l = state.leads.find(x => String(x.id) === String(id));
  if (!l) return;
  if (act === 'send') {
    const next = l.stage === 'new' ? 'sent' : l.stage;
    await updateLead(id, { stage: next });
  } else if (act === 'advance') {
    const next = NEXT_STAGE[l.stage] || 'sent';
    const patch = { stage: next, updated_at: new Date().toISOString() };
    if (next === 'wechat' && !l.wechat_note) patch.wechat_note = l.nickname + '·' + (l.requirement || l.keyword || '意向客户');
    await updateLead(id, patch);
  } else if (act === 'drop') {
    await updateLead(id, { stage: 'sleep' });
  }
}

/* =========================================================
   计费：下单 → 支付 → 履约 → 刷新权益
   三条通道统一走服务端订单状态机，前端只负责展示差异：
     mock   自测通道，点一下就 paid（不发真实请求）
     manual 人工确认通道，展示收款信息，管理员确认到账
     wechat 微信支付 Native，展示 code_url 等回调
   ========================================================= */
const PAY_TEXT = {
  mock: {
    title: '模拟支付通道',
    note: '这是自测通道：点「模拟支付」会直接把订单标记为已支付并发放额度，不会产生任何真实收款。'
  },
  manual: {
    title: '人工确认通道',
    note: '请按下方信息转账，并在备注里写上订单号。管理员确认到账后额度立即到账（通常 10 分钟内）。'
  },
  wechat: {
    title: '微信支付',
    note: '用微信扫码完成支付，支付成功会自动开通，本页无需刷新。'
  }
};

function planByCode(code) {
  const list = (state.plans && state.plans.length) ? state.plans : demoSlice('plans');
  return list.find(p => p.code === code || p.id === code) || null;
}

function payModeOf(order) {
  return (order && order.payment && order.payment.payMode) || (state.billing && state.billing.provider) || 'mock';
}

/* 统一入口：套餐下单 */
async function subscribe(planCode) {
  if (!Api.live()) {
    alert('未连通服务端（BFF）。\n请先在「设置」里填服务端地址，再开通套餐。');
    return;
  }
  const plan = planByCode(planCode);
  if (!plan) { alert('未找到套餐：' + planCode); return; }
  const cycle = pickCycle(plan);
  if (state.demo) { alert('当前是演示模式，数据不会落库。请先登录再开通。'); return; }
  const r = await Api.createOrder({ planId: plan.id || plan.code, cycle: cycle });
  if (!r.ok) {
    const msg = (r.json && r.json.message) || r.error || '下单失败';
    alert('下单失败：' + msg);
    return;
  }
  openPayDialog(r.data);
}

/* 试用：不产生订单，直接发 14 天额度 */
async function startTrial() {
  if (!Api.live()) { alert('未连通服务端（BFF）。'); return; }
  if (!confirm('开通 14 天免费试用？\n额度：50 条线索 / 20 分钟剪辑 / 3 次 GEO，到期自动停止。')) return;
  const r = await Api.call('/v1/billing/trial', {}, { timeout: 10000 });
  if (!r.ok) {
    alert('试用开通失败：' + (((r.json || {}).message) || r.error || ''));
    return;
  }
  await refreshBilling();
  alert('试用已开通，额度已到账。');
}

/* 加量包：小额补量，不换套餐 */
async function openPackPicker() {
  if (!Api.live()) { alert('未连通服务端（BFF）。'); return; }
  const packs = (state.billing && state.billing.packs) || [];
  if (!packs.length) { alert('服务端未返回加量包配置（.data/billing-plans.json）。'); return; }
  const body = '<div class="pack-list">' + packs.map((p, i) =>
    '<button type="button" class="pack-item" data-buy="' + esc(p.id) + '">' +
      '<b>' + esc(p.name) + '</b><span>' + yuan(Number(p.amount || 0)) + '</span>' +
      '<div style="font-size:11.5px;color:var(--text-3);margin-top:4px">' + esc(p.note || (p.qty + ' ' + (p.unit || ''))) + '</div>' +
    '</button>').join('') + '</div>';
  const m = openModal({
    title: '购买加量包',
    sub: '加量包只补额度，不改变套餐与有效期',
    icon: 'i-wallet',
    body: body,
    okText: null,
    cancelText: '关闭'
  });
  const root = m && (m.mask || m);
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('[data-buy]').forEach(b => b.addEventListener('click', async () => {
    const pid = b.dataset.buy;
    if (m && m.close) m.close();
    const r = await Api.createOrder({ packId: pid });
    if (!r.ok) { alert('下单失败：' + (((r.json || {}).message) || r.error || '')); return; }
    openPayDialog(r.data);
  }));
}

/* 支付弹窗：按通道渲染不同内容 */
function openPayDialog(data) {
  const order = (data && data.order) || {};
  const pay = order.payment || data.payment || {};
  const mode = payModeOf(order);
  const txt = PAY_TEXT[mode] || { title: '支付', note: '' };
  const amount = Number(order.amount || 0);
  const kind = order.kind === 'pack' ? '加量包' : '套餐';

  let body = '<div class="pay-box">' +
    '<div class="pay-amt"><em>¥</em><b>' + amount.toLocaleString('zh-CN') + '</b></div>' +
    '<div class="pay-meta">' + esc(kind) + ' · ' + esc(order.name || '') + (order.cycleLabel ? ' · ' + esc(order.cycleLabel) : '') + '</div>' +
    '<div class="pay-meta" style="color:var(--text-3);font-size:11.5px">订单号 ' + esc(order.orderNo || '') + '</div>' +
    '<div class="pay-note">' + esc(txt.note) + '</div>';

  if (mode === 'manual') {
    const qr = pay.qrUrl || pay.payUrl || '';
    body += '<div class="pay-manual">' +
      (qr ? '<img src="' + esc(qr) + '" alt="收款码" style="width:180px;height:180px;object-fit:contain;border-radius:10px;border:1px solid var(--border)">' : '') +
      (pay.account ? '<div style="margin-top:8px;font-size:12.5px">收款账户：' + esc(pay.account) + '</div>' : '') +
      (!qr && !pay.account ? '<div style="color:var(--amber,#F5A524);font-size:12.5px">服务端未配置收款信息（PAY_MANUAL_QR_URL / PAY_MANUAL_ACCOUNT），订单已生成但暂时无法付款。</div>' : '') +
      '</div>';
  } else if (mode === 'wechat') {
    const code = pay.codeUrl || pay.payUrl || '';
    body += '<div class="pay-wx">' +
      (code
        ? '<canvas class="pay-qr" id="payQr" width="180" height="180"></canvas>'
        : '') +
      '<div style="font-size:12.5px;margin:10px 0 6px">支付链接（也可复制到手机微信打开）：</div>' +
      '<div class="pay-code">' + esc(code || '未获取到支付链接，请检查微信支付配置（/v1/billing/health）') + '</div>' +
      '</div>';
  }

  body += '<div class="pay-status" id="payStatus">' +
    (order.status === 'paid' || order.status === 'fulfilled'
      ? '<b style="color:var(--green)">已支付，权益已生效</b>'
      : '等待支付…') + '</div></div>';

  const footer = mode === 'mock'
    ? '<button class="btn" data-m="cancel" type="button">关闭</button><button class="btn primary" data-m="ok" type="button">模拟支付</button>'
    : (mode === 'manual'
      ? '<button class="btn" data-m="cancel" type="button">稍后付款</button><button class="btn primary" data-m="ok" type="button">确认到账（管理员）</button>'
      : '<button class="btn" data-m="cancel" type="button">关闭</button>');

  const m = openModal({
    title: txt.title,
    sub: '订单已生成，2 小时内未支付自动关闭',
    icon: 'i-wallet',
    body: body,
    footer: footer,
    onOk: async () => {
      const st = document.getElementById('payStatus');
      if (st) st.textContent = '确认中…';
      const r = await Api.call('/v1/billing/orders/' + encodeURIComponent(order.orderNo) + '/pay', {}, { timeout: 15000 });
      if (!r.ok) {
        if (st) st.innerHTML = '<b style="color:var(--red)">' + esc(((r.json || {}).message) || r.error || '确认失败') + '</b>';
        return true;
      }
      if (st) st.innerHTML = '<b style="color:var(--green)">支付成功，权益已生效</b>';
      await refreshBilling();
      setTimeout(() => { if (m && m.close) m.close(); }, 900);
      return true;
    }
  });

  /* 微信通道：把 code_url 画成二维码，省得用户复制链接 */
  if (mode === 'wechat') {
    const code = pay.codeUrl || pay.payUrl || '';
    const cv = document.getElementById('payQr');
    if (cv && code && window.PFQR && window.PFQR.draw) {
      try { window.PFQR.draw(cv, code, { width: 180, quiet: 3, dark: '#161528', light: '#ffffff' }); } catch (e) {}
    }
  }

  /* 非 mock 通道：轮询订单状态，回调到了自动收口 */
  if (mode !== 'mock' && order.orderNo) pollOrder(order.orderNo, m);
}

let _pollTimer = null;
function pollOrder(orderNo, modal) {
  if (_pollTimer) clearInterval(_pollTimer);
  let n = 0;
  _pollTimer = setInterval(async () => {
    n += 1;
    if (n > 200) { clearInterval(_pollTimer); _pollTimer = null; return; }
    const r = await Api.orderStatus(orderNo);
    if (!r.ok || !r.data || !r.data.order) return;
    const o = r.data.order;
    const st = document.getElementById('payStatus');
    if (o.status === 'paid' || o.status === 'fulfilled') {
      clearInterval(_pollTimer); _pollTimer = null;
      if (st) st.innerHTML = '<b style="color:var(--green)">支付成功，权益已生效</b>';
      await refreshBilling();
      setTimeout(() => { if (modal && modal.close) modal.close(); }, 1200);
    } else if (o.status === 'closed') {
      clearInterval(_pollTimer); _pollTimer = null;
      if (st) st.innerHTML = '<b style="color:var(--red)">订单已超时关闭，请重新下单</b>';
    }
  }, 3000);
}

/* 刷新套餐 + 额度（进入套餐页时调用） */
async function refreshBilling() {
  try {
    const plans = await loadPlans();
    if (Array.isArray(plans) && plans.length) state.plans = plans;
    await loadBillingSummary();
  } catch (e) {}
  renderPricing();
  renderSidePlan();
}

/* =========================================================
   渲染调度 & 数据刷新
   ========================================================= */
/* ---- 看板趋势图：由真实线索绘制 7 日曲线 ----
   模板里原本是一条写死的上升折线（含 +23.4% 气泡），与真实数据无关。
   这里按 created_at 分 7 个自然日桶，绘制「意向线索 / 加微成功」双线；
   无数据时隐藏画布、显示统一空态。 */
function renderTrendChart(leads) {
  const svg = document.getElementById('trendSvg');
  const empty = document.getElementById('trendEmpty');
  if (!svg) return;
  const days = 7;
  const buckets = [];
  const labels = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    buckets.push({ start: d.getTime(), end: d.getTime() + 864e5, total: 0, added: 0 });
    labels.push((d.getMonth() + 1) + '/' + d.getDate());
  }
  (leads || []).forEach(l => {
    const ts = Date.parse(l.created_at || '') || 0;
    if (!ts) return;
    const b = buckets.find(x => ts >= x.start && ts < x.end);
    if (!b) return;
    b.total++;
    if (['wechat', 'nego', 'deal'].indexOf(l.stage) > -1) b.added++;
  });

  if (!leads || !leads.length) {
    svg.style.display = 'none';
    if (empty) empty.hidden = false;
    return;
  }
  svg.style.display = 'block';
  if (empty) empty.hidden = true;

  const maxVal = Math.max(4, ...buckets.map(b => b.total));
  const step = Math.ceil(maxVal / 4);
  const top = step * 4;
  const X = i => 40 + i * ((598 - 40) / (days - 1));
  const Y = v => 180 - (v / top) * 160;
  const pts = key => buckets.map((b, i) => X(i) + ',' + Y(b[key]).toFixed(1)).join(' ');
  const area = 'M' + X(0) + ',' + Y(buckets[0].total).toFixed(1) + ' ' +
    buckets.slice(1).map((b, i) => 'L' + X(i + 1) + ',' + Y(b.total).toFixed(1)).join(' ') +
    ' L' + X(days - 1) + ',180 L' + X(0) + ',180 Z';
  const grid = [0, 1, 2, 3, 4].map(i => {
    const y = 180 - i * 40;
    return '<line x1="40" y1="' + y + '" x2="612" y2="' + y + '" stroke="#F0F0F7" stroke-width="1"/>' +
      '<text x="30" y="' + (y + 4) + '" fill="#8E8DA5" font-size="11" font-family="system-ui" text-anchor="end">' + (step * i) + '</text>';
  }).join('');
  const dots = (key, color) => buckets.map((b, i) =>
    '<circle cx="' + X(i) + '" cy="' + Y(b[key]).toFixed(1) + '" r="3.2" fill="#fff" stroke="' + color + '" stroke-width="2"/>'
  ).join('');
  const xLabels = labels.map((lb, i) =>
    '<text x="' + X(i) + '" y="202" fill="' + (i === days - 1 ? '#4C3FE4' : '#8E8DA5') + '"' +
    (i === days - 1 ? ' font-weight="700"' : '') + '>' + (i === days - 1 ? '今日' : lb) + '</text>'
  ).join('');

  svg.innerHTML =
    '<defs><linearGradient id="areaG" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#4C3FE4" stop-opacity=".22"/>' +
      '<stop offset="100%" stop-color="#4C3FE4" stop-opacity="0"/>' +
    '</linearGradient></defs>' +
    '<g>' + grid + '</g>' +
    '<path d="' + area + '" fill="url(#areaG)"/>' +
    '<polyline points="' + pts('total') + '" fill="none" stroke="#4C3FE4" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<polyline points="' + pts('added') + '" fill="none" stroke="#F5A524" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
    dots('total', '#4C3FE4') + dots('added', '#F5A524') +
    '<g fill="#8E8DA5" font-size="11" font-family="system-ui" text-anchor="middle">' + xLabels + '</g>';
}

/* ---- 看板右栏：平台分布 / 加微转化 / 数据口径 ----
   全部由 state.leads 计算，无数据统一空态。
   改造前这里是模板写死的 38/24/22/16%、84%、1,846 条私信与 12/312/46 战绩，
   和左侧真实 KPI 同屏出现两套口径。 */
function renderDashInsights() {
  const leads = state.leads || [];
  const total = leads.length;
  const added = leads.filter(l => ['wechat', 'nego', 'deal'].indexOf(l.stage) > -1).length;

  renderTrendChart(leads);

  /* 1) 平台分布 */
  const box = document.getElementById('platSplit');
  if (box) {
    if (!total) {
      box.innerHTML = '<div class="empty" style="padding:18px 12px">暂无线索数据</div>';
    } else {
      const names = { douyin: '抖音', kuaishou: '快手', xhs: '小红书', sph: '视频号' };
      const pcls = { douyin: 'dy', kuaishou: 'ks', xhs: 'xhs', sph: 'sph' };
      const counts = {};
      leads.forEach(l => {
        const k = l.platform || 'other';
        counts[k] = (counts[k] || 0) + 1;
      });
      box.innerHTML = Object.keys(counts)
        .sort((a, b) => counts[b] - counts[a])
        .slice(0, 4)
        .map(k => {
          const pct = Math.round((counts[k] / total) * 100);
          const label = names[k] || (window.PF && PF[k] && PF[k].label) || k;
          const color = 'var(--' + (['douyin', 'kuaishou', 'xhs', 'sph'].indexOf(k) > -1 ? k : 'primary') + ')';
          return '<div class="bar-row">' +
            '<div class="nm"><span class="pf ' + (pcls[k] || 'dy') + '">' + label.charAt(0) + '</span>' + label + '</div>' +
            '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
            '<div class="pc">' + pct + '%</div>' +
          '</div>';
        })
        .join('');
    }
  }

  /* 2) 加微转化率（环图） */
  const rate = total ? Math.round((added / total) * 100) : 0;
  const arc = document.getElementById('convArc');
  const val = document.getElementById('convVal');
  const sub = document.getElementById('convSub');
  if (arc && val && sub) {
    if (!total) {
      val.textContent = '—';
      arc.setAttribute('stroke-dashoffset', '169.6');
      sub.textContent = '暂无线索数据';
    } else {
      val.textContent = rate + '%';
      arc.setAttribute('stroke-dashoffset', String((169.6 * (1 - rate / 100)).toFixed(1)));
      sub.textContent = '共 ' + total + ' 条线索，已加微 ' + added + ' 条';
    }
  }

  /* 3) 数据口径 */
  const q = document.getElementById('dataQuality');
  if (q) {
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const today = leads.filter(l => (Date.parse(l.created_at || '') || 0) >= t0.getTime()).length;
    const scored = leads.filter(l => Number(l.intent_score) > 0);
    const avg = scored.length ? Math.round(scored.reduce((s, l) => s + Number(l.intent_score || 0), 0) / scored.length) : 0;
    const withText = leads.filter(l => (l.comment || l.requirement || '').length > 0).length;
    q.innerHTML =
      '<div class="dq-grid">' +
        '<div><b>' + total + '</b><span>线索总量</span></div>' +
        '<div><b>' + today + '</b><span>今日新增</span></div>' +
        '<div><b>' + (total ? Math.round((withText / total) * 100) + '%' : '—') + '</b><span>含原始评论</span></div>' +
        '<div><b>' + (scored.length ? avg : '—') + '</b><span>平均意向分</span></div>' +
      '</div>' +
      '<p class="dq-note">口径：按去重后的有效意向客户计；成交金额取 CRM 已回款订单。' +
      (state.demo ? '当前为演示数据，不写入生产库。' : '') + '</p>';
  }

  /* 4) 数据来源标签 */
  const tag = document.getElementById('dashSourceTag');
  if (tag) {
    tag.textContent = state.demo ? '演示数据' : '实时数据';
    tag.className = 'tag ' + (state.demo ? 'amber' : 'green');
  }
}

function renderAll() {
  renderKPIs();
  renderDashInsights();
  renderLeadTable();
  renderLeadFeed();
  renderKanban();
  renderCrmKpis();
  renderCrmTable();
  renderTasks();
  renderSidePlan();
  renderPricing();
}

async function refreshData() {
  /* 以前这里是 `if (state.demo || !cloud) return;` —— 云端一挂，
     看板和 CRM 就整体不刷新，页面停在旧数字上还看不出来。
     现在数据来自本服务，只要不是演示态就刷。 */
  if (state.demo) return;
  await loadCloudData();
  if (typeof renderAll === 'function') renderAll();
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b) { handleLeadAction(b.dataset.act, b.dataset.id); }
});

/* =========================================================
   启动流程
   ========================================================= */
async function enterApp(isDemo) {
  applyBffTokenFromInput();
  state.demo = !!isDemo;
  document.body.classList.toggle('demo-mode', state.demo);
  document.body.classList.remove('pre-auth');
  /* 先给应用外壳，再做数据加载：任何一步失败都不允许把用户退回登录页（F5 掉登录的根因） */
  setStage('app');

  /* 每一步数据加载独立容错，失败只降级不清场 */
  const soft = async (fn, tag) => {
    try { await fn(); } catch (e) { try { console.warn('[boot:' + tag + ']', e); } catch (e2) {} }
  };

  if (state.demo) {
    let ds = null;
    try { ds = await loadDemoDataset(); } catch (e) {}
    if (!ds) {
      state.demo = false;
      document.body.classList.remove('demo-mode');
      alert('演示数据服务未启动。\n请先运行 start-local.cmd，再通过「先看 DEMO 演示」进入。');
      setStage('login');
      return;
    }
    state.demoData = ds;
    window.__DEMO_DATA__ = ds;
    try { document.dispatchEvent(new CustomEvent('demo:ready', { detail: ds })); } catch (e) {}
    state.leads = (ds.leads || []).slice();
    state.subs = [];
    state.tasks = (ds.tasks || []).slice();
  }
  await soft(async function () { state.plans = await loadPlans(); }, 'plans');
  if (!state.demo) await soft(loadCloudData, 'cloud');

  await soft(async function () {
    if (state.session && state.session.user) {
      const u = state.session.user;
      const label = u.phone || u.email || u.name || '已登录';
      const av = $('.avatar');
      if (av) av.textContent = String(label).replace(/\D/g, '').slice(-2) || '盈';
    }
    renderAll();
  }, 'render');
  setStage('app');
  /* 计费额度：首屏聚合已带回 billing.summary 时直接用，不再重复拉
     plans + summary（之前每次进首页都会多打两个请求）。旧服务端没有
     overview 时才走 refreshBilling。 */
  if (!state.demo) {
    try {
      /* 只认 30 秒内的快照：换账号重新登录时不能拿着上一个账号的额度 */
      const fresh = state.billingSummary && (Date.now() - Number(state.billingAt || 0) < 30000);
      if (fresh) { renderPricing(); renderSidePlan(); }
      else refreshBilling();
    } catch (e) {}
  }
  /* F5 后停留在原页面：hash 优先，其次上次浏览记录（localStorage） */
  let initView = location.hash.slice(1);
  if (!META[initView]) { try { initView = localStorage.getItem('pf.view') || ''; } catch (e) { initView = ''; } }
  try { go(META[initView] ? initView : 'v-dashboard'); } catch (e) { try { go('v-dashboard'); } catch (e2) {} }
}

function showLogin() {
  setStage('login');
  const box = $('#boot');
  if (box) box.style.display = 'none';
}

/* 前向兜底：bffToken/authToken 的正式定义在后面的「服务层 Api」块（约 10.8k 行）。
   自部署环境没有 cloud SDK，boot 的同步流不会 await 让出，走到 6013 的 if (bffToken())
   时后面块还没执行 → ReferenceError 直接打断启动链（页面卡在 boot/空白，顶栏按钮全失效）。
   这里提前给一份等价实现；后面块的 var 声明会覆盖同名绑定，行为一致。 */
var bffToken = bffToken || function () {
  try { return localStorage.getItem('pf.bff.token') || ''; } catch (e) { return ''; }
};
var authToken = authToken || function () {
  try { return localStorage.getItem('pf.auth.token') || ''; } catch (e) { return ''; }
};

(async function boot() {
  /* 1. 本地账号票先向服务端验一次：过期的 localStorage 票不能直接进应用，
        否则会进到一个“每个接口都 401”的空壳页面（账号 0、作品 0、漏斗一直转）。 */
  if (authToken()) {
    try {
      const me = await Api.call('/v1/auth/me', null, { method: 'GET', timeout: 6000 });
      if (me && me.ok && me.data && me.data.user) {
        state.session = { user: me.data.user, local: true, source: 'local' };
        await enterApp(false);
        return;
      }
      if (me && me.ok && me.data && me.data.user === null) {
        try { localStorage.removeItem('pf.auth.token'); } catch (e) {}
        if (bffToken()) {
          try { await enterApp(false); } catch (e) {}
          return;
        }
        showLogin();
        return;
      }
    } catch (e) {}
    /* 网络失败或服务端不可用：有 BFF 令牌仍可进；否则回登录页 */
    if (bffToken()) {
      try { await enterApp(false); } catch (e) {}
      return;
    }
    showLogin();
    return;
  }

  /* 2. 只有 BFF 令牌（IP/自部署版）时直接进；它本身就是服务端管理员令牌 */
  if (bffToken()) {
    try { await enterApp(false); } catch (e) { try { console.warn('[boot]', e); } catch (e2) {} }
    return;
  }

  /* 3. 本地没票但服务端可能还有有效会话（HttpOnly Cookie）：问一次 /v1/auth/me */
  try {
    const me = await Api.call('/v1/auth/me', null, { method: 'GET', timeout: 6000 });
    if (me && me.ok && me.data && me.data.user) {
      state.session = { user: me.data.user, local: true, source: 'local' };
      await enterApp(false);
      return;
    }
  } catch (e) {}

  /* 4. 显式演示入口保留，仅调试用 */
  if (location.search.indexOf('demo') > -1) { await enterApp(true); return; }

  /* 5. 确实没有任何凭证 → 登录页（plan 拉取失败也不阻塞，登录框照常显示） */
  try { state.plans = await loadPlans(); } catch (e) {}
  showLogin();
})();

/* ---------- 登录页交互绑定 ---------- */
$('#demoBtn').addEventListener('click', () => enterApp(true));

/* 自部署版兜底入口：云登录失效时，凭已注入的 BFF 令牌直接进入真实应用 */
var _bffEnter = $('#bffEnterBtn');
if (_bffEnter) _bffEnter.addEventListener('click', function () {
  applyBffTokenFromInput();
  if (!bffToken()) { var e = document.getElementById('bffTokenErr'); if (e) e.textContent = '请先在上方粘贴服务端令牌'; return; }
  enterApp(false);
});

/* ---------- IP 版登录页：BFF 令牌输入框（登录时自动写入 localStorage） ---------- */
function applyBffTokenFromInput() {
  try {
    var el = document.getElementById('bffTokenInput');
    if (!el) return;
    var v = (el.value || '').trim();
    if (!v) return;
    if (!/^[A-Za-z0-9_\-]{8,128}$/.test(v)) return;
    if (v === bffToken()) return;
    window.PF.setToken(v);          /* 同步写入 localStorage，并异步换 HttpOnly Cookie */
  } catch (e) {}
}
(function initBffTokenField() {
  try {
    var wrap = document.getElementById('bffTokenWrap');
    if (!wrap) return;
    /* 只在 IP / 本地部署时显示：域名版登录走账号票，令牌字段纯属干扰 */
    var host = String(location.hostname || '');
    var isIpOrLocal = isLoopbackHost() || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    if (!isIpOrLocal) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var inp = document.getElementById('bffTokenInput');
    var st = document.getElementById('bffState');
    var cur = bffToken();
    if (cur) {
      try { inp.value = cur; } catch (e) {}
      if (st) { st.textContent = '已设置'; st.className = 'bff-tag ok'; }
    }
    function save() {
      var v = (inp.value || '').trim();
      var err = document.getElementById('bffTokenErr');
      if (!v) { if (err) err.textContent = ''; return; }
      if (!/^[A-Za-z0-9_\-]{8,128}$/.test(v)) {
        if (err) err.textContent = '令牌格式错误（8–128 位字母/数字或 _ -）';
        return;
      }
      window.PF.setToken(v);
      if (st) { st.textContent = '已保存'; st.className = 'bff-tag ok'; }
      if (err) err.textContent = '';
    }
    var btn = document.getElementById('bffTokenSave');
    if (btn) btn.addEventListener('click', save);
    if (inp) inp.addEventListener('blur', save);
  } catch (e) {}
})();
/* ---------- 本地账号登录（云端登录失效时的兜底路径） ----------
   账号体系在 server/auth.js：密码 scrypt 加盐、会话票 HMAC 签名、失败限流。
   登录成功后把票写进 localStorage，bffHeaders 会优先带它，等价于持有服务端令牌。 */
(function initLocalAuth() {
  var wrap = document.getElementById('localAuthWrap');
  if (!wrap) return;
  /* 官方域名版没有本地 BFF，隐藏 */
  if (/aizhiying\.app\.workbuddy\.host$/i.test(String(location.hostname || ''))) {
    wrap.style.display = 'none';
    return;
  }
  var err = document.getElementById('localAuthErr');
  var st = document.getElementById('localAuthState');
  var title = document.getElementById('authTitle');
  var sub = document.getElementById('authSub');
  var tabLogin = document.getElementById('authTabLogin');
  var tabRegister = document.getElementById('authTabRegister');
  var regFields = document.getElementById('localRegFields');
  var forgot = document.getElementById('localForgotBtn');
  var mode = 'login';
  var registerMode = 'closed';
  function showErr(m) { if (err) err.textContent = m || ''; }

  function setMode(next) {
    if (next === 'register' && registerMode === 'closed') {
      showErr('注册未开放，请联系管理员开通账号');
      return;
    }
    mode = next === 'register' ? 'register' : 'login';
    if (tabLogin) tabLogin.classList.toggle('on', mode === 'login');
    if (tabRegister) tabRegister.classList.toggle('on', mode === 'register');
    if (regFields) regFields.style.display = mode === 'register' ? '' : 'none';
    if (title) title.textContent = mode === 'register' ? '创建工作区账号' : '登录';
    if (sub) sub.textContent = mode === 'register'
      ? '用邀请码加入工作区；管理员可在账号体系里分配角色'
      : '手机号 + 密码 · 账号只存在本服务器，不出网';
    var btn = document.getElementById('localLoginBtn');
    if (btn) btn.textContent = mode === 'register' ? '注册并登录' : '登录';
    var pwd = document.getElementById('localPwd');
    if (pwd) pwd.setAttribute('autocomplete', mode === 'register' ? 'new-password' : 'current-password');
    showErr('');
  }

  function submit() {
    var phone = (document.getElementById('localPhone') || {}).value || '';
    var pwd = (document.getElementById('localPwd') || {}).value || '';
    var pwd2 = (document.getElementById('localPwd2') || {}).value || '';
    var name = (document.getElementById('localName') || {}).value || '';
    var company = (document.getElementById('localCompany') || {}).value || '';
    var code = (document.getElementById('localCode') || {}).value || '';
    phone = phone.trim();
    showErr('');
    if (!/^1\d{10}$/.test(phone)) { showErr('请输入 11 位手机号'); return; }
    if (String(pwd).length < 8) { showErr('密码至少 8 位'); return; }
    if (mode === 'register') {
      if (pwd2 !== pwd) { showErr('两次输入的密码不一致'); return; }
      if (registerMode === 'code' && !String(code).trim()) { showErr('请填写管理员提供的邀请码'); return; }
      var agree = document.getElementById('agreeChk');
      if (agree && !agree.checked) { showErr('请先同意服务协议与隐私政策'); return; }
    }
    var btn = document.getElementById('localLoginBtn');
    var old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = mode === 'register' ? '注册中…' : '登录中…'; }
    var url = ((window.RT && RT.bffBase) || '') + '/v1/auth/' + (mode === 'register' ? 'register' : 'login');
    var body = { phone: phone, password: pwd };
    if (mode === 'register') {
      body.name = String(name).trim();
      body.company = String(company).trim();
      body.code = String(code).trim();
    }
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (btn) { btn.disabled = false; btn.textContent = old; }
      if (!d || !d.ok) { showErr((d && (d.message || d.error)) || '操作失败'); return; }
      setAuthToken(d.token);
      state.session = { user: d.user, local: true, source: 'local' };
      if (st) { st.textContent = '已登录'; st.className = 'bff-tag ok'; }
      (async function () {
        try { await enterApp(false); }
        catch (e) {
          bootView.style.display = 'none';
          document.body.classList.remove('pre-auth');
          $('#app').style.display = 'flex';
          loginView.classList.remove('show');
          try { renderAll(); } catch (e2) {}
          try { go('v-dashboard'); } catch (e3) {}
        }
      })();
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = old; }
      showErr('连不上服务端，请检查网络或稍后重试');
    });
  }

  var loginBtn = document.getElementById('localLoginBtn');
  if (loginBtn) loginBtn.addEventListener('click', submit);
  if (tabLogin) tabLogin.addEventListener('click', function () { setMode('login'); });
  if (tabRegister) tabRegister.addEventListener('click', function () { setMode('register'); });
  var pw = document.getElementById('localPwd');
  if (pw) pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  if (forgot) forgot.addEventListener('click', function () {
    var phone = (document.getElementById('localPhone') || {}).value || '';
    fetch(((window.RT && RT.bffBase) || '') + '/v1/auth/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone.trim() })
    }).then(function (r) { return r.json(); }).then(function (d) {
      showErr((d && (d.message || d.error)) || '请联系管理员重置密码');
    }).catch(function () { showErr('请联系管理员重置密码'); });
  });

  /* 注册开关由服务端决定（REGISTER_CODE 未配置 = 关闭）。
     注册入口只在服务端允许时出现，不做“点了必 403”的假按钮。 */
  fetch(((window.RT && RT.bffBase) || '') + '/v1/auth/status', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      registerMode = (d && d.register) || 'closed';
      if (tabRegister) tabRegister.style.display = (registerMode === 'code' || registerMode === 'open') ? '' : 'none';
      if (registerMode === 'closed' && st) { st.textContent = '请用已开通的账号'; st.className = 'bff-tag'; }
    })
    .catch(function () { if (tabRegister) tabRegister.style.display = 'none'; });
})();

var _dl = $('#demoLoginBtn');
if (_dl) _dl.addEventListener('click', () => {
  document.body.classList.remove('demo-mode');
  state.demo = false;
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  setStage('login');
});

/* ---------- 顶栏用户菜单 ---------- */
(function userMenu() {
  const topbar = $('.topbar');
  const avatar = $('.avatar');
  if (!topbar || !avatar) return;
  const menu = document.createElement('div');
  menu.className = 'user-menu';
  menu.id = 'userMenu';
  menu.innerHTML = '<div class="um-head"><b id="umName">未登录</b><span id="umSub">演示模式</span></div>' +
    '<button data-go="v-pricing"><svg class="icon"><use href="#i-crown"/></svg>我的套餐</button>' +
    '<button data-go="v-settings"><svg class="icon"><use href="#i-setting"/></svg>账号设置</button>' +
    '<button id="umPassword"><svg class="icon"><use href="#i-lock"/></svg>修改密码</button>' +
    '<button id="umLogout"><svg class="icon"><use href="#i-logout"/></svg>退出登录</button>';
  topbar.appendChild(menu);
  avatar.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('show'); });
  document.addEventListener('click', () => menu.classList.remove('show'));
  menu.addEventListener('click', e => e.stopPropagation());
  $$('[data-go]', menu).forEach(b => b.addEventListener('click', () => { menu.classList.remove('show'); go(b.dataset.go); }));
  $('#umPassword').addEventListener('click', function () { menu.classList.remove('show'); openPasswordModal(); });
  $('#umLogout').addEventListener('click', signOut);
})();

/* 修改密码：登录用户的常规自助入口 */
function openPasswordModal() {
  if (document.getElementById('pwdMask')) return;
  var mask = document.createElement('div');
  mask.id = 'pwdMask';
  mask.className = 'pwd-mask';
  mask.innerHTML = '<div class="pwd-box" role="dialog" aria-modal="true">' +
    '<h4>修改密码</h4>' +
    '<input id="pwdOld" type="password" placeholder="原密码" autocomplete="current-password">' +
    '<input id="pwdNew" type="password" placeholder="新密码（至少 8 位）" autocomplete="new-password">' +
    '<input id="pwdNew2" type="password" placeholder="确认新密码" autocomplete="new-password">' +
    '<div class="pwd-err" id="pwdErr"></div>' +
    '<div class="pwd-acts"><button class="btn ghost" id="pwdCancel" type="button">取消</button>' +
    '<button class="btn primary" id="pwdSave" type="button">保存</button></div></div>';
  document.body.appendChild(mask);
  var close = function () { try { mask.remove(); } catch (e) {} };
  document.getElementById('pwdCancel').addEventListener('click', close);
  mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
  document.getElementById('pwdSave').addEventListener('click', async function () {
    var oldPwd = (document.getElementById('pwdOld') || {}).value || '';
    var newPwd = (document.getElementById('pwdNew') || {}).value || '';
    var newPwd2 = (document.getElementById('pwdNew2') || {}).value || '';
    var err = document.getElementById('pwdErr');
    var btn = document.getElementById('pwdSave');
    var say = function (m) { if (err) err.textContent = m || ''; };
    if (!oldPwd) return say('请输入原密码');
    if (newPwd.length < 8) return say('新密码至少 8 位');
    if (newPwd !== newPwd2) return say('两次输入的新密码不一致');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    try {
      var r = await Api.call('/v1/auth/password', { oldPassword: oldPwd, newPassword: newPwd }, { timeout: 20000 });
      if (!r || r.ok === false) { say((r && (r.error || r.message)) || '修改失败'); return; }
      if (r.data && r.data.token) setAuthToken(r.data.token);
      if (window.toast) toast('密码已修改', 'ok', '账号');
      close();
    } catch (e) { say('修改失败，请稍后重试'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '保存'; } }
  });
}

/* 更新用户菜单文案 */
const _origRenderSide = renderSidePlan;
renderSidePlan = function () {
  _origRenderSide();
  const n = $('#umName'), s = $('#umSub');
  if (!n) return;
  if (state.demo) { n.textContent = '演示账号'; s.textContent = '数据不会保存'; return; }
  if (state.session && state.session.user) {
    const u = state.session.user;
    n.textContent = u.name || (u.phone ? ('手机号 ' + String(u.phone).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')) : '已登录用户');
    const roleText = u.role === 'owner' ? '所有者' : u.role === 'admin' ? '管理员' : '成员';
    s.textContent = (u.company || '工作区') + ' · ' + roleText;
  } else {
    n.textContent = '未登录';
    s.textContent = '请先登录';
  }
};

