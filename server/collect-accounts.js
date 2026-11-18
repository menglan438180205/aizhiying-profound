'use strict';
/* =========================================================
   collect-accounts.js — 采集账号（身份档案）
   ---------------------------------------------------------
   为什么需要这一层：
     在此之前，「哪个号在采」完全由环境变量 COLLECT_CRAWLER_URL 决定，
     页面上看不见、换号要动服务器。账号层把「服务地址」和「登录身份」
     拆开：通道回答「走哪条路」，账号回答「用谁的号」。

   一个账号记录什么：
     platform     douyin / xhs / kuaishou / sph
     nickname     展示用昵称（平台上的名字）
     profileDir   浏览器配置目录（MediaCrawler 的 user_data_dir），
                  登录态就持久化在这里；可以是绝对路径，也可以是
                  相对于 MC_BROWSER_ROOT 的子目录名
     quotaPerHour 每小时最多采多少条（超了调度器直接跳过，不硬跑）
     status       active / expired / disabled —— 只有人知道号还活着没，
                  所以状态由人改；探测只提供证据（checkDetail），不擅自改状态

   探测的诚实边界：
     profileDir 在服务端本机 → 文件级探测（目录是否存在、Cookies 最后写入时间）
     不在本机（采集机在别的电脑）→ 返回 unknown 并明说「需在采集机上确认」，
     绝不用「文件不存在」冒充「账号已失效」。
   ========================================================= */

const fs = require('fs');
const path = require('path');

const PLATFORMS = ['douyin', 'xhs', 'kuaishou', 'sph'];
const STATUS = ['active', 'expired', 'disabled'];
const PLATFORM_LABEL = { douyin: '抖音', xhs: '小红书', kuaishou: '快手', sph: '视频号' };

function trim(s, n) { return String(s == null ? '' : s).trim().slice(0, n || 200); }

/** 浏览器配置根目录：可以不配，配了就让 profileDir 支持相对路径 */
function browserRoot() {
  return String(process.env.MC_BROWSER_ROOT || '').trim();
}

function resolveProfileDir(profileDir) {
  const raw = trim(profileDir, 240);
  if (!raw) return '';
  /* 绝对路径直接用（Windows 盘符 / UNC / POSIX 三种都认） */
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.indexOf('\\\\') === 0 || raw[0] === '/') return raw;
  const root = browserRoot();
  return root ? path.join(root, raw) : '';
}

/**
 * 探测登录态。只做「本机可验证」的事，不能验证就如实说 unknown。
 * @returns {{level:'ok'|'stale'|'missing'|'unknown', message:string, cookieAt:string, dir:string}}
 */
function probeProfile(profileDir) {
  const now = new Date().toISOString();
  const raw = trim(profileDir, 240);
  if (!raw) {
    return { level: 'unknown', message: '未填写浏览器配置目录，无法探测', cookieAt: '', dir: '', checkedAt: now };
  }
  const dir = resolveProfileDir(raw);
  if (!dir) {
    return {
      level: 'unknown',
      message: '登录态保存在本机桥的 browser_data 目录；服务端只做记录，需在本机桥确认',
      cookieAt: '', dir: '', checkedAt: now
    };
  }
  let st = null;
  try { st = fs.statSync(dir); } catch (e) {
    return { level: 'missing', message: '本机找不到该配置目录（若采集机在另一台电脑，请在那台上确认）', cookieAt: '', dir, checkedAt: now };
  }
  if (!st.isDirectory()) {
    return { level: 'missing', message: '该路径不是目录', cookieAt: '', dir, checkedAt: now };
  }
  /* Chromium 系 Cookies 的两个可能位置 */
  const cands = [
    path.join(dir, 'Default', 'Network', 'Cookies'),
    path.join(dir, 'Default', 'Cookies'),
    path.join(dir, 'Cookies')
  ];
  let cookieAt = 0;
  let hit = '';
  for (const c of cands) {
    try {
      const s = fs.statSync(c);
      if (s.mtimeMs > cookieAt) { cookieAt = s.mtimeMs; hit = c; }
    } catch (e) {}
  }
  if (!cookieAt) {
    return { level: 'unknown', message: '配置目录存在，但没找到 Cookies 文件（可能尚未扫码登录）', cookieAt: '', dir, checkedAt: now };
  }
  const days = (Date.now() - cookieAt) / 86400000;
  const iso = new Date(cookieAt).toISOString();
  if (days > 7) {
    return {
      level: 'stale',
      message: '登录态 ' + Math.round(days) + ' 天没更新，平台多半已过期，建议重新扫码',
      cookieAt: iso, dir: dir + (hit ? ' / ' + path.basename(hit) : ''), checkedAt: now
    };
  }
  return {
    level: 'ok',
    message: '登录态 ' + Math.round(days * 24) + ' 小时前仍有写入，本机可读到 Cookies',
    cookieAt: iso, dir, checkedAt: now
  };
}

/**
 * @param {object} store  store 实例
 * @param {{now?:Function}} [opt]
 */
