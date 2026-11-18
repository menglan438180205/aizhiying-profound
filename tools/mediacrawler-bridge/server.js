'use strict';
/* =========================================================================
 * tools/mediacrawler-bridge/server.js — MediaCrawler 导出 → BFF crawler 通道 桥
 * -------------------------------------------------------------------------
 * ⛔⛔⛔ 非商用 · 仅供本地研究 · 禁止进入发布包 / 禁止作为产品数据源 ⛔⛔⛔
 *
 * 本文件用途：
 *   你在自己电脑上以【个人非商业研究】目的运行 MediaCrawler（github.com/NanmiCoder
 *   /MediaCrawler，其协议为 NON-COMMERCIAL LEARNING LICENSE 1.1，禁止商用），
 *   把它的导出文件（CSV / JSON / JSONL）喂给本系统 BFF 的 crawler 通道，
 *   从而体验「抓取 → 意向打分 → 去重 → 入库」整条链路。
 *
 * 它【不】包含任何爬虫代码，【不】连接任何第三方平台，只是把 MediaCrawler
 * 已经导出到本地的文件，转成 BFF 能消费的 { data: { comments: [...] } } 结构。
 *
 * 法律与合规红线（务必阅读 server/README.md 第 283–290 行）：
 *   1) MediaCrawler 协议禁止商用。本桥同样禁止商用，仅限你个人研究链路验证。
 *   2) 用本桥把真实公开评论导进产品 = 触发《个人信息保护法》《反不正当竞争法》
 *      风险，且违反各平台 ToS。生产环境请改用 vendor 通道（有资质供应商）或
 *      official 通道（自有内容）。
 *   3) 不要把本文件复制到 C:\aizhiying 或任何部署包；它只存在于 tools/ 开发态。
 *
 * 与 BFF 的契约（与 server/collect-adapters/http-provider.js 对齐）：
 *   BFF 设置 COLLECT_CRAWLER_URL=http://127.0.0.1:8802 后会主动拉取本服务：
 *   POST /v1/comments/collect
 *     Body { platform, keyword, limit, region, scope }
 *     Resp { ok:true, data:{ comments:[ { nickname, comment, video_title,
 *            likes, at, region, platform } ] } }
 *   GET  /v1/health  -> 200 { ok:true, service:'mediacrawler-bridge', research:true }
 *
 * 运行（零依赖，仅 Node 内置模块）：
 *   MC_DIR=/path/to/mediacrawler/data PORT=8802 node tools/mediacrawler-bridge/server.js
 *   # 不传 MC_DIR 时默认读当前目录下的 ./data
 * ========================================================================= */

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT || 8801);
const MC_DIR = process.env.MC_DIR || path.join(process.cwd(), 'data');

/* ---------- 平台识别：MediaCrawler 目录/文件名 → 本系统 platform id ---------- */
// MediaCrawler 实际目录名：xhs / douyin / kuaishou / bili / wb / tz / zhihu
// 本系统采集页 platform：douyin / kuaishou / xiaohongshu / channels
const PLATFORM_ALIASES = [
  { id: 'douyin', keys: ['douyin', 'dy', '抖音'] },
  { id: 'kuaishou', keys: ['kuaishou', 'ks', '快手'] },
  { id: 'xiaohongshu', keys: ['xhs', 'xiaohongshu', 'xiaoHongShu', 'redbook', '小红书', '红书'] },
  { id: 'channels', keys: ['channels', 'sph', 'shipinhao', '视频号', '微信视频号'] },
  { id: 'bilibili', keys: ['bili', 'bilibili', 'b站'] },
  { id: 'weibo', keys: ['wb', 'weibo', '微博'] },
  { id: 'tieba', keys: ['tz', 'tieba', '贴吧'] },
  { id: 'zhihu', keys: ['zhihu', '知乎'] }
];

function detectPlatform(p) {
  const s = String(p || '').toLowerCase();
  for (const a of PLATFORM_ALIASES) {
    if (a.keys.some((k) => s.indexOf(k.toLowerCase()) >= 0)) return a.id;
  }
  return '';
}

/* ---------- 字段别名：MediaCrawler 列名 → 本系统归一化字段 ---------- */
// 方向：MediaCrawler 导出列 → normalize.js 接受的别名（见 server/collect-adapters/normalize.js）
const FIELD_MAP = {
  nickname: ['user_name', 'nickname', 'author', 'username', 'nick_name', 'user', 'nick'],
  comment: ['content', 'comment', 'comment_content', 'text', 'body', 'comment_text'],
  video_title: ['note_title', 'title', 'video_title', 'aweme_title', 'post_title', 'video', 'aweme_desc'],
  likes: ['like_count', 'digg_count', 'likes', 'liked_count', 'likedCount', 'likeCount'],
  at: ['add_ts', 'create_time', 'comment_time', 'publish_time', 'add_time', 'last_modify_ts', 'time', 'date', 'addTime'],
  region: ['ip_location', 'city', 'location', 'region', 'ip', 'ipLocation'],
  /* 来源回链三件套：没有它们，线索只是一句没有出处的话 */
  cid: ['comment_id', 'cid', 'id'],
  video_url: ['note_url', 'aweme_url', 'video_url', 'share_url', 'url'],
  author: ['note_author', 'author_nickname', 'creator_nickname', 'blogger', 'nickname'],
  note_id: ['note_id', 'aweme_id', 'video_id', 'item_id'],
  keyword: ['source_keyword', 'keyword', 'search_keyword'],
  /* 作品卡片可视化字段：封面 / 发布时间 / 互动数 */
  cover: ['cover_url', 'cover', 'image_url', 'img_url', 'thumbnail', 'avatar_url'],
  publish_time: ['publish_time', 'created_at', 'create_time', 'time', 'publishTime'],
  comment_count: ['comment_count', 'comment_num', 'comments_count'],
  collected_count: ['collected_count', 'collect_count', 'collect_num', 'share_count']
};

/* 作品链接兜底：导出里没存 URL 时，按平台规则拼一个可点开的 */
function fallbackUrl(platform, noteId) {
  const id = String(noteId || '').trim();
  if (!id) return '';
  const p = detectPlatform(platform);
  if (p === 'xhs') return 'https://www.xiaohongshu.com/explore/' + id;
  if (p === 'douyin') return 'https://www.douyin.com/video/' + id;
  if (p === 'kuaishou') return 'https://www.kuaishou.com/short-video/' + id;
  return '';
}

