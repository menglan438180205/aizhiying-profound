'use strict';
/**
 * deploy.js — 把站点产物一键推到 CloudBase 托管
 *
 * 编排三步：导出（含按目标域改域）→ 上传 → 返回结果。
 * 具体签名与传输在 cloudbase.js，导出在 publish.js，这里只做编排和错误归类。
 */

const { exportSite, cleanDomain } = require('./publish');
const cb = require('./cloudbase');

/** 当前密钥与目标桶是否配齐 —— 前端据此决定能不能点「部署」 */
function status() {
  const cred = !!(String(process.env.TCB_SECRET_ID || '').trim() && String(process.env.TCB_SECRET_KEY || '').trim());
  const bucket = String(process.env.TCB_BUCKET || '').trim();
  const region = String(process.env.TCB_REGION || '').trim();
  const envId = String(process.env.TCB_ENV_ID || '').trim();
  return {
    credential: cred, envId, bucket, region,
    targetReady: !!(bucket && region),
    ready: !!(cred && bucket && region),
    hint: !cred
      ? '未配置腾讯云密钥（TCB_SECRET_ID / TCB_SECRET_KEY）'
      : (!bucket || !region)
        ? '未配置目标桶（TCB_BUCKET / TCB_REGION），请先跑 node scripts/cb-doctor.js'
        : ''
  };
}

/**
 * @param {object} opt { siteId, domain, bucket, region, prefix, concurrency }
 */
async function deploySite(opt) {
  const started = Date.now();
  const siteId = String(opt.siteId || '').trim();
  if (!siteId) {
    const e = new Error('缺少站点 ID'); e.code = 'NO_SITE'; throw e;
  }

  const domain = cleanDomain(opt.domain || process.env.TCB_SITE_DOMAIN || '');
  if (!domain) {
    const e = new Error('缺少目标域名（请求体 domain，或环境变量 TCB_SITE_DOMAIN）');
    e.code = 'NO_DOMAIN';
    throw e;
  }

  const bucket = String(opt.bucket || process.env.TCB_BUCKET || '').trim();
  const region = String(opt.region || process.env.TCB_REGION || '').trim();
  if (!bucket || !region) {
    const e = new Error('未配置目标桶：请在 .env.local 补 TCB_BUCKET / TCB_REGION（跑 cb-doctor.js 可得）');
    e.code = 'NO_TARGET';
    throw e;
  }

  /* 1. 导出 —— 顺带把旧域名全部换成本次目标域，避免 sitemap 指向死链 */
  const ex = exportSite({ siteId, targetDomain: domain, zip: false });

  /* 2. 上传 —— 目录整体推上去，覆盖同名对象（用户选的是覆盖当前站点） */
  const up = await cb.uploadDir({
    dir: ex.dir,
    bucket,
    region,
    prefix: opt.prefix,
    concurrency: opt.concurrency
  });

  const out = {
    siteId,
    brand: ex.brand,
    domain,
    retargeted: ex.hits,
    files: ex.files,
    total: up.total,
    uploaded: up.uploaded,
    failed: up.failed,
    failures: up.failures,
    bytes: up.bytes,
    ms: Date.now() - started
  };

  if (up.failed > 0) {
    const e = new Error('上传部分失败：' + up.failed + '/' + up.total + ' 个文件未成功');
    e.code = 'PARTIAL_FAILED';
    e.detail = out;
    throw e;
  }
  return out;
}

module.exports = { deploySite, status };
