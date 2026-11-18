'use strict';
/* =========================================================================
 * background.js — 浏览器采集器的执行侧
 * -------------------------------------------------------------------------
 * 它只干三件事：
 *   1) 每 1.2 秒问一次本机桥「有活吗」（本机桥再去云端领任务）
 *   2) 有活就在后台标签页里打开搜索页 / 视频页，等渲染完读 DOM
 *   3) 把读到的结构化数据交回本机桥（桥再转云端入池）
 *
 * 三条刻意的克制：
 *   · 不读 cookie、不碰 localStorage、不调任何私有接口 —— 只读「用户自己
 *     已经看得见的页面」，所以平台改版只会让选择器失效，不会触发风控对抗。
 *   · 不主动登录、不绕验证码、不点关注不私信 —— 账号行为与真人一致。
 *   · 抓取跑在用户自己的浏览器与 IP 上；本服务器全程不接触平台。
 * ========================================================================= */

const BRIDGE = 'http://127.0.0.1:8801';
const VERSION = chrome.runtime.getManifest().version;
/* 平台 ID 必须与服务端一致（collect-sched.PLATFORMS = douyin/xhs/kuaishou/sph）。
   之前上报 xiaohongshu，服务端按 xhs 匹配设备，小红书任务永远派不下来。 */
const PLATFORMS = ['douyin', 'xhs', 'kuaishou', 'sph'];
/* 服务端 ID → 站点（用于拼 URL 和识别页面域名） */
const SITE_OF = { douyin: 'douyin', xhs: 'xiaohongshu', kuaishou: 'kuaishou', sph: 'channels' };
/* 站点 → 服务端 ID（页面侧解析结果回传前统一） */
const PF_OF_SITE = { douyin: 'douyin', xiaohongshu: 'xhs', kuaishou: 'kuaishou', channels: 'sph' };
const SITE_LABEL = { douyin: '抖音', xiaohongshu: '小红书', kuaishou: '快手', channels: '视频号' };

