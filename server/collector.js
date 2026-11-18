'use strict';
/* =========================================================
   collector.js — 评论区采集门面
   ---------------------------------------------------------
   前端契约（已固化，不可改动）：
     POST {base}/v1/comments/collect
       Header  Authorization: Bearer <token>
       Body    { platform, keyword, limit, region [, channel [, scope ]] }
       Resp    { data: { comments: [{ nickname, comment, video_title, likes, at }] } }
     GET  {base}/v1/health

   本层只做三件事：选通道 → 转发 → 归一化兜底。
   具体通道的差异全部下沉到 collect-adapters/，这里不堆分支。

   通道（详见 collect-adapters/registry.js）：
     official  自有内容评论区（平台官方开放能力，仅自有作品，scope=own）
     crawler   自建爬虫（第三方公开评论，scope=keyword/own）
     vendor    第三方数据服务（等价于历史 COLLECT_UPSTREAM，契约冻结）
     local     本地模拟（ALLOW_LOCAL_COLLECT=1，绝不冒充真实采集）

   选通道规则（「兼顾两种模式」的落点）：
     · 请求显式指定 channel → 用该通道；未配置则 501，不静默降级
     · channel=auto（默认）→ 按 scope 决定候选顺序，第一个已配置的胜出
         scope=own     → official → crawler → vendor
         scope=keyword → vendor → crawler
         scope=auto    → vendor → crawler → official
     · 一条真实通道都没有且 ALLOW_LOCAL_COLLECT=1 → local
     · 都没有 → 501 UPSTREAM_NOT_CONFIGURED（不返回空数组冒充成功）

   向后兼容保证：mode() 仍是 upstream | local | unconfigured 三态；
   source 仍是 upstream | local-simulated；返回值结构与旧版一致。
   ========================================================= */

const { registry, http, local, normalize } = require('./collect-adapters');

/* 兼容旧导出：这两个词库此前由本模块直接暴露 */
const PALETTE = local.PALETTE;
const OPENERS = local.OPENERS;

/* ------------------------------------------------------------------
   浏览器采集器通道（plugin）
   ------------------------------------------------------------------
   与三条 HTTP 通道的区别是「没有可请求的地址」：采集端在用户电脑上，
   服务器连不到它。所以这里反过来 —— 发一个任务进队列，等采集端来领、
   抓完回传。等待窗口由 COLLECT_PLUGIN_TIMEOUT_MS 控制（默认 120s）。
   超时如实失败并保留任务，采集端晚到的结果仍然会进 collect_jobs，
   不会静默丢数据。
   ------------------------------------------------------------------ */
let deviceHub = null;
function attachDevice(hub) { deviceHub = hub || null; }

function pluginOffline(code, message) {
  return {
    status: 501,
    body: {
      ok: false, code: code || 'PLUGIN_OFFLINE', channel: 'plugin',
      message: message || '浏览器采集器未连接：装扩展的那台电脑需要开着本机桥，并在页面点「连接本机采集器」配对',
      fix: '在评论区获客左栏点「连接本机采集器」→ 启动本机桥 → Chrome 加载扩展'
    }
  };
}

async function deviceCollect(payload, meta) {
  const p = payload || {};
  if (!deviceHub) return pluginOffline('PLUGIN_OFFLINE', '本服务未启用浏览器采集器中枢');
  const dev = deviceHub.pick(p.platform);
  if (!dev) return pluginOffline('PLUGIN_OFFLINE', '没有在线的采集器（本机桥已配对，但最近 25 秒没有心跳）');
  if (!deviceHub.pluginAlive(dev)) {
    return pluginOffline('PLUGIN_NOT_CONNECTED',
      '本机桥在线，但浏览器扩展没连上：在 Chrome 里加载 tools/browser-collector 扩展后会自动连上（桥窗口会打印 PLUGIN ONLINE）');
  }
  const job = deviceHub.enqueue(p, { taskId: meta && meta.taskId, deviceId: dev.id });
  const timeout = registry.timeoutOf('plugin');
  const done = await deviceHub.waitJob(job.id, timeout);

  if (!done) {
    return {
      status: 504,
      body: {
        ok: false, code: 'PLUGIN_TIMEOUT', channel: 'plugin', jobId: job.id,
        message: '采集器在 ' + Math.round(timeout / 1000) + ' 秒内没有回传结果（任务 ' + job.id + ' 仍保留，晚到的结果会照常入池）'
      }
    };
  }
  if (done.status === 'failed' || done.status === 'expired') {
    return {
      status: 502,
      body: {
        ok: false, code: done.error || 'PLUGIN_FAILED', channel: 'plugin', jobId: done.id,
        message: (done.result && done.result.message) || done.error || '采集器执行失败'
      }
    };
  }
  const res = done.result || {};
  const comments = Array.isArray(res.comments) ? res.comments : [];
  return {
    status: 200,
    body: {
      ok: true,
      data: { comments },
      /* 作品卡数据与评论一起回来：一次页面访问能拿到的东西不要分两次请求 */
      notes: Array.isArray(res.notes) ? res.notes : [],
      normalize: { status: 'ok', shell: 'plugin', dropped: 0, missingFields: [], reason: res.message || '' },
      source: 'upstream',
      channel: 'plugin',
      scope: String(p.scope || 'keyword'),
      device: { id: dev.id, name: dev.name, host: dev.host },
      stats: res.stats || {},
      ms: done.ms || 0
    }
  };
}

