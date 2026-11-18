'use strict';
/* =========================================================
   collect/ledger.js — 采集域公共账本
   ---------------------------------------------------------
   背景：评论（collect-comments.js）与点赞（collect-likes.js）是同一类
   「对外写」动作，各自复制了一份 nowIso / dayKey / rand / noteKeyOf /
   todayCount / nextSlot。四份实现里任何一处改了节奏或日限口径，另一处
   就会悄悄跟它不一致 —— 这正是 R4「合并重复」要解决的那类冗余。

   这里只抽「与具体业务无关」的部分：时间、去重键、日计数、排期打点。
   业务闸门（正文近似去重、失败原因、回执字段）仍留在各自模块里。

   约束：
     · 无依赖（不 require store/deviceHub），纯函数 + 只读遍历；
     · 语义与抽取前逐行等价（含「失败不计入日限」这一条）。
   ========================================================= */

function nowIso() { return new Date().toISOString(); }

function dayKey(d) {
  const t = d ? new Date(d) : new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}

function rand(min, max) { return Math.round(min + Math.random() * Math.max(1, max - min)); }

/** 作品去重键：platform|noteId（或 platform|url）；显式带 '|' 的视为已拼好 */
function noteKeyOf(b) {
  const p = String((b && b.platform) || '').toLowerCase();
  const id = String((b && (b.noteKey || b.note_id || b.noteId)) || '').trim();
  const url = String((b && b.url) || '').trim();
  const key = id.indexOf('|') >= 0 ? id : (p + '|' + (id || url));
  return key.slice(0, 200);
}

/** 今日已执行条数：失败的记录不占日限（失败通常是平台侧拒绝，不该惩罚用户） */
function todayCount(rows) {
  const d = dayKey();
  return (rows || []).filter(function (c) {
    return c && c.status !== 'failed' && dayKey(c.createdAt) === d;
  }).length;
}

/** 队列里该类型尚未结束的任务（排期以最后一条为准） */
function pendingJobs(store, kind) {
  return (store.data.collect_jobs || []).filter(function (j) {
    return j && j.kind === kind && (j.status === 'pending' || j.status === 'claimed');
  });
}

/** 下一条可执行时刻：在排队末尾再随机铺开一个间隔；空队列先等 firstDelay */
function nextSlot(store, kind, paceMin, paceMax, firstDelay) {
  const now = Date.now();
  let last = 0;
  pendingJobs(store, kind).forEach(function (j) { last = Math.max(last, Number(j.notBefore || 0)); });
  if (!last) return now + firstDelay;
  return Math.max(now, last) + rand(paceMin, paceMax);
}

function findByKey(rows, key) {
  return (rows || []).filter(function (c) { return c && c.noteKey === key; })[0] || null;
}

module.exports = { nowIso, dayKey, rand, noteKeyOf, todayCount, pendingJobs, nextSlot, findByKey };
