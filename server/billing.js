'use strict';
/* =========================================================
   billing.js — 订阅 · 配额 · 钱包 · 订单 · 计量
   ---------------------------------------------------------
   设计原则：
   1) 金额只在服务端算 —— 前端传来的 amount 一律忽略，只认 planId / packId。
   2) 套餐价目表落盘可改（.data/billing-plans.json），改价不用发版。
   3) 支付通道三选一：mock（自测） / manual（人工确认） / wechat（微信支付 v3）。
      生产默认 manual —— 宁可不收钱，也不伪造「支付成功」。
   4) 计量口径：套餐额度优先，用完扣加量包，都不够返回 402，绝不静默失败。
      没有订阅时走 grace（记录但不拦截），避免老客户被突然锁死。
   5) 所有钱相关动作写 ledger（流水），可审计、可对账。
   ========================================================= */

const fs = require('fs');
const path = require('path');
const tenantMod = require('./tenant');   /* K1：租户标识白名单 */

const CYCLE = {
  month:   { id: 'month',   months: 1,  label: '月付' },
  quarter: { id: 'quarter', months: 3,  label: '季付' },
  year:    { id: 'year',    months: 12, label: '年付' }
};

/* -1 = 不限量 */
const DEFAULT_PLANS = [
  {
    id: 'trial', name: '试用版', free: true, days: 14, highlight: false, seats: 1,
    prices: {},
    quota: { leads: 50, minutes: 20, geo: 3 },
    features: ['14 天全功能体验', '50 条线索', '20 分钟 AI 剪辑', '3 次 GEO 检测']
  },
  {
    id: 'quarter', name: '季度版', highlight: false, seats: 1,
    prices: { quarter: 1980 },
    quota: { leads: 500, minutes: 60, geo: 20 },
    features: ['500 条线索 / 月', '60 分钟剪辑 / 月', '20 次 GEO / 月', '1 个微信号席位', '工单支持']
  },
  {
    id: 'basic', name: '基础版', highlight: false, seats: 2,
    prices: { month: 598, year: 5980 },
    quota: { leads: 2000, minutes: 300, geo: 100 },
    features: ['2,000 条线索 / 月', '300 分钟剪辑 / 月', '100 次 GEO / 月', '2 个微信号席位', '5 位 AI 员工', '1v1 客服']
  },
  {
    id: 'standard', name: '标准版', highlight: true, seats: 5,
    prices: { month: 1280, year: 12800 },
    quota: { leads: 10000, minutes: 1000, geo: -1 },
    features: ['10,000 条线索 / 月', '1,000 分钟剪辑 / 月', 'GEO 不限次', '5 个微信号席位', '自动加微全流程', '专属运营顾问']
  },
  {
    id: 'flagship', name: '旗舰版', highlight: false, seats: 20,
    prices: { month: 2980, year: 29800 },
    quota: { leads: -1, minutes: -1, geo: -1 },
    features: ['线索不设上限', '剪辑不限量', 'GEO 不限次', '20 个微信号席位', '专属采集通道', '7×24 客户成功']
  }
];

const DEFAULT_PACKS = [
  { id: 'leads_1000',   name: '线索加量包', kind: 'leads',   qty: 1000, price: 80 },
  { id: 'minutes_100',  name: '剪辑加量包', kind: 'minutes', qty: 100,  price: 60 },
  { id: 'geo_100',      name: 'GEO 加量包', kind: 'geo',     qty: 100,  price: 500 },
  { id: 'seat_1',       name: '微信席位',   kind: 'seats',   qty: 1,    price: 99 }
];

const KIND_LABEL = { leads: '线索', minutes: '剪辑分钟', geo: 'GEO 次数', seats: '微信席位' };

function addMonths(ts, months) {
  const d = new Date(ts);
  const day = d.getDate();
  d.setMonth(d.getMonth() + Number(months || 0));
  /* 1/31 + 1 月会溢出到 3/3，回拨到月末 */
  if (d.getDate() !== day) d.setDate(0);
  return d.getTime();
}
function rid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function num(v, dft) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dft;
}