/**
 * 解析本次请求应使用的通道。
 * @param {object} payload 含 channel / scope
 */
function resolveChannel(payload) {
  const p = payload || {};
  return registry.resolve(p.channel, p.scope);
}

/**
 * 采集一次。
 * @param {object} payload { platform, keyword, limit, region, channel, scope }
 * @param {object} [reqHeaders]
 * @param {object} [meta]  { taskId } —— 仅用于把任务与采集端的执行记录对上
 * @returns {Promise<{status:number, body:object}>}
 */
async function collect(payload, reqHeaders, meta) {
  const picked = resolveChannel(payload);
  if (!picked.ok) {
    return {
      status: 501,
      body: {
        ok: false,
        code: picked.code,
        channel: picked.channel || '',
        message: picked.message,
        fix: picked.fix || '',
        candidates: picked.candidates || [],
        contract: 'POST /v1/comments/collect  Body { platform, keyword, limit, region [, channel] }  Resp { data: { comments: [...] } }'
      }
    };
  }

  const d = registry.def(picked.channel);
  if (d && d.kind === 'local') {
    const r = local.collect(Object.assign({}, payload, { channel: 'local' }));
    r.body.why = picked.why;
    return r;
  }
  if (d && d.kind === 'device') {
    const r = await deviceCollect(payload, meta);
    if (r.body) r.body.why = picked.why;
    return r;
  }

  const r = await http.call(picked.channel, payload, reqHeaders);
  if (r.body) {
    r.body.why = picked.why;
    r.body.scope = String((payload && payload.scope) || registry.def(picked.channel).scope);
  }
  return r;
}

/** 是否已接入至少一条真实通道（供 /v1/health 与启动横幅使用） */
function configured() {
  return registry.hasReal();
}

/** 通道模式三态：upstream（有真实通道）/ local（仅模拟）/ unconfigured（都没有） */
function mode() {
  if (registry.hasReal()) return 'upstream';
  if (require('./demo').allowLocalCollect()) return 'local';
  return 'unconfigured';
}

/** 通道清单（只看配置，不探测） */
function channels() {
  return registry.list();
}

/** 各真实通道的健康探测（并发）。浏览器采集器没有 HTTP 地址，单独出状态 */
async function channelHealth() {
  const ids = registry.REAL_IDS.filter((id) => id !== 'plugin' && registry.configured(id));
  const list = await Promise.all(ids.map((id) => http.health(id)));
  if (registry.configured('plugin') || (deviceHub && deviceHub.devices().length)) {
    const st = deviceHub ? deviceHub.status() : { paired: 0, online: 0, plugin: false, devices: [] };
    list.push({
      id: 'plugin', name: registry.DEFS.plugin.name, configured: st.paired > 0,
      ok: st.online > 0 && st.plugin, upstream: 'local-collector',
      message: st.online > 0
        ? (st.plugin ? (st.online + ' 台采集器在线') : '本机桥在线，但浏览器扩展未连接')
        : '采集器离线',
      device: st
    });
  }
  return list;
}

/**
 * 聚合健康状态。保留 configured / ok / upstream / message 四个历史字段，
 * 新增 channels 明细，避免改动 /v1/health 的既有消费方。
 *
 * 注意：这里只认「真实通道」。local 是本地模拟，即便 ALLOW_LOCAL_COLLECT=1
 * 也不算「已接入通道」—— 否则界面会把它显示成真实采集，与 fail-loud 的初衷相反。
 */
async function upstreamHealth() {
  const real = channels().filter((c) => c.id !== 'local' && c.configured);
  const list = await channelHealth();
  if (!real.length) {
    return {
      configured: false, ok: false,
      channels: channels(),
      message: '未配置任何采集通道（自有内容评论区 / 自建爬虫 / 第三方数据服务）'
    };
  }
  const primary = real.filter((c) => c.id !== 'plugin')[0] || real[0];
  const okAll = list.length > 0 && list.every((x) => x.ok);
  return {
    configured: true,
    ok: okAll,
    upstream: primary.upstream,
    channel: primary.id,
    channels: list,
    /* 缺必填项（如官方通道缺 owner）时在这里点出来，而不是等采集时才 501 */
    incomplete: real.filter((c) => c.missing.length > 0).map((c) => ({ id: c.id, missing: c.missing })),
    message: okAll ? '' : ('部分通道不可达：' + list.filter((x) => !x.ok).map((x) => x.id).join(' / '))
  };
}

/** 本地模拟采集（保留旧签名，供需要显式兜底的老调用方使用） */
function localCollect(payload) {
  return local.collect(payload);
}

module.exports = {
  collect, normalize, upstreamHealth, localCollect,
  configured, mode, channels, channelHealth, resolveChannel,
  attachDevice,
  PALETTE, OPENERS,
  CHANNEL_IDS: registry.CHANNEL_IDS,
  REAL_IDS: registry.REAL_IDS,
  SCOPE_IDS: registry.SCOPE_IDS,
  setOverride: registry.setOverride,
  overrideFile: registry.overrideFile
};
