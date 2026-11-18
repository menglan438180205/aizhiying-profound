'use strict';
/* =========================================================
   multipart.js — 零依赖 multipart/form-data 解析
   仅解析到内存缓冲（调用方已做体积上限控制）
   ========================================================= */

const CRLF = Buffer.from('\r\n');

function parseHeaders(text) {
  const h = {};
  text.split('\r\n').forEach((line) => {
    const i = line.indexOf(':');
    if (i < 0) return;
    h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  });
  return h;
}

function parseDisposition(v) {
  const out = { name: '', filename: '', fields: {} };
  if (!v) return out;
  const segs = v.split(';');
  out.type = segs.shift().trim();
  segs.forEach((s) => {
    const i = s.indexOf('=');
    if (i < 0) return;
    const k = s.slice(0, i).trim().toLowerCase();
    let val = s.slice(i + 1).trim();
    if (val[0] === '"' && val[val.length - 1] === '"') val = val.slice(1, -1);
    out.fields[k] = val;
    if (k === 'name') out.name = val;
    if (k === 'filename') out.filename = val;
  });
  return out;
}

/**
 * @param {Buffer} buf 完整请求体
 * @param {string} boundary
 * @returns {Array<{name, filename, contentType, data:Buffer}>}
 */
function parse(buf, boundary) {
  const parts = [];
  if (!buf || !buf.length || !boundary) return parts;
  const delim = Buffer.from('--' + boundary);
  const sep = Buffer.from('\r\n--' + boundary);
  let start = buf.indexOf(delim);
  if (start < 0) return parts;
  start += delim.length;
  // 跳过第一个 boundary 后的 CRLF
  if (buf.slice(start, start + 2).equals(CRLF)) start += 2;

  while (start < buf.length) {
    let next = buf.indexOf(sep, start);
    let end = next < 0 ? buf.length : next;
    const chunk = buf.slice(start, end);
    const hEnd = chunk.indexOf('\r\n\r\n');
    if (hEnd > 0) {
      const headers = parseHeaders(chunk.slice(0, hEnd).toString('utf8'));
      const disp = parseDisposition(headers['content-disposition'] || '');
      // 数据区尾部可能带一个 CRLF（属于分隔符的一部分）
      let data = chunk.slice(hEnd + 4);
      if (data.length >= 2 && data.slice(data.length - 2).equals(CRLF)) data = data.slice(0, data.length - 2);
      parts.push({
        name: disp.name || disp.fields.name || '',
        filename: disp.filename || '',
        contentType: headers['content-type'] || '',
        data
      });
    }
    if (next < 0) break;
    start = next + sep.length;
    if (buf.slice(start, start + 2).equals(CRLF)) start += 2;
    else if (buf.slice(start, start + 2).toString('utf8') === '--') break; // 结束边界
  }
  return parts;
}

function field(parts, name) {
  const p = parts.filter((x) => x.name === name && !x.filename)[0];
  return p ? p.data.toString('utf8') : '';
}

function files(parts, name) {
  return parts.filter((x) => x.name === name && x.filename);
}

/** 解析 data URL（JSON 上传通道用） */
function dataUrl(buf) {
  const s = String(buf || '');
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(s);
  if (!m) return null;
  const isB64 = !!m[2];
  const data = isB64 ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return { contentType: m[1] || 'application/octet-stream', data };
}

module.exports = { parse, field, files, dataUrl };
