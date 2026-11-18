'use strict';
/**
 * 本地账号体系（Local Auth）
 * ------------------------------------------------------------
 * 为什么需要它：
 *   现有登录（手机号验证码 / 微信 OAuth）全部依赖 WorkBuddy 云端
 *   （经 /.cloud/ 中继转发）。云端一旦凭证失效（实测 401 invalid_client），
 *   前台就只剩「DEMO」和「粘贴 API_TOKEN」两条路 —— 等于把进门的钥匙
 *   挂在一个不受自己控制的外部服务上。
 *
 * 本模块提供一个**完全本地**的兜底账号体系：
 *   - 手机号 + 密码注册/登录，账号存 DATA_DIR/users.ndjson
 *   - 密码 scrypt 加盐哈希（Node 内置 crypto，零依赖）
 *   - 会话 token 是 HMAC-SHA256 签名的无状态票（不落库、可校验、可过期）
 *   - 与云端登录**并存**：云端恢复后前端仍走云端，本模块只是永远可用的备胎
 *
 * 边界与取舍：
 *   - 不做短信验证：发短信要供应商和费用，本地场景（自用/内网/演示）不需要。
 *     要短信就把本模块当「密码体系」，外包一层短信校验即可，不用改存储。
 *   - 不做多租户隔离：与现有单一 API_TOKEN 同权限级（登录后等价于持有令牌）。
 *     真要分权需要给每个 API 加 subject 校验，属另一期工程。
 *   - 失败限流放内存：进程重启即清零。可接受 —— 它防的是脚本暴力猜密码，
 *     真被打穿的前置条件是攻击者已能连到 8787（隧道后面）。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRYPT_N = 16384;
const KEYLEN = 64;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;   /* 30 天 */
const PHONE_RE = /^1\d{10}$/;
const MIN_PWD = 8;

/* 登录失败限流：同一 IP 10 分钟内 6 次失败即锁定 */
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_MAX_FAIL = 6;
const failBuckets = new Map();

function nowIso() { return new Date().toISOString(); }

function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 ? '='.repeat(4 - (t.length % 4)) : '';
  return Buffer.from(t + pad, 'base64');
}

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, { N: SCRYPT_N, r: 8, p: 1 });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  if (!ba.length || ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (e) { return false; }
}

/**
 * @param {object} o
 * @param {string} o.dataDir       数据目录（跟随 DATA_ROOT）
 * @param {string} o.secret        会话签名密钥（用 API_TOKEN，未设则退化到固定值+告警）
 * @param {string} o.adminPhone    管理员手机号（配合 adminPassword，启动时自动开户）
 * @param {string} o.adminPassword 管理员初始密码
 * @param {string} o.registerCode  邀请码：配置后注册必须带对码；不配置 = 关闭注册
 * @param {object} o.log           日志函数
 */