let busy = false;
let online = false;
let lastError = '';
const stat = { done: 0, failed: 0, lastJob: '', lastAt: 0, lastNotes: 0, lastComments: 0 };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function api(path, opt) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const o = Object.assign({}, opt || {});
    o.signal = ctl.signal;
    o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    if (o.body && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
    const r = await fetch(BRIDGE + path, o);
    const txt = await r.text();
    let body = null;
    try { body = txt ? JSON.parse(txt) : null; } catch (e) { body = null; }
    return { status: r.status, ok: r.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 注入到页面里的采集函数（必须自包含） ---------- */
async function pageCollector(opts) {
  const o = opts || {};
  const host = location.hostname;
  /* 站点识别：域名 → 内部站点名 → 服务端平台 ID（回传用服务端 ID） */
  const site = host.indexOf('xiaohongshu') >= 0 ? 'xiaohongshu'
    : host.indexOf('kuaishou') >= 0 ? 'kuaishou'
    : (host.indexOf('channels.weixin') >= 0 || host === 'channels.weixin.qq.com') ? 'channels'
    : 'douyin';
  const pfId = ({ douyin: 'douyin', xiaohongshu: 'xhs', kuaishou: 'kuaishou', channels: 'sph' })[site] || 'douyin';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const all = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const txt = (el) => (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
  const pick = (sels, root) => {
    for (let i = 0; i < sels.length; i++) {
      const e = (root || document).querySelector(sels[i]);
      if (e) return e;
    }
    return null;
  };
  const scan = (sels, root) => {
    /* 多套选择器里挑「命中最多的那一套」：平台改版常常只是换一层壳，
       新旧选择器同时存在时取最多的，比写死一套稳 */
    let best = [];
    for (let i = 0; i < sels.length; i++) {
      const list = all(sels[i], root);
      if (list.length > best.length) best = list;
    }
    return best;
  };
  const num = (s) => {
    const t = String(s || '').replace(/\s+/g, '');
    const m = t.match(/([\d.]+)\s*(亿|万|w|W|k|K)?/);
    if (!m) return 0;
    let n = parseFloat(m[1]);
    if (!isFinite(n)) return 0;
    if (m[2] === '万' || m[2] === 'w' || m[2] === 'W') n *= 10000;
    else if (m[2] === '亿') n *= 100000000;
    else if (m[2] === 'k' || m[2] === 'K') n *= 1000;
    return Math.round(n);
  };
  const abs = (href) => {
    try { return new URL(href, location.origin).href; } catch (e) { return String(href || ''); }
  };
  const bodyTxt = document.body ? (document.body.innerText || '') : '';
  const loginWall = /扫码登录|登录后查看|登录后可见|请先登录/.test(bodyTxt);

  if (o.mode === 'search') {
    /* 各站结果卡选择器：scan() 会在多套里挑命中最多的，平台改版只换壳时也稳 */
    const CARD_SELS = {
      xiaohongshu: ['section.note-item', 'div.note-item', '.feeds-page .note-item'],
      kuaishou: ['a[href*="/short-video/"]', 'div[class*="video-card"]', '.card-wrapper'],
      /* 视频号搜索页是自定义组件，没有通用卡片类名，靠多套猜测 + 通用兜底 */
      channels: ['[class*="feeds__item"]', '.search-result__item', '[class*="video-item"]', '[class*="item-card"]'],
      douyin: [
        '[data-e2e="scroll-list"] li',
        'ul[data-e2e="scroll-list"] > li',
        '[data-e2e="search-result-container"] li',
        'div[data-e2e="search-result"] li'
      ]
    };
    const cardSel = CARD_SELS[site] || CARD_SELS.douyin;
    const waitUntil = Date.now() + (o.waitMs || 12000);
    let cards = [];
    while (Date.now() < waitUntil) {
      cards = scan(cardSel);
      if (cards.length >= 6) break;
      await sleep(600);
    }
    /* 滚动加载更多：抖音/小红书都是虚拟列表，不滚就只有首屏 4~6 条 */
    const want = Math.max(4, Math.min(50, Number(o.limit) || 20));
    for (let i = 0; i < (o.scrolls || 5) && cards.length < want; i++) {
      window.scrollBy(0, 1300);
      await sleep(900);
      const next = scan(cardSel);
      if (next.length >= cards.length) cards = next;
    }
    if (!cards.length) {
      /* 兜底 1：直接抓页面上的作品链接（视频/笔记/短视频） */
      const linkPat = site === 'kuaishou' ? '/short-video/' : (site === 'xiaohongshu' ? '/explore/' : '/video/');
      const anchors = all('a[href]');
      const seenA = {};
      cards = anchors.filter((a) => {
        const h = a.getAttribute('href') || '';
        if (!h || seenA[h]) return false;
        seenA[h] = 1;
        return h.indexOf(linkPat) >= 0 || h.indexOf('/note/') >= 0 || h.indexOf('/explore/') >= 0;
      });
      /* 兜底 2（视频号搜索页没有 <a> 链接）：按「文本像标题的最小容器」组卡，
         用标题拼伪链接保证作品能入库展示（点开是搜索页） */
      if (!cards.length && site === 'channels') {
        const cand = all('div,li,section').filter((el) => {
          const t = txt(el);
          if (t.length < 8 || t.length > 90) return false;
          return !el.querySelector('div,li,section');
        });
        const seenT = {};
        cards = cand.filter((el) => {
          const t = txt(el);
          if (seenT[t]) return false;
          seenT[t] = 1;
          return true;
        }).slice(0, 30);
      }
    }
    const notes = [];
    const seen = {};
    for (let i = 0; i < cards.length && notes.length < want; i++) {
      const c = cards[i];
      const a = c.matches && c.matches('a') ? c : pick(['a[href*="/video/"]', 'a[href*="/short-video/"]', 'a[href*="/explore/"]', 'a[href*="/note/"]'], c);
      const href = abs((a && a.getAttribute('href')) || '');
      const m = href.match(/\/(video|short-video|explore|note)\/([A-Za-z0-9]+)/);
      let nid = m ? m[2] : '';
      let url = href || (nid ? (site === 'xiaohongshu' ? 'https://www.xiaohongshu.com/explore/' + nid
        : site === 'kuaishou' ? 'https://www.kuaishou.com/short-video/' + nid
        : 'https://www.douyin.com/video/' + nid) : '');
      const title = (txt(pick(['[data-e2e="video-desc"]', '.video-desc', '.title span', '.footer .title', 'span.title', '[class*="title"]'], c)) || txt(c).slice(0, 60)).slice(0, 120);
      /* 视频号兜底卡没有链接：用标题生成稳定伪 URL（同标题 = 同键，去重仍有效） */
      if (!url && title) {
        nid = '';
        url = 'https://channels.weixin.qq.com/web/pages/search?keyword=' + encodeURIComponent(o.keyword || '') +
          '&via=card&t=' + encodeURIComponent(title.slice(0, 40));
      }
      if (!url || seen[url]) continue;
      seen[url] = 1;
      const authorEl = pick(['[data-e2e="video-author"]', '.author .name', '.author-wrapper .name', '.name', 'span.author', '[class*="author"]'], c);
      const likeEl = pick(['[data-e2e="video-like"]', '.like-wrapper .count', '.count', '.like-count', '[class*="like"]'], c);
      const img = c.querySelector('img');
      notes.push({
        platform: pfId,
        note_id: nid,
        title: title,
        url: url,
        author: txt(authorEl).replace(/^@/, '').slice(0, 40),
        cover: (img && (img.getAttribute('src') || img.getAttribute('data-src'))) || '',
        liked: num(txt(likeEl)),
        comments: 0,
        collected: 0,
        keyword: o.keyword || '',
        publishAt: ''
      });
    }
    return { ok: true, mode: 'search', notes, loginWall, pageTitle: document.title, href: location.href };
  }

  /* ---------- 视频页：读评论 ---------- */
  const commentSel = site === 'xiaohongshu'
    ? ['.comment-item', '.comment-list .item']
    : site === 'kuaishou'
      ? ['[class*="comment-item"]', '.comment-item', '[data-e2e="comment-item"]']
      : site === 'channels'
        ? ['[class*="comment-item"]', '.comment-item', '[class*="comment"] li']
        : ['[data-e2e="comment-item"]', '.comment-item', 'div[data-e2e="comment-list"] > div'];
  const waitEnd = Date.now() + (o.waitMs || 10000);
  let items = [];
  while (Date.now() < waitEnd) {
    items = scan(commentSel);
    if (items.length) break;
    await sleep(600);
  }
  for (let i = 0; i < (o.scrolls || 4); i++) {
    window.scrollBy(0, 1000);
    await sleep(800);
  }
  items = scan(commentSel);
  const wantC = Math.max(1, Math.min(50, Number(o.limit) || 20));
  const out = [];
  const seenC = {};
  for (let i = 0; i < items.length && out.length < wantC; i++) {
    const el = items[i];
    const nickEl = pick(['[data-e2e="comment-username"]', '.user-name', '.author .name', 'a[href*="/user/"]', '.name'], el);
    const contentEl = pick(['[data-e2e="comment-content"]', '.content .note-text', '.comment-content', '.content', 'p'], el);
    const likeEl = pick(['[data-e2e="comment-like-count"]', '.like-wrapper .count', '.like-count'], el);
    const content = txt(contentEl).replace(/\s+/g, ' ').trim();
    if (!content || content.length < 2) continue;
    const nick = txt(nickEl).replace(/^@/, '').slice(0, 40) || '匿名用户';
    const key = nick + '|' + content.slice(0, 40);
    if (seenC[key]) continue;
    seenC[key] = 1;
    out.push({
      platform: pfId,
      nickname: nick,
      comment: content.slice(0, 500),
      likes: num(txt(likeEl)),
      at: '',
      region: '',
      cid: '',
      video_title: o.videoTitle || '',
      video_url: o.videoUrl || location.href,
      author: o.author || '',
      keyword: o.keyword || ''
    });
  }
  return { ok: true, mode: 'video', comments: out, loginWall, pageTitle: document.title, href: location.href };
}

/* ---------- 标签页控制 ---------- */
function waitComplete(tabId, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (e) {}
      resolve();
    };
    const onUpd = (id, info) => { if (id === tabId && info && info.status === 'complete') fin(); };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === 'complete') fin(); }).catch(fin);
    setTimeout(fin, timeout || 25000);
  });
}

async function inject(tabId, func, args) {
  /* 注意：不要传 awaitPromise —— 新版 Chrome 已移除该参数，
     传了会报 "Unexpected property: 'awaitPromise'" 导致整轮任务失败。
     官方文档：注入函数返回 Promise 时浏览器会自动等待结算再回传 result，
     所以 async 的注入函数不需要任何额外参数。 */
  const res = await chrome.scripting.executeScript({ target: { tabId }, func, args: args || [] });
  return (res && res[0] && res[0].result) || null;
}

async function scrape(tabId, opts) {
  return inject(tabId, pageCollector, [opts]);
}

