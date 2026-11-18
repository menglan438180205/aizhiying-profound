'use strict';
/**
 * zip.js — 极简 ZIP 写入器（零依赖，CRC32 + deflate，POSIX 权限位正确）
 *
 * 为什么不用 PowerShell Compress-Archive：
 *   它只写文件条目、不写目录条目，且 external_attr 恒为 0。云平台（EdgeOne Pages /
 *   CloudBase 等）的解压器按目录条目建子目录、按权限位判定文件有效性，遇到这种包会
 *   直接报 "Unzipping error"。本模块按 ZIP 规范显式写入目录条目与 0644/0755 权限位。
 *
 * 用法:
 *   const { buildZip } = require('./zip');
 *   const buf = buildZip([{ path: 'assets/', dir: true }, { path: 'index.html', data: '...' }]);
 */

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/**
 * @param {Array<{path:string, data?:Buffer|string, dir?:boolean, mtime?:Date}>} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const now = new Date();
  const { time, date } = dosTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    let name = String(e.path).replace(/\\/g, '/');
    if (e.dir && !name.endsWith('/')) name += '/';
    const nameBuf = Buffer.from(name, 'utf8');
    const isDir = !!e.dir;
    const src = isDir ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    const method = isDir || src.length === 0 ? 0 : 8;
    const body = method === 8 ? zlib.deflateRawSync(src, { level: 9 }) : src;
    const crc = crc32(src);
    const extAttr = isDir ? 0o040755 * 0x10000 + 0x10 : 0o100644 * 0x10000;
    const ts = e.mtime ? dosTime(e.mtime) : { time, date };

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(ts.time, 10);
    lh.writeUInt16LE(ts.date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(src.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(ts.time, 12);
    ch.writeUInt16LE(ts.date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(src.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(extAttr >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

module.exports = { buildZip, crc32 };