function loadProviders() {
  const out = {};
  [['mock', './pay/mock'], ['manual', './pay/manual'], ['wechat', './pay/wechatv3']].forEach(function (p) {
    try {
      out[p[0]] = require(p[1]);
    } catch (e) {
      out[p[0]] = {
        id: p[0], broken: true,
        configured: () => false,
        create: () => ({ provider: p[0], status: 'broken', message: '支付模块加载失败：' + (e && e.message) }),
        verifyNotify: () => ({ ok: false, code: 'BROKEN', message: '支付模块加载失败' })
      };
    }
  });
  return out;
}

class Billing {
  constructor(store, opt) {
    this.store = store;
    this.opt = opt || {};
    this.dataRoot = this.opt.dataRoot || path.join(process.cwd(), '.data');
    this.providers = loadProviders();
    this._plansAt = 0;
    this._plans = null;
    this._packs = null;
    this._loadConfig();
    const def = this.opt.provider || process.env.PAY_PROVIDER ||
      (process.env.NODE_ENV === 'production' ? 'manual' : 'mock');
    this.providerId = this.providers[def] ? def : 'manual';
    this.provider = this.providers[this.providerId];
    this.log('info', '计费已加载 · 通道 ' + this.providerId + ' · 套餐 ' + this.plans().length + ' 档');
  }

  log(lv, m) {
    if (process.env.QUIET === '1') return;
    console.log('[billing/' + lv + '] ' + m);
  }

  /* ---------------- 价目表（可落盘覆盖） ---------------- */
  _cfgFile() { return path.join(this.dataRoot, 'billing-plans.json'); }

  _loadConfig() {
    let j = null;
    try {
      const f = this._cfgFile();
      if (fs.existsSync(f)) j = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      this.log('err', '价目表读取失败，回退内置默认：' + (e && e.message));
    }
    this._plans = (j && Array.isArray(j.plans) && j.plans.length) ? j.plans : DEFAULT_PLANS.slice();
    this._packs = (j && Array.isArray(j.packs) && j.packs.length) ? j.packs : DEFAULT_PACKS.slice();
    /* 首次启动把默认价目表落盘，方便用户直接编辑改价 */
    if (!j) this.saveConfig();
    this._plansAt = Date.now();
  }

