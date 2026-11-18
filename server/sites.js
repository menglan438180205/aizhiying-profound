'use strict';
/* =========================================================
   sites.js — 「AI秒搭建站」产物持久化与静态托管
   ---------------------------------------------------------
   为什么要有这个模块（原先的断点）：

   旧实现只有前端一侧：geosite.js 里 buildSite() 在浏览器内存里
   拼出一堆 HTML 字符串，塞进 GB.site，然后 pushHistory() 把品牌 /
   域名 / 得分这 8 个字段写进 localStorage。也就是说：

     · 真正的产物（files[] 里的页面源码）从未离开过浏览器内存；
     · 刷新页面即丢失，换设备打开直接没有；
     · 服务端 ROUTES 里没有任何 /v1/sites 端点，前端生成完无处投递；
     · 「域名」只是一个拼进 <link rel=canonical> 的字符串，没有
       DNS / 可达性 / 线上 GEO 文件的任何校验。

   结果是：填了真实域名，看到的仍是样例 —— 因为系统里压根不存在
   「校验 → 生成 → 落盘 → 托管 → 部署」这条生产链路的后半段。

   本模块补上服务端一侧：
     1) 产物按站点落盘 <DATA_ROOT>/sites/<siteId>/files/<name>
     2) meta.json 记站点元信息 + 文件清单 + 体检分
     3) 提供安全的文件解析，支撑 /site/<id>/... 真实 HTTP 托管
     4) 提供域名探测：DNS 解析 + HTTPS 可达 + 线上 GEO 文件抓取

   安全约束（与 K0 静态越界同源，不能放松）：
     · siteId 白名单字符集，不匹配直接拒绝；
     · 文件名禁止 .. / 空字节 / 绝对路径，且必须落在 ALLOW_EXT 白名单；
     · 单站点文件数与总体积上限，防止一次请求打爆磁盘。
   ========================================================= */

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const https = require('https');
const http = require('http');
const { mimeOf } = require('./util');   /* MIME 查表已收口到 ./util，避免与 index.js 各写一遍 */

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} }

/* ---- 常量 ---- */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ALLOW_EXT = /\.(html?|css|js|json|xml|txt|md|ico|png|jpe?g|gif|webp|svg|woff2?)$/i;
const MAX_FILES = 60;          /* 单站点文件数上限 */
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;  /* 单站点总体积上限 8MB */
const MAX_NAME_LEN = 96;

/* MIME 查表与 mimeOf 已收口到 ./util（见顶部 require），此处不再重复定义。 */

/** 域名字符白名单：允许 a-z 0-9 . - _ 和中文（国际化域名） */
function safeDomain(raw) {
  return String(raw || '').trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .split(/[/?#]/)[0]
    .toLowerCase();
}

/** 相对路径 → 安全文件名。返回 null 表示拒绝 */
function safeName(name) {
  const raw = String(name == null ? '' : name);
  if (!raw || raw.length > MAX_NAME_LEN) return null;
  if (raw.indexOf('..') > -1 || raw.indexOf('\u0000') > -1) return null;
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) return null;
  /* 归一化后不允许逃出根目录 */
  const norm = path.normalize(raw).replace(/^([/\\]|\.\.[/\\])+/, '');
  if (!norm || norm !== path.posix.normalize(raw.split('\\').join('/')).replace(/^\/+/, '')) {
    /* 允许 assets/style.css 这类子路径，但拒绝 ../../ 与 Windows 盘符 */
  }
  const parts = norm.split(/[/\\]/);
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..') return null;
    if (seg.length > MAX_NAME_LEN) return null;
  }
  /* 统一成正斜杠：Windows 下 path.normalize 会产出反斜杠，
     虽然本地可用，但作为托管 URL 的一部分必须是 / */
  if (!ALLOW_EXT.test(norm)) return null;
  return norm.split('\\').join('/');
}

class SiteStore {
  /**
   * @param {string} root 站点根目录（建议 DATA_ROOT/sites）
   */
  constructor(root) {
    this.root = root;
    ensureDir(root);
  }

  dirOf(id) { return path.join(this.root, String(id)); }

  /** 读站点 meta；不存在返回 null */
  meta(id) {
    if (!ID_RE.test(String(id || ''))) return null;
    const f = path.join(this.dirOf(id), 'meta.json');
    if (!fs.existsSync(f)) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
  }