/* ---------- 注入到页面里的「分步执行」函数（每个都必须自包含） ----------
   为什么拆成多步：过程要能被看见。扩展每做完一步就向本机桥报一次进度，
   云端把进度追加到 job.steps，页面中栏的作品卡片实时画出来 ——
   用户能看到「打开页面 → 定位评论区 → 点赞 → 写入 → 发送」卡在哪一步。

     cmtPrepare 滚动页面 + 识别登录墙 + 找评论输入框
     cmtType    聚焦 + 写入 + 校验（contenteditable 走 execCommand）
     cmtSubmit  找发送按钮 + 点击 + 校验
     likePoster 找点赞按钮 + 判断是否已赞 + 点击

   共同约束：只做真人会做的事，不碰 cookie、不调私有接口、不模拟鼠标轨迹。
   失败时把「试过哪些选择器、卡在哪一步」原样带回，便于按真实 DOM 校准。
   ---------------------------------------------------------- */

async function cmtPrepare(opts) {
  const o = opts || {};
  const host = location.hostname;
  const site = host.indexOf('xiaohongshu') >= 0 ? 'xiaohongshu'
    : host.indexOf('kuaishou') >= 0 ? 'kuaishou'
      : host.indexOf('weixin') >= 0 ? 'channels'
        : 'douyin';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const all = (sel, root) => {
    try { return Array.from((root || document).querySelectorAll(sel)); } catch (e) { return []; }
  };
  const INPUT = {
    douyin: ['[data-cc-input="1"]', '[data-e2e="comment-input"]', '[data-e2e="comment-input"] [contenteditable]',
      '.comment-input-inner-container [contenteditable]', '.public-DraftEditor-content',
      '[contenteditable="true"]', '[contenteditable="plaintext-only"]', '[role="textbox"]', 'textarea'],
    xiaohongshu: ['[data-cc-input="1"]', '#content-textarea', '.input-box [contenteditable]', '.content-input',
      '[placeholder*="说点什么"]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]', '[role="textbox"]', 'textarea'],
    kuaishou: ['[data-cc-input="1"]', '[class*="comment-input"] [contenteditable]', '[class*="commentInput"]',
      'textarea[placeholder]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]', '[role="textbox"]', 'textarea'],
    channels: ['[data-cc-input="1"]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]', '[role="textbox"]', 'textarea[placeholder]', 'textarea']
  };
  /* 视频页默认不展开评论区：必须像真人一样点一下「评论」入口，
     输入框才会挂载。只滚页面是找不到的（截图里卡住的就是这一步）。 */
  const TRIGGER = {
    douyin: ['[data-e2e="comment-icon"]', '[data-e2e="feed-comment-icon"]',
      '[data-e2e="video-comment"]', '[aria-label*="评论"]', '[title*="评论"]'],
    xiaohongshu: ['[class*="comment-icon"]', '[class*="comment"] [class*="icon"]', '[aria-label*="评论"]'],
    kuaishou: ['[class*="comment"] [class*="icon"]', '[class*="comment-btn"]', '[aria-label*="评论"]'],
    channels: ['[class*="comment"] [class*="icon"]', '[aria-label*="评论"]']
  };
  /* 新版抖音/小红书编辑器不一定写 contenteditable="true"，
     可能是 plaintext-only、role=textbox 或空的 contenteditable。
     所以最后再用 isContentEditable 全页扫一遍，别只认固定选择器。 */
  const findEditable = () => {
    const els = all('*');
    let fallback = null;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (!vis(el)) continue;
      const tag = String(el.tagName || '').toLowerCase();
      const role = el.getAttribute && el.getAttribute('role');
      const ce = el.getAttribute && el.getAttribute('contenteditable');
      if (!(el.isContentEditable || ce !== null || tag === 'textarea' || role === 'textbox')) continue;
      if (el.disabled || el.readOnly) continue;
      const ph = String((el.getAttribute && (el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('data-placeholder'))) || '');
      if (/搜索|search/i.test(ph)) continue;
      if (el.closest && el.closest('header,[class*="search"],[data-e2e*="search"],[id*="search"]')) continue;
      const inComment = el.closest && el.closest('[data-e2e*="comment"],[class*="comment"],[id*="comment"]');
      if (/评论|说点什么|留下|comment/i.test(ph) || inComment) return { el: el, sel: '__editable' };
      if (!fallback) fallback = { el: el, sel: '__editable' };
    }
    return fallback;
  };
  const findInput = () => {
    const tried = INPUT[site] || INPUT.douyin;
    for (let i = 0; i < tried.length; i++) {
      const els = all(tried[i]);
      for (let j = 0; j < els.length; j++) {
        if (vis(els[j])) return { el: els[j], sel: tried[i] };
      }
    }
    return findEditable();
  };
  const isLoginWall = () => {
    const t = String(document.body && document.body.innerText || '');
    const wallRe = /登录后(才可|可以|参与|查看|评论)|请先登录|扫码登录|手机号登录|验证码登录|登录\/注册|立即登录/;
    const loggedRe = /退出登录|我的主页|个人中心|发布作品/;
    return wallRe.test(t) && !loggedRe.test(t);
  };
  const loginLabel = () => {
    const els = all('button,[role="button"],a,span');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (!vis(el)) continue;
      const t = String(el.innerText || '').trim();
      if (t.length <= 6 && /^(登录|立即登录|登录\/注册|扫码登录|手机号登录)$/.test(t)) return t;
    }
    return '';
  };
  /* 抖音视频页经常是整屏播放：评论不在首屏，而且不一定挂在 window 上，
     真正滚动的是某个 overflow:auto 的容器。所以 window 和内部滚动容器都要推到底。 */
  const revealComments = async () => {
    const doc = document.scrollingElement || document.documentElement;
    const h = Math.max(doc.scrollHeight || 0, document.body ? document.body.scrollHeight : 0);
    const spots = [0, Math.round(h * 0.45), h];
    for (let i = 0; i < spots.length; i++) {
      window.scrollTo(0, spots[i]);
      await sleep(220);
    }
    window.scrollTo(0, h);
    let n = 0;
    const els = all('*');
    for (let i = 0; i < els.length && n < 14; i++) {
      const el = els[i];
      try {
        if (el.scrollHeight <= el.clientHeight + 80) continue;
        const st = getComputedStyle(el);
        if (!/(auto|scroll)/.test(st.overflowY)) continue;
        el.scrollTop = el.scrollHeight;
        n++;
      } catch (e) {}
    }
    await sleep(350);
  };
  const openCommentPanel = async () => {
    const triggers = TRIGGER[site] || TRIGGER.douyin;
    for (let i = 0; i < triggers.length; i++) {
      const els = all(triggers[i]);
      for (let j = 0; j < els.length; j++) {
        const el = els[j];
        if (!vis(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 14 || r.height < 14) continue;
        try { el.click(); } catch (e) { continue; }
        await sleep(650);
        await revealComments();
        const inp = findInput();
        if (inp) return inp;
      }
    }
    /* 有些评论区先折叠，点「展开更多」后才挂载输入框 */
    const moreEls = all('[data-e2e="video-comment-more"],[data-e2e*="comment-more"],[class*="comment-more"]').filter(vis);
    for (let i = 0; i < moreEls.length && i < 2; i++) {
      try { moreEls[i].click(); } catch (e) {}
      await sleep(500);
      await revealComments();
      const inp = findInput();
      if (inp) return inp;
    }
    /* 有些版本没有稳定的 data-e2e，只有「评论 / 展开评论 / 23条评论」文字入口 */
    const textEls = all('button,[role="button"],a,span,div').filter(function (el) {
      if (!vis(el)) return false;
      const t = String(el.innerText || '').trim();
      return t.length <= 12 && /^(评论|查看评论|展开评论|写评论|发表评论|评论一下|留下你的精彩评论吧|说点什么|\d+\s*条评论)$/.test(t);
    });
    for (let i = 0; i < textEls.length && i < 12; i++) {
      try { textEls[i].click(); } catch (e) { continue; }
      await sleep(650);
      await revealComments();
      const inp = findInput();
      if (inp) return inp;
    }
    return null;
  };
  try {
    /* 登录墙先识别，否则会误报成「选择器失效」 */
    const wall = isLoginWall() || !!loginLabel();

    /* 评论区一般在页面中段/底部：先滚到底，把整屏视频下面的评论容器唤起来 */
    await revealComments();
    if (wall) {
      return { ok: false, code: 'NEED_LOGIN', reason: '当前浏览器（装扩展的这个）没登录平台，请先在这个浏览器登录；桥里另一个浏览器的登录不算', debug: 'login-wall', href: location.href };
    }
    /* 先看滚动后是否已经露出输入框；没有才去点评论入口 */
    let inp = findInput();
    if (!inp) inp = await openCommentPanel();
    const tried = INPUT[site] || INPUT.douyin;
    /* 轮询等待：评论区可能要滚动几次才挂载，一次查不到别急着判死刑 */
    for (let a = 0; a < 8 && !inp; a++) {
      for (let i = 0; i < tried.length && !inp; i++) {
        const els = all(tried[i]);
        for (let j = 0; j < els.length; j++) if (vis(els[j])) { inp = { el: els[j], sel: tried[i] }; break; }
      }
      if (!inp) {
        await revealComments();
        await sleep(900);
        inp = await openCommentPanel();
        if (!inp && (isLoginWall() || loginLabel())) {
          return { ok: false, code: 'NEED_LOGIN', reason: '当前浏览器（装扩展的这个）没登录平台，请先在这个浏览器登录；桥里另一个浏览器的登录不算', debug: 'login-wall-after-open', href: location.href };
        }
      }
    }
    if (!inp) {
      const loginTxt = loginLabel();
      if (loginTxt) {
        return { ok: false, code: 'NEED_LOGIN', reason: '页面顶部是「' + loginTxt + '」：当前浏览器没登录平台，请先在这个浏览器登录（不是桥里的另一个浏览器）', debug: 'login-button', href: location.href };
      }
      const cands = all('[contenteditable="true"],textarea,[data-e2e*="comment"]').filter(vis).slice(0, 4)
        .map(function (el) { return el.tagName + '[' + (el.getAttribute('data-e2e') || '') + ']'; }).join(',');
      const edits = all('[contenteditable],[role="textbox"],textarea').filter(vis).slice(0, 4)
        .map(function (el) {
          return el.tagName + '[ce=' + (el.getAttribute('contenteditable') || '') + ',role=' + (el.getAttribute('role') || '') + ']';
        }).join(',');
      return {
        ok: false, code: 'NO_INPUT',
        reason: '没找到评论输入框（等待 12 秒仍未出现；可能未登录或平台改版）'
          + '；可见候选：' + (cands || '无') + '；可编辑候选：' + (edits || '无')
          + '；页面：' + String(document.body && document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 100),
        debug: 'tried: ' + tried.join(' | ') + ' | href: ' + String(location.href).slice(0, 60), href: location.href
      };
    }
    inp.el.scrollIntoView({ block: 'center' });
    await sleep(400);
    /* 打标记，后续 cmtType / cmtSubmit 用它定位，避免选择器在两步之间失效 */
    try { inp.el.setAttribute('data-cc-input', '1'); inp.sel = '[data-cc-input="1"]'; } catch (e) {}
    window.__ccInputSel = inp.sel;
    return { ok: true, sel: inp.sel, dry: !!o.dryRun, href: location.href };
  } catch (e) {
    return { ok: false, code: 'PREPARE_ERROR', reason: String((e && e.message) || e).slice(0, 160), debug: '', href: location.href };
  }
}

