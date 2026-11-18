'use strict';
const fs = require('fs');
const path = require('path');
/* =========================================================
   collect-adapters/registry.js — 采集通道注册表
   ---------------------------------------------------------
   本系统同时支持两类截然不同的评论来源，它们的合规边界、
   数据半径、运维成本都不一样，所以不能揉成一个「上游」：

     official  自有内容评论区 —— 平台官方开放能力
               只能读「自己账号发布的作品」下的评论。
               合规最干净，但获客半径 = 自有内容量。
     crawler   自建爬虫 —— 抓第三方公开评论
               半径最大，但登录态 / 限速 / 改版维护全自理，
               且违反平台协议，风险自负。
     vendor    第三方数据服务 —— 采购的有资质数据源
               等价于原来的 COLLECT_UPSTREAM，保持完全兼容。
     local     本地模拟 —— 仅 ALLOW_LOCAL_COLLECT=1
               只用于没通道时跑通链路，生产必须关闭。

   核心概念是 scope（采集范围）：
     own      只采自有账号作品下的评论 —— 只有 official 原生支持
     keyword  按关键词搜公开内容         —— vendor / crawler 支持

   「兼顾两种模式」的落点就是 resolve()：任务不指定通道时，
   按 scope 决定候选顺序，第一个已配置的通道胜出。
   ========================================================= */

/** 通道 id 全集（auto 不是真实通道，是「自动选择」的占位） */
const CHANNEL_IDS = ['auto', 'plugin', 'official', 'crawler', 'vendor', 'local'];
const REAL_IDS = ['plugin', 'official', 'crawler', 'vendor'];
const SCOPE_IDS = ['auto', 'own', 'keyword'];

/* 浏览器采集器的在线探针由 index.js 在启动时注入（registry 是叶子模块，
   不能反向 require 设备中枢，否则循环依赖）。 */
let DEVICE_PROBE = null;
function setDeviceProbe(fn) { DEVICE_PROBE = typeof fn === 'function' ? fn : null; }


const DEFS = {
  plugin: {
    id: 'plugin',
    name: '浏览器采集器',
    short: '本地采集',
    kind: 'device',
    scope: 'keyword',
    urlEnv: '',
    tokenEnv: '',
    timeoutEnv: 'COLLECT_PLUGIN_TIMEOUT_MS',
    /* 60 秒：一次「搜索页 + 3 条作品评论」实测 25~35 秒。
       再长就会顶到 Cloudflare 100 秒的代理上限，所以宁可如实超时。 */
    timeout: 60000,
    needToken: false,
    risk: 'low',
    scopes: ['keyword', 'own'],
    desc: '装在使用者电脑上的浏览器扩展：用他自己的登录态读已渲染的搜索页与评论区，'
      + '抓取不发生在本服务器；登录态不外传、不存 cookie',
    fix: '在「评论区获客」左栏点「连接本机采集器」，按提示启动本机桥并在 Chrome 里加载扩展'
  },
  official: {
    id: 'official',
    name: '自有内容评论区',
    short: '官方通道',
    kind: 'official',
    scope: 'own',
    urlEnv: 'COLLECT_OFFICIAL_URL',
    tokenEnv: 'COLLECT_OFFICIAL_TOKEN',
    ownerEnv: 'COLLECT_OFFICIAL_OWNER',
    timeoutEnv: 'COLLECT_OFFICIAL_TIMEOUT_MS',
    timeout: 20000,
    needToken: false,
    risk: 'low',
    scopes: ['own'],
    /* 从未接通：生产环境没有配置网关地址。留在代码里备将来接官方开放平台，
       但不参与自动选择，避免「以为走了官方通道、其实没走」的误判。 */
    dormant: true,
    desc: '平台官方开放能力，只能读自有账号作品的评论；合规最干净，获客半径取决于自有内容量',
    fix: 'COLLECT_OFFICIAL_URL=<官方网关地址> COLLECT_OFFICIAL_OWNER=<自有账号标识>（令牌按网关要求填 COLLECT_OFFICIAL_TOKEN）'
  },
  crawler: {
    id: 'crawler',
    name: '自建爬虫',
    short: '自建通道',
    kind: 'crawler',
    scope: 'keyword',
    urlEnv: 'COLLECT_CRAWLER_URL',
    tokenEnv: 'COLLECT_CRAWLER_TOKEN',
    timeoutEnv: 'COLLECT_CRAWLER_TIMEOUT_MS',
    timeout: 60000,
    needToken: false,
    risk: 'high',
    scopes: ['keyword', 'own'],
    desc: '自建爬虫，抓第三方公开评论；不占官方配额，但登录态、限速、验证码与改版维护全部自理',
    fix: 'COLLECT_CRAWLER_URL=http://crawler:8801（内网地址即可；非可信网络再配 COLLECT_CRAWLER_TOKEN）'
  },
  vendor: {
    id: 'vendor',
    name: '第三方数据服务',
    short: '供应商',
    kind: 'vendor',
    scope: 'keyword',
    urlEnv: 'COLLECT_UPSTREAM',
    tokenEnv: 'COLLECT_TOKEN',
    timeoutEnv: 'COLLECT_TIMEOUT_MS',
    timeout: 15000,
    needToken: true,
    risk: 'medium',
    scopes: ['keyword'],
    /* 同上：采购接口一直没接。显式传 channel=vendor 仍可用，
       但 auto 不会在用户不知情时把数据发到第三方。 */
    dormant: true,
    desc: '采购的有资质数据服务，可跨平台跨账号；把数据来源的合规责任交给供应商',
    fix: 'COLLECT_UPSTREAM=<供应商地址> COLLECT_TOKEN=<供应商令牌>'
  },
  local: {
    id: 'local',
    name: '本地模拟',
    short: '模拟',
    kind: 'local',
    scope: 'keyword',
    urlEnv: '',
    tokenEnv: '',
    timeoutEnv: '',
    timeout: 0,
    needToken: false,
    risk: 'demo',
    scopes: ['keyword'],
    desc: '本地生成演示数据，仅用于没有通道时跑通「任务 → 入池 → CRM」链路；生产必须关闭',
    fix: '取消 ALLOW_LOCAL_COLLECT'
  }
};