  /** 摘要列表（不含文件正文），按更新时间倒序 */
  list(limit) {
    let ids = [];
    try { ids = fs.readdirSync(this.root); } catch (e) { return []; }
    const out = [];
    for (const id of ids) {
      if (!ID_RE.test(id)) continue;
      const m = this.meta(id);
      if (!m) continue;
      out.push({
        id: m.id, brand: m.brand, domain: m.domain, date: m.date,
        pages: (m.pages || []).length, files: (m.files || []).length,
        score: m.score, industry: m.industry, industryLabel: m.industryLabel,
        status: m.status || '已生成', updatedAt: m.updatedAt, createdAt: m.createdAt
      });
    }
    out.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    return typeof limit === 'number' ? out.slice(0, limit) : out;
  }

  /**
   * 落盘一个站点（同名 brand+domain 幂等更新）
   * @param {object} payload { id?, brand, domain, spec, files:[{name,text,group}], audit, pages, ldCount, faqs, keywords }
   */
  save(payload) {
    const p = payload || {};
    const brand = String(p.brand || '未命名企业').trim().slice(0, 60);
    const domain = safeDomain(p.domain) || 'example.com';
    const rawFiles = Array.isArray(p.files) ? p.files : [];
    if (!rawFiles.length) return { error: 'FILES_EMPTY', message: '站点没有可落盘的文件' };
    if (rawFiles.length > MAX_FILES) return { error: 'TOO_MANY_FILES', message: `文件数 ${rawFiles.length} 超过上限 ${MAX_FILES}` };

    /* 先全部解析 + 量体积，任何一项非法整体拒绝，避免写一半 */
    const files = [];
    let total = 0;
    for (const f of rawFiles) {
      const name = safeName(f && f.name);
      if (!name) return { error: 'BAD_NAME', message: `非法文件名：${String((f && f.name) || '').slice(0, 40)}` };
      const text = String((f && f.text) == null ? '' : f.text);
      const bytes = Buffer.byteLength(text, 'utf8');
      total += bytes;
      if (total > MAX_TOTAL_BYTES) return { error: 'TOO_LARGE', message: '站点体积超过 8MB 上限' };
      files.push({ name, group: String((f && f.group) || '文件'), bytes });
    }

    /* 幂等：同一 brand+domain 复用旧 id，避免历史里堆积重复条目 */
    let id = String(p.id || '').trim();
    if (!ID_RE.test(id)) {
      const exist = this.list().filter((x) => x.brand === brand && x.domain === domain)[0];
      id = exist ? exist.id : ('gs' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    }
    if (!ID_RE.test(id)) id = 'gs' + Date.now().toString(36);

    const dir = this.dirOf(id);
    const fileDir = path.join(dir, 'files');
    const existed = fs.existsSync(path.join(dir, 'meta.json'));

    /* 若 id 复用，先清空旧文件，避免删掉的页面仍残留在托管里 */
    if (existed) { try { fs.rmSync(fileDir, { recursive: true, force: true }); } catch (e) {} }
    ensureDir(fileDir);

    for (let i = 0; i < files.length; i++) {
      const target = path.join(fileDir, files[i].name);
      ensureDir(path.dirname(target));
      fs.writeFileSync(target, Buffer.from(String(rawFiles[i].text), 'utf8'));
    }

    const now = Date.now();
    const meta = {
      id, brand, domain,
      industry: String(p.industry || 'general'),
      industryLabel: String(p.industryLabel || ''),
      date: String(p.date || ''),
      pages: Array.isArray(p.pages) ? p.pages.map((x) => ({ file: x.file, crumb: x.crumb, title: x.title, desc: x.desc })) : [],
      keywords: Array.isArray(p.keywords) ? p.keywords.slice(0, 12) : [],
      score: Number(p.score || 0),
      ldCount: Number(p.ldCount || 0),
      status: String(p.status || '已生成'),
      probe: p.probe || null,
      spec: p.spec || null,
      files,
      createdAt: existed ? (this.meta(id) || {}).createdAt || now : now,
      updatedAt: now
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return { ok: true, record: this.summary(meta), totalBytes: total };
  }

  summary(m) {
    return {
      id: m.id, brand: m.brand, domain: m.domain, date: m.date,
      pages: m.pages.length, files: (m.files || []).length,
      score: m.score, industry: m.industry, industryLabel: m.industryLabel,
      status: m.status, createdAt: m.createdAt, updatedAt: m.updatedAt
    };
  }

  /** 读某个文件的正文（供 API 返回源码） */
  readFile(id, name) {
    if (!ID_RE.test(String(id || ''))) return null;
    const rel = safeName(name);
    if (!rel) return null;
    const full = path.join(this.dirOf(id), 'files', rel);
    if (!full.startsWith(path.join(this.dirOf(id), 'files'))) return null;
    if (!fs.existsSync(full)) return null;
    try { return fs.readFileSync(full, 'utf8'); } catch (e) { return null; }
  }

  /** 静态托管用：解析 http 路径到本地文件，返回 {full, mime} 或 null */
  resolveStatic(id, relPath) {
    if (!ID_RE.test(String(id || ''))) return null;
    let rel = String(relPath || '').replace(/^\/+/, '').split('?')[0];
    try { rel = decodeURIComponent(rel); } catch (e) { return null; }
    if (!rel) rel = 'index.html';
    /* White-list 之前先砍掉回溯 */
    if (rel.indexOf('..') > -1 || rel.indexOf('\u0000') > -1) return null;
    const safe = safeName(rel);
    if (!safe) return null;
    const full = path.join(this.dirOf(id), 'files', safe);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return null;
    return { full, mime: mimeOf(full) };
  }

  remove(id) {
    if (!ID_RE.test(String(id || ''))) return false;
    const d = this.dirOf(id);
    if (!fs.existsSync(d)) return false;
    try { fs.rmSync(d, { recursive: true, force: true }); return true; } catch (e) { return false; }
  }

  stats() {
    let n = 0, bytes = 0;
    for (const s of this.list()) {
      n++;
      bytes += (s.files || 0);
    }
    return { count: n, dir: this.root };
  }
}

/* =========================================================
   域名真实性探测
   ---------------------------------------------------------
   geosite.js 里曾经只有一句 crawl: !!f.domain —— 域名非空就标
   「可被抓取 就绪」。这是假断言：填了域名 ≠ 站点真的能被 AI 引擎抓到。

   这里做真实探测：
     1) dns.lookup        → 域名是否解析出 IP
     2) HTTPS/HTTP HEAD   → 站点是否可达（含重定向、状态码、TLS 耗时）
     3) 抓取线上 GEO 三件套：robots.txt / sitemap.xml / llms.txt
        —— 这才是「可被抓取」的真实依据
   ========================================================= */

function lookup(host, family) {
  return new Promise((resolve) => {
    dns.lookup(host, { family: family, all: false }, (err, addr) => {
      resolve({ addr: err ? '' : addr, code: err ? ((err.code) || 'LOOKUP_FAILED') : '' });
    });
  });
}

function httpOnce(url, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const mod = /^https:/i.test(url) ? https : http;
    let req;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    try {
      req = mod.request(url, {
        method: 'GET',
        timeout: timeoutMs || 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ProFoundBot/1.0; +GEO audit)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      }, (res) => {
        const chunks = [];
        let len = 0;
        res.on('data', (c) => {
          len += c.length;
          if (len <= 65536) chunks.push(c);
        });
        res.on('end', () => {
          done({
            status: res.statusCode,
            location: res.headers.location || '',
            contentType: (res.headers['content-type'] || '').split(';')[0],
            server: res.headers.server || '',
            ms: Date.now() - started,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      });
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} done({ status: 0, error: 'ETIMEDOUT', ms: Date.now() - started }); });
      req.on('error', (e) => done({ status: 0, error: (e && e.code) || 'ERROR', ms: Date.now() - started }));
      req.end();
    } catch (e) {
      done({ status: 0, error: 'REQUEST_FAILED', ms: Date.now() - started });
    }
  });
}

