'use strict';
/* =========================================================
   util.js — 服务端共享小工具（单一真相源）
   ---------------------------------------------------------
   把散落在 index.js / sites.js / samples.js 里的同源小函数收口
   到这里，避免：
     · 同一个 mimeOf 在多个模块各写一遍（MIME 表还不完全一致）；
     · samples.js 里 esc 和 fontArg 其实是同一个 Windows 路径转义
       却叫两个名字，且 esc 与 index.js 的 HTML 转义重名易误用。
   ========================================================= */
const path = require('path');

/* MIME 查表：index.js（静态资源托管，含音视频 / .mjs / .bmp）与
   sites.js（站点产物托管，含 .htm / .woff / .xml）的并集，保证
   两边原行为都不回退。 */
const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.xml': 'application/xml',
  '.txt': 'text/plain', '.md': 'text/markdown',
  '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac'
};

function mimeOf(f) {
  return MIME[String(path.extname(f == null ? '' : f)).toLowerCase()] || 'application/octet-stream';
}

/* HTML 转义，用于状态页 / 错误页拼接。与 samples.js 的 Windows
   路径转义（escapeWinPath）不是一回事，名字刻意区分开。 */
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

module.exports = { MIME, mimeOf, escHtml };