async function cmtType(opts) {
  const o = opts || {};
  const text = String(o.text || '');
  const host = location.hostname;
  const site = host.indexOf('xiaohongshu') >= 0 ? 'xiaohongshu'
    : host.indexOf('kuaishou') >= 0 ? 'kuaishou'
      : host.indexOf('weixin') >= 0 ? 'channels'
        : 'douyin';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const all = (sel, root) => {
    try { return Array.from((root || document).querySelectorAll(sel)); } catch (e) { return []; }
  };
  const INPUT = {
    douyin: ['[data-cc-input="1"]', '[data-e2e="comment-input"]', '[data-e2e="comment-input"] [contenteditable]',
      '.comment-input-inner-container [contenteditable]', '.public-DraftEditor-content',
      '[contenteditable="true"]', '[contenteditable="plaintext-only"]', '[role="textbox"]', 'textarea'],
    xiaohongshu: ['[data-cc-input="1"]', '#content-textarea', '.input-box [contenteditable]', '.content-input',
      '[placeholder*="说点什么"]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]', '[role="textbox"]', 'textarea'],
    kuaishou: ['[data-cc-input="1"]', '[class*="comment-input"] [contenteditable]', '[class*="commentInput"]',
      'textarea[placeholder]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]', '[role="textbox"]', 'textarea'],
    channels: ['[data-cc-input="1"]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]', '[role="textbox"]', 'textarea[placeholder]', 'textarea']
  };
  const debug = [];
  try {
    let inp = null;
    const tried = INPUT[site] || INPUT.douyin;
    for (let i = 0; i < tried.length && !inp; i++) {
      const els = all(tried[i]);
      for (let j = 0; j < els.length; j++) if (vis(els[j])) { inp = { el: els[j], sel: tried[i] }; break; }
    }
    if (!inp) {
      return { ok: false, code: 'NO_INPUT', reason: '写入前输入框消失了（页面重渲染），请重试', debug: 'tried: ' + tried.join(' | ') };
    }
    debug.push('input=' + inp.sel);
    inp.el.focus();
    await sleep(200);
    if (inp.el.isContentEditable) {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(inp.el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, text);
      } catch (e) { debug.push('execCommand失败'); }
      if (!String(inp.el.textContent || '').trim()) {
        inp.el.textContent = text;
      }
      /* 抖音/小红书的发送按钮依赖 React 状态；execCommand 后必须再派发 input，
         否则文字看得见、按钮仍是灰的，最后卡在「找不到发送按钮」。 */
      try { inp.el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })); } catch (e) {}
      try { inp.el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
    } else {
      const proto = inp.el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(inp.el, text);
      inp.el.dispatchEvent(new Event('input', { bubbles: true }));
      inp.el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await sleep(700);
    const typed = String(inp.el.value || inp.el.textContent || '').trim();
    if (!typed) {
      return { ok: false, code: 'TYPE_FAILED', reason: '文字没能写进输入框（平台输入框结构变了）', debug: debug.join('; ') };
    }
    if (typed.replace(/\s/g, '').indexOf(text.replace(/\s/g, '').slice(0, 8)) < 0) {
      debug.push('写入内容与预期不一致');
    }
    return { ok: true, len: typed.length, debug: debug.join('; ') };
  } catch (e) {
    return { ok: false, code: 'TYPE_ERROR', reason: String((e && e.message) || e).slice(0, 160), debug: debug.join('; ') };
  }
}

