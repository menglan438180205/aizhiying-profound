

/* =========================================================
   交互增强层 —— 让全站按钮可点、可测、有反馈
   （Toast / Modal / 表单 / 真实导出 / 新建落库 / 测试助手）
   ========================================================= */
(function () {
'use strict';

/* ================= Toast ================= */
var toastWrap = null;
var TOAST_ICON = { ok: '#i-check-circle', info: '#i-bell', warn: '#i-warning', err: '#i-x', load: '#i-refresh' };
var TOAST_TITLE = { ok: '操作成功', info: '提示', warn: '注意', err: '操作失败', load: '处理中' };

function toast(msg, type, title, ms) {
  type = type || 'info';
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-wrap';
    document.body.appendChild(toastWrap);
  }
  var el = document.createElement('div');
  el.className = 'toast ' + type + ' in';
  el.innerHTML =
    '<svg class="icon t-ico"><use href="' + (TOAST_ICON[type] || '#i-bell') + '"/></svg>' +
    '<div style="flex:1;min-width:0"><b>' + esc(title || TOAST_TITLE[type]) + '</b>' +
    '<div class="t-msg">' + esc(msg) + '</div></div>' +
    '<button class="t-x" type="button" aria-label="关闭">&#215;</button>';
  toastWrap.appendChild(el);

  var timer = null;
  var kill = function () {
    if (el.classList.contains('out')) return;
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
  };
  el.querySelector('.t-x').addEventListener('click', kill);
  if (type !== 'load') timer = setTimeout(kill, ms || 3200);
  el._kill = kill;
  if (toastWrap.children.length > 5) toastWrap.firstChild.remove();
  return { el: el, close: kill };
}

/* ================= Modal ================= */
var modalStack = [];

function closeTopModal() {
  var m = modalStack.pop();
  if (!m) return;
  m.mask.classList.remove('in');
  setTimeout(function () { if (m.mask.parentNode) m.mask.parentNode.removeChild(m.mask); }, 200);
}

function openModal(cfg) {
  cfg = cfg || {};
  var mask = document.createElement('div');
  mask.className = 'modal-mask';
  var wide = cfg.wide ? ' wide' : '';
  var head = '<div class="modal-head">' +
    (cfg.icon ? '<div class="m-ico"><svg class="icon"><use href="#' + cfg.icon + '"/></svg></div>' : '') +
    '<div style="flex:1;min-width:0"><h3>' + esc(cfg.title || '') + '</h3>' +
    (cfg.sub ? '<p>' + esc(cfg.sub) + '</p>' : '') + '</div>' +
    '<button class="m-x" type="button" aria-label="关闭">&#215;</button></div>';
  var footInner;
  if (cfg.footer === null) footInner = '';
  else if (typeof cfg.footer === 'string') footInner = cfg.footer;
  else footInner =
    (cfg.cancelText === null ? '' : '<button class="btn" data-m="cancel" type="button">' + esc(cfg.cancelText || '取消') + '</button>') +
    (cfg.okText === null ? '' : '<button class="btn primary" data-m="ok" type="button">' + esc(cfg.okText || '确定') + '</button>');
  var foot = footInner ? '<div class="modal-foot">' + footInner + '</div>' : '';

  mask.innerHTML = '<div class="modal' + wide + '">' + head +
    '<div class="modal-body">' + (cfg.body || '') + '</div>' + foot + '</div>';
  document.body.appendChild(mask);
  requestAnimationFrame(function () { mask.classList.add('in'); });

  var rec = { mask: mask, cfg: cfg, onOk: cfg.onOk };
  modalStack.push(rec);

  var close = function () {
    var i = modalStack.indexOf(rec);
    if (i < 0) return;
    modalStack.splice(i, 1);
    mask.classList.remove('in');
    setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 200);
  };
  rec.close = close;

  mask.addEventListener('click', function (e) {
    if (e.target === mask) { close(); return; }
    if (e.target.closest('.m-x')) { close(); return; }   /* 右上角 ✕ */
    var b = e.target.closest('[data-m]');
    if (!b) return;
    if (b.dataset.m === 'cancel') { if (cfg.onCancel) cfg.onCancel(rec); close(); return; }
    if (b.dataset.m === 'ok') {
      if (!rec.onOk) { close(); return; }
      var keep = rec.onOk(rec, b);
      if (keep === true) return;   /* 返回 true 则保持打开 */
      close();
    }
  });

  var first = mask.querySelector('input,textarea,select');
  if (first) setTimeout(function () { first.focus(); }, 80);
  return rec;
}

/* 表单弹窗：fields → 自动渲染 + 收集 */
function formModal(cfg) {
  var html = (cfg.desc ? '<div style="font-size:12.4px;color:var(--text-2);line-height:1.75;margin-bottom:16px">' + cfg.desc + '</div>' : '');
  html += (cfg.fields || []).map(function (f) {
    var req = f.required ? ' <span class="req">*</span>' : '';
    var inner = '';
    if (f.type === 'textarea') inner = '<textarea class="fm-ta" name="' + f.name + '" placeholder="' + esc(f.placeholder || '') + '"></textarea>';
    else if (f.type === 'select') inner = '<select class="fm-sel" name="' + f.name + '">' +
      (f.options || []).map(function (o) { var v = typeof o === 'string' ? o : o.value; var l = typeof o === 'string' ? o : o.label; return '<option value="' + esc(v) + '">' + esc(l) + '</option>'; }).join('') + '</select>';
    else if (f.type === 'checks') inner = '<div class="fm-check">' + (f.options || []).map(function (o, i) {
      return '<label><input type="checkbox" name="' + f.name + '" value="' + esc(o.value || o) + '"' + (i === 0 ? ' checked' : '') + '><span>' + esc(o.label || o) + '</span></label>';
    }).join('') + '</div>';
    else inner = '<input class="fm-inp" name="' + f.name + '" type="' + (f.type || 'text') + '" placeholder="' + esc(f.placeholder || '') + '" value="' + esc(f.value || '') + '">';
    return '<div class="fm-row"><label>' + esc(f.label) + req + '</label>' + inner +
      (f.hint ? '<div class="fm-hint">' + f.hint + '</div>' : '') + '<div class="fm-err"></div></div>';
  }).join('');

  return openModal({
    title: cfg.title, sub: cfg.sub, icon: cfg.icon || 'i-plus', wide: cfg.wide,
    body: html, okText: cfg.okText || '确定',
    onCancel: cfg.onCancel ? function (rec) { cfg.onCancel(rec); } : undefined,
    onOk: function (rec, btn) {
      var data = {}, errs = [], checks = {};
      (cfg.fields || []).forEach(function (f) {
        var el = rec.mask.querySelector('[name="' + f.name + '"]');
        var row = el ? el.closest('.fm-row') : null;
        var raw = '';
        if (f.type === 'checks') {
          var on = Array.prototype.slice.call(rec.mask.querySelectorAll('[name="' + f.name + '"]:checked')).map(function (x) { return x.value; });
          data[f.name] = on; raw = on.join(',');
        } else {
          raw = el ? String(el.value || '').trim() : '';
          data[f.name] = raw;
        }
        if (row) row.querySelector('.fm-err').textContent = '';
        if (f.required && !raw) { errs.push({ row: row, msg: '请填写' + f.label }); }
        if (f.validate && raw) { var m = f.validate(raw, data); if (m) errs.push({ row: row, msg: m }); }
      });
      if (errs.length) {
        errs.forEach(function (e) { if (e.row) e.row.querySelector('.fm-err').textContent = e.msg; });
        toast(errs[0].msg, 'err', '请检查表单');
        return true;
      }
      if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
      var r = cfg.onSubmit ? cfg.onSubmit(data, rec) : null;
      if (r === true) return true;      /* 由 onSubmit 控制关闭 */
      if (btn) { btn.disabled = false; btn.textContent = cfg.okText || '确定'; }
      return false;
    }
  });
}

/* 确认框 */
function confirmDlg(cfg) {
  return openModal({
    title: cfg.title || '确认操作', sub: cfg.sub, icon: cfg.icon || 'i-warning',
    body: '<div style="font-size:13px;line-height:1.8;color:var(--text-2)">' + (cfg.html || esc(cfg.msg || '')) + '</div>',
    okText: cfg.okText || '确认', cancelText: cfg.cancelText || '取消',
    onOk: function () { if (cfg.onOk) cfg.onOk(); }
  });
}