/**
 * 跟随重定向后再判定。
 *
 * 旧实现只发一次 GET、把 302 也算「已上线」，于是「401 登录墙 / 预览鉴权链接」
 * 会被误判成「域名上线了，只是没放 GEO 文件」—— 这是两件完全不同的事，
 * 用户按「去部署文件」的提示去补，永远修不好。云平台（EdgeOne Pages 等）
 * 的区域合规预览域正是这种形态。这里跟完重定向链再下结论。
 */
async function fetchFollow(url, timeoutMs, maxHop) {
  const hopMax = maxHop == null ? 5 : maxHop;
  const chain = [];
  let cur = url;
  for (let i = 0; i <= hopMax; i++) {
    const r = await httpOnce(cur, timeoutMs);
    chain.push({ url: cur, status: r.status || 0, location: r.location || '' });
    const redir = [301, 302, 303, 307, 308].indexOf(r.status) >= 0 && r.location;
    if (!redir || i === hopMax) {
      return Object.assign({}, r, { finalUrl: cur, chain, hopCount: i });
    }
    let next;
    try {
      next = new URL(r.location, cur).toString();
    } catch (e) {
      return Object.assign({}, r, { finalUrl: cur, chain, hopCount: i });
    }
    if (!/^https?:/i.test(next)) break;
    cur = next;
  }
  return { status: 0, error: 'TOO_MANY_REDIRECTS', ms: 0, body: '', finalUrl: cur, chain, hopCount: chain.length };
}