function pickFromRow(row, aliases) {
  for (const k of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      const v = row[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
  }
  return undefined;
}

/* ---------- 极简 RFC4180 CSV 解析（支持引号内逗号/换行/双引号转义） ---------- */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function csvToObjects(text) {
  const rows = parseCsv(text).filter((r) => r.length && !(r.length === 1 && r[0].trim() === ''));
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = (cells[c] || '').trim();
    out.push(obj);
  }
  return out;
}

function jsonToObjects(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.list)) return data.list;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.comments)) return data.comments;
  return [];
}

/* ---------- 读取 MC_DIR 下所有导出文件，归一化为评论对象 ----------
   两遍扫描：第一遍建「作品索引」（note_id → 标题/链接/博主），
   第二遍解析评论并按 note_id 关联回作品。
   MediaCrawler 把作品和评论分别导出到 search_contents_*.json 与
   search_comments_*.json，评论行里只有 note_id 没有标题和链接 ——
   不做这个关联，前端就只能显示一句「来源未知」，销售没法跳回原视频。 */
let _cache = { at: 0, files: [], comments: [] };

function loadAll() {
  const now = Date.now();
  if (_cache.files.length && now - _cache.at < 5000) return _cache;

  const comments = [];
  const files = [];
  const notes = new Map();
  if (!fs.existsSync(MC_DIR)) {
    _cache = { at: now, files: [], comments: [] };
    return _cache;
  }

  const raws = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const lower = e.name.toLowerCase();
      const ok = lower.endsWith('.csv') || lower.endsWith('.json') || lower.endsWith('.jsonl');
      if (!ok) continue;
      const platform = detectPlatform(full) || detectPlatform(e.name);
      let rows = [];
      try {
        const txt = fs.readFileSync(full, 'utf8');
        rows = lower.endsWith('.csv') ? csvToObjects(txt) : jsonToObjects(txt);
      } catch (err) {
        console.warn('[bridge] 跳过无法解析的文件 ' + full + ' : ' + err.message);
        continue;
      }
      raws.push({ file: full, platform: platform || '?', rows: rows });
    }
  };
  walk(MC_DIR);

  /* 第一遍：作品索引（有 note_id 且有标题或链接，且没有评论正文） */
  for (const r of raws) {
    for (const row of r.rows) {
      const noteId = pickFromRow(row, FIELD_MAP.note_id);
      const title = pickFromRow(row, FIELD_MAP.video_title);
      const url = pickFromRow(row, FIELD_MAP.video_url);
      if (!noteId || (!title && !url)) continue;
      /* 作品行没有 comment_id，评论行有。用这个区分，避免把评论当成作品建索引 */
      if (pickFromRow(row, FIELD_MAP.cid) !== undefined && pickFromRow(row, FIELD_MAP.comment) !== undefined) continue;
      const key = String(noteId);
      if (notes.has(key)) continue;
      notes.set(key, {
        note_id: key,
        title: title ? String(title) : '',
        url: url ? String(url) : '',
        author: String(pickFromRow(row, ['nickname', 'user_name', 'author', 'nick_name']) || ''),
        keyword: String(pickFromRow(row, FIELD_MAP.keyword) || ''),
        platform: r.platform !== '?' ? r.platform : detectPlatform(row.platform || '') || '',
        cover: String(pickFromRow(row, FIELD_MAP.cover) || ''),
        publishAt: String(pickFromRow(row, FIELD_MAP.publish_time) || ''),
        liked: Number(pickFromRow(row, FIELD_MAP.likes) || 0) || 0,
        comments: Number(pickFromRow(row, FIELD_MAP.comment_count) || 0) || 0,
        collected: Number(pickFromRow(row, FIELD_MAP.collected_count) || 0) || 0
      });
    }
  }

  /* 第二遍：评论 */
  for (const r of raws) {
    let n = 0;
    for (const row of r.rows) {
      const comment = pickFromRow(row, FIELD_MAP.comment);
      if (!comment) continue;
      const atRaw = pickFromRow(row, FIELD_MAP.at);
      const noteId = String(pickFromRow(row, FIELD_MAP.note_id) || '');
      const note = notes.get(noteId) || null;
      const platform = r.platform !== '?' ? r.platform : detectPlatform(row.platform || '');
      const url = (note && note.url) || String(pickFromRow(row, FIELD_MAP.video_url) || '') || fallbackUrl(platform, noteId);
      comments.push({
        nickname: pickFromRow(row, FIELD_MAP.nickname) || '匿名用户',
        comment: comment,
        cid: String(pickFromRow(row, FIELD_MAP.cid) || ''),
        video_title: (note && note.title) || pickFromRow(row, FIELD_MAP.video_title) || '',
        video_url: url,
        author: (note && note.author) || '',
        note_id: noteId,
        keyword: (note && note.keyword) || String(pickFromRow(row, FIELD_MAP.keyword) || ''),
        likes: Number(pickFromRow(row, FIELD_MAP.likes) || 0) || 0,
        at: atRaw ? String(atRaw) : '',
        region: pickFromRow(row, FIELD_MAP.region) || '',
        platform: platform || (row.platform || '')
      });
      n++;
    }
    if (n > 0) files.push({ file: r.file, platform: r.platform, rows: r.rows.length, kept: n });
  }
  _cache = { at: now, files, comments, notesArr: Array.from(notes.values()) };
  console.log('[bridge] 已加载 ' + files.length + ' 个文件，归一化评论 ' + comments.length + ' 条，作品索引 ' + notes.size + ' 条');
  return _cache;
}

function filterComments(body, all) {
  /* 平台用 detectPlatform 归一化后比较：前端传 xhs / 服务端传 xiaohongshu 都能对上同一批数据，
     之前是字符串全等比较，xhs 永远匹配不到 xiaohongshu 的评论（小红书通道恒 0 条）。 */
  const platform = detectPlatform(body.platform);
  const keyword = String(body.keyword || '').trim().toLowerCase();
  const region = String(body.region || '').trim().toLowerCase();
  const author = String(body.author || '').trim().toLowerCase();
  const video = String(body.video || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(500, Number(body.limit) || 50));

  let list = all;
  if (platform) list = list.filter((c) => detectPlatform(c.platform) === platform);
  if (region) list = list.filter((c) => (c.region || '').toLowerCase().indexOf(region) >= 0);

  /* 博主目标：匹配作品作者，也允许直接匹配评论者昵称（用户可能只给了个昵称） */
  if (author) {
    list = list.filter((c) =>
      (c.author || '').toLowerCase().indexOf(author) >= 0 ||
      (c.nickname || '').toLowerCase().indexOf(author) >= 0);
  }
  /* 作品目标：给链接、给 ID、给标题片段都能命中 */
  if (video) {
    list = list.filter((c) =>
      (c.video_url || '').toLowerCase().indexOf(video) >= 0 ||
      (c.note_id || '').toLowerCase() === video ||
      (c.video_title || '').toLowerCase().indexOf(video) >= 0);
  }
  if (keyword && !author && !video) {
    list = list.filter((c) =>
      (c.comment || '').toLowerCase().indexOf(keyword) >= 0 ||
      (c.video_title || '').toLowerCase().indexOf(keyword) >= 0);
  }
  return list.slice(0, limit);
}

