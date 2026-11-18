'use strict';
/**
 * cloudbase.js — 腾讯云 CloudBase / COS 直传（零第三方依赖）
 *
 * 用途：把「AI秒搭建站」的产物直接推上 CloudBase 托管的 COS 桶，替代手动上传。
 * 之所以不用 @cloudbase/cli：项目坚持零 npm 依赖，且生产环境下维护 CLI 登录态很脆弱。
 *
 * 两块能力：
 *   1) 云 API 3.0（TC3-HMAC-SHA256 签名）—— 查询环境与其静态存储信息
 *   2) COS 对象存储（SigV5 / HMAC-SHA1 签名）—— PUT 单个对象
 *
 * 需要的环境变量（写进 .env.local，由 start-local.js 注入）：
 *   TCB_SECRET_ID / TCB_SECRET_KEY   腾讯云 API 密钥（建议用子账号，只给 COS 写权限）
 *   TCB_ENV_ID                        CloudBase 环境 ID
 *   TCB_BUCKET / TCB_REGION          目标桶与地域（由 scripts/cb-doctor.js 探测确认）
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

const TCB_HOST = 'tcb.tencentcloudapi.com';
const TCB_VERSION = '2018-06-08';

function cred() {
  const id = String(process.env.TCB_SECRET_ID || '').trim();
  const key = String(process.env.TCB_SECRET_KEY || '').trim();
  if (!id || !key) {
    const e = new Error('缺少腾讯云密钥：请检查 .env.local 里的 TCB_SECRET_ID / TCB_SECRET_KEY');
    e.code = 'NO_CREDENTIAL';
    throw e;
  }
  return { id, key };
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

function hmacSha256(keyBuf, msg) {
  return crypto.createHmac('sha256', keyBuf).update(Buffer.from(msg, 'utf8')).digest();
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function utcDate(t) {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

function httpsReq(opt, bodyBuf, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = https.request(opt, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} if (!settled) { settled = true; reject(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })); } });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    req.setTimeout(timeoutMs || 15000);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/* =========================================================
   1. 云 API 3.0 —— TC3-HMAC-SHA256
   ========================================================= */

async function tcbApi(action, payload, timeoutMs) {
  const { id, key } = cred();
  const t = nowSec();
  const body = JSON.stringify(payload || {});
  const contentType = 'application/json; charset=utf-8';

  const headers = {
    'content-type': contentType,
    'host': TCB_HOST,
    'x-tc-action': action,
    'x-tc-timestamp': String(t),
    'x-tc-version': TCB_VERSION
  };

  const keys = Object.keys(headers).sort();
  const canonicalHeaders = keys.map((k) => k + ':' + headers[k] + '\n').join('');
  const signedHeaders = keys.join(';');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(body)].join('\n');
  const scope = utcDate(t) + '/tcb/tc3_request';
  const stringToSign = ['TC3-HMAC-SHA256', String(t), scope, sha256hex(canonicalRequest)].join('\n');

  const secretDate = hmacSha256(Buffer.from('TC3' + key, 'utf8'), utcDate(t));
  const secretService = hmacSha256(secretDate, 'tcb');
  const secretSigning = hmacSha256(secretService, 'tc3_request');
  const signature = crypto.createHmac('sha256', secretSigning)
    .update(Buffer.from(stringToSign, 'utf8')).digest('hex');

  const authorization = 'TC3-HMAC-SHA256 Credential=' + id + '/' + scope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

  const res = await httpsReq({
    host: TCB_HOST, path: '/', method: 'POST', timeout: timeoutMs || 15000,
    headers: Object.assign({}, headers, { Authorization: authorization })
  }, Buffer.from(body, 'utf8'), timeoutMs || 15000);

  let json = null;
  try { json = JSON.parse(res.text); } catch (e) { /* 非 JSON（如网关错误）按文本处理 */ }
  if (json) {
    const err = json.Response && json.Response.Error;
    if (err) {
      const e = new Error((err.Code || 'CloudBaseApiError') + ': ' + (err.Message || ''));
      e.code = err.Code || 'CLOUDBASE_API_ERROR';
      throw e;
    }
    return json.Response;
  }
  const e = new Error('云 API 返回非 JSON：HTTP ' + res.status + ' ' + res.text.slice(0, 200));
  e.code = 'BAD_RESPONSE';
  throw e;
}

/** 列出当前密钥可见的全部 CloudBase 环境 —— doctor 用它确认 envId 与静态存储 */
function listEnvs() {
  return tcbApi('DescribeEnvs', {}, 20000);
}

/**
 * 从云 API 的环境信息里抽取静态托管相关的存储线索。
 * 不同账号计划字段名不完全一致，这里做宽容匹配：凡是值里像桶名 / 地域 / 域名的都收上来。
 */
function pickStorageHints(response) {
  const envs = (response && response.EnvList) || (response && response.Envs) || [];
  const out = [];
  for (const env of envs) {
    const item = { envId: env.EnvId || '', alias: env.Alias || '', hints: [] };
    const walk = (obj, trail) => {
      if (!obj || typeof obj !== 'object') return;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        const p = trail ? trail + '.' + k : k;
        if (typeof v === 'string') {
          if (/(bucket|cos|storage|oss)/i.test(k) && v) item.hints.push({ field: p, kind: 'bucket', value: v });
          else if (/region/i.test(k) && v) item.hints.push({ field: p, kind: 'region', value: v });
          else if (/(domain|host|url)/i.test(k) && /(tcloudbase|tcb|myqcloud)/i.test(v)) item.hints.push({ field: p, kind: 'domain', value: v });
        } else if (typeof v === 'object') {
          walk(v, p);
        }
      }
    };
    walk(env, '');
    out.push(item);
  }
  return out;
}

