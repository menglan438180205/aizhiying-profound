'use strict';
/* =========================================================
   login-relay.js — 扫码登录中转（K：跨 HTTPS 的本机登录）
   ---------------------------------------------------------
   为什么需要它：
   页面在 https://aizhiying.online，本机桥在 http://127.0.0.1:8801。
   浏览器会拦「HTTPS 页面直连 localhost」的请求，页面拿不到二维码。
   所以让「本机桥 → 云端 BFF」走主动外连：桥用设备令牌领登录任务，
   把二维码 PNG 和状态回传给 BFF；页面只读同源的 BFF，不碰 localhost。

   数据只放内存（登录会话分钟级，BFF 重启即丢，不需要落盘）。
   ========================================================= */

const crypto = require('crypto');

const TTL_MS = 10 * 60e3;

class LoginRelay {
  constructor(deviceHub) {
    this.hub = deviceHub;
    this.sessions = new Map();
  }

  _prune() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.createdAt > TTL_MS) this.sessions.delete(id);
    }
  }

  _id() { return 'lg_' + crypto.randomBytes(9).toString('hex'); }

  start(input, deviceId) {
    this._prune();
    const platform = String(input.platform || '').trim();
    const accountId = String(input.accountId || '').slice(0, 64);
    const profileDir = String(input.profileDir || '').trim().slice(0, 240);
    if (!platform || !profileDir) {
      return { error: { code: 'BAD_LOGIN', message: '缺少 platform 或 profileDir' } };
    }
    let dev = null;
    if (deviceId) dev = this.hub.devices().filter((d) => d.id === deviceId)[0] || null;
    if (!dev) dev = this.hub.pick(platform);
    if (!dev) {
      return { error: { code: 'NO_DEVICE', message: '本机采集器不在线：先启动本机桥并点「连接」配对' } };
    }
    if (!this.hub.isOnline(dev)) {
      return { error: { code: 'DEVICE_OFFLINE', message: '本机采集器离线，请确认本机桥黑窗口还开着' } };
    }
    const s = {
      id: this._id(), deviceId: dev.id, platform: platform,
      accountId: accountId, profileDir: profileDir, force: !!input.force,
      status: 'pending', message: '等待本机桥领取…',
      qr: null, qrAt: 0, createdAt: Date.now(), updatedAt: Date.now()
    };
    this.sessions.set(s.id, s);
    return { session: s, device: this.hub.pub(dev) };
  }

  /** 本机桥来领任务：同一台设备一次只领一个，领到即标记 running */
  next(dev) {
    this._prune();
    for (const s of this.sessions.values()) {
      if (s.deviceId === dev.id && s.status === 'pending') {
        s.status = 'running';
        s.message = '本机桥已领取，正在打开登录页…';
        s.updatedAt = Date.now();
        return s;
      }
    }
    return null;
  }

  qr(id, dev, buf, mime) {
    const s = this.sessions.get(String(id || ''));
    if (!s || s.deviceId !== dev.id) return { error: { code: 'NOT_FOUND', message: '登录会话不存在' } };
    s.qr = buf;
    s.qrAt = Date.now();
    s.qrMime = String(mime || 'image/png').slice(0, 40);
    s.updatedAt = Date.now();
    return { ok: true };
  }

  update(id, dev, patch) {
    const s = this.sessions.get(String(id || ''));
    if (!s || s.deviceId !== dev.id) return { error: { code: 'NOT_FOUND', message: '登录会话不存在' } };
    if (patch.status) s.status = String(patch.status).slice(0, 24);
    if (patch.message != null) s.message = String(patch.message).slice(0, 300);
    if (patch.profileDir) s.profileDir = String(patch.profileDir).slice(0, 240);
    s.updatedAt = Date.now();
    return { ok: true };
  }

  state(id, dev) {
    const s = this.sessions.get(String(id || ''));
    if (!s || s.deviceId !== dev.id) return null;
    return { status: s.status, message: s.message };
  }

  get(id) {
    this._prune();
    return this.sessions.get(String(id || '')) || null;
  }

  cancel(id) {
    const s = this.get(id);
    if (s && ['ok', 'failed', 'timeout', 'canceled'].indexOf(s.status) < 0) {
      s.status = 'canceled';
      s.message = '已取消登录';
      s.updatedAt = Date.now();
    }
    return s;
  }

  view(s, withQr) {
    if (!s) return null;
    const o = {
      id: s.id, deviceId: s.deviceId, platform: s.platform, accountId: s.accountId,
      profileDir: s.profileDir, status: s.status, message: s.message,
      hasQr: !!s.qr, qrAt: s.qrAt, qrMime: s.qrMime || 'image/png',
      createdAt: s.createdAt, updatedAt: s.updatedAt
    };
    /* 页面轮询时直接带 data URL，避免 <img> 再去请求一个需要 Cookie 的地址 */
    if (withQr && s.qr) o.qr = s.qr.toString('base64');
    return o;
  }
}

module.exports = { LoginRelay };