/* ---------- 扫码登录：本机弹出浏览器 → 用户扫码 → Cookies 落盘 ----------
   原理：Chromium 系浏览器的用户目录（user-data-dir）就是「登录态」本身。
   用系统 Chrome/Edge 带一个独立目录打开平台首页，用户扫码登录后 Cookies
   会写进该目录；轮询 Cookies 文件的出现/更新即可判定登录成功。
   之后 MediaCrawler(playwright) 用同一个目录启动，登录态直接可用。
   零依赖：只 spawn 本机浏览器，不装任何包。
   边界：没有桌面/没有浏览器的机器（如服务器）会如实报 NO_BROWSER。 */

const { spawn } = require('child_process');
const LOGIN_URLS = {
  douyin: 'https://www.douyin.com',
  xiaohongshu: 'https://www.xiaohongshu.com',
  kuaishou: 'https://www.kuaishou.com',
  channels: 'https://channels.weixin.qq.com'
};
/* 各平台的「已登录」会话 Cookies。只读名字，不读值、不上传。
   新 Chrome 配置目录一启动就会生成 Cookies 数据库，所以「文件存在/变大」
   不能当作登录成功；必须看到这些会话 Cookie 才算真登录。 */
const SESSION_COOKIES = {
  douyin: ['sessionid', 'sessionid_ss', 'sid_tt'],
  xiaohongshu: ['web_session'],
  kuaishou: ['kuaishou.server.web_st', 'kuaishou.server.web_ph'],
  channels: ['sessionid', 'wxuin']
};
const LOGIN_OK_FILE = '.login-ok.json';
const LOGIN_PROFILE_ROOT = process.env.LOGIN_PROFILE_ROOT ||
  path.join(path.dirname(MC_DIR), 'browser_data');
const LOGIN_TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MS || 180000);

function findBrowser(preferred) {
  if (process.env.LOGIN_CHROME) {
    try { fs.accessSync(process.env.LOGIN_CHROME); return process.env.LOGIN_CHROME; } catch (e) {}
  }
  const chrome = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe' : ''
  ].filter(Boolean);
  const edge = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ].filter(Boolean);
  /* 扩展装在哪个浏览器，登录就用哪个，避免「桥开 Chrome、扩展在 Edge」各登各的 */
  const cands = preferred === 'edge' ? edge.concat(chrome) : chrome.concat(edge);
  for (const c of cands) { try { fs.accessSync(c); return c; } catch (e) {} }
  return '';
}

function cookieStat(dir) {
  const cands = [
    path.join(dir, 'Default', 'Network', 'Cookies'),
    path.join(dir, 'Default', 'Cookies'),
    path.join(dir, 'Cookies')
  ];
  let best = null;
  for (const c of cands) {
    try {
      const s = fs.statSync(c);
      if (!best || s.mtimeMs > best.mtimeMs) best = { file: c, mtimeMs: s.mtimeMs, size: s.size };
    } catch (e) {}
  }
  return best;
}

/* ---------- 二维码镜像：用 Chrome DevTools Protocol 截取登录页 ----------
   目的：把「本机 Chrome 里的登录二维码」搬进系统中间栏，用户不用切窗口。
   做法：启动浏览器时开一个随机 debugging 端口，定时连上去截一张图；
   页面里能找到近正方形的大图（二维码）就裁它，找不到就截整页兜底。
   仍然只读页面像素，不读 cookie 内容、不调平台私有接口。 */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(0));
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function cdpOnce(wsUrl, method, params) {
  return new Promise((resolve) => {
    if (typeof WebSocket !== 'function' || !wsUrl) return resolve(null);
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return resolve(null); }
    let timer = null;
    const done = (v) => {
      if (timer) clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      resolve(v);
    };
    timer = setTimeout(() => done(null), 3000);
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ id: 1, method: method, params: params || {} })); }
      catch (e) { done(null); }
    };
    ws.onmessage = (ev) => {
      let m = null;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && m.id === 1) done(m.result || null);
    };
    ws.onerror = () => done(null);
  });
}

const QR_RECT_EXPR = `(() => {
  const nodes = Array.from(document.querySelectorAll('img,canvas,div,svg'));
  let best = null;
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width < 130 || r.height < 130) continue;
    if (Math.abs(r.width - r.height) > Math.max(10, r.width * 0.12)) continue;
    if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    if (!best || r.width > best.width) best = { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  return best;
})()`;

/* 平台首页默认只显示「登录」按钮，不自动弹二维码。点一次登录入口，
   二维码弹层才会出现；找不到就返回空，不影响后续截图。 */
const LOGIN_CLICK_EXPR = `(() => {
  const wanted = ['登录', '立即登录', '登录/注册', '扫码登录'];
  const nodes = Array.from(document.querySelectorAll('button,a,div,span'));
  for (const el of nodes) {
    const t = (el.textContent || '').trim();
    if (!t || t.length > 8 || wanted.indexOf(t) < 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 18 || r.height < 12 || r.left < 0 || r.top < 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    el.click();
    return t;
  }
  return '';
})()`;

async function getPageTarget(s) {
  if (!s || !s.cdpPort) return null;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 1500);
  let list = null;
  try {
    const r = await fetch('http://127.0.0.1:' + s.cdpPort + '/json/list', { signal: ctl.signal });
    list = await r.json();
  } catch (e) { list = null; }
  finally { clearTimeout(to); }
  if (!Array.isArray(list)) return null;
  return list.find((t) => t && t.type === 'page' && /^https?:/i.test(t.url || '')) || null;
}

/** 真实登录判定：只认平台会话 Cookie 的名字，不拿 Cookies 文件大小猜 */
async function hasSessionCookie(s) {
  const page = await getPageTarget(s);
  if (!page || !page.webSocketDebuggerUrl) return null;
  const res = await cdpOnce(page.webSocketDebuggerUrl, 'Network.getCookies', { urls: [s.url] });
  const names = ((res && res.cookies) || []).map((c) => String(c.name || ''));
  if (!names.length) return false;
  const want = SESSION_COOKIES[s.platform] || [];
  return names.some((n) => want.indexOf(n) >= 0);
}

