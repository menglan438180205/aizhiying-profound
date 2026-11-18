'use strict';
/* =========================================================
   pay/wechatv3.js — 微信支付 APIv3 · Native 扫码
   ---------------------------------------------------------
   零第三方依赖：签名 / 验签 / 回调解密全部用 Node 内置 crypto。
   需要填的 6 个字段（写进 .env.local）：
     PAY_PROVIDER=wechat
     WXPAY_MCHID            商户号
     WXPAY_APPID            绑定的 AppID
     WXPAY_SERIAL_NO        商户 API 证书序列号
     WXPAY_PRIVATE_KEY      apiclient_key.pem 的路径
     WXPAY_APIV3_KEY        APIv3 密钥（32 位）
     WXPAY_NOTIFY_URL       回调地址（必须 https、公网可达）
   可选：
     WXPAY_PLATFORM_CERT    平台证书 pem 路径；不填则自动下载并缓存 12h

   注意：本模块按官方文档实现，但未经真实商户号联调。
   首次接入请先用 1 分钱订单验证回调验签，再放量。
   ========================================================= */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_BASE = 'https://api.mch.weixin.qq.com';

function env(k, dft) {
  const v = process.env[k];
  return (v == null || v === '') ? (dft || '') : String(v).trim();
}

function cfg() {
  return {
    mchid: env('WXPAY_MCHID'),
    appid: env('WXPAY_APPID'),
    serialNo: env('WXPAY_SERIAL_NO'),
    keyPath: env('WXPAY_PRIVATE_KEY'),
    apiv3: env('WXPAY_APIV3_KEY'),
    notifyUrl: env('WXPAY_NOTIFY_URL')
  };
}

function readKey(p) {
  if (!p) return null;
  try {
    const full = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full, 'utf8');
  } catch (e) { return null; }
}

/* ---------------- 签名 ---------------- */
function authHeader(method, urlPath, bodyStr, c) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex').toUpperCase();
  const msg = method + '\n' + urlPath + '\n' + ts + '\n' + nonce + '\n' + bodyStr + '\n';
  const key = readKey(c.keyPath);
  if (!key) throw new Error('商户私钥不可读：' + c.keyPath);
  const sig = crypto.createSign('RSA-SHA256').update(msg, 'utf8').sign(key, 'base64');
  return 'WECHATPAY2-SHA256-RSA2048 mchid="' + c.mchid + '",nonce_str="' + nonce +
    '",signature="' + sig + '",timestamp="' + ts + '",serial_no="' + c.serialNo + '"';
}

/* ---------------- AES-256-GCM 解密（回调报文 / 平台证书） ---------------- */
function decryptGcm(apiv3, nonce, assoc, ciphertextB64) {
  const buf = Buffer.from(ciphertextB64, 'base64');
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(apiv3, 'utf8'), Buffer.from(nonce, 'utf8'));
  d.setAuthTag(tag);
  if (assoc) d.setAAD(Buffer.from(assoc, 'utf8'));
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/* ---------------- 平台证书（验签用公钥） ---------------- */
let _certs = { at: 0, list: [] };

async function platformCerts(c) {
  if (_certs.list.length && Date.now() - _certs.at < 12 * 3600e3) return _certs.list;
  const fixed = env('WXPAY_PLATFORM_CERT');
  if (fixed) {
    const pem = readKey(fixed);
    if (pem) {
      const serial = crypto.X509Certificate ? new crypto.X509Certificate(pem).serialNumber : '';
      _certs = { at: Date.now(), list: [{ serial: serial, pem: pem }] };
      return _certs.list;
    }
  }
  const urlPath = '/v3/certificates';
  const r = await fetch(API_BASE + urlPath, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: authHeader('GET', urlPath, '', c) }
  });
  if (!r.ok) throw new Error('下载平台证书失败 HTTP ' + r.status);
  const j = await r.json();
  const list = [];
  (j.data || []).forEach((it) => {
    try {
      const enc = it.encrypt_certificate;
      const pem = decryptGcm(c.apiv3, enc.nonce, enc.associated_data, enc.ciphertext);
      const x = new crypto.X509Certificate(pem);
      list.push({ serial: x.serialNumber, pem: pem });
    } catch (e) {}
  });
  if (!list.length) throw new Error('平台证书解析为空');
  _certs = { at: Date.now(), list: list };
  return list;
}

