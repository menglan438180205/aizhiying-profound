'use strict';
/* 直连网关本地冒烟：假上游 + 真网关，验证 4 条路径与鉴权 */
const http = require('http');
const https = require('https');
const { createUploadDirect } = require('../server/upload-direct.js');

let upstreamSeen = [];
const up = http.createServer((req, res) => {
  let n = 0;
  req.on('data', (c) => { n += c.length; });
  req.on('end', () => {
    upstreamSeen.push({ m: req.method, u: req.url, bytes: n, origin: req.headers.origin || '' });
    const body = JSON.stringify({ ok: true, echo: req.url, bytes: n });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': req.headers.origin || '*' });
    res.end(body);
  });
});

const gw = createUploadDirect({
  port: 18443,
  host: '127.0.0.1',
  domain: 'up.aizhiying.online',
  certDir: './.tmp-certs',
  targetHost: '127.0.0.1',
  targetPort: 19100,
  verify: (t) => t === 'local-ticket',
  log: (lv, m) => console.log(m)
});

function req(method, path, headers, body) {
  return new Promise((resolve) => {
    const r = https.request({ host: '127.0.0.1', port: 18443, method, path, headers: headers || {}, rejectUnauthorized: false }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ s: res.statusCode, h: res.headers, b }));
    });
    r.on('error', (e) => resolve({ s: 0, b: String(e.message) }));
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  await new Promise((r) => up.listen(19100, '127.0.0.1', r));
  await new Promise((r) => setTimeout(r, 300));

  const out = [];
  const t1 = await req('GET', '/up/ping');
  out.push(['ping', t1.s, t1.b]);
  const t2 = await req('GET', '/up/init');
  out.push(['ping 走 GET init(应404)', t2.s]);
  const t3 = await req('POST', '/up/init', { 'Content-Type': 'application/json' }, '{"name":"a.mp4"}');
  out.push(['init 无票(应401)', t3.s, t3.b]);
  const t4 = await req('POST', '/up/init', { Authorization: 'Bearer local-ticket', 'Content-Type': 'application/json' }, '{"name":"a.mp4","totalBytes":10}');
  out.push(['init 有票(应200)', t4.s, t4.b]);
  const t5 = await req('PUT', '/up/chunk/upabc123/7', { Authorization: 'Bearer cloud-token-xyz' }, 'x'.repeat(5000));
  out.push(['chunk 云端票透传(应200)', t5.s, t5.b]);
  const t6 = await req('POST', '/up/finish/upabc123', { Authorization: 'Bearer local-ticket' });
  out.push(['finish(应200)', t6.s, t6.b]);
  const t7 = await req('POST', '/v1/edit/jobs', { Authorization: 'Bearer local-ticket' });
  out.push(['非白名单路径(应404)', t7.s]);
  const t8 = await req('OPTIONS', '/up/init', { Origin: 'https://evil.com', 'Access-Control-Request-Method': 'POST' });
  out.push(['坏来源预检(应403)', t8.s]);
  const t9 = await req('OPTIONS', '/up/init', { Origin: 'https://aizhiying.online', 'Access-Control-Request-Method': 'POST' });
  out.push(['好来源预检(应204)', t9.s, t9.h['access-control-allow-origin']]);

  out.forEach((x) => console.log('  ' + x.join(' | ')));
  console.log('\n上游实际收到：');
  upstreamSeen.forEach((x) => console.log('  ' + x.m + ' ' + x.u + ' bytes=' + x.bytes + ' origin=' + x.origin));
  try { gw.close(); } catch (e) {}
  up.close();
  process.exit(0);
})();