async function captureQrOnce(s) {
  if (!s || !s.cdpPort || s.status !== 'waiting') return;
  const page = await getPageTarget(s);
  if (!page || !page.webSocketDebuggerUrl) return;

  /* 页面在后台时平台会懒加载二维码（只渲染空白框），把标签页带到前台一次 */
  if (!s.brought) {
    await cdpOnce(page.webSocketDebuggerUrl, 'Page.bringToFront', {});
    s.brought = true;
  }

  /* 首页不自动弹二维码：等页面稳定后点一次「登录」，弹层才会出来 */
  if (!s.clicked && Date.now() - s.startedAt > 2200) {
    const ck = await cdpOnce(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: LOGIN_CLICK_EXPR, returnByValue: true
    });
    if (ck && ck.result && ck.result.value) s.clicked = true;
  }

  const ev = await cdpOnce(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: QR_RECT_EXPR, returnByValue: true
  });
  const rect = ev && ev.result && ev.result.value;
  let shot = null;
  let mime = 'image/png';
  if (rect && rect.width >= 130) {
    shot = await cdpOnce(page.webSocketDebuggerUrl, 'Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height, scale: 1 }
    });
  }
  if (!shot || !shot.data) {
    /* 还没找到二维码：用压缩整页图兜底，避免中间栏空白 */
    shot = await cdpOnce(page.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'jpeg', quality: 55 });
    mime = 'image/jpeg';
  }
  if (shot && shot.data) {
    s.qr = Buffer.from(shot.data, 'base64');
    s.qrAt = Date.now();
    s.qrMime = mime;
  }
}

function startQrMirror(s) {
  stopQrMirror(s);
  if (!s || !s.cdpPort) return;
  const tick = () => { captureQrOnce(s).catch(() => {}); };
  s.qrTimer = setInterval(tick, 2000);
  if (s.qrTimer.unref) s.qrTimer.unref();
  setTimeout(tick, 1200);
}

function stopQrMirror(s) {
  if (s && s.qrTimer) {
    clearInterval(s.qrTimer);
    s.qrTimer = null;
  }
}

/** 登录会话：一块屏幕同时只服务一个扫码流程，简单且不会抢焦点 */
let login = null;

function loginView(s) {
  if (!s) return null;
  return {
    id: s.id, platform: s.platform, profileDir: s.profileDir, url: s.url,
    browser: s.browser, status: s.status,
    startedAt: s.startedAt, expiresAt: s.startedAt + LOGIN_TIMEOUT_MS,
    cookieAt: s.cookieAt || '', message: s.message || '',
    qr: !!s.qr, qrAt: s.qrAt || 0, qrMime: s.qrMime || 'image/png'
  };
}

async function loginPoll() {
  if (!login || login.status !== 'waiting') return;
  /* Chrome 新建配置目录时就会生成 Cookies 文件（含匿名 cookie），
     所以不能用「文件变大」判定登录；必须看到平台会话 Cookie。 */
  const ok = await hasSessionCookie(login);
  if (ok === true) {
    login.status = 'ok';
    login.cookieAt = new Date().toISOString();
    login.message = '登录成功，登录态已保存，下次不用再扫码';
    try {
      fs.writeFileSync(path.join(login.profileDir, LOGIN_OK_FILE), JSON.stringify({
        platform: login.platform, browser: login.browserId || 'chrome', at: login.cookieAt
      }));
    } catch (e) {}
    stopQrMirror(login);
    try { login.child && login.child.kill(); } catch (e) {}
    return;
  }
  if (Date.now() - login.startedAt > LOGIN_TIMEOUT_MS) {
    login.status = 'timeout';
    login.message = '等待扫码超时（浏览器未关闭，可继续扫码后点「检测」确认）';
    stopQrMirror(login);
  }
}

