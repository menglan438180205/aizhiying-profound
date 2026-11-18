'use strict';
/* =========================================================================
 * tools/crawler-verify/server.js — 采集通道「验证用」上游（合规安全版）
 * -------------------------------------------------------------------------
 * ⚠ 合规边界（务必先读 server/README.md 第 283–290 行）：
 *   本文件是一个【验证线束】工具，仅用于证明 BFF 的 crawler 通道「接得上、
 *   数据能进池、CRM 能查到」这条链路是通的。它绝对不抓取任何第三方平台，
 *   返回的全部是清晰标注的【合成样例数据】，不含任何真实个人信息。
 *
 *   不要把本服务当成生产爬虫去连抖音/小红书等第三方平台的评论区：
 *   - 绕过平台防护措施抓取受保护内容，违反平台协议；
 *   - 未经授权收集个人信息，触及《个人信息保护法》《反不正当竞争法》《数据安全法》。
 *   生产环境若启用 crawler 通道，请严格限定为「自有账号内容」或「已获书面授权
 *   的内容源」，并在条款页写清这一边界（README 建议方案二）。代码侧已保证：
 *   crawler 未配置时完全不可用，不会因「代码里有这个通道」而产生任何采集行为。
 *
 * 契约（与 BFF server/collect-adapters/http-provider.js 对齐）：
 *   POST /v1/comments/collect
 *     Body { platform, keyword, limit, region, scope, ... }
 *     Resp { ok:true, data:{ comments:[ { nickname, comment, video_title,
 *            likes, at, region, platform } ] } }
 *     （字段名兼容 normalize.js 的多别名，见 server/collect-adapters/normalize.js）
 *   GET  /v1/health   -> 200 { ok:true, service:'crawler-verify', synthetic:true }
 *
 * 运行（无需任何 npm 依赖，仅用 Node 内置 http）：
 *   node tools/crawler-verify/server.js            # 默认监听 8801
 *   PORT=8801 node tools/crawler-verify/server.js
 * ========================================================================= */

const http = require('http');

const PORT = Number(process.env.PORT || 8801);

// 清晰标注的合成样例：覆盖 normalize 的多套别名，证明上游「差不多对」就能接。
// 注意：nick_name / content / title / digg_count 等是故意用别名，验证归一化兼容。
const SAMPLE_COMMENTS = [
  {
    nickname: '示例用户·验证A',
    comment: '【验证样例·非真实数据】请问你们做汽车广告的报价怎么算？',
    video_title: '劳斯莱斯 15s 短视频案例',
    likes: 12,
    at: new Date().toISOString(),
    region: '江苏·苏州',
    platform: 'douyin'
  },
  {
    nick_name: '示例用户·验证B',
    content: '【验证样例·非真实数据】有没有同城的开店方案可以聊聊？',
    title: 'AI 智盈 · 案例演示',
    digg_count: 3,
    create_time: new Date(Date.now() - 3600e3).toISOString(),
    city: '浙江·杭州'
  },
  {
    user: '示例用户·验证C',
    text: '【验证样例·非真实数据】这条仅用于通道连通性验证。',
    video: '户型设计小程序演示',
    liked_count: 0,
    time: new Date(Date.now() - 7200e3).toISOString(),
    ip_region: '上海'
  }
];

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && url === '/v1/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'crawler-verify',
      synthetic: true,
      note: 'verification-only upstream, returns no real data'
    });
  }

  if (req.method === 'POST' && url === '/v1/comments/collect') {
    const body = await readBody(req);
    // 只回显 scope 等参数，便于在 BFF 运行记录里核对转发是否正确。
    return sendJson(res, 200, {
      ok: true,
      data: {
        comments: SAMPLE_COMMENTS.map((c) => Object.assign({}, c, {
          // 把本次请求的 scope/platform 透传，便于端到端核对
          _echo_scope: body.scope || 'keyword',
          _echo_platform: body.platform || 'douyin'
        }))
      }
    });
  }

  return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'unknown path' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[crawler-verify] listening on http://0.0.0.0:' + PORT);
  console.log('[crawler-verify] SYNTHETIC DATA ONLY — not for production scraping.');
  console.log('[crawler-verify] BFF should set COLLECT_CRAWLER_URL=http://<this-host>:' + PORT);
});
