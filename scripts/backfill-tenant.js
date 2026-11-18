'use strict';
/* =========================================================
   backfill-tenant.js — 存量任务补租户（K1 迁移）
   ---------------------------------------------------------
   背景：K1 之前 collect_tasks / geo_tasks 没有 tenant 字段，
   调度执行时拿不到归属，计量只能全部记到 default。
   服务端启动时已经会自动补一次（server/tenant.js#backfillTasks），
   这个脚本给两个场景用：
     · 部署前先体检：不写盘，只报「多少条缺租户、多少条格式非法」；
     · 需要人工确认后再写：--apply 显式落盘（幂等，可重复执行）。

   用法：
     node scripts/backfill-tenant.js            # 体检（默认，不写盘）
     node scripts/backfill-tenant.js --apply    # 写入 tenant=default
   环境变量：DATA_DIR（与服务端一致；演示模式自动使用 DATA_DIR/demo）
   ========================================================= */

const path = require('path');
const { Store } = require('../server/store');
const tenantMod = require('../server/tenant');
const demo = require('../server/demo');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '.data');
const ROOT = demo.root();
const DB_FILE = path.join(ROOT, 'db.json');
const APPLY = process.argv.indexOf('--apply') > -1;
const TABLES = ['collect_tasks', 'geo_tasks'];

function scan(store) {
  const out = {};
  let missing = 0;
  let invalid = 0;
  TABLES.forEach(function (name) {
    const rows = (store.data && store.data[name]) || [];
    let m = 0;
    let bad = 0;
    rows.forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      if (r.tenant == null || String(r.tenant).trim() === '') { m++; return; }
      if (!tenantMod.valid(r.tenant)) bad++;
    });
    out[name] = { total: rows.length, missing: m, invalid: bad };
    missing += m;
    invalid += bad;
  });
  out._sum = { missing: missing, invalid: invalid };
  return out;
}

function main() {
  console.log('数据目录 : ' + ROOT);
  console.log('模式     : ' + (APPLY ? 'APPLY（写盘）' : 'DRY-RUN（只体检，不写盘）'));

  const store = new Store(DB_FILE);
  const before = scan(store);

  const rows = [];
  TABLES.forEach(function (name) {
    const s = before[name];
    rows.push('  ' + name.padEnd(14) + ' 共 ' + String(s.total).padStart(5)
      + ' 条 · 缺租户 ' + String(s.missing).padStart(4)
      + ' 条 · 非法 ' + String(s.invalid).padStart(3) + ' 条');
  });
  console.log('现状：\n' + rows.join('\n'));

  if (!before._sum.missing && !before._sum.invalid) {
    console.log('无需迁移：所有任务都有合法 tenant。');
    return 0;
  }

  if (!APPLY) {
    console.log('体检完成：以上缺失项可用 `--apply` 写入 tenant=default（不会改动已有值）。');
    return 0;
  }

  const r = tenantMod.backfillTasks(store);
  const after = scan(store);
  console.log('已补写：collect_tasks ' + r.byTable.collect_tasks.filled
    + ' 条 · geo_tasks ' + r.byTable.geo_tasks.filled + ' 条');
  if (r.invalid) {
    console.log('注意：仍有 ' + r.invalid + ' 条 tenant 格式非法（已保留原值，请人工改成合法租户 id）');
  }
  console.log('复核：缺租户 ' + (after._sum.missing) + ' 条 · 非法 ' + after._sum.invalid + ' 条');
  return r.invalid ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error('迁移失败：' + ((e && e.message) || e));
  process.exitCode = 2;
}