async function cmtSubmit(opts) {
  const o = opts || {};
  const text = String(o.text || '');
  const host = location.hostname;
  const site = host.indexOf('xiaohongshu') >= 0 ? 'xiaohongshu'
    : host.indexOf('kuaishou') >= 0 ? 'kuaishou'
      : host.indexOf('weixin') >= 0 ? 'channels'
        : 'douyin';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const all = (sel, root) => {
    try { return Array.from((root || document).querySelectorAll(sel)); } catch (e) { return []; }
  };
  const SEND = {
    douyin: ['[data-e2e="comment-publish"]', '[data-e2e="comment-send"]'],
    xiaohongshu: ['#content-textarea ~ .btn', '.input-box .submit', '.comment-input .submit'],
    kuaishou: ['[class*="comment"] [class*="send"]', '[class*="publish"]'],
    channels: []
  };
  const BTN_TEXT = /^(发送|发布|评论|提交|Send|Post)/;
  const debug = [];
  const msgCount = (head) => head ? (String(document.body.innerText || '').split(head).length - 1) : 0;
  try {
    const INPUT_SEL = '[data-e2e="comment-input"], #content-textarea, div[contenteditable="true"], textarea';
    let inp = null;
    const els = all(INPUT_SEL);
    for (let i = 0; i < els.length; i++) if (vis(els[i])) { inp = els[i]; break; }

    /* 再补一次输入事件：发送按钮的 disabled 状态由框架状态控制 */
    if (inp) {
      inp.focus();
      try { inp.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })); } catch (e) {}
      await sleep(250);
    }

    const usable = (el) => !!(el && vis(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    let btn = null; let btnSel = '';
    const cands0 = SEND[site] || [];
    for (let i = 0; i < cands0.length && !btn; i++) {
      const list = all(cands0[i]);
      for (let j = 0; j < list.length; j++) if (usable(list[j])) { btn = list[j]; btnSel = cands0[i]; break; }
    }
    if (!btn) {
      let scope = inp;
      for (let up = 0; up < 4 && scope && !btn; up++) {
        const cands = all('button,[role="button"],span,a', scope.parentElement || scope);
        for (let i = 0; i < cands.length; i++) {
          const t = String(cands[i].textContent || '').trim();
          if (t.length <= 10 && BTN_TEXT.test(t) && usable(cands[i])) {
            btn = cands[i]; btnSel = 'text:' + t; break;
          }
        }
        scope = scope.parentElement;
      }
    }
    const fireEnter = async (ctrl) => {
      if (!inp) return false;
      const head = String(text || '').slice(0, 10);
      const before = msgCount(head);
      inp.focus();
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, ctrlKey: !!ctrl };
      try {
        inp.dispatchEvent(new KeyboardEvent('keydown', opts));
        inp.dispatchEvent(new KeyboardEvent('keypress', opts));
        inp.dispatchEvent(new KeyboardEvent('keyup', opts));
      } catch (e) { debug.push('enter失败'); }
      await sleep(1800);
      const left = String(inp.value || inp.textContent || '').trim();
      const after = msgCount(head);
      const posted = !left || after > before;
      debug.push((ctrl ? 'ctrl+' : '') + 'enter ' + (posted ? 'ok' : 'fail'));
      return posted;
    };

    if (!btn) {
      if (await fireEnter(false) || await fireEnter(true)) {
        return { ok: true, posted: true, reason: '已通过回车发送', debug: debug.join('; ') };
      }
      return { ok: false, posted: false, code: 'NO_SEND', reason: '文字已写入，但没找到可用的发送按钮；已尝试回车，页面保留可手动发送', debug: debug.join('; ') };
    }
    debug.push('send=' + btnSel);
    const head = String(text || '').slice(0, 10);
    const before = msgCount(head);
    btn.click();
    await sleep(1800);
    let left = inp ? String(inp.value || inp.textContent || '').trim() : '';
    let after = msgCount(head);
    let posted = !left || after > before;
    if (!posted) {
      /* 按钮点了没反应（常见：按钮可见但未启用）→ 回车兜底 */
      posted = await fireEnter(false) || await fireEnter(true);
      left = inp ? String(inp.value || inp.textContent || '').trim() : '';
      after = msgCount(head);
    }
    return {
      ok: posted, posted,
      reason: posted ? '已发送' : '点击发送/回车后仍未确认到内容（可能被平台拦截或需验证）',
      debug: debug.join('; ') + '; left=' + left.slice(0, 20) + '; hits=' + before + '->' + after
    };
  } catch (e) {
    return { ok: false, posted: false, code: 'POSTER_ERROR', reason: String((e && e.message) || e).slice(0, 160), debug: debug.join('; ') };
  }
}

/* 点赞：先看是否已赞（已赞就不再点，重复点会变成取消赞），
   再点一次并校验 class/aria 是否真的变化。 */
