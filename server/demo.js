'use strict';
/* =========================================================
   demo.js — 演示环境开关与数据出口
   ---------------------------------------------------------
   规则：
     · DEMO_MODE=1        → 演示环境：允许本地模拟采集/GEO、写入 demo 库、
                            下发 /v1/demo/dataset
     · DEMO_MODE=0        → 生产环境：以上能力全部关闭
     · 未设置            → NODE_ENV=production 视为 0，其余视为 1

   隔离手段：
     · 演示数据落在 DATA_DIR/demo/ 下（独立 db.json / assets / out），
       生产库 DATA_DIR/db.json 不会被演示数据污染
     · ALLOW_LOCAL_COLLECT / ALLOW_LOCAL_GEO 只在演示环境生效
   ========================================================= */

const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '.data');

function isProduction() {
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

function truthy(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** 演示模式是否启用（config.enforce() 在生产下会强制置 0） */
function enabled() {
  const v = String(process.env.DEMO_MODE == null ? '' : process.env.DEMO_MODE).trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  return !isProduction();
}

/** 演示数据根目录：启用时与生产库完全隔离 */
function root() {
  return enabled() ? path.join(DATA_DIR, 'demo') : DATA_DIR;
}

/** 演示数据集（懒加载，避免生产进程 require 演示数据） */
function dataset() {
  if (!enabled()) return null;
  return require('../demo/dataset').build();
}

/** 本地模拟采集是否可用：必须同时处于演示环境且显式开启 */
function allowLocalCollect() {
  return enabled() && truthy(process.env.ALLOW_LOCAL_COLLECT);
}

/** 本地模拟 GEO 是否可用：同上 */
function allowLocalGeo() {
  return enabled() && truthy(process.env.ALLOW_LOCAL_GEO);
}

/** 演示库信息（用于启动横幅与 /v1/health） */
function info() {
  const on = enabled();
  return {
    enabled: on,
    mode: on ? 'demo' : 'production',
    dataRoot: on ? path.join(DATA_DIR, 'demo') : DATA_DIR,
    localCollect: allowLocalCollect(),
    localGeo: allowLocalGeo(),
    seeded: truthy(process.env.DEMO_NO_SEED) ? false : on
  };
}

function ensureRoot() {
  try { fs.mkdirSync(root(), { recursive: true }); } catch (e) {}
  return root();
}

module.exports = { enabled, root, dataset, allowLocalCollect, allowLocalGeo, info, ensureRoot, isProduction };