function def(id) {
  return DEFS[String(id || '').trim().toLowerCase()] || null;
}

/* =========================================================
   运行时通道地址覆盖（体验 / 运维用）
   ---------------------------------------------------------
   设计目标：让前端「采集服务配置」填的地址真正被 BFF 消费，
   而不必改环境变量 + 重启。覆盖项保存在 .data/collect-override.json，
   进程启动即加载，保存即时生效（in-memory + 落盘）。

   优先级：运行时覆盖 > 环境变量。
   清空某通道覆盖（url 传空）即回退到环境变量 / 未配置态。
   ========================================================= */
const DATA_ROOT = (process.env.DATA_ROOT || '.data').replace(/\/+$/, '');
const OVERRIDE_FILE = path.join(DATA_ROOT, 'collect-override.json');
let OVERRIDE = {};
(function loadOverride() {
  try {
    const txt = fs.readFileSync(OVERRIDE_FILE, 'utf8');
    const obj = JSON.parse(txt);
    if (obj && typeof obj === 'object') OVERRIDE = obj;
  } catch (e) { OVERRIDE = {}; }
})();

function setOverride(id, url, token) {
  const d = DEFS[id];
  if (!d || !d.urlEnv) return false;
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) {
    delete OVERRIDE[id];
  } else {
    OVERRIDE[id] = { url: u, token: String(token || '').trim() };
  }
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(OVERRIDE, null, 2));
  } catch (e) { /* 落盘失败不致命，内存态仍生效 */ }
  return true;
}

/** 通道上游地址（去掉尾部斜杠，运行时覆盖优先） */
function urlOf(id) {
  const d = DEFS[id];
  if (!d || !d.urlEnv) return '';
  if (OVERRIDE[id] && OVERRIDE[id].url) return OVERRIDE[id].url;
  return String(process.env[d.urlEnv] || '').replace(/\/+$/, '');
}

function tokenOf(id) {
  const d = DEFS[id];
  if (!d || !d.tokenEnv) return '';
  if (OVERRIDE[id] && OVERRIDE[id].token) return OVERRIDE[id].token;
  return String(process.env[d.tokenEnv] || '');
}

function timeoutOf(id) {
  const d = DEFS[id];
  if (!d) return 15000;
  const t = d.timeoutEnv ? Number(process.env[d.timeoutEnv] || 0) : 0;
  return t > 0 ? t : d.timeout;
}

/** 自有账号标识（official 通道必需） */
function ownerOf() {
  return String(process.env.COLLECT_OFFICIAL_OWNER || '').trim();
}

/** 某通道是否已具备可用条件 */
function configured(id) {
  if (id === 'local') return process.env.ALLOW_LOCAL_COLLECT === '1';
  /* 浏览器采集器没有地址可配：有在线的采集端才算「可用」，
     这样装了插件自动优先走它，没装就自动退到爬虫/供应商，不用改任务 */
  if (id === 'plugin') return !!(DEVICE_PROBE && DEVICE_PROBE());
  const d = DEFS[id];
  if (!d || !d.urlEnv) return false;
  return !!urlOf(id);
}

/** 是否至少接入了一条可用通道（dormant 的空壳不算） */
function hasReal() {
  return REAL_IDS.some((id) => !DEFS[id].dormant && configured(id));
}

/**
 * 按 scope 给出候选顺序。
 * 这是「兼顾两种模式」的核心：own 场景先试官方通道（唯一原生支持自有内容的），
 * keyword 场景先试供应商与爬虫 —— 官方通道读不到别人作品下的评论，故不列入。
 */
