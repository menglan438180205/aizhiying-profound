
/* =========================================================
   评论区采集器 · 服务端定时调度面板（增强层）
   ---------------------------------------------------------
   目的：把采集从「点一次采一次」升级为服务端常驻的
         Cron / 间隔调度 + 队列 + Worker。

   本面板只做三件事：
     1) 展示与操作服务端调度任务（新建 / 启停 / 立即执行 / 删除 / 改频率）
     2) 把前端已有的本地任务一键推送到服务端，变成真正会自己跑的调度
     3) 展示服务端去重后的线索池，并支持导出

   完全独立于采集器主体：只读 window.__COLLECTOR（本地任务列表），
   不修改它的任何状态，避免影响既有链路。
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- 0. 与宿主环境的桥 ---------------- */
  function api() { return window.Api || (window.__RT && window.__RT.api) || null; }
  function fn(o, k) { return o && typeof o[k] === 'function'; }

  function live() {
    var a = api();
    return !!(a && fn(a, 'live') && a.live());
  }
  function base() {
    var a = api();
    return (a && fn(a, 'base') && a.base()) || '';
  }
  function call(path, body, method) {
    var a = api();
    if (!a || !fn(a, 'call')) return Promise.resolve({ ok: false, code: 'NO_BFF', error: '未配置服务端地址' });
    return a.call(path, body == null ? null : body, { method: method || (body == null ? 'GET' : 'POST') });
  }
  function ui() { return window.__UI || {}; }
  function toast(msg, kind, title, ms) {
    var u = ui();
    if (fn(u, 'toast')) { try { return u.toast(msg, kind || 'info', title, ms); } catch (e) {} }
    log(kind === 'err' ? 'err' : (kind === 'warn' ? 'warn' : 'info'), msg);
  }
  function appModal(cfg) {
    var u = ui();
    if (fn(u, 'openModal')) { try { return u.openModal(cfg); } catch (e) {} }
    return null;
  }
  function appConfirm(cfg) {
    var u = ui();
    if (fn(u, 'confirmDlg')) { try { return u.confirmDlg(cfg); } catch (e) {} }
    if (window.confirm) { if (window.confirm(cfg.msg || cfg.title)) { if (fn(cfg, 'onOk')) cfg.onOk(); } }
    return null;
  }
  function audit(action, target) {
    var r = window.__RT;
    if (r && fn(r.audit, 'audit')) { try { r.audit(action, target); return; } catch (e) {} }
  }
  /* 把日志写进采集器既有的运行日志区，保持「一个模块一个日志流」 */
  function log(kind, msg) {
    var host = document.getElementById('colLog');
    if (!host) return;
    var icons = { info: 'i', ok: '✓', warn: '!', err: '×', run: '»' };
    var line = document.createElement('div');
    line.className = 'col-line';
    line.innerHTML = '<span class="col-k ' + (kind || 'info') + '">' + (icons[kind] || 'i') + '</span>' +
      '<span class="col-t">' + esc(new Date().toTimeString().slice(0, 8)) + '</span>' +
      '<span class="col-m ' + (kind || 'info') + '">' + esc(msg) + '</span>';
    host.appendChild(line);
    while (host.children.length > 400) host.removeChild(host.firstChild);
    host.scrollTop = host.scrollHeight;
  }

  /* ---------------- 1. 小工具 ---------------- */
  function q(s, r) { return (r || document).querySelector(s); }
  function qa(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function txt(el) { return el ? String(el.textContent || '') : ''; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '—';
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtDelta(ts) {
    if (!ts) return '未排期';
    var ms = Number(ts) - Date.now();
    if (ms <= 0) return '即将执行';
    if (ms < 60000) return Math.ceil(ms / 1000) + ' 秒后';
    if (ms < 3600000) return Math.ceil(ms / 60000) + ' 分钟后';
    if (ms < 86400000) return Math.floor(ms / 3600000) + ' 小时 ' + Math.floor((ms % 3600000) / 60000) + ' 分后';
    return Math.floor(ms / 86400000) + ' 天后';
  }
  function fmtSince(ts) {
    if (!ts) return '尚未执行';
    var ms = Date.now() - Number(ts);
    if (ms < 60000) return '刚刚';
    if (ms < 3600000) return Math.floor(ms / 60000) + ' 分钟前';
    if (ms < 86400000) return Math.floor(ms / 3600000) + ' 小时前';
    return Math.floor(ms / 86400000) + ' 天前';
  }
  var PLAT_NAME = { douyin: '抖音', kuaishou: '快手', xhs: '小红书', sph: '视频号' };
  var PLAT_TAG = { douyin: 'blue', kuaishou: 'amber', xhs: 'red', sph: 'accent' };
  var EVERY_LABEL = {
    realtime: '实时（1 分钟）', '10m': '每 10 分钟', '15m': '每 15 分钟', '30m': '每 30 分钟',
    '1h': '每小时', '6h': '每 6 小时', '12h': '每 12 小时', '24h': '每天', daily2: '每天 2 次'
  };
  var EVERY_KEYS = ['15m', '30m', '1h', '6h', '12h', '24h'];
  var CRON_PRESETS = [
    { c: '*/15 * * * *', t: '每 15 分钟' },
    { c: '0 * * * *', t: '每小时整点' },
    { c: '0 9,15,21 * * *', t: '每天 9/15/21 点' },
    { c: '0 9 * * 1-5', t: '工作日 9 点' }
  ];
  var STATUS_META = {
    ok: { tag: 'green', text: '成功' },
    empty: { tag: 'amber', text: '无数据' },
    skipped: { tag: 'amber', text: '已跳过' },
    failed: { tag: 'red', text: '失败' },
    running: { tag: 'blue', text: '执行中' }
  };

  /* ---------------- 采集通道与范围 ----------------
     两类评论来源的合规边界完全不同，所以任务要能分别指定：
       自有内容评论区 → 只有平台官方开放能力能给（合规最干净）
       第三方公开评论 → 自建爬虫或第三方数据服务（半径大，责任自负）
     auto 不写死通道，由服务端按「范围 → 优先级」在运行时决定。 */
  var CHANNEL_ORDER = ['auto', 'official', 'crawler', 'vendor', 'local'];
  var CHANNEL_META = {
    auto: { name: '自动选择', tag: '', desc: '由服务端按范围与已接入通道自动挑一条' },
    official: { name: '自有内容评论区', tag: 'green', desc: '平台官方开放能力，只能读自有账号作品的评论' },
    crawler: { name: '自建爬虫', tag: 'amber', desc: '自建爬虫抓第三方公开评论，登录态与限流自理' },
    vendor: { name: '第三方数据服务', tag: 'blue', desc: '采购的有资质数据源，可跨平台跨账号' },
    local: { name: '本地模拟', tag: 'amber', desc: '本地生成演示数据，仅用于没有通道时跑通链路' }
  };
  var SCOPE_META = {
    auto: { name: '自动', desc: '按已接入的通道自动决定采什么' },
    own: { name: '自有内容', desc: '只采自有账号作品下的评论，优先走官方通道' },
    keyword: { name: '公开搜索', desc: '按关键词搜第三方公开内容，走爬虫或供应商' }
  };
  var SCOPE_ORDER = ['auto', 'own', 'keyword'];
  function chanName(id) { return (CHANNEL_META[id] || { name: id || '—' }).name; }
  function scopeName(id) { return (SCOPE_META[id] || { name: id || '—' }).name; }

  /* 通道清单：以服务端返回为准（含 configured / missing），缺失时退化为本地定义 */
  function chanOptions() {
    var live = {};
    ((SD.cfg && SD.cfg.channels) || []).forEach(function (c) { if (c && c.id) live[c.id] = c; });
    return CHANNEL_ORDER.map(function (id) {
      var meta = CHANNEL_META[id] || { name: id, desc: '' };
      var srv = live[id];
      return {
        id: id,
        name: meta.name,
        desc: (srv && srv.desc) || meta.desc || '',
        configured: id === 'auto' ? true : (srv ? !!srv.configured : null),
        missing: (srv && srv.missing) || [],
        upstream: (srv && srv.upstream) || ''
      };
    });
  }
  function chanDesc(id) {
    var o = null;
    chanOptions().forEach(function (x) { if (x.id === id) o = x; });
    if (!o) return '';
    var s = o.desc || '';
    if (o.configured === false) s = '⚠ 尚未接入' + (o.missing.length ? '（缺 ' + o.missing.join(' / ') + '）' : '') + '：' + s;
    return s;
  }

  /* ---------------- 2. 状态 ---------------- */
  var SD = {
    reachable: false,          /* 是否连上了 BFF */
    mode: '',                  /* upstream | local | unconfigured */
    tasks: [], stats: null, cfg: null,
    leads: [], leadsTotal: 0,
    busy: false, lastErr: '',
    timer: null, lastAt: 0, fetching: false
  };
  function C() { return window.__COLLECTOR || {}; }

  /* ---------------- 3. 数据 ---------------- */
  function refresh(silent) {
    if (SD.fetching) return Promise.resolve(false);
    if (!live()) {
      SD.reachable = false;
      SD.mode = 'unconfigured';
      SD.lastErr = '未配置服务端地址';
      renderAll();
      return Promise.resolve(false);
    }
    SD.fetching = true;
    return call('/v1/collect/config', null, 'GET').then(function (r) {
      if (!r.ok || !r.data) {
        SD.reachable = false;
        SD.lastErr = (r.error || r.code || '服务端未响应').slice(0, 80);
        SD.fetching = false;
        renderAll();
        return false;
      }
      SD.reachable = true;
      SD.lastErr = '';
      SD.cfg = r.data;
      SD.stats = r.data.stats || null;
      SD.mode = (r.data.stats && r.data.stats.mode) || 'unconfigured';
      return call('/v1/collect/tasks', null, 'GET').then(function (t) {
        if (t.ok && t.data && Array.isArray(t.data.tasks)) SD.tasks = t.data.tasks;
        if (t.ok && t.data && t.data.stats) SD.stats = t.data.stats;
        SD.lastAt = Date.now();
        SD.fetching = false;
        renderAll();
        if (!silent) audit('collect.sched.refresh', SD.tasks.length + ' 个调度任务');
        return true;
      });
    })['catch'](function (e) {
      SD.fetching = false;
      SD.reachable = false;
      SD.lastErr = String((e && e.message) || e).slice(0, 80);
      renderAll();
      return false;
    });
  }

  /* ---------------- 4. 渲染 ---------------- */
  function renderChan() {
    var dot = q('#colsdDot');
    var chan = q('#colsdChan');
    var chips = q('#colsdChips');
    if (!dot || !chan || !chips) return;

    var st = SD.stats || {};
    var kind, label, desc;
    if (!SD.reachable) {
      kind = 'err'; label = '服务端未接入';
      desc = '调度在服务端常驻执行，需先接入 BFF';
    } else if (SD.mode === 'upstream') {
      /* 多通道：把「接了哪几条」直接报出来，避免只看到一句「真实采集通道」
         却不知道实际走的是官方、爬虫还是供应商 */
      var real = ((st.channels || []).filter(function (c) {
        return c && c.configured && c.id !== 'local';
      }));
      kind = 'ok';
      label = '真实采集通道' + (real.length > 1 ? '（' + real.length + ' 路）' : '');
      desc = real.length
        ? '已接入 ' + real.map(function (c) { return c.name || chanName(c.id); }).join(' · ')
        : ('上游 ' + (st.upstreamConfigured ? '已配置' : '—'));
    } else if (SD.mode === 'local') {
      kind = 'warn'; label = '本地模拟通道';
      desc = 'ALLOW_LOCAL_COLLECT=1，调度产出的数据为模拟数据';
    } else {
      kind = 'warn'; label = '未接入采集通道';
      desc = '配置 COLLECT_OFFICIAL_URL / COLLECT_CRAWLER_URL / COLLECT_UPSTREAM 任一后调度才会真正抓取';
    }
    dot.className = 'colsd-dot ' + kind;
    chan.textContent = label;

    chips.innerHTML =
      chip(st.tasks || 0, '调度任务') +
      chip(st.enabled || 0, '运行中') +
      chip(st.runs || 0, '已执行轮次') +
      chip(st.leads || 0, '去重线索') +
      chip(fmtDelta(st.nextRunAt), '下次执行');

    var hint = q('#colsdHint');
    if (hint) {
      var dist = '';
      if (st.tasksByChannel) {
        var parts = Object.keys(st.tasksByChannel).map(function (k) {
          return chanName(k) + ' ' + st.tasksByChannel[k];
        });
        if (parts.length) dist = ' · 任务分布 ' + parts.join(' / ');
      }
      hint.textContent = SD.reachable
        ? ('服务端常驻调度 · ' + desc + dist + ' · 巡检 ' + Math.round((st.tickMs || 30000) / 1000) + 's · 并发 ' + (st.concurrency || 1))
        : '采集不再依赖「手动点击」：接入服务端后由 Cron / 间隔调度常驻执行';
    }
  }
  function chip(v, label) {
    return '<div class="colsd-chip"><b>' + esc(String(v)) + '</b><span>' + esc(label) + '</span></div>';
  }

  /* 任务列表已合并到上方「关键词监听任务」，这里只报服务端侧的调度状态摘要 */
  function renderList() {
    var host = q('#colsdList');
    if (!host) return;

    if (!SD.reachable) {
      host.innerHTML =
        '<div class="colsd-empty"><b>尚未接入服务端调度</b>' +
        '到「设置 → 配置服务端」填入 BFF 地址并测试保存。<br>' +
        '接入后采集任务会由服务端 Cron / 间隔调度常驻执行，关掉页面也不会停。</div>';
      return;
    }
    var on = SD.tasks.filter(function (t) { return t.enabled; }).length;
    var next = 0;
    SD.tasks.forEach(function (t) {
      if (t.enabled && t.nextRunAt && (!next || t.nextRunAt < next)) next = t.nextRunAt;
    });
    host.innerHTML = '<div class="colsd-empty" style="padding:14px;line-height:1.9">' +
      '调度任务共 <b>' + SD.tasks.length + '</b> 个，运行中 <b>' + on + '</b> 个' +
      (next ? '，最近一次将在 <b>' + esc(fmtDelta(next)) + '</b> 执行' : '') +
      '。<br>新建 / 启停 / 立即执行 / 删除都统一在上方「关键词监听任务」里操作。</div>';
  }

  function renderFoot() { /* 旧版页脚的「推送本地任务」「调度线索池」按钮已随任务合并移除 */ }

  function renderAll() {
    renderChan(); renderList();
    /* 任务列表与状态在上方「关键词监听任务」里统一展示，SD 刷新后同步重绘它 */
    try { if (window.__COL_ON_TASKS) window.__COL_ON_TASKS(); } catch (e) {}
  }

  /* ---------------- 5. 操作 ---------------- */
  function runTask(id, silent) {
    var t = taskOf(id);
    if (!t) return Promise.resolve(false);
    if (SD.mode === 'unconfigured') {
      toast('未接入任何采集通道：服务端不会生成模拟数据。请配置 COLLECT_OFFICIAL_URL（自有内容评论区）/ COLLECT_CRAWLER_URL（自建爬虫）/ COLLECT_UPSTREAM（第三方数据服务），或仅在本地验证时设 ALLOW_LOCAL_COLLECT=1', 'warn', '无法执行采集');
      return Promise.resolve(false);
    }
    log('run', '手动触发调度任务：' + t.keyword);
    return call('/v1/collect/tasks/' + encodeURIComponent(id) + '/run', {}, 'POST').then(function (r) {
      if (!r.ok) {
        var msg = (r.json && r.json.message) || r.error || ('HTTP ' + r.status);
        log('err', '任务「' + t.keyword + '」执行失败：' + msg);
        toast(String(msg).slice(0, 90), 'err', '采集执行失败');
        return false;
      }
      var run = (r.data && r.data.run) || {};
      var chName = run.channel ? ('［' + chanName(run.channel) + '］') : '';
      var note = run.status === 'ok'
        ? ('本轮新增 ' + (run.fresh || 0) + ' 条（抓到 ' + (run.got || 0) + ' 条，去重拦截 ' + (run.dup || 0) + ' 条）')
        : (run.status === 'skipped'
          ? '本轮跳过：未接入任何采集通道'
          : ('失败：' + (run.reason || run.note || '')));
      log(run.status === 'ok' ? 'ok' : (run.status === 'skipped' ? 'warn' : 'err'),
        '任务「' + t.keyword + '」' + chName + note + (run.simulated ? '（本地模拟数据）' : ''));
      if (!silent) toast(note, run.status === 'ok' ? 'ok' : 'warn', '调度任务已执行');
      audit('collect.sched.run', t.keyword);
      return refresh(true).then(function () { return true; });
    })['catch'](function (e) {
      log('err', '执行异常：' + String((e && e.message) || e));
      return false;
    });
  }

  function toggleTask(id, on) {
    return call('/v1/collect/tasks/' + encodeURIComponent(id), { enabled: !!on }, 'PATCH').then(function (r) {
      if (!r.ok) { toast('操作失败：' + (r.error || r.code), 'err'); refresh(); return false; }
      var t = taskOf(id);
      log(on ? 'ok' : 'warn', '调度任务「' + (t ? t.keyword : id) + '」已' + (on ? '启用' : '暂停'));
      audit(on ? 'collect.sched.enable' : 'collect.sched.pause', (t ? t.keyword : id));
      return refresh(true);
    });
  }

  function removeTask(id) {
    var t = taskOf(id);
    appConfirm({
      title: '删除调度任务',
      msg: '将停止「' + (t ? t.keyword : id) + '」的服务端自动采集。已抓到的线索与运行记录会保留。',
      icon: 'i-warning',
      okText: '删除',
      onOk: function () {
        call('/v1/collect/tasks/' + encodeURIComponent(id), null, 'DELETE').then(function (r) {
          if (!r.ok) { toast('删除失败：' + (r.error || r.code), 'err'); return; }
          log('warn', '已删除调度任务「' + (t ? t.keyword : id) + '」');
          audit('collect.sched.del', (t ? t.keyword : id));
          refresh(true);
        });
      }
    });
  }

  function taskOf(id) {
    for (var i = 0; i < SD.tasks.length; i++) if (SD.tasks[i].id === id) return SD.tasks[i];
    return null;
  }

  /* ---- 新建 / 改频率（同一个表单） ---- */
  function openForm(task) {
    var isEdit = !!task;
    var form = {
      platform: (task && task.platform) || 'douyin',
      every: (task && task.every) || '1h',
      cron: (task && task.cron) || '',
      channel: (task && task.channel) || 'auto',
      scope: (task && task.scope) || 'auto',
      planMode: (task && task.cron) ? 'cron' : 'every'
    };
    var body =
      '<div class="colsd-form">' +
        '<div class="colsd-fld"><label>监听关键词 ' + (isEdit ? '<i>（不可修改，如需更换请新建）</i>' : '') + '</label>' +
          '<input class="colsd-inp" id="colsdKw" maxlength="60" ' +
          (isEdit ? 'disabled value="' + esc(task.keyword) + '"' : 'placeholder="例如：抖音代运营 报价"') + '>' +
          '<div class="colsd-hint">按客户真实搜索的长词填写，命中率更高。</div></div>' +
        '<div class="colsd-row2">' +
          '<div class="colsd-fld"><label>平台</label><div class="colsd-seg" id="colsdPf">' +
            Object.keys(PLAT_NAME).map(function (k) {
              return '<button type="button" data-pf="' + k + '"' + (k === form.platform ? ' class="on"' : '') + '>' +
                esc(PLAT_NAME[k]) + '</button>';
            }).join('') +
          '</div></div>' +
          '<div class="colsd-fld"><label>单轮抓取条数</label>' +
            '<input class="colsd-inp" id="colsdLimit" type="number" min="1" max="50" value="' + ((task && task.limit) || 20) + '"></div>' +
        '</div>' +
        '<div class="colsd-fld"><label>采集范围 <i>决定采「谁的评论」</i></label>' +
          '<div class="colsd-seg" id="colsdScopeSeg">' +
            SCOPE_ORDER.map(function (k) {
              return '<button type="button" data-scope="' + k + '"' + (k === form.scope ? ' class="on"' : '') + '>' +
                esc(SCOPE_META[k].name) + '</button>';
            }).join('') +
          '</div>' +
          '<div class="colsd-hint" id="colsdScopeHint">—</div></div>' +
        '<div class="colsd-fld"><label>采集通道 <i>决定从哪条上游取</i></label>' +
          '<div class="colsd-seg" id="colsdChanSeg">' +
            chanOptions().map(function (o) {
              var cls = (o.id === form.channel ? 'on' : '') + (o.configured === false ? ' na' : '');
              return '<button type="button" data-chan="' + o.id + '"' +
                (cls.trim() ? ' class="' + cls.trim() + '"' : '') +
                '>' + esc(o.name) + '</button>';
            }).join('') +
          '</div>' +
          '<div class="colsd-hint" id="colsdChanHint">—</div></div>' +
        '<div class="colsd-fld"><label>排期方式</label><div class="colsd-seg" id="colsdMode">' +
          '<button type="button" data-mode="every"' + (form.planMode === 'every' ? ' class="on"' : '') + '>固定间隔</button>' +
          '<button type="button" data-mode="cron"' + (form.planMode === 'cron' ? ' class="on"' : '') + '>Cron 表达式</button>' +
        '</div></div>' +
        '<div id="colsdEveryWrap"><div class="colsd-fld"><label>采集频率</label>' +
          '<div class="colsd-seg" id="colsdEverySeg">' +
            EVERY_KEYS.map(function (k) {
              return '<button type="button" data-every="' + k + '"' + (k === form.every ? ' class="on"' : '') + '>' +
                esc(EVERY_LABEL[k]) + '</button>';
            }).join('') +
          '</div></div></div>' +
        '<div id="colsdCronWrap"><div class="colsd-fld"><label>Cron 表达式 <i>分 时 日 月 周（5 段）</i></label>' +
          '<input class="colsd-inp" id="colsdCron" placeholder="0 9,15,21 * * *" value="' + esc(form.cron) + '">' +
          '<div class="colsd-seg" id="colsdPresets">' +
            CRON_PRESETS.map(function (p) {
              return '<button type="button" data-preset="' + esc(p.c) + '">' + esc(p.t) + '</button>';
            }).join('') +
          '</div>' +
          '<div class="colsd-hint">可用示例：<code>*/15 * * * *</code>（每 15 分钟）、<code>0 9 * * 1-5</code>（工作日 9 点）。</div>' +
        '</div></div>' +
        '<div class="colsd-preview" id="colsdPreview">排期预览：—</div>' +
      '</div>';

    var rec = appModal({
      title: isEdit ? '调整采集排期' : '新建采集调度任务',
      sub: '服务端常驻执行 · 关掉页面也会继续跑',
      icon: 'i-clock',
      wide: true,
      okText: isEdit ? '保存排期' : '创建调度任务',
      body: body,
      onOk: function () {
        var mask = rec && rec.mask;
        var pfBtn = q('#colsdPf button.on', mask);
        var platform = pfBtn ? pfBtn.getAttribute('data-pf') : 'douyin';
        var limit = Math.max(1, Math.min(50, Number((q('#colsdLimit', mask) || {}).value) || 20));
        var modeBtn = q('#colsdMode button.on', mask);
        var mode = modeBtn ? modeBtn.getAttribute('data-mode') : 'every';
        var everyBtn = q('#colsdEverySeg button.on', mask);
        var every = everyBtn ? everyBtn.getAttribute('data-every') : form.every;
        var cron = String((q('#colsdCron', mask) || {}).value || '').trim();
        var chanBtn = q('#colsdChanSeg button.on', mask);
        var channel = chanBtn ? chanBtn.getAttribute('data-chan') : form.channel;
        var scopeBtn = q('#colsdScopeSeg button.on', mask);
        var scope = scopeBtn ? scopeBtn.getAttribute('data-scope') : form.scope;
        /* 通道与范围的非法组合在提交前就拦掉，别等服务端 400/501 */
        if (scope === 'own' && channel === 'vendor') {
          toast('第三方数据服务不支持「自有内容」范围，请改用官方通道或把范围改成公开搜索', 'warn');
          return true;
        }

        var payload = { platform: platform, limit: limit, channel: channel, scope: scope };
        if (mode === 'cron') {
          if (!cron) { toast('请填写 Cron 表达式，或切回固定间隔', 'warn'); return true; }
          payload.cron = cron;
        } else {
          payload.every = every;
        }
        if (!isEdit) {
          var kwEl = q('#colsdKw', mask);
          var kw = kwEl ? String(kwEl.value || '').trim() : '';
          if (!kw) { toast('请填写要监听的关键词', 'warn'); return true; }
          if (SD.tasks.some(function (t) { return t.keyword === kw && t.platform === platform; })) {
            toast('该关键词在同一平台下已有调度任务', 'warn'); return true;
          }
          payload.keyword = kw;
        }

        var req = isEdit
          ? call('/v1/collect/tasks/' + encodeURIComponent(task.id), payload, 'PATCH')
          : call('/v1/collect/tasks', payload, 'POST');
        req.then(function (r) {
          if (!r.ok) {
            var msg = (r.json && r.json.message) || r.error || ('HTTP ' + r.status);
            if (r.status === 409) msg = '该关键词在该平台下已存在调度任务';
            toast(String(msg).slice(0, 90), 'err', isEdit ? '保存失败' : '创建失败');
            log('err', (isEdit ? '保存排期失败：' : '创建调度任务失败：') + msg);
            return;
          }
          var t = (r.data && r.data.task) || {};
          log('ok', (isEdit ? '已调整排期：' : '已创建调度任务：') + (t.keyword || payload.keyword || '') +
            ' · ' + (t.scheduleText || payload.cron || payload.every));
          toast(isEdit ? '排期已更新' : ('已开始调度「' + (t.keyword || payload.keyword) + '」'),
            'ok', isEdit ? '调度任务已更新' : '调度任务已创建');
          audit(isEdit ? 'collect.sched.update' : 'collect.sched.add', t.keyword || payload.keyword || '');
          refresh(true);
        });
        return false;
      }
    });
    if (!rec) return;
    var mask = rec.mask;
    /* 排期方式互斥：固定间隔 ↔ Cron，避免两种排期同时可编辑造成歧义 */
    function setCronMode(isCron) {
      var aw = q('#colsdEveryWrap', mask);
      var cw = q('#colsdCronWrap', mask);
      if (aw) aw.style.display = isCron ? 'none' : '';
      if (cw) cw.style.display = isCron ? '' : 'none';
      updatePreview(mask);
    }
    bindSeg('#colsdMode', mask, true, function (mode) { setCronMode(mode === 'cron'); });
    bindSeg('#colsdPf', mask, true);
    bindSeg('#colsdEverySeg', mask, true, function () { updatePreview(mask); });
    bindSeg('#colsdScopeSeg', mask, true, function () { syncRoute(mask); });
    bindSeg('#colsdChanSeg', mask, true, function () { syncRoute(mask); });
    setCronMode(form.planMode === 'cron');
    /* 通道与范围的联动：选了官方通道就只能采自有内容；改回公开搜索时
       把被官方通道锁定的 own 自动放开，避免提交出必然失败的组合 */
    syncRoute(mask);
    var presetWrap = q('#colsdPresets', mask);
    if (presetWrap) {
      presetWrap.addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('button') : null;
        if (!b) return;
        var inp = q('#colsdCron', mask);
        if (inp) inp.value = b.getAttribute('data-preset');
        updatePreview(mask);
      });
    }
    var cronInput = q('#colsdCron', mask);
    if (cronInput) {
      cronInput.addEventListener('input', function () { updatePreview(mask); });
      cronInput.addEventListener('blur', function () { updatePreview(mask); });
    }
    var everySeg = q('#colsdEverySeg', mask);
    if (everySeg && qa('#colsdEveryWrap .colsd-seg button.on', mask).length === 0) {
      var first = q('#colsdEverySeg button', mask);
      if (first) first.classList.add('on');
    }
    updatePreview(mask);
  }

  function bindSeg(sel, root, single, onPick) {
    var box = q(sel, root);
    if (!box) return;
    box.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('button') : null;
      if (!b) return;
      if (single) qa('button', box).forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      if (onPick) {
        onPick(b.getAttribute('data-mode') || b.getAttribute('data-pf') || b.getAttribute('data-every')
          || b.getAttribute('data-chan') || b.getAttribute('data-scope'));
      }
    });
  }

  /* 通道 × 范围联动：把必然失败的组合在界面上就消掉，
     而不是等用户提交后从服务端拿一个 400/501 */
  function syncRoute(mask) {
    if (!mask) return;
    var scopeBox = q('#colsdScopeSeg', mask);
    var chanBtn = q('#colsdChanSeg button.on', mask);
    var channel = chanBtn ? chanBtn.getAttribute('data-chan') : 'auto';
    var lockOwn = channel === 'official';   /* 官方开放能力：只能读自有内容 */
    var noOwn = channel === 'vendor';       /* 第三方数据服务：没有自有内容能力 */

    if (scopeBox) {
      var btns = qa('button', scopeBox);
      if (lockOwn) {
        btns.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-scope') === 'own'); });
      } else if (noOwn) {
        var onBtn = q('button.on', scopeBox);
        if (onBtn && onBtn.getAttribute('data-scope') === 'own') {
          btns.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-scope') === 'auto'); });
        }
      }
      btns.forEach(function (b) {
        var s = b.getAttribute('data-scope');
        var off = lockOwn ? (s !== 'own') : (noOwn && s === 'own');
        b.disabled = off;
        b.style.opacity = off ? '.45' : '';
      });
    }

    var scBtn = q('#colsdScopeSeg button.on', mask);
    var sc = scBtn ? scBtn.getAttribute('data-scope') : 'auto';
    var sHint = q('#colsdScopeHint', mask);
    if (sHint) {
      sHint.className = 'colsd-hint' + (lockOwn ? ' ok' : '');
      sHint.textContent = (SCOPE_META[sc] || {}).desc || ''
        + (lockOwn ? '　·　官方开放能力只能读自有账号作品，范围已锁定' : '');
    }
    var cHint = q('#colsdChanHint', mask);
    if (cHint) {
      var target = null;
      chanOptions().forEach(function (x) { if (x.id === channel) target = x; });
      cHint.className = 'colsd-hint' + (target && target.configured === false ? ' err' : '');
      cHint.textContent = chanDesc(channel);
    }
  }

  /* 排期预览：调用服务端 /v1/collect/preview，用真实推演结果校验表达式 */
  var previewTimer = null;
  function updatePreview(mask) {
    var out = q('#colsdPreview', mask);
    if (!out) return;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      var modeBtn = q('#colsdMode button.on', mask);
      var mode = modeBtn ? modeBtn.getAttribute('data-mode') : 'every';
      var payload = {};
      if (mode === 'cron') {
        var v = String((q('#colsdCron', mask) || {}).value || '').trim();
        if (!v) { out.innerHTML = '排期预览：请填写 Cron 表达式'; return; }
        payload.cron = v;
      } else {
        var eb = q('#colsdEverySeg button.on', mask);
        payload.every = eb ? eb.getAttribute('data-every') : '1h';
      }
      call('/v1/collect/preview', payload, 'POST').then(function (r) {
        if (!r.ok || !r.data) {
          out.className = 'colsd-preview';
          out.innerHTML = '排期预览：<span style="color:var(--red)">' +
            esc((r.json && r.json.message) || r.error || '服务端未响应') + '</span>';
          return;
        }
        var sc = r.data.schedule || {};
        var times = (r.data.times || []).slice(0, 4).map(fmtTime).join('　');
        out.className = 'colsd-preview';
        out.innerHTML = '排期预览：<b>' + esc(sc.text || '') + '</b><br>接下来：' + esc(times || '—');
      });
    }, 260);
  }

  /* ---- 把本地任务推送到服务端 ---- */
  function pushLocal() {
    if (!SD.reachable) {
      toast('请先在「设置 → 配置服务端」接入 BFF 地址', 'warn', '未接入服务端');
      return;
    }
    var local = (C().tasks || []).filter(function (t) { return t && t.on && t.kw; });
    if (!local.length) { toast('本地没有启用的采集任务', 'warn'); return; }

    var freqMap = { realtime: 'realtime', '600': '10m', '3600': '1h', daily2: '12h' };
    var payloads = [];
    var seen = {};
    local.forEach(function (t) {
      (t.pf && t.pf.length ? t.pf : ['douyin']).forEach(function (pf) {
        var key = pf + '|' + t.kw;
        if (seen[key]) return;                       /* 前端一个任务可挂多平台，服务端一平台一条 */
        if (SD.tasks.some(function (s) { return s.keyword === t.kw && s.platform === pf; })) return;
        seen[key] = 1;
        payloads.push({ keyword: t.kw, platform: pf, every: freqMap[t.freq] || '1h', limit: 20 });
      });
    });

    if (!payloads.length) {
      toast('本地任务在服务端已全部存在，无需推送', 'ok', '无需推送');
      return;
    }
    appConfirm({
      title: '推送到服务端调度',
      msg: '将把 ' + payloads.length + ' 条任务写入服务端调度（已在服务端的会自动跳过）。推送后由服务端按频率常驻执行。',
      icon: 'i-send',
      okText: '确认推送',
      onOk: function () {
        var done = 0, dup = 0, failed = 0;
        var chain = Promise.resolve();
        payloads.forEach(function (p) {
          chain = chain.then(function () {
            return call('/v1/collect/tasks', p, 'POST').then(function (r) {
              if (r.ok) done++;
              else if (r.status === 409) dup++;
              else failed++;
            });
          });
        });
        chain.then(function () {
          log('ok', '本地任务推送完成：新增 ' + done + ' 条' + (dup ? ('，已存在跳过 ' + dup + ' 条') : '') +
            (failed ? ('，失败 ' + failed + ' 条') : ''));
          toast('新增 ' + done + ' 条调度任务' + (dup ? ('，跳过 ' + dup + ' 条重复') : '') +
            (failed ? ('，' + failed + ' 条失败') : ''), failed ? 'warn' : 'ok', '推送完成');
          audit('collect.sched.push', done + ' 条');
          refresh(true);
        });
      }
    });
  }

  /* ---- 线索池 ---- */
  function openLeads() {
    /* 线索池已统一：与服务端无关的那份「调度线索池」并入了前端统一的线索池视图 */
    if (window.__COL_LEADS_POOL) { window.__COL_LEADS_POOL(); return; }
    if (!SD.reachable) { toast('请先接入服务端', 'warn'); return; }
    call('/v1/collect/leads?limit=60', null, 'GET').then(function (r) {
      if (!r.ok || !r.data) { toast('读取失败：' + (r.error || r.code), 'err'); return; }
      SD.leads = r.data.leads || [];
      SD.leadsTotal = r.data.total || 0;
      var list = SD.leads;
      var body = list.length
        ? '<div style="max-height:44vh;overflow:auto">' + list.map(function (l, i) {
            return '<div class="colsd-lead">' +
              '<div class="colsd-lead-n">' + (i + 1) + '</div>' +
              '<div class="colsd-lead-b">' +
                '<div class="colsd-lead-t">' + esc(l.comment) + '</div>' +
                '<div class="colsd-lead-m">' +
                  '<span class="tag ' + (PLAT_TAG[l.platform] || '') + '">' + esc(PLAT_NAME[l.platform] || l.platform) + '</span>' +
                  '<span>' + esc(l.nickname) + '</span>' +
                  '<span>关键词：' + esc(l.keyword) + '</span>' +
                  '<span>赞 ' + (l.likes || 0) + '</span>' +
                  '<span>' + esc(fmtTime(Date.parse(l.at))) + '</span>' +
                  (l.channel ? '<span class="tag">' + esc(chanName(l.channel)) + '</span>' : '') +
                  (l.scope === 'own' ? '<span class="tag green">自有内容</span>' : '') +
                  (l.simulated ? '<span class="tag amber">模拟数据</span>' : '') +
                '</div>' +
              '</div></div>';
          }).join('') + '</div>'
        : '<div class="colsd-empty"><b>线索池还是空的</b>调度任务执行成功后，去重后的新评论会进入这里。</div>';

      appModal({
        title: '调度线索池',
        sub: '共 ' + SD.leadsTotal + ' 条去重线索（展示最新 ' + list.length + ' 条）· 指纹按「平台+昵称+评论」去重'
          + leadsSourceNote(list),
        icon: 'i-users',
        wide: true,
        okText: '导出 CSV',
        cancelText: '关闭',
        body: body,
        onOk: function () {
          exportLeads(list);
          return false;
        }
      });
    });
  }

  /* 线索池的来源构成一句话：让「多少条来自自有内容、多少条来自爬虫」一眼可见 */
  function leadsSourceNote(list) {
    var by = {}, own = 0, sim = 0;
    (list || []).forEach(function (l) {
      var k = l.channel || (l.simulated ? 'local' : 'unknown');
      by[k] = (by[k] || 0) + 1;
      if (l.scope === 'own') own++;
      if (l.simulated) sim++;
    });
    var keys = Object.keys(by);
    if (!keys.length) return '';
    var parts = keys.map(function (k) { return chanName(k) + ' ' + by[k]; });
    var extra = [];
    if (own) extra.push('自有内容 ' + own);
    if (sim) extra.push('⚠ 模拟 ' + sim);
    return ' · 来源：' + parts.join(' / ') + (extra.length ? '（' + extra.join('，') + '）' : '');
  }

  function exportLeads(list) {
    if (!list || !list.length) { toast('暂无可导出的线索', 'warn'); return; }
    var head = ['平台', '关键词', '昵称', '评论', '视频', '点赞', '时间', '采集通道', '采集范围', '来源'];
    var rows = list.map(function (l) {
      return [PLAT_NAME[l.platform] || l.platform, l.keyword, l.nickname,
        String(l.comment || '').replace(/[\r\n,]/g, ' '), l.video || '', l.likes || 0,
        new Date(Date.parse(l.at) || Date.now()).toISOString(),
        l.channel ? chanName(l.channel) : '—', scopeName(l.scope || 'auto'),
        l.simulated ? '本地模拟' : '真实采集']
        .map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
    });
    var csv = '\ufeff' + head.join(',') + '\n' + rows.join('\n');
    try {
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '调度线索池_' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 800);
      toast('已导出 ' + list.length + ' 条线索', 'ok', '导出完成');
      audit('collect.sched.export', list.length + ' 条');
    } catch (e) {
      toast('导出失败：' + String((e && e.message) || e), 'err');
    }
  }

  /* ---------------- 6. 事件绑定与生命周期 ---------------- */
  function bindHost() {
    var card = q('#colsdCard');
    if (card && !card.__sd) {
      card.__sd = 1;
      card.addEventListener('click', function (ev) {
        var el = ev.target;
        var pick = function (attr, handler) {
          var n = el.closest ? el.closest('[' + attr + ']') : null;
          if (n) { handler(n.getAttribute(attr)); return true; }
          return false;
        };
        if (pick('data-sdswitch', function (id) {
          var t = taskOf(id);
          toggleTask(id, !(t && t.enabled));
        })) return;
        if (pick('data-sdrun', function (id) { runTask(id, false); })) return;
        if (pick('data-sdedit', function (id) { var t = taskOf(id); if (t) openForm(t); })) return;
        if (pick('data-sddel', function (id) { removeTask(id); })) return;
        /* 点条目空白处 = 查看详情 */
        var item = el.closest ? el.closest('[data-sdtask]') : null;
        if (item) openDetail(item.getAttribute('data-sdtask'));
      });
    }
    /* 区块级按钮（在 card 外，用 document 委托一次） */
    if (!document.__colsdBtns) {
      document.__colsdBtns = 1;
      document.addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-colsd]') : null;
        if (!b) return;
        var act = b.getAttribute('data-colsd');
        if (act === 'new') openForm(null);
        else if (act === 'refresh') refresh(false);
        else if (act === 'push') pushLocal();
        else if (act === 'leads') openLeads();
      });
      window.addEventListener('bff:changed', function () { refresh(true); });
    }
  }

  /* 只在采集器视图可见时才轮询，避免后台空转 */
  function visible() {
    var v = document.getElementById('v-content');
    return !!(v && v.classList.contains('active') && document.getElementById('colsdCard'));
  }

  function openDetail(id) {
    var t = taskOf(id);
    if (!t) return;
    call('/v1/collect/tasks/' + encodeURIComponent(id), null, 'GET').then(function (r) {
      var runs = (r.ok && r.data && r.data.runs) || [];
      var body =
        '<div class="colsd-preview">关键词：<b>' + esc(t.keyword) + '</b>　平台：' + esc(PLAT_NAME[t.platform] || t.platform) +
        '　排期：<b>' + esc(t.cron ? (t.scheduleText || t.cron) : (EVERY_LABEL[t.every] || t.every)) + '</b>' +
        '　单轮条数：' + (t.limit || 20) + '<br>' +
        '采集范围：<b>' + esc(scopeName(t.scope || 'auto')) + '</b>　采集通道：<b>' + esc(chanName(t.channel || 'auto')) + '</b>' +
        (t.channel && t.channel !== 'auto' ? '' : '（运行时按范围自动选）') + '<br>' +
        '下次执行：' + esc(fmtTime(t.nextRunAt)) + '（' + esc(fmtDelta(t.nextRunAt)) + '）　' +
        '累计执行 ' + (t.runs || 0) + ' 轮　累计入池 ' + (t.total || 0) + ' 条</div>' +
        (runs.length
          ? '<div style="margin-top:12px;max-height:38vh;overflow:auto">' + runs.map(function (x) {
              var m = STATUS_META[x.status] || { tag: '', text: x.status };
              return '<div class="colsd-lead"><div class="colsd-lead-b">' +
                '<div class="colsd-lead-t">' + esc(x.note || '') + '</div>' +
                '<div class="colsd-lead-m"><span class="tag ' + m.tag + '">' + m.text + '</span>' +
                '<span>' + esc(fmtTime(Date.parse(x.at))) + '</span>' +
                (x.channel ? '<span class="tag">' + esc(chanName(x.channel)) + '</span>' : '') +
                (x.scope === 'own' ? '<span class="tag green">自有内容</span>' : '') +
                '<span>抓到 ' + (x.got || 0) + ' 条</span>' +
                '<span>新增 ' + (x.fresh || 0) + '</span>' +
                '<span>去重 ' + (x.dup || 0) + '</span>' +
                '<span>' + (x.ms || 0) + 'ms</span>' +
                (x.manual ? '<span class="tag">手动</span>' : '<span class="tag">自动</span>') +
                (x.simulated ? '<span class="tag amber">模拟</span>' : '') +
                '</div></div></div>';
            }).join('') + '</div>'
          : '<div class="colsd-empty" style="padding:16px">尚无运行记录</div>');
      appModal({
        title: '调度任务详情',
        sub: t.keyword + ' · 最近 ' + runs.length + ' 轮执行记录',
        icon: 'i-doc',
        wide: true,
        okText: '立即执行一轮',
        cancelText: '关闭',
        body: body,
        onOk: function () { runTask(id, false); return false; }
      });
    });
  }

  function boot() {
    if (!document.getElementById('colsdCard')) return;
    bindHost();
    refresh(true);
    if (!SD.timer) {
      SD.timer = setInterval(function () {
        if (!visible()) return;
        /* 可见时：每 15s 刷新一次；区间内若有任务即将到点，也顺带刷新 */
        refresh(true);
      }, 15000);
    }
    /* 首屏提示一次，说明这块是服务端能力 */
    if (!SD.__greeted) {
      SD.__greeted = 1;
      if (!live()) log('info', '服务端调度未接入：采集当前仍由「手动点击 + 本地模拟」驱动；接入 BFF 后自动切换为常驻调度');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 900); });
  } else {
    setTimeout(boot, 900);
  }

  /* 对外暴露，便于自动化验证与排障 */
  window.__COLSD = {
    sd: SD, refresh: refresh, renderAll: renderAll, openForm: openForm, openDetail: openDetail,
    runTask: runTask, toggleTask: toggleTask, removeTask: removeTask,
    pushLocal: pushLocal, openLeads: openLeads, exportLeads: exportLeads,
    visible: visible, taskOf: taskOf, fmtDelta: fmtDelta, PLAT_NAME: PLAT_NAME,
    /* 采集通道（双模式）对外只读面 */
    chanName: chanName, scopeName: scopeName, chanOptions: chanOptions, chanDesc: chanDesc,
    CHANNEL_META: CHANNEL_META, SCOPE_META: SCOPE_META
  };
})();

