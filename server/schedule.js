'use strict';
/* =========================================================
   schedule.js — 零依赖「计划时间」工具
   ---------------------------------------------------------
   提供两套并存的排期语义，供采集调度等后台任务使用：

     1) 间隔式   every: '15m' | '30m' | '1h' | '6h' | '24h'
                        | 'realtime'(1 分钟) | 'daily2'(12 小时)
                        | '600'（纯数字＝秒）
     2) 计划式   cron:  标准 5 段表达式（分 时 日 月 周），如「每 15 分钟」

   全部是纯函数，不持有状态、不读时钟（必须显式传入基准时间），
   因此可以在测试里直接断言「下一次触发时刻」。

   cron 支持的写法：
     *           任意值
     5           单值
     1-5         区间
     星斜杠 10   步长（形如「星号 斜杠 10」，即每 10 个单位）
     1,15,30     枚举
     1-20/3      区间 + 步长
     mon|jan     三个字母的英文简写（周 / 月）
   日/周的「或」语义遵循 POSIX cron：
     两者都被限定时取并集，只有一个被限定时以它为准。
   ========================================================= */

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/* 单位 → 毫秒。同时接受中英文别名，避免调用方各写一套。 */
const UNIT_MS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, 秒: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000, 分: 60000, 分钟: 60000,
  h: 3600000, hr: 3600000, hour: 3600000, hours: 3600000, 时: 3600000, 小时: 3600000,
  d: 86400000, day: 86400000, days: 86400000, 天: 86400000
};

/* 前端与 geo 层已在用的语义化档位，这里保持一致，避免两套词汇 */
const PRESETS = {
  realtime: 60000,
  '10m': 600000,
  '15m': 900000,
  '30m': 1800000,
  '1h': 3600000,
  '6h': 21600000,
  '12h': 43200000,
  daily2: 43200000,
  '24h': 86400000
};

const EVERY_KEYS = ['realtime', '10m', '15m', '30m', '1h', '6h', '12h', '24h', 'daily2'];
const MIN_EVERY_MS = 30000;          /* 后台任务最短 30 秒，防止误配把上游打爆 */

/** 把 '15m' / '600' / '2h' 这类写法换算成毫秒；无法识别返回 0 */
function everyMs(spec) {
  if (spec == null) return 0;
  if (typeof spec === 'number') return spec > 0 ? Math.round(spec) : 0;
  let s = String(spec).trim().toLowerCase();
  if (!s) return 0;
  if (PRESETS[s] != null) return PRESETS[s];
  /* 纯数字：沿用 cron 语境下「秒」的习惯 */
  if (/^\d+$/.test(s)) return Math.round(Number(s) * 1000);
  const m = /^(\d+(?:\.\d+)?)\s*([a-z\u4e00-\u9fa5]*)$/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = UNIT_MS[m[2]] != null ? UNIT_MS[m[2]] : null;
  if (!isFinite(n) || n <= 0 || unit == null) return 0;
  return Math.round(n * unit);
}

/** 毫秒 → 中文可读（用于日志与界面提示） */
function describeEvery(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return '未排期';
  if (n % 86400000 === 0) return '每 ' + (n / 86400000) + ' 天';
  if (n % 3600000 === 0) return '每 ' + (n / 3600000) + ' 小时';
  if (n % 60000 === 0) return '每 ' + (n / 60000) + ' 分钟';
  return '每 ' + Math.round(n / 1000) + ' 秒';
}

/* ---------------- cron ---------------- */

function nameToNum(token, names) {
  const i = names.indexOf(String(token).toLowerCase());
  return i < 0 ? null : i;
}

/**
 * 展开单个 cron 字段为取值集合。
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @param {string[]} [names] 允许的英文简写（周 / 月），按 min 起始下标对齐
 * @param {number} [wrap]    允许的「同义最大值」映射，如周日 7 → 0
 */