function orderFor(scope) {
  const s = String(scope || 'auto').toLowerCase();
  /* 自动选择只走两条真通道，顺序固定：
       plugin（用使用者自己的登录态，数据最真、风控最低）→ crawler（自建爬虫/本机桥）
     official / vendor 是 dormant 空壳，只有任务显式指定 channel 时才会用。 */
  if (s === 'own') return ['plugin', 'crawler'];
  if (s === 'keyword') return ['plugin', 'crawler'];
  return ['plugin', 'crawler'];
}

/**
 * 解析本次采集该走哪条通道。
 * @param {string} [requested] 任务指定的通道 id，或 'auto'
 * @param {string} [scope]     'own' | 'keyword' | 'auto'
 * @returns {{ok:true,channel:string,why:string}|{ok:false,code:string,message:string,fix:string,candidates:string[]}}
 */
function resolve(requested, scope) {
  const want = String(requested || 'auto').trim().toLowerCase();
  const sc = String(scope || 'auto').trim().toLowerCase();
  const scopes = SCOPE_IDS.indexOf(sc) > -1 ? sc : 'auto';
  const cands = orderFor(scopes);

  if (want && want !== 'auto') {
    const d = def(want);
    if (!d) {
      return {
        ok: false, code: 'CHANNEL_UNKNOWN',
        message: '未知采集通道「' + want + '」，可选：' + CHANNEL_IDS.join(' / '),
        fix: '改用 ' + CHANNEL_IDS.join(' / ') + ' 之一', candidates: cands
      };
    }
    if (!configured(want)) {
      return {
        ok: false, code: 'CHANNEL_NOT_CONFIGURED', channel: want,
        message: d.name + '（' + want + '）未接入：' + d.fix,
        fix: d.fix, candidates: [want]
      };
    }
    return { ok: true, channel: want, why: '任务指定通道' };
  }

  const forced = String(process.env.COLLECT_DEFAULT_CHANNEL || '').trim().toLowerCase();
  if (forced && forced !== 'auto' && def(forced) && configured(forced)) {
    return { ok: true, channel: forced, why: 'COLLECT_DEFAULT_CHANNEL 指定' };
  }

  for (let i = 0; i < cands.length; i++) {
    if (configured(cands[i])) {
      return { ok: true, channel: cands[i], why: '自动选择（范围 ' + scopes + '，优先 ' + cands.join(' → ') + '）' };
    }
  }
  if (configured('local')) {
    return { ok: true, channel: 'local', why: '无可用通道，且已显式开启 ALLOW_LOCAL_COLLECT（数据为本地模拟）' };
  }
  return {
    ok: false, code: 'UPSTREAM_NOT_CONFIGURED',
    message: '没有可用的采集通道：装浏览器采集器（plugin）或配置自建爬虫（COLLECT_CRAWLER_URL）。'
      + '官方通道与第三方数据服务目前是 dormant 空壳，未参与自动选择。',
    fix: '在「评论区获客」左栏点「连接本机采集器」，或配置 COLLECT_CRAWLER_URL',
    candidates: cands
  };
}

/** 对外可查询的通道清单（不探测，只看配置） */
function list() {
  return CHANNEL_IDS.filter((id) => id !== 'auto').map((id) => {
    const d = DEFS[id];
    return {
      id: d.id, name: d.name, short: d.short, kind: d.kind, scope: d.scope,
      configured: configured(id), risk: d.risk, needToken: d.needToken,
      /* dormant：代码保留但从未接线，不参与自动选择；前端据此显示「未启用」 */
      dormant: !!d.dormant,
      scopes: d.scopes.slice(), desc: d.desc, fix: d.fix,
      upstream: d.urlEnv ? urlOf(id) : '',
      tokenSet: !!(d.tokenEnv && tokenOf(id)),
      timeoutMs: timeoutOf(id),
      /* 官方通道缺 owner 时即便配了地址也拿不到自有内容，这里显式暴露 */
      missing: missingOf(id)
    };
  });
}

/** 该通道缺什么才算可用；返回中文缺失项清单 */
function missingOf(id) {
  const d = DEFS[id];
  const miss = [];
  if (id === 'local') return miss;
  if (!d || !d.urlEnv) return miss;
  if (!urlOf(id)) miss.push(d.urlEnv);
  if (d.needToken && !tokenOf(id)) miss.push(d.tokenEnv);
  if (d.id === 'official' && !ownerOf()) miss.push(d.ownerEnv);
  return miss;
}

module.exports = {
  CHANNEL_IDS, REAL_IDS, SCOPE_IDS, DEFS,
  def, urlOf, tokenOf, timeoutOf, ownerOf,
  configured, hasReal, orderFor, resolve, list, missingOf,
  setOverride, overrideFile: OVERRIDE_FILE, setDeviceProbe
};