async function loginStart(body) {
  const platform = detectPlatform(body.platform || '');
  if (!LOGIN_URLS[platform]) {
    return { status: 400, body: { ok: false, code: 'BAD_PLATFORM', message: '不支持的平台：' + (body.platform || '') } };
  }
  const rawDir = String(body.profileDir || '').trim();
  if (!rawDir) {
    return { status: 400, body: { ok: false, code: 'NO_PROFILE', message: '缺少 profileDir（登录态保存目录）' } };
  }
  const dir = /^[a-zA-Z]:[\\/]/.test(rawDir) || rawDir.indexOf('\\\\') === 0
    ? rawDir
    : path.join(LOGIN_PROFILE_ROOT, rawDir);
  const browser = findBrowser(plugin.browser);
  if (!browser) {
    return {
      status: 500,
      body: { ok: false, code: 'NO_BROWSER', message: '本机没有找到 Chrome/Edge。扫码登录要在有屏幕的采集机上执行；服务器上无法弹二维码' }
    };
  }
  const browserId = /msedge/i.test(browser) ? 'edge' : 'chrome';
  /* 登录标记由上次成功扫码后写入这个浏览器目录；浏览器变了就不算已登录，
     否则会出现「桥开 Edge、登录态还是 Chrome」的错位。 */
  const okFile = path.join(dir, LOGIN_OK_FILE);
  let okMark = null;
  try { okMark = JSON.parse(fs.readFileSync(okFile, 'utf8')); } catch (e) { okMark = null; }
  const markBrowser = (okMark && okMark.browser) || 'chrome';
  if (!body.force && okMark && markBrowser === browserId) {
    return {
      status: 200,
      body: {
        ok: true, already: true,
        session: {
          id: 'ls_existing', platform, profileDir: dir, url: LOGIN_URLS[platform],
          status: 'ok', message: '检测到本机已有登录态，无需重复扫码',
          qr: false, qrAt: 0
        }
      }
    };
  }
  if (login && login.status === 'waiting' && login.profileDir === dir && Date.now() - login.startedAt < LOGIN_TIMEOUT_MS) {
    return { status: 200, body: { ok: true, session: loginView(login), reused: true } };
  }
  if (login) {
    stopQrMirror(login);
    try { login.child && login.child.kill(); } catch (e) {}
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const hadCookie = !!cookieStat(dir);
  const cdpPort = await freePort();
  let child;
  try {
    const args = [
      '--user-data-dir=' + dir,
      '--no-first-run', '--no-default-browser-check', '--no-crash-upload',
      '--window-size=1180,860',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling'
    ];
    if (cdpPort) args.push('--remote-debugging-port=' + cdpPort, '--remote-allow-origins=*');
    args.push(LOGIN_URLS[platform]);
    child = spawn(browser, args, { stdio: 'ignore', detached: false });
    child.on('error', () => { if (login && login.status === 'waiting') { login.status = 'failed'; login.message = '浏览器启动失败'; } });
  } catch (e) {
    return { status: 500, body: { ok: false, code: 'SPAWN_FAIL', message: '浏览器启动失败：' + e.message } };
  }
  login = {
    id: 'ls_' + Date.now().toString(36),
    platform, profileDir: dir, url: LOGIN_URLS[platform], browser, browserId,
    status: 'waiting', startedAt: Date.now(), hadCookie, child, cdpPort,
    message: '已在本机打开浏览器，二维码会同步到中间栏；也可以直接在浏览器窗口里扫码'
  };
  startQrMirror(login);
  return { status: 200, body: { ok: true, session: loginView(login) } };
}

/* =========================================================================
 * 本地采集器（浏览器扩展）+ 云端调度
 * -------------------------------------------------------------------------
 * 这里有两种身份，刻意分开：
 *
 *   1) 对「浏览器扩展」是服务端：扩展 POST /v1/plugin/hello 报到，
 *      GET /v1/plugin/poll 领活，POST /v1/plugin/result 交数据。
 *      扩展只认识 127.0.0.1，从不接触云端令牌 —— 令牌只在这个桥里。
 *
 *   2) 对「云端 BFF」是客户端：定时 GET /v1/device/jobs 领任务、
 *      POST /v1/device/jobs/:id/result 回传。云端连不到本机，
 *      全部由本机主动外连，所以不需要反向隧道 / 端口映射。
 *
 * 配对：页面（已登录）→ 本机桥 POST /v1/pair {code, cloud} → 桥拿码去云端
 * 换设备令牌并落盘。用户全程不用复制粘贴任何 token。
 * ========================================================================= */

const BRIDGE_CONF = path.join(__dirname, 'bridge-config.json');
const PLUGIN_TIMEOUT_MS = 25000;   /* 扩展多久没心跳算掉线 */
const INBOX = path.join(path.dirname(MC_DIR), 'inbox');

let conf = { cloud: '', token: '', deviceId: '', name: '', at: '' };
(function loadConf() {
  try {
    const o = JSON.parse(fs.readFileSync(BRIDGE_CONF, 'utf8'));
    if (o && typeof o === 'object') conf = Object.assign(conf, o);
  } catch (e) { /* 没配过就是空 */ }
})();
function saveConf() {
  try { fs.writeFileSync(BRIDGE_CONF, JSON.stringify(conf, null, 2)); } catch (e) {
    console.warn('[bridge] 配对信息落盘失败：' + e.message);
  }
}

/** 扩展侧的运行时状态（内存即可，进程重启后扩展会自动重新报到） */
const plugin = {
  lastSeen: 0, version: '', platforms: [], browser: '',
  queue: [],            /* 云端领来、还没被扩展取走的任务 */
  inflight: new Map(),  /* jobId → job（等扩展回传） */
  done: 0, failed: 0, lastError: ''
};

function pluginOnline() { return plugin.lastSeen > 0 && Date.now() - plugin.lastSeen < PLUGIN_TIMEOUT_MS; }

function httpJson(url, opt, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 15000);
  return fetch(url, Object.assign({}, opt, { signal: ctl.signal }))
    .then(async (r) => {
      const txt = await r.text();
      let j = null;
      try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = null; }
      return { status: r.status, ok: r.ok, body: j, text: txt };
    })
    .finally(() => clearTimeout(t));
}

/* ---------- 配对：页面把码交给本机桥，桥去云端换令牌 ---------- */
async function pairWithCloud(body) {
  const code = String(body.code || '').replace(/\D/g, '');
  const cloud = String(body.cloud || '').replace(/\/+$/, '');
  if (!code) return { status: 400, body: { ok: false, code: 'NO_CODE', message: '缺少配对码' } };
  if (!/^https?:\/\//i.test(cloud)) {
    return { status: 400, body: { ok: false, code: 'NO_CLOUD', message: '缺少云端地址（由页面自动带上）' } };
  }
  try {
    const r = await httpJson(cloud + '/v1/device/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        name: os.hostname(),
        host: os.hostname(),
        version: '1.0.0',
        platforms: ['douyin', 'xhs', 'kuaishou', 'sph']
      })
    }, 15000);
    if (!r.ok || !r.body || !r.body.ok) {
      return {
        status: 400,
        body: {
          ok: false, code: (r.body && r.body.code) || 'PAIR_FAILED',
          message: (r.body && r.body.message) || ('配对失败（HTTP ' + r.status + '）')
        }
      };
    }
    conf = {
      cloud,
      token: r.body.token,
      deviceId: (r.body.device && r.body.device.id) || '',
      name: (r.body.device && r.body.device.name) || os.hostname(),
      at: new Date().toISOString()
    };
    saveConf();
    startupSync();
    return { status: 200, body: { ok: true, device: r.body.device, cloud } };
  } catch (e) {
    return {
      status: 502,
      body: { ok: false, code: 'CLOUD_UNREACHABLE', message: '连不上云端（' + cloud + '）：' + ((e && e.message) || e) }
    };
  }
}

/* ---------- 云端任务轮询（本机 → 云端） ---------- */
let syncTimer = null;
let syncBusy = false;
let beatAt = 0;

async function syncOnce() {
  if (syncBusy || !conf.token || !conf.cloud) return;
  /* 扩展没连上就别领活：领了没人干，任务只会在云端超时 */
  if (!pluginOnline()) return;
  /* 一次只干一个：扩展是单线程的执行器，领多了只会在队列里互相等，
     反而把后领的那几个等成超时 */
  if (plugin.inflight.size > 0 || plugin.queue.length > 0) return;
  syncBusy = true;
  try {
    const r = await httpJson(conf.cloud + '/v1/device/jobs', {
      method: 'GET',
      headers: { 'X-Device-Token': conf.token }
    }, 12000);
    if (r.status === 401) {
      conf.token = '';
      saveConf();
      console.warn('[bridge] 设备令牌已失效，请在页面上重新「连接本机采集器」');
      return;
    }
    const job = r.body && r.body.job;
    if (job && job.id) {
      if (!plugin.inflight.has(job.id) && !plugin.queue.some((j) => j.id === job.id)) {
        plugin.queue.push(job);
        console.log('[bridge] 领到任务 ' + job.id + '：' + job.platform + ' / ' + job.keyword + ' × ' + job.limit);
      }
    }
  } catch (e) {
    plugin.lastError = String((e && e.message) || e);
  } finally {
    syncBusy = false;
  }
}