function createAccounts(store, opt) {
  const o = opt || {};

  function list() { return store.data.collect_accounts || []; }
  function get(id) { return list().filter((a) => a.id === id)[0] || null; }
  function byPlatform(p) { return list().filter((a) => !p || a.platform === p); }

  /** 平台 + 昵称 唯一：同一个号别建两遍，否则配额会被拆散 */
  function duplicate(platform, nickname, skipId) {
    return list().filter((a) => a.platform === platform
      && a.nickname === nickname && a.id !== skipId)[0] || null;
  }

  function add(input) {
    const s = input || {};
    const platform = PLATFORMS.indexOf(String(s.platform || '')) > -1 ? String(s.platform) : '';
    if (!platform) return { ok: false, code: 'PLATFORM_INVALID', message: '请选择平台' };
    const nickname = trim(s.nickname, 30);
    if (!nickname) return { ok: false, code: 'NICKNAME_REQUIRED', message: '请填写账号昵称（平台上的名字）' };
    const dup = duplicate(platform, nickname);
    if (dup) return { ok: false, code: 'ACCOUNT_EXISTS', message: '该平台下已有同名账号', accountId: dup.id };
    const acc = {
      id: store.nextId('ca'),
      platform: platform,
      nickname: nickname,
      profileDir: trim(s.profileDir, 240),
      quotaPerHour: Math.max(1, Math.min(500, Number(s.quotaPerHour || 30))),
      status: 'active',
      note: trim(s.note, 120),
      /* 为 UI 自动化评论预留：显式开启或配了小时额度才视为允许 */
      allowComment: s.allowComment === true || Number(s.commentQuotaPerHour) > 0,
      commentQuotaPerHour: Math.max(0, Math.min(100, Number(s.commentQuotaPerHour) || 0)),
      lastUsedAt: '',
      lastCheckAt: '',
      checkDetail: '',
      owner: 'default',
      createdAt: new Date().toISOString()
    };
    list().unshift(acc);
    store.save(true, 'collect_accounts');
    return { ok: true, account: acc };
  }

  function update(id, patch) {
    const a = get(id);
    if (!a) return null;
    const p = patch || {};
    if (p.nickname != null) {
      const nk = trim(p.nickname, 30);
      if (!nk) return { error: { code: 'NICKNAME_REQUIRED', message: '昵称不能为空' } };
      const dup = duplicate(a.platform, nk, a.id);
      if (dup) return { error: { code: 'ACCOUNT_EXISTS', message: '该平台下已有同名账号' } };
      a.nickname = nk;
    }
    if (p.profileDir != null) a.profileDir = trim(p.profileDir, 240);
    if (p.note != null) a.note = trim(p.note, 120);
    if (p.quotaPerHour != null) a.quotaPerHour = Math.max(1, Math.min(500, Number(p.quotaPerHour) || a.quotaPerHour));
    if (p.status != null && STATUS.indexOf(String(p.status)) > -1) a.status = String(p.status);
    if (p.allowComment != null) a.allowComment = !!p.allowComment;
    if (p.commentQuotaPerHour != null) a.commentQuotaPerHour = Math.max(0, Math.min(100, Number(p.commentQuotaPerHour) || 0));
    store.save(true, 'collect_accounts');
    return a;
  }

  function remove(id) {
    const arr = list();
    const i = arr.findIndex((a) => a.id === id);
    if (i < 0) return false;
    arr.splice(i, 1);
    store.save(true, 'collect_accounts');
    return true;
  }

  /** 探测并把证据写回账号（不改 status —— 状态是人定的） */
  function probe(id) {
    const a = get(id);
    if (!a) return null;
    const r = probeProfile(a.profileDir);
    a.lastCheckAt = r.checkedAt;
    a.checkDetail = r.message;
    a.checkLevel = r.level;
    a.cookieAt = r.cookieAt || '';
    if (r.level === 'ok') a.lastActiveAt = r.cookieAt || a.lastActiveAt || '';
    store.save(true, 'collect_accounts');
    return { account: a, probe: r };
  }

  function touch(id, when) {
    const a = get(id);
    if (!a) return null;
    a.lastUsedAt = when || new Date().toISOString();
    store.save(false, 'collect_accounts');
    return a;
  }

  /** 近 1 小时该账号已采条数（配额判断用；只算真正跑出数据的轮次） */
  function usedLastHour(id, runs) {
    const from = Date.now() - 3600000;
    return (runs || []).filter((r) =>
      r.accountId === id && Date.parse(r.at || 0) >= from && r.status === 'ok')
      .reduce((n, r) => n + (Number(r.fresh) || 0), 0);
  }

  function stats(runs) {
    const arr = list();
    const byPlatform = {};
    arr.forEach((a) => { byPlatform[a.platform] = (byPlatform[a.platform] || 0) + 1; });
    return {
      total: arr.length,
      active: arr.filter((a) => a.status === 'active').length,
      expired: arr.filter((a) => a.status === 'expired').length,
      disabled: arr.filter((a) => a.status === 'disabled').length,
      commentEnabled: arr.filter((a) => a.allowComment).length,
      byPlatform: byPlatform,
      recent: arr.filter((a) => a.lastUsedAt).slice(0, 5).map((a) => ({
        id: a.id, nickname: a.nickname, platform: a.platform, lastUsedAt: a.lastUsedAt
      }))
    };
  }

  /** 给前端/任务表单用：只返回可选（启用中）的账号 */
  function options(platform) {
    return byPlatform(platform).filter((a) => a.status === 'active').map((a) => ({
      id: a.id, platform: a.platform, nickname: a.nickname, quotaPerHour: a.quotaPerHour
    }));
  }

  return {
    PLATFORMS, STATUS, PLATFORM_LABEL,
    list, get, add, update, remove, probe, touch, stats, options,
    usedLastHour, probeProfile, resolveProfileDir
  };
}

module.exports = { createAccounts, probeProfile, resolveProfileDir, PLATFORMS, STATUS, PLATFORM_LABEL };