/* =========================================================
   2. COS 对象上传 —— SigV5（HMAC-SHA1）
   ========================================================= */

function cosUrlEncode(s) {
  return encodeURIComponent(String(s))
    .replace(/%2C/gi, ',')
    .replace(/%2F/gi, '/')
    .replace(/%3A/gi, ':');
}

async function putObject(opt) {
  const { id, key } = cred();
  const bucket = String(opt.bucket || process.env.TCB_BUCKET || '').trim();
  const region = String(opt.region || process.env.TCB_REGION || '').trim();
  if (!bucket || !region) {
    const e = new Error('缺少目标桶/地域：请先跑 node scripts/cb-doctor.js 确认 TCB_BUCKET / TCB_REGION');
    e.code = 'NO_TARGET';
    throw e;
  }

  const objKey = String(opt.key || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!objKey) {
    const e = new Error('对象 key 为空');
    e.code = 'EMPTY_KEY';
    throw e;
  }

  const data = Buffer.isBuffer(opt.data) ? opt.data : Buffer.from(String(opt.data == null ? '' : opt.data), 'utf8');
  const contentType = String(opt.contentType || guessMime(objKey));
  const host = bucket + '.cos.' + region + '.myqcloud.com';
  const pathname = '/' + objKey.split('/').map((seg) => encodeURIComponent(seg)).join('/');

  const now = nowSec();
  const keyTime = now + ';' + (now + 3600);
  const signKey = crypto.createHmac('sha1', key).update(keyTime).digest('hex');

  const headers = { 'content-type': contentType, 'host': host, 'content-length': String(data.length) };
  const hKeys = Object.keys(headers).sort();
  const headerList = hKeys.join(';');
  const httpHeaders = hKeys.map((k) => cosUrlEncode(k) + '=' + cosUrlEncode(headers[k])).join('&');
  const httpString = ['put', pathname, '', httpHeaders, ''].join('\n');
  const stringToSign = ['sha1', keyTime, crypto.createHash('sha1').update(Buffer.from(httpString, 'utf8')).digest('hex'), ''].join('\n');
  const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');

  const authorization = [
    'q-sign-algorithm=sha1',
    'q-ak=' + id,
    'q-sign-time=' + keyTime,
    'q-key-time=' + keyTime,
    'q-header-list=' + headerList,
    'q-url-param-list=',
    'q-signature=' + signature
  ].join('&');

  const res = await httpsReq({
    host, path: pathname, method: 'PUT', timeout: opt.timeoutMs || 30000,
    headers: {
      Authorization: authorization,
      Host: host,
      'Content-Type': contentType,
      'Content-Length': data.length
    }
  }, data, opt.timeoutMs || 30000);

  if (res.status >= 200 && res.status < 300) {
    return { ok: true, key: objKey, bytes: data.length, status: res.status, etag: res.headers.etag || '' };
  }
  const e = new Error('COS 上传失败 HTTP ' + res.status + '：' + res.text.slice(0, 300));
  e.code = 'COS_PUT_FAILED';
  e.status = res.status;
  throw e;
}

function guessMime(file) {
  const ext = path.extname(String(file)).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2'
  };
  return map[ext] || 'application/octet-stream';
}

function walkDir(dir, base) {
  const out = [];
  base = base || dir;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push.apply(out, walkDir(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/**
 * 把本地目录整体推到桶里
 * @param {object} o { dir, prefix, bucket, region, concurrency }
 */
async function uploadDir(o) {
  const dir = String(o.dir || '');
  if (!fs.existsSync(dir)) {
    const e = new Error('目录不存在：' + dir);
    e.code = 'NO_DIR';
    throw e;
  }
  const prefix = String(o.prefix == null ? '' : o.prefix).replace(/^\/+/, '').replace(/\/+$/, '');
  const files = walkDir(dir);
  const concurrency = Math.max(1, Math.min(8, Number(o.concurrency || 4)));
  const uploaded = [];
  const failed = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < files.length) {
      const rel = files[cursor++];
      const key = (prefix ? prefix + '/' : '') + rel;
      try {
        const r = await putObject({
          bucket: o.bucket, region: o.region, key,
          data: fs.readFileSync(path.join(dir, rel)),
          contentType: guessMime(rel),
          timeoutMs: o.timeoutMs || 30000
        });
        uploaded.push(r);
      } catch (e) {
        failed.push({ key, message: (e && e.message) || String(e), code: (e && e.code) || '' });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));

  return {
    total: files.length,
    uploaded: uploaded.length,
    failed: failed.length,
    failures: failed,
    bytes: uploaded.reduce((n, x) => n + x.bytes, 0)
  };
}

module.exports = {
  tcbApi, listEnvs, pickStorageHints,
  putObject, uploadDir, guessMime, walkDir
};