async function heartbeat(force) {
  if (!conf.token || !conf.cloud) return;
  if (!force && Date.now() - beatAt < 15000) return;
  beatAt = Date.now();
  try {
    await httpJson(conf.cloud + '/v1/device/hello', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Token': conf.token },
      body: JSON.stringify({
        plugin: pluginOnline(),
        version: plugin.version || '1.0.0',
        host: os.hostname(),
        platforms: plugin.platforms.length ? plugin.platforms : ['douyin', 'xhs', 'kuaishou', 'sph']
      })
    }, 10000);
  } catch (e) { /* 心跳失败不致命，下一轮再试 */ }
}

/* ---------- 云端扫码登录中转：HTTPS 页面拿不到 localhost，由桥主动外连 ---------- */
let relayTask = null;
let relayPolling = false;

async function relayUpload(path, body) {
  if (!conf.token || !conf.cloud) return { ok: false };
  return httpJson(conf.cloud + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Token': conf.token },
    body: JSON.stringify(body || {})
  }, 12000);
}

async function relayStatus(task, status, message, profileDir) {
  if (!task) return;
  task.lastStatus = status;
  await relayUpload('/v1/device/login/' + encodeURIComponent(task.id) + '/status', {
    status: status, message: message || '', profileDir: profileDir || ''
  });
}

async function relayQr(task) {
  if (!task || !login || login.id !== task.sessionId || !login.qr) return;
  if (login.qrAt === task.lastQrAt) return;
  /* 整页兜底图只传一次；等到裁剪后的二维码再持续更新 */
  if (login.qrMime === 'image/jpeg' && task.sentFull) return;
  if (login.qrMime === 'image/jpeg') task.sentFull = true;
  task.lastQrAt = login.qrAt;
  await relayUpload('/v1/device/login/' + encodeURIComponent(task.id) + '/qr', {
    png: login.qr.toString('base64'), mime: login.qrMime || 'image/png', at: login.qrAt
  });
}

async function relayTick() {
  const task = relayTask;
  if (!task || task.busy) return;
  task.busy = true;
  try {
    await loginPoll();
    await relayQr(task);
    if (!login || login.id !== task.sessionId) return;
    if (login.status !== task.lastStatus) {
      await relayStatus(task, login.status, login.message, login.profileDir);
    }
    /* 页面点了取消：桥也把本机浏览器关掉 */
    try {
      const r = await httpJson(conf.cloud + '/v1/device/login/' + encodeURIComponent(task.id) + '/state',
        { headers: { 'X-Device-Token': conf.token } }, 8000);
      if (r.body && r.body.status === 'canceled' && login.status === 'waiting') {
        stopQrMirror(login);
        try { login.child && login.child.kill(); } catch (e) {}
        login.status = 'canceled';
        login.message = '已取消登录';
        await relayStatus(task, 'canceled', login.message, login.profileDir);
      }
    } catch (e) { /* 下一轮再查 */ }
    if (['ok', 'timeout', 'failed', 'canceled'].indexOf(login.status) >= 0) {
      if (task.timer) clearInterval(task.timer);
      relayTask = null;
    }
  } finally {
    task.busy = false;
  }
}

async function relayBegin(cmd) {
  if (relayTask && relayTask.timer) clearInterval(relayTask.timer);
  const task = { id: cmd.id, sessionId: '', lastStatus: '', lastQrAt: 0, sentFull: false, timer: null };
  relayTask = task;
  const r = await loginStart({ platform: cmd.platform, profileDir: cmd.profileDir, force: cmd.force });
  if (!r.body || r.body.ok === false) {
    await relayStatus(task, 'failed', (r.body && r.body.message) || '登录启动失败', cmd.profileDir);
    relayTask = null;
    return;
  }
  if (r.body.already) {
    await relayStatus(task, 'ok', r.body.session.message, r.body.session.profileDir);
    relayTask = null;
    return;
  }
  task.sessionId = r.body.session.id;
  await relayStatus(task, r.body.session.status || 'waiting', r.body.session.message || '', r.body.session.profileDir);
  task.timer = setInterval(() => { relayTick().catch(() => {}); }, 2000);
  if (task.timer.unref) task.timer.unref();
}

async function relayPoll() {
  if (!conf.token || !conf.cloud || relayTask || relayPolling) return;
  relayPolling = true;
  try {
    const r = await httpJson(conf.cloud + '/v1/device/login/next',
      { headers: { 'X-Device-Token': conf.token } }, 10000);
    if (r.status === 401) {
      conf.token = '';
      saveConf();
      console.warn('[bridge] 设备令牌已失效，请重新「连接」配对');
      return;
    }
    if (r.body && r.body.login) await relayBegin(r.body.login);
  } catch (e) { /* 网络抖动，下一轮再试 */ }
  finally { relayPolling = false; }
}

function startupSync() {
  if (syncTimer) clearInterval(syncTimer);
  if (!conf.token) return;
  syncTimer = setInterval(() => { syncOnce(); relayPoll(); heartbeat(false); }, 1500);
  if (syncTimer.unref) syncTimer.unref();
  heartbeat(true);
  relayPoll();
  console.log('[bridge] 已连上云端 ' + conf.cloud + '（设备 ' + (conf.name || conf.deviceId) + '）');
}

/* ---------- 扩展上报结果 → 落 inbox + 转给云端 ---------- */
function saveSnapshot(job, payload) {
  try {
    fs.mkdirSync(INBOX, { recursive: true });
    const f = path.join(INBOX, (job.id || 'job') + '.json');
    fs.writeFileSync(f, JSON.stringify({
      job: { id: job.id, platform: job.platform, keyword: job.keyword, at: new Date().toISOString() },
      result: payload
    }, null, 2));
    return f;
  } catch (e) { return ''; }
}

async function reportResult(jobId, payload) {
  const job = plugin.inflight.get(jobId) || { id: jobId, platform: '', keyword: '' };
  const snap = saveSnapshot(job, payload);
  plugin.inflight.delete(jobId);
  if (payload && payload.ok !== false) plugin.done++; else plugin.failed++;
  if (!conf.token || !conf.cloud) {
    return { ok: false, code: 'NOT_PAIRED', message: '本机桥还没配对云端，结果只存在本地 inbox' };
  }
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    try {
      const r = await httpJson(conf.cloud + '/v1/device/jobs/' + encodeURIComponent(jobId) + '/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': conf.token },
        body: JSON.stringify(payload)
      }, 20000);
      if (r.ok && r.body && r.body.ok) return { ok: true, snapshot: snap };
      lastErr = (r.body && r.body.message) || ('HTTP ' + r.status);
      if (r.status === 404) break;    /* 云端没这个任务了，重试无意义 */
    } catch (e) { lastErr = String((e && e.message) || e); }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return { ok: false, code: 'REPORT_FAILED', message: lastErr, snapshot: snap };
}