async function likePoster(opts) {
  const o = opts || {};
  const host = location.hostname;
  const site = host.indexOf('xiaohongshu') >= 0 ? 'xiaohongshu'
    : host.indexOf('kuaishou') >= 0 ? 'kuaishou'
      : host.indexOf('weixin') >= 0 ? 'channels'
        : 'douyin';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const all = (sel, root) => {
    try { return Array.from((root || document).querySelectorAll(sel)); } catch (e) { return []; }
  };
  const LIKED = /(^|\s|-)(active|liked|selected|on|checked)(\s|$)/i;
  const LIKE = {
    douyin: ['[data-e2e="video-player-digg"]', '[data-e2e="like-icon"]', '[data-e2e="like-button"]', '[class*="digg"]'],
    xiaohongshu: ['.interact-container .like-wrapper', '#noteContainer .like-wrapper', '.like-wrapper', '[class*="like"]'],
    kuaishou: ['[class*="like-btn"]', '[class*="likeBtn"]', '[class*="like"]'],
    channels: ['[class*="like"]', '.like-icon', '[aria-label*="赞"]']
  };
  const isLiked = (el) => {
    let n = el;
    for (let i = 0; i < 4 && n; i++) {
      const cls = String(n.className || '');
      if (LIKED.test(cls)) return true;
      if (String(n.getAttribute && n.getAttribute('aria-pressed') || '') === 'true') return true;
      n = n.parentElement;
    }
    /* 图标换成「已赞」形态（use href / path d 一般会带 liked 字样） */
    const svg = el.querySelector && el.querySelector('svg use');
    const href = svg && (svg.getAttribute('href') || svg.getAttribute('xlink:href') || '');
    return !!(href && /like|digg|heart/i.test(href) && /fill|active|liked/i.test(String(el.className || '')));
  };

  const tried = LIKE[site] || LIKE.douyin;
  const debug = [];
  try {
    const vh = window.innerHeight || 800;
    window.scrollTo(0, Math.round(vh * 0.4));
    await sleep(500);

    let el = null; let sel = '';
    for (let i = 0; i < tried.length && !el; i++) {
      const list = all(tried[i]);
      for (let j = 0; j < list.length; j++) {
        if (vis(list[j])) { el = list[j]; sel = tried[i]; break; }
      }
    }
    /* 兜底：aria-label / title 里带「赞」的可见按钮 */
    if (!el) {
      const cands = all('button,[role="button"],div[aria-label],span[aria-label]');
      for (let i = 0; i < cands.length; i++) {
        const lb = String((cands[i].getAttribute && (cands[i].getAttribute('aria-label') || cands[i].getAttribute('title'))) || '');
        if (/赞|like/i.test(lb) && !/评论|分享|收藏/.test(lb) && vis(cands[i])) { el = cands[i]; sel = 'aria:' + lb.slice(0, 12); break; }
      }
    }
    if (!el) {
      return { ok: false, liked: false, code: 'NO_LIKE', reason: '没找到点赞按钮（平台改版或页面未渲染完）', debug: 'tried: ' + tried.join(' | ') };
    }
    debug.push('like=' + sel);
    if (isLiked(el)) {
      return { ok: true, liked: false, already: true, reason: '这个作品你已经赞过了', debug: debug.join('; ') };
    }
    if (o.dryRun) {
      return { ok: true, liked: false, already: false, dry: true, reason: '找到点赞按钮（未实际点击）', debug: debug.join('; ') };
    }
    const clsBefore = String(el.className || '');
    el.scrollIntoView({ block: 'center' });
    await sleep(300);
    el.click();
    await sleep(1200);
    const clsAfter = String(el.className || '');
    const nowLiked = isLiked(el) || clsAfter !== clsBefore;
    return {
      ok: !!nowLiked, liked: !!nowLiked,
      reason: nowLiked ? '已点赞' : '点了按钮但没确认到状态变化（可能被限流）',
      debug: debug.join('; ') + '; cls=' + clsBefore.slice(0, 24) + '->' + clsAfter.slice(0, 24)
    };
  } catch (e) {
    return { ok: false, liked: false, code: 'LIKE_ERROR', reason: String((e && e.message) || e).slice(0, 160), debug: debug.join('; ') };
  }
}

function searchUrlOf(platform, kw) {
  const k = encodeURIComponent(kw);
  switch (SITE_OF[platform] || platform) {
    case 'xiaohongshu':
      return 'https://www.xiaohongshu.com/search_result?keyword=' + k + '&source=web_search_result_notes';
    case 'kuaishou':
      return 'https://www.kuaishou.com/search/video?searchKey=' + k;
    case 'channels': /* 视频号：网页版搜索（需要在这个 Chrome 里登录微信） */
      return 'https://channels.weixin.qq.com/web/pages/search?keyword=' + k;
    default:
      return 'https://www.douyin.com/search/' + k + '?type=video';
  }
}

/* ---------- 执行过程上报 ----------
   一条任务在页面上会经历：打开 → 定位 → 点赞 → 写入 → 发送。
   每做完一步报一次，云端 steps 追加，前端卡片实时画出来。
   上报失败只吞掉，不影响任务本身。 */
async function stepOf(jobId, name, status, msg) {
  if (!jobId) return;
  try {
    await api('/v1/plugin/progress', {
      method: 'POST',
      body: { jobId: jobId, step: name, status: status, msg: String(msg || '').slice(0, 118) }
    });
  } catch (e) { /* 过程丢一条不影响结果 */ }
}

/* ---------- 执行一条评论任务 ----------
   与采集的区别：这是「对外写」。所以失败一律不重试、不硬刷，
   把原因原样带回去，由人决定要不要补发。

   一次打开页面把「点赞 + 评论」都做完：少一次页面加载，也少一次风控暴露。 */
