'use strict';
/* =========================================================
   config.js — 环境变量收口与生产守卫
   ---------------------------------------------------------
   背景：这个服务有若干个「本地开发才该开」的开关
     QA_MODE              暴露 .build 静态目录 + /v1/qa/report 测试后门
     ALLOW_LOCAL_COLLECT  上游未接时用手写模拟数据冒充采集结果
     ALLOW_LOCAL_GEO      同上，GEO 关键词监测
   它们一旦被带上生产，功能看起来完全正常，但对外输出的是假数据 ——
   这是本系统最危险的一类故障，因为它不会报错。

   所以这里做两件事：
     1) snapshot()  把「当前环境是否安全」做成可查询、可展示的结构
     2) enforce()   在 NODE_ENV=production 且存在阻断项时**拒绝启动**
        （除非显式设置 ALLOW_INSECURE_BOOT=1 —— 那时仍会强制关掉
          QA_MODE 测试后门，因为那不是业务选择而是攻击面）

   开发模式下同样的检查只作为「告警」返回，不拦截启动，
   这样 /v1/health 与设置页的运行状态卡能长期提示，而不影响本地调试。
   ========================================================= */

const os = require('os');

/* 认定为「已开启」的真值写法 */
function truthy(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function isProduction() {
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

/** 敏感值脱敏：只保留长度与首尾，绝不回显完整令牌 */
function mask(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return s.slice(0, 3) + '****' + s.slice(-2) + '(' + s.length + '位)';
}

const FLAG_META = {
  QA_MODE: {
    label: '测试后门',
    why: 'QA_MODE=1 会把 .build 静态目录暴露到 /app 下，并开启 /v1/qa/report 上报接口',
    fix: '取消设置 QA_MODE（生产镜像里本就不该出现）'
  },
  ALLOW_LOCAL_COLLECT: {
    label: '本地模拟采集',
    why: '一条真实采集通道都没接时，用本地生成的数据冒充真实评论采集结果，会把假线索写进业务库',
    fix: '取消设置 ALLOW_LOCAL_COLLECT，改为配置任一真实通道：'
      + 'COLLECT_OFFICIAL_URL（自有内容评论区）/ COLLECT_CRAWLER_URL（自建爬虫）/ COLLECT_UPSTREAM + COLLECT_TOKEN（第三方数据服务）'
  },
  ALLOW_LOCAL_GEO: {
    label: '本地模拟监测',
    why: '上游未接通时用本地算法生成 AI 收录排名，会让「AI 曝光率」变成自说自话',
    fix: '取消设置 ALLOW_LOCAL_GEO，改为配置 GEO_UPSTREAM + GEO_TOKEN'
  },
  DEMO_MODE: {
    label: '演示模式',
    why: '演示模式会启用本地模拟采集/GEO、写入独立演示库并对外开放 /v1/demo/dataset；生产环境必须关闭',
    fix: 'DEMO_MODE=0（生产镜像默认按 NODE_ENV=production 关闭）'
  },
  GEO_NO_SEED: {
    label: '关闭 GEO 种子任务',
    why: '首次启动不会写入示例监测任务，新库页面上会是空的（非故障，仅提示）',
    fix: '生产可保留该开关；若要演示数据请临时取消设置'
  }
};

/**
 * 生成环境快照。
 * @returns {{
 *   mode:'production'|'development', production:boolean,
 *   node:string, platform:string, arch:string, pid:number,
 *   token:{set:boolean,length:number,masked:string},
 *   flags:object, upstreams:object, guard:{}},
 * }
 */
function snapshot() {
  const prod = isProduction();
  const token = String(process.env.API_TOKEN || '');
  const violations = [];

  /** 生产下阻断启动、开发下仅告警 */
  const gate = (severityWhenDev) => (prod ? 'block' : severityWhenDev);
  const add = (severity, key, message, fix) => violations.push({ severity, key, message, fix });

  /* ---- 鉴权 ---- */
  if (!token) {
    add(gate('warn'), 'API_TOKEN', '未设置 API_TOKEN，所有 /v1/* 接口无鉴权（任何人可调用、可下单、可提交渲染）',
      'API_TOKEN=$(openssl rand -hex 24)');
  } else if (token.length < 16) {
    add('warn', 'API_TOKEN', 'API_TOKEN 只有 ' + token.length + ' 位，强度不足，建议 32 位以上随机串',
      'API_TOKEN=$(openssl rand -hex 24)');
  }

  /* ---- 危险开关 ---- */
  const flags = {};
  Object.keys(FLAG_META).forEach((k) => {
    const on = truthy(process.env[k]);
    flags[k] = on;
    if (!on) return;
    const meta = FLAG_META[k];
    /* DEMO_MODE 在开发环境属正常配置，只在生产告警/阻断 */
    if (k === 'DEMO_MODE' && !prod) return;
    /* GEO_NO_SEED 不属于危险开关，只提示 */
    const sev = (k === 'GEO_NO_SEED') ? 'warn' : gate('warn');
    add(sev, k, meta.label + '：' + meta.why, meta.fix);
  });

  /* ---- 上游凭据配对 ---- */
  const up = {
    collect: String(process.env.COLLECT_UPSTREAM || ''),
    official: String(process.env.COLLECT_OFFICIAL_URL || ''),
    crawler: String(process.env.COLLECT_CRAWLER_URL || ''),
    geo: String(process.env.GEO_UPSTREAM || ''),
    pay: String(process.env.PAY_GATEWAY || ''),
    /* 配音走操作系统自带的语音合成，不需要凭据；这里只记录指定的语音名 */
    voice: String(process.env.EDIT_TTS_VOICE || '')
  };
  if (up.collect && !process.env.COLLECT_TOKEN) {
    add('warn', 'COLLECT_TOKEN', '已配置 COLLECT_UPSTREAM 但缺少 COLLECT_TOKEN，上游大概率返回 401',
      'COLLECT_TOKEN=<采集服务签发令牌>');
  }
  /* 官方开放能力必须知道自己代表哪个自有账号，否则请求会「成功但空」——
     这类故障不报错，最容易被当成「没有评论」而漏掉 */
  if (up.official && !process.env.COLLECT_OFFICIAL_OWNER) {
    add('warn', 'COLLECT_OFFICIAL_OWNER',
      '已配置 COLLECT_OFFICIAL_URL 但缺少 COLLECT_OFFICIAL_OWNER：官方开放能力无法定位自有账号，采集会返回空而不是报错',
      'COLLECT_OFFICIAL_OWNER=<自有账号标识，如抖音 open_id / 视频号 finder id>');
  }
  /* 自建爬虫走内网、通常不需要令牌，所以只在「令牌配了但没地址」时提示 */
  const multiChannel = [up.collect, up.official, up.crawler].filter(Boolean).length;
  if (multiChannel > 1 && process.env.COLLECT_DEFAULT_CHANNEL == null) {
    add('warn', 'COLLECT_DEFAULT_CHANNEL',
      '已接入 ' + multiChannel + ' 条采集通道，但未指定 COLLECT_DEFAULT_CHANNEL：任务默认按「范围 → 通道」优先级自动选择，建议显式声明以免误用',
      'COLLECT_DEFAULT_CHANNEL=auto（或 official / crawler / vendor 之一）');
  }
  if (up.geo && !process.env.GEO_TOKEN) {
    add('warn', 'GEO_TOKEN', '已配置 GEO_UPSTREAM 但缺少 GEO_TOKEN，上游大概率返回 401',
      'GEO_TOKEN=<监测服务签发令牌>');
  }
  if (up.pay && !process.env.PAY_MCH_ID) {
    add('warn', 'PAY_MCH_ID', '已配置 PAY_GATEWAY 但缺少 PAY_MCH_ID，支付回调无法对账',
      'PAY_MCH_ID=<商户号>');
  }
  /* 配音是本地能力，不需要凭据；但「指定了语音名却又整体关掉」值得提示一次 */
  if (truthy(process.env.EDIT_TTS_DISABLE) && process.env.EDIT_TTS_VOICE) {
    add('warn', 'EDIT_TTS_VOICE', '已设置 EDIT_TTS_VOICE 但同时开了 EDIT_TTS_DISABLE，配音不会生效',
      '取消 EDIT_TTS_DISABLE，或清空 EDIT_TTS_VOICE');
  }

  /* ---- 暴露面 ---- */
  const host = String(process.env.HOST || '127.0.0.1');
  if (prod && (host === '0.0.0.0' || host === '::' || host === '')) {
    if (!truthy(process.env.TRUST_PROXY)) {
      add('warn', 'HOST', '监听地址为 ' + host + '（对外可达），但未声明 TRUST_PROXY',
        '确认由 Nginx 终止 TLS 后设置 TRUST_PROXY=1，并让容器端口只绑定上游网络');
    }
  }
  if (prod && !process.env.DATA_DIR) {
    add('warn', 'DATA_DIR', '生产环境未显式指定 DATA_DIR，数据会落在镜像内的默认路径，容器重建即丢失',
      'DATA_DIR=/data 并挂载持久卷');
  }
  if (prod && !process.env.STATIC_ROOT && !process.env.APP_INDEX_DIR) {
    /* 仅提示：默认从镜像内取 index.html 是 Docker 镜像的正确形态 */
  }

  const blockers = violations.filter((v) => v.severity === 'block');
  return {
    mode: prod ? 'production' : 'development',
    production: prod,
    node: process.version,
    platform: os.platform(),
    arch: os.arch(),
    pid: process.pid,
    token: { set: !!token, length: token.length, masked: mask(token) },
    flags,
    upstreams: up,
    guard: {
      ok: blockers.length === 0,
      blocked: blockers.length,
      warnings: violations.length - blockers.length,
      violationKeys: violations.map((v) => v.key),
      violations,
      actionable: violations.map((v) => (v.fix ? v.key + ' → ' + v.fix : v.key))
    }
  };
}

/**
 * 生产守卫：不满足安全前提时抛错，由调用方决定如何终止进程。
 * @param {{allowOverride?:boolean}} [opt]
 * @returns {object} 快照（可能带 overridden 标记）
 */
function enforce(opt) {
  const s = snapshot();
  if (!s.production || s.guard.blocked === 0) return s;

  const override = (opt && opt.allowOverride) || truthy(process.env.ALLOW_INSECURE_BOOT);
  if (!override) {
    const lines = s.guard.violations
      .filter((v) => v.severity === 'block')
      .map((v) => '  ✗ ' + v.key + '：' + v.message + '\n      修复：' + v.fix);
    throw Object.assign(
      new Error('生产模式环境变量未收口，已拒绝启动。请修正以下阻断项，'
        + '或在明确接受风险时设置 ALLOW_INSECURE_BOOT=1（不推荐）：\n' + lines.join('\n')),
      { code: 'INSECURE_CONFIG', snapshot: s }
    );
  }

  /* 即便豁免，测试后门也一律关掉——它不是业务选择，是攻击面 */
  const forced = [];
  if (truthy(process.env.QA_MODE)) { process.env.QA_MODE = '0'; forced.push('QA_MODE'); }
  if (truthy(process.env.DEMO_MODE)) { process.env.DEMO_MODE = '0'; forced.push('DEMO_MODE'); }
  s.overridden = true;
  s.guard.forcedOff = forced;
  return s;
}

/** 一行式日志（启动横幅用），已脱敏。可传入 enforce() 的快照以呈现「生效后」状态 */
function summaryLines(snap) {
  const s = snap || snapshot();
  const out = [];
  out.push(' 运行模式    ' + s.mode + '（NODE_ENV=' + (process.env.NODE_ENV || '未设置') + '）· ' + s.platform + '/' + s.arch + ' · ' + s.node);
  out.push(' 鉴权令牌    ' + (s.token.set ? '已设置 ' + s.token.masked : '未设置（开放访问）'));
  if (s.overridden) {
    out.push(' ⚠ 豁免启动  已设置 ALLOW_INSECURE_BOOT=1，按现有环境继续启动'
      + (s.guard.forcedOff && s.guard.forcedOff.length
        ? '（已强制关闭测试后门：' + s.guard.forcedOff.join('、') + '）' : ''));
  }
  if (s.guard.violations.length) {
    s.guard.violations.forEach((v) => {
      out.push(' ' + (v.severity === 'block' ? '✗ 阻断' : '⚠ 告警') + '  ' + v.key + ' — ' + v.message);
    });
  } else {
    out.push(' 安全自检    通过（无阻断项、无告警）');
  }
  return out;
}

module.exports = {
  truthy, isProduction, mask, snapshot, enforce, summaryLines, FLAG_META
};