  /** 把当前价目表写回磁盘（运维可直接改这个文件） */
  saveConfig() {
    try {
      const dir = path.dirname(this._cfgFile());
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._cfgFile(), JSON.stringify({ plans: this._plans, packs: this._packs }, null, 2), 'utf8');
      return true;
    } catch (e) {
      this.log('err', '价目表写入失败：' + (e && e.message));
      return false;
    }
  }

  plans() { return this._plans; }
  packs() { return this._packs; }
  cycles() { return Object.keys(CYCLE).map((k) => CYCLE[k]); }
  plan(id) { return this._plans.filter((p) => p.id === id)[0] || null; }
  pack(id) { return this._packs.filter((p) => p.id === id)[0] || null; }

  /** 前端菜单用：富字段 + 老字段（code/price/period/seats/features）双写，避免旧渲染崩 */
  listPlans() {
    return this._plans.filter((p) => !p.free).map((p) => {
      const cycles = Object.keys(p.prices || {});
      const preferred = cycles.indexOf('year') > -1 ? 'year' : (cycles[0] || 'year');
      return {
        id: p.id, code: p.id, name: p.name,
        prices: p.prices || {},
        cycles: cycles,
        defaultCycle: preferred,
        amount: (p.prices || {})[preferred] || 0,
        price: (p.prices || {})[preferred] || 0,
        period: preferred === 'quarter' ? 'quarter' : (preferred === 'month' ? 'month' : 'year'),
        cycle: CYCLE[preferred] ? CYCLE[preferred].label : '年付',
        seats: p.seats || 1,
        quota: Object.assign({ seats: p.seats || 1 }, p.quota || {}),
        highlight: !!p.highlight,
        features: p.features || []
      };
    });
  }

  listPacks() {
    return this._packs.map((k) => Object.assign({ unit: KIND_LABEL[k.kind] || k.kind }, k));
  }

  /* ---------------- 集合 ---------------- */
  subs() { return this.store.data.billing_subscriptions || []; }
  wallets() { return this.store.data.billing_wallets || []; }
  ledgerRows() { return this.store.data.billing_ledger || []; }
  usageRows() { return this.store.data.billing_usage || []; }

  subsOf(tenant) {
    return this.subs().filter((s) => s.tenant === tenant);
  }

  /** 当前生效订阅（active 优先，其次 trial），顺带处理自然到期 */
  activeSub(tenant) {
    const now = Date.now();
    const list = this.subsOf(tenant).filter((s) => s.status === 'active' || s.status === 'trial');
    const live = list.filter((s) => new Date(s.periodEnd).getTime() > now);
    const dead = list.filter((s) => new Date(s.periodEnd).getTime() <= now);
    if (dead.length) {
      dead.forEach((s) => { s.status = 'expired'; s.expiredAt = now; });
      this.store.save(true, 'billing_subscriptions');
    }
    live.sort((a, b) => (a.status === 'active' ? -1 : 1) - (b.status === 'active' ? -1 : 1));
    const sub = live[0] || null;
    if (sub) this._rollQuota(sub);
    return sub;
  }

  /** 月度额度重置：拿 periodStart 起每月滚一次 */
  _rollQuota(sub) {
    if (sub.planId === 'trial') return sub;              /* 试用期不重置 */
    const quota = sub.quota || {};
    const unlimited = Object.keys(quota).every((k) => Number(quota[k]) < 0);
    if (unlimited) return sub;
    const now = Date.now();
    let next = Number(sub.resetAt) || addMonths(new Date(sub.periodStart).getTime(), 1);
    let changed = false;
    let guard = 0;
    while (next <= now && next < new Date(sub.periodEnd).getTime() && guard++ < 36) {
      next = addMonths(next, 1);
      sub.used = { leads: 0, minutes: 0, geo: 0 };
      changed = true;
    }
    if (!Number(sub.resetAt)) { sub.resetAt = next; changed = true; }
    else if (changed) sub.resetAt = next;
    if (changed) this.store.save(true, 'billing_subscriptions');
    return sub;
  }

  wallet(tenant) {
    let w = this.wallets().filter((x) => x.tenant === tenant)[0];
    if (!w) {
      w = { tenant: tenant, packs: { leads: 0, minutes: 0, geo: 0, seats: 0 }, updatedAt: Date.now() };
      this.wallets().push(w);
      this.store.save(true, 'billing_wallets');
    }
    if (!w.packs) w.packs = { leads: 0, minutes: 0, geo: 0, seats: 0 };
    return w;
  }

  _ledger(tenant, kind, delta, reason, ref) {
    const rec = {
      id: rid('bl'), tenant: tenant, kind: kind, delta: delta,
      reason: reason || '', ref: ref || '',
      at: Date.now(), created_at: new Date().toISOString()
    };
    this.store.push('billing_ledger', rec);
    return rec;
  }

  _usage(tenant, kind, qty, meta) {
    const rec = {
      id: rid('bu'), tenant: tenant, kind: kind, qty: qty,
      meta: meta || {}, at: Date.now(), created_at: new Date().toISOString()
    };
    this.store.push('billing_usage', rec);
    return rec;
  }

  /* ---------------- 计量 ---------------- */

  /**
   * 扣减额度。返回 {ok, left, grace, fromPack, code}
   * 无订阅 → grace 放行（只记账不拦截）；有订阅 → 严格按额度。
   * K10：meta.dedupeKey 提供重试幂等——同一 key 10 分钟内只记一次用量，
   *       上游超时重试不会再扣一遍（调用方用 job.id / run.id 作 key）。
   */
  charge(tenant, kind, qty, meta) {
    /* K1：记账前做一次租户白名单校验。上层（tenantOf / 任务归属）已经归一化过，
       这里是纵深防御：非法标识直接拒绝记账，绝不静默改记到 default ——
       「钱记到别人头上」比「这笔没记」更难查。 */
    tenant = tenantMod.norm(tenant, '');
    if (!tenant) return { ok: false, code: 'BAD_TENANT', message: '租户标识非法（1–64 位字母/数字/中文与 ._:@-）' };
    kind = String(kind || '').trim();
    const n = num(qty, 0);
    if (!kind || n <= 0) return { ok: true, skipped: true };
    if (!KIND_LABEL[kind]) return { ok: true, skipped: true, message: '未知计量维度 ' + kind };
    const dk = meta && meta.dedupeKey ? String(meta.dedupeKey).slice(0, 120) : '';
    if (dk) {
      const recent = this.usageRows().some((u) => u && u.meta && u.meta.dedupeKey === dk && (Date.now() - Number(u.at || 0)) < 600000);
      if (recent) return { ok: true, deduped: true, left: (this.summary(tenant).left || {})[kind] };
    }

    const sub = this.activeSub(tenant);
    if (!sub) {
      this._usage(tenant, kind, n, Object.assign({ grace: true }, meta || {}));
      return { ok: true, grace: true, message: '未开通套餐（体验放行），已计入用量' };
    }

    const quota = num((sub.quota || {})[kind], 0);
    if (quota < 0) {
      this._usage(tenant, kind, n, meta);
      return { ok: true, unlimited: true, left: -1 };
    }

    sub.used = sub.used || { leads: 0, minutes: 0, geo: 0 };
    const used = num(sub.used[kind], 0);
    const left = Math.max(0, quota - used);

    if (left >= n) {
      sub.used[kind] = used + n;
      this.store.save(true, 'billing_subscriptions');
      this._usage(tenant, kind, n, meta);
      return { ok: true, left: quota - sub.used[kind] };
    }

    /* 套餐不够 → 尝试扣加量包 */
    const need = n - left;
    const w = this.wallet(tenant);
    const pack = num(w.packs[kind], 0);
    if (pack >= need) {
      sub.used[kind] = quota;
      w.packs[kind] = pack - need;
      w.updatedAt = Date.now();
      this.store.save(true, 'billing_subscriptions');
      this.store.save(true, 'billing_wallets');
      this._ledger(tenant, kind, -need, '加量包扣减', meta && meta.ref);
      this._usage(tenant, kind, n, meta);
      return { ok: true, left: 0, fromPack: need };
    }

    this._usage(tenant, kind, 0, Object.assign({ rejected: true, need: need, pack: pack }, meta || {}));
    return {
      ok: false, code: 'QUOTA_EXCEEDED', need: need, left: left, pack: pack,
      message: (KIND_LABEL[kind] || kind) + '额度不足：本月剩余 ' + left + '，还需 ' + need +
        (pack ? '（加量包余额 ' + pack + '）' : '') + '，请升级套餐或购买加量包'
    };
  }

  /** 只读查询，供前端展示「我的额度」 */
  summary(tenant) {
    tenant = tenantMod.norm(tenant);
    const sub = this.activeSub(tenant);
    const w = this.wallet(tenant);
    const now = Date.now();
    const monthUsage = { leads: 0, minutes: 0, geo: 0 };
    this.usageRows().forEach((u) => {
      if (u.tenant !== tenant) return;
      if (now - Number(u.at || 0) > 31 * 864e5) return;
      if (monthUsage[u.kind] == null) return;
      monthUsage[u.kind] += num(u.qty, 0);
    });
    const out = {
      tenant: tenant,
      subscription: sub ? {
        planId: sub.planId, planName: sub.planName, status: sub.status, cycle: sub.cycle,
        periodStart: sub.periodStart, periodEnd: sub.periodEnd,
        leftDays: Math.max(0, Math.ceil((new Date(sub.periodEnd).getTime() - now) / 864e5)),
        trial: sub.status === 'trial'
      } : null,
      quota: sub ? (sub.quota || {}) : null,
      used: sub ? (sub.used || {}) : null,
      packs: w.packs,
      monthUsage: monthUsage,
      trialUsed: this.subsOf(tenant).some((s) => s.planId === 'trial'),
      provider: this.providerId
    };
    if (sub && sub.quota) {
      out.left = {};
      Object.keys(sub.quota).forEach((k) => {
        const q = num(sub.quota[k], 0);
        out.left[k] = q < 0 ? -1 : Math.max(0, q - num((sub.used || {})[k], 0));
      });
    }
    return out;
  }

  /* ---------------- 试用 ---------------- */
  startTrial(tenant) {
    tenant = tenantMod.norm(tenant);
    if (this.subsOf(tenant).some((s) => s.planId === 'trial')) {
      return { ok: false, code: 'TRIAL_USED', message: '该账号已使用过试用额度' };
    }
    const plan = this.plan('trial');
    if (!plan) return { ok: false, code: 'NO_TRIAL_PLAN', message: '未配置试用套餐' };
    const now = Date.now();
    const sub = {
      id: rid('sub'), tenant: tenant, planId: 'trial', planName: plan.name,
      status: 'trial', cycle: 'trial',
      periodStart: now, periodEnd: now + num(plan.days, 14) * 864e5,
      quota: Object.assign({ seats: plan.seats || 1 }, plan.quota || {}),
      used: { leads: 0, minutes: 0, geo: 0 },
      resetAt: now + num(plan.days, 14) * 864e5,
      createdAt: now, created_at: new Date().toISOString()
    };
    this.subs().push(sub);
    this.store.save(true, 'billing_subscriptions');
    this.store.event('info', 'billing', '试用已开通 · ' + tenant + ' · 14 天', { tenant: tenant });
    this._ledger(tenant, 'trial', 1, '开通试用', sub.id);
    return { ok: true, subscription: sub };
  }

  /* ---------------- 订单 ---------------- */
  _item(input) {
    const b = input || {};
    if (b.planId || b.id || b.code) {
      const id = String(b.planId || b.id || b.code).trim();
      const plan = this.plan(id);
      if (!plan) return { ok: false, code: 'BAD_PLAN', message: '未识别的套餐：' + id };
      if (plan.free) return { ok: false, code: 'FREE_PLAN', message: '试用套餐请走 /v1/billing/trial，不需要下单' };
      const avail = Object.keys(plan.prices || {});
      let cycle = String(b.cycle || '').trim();
      if (avail.indexOf(cycle) < 0) cycle = avail.indexOf('year') > -1 ? 'year' : avail[0];
      if (!cycle) return { ok: false, code: 'NO_PRICE', message: '该套餐未配置价格' };
      return {
        ok: true,
        item: {
          kind: 'plan', planId: plan.id, cycle: cycle,
          months: CYCLE[cycle].months,
          amount: num(plan.prices[cycle], 0),
          name: plan.name + ' · ' + CYCLE[cycle].label,
          quota: plan.quota, seats: plan.seats
        }
      };
    }
    if (b.packId) {
      const pack = this.pack(String(b.packId));
      if (!pack) return { ok: false, code: 'BAD_PACK', message: '未识别的加量包：' + b.packId };
      const qtyMul = Math.max(1, Math.min(20, num(b.qty, 1)));
      return {
        ok: true,
        item: {
          kind: 'pack', packId: pack.id, packKind: pack.kind, qty: pack.qty * qtyMul,
          amount: pack.price * qtyMul,
          name: pack.name + ' × ' + qtyMul,
          cycle: 'once', months: 0
        }
      };
    }
    /* 企业定制单：允许人工报价，但不会自动发额度 */
    const amount = num(b.amount, 0);
    if (amount > 0) {
      return {
        ok: true,
        item: {
          kind: 'custom', planId: 'custom', cycle: 'once', months: 0,
          amount: Math.round(amount), name: String(b.planName || '企业定制').slice(0, 40),
          needsManualFulfill: true
        }
      };
    }
    return { ok: false, code: 'BAD_ITEM', message: '请传 planId（quarter/basic/standard/flagship）、packId 或有效 amount' };
  }

  async create(input, tenant) {
    tenant = tenantMod.norm(tenant);
    const r = this._item(input);
    if (!r.ok) return r;
    const item = r.item;

    const idemKey = [tenant, item.kind, item.planId || item.packId, item.cycle, item.amount].join('|');
    const exist = this.store.orders().filter((o) =>
      o.idemKey === idemKey && o.status === 'pending_payment' && Date.now() - Number(o.createdAt) < 2 * 3600e3)[0];
    if (exist) {
      exist.reused = (exist.reused || 0) + 1;
      this.store.save(true, 'orders');
      return { ok: true, reused: true, order: this._pub(exist) };
    }

    const orderNo = 'AD' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1e4).toString().padStart(4, '0');
    const order = {
      orderNo: orderNo,
      idemKey: idemKey,
      tenant: tenant,
      kind: item.kind,
      planId: item.planId || '',
      packId: item.packId || '',
      packKind: item.packKind || '',
      packQty: item.qty || 0,
      cycle: item.cycle,
      months: item.months,
      name: item.name,
      amount: item.amount,
      currency: 'CNY',
      status: 'pending_payment',
      needsManualFulfill: !!item.needsManualFulfill,
      createdAt: Date.now(),
      created_at: new Date().toISOString(),
      expiresAt: Date.now() + 2 * 3600e3
    };
    order.payment = await this._payment(order);
    this.store.addOrder(order);
    this.store.event('info', 'billing', '创建订单 ' + orderNo + ' · ' + item.name + ' ¥' + item.amount, { orderNo: orderNo, planId: order.planId });
    return { ok: true, reused: false, order: this._pub(order) };
  }

  async _payment(order) {
    try {
      const p = await this.provider.create(order);
      return Object.assign({ provider: this.providerId, at: Date.now() }, p);
    } catch (e) {
      return { provider: this.providerId, status: 'error', message: '支付下单失败：' + (e && e.message) };
    }
  }

  /** 对外输出：脱敏 + 兼容老字段 payUrl */
  _pub(o) {
    if (!o) return null;
    const out = Object.assign({}, o);
    out.payUrl = (o.payment && (o.payment.payUrl || o.payment.codeUrl)) || '';
    return out;
  }

  get(orderNo) {
    const o = this.store.order(orderNo);
    if (!o) return { ok: false, code: 'NOT_FOUND', message: '订单不存在' };
    return { ok: true, order: this._pub(o) };
  }

  /** 标记已支付并履约（幂等） */
  markPaid(orderNo, info) {
    const o = this.store.order(orderNo);
    if (!o) return { ok: false, code: 'NOT_FOUND', message: '订单不存在' };
    if (o.status === 'paid' || o.status === 'fulfilled') {
      return { ok: true, idempotent: true, order: this._pub(o) };
    }
    if (o.status === 'closed') return { ok: false, code: 'ORDER_CLOSED', message: '订单已关闭，请重新下单' };

    o.status = 'paid';
    o.paidAt = Date.now();
    o.paid_at = new Date().toISOString();
    o.paidChannel = (info && info.channel) || this.providerId;
    o.transactionId = (info && info.transactionId) || '';
    this.store.save(true, 'orders');
    this._ledger(o.tenant, 'cash', o.amount, '支付成功 · ' + o.name, o.orderNo);

    const f = this.fulfill(o);
    return { ok: true, order: this._pub(o), fulfill: f };
  }

  /** 履约：套餐 → 建/续订阅；加量包 → 进钱包 */
  fulfill(o) {
    if (o.status === 'fulfilled') return { ok: true, idempotent: true };
    if (o.kind === 'plan') {
      const plan = this.plan(o.planId);
      if (!plan) return { ok: false, code: 'BAD_PLAN' };
      const now = Date.now();
      const cur = this.activeSub(o.tenant);
      let start = now;
      if (cur && cur.planId === o.planId && new Date(cur.periodEnd).getTime() > now) {
        start = new Date(cur.periodEnd).getTime();          /* 同档续费：顺延 */
        cur.status = 'renewed';
        cur.renewedBy = o.orderNo;
      } else if (cur) {
        cur.status = 'replaced';                            /* 升/降档：旧的让位 */
        cur.replacedBy = o.orderNo;
        cur.endedAt = now;
      }
      const end = addMonths(start, o.months || 12);
      const sub = {
        id: rid('sub'), tenant: o.tenant, planId: plan.id, planName: plan.name,
        status: 'active', cycle: o.cycle,
        periodStart: start, periodEnd: end,
        quota: Object.assign({ seats: plan.seats || 1 }, plan.quota || {}),
        used: { leads: 0, minutes: 0, geo: 0 },
        resetAt: addMonths(start, 1),
        orderNo: o.orderNo, months: o.months,
        createdAt: now, created_at: new Date().toISOString()
      };
      this.subs().push(sub);
      this.store.save(true, 'billing_subscriptions');
      o.status = 'fulfilled';
      o.fulfilledAt = now;
      this.store.save(true, 'orders');
      this.store.event('info', 'billing', '套餐生效 · ' + plan.name + ' · 至 ' + new Date(end).toLocaleDateString('zh-CN'), { tenant: o.tenant });
      return { ok: true, subscription: sub };
    }
    if (o.kind === 'pack') {
      const w = this.wallet(o.tenant);
      w.packs[o.packKind] = num(w.packs[o.packKind], 0) + num(o.packQty, 0);
      w.updatedAt = Date.now();
      this.store.save(true, 'billing_wallets');
      this._ledger(o.tenant, o.packKind, num(o.packQty, 0), '加量包到账 · ' + o.name, o.orderNo);
      o.status = 'fulfilled';
      o.fulfilledAt = Date.now();
      this.store.save(true, 'orders');
      return { ok: true, packs: w.packs };
    }
    /* custom：需人工确认后再发额度，这里只标记待处理 */
    o.status = 'fulfilled';
    o.fulfilledAt = Date.now();
    this.store.save(true, 'orders');
    return { ok: true, manual: true, message: '定制订单已支付，额度需运营手工发放' };
  }

  /** 支付回调（网关 → 服务端）。验签由各 provider 自己负责。 */
  notify(payload, headers, rawBody) {
    const p = this.provider;
    if (!p || typeof p.verifyNotify !== 'function') {
      return { ok: false, code: 'NO_PROVIDER', message: '未配置支付通道' };
    }
    const v = p.verifyNotify(headers || {}, rawBody, payload);
    if (!v || !v.ok) {
      return { ok: false, code: (v && v.code) || 'BAD_SIGN', message: (v && v.message) || '验签失败' };
    }
    const orderNo = v.orderNo || (payload && (payload.orderNo || payload.out_trade_no)) || (v.payload && v.payload.orderNo);
    if (!orderNo) return { ok: false, code: 'NO_ORDER', message: '回调缺少订单号' };
    const r = this.markPaid(orderNo, { channel: this.providerId, transactionId: v.transactionId });
    return r.ok ? Object.assign({ idempotent: !!r.idempotent }, r) : r;
  }

  /* ---------------- 巡检 ---------------- */
  sweep() {
    const now = Date.now();
    let closed = 0;
    let expired = 0;
    this.store.orders().forEach((o) => {
      if (o.status === 'pending_payment' && Number(o.expiresAt || 0) && now > Number(o.expiresAt)) {
        o.status = 'closed';
        o.closedAt = now;
        closed++;
      }
    });
    if (closed) this.store.save(true, 'orders');
    this.subs().forEach((s) => {
      if ((s.status === 'active' || s.status === 'trial') && new Date(s.periodEnd).getTime() <= now) {
        s.status = 'expired';
        s.expiredAt = now;
        expired++;
      }
    });
    if (expired) this.store.save(true, 'billing_subscriptions');
    return { closed: closed, expired: expired };
  }

  stats() {
    const orders = this.store.orders();
    const subs = this.subs();
    const paid = orders.filter((o) => o.status === 'paid' || o.status === 'fulfilled');
    const now = Date.now();
    return {
      provider: this.providerId,
      configured: !!(this.provider && this.provider.configured && this.provider.configured()),
      plans: this._plans.length,
      orders: {
        total: orders.length,
        pending: orders.filter((o) => o.status === 'pending_payment').length,
        paid: paid.length,
        closed: orders.filter((o) => o.status === 'closed').length
      },
      revenue: paid.reduce((n, o) => n + num(o.amount, 0), 0),
      revenue30d: paid.filter((o) => now - Number(o.paidAt || 0) < 30 * 864e5).reduce((n, o) => n + num(o.amount, 0), 0),
      subscriptions: {
        active: subs.filter((s) => s.status === 'active').length,
        trial: subs.filter((s) => s.status === 'trial').length,
        expired: subs.filter((s) => s.status === 'expired').length
      }
    };
  }

  /** 体检：填错商户参数时当场说清楚错哪，不用猜 */
  health() {
    const p = this.provider || {};
    const base = {
      provider: this.providerId,
      available: Object.keys(this.providers),
      plansFile: this._cfgFile(),
      plansEditable: true,
      checks: []
    };
    if (typeof p.diagnose === 'function') {
      try { base.checks = p.diagnose() || []; } catch (e) { base.checks = [{ key: 'provider', ok: false, message: String(e && e.message) }]; }
    }
    base.ok = base.checks.length ? base.checks.every((c) => c.ok !== false) : true;
    if (this.providerId === 'mock') base.ok = true;
    return base;
  }
}

module.exports = { Billing, PLANS: DEFAULT_PLANS, PACKS: DEFAULT_PACKS, CYCLE, KIND_LABEL, addMonths };