function expandField(field, min, max, names, wrap) {
  const out = new Set();
  const parts = String(field).split(',');
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;

    let stepStr = null;
    let body = part;
    const slash = part.indexOf('/');
    if (slash > -1) {
      body = part.slice(0, slash);
      stepStr = part.slice(slash + 1);
    }
    const step = stepStr == null ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step <= 0) {
      throw Object.assign(new Error('cron 步长非法：「' + part + '」'), { code: 'CRON_BAD_STEP' });
    }

    const pick = (tok) => {
      const t = String(tok).trim();
      if (/^-?\d+$/.test(t)) return Number(t);
      const n = names ? nameToNum(t, names) : null;
      if (n == null) throw Object.assign(new Error('cron 取值非法：「' + t + '」'), { code: 'CRON_BAD_VALUE' });
      return min + n;
    };

    let lo, hi;
    if (body === '*' || body === '?' || body === '') {
      lo = min; hi = max;
    } else if (body.indexOf('-') > 0) {
      const [a, b] = body.split('-');
      lo = pick(a); hi = pick(b);
    } else {
      lo = pick(body);
      hi = (stepStr == null) ? lo : max;
    }
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    if (lo < min || hi > max + (wrap || 0)) {
      throw Object.assign(new Error('cron 取值越界：「' + part + '」（允许 ' + min + '-' + max + '）'), { code: 'CRON_RANGE' });
    }
    for (let v = lo; v <= hi; v += step) out.add(wrap != null && v === max + 1 ? min : v);
  }
  if (!out.size) throw Object.assign(new Error('cron 字段为空'), { code: 'CRON_EMPTY' });
  return out;
}

/**
 * 解析 5 段 cron 表达式。
 * @returns {{minute:Set<number>,hour:Set<number>,dom:Set<number>,month:Set<number>,dow:Set<number>,
 *            domRestricted:boolean,dowRestricted:boolean,raw:string}}
 */
function parseCron(expr) {
  const raw = String(expr == null ? '' : expr).trim();
  const fields = raw.split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    throw Object.assign(new Error('cron 需要 5 段（分 时 日 月 周），当前 ' + fields.length + ' 段：' + raw),
      { code: 'CRON_FIELDS' });
  }
  const minute = expandField(fields[0], 0, 59);
  const hour = expandField(fields[1], 0, 23);
  const dom = expandField(fields[2], 1, 31);
  const month = expandField(fields[3], 1, 12, MONTH_NAMES);
  /* 周日既可写 0 也可写 7，这里统一折叠到 0 */
  const dow = expandField(fields[4], 0, 6, DOW_NAMES, 1);
  return {
    minute, hour, dom, month, dow,
    domRestricted: fields[2].trim() !== '*' && fields[2].trim() !== '?',
    dowRestricted: fields[4].trim() !== '*' && fields[4].trim() !== '?',
    raw
  };
}

function dayMatches(p, dom, dow) {
  const dm = p.dom.has(dom);
  const dw = p.dow.has(dow);
  if (p.domRestricted && p.dowRestricted) return dm || dw;
  if (p.domRestricted) return dm;
  if (p.dowRestricted) return dw;
  return true;
}

const MAX_DAYS_AHEAD = 1500;   /* ≈ 4 年；闰年 2/29 + 复杂周组合足够，同时避免永不匹配时死循环 */

/**
 * 推算 from 之后的下一次触发时刻（严格大于 from）。
 * @param {string|object} exprOrParsed
 * @param {number} [fromMs]
 * @returns {number} 毫秒时间戳；4 年内无解返回 0
 */
function nextCron(exprOrParsed, fromMs) {
  const p = typeof exprOrParsed === 'string' ? parseCron(exprOrParsed) : exprOrParsed;
  const from = Number(fromMs == null ? Date.now() : fromMs);

  /* 从下一分钟整点开始找 */
  const base = new Date(from);
  base.setSeconds(0, 0);
  let cursor = new Date(base.getTime() + 60000);

  for (let i = 0; i < MAX_DAYS_AHEAD; i++) {
    const mo = cursor.getMonth() + 1;
    const dom = cursor.getDate();
    const dow = cursor.getDay();
    if (!p.month.has(mo) || !dayMatches(p, dom, dow)) {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0, 0);
      continue;
    }
    const startH = cursor.getHours();
    const startM = cursor.getMinutes();
    for (let h = startH; h < 24; h++) {
      if (!p.hour.has(h)) continue;
      const m0 = (h === startH) ? startM : 0;
      for (let m = m0; m < 60; m++) {
        if (!p.minute.has(m)) continue;
        const cand = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), h, m, 0, 0).getTime();
        if (cand > from) return cand;
      }
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0, 0);
  }
  return 0;
}

