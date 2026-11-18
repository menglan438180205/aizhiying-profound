'use strict';
/**
 * publish.js — 站点产物导出（供 CLI 与自动部署共用）
 *
 * 站点生成时会把品牌域名写死进 robots / sitemap / llms 与页面绝对链接，
 * 换托管域名后必须整体改写，否则 sitemap 会指向一个已经不存在的域。
 *
 * 这里是唯一的导出实现：`scripts/retarget-site.js`（命令行）与
 * `server/deploy.js`（一键部署）都走这一份，避免两处逻辑漂移。
 */

const fs = require('fs');
const path = require('path');
const { buildZip } = require('./zip');

const ROOT = path.resolve(__dirname, '..');

const TEXT_EXT = new Set([
  '.html', '.htm', '.txt', '.xml', '.css', '.js', '.json', '.md',
  '.svg', '.webmanifest', '.yml', '.yaml'
]);

function slugify(s) {
  return String(s || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'site';
}

function cleanDomain(s) {
  return String(s || '')
    .trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

function findSite(id) {
  const cands = [
    path.join(ROOT, '.data', 'demo', 'sites', id),
    path.join(ROOT, '.data', 'sites', id)
  ];
  for (const d of cands) {
    if (fs.existsSync(path.join(d, 'files'))) return d;
  }
  return null;
}

function walk(dir, base, out) {
  base = base || dir;
  out = out || [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/**
 * 收集为 zip 条目：显式目录条目 + 0644 权限 + index.html 排首位
 * （PowerShell Compress-Archive 缺这两样，云平台解压会失败）
 */
function buildEntries(rootDir, prefix) {
  const files = walk(rootDir);
  const pre = prefix ? prefix.replace(/\/+$/, '') + '/' : '';
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
  }

  const entries = [];
  if (pre) entries.push({ path: pre, dir: true });
  for (const d of [...dirs].sort()) entries.push({ path: pre + d, dir: true });

  const ordered = files.slice().sort((a, b) => {
    const rank = (x) => (x === 'index.html' ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  for (const f of ordered) {
    entries.push({ path: pre + f, data: fs.readFileSync(path.join(rootDir, f)) });
  }
  return entries;
}

function writeZip(srcDir, zipPath, prefix) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const buf = buildZip(buildEntries(srcDir, prefix));
  fs.writeFileSync(zipPath, buf);
  return buf.length;
}

/**
 * 把站点产物按目标域名重写并落到 .build/publish/<slug>/
 * @param {object} o { siteId, targetDomain, zip, outDir }
 * @returns {{dir:string, files:number, hits:number, changed:string[], brand:string, oldDomain:string, slug:string, files_?:string[]}}
 */
function exportSite(o) {
  const siteId = String(o.siteId || '').trim();
  const target = cleanDomain(o.targetDomain);
  if (!siteId) {
    const e = new Error('缺少 siteId');
    e.code = 'NO_SITE';
    throw e;
  }
  if (!target) {
    const e = new Error('缺少目标域名');
    e.code = 'NO_DOMAIN';
    throw e;
  }

  const src = findSite(siteId);
  if (!src) {
    const e = new Error('找不到站点 ' + siteId + '（已查 .data/demo/sites 与 .data/sites）');
    e.code = 'SITE_NOT_FOUND';
    throw e;
  }

  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(src, 'meta.json'), 'utf8')); } catch (_) { /* 缺失不阻断 */ }

  const oldDomain = cleanDomain(meta.domain || '');
  const brand = meta.brand || siteId;
  const slug = slugify(brand) || siteId;
  const outDir = String(o.outDir || path.join(ROOT, '.build', 'publish', slug));

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const files = walk(path.join(src, 'files'));
  let hits = 0;
  const changed = [];

  for (const rel of files) {
    const from = path.join(src, 'files', rel);
    const to = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });

    if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) {
      fs.copyFileSync(from, to);
      continue;
    }
    let text = fs.readFileSync(from, 'utf8');
    if (oldDomain) {
      const before = text;
      text = text.split(oldDomain).join(target);
      if (text !== before) {
        const n = before.split(oldDomain).length - 1;
        hits += n;
        changed.push(rel + ' (' + n + ')');
      }
    }
    fs.writeFileSync(to, text, 'utf8');
  }

  const out = {
    siteId, dir: outDir, slug, brand,
    oldDomain, domain: target,
    files: files.length, hits, changed,
    fileList: files, zips: null, meta
  };

  if (o.zip !== false) {
    const base = slug + '-site';
    const flat = path.join(ROOT, 'release', base + '.zip');
    const wrapped = path.join(ROOT, 'release', base + '-folder.zip');
    out.zips = {
      flat: { path: flat, bytes: writeZip(outDir, flat, '') },
      wrapped: { path: wrapped, bytes: writeZip(outDir, wrapped, 'site') }
    };
  }

  return out;
}

module.exports = {
  exportSite, findSite, cleanDomain, slugify, walk,
  buildEntries, writeZip, TEXT_EXT
};
