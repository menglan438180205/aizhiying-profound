'use strict';
/* =========================================================
   tenant.js — 租户标识的唯一收敛点（K1）
   ---------------------------------------------------------
   为什么单独一个模块：
   同一个租户 id 会同时出现在四处 —— 会话票 / 请求头 / 任务归属 /
   计费用量。任何一处规则不一致，就会出现「任务属于 A、额度扣在
   default」这种错账，而且很难在日志里看出来。这里把三件事收成一个
   函数：合法长什么样、缺省值是什么、怎么从任务上取。

   规则（格式白名单，不是租户注册表）：
     · 1–64 位，首字符为字母 / 数字 / 中文；
     · 后续允许字母 / 数字 / 中文与 . _ : @ - ；
     · 空值或非法值一律回落 default（票里也没有就按 default 记账）。
   刻意不校验「租户是否已开通」：新租户第一次调用时还没有订阅，
   计费走 grace 放行（只记账不拦截），若在这里拒绝，第一笔用量就丢了。
   ========================================================= */

const DEFAULT = 'default';
const MAX_LEN = 64;
/* 允许中文：客户名直接当租户 id 是常见做法，不必强制改成拼音 */
const RE = /^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9._:@\-\u4e00-\u9fa5]{0,63}$/;
/* 非字符串键：这些值一旦当对象键会污染原型链 */
const RESERVED = ['__proto__', 'prototype', 'constructor'];

/** 是否是合法租户标识（不含空值与缺省回落） */
function valid(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.length > MAX_LEN) return false;
  if (RESERVED.indexOf(s) > -1) return false;
  return RE.test(s);
}

/**
 * 归一化租户标识：合法原样返回，非法/空回落 fallback（默认 default）。
 * 传 fallback='' 可用于「非法就拒绝」的场景（见 billing.charge）。
 */
function norm(v, fallback) {
  const fb = fallback === undefined ? DEFAULT : String(fallback || '');
  const s = String(v == null ? '' : v).trim();
  return valid(s) ? s : fb;
}

/** 从任务记录取归属租户；老任务没有 tenant 字段时按 default */
function ofTask(t) {
  return norm(t && t.tenant);
}

/**
 * 存量任务补租户（迁移，幂等）：只给「缺失/空」的记录补 default，
 * 已有值一律不动；格式非法的单独计数返回，交给人工确认（不静默改归属）。
 * @returns {{filled:number, invalid:number, byTable:Object}}
 */
function backfillTasks(store) {
  const out = { filled: 0, invalid: 0, byTable: {} };
  ['collect_tasks', 'geo_tasks'].forEach(function (name) {
    const rows = (store && store.data && store.data[name]) || [];
    let n = 0;
    let bad = 0;
    rows.forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      if (r.tenant == null || String(r.tenant).trim() === '') {
        r.tenant = DEFAULT;
        n++;
      } else if (!valid(r.tenant)) {
        bad++;
      }
    });
    if (n && typeof store.save === 'function') store.save(true, name);
    out.filled += n;
    out.invalid += bad;
    out.byTable[name] = { filled: n, invalid: bad };
  });
  out.total = out.filled;
  return out;
}

module.exports = { DEFAULT, MAX_LEN, valid, norm, ofTask, backfillTasks };