/* 扩展上报「执行到哪一步」→ 云端 job.steps。
   不排队、不重试：这是给人看的过程，丢一条不影响结果本身。 */
async function reportProgress(jobId, step) {
  if (!conf.token || !conf.cloud) return { ok: false, code: 'NOT_PAIRED' };
  try {
    const r = await httpJson(conf.cloud + '/v1/device/jobs/' + encodeURIComponent(jobId) + '/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Token': conf.token },
      body: JSON.stringify(step || {})
    }, 8000);
    return { ok: !!(r && r.ok), status: r && r.status };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------- HTTP 服务 ---------- */
/* 跨域 + 私有网络：
   页面在 https://aizhiying.online，扫码登录必须弹在「使用者这台电脑」上，
   所以前端要能直连本机桥 http://127.0.0.1:<PORT>。Chrome 对 localhost 的
   混合内容放行，但需要 CORS 头；新版 Chrome 的私有网络访问还要预检里
   明确 Allow-Private-Network，否则 fetch 会被拦在预检。 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '600'
};

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length
  }, CORS_HEADERS));
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 4e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  /* 轻量探针：前端用它判断「本机采集桥在不在」。
     不扫数据目录，必须毫秒级返回 —— 页面加载时会直接打这个接口。 */
  if (req.method === 'GET' && url === '/v1/ping') {
    return sendJson(res, 200, {
      ok: true,
      service: 'mediacrawler-bridge',
      host: os.hostname(),
      port: PORT,
      pid: process.pid,
      profileRoot: LOGIN_PROFILE_ROOT,
      browser: findBrowser() || '',
      login: loginView(login),
      paired: !!conf.token,
      cloud: conf.cloud || '',
      plugin: { online: pluginOnline(), version: plugin.version, lastSeen: plugin.lastSeen, queued: plugin.queue.length },
      at: new Date().toISOString()
    });
  }

  if (req.method === 'GET' && url === '/v1/health') {
    const st = loadAll();
    return sendJson(res, 200, {
      ok: true,
      service: 'mediacrawler-bridge',
      research: true,
      nonCommercial: true,
      note: '仅供本地研究，禁止商用 / 禁止进发布包',
      mcDir: MC_DIR,
      files: st.files.length,
      comments: st.comments.length
    });
  }

  if (req.method === 'GET' && url === '/v1/debug/files') {
    const st = loadAll();
    return sendJson(res, 200, { ok: true, mcDir: MC_DIR, files: st.files, comments: st.comments.length });
  }

  /* 作品清单：给 BFF / 前端做「搜到的作品」卡片可视化。
     每个作品附上该作品下的评论条数（从归一化评论里数），前端可以直接展示。 */
  if (req.method === 'GET' && url === '/v1/notes') {
    const st = loadAll();
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const platform = detectPlatform(q.get('platform') || '');
    const keyword = String(q.get('keyword') || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(q.get('limit')) || 60));
    const cntByNote = {};
    for (const c of st.comments) {
      if (c.note_id) cntByNote[c.note_id] = (cntByNote[c.note_id] || 0) + 1;
    }
    let list = st.notesArr.slice();
    if (platform) list = list.filter((n) => detectPlatform(n.platform) === platform);
    if (keyword) {
      list = list.filter((n) =>
        (n.keyword || '').toLowerCase().indexOf(keyword) >= 0 ||
        (n.title || '').toLowerCase().indexOf(keyword) >= 0);
    }
    list = list.map((n) => Object.assign({ commentCount: cntByNote[n.note_id] || 0 }, n));
    list.sort((a, b) => b.commentCount - a.commentCount || b.liked - a.liked);
    return sendJson(res, 200, {
      ok: true,
      total: st.notesArr.length,
      matched: list.length,
      notes: list.slice(0, limit)
    });
  }

  if (req.method === 'POST' && url === '/v1/comments/collect') {
    const body = await readBody(req);
    const st = loadAll();
    const list = filterComments(body, st.comments);
    return sendJson(res, 200, {
      ok: true,
      data: {
        comments: list.map((c) => ({
          nickname: c.nickname,
          comment: c.comment,
          cid: c.cid,
          video_title: c.video_title,
          video_url: c.video_url,
          author: c.author,
          keyword: c.keyword,
          likes: c.likes,
          at: c.at,
          region: c.region,
          platform: c.platform
        }))
      },
      _meta: {
        research: true,
        nonCommercial: true,
        requested: {
          platform: body.platform, keyword: body.keyword, limit: body.limit,
          target: body.target || '', author: body.author || '', video: body.video || ''
        },
        matched: list.length,
        poolTotal: st.comments.length,
        withSource: list.filter((c) => !!c.video_url).length
      }
    });
  }

  /* 扫码登录会话（见上方「扫码登录」段） */
  if (req.method === 'POST' && url === '/v1/login/start') {
    const body = await readBody(req);
    const r = await loginStart(body);
    return sendJson(res, r.status, r.body);
  }
  if (req.method === 'GET' && url === '/v1/login/status') {
    await loginPoll();
    return sendJson(res, 200, { ok: true, session: loginView(login) });
  }
  /* 中间栏的二维码图片（PNG）。页面用 <img> 直接加载，2 秒刷新一次。 */
  if (req.method === 'GET' && url === '/v1/login/qr') {
    await loginPoll();
    if (!login || !login.qr) {
      return sendJson(res, 404, { ok: false, code: 'NO_QR', message: '二维码还没准备好' });
    }
    res.writeHead(200, Object.assign({
      'Content-Type': login.qrMime || 'image/png',
      'Content-Length': login.qr.length,
      'Cache-Control': 'no-store'
    }, CORS_HEADERS));
    return res.end(login.qr);
  }
  if (req.method === 'POST' && url === '/v1/login/cancel') {
    if (login && login.status === 'waiting') {
      stopQrMirror(login);
      try { login.child && login.child.kill(); } catch (e) {}
      login.status = 'canceled';
      login.message = '已取消本次扫码';
    }
    return sendJson(res, 200, { ok: true, session: loginView(login) });
  }

  /* ---- 采集器配对：页面把云端给的 6 位码交给本机桥 ----
     GET 版本给 HTTPS 页面用：顶层打开 http://127.0.0.1:8801/v1/pair?...，
     不受「HTTPS 页面 fetch localhost」的混合内容限制。 */
  if (req.method === 'GET' && url === '/v1/pair') {
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const r = await pairWithCloud({ code: q.get('code'), cloud: q.get('cloud') });
    const ok = !!(r.body && r.body.ok);
    const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const msg = ok
      ? ('配对成功：' + ((r.body.device && r.body.device.name) || '本机') + '，可以关闭此页回系统继续。')
      : ((r.body && r.body.message) || '配对失败');
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta charset="utf-8"><title>本机采集桥配对</title>' +
      '<style>body{font:15px/1.7 system-ui;margin:48px;color:#222}code{background:#f3f3f3;padding:2px 6px;border-radius:4px}</style>' +
      '<h2>' + (ok ? '✅ ' : '❌ ') + esc(msg) + '</h2>' +
      '<p>本页会在 2 秒后自动关闭。若没有关闭，直接关掉即可。</p>' +
      '<script>setTimeout(function(){try{window.close()}catch(e){}},2000)</script>');
  }
  if (req.method === 'POST' && url === '/v1/pair') {
    const body = await readBody(req);
    const r = await pairWithCloud(body);
    return sendJson(res, r.status, r.body);
  }

  /* ---- 本机桥状态（页面「连接本机采集器」卡片用） ---- */
  if (req.method === 'GET' && url === '/v1/bridge/status') {
    return sendJson(res, 200, {
      ok: true,
      host: os.hostname(),
      paired: !!conf.token,
      cloud: conf.cloud || '',
      device: { id: conf.deviceId, name: conf.name, at: conf.at },
      plugin: {
        online: pluginOnline(), version: plugin.version, platforms: plugin.platforms,
        lastSeen: plugin.lastSeen, queued: plugin.queue.length, inflight: plugin.inflight.size,
        done: plugin.done, failed: plugin.failed, lastError: plugin.lastError
      },
      inbox: INBOX
    });
  }

  /* ---- 扩展报到。扩展每次连上都会打这个，也可当心跳 ---- */
  if (req.method === 'POST' && url === '/v1/plugin/hello') {
    const body = await readBody(req);
    const was = pluginOnline();
    plugin.lastSeen = Date.now();
    plugin.version = String(body.version || plugin.version || '').slice(0, 20);
    if (body.browser) plugin.browser = body.browser === 'edge' ? 'edge' : 'chrome';
    if (Array.isArray(body.platforms) && body.platforms.length) {
      plugin.platforms = body.platforms.slice(0, 8).map((x) => String(x).slice(0, 20));
    }
    if (!was) console.log('[bridge] PLUGIN ONLINE v' + (plugin.version || '?') + ' · ' + (plugin.browser || 'chrome') + ' · ' + plugin.platforms.join(','));
    if (!conf.token) {
      return sendJson(res, 200, {
        ok: true, paired: false,
        message: '扩展已连上本机桥，但桥还没和云端配对：请在系统页面点「连接本机采集器」',
        poll: 1500
      });
    }
    return sendJson(res, 200, {
      ok: true, paired: true, device: conf.name || conf.deviceId,
      cloud: conf.cloud, poll: 1200, platforms: ['douyin', 'xhs', 'kuaishou', 'sph']
    });
  }

  /* ---- 扩展领活。没活就返回 job:null，扩展隔 1.2s 再问 ---- */
  if (req.method === 'GET' && url === '/v1/plugin/poll') {
    plugin.lastSeen = Date.now();
    const job = plugin.queue.shift() || null;
    if (job) plugin.inflight.set(job.id, job);
    return sendJson(res, 200, {
      ok: true,
      job,
      paired: !!conf.token
    });
  }

  /* ---- 扩展交活。先落 inbox 快照，再转云端 ---- */
  if (req.method === 'POST' && url === '/v1/plugin/result') {
    const body = await readBody(req);
    plugin.lastSeen = Date.now();
    const jobId = String(body.jobId || '');
    if (!jobId) return sendJson(res, 400, { ok: false, code: 'NO_JOB', message: '缺少 jobId' });
    const payload = {
      ok: body.ok !== false,
      code: body.code || '',
      message: body.message || '',
      comments: Array.isArray(body.comments) ? body.comments.slice(0, 500) : [],
      notes: Array.isArray(body.notes) ? body.notes.slice(0, 100) : [],
      stats: body.stats && typeof body.stats === 'object' ? body.stats : {},
      /* 评论/点赞任务的回执与执行步骤：原样透传，云端自己截断。
         白名单漏掉它们的话，云端只见 comment:null / steps:[]，
         前端卡片就没有过程、也看不到失败的具体原因。 */
      comment: body.comment && typeof body.comment === 'object' ? body.comment : null,
      like: body.like && typeof body.like === 'object' ? body.like : null,
      steps: Array.isArray(body.steps) ? body.steps.slice(0, 40) : []
    };
    const r = await reportResult(jobId, payload);
    return sendJson(res, r.ok ? 200 : 502, r);
  }

  /* ---- 扩展上报执行步骤（打开页面/定位/写入/点赞/发送） ---- */
  if (req.method === 'POST' && url === '/v1/plugin/progress') {
    const body = await readBody(req);
    plugin.lastSeen = Date.now();
    const jobId = String(body.jobId || '');
    if (!jobId) return sendJson(res, 400, { ok: false, code: 'NO_JOB', message: '缺少 jobId' });
    const r = await reportProgress(jobId, {
      step: String(body.step || '').slice(0, 20),
      status: String(body.status || 'ok').slice(0, 6),
      msg: String(body.msg || '').slice(0, 120)
    });
    return sendJson(res, 200, { ok: true, forwarded: r.ok });
  }

  /* ---- 扩展侧状态（popup 显示用） ---- */
  if (req.method === 'GET' && url === '/v1/plugin/status') {
    return sendJson(res, 200, {
      ok: true,
      online: pluginOnline(),
      paired: !!conf.token,
      device: conf.name || '',
      queued: plugin.queue.length,
      done: plugin.done, failed: plugin.failed
    });
  }

  return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'unknown path' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[mediacrawler-bridge] 监听 http://127.0.0.1:' + PORT);
  console.log('[mediacrawler-bridge] ⛔ 非商用 · 本地研究 · 禁止进发布包');
  console.log('[mediacrawler-bridge] 读取目录 MC_DIR=' + MC_DIR);
  console.log('[mediacrawler-bridge] BFF 配置：COLLECT_CRAWLER_URL=http://127.0.0.1:' + PORT);
  console.log('[mediacrawler-bridge] 采集器配对状态：' + (conf.token ? ('已配对 ' + conf.cloud) : '未配对（在系统页面点「连接本机采集器」）'));
  startupSync();
});
