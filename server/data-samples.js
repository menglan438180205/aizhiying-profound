'use strict';
/* =========================================================
   data-samples.js — 生产系统的「数据结构样例」出口
   ---------------------------------------------------------
   与 demo/dataset.js 的分工：
     demo/dataset.js  → 演示环境的模拟业务数据（有故事、有数字）
     data-samples/*   → 生产环境的数据结构样例（字段定义 + 一条脱敏示例）

   这里只读文件、不写库，生产环境始终可用；不包含任何"看起来像真实客户"
   的演示数据，避免与生产库混淆。
   ========================================================= */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data-samples');
const cache = new Map();

function readJSON(file) {
  if (cache.has(file)) return cache.get(file);
  let v = null;
  try { v = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch (e) { v = null; }
  cache.set(file, v);
  return v;
}

function manifest() {
  return readJSON('index.json') || { entities: [] };
}

function list() {
  const m = manifest();
  return (m.entities || []).map((e) => {
    const doc = readJSON(e.file);
    return Object.assign({}, e, {
      available: !!doc,
      fields: (doc && doc.fields) || {},
      example: (doc && doc.example) || null,
      note: (doc && doc._note) || ''
    });
  });
}

function get(entity) {
  const e = (manifest().entities || []).filter((x) => x.entity === entity)[0];
  if (!e) return null;
  const doc = readJSON(e.file);
  return doc ? Object.assign({}, e, doc) : null;
}

module.exports = { manifest, list, get, DIR };