function createAuth(o) {
  const opts = o || {};
  const dataDir = opts.dataDir || path.join(__dirname, '.data');
  const file = path.join(dataDir, 'users.ndjson');
  const secret = String(opts.secret || 'pf-local-auth-fallback');
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const adminPhone = String(opts.adminPhone || '').trim();
  const adminPassword = String(opts.adminPassword || '');
  const envRegisterCode = String(opts.registerCode || '').trim();
  const companyName = String(opts.companyName || process.env.COMPANY_NAME || 'ProFound').slice(0, 60);
  const settingsFile = path.join(dataDir, 'auth-settings.json');

  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {}

  /* ---------------- 邀请码设置 ----------------
   * 以前 REGISTER_CODE 只从 env 读：改一次要登服务器、改 .env.local、重启 BFF。
   * 现在后台把设置写 DATA_DIR/auth-settings.json，保存即生效、重启不丢；
   * 文件不存在时仍回退 env，保证旧部署零改动。 */
  let settingsCache = null;

  function readSettings() {
    if (settingsCache) return settingsCache;
    let raw = '';
    try { raw = fs.readFileSync(settingsFile, 'utf8'); } catch (e) {}
    if (!raw) {
      settingsCache = {
        register: envRegisterCode ? 'code' : 'closed',
        code: envRegisterCode,
        source: 'env',
        updatedAt: '',
        updatedBy: ''
      };
      return settingsCache;
    }
    try {
      const j = JSON.parse(raw);
      settingsCache = {
        register: j && j.register === 'code' ? 'code' : 'closed',
        code: String((j && j.code) || ''),
        source: 'file',
        updatedAt: String((j && j.updatedAt) || ''),
        updatedBy: String((j && j.updatedBy) || '')
      };
    } catch (e) {
      log('warn', '邀请码配置文件解析失败，回退 REGISTER_CODE：' + e.message);
      settingsCache = {
        register: envRegisterCode ? 'code' : 'closed',
        code: envRegisterCode,
        source: 'env',
        updatedAt: '',
        updatedBy: ''
      };
    }
    return settingsCache;
  }

  function settingsView() {
    const s = readSettings();
    return {
      register: s.register === 'code' ? 'code' : 'closed',
      code: s.code || '',
      source: s.source,
      updatedAt: s.updatedAt || '',
      updatedBy: s.updatedBy || ''
    };
  }

  function saveSettings(p, actor) {
    const mode = p && p.register === 'code' ? 'code' : 'closed';
    const code = String((p && p.code) || '').trim();
    if (mode === 'code' && !code) {
      return { error: { code: 'CODE_REQUIRED', message: '开启自助注册时必须填写邀请码' } };
    }
    if (code && !/^[A-Za-z0-9_-]{6,64}$/.test(code)) {
      return { error: { code: 'CODE_FORMAT', message: '邀请码需为 6–64 位字母、数字、下划线或短横线' } };
    }
    const next = {
      register: mode,
      code: code,
      updatedAt: nowIso(),
      updatedBy: actor ? (actor.name || actor.phone || '管理员') : '管理员'
    };
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = settingsFile + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, settingsFile);
      try { fs.chmodSync(settingsFile, 0o600); } catch (e) {}
    } catch (e) {
      log('error', '邀请码设置写入失败：' + e.message);
      return { error: { code: 'WRITE_FAILED', message: '保存失败：' + e.message } };
    }
    settingsCache = Object.assign({}, next, { source: 'file' });
    log('ok', '邀请码设置已更新：' + (mode === 'code' ? '开启自助注册' : '关闭自助注册'));
    return { settings: settingsView() };
  }

  /* ---------------- 存储 ----------------
   * 与 store.js 同策略：整表读进内存 + 写入用「临时文件 + rename」保证原子，
   * 避免进程被杀时留下半行 JSON。用户量级在百级以内，全量重写完全够用。 */
  let users = [];
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { users = []; return; }
    users = raw.split('\n').map(function (l) {
      const s = l.trim();
      if (!s) return null;
      try { return JSON.parse(s); } catch (e) { return null; }
    }).filter(Boolean);
  }

  function persist() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, users.map(function (u) { return JSON.stringify(u); }).join('\n') + '\n', 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      log('error', '本地账号写入失败：' + e.message);
    }
  }

  function findByPhone(phone) {
    load();
    const p = String(phone || '').trim();
    return users.find(function (u) { return u.phone === p; }) || null;
  }

  function publicUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      phone: u.phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2'),
      name: u.name || '',
      company: u.company || companyName,
      tenant: u.tenant || 'default',
      role: u.role || 'member',
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt || ''
    };
  }

  /* ---------------- 会话票 ----------------
   * 结构：b64u(payloadJSON) + '.' + b64u(HMAC-SHA256(payload, secret))
   * 无状态：服务重启后仍有效；改 secret 即全体失效（应急下线手段）。 */
  function sign(payloadB64) {
    return b64u(crypto.createHmac('sha256', secret).update(payloadB64).digest());
  }

  function issue(u) {
    const payload = { sub: u.id, ph: u.phone, iat: Date.now(), exp: Date.now() + SESSION_TTL_MS };
    /* K2：租户/角色随票签发，服务端不再信任请求头里的 X-Tenant-Id。
       老账号没有 tenant 字段 → 不写，读侧回落 default，行为不变。 */
    if (u.tenant) payload.tenant = String(u.tenant).slice(0, 64);
    if (u.role) payload.role = String(u.role).slice(0, 16);
    const p = b64u(JSON.stringify(payload));
    return p + '.' + sign(p);
  }

  function verify(token) {
    const t = String(token || '');
    const i = t.lastIndexOf('.');
    if (i <= 0) return null;
    const p = t.slice(0, i), s = t.slice(i + 1);
    let expect;
    try { expect = sign(p); } catch (e) { return null; }
    if (expect.length !== s.length) return null;
    try {
      if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(s))) return null;
    } catch (e) { return null; }
    let payload;
    try { payload = JSON.parse(b64uDecode(p).toString('utf8')); } catch (e) { return null; }
    if (!payload || !payload.exp || Date.now() > payload.exp) return null;
    load();
    const u = users.find(function (x) { return x.id === payload.sub; }) || null;
    if (!u) return null;   /* 账号被删 → 票立即失效 */
    return { user: u, payload: payload };
  }

  /* ---------------- 限流 ---------------- */
  function rlKey(ip) { return String(ip || 'unknown'); }
  function rlBlocked(ip) {
    const b = failBuckets.get(rlKey(ip));
    if (!b) return false;
    if (Date.now() - b.at > RL_WINDOW_MS) { failBuckets.delete(rlKey(ip)); return false; }
    return b.n >= RL_MAX_FAIL;
  }
  function rlHit(ip) {
    const k = rlKey(ip);
    const b = failBuckets.get(k);
    if (!b || Date.now() - b.at > RL_WINDOW_MS) { failBuckets.set(k, { n: 1, at: Date.now() }); return; }
    b.n += 1; b.at = Date.now();
  }
  function rlClear(ip) { failBuckets.delete(rlKey(ip)); }

  /* ---------------- 管理员账号自举 ----------------
   * 去掉前端内嵌令牌后，进门必须有账号；而注册默认关闭，首次部署一个账号都没有
   * 就会把自己锁在门外。于是用 env 兜这一层：账号不存在就创建，已存在绝不覆盖
   * （改过密码不会被重启冲回去）。控制变量：ADMIN_PHONE / ADMIN_PASSWORD。 */
  function ensureAdmin() {
    if (!adminPhone || !adminPassword) return;
    if (!PHONE_RE.test(adminPhone)) { log('warn', 'ADMIN_PHONE 不是 11 位手机号，跳过管理员自举'); return; }
    if (adminPassword.length < MIN_PWD) { log('warn', 'ADMIN_PASSWORD 少于 ' + MIN_PWD + ' 位，跳过管理员自举'); return; }
    load();
    for (let i = 0; i < users.length; i++) {
      if (users[i].phone === adminPhone) return;
    }
    const h = hashPassword(adminPassword);
    const u = {
      id: 'u' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      phone: adminPhone, name: '管理员', salt: h.salt, hash: h.hash,
      role: 'owner', tenant: 'default', company: companyName,
      createdAt: nowIso(), lastLoginAt: ''
    };
    users.push(u);
    persist();
    log('ok', '已按 ADMIN_PHONE 创建管理员账号：' + publicUser(u).phone);
  }

  /* ---------------- 业务方法 ---------------- */
  function register(p) {
    const phone = String((p && p.phone) || '').trim();
    const password = String((p && p.password) || '');
    const name = String((p && p.name) || '').trim().slice(0, 40);
    /* 注册默认关闭：任何人都能注册 = 任何人都能拿到全部接口权限（含客户手机号）。
       后台开启后必须带对邀请码；设置文件优先于 REGISTER_CODE。 */
    const s = readSettings();
    if (s.register !== 'code') return { error: { code: 'REGISTER_CLOSED', message: '注册已关闭，请联系管理员开通账号' } };
    if (String((p && p.code) || '').trim() !== s.code) {
      return { error: { code: 'BAD_CODE', message: '邀请码不正确' } };
    }
    if (!PHONE_RE.test(phone)) return { error: { code: 'BAD_PHONE', message: '请输入 11 位手机号' } };
    if (password.length < MIN_PWD) return { error: { code: 'WEAK_PASSWORD', message: '密码至少 ' + MIN_PWD + ' 位' } };
    if (findByPhone(phone)) return { error: { code: 'EXISTS', message: '该手机号已注册，请直接登录' } };

    const h = hashPassword(password);
    const u = {
      id: 'u' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      phone: phone, name: name, salt: h.salt, hash: h.hash, role: 'member',
      tenant: 'default',
      company: String((p && p.company) || companyName).trim().slice(0, 60) || companyName,
      createdAt: nowIso(), lastLoginAt: ''
    };
    users.push(u);
    persist();
    log('ok', '本地账号注册：' + publicUser(u).phone);
    return { user: u, token: issue(u) };
  }

  function login(p, ip) {
    const phone = String((p && p.phone) || '').trim();
    const password = String((p && p.password) || '');
    if (rlBlocked(ip)) return { error: { code: 'TOO_MANY', message: '尝试过于频繁，请 10 分钟后再试' } };
    if (!PHONE_RE.test(phone) || !password) {
      rlHit(ip);
      return { error: { code: 'BAD_INPUT', message: '手机号或密码不完整' } };
    }
    const u = findByPhone(phone);
    if (!u) { rlHit(ip); return { error: { code: 'BAD_CREDENTIAL', message: '手机号或密码错误' } }; }
    const h = hashPassword(password, u.salt);
    if (!safeEqualHex(h.hash, u.hash)) {
      rlHit(ip);
      return { error: { code: 'BAD_CREDENTIAL', message: '手机号或密码错误' } };
    }
    rlClear(ip);
    u.lastLoginAt = nowIso();
    persist();
    return { user: u, token: issue(u) };
  }

  function changePassword(u, oldPwd, newPwd) {
    if (!u) return { error: { code: 'NO_USER', message: '未登录' } };
    const h = hashPassword(String(oldPwd || ''), u.salt);
    if (!safeEqualHex(h.hash, u.hash)) return { error: { code: 'BAD_CREDENTIAL', message: '原密码错误' } };
    if (String(newPwd || '').length < MIN_PWD) return { error: { code: 'WEAK_PASSWORD', message: '新密码至少 ' + MIN_PWD + ' 位' } };
    const nh = hashPassword(String(newPwd));
    u.salt = nh.salt; u.hash = nh.hash;
    persist();
    return { ok: true };
  }

  function stats() {
    load();
    const s = readSettings();
    /* register: closed = 只能由管理员开户；code = 需要邀请码自助注册 */
    return { users: users.length, file: file, register: s.register === 'code' ? 'code' : 'closed', registerSource: s.source, company: companyName };
  }

  /* ---------------- HTTP 路由 ---------------- */
  /* 依赖注入：不直接 require('./index')，避免循环依赖 */
  function registerRoutes(deps) {
    const route = deps.route, ok = deps.ok, fail = deps.fail, jsonBody = deps.jsonBody;
    const authed = deps.authed || function () { return false; };
    const ownerOnly = deps.ownerOnly || authed;

    /* 前端用来判断「本地账号是否可用」，必须免鉴权（进门前就要知道） */
    route('GET', /^\/v1\/auth\/status$/, function (req, res) {
      const s = stats();
      return ok(res, { ok: true, local: true, users: s.users, register: s.register, registerSource: s.registerSource, company: s.company, cloudHint: 'cloud' });
    }, { public: true, desc: '本地账号可用性 / 注册开关' });

    /* 后台邀请码设置：只有 owner/admin 能读写，成员不可见邀请码 */
    route('GET', /^\/v1\/auth\/settings$/, function (req, res) {
      if (!ownerOnly(req)) return fail(res, 403, 'FORBIDDEN', '仅所有者可管理邀请码');
      return ok(res, {
        ok: true,
        settings: settingsView(),
        envFallback: !!envRegisterCode,
        registerUrl: '/app/'
      });
    }, { desc: '读取邀请码与注册开关（仅所有者）' });

    route('PUT', /^\/v1\/auth\/settings$/, async function (req, res) {
      if (!ownerOnly(req)) return fail(res, 403, 'FORBIDDEN', '仅所有者可管理邀请码');
      const body = await jsonBody(req);
      const r = saveSettings(body || {}, (function () {
        try {
          const bt = deps.bearerOf ? deps.bearerOf(req) : '';
          const v = bt ? verify(bt) : null;
          return v ? v.user : null;
        } catch (e) { return null; }
      })());
      if (r.error) return fail(res, 400, r.error.code, r.error.message);
      return ok(res, { ok: true, settings: r.settings });
    }, { desc: '保存邀请码与注册开关（仅所有者）' });

    route('POST', /^\/v1\/auth\/register$/, async function (req, res) {
      const body = await jsonBody(req);
      const r = register(body || {});
      if (r.error) {
        const code = r.error.code;
        /* 关闭注册 / 邀请码错都不是「参数不合法」，用 403 和 400 区分开 */
        const status = (code === 'REGISTER_CLOSED' || code === 'BAD_CODE') ? 403 : 400;
        return fail(res, status, code, r.error.message);
      }
      return ok(res, { token: r.token, user: publicUser(r.user) });
    }, { public: true, desc: '本地账号注册（需邀请码）' });

    route('POST', /^\/v1\/auth\/login$/, async function (req, res) {
      const body = await jsonBody(req);
      const ip = deps.clientIp ? deps.clientIp(req) : (req.socket && req.socket.remoteAddress) || '';
      const r = login(body || {}, ip);
      if (r.error) return fail(res, r.error.code === 'TOO_MANY' ? 429 : 401, r.error.code, r.error.message);
      return ok(res, { token: r.token, user: publicUser(r.user) });
    }, { public: true, desc: '本地账号登录' });

    /* 无状态票：服务端不维护会话表，退出以客户端清票为准；这里保留审计与扩展点。 */
    route('POST', /^\/v1\/auth\/logout$/, function (req, res) {
      return ok(res, { ok: true, message: '已退出登录' });
    }, { public: true, desc: '退出登录' });

    /* 当前没有短信/邮件通道，忘记密码走管理员重置，别给一个假的自助入口。 */
    route('POST', /^\/v1\/auth\/forgot$/, async function (req, res) {
      const body = await jsonBody(req);
      const phone = String((body && body.phone) || '').trim();
      return fail(res, 501, 'RESET_CONTACT_ADMIN',
        phone ? '请联系管理员重置密码；当前未接短信/邮件服务' : '请输入手机号，或联系管理员重置密码');
    }, { public: true, desc: '忘记密码（当前转人工）' });

    /* 以下需要已登录：用 authed()（它同时接受 API_TOKEN 与本地会话票） */
    route('GET', /^\/v1\/auth\/me$/, function (req, res) {
      const v = verify(deps.bearerOf ? deps.bearerOf(req) : '');
      if (!v) return ok(res, { ok: true, user: null, mode: authed(req) ? 'token' : 'none' });
      return ok(res, { ok: true, user: publicUser(v.user), mode: 'local' });
    }, { desc: '当前登录身份' });

    route('POST', /^\/v1\/auth\/password$/, async function (req, res) {
      const v = verify(deps.bearerOf ? deps.bearerOf(req) : '');
      if (!v) return fail(res, 400, 'NO_LOCAL_USER', '当前不是本地账号登录，无法改密码');
      const body = await jsonBody(req);
      const r = changePassword(v.user, (body || {}).oldPassword, (body || {}).newPassword);
      if (r.error) return fail(res, 400, r.error.code, r.error.message);
      return ok(res, { ok: true, token: issue(v.user) });
    }, { desc: '修改本地账号密码' });
  }

  /* 启动即自举管理员：失败不能影响服务启动，账号体系整体仍在。 */
  try { ensureAdmin(); } catch (e) { log('warn', '管理员自举失败：' + (e && e.message)); }

  return {
    registerRoutes: registerRoutes,
    stats: stats,
    /* 供 index.js 的 authed() 调用：判断一个 Bearer 是否是合法本地会话票 */
    verifyToken: function (t) { try { return !!verify(t); } catch (e) { return false; } },
    /* K2：返回票内声明（tenant/role），tenantOf() 用它取代请求头 */
    claims: function (t) { try { const v = verify(t); return v ? v.payload : null; } catch (e) { return null; } },
    issueFor: function (phone, password) { return login({ phone: phone, password: password }, 'local'); },
    _internals: { verify: verify, users: function () { load(); return users; } }
  };
}

module.exports = { createAuth: createAuth };