async function runCommentJob(job) {
  const started = Date.now();
  const platform = String(job.platform || 'douyin');
  const site = SITE_OF[platform] || platform;
  const url = String(job.url || '');
  const text = String(job.text || '');
  const steps = [];
  const out = {
    ok: true, comments: [], notes: [],
    stats: { kind: 'comment', platform: platform, ms: 0 },
    comment: { posted: false, text: text, reason: '', debug: '' },
    like: null,
    steps: steps
  };
  const trace = async (name, status, msg) => {
    steps.push({ step: name, status: status, msg: String(msg || '').slice(0, 120), at: new Date().toISOString() });
    await stepOf(job.id, name, status, msg);
  };

  if (!url) {
    out.ok = false; out.code = 'NO_URL';
    out.message = '任务缺少作品链接';
    out.comment.reason = out.message;
    await trace('fail', 'fail', out.message);
    return out;
  }
  let tabId = 0;
  try {
    await trace('open', 'run', '打开作品页 · ' + (SITE_LABEL[site] || platform));
    const tab = await chrome.tabs.create({ url: url, active: false });
    tabId = tab.id;
    await waitComplete(tabId, 30000);
    /* 关键：切到前台再执行。抖音/快手的播放器和评论区按可见性懒挂载，
       后台标签页里 IntersectionObserver 不触发，输入框根本不会出现在 DOM 里。 */
    await chrome.tabs.update(tabId, { active: true }).catch(function () {});
    /* 视频页的评论组件是懒加载的，给足首屏时间再去点 */
    await sleep(2600);
    await trace('open', 'ok', '页面已打开（已切前台渲染）');

    /* 可选：先点赞。失败不拦评论 —— 两件事互不绑定 */
    if (job.withLike) {
      await trace('like', 'run', '定位点赞按钮');
      const lk = await inject(tabId, likePoster, [{ dryRun: !!job.dryRun }]);
      out.like = lk || { ok: false, liked: false, reason: '注入没有返回结果' };
      await trace('like', (lk && (lk.liked || lk.already)) ? 'ok' : 'fail',
        (lk && (lk.reason || (lk.liked ? '已点赞' : '点赞未完成'))) || '点赞未完成');
    }

    await trace('locate', 'run', '滚动页面 · 定位评论输入框');
    const prep = await inject(tabId, cmtPrepare, [{ dryRun: !!job.dryRun }]);
    if (!prep || !prep.ok) {
      out.ok = false;
      out.code = (prep && prep.code) || 'NO_INPUT';
      out.message = (prep && prep.reason) || '没找到评论输入框';
      out.comment.reason = out.message;
      out.comment.debug = String((prep && prep.debug) || '').slice(0, 160);
      await trace('locate', 'fail', out.message);
      out.stats.ms = Date.now() - started;
      return out;
    }
    await trace('locate', 'ok', '已找到输入框：' + String(prep.sel || '').slice(0, 40));
    if (job.dryRun) {
      out.ok = true;
      out.comment.reason = '输入框可用（未实际发送）';
      await trace('done', 'ok', '试运行完成：输入框与发送按钮都可用');
      out.stats.ms = Date.now() - started;
      return out;
    }

    await trace('type', 'run', '写入评论内容（' + text.length + ' 字）');
    const typed = await inject(tabId, cmtType, [{ text: text }]);
    if (!typed || !typed.ok) {
      out.ok = false;
      out.code = (typed && typed.code) || 'TYPE_FAILED';
      out.message = (typed && typed.reason) || '文字没能写进输入框';
      out.comment.reason = out.message;
      out.comment.debug = String((typed && typed.debug) || '').slice(0, 160);
      await trace('type', 'fail', out.message);
      out.stats.ms = Date.now() - started;
      return out;
    }
    await trace('type', 'ok', '已写入 ' + (typed.len || text.length) + ' 字');

    await trace('submit', 'run', '点击发送按钮');
    const sub = await inject(tabId, cmtSubmit, [{ text: text }]);
    out.stats.ms = Date.now() - started;
    if (!sub) {
      out.ok = false; out.code = 'NO_RESULT';
      out.message = '页面注入没有返回结果（标签页可能被关闭或页面脚本被拦）';
      out.comment.reason = out.message;
      await trace('submit', 'fail', out.message);
      return out;
    }
    out.comment = {
      posted: !!sub.posted,
      text: text,
      reason: String(sub.reason || '').slice(0, 160),
      debug: String(sub.debug || '').slice(0, 160)
    };
    if (!sub.posted) {
      out.ok = false;
      out.code = String(sub.code || 'COMMENT_NOT_POSTED');
      out.message = out.comment.reason || '评论未发出';
      await trace('submit', 'fail', out.message);
      return out;
    }
    await trace('done', 'ok', '评论已发布' + (out.like && out.like.liked ? ' · 同时完成点赞' : ''));
    return out;
  } catch (e) {
    out.ok = false; out.code = 'COMMENT_JOB_FAILED';
    out.message = String((e && e.message) || e).slice(0, 160);
    out.comment.reason = out.message;
    out.stats.ms = Date.now() - started;
    await trace('fail', 'fail', out.message);
    return out;
  } finally {
    if (tabId) {
      /* 只有「文字已写入、发送没确认」才保留标签页让人工回车；
         登录墙/找不到输入框等失败直接关掉，避免堆一屏登录页。 */
      const keepTab = !out.ok && (out.code === 'NO_SEND' || out.code === 'COMMENT_NOT_POSTED');
      if (keepTab) {
        try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
        if (out.comment) {
          out.comment.reason = String(out.comment.reason || '评论未发出') + '（页面已保留，可手动回车或点发送）';
        }
        out.message = out.comment ? out.comment.reason : (out.message || '评论未完成（页面已保留）');
      } else {
        try { await chrome.tabs.remove(tabId); } catch (e) {}
      }
    }
  }
}

/* ---------- 执行一条点赞任务 ---------- */
async function runLikeJob(job) {
  const started = Date.now();
  const platform = String(job.platform || 'douyin');
  const site = SITE_OF[platform] || platform;
  const url = String(job.url || '');
  const steps = [];
  const out = {
    ok: true, comments: [], notes: [],
    stats: { kind: 'like', platform: platform, ms: 0 },
    like: { liked: false, already: false, reason: '', debug: '' },
    steps: steps
  };
  const trace = async (name, status, msg) => {
    steps.push({ step: name, status: status, msg: String(msg || '').slice(0, 120), at: new Date().toISOString() });
    await stepOf(job.id, name, status, msg);
  };
  if (!url) {
    out.ok = false; out.code = 'NO_URL';
    out.message = '任务缺少作品链接';
    out.like.reason = out.message;
    await trace('fail', 'fail', out.message);
    return out;
  }
  let tabId = 0;
  try {
    await trace('open', 'run', '打开作品页 · ' + (SITE_LABEL[site] || platform));
    const tab = await chrome.tabs.create({ url: url, active: false });
    tabId = tab.id;
    await waitComplete(tabId, 30000);
    await chrome.tabs.update(tabId, { active: true }).catch(function () {});
    await sleep(2400);
    await trace('open', 'ok', '页面已打开（已切前台渲染）');

    await trace('like', 'run', '定位点赞按钮');
    const r = await inject(tabId, likePoster, [{ dryRun: !!job.dryRun }]);
    out.stats.ms = Date.now() - started;
    if (!r) {
      out.ok = false; out.code = 'NO_RESULT';
      out.message = '页面注入没有返回结果（标签页可能被关闭或页面脚本被拦）';
      out.like.reason = out.message;
      await trace('like', 'fail', out.message);
      return out;
    }
    out.like = {
      liked: !!r.liked,
      already: !!r.already,
      reason: String(r.reason || '').slice(0, 160),
      debug: String(r.debug || '').slice(0, 160)
    };
    if (!r.liked && !r.already) {
      out.ok = false;
      out.code = String(r.code || 'LIKE_NOT_DONE');
      out.message = out.like.reason || '点赞未完成';
      await trace('like', 'fail', out.message);
      return out;
    }
    await trace('done', 'ok', r.already ? '之前已经赞过（无需重复）' : '已点赞');
    return out;
  } catch (e) {
    out.ok = false; out.code = 'LIKE_JOB_FAILED';
    out.message = String((e && e.message) || e).slice(0, 160);
    out.like.reason = out.message;
    out.stats.ms = Date.now() - started;
    await trace('fail', 'fail', out.message);
    return out;
  } finally {
    if (tabId) { try { await chrome.tabs.remove(tabId); } catch (e) {} }
  }
}

