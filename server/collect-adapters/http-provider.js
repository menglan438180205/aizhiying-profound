'use strict';
/* =========================================================
   collect-adapters/http-provider.js — HTTP 型通道的通用转发
   ---------------------------------------------------------
   official / crawler / vendor 三条通道的差别只在「地址、令牌、
   超时、body 里多带哪几个字段」，转发逻辑完全一致，所以合成一处，
   避免往主链路堆 if 分支。

   契约（上游必须实现）：
     POST {base}/v1/comments/collect
       Header  Authorization: Bearer <token>   （令牌非空时）
       Body    { platform, keyword, limit, region [, scope [, owner]] }
       Resp    { data: { comments: [...] } }    （壳层别名由 normalize 兜底）
     GET  {base}/v1/health                      （用于 /v1/health 的通道探测）

   body 的差异（刻意为之，不要拉平）：
     vendor   只发 { platform, keyword, limit, region }
              —— 供应商契约已上线，绝不能因为改造而多出字段
     crawler  多带 scope（own = 只采自有账号，keyword = 按关键词搜公开内容）
     official 多带 scope:'own' 与 owner（自有账号标识）
   ========================================================= */

const registry = require('./registry');
const { normalize, normalizeDetailed } = require('./normalize');

/**
 * 按通道定义组装请求体。
 * @param {object} d  通道定义
 * @param {object} payload  前端/调度器给的统一参数
 */
function bodyOf(d, payload) {
  const p = payload || {};
  const out = {
    platform: p.platform,
    keyword: p.keyword,
    limit: p.limit,
    region: p.region
  };
  if (d.id === 'vendor') return out;               /* 契约冻结，保持现状 */
  if (d.id === 'crawler') {
    out.scope = String(p.scope || 'keyword') === 'own' ? 'own' : 'keyword';
    /* 目标类型透传给桥：author=盯博主、video=盯作品。
       不认识这两个字段的桥会忽略它们，退化成关键词搜索，不会报错。 */
    if (p.target) out.target = String(p.target).slice(0, 16);
    if (p.author) out.author = String(p.author).slice(0, 120);
    if (p.video) out.video = String(p.video).slice(0, 200);
    return out;
  }
  /* official：官方开放能力只能读自有账号作品 */
  out.scope = 'own';
  out.owner = registry.ownerOf();
  if (p.owner_id) out.owner_id = String(p.owner_id).slice(0, 64);
  if (Array.isArray(p.content_ids) && p.content_ids.length) {
    out.content_ids = p.content_ids.slice(0, 50).map((x) => String(x).slice(0, 64));
  }
  return out;
}

/**
 * 转发一次采集请求。
 * @param {string} channelId
 * @param {object} payload
 * @param {object} [reqHeaders]  仅 vendor 允许用 x-collect-token 头兜底传令牌
 * @returns {Promise<{status:number, body:object}>}
 */
async function call(channelId, payload, reqHeaders) {
  const d = registry.def(channelId);
  const up = registry.urlOf(channelId);
  if (!d || !up) {
    return {
      status: 501,
      body: {
        ok: false, code: 'CHANNEL_NOT_CONFIGURED', channel: channelId,
        message: (d ? d.name : channelId) + ' 未接入：' + (d ? d.fix : '未知通道')
      }
    };
  }

  /* 令牌：优先环境变量；vendor 兼容历史行为，允许用请求头兜底 */
  let token = registry.tokenOf(channelId);
  if (!token && channelId === 'vendor') {
    token = String((reqHeaders && reqHeaders['x-collect-token']) || '');
  }
  if (d.needToken && !token) {
    return {
      status: 501,
      body: {
        ok: false, code: 'CHANNEL_NOT_CONFIGURED', channel: channelId,
        message: d.name + ' 缺少令牌：' + d.fix
      }
    };
  }

  const body = bodyOf(d, payload);
  const timeout = registry.timeoutOf(channelId);
  const ctl = new AbortController();
  const timer = setTimeout(() => { ctl.abort(); }, timeout);
  const headers = Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' },
    token ? { Authorization: 'Bearer ' + token } : {});

  try {
    const res = await fetch(up + '/v1/comments/collect', {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal
    });
    clearTimeout(timer);
    let json = null;
    let parseFailed = false;
    try {
      json = await res.json();
    } catch (e) {
      /* 上游返回空体或非 JSON —— 与「上游说没有评论」是两回事 */
      parseFailed = true;
    }
    if (!res.ok) {
      return {
        status: 502,
        body: {
          ok: false, code: 'UPSTREAM_ERROR', channel: channelId, upstreamStatus: res.status,
          message: d.name + '返回错误', raw: json
        }
      };
    }

    /* 归一化：区分「合法空列表」与「结构漂移 / 读不到」。
       旧实现在这里直接 normalize(json) 取数组，结构一漂移就静默变空数组，
       上层记 status='ok' + '本轮无新增' —— 销售拿到空名单却以为采集成功。 */
    const det = normalizeDetailed(json, body);
    if (det.status === 'shape_changed' || det.status === 'invalid_body') {
      return {
        status: 502,
        body: {
          ok: false, code: 'UPSTREAM_SHAPE_CHANGED', channel: channelId, upstreamStatus: res.status,
          message: d.name + '返回结构无法识别，已判定为失败（而非「本轮无评论」）',
          detail: det.reason,
          missingFields: det.missingFields,
          shell: det.shell,
          parseFailed: parseFailed
        }
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        data: { comments: det.items },
        /* 归一化诊断：让上层能区分「空结果」与「有结果」，也能看到丢了多少条 */
        normalize: {
          status: det.status, shell: det.shell, dropped: det.dropped,
          missingFields: det.missingFields, reason: det.reason
        },
        /* source 保持 'upstream' 不变：下游（前端标签、运行记录、导出）
           都按「真实通道 vs local-simulated」二分判断，具体走哪条通道
           由 channel 字段单独承载，避免把既有判断改坏 */
        source: 'upstream',
        channel: channelId,
        upstream: up
      }
    };
  } catch (e) {
    clearTimeout(timer);
    const ab = e && e.name === 'AbortError';
    return {
      status: 504,
      body: {
        ok: false, channel: channelId,
        code: ab ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
        message: ab
          ? (d.name + '超时（' + timeout + 'ms）')
          : (d.name + '不可达：' + String((e && e.message) || e))
      }
    };
  }
}

/** 通道健康探测 */
async function health(channelId) {
  const d = registry.def(channelId);
  const up = registry.urlOf(channelId);
  if (!d || !up) return { id: channelId, configured: false, ok: false, message: '未配置 ' + (d ? d.urlEnv : '') };
  const ctl = new AbortController();
  const timer = setTimeout(() => { ctl.abort(); }, 6000);
  const token = registry.tokenOf(channelId);
  try {
    const res = await fetch(up + '/v1/health', {
      headers: token ? { Authorization: 'Bearer ' + token } : {}, signal: ctl.signal
    });
    clearTimeout(timer);
    return { id: channelId, name: d.name, configured: true, ok: res.ok, status: res.status, upstream: up };
  } catch (e) {
    clearTimeout(timer);
    return {
      id: channelId, name: d.name, configured: true, ok: false,
      upstream: up, message: String((e && e.message) || e)
    };
  }
}

module.exports = { call, health, bodyOf };
