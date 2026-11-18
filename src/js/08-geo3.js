
/* =========================================================
   GEO 优化引擎 v3 —— 11 模块控制台前端层
   ---------------------------------------------------------
   仪表盘 / 企业身份 / 词库话题包 / 方舟创作中心 / 站点矩阵
   全域渠道分发 / 探针采集 / 报告中心 / 页面诊断 / 客户权限 / 系统设置
   兼容：保留 window.__GEO.{engines, addTask, geo.tasks}（AI秒搭建站使用）
   ========================================================= */
(function () {
  'use strict';

  var G3 = {
    mod: 'dash', bound: false, visible: false, busy: false,
    cache: {}, sel: { pack: '', word: '', asset: '', snap: '', rep: '', diag: '', tab: 'preview' }
  };

  var ENGINES = [
    { id: 'doubao', name: '豆包' }, { id: 'yuanbao', name: '腾讯元宝' },
    { id: 'wenxin', name: '文心一言' }, { id: 'tongyi', name: '通义千问' },
    { id: 'deepseek', name: 'DeepSeek' }, { id: 'kimi', name: 'Kimi' }
  ];
  var ENGINE_NAME = {};
  ENGINES.forEach(function (e) { ENGINE_NAME[e.id] = e.name; });

  var META = {
    dash: { t: '仪表盘', s: '全域指标 · 分模型看板 · 任务概览 · 告警提示' },
    org: { t: '企业身份管理', s: '标准实体 · NAP 统一库 · 品牌知识库 · sameAs 关联' },
    packs: { t: '词库 / 话题包', s: '批量导入问句 · 七维标签 · 词分区 · 词效曲线' },
    content: { t: '方舟内容创作中心', s: 'GEO 模板 · AI 生成 · 诊断打分 · 同义变体 · 人工审核' },
    sites: { t: '站点矩阵管理', s: '分站列表 · 权重标签 · 健康检测 · 收录监控' },
    channels: { t: '全域渠道分发', s: '分站 / 媒体通稿 / 自媒体 / 短视频 · 排期队列 · 发布存证' },
    probes: { t: '探针采集监测中心', s: '任务调度 · AI 回答快照 · 命中解析 · 异常日志' },
    reports: { t: '报告中心', s: '预制模板 · 定时生成 · 历史报告 · Excel 导出' },
    diag: { t: '页面诊断质检', s: '单页 / 批量体检 · 打分明细 · 整改清单' },
    tenants: { t: '客户 & 权限管理', s: '套餐配额 · 子账号 · 交付记录' },
    settings: { t: '系统设置', s: '模型网关 · 渠道密钥 · 告警通知 · 存储与水印' }
  };

  var STYLE_LIST = ['专业', '干货', '深度', '轻松', '故事'];
  var ASSET_STATUS = { draft: '待审核', approved: '已审核', rejected: '已驳回', published: '已发布', superseded: '旧版' };
  var KIND = {
    subsite: { n: '自有分站', c: '#0891B2', i: 'i-globe' },
    media: { n: '媒体通稿', c: '#D97706', i: 'i-doc' },
    social: { n: '自媒体', c: '#DB2777', i: 'i-comment' },
    video: { n: '短视频', c: '#7C3AED', i: 'i-video' }
  };

  /* ---------------- 基础工具 ---------------- */
  function q(s, r) { return (r || document).querySelector(s); }
  function qa(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function ui() { return window.__UI || {}; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, kind, title) {
    var u = ui();
    if (typeof u.toast === 'function') { try { return u.toast(msg, kind || 'info', title || 'GEO 引擎'); } catch (e) {} }
    return null;
  }
  function call(path, body, opt) {
    var a = window.Api || (window.__RT && window.__RT.api);
    if (!a || typeof a.call !== 'function') return Promise.resolve({ ok: false, error: 'NO_BFF' });
    var o = Object.assign({ method: body == null ? 'GET' : 'POST', timeout: 30000 }, opt || {});
    return a.call(path, body == null ? null : body, o);
  }
  function pct(v) { return (v == null || isNaN(v)) ? '—' : (Math.round(v * 10) / 10) + '%'; }
  function num(v) { return (v == null || isNaN(v)) ? '—' : String(v); }
  function ago(ts) {
    if (!ts) return '—';
    var t = Date.parse(ts) || 0;
    if (!t) return '—';
    var d = Date.now() - t;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }
  function dshort(ts) { return String(ts || '').slice(5, 16).replace('T', ' '); }
  function avg(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }

  function loading() { return '<div class="g3-skel"></div><div class="g3-skel"></div>'; }
  function badConn(msg) {
    return '<div class="g3-card"><div class="g3-card-bd"><div class="g3-empty"><b>没连上服务端</b>' +
      esc(msg || 'BFF 未就绪或网络异常，重试一次即可。') + '<br><button class="g3-btn p" data-act="reload">重新加载</button></div></div></div>';
  }
  function emptyBox(title, sub, action) {
    return '<div class="g3-empty"><b>' + esc(title) + '</b>' + (sub ? esc(sub) : '') +
      (action ? '<br>' + action : '') + '</div>';
  }
  function tag(t, tone) { return '<span class="g3-tag ' + (tone || '') + '">' + esc(t) + '</span>'; }
  function card(title, sub, body, right) {
    return '<div class="g3-card"><div class="g3-card-hd"><h3>' + title + '</h3>' +
      (sub ? '<span class="sub">' + sub + '</span>' : '') +
      (right ? '<div class="r">' + right + '</div>' : '') +
      '</div><div class="g3-card-bd">' + body + '</div></div>';
  }
  function kpi(label, value, unit, foot, color) {
    return '<div class="g3-kpi" style="--k:' + (color || '#4A46E8') + '">' +
      '<div class="lb">' + esc(label) + '</div>' +
      '<div class="vl">' + value + (unit ? '<small>' + unit + '</small>' : '') + '</div>' +
      '<div class="ft">' + (foot || '') + '</div></div>';
  }
  function deltaTag(v) {
    if (v == null || isNaN(v)) return '<span class="g3-hint">环比 —</span>';
    var up = v >= 0;
    return '<span class="' + (up ? 'g3-up' : 'g3-down') + '">' + (up ? '▲' : '▼') + ' ' + Math.abs(v) + 'pt</span><span class="g3-hint">环比</span>';
  }
  function zoneBar(z) {
    var total = (z.advantage || 0) + (z.enemy || 0) + (z.blank || 0) + (z.risk || 0);
    if (!total) return '<div class="g3-zonebar"></div>';
    var c = { advantage: '#12a150', enemy: '#e5484d', blank: '#8E8DA5', risk: '#F5A524' };
    var h = ['advantage', 'enemy', 'blank', 'risk'].map(function (k) {
      return z[k] ? '<i style="width:' + (z[k] / total * 100) + '%;background:' + c[k] + '"></i>' : '';
    }).join('');
    return '<div class="g3-zonebar">' + h + '</div>';
  }
  function lineChart(trend, keys, height) {
    var w = 680, h = height || 168, pad = { l: 32, r: 10, t: 10, b: 20 };
    var n = trend.length || 1;
    function X(i) { return pad.l + (w - pad.l - pad.r) * (n <= 1 ? 0 : i / (n - 1)); }
    function Y(v) { return pad.t + (h - pad.t - pad.b) * (1 - Math.max(0, Math.min(100, v)) / 100); }
    var g = '';
    for (var i = 0; i <= 4; i++) {
      var gy = Y(i * 25);
      g += '<line x1="' + pad.l + '" y1="' + gy.toFixed(1) + '" x2="' + (w - pad.r) + '" y2="' + gy.toFixed(1) + '" stroke="#EEF1FA" stroke-width="1"/>' +
        '<text x="' + (pad.l - 6) + '" y="' + (gy + 3.5).toFixed(1) + '" font-size="9" fill="#8E8DA5" text-anchor="end">' + (i * 25) + '</text>';
    }
    var body = '';
    keys.forEach(function (k, ki) {
      var pts = trend.map(function (t, idx) { return X(idx).toFixed(1) + ',' + Y(t[k.key] || 0).toFixed(1); }).join(' ');
      body += '<polygon points="' + X(0).toFixed(1) + ',' + Y(0).toFixed(1) + ' ' + pts + ' ' + X(n - 1).toFixed(1) + ',' + Y(0).toFixed(1) +
        '" fill="' + k.c + '" opacity=".07"/>';
      body += '<polyline points="' + pts + '" fill="none" stroke="' + k.c + '" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>';
    });
    var labels = '';
    [0, Math.floor((n - 1) / 2), n - 1].forEach(function (idx) {
      if (idx < 0 || !trend[idx]) return;
      labels += '<text x="' + X(idx).toFixed(1) + '" y="' + (h - 5) + '" font-size="9" fill="#8E8DA5" text-anchor="middle">' + esc(trend[idx].day) + '</text>';
    });
    return '<svg class="g3-chart" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' + g + body + labels + '</svg>';
  }
  function donut(parts, center) {
    var total = parts.reduce(function (s, p) { return s + p.v; }, 0) || 1;
    var acc = 0;
    var stops = parts.map(function (p) {
      var a = acc / total * 360, b = (acc + p.v) / total * 360;
      acc += p.v;
      return p.c + ' ' + a.toFixed(2) + 'deg ' + b.toFixed(2) + 'deg';
    }).join(',');
    return '<div class="g3-donut" style="background:conic-gradient(' + stops + ')"><span>' + center + '</span></div>';
  }
  function barRow(label, value, max, color) {
    var w = max ? Math.min(100, value / max * 100) : 0;
    return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0">' +
      '<div style="width:62px;font-size:11.5px;color:var(--text-2);flex:none">' + esc(label) + '</div>' +
      '<div class="g3-prog" style="flex:1"><i style="width:' + w.toFixed(1) + '%;background:' + (color || 'linear-gradient(90deg,#4A46E8,#7C3AED)') + '"></i></div>' +
      '<div style="width:44px;text-align:right;font-size:11.5px;font-weight:700;font-variant-numeric:tabular-nums">' + value + '</div></div>';
  }

  /* ---------------- 1 仪表盘 ---------------- */
  function viewDash() {
    var d = G3.cache.dash;
    if (!d) return loading();
    if (d.__err) return badConn(d.__err);

    var t = d.trend || [];
    var kMention = deltaOf(t, 'mentionRate'), kFirst = deltaOf(t, 'firstRate');
    var kpis = '<div class="g3-kpis">' +
      kpi('品牌提及率', pct(d.all.mentionRate), '', deltaTag(kMention), '#4A46E8') +
      kpi('首推率（第 1 位）', pct(d.all.firstRate), '', deltaTag(kFirst), '#7C3AED') +
      kpi('TOP3 推荐率', pct(d.all.top3Rate), '', '<span class="g3-hint">样本 ' + num(d.all.total) + ' 条</span>', '#0891B2') +
      kpi('情感得分', num(d.all.sentiment), '分', '<span class="g3-hint">正向占比折算</span>', '#059669') +
      kpi('竞品占比', pct(d.all.compShare), '', '<span class="g3-hint">竞品命中 / 总命中</span>', '#E11D48') +
      '</div>';

    var trendCard = card('提及率 / 首推率趋势', '近 ' + d.rangeDays + ' 天',
      (d.all.total ? lineChart(t, [{ key: 'mentionRate', c: '#4A46E8' }, { key: 'firstRate', c: '#F5A524' }]) +
        '<div class="g3-legend"><span><i style="background:#4A46E8"></i>提及率</span><span><i style="background:#F5A524"></i>首推率</span></div>'
        : emptyBox('还没有探针数据', '接入监测上游后自动汇聚，或先载入示例数据看大盘效果。', '<button class="g3-btn p" data-act="seed">载入示例数据</button>')));

    var modelRows = (d.models || []).map(function (m) {
      return barRow(m.name, m.mentionRate, 100, 'linear-gradient(90deg,#4A46E8,#7C3AED)')
        .replace('<div style="width:44px;text-align:right;font-size:11.5px;font-weight:700;font-variant-numeric:tabular-nums">' + m.mentionRate + '</div>',
          '<div style="width:56px;text-align:right;font-size:11.5px;font-weight:700">' + m.mentionRate + '%<span style="font-weight:400;color:var(--text-3)"> · ' + m.total + '</span></div>');
    }).join('');
    var modelCard = card('分模型看板', '各 AI 引擎独立统计', '<div class="g3-rows">' + (modelRows || emptyBox('暂无模型数据')) + '</div>');

    var zones = d.zones || {};
    var zoneParts = [
      { v: zones.advantage || 0, c: '#12a150', n: '优势区' },
      { v: zones.enemy || 0, c: '#e5484d', n: '敌占区' },
      { v: zones.blank || 0, c: '#C7CBDE', n: '空白区' },
      { v: zones.risk || 0, c: '#F5A524', n: '风险区' }
    ];
    var zoneTotal = zoneParts.reduce(function (s, p) { return s + p.v; }, 0);
    var zoneCard = card('词分区分布', '共 ' + zoneTotal + ' 个问句',
      '<div class="g3-donut-wrap">' + donut(zoneParts, zoneTotal) +
      '<div style="flex:1;min-width:120px">' + zoneParts.map(function (p) {
        return '<div style="display:flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 0">' +
          '<i style="width:8px;height:8px;border-radius:3px;background:' + p.c + '"></i>' +
          '<span style="flex:1;color:var(--text-2)">' + p.n + '</span><b>' + p.v + '</b></div>';
      }).join('') + '</div></div>');

    var tk = d.tasks || {};
    var taskCard = card('任务概览', '待办与风险', '<div class="g3-kpis" style="grid-template-columns:repeat(2,1fr)">' +
      kpi('待采集问句', tk.pendingCollect || 0, '', '<span class="g3-hint">词包内未跑过</span>', '#0EA5E9') +
      kpi('待审核内容', tk.pendingAudit || 0, '', '<span class="g3-hint">草稿未过审</span>', '#D97706') +
      kpi('待发布任务', tk.pendingPublish || 0, '', '<span class="g3-hint">队列中</span>', '#4A46E8') +
      kpi('失效信源', (tk.brokenSites || 0) + (tk.failedPublish || 0), '', '<span class="g3-hint">站点异常 + 发布失败</span>', '#e5484d') +
      '</div>');

    var alerts = (d.alerts || []).map(function (a) {
      var c = a.lv === 'err' ? '#e5484d' : a.lv === 'warn' ? '#F5A524' : '#4A46E8';
      return '<div style="display:flex;gap:8px;align-items:flex-start;padding:7px 0;border-bottom:1px dashed var(--border-2);font-size:12px;line-height:1.55">' +
        '<i style="width:7px;height:7px;border-radius:50%;background:' + c + ';margin-top:6px;flex:none"></i><div style="flex:1">' + esc(a.text) + '</div></div>';
    }).join('');
    var alertCard = card('告警与提示', '', alerts || emptyBox('一切正常', '暂无需要处理的告警。'));

    var packRows = (d.packs || []).slice(0, 6).map(function (p) {
      return '<div class="g3-row"><div class="m"><b>' + esc(p.name) + '</b><span>' + p.words + ' 问句 · 命中 ' + p.hitWords +
        ' · ' + (p.monitoring ? '监测中' : '已暂停') + '</span></div>' +
        '<div style="width:90px">' + '<div class="g3-prog"><i style="width:' + p.coverage + '%"></i></div></div>' +
        '<div style="width:44px;text-align:right;font-weight:700;font-size:12px">' + p.coverage + '%</div></div>';
    }).join('');
    var packCard = card('词包状态', '覆盖 = 有品牌命中的问句占比',
      '<div class="g3-rows">' + (packRows || emptyBox('还没有词包', '导入 Excel/文本问句，才有可监测的对象。',
        '<button class="g3-btn p" data-g3="packs">去导入词包</button>')) + '</div>');

    return kpis +
      '<div class="g3-grid2">' + trendCard + modelCard + '</div>' +
      '<div class="g3-grid2 even">' + zoneCard + taskCard + '</div>' +
      '<div class="g3-grid2">' + alertCard + packCard + '</div>';
  }
  function deltaOf(t, key) {
    if (!t || t.length < 8) return null;
    var a = avg(t.slice(-7).map(function (x) { return x[key] || 0; }));
    var b = avg(t.slice(-14, -7).map(function (x) { return x[key] || 0; }));
    if (!b) return null;
    return Math.round((a - b) * 10) / 10;
  }

  /* ---------------- 2 企业身份 ---------------- */
  function viewOrg() {
    var d = G3.cache.org;
    if (!d) return loading();
    if (d.__err) return badConn(d.__err);
    var o = d.org || {};
    var issues = (d.consistency && d.consistency.issues) || [];
    var cons = d.consistency || { checked: 0, ok: true };

    var form = '<div class="g3-form">' +
      '<label class="g3-fld">企业全称<input id="g3oCompany" value="' + esc(o.company || '') + '" placeholder="营业执照口径的全称"></label>' +
      '<label class="g3-fld">品牌名（AI 答案要出现）<input id="g3oBrand" value="' + esc(o.brand || '') + '" placeholder="对外统一品牌名"></label>' +
      '<label class="g3-fld">品牌词（逗号分隔，用于命中判定）<input id="g3oKeys" value="' + esc((o.brandKeys || []).join(', ')) + '" placeholder="品牌A,品牌A科技"></label>' +
      '<label class="g3-fld">统一电话（NAP）<input id="g3oPhone" value="' + esc(o.phone || '') + '" placeholder="全网唯一的对外电话"></label>' +
      '<label class="g3-fld full">统一地址（NAP）<input id="g3oAddress" value="' + esc(o.address || '') + '" placeholder="省市区+详细地址，与地图/百科保持一致"></label>' +
      '<label class="g3-fld">服务区域<input id="g3oArea" value="' + esc(o.serviceArea || '') + '" placeholder="如：杭州、苏州、上海"></label>' +
      '<label class="g3-fld">主营类目<input id="g3oBiz" value="' + esc(o.mainBusiness || '') + '" placeholder="如：高端女装定制"></label>' +
      '<label class="g3-fld full">核心卖点（逗号或换行分隔）<textarea id="g3oSell" placeholder="自有工厂, 7 天交付, 免费打样">' + esc((o.sellingPoints || []).join(', ')) + '</textarea></label>' +
      '<label class="g3-fld full">sameAs 关联阵地（每行一个：官网/百科/自媒体主页）<textarea id="g3oSame" placeholder="https://www.example.com&#10;https://baike.baidu.com/item/xxx">' + esc((o.sameAs || []).join('\n')) + '</textarea></label>' +
      '<label class="g3-fld full">分站主域名<input id="g3oSub" value="' + esc(o.subsiteUrl || '') + '" placeholder="https://sub.example.com"></label>' +
      '</div><div style="margin-top:10px;display:flex;gap:8px;align-items:center">' +
      '<button class="g3-btn p" data-act="orgSave">保存标准实体</button>' +
      '<span class="g3-hint">全网统一口径，解决实体冲突导致的降权</span></div>';

    var kb = (d.kb || []).map(function (k) {
      return '<div class="g3-row"><div class="m"><b>' + esc(k.name) + '</b><span>' + esc(k.type) + ' · ' + (k.text ? k.text.length + ' 字' : '无正文') + ' · ' + ago(k.at) + '</span></div>' +
        '<button class="g3-btn sm" data-act="kbDel" data-id="' + esc(k.id) + '">删除</button></div>';
    }).join('');

    var consList = issues.length ? issues.slice(0, 8).map(function (i) {
      return '<div class="g3-check no"><div class="ic">!</div><div class="tx"><b>' + esc(i.word || '') + '</b> ' + esc(i.detail) + '<em>' + (i.type === 'phone' ? '电话不一致' : '实体名疑似不一致') + ' · ' + ago(i.at) + '</em></div></div>';
    }).join('') : '<div class="g3-check ok"><div class="ic">✓</div><div class="tx">已检查 ' + (cons.checked || 0) + ' 篇资产页，未发现实体信息冲突。<em>每篇内容发布前都会复检</em></div></div>';

    return '<div class="g3-grid2">' +
      card('企业实体 · NAP 统一库', '品牌全称 / 简称 / 地址 / 电话 / 服务区域 / 主营', form) +
      card('品牌知识库', '产品手册 / 工艺资料 / 实拍素材 / 证书，供内容生产', 
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">' +
        '<input type="file" id="g3KbFile" accept=".txt,.md,.csv,.json,.html" style="font-size:11.5px;flex:1;min-width:160px">' +
        '<button class="g3-btn" data-act="kbUpload">上传入库</button></div>' +
        '<div class="g3-hint" style="margin-bottom:8px">文本类文件会解析正文供大模型引用；其它格式仅登记名称。</div>' +
        '<div class="g3-rows">' + (kb || emptyBox('知识库为空', '上传产品手册或工艺资料，生成内容会更贴合业务。')) + '</div>') +
      '</div>' +
      '<div class="g3-grid2 even">' +
      card('实体一致性校验', '全网稿件里的名称 / 电话是否出现多个版本',
        '<div style="margin-bottom:8px">' + (cons.ok ? tag('通过', 'ok') : tag(issues.length + ' 处冲突', 'bad')) + '</div>' + consList) +
      card('多阵地关联（sameAs）', '构建知识图谱关联信号',
        (o.sameAs && o.sameAs.length ? o.sameAs.map(function (u) {
          return '<div class="g3-row"><div class="m"><b>' + esc(u) + '</b><span>' + (/baike|wiki/i.test(u) ? '百科' : /weibo|zhihu|douyin|xhs/i.test(u) ? '自媒体' : '官网 / 其他') + '</span></div></div>';
        }).join('') : emptyBox('尚未绑定关联阵地', '在上方表单填写官网、百科、自媒体主页，一行一个。'))) +
      '</div>';
  }

  /* ---------------- 3 词库 / 话题包 ---------------- */
  function viewPacks() {
    var d = G3.cache.packs;
    if (!d) return loading();
    if (d.__err) return badConn(d.__err);
    var packs = d.packs || [];
    if (!packs.length) {
      return card('导入第一个词包', '每行一条问句，可选「,热度,意图」', packImportForm() +
        emptyBox('还没有词包', '把用户真实会问 AI 的问题粘进来，系统自动归入优势/敌占/空白/风险区。'));
    }
    var sel = packs.filter(function (p) { return p.id === G3.sel.pack; })[0] || packs[0];
    G3.sel.pack = sel.id;
    var list = packs.map(function (p) {
      return '<div class="g3-item' + (p.id === sel.id ? ' on' : '') + '" data-act="pickPack" data-id="' + esc(p.id) + '">' +
        '<div class="t">' + esc(p.name) + '</div>' +
        '<div class="s">' + tag(p.count + ' 问句', 'info') + (p.monitoring ? tag('监测中', 'ok') : tag('已暂停', 'gray')) + '</div>' +
        zoneBar(p.zones) + '</div>';
    }).join('');

    var words = (sel.words || []).map(function (w) {
      var tone = w.zone === 'advantage' ? 'ok' : w.zone === 'enemy' ? 'bad' : w.zone === 'risk' ? 'warn' : 'gray';
      return '<tr><td class="w">' + esc(w.word) + '</td><td>' + tag(w.zoneLabel, tone) + '</td>' +
        '<td class="num">' + (w.heat || 0) + '</td><td class="num">' + w.hits + '/' + w.total + '</td>' +
        '<td style="text-align:right"><button class="g3-btn sm" data-act="wordTrend" data-word="' + esc(w.word) + '">词效</button></td></tr>';
    }).join('');

    var trend = G3.cache.wordTrend;
    var trendBox = '';
    if (trend && trend.word) {
      trendBox = card('词效曲线 · ' + esc(trend.word), '提及率 / 首推率（近 14 天）',
        lineChart(trend.trend, [{ key: 'mention', c: '#4A46E8' }, { key: 'first', c: '#F5A524' }], 140) +
        '<div class="g3-legend"><span><i style="background:#4A46E8"></i>被提及</span><span><i style="background:#F5A524"></i>首推</span></div>');
    }

    return '<div class="g3-split" style="grid-template-columns:280px minmax(0,1fr)">' +
      '<div style="display:flex;flex-direction:column;gap:10px">' +
      card('词包分组', packs.length + ' 个', '<div class="g3-list">' + list + '</div>',
        '<button class="g3-btn sm" data-act="toggleImport">导入</button>') +
      (G3.sel.importing ? card('导入词包', '', packImportForm()) : '') +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:12px">' +
      card(esc(sel.name), '七维标签 · 词分区 · 单条词效', 
        '<div class="g3-tbl g3-scroll"><table class="g3-tbl"><thead><tr><th>问句</th><th>分区</th><th class="num">热度</th><th class="num">命中</th><th></th></tr></thead><tbody>' +
        (words || '<tr><td colspan="5">' + emptyBox('该词包还没有词') + '</td></tr>') + '</tbody></table></div>' +
        '<div class="g3-legend" style="margin-top:8px"><span><i style="background:#12a150"></i>优势区</span><span><i style="background:#e5484d"></i>敌占区</span>' +
        '<span><i style="background:#C7CBDE"></i>空白区</span><span><i style="background:#F5A524"></i>风险区</span></div>',
        '<button class="g3-btn sm" data-act="packToggle" data-id="' + esc(sel.id) + '">' + (sel.monitoring ? '暂停监测' : '恢复监测') + '</button>' +
        '<button class="g3-btn sm" data-act="packCopy" data-id="' + esc(sel.id) + '">复制</button>' +
        '<button class="g3-btn sm" data-act="packDel" data-id="' + esc(sel.id) + '">删除</button>') +
      trendBox +
      '</div></div>';
  }
  function packImportForm() {
    return '<div class="g3-form" style="grid-template-columns:1fr">' +
      '<label class="g3-fld">词包名称<input id="g3PackName" placeholder="如：杭州婚纱摄影 · 成交词"></label>' +
      '<label class="g3-fld">问句（每行一条，可写「问句,热度,意图」）<textarea id="g3PackText" rows="6" placeholder="杭州婚纱摄影哪家好,88,成交&#10;杭州拍婚纱照多少钱,72,成交"></textarea></label>' +
      '</div><div style="margin-top:8px;display:flex;gap:8px"><button class="g3-btn p" data-act="packImport">导入并分类</button>' +
      '<span class="g3-hint">自动按问句语义打标签，导入后即可分配监测</span></div>';
  }

  /* ---------------- 4 方舟内容创作中心 ---------------- */
  function viewContent() {
    var d = G3.cache.content;
    if (!d) return loading();
    if (d.__err) return badConn(d.__err);
    var assets = (d.assets || []).slice();
    var cur = assets.filter(function (a) { return a.id === G3.sel.asset; })[0] || assets[0];
    if (cur) G3.sel.asset = cur.id;

    var packs = (G3.cache.packs && G3.cache.packs.packs) || [];
    var wordOpts = '';
    packs.forEach(function (p) {
      (p.words || []).slice(0, 60).forEach(function (w) {
        wordOpts += '<option value="' + esc(w.word) + '">' + esc(w.word) + '</option>';
      });
    });

    var gen = '<div class="g3-form" style="grid-template-columns:1.4fr .8fr auto;align-items:end">' +
      '<label class="g3-fld">目标问句<input id="g3GenWord" list="g3WordList" placeholder="输入或选择词包里的问句">' +
      '<datalist id="g3WordList">' + wordOpts + '</datalist></label>' +
      '<label class="g3-fld">内容风格<select id="g3GenStyle">' + STYLE_LIST.map(function (s) { return '<option>' + s + '</option>'; }).join('') + '</select></label>' +
      '<button class="g3-btn p" data-act="genAsset">AI 生成资产页</button></div>' +
      '<div class="g3-hint" style="margin-top:6px">未配置大模型时走内置模板：结构、Answer 块、参数表格、FAQ 一个不少。</div>';

    var list = assets.map(function (a) {
      var s = a.qa ? a.qa.score : 0;
      var tone = s >= 85 ? 'ok' : s >= 70 ? 'info' : 'warn';
      return '<div class="g3-item' + (cur && a.id === cur.id ? ' on' : '') + '" data-act="pickAsset" data-id="' + esc(a.id) + '">' +
        '<div class="t">' + esc(a.title) + '</div>' +
        '<div class="s">' + tag(ASSET_STATUS[a.status] || a.status, a.status === 'published' ? 'ok' : a.status === 'draft' ? 'warn' : 'info') +
        tag(s + ' 分', tone) + '<span>' + esc(a.word) + '</span></div></div>';
    }).join('');

    var detail = '';
    if (!cur) {
      detail = card('资产页编辑器', '没有内容时先在上方生成', emptyBox('还没有资产页', '选一个问句生成第一篇。'));
    } else {
      var tab = G3.sel.tab || 'preview';
      var preview = G3.cache.preview && G3.cache.preview.assetId === cur.id ? G3.cache.preview : null;
      var body = '';
      if (tab === 'preview') {
        var paras = String(cur.content || '').split(/\n\s*\n/).filter(Boolean);
        body = '<div class="g3-paper"><h1>' + esc(cur.title) + '</h1>' +
          paras.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') +
          ((cur.sources || []).length ? '<div class="g3-hint" style="border-top:1px dashed var(--border);padding-top:10px">信源：' + esc(cur.sources.join('；')) + '</div>' : '') +
          '</div>';
      } else if (tab === 'crawler') {
        body = preview
          ? '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">' +
            tag(preview.stats.chars + ' 字', 'info') + tag(preview.stats.paras + ' 段', 'info') +
            (preview.stats.answerBlock ? tag('Answer 块 ✓', 'ok') : tag('缺 Answer 块', 'warn')) +
            (preview.stats.hasNumbers ? tag('含量化数据', 'ok') : tag('缺量化数据', 'warn')) + '</div>' +
            '<div class="g3-mono">' + esc(preview.crawlerText) + '</div>'
          : '<button class="g3-btn" data-act="previewAsset" data-id="' + esc(cur.id) + '">模拟爬虫抓取</button>';
      } else if (tab === 'qa') {
        var qa = cur.qa || { score: 0, dims: {}, issues: [] };
        var dims = qa.dims || {};
        body = '<div class="g3-score">' +
          '<div class="ring" style="background:conic-gradient(#4A46E8 ' + (qa.score * 3.6) + 'deg,#EEF0FA 0)"><b>' + qa.score + '<small>分</small></b></div>' +
          '<div style="flex:1;min-width:180px">' +
          ['structure:结构化', 'trust:可信度', 'quotable:可引用性', 'sources:信源'].map(function (p) {
            var kv = p.split(':');
            return barRow(kv[1], dims[kv[0]] || 0, 100);
          }).join('') + '</div></div>' +
          ((qa.issues || []).length ? '<div style="margin-top:10px">' + qa.issues.map(function (i) {
            return '<div class="g3-check no"><div class="ic">!</div><div class="tx">' + esc(i) + '</div></div>';
          }).join('') + '</div>' : '<div class="g3-hint" style="margin-top:10px">未发现明显扣分项。</div>');
      } else if (tab === 'variants') {
        var vs = cur.variants || [];
        body = vs.length ? vs.map(function (v) {
          return '<div class="g3-item" style="cursor:default;margin-bottom:6px"><div class="t">' + esc(v.title) + '</div>' +
            '<div class="s">' + tag('变体 ' + v.variant, 'info') + tag((v.qa && v.qa.score || 0) + ' 分', 'ok') + '</div>' +
            '<div class="g3-hint" style="margin-top:5px;max-height:62px;overflow:hidden">' + esc(String(v.content).slice(0, 180)) + '…</div></div>';
        }).join('') : emptyBox('还没有变体', '同一问句生成多版差异化内容，分发到不同分站规避同质化。',
          '<button class="g3-btn p" data-act="genVariants" data-id="' + esc(cur.id) + '">生成 3 版变体</button>');
      }
      detail = card('资产页编辑器', esc(cur.word) + ' · v' + (cur.rev || 1) + ' · ' + (ASSET_STATUS[cur.status] || cur.status),
        '<div class="g3-tabs">' +
        ['preview:预览', 'crawler:爬虫视角', 'qa:诊断打分', 'variants:同义变体'].map(function (t) {
          var kv = t.split(':');
          return '<button class="g3-tab' + (tab === kv[0] ? ' on' : '') + '" data-act="tab" data-tab="' + kv[0] + '">' + kv[1] + '</button>';
        }).join('') + '</div>' + body,
        (cur.status === 'draft' || cur.status === 'rejected'
          ? '<button class="g3-btn sm p" data-act="audit" data-id="' + esc(cur.id) + '" data-pass="1">审核通过</button>' +
            '<button class="g3-btn sm" data-act="audit" data-id="' + esc(cur.id) + '" data-pass="0">驳回</button>'
          : '<button class="g3-btn sm" data-act="rewrite" data-id="' + esc(cur.id) + '">回炉重写</button>') +
        '<button class="g3-btn sm" data-act="genVariants" data-id="' + esc(cur.id) + '">生成变体</button>');
    }

    return card('AI 生成', '万象垂类大模型 · 模板兜底', gen) +
      '<div class="g3-split">' + card('资产页列表', assets.length + ' 篇', '<div class="g3-list">' + (list || emptyBox('还没有内容')) + '</div>') + detail + '</div>';
  }

  /* ---------------- 5 站点矩阵 ---------------- */
  function viewSites() {
    var d = G3.cache.sites;
    if (!d) return loading();
    if (d.__err) return badConn(d.__err);
    var sites = d.sites || [];
    var rows = sites.map(function (s) {
      var st = s.status || {};
      var dot = st.ok === true ? '#12a150' : st.ok === false ? '#e5484d' : '#C7CBDE';
      var wt = { core: ['核心阵地', 'ok'], aux: ['辅助阵地', 'info'], backup: ['备用阵地', 'gray'] }[s.weight] || ['辅助阵地', 'gray'];
      return '<tr><td><b style="font-size:12.5px">' + esc(s.name) + '</b><div class="g3-hint">' + esc(s.url) + '</div></td>' +
        '<td>' + tag(s.type === 'industry' ? '行业站' : '城市站', 'gray') + '</td>' +
        '<td>' + esc(s.group || '默认') + '</td>' +
        '<td>' + tag(wt[0], wt[1]) + '</td>' +
        '<td><span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px"><i style="width:7px;height:7px;border-radius:50%;background:' + dot + '"></i>' +
        esc(st.msg || '未检测') + (st.ms ? ' <span class="g3-hint">' + st.ms + 'ms</span>' : '') + '</span></td>' +
        '<td style="text-align:right;white-space:nowrap">' +
        '<button class="g3-btn sm" data-act="checkSite" data-id="' + esc(s.id) + '">检测</button> ' +
        '<button class="g3-btn sm" data-act="delSite" data-id="' + esc(s.id) + '">删除</button></td></tr>';
    }).join('');

    var form = '<div class="g3-form">' +
      '<label class="g3-fld">站点名称<input id="g3sName" placeholder="如：杭州站"></label>' +
      '<label class="g3-fld">站点地址<input id="g3sUrl" placeholder="https://hz.example.com"></label>' +
      '<label class="g3-fld">类型<select id="g3sType"><option value="city">城市分站</option><option value="industry">行业分站</option></select></label>' +
      '<label class="g3-fld">分组<input id="g3sGroup" placeholder="华东 / 垂类"></label>' +
      '<label class="g3-fld">权重标签<select id="g3sWeight"><option value="core">核心阵地</option><option value="aux" selected>辅助阵地</option><option value="backup">备用阵地</option></select></label>' +
      '<label class="g3-fld">发布 API 密钥（可选）<input id="g3sKey" placeholder="站点对接用的 token"></label>' +
      '</div><div style="margin-top:8px"><button class="g3-btn p" data-act="addSite">新增站点</button></div>';

    return card('分站列表', sites.length + ' 个站点',
      '<div class="g3-scroll"><table class="g3-tbl"><thead><tr><th>站点</th><th>类型</th><th>分组</th><th>权重</th><th>健康</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6">' + emptyBox('还没有站点', '先新增城市分站，内容才有落地的自有阵地。') + '</td></tr>') +
      '</tbody></table></div>') +
      card('新增分站', '批量建站后即可分配内容投放权限', form);
  }

  /* ---------------- 6 全域渠道分发 ---------------- */
  function viewChannels() {
    var d = G3.cache.channels;
    if (!d) return loading();
    if (d.__err) return badConn(d.__err);
    var chans = d.channels || [];
    var groups = ['subsite', 'media', 'social', 'video'].map(function (k) {
      var items = chans.filter(function (c) { return c.kind === k; });
      var body = items.length ? items.map(function (c) {
        return '<div class="g3-chan-i"><span class="nm">' + esc(c.name) + '</span>' +
          (c.status === 'active' ? tag('已授权', 'ok') : tag('待授权', 'warn')) +
          '<button class="g3-btn sm" data-act="chanAuth" data-id="' + esc(c.id) + '" data-on="' + (c.status === 'active' ? '0' : '1') + '">' +
          (c.status === 'active' ? '停用' : '授权') + '</button>' +
          '<button class="g3-btn sm" data-act="delChan" data-id="' + esc(c.id) + '">×</button></div>';
      }).join('') : '<div class="g3-hint" style="padding:4px 0">暂无渠道</div>';
      return '<div class="g3-chan-g"><h4><i style="background:' + KIND[k].c + '"><svg class="icon"><use href="#' + KIND[k].i + '"/></svg></i>' + KIND[k].n +
        '<span class="g3-hint" style="margin-left:auto">' + items.length + '</span></h4><div class="g3-chan-l">' + body + '</div></div>';
    }).join('');

    var addForm = '<div class="g3-form" style="grid-template-columns:1fr 1.2fr 1fr 1fr auto;align-items:end">' +
      '<label class="g3-fld">类型<select id="g3cKind">' + Object.keys(KIND).map(function (k) { return '<option value="' + k + '">' + KIND[k].n + '</option>'; }).join('') + '</select></label>' +
      '<label class="g3-fld">渠道名称<input id="g3cName" placeholder="如：中国网 · 生活频道"></label>' +
      '<label class="g3-fld">账号 / 媒体位<input id="g3cAccount" placeholder="账号或媒体位 ID"></label>' +
      '<label class="g3-fld">单价（元）<input id="g3cPrice" type="number" min="0" placeholder="0"></label>' +
      '<button class="g3-btn p" data-act="addChan">新增渠道</button></div>';

    var assets = ((G3.cache.assets && G3.cache.assets.assets) || []).filter(function (a) { return a.status === 'approved'; });
    var assetOpts = assets.map(function (a) {
      return '<option value="' + esc(a.id) + '">' + esc(a.word) + ' · ' + esc(a.title).slice(0, 28) + '</option>';
    }).join('');
    var pick = chans.filter(function (c) { return c.status === 'active'; }).map(function (c) {
      return '<label style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;background:#fff;border:1px solid var(--border-2);border-radius:8px;padding:4px 8px;margin:0 6px 6px 0;cursor:pointer">' +
        '<input type="checkbox" class="g3-pubchk" value="' + esc(c.id) + '" data-kind="' + esc(c.kind) + '" data-name="' + esc(c.name) + '">' + esc(c.name) + '</label>';
    }).join('');

    var publishPanel = card('一键发布', '仅「已审核」资产可入队；勾选渠道后错峰排期',
      (assets.length && pick
        ? '<div class="g3-form" style="grid-template-columns:1.4fr 1fr auto;align-items:end">' +
          '<label class="g3-fld">选择资产<select id="g3PubAsset">' + assetOpts + '</select></label>' +
          '<label class="g3-fld">排期时间<input id="g3PubAt" type="datetime-local"></label>' +
          '<button class="g3-btn p" data-act="doPublish">提交发布</button></div>' +
          '<div style="margin-top:9px">' + pick + '</div>' +
          '<div class="g3-hint" style="margin-top:4px">同一资产同一天不超过 3 个渠道，避免集中爆发触发风控。</div>'
        : emptyBox(assets.length ? '还没有已授权渠道' : '还没有可发布的资产',
          assets.length ? '先在上方给渠道点「授权」，或新增一个渠道。' : '先在创作中心生成并通过审核。',
          assets.length ? '' : '<button class="g3-btn p" data-g3="content">去创作中心</button>')));

    var q = (G3.cache.pubq && G3.cache.pubq.queue) || [];
    var qRows = q.map(function (x) {
      var tone = x.status === 'published' ? 'ok' : x.status === 'failed' ? 'bad' : 'warn';
      return '<tr><td class="w">' + esc(x.word) + '</td><td>' + tag(KIND[x.kind] ? KIND[x.kind].n : x.kind, 'gray') + '</td>' +
        '<td class="w">' + esc(x.name) + '</td><td>' + tag(x.status === 'published' ? '已发布' : x.status === 'failed' ? '失败' : '排队中', tone) + '</td>' +
        '<td class="w">' + esc(x.url || '—') + '</td><td>' + ago(x.at) + '</td>' +
        '<td style="text-align:right">' + (x.status !== 'published' ? '<button class="g3-btn sm" data-act="retryPub" data-id="' + esc(x.id) + '">重试</button>' : '') + '</td></tr>';
    }).join('');

    return card('渠道资源池', '自有分站 / 媒体通稿 / 自媒体 / 短视频', '<div class="g3-chan">' + groups + '</div>' +
      '<div style="margin-top:12px;border-top:1px dashed var(--border);padding-top:12px">' + addForm + '</div>') +
      publishPanel +
      card('发布队列与存证', q.length + ' 条记录',
        '<div class="g3-scroll"><table class="g3-tbl"><thead><tr><th>问句</th><th>渠道类型</th><th>渠道</th><th>状态</th><th>链接</th><th>时间</th><th></th></tr></thead><tbody>' +
        (qRows || '<tr><td colspan="7">' + emptyBox('队列为空', '发布后这里会记录每一条链接，用于交付对账。') + '</td></tr>') +
        '</tbody></table></div>');
  }

  /* ---------------- 7 探针采集监测 ---------------- */
  function viewProbes() {
    var d = G3.cache.probes;
    if (!d) return loading();
    if (d.__err) return badConn(d.__err);
    var st = d.stats || {};
    var rows = (d.rows || []).slice(0, 60).map(function (r) {
      return '<tr><td class="w">' + esc(r.word) + '</td><td>' + esc(r.pack) + '</td>' +
        '<td>' + (r.lastAt ? ago(r.lastAt) : tag('未采集', 'warn')) + '</td>' +
        '<td class="num">' + r.total + '</td>' +
        '<td style="text-align:right"><button class="g3-btn sm" data-act="runProbe" data-word="' + esc(r.word) + '">立即采集</button></td></tr>';
    }).join('');

    var snaps = (G3.cache.snaps && G3.cache.snaps.list) || [];
    var sRows = snaps.map(function (s) {
      return '<div class="g3-item' + (G3.sel.snap === s.id ? ' on' : '') + '" data-act="pickSnap" data-id="' + esc(s.id) + '" style="cursor:pointer">' +
        '<div class="t">' + esc(s.word) + '</div>' +
        '<div class="s">' + tag(ENGINE_NAME[s.model] || s.model, 'info') +
        (s.brandHit ? tag('命中 #' + (s.rank || 0), 'ok') : tag('未命中', 'gray')) +
        (s.compHit ? tag('竞品出现', 'warn') : '') + '<span>' + ago(s.at) + '</span></div></div>';
    }).join('');
    var one = snaps.filter(function (s) { return s.id === G3.sel.snap; })[0];
    var detail = one ? card('快照详情', ENGINE_NAME[one.model] || one.model,
      '<div class="g3-hint" style="margin-bottom:6px">问句：' + esc(one.word) + ' · ' + dshort(one.at) + '</div>' +
      '<div class="g3-paper" style="max-height:220px"><p>' + esc(one.answer || '（无回答正文）') + '</p></div>' +
      ((one.citations || []).length ? '<div style="margin-top:8px">' + one.citations.map(function (c) {
        return '<div class="g3-row"><div class="m"><b>' + esc(c.title || c.url) + '</b><span>' + esc(c.url) + '</span></div></div>';
      }).join('') + '</div>' : '<div class="g3-hint" style="margin-top:8px">该快照未解析到引用链接。</div>')) : '';

    return '<div class="g3-kpis">' +
      kpi('监测问句', st.words || 0, '', '<span class="g3-hint">启用中 ' + (st.monitoring || 0) + '</span>', '#0EA5E9') +
      kpi('快照总量', st.snapshots || 0, '条', '<span class="g3-hint">问句 × 模型</span>', '#4A46E8') +
      kpi('从未采集', st.neverRun || 0, '', '<span class="g3-hint">建议先跑一轮</span>', '#F5A524') +
      kpi('覆盖模型', st.models || 0, '个', '<span class="g3-hint">豆包/元宝/文心/通义/DeepSeek/Kimi</span>', '#059669') +
      '</div>' +
      '<div class="g3-grid2">' +
      card('采集任务', '按词包周期提问各联网 LLM',
        '<div class="g3-scroll"><table class="g3-tbl"><thead><tr><th>问句</th><th>词包</th><th>最近采集</th><th class="num">快照</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="5">' + emptyBox('没有监测任务', '导入词包后自动生成。') + '</td></tr>') + '</tbody></table></div>') +
      card('AI 回答快照库', '原始证据可回溯核验',
        '<div style="display:flex;gap:6px;margin-bottom:8px"><input id="g3SnapQ" placeholder="搜问句 / 回答内容" style="flex:1;border:1px solid var(--border);border-radius:9px;padding:6px 10px;font-size:12px;font-family:inherit">' +
        '<button class="g3-btn" data-act="snapSearch">搜索</button></div>' +
        '<div class="g3-list" style="max-height:300px">' + (sRows || emptyBox('暂无快照', '接入监测上游或载入示例数据后可见。')) + '</div>') +
      '</div>' + detail;
  }

  /* ---------------- 8 报告中心 ---------------- */
  function viewReports() {
    var d = G3.cache.reports;
    if (!d) return loading();
    if (d.__err) return badConn(d.__err);
    var kinds = d.kinds || [];
    var selKind = G3.sel.rep || 'brand';
    var cards = kinds.map(function (k) {
      return '<div class="g3-mini' + (k.id === selKind ? ' on' : '') + '" data-act="pickKind" data-id="' + esc(k.id) + '">' +
        '<b>' + esc(k.name) + '</b><span>' + esc(k.desc) + '</span></div>';
    }).join('');
    var list = (d.reports || []).map(function (r) {
      return '<div class="g3-row"><div class="m"><b>' + esc(r.kindName || r.kind) + '</b><span>' +
        '提及率 ' + pct(r.summary.mentionRate) + ' · 首推 ' + pct(r.summary.firstRate) + ' · 快照 ' + r.summary.snapshots + ' · ' + ago(r.at) + '</span></div>' +
        '<button class="g3-btn sm" data-act="csv" data-id="' + esc(r.id) + '">导出 Excel</button>' +
        '<button class="g3-btn sm" data-act="viewRep" data-id="' + esc(r.id) + '">查看</button></div>';
    }).join('');
    var cur = (d.reports || []).filter(function (r) { return r.id === G3.sel.repView; })[0];
    var detail = cur ? card('报告预览 · ' + esc(cur.kindName || cur.kind), dshort(cur.at),
      '<div class="g3-kpis" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">' +
      kpi('提及率', pct(cur.summary.mentionRate), '', '', '#4A46E8') +
      kpi('首推率', pct(cur.summary.firstRate), '', '', '#7C3AED') +
      kpi('TOP3', pct(cur.summary.top3Rate), '', '', '#0891B2') +
      kpi('情感分', num(cur.summary.sentiment), '', '', '#059669') +
      '</div>' +
      '<div style="margin-top:10px">' + (cur.suggestions || []).map(function (s) {
        return '<div class="g3-check"><div class="ic" style="background:#4A46E8">›</div><div class="tx">' + esc(s) + '</div></div>';
      }).join('') + '</div>') : '';

    return card('报告模板', '预制 5 类，也可自定义指标与时间范围',
      '<div class="g3-cards">' + cards + '</div>' +
      '<div style="margin-top:10px;display:flex;gap:8px;align-items:end;flex-wrap:wrap">' +
      '<label class="g3-fld" style="width:120px">统计区间<select id="g3RepDays"><option value="7">近 7 天</option><option value="30" selected>近 30 天</option><option value="90">近 90 天</option></select></label>' +
      '<button class="g3-btn p" data-act="buildRep">生成报告</button>' +
      '<span class="g3-hint">生成后可导出 Excel 明细，用于对账交付</span></div>') +
      card('历史报告', (d.reports || []).length + ' 份',
        '<div class="g3-rows">' + (list || emptyBox('还没有报告', '选一个模板生成第一份。')) + '</div>') + detail;
  }

  /* ---------------- 9 页面诊断质检 ---------------- */
  function viewDiag() {
    var d = G3.cache.diag;
    if (!d) return loading();
    if (d.__err) return badConn(d.__err);
    var r = d.result;
    var form = '<div class="g3-form" style="grid-template-columns:1fr auto;align-items:end">' +
      '<label class="g3-fld">页面 URL<input id="g3dUrl" placeholder="https://www.example.com/page"></label>' +
      '<button class="g3-btn p" data-act="runDiag">开始体检</button></div>' +
      '<details style="margin-top:8px"><summary class="g3-hint" style="cursor:pointer">抓不到页面？粘贴 HTML 诊断</summary>' +
      '<textarea id="g3dHtml" rows="5" placeholder="把页面源码粘到这里" style="width:100%;margin-top:6px;border:1px solid var(--border);border-radius:9px;padding:8px 10px;font-size:11.5px;font-family:ui-monospace,monospace"></textarea></details>';

    var result = '';
    if (r) {
      var color = r.score >= 85 ? '#12a150' : r.score >= 70 ? '#4A46E8' : r.score >= 55 ? '#F5A524' : '#e5484d';
      result = card('体检结果 · ' + esc(r.url), dshort(r.at) + ' · 正文 ' + r.chars + ' 字',
        '<div class="g3-score"><div class="ring" style="background:conic-gradient(' + color + ' ' + (r.score * 3.6) + 'deg,#EEF0FA 0)">' +
        '<b>' + r.score + '<small>分</small></b></div>' +
        '<div style="flex:1;min-width:160px"><div style="font-size:13px;font-weight:700">' + (r.grade === 'A' ? '优秀，可作模板' : r.grade === 'B' ? '良好，小幅优化' : r.grade === 'C' ? '及格，需整改' : '偏弱，建议重写') + '</div>' +
        '<div class="g3-hint" style="margin-top:3px">共 ' + r.items.length + ' 项检测，扣分 ' + (100 - r.score) + ' 分</div></div></div>' +
        '<div style="margin-top:10px">' + r.items.map(function (i) {
          return '<div class="g3-check ' + (i.ok ? 'ok' : 'no') + '"><div class="ic">' + (i.ok ? '✓' : '!') + '</div>' +
            '<div class="tx">' + esc(i.label) + (i.ok ? '' : '<em>' + esc(i.detail) + '</em>') + '</div>' +
            '<div class="wt">' + i.weight + '分</div></div>';
        }).join('') + '</div>');
    }

    var hist = (d.history || []).map(function (h) {
      return '<div class="g3-row"><div class="m"><b>' + esc(h.url) + '</b><span>' + ago(h.at) + ' · ' + h.chars + ' 字</span></div>' +
        '<div style="font-weight:800;font-size:13px;color:' + (h.score >= 70 ? '#12a150' : '#F5A524') + '">' + h.score + '</div></div>';
    }).join('');

    return card('单页 / 批量体检', 'Answer 块 · Schema · FAQ · 表格 · 实体一致性 · 抓取障碍', form) +
      result +
      card('诊断历史', (d.history || []).length + ' 次', '<div class="g3-rows">' + (hist || emptyBox('还没有诊断记录', '填一个分站页面 URL 试试。')) + '</div>');
  }

  /* ---------------- 10 客户 & 权限 ---------------- */
  function viewTenants() {
    var d = G3.cache.tenants;
    if (!d) return loading();
    if (d.__err) return badConn(d.__err);
    var ts = d.tenants || [];
    var cards = ts.map(function (t) {
      var q = t.quota || {}, u = t.used || {};
      var pr = function (used, total) { return total ? Math.min(100, Math.round(used / total * 100)) : 0; };
      return '<div class="g3-card"><div class="g3-card-hd"><h3>' + esc(t.name) + '</h3>' + tag(t.plan, 'info') +
        '<div class="r"><button class="g3-btn sm" data-act="addSub" data-id="' + esc(t.id) + '">加子账号</button>' +
        '<button class="g3-btn sm" data-act="delTenant" data-id="' + esc(t.id) + '">删除</button></div></div>' +
        '<div class="g3-card-bd">' +
        barRow('资产页', u.assets || 0, q.assets || 1) +
        barRow('媒体稿', u.media || 0, q.media || 1) +
        barRow('快照 GB', Math.round((u.probeGb || 0) * 10) / 10, q.probeGb || 1) +
        '<div class="g3-hint" style="margin-top:8px">子账号：' + ((t.subs || []).map(function (s) { return esc(s.name) + '(' + s.role + ')'; }).join('、') || '无') + '</div>' +
        '</div></div>';
    }).join('');
    var form = '<div class="g3-form">' +
      '<label class="g3-fld">客户名称<input id="g3tName" placeholder="如：某某科技"></label>' +
      '<label class="g3-fld">套餐<select id="g3tPlan"><option>标准版</option><option>专业版</option><option>旗舰版</option></select></label>' +
      '<label class="g3-fld">资产页配额<input id="g3tAssets" type="number" value="50"></label>' +
      '<label class="g3-fld">媒体稿配额<input id="g3tMedia" type="number" value="20"></label>' +
      '<label class="g3-fld full">对接人<input id="g3tContact" placeholder="姓名 / 手机"></label>' +
      '</div><div style="margin-top:8px"><button class="g3-btn p" data-act="addTenant">新增客户</button></div>';
    return '<div class="g3-cards" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">' + (cards || '<div class="g3-card"><div class="g3-card-bd">' + emptyBox('还没有客户', '新增客户后即可分配配额与子账号。') + '</div></div>') + '</div>' +
      card('新增客户 / 套餐配额', '资产页 · 媒体稿 · 采集额度', form);
  }

  /* ---------------- 11 系统设置 ---------------- */
  function viewSettings() {
    var d = G3.cache.settings;
    if (!d) return loading();
    if (d.__err) return badConn(d.__err);
    var s = d.settings || {}, llm = d.llm || {}, env = d.env || {};
    var gw = '<div class="g3-form">' +
      '<label class="g3-fld full">模型网关地址（OpenAI 兼容）<input id="g3lBase" value="' + esc(llm.baseUrl || '') + '" placeholder="https://api.openai.com/v1"></label>' +
      '<label class="g3-fld">模型名<input id="g3lModel" value="' + esc(llm.model || '') + '" placeholder="gpt-4o-mini / qwen-plus"></label>' +
      '<label class="g3-fld">API Key<input id="g3lKey" type="password" placeholder="' + (llm.enabled ? '已配置，留空则不修改' : 'sk-...') + '"></label>' +
      '</div><div style="margin-top:8px;display:flex;gap:8px;align-items:center">' +
      '<button class="g3-btn p" data-act="saveLlm">保存网关</button>' +
      '<span class="g3-hint">' + (llm.enabled ? '当前：' + esc(llm.model || '已启用') + ' · 生成/质检走真实大模型' : '未配置：全部环节走内置模板，功能闭环但不调用大模型') + '</span></div>';

    var st = '<div class="g3-form">' +
      '<label class="g3-fld">快照保留天数<input id="g3Ret" type="number" value="' + (s.retentionDays || 90) + '"></label>' +
      '<label class="g3-fld">告警邮箱<input id="g3Mail" value="' + esc(s.notifyEmail || '') + '" placeholder="ops@example.com"></label>' +
      '<label class="g3-fld full">告警 Webhook<input id="g3Hook" value="' + esc(s.notifyWebhook || '') + '" placeholder="https://open.feishu.cn/..."></label>' +
      '<label class="g3-fld">存储目录<input id="g3Dir" value="' + esc(s.storageDir || '.data') + '"></label>' +
      '<label class="g3-fld">交付水印<select id="g3Wm"><option value="1"' + (s.watermark !== false ? ' selected' : '') + '>开启</option><option value="0"' + (s.watermark === false ? ' selected' : '') + '>关闭</option></select></label>' +
      '</div><div style="margin-top:8px"><button class="g3-btn p" data-act="saveSettings">保存设置</button></div>';

    var envRows = [
      ['运行模式', env.mode || '—', env.mode === 'production' ? 'ok' : 'warn'],
      ['监测上游 GEO_UPSTREAM', env.geoUpstream ? '已配置' : '未配置', env.geoUpstream ? 'ok' : 'warn'],
      ['上游令牌 GEO_TOKEN', env.geoToken ? '已配置' : '未配置', env.geoToken ? 'ok' : 'warn'],
      ['采集模式 GEO_MODE', env.geoMode || '默认', env.geoMode === 'manual' ? 'info' : 'gray']
    ].map(function (r) {
      return '<div class="g3-row"><div class="m"><b>' + r[0] + '</b></div>' + tag(r[1], r[2]) + '</div>';
    }).join('');

    return '<div class="g3-grid2 even">' +
      card('模型网关', '生成 / 质检 / 回炉重写统一走这里', gw) +
      card('告警 · 存储 · 水印', '定时报告与异常通知', st) +
      '</div>' +
      card('运行环境', '只读，改配置需改 .env.local 并重启 BFF', '<div class="g3-rows">' + envRows + '</div>') +
      card('渠道 API 密钥', '媒体通稿 / 自媒体授权在「全域渠道分发」里维护', '<div class="g3-hint">发布类密钥按渠道保存在渠道记录中，仅服务端读取；前端只显示脱敏后的账号名。</div>');
  }

  /* ---------------- 视图注册 ---------------- */
  var VIEWS = {
    dash: viewDash, org: viewOrg, packs: viewPacks, content: viewContent, sites: viewSites,
    channels: viewChannels, probes: viewProbes, reports: viewReports, diag: viewDiag,
    tenants: viewTenants, settings: viewSettings
  };
  var LOADS = {
    dash: function () { return call('/v1/geo2/dashboard'); },
    org: function () { return call('/v1/geo2/org'); },
    packs: function () { return call('/v1/geo2/packs'); },
    content: function () { return call('/v1/geo2/assets'); },
    sites: function () { return call('/v1/geo2/sites'); },
    channels: function () {
      return Promise.all([call('/v1/geo2/channels'), call('/v1/geo2/pubq'), call('/v1/geo2/assets')]);
    },
    probes: function () {
      return Promise.all([call('/v1/geo2/probes'), call('/v1/geo2/snapshots?limit=80')]);
    },
    reports: function () { return call('/v1/geo2/reports'); },
    diag: function () { return call('/v1/geo2/diag'); },
    tenants: function () { return call('/v1/geo2/tenants'); },
    settings: function () { return call('/v1/geo2/settings'); }
  };

  function put(key) {
    return function (r) {
      G3.cache[key] = (r && r.ok) ? (r.data || {}) : { __err: (r && (r.error || r.message)) || '请求失败' };
    };
  }
  function loadModule(m) {
    var f = LOADS[m];
    if (!f) return Promise.resolve();
    return Promise.resolve(f()).then(function (r) {
      if (m === 'channels') {
        G3.cache.channels = (r[0] && r[0].ok) ? r[0].data : { __err: (r[0] && r[0].error) || '请求失败' };
        G3.cache.pubq = (r[1] && r[1].ok) ? r[1].data : { queue: [] };
        G3.cache.assets = (r[2] && r[2].ok) ? r[2].data : { assets: [] };
      } else if (m === 'probes') {
        G3.cache.probes = (r[0] && r[0].ok) ? r[0].data : { __err: (r[0] && r[0].error) || '请求失败' };
        G3.cache.snaps = (r[1] && r[1].ok) ? r[1].data : { list: [] };
      } else {
        put(m)(r);
      }
    }).catch(function (e) {
      G3.cache[m] = { __err: (e && e.message) || '网络异常' };
    });
  }

  function actionsFor(m) {
    var r = '<button class="g3-btn" data-act="reload"><svg class="icon"><use href="#i-refresh"/></svg>刷新</button>';
    if (m === 'dash') {
      var d = G3.cache.dash || {};
      if (d.__err) return r;
      r = (d.empty ? '<button class="g3-btn" data-act="seed">载入示例数据</button>'
        : d.demo ? '<button class="g3-btn" data-act="clearDemo">清除示例</button>' : '') + r;
      r += '<button class="g3-btn" data-g3="packs">新建词包</button>' +
        '<button class="g3-btn p" data-g3="content">新建内容</button>' +
        '<button class="g3-btn" data-g3="reports">查看报告</button>';
    } else if (m === 'packs') {
      r += '<button class="g3-btn p" data-act="toggleImport">导入词包</button>';
    } else if (m === 'content') {
      r += '<button class="g3-btn p" data-act="focusGen">生成资产页</button>';
    } else if (m === 'channels') {
      r += '<button class="g3-btn p" data-g3="content">去创作中心</button>';
    } else if (m === 'probes') {
      r += '<button class="g3-btn" data-g3="settings">配置上游</button>';
    }
    return r;
  }

  function render() {
    var meta = META[G3.mod] || META.dash;
    var t = q('#g3Title'), s = q('#g3Sub'), a = q('#g3Actions'), b = q('#g3Body');
    if (!b) return;
    if (t) t.textContent = meta.t;
    if (s) s.textContent = meta.s;
    if (a) a.innerHTML = actionsFor(G3.mod);
    try {
      b.innerHTML = VIEWS[G3.mod] ? VIEWS[G3.mod]() : '';
    } catch (e) {
      b.innerHTML = '<div class="g3-card"><div class="g3-card-bd">' + badConn('渲染出错：' + e.message) + '</div></div>';
    }
  }

  function setMod(m) {
    if (!META[m]) m = 'dash';
    G3.mod = m;
    qa('#g3Nav .g3-navi').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-g3') === m);
    });
    G3.cache[m] = G3.cache[m] || null;
    render();
    loadModule(m).then(function () { render(); updateFoot(); });
  }

  function updateFoot() {
    var el = q('#g3NavFoot');
    if (!el) return;
    var d = G3.cache.dash || {};
    var packs = (G3.cache.packs && G3.cache.packs.packs) || [];
    var txt = [];
    txt.push(d.empty === false ? '快照 ' + num(d.all && d.all.total) + ' 条' : '快照 0 条');
    txt.push('词包 ' + packs.length);
    if (d.demo) txt.push('示例数据');
    el.innerHTML = txt.join(' · ') + '<br>' + (d.empty === false ? '数据已接入' : '待接入监测上游');
    var n = q('#g3NvAudit');
    if (n && d.tasks) {
      var c = (d.tasks.pendingAudit || 0);
      n.textContent = c;
      n.style.display = c ? '' : 'none';
    }
  }

  /* ---------------- 交互动作 ---------------- */
  var ACT = {
    reload: function () { return loadModule(G3.mod).then(function () { render(); updateFoot(); }); },

    seed: function () {
      return call('/v1/geo2/demo/seed', {}).then(function (r) {
        if (!r.ok) return toast(r.error || '载入失败', 'err');
        toast('已载入示例数据（标记 demo，可一键清除）', 'ok');
        return ACT.reload();
      });
    },
    clearDemo: function () {
      return call('/v1/geo2/demo/seed', null, { method: 'DELETE' }).then(function (r) {
        if (!r.ok) return toast(r.error || '清除失败', 'err');
        toast('示例数据已清除', 'ok');
        return ACT.reload();
      });
    },

    orgSave: function () {
      var body = {
        company: val('#g3oCompany'), brand: val('#g3oBrand'), brandKeys: val('#g3oKeys'),
        phone: val('#g3oPhone'), address: val('#g3oAddress'), serviceArea: val('#g3oArea'),
        mainBusiness: val('#g3oBiz'), sellingPoints: val('#g3oSell'),
        sameAs: val('#g3oSame').split(/\n+/).map(trim).filter(Boolean),
        subsiteUrl: val('#g3oSub')
      };
      return call('/v1/geo2/org', body).then(function (r) {
        if (!r.ok) return toast(r.error || '保存失败', 'err');
        toast('标准实体已保存，后续内容统一口径', 'ok');
        return loadModule('org').then(render);
      });
    },
    kbUpload: function () {
      var f = q('#g3KbFile');
      if (!f || !f.files || !f.files[0]) return toast('先选一个文件', 'warn');
      var file = f.files[0];
      var isText = /\.(txt|md|csv|json|html?)$/i.test(file.name);
      var done = function (text) {
        return call('/v1/geo2/org/kb', { name: file.name, type: isText ? 'text' : 'file', size: file.size, text: text || '' })
          .then(function (r) {
            if (!r.ok) return toast(r.error || '入库失败', 'err');
            toast('已入库：' + file.name, 'ok');
            return loadModule('org').then(render);
          });
      };
      if (!isText) return done('');
      var fr = new FileReader();
      fr.onload = function () { done(String(fr.result || '').slice(0, 20000)); };
      fr.onerror = function () { done(''); };
      fr.readAsText(file);
    },
    kbDel: function (el) {
      return call('/v1/geo2/org/kb/' + el.getAttribute('data-id'), null, { method: 'DELETE' })
        .then(function (r) { if (!r.ok) return toast(r.error || '删除失败', 'err'); return loadModule('org').then(render); });
    },

    toggleImport: function () { G3.sel.importing = !G3.sel.importing; render(); },
    pickPack: function (el) { G3.sel.pack = el.getAttribute('data-id'); G3.sel.word = ''; G3.cache.wordTrend = null; render(); },
    packImport: function () {
      var name = val('#g3PackName'), text = val('#g3PackText');
      if (!text.trim()) return toast('先粘贴问句', 'warn');
      return call('/v1/geo2/packs', { name: name, text: text }).then(function (r) {
        if (!r.ok) return toast(r.error || r.message || '导入失败', 'err');
        toast('词包已导入', 'ok');
        G3.sel.importing = false;
        if (r.data && r.data.pack) G3.sel.pack = r.data.pack.id;
        return loadModule('packs').then(render);
      });
    },
    packToggle: function (el) {
      var id = el.getAttribute('data-id');
      var p = ((G3.cache.packs && G3.cache.packs.packs) || []).filter(function (x) { return x.id === id; })[0] || {};
      return call('/v1/geo2/packs/' + id + '/toggle', { off: p.monitoring !== false }).then(function () {
        return loadModule('packs').then(render);
      });
    },
    packCopy: function (el) {
      return call('/v1/geo2/packs/' + el.getAttribute('data-id') + '/copy', {}).then(function (r) {
        if (!r.ok) return toast(r.error || '复制失败', 'err');
        toast('已复制词包', 'ok');
        return loadModule('packs').then(render);
      });
    },
    packDel: function (el) {
      if (!window.confirm('删除后该词包及监测任务不再展示，确认删除？')) return;
      return call('/v1/geo2/packs/' + el.getAttribute('data-id'), null, { method: 'DELETE' })
        .then(function () { return loadModule('packs').then(render); });
    },
    wordTrend: function (el) {
      var w = el.getAttribute('data-word');
      return call('/v1/geo2/words/trend?word=' + encodeURIComponent(w)).then(function (r) {
        G3.cache.wordTrend = { word: w, trend: (r.ok && r.data.trend) || [] };
        render();
      });
    },

    pickAsset: function (el) { G3.sel.asset = el.getAttribute('data-id'); G3.sel.tab = 'preview'; G3.cache.preview = null; render(); },
    tab: function (el) { G3.sel.tab = el.getAttribute('data-tab'); render(); },
    focusGen: function () { var i = q('#g3GenWord'); if (i) { i.focus(); i.scrollIntoView({ block: 'center' }); } },
    genAsset: function () {
      var w = val('#g3GenWord').trim();
      if (!w) return toast('先填目标问句', 'warn');
      toast('生成中，请稍候…', 'info');
      return call('/v1/geo2/assets', { word: w, style: val('#g3GenStyle') }).then(function (r) {
        if (!r.ok) return toast(r.error || '生成失败', 'err');
        G3.sel.asset = r.data.asset.id; G3.sel.tab = 'preview';
        toast('已生成：' + (r.data.fromLLM ? '大模型' : '模板兜底') + ' · ' + r.data.asset.qa.score + ' 分', 'ok');
        return loadModule('content').then(render);
      });
    },
    audit: function (el) {
      var pass = el.getAttribute('data-pass') === '1';
      return call('/v1/geo2/assets/' + el.getAttribute('data-id') + '/audit', { pass: pass, note: '' }).then(function (r) {
        if (!r.ok) return toast(r.error || '操作失败', 'err');
        toast(pass ? '已通过审核，可进入发布队列' : '已驳回，待修改', pass ? 'ok' : 'warn');
        return loadModule('content').then(render);
      });
    },
    genVariants: function (el) {
      return call('/v1/geo2/assets/' + el.getAttribute('data-id') + '/variants', { count: 3 }).then(function (r) {
        if (!r.ok) return toast(r.error || '生成失败', 'err');
        toast('已生成 3 版变体', 'ok');
        G3.sel.tab = 'variants';
        return loadModule('content').then(render);
      });
    },
    previewAsset: function (el) {
      return call('/v1/geo2/assets/' + el.getAttribute('data-id') + '/preview').then(function (r) {
        if (!r.ok) return toast(r.error || '抓取失败', 'err');
        G3.cache.preview = Object.assign({ assetId: el.getAttribute('data-id') }, r.data);
        render();
      });
    },
    rewrite: function (el) {
      toast('回炉重写中…', 'info');
      return call('/v1/geo2/assets/' + el.getAttribute('data-id') + '/rewrite', { sources: [] }, { timeout: 90000 }).then(function (r) {
        if (!r.ok) return toast(r.error || '重写失败', 'err');
        G3.sel.asset = r.data.asset.id;
        toast('已重写为 v' + r.data.asset.rev + '，回到待审核', 'ok');
        return loadModule('content').then(render);
      });
    },

    addSite: function () {
      var body = { name: val('#g3sName'), url: val('#g3sUrl'), type: val('#g3sType'), group: val('#g3sGroup'), weight: val('#g3sWeight'), apiKey: val('#g3sKey') };
      if (!body.url) return toast('请填写站点地址', 'warn');
      return call('/v1/geo2/sites', body).then(function (r) {
        if (!r.ok) return toast(r.error || r.message || '新增失败', 'err');
        toast('站点已新增', 'ok');
        return loadModule('sites').then(render);
      });
    },
    checkSite: function (el) {
      toast('检测中…', 'info');
      return call('/v1/geo2/sites/' + el.getAttribute('data-id') + '/check', {}, { timeout: 20000 }).then(function (r) {
        if (!r.ok) return toast(r.error || '检测失败', 'err');
        return loadModule('sites').then(render);
      });
    },
    delSite: function (el) {
      if (!window.confirm('删除该站点？')) return;
      return call('/v1/geo2/sites/' + el.getAttribute('data-id'), null, { method: 'DELETE' })
        .then(function () { return loadModule('sites').then(render); });
    },

    addChan: function () {
      var body = { kind: val('#g3cKind'), name: val('#g3cName'), account: val('#g3cAccount'), price: val('#g3cPrice') };
      if (!body.name) return toast('请填写渠道名称', 'warn');
      return call('/v1/geo2/channels', body).then(function (r) {
        if (!r.ok) return toast(r.error || '新增失败', 'err');
        toast('渠道已新增', 'ok');
        return loadModule('channels').then(render);
      });
    },
    chanAuth: function (el) {
      var on = el.getAttribute('data-on') === '1';
      return call('/v1/geo2/channels/' + el.getAttribute('data-id') + '/authed', { on: on }).then(function () {
        return loadModule('channels').then(render);
      });
    },
    delChan: function (el) {
      return call('/v1/geo2/channels/' + el.getAttribute('data-id'), null, { method: 'DELETE' })
        .then(function () { return loadModule('channels').then(render); });
    },
    doPublish: function () {
      var assetId = val('#g3PubAsset');
      var boxes = qa('.g3-pubchk:checked');
      if (!assetId) return toast('先选资产', 'warn');
      if (!boxes.length) return toast('至少勾选一个渠道', 'warn');
      var targets = boxes.map(function (b) {
        return { kind: b.getAttribute('data-kind'), name: b.getAttribute('data-name') };
      });
      return call('/v1/geo2/publish', { assetId: assetId, targets: targets, scheduledAt: val('#g3PubAt') }).then(function (r) {
        if (!r.ok) return toast(r.error || r.message || '发布失败', 'err');
        toast('已入发布队列 ' + r.data.created.length + ' 条', 'ok');
        G3.cache.pubq = null;
        return loadModule('channels').then(render);
      });
    },
    retryPub: function (el) {
      return call('/v1/geo2/pubq/' + el.getAttribute('data-id') + '/retry', {}).then(function () {
        G3.cache.pubq = null;
        return loadModule('channels').then(render);
      });
    },

    runProbe: function (el) {
      var w = el.getAttribute('data-word');
      toast('采集「' + w + '」…', 'info');
      return call('/v1/geo2/probes/run', { word: w }, { timeout: 60000 }).then(function (r) {
        if (!r.ok) return toast(r.message || '探针未接入上游', 'warn');
        toast('采集完成：覆盖 ' + (r.data.run.covered || 0) + '/' + (r.data.run.results || []).length, 'ok');
        return loadModule('probes').then(render);
      });
    },
    snapSearch: function () {
      var kw = val('#g3SnapQ');
      return call('/v1/geo2/snapshots?limit=80&q=' + encodeURIComponent(kw)).then(function (r) {
        if (r.ok) { G3.cache.snaps = r.data; render(); }
      });
    },
    pickSnap: function (el) { G3.sel.snap = el.getAttribute('data-id'); render(); },

    pickKind: function (el) { G3.sel.rep = el.getAttribute('data-id'); render(); },
    buildRep: function () {
      toast('生成报告中…', 'info');
      return call('/v1/geo2/reports', { kind: G3.sel.rep || 'brand', rangeDays: Number(val('#g3RepDays')) || 30 })
        .then(function (r) {
          if (!r.ok) return toast(r.error || '生成失败', 'err');
          toast('报告已生成', 'ok');
          G3.sel.repView = r.data.report.id;
          return loadModule('reports').then(render);
        });
    },
    viewRep: function (el) { G3.sel.repView = el.getAttribute('data-id'); render(); },
    csv: function (el) {
      var rep = ((G3.cache.reports && G3.cache.reports.reports) || []).filter(function (x) { return x.id === el.getAttribute('data-id'); })[0];
      if (!rep) return;
      var rows = [['指标', '数值']];
      Object.keys(rep.summary).forEach(function (k) { rows.push([k, rep.summary[k]]); });
      rows.push([]);
      rows.push(['模型', '样本', '提及率%', '首推率%', 'TOP3%', '情感分', '竞品占比%']);
      (rep.models || []).forEach(function (m) { rows.push([m.name, m.total, m.mentionRate, m.firstRate, m.top3Rate, m.sentiment, m.compShare]); });
      rows.push([]);
      rows.push(['词包', '词数', '优势区', '敌占区', '空白区', '风险区']);
      (rep.packs || []).forEach(function (p) { rows.push([p.name, p.words, (p.zones || {}).advantage || 0, (p.zones || {}).enemy || 0, (p.zones || {}).blank || 0, (p.zones || {}).risk || 0]); });
      var csv = '\ufeff' + rows.map(function (r) {
        return r.map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(',');
      }).join('\r\n');
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'geo-report-' + rep.id + '.csv';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 800);
    },

    runDiag: function () {
      var url = val('#g3dUrl').trim();
      var html = val('#g3dHtml');
      if (!url && !html) return toast('填 URL 或粘贴 HTML', 'warn');
      toast('体检中…', 'info');
      return call('/v1/geo2/diag', { url: url, html: html }, { timeout: 30000 }).then(function (r) {
        if (!r.ok) return toast(r.message || r.error || '诊断失败', 'err');
        G3.cache.diag = { result: r.data.result, history: [r.data.result].concat((G3.cache.diag && G3.cache.diag.history) || []).slice(0, 50) };
        render();
        toast('体检完成：' + r.data.result.score + ' 分', 'ok');
      });
    },

    addTenant: function () {
      var body = { name: val('#g3tName'), plan: val('#g3tPlan'), assets: val('#g3tAssets'), media: val('#g3tMedia'), contact: val('#g3tContact') };
      if (!body.name) return toast('请填写客户名称', 'warn');
      return call('/v1/geo2/tenants', body).then(function (r) {
        if (!r.ok) return toast(r.error || '新增失败', 'err');
        toast('客户已新增', 'ok');
        return loadModule('tenants').then(render);
      });
    },
    addSub: function (el) {
      var name = window.prompt('子账号名称（如：运营小王）');
      if (!name) return;
      return call('/v1/geo2/tenants/' + el.getAttribute('data-id') + '/subs', { name: name, role: 'ops' })
        .then(function () { return loadModule('tenants').then(render); });
    },
    delTenant: function (el) {
      if (!window.confirm('删除该客户？配额与子账号一并移除。')) return;
      return call('/v1/geo2/tenants/' + el.getAttribute('data-id'), null, { method: 'DELETE' })
        .then(function () { return loadModule('tenants').then(render); });
    },

    saveLlm: function () {
      var body = { provider: 'custom', baseUrl: val('#g3lBase'), model: val('#g3lModel'), apiKey: val('#g3lKey') };
      if (!body.baseUrl || !body.model) return toast('地址与模型名必填', 'warn');
      return call('/v1/geo2/llm', body).then(function (r) {
        if (!r.ok) return toast(r.error || '保存失败', 'err');
        toast(r.data.enabled ? '模型网关已启用' : '已保存（信息不全，保持模板模式）', 'ok');
        return loadModule('settings').then(render);
      });
    },
    saveSettings: function () {
      var body = {
        retentionDays: val('#g3Ret'), notifyEmail: val('#g3Mail'), notifyWebhook: val('#g3Hook'),
        storageDir: val('#g3Dir'), watermark: val('#g3Wm') === '1'
      };
      return call('/v1/geo2/settings', body).then(function (r) {
        if (!r.ok) return toast(r.error || '保存失败', 'err');
        toast('设置已保存', 'ok');
        return loadModule('settings').then(render);
      });
    }
  };

  function val(sel) { var el = q(sel); return el ? String(el.value || '') : ''; }
  function trim(s) { return String(s || '').trim(); }

  /* ---------------- 事件绑定 ---------------- */
  function onClick(ev) {
    var nav = ev.target.closest('[data-g3]');
    if (nav) {
      ev.preventDefault();
      var m = nav.getAttribute('data-g3');
      setMod(m);
      var v = q('#v-geo');
      if (v && v.scrollIntoView) v.scrollIntoView({ block: 'start' });
      return;
    }
    var el = ev.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    if (!ACT[act]) return;
    ev.preventDefault();
    if (el.disabled) return;
    el.disabled = true;
    var p = ACT[act](el);
    if (p && p.then) p.then(function () { el.disabled = false; }, function (e) {
      el.disabled = false;
      toast((e && e.message) || '操作失败', 'err');
    });
    else el.disabled = false;
  }

  function bind() {
    var root = document.getElementById('v-geo');
    if (!root) return false;
    if (!G3.bound) {
      root.addEventListener('click', onClick);
      G3.bound = true;
    }
    return true;
  }

  /* ---------------- 兼容层（AI 秒搭建站调用） ---------------- */
  function installShim() {
    window.__GEO = {
      engines: ENGINES,
      geo: { get tasks() { return (G3.cache.probes && G3.cache.probes.rows) || []; } },
      addTask: function (kw, engines, every) {
        return call('/v1/geo/tasks', { keyword: kw, engines: engines && engines.length ? engines : ['doubao'], every: every || '1h' }, { timeout: 15000 })
          .then(function (r) { return r.ok ? (r.data && r.data.task) : null; });
      },
      refresh: function () { return loadModule('dash').then(render); }
    };
  }

  /* ---------------- 启动 ---------------- */
  function tick() {
    var v = document.getElementById('v-geo');
    var on = !!(v && v.classList.contains('active'));
    if (on === G3.visible) return;
    G3.visible = on;
    if (!on) return;
    if (!bind()) return;
    setMod(G3.mod && META[G3.mod] ? G3.mod : 'dash');
  }

  function boot() {
    installShim();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { bind(); tick(); });
    } else { bind(); tick(); }
    /* 视图切换由主框架控制，这里用轻量轮询判断是否可见（不劫持 switchView） */
    setInterval(tick, 700);
    /* 部署后老缓存的 gp* 元素不存在，直接确保新层挂载 */
    setTimeout(function () { bind(); tick(); }, 1500);
  }

  boot();
})();