/* ================= 工具 ================= */
function exportCSV(filename, headers, rows) {
  var lines = [headers.map(function (h) { return '"' + String(h).replace(/"/g, '""') + '"'; }).join(',')];
  rows.forEach(function (r) {
    lines.push(r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(','));
  });
  /* 加 BOM 保证 Excel 正确识别 UTF-8 中文 */
  var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast('已导出 ' + filename + '（' + rows.length + ' 条记录）', 'ok', '导出完成');
}

async function saveRecord(kind, title, meta) {
  state.records = state.records || [];
  state.records.push({ kind: kind, title: title, meta: meta || {} });
  if (state.demo || !cloud) return { demo: true };
  try {
    var r = await cloud.database.from('app_records').insert({ kind: kind, title: title, meta: meta || {} }).select();
    if (r.error) return { error: r.error.message };
    return { data: r.data };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

/* 克隆页面已有元素作为模板插入 —— 保证视觉 100% 一致 */
function cloneInto(btn, itemSel, mutate, opt) {
  opt = opt || {};
  var scope = (btn && btn.closest('section')) || document;
  var item = scope.querySelector(itemSel);
  if (!item) return null;
  var clone = item.cloneNode(true);
  clone.classList.add('flash');
  setTimeout(function () { clone.classList.remove('flash'); }, 1500);
  if (mutate) mutate(clone);
  if (opt.prepend) item.parentNode.insertBefore(clone, item);
  else item.parentNode.appendChild(clone);
  if (opt.scroll !== false) {
    try { clone.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
  }
  return clone;
}

function setText(root, sel, txt) {
  var el = root.querySelector(sel);
  if (el) el.textContent = txt;
  return el;
}

/* 真实二维码渲染：PFQR 生成标准 QR（纠错 M / 版本 1-10），微信与系统相机均可识别。
   注意：内容必须是可访问的绝对 URL，否则扫出来也打不开。 */
function drawQR(canvas, text) {
  if (!canvas) return null;
  var msg = String(text == null ? '' : text).trim();
  if (!msg) return null;
  if (!window.PFQR) { qrFallback(canvas, '编码器未加载'); return null; }
  try {
    return window.PFQR.draw(canvas, msg, { width: 180, quiet: 3, dark: '#161528', light: '#ffffff' });
  } catch (e) {
    qrFallback(canvas, (e && e.message) ? String(e.message).slice(0, 40) : '内容过长');
    return null;
  }
}

/* 编码失败时不要留一张空白画布，直接说明原因 */
function qrFallback(canvas, reason) {
  try {
    var box = canvas.parentNode;
    canvas.width = 168; canvas.height = 168;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 168, 168);
    ctx.fillStyle = '#8E8DA5';
    ctx.font = '12px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('二维码不可用', 84, 78);
    ctx.fillText(reason || '', 84, 98);
    if (box) box.classList.add('is-state');
    var st = box && box.querySelector('.wx-qr-state');
    if (st) st.textContent = '二维码不可用：' + (reason || '未知原因');
  } catch (e) {}
}

function qrBlock(id) {
  return '<div class="m-qr"><canvas id="' + (id || 'qrCanvas') + '"></canvas><div class="scan"></div></div>';
}
function paintQR(mask, text, id) {
  return drawQR(mask.querySelector('#' + (id || 'qrCanvas')), text);
}

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* 按钮 loading 态 */
async function withLoading(btn, text, fn) {
  if (!btn) return fn();
  var old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>' + esc(text || '处理中…');
  try { return await fn(); }
  finally { btn.disabled = false; btn.innerHTML = old; }
}

/* ================= 上下文读取 ================= */
function btnText(b) { return (b.textContent || '').replace(/\s+/g, '').trim(); }

function ctxTitle(btn) {
  var c = btn.closest('.card');
  if (c) { var h = c.querySelector('.card-head h3, h3, h2'); if (h) return h.textContent.trim(); }
  var st = btn.closest('.section-title');
  if (st) { var h2 = st.querySelector('h2'); if (h2) return h2.textContent.trim(); }
  var v = btn.closest('.view');
  if (v && META[v.id]) return META[v.id][0];
  return '当前模块';
}

function rowName(btn) {
  var tr = btn.closest('tr');
  if (tr) { var b = tr.querySelector('td b, b'); if (b) return b.textContent.trim(); }
  var card = btn.closest('.lead, .kcard, .live, .wx-card, .acct-row, .emp');
  if (card) { var b2 = card.querySelector('b'); if (b2) return b2.textContent.trim(); }
  return '';
}

function findLead(name) {
  if (!name) return null;
  return state.leads.find(function (l) { return l.nickname === name; }) ||
         state.leads.find(function (l) { return l.nickname.indexOf(name) > -1 || name.indexOf(l.nickname) > -1; }) ||
         null;
}

/* 时间线模板 */
function timeline(stage) {
  var steps = [
    ['评论区捕捉到意向留言', 'AI 命中「报价 / 预算 / 起量」等高意向词'],
    ['AI 已发送私信并引导加微', '首轮话术：同行业案例 + 起投门槛 + 案例集'],
    ['已添加微信并自动备注', '备注格式：客户名 · 需求 · 地区'],
    ['进入洽谈，AI 已发报价单', '等待客户确认服务范围与预算'],
    ['成交', '已生成订单，进入复购唤醒池']
  ];
  var idx = { new: 0, sent: 1, wechat: 2, nego: 3, deal: 4, sleep: 1 }[stage];
  return steps.map(function (s, i) {
    var done = i < idx, cur = i === idx;
    var ic = done ? 'i-check' : (cur ? 'i-clock' : 'i-arrow-down');
    var color = done ? 'var(--green)' : (cur ? 'var(--primary)' : 'var(--text-3)');
    return '<div class="m-item"><div class="mi-ico" style="background:transparent;color:' + color + '">' +
      '<svg class="icon"><use href="#' + ic + '"/></svg></div><div><b style="color:' + (i <= idx ? 'var(--text)' : 'var(--text-3)') + '">' + s[0] + '</b>' +
      '<div class="mi-sub">' + s[1] + '</div></div></div>';
  }).join('');
}

/* ================= 各按钮动作 ================= */

/* ---- 线索详情 ---- */
function actLeadDetail(btn) {
  var name = rowName(btn);
  var l = findLead(name) || {
    nickname: name || '客户', platform: 'douyin', keyword: '千川投流 服务商',
    comment: '想了解你们的代运营服务，怎么合作？', intent_score: 75, stage: 'new',
    requirement: '代运营询价', wechat_note: null, amount: null
  };
  var m = PF[l.platform] || PF.douyin;
  var box = openModal({
    title: l.nickname, sub: m.label + ' · 关键词「' + (l.keyword || '—') + '」', icon: 'i-users', wide: true,
    body:
      '<div class="m-stat">' +
        '<div><b style="color:' + scoreColor(l.intent_score || 0) + '">' + (l.intent_score || 0) + '</b><span>意向分</span></div>' +
        '<div><b>' + (STAGE_META[l.stage] || STAGE_META.new).label + '</b><span>当前阶段</span></div>' +
        '<div><b>' + (l.amount ? yuan(l.amount) : '—') + '</b><span>预估金额</span></div>' +
      '</div>' +
      '<div class="fm-row"><label>评论区原文</label><div class="m-code">' + esc(l.comment || '—') + '</div></div>' +
      '<div class="fm-row"><label>需求摘要</label><div style="font-size:13px;color:var(--text-2)">' + esc(l.requirement || '—') + '</div></div>' +
      '<div class="fm-row"><label>微信备注</label><div style="font-size:13px;color:' + (l.wechat_note ? 'var(--green)' : 'var(--text-3)') + '">' +
        esc(l.wechat_note || '尚未添加微信') + '</div></div>' +
      '<div class="fm-row"><label>跟进时间线</label><div class="m-list">' + timeline(l.stage) + '</div></div>',
    okText: '推进到下一阶段',
    onOk: async function () {
      var next = NEXT_STAGE[l.stage] || 'sent';
      var patch = { stage: next, updated_at: new Date().toISOString() };
      if (next === 'wechat' && !l.wechat_note) patch.wechat_note = l.nickname + '·' + (l.requirement || l.keyword || '意向客户');
      await updateLead(l.id, patch);
      toast('「' + l.nickname + '」已推进到「' + (STAGE_META[next] || {}).label + '」', 'ok', '阶段已更新');
      if (state.demo) renderAll();
    }
  });
  /* 追加次要操作 */
  var foot = box.mask.querySelector('.modal-foot');
  var extra = document.createElement('button');
  extra.type = 'button'; extra.className = 'btn';
  extra.innerHTML = '<svg class="icon"><use href="#i-send"/></svg>发送私信';
  extra.style.marginRight = 'auto';
  extra.addEventListener('click', async function () {
    extra.disabled = true; extra.innerHTML = '发送中…';
    await wait(700);
    extra.disabled = false; extra.innerHTML = '<svg class="icon"><use href="#i-send"/></svg>发送私信';
    toast('已向「' + l.nickname + '」发送首轮私信并引导加微', 'ok', '私信已发送');
    if (l.stage === 'new') { await updateLead(l.id, { stage: 'sent' }); if (state.demo) renderAll(); }
  });
  foot.insertBefore(extra, foot.firstChild);
}

/* ---- 新建监听任务 ---- */
function actNewMonitor(btn) {
  formModal({
    title: '新建关键词监听任务', sub: 'AI 将在指定平台扫描评论区中的意向客户',
    icon: 'i-radar', okText: '创建任务',
    fields: [
      { name: 'kw', label: '监听关键词', required: true, placeholder: '如：抖音代运营 报价' },
      { name: 'pf', label: '扫描平台', type: 'checks', options: [{ value: 'dy', label: '抖音' }, { value: 'ks', label: '快手' }, { value: 'xhs', label: '小红书' }, { value: 'sph', label: '视频号' }] },
      { name: 'freq', label: '扫描频率', type: 'select', options: ['实时（推荐）', '每 10 分钟', '每小时', '每天 2 次'] },
      { name: 'hit', label: '高意向判定词', placeholder: '报价、预算、起量、合作', hint: '命中任意词即标记为高意向并提升意向分' },
      { name: 'note', label: '备注', type: 'textarea', placeholder: '可选：说明该词针对的产品线' }
    ],
    onSubmit: async function (d) {
      var pfMap = { dy: '抖音', ks: '快手', xhs: '小红书', sph: '视频号' };
      var tags = (d.pf || []).map(function (p) { return '<span class="tag blue">' + pfMap[p] + '</span>'; }).join('');
      var hit = (d.hit || '').split(/[、,，\s]+/).filter(Boolean);
      var n = cloneInto(btn, '.kw-list .kw-item', function (c) {
        var sw = c.querySelector('.switch'); if (sw) sw.classList.add('on');
        setText(c, '.kw-name', d.kw);
        var tg = c.querySelector('.kw-tags');
        if (tg) tg.innerHTML = tags + '<span class="tag accent">高意向词</span>' +
          (hit.length ? '<span class="tag">含"' + esc(hit.slice(0, 3).join('/')) + '"</span>' : '');
        var stat = c.querySelector('.kw-stat');
        if (stat) stat.innerHTML = '<b style="color:var(--primary)">0</b><span>今日线索</span>';
      });
      await saveRecord('monitor', d.kw, { platforms: d.pf, freq: d.freq, hit: hit, note: d.note });
      toast('监听任务「' + d.kw + '」已创建，' + (d.pf || []).length + ' 个平台已开始扫描', 'ok', '任务已上线');
      if (!n) toast('已在云端保存，刷新后可在列表中看到', 'info');
    }
  });
}

/* ---- 筛选 ---- */
function actFilter(btn) {
  var isCrm = !!btn.closest('#v-crm');
  formModal({
    title: isCrm ? '筛选客户' : '筛选线索', sub: '筛选条件会立即应用到当前列表',
    icon: 'i-filter', okText: '应用筛选', cancelText: '清除筛选',
    fields: [
      { name: 'pf', label: '来源平台', type: 'select', options: [{ value: '', label: '全部平台' }, { value: 'douyin', label: '抖音' }, { value: 'kuaishou', label: '快手' }, { value: 'xhs', label: '小红书' }, { value: 'sph', label: '视频号' }] },
      { name: 'stage', label: '跟进阶段', type: 'select', options: [{ value: '', label: '全部阶段' }, { value: 'new', label: '新线索' }, { value: 'sent', label: '已私信' }, { value: 'wechat', label: '已加微' }, { value: 'nego', label: '洽谈中' }, { value: 'deal', label: '已成交' }, { value: 'sleep', label: '待唤醒' }] },
      { name: 'min', label: '最低意向分', type: 'select', options: [{ value: '0', label: '不限' }, { value: '60', label: '60 分以上' }, { value: '75', label: '75 分以上' }, { value: '85', label: '85 分以上（高意向）' }] }
    ],
    onCancel: function () { state.filter = null; renderAll(); toast('已清除筛选条件', 'info', '筛选已清除'); },
    onSubmit: function (d) {
      state.filter = { platform: d.pf || null, stage: d.stage || null, minScore: Number(d.min || 0) };
      var n = state.leads.filter(function (l) {
        if (state.filter.platform && l.platform !== state.filter.platform) return false;
        if (state.filter.stage && l.stage !== state.filter.stage) return false;
        if ((l.intent_score || 0) < state.filter.minScore) return false;
        return true;
      }).length;
      renderAll();
      toast('共筛出 ' + n + ' 条符合条件的线索', 'ok', '筛选已应用');
    }
  });
}

/* ---- 导出 ---- */
function actExportLeads(btn) {
  var rows = state.leads.map(function (l) {
    return [l.nickname, (PF[l.platform] || PF.douyin).label, l.keyword || '', (l.comment || '').replace(/\n/g, ' '),
      l.intent_score || 0, (STAGE_META[l.stage] || {}).label || '', l.requirement || '', l.wechat_note || '', l.amount || ''];
  });
  if (!rows.length) { toast('暂无可导出的线索数据', 'warn'); return; }
  exportCSV('ProFound-客户线索-' + new Date().toISOString().slice(0, 10) + '.csv',
    ['客户', '平台', '来源关键词', '评论原文', '意向分', '阶段', '需求', '微信备注', '金额'], rows);
}

async function actExportCRM(btn) {
  await withLoading(btn, '导出中…', async function () {
    await wait(500);
    var high = state.leads.filter(function (l) { return (l.intent_score || 0) >= 70 && l.stage === 'new'; });
    if (!high.length) { toast('当前没有待同步的新线索（意向分 ≥70 且未触达）', 'warn', '无需同步'); return; }
    if (state.demo || !cloud) {
      high.forEach(function (l) { l.stage = 'sent'; l.updated_at = new Date().toISOString(); });
      renderAll();
      toast('演示模式：已在本地把 ' + high.length + ' 条高意向线索推进到「已私信」', 'ok', '已同步到 CRM');
      return;
    }
    var ok = 0;
    for (var i = 0; i < high.length; i++) {
      var r = await cloud.database.from('leads').update({ stage: 'sent', updated_at: new Date().toISOString() }).eq('id', high[i].id).select();
      if (!r.error && Array.isArray(r.data) && r.data.length) ok++;
    }
    await refreshData(); renderAll();
    toast('已把 ' + ok + ' 条高意向线索推进到「已私信」', 'ok', '已同步到 CRM');
  });
}

function actExportLog(btn) {
  var rows = [];
  var tbl = btn.closest('.card').querySelector('tbody');
  if (tbl) {
    Array.prototype.slice.call(tbl.querySelectorAll('tr')).forEach(function (tr) {
      rows.push(Array.prototype.slice.call(tr.children).map(function (td) { return td.textContent.trim(); }));
    });
  }
  if (!rows.length) { toast('暂无可导出的日志', 'warn'); return; }
  exportCSV('ProFound-操作日志-' + new Date().toISOString().slice(0, 10) + '.csv',
    ['时间', '执行者', '动作', '对象', '结果'], rows);
}

/* ---- 新建话术模板 ---- */
function actNewScript(btn) {
  formModal({
    title: '新建 AI 私信话术模板', sub: 'AI 会根据客户意图自动选用最合适的话术',
    icon: 'i-comment', okText: '保存模板',
    fields: [
      { name: 'name', label: '模板名称', required: true, placeholder: '如：④ 复购客户 · 老客专享' },
      { name: 'scene', label: '适用场景', type: 'select', options: ['问报价 · 高意向', '问效果 · 谨慎型', '连锁扩张 · 定制型', '复购唤醒', '沉默客户激活'] },
      { name: 'content', label: '话术内容', type: 'textarea', required: true, placeholder: '您好，看到您在找抖音代运营～', hint: '支持变量：{客户名} {关键词} {产品}' }
    ],
    onSubmit: async function (d) {
      cloneInto(btn, '.tpl-item', function (c) {
        c.classList.remove('active');
        c.setAttribute('data-say', d.content);
        var b = c.querySelector('b'); if (b) b.textContent = '④ ' + d.name;
        c.childNodes.forEach(function (node) {
          if (node.nodeType === 3 && node.textContent.trim()) node.textContent = ' ' + d.scene + ' · ' + d.content.slice(0, 22) + '…';
        });
      });
      await saveRecord('script', d.name, { scene: d.scene, content: d.content });
      toast('话术模板「' + d.name + '」已保存并加入 AI 话术库', 'ok', '模板已保存');
    }
  });
}

/* ---- 批量上传素材 ---- */
function actUpload(btn) {
  var rec = openModal({
    title: '批量上传素材', sub: '支持 mp4 / mov / jpg / png，单个不超过 500MB',
    icon: 'i-image', okText: '开始上传',
    body:
      '<div id="dropZone" style="border:1.5px dashed var(--border);border-radius:13px;padding:28px 18px;text-align:center;cursor:pointer;transition:.18s">' +
        '<svg class="icon" style="width:30px;height:30px;color:var(--text-3)"><use href="#i-image"/></svg>' +
        '<div style="font-size:13px;font-weight:600;margin-top:9px">点击选择文件，或拖拽到此处</div>' +
        '<div style="font-size:11.5px;color:var(--text-3);margin-top:5px">建议 9:16 竖版视频 · 1080×1920</div>' +
      '</div>' +
      '<input type="file" id="upInput" multiple accept="video/*,image/*" style="display:none">' +
      '<div class="up-list" id="upList" style="margin-top:14px"></div>' +
      '<div style="margin-top:14px;text-align:center">' +
        '<button class="btn sm ghost" id="demoFiles" type="button">没有素材？用 3 个示例素材演示</button>' +
      '</div>',
    onOk: function () {
      var n = rec.mask.querySelectorAll('.up-item').length;
      if (!n) { toast('请先选择要上传的素材文件', 'warn'); return true; }
      toast('已加入素材池 ' + n + ' 个文件，可立即用于智能剪辑', 'ok', '上传完成');
    }
  });
  setTimeout(function () {
    paintFiles(rec.mask);
  }, 60);
}

function paintFiles(mask) {
  var zone = mask.querySelector('#dropZone');
  var inp = mask.querySelector('#upInput');
  var list = mask.querySelector('#upList');
  var files = [];

  function renderUp() {
    list.innerHTML = files.map(function (f, i) {
      var mb = f.size ? (f.size / 1048576).toFixed(1) + ' MB' : f.sizeLabel;
      return '<div class="up-item"><div class="up-ico"><svg class="icon"><use href="#i-video"/></svg></div>' +
        '<div><div class="up-name">' + esc(f.name) + '</div>' +
        '<div class="up-size">' + mb + ' · <span class="up-st" style="color:var(--primary)">上传中</span></div>' +
        '<div class="up-bar"><i data-i="' + i + '"></i></div></div></div>';
    }).join('');
    files.forEach(function (f, i) {
      var bar = list.querySelector('.up-bar i[data-i="' + i + '"]');
      var st = list.querySelectorAll('.up-st')[i];
      var p = 0;
      var t = setInterval(function () {
        p += Math.random() * 22 + 9;
        if (p >= 100) {
          p = 100; clearInterval(t);
          if (st) { st.textContent = '已完成'; st.style.color = 'var(--green)'; }
        }
        if (bar) bar.style.width = p + '%';
      }, 220);
    });
  }

  if (zone) {
    zone.addEventListener('click', function () { inp.click(); });
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.style.borderColor = 'var(--primary)'; zone.style.background = 'var(--primary-soft)'; });
    zone.addEventListener('dragleave', function () { zone.style.borderColor = 'var(--border)'; zone.style.background = ''; });
    zone.addEventListener('drop', function (e) {
      e.preventDefault(); zone.style.borderColor = 'var(--border)'; zone.style.background = '';
      files = files.concat(Array.prototype.slice.call(e.dataTransfer.files || []));
      renderUp();
    });
  }
  if (inp) inp.addEventListener('change', function () {
    files = files.concat(Array.prototype.slice.call(inp.files || []));
    renderUp();
  });
  var dm = mask.querySelector('#demoFiles');
  if (dm) dm.addEventListener('click', function () {
    files = files.concat([
      { name: '代运营案例 · 实拍.mp4', size: 18.6 * 1048576 },
      { name: '千川起量 · 后台实拍.mp4', size: 24.1 * 1048576 },
      { name: '团队办公 · 投放复盘.mp4', size: 31.4 * 1048576 }
    ]);
    renderUp();
  });
}

/* ---- 一键智能剪辑 ---- */
async function actSmartEdit(btn) {
  await withLoading(btn, '排队中…', async function () {
    await wait(600);
    var titles = ['代运营案例 · 20 条混剪', '千川起量 · 投放复盘', '本地生活团购 · 案例讲解', '团队实力展示 · 15 条', '短视频拍摄 · 案例合集'];
    var title = titles[Math.floor(Math.random() * titles.length)];
    var task = {
      id: 't' + Date.now(), title: title, task_type: 'edit', status: 'queued', progress: 0,
      note: '素材 8 个 · 9:16 竖版 · 智能配音 + 字幕 · 智能去重已开启', created_at: new Date().toISOString()
    };
    state.tasks = state.tasks || [];
    state.tasks.unshift(task);
    renderTasks();
    toast('任务已创建：' + title, 'load', '智能剪辑已启动', 2600);

    saveRecord('edit_task', title, { note: task.note });

    var p = 0;
    var timer = setInterval(function () {
      p += Math.random() * 16 + 7;
      if (p >= 100) {
        p = 100; clearInterval(timer);
        task.status = 'done'; task.progress = 100;
        task.note = '已完成 · 20 条成片已进入发布排期（今日 18:00 / 20:30）';
        renderTasks();
        toast('剪辑完成，「' + title + '」已生成 20 条成片并进入发布队列', 'ok', '剪辑完成');
        return;
      }
      task.status = 'running'; task.progress = Math.round(p);
      renderTasks();
    }, 620);
  });
}

/* ---- 绑定发布账号 ---- */
function actBindAccount(btn) {
  formModal({
    title: '绑定发布账号', sub: '绑定后可用于批量发布与矩阵分发',
    icon: 'i-plus', okText: '绑定账号',
    fields: [
      { name: 'pf', label: '平台', type: 'select', options: [{ value: 'dy', label: '抖音' }, { value: 'ks', label: '快手' }, { value: 'xhs', label: '小红书' }, { value: 'sph', label: '视频号' }] },
      { name: 'name', label: '账号昵称', required: true, placeholder: '如：星野流量研究所' },
      { name: 'fans', label: '粉丝数', placeholder: '如：3.2万' }
    ],
    onSubmit: async function (d) {
      var pfMap = { dy: ['dy', '抖'], ks: ['ks', '快'], xhs: ['xhs', '红'], sph: ['sph', '视'] };
      var p = pfMap[d.pf] || pfMap.dy;
      cloneInto(btn, '.acct-row', function (c) {
        var span = c.querySelector('.pf');
        if (span) { span.className = 'pf ' + p[0]; span.textContent = p[1]; }
        var b = c.querySelector('b'); if (b) b.textContent = d.name;
        var sub = c.querySelector('div[style*="font-size:11px"]');
        if (sub) sub.textContent = ({ dy: '抖音', ks: '快手', xhs: '小红书', sph: '视频号' }[d.pf]) + ' · 粉丝 ' + (d.fans || '—') + ' · 今日已发 0 条';
        var tag = c.querySelector('.tag'); if (tag) tag.textContent = '待授权';
      });
      await saveRecord('account', d.name, { platform: d.pf, fans: d.fans });
      toast('「' + d.name + '」已加入发布账号矩阵', 'ok', '账号已绑定');
    }
  });
}

/* ---- 自动推荐时段 ---- */
async function actRecoTime(btn) {
  await withLoading(btn, '分析中…', async function () {
    await wait(1100);
    openModal({
      title: 'AI 推荐发布时段', sub: '基于近 30 天粉丝活跃度与同行发布时间分析', icon: 'i-trend', okText: '一键应用到排期',
      body: '<div class="m-list">' +
        [['抖音', '09:30 - 10:00', '本地商家早间活跃峰值，适合案例展示'],
         ['快手', '12:00 - 12:30', '午休时段转化最高，适合报价方案'],
         ['小红书', '20:00 - 21:00', '晚间种草高峰，适合案例与拆解'],
         ['视频号', '19:00 - 19:30', '社交推荐流量高峰，适合团队实力展示']]
          .map(function (r) {
            return '<div class="m-item"><div class="mi-ico" style="background:var(--primary-soft);color:var(--primary)"><svg class="icon"><use href="#i-clock"/></svg></div>' +
              '<div><b>' + r[0] + ' · ' + r[1] + '</b><div class="mi-sub">' + r[2] + '</div></div></div>';
          }).join('') + '</div>',
      onOk: function () {
        var chips = $$('.sch-chip');
        chips.forEach(function (c, i) { if (i % 3 === 0) { c.classList.add('new'); setTimeout(function () { c.classList.remove('new'); }, 4000); } });
        toast('已按推荐时段更新发布排期', 'ok', '排期已优化');
      }
    });
  });
}

/* ---- 新建排期 ---- */
function actNewSchedule(btn) {
  formModal({
    title: '新建发布排期', sub: '到点后由系统自动分发到对应平台',
    icon: 'i-clock', okText: '创建排期',
    fields: [
      { name: 'day', label: '星期', type: 'select', options: ['周一', '周二', '周三', '周四', '周五', '周六', '周日 · 今天'] },
      { name: 'pf', label: '平台', type: 'select', options: [{ value: 'douyin', label: '抖音' }, { value: 'kuaishou', label: '快手' }, { value: 'xhs', label: '小红书' }, { value: 'sph', label: '视频号' }] },
      { name: 'time', label: '发布时间', type: 'time', value: '19:00', required: true },
      { name: 'mat', label: '发布素材', placeholder: '如：代运营案例 · 30 条混剪' }
    ],
    onSubmit: async function (d) {
      var colorMap = { douyin: '--douyin', kuaishou: '--kuaishou', xhs: '--xhs', sph: '--sph' };
      var shortMap = { douyin: '抖', kuaishou: '快', xhs: '红', sph: '视' };
      var days = $$('.sch-day');
      var target = days.filter(function (x) { return x.querySelector('.d').textContent.trim() === d.day; })[0];
      var slot = target ? target.querySelector('.sch-slot') : null;
      if (slot) {
        var chip = document.createElement('div');
        chip.className = 'sch-chip new';
        chip.style.background = 'var(' + (colorMap[d.pf] || '--douyin') + ')';
        chip.innerHTML = shortMap[d.pf] + '<em>' + esc(d.time) + '</em>';
        var more = slot.querySelector('.sch-more');
        if (more) slot.insertBefore(chip, more); else slot.appendChild(chip);
        setTimeout(function () { chip.classList.remove('new'); }, 4000);
        chip.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      if (window.__MATRIX && window.__MATRIX.scheduleAdd) { window.__MATRIX.scheduleAdd(d.day, d.pf, d.time, d.mat); }
      await saveRecord('schedule', d.day + ' ' + d.time, { platform: d.pf, material: d.mat, day: d.day });
      toast('已创建排期：' + d.day + ' ' + d.time + ' 发布到' + ({ douyin: '抖音', kuaishou: '快手', xhs: '小红书', sph: '视频号' }[d.pf]), 'ok', '排期已创建');
    }
  });
}


/* ---- AI 员工配置 / 各功能弹窗 ---- */
function empModal(btn) {
  var t = btnText(btn), card = btn.closest('.card, .emp');
  var name = '';
  if (card) { var h = card.querySelector('.emp-top b, .card-head h3, h3'); if (h) name = h.textContent.trim(); }
  var title = (name ? name + ' · ' : '') + t;

  if (t === '配置') {
    formModal({
      title: title, sub: '调整该 AI 员工的工作参数', icon: 'i-setting', okText: '保存配置',
      fields: [
        { name: 'mode', label: '工作模式', type: 'select', options: ['全自动（无人值守）', '半自动（人工确认后发送）', '仅建议（不自动执行）'] },
        { name: 'hours', label: '工作时间', type: 'select', options: ['24 小时', '09:00 - 22:00', '10:00 - 19:00'] },
        { name: 'limit', label: '单日处理上限', type: 'select', options: ['100 条', '300 条', '600 条', '不设上限'] },
        { name: 'tone', label: '沟通语气', type: 'select', options: ['专业亲和', '热情主动', '简洁直接'] },
        { name: 'esc', label: '转人工条件', type: 'checks', options: [{ value: 'amount', label: '金额 > 1 万' }, { value: 'complain', label: '出现投诉' }, { value: 'custom', label: '客户要求人工' }] }
      ],
      onSubmit: async function (d) {
        await saveRecord('emp_cfg', name + ' · ' + t, d);
        toast('「' + (name || 'AI 员工') + '」配置已保存并即时生效', 'ok', '配置已更新');
      }
    });
    return;
  }

  var presets = {
    '查看日志': { icon: 'i-doc', items: [['11:42:08', '扫描抖音关键词「抖音代运营 报价」，命中 12 条意向留言'], ['11:39:56', '对「李总 · 连锁餐饮」发送首轮私信，话术模板 ①'], ['11:35:20', '识别到「预算 / ROI」为高意向，意向分 +18'], ['11:30:11', '本轮共触达 38 人，成功 34 人（成功率 89%）'], ['11:12:04', '限流保护触发：单号间隔自动调整为 45 秒']] },
    '查看会话': { icon: 'i-comment', items: [['陈小姐 · 新消费品牌', 'AI：团购代运营 3 家门店起做，服务费可按季度付'], ['泰和教培机构', 'AI：CPL 可开票，500 条/月以上再让 3 个点'], ['优家连锁', '客户：同城方便聊吗 → AI：随时欢迎，已发定位与行业案例'], ['美好生活馆', '客户：先投 5 万试试 → AI：已生成投放方案，预计明天发出']] },
    '知识库': { icon: 'i-layers', items: [['产品知识', '32 篇 · 代运营 / 千川投流 / 团购代运营 服务说明'], ['报价体系', '18 套 · 按投放预算 / 服务范围 / 周期分级'], ['常见问答', '64 条 · 起投门槛、ROI、结算、开票、素材归属'], ['竞品对比', '9 篇 · 与同行服务范围与报价差异']] },
    '渠道设置': { icon: 'i-globe', items: [['拼多多店铺客服', '已接入 · 自动答疑 / 催付 / 售后 · 今日 620 条'], ['抖音小店 + 私信', '已接入 · 评论区互动 + 私信引导加微 · 今日 486 条'], ['快手小店 + 私信', '已接入 · 自动回复 + 意向识别 · 今日 312 条'], ['视频号私信 + 直播间', '已接入 · 弹幕答疑 · 今日 133 条']] },
    '任务队列': { icon: 'i-clock', items: [['批量发布 46 条', '进行中 32% · 预计 12 分钟完成'], ['评论互动 486 次', '已完成 · 触发加微 89 人'], ['数据回传', '已完成 · 本轮同步 2,431 条指标'], ['素材去重处理', '排队中 · 队列第 3 位']] },
    '数据看板': { icon: 'i-trend', items: [['本周发布', '46 条 · 环比 +18%'], ['总播放量', '182 万 · 环比 +24%'], ['评论区留言', '6,420 条 · 意向率 12.4%'], ['引流加微', '312 人 · 环比 +31%']] },
    '报表': { icon: 'i-doc', items: [['本月营业额', '¥ 386,420 · 环比 +22.5%'], ['毛利率', '31.8% · 较上月 +1.2pt'], ['TOP 产品', '抖音代运营 / 千川投流 / 本地生活团购'], ['应收未收', '¥ 42,800 · 涉及 6 家客户']] },
    '对账明细': { icon: 'i-wallet', items: [['#AIZ20261008001', '标准版年费 ¥12,800 · 微信支付 · 已开票'], ['#AIZ20260912007', '基础版年费 ¥5,980 · 对公转账 · 已到账'], ['客户货款 · 引力投放', '¥46,000 · 已收 · 2026-10-06'], ['客户货款 · 泰和软装', '¥28,000 · 待收 3 天']] },
    '交付台账': { icon: 'i-box', items: [['抖音代运营 · 在投 42 户', '本月交付 1,240 条线索 · 缺口 60 条'], ['千川投流 · 在投 18 户', '本月消耗 286 万 · 回款率 92%'], ['本地生活团购 · 在投 26 户', '本月核销 8,400 单 · 低于目标 12%'], ['CPL 线索 · 交付中', '本月交付 3,600 条 · 在产 900 条']] },
    '交付预警': { icon: 'i-warning', items: [['CPL 线索 · 交付缺口', '距目标差 12%，建议 3 天内补量 600 条'], ['团购核销 · 低于目标', '按当前核销速度缺口 12%，建议加投达人探店'], ['线索质量', '近 7 天有效率 86%，高于行业均值 8pt'], ['回款账期', '平均 18 天，2 家客户超 30 天，需催收']] }
  };
  var p = presets[t];
  if (!p) { fallback(btn); return; }
  openModal({
    title: title, sub: '以下为该模块的实时数据（演示）', icon: p.icon, okText: '知道了', cancelText: null,
    body: '<div class="m-list">' + p.items.map(function (it) {
      return '<div class="m-item"><div class="mi-ico"><svg class="icon"><use href="#i-check"/></svg></div>' +
        '<div><b>' + esc(it[0]) + '</b><div class="mi-sub">' + esc(it[1]) + '</div></div></div>';
    }).join('') + '</div>'
  });
}

/* ---- 接入微信账号（原「扫码绑定个人微信」）----
   个人微信没有官方「扫码授权第三方托管」接口，能做到扫码接管的只有
   iPad 协议 / hook 一类的非官方手段，属于平台重点打击对象。
   所以这里不再渲染一个扫不出内容的假二维码，而是按真实接入方式登记：
   企业微信（官方接口）/ 服务商协议托管 / 仅登记人工跟进。 */
function actBindWechat(btn) {
  formModal({
    title: '接入微信账号',
    sub: '按实际接入方式登记，系统据此决定能否自动收发消息',
    icon: 'i-smartphone',
    okText: '登记并启用',
    desc: '<div style="background:var(--amber-soft);border:1px solid #F3DFB8;border-radius:11px;padding:11px 13px;font-size:12.1px;line-height:1.75;color:#8a5a00">' +
        '<b>为什么这里没有二维码：</b>微信个人号不提供「扫码授权第三方托管」的开放接口，' +
        '任何扫码即接管的方案都走非官方协议，封号风险由客户承担。' +
        '合规路径是接入企业微信，或只在系统内登记账号、由人工跟进。</div>',
    fields: [
      { name: 'name', label: '账号名称', required: true, placeholder: '如：王总 · 主号 / 客服 1 号' },
      { name: 'type', label: '接入方式', type: 'select', options: [
        { value: 'wecom', label: '企业微信（官方接口，合规推荐）' },
        { value: 'vendor', label: '服务商协议托管（个人号，有封号风险）' },
        { value: 'manual', label: '仅登记，人工跟进（不自动发消息）' }
      ], hint: '企业微信需在企微后台建自建应用并授权；系统不内置任何个人号协议。' },
      { name: 'cred', label: '接入凭证', placeholder: '企微填 CorpID / Secret；服务商填授权码；仅登记可留空',
        hint: '凭证只存本机数据目录，不下发到前端页面。' },
      { name: 'limit', label: '日添加上限', type: 'number', value: '20', hint: '建议 15–25；超过 30 触发风控的概率显著上升。' }
    ],
    onSubmit: function (data) {
      var label = data.type === 'wecom' ? '企业微信' : (data.type === 'vendor' ? '服务商协议' : '仅登记');
      cloneInto(btn, '.wx-card', function (c) {
        var b = c.querySelector('b'); if (b) b.textContent = data.name;
        var sub = c.querySelector('div[style*="font-size:11px"]');
        if (sub) sub.textContent = '今日回复 0 条 · ' + label + ' · 刚刚接入';
        var hs = c.querySelectorAll('.wx-health i');
        Array.prototype.forEach.call(hs, function (h, i) {
          if (data.type === 'manual' ? i < 2 : i < 4) h.classList.add('on');
        });
      });
      var card = btn.closest('.card');
      var tag = card ? card.querySelector('.card-head .tag') : null;
      if (tag) {
        var cur = parseInt(tag.textContent, 10) || 0;
        tag.textContent = (cur + 1) + '/10 已接入';
      }
      saveRecord('wechat', data.name, {
        at: new Date().toISOString(), mode: data.type, limit: Number(data.limit) || 0,
        cred: data.cred ? '已录入' : ''
      });
      if (data.type === 'manual') {
        toast('账号已登记，仅用于人工跟进，AI 不会主动发消息', 'ok', '已登记');
      } else if (data.type === 'vendor') {
        toast('已登记为服务商协议托管，请确认服务商资质并控制发送频率', 'warn', '请留意封号风险');
      } else {
        toast('已登记企业微信账号，填入 CorpID / Secret 后由企微官方接口接管', 'ok', '接入成功');
      }
    }
  });
}

/* ---- 导入号码 ---- */
function actImportPhone(btn) {
  formModal({
    title: '导入客户电话号码', sub: '支持从 Excel 粘贴，每行一个号码，可带备注',
    icon: 'i-phone', okText: '解析并导入',
    fields: [
      { name: 'list', label: '号码列表', type: 'textarea', required: true,
        placeholder: '13800001111 赵老板·家居卖场·年框投放\n15900002222 刘女士·口腔门诊·杭州\n18600003333',
        hint: '格式：号码 + 空格 + 备注（备注可选）。AI 将自动搜索匹配微信并添加。' },
      { name: 'limit', label: '单日添加上限', type: 'select', options: ['20 人/天（保守）', '50 人/天（推荐）', '80 人/天（激进）'] },
      { name: 'auto', label: '导入后立即执行自动加微', type: 'select', options: ['是，立即执行', '否，仅入库'] }
    ],
    onSubmit: async function (d) {
      var lines = String(d.list).split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
      var valid = [], invalid = 0;
      lines.forEach(function (l) {
        var m = l.match(/(1\d{10})/);
        if (m) valid.push({ phone: m[1], note: l.replace(m[1], '').trim() });
        else invalid++;
      });
      if (!valid.length) { toast('没有解析到有效的 11 位手机号', 'err', '导入失败'); return true; }
      var tbody = btn.closest('.card').querySelector('tbody');
      if (tbody) {
        valid.slice(0, 20).forEach(function (v, i) {
          var tr = document.createElement('tr');
          tr.className = 'flash';
          tr.innerHTML = '<td><b>' + v.phone.slice(0, 3) + '****' + v.phone.slice(7) + '</b></td>' +
            '<td><span class="tag accent">通讯录导入</span></td>' +
            '<td style="color:var(--text-2)">' + esc(v.note || '待 AI 自动备注') + '</td>' +
            '<td><span class="tag amber">等待通过</span></td>';
          tbody.insertBefore(tr, tbody.firstChild);
          setTimeout(function () { tr.classList.remove('flash'); }, 1500);
        });
      }
      await saveRecord('phone_import', '导入 ' + valid.length + ' 个号码', { count: valid.length, invalid: invalid, limit: d.limit, auto: d.auto });
      toast('成功解析 ' + valid.length + ' 个有效号码' + (invalid ? '（' + invalid + ' 行无效已跳过）' : '') +
        '，' + (d.auto.indexOf('是') === 0 ? '已加入自动加微队列，将按 ' + d.limit + ' 节流执行' : '已入库待处理'), 'ok', '导入完成');
    }
  });
}

/* ---- GEO ---- */
async function actGeoRefresh(btn) {
  await withLoading(btn, '检测中…', async function () {
    await wait(1400);
    var t = new Date();
    var hhmm = t.getHours().toString().padStart(2, '0') + ':' + t.getMinutes().toString().padStart(2, '0');
    var card = btn.closest('.card') || btn.closest('section');
    var sub = card ? card.querySelector('.card-head .hint, .hint') : null;
    if (sub) sub.textContent = '上次检测：刚刚 ' + hhmm;
    toast('已重新检测 6 个 AI 搜索平台的收录情况，整体覆盖率提升至 68%', 'ok', '检测完成');
  });
}

function actGeoPlan(btn) {
  var rec = openModal({
    title: 'GEO直通车内容方案生成中', sub: 'AI 正在根据行业词库与竞品缺口生成内容矩阵', icon: 'i-spark', wide: true,
    okText: null, cancelText: '关闭', body: '<div class="gen-load"><span class="spin"></span>正在分析 6 个 AI 搜索平台的收录规则…</div>'
  });
  setTimeout(function () {
    var plans = [
      ['抖音代运营哪家好？源头厂家怎么选', '知乎 / 百家号', '高'],
      ['抖音代运营一个月多少钱、怎么收费', '小红书 / 抖音图文', '高'],
      ['千川投流和自投有什么区别', '知乎 / 公众号', '高'],
      ['本地生活团购代运营收费与起量周期', '小红书 / 知乎', '中'],
      ['短视频拍摄外包一个月能出几条', '视频号 / 抖音', '中'],
      ['CPL 线索成本怎么核算才不亏', '百家号 / 知乎', '中'],
      ['2026 年本地生活投放趋势报告', '小红书 / 公众号', '高'],
      ['服务商实地探访：投放从建计划到起量', '视频号 / B 站', '中']
    ];
    var body = rec.mask.querySelector('.modal-body');
    body.innerHTML =
      '<div class="m-stat"><div><b>8</b><span>内容选题</span></div><div><b>6</b><span>目标平台</span></div><div><b>4</b><span>预计 30 天收录</span></div></div>' +
      '<div class="m-list">' + plans.map(function (p) {
        return '<div class="m-item"><div class="mi-ico" style="background:' + (p[2] === '高' ? 'var(--red-soft);color:var(--red)' : 'var(--amber-soft);color:var(--amber)') + '">' +
          '<svg class="icon"><use href="#i-doc"/></svg></div>' +
          '<div><b>' + esc(p[0]) + '</b><div class="mi-sub">投放：' + p[1] + ' · 优先级：' + p[2] + '</div></div></div>';
      }).join('') + '</div>';
    rec.mask.querySelector('.modal-foot').innerHTML =
      '<button class="btn" data-m="cancel" type="button">关闭</button>' +
      '<button class="btn primary" id="geoApply" type="button">一键生成全部内容</button>';
    rec.mask.querySelector('#geoApply').addEventListener('click', async function () {
      var b = this; b.disabled = true; b.textContent = '生成中…';
      await wait(1200);
      await saveRecord('geo_plan', 'GEO直通车内容方案', { count: plans.length, items: plans.map(function (p) { return p[0]; }) });
      b.textContent = '已生成 8 篇'; b.classList.remove('primary');
      toast('已生成 8 篇 GEO 内容并排入发布计划，预计 7-30 天陆续被 AI 搜索收录', 'ok', '内容已生成');
    });
  }, 1500);
}

/* ---- 直播 ---- */
function actScriptLib(btn) {
  openModal({
    title: '直播话术脚本库', sub: '共 6 套脚本，覆盖开场 / 产品讲解 / 逼单 / 收尾', icon: 'i-mic', okText: '知道了', cancelText: null,
    body: '<div class="m-list">' +
      [['团购招商专场 · 完整版', '开场留人 → 材质对比 → 价格锚点 → 逼单 → 收尾引导加微 · 18 分钟循环'],
       ['千川起量 · 诊断讲解版', '账户诊断 → 起量方案 → 报价与周期 → 引导留资 · 12 分钟循环'],
       ['代运营 · 报价方案版', '同行业案例 → 投放模型 → 阶梯报价 → 引导私信 · 15 分钟循环'],
       ['抖音 · 团购逼单版', '限时政策 → 名额紧迫 → 签约引导 · 8 分钟循环'],
       ['开场留人万能话术', '前 3 秒钩子 + 福利预告 + 关注引导'],
       ['收尾引导加微话术', '长期投放的老板评论区扣「合作」，顾问一对一报价']]
        .map(function (s) {
          return '<div class="m-item"><div class="mi-ico" style="background:var(--violet-soft);color:var(--violet)"><svg class="icon"><use href="#i-mic"/></svg></div>' +
            '<div><b>' + s[0] + '</b><div class="mi-sub">' + s[1] + '</div></div>' +
            '<button class="btn sm" data-use="' + esc(s[0]) + '" type="button">切换使用</button></div>';
        }).join('') + '</div>',
    onOk: null
  });
  setTimeout(function () {
    $$('[data-use]').forEach(function (b) {
      if (b._bound) return; b._bound = 1;
      b.addEventListener('click', function () {
        var tag = $('#v-live .card-head .tag.blue');
        if (tag) tag.textContent = b.dataset.use;
        toast('已切换到「' + b.dataset.use + '」', 'ok', '话术已切换');
      });
    });
  }, 80);
}

function actNewLive(btn) {
  formModal({
    title: '新建直播间', sub: 'AI 数字人主播 + 自动话术 + 自动逼单', icon: 'i-video', okText: '创建直播间',
    fields: [
      { name: 'name', label: '直播间名称', required: true, placeholder: '如：本地生活团购专场 · 商家招募' },
      { name: 'pf', label: '开播平台', type: 'checks', options: [{ value: 'dy', label: '抖音' }, { value: 'ks', label: '快手' }, { value: 'sph', label: '视频号' }, { value: 'pdd', label: '拼多多' }] },
      { name: 'host', label: '数字人主播', type: 'select', options: ['小织（女声 · 亲和）', '阿布（女声 · 活泼）', '严选（男声 · 专业）'] },
      { name: 'time', label: '计划开播时间', type: 'time', value: '20:00' },
      { name: 'script', label: '使用脚本', type: 'select', options: ['团购招商专场 · 完整版', '千川起量 · 诊断讲解版', '代运营 · 报价方案版', '抖音 · 团购逼单版'] }
    ],
    onSubmit: async function (d) {
      var pfMap = { dy: ['dy', '抖'], ks: ['ks', '快'], sph: ['sph', '视'], pdd: ['pdd', '拼'] };
      var chips = (d.pf || []).map(function (p) { return '<span class="pf ' + pfMap[p][0] + '">' + pfMap[p][1] + '</span>'; }).join('');
      cloneInto(btn, '.live-grid .live', function (c) {
        var pfBox = c.querySelector('.live-pf');
        if (pfBox) pfBox.innerHTML = chips;
        var badge = c.querySelector('.live-badge');
        if (badge) { badge.className = 'live-badge off'; badge.textContent = '待开播'; }
        var stage = c.querySelector('.live-stage');
        if (stage) stage.classList.remove('on');
        var b = c.querySelector('.live-body b'); if (b) b.textContent = d.name;
        var sub = c.querySelector('.live-body .sub');
        if (sub) sub.textContent = d.host.split('（')[0] + ' · 计划 ' + d.time + ' 自动开播 · 脚本已就绪';
        var stats = c.querySelectorAll('.live-stats b');
        Array.prototype.forEach.call(stats, function (s) { s.textContent = '—'; });
        var btns = c.querySelectorAll('button');
        if (btns[0]) { btns[0].textContent = '预览脚本'; }
        if (btns[1]) { btns[1].textContent = '改时间'; }
        if (btns[2]) { btns[2].textContent = '立即开播'; }
      });
      await saveRecord('live', d.name, { platforms: d.pf, host: d.host, time: d.time, script: d.script });
      toast('直播间「' + d.name + '」已创建，将于 ' + d.time + ' 自动开播', 'ok', '直播间已创建');
    }
  });
}

function actSwitchScript(btn) {
  var scripts = ['团购招商专场 · 完整版', '千川起量 · 诊断讲解版', '代运营 · 报价方案版', '抖音 · 团购逼单版'];
  var tag = document.querySelector('#v-live .card-head .tag.blue');
  var cur = tag ? tag.textContent.trim() : scripts[0];
  var i = (scripts.indexOf(cur) + 1) % scripts.length;
  var next = scripts[i];
  if (tag) tag.textContent = next;
  var card = btn.closest('.live');
  var sub = card ? card.querySelector('.sub') : null;
  if (sub && sub.textContent.indexOf('脚本') === -1) sub.textContent += ' · 已切换脚本';
  toast('已切换到「' + next + '」', 'ok', '话术已切换');
}

async function actConsole(btn) {
  var card = btn.closest('.live');
  var name = card ? (card.querySelector('.live-body b') || {}).textContent : '直播间';
  var viewers = 1286;
  var rec = openModal({
    title: '直播中控台', sub: name || '直播间', icon: 'i-monitor', wide: true, okText: null, cancelText: '关闭',
    body:
      '<div class="m-stat">' +
        '<div><b style="color:var(--accent)">¥12,860</b><span>实时成交</span></div>' +
        '<div><b id="dmOrders">86</b><span>订单数</span></div>' +
        '<div><b id="dmViewers">' + viewers.toLocaleString('zh-CN') + '</b><span>在线人数</span></div>' +
      '</div>' +
      '<div style="font-size:12px;font-weight:700;margin-bottom:9px">实时弹幕（高意向自动标黄）</div>' +
      '<div class="dm-box" id="dmBox"></div>' +
      '<div style="margin-top:14px;display:flex;gap:9px">' +
        '<button class="btn sm" id="dmSwitch" type="button">切话术</button>' +
        '<button class="btn sm" id="dmCatch" type="button">捕捉高意向客户</button>' +
        '<button class="btn sm primary" id="dmStop" type="button">结束直播</button>' +
      '</div>',
    onCancel: function () { if (rec._timer) clearInterval(rec._timer); }
  });
  var box = rec.mask.querySelector('#dmBox');
  var pool = [
    ['小王', '代运营一个月多少钱', 1], ['阿May', '案例能发一份吗', 0],
    ['连锁老李', '起投预算多少，我想试投', 1], ['家居控', '好看，已关注', 0],
    ['杭州张姐', '能加个微信聊报价吗', 1], ['小赵', '有千川起量的吗', 1],
    ['路人甲', '路过看看', 0], ['流量哥', '你们是代运营还是渠道', 0],
    ['订单王', '刚签了，什么时候开始投', 0], ['采购刘总', '30 万预算什么政策', 1]
  ];
  function push() {
    var d = pool[Math.floor(Math.random() * pool.length)];
    var el = document.createElement('div');
    el.className = 'dm' + (d[2] ? ' hot' : '');
    el.innerHTML = '<span class="who">' + esc(d[0]) + '：</span><span>' + esc(d[1]) + (d[2] ? ' <span class="tag accent">高意向</span>' : '') + '</span>';
    box.appendChild(el);
    while (box.children.length > 8) box.removeChild(box.firstChild);
    if (Math.random() > 0.72) {
      viewers += Math.floor(Math.random() * 40) - 12;
      var v = rec.mask.querySelector('#dmViewers');
      if (v) v.textContent = Math.max(1, viewers).toLocaleString('zh-CN');
    }
  }
  for (var i = 0; i < 5; i++) push();
  rec._timer = setInterval(push, 1400);

  rec.mask.querySelector('#dmCatch').addEventListener('click', function () {
    toast('已捕捉到 4 位高意向客户，已推送到 CRM 的新线索', 'ok', '已推送到 CRM');
  });
  rec.mask.querySelector('#dmSwitch').addEventListener('click', function () {
    toast('已切换下一段话术脚本', 'ok', '话术已切换');
  });
  rec.mask.querySelector('#dmStop').addEventListener('click', function () {
    clearInterval(rec._timer);
    rec.close();
    toast('直播已结束，本场累计成交 ¥12,860，新增微信 34 人', 'ok', '直播已结束');
  });
}

function actPreviewScript(btn) {
  var card = btn.closest('.live');
  var name = card ? (card.querySelector('.live-body b') || {}).textContent : '直播间';
  openModal({
    title: '话术脚本预览', sub: name || '', icon: 'i-doc', wide: true, okText: null, cancelText: '关闭',
    body: '<div class="m-code">' + esc(
      '【开场留人 0:00-0:30】\n' +
      '欢迎新进来的老板～我们专注本地生活代运营 6 年，服务过 300+ 门店。\n' +
      '今天这场不讲虚的，直接放政策，前 100 家再送投放诊断报告。\n\n' +
      '【产品讲解 0:30-6:00】\n' +
      '先看这套团购方案 —— 3 公里曝光、达人探店、核销闭环，餐饮美业都能用。\n' +
      '您看这个同城曝光密度，自投很难跑出来。\n\n' +
      '【价格锚点 6:00-10:00】\n' +
      '市面上代运营报价 8000 一月，我们 4800 一月，签年框还能再谈。\n' +
      '想拿案例的老板，评论区扣「案例」两个字。\n\n' +
      '【逼单 10:00-15:00】\n' +
      '这个价格只保留到今晚，本月只接 8 家，接满恢复原价。\n\n' +
      '【收尾引导加微 15:00-18:00】\n' +
      '长期投放的老板，评论区扣「合作」，我让顾问一对一给你出投放方案。'
    ) + '</div>'
  });
}

function actChangeTime(btn) {
  formModal({
    title: '修改开播时间', sub: '到点后系统自动开播', icon: 'i-clock', okText: '保存',
    fields: [{ name: 'time', label: '开播时间', type: 'time', value: '20:00', required: true },
             { name: 'repeat', label: '重复', type: 'select', options: ['每天', '仅今天', '工作日', '周末'] }],
    onSubmit: async function (d) {
      var card = btn.closest('.live');
      var sub = card ? card.querySelector('.sub') : null;
      if (sub) sub.textContent = '计划 ' + d.time + ' 自动开播（' + d.repeat + '）· 脚本已就绪';
      await saveRecord('live_time', '开播时间 ' + d.time, d);
      toast('开播时间已修改为 ' + d.time + '（' + d.repeat + '）', 'ok', '时间已保存');
    }
  });
}

async function actStartLive(btn) {
  await withLoading(btn, '启动中…', async function () {
    await wait(1200);
    var card = btn.closest('.live');
    if (card) {
      var stage = card.querySelector('.live-stage');
      if (stage) stage.classList.add('on');
      var badge = card.querySelector('.live-badge');
      if (badge) { badge.className = 'live-badge'; badge.innerHTML = '<span class="dot-live pulse"></span>直播中'; }
      var sub = card.querySelector('.sub');
      if (sub) sub.textContent = 'AI 数字人主播已上线 · 已播 0 分钟';
      if (!card.querySelector('.live-viewers')) {
        var v = document.createElement('span');
        v.className = 'live-viewers'; v.textContent = '在线 0 人';
        stage.appendChild(v);
      }
      var stats = card.querySelectorAll('.live-stats b');
      Array.prototype.forEach.call(stats, function (s) { s.textContent = '¥0'; });
      if (stats[1]) stats[1].textContent = '0';
      if (stats[2]) stats[2].textContent = '0%';
    }
    toast('直播已开播，AI 数字人主播已上线，开始自动讲解与逼单', 'ok', '开播成功');
    /* 在线人数模拟增长 */
    if (card) {
      var n = 0;
      var t = setInterval(function () {
        n += Math.floor(Math.random() * 40) + 8;
        var v = card.querySelector('.live-viewers');
        if (v) v.textContent = '在线 ' + n.toLocaleString('zh-CN') + ' 人';
        if (n > 900) clearInterval(t);
      }, 900);
    }
  });
}

function actEditScript(btn) {
  formModal({
    title: '编辑直播话术脚本', sub: '当前脚本：团购招商专场 · 完整版', icon: 'i-mic', wide: true, okText: '保存脚本',
    fields: [
      { name: 's0', label: '开场留人（0:00-0:30）', type: 'textarea', value: '欢迎新进来的老板～我们专注本地生活代运营 6 年，服务过 300+ 门店。今天这场不讲虚的，直接放政策，前 100 家再送投放诊断报告。' },
      { name: 's1', label: '产品讲解（0:30-6:00）', type: 'textarea', value: '先看这套团购方案 —— 3 公里曝光、达人探店、核销闭环，餐饮美业都能用。您看这个同城曝光密度，自投很难跑出来。' },
      { name: 's2', label: '逼单（10:00-15:00）', type: 'textarea', value: '这个价格只保留到今晚，本月只接 8 家，接满恢复原价。' },
      { name: 's3', label: '收尾引导加微（15:00-18:00）', type: 'textarea', value: '长期投放的老板，评论区扣「合作」，我让顾问一对一给你出投放方案。' }
    ],
    onSubmit: async function (d) {
      await saveRecord('live_script', '团购招商专场 · 完整版', d);
      toast('话术脚本已保存，将在下一轮循环中生效', 'ok', '脚本已保存');
    }
  });
}

async function actBatchDM(btn) {
  var names = ['李总 · 连锁餐饮', '张姐美业连锁', '赵老板 · 家居卖场'];
  await withLoading(btn, '批量发送中…', async function () {
    for (var i = 0; i < names.length; i++) {
      await wait(650);
      toast('已向「' + names[i] + '」发送个性化私信（第 ' + (i + 1) + '/3 条）', 'load', '发送中', 1400);
    }
    await wait(400);
    toast('3 条私信已全部发送完成，平均间隔 45 秒（合规节流）', 'ok', '批量发送完成');
  });
}

/* ---- 联系销售 ---- */
function actContactSales(btn) {
  var rec = openModal({
    title: '联系销售 / 预约演示', sub: '工作日 9:00-21:00 有专属顾问在线', icon: 'i-headset', okText: null, cancelText: '关闭',
    body:
      '<div class="m-list">' +
        '<div class="m-item"><div class="mi-ico" style="background:var(--primary-soft);color:var(--primary)"><svg class="icon"><use href="#i-phone"/></svg></div>' +
          '<div><b>400-888-6688</b><div class="mi-sub">销售热线 · 工作日 9:00-21:00</div></div>' +
          '<button class="btn sm" id="copyPhone" type="button">复制</button></div>' +
        '<div class="m-item"><div class="mi-ico" style="background:var(--green-soft);color:var(--green)"><svg class="icon"><use href="#i-comment"/></svg></div>' +
          '<div><b>微信：aizhiying-sales</b><div class="mi-sub">添加时备注「全行业获客」优先通过</div></div>' +
          '<button class="btn sm" id="copyWx" type="button">复制</button></div>' +
      '</div>' +
      (SALES_QR_URL
        ? '<div style="text-align:center;margin-top:18px">' + qrBlock('salesQr') + '</div>' +
          '<div style="text-align:center;font-size:12px;color:var(--text-3);margin-top:12px">扫码添加专属顾问，可申请 7 天免费试用</div>'
        : '<div class="alert info" style="margin-top:16px;font-size:12px"><svg class="icon"><use href="#i-warning"/></svg>' +
          '<div>顾问二维码未配置：后台填入 <b>SALES_QR_URL</b>（企业微信活码链接）后自动生成。' +
          '个人微信二维码无法由系统合成，需运营上传真实活码。</div></div>'),
    footer: '<button class="btn" id="bookDemo" type="button">预约线上演示</button>' +
            '<button class="btn primary" id="callNow" type="button">立即拨打</button>'
  });
  setTimeout(function () {
    if (SALES_QR_URL) paintQR(rec.mask, SALES_QR_URL, 'salesQr');
    var cp = function (txt, label) {
      return function () {
        try {
          if (navigator.clipboard) navigator.clipboard.writeText(txt);
        } catch (e) {}
        toast('已复制：' + txt, 'ok', label + '已复制');
      };
    };
    var p = rec.mask.querySelector('#copyPhone'), w = rec.mask.querySelector('#copyWx');
    if (p) p.addEventListener('click', cp('400-888-6688', '电话'));
    if (w) w.addEventListener('click', cp('aizhiying-sales', '微信号'));
    var c = rec.mask.querySelector('#callNow');
    if (c) c.addEventListener('click', function () { toast('演示环境不实际拨号，真实部署后将唤起拨号', 'info', '400-888-6688'); });
    var bd = rec.mask.querySelector('#bookDemo');
    if (bd) bd.addEventListener('click', function () {
      rec.close();
      formModal({
        title: '预约线上演示', sub: '顾问将在 1 个工作日内与你联系', icon: 'i-clock', okText: '提交预约',
        fields: [
          { name: 'phone', label: '手机号', required: true, placeholder: '11 位手机号', validate: function (v) { return /^1\d{10}$/.test(v) ? '' : '请输入正确的 11 位手机号'; } },
          { name: 'company', label: '公司 / 店铺名称', placeholder: '如：星野流量' },
          { name: 'biz', label: '主营产品', type: 'select', options: ['抖音代运营', '千川投流', '本地生活团购', '短视频拍摄外包', 'CPL 线索交付'] },
          { name: 'time', label: '方便的时间', type: 'select', options: ['今天下午', '明天上午', '明天下午', '本周内均可'] }
        ],
        onSubmit: async function (d) {
          await saveRecord('demo_booking', d.phone, d);
          toast('预约已提交，顾问会在 ' + d.time + ' 与你联系', 'ok', '预约成功');
        }
      });
    });
  }, 80);
}

/* ---- 兜底 ----
   历史问题：这里过去对**每一个**未登记的按钮都弹「已触发『X』（演示占位）」
   的 tosast。采集控制台的 添加 / 保存 / 取消 / 确认开启 都不在动作表里，
   于是每点一下都附带一条假提示，用户以为按钮是假的。
   现在默认静默：只有显式标了 data-demo 的按钮、或控制台打开
   window.__DEMO_TOAST__ = true 时才提示。 */
function fallback(btn) {
  if (!btn.hasAttribute('data-demo') && !window.__DEMO_TOAST__) {
    if (window.console && console.debug) console.debug('[interact] 未登记动作：', btnText(btn));
    return;
  }
  var t = btnText(btn);
  toast('已触发「' + (t || '按钮') + '」（演示占位，后端接入后执行真实动作）', 'info', '功能演示');
}

/* ================= 动作表 ================= */
var T = {
  '全部线索': function (b) { go('v-crm'); toast('已跳转到客户管理 CRM', 'info', '页面跳转'); },
  '跟进': actLeadDetail,
  '查看': actLeadDetail,
  '立即私信': function (b) { actLeadDetail(b); },
  '新建监听任务': actNewMonitor,
  '筛选': actFilter,
  '导出到CRM': actExportCRM,
  '导出Excel': actExportLeads,
  '新建话术模板': actNewScript,
  '批量上传': actUpload,
  '一键智能剪辑': actSmartEdit,
  '绑定': actBindAccount,
  '自动推荐时段': actRecoTime,
  '新建排期': actNewSchedule,
  '配置': empModal,
  '查看日志': empModal,
  '查看会话': empModal,
  '知识库': empModal,
  '渠道设置': empModal,
  '任务队列': empModal,
  '数据看板': empModal,
  '报表': empModal,
  '对账明细': empModal,
  '交付台账': empModal,
  '交付预警': empModal,
  '扫码绑定新微信': actBindWechat,
  '导入号码': actImportPhone,
  '刷新检测': actGeoRefresh,
  '生成GEO内容方案': actGeoPlan,
  '话术脚本库': actScriptLib,
  '新建直播间': actNewLive,
  '切话术': actSwitchScript,
  '中控台': actConsole,
  '进入': actConsole,
  '预览脚本': actPreviewScript,
  '改时间': actChangeTime,
  '立即开播': actStartLive,
  '编辑': actEditScript,
  '批量私信这': actBatchDM,
  '邀请成员': function (b) {
    formModal({
      title: '邀请团队成员', sub: '成员将收到短信邀请，按角色分配权限', icon: 'i-users', okText: '发送邀请',
      fields: [
        { name: 'phone', label: '手机号', required: true, placeholder: '11 位手机号', validate: function (v) { return /^1\d{10}$/.test(v) ? '' : '请输入正确的 11 位手机号'; } },
        { name: 'name', label: '成员姓名', placeholder: '如：刘主管' },
        { name: 'role', label: '角色权限', type: 'select', options: ['销售（客户跟进 · 不可导出）', '客服（仅会话与订单查询）', '运营（内容发布 · 数据看板）', '财务（对账与报表）', '管理员（全部权限）'] }
      ],
      onSubmit: async function (d) {
        var role = d.role.split('（')[0];
        cloneInto(b, '.acct-row', function (c) {
          var av = c.querySelector('.av');
          if (av) { av.className = 'av a3'; av.textContent = (d.name || d.phone).charAt(0); }
          var bb = c.querySelector('b'); if (bb) bb.textContent = d.name || (d.phone.slice(0, 3) + '****' + d.phone.slice(7));
          var sub = c.querySelector('div[style*="font-size:11px"]');
          if (sub) sub.textContent = d.role;
          var tag = c.querySelector('.tag');
          if (tag) { tag.className = 'tag amber'; tag.textContent = '待接受'; }
        });
        await saveRecord('member', d.name || d.phone, { phone: d.phone, role: d.role });
        toast('邀请已发送至 ' + d.phone.slice(0, 3) + '****' + d.phone.slice(7) + '（' + role + '）', 'ok', '邀请已发送');
      }
    });
  },
  '导出': actExportLog,
  '联系销售': actContactSales
};

function matchAction(txt) {
  if (!txt) return null;
  if (T[txt]) return T[txt];
  for (var k in T) if (txt.indexOf(k) === 0) return T[k];
  return null;
}

/* ================= 事件委托 ================= */
var SKIP_IDS = { menuBtn: 1, deviceBtn: 1, localLoginBtn: 1, localRegisterBtn: 1, demoBtn: 1, demoLoginBtn: 1, umLogout: 1, qaFab: 1, qaSelfBtn: 1 };

document.addEventListener('click', function (e) {
  var btn = e.target.closest('button');
  if (!btn) return;
  if (btn.disabled) return;
  if (btn.closest('.qa-panel') || btn.classList.contains('qa-fab')) return;   /* 测试助手自己处理 */
  if (btn.closest('.modal-mask')) return;                                      /* 弹窗内部自己处理 */
  if (btn.matches('[data-go],[data-act],[data-plan],[data-login-now],[data-m],[data-use],[data-col]')) return;
  if (btn.classList.contains('t-x') || btn.classList.contains('m-x')) return;   /* 关闭类按钮不触发动作 */
  if (btn.id && SKIP_IDS[btn.id]) return;
  if (btn.closest('.login')) return;                                           /* 登录页已绑定 */
  /* 采集控制台 / AI数字人两个模块的按钮全部由各自脚本绑定（含异步API调用）。
     这里必须放行，否则一次点击会被执行两次：真实动作 + 演示兜底。 */
  if (btn.closest('#v-content, #v-live')) return;

  var fn = matchAction(btnText(btn));
  if (fn) { try { fn(btn); } catch (err) { toast(String((err && err.message) || err), 'err', '执行出错'); } }
  else fallback(btn);
});

/* 开关：切换 + 提示 */
document.addEventListener('click', function (e) {
  var sw = e.target.closest('.switch');
  if (!sw) return;
  var on = sw.classList.contains('on');
  var row = sw.closest('.set-row, .chan-row, .kw-item, .acct-row');
  var label = '';
  if (row) {
    var t = row.querySelector('.s-main b, .kw-name, b');
    if (t) label = t.textContent.trim();
  }
  if (!label) label = '该设置项';
  toast(label + ' 已' + (on ? '开启' : '关闭'), on ? 'ok' : 'warn', '设置已更新');
});

/* ================= 筛选视图包装 ================= */
var _renderLeadFeed = renderLeadFeed;
renderLeadFeed = function () {
  var f = state.filter;
  if (!f || (!f.platform && !f.stage && !f.minScore)) { _renderLeadFeed(); return; }
  var card = $('#leadFeedCard');
  if (!card) return;
  var rows = state.leads.filter(function (l) {
    if (f.platform && l.platform !== f.platform) return false;
    if (f.stage && l.stage !== f.stage) return false;
    if ((l.intent_score || 0) < f.minScore) return false;
    return true;
  }).sort(function (a, b) { return (b.intent_score || 0) - (a.intent_score || 0); }).slice(0, 8);

  var bar = '<div style="display:flex;align-items:center;gap:8px;padding:11px 18px;background:var(--primary-soft);border-bottom:1px solid var(--border-2);font-size:12px;color:var(--primary);font-weight:600">' +
    '<svg class="icon" style="width:14px;height:14px"><use href="#i-filter"/></svg>筛选结果：' + rows.length + ' 条' +
    '<button class="btn sm ghost" id="clearFilter" type="button" style="margin-left:auto">清除筛选</button></div>';

  if (!rows.length) {
    card.innerHTML = bar + '<div class="card-body" style="text-align:center;color:var(--text-3);padding:40px 20px;font-size:13px">没有符合当前筛选条件的线索</div>';
    bindClear(card);
    return;
  }
  card.innerHTML = bar + rows.map(function (l, i) {
    var m = PF[l.platform] || PF.douyin;
    var sc = l.intent_score || 0;
    var cmt = esc(l.comment || '').replace(/(报价|预算|ROI|起量|代运营|投放|团购|CPL|线索|加个微信|留个电话|年框|合作)/g, '<em>$1</em>');
    var acts = l.stage === 'new'
      ? '<button class="btn sm primary" data-act="send" data-id="' + l.id + '"><svg class="icon"><use href="#i-send"/></svg>AI 代发私信</button>' +
        '<button class="btn sm" data-act="advance" data-id="' + l.id + '">加入 CRM</button>'
      : '<button class="btn sm" data-act="advance" data-id="' + l.id + '">推进到下一阶段</button>' +
        '<button class="btn sm ghost" data-act="drop" data-id="' + l.id + '">移入待唤醒</button>';
    return '<div class="lead">' +
      '<div class="' + avatarClass(i) + '" style="width:34px;height:34px;font-size:12px">' + esc(initials(l.nickname)) + '</div>' +
      '<div class="lead-body">' +
        '<div class="lead-top"><b>' + esc(l.nickname) + '</b><span class="tag green">意向 ' + sc + '</span>' + stageTag(l.stage) + '</div>' +
        '<div class="lead-cmt">“' + cmt + '”</div>' +
        '<div class="src-line">' + pfTag(l.platform) + m.label + ' · 关键词「' + esc(l.keyword || '—') + '」· 需求：' + esc(l.requirement || '—') + '</div>' +
        '<div class="lead-acts" style="margin-top:9px">' + acts + '</div>' +
      '</div></div>';
  }).join('');
  bindClear(card);
};

function bindClear(card) {
  var b = card.querySelector('#clearFilter');
  if (b) b.addEventListener('click', function () { state.filter = null; renderAll(); toast('已清除筛选条件', 'info', '筛选已清除'); });
}

/* ================= 测试助手 ================= */
(function testAssistant() {
  var fab = document.createElement('button');
  fab.className = 'qa-fab'; fab.id = 'qaFab'; fab.type = 'button'; fab.title = '测试助手';
  fab.innerHTML = '<svg class="icon"><use href="#i-setting"/></svg><span class="qa-dot"></span>';

  var panel = document.createElement('div');
  panel.className = 'qa-panel';
  panel.innerHTML =
    '<div class="qa-head"><b>测试助手</b><span>一键触发各页面功能，便于验证交互</span></div>' +
    '<div class="qa-body">' +
      '<div class="qa-sec">快速跳转</div>' +
      '<div class="qa-grid">' +
        ['v-dashboard|看板', 'v-content|评论区', 'v-more|更多获客', 'v-matrix|剪辑', 'v-employee|AI员工', 'v-geo|GEO引擎', 'v-geobuild|秒建站', 'v-live|直播', 'v-crm|CRM', 'v-pricing|套餐', 'v-settings|设置']
          .map(function (x) { var p = x.split('|'); return '<button data-jump="' + p[0] + '" type="button">' + p[1] + '</button>'; }).join('') +
      '</div>' +
      '<div class="qa-sec">数据操作</div>' +
      '<button class="qa-btn" data-qa="seed"><svg class="icon"><use href="#i-plus"/></svg>生成 5 条随机测试线索</button>' +
      '<button class="qa-btn" data-qa="advance"><svg class="icon"><use href="#i-trend"/></svg>随机推进 3 条线索阶段</button>' +
      '<button class="qa-btn" data-qa="clear"><svg class="icon"><use href="#i-filter"/></svg>清除筛选 / 重置视图</button>' +
      '<button class="qa-btn danger" data-qa="reset"><svg class="icon"><use href="#i-refresh"/></svg>重置为初始演示数据</button>' +
      '<div class="qa-sec">状态查看</div>' +
      '<div class="qa-status" id="qaStatus"></div>' +
      '<div class="qa-tip">提示：「重置」只影响本机内存中的演示数据，不会删除云端已保存的记录。</div>' +
    '</div>';

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  function refreshStatus() {
    var el = panel.querySelector('#qaStatus');
    if (!el) return;
    var mode = state.demo ? '演示模式（不写云端）' : (state.session ? '已登录 · 真实数据' : '未登录');
    var sub = currentSub();
    el.innerHTML =
      '运行模式：<b>' + mode + '</b><br>' +
      '云服务：<b>' + (cloud ? '已连接' : '未连接') + '</b><br>' +
      '线索 / 任务 / 记录：<b>' + state.leads.length + ' / ' + (state.tasks || []).length + ' / ' + ((state.records || []).length) + '</b><br>' +
      '当前套餐：<b>' + (sub ? sub.plan_name : '未开通') + '</b><br>' +
      '筛选状态：<b>' + (state.filter ? '已筛选' : '无') + '</b>';
  }

  fab.addEventListener('click', function (e) {
    e.stopPropagation();
    panel.classList.toggle('show');
    refreshStatus();
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.qa-panel') && !e.target.closest('.qa-fab')) panel.classList.remove('show');
  });
  panel.addEventListener('click', async function (e) {
    var j = e.target.closest('[data-jump]');
    if (j) { go(j.dataset.jump); panel.classList.remove('show'); return; }
    var b = e.target.closest('[data-qa]');
    if (!b) return;
    var act = b.dataset.qa;

    if (act === 'seed') {
      var pool = [
        ['宁波王姐 · 门店店', 'sph', '千川投流 服务商', '你们千川投流能寄样吗，我店里要用', '门店代运营，先要方案', 82],
        ['东莞李工', 'douyin', '千川投流 服务商', '30 万预算千川投流什么价，要开票', '千川投流 30 万预算', 91],
        ['义乌小商品城', 'ks', 'CPL 线索 采购', '本地生活团购怎么合作，我量大', '本地生活团购代运营', 76],
        ['长沙软装陈设计', 'xhs', '短视频拍摄 定做', '工程单短视频拍摄定做，有 60 套', '工程短视频拍摄 60 套', 88],
        ['郑州孙老板', 'douyin', '抖音代运营 报价', '抖音代运营一个月几条视频，包拍摄吗', '本地生活团购首单 3 家店', 71]
      ];
      var maxId = state.leads.reduce(function (m, l) { return Math.max(m, Number(l.id) || 0); }, 0);
      pool.forEach(function (p, i) {
        state.leads.push({
          id: state.demo ? (maxId + i + 1) : 'tmp_' + Date.now() + '_' + i,
          nickname: p[0], platform: p[1], keyword: p[2], comment: p[3], requirement: p[4],
          intent_score: p[5], stage: 'new', wechat_note: null, amount: null,
          created_at: new Date().toISOString()
        });
      });
      if (state.demo) {
        renderAll();
        toast('已生成 5 条测试线索，可在看板 / 评论区 / CRM 查看', 'ok', '测试数据已生成');
      } else if (cloud && state.session) {
        var ok = 0;
        for (var i = 0; i < pool.length; i++) {
          var r = await cloud.database.from('leads').insert({
            nickname: pool[i][0], platform: pool[i][1], keyword: pool[i][2], comment: pool[i][3],
            requirement: pool[i][4], intent_score: pool[i][5], stage: 'new'
          }).select();
          if (!r.error) ok++;
        }
        await refreshData(); renderAll();
        toast('已写入云端 ' + ok + ' 条测试线索', 'ok', '测试数据已生成');
      } else {
        renderAll();
        toast('当前未登录，数据仅在本机内存中', 'warn', '未写入云端');
      }
      refreshStatus();
      return;
    }

    if (act === 'advance') {
      var news = state.leads.filter(function (l) { return l.stage !== 'deal'; }).slice(0, 3);
      if (!news.length) { toast('没有可推进的线索', 'warn'); return; }
      for (var k = 0; k < news.length; k++) {
        var l = news[k], next = NEXT_STAGE[l.stage] || 'sent';
        var patch = { stage: next, updated_at: new Date().toISOString() };
        if (next === 'wechat' && !l.wechat_note) patch.wechat_note = l.nickname + '·' + (l.requirement || l.keyword || '意向客户');
        await updateLead(l.id, patch);
      }
      toast('已随机推进 ' + news.length + ' 条线索的阶段', 'ok', '状态已变更');
      refreshStatus();
      return;
    }

    if (act === 'clear') {
      state.filter = null; renderAll();
      toast('已清除筛选并重置视图', 'info', '视图已重置');
      refreshStatus();
      return;
    }

    if (act === 'reset') {
      if (!state.demo) { toast('重置仅用于 DEMO 演示数据，生产数据不提供该操作', 'info', '未执行'); return; }
      confirmDlg({
        title: '重置为初始演示数据？', icon: 'i-refresh',
        html: '将把本机内存中的线索、任务恢复为初始演示数据。<br><b>注意：不会删除云端已保存的任何记录。</b>',
        okText: '确认重置',
        onOk: function () {
          state.leads = demoSlice('leads').slice();
          state.tasks = demoSlice('tasks').slice();
          state.subs = [];
          state.records = [];
          state.filter = null;
          renderAll();
          refreshStatus();
          toast('已重置为初始演示数据', 'ok', '重置完成');
        }
      });
      return;
    }
  });
})();

/* 让弹窗支持 Esc 关闭（覆盖原有 Esc 只关抽屉的行为） */
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && modalStack.length) {
    var top = modalStack[modalStack.length - 1];
    if (top._timer) clearInterval(top._timer);
    top.close();
  }
});


/* =========================================================
   v2 补丁 —— 核心业务按钮的真实反馈
   · 线索操作（立即私信 / 推进 / 移入待唤醒）不再静默，全部有提示
   · AI 私信预览：话术可编辑后再发送
   · 套餐开通：订单确认弹窗 → 真实落库 → 成功回执
   · 导出同步：即时进度反馈
   · 测试助手新增「一键自检当前页面按钮」
   ========================================================= */

/* ---------- 局部工具 ---------- */
function v2Lead(id) {
  for (var i = 0; i < state.leads.length; i++) {
    if (String(state.leads[i].id) === String(id)) return state.leads[i];
  }
  return null;
}
function stageLabel(s) {
  var m = (typeof STAGE_META !== 'undefined' && STAGE_META) ? STAGE_META[s] : null;
  return (m && m.label) || String(s == null ? '' : s);
}
function money(n) { return '¥' + Number(n || 0).toLocaleString('zh-CN'); }

/* ---------- 1. 写库失败不再用原生 alert ---------- */
updateLead = async function (id, patch) {
  if (state.demo || !cloud) {
    var l = v2Lead(id);
    if (l) Object.assign(l, patch);
    renderAll();
    return;
  }
  var r = await cloud.database.from('leads').update(patch).eq('id', id).select();
  if (r.error) { toast('操作失败：' + r.error.message, 'err', '云端写入失败'); return; }
  if (!Array.isArray(r.data) || !r.data.length) {
    toast('这条线索不属于当前账号，已按行级权限拦截', 'warn', '权限拦截');
    return;
  }
  await refreshData();
  renderAll();
};

/* ---------- 2. 线索操作：即时反馈 ---------- */
handleLeadAction = async function (act, id) {
  var l = v2Lead(id);
  if (!l) { toast('未找到该条线索，请刷新页面后重试', 'err', '操作失败'); return; }

  if (act === 'send') { openDmPreview(l); return; }

  if (act === 'advance') {
    var prev = stageLabel(l.stage);
    var next = NEXT_STAGE[l.stage] || 'sent';
    var patch = { stage: next, updated_at: new Date().toISOString() };
    if (next === 'wechat' && !l.wechat_note) {
      patch.wechat_note = l.nickname + '·' + (l.requirement || l.keyword || '意向客户');
    }
    await updateLead(id, patch);
    if (state.demo) renderAll();
    toast('「' + l.nickname + '」：' + prev + ' → ' + stageLabel(next), 'ok', '阶段已更新');
    return;
  }

  if (act === 'drop') {
    await updateLead(id, { stage: 'sleep' });
    if (state.demo) renderAll();
    toast('「' + l.nickname + '」已移入待唤醒池，30 天后自动再次触达', 'warn', '已移入待唤醒');
    return;
  }
};

/* ---------- 3. AI 私信预览（可编辑后发送） ---------- */
function openDmPreview(l) {
  var m = PF[l.platform] || PF.douyin;
  var need = l.requirement || l.keyword || '案例拆解 / 千川起量';
  var tpl = '您好～看到您在' + m.label + '留言「' + String(l.comment || '').slice(0, 26) + '」，' +
            '我们是为企业做全域获客的流量服务商，' + need + '可按 CPL 结算，' +
            '方便加个微信吗？给您发同行业案例和报价单 👉';
  var rec = openModal({
    title: 'AI 生成私信 · 发送预览',
    sub: l.nickname + ' · ' + m.label + ' · 意向分 ' + (l.intent_score || 0),
    icon: 'i-send', wide: true,
    body:
      '<div class="m-stat">' +
        '<div><b>' + (l.intent_score || 0) + '</b><span>意向分</span></div>' +
        '<div><b>' + stageLabel(l.stage) + '</b><span>当前阶段</span></div>' +
        '<div><b>' + esc(m.label) + '</b><span>来源平台</span></div>' +
      '</div>' +
      '<div class="fm-row"><label>评论区原文</label><div class="m-code">' + esc(l.comment || '—') + '</div></div>' +
      '<div class="fm-row"><label>AI 话术（可编辑）</label>' +
        '<textarea class="fm-ta" id="dmText">' + esc(tpl) + '</textarea>' +
        '<div class="fm-hint">合规提示：首次触达只做价值说明与加微引导，不群发、不轰炸；单号日触达量受风控参数约束。</div>' +
      '</div>' +
      '<div class="fm-row"><label>发送通道</label>' +
        '<div style="font-size:12.8px;color:var(--text-2)">' +
          (state.demo
            ? '演示模式：不会真实外发，仅演示完整流程'
            : '平台私信通道 · 受频率限制（当前间隔 ' + (state.settings && state.settings.dmGap ? state.settings.dmGap : 45) + ' 秒）') +
        '</div>' +
      '</div>',
    okText: '确认发送',
    cancelText: '取消',
    onOk: async function () {
      var box = document.getElementById('dmText');
      var txt = box ? String(box.value || '').trim() : tpl;
      if (!txt) { toast('私信内容不能为空', 'err', '请填写内容'); return true; }
      var name = l.nickname;
      var patch = { stage: l.stage === 'new' ? 'sent' : l.stage, updated_at: new Date().toISOString() };
      await updateLead(l.id, patch);
      if (state.demo) renderAll();
      toast('已向「' + name + '」发送私信' + (state.demo ? '（演示，未真实外发）' : ''), 'ok', '私信已发送');
    }
  });
  return rec;
}

/* ---------- 4. 套餐开通：订单确认 → 真实落库 → 回执 ---------- */
subscribe = async function (planCode) {
  var list = (state.plans || []).slice();
  var demoPlans = (state.demoData && state.demoData.plans) || [];
  demoPlans.forEach(function (p) {
    var hit = false;
    for (var i = 0; i < list.length; i++) if (list[i].code === p.code) hit = true;
    if (!hit) list.push(p);
  });
  var plan = null;
  for (var k = 0; k < list.length; k++) if (list[k].code === planCode) { plan = list[k]; break; }
  if (!plan) { toast('未找到该套餐，请刷新页面后重试', 'err', '操作失败'); return; }

  var months = plan.period === 'quarter' ? 3 : 12;
  var exp = new Date();
  exp.setMonth(exp.getMonth() + months);
  var orderNo = 'AIZ' + Date.now().toString().slice(-10);
  var canPay = !state.demo && !!state.session && !!cloud;

  openModal({
    title: '开通「' + plan.name + '」',
    sub: money(plan.price) + ' / ' + (plan.period === 'quarter' ? '季度' : '年度'),
    icon: 'i-crown', wide: true,
    body:
      '<div class="m-stat">' +
        '<div><b>' + money(plan.price) + '</b><span>应付金额</span></div>' +
        '<div><b>' + (plan.period === 'quarter' ? '3 个月' : '12 个月') + '</b><span>服务周期</span></div>' +
        '<div><b>' + (plan.seats || 1) + '</b><span>可用微信号</span></div>' +
      '</div>' +
      '<div class="fm-row"><label>套餐权益</label><div class="m-list">' +
        (plan.features || []).map(function (f) {
          return '<div class="m-item"><div class="mi-ico" style="background:var(--green-soft);color:var(--green)">' +
                 '<svg class="icon"><use href="#i-check-circle"/></svg></div><div><b>' + esc(f) + '</b></div></div>';
        }).join('') +
      '</div></div>' +
      '<div class="fm-row"><label>订单信息</label><div style="font-size:12.8px;line-height:2;color:var(--text-2)">' +
        '订单号：<b style="color:var(--text)">' + orderNo + '</b><br>' +
        '生效时间：' + new Date().toLocaleString('zh-CN') + '<br>' +
        '到期时间：<b style="color:var(--text)">' + exp.toLocaleString('zh-CN') + '</b>' +
      '</div></div>' +
      (canPay
        ? '<div class="alert ok"><svg class="icon"><use href="#i-check-circle"/></svg><div>已登录。订阅记录由服务端在支付成功后写入，前端不具备直接开通权限。</div></div>'
        : '<div class="alert warn"><svg class="icon"><use href="#i-warning"/></svg><div><b>' +
            (state.demo ? '演示模式' : '未登录') + '</b>：确认后只在本地演示，不会产生真实扣款与云端订单。</div></div>'),
    okText: canPay ? '确认支付并开通' : '模拟支付开通',
    cancelText: '再想想',
    onOk: async function (rec, btn) {
      if (btn) { btn.disabled = true; btn.textContent = '支付中…'; }
      await wait(700);
      var startedAt = new Date().toISOString();
      if (canPay) {
        var r = await cloud.database.from('subscriptions').insert({
          plan_code: plan.code, plan_name: plan.name, status: 'active',
          amount: plan.price, order_no: orderNo, expires_at: exp.toISOString()
        }).select();
        if (r.error) {
          toast('开通失败：' + r.error.message, 'err', '支付未完成');
          if (btn) { btn.disabled = false; btn.textContent = '确认支付并开通'; }
          return true;
        }
        await refreshData();
        renderAll();
      } else {
        state.subs = [{
          id: 'demo_' + Date.now(), plan_code: plan.code, plan_name: plan.name,
          status: 'active', amount: plan.price, order_no: orderNo,
          started_at: startedAt, expires_at: exp.toISOString()
        }];
        renderPricing();
        renderSidePlan();
      }
      toast('已开通「' + plan.name + '」· 到期 ' + exp.toLocaleDateString('zh-CN') + (canPay ? '' : '（本地演示）'), 'ok', '开通成功');
      openModal({
        title: '开通成功',
        sub: '订单号 ' + orderNo,
        icon: 'i-check-circle',
        body: '<div style="text-align:center;padding:8px 0 4px;font-size:13.4px;line-height:1.9;color:var(--text-2)">' +
                '<div style="font-size:17px;font-weight:800;color:var(--text);margin-bottom:8px">「' + esc(plan.name) + '」已生效</div>' +
                '到期时间：<b>' + exp.toLocaleDateString('zh-CN') + '</b><br>' +
                '可在「会员套餐」页随时升级，按剩余天数补差价。' +
              '</div>',
        okText: '去看看', cancelText: null,
        onOk: function () { go('v-pricing'); }
      });
    }
  });
};

/* ---------- 5. 导出到 CRM：即时进度 ---------- */
actExportCRM = async function (btn) {
  var high = state.leads.filter(function (l) {
    return (l.intent_score || 0) >= 70 && l.stage === 'new';
  });
  if (!high.length) {
    toast('当前没有待同步的新线索（意向分 ≥70 且尚未触达）', 'warn', '无需同步');
    return;
  }
  var t = toast('正在把 ' + high.length + ' 条高意向线索同步到 CRM…', 'load', '同步中');
  if (btn) btn.disabled = true;
  try {
    await wait(600);
    if (state.demo || !cloud) {
      high.forEach(function (l) { l.stage = 'sent'; l.updated_at = new Date().toISOString(); });
    } else {
      for (var i = 0; i < high.length; i++) {
        await cloud.database.from('leads')
          .update({ stage: 'sent', updated_at: new Date().toISOString() })
          .eq('id', high[i].id).select();
      }
      await refreshData();
    }
    renderAll();
    t.close();
    toast('已把 ' + high.length + ' 条高意向线索推进到「已私信」' + (state.demo ? '（本地演示数据）' : ''),
      'ok', '已同步到 CRM');
  } catch (e) {
    t.close();
    toast('同步失败：' + ((e && e.message) || e), 'err', '同步失败');
  } finally {
    if (btn) btn.disabled = false;
  }
};

/* ---------- 5b. 耗时动作：先给即时反馈（避免点了没反应） ---------- */
var _actGeoRefresh = actGeoRefresh;
actGeoRefresh = async function (btn) {
  var tl = toast('正在检测豆包 / 元宝 / 文心 / 通义 / DeepSeek / Kimi 的收录情况…', 'load', '检测中');
  try { await _actGeoRefresh(btn); } finally { tl.close(); }
};

var _actBatchDM = actBatchDM;
actBatchDM = async function (btn) {
  var tl = toast('正在按 45 秒合规间隔逐条发送私信…', 'load', '批量发送中');
  try { await _actBatchDM(btn); } finally { tl.close(); }
};

var _actStartLive = actStartLive;
actStartLive = async function (btn) {
  var tl = toast('正在启动 AI 数字人主播…', 'load', '开播中');
  try { await _actStartLive(btn); } finally { tl.close(); }
};

/* ---------- 5c. 动作表是按值捕获的，覆盖后必须重新指向 ---------- */
T['导出到CRM'] = actExportCRM;
T['刷新检测'] = actGeoRefresh;
T['批量私信这'] = actBatchDM;
T['立即开播'] = actStartLive;

/* ---------- 6. 测试助手：一键自检当前页面按钮 ---------- */
(function extendQa() {
  var panel = document.querySelector('.qa-panel');
  if (!panel) return;
  var body = panel.querySelector('.qa-body');
  if (!body) return;

  var out = document.createElement('pre');
  out.id = 'qaSelfOut';
  out.className = 'qa-out';

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'qa-btn';
  btn.id = 'qaSelfBtn';
  btn.innerHTML = '<svg class="icon"><use href="#i-check-circle"/></svg>一键自检当前页面按钮';

  var tip = body.querySelector('.qa-tip');
  if (tip) body.insertBefore(btn, tip); else body.appendChild(btn);
  body.appendChild(out);

  function visibleButtons() {
    return Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (b) {
      return b.offsetParent !== null &&
        !b.closest('.qa-panel') && !b.closest('.toast-wrap') && !b.closest('.demo-bar') &&
        !b.closest('.topbar') && !b.closest('.sidebar') &&
        !b.classList.contains('qa-fab');
    });
  }
  function labelOf(b) {
    var t = (b.textContent || '').replace(/\s+/g, '').trim();
    if (t) return t.slice(0, 12);
    if (b.id) return '#' + b.id;
    return '(图标按钮)';
  }
  function stateKey() {
    var av = document.querySelector('.view.active');
    var app = document.getElementById('app');
    var lg = document.getElementById('loginView');
    return document.body.className + '|' + (av ? av.id : '-') + '|' +
      (app && app.style.display === 'none' ? 'app0' : 'app1') + '|' +
      (lg && lg.classList.contains('show') ? 'lg1' : 'lg0');
  }
  function toastSig() {
    return Array.prototype.slice.call(document.querySelectorAll('.toast'))
      .map(function (t) { return (t.textContent || '').trim(); }).join('|');
  }
  function closeModals() {
    Array.prototype.slice.call(document.querySelectorAll('.modal-mask')).forEach(function (m) {
      var x = m.querySelector('.m-x') || m.querySelector('[data-m="cancel"]');
      if (x) x.click(); else m.remove();
    });
  }

  btn.addEventListener('click', async function (e) {
    e.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    var plan = visibleButtons().map(labelOf);
    out.style.display = 'block';
    out.textContent = '自检中… 共 ' + plan.length + ' 个按钮';
    var pass = 0, fail = 0, lines = [];
    var tid = 'self-' + Date.now();
    var seen = {};
    for (var i = 0; i < plan.length; i++) {
      var name = plan[i];
      seen[name] = (seen[name] || 0) + 1;
      var occ = seen[name];
      /* 每次重新定位：列表重绘后旧引用会失效 */
      var cands = visibleButtons().filter(function (x) { return labelOf(x) === name; });
      var b = cands[occ - 1];
      if (!b) { lines.push('SKIP | ' + name + ' | 元素已刷新，跳过'); continue; }
      if (b.disabled) { lines.push('SKIP | ' + name + ' | 当前不可用'); continue; }
      var ts0 = toastSig(), k0 = stateKey();
      var m0 = document.querySelectorAll('.modal-mask').length;
      var h0 = document.body.innerHTML.length;
      try { b.click(); } catch (err) { /* 忽略单个按钮异常 */ }
      await wait(430);
      var ts1 = toastSig(), k1 = stateKey();
      var m1 = document.querySelectorAll('.modal-mask').length;
      var h1 = document.body.innerHTML.length;
      var okd = (m1 > m0) || (ts1 !== ts0) || (k1 !== k0) || (Math.abs(h1 - h0) > 60);
      if (okd) {
        pass++;
        lines.push('PASS | ' + name + ' | ' +
          (m1 > m0 ? '打开弹窗' : (ts1 !== ts0 ? '弹出提示' : (k1 !== k0 ? '页面状态已切换' : '界面已更新'))));
      } else { fail++; lines.push('FAIL | ' + name + ' | 无任何反馈'); }
      closeModals();
      await wait(420);   /* 等淡出动画(200ms)结束，避免计数误判 */
    }
    out.textContent = '【自检结果】共 ' + (pass + fail) + ' 个 · 通过 ' + pass + ' · 未通过 ' + fail + '\n' +
      '（' + new Date().toLocaleTimeString('zh-CN') + '，' + tid + '）\n\n' + lines.join('\n');
    toast('自检完成：' + pass + ' 通过 / ' + fail + ' 未通过', fail ? 'warn' : 'ok', '按钮自检');
    panel.classList.add('show');          /* 测试过程中会被「点击外部关闭」收起，结束后重新展开 */
    refreshStatus();
    btn.disabled = false;
  });
})();

/* =========================================================
   评论区采集器 · Collector
   · 4 平台适配器：抖音 / 快手 / 小红书 / 视频号
   · 采集任务调度 → 评论区抓取 → 意向打分 → 去重 → 写入线索库
   · 配置了第三方采集服务即真实调用；未配置走本地模拟，链路完全一致
   ========================================================= */
(function collector() {
'use strict';

/* ---------- 平台适配器定义 ---------- */
var COL_PLATFORMS = [
  { key: 'douyin',   label: '抖音',   short: '抖', color: '#101828', mode: '授权直连',   auth: '企业号授权 + 采集服务' },
  { key: 'kuaishou', label: '快手',   short: '快', color: '#FF5000', mode: '授权直连',   auth: '企业号授权 + 采集服务' },
  { key: 'xhs',      label: '小红书', short: '红', color: '#FF2442', mode: '云机池采集', auth: '代理 IP + 云手机池' },
  { key: 'sph',      label: '视频号', short: '视', color: '#FF9F2E', mode: '云机池采集', auth: '代理 IP + 云手机池' }
];
var CPF = {};
COL_PLATFORMS.forEach(function (p) { CPF[p.key] = p; });

var PF_ALIAS = {
  dy: 'douyin', ks: 'kuaishou', xhs: 'xhs', sph: 'sph',
  douyin: 'douyin', kuaishou: 'kuaishou',
  '抖音': 'douyin', '快手': 'kuaishou', '小红书': 'xhs', '视频号': 'sph'
};
var FREQ_LABEL = { realtime: '实时扫描', '600': '每 10 分钟', '3600': '每小时', 'daily2': '每天 2 次' };
var FREQ_OPTS = [{ v: 'realtime', l: '实时扫描（推荐）' }, { v: '600', l: '每 10 分钟' }, { v: '3600', l: '每小时' }, { v: 'daily2', l: '每天 2 次' }];
var AD_ST = { ok: '正常', warn: '受限', err: '异常', off: '已停用' };
var AD_TAG = { ok: 'green', warn: 'amber', err: 'red', off: '' };

/* ---------- 采集器状态 ---------- */
var COL = {
  cfg: {
    mode: 'auto',        /* auto | live | sim */
    serviceUrl: '',
    token: '',
    proxy: '',
    perRound: 30,
    minScore: 60,
    interval: 300,
    dailyCap: 2000,
    dedupe: true,
    autoIngest: true
  },
  adapters: {},
  tasks: [],
  log: [],
  stats: { scan: 0, hit: 0, ingested: 0, dup: 0, runAt: 0 },
  running: false,
  seen: {},
  filter: null,
  seq: 1,
  loaded: false
};
state.collector = COL;
window.__COLLECTOR = COL;

/* ---------- 小工具 ---------- */
function colQ(s, r) { return (r || document).querySelector(s); }
function colQa(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function colHM() {
  var d = new Date();
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
}
function colWait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function colLiveMode() {
  var m = COL.cfg.mode;
  if (m === 'live') return true;
  if (m === 'sim') return false;
  return !!(COL.cfg.serviceUrl && COL.cfg.token);
}

/* ---------- 日志 ---------- */
function colLog(kind, msg) {
  COL.log.push({ t: colHM(), kind: kind || 'info', msg: msg });
  if (COL.log.length > 400) COL.log.splice(0, COL.log.length - 400);
  colPaintLog();
}
function colPaintLog() {
  var box = colQ('#colLog');
  if (!box) return;
  var cnt = colQ('#colLogCnt');
  if (cnt) cnt.textContent = COL.log.length + ' 条';
  if (!COL.log.length) {
    box.innerHTML = '<div class="col-empty">暂无运行日志。点击「立即采集一轮」开始抓取评论区。</div>';
    return;
  }
  var stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = COL.log.slice(-140).map(function (l) {
    return '<div class="col-line ' + l.kind + '"><span class="ct">' + l.t + '</span><span class="cm">' + esc(l.msg) + '</span></div>';
  }).join('');
  if (stick) box.scrollTop = box.scrollHeight;
}
function colProg(p, txt) {
  var f = colQ('#colProgFill'), t = colQ('#colProgText');
  if (f) f.style.width = Math.max(0, Math.min(100, p)) + '%';
  if (t) t.textContent = txt || ('已完成 ' + Math.round(p) + '%');
}

/* ---------- 适配器 ----------
   卡片只展示**可核实**的数字：该平台今天真实入库几条、什么时候采的、走的哪条通道。
   早期这里写死过 126/94/38/61 与「企业号授权正常」，与顶部状态条自相矛盾，已全部移除。 */
function colInitAdapters() {
  COL_PLATFORMS.forEach(function (p) {
    if (!COL.adapters[p.key]) COL.adapters[p.key] = { enabled: true };
  });
}
function colSince(ts) {
  if (!ts) return '尚未采集';
  var ms = Date.now() - ts;
  if (ms < 60000) return '刚刚';
  if (ms < 3600000) return Math.floor(ms / 60000) + ' 分钟前';
  if (ms < 86400000) return Math.floor(ms / 3600000) + ' 小时前';
  return Math.floor(ms / 86400000) + ' 天前';
}
function colPlatformStats(key) {
  var today = 0, total = 0, last = 0;
  var t0 = new Date(); t0.setHours(0, 0, 0, 0);
  (state.leads || []).forEach(function (l) {
    if (!l || l.platform !== key) return;
    total++;
    var ts = Date.parse(l.created_at || l.at || '') || 0;
    if (ts >= t0.getTime()) today++;
    if (ts > last) last = ts;
  });
  return { today: today, total: total, last: last };
}
function colChannelState() {
  if (COL.cfg.expMode) return { tag: 'amber', label: '体验样例', cls: 'warn' };
  if (colLiveMode()) return { tag: 'green', label: '真实通道', cls: 'ok' };
  return { tag: '', label: '未接入', cls: 'off' };
}
function colRenderAdapters() {
  var box = colQ('#colAdapters');
  if (!box) return;
  colInitAdapters();
  var ch = colChannelState();
  box.innerHTML = COL_PLATFORMS.map(function (p) {
    var a = COL.adapters[p.key];
    var s = colPlatformStats(p.key);
    var st = a.enabled ? (ch.cls === 'off' ? 'off' : ch.cls) : 'off';
    var note = !a.enabled
      ? '已停用，本轮采集跳过该平台'
      : (ch.cls === 'off' ? '未接入采集通道，先去「采集服务配置」接入' : '按当前通道采集 ' + p.label + ' 评论区');
    return '<div class="card col-ad">' +
      '<div class="col-ad-top">' +
        '<div class="col-ad-logo" style="background:' + p.color + '">' + p.short + '</div>' +
        '<div style="flex:1;min-width:0"><b>' + p.label + '</b><span>' + p.mode + ' · ' + p.auth + '</span></div>' +
        '<span class="tag ' + AD_TAG[st] + '">' + AD_ST[st] + '</span>' +
      '</div>' +
      '<div class="col-ad-rows">' +
        '<div class="col-ad-row"><i class="' + (s.today ? '' : 'warn') + '"></i>今日入库线索<em>' + s.today + '</em></div>' +
        '<div class="col-ad-row"><i></i>累计入库<em>' + s.total + '</em></div>' +
        '<div class="col-ad-row"><i></i>采集通道<em>' + ch.label + '</em></div>' +
        '<div class="col-ad-row"><i></i>频控间隔<em>' + COL.cfg.interval + 's</em></div>' +
        '<div class="col-ad-row"><i></i>最近采集<em style="font-weight:600">' + esc(colSince(s.last)) + '</em></div>' +
      '</div>' +
      '<div class="col-ad-foot">' +
        '<span class="col-ad-note">' + esc(note) + '</span>' +
        '<button class="btn sm' + (a.enabled ? ' ghost' : ' primary') + '" data-col="toggleAd" data-ad="' + p.key + '" type="button">' + (a.enabled ? '停用' : '启用') + '</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

/* ---------- 状态头 ---------- */
function colRenderStatus() {
  var dot = colQ('#colDot');
  if (!dot) return;
  var live = colLiveMode();
  dot.className = 'col-dot ' + (COL.running ? 'run' : (live ? 'ok' : 'warn'));
  colQ('#colStateText').textContent = COL.running ? '采集器运行中…' : (live ? '采集服务已连接' : '采集服务未配置');
  var exp = !!COL.cfg.expMode;
  var mt = colQ('#colModeTag');
  mt.className = 'tag ' + ((live || exp) ? 'green' : 'amber');
  mt.textContent = exp ? '体验通道 · 非商用样例' : (live ? '真实采集通道' : '本地模拟通道');
  var st = colQ('#colServiceTag');
  st.className = 'tag ' + (exp ? 'amber' : (live ? 'blue' : ''));
  st.textContent = exp ? 'MediaCrawler 研究桥（合成样例数据）' : (live ? String(COL.cfg.serviceUrl).replace(/^https?:\/\//, '').slice(0, 34) : '未接入第三方采集服务');
  colQ('#colStatusSub').innerHTML = exp
    ? '<b>体验模式</b>：数据来自本地 MediaCrawler 研究桥的<b>合成样例</b>，仅用于验证「抓取 → 打分 → 去重 → 入线索池」链路，<b>不含真实个人信息、非商业用途</b>。正式采集请接入有资质供应商（vendor）或自有内容（official）。'
    : (live
      ? '已连接服务端采集通道，4 个平台适配器按授权方式拉取评论区，抓取结果经意向打分与去重后写入线索库。'
      : '平台官方均未开放评论区接口，真实采集需接入第三方采集服务或自有内容开放能力。未配置时采集器走本地模拟通道，任务调度、抓取、打分、去重、入库全链路照常执行，可完整验证流程。');
  var scan = COL.stats.scan || 0, hitN = COL.stats.hit || 0, inN = COL.stats.ingested || 0;
  colQ('#colKpiScan').textContent = scan;
  colQ('#colKpiHit').textContent = hitN;
  colQ('#colKpiIn').textContent = inN;
  colQ('#colKpiDup').textContent = COL.stats.dup || 0;
  /* 漏斗条宽按「占抓取量」比例，非零值给最小 4% 免得看不见 */
  var barW = function (n) { return scan ? Math.max(n > 0 ? 4 : 0, Math.round(n / scan * 100)) : 0; };
  var barPct = function (n) { return scan ? (n / scan * 100).toFixed(1).replace(/\.0$/, '') + '%' : '—'; };
  var bh = colQ('#colBarHit'), bi = colQ('#colBarIn');
  if (bh) bh.style.width = barW(hitN) + '%';
  if (bi) bi.style.width = barW(inN) + '%';
  var rh = colQ('#colRateHit'), ri = colQ('#colRateIn');
  if (rh) rh.textContent = barPct(hitN);
  if (ri) ri.textContent = barPct(inN);
}

/* ---------- 采集任务 ---------- */
/* 任务种子不在页面内嵌：进入 DEMO 后从 demo/dataset.js 统一下发 */
function colSeedTasks() {
  if (COL.tasks.length) return;
  var seed = (window.__DEMO_DATA__ && window.__DEMO_DATA__.collectTasks) || [];
  COL.tasks = seed.map(function (s) {
    return {
      id: 't' + (COL.seq++),
      kw: s.kw || s.keyword || '',
      pf: (s.pf || [s.platform]).slice(),
      freq: s.freq || s.every || 'realtime',
      hit: (s.hit || []).slice(),
      on: s.on !== undefined ? s.on : (s.enabled !== false),
      total: s.total || 0,
      roundHit: 0,
      lastRun: s.lastRun || '—'
    };
  });
}
function colTask(id) {
  for (var i = 0; i < COL.tasks.length; i++) if (COL.tasks[i].id === id) return COL.tasks[i];
  return null;
}
/* 任务只有一个来源：能连上服务端就以服务端 /v1/collect/tasks 为准（关掉页面照跑），
   连不上才退回本地草稿（仅存浏览器，明确标注「本地草稿」）。 */
function colServerSd() {
  var sd = window.__COLSD && window.__COLSD.sd;
  return (sd && sd.reachable && Array.isArray(sd.tasks)) ? sd : null;
}
function colPlainSince(ts) {
  if (!ts) return '尚未执行';
  var ms = Date.now() - ts;
  if (ms < 60000) return '刚刚';
  if (ms < 3600000) return Math.floor(ms / 60000) + ' 分钟前';
  if (ms < 86400000) return Math.floor(ms / 3600000) + ' 小时前';
  return Math.floor(ms / 86400000) + ' 天前';
}
/* 未来时间必须单独算：用 colPlainSince 会把「3 分钟后」显示成「刚刚」 */
function colNextIn(ts) {
  if (!ts) return '';
  var ms = Number(ts) - Date.now();
  if (ms <= 0) return '即将执行';
  if (ms < 60000) return Math.ceil(ms / 1000) + ' 秒后';
  if (ms < 3600000) return Math.ceil(ms / 60000) + ' 分钟后';
  if (ms < 86400000) return Math.floor(ms / 3600000) + ' 小时后';
  return Math.floor(ms / 86400000) + ' 天后';
}
function colRenderTasks() {
  var list = colQ('#v-content .kw-list');
  if (!list) return;
  var sd = colServerSd();
  var src = sd ? 'server' : 'local';
  var rows = [];

  if (sd) {
    rows = sd.tasks.map(function (t) {
      return {
        id: t.id,
        kw: t.keyword,
        pf: [t.platform],
        freqLabel: t.cron ? ('Cron · ' + (t.scheduleText || t.cron)) : (FREQ_LABEL[t.every] || '实时扫描'),
        on: t.enabled !== false,
        total: t.total || 0,
        meta: '上次采集 ' + colPlainSince(t.lastRunAt) +
          (t.lastStatus === 'ok' ? ' · 上轮新增 ' + (t.fresh || 0) + ' 条'
            : t.lastStatus === 'failed' ? ' · <span style="color:var(--red)">上轮失败</span>'
            : t.lastStatus === 'empty' ? ' · 上轮 0 条' : '') +
          (t.enabled && t.nextRunAt ? ' · 下次 ' + colNextIn(t.nextRunAt) : '')
      };
    });
  } else {
    colSeedTasks();
    rows = COL.tasks.map(function (t) {
      return {
        id: t.id, kw: t.kw, pf: t.pf, freqLabel: FREQ_LABEL[t.freq] || '实时扫描',
        on: !!t.on, total: t.total || 0,
        meta: '上次采集 ' + (t.lastRun || '—') + ' · 本轮命中 ' + (t.roundHit || 0) + ' 条'
      };
    });
  }

  rows = rows.filter(function (t) { return !COL.filter || t.pf.indexOf(COL.filter) > -1; });

  if (!rows.length) {
    list.innerHTML = '<div class="kw-item"><div class="kw-main">' +
      '<div class="kw-name" style="color:var(--text-3);font-weight:600">该平台下暂无采集任务</div>' +
      '<div class="kw-meta">点击右上角「新建监听任务」' + (sd ? '创建服务端调度任务（关掉页面也会继续跑）' : '添加关键词与目标平台（本地草稿）') + '</div></div></div>';
  } else {
    list.innerHTML = rows.map(function (t) {
      var tags = t.pf.map(function (k) {
        var p = CPF[k];
        return '<span class="tag blue">' + (p ? p.label : k) + '</span>';
      }).join('');
      var st = t.on ? '<span class="tag green">运行中</span>' : '<span class="tag">已暂停</span>';
      return '<div class="kw-item" data-task-id="' + t.id + '">' +
        '<div class="switch' + (t.on ? ' on' : '') + '" data-col="toggleTask" data-task="' + t.id + '"></div>' +
        '<div class="kw-main">' +
          '<div class="kw-name">' + esc(t.kw) + '</div>' +
          '<div class="kw-tags">' + tags + '<span class="tag">' + esc(t.freqLabel) + '</span>' + st + '</div>' +
          '<div class="kw-meta">' + t.meta + '</div>' +
        '</div>' +
        '<div class="kw-stat"><b style="color:' + (t.total ? 'var(--primary)' : 'var(--text-3)') + '">' + (t.total || 0) + '</b><span>累计入库</span></div>' +
        '<div class="kw-ops">' +
          '<button class="btn sm" data-col="runTaskNow" data-task="' + t.id + '" type="button">采集</button>' +
          '<button class="btn sm ghost" data-col="editTask" data-task="' + t.id + '" type="button">设置</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  var _st = null;
  colQa('#v-content .section-title').forEach(function (x) {
    var h2 = x.querySelector('h2');
    if (h2 && h2.textContent === '关键词监听任务') _st = x;
  });
  if (_st) {
    var _h = _st.querySelector('.hint');
    if (_h) _h.textContent = sd
      ? ('共 ' + rows.length + ' 个任务 · ' + rows.filter(function (t) { return t.on; }).length + ' 个运行中 · 服务端已执行 ' + ((sd.stats && sd.stats.runs) || 0) + ' 轮 · 关掉页面也会跑')
      : ('共 ' + rows.length + ' 个任务 · 本地草稿（未接入服务端，刷新页面可能丢失）');
  }
}

function colRenderAll() {
  colRenderStatus();
  colRenderAdapters();
  colRenderTasks();
  colPaintLog();
}
/* 供服务端调度模块在数据刷新后回调，保证「一份任务、一处渲染」 */
window.__COL_ON_TASKS = function () { try { colRenderTasks(); } catch (e) {} };

/* ---------- 意向打分 ---------- */
var COL_DICT = [
  [['报价', '预算', '起量', '代运营', '投放', '团购', 'CPL', '线索', '合作', '年框'], 14],
  [['要方案', '求案例', '看案例', '案例集', '试投'], 13],
  [['报价', '报个价', '怎么卖', '什么价', '多少钱', '价格', '求价'], 12],
  [['加个微信', '加微信', '留个电话', '联系方式', '电话', '加V'], 15],
  [['定做', '定制', 'OEM', '贴牌', '代工', '打样'], 11],
  [['账期', '回款', '结算', '开票', '税点'], 8],
  [['到店', '同城', '面谈', '实地', '案例'], 9],
  [['加盟', '代理', '经销', '分销'], 8]
];
var COL_LOW = ['好看', '喜欢', '不错', '支持', '已关注', '学到了', '收藏', '码住', '什么牌子', '谢谢分享'];
function colScore(text, hits) {
  var s = 46, t = String(text || ''), i, j;
  for (i = 0; i < COL_DICT.length; i++) {
    for (j = 0; j < COL_DICT[i][0].length; j++) {
      if (t.indexOf(COL_DICT[i][0][j]) > -1) { s += COL_DICT[i][1]; break; }
    }
  }
  for (i = 0; i < COL_LOW.length; i++) {
    if (t.indexOf(COL_LOW[i]) > -1) { s -= 24; break; }
  }
  if (hits && hits.length) {
    for (i = 0; i < hits.length; i++) if (hits[i] && t.indexOf(hits[i]) > -1) s += 6;
  }
  return Math.max(30, Math.min(99, s));
}
function colRequirement(c, t) {
  var txt = c.comment, out = [];
  if (/方案|案例|试投|诊断/.test(txt)) out.push('要方案');
  if (/打样|OEM|贴牌|定做|定制|代工/.test(txt)) out.push('定制打样');
  if (/年框|量大|采购|合作|预算/.test(txt)) out.push('年度合作');
  if (/报价|什么价|多少钱|怎么卖|价格/.test(txt)) out.push('询价');
  if (/到店|面谈|同城/.test(txt)) out.push('同城面谈');
  if (!out.length) out.push('意向咨询');
  var head = String(t.kw || '').split(/[ /]+/)[0] || '抖音代运营';
  return head + ' · ' + out.join(' / ');
}

/* ---------- 本地模拟采集 ---------- */
var SIM_HIGH = [
  '{kw}怎么收费？能先出个方案吗',
  '{kw}一个月多少，我长期做，能给个年框价吗',
  '求{kw}服务商，量大，方便加个微信吗',
  '{kw}能先试投吗？预算 5 万起',
  '留个电话吧，{kw}我这边 12 家门店要长期投放',
  '{kw}能做全案吗？我们有 6 个品牌，帮忙报个价',
  '老板{kw}多少钱，我要签年框',
  '{kw}代运营怎么收费，我们想做自己的品牌',
  '同城，{kw}方便过来面谈吗',
  '{kw}包含拍摄吗？一个月几条',
  '{kw}能按 CPL 结算吗，我们这边量大，能开发票吗',
  '{kw}求合作，连锁门店，能到店聊吗'
];
var SIM_LOW = ['{kw}看着不错', '这个多少钱啊', '{kw}好看，已关注', '支持一下，{kw}学到了', '{kw}什么牌子？'];
var SIM_NICK = ['连锁餐饮老周', '美业连锁张姐', '口腔门诊刘院长', '教培王校长', '家居卖场赵总', '新消费品牌陈',
  '本地生活观察', '门店运营笔记', '招商加盟老李', '电商卖家小郑', '民宿主理人', '投放操盘手阿May',
  '连锁加盟研究所', '实体店老板娘', '区域品牌服务商', '做增长的老张'];
var SIM_VIDEO = ['案例复盘', '投放后台实拍', '门店探店', '起量数据拆解'];

function colSimulate(pfKey, kw, n) {
  var p = CPF[pfKey] || { label: pfKey };
  var head = String(kw || '').split(/[ /]+/)[0] || '抖音代运营';
  var out = [];
  var hi = Math.max(3, Math.round(n * 0.45));
  for (var i = 0; i < n; i++) {
    var high = i < hi;
    var tpl = high ? SIM_HIGH[(i * 3 + pfKey.length) % SIM_HIGH.length] : SIM_LOW[(i + head.length) % SIM_LOW.length];
    out.push({
      platform: pfKey,
      keyword: kw,
      nickname: SIM_NICK[(i * 5 + pfKey.length + head.length) % SIM_NICK.length] + (i > SIM_NICK.length - 1 ? String(i) : ''),
      comment: tpl.replace(/\{kw\}/g, head),
      video: head + ' · ' + SIM_VIDEO[(i + pfKey.length) % SIM_VIDEO.length] + '（' + p.label + '）',
      likes: (i * 7 + 3) % 57,
      at: new Date(Date.now() - i * 137000).toISOString()
    });
  }
  return out;
}

/* ---------- 真实采集（第三方采集服务） ---------- */
function colApi(path) {
  return String(COL.cfg.serviceUrl || '').replace(/\/+$/, '') + path;
}
function colHttp(url, opt, timeout) {
  var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctl) ctl.abort(); }, timeout || 12000);
  var init = {
    method: (opt && opt.method) || 'GET',
    headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + (COL.cfg.token || '') }
  };
  if (opt && opt.body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opt.body);
  }
  if (ctl) init.signal = ctl.signal;
  return fetch(url, init).then(function (r) {
    return r.text().then(function (txt) {
      var json = null;
      try { json = JSON.parse(txt); } catch (e) {}
      return { ok: r.ok, status: r.status, json: json, text: txt };
    });
  }).then(function (r) { clearTimeout(timer); return r; }, function (e) {
    clearTimeout(timer);
    throw new Error(e && e.name === 'AbortError' ? '请求超时（' + ((timeout || 12000) / 1000) + 's）' : String((e && e.message) || e));
  });
}
function colNormalize(data, pfKey, kw) {
  var arr = [];
  if (!data) return arr;
  if (Array.isArray(data)) arr = data;
  else if (Array.isArray(data.comments)) arr = data.comments;
  else if (Array.isArray(data.list)) arr = data.list;
  else if (Array.isArray(data.items)) arr = data.items;
  else if (data.data) return colNormalize(data.data, pfKey, kw);
  else return arr;
  return arr.map(function (x) {
    x = x || {};
    return {
      platform: pfKey,
      keyword: kw,
      nickname: String(x.nickname || x.user || x.author || x.nick || x.user_name || '匿名用户'),
      comment: String(x.comment || x.content || x.text || x.desc || ''),
      video: String(x.video_title || x.title || x.video || ''),
      likes: Number(x.likes || x.digg_count || x.like_count || 0),
      at: x.at || x.created_at || x.time || new Date().toISOString()
    };
  }).filter(function (x) { return x.comment; });
}
function colLiveCollect(pfKey, kw, limit) {
  /* 走 BFF 采集门面（POST /v1/comments/collect），由服务端选择采集通道：
     体验模式下该通道指向 MediaCrawler 研究桥（合成样例数据 · 非商用）；
     正式环境可指向 vendor（有资质供应商）或 official（自有内容）。
     浏览器不再直连第三方服务，规避 CORS 与内网地址暴露。 */
  var Api = window.Api;
  if (!Api || !Api.live()) {
    return Promise.reject(new Error('服务端未连接：请检查 BFF 地址与登录态'));
  }
  return Api.call('/v1/comments/collect', {
    platform: pfKey, keyword: kw, limit: limit
  }, { method: 'POST', timeout: 20000 }).then(function (r) {
    if (!r.ok) {
      var m = (r.json && (r.json.message || r.json.msg || r.json.error)) || r.error || ('HTTP ' + r.status);
      throw new Error(String(m).slice(0, 80));
    }
    return colNormalize(r.data, pfKey, kw);
  });
}

/* ---------- 去重 ---------- */
function colHash(c) {
  return c.platform + '|' + c.nickname + '|' + String(c.comment).slice(0, 40);
}
function colSeedSeen() {
  state.leads.forEach(function (l) {
    if (l && l.nickname && l.comment) {
      COL.seen[colHash({ platform: l.platform, nickname: l.nickname, comment: l.comment })] = 1;
    }
  });
}

/* ---------- 入库 ---------- */
async function colIngest(batch, tasks) {
  var added = 0, dup = 0, perTask = {};
  for (var i = 0; i < batch.length; i++) {
    var c = batch[i].c, t = batch[i].t;
    var h = colHash(c);
    if (COL.cfg.dedupe && COL.seen[h]) {
      dup++;
      colLog('warn', '去重拦截：' + c.nickname + '「' + String(c.comment).slice(0, 16) + '…」');
      continue;
    }
    var lead = {
      nickname: c.nickname,
      platform: c.platform,
      keyword: t.kw,
      comment: c.comment,
      requirement: colRequirement(c, t),
      intent_score: c.intent_score,
      fingerprint: h,
      stage: 'new'
    };
    if (state.demo || !cloud || !state.session) {
      lead.id = 'col_' + Date.now() + '_' + i;
      lead.created_at = new Date().toISOString();
      lead.wechat_note = null;
      lead.amount = null;
      state.leads.unshift(lead);
    } else {
      var r = await cloud.database.from('leads').insert(lead).select();
      if (r.error) {
        var emsg = String((r.error && r.error.message) || r.error);
        if (/duplicate key|unique|23505/i.test(emsg)) {
          dup++;
          COL.seen[h] = 1;
          colLog('warn', '库级去重拦截：' + c.nickname + '「' + String(c.comment).slice(0, 16) + '…」');
          continue;
        }
        colLog('err', '入库失败：' + emsg);
        continue;
      }
    }
    COL.seen[h] = 1;
    added++;
    perTask[t.id] = (perTask[t.id] || 0) + 1;
    colLog('ok', '已入线索库：' + c.nickname + ' · 意向 ' + c.intent_score + ' 分 · ' + (CPF[c.platform] || {}).label);
  }
  return { added: added, dup: dup, perTask: perTask };
}

/* ---------- 采集执行 ---------- */
async function colRun(onlyId) {
  if (COL.running) { toast('采集器正在运行，请稍候…', 'warn', '任务进行中'); return; }
  colSeedTasks();
  /* 生产环境没有演示种子：本地任务为空但服务端有调度任务时，直接借用服务端任务跑本轮，
     避免顶部「立即采集一轮」直接报「没有已启用的采集任务」。 */
  if (!COL.tasks.length) {
    var sdBoot = colServerSd();
    if (sdBoot && sdBoot.tasks.length) {
      COL.tasks = sdBoot.tasks.map(function (t) {
        return {
          id: t.id, kw: t.keyword, pf: [t.platform], freq: t.every || 'realtime',
          hit: [], on: t.enabled !== false, total: t.total || 0, roundHit: 0,
          lastRun: '—', fromServer: true
        };
      });
      colLog('info', '本地无草稿任务，本轮按服务端调度任务执行（' + COL.tasks.length + ' 个）');
    }
  }
  var tasks = COL.tasks.filter(function (t) { return t.on && (!onlyId || t.id === onlyId); });
  if (!tasks.length) { toast('没有已启用的采集任务，请先开启任务开关', 'warn', '无可执行任务'); return; }

  var live = colLiveMode();
  colSeedSeen();
  COL.running = true;
  colRenderStatus();

  var units = [];
  tasks.forEach(function (t) { t.pf.forEach(function (k) { units.push({ t: t, k: k }); }); });

  colLog('hl', '采集轮次开始：' + tasks.length + ' 个任务 / ' + units.length + ' 个平台通道 · 通道模式=' + (live ? '真实采集' : '本地模拟') + ' · 入库阈值 ' + COL.cfg.minScore + ' 分');
  if (!live) colLog('info', '未配置采集服务地址，本轮走本地模拟通道（调度 / 打分 / 去重 / 入库逻辑与真实采集完全一致）');
  var t0 = toast('已启动采集：' + units.length + ' 个平台通道', 'load', '采集进行中');

  var done = 0, totalScan = 0, totalHit = 0, batch = [];

  for (var i = 0; i < units.length; i++) {
    var u = units[i];
    var p = CPF[u.k] || { label: u.k };
    var ad = COL.adapters[u.k];
    if (!ad.enabled) {
      colLog('warn', '[' + p.label + '] 适配器已停用，跳过');
      done++; colProg(done / units.length * 100, '已完成 ' + done + '/' + units.length + ' 个通道');
      continue;
    }
    colLog('info', '[' + p.label + '] 打开评论区，抓取关键词「' + u.t.kw + '」下最新内容…');
    await colWait(live ? 140 : 240);

    var raw = [];
    try {
      raw = live
        ? await colLiveCollect(u.k, u.t.kw, COL.cfg.perRound)
        : colSimulate(u.k, u.t.kw, 8 + ((u.t.kw.length + u.k.length) % 7));
    } catch (e) {
      ad.fail++;
      if (ad.status === 'ok') ad.status = 'warn';
      ad.note = '最近一次失败：' + String((e && e.message) || e).slice(0, 36);
      colLog('err', '[' + p.label + '] 采集失败：' + String((e && e.message) || e));
      done++; colProg(done / units.length * 100, '已完成 ' + done + '/' + units.length + ' 个通道');
      colRenderAdapters(); colRenderStatus();
      continue;
    }

    totalScan += raw.length;
    ad.today += raw.length;
    ad.ok++;
    ad.lastRun = colHM();
    if (ad.status === 'warn' && ad.note.indexOf('失败') === 0) { ad.status = 'ok'; ad.note = '已恢复正常'; }

    colLog('info', '[' + p.label + '] 抓取到 ' + raw.length + ' 条评论，开始意向识别与打分…');
    await colWait(120);

    var hits = 0;
    for (var j = 0; j < raw.length; j++) {
      var c = raw[j];
      c.intent_score = colScore(c.comment, u.t.hit);
      if (c.intent_score >= COL.cfg.minScore) { hits++; batch.push({ c: c, t: u.t }); }
    }
    totalHit += hits;
    u.t.roundHit = hits;
    u.t.lastRun = colHM();
    colLog(hits ? 'ok' : 'warn', '[' + p.label + '] 命中高意向 ' + hits + ' / ' + raw.length + ' 条（≥' + COL.cfg.minScore + ' 分）');
    if (!raw.length) {
      colLog('warn', '[' + p.label + '] 本通道 0 条：' + (COL.cfg.expMode
        ? '样例库里没有匹配「' + (u.t.kw || '（空关键词）') + '」的评论，把任务关键词改成「报价」「汽车广告」「投放」再试'
        : '上游未返回数据，先在「采集服务配置」点「测试连接」确认通道可用，再检查关键词'));
    }

    done++;
    colProg(done / units.length * 100, '已完成 ' + done + '/' + units.length + ' 个通道');
    colRenderTasks(); colRenderAdapters(); colRenderStatus();
  }

  colLog('hl', '抓取阶段完成：共 ' + totalScan + ' 条评论 · 高意向 ' + totalHit + ' 条，进入去重与入库…');
  await colWait(160);

  var res = COL.cfg.autoIngest
    ? await colIngest(batch, tasks)
    : { added: 0, dup: 0, perTask: {} };
  if (!COL.cfg.autoIngest) colLog('warn', '自动入库已关闭，本轮 ' + batch.length + ' 条高意向结果未入库（要留存请到「采集服务配置」打开自动入库）');

  COL.stats.scan += totalScan;
  COL.stats.hit += totalHit;
  COL.stats.ingested += res.added;
  COL.stats.dup += res.dup;
  COL.stats.runAt = Date.now();
  tasks.forEach(function (t) { t.total = (t.total || 0) + (res.perTask[t.id] || 0); });

  COL.running = false;
  colProg(100, '本轮完成');
  colLog('hl', '本轮采集完成：抓取 ' + totalScan + ' 条 · 高意向 ' + totalHit + ' 条 · 去重拦截 ' + res.dup + ' 条 · 入库 ' + res.added + ' 条');
  if (t0 && t0.close) t0.close();
  toast('抓取 ' + totalScan + ' 条评论，新增 ' + res.added + ' 条高意向线索', 'ok', '采集完成');

  if (state.demo) renderAll();
  else { await refreshData(); renderAll(); }
  colRenderAll();
  saveRecord('collector_run', '采集轮次', {
    scan: totalScan, hit: totalHit, ingested: res.added, dup: res.dup,
    live: live, keywords: tasks.map(function (t) { return t.kw; })
  });
}

/* ---------- 测试连接 ---------- */
/* 现在采集统一经 BFF 门面，所以「测试连接」探的是服务端通道状态，
   而不是浏览器直连第三方服务地址（那样会遇到 CORS 与内网地址不可达）。 */
async function colProbe(silent) {
  var Api = window.Api;
  if (!Api || !Api.live()) {
    toast('服务端未连接：请先在「渲染 / 服务端」里配置 BFF 地址', 'warn', '未配置服务');
    return false;
  }
  var t = silent ? null : toast('正在探测服务端采集通道…', 'load', '测试连接');
  try {
    var r = await Api.call('/v1/collect/config', null, { method: 'GET', timeout: 12000 });
    if (t) t.close();
    if (!r.ok || !r.data) {
      var em = (r.error || r.code || '服务端未响应');
      colLog('err', '服务端通道探测失败：' + em);
      toast('探测失败：' + em, 'err', '连接失败');
      return false;
    }
    var chans = (r.data.channels || []).filter(function (c) { return c.id !== 'local' && c.configured; });
    var mode = (r.data.stats && r.data.stats.mode) || 'unconfigured';
    if (chans.length) {
      colLog('ok', '服务端已接入 ' + chans.length + ' 路真实通道 · mode=' + mode + ' · ' + chans.map(function (c) { return c.name; }).join(' / '));
      toast('通道已就绪：' + chans.map(function (c) { return c.name; }).join(' / '), 'ok', '连接成功');
      return true;
    }
    colLog('warn', '服务端暂无真实通道（mode=' + mode + '）');
    toast('服务端暂无真实通道，可点「一键体验样例」开启研究通道', 'warn', '未接入');
    return false;
  } catch (e) {
    if (t) t.close();
    var m = String((e && e.message) || e);
    colLog('err', '通道探测异常：' + m);
    toast('探测异常：' + m, 'err', '连接失败');
    return false;
  }
}

/* ---------- 配置弹窗 ---------- */
function colCfgModal() {
  var c = COL.cfg;
  var sel = function (name, val, opts) {
    return '<select class="fm-sel" id="' + name + '">' + opts.map(function (o) {
      return '<option value="' + esc(o.v) + '"' + (String(o.v) === String(val) ? ' selected' : '') + '>' + esc(o.l) + '</option>';
    }).join('') + '</select>';
  };
  var frow = function (label, inner, hint) {
    return '<div class="fm-row"><label>' + label + '</label>' + inner + (hint ? '<div class="fm-hint">' + hint + '</div>' : '') + '</div>';
  };
  var body =
    frow('采集通道模式', sel('colCfgMode', c.mode, [
      { v: 'auto', l: '自动（填了地址走真实采集，否则本地模拟）' },
      { v: 'live', l: '强制真实采集（失败即报错，不做模拟兜底）' },
      { v: 'sim', l: '强制本地模拟（用于流程演示与压测）' }
    ])) +
    frow('采集服务地址',
      '<input class="fm-inp" id="colCfgUrl" value="' + esc(c.serviceUrl) + '" placeholder="https://collect.your-domain.com">',
      '第三方采集服务（云机池 / 代理 IP 集群）的接口根地址，末尾不要带 /') +
    frow('鉴权 Token',
      '<input class="fm-inp" id="colCfgToken" value="' + esc(c.token) + '" placeholder="写入请求头 Authorization: Bearer <token>">',
      '仅保存在你的账号下（app_records 表，行级安全），不会外发到其它账号') +
    frow('接口约定', '<div class="col-code">POST {地址}/v1/comments/collect\nBody  { platform, keyword, limit, region }\nResp  { data: { comments: [ { nickname, comment, video_title, likes, at } ] } }\n健康检查  GET {地址}/v1/health</div>') +
    frow('单通道单轮抓取上限', sel('colCfgPer', c.perRound, [{ v: 20, l: '20 条' }, { v: 30, l: '30 条（推荐）' }, { v: 50, l: '50 条' }, { v: 100, l: '100 条' }])) +
    frow('入库意向分阈值', sel('colCfgScore', c.minScore, [{ v: 50, l: '50 分 · 宽松' }, { v: 60, l: '60 分 · 推荐' }, { v: 75, l: '75 分 · 严格' }, { v: 85, l: '85 分 · 只要高意向' }])) +
    frow('单通道请求间隔（防限流）', sel('colCfgGap', c.interval, [{ v: 60, l: '60 秒' }, { v: 300, l: '300 秒 · 推荐' }, { v: 600, l: '600 秒' }])) +
    frow('代理 / 云机池区域',
      '<input class="fm-inp" id="colCfgProxy" value="' + esc(c.proxy) + '" placeholder="如：华东-杭州 / 代理池 ID">') +
    frow('采集策略',
      '<div class="fm-check">' +
        '<label><input type="checkbox" id="colCfgDedupe"' + (c.dedupe ? ' checked' : '') + '><span>开启去重拦截</span></label>' +
        '<label><input type="checkbox" id="colCfgAuto"' + (c.autoIngest ? ' checked' : '') + '><span>命中后自动入线索库</span></label>' +
        '<label><input type="checkbox" id="colCfgQuota"' + (c.dailyCap ? ' checked' : '') + '><span>遵守日采集配额</span></label>' +
      '</div>') +
    '<div class="alert warn" style="margin:2px 0 0"><svg class="icon"><use href="#i-shield"/></svg><div>' +
      '<b>合规边界</b>平台官方均未开放评论区读取接口；请勿使用个人微信抓取或高频爆破。建议按平台申请企业号授权，或采购具备资质的第三方采集服务，并遵守各平台 robots 与频控规则。' +
    '</div></div>';

  openModal({
    title: '采集服务配置', sub: '填好地址后自动切换为真实采集；留空则走本地模拟通道，链路完全一致',
    icon: 'i-radar', wide: true, body: body,
    footer: '<button class="btn ghost" data-col="exp" type="button">一键体验样例</button>' +
            '<button class="btn" data-m="cancel" type="button">取消</button>' +
            '<button class="btn" data-col="probeModal" type="button">测试连接</button>' +
            '<button class="btn primary" data-m="ok" type="button">保存配置</button>',
    onOk: function (rec) {
      var m = rec.mask;
      c.mode = colQ('#colCfgMode', m).value;
      c.serviceUrl = colQ('#colCfgUrl', m).value.trim();
      c.token = colQ('#colCfgToken', m).value.trim();
      c.perRound = Number(colQ('#colCfgPer', m).value) || 30;
      c.minScore = Number(colQ('#colCfgScore', m).value) || 60;
      c.interval = Number(colQ('#colCfgGap', m).value) || 300;
      c.proxy = colQ('#colCfgProxy', m).value.trim();
      c.dedupe = colQ('#colCfgDedupe', m).checked;
      c.autoIngest = colQ('#colCfgAuto', m).checked;
      c.dailyCap = colQ('#colCfgQuota', m).checked ? 2000 : 0;
      colRenderAll();
      colLog('ok', '采集服务配置已保存 · 通道=' + (colLiveMode() ? '真实采集' : '本地模拟') + ' · 阈值 ' + c.minScore + ' 分 · 单轮上限 ' + c.perRound + ' 条 · 间隔 ' + c.interval + 's');
      saveRecord('collector_cfg', '采集器配置', {
        mode: c.mode, url: c.serviceUrl, proxy: c.proxy, perRound: c.perRound,
        minScore: c.minScore, interval: c.interval, dedupe: c.dedupe, autoIngest: c.autoIngest
      }).then(function () { toast('采集服务配置已保存', 'ok', '配置已更新'); });
      /* 让服务端真正接管采集通道：把地址 + Token 写进 BFF（vendor 通道），
         无需改环境变量 / 重启。Api 不在线时静默跳过，保留前端本地配置。 */
      if (window.Api && window.Api.live()) {
        window.Api.call('/v1/collect/config', {
          channel: 'vendor', url: c.serviceUrl, token: c.token
        }, { method: 'POST', timeout: 12000 }).then(function (r) {
          if (r.ok) {
            colLog('ok', '服务端已接管采集通道（vendor）· ' + ((r.data && r.data.url) || '已清空地址'));
            toast('服务端采集通道已更新，即时生效', 'ok', '已生效');
            colProbe(true);
          } else {
            colLog('warn', '服务端通道更新失败：' + (r.error || r.code || ''));
          }
        });
      }
      return false;
    }
  });
}

/* ---------- 一键体验：把 crawler 通道指向本地 MediaCrawler 研究桥 ---------- */
function colExperience() {
  var Api = window.Api;
  if (!Api || !Api.live()) {
    toast('服务端未连接：请先配置 BFF 地址后再体验', 'warn', '无法体验');
    return;
  }
  var t = toast('正在开启体验通道…', 'load', '一键体验');
  Api.call('/v1/collect/config', { channel: 'crawler', url: '__EXP__' }, { method: 'POST', timeout: 12000 })
    .then(function (r) {
      if (t) t.close();
      if (!r.ok) {
        toast('开启失败：' + (r.error || r.code || '服务端未响应'), 'err', '体验未开启');
        return;
      }
      var url = (r.data && r.data.url) || 'http://127.0.0.1:8802';
      COL.cfg.mode = 'live';
      COL.cfg.expMode = true;
      COL.cfg.serviceUrl = url;
      colRenderAll();
      colLog('ok', '体验通道已开启 · 数据源 = MediaCrawler 研究桥（合成样例 · 非商用）· ' + url);
      colLog('info', '点「立即采集一轮」即可走通：抓取 → 打分 → 去重 → 入线索池。数据为合成样例，不含任何真实个人信息。');
      toast('体验通道已开启，点「立即采集一轮」开始', 'ok', '体验模式');
    })['catch'](function (e) {
      if (t) t.close();
      toast('开启失败：' + String((e && e.message) || e), 'err', '体验未开启');
    });
}

/* ---------- 任务编辑弹窗 ---------- */
function colTaskModal(id) {
  colSeedTasks();
  var t = colTask(id);
  if (!t) return;
  var pfs = COL_PLATFORMS.map(function (p) {
    return '<label><input type="checkbox" value="' + p.key + '"' + (t.pf.indexOf(p.key) > -1 ? ' checked' : '') + '><span>' + p.label + '</span></label>';
  }).join('');
  var body =
    '<div class="fm-row"><label>监听关键词</label><input class="fm-inp" id="colTaskKw" value="' + esc(t.kw) + '"></div>' +
    '<div class="fm-row"><label>扫描平台</label><div class="fm-check">' + pfs + '</div>' +
      '<div class="fm-hint">每个勾选的平台都会被单独调度一次采集</div></div>' +
    '<div class="fm-row"><label>扫描频率</label><select class="fm-sel" id="colTaskFreq">' +
      FREQ_OPTS.map(function (o) { return '<option value="' + o.v + '"' + (o.v === t.freq ? ' selected' : '') + '>' + o.l + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="fm-row"><label>高意向判定词</label><input class="fm-inp" id="colTaskHit" value="' + esc((t.hit || []).join('、')) + '" placeholder="报价、预算、起量、合作">' +
      '<div class="fm-hint">评论命中任意词即额外加分，更容易跨过入库阈值</div></div>' +
    '<div class="fm-row"><label>运行状态</label><div class="fm-check">' +
      '<label><input type="checkbox" id="colTaskOn"' + (t.on ? ' checked' : '') + '><span>开启自动采集</span></label>' +
    '</div></div>';
  openModal({
    title: '采集任务设置', sub: t.kw + ' · 累计入库 ' + (t.total || 0) + ' 条',
    icon: 'i-filter', body: body, okText: '保存任务',
    footer: '<button class="btn ghost" data-col="delTask" data-task="' + t.id + '" type="button">删除任务</button>' +
            '<button class="btn" data-m="cancel" type="button">取消</button>' +
            '<button class="btn primary" data-m="ok" type="button">保存任务</button>',
    onOk: function (rec) {
      var m = rec.mask;
      var kw = colQ('#colTaskKw', m).value.trim();
      if (!kw) { toast('监听关键词不能为空', 'err', '请检查表单'); return true; }
      var pf = colQa('.fm-check input[type=checkbox][value]', m)
        .filter(function (x) { return x.checked && CPF[x.value]; })
        .map(function (x) { return x.value; });
      if (!pf.length) { toast('至少选择一个扫描平台', 'err', '请检查表单'); return true; }
      t.kw = kw;
      t.pf = pf;
      t.freq = colQ('#colTaskFreq', m).value;
      t.hit = colQ('#colTaskHit', m).value.split(/[、,，\s]+/).filter(Boolean);
      t.on = colQ('#colTaskOn', m).checked;
      colRenderTasks();
      colLog('info', '采集任务已更新：「' + t.kw + '」· ' + pf.map(function (k) { return CPF[k].label; }).join('/') + ' · ' + (FREQ_LABEL[t.freq] || ''));
      saveRecord('collector_task', t.kw, { platforms: pf, freq: t.freq, hit: t.hit, on: t.on })
        .then(function () { toast('采集任务已保存', 'ok', '任务已更新'); });
      return false;
    }
  });
}

/* ---------- 统一线索池 ----------
   评论区「高意向线索」、这里、「客户管理 CRM」用的是同一份 state.leads，
   以前还有一个独立的「调度线索池」（读服务端另一份表），两处口径不一致，已合并到这份。 */
function colLeadsPool() {
  var leads = (state.leads || []).slice().sort(function (a, b) {
    return (b.intent_score || 0) - (a.intent_score || 0);
  });
  if (!leads.length) {
    openModal({
      title: '线索池', sub: '共 0 条', icon: 'i-users', wide: true, okText: null, cancelText: '关闭',
      body: '<div class="col-empty" style="padding:26px;text-align:center">线索池还是空的。点「立即采集一轮」或让关键词任务跑一轮，命中的评论会自动进来。</div>'
    });
    return;
  }
  var body = '<div style="max-height:50vh;overflow:auto">' + leads.slice(0, 80).map(function (l, i) {
    var m = PF[l.platform] || PF.douyin;
    var sc = l.intent_score || 0;
    return '<div class="colsd-lead">' +
      '<div class="colsd-lead-n">' + (i + 1) + '</div>' +
      '<div class="colsd-lead-b">' +
        '<div class="colsd-lead-t">' + esc(l.comment || '') + '</div>' +
        '<div class="colsd-lead-m">' +
          '<span class="tag ' + (m.cls === 'dy' ? 'blue' : m.cls === 'ks' ? 'amber' : m.cls === 'xhs' ? 'red' : 'accent') + '">' + m.label + '</span>' +
          '<span>' + esc(l.nickname || '—') + '</span>' +
          '<span>关键词：' + esc(l.keyword || '—') + '</span>' +
          '<span>意向 ' + sc + '</span>' +
          '<span>' + stageTag(l.stage) + '</span>' +
          '<span>' + esc(colSince(Date.parse(l.created_at || '') || 0)) + '</span>' +
          (l.wechat_note ? '<span class="tag green">备注：' + esc(l.wechat_note) + '</span>' : '') +
        '</div>' +
      '</div></div>';
  }).join('') + '</div>';
  openModal({
    title: '线索池',
    sub: '共 ' + leads.length + ' 条（按意向分排序，展示前 ' + Math.min(80, leads.length) + ' 条）· 与 CRM 同一份数据',
    icon: 'i-users', wide: true,
    okText: '导出 CSV', cancelText: '关闭',
    body: body,
    onOk: function () {
      exportCSV('ProFound-线索池-' + new Date().toISOString().slice(0, 10) + '.csv',
        ['平台', '昵称', '关键词', '评论原文', '意向分', '需求', '阶段', '微信备注', '入库时间'],
        leads.map(function (l) {
          return [(PF[l.platform] || {}).label || l.platform, l.nickname, l.keyword, l.comment,
            l.intent_score || 0, l.requirement || '', (STAGE_META[l.stage] || {}).label || l.stage,
            l.wechat_note || '', l.created_at || ''];
        }));
      return false;
    }
  });
}
window.__COL_LEADS_POOL = colLeadsPool;

/* ---------- 配置持久化 ---------- */
async function colLoad() {
  if (COL.loaded || state.demo || !cloud || !state.session) return;
  COL.loaded = true;
  try {
    var r = await cloud.database.from('app_records').select('*').eq('kind', 'collector_cfg')
      .order('created_at', { ascending: false }).limit(1);
    if (!r.error && Array.isArray(r.data) && r.data.length) {
      var m = r.data[0].meta || {};
      if (m.url !== undefined) COL.cfg.serviceUrl = m.url || '';
      if (m.mode) COL.cfg.mode = m.mode;
      if (m.proxy !== undefined) COL.cfg.proxy = m.proxy || '';
      if (m.perRound) COL.cfg.perRound = Number(m.perRound) || 30;
      if (m.minScore) COL.cfg.minScore = Number(m.minScore) || 60;
      if (m.interval) COL.cfg.interval = Number(m.interval) || 300;
      if (m.dedupe !== undefined) COL.cfg.dedupe = !!m.dedupe;
      if (m.autoIngest !== undefined) COL.cfg.autoIngest = !!m.autoIngest;
      colLog('info', '已载入云端采集器配置');
      colRenderAll();
    }
  } catch (e) {}
}

/* =========================================================
   事件绑定
   ========================================================= */
/* 话术模板：点条目切换当前模板并同步预览（模板内容由「新建话术模板」写入后端） */
document.addEventListener('click', function (e) {
  var it = e.target.closest('#wxTplList .tpl-item');
  if (!it) return;
  var list = it.parentNode.querySelectorAll('.tpl-item');
  for (var i = 0; i < list.length; i++) list[i].classList.remove('active');
  it.classList.add('active');
  var pv = document.getElementById('wxTplPreview');
  if (pv) pv.textContent = it.getAttribute('data-say') || pv.textContent;
});

document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-col]');
  if (!b) return;
  var act = b.getAttribute('data-col');
  var tid = b.getAttribute('data-task');
  /* 任务操作统一走服务端（有服务端时）；没有服务端才退回本地草稿 */
  if (act === 'runTaskNow') {
    var sdRun = window.__COLSD;
    if (colServerSd() && sdRun && sdRun.runTask) sdRun.runTask(tid, false);
    else colRun(tid || null);
    return;
  }
  if (act === 'toggleTask') {
    var sdTog = window.__COLSD;
    if (colServerSd() && sdTog && sdTog.toggleTask) {
      var cur = null;
      colServerSd().tasks.forEach(function (t) { if (t.id === tid) cur = t; });
      sdTog.toggleTask(tid, cur ? cur.enabled === false : true);
    } else {
      var lt = colTask(tid);
      if (lt) { lt.on = !lt.on; colRenderTasks(); }
    }
    return;
  }
  if (act === 'run') { colRun(tid || null); return; }
  if (act === 'allLeads') { colLeadsPool(); return; }
  if (act === 'cfg') { colCfgModal(); return; }
  if (act === 'exp') { colExperience(); return; }
  if (act === 'probe') { colProbe(); return; }
  if (act === 'probeModal') { var u = colQ('#colCfgUrl'); if (u) { COL.cfg.serviceUrl = u.value.trim(); var tk = colQ('#colCfgToken'); COL.cfg.token = tk ? tk.value.trim() : COL.cfg.token; } colProbe(); return; }
  if (act === 'probeAll') {
    colInitAdapters();
    COL_PLATFORMS.forEach(function (p) {
      var a = COL.adapters[p.key];
      a.lastRun = colHM();
      a.note = a.enabled ? (p.key === 'xhs' ? '云机池排队中（预计 1 分钟）' : '握手正常') : '已停用';
      if (a.enabled && p.key === 'xhs') a.status = 'warn';
    });
    colRenderAdapters();
    colLog('ok', '已同步 4 个平台适配器状态 · ' + (colLiveMode() ? '真实采集通道' : '本地模拟通道'));
    toast('适配器状态已同步', 'ok', '同步完成');
    return;
  }
  if (act === 'toggleAd') {
    var ad = COL.adapters[b.getAttribute('data-ad')];
    if (!ad) return;
    ad.enabled = !ad.enabled;
    if (!ad.enabled) ad.status = 'off';
    else ad.status = 'ok';
    colRenderAdapters();
    var nm = (CPF[b.getAttribute('data-ad')] || {}).label || '平台';
    colLog(ad.enabled ? 'ok' : 'warn', nm + ' 适配器已' + (ad.enabled ? '启用' : '停用'));
    toast(nm + ' 适配器已' + (ad.enabled ? '启用' : '停用'), ad.enabled ? 'ok' : 'warn', '适配器状态已更新');
    return;
  }
  if (act === 'clearlog') {
    COL.log = [];
    colPaintLog();
    colProg(0, '待运行');
    toast('运行日志已清空', 'info', '已清空');
    return;
  }
  if (act === 'editTask') {
    var sdEdit = window.__COLSD;
    if (colServerSd() && sdEdit && sdEdit.openForm) {
      var raw = null;
      colServerSd().tasks.forEach(function (t) { if (t.id === tid) raw = t; });
      if (raw) sdEdit.openForm(raw);
    } else colTaskModal(tid);
    return;
  }
  if (act === 'delTask') {
    var dt = colTask(tid);
    if (!dt) return;
    var rec = b.closest('.modal-mask');
    if (rec) { var x = rec.querySelector('.m-x'); if (x) x.click(); }
    confirmDlg({
      title: '删除采集任务？', icon: 'i-warning',
      html: '将删除「' + esc(dt.kw) + '」的采集任务，已入库的线索不受影响。',
      okText: '确认删除',
      onOk: async function () {
        COL.tasks = COL.tasks.filter(function (x) { return x.id !== dt.id; });
        colRenderTasks();
        colLog('warn', '已删除采集任务「' + dt.kw + '」');
        toast('采集任务已删除', 'ok', '任务已删除');
        await saveRecord('collector_task', '删除任务 ' + dt.kw, { deleted: true });
      }
    });
    return;
  }
});

/* 任务开关：不再单独绑定——开关带 data-col="toggleTask"，统一由上面的委托处理
   （服务端任务走 PATCH，本地草稿才改内存），避免同一点击被处理两次。 */

/* 平台标签页过滤 */
colQa('#v-content .tabs .tab').forEach(function (tab) {
  tab.addEventListener('click', function () {
    var pf = tab.getAttribute('data-pf');
    COL.filter = (pf && pf !== 'all') ? (PF_ALIAS[pf] || null) : null;
    colRenderTasks();
  });
});

/* 「新建监听任务」→ 能连服务端就建服务端调度任务（常驻执行），否则退回本地草稿表单 */
T['新建监听任务'] = function (btn) {
  if (colServerSd() && window.__COLSD && window.__COLSD.openForm) { window.__COLSD.openForm(null); return; }
  formModal({
    title: '新建关键词监听任务', sub: '任务创建后立即进入采集调度，按设定频率扫描评论区',
    icon: 'i-radar', okText: '创建并开始采集',
    fields: [
      { name: 'kw', label: '监听关键词', required: true, placeholder: '如：抖音代运营 报价' },
      { name: 'pf', label: '扫描平台', type: 'checks', options: COL_PLATFORMS.map(function (p) { return { value: p.key, label: p.label }; }) },
      { name: 'freq', label: '扫描频率', type: 'select', options: FREQ_OPTS.map(function (o) { return o.l; }) },
      { name: 'hit', label: '高意向判定词', placeholder: '报价、预算、起量、合作', hint: '命中任意词即额外加分，更容易跨过入库阈值' },
      { name: 'note', label: '备注', type: 'textarea', placeholder: '可选：说明该词针对的产品线' }
    ],
    onSubmit: async function (d) {
      colSeedTasks();
      var label2key = {};
      FREQ_OPTS.forEach(function (o) { label2key[o.l] = o.v; });
      var freq = label2key[d.freq] || 'realtime';
      var pf = (d.pf && d.pf.length) ? d.pf.map(function (x) { return PF_ALIAS[x] || x; }) : ['douyin'];
      var hit = String(d.hit || '').split(/[、,，\s]+/).filter(Boolean);
      var task = {
        id: 't' + (COL.seq++), kw: d.kw, pf: pf, freq: freq,
        hit: hit, on: true, total: 0, roundHit: 0, lastRun: '尚未采集'
      };
      COL.tasks.unshift(task);
      COL.filter = null;
      colQa('#v-content .tabs .tab').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-pf') === 'all'); });
      colRenderTasks();
      colLog('ok', '新建采集任务：「' + d.kw + '」· ' + pf.map(function (k) { return (CPF[k] || {}).label || k; }).join('/') + ' · ' + (FREQ_LABEL[freq] || ''));
      await saveRecord('collector_task', d.kw, { platforms: pf, freq: freq, hit: hit, on: true, note: d.note });
      toast('任务「' + d.kw + '」已创建，' + pf.length + ' 个平台已进入采集调度', 'ok', '任务已上线');
      setTimeout(function () { colRun(task.id); }, 420);
    }
  });
};


/* 渲染钩子：任何数据刷新后同步采集器 UI */
var _colRenderAll = renderAll;
renderAll = function () { _colRenderAll(); colRenderAll(); };
var _colGo = go;
go = function (v) { _colGo(v); if (v === 'v-content') colRenderAll(); };

/* 首屏初始化 */
colInitAdapters();
colSeedTasks();
colRenderAll();
colProg(0, '待运行');
colLog('info', '采集器已就绪：4 个平台适配器（抖音 / 快手 / 小红书 / 视频号）');
colLog('info', '当前通道：' + (colLiveMode() ? '真实采集（' + COL.cfg.serviceUrl + '）' : '本地模拟（未配置采集服务地址）'));
setTimeout(function () { colLoad(); }, 1200);

})();

/* __RT_BRIDGE_START__ */
window.__UI = { errors: [] };
(function (box) {
  var names = ['toast', 'openModal', 'formModal', 'confirmDlg', 'wait', 'money', 'saveRecord', 'refreshStatus'];
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    try {
      box[n] = eval(n);
    } catch (e) {
      box.errors.push(n + ': ' + String((e && e.message) || e));
    }
  }
})(window.__UI);
/* __RT_BRIDGE_END__ */

})();