/* ---------- 执行一个任务 ---------- */
async function runJob(job) {
  if (job && job.kind === 'comment') return runCommentJob(job);
  if (job && job.kind === 'like') return runLikeJob(job);
  /* 平台 ID 已与服务端统一（xhs/sph 直接用），站点名只用于拼 URL */
  const platform = String(job.platform || 'douyin').trim();
  const site = SITE_OF[platform] || platform;
  const kw = String(job.keyword || job.ref || job.video || job.author || '').trim();
  const started = Date.now();
  const result = { ok: true, comments: [], notes: [], stats: { platform, keyword: kw } };
  let tabId = 0;

  try {
    const isVideoTarget = job.target === 'video' && job.video;
    const first = isVideoTarget
      ? (String(job.video).indexOf('http') === 0 ? String(job.video) : searchUrlOf(platform, job.video))
      : searchUrlOf(platform, kw);

    const tab = await chrome.tabs.create({ url: first, active: false });
    tabId = tab.id;
    await waitComplete(tabId, 30000);
    await sleep(2500);   /* SPA 首屏渲染 + 首屏数据请求 */

    if (isVideoTarget) {
      const c = await scrape(tabId, {
        mode: 'video', platform, limit: job.limit, keyword: kw,
        videoUrl: first, videoTitle: '', author: job.author || '', scrolls: 5
      });
      if (c && c.loginWall && !(c.comments || []).length) {
        result.ok = false; result.code = 'NEED_LOGIN';
        result.message = '页面要求登录才能看评论：请在这个 Chrome 里登录 ' + SITE_LABEL[site] + ' 后再试';
      } else if (c) {
        result.comments = c.comments || [];
      }
    } else {
      const s = await scrape(tabId, {
        mode: 'search', platform, limit: job.limit, keyword: kw,
        scrolls: Math.max(3, Math.min(8, Math.ceil((job.limit || 20) / 5)))
      });
      if (s && s.loginWall && !(s.notes || []).length) {
        result.ok = false; result.code = 'NEED_LOGIN';
        result.message = '页面要求登录才能看搜索结果：请在这个 Chrome 里登录 ' + SITE_LABEL[site] + ' 后再试';
      } else if (s) {
        result.notes = s.notes || [];
      }
      /* 评论：只挑前 N 个作品进去读，读评论是整个流程里最贵的一步 */
      const maxV = Math.max(0, Math.min(8, Number(job.maxVideos) || 0));
      const targets = (result.notes || []).slice(0, maxV);
      for (let i = 0; i < targets.length; i++) {
        const n = targets[i];
        if (!n.url) continue;
        try {
          await chrome.tabs.update(tabId, { url: n.url });
          await waitComplete(tabId, 25000);
          await sleep(2200);
          const c = await scrape(tabId, {
            mode: 'video', platform, limit: Math.max(5, Math.ceil((job.limit || 20) / Math.max(1, maxV))),
            keyword: kw, videoUrl: n.url, videoTitle: n.title, author: n.author, scrolls: 4
          });
          if (c && c.comments && c.comments.length) {
            for (const cm of c.comments) result.comments.push(cm);
          }
          n.comments = (c && c.comments) ? c.comments.length : 0;
        } catch (e) {
          /* 单个作品失败不拖垮整轮：记下来继续下一个 */
          result.stats['videoErr' + i] = String((e && e.message) || e).slice(0, 80);
        }
      }
    }
    result.stats.notes = result.notes.length;
    result.stats.comments = result.comments.length;
    result.stats.ms = Date.now() - started;
    return result;
  } catch (e) {
    return {
      ok: false, code: 'JOB_FAILED',
      message: String((e && e.message) || e).slice(0, 200),
      comments: result.comments, notes: result.notes,
      stats: Object.assign(result.stats, { ms: Date.now() - started })
    };
  } finally {
    if (tabId) { try { await chrome.tabs.remove(tabId); } catch (e) {} }
  }
}

/* ---------- 主循环 ---------- */
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const hello = await api('/v1/plugin/hello', { method: 'POST', body: {
      version: VERSION,
      platforms: PLATFORMS,
      browser: /Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome'
    } });
    online = !!(hello.body && hello.body.ok);
    if (!online) return;

    const r = await api('/v1/plugin/poll');
    const job = r.body && r.body.job;
    if (!job) return;

    stat.lastJob = job.id;
    stat.lastAt = Date.now();
    const res = await runJob(job);
    stat.lastNotes = (res.notes || []).length;
    stat.lastComments = (res.comments || []).length;
    const out = await api('/v1/plugin/result', {
      method: 'POST',
      body: Object.assign({ jobId: job.id }, res)
    });
    if (res.ok === false || !(out.body && out.body.ok)) {
      stat.failed++;
      lastError = (out.body && out.body.message) || res.message || '回传失败';
    } else {
      stat.done++;
    }
    try {
      chrome.action.setBadgeText({ text: String(stat.done % 100) });
      chrome.action.setBadgeBackgroundColor({ color: '#1f9d55' });
    } catch (e) {}
  } catch (e) {
    online = false;
    lastError = String((e && e.message) || e);
  } finally {
    busy = false;
    setTimeout(tick, online ? 1200 : 4000);
  }
}

/* service worker 会被浏览器休眠：alarms 负责把它叫醒（30 秒一次，
   比这更短的最小周期在 MV3 里不被允许；醒了就恢复 1.2 秒轮询） */
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('beat', { periodInMinutes: 0.5 });
  tick();
});
chrome.runtime.onStartup.addListener(() => { tick(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'beat') tick(); });
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'status') {
    sendResponse({
      online, busy, version: VERSION, platforms: PLATFORMS,
      stat, lastError
    });
    return true;
  }
  if (msg && msg.type === 'wake') { tick(); sendResponse({ ok: true }); return true; }
  return false;
});
tick();