/**
 * 探测域名真实状态
 * @param {string} rawDomain
 * @param {object} opts { withFetch:boolean } 是否抓取线上 GEO 三件套
 */
async function probe(rawDomain, opts) {
  const o = opts || {};
  const domain = safeDomain(rawDomain);
  const out = {
    domain,
    input: String(rawDomain || '').trim(),
    ok: false,
    dns: { resolved: false, ipv4: '', ipv6: '', error: '' },
    http: { url: '', scheme: '', status: 0, ms: 0, error: '', redirected: false },
    geo: { robots: null, sitemap: null, llms: null },
    verdict: '',
    level: 'err',
    checkedAt: new Date().toISOString()
  };

  /* 1. 格式判断 */
  const valid = /^(?=.{1,253}$)([a-z0-9\u4e00-\u9fa5]([a-z0-9\u4e00-\u9fa5-]{0,61}[a-z0-9\u4e00-\u9fa5])?\.)+[a-z\u4e00-\u9fa5]{2,}$/i.test(domain);
  if (!valid) {
    out.verdict = '域名格式不正确，无法作为站点地址使用';
    out.level = 'err';
    return out;
  }

  /* 2. DNS */
  let lastCode = '';
  try {
    const v4 = await lookup(domain, 4);
    if (v4.addr) out.dns.ipv4 = v4.addr; else lastCode = v4.code;
    if (!v4.addr) {
      const v6 = await lookup(domain, 6);
      if (v6.addr) out.dns.ipv6 = v6.addr; else lastCode = lastCode || v6.code;
    }
    out.dns.resolved = !!(out.dns.ipv4 || out.dns.ipv6);
  } catch (e) {
    lastCode = (e && e.code) || 'LOOKUP_FAILED';
  }
  out.dns.error = out.dns.resolved ? '' : (lastCode || 'ENOTFOUND');
  if (!out.dns.resolved) {
    out.verdict = `域名未解析（${out.dns.error}）：DNS 里还没有 A/AAAA 记录，任何引擎都抓不到`;
    out.level = 'err';
    return out;
  }

  /* 3. HTTPS 优先，失败回落 HTTP；跟随重定向后再判定 */
  const schemes = ['https', 'http'];
  for (const scheme of schemes) {
    const url = scheme + '://' + domain + '/';
    const r = await fetchFollow(url, 9000, 5);
    out.http = {
      url, scheme, status: r.status || 0, ms: r.ms || 0,
      error: r.error || '',
      redirected: (r.hopCount || 0) > 0,
      finalUrl: r.finalUrl || url,
      redirectChain: r.chain || [],
      contentType: r.contentType || '', server: r.server || ''
    };
    if (r.status >= 200 && r.status < 400) { out.ok = true; break; }
    if (r.status === 401) { out.http.guard = 'auth'; break; }
    if (r.status === 403) { out.http.guard = 'waf'; out.http.forbidden = true; break; }
  }

  if (!out.ok) {
    const ip = out.dns.ipv4 || out.dns.ipv6;
    const fin = out.http.finalUrl && out.http.finalUrl !== out.http.url
      ? `（重定向至 ${out.http.finalUrl}）` : '';
    if (out.http.status === 401) {
      out.verdict = `域名解析到 ${ip}，但站点返回 401${fin} —— 这是「需要登录 / 预览鉴权」的地址，公网匿名访问被拦，AI 引擎同样抓不到。请换用可匿名访问的公开域名`;
      out.level = 'err';
    } else if (out.http.status === 403) {
      out.verdict = `域名已解析到 ${ip}，但站点返回 403${fin} —— 服务器拒绝访问，需检查 Web 服务或 WAF 配置`;
      out.level = 'warn';
    } else if (out.http.status === 404) {
      out.verdict = `域名解析到 ${ip}，站点返回 404 —— 域名已通，但根路径没有 index.html。静态托管桶是空的，或文件传到了子目录（应传到根目录 /）`;
      out.level = 'warn';
    } else if (out.http.error === 'ETIMEDOUT') {
      out.verdict = `域名解析到 ${ip}，但连接超时 —— 80/443 端口未放通，或服务器未启动`;
      out.level = 'warn';
    } else if (out.http.error === 'ECONNREFUSED') {
      out.verdict = `域名解析到 ${ip}，但连接被拒绝 —— 没有 Web 服务在监听`;
      out.level = 'warn';
    } else if (out.http.error === 'CERT_HAS_EXPIRED' || /CERT|SSL|TLS/i.test(out.http.error || '')) {
      out.verdict = `域名可达但 TLS 证书异常（${out.http.error}）—— AI 引擎会直接放弃抓取`;
      out.level = 'warn';
    } else {
      out.verdict = `域名已解析但站点不可达（HTTP ${out.http.status || out.http.error || '未知'}）`;
      out.level = 'warn';
    }
    return out;
  }

  /* 4. 抓取线上 GEO 三件套 —— 这是「可被抓取」的真实证据 */
  if (o.withFetch !== false) {
    const targets = [
      ['robots', out.http.scheme + '://' + domain + '/robots.txt', 'robots.txt'],
      ['sitemap', out.http.scheme + '://' + domain + '/sitemap.xml', 'sitemap.xml'],
      ['llms', out.http.scheme + '://' + domain + '/llms.txt', 'llms.txt']
    ];
    for (const [key, url] of targets) {
      const r = await fetchFollow(url, 7000, 3);
      const found = r.status === 200;
      out.geo[key] = {
        present: found,
        status: r.status || 0,
        url,
        finalUrl: r.finalUrl || url,
        bytes: found ? Buffer.byteLength(r.body || '', 'utf8') : 0,
        /* 兜个底：robots 里是否显式放行 GPTBot 等 AI 爬虫 */
        aiAllowed: key === 'robots' && found ? /GPTBot|OAI-SearchBot|ClaudeBot|PerplexityBot|Bytespider/i.test(r.body || '') : null,
        sitemapUrls: key === 'sitemap' && found ? (((r.body || '').match(/<loc>/g) || []).length) : null
      };
    }
  }

  const g = out.geo;
  const hit = [g.robots, g.sitemap, g.llms].filter((x) => x && x.present).length;
  const guarded = [g.robots, g.sitemap, g.llms].filter((x) => x && (x.status === 401 || x.status === 403)).length;
  if (hit === 0 && guarded === 3) {
    out.verdict = `站点首页可以打开，但 robots / sitemap / llms 三项都返回 ${g.robots.status} —— 整站处于访问控制之下，AI 引擎抓不到任何内容`;
    out.level = 'err';
    return out;
  }
  if (hit === 3) {
    out.verdict = `域名已上线且有完整 GEO 配置（robots + sitemap + llms.txt）`;
    out.level = 'ok';
  } else if (hit > 0) {
    out.verdict = `域名已上线（HTTP ${out.http.status}），但 GEO 三件套缺 ${3 - hit} 项 —— AI 引擎只能部分理解你的站点`;
    out.level = 'warn';
  } else {
    out.verdict = `域名已上线（HTTP ${out.http.status}），但线上没有 robots.txt / sitemap.xml / llms.txt —— 生成后需部署这些文件才能真正被抓取`;
    out.level = 'warn';
  }
  return out;
}

module.exports = { SiteStore, probe, safeDomain, safeName, mimeOf, MAX_FILES, MAX_TOTAL_BYTES };