/* ---------------- 下单 ---------------- */
async function create(order) {
  const c = cfg();
  if (!c.mchid || !c.appid || !c.serialNo || !c.keyPath || !c.apiv3 || !c.notifyUrl) {
    return {
      provider: 'wechat', status: 'not_configured', payMode: 'wechat',
      message: '微信支付未配置完整（需要 MCHID / APPID / SERIAL_NO / PRIVATE_KEY / APIV3_KEY / NOTIFY_URL）'
    };
  }
  const urlPath = '/v3/pay/transactions/native';
  const body = {
    appid: c.appid,
    mchid: c.mchid,
    description: String(order.name || 'AI智盈服务').slice(0, 120),
    out_trade_no: order.orderNo,
    notify_url: c.notifyUrl,
    amount: { total: Math.round(Number(order.amount || 0) * 100), currency: 'CNY' },
    attach: String(order.tenant || 'default').slice(0, 100)
  };
  const bodyStr = JSON.stringify(body);
  const r = await fetch(API_BASE + urlPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authHeader('POST', urlPath, bodyStr, c)
    },
    body: bodyStr
  });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch (e) {}
  if (!r.ok) {
    return {
      provider: 'wechat', status: 'error', payMode: 'wechat',
      message: '微信下单失败：' + (j.message || ('HTTP ' + r.status)),
      code: j.code || ''
    };
  }
  return {
    provider: 'wechat', status: 'ready', payMode: 'wechat',
    codeUrl: j.code_url || '',
    payUrl: j.code_url || '',
    qrText: j.code_url || '',
    message: '请用微信扫码支付',
    canConfirm: false
  };
}

/* ---------------- 回调验签 ---------------- */
function verifyNotify(headers, rawBody) {
  const c = cfg();
  const ts = String(headers['wechatpay-timestamp'] || '');
  const nonce = String(headers['wechatpay-nonce'] || '');
  const sig = String(headers['wechatpay-signature'] || '');
  const serial = String(headers['wechatpay-serial'] || '');
  if (!ts || !nonce || !sig || !serial) {
    return { ok: false, code: 'BAD_HEADER', message: '回调缺少微信签名头' };
  }
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
    return { ok: false, code: 'STALE', message: '回调时间戳超出 5 分钟' };
  }
  const body = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody || '').toString('utf8');
  const msg = ts + '\n' + nonce + '\n' + body + '\n';

  /* 平台证书是异步下载的，这里只能同步取缓存；未预热时返回可重试错误 */
  const certs = _certs.list.length ? _certs.list : [];
  if (!certs.length) {
    return { ok: false, code: 'CERT_NOT_READY', message: '平台证书尚未加载，请先触发一次支付或配置 WXPAY_PLATFORM_CERT' };
  }
  const hit = certs.filter((x) => !serial || x.serial === serial)[0] || certs[0];
  let valid = false;
  try {
    valid = crypto.createVerify('RSA-SHA256').update(msg, 'utf8').verify(hit.pem, sig, 'base64');
  } catch (e) {
    valid = false;
  }
  if (!valid) return { ok: false, code: 'BAD_SIGN', message: '微信回调验签失败' };

  let payload = {};
  try { payload = JSON.parse(body); } catch (e) {}
  let dec = {};
  try {
    const res = payload.resource || {};
    if (res.ciphertext) {
      dec = JSON.parse(decryptGcm(c.apiv3, res.nonce, res.associated_data, res.ciphertext));
    }
  } catch (e) {
    return { ok: false, code: 'BAD_DECRYPT', message: '回调报文解密失败：' + (e && e.message) };
  }
  const orderNo = dec.out_trade_no || payload.out_trade_no;
  const tradeState = dec.trade_state || '';
  if (tradeState && tradeState !== 'SUCCESS') {
    return { ok: false, code: 'NOT_SUCCESS', message: '交易状态 ' + tradeState + '，不视为支付成功', orderNo: orderNo };
  }
  return { ok: true, orderNo: orderNo, transactionId: dec.transaction_id || '', payload: dec };
}

function diagnose() {
  const c = cfg();
  const key = readKey(c.keyPath);
  const out = [];
  out.push({ key: 'WXPAY_MCHID', ok: !!c.mchid, message: c.mchid ? '商户号已填' : '缺少商户号' });
  out.push({ key: 'WXPAY_APPID', ok: !!c.appid, message: c.appid ? 'AppID 已填' : '缺少 AppID' });
  out.push({ key: 'WXPAY_SERIAL_NO', ok: /^[0-9A-Fa-f]{16,64}$/.test(c.serialNo), message: c.serialNo ? '证书序列号格式可疑：应为 16-64 位十六进制' : '缺少证书序列号' });
  out.push({
    key: 'WXPAY_PRIVATE_KEY',
    ok: !!key && key.indexOf('BEGIN PRIVATE KEY') > -1,
    message: key ? '商户私钥可读' : '私钥文件不存在或不可读：' + (c.keyPath || '(未填)')
  });
  out.push({ key: 'WXPAY_APIV3_KEY', ok: c.apiv3.length === 32, message: c.apiv3.length === 32 ? 'APIv3 密钥长度正确' : 'APIv3 密钥必须是 32 位，当前 ' + c.apiv3.length + ' 位' });
  out.push({
    key: 'WXPAY_NOTIFY_URL',
    ok: /^https:\/\//.test(c.notifyUrl),
    message: /^https:\/\//.test(c.notifyUrl) ? '回调地址已配置' : '回调地址必须是 https 开头的外网地址'
  });
  out.push({
    key: 'WXPAY_PLATFORM_CERT',
    ok: true,
    message: env('WXPAY_PLATFORM_CERT') ? '已指定平台证书' : '未指定平台证书，将自动下载并缓存 12 小时'
  });
  return out;
}

module.exports = { id: 'wechat', configured: () => diagnose().every((x) => x.ok !== false), create, verifyNotify, diagnose, platformCerts };