/** cron → 中文描述（覆盖常见形态，其余给出「分/时」原始集合） */
function describeCron(expr) {
  let p;
  try { p = parseCron(expr); } catch (e) { return String(expr || ''); }
  const list = (set) => [...set].sort((a, b) => a - b);
  const mins = list(p.minute), hours = list(p.hour);

  /* 时间部分 */
  let time;
  const hourStep = hourStepOf(hours);
  if (mins.length === 60 && hours.length === 24) time = '每分钟';
  else if (hours.length === 24) time = '每小时的 ' + mins.map(pad).join('/') + ' 分';
  else if (mins.length === 1 && hourStep > 1) time = '每 ' + hourStep + ' 小时（第 ' + pad(mins[0]) + ' 分）';
  else if (mins.length === 1 && hours.length === 1) time = pad(hours[0]) + ':' + pad(mins[0]);
  else if (mins.length === 1) time = hours.map(pad).join('/') + ' 点 ' + pad(mins[0]) + ' 分';
  else time = '时 ' + hours.join('/') + ' · 分 ' + mins.join('/');

  /* 日期部分 */
  let day = '';
  if (p.domRestricted) day = '每月 ' + list(p.dom).join('/') + ' 号';
  if (p.dowRestricted) {
    const w = '每周' + list(p.dow).map((d) => '日一二三四五六'[d]).join('、周');
    day = day ? day + ' 或 ' + w : w;
  }
  if (time === '每分钟') return day ? day + '全天每分钟' : '每分钟';
  if (!day) day = '每天';
  return day + ' ' + time;
}
function pad(s) { return String(s).padStart(2, '0'); }

/** 若小时集合是 0 起、等差的序列则返回步长，否则返回 1 */
function hourStepOf(hours) {
  if (!hours.length) return 1;
  if (hours[0] !== 0) return 1;
  const step = hours.length > 1 ? hours[1] - hours[0] : 0;
  if (step <= 1) return 1;
  for (let i = 0; i < hours.length; i++) if (hours[i] !== i * step) return 1;
  return step;
}

/* ---------------- 统一入口 ---------------- */

/**
 * 计算任务的「下一次执行时刻」。
 * 有 cron 时以 cron 为准（绝对排期），否则按间隔从基准时间顺推。
 * @param {{cron?:string,every?:string|number}} task
 * @param {number} [fromMs]
 * @returns {number} 毫秒时间戳；无法排期返回 0
 */
function nextRun(task, fromMs) {
  const from = Number(fromMs == null ? Date.now() : fromMs);
  if (task && task.cron) {
    try { return nextCron(task.cron, from); } catch (e) { return 0; }
  }
  const ms = everyMs(task && task.every);
  return ms > 0 ? from + ms : 0;
}

/** 校验一个排期描述是否合法，供接口做入参白名单 */
function validateSchedule(spec) {
  const s = spec || {};
  if (s.cron) {
    try {
      const parsed = parseCron(s.cron);
      return { ok: true, kind: 'cron', next: nextCron(parsed, Date.now()), text: describeCron(s.cron) };
    } catch (e) {
      return { ok: false, code: e.code || 'CRON_INVALID', message: (e && e.message) || 'cron 表达式非法' };
    }
  }
  const ms = everyMs(s.every);
  if (!ms) return { ok: false, code: 'EVERY_INVALID', message: '间隔非法，可用：' + EVERY_KEYS.join(' / ') + '，或纯秒数' };
  if (ms < MIN_EVERY_MS) return { ok: false, code: 'EVERY_TOO_SMALL', message: '间隔不得小于 ' + (MIN_EVERY_MS / 1000) + ' 秒' };
  return { ok: true, kind: 'every', ms, next: Date.now() + ms, text: describeEvery(ms) };
}

/** 预览未来 n 次执行时刻（cron 用），便于前端校验表达式 */
function preview(spec, n, fromMs) {
  const out = [];
  const s = spec || {};
  if (!s.cron) {
    const ms = everyMs(s.every);
    if (!ms) return out;
    const from = Number(fromMs == null ? Date.now() : fromMs);
    for (let i = 1; i <= (n || 5); i++) out.push(from + ms * i);
    return out;
  }
  let cur = Number(fromMs == null ? Date.now() : fromMs);
  let parsed;
  try { parsed = parseCron(s.cron); } catch (e) { return out; }
  for (let i = 0; i < (n || 5); i++) {
    const t = nextCron(parsed, cur);
    if (!t) break;
    out.push(t);
    cur = t;
  }
  return out;
}

module.exports = {
  PRESETS, EVERY_KEYS, MIN_EVERY_MS, UNIT_MS,
  everyMs, describeEvery, parseCron, nextCron, describeCron, nextRun, validateSchedule, preview
};
