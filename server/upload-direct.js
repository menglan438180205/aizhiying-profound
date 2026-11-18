'use strict';
/**
 * 直连上传网关（upload-direct）
 * ------------------------------------------------------------------
 * 目的：把「素材分块上传」从 Cloudflare 隧道上摘下来，走服务器自己的
 *       HTTPS 443，绕开隧道 QUIC/边缘 100s 的硬限制。
 *
 * 设计取舍：不复制上传逻辑，只做「带鉴权的窄口径反向代理」。
 *   - 只放行 3 条上传路径 + 1 条 ping，其余 404（公网 443，必须窄）
 *   - 先校验前端会话票，再原样透传给 127.0.0.1:8787 的现有实现
 *   - 证书缺失/端口被占 ⇒ 返回 null，主服务照常启动（优雅降级）
 *
 * 前端用法：
 *   GET  https://up.aizhiying.online/up/ping
 *   POST https://up.aizhiying.online/up/init
 *   PUT  https://up.aizhiying.online/up/chunk/<uploadId>/<idx>
 *   POST https://up.aizhiying.online/up/finish/<uploadId>
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

/* 单块 8MB，留 5 倍余量防止异常客户端打爆内存 */
const MAX_BODY = 40 * 1024 * 1024;

/* 允许跨域的主站来源（直连域名与主站不同源，必须显式放行） */
const ORIGIN_OK = [
  'https://aizhiying.online',
  'https://www.aizhiying.online',
  'https://aizhiying.app.workbuddy.host',
  'https://profound.app.workbuddy.host'
];

function originAllowed(o) {
  const s = String(o || '');
  if (!s) return false;
  if (ORIGIN_OK.indexOf(s) > -1) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(s);
}

function createUploadDirect(o) {
  const opts = o || {};
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const verify = typeof opts.verify === 'function' ? opts.verify : function () { return false; };

  const targetHost = opts.targetHost || '127.0.0.1';
  const targetPort = Number(opts.targetPort || 8787);
  const port = Number(opts.port || 443);
  const host = opts.host || '0.0.0.0';
  const certDir = String(opts.certDir || '');
  const domain = String(opts.domain || 'up.aizhiying.online');
  const strict = !!opts.strict;

  if (!certDir) { log('warn', '[up-direct] 未配置 UPLOAD_CERT_DIR，直连上传通道未启动'); return null; }
  const crtFile = path.join(certDir, domain + '-crt.pem');
  const keyFile = path.join(certDir, domain + '-key.pem');
  if (!fs.existsSync(crtFile) || !fs.existsSync(keyFile)) {
    log('warn', '[up-direct] 证书缺失（' + crtFile + '），直连上传通道未启动');
    return null;
  }
  let tls = null;
  try {
    tls = { cert: fs.readFileSync(crtFile), key: fs.readFileSync(keyFile) };
  } catch (e) {
    log('warn', '[up-direct] 证书读取失败：' + e.message);
    return null;
  }

  /* 路径映射：只有这几条能出去，别的一律 404 */
  function mapPath(method, p) {
    if (method === 'GET' && p === '/up/ping') return '__ping';
    if (method === 'POST' && p === '/up/init') return '/v1/edit/upload/init';
    let m = /^\/up\/chunk\/([A-Za-z0-9-]{4,40})\/(\d{1,5})$/.exec(p);
    if (method === 'PUT' && m) return '/v1/edit/upload/' + m[1] + '/' + m[2];
    m = /^\/up\/finish\/([A-Za-z0-9-]{4,40})$/.exec(p);
    if (method === 'POST' && m) return '/v1/edit/upload/' + m[1] + '/finish';
    return null;
  }

  function cors(res, origin) {
    if (!originAllowed(origin)) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Request-Id,X-Tenant');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
  }

  function reply(res, code, obj, origin) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    cors(res, origin);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store'
    });
    res.end(body);
  }

  function tokenOf(req) {
    const h = String(req.headers.authorization || '');
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1].trim() : '';
  }

  /* 流式转发：不缓冲整块，8MB 块直接边收边转 */
  function proxy(req, res, outPath, origin) {
    const headers = Object.assign({}, req.headers);
    headers.host = targetHost + ':' + targetPort;
    delete headers['accept-encoding'];

    const up = http.request({
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: outPath,
      headers: headers
    }, (r) => {
      const h = Object.assign({}, r.headers);
      cors(res, origin);
      try { res.writeHead(r.statusCode || 502, h); } catch (e) { return res.end(); }
      r.pipe(res);
    });

    up.on('error', (e) => {
      log('error', '[up-direct] 转发失败 ' + outPath + '：' + e.message);
      if (!res.headersSent) reply(res, 502, { ok: false, code: 'UPSTREAM_DOWN', message: '内部服务不可用，请稍后重试' }, origin);
      else { try { res.end(); } catch (e2) {} }
    });

    /* 客户端中途断开（切页面/断网）必须掐掉上游，否则 BFF 会留半截请求 */
    req.on('aborted', () => { try { up.destroy(); } catch (e) {} });

    let seen = 0;
    req.on('data', (c) => { seen += c.length; if (seen > MAX_BODY) { try { up.destroy(); } catch (e) {} req.destroy(); } });
    req.pipe(up);
  }

  function handler(req, res) {
    const origin = req.headers.origin || '';
    const u = req.url || '/';
    const p = u.split('?')[0];

    if (req.method === 'OPTIONS') {
      if (!originAllowed(origin)) return reply(res, 403, { ok: false, code: 'BAD_ORIGIN', message: '来源不被允许' }, origin);
      cors(res, origin);
      res.writeHead(204);
      return res.end();
    }

    const outPath = mapPath(req.method, p);
    if (!outPath) return reply(res, 404, { ok: false, code: 'NO_ROUTE', message: '未知接口' }, origin);

    /* 探测接口免鉴权：前端靠它决定走直连还是回退隧道 */
    if (outPath === '__ping') return reply(res, 200, { ok: true, direct: true, up: true, ts: Date.now() }, origin);

    /* 鉴权分两层：
     *   1) 没带票 ⇒ 直接 401（挡掉公网随机扫描，省一次内部往返）
     *   2) 带了票 ⇒ 本地票由 verify() 当场判定；云端票只有 BFF 认得，
     *      交给 BFF 的 authed() 定夺（401 会原样透回前端）。
     * 这样直连层不复制鉴权逻辑，也不会误伤云端登录的用户。
     * strict=true 时改为只认本地票（排查可疑流量用）。 */
    const tk = tokenOf(req);
    if (!tk) {
      return reply(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '缺少登录票（请重新登录后再上传）' }, origin);
    }
    if (strict && !verify(tk)) {
      return reply(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '登录票无效或已过期' }, origin);
    }

    return proxy(req, res, outPath, origin);
  }

  const srv = https.createServer(tls, handler);

  srv.on('error', (e) => {
    log('error', '[up-direct] 监听 ' + port + ' 失败：' + e.message);
  });

  srv.listen(port, host, () => {
    log('info', '[up-direct] 直连上传通道已监听 https://' + domain + ':' + port + ' → ' + targetHost + ':' + targetPort);
  });

  return {
    server: srv,
    port: port,
    domain: domain,
    close: function () { try { srv.close(); } catch (e) {} }
  };
}

module.exports = { createUploadDirect: createUploadDirect };
