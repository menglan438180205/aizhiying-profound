/* =========================================================
   13-llm.js — 后台管理 · 大模型配置（全栈统一）
   ---------------------------------------------------------
   放在「风控与设置」里，因为模型接入属于管理动作：谁能改 key，
   谁就能决定全站内容长什么样。这里只做界面，key 的明文永远不出服务端：

     GET    /v1/admin/llm           列表（脱敏，sk-****abcd）
     POST   /v1/admin/llm           新增 / 修改
     POST   /v1/admin/llm/test      真实调一次，返回延迟与回显
     GET    /v1/admin/llm/models    拉模型清单（网关不实现时为空）
     POST   /v1/admin/llm/enable    启用 / 停用
     POST   /v1/admin/llm/default   设为默认
     DELETE /v1/admin/llm/:id       删除

   为什么要「按用途分配」而不是一个全局模型：
     评论仿写要更像口语（温度高、便宜、快），GEO 资产页要长文与结构
     （贵模型、温度低），质检要稳（温度 0）。一个模型全包，要么贵，
     要么效果打折。
   ========================================================= */
(function () {
  'use strict';
  var HOST = 'v-settings';
  var PANEL = 'llmPanel';
  var S = { data: null, editing: null, busy: false, models: [], shown: false, loaded: false };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function toast(msg, kind, title) {
    try { if (window.toast) return window.toast(msg, kind || 'info', title || '大模型'); } catch (e) {}
  }
  function api(path, body, opt) {
    var o = opt || {};
    return window.Api.call(path, body == null ? null : body, {
      method: o.method || (body == null ? 'GET' : 'POST'),
      timeout: o.timeout || 30000
    });
  }
  function errOf(r) {
    if (!r) return '网络未就绪';
    var j = r.json || r.data;
    return (j && (j.message || j.error)) || r.error || r.code || '操作失败';
  }

  /* ---------------- 面板骨架 ---------------- */
  function ensure() {
    var host = $(HOST);
    if (!host) return null;
    var p = $(PANEL);
    if (p && host.contains(p)) return p;
    p = document.createElement('div');
    p.className = 'card';
    p.id = PANEL;
    p.innerHTML =
      '<div class="card-head"><h3>大模型引擎 · 全栈统一配置</h3>' +
        '<div class="right">' +
          '<span class="tag" id="llmState">读取中…</span>' +
          '<button class="btn sm" id="llmReload" type="button">刷新</button>' +
          '<button class="btn sm primary" id="llmNew" type="button">新增模型</button>' +
        '</div></div>' +
      '<div class="card-body" id="llmBody">' +
        '<div class="llm-hint" id="llmHint">接口地址填 OpenAI 兼容网关（如 <code>https://api.openai.com/v1</code>、<code>https://dashscope.aliyuncs.com/compatible-mode/v1</code>）。' +
        'API Key 保存后只显示尾号；停用全部模型时，评论与 GEO 自动退回本地模板，功能不中断。</div>' +
        '<div id="llmList"></div>' +
        '<div id="llmForm" style="display:none"></div>' +
      '</div>';
    var anchor = host.querySelector('.grid');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(p, anchor);
    else host.appendChild(p);
    bindHead();
    return p;
  }

  function bindHead() {
    var b = $('llmReload');
    if (b && !b.__llm) { b.__llm = 1; b.addEventListener('click', function () { load(true); }); }
    var n = $('llmNew');
    if (n && !n.__llm) { n.__llm = 1; n.addEventListener('click', function () { openForm(null); }); }
  }

  /* ---------------- 数据 ---------------- */
  async function load(force) {
    if (!window.Api || !Api.live || !Api.live()) return;
    if (S.busy) return;
    if (S.loaded && !force) return;
    S.busy = true;
    var r = await api('/v1/admin/llm');
    S.busy = false;
    if (!r || !r.ok) {
      var st = $('llmState');
      if (st) { st.className = 'tag red'; st.textContent = '读取失败'; }
      var box = $('llmList');
      if (box) box.innerHTML = '<div class="llm-empty">' + esc(errOf(r)) + '</div>';
      return;
    }
    S.data = r.data || { items: [] };
    S.loaded = true;
    render();
  }

  function purposeTags(item) {
    var all = (S.data && S.data.purposes) || [];
    var picked = (item.purposes || []);
    if (!picked.length) return '<span class="tag">全部用途</span>';
    return picked.map(function (id) {
      var p = all.filter(function (x) { return x.id === id; })[0];
      return '<span class="tag blue">' + esc((p && p.name) || id) + '</span>';
    }).join('');
  }

  function render() {
    var d = S.data || { items: [] };
    var st = $('llmState');
    if (st) {
      if (d.envConfigured && !(d.items || []).length) { st.className = 'tag amber'; st.textContent = '仅环境变量'; }
      else if (d.llmReady) { st.className = 'tag green'; st.textContent = '已启用 · ' + (d.activeName || ''); }
      else { st.className = 'tag amber'; st.textContent = '未启用（走本地模板）'; }
    }
    var box = $('llmList');
    if (!box) return;
    var items = d.items || [];
    if (!items.length) {
      box.innerHTML = '<div class="llm-empty"><b>还没有配置模型</b><br>不配也能用：评论仿写走本地模板、GEO 走内置模板。配了之后内容更像人、更像专业编辑。</div>';
      return;
    }
    box.innerHTML = items.map(function (it) {
      var badges = '';
      if (it.isDefault) badges += '<span class="tag blue">默认</span>';
      if (!it.enabled) badges += '<span class="tag">已停用</span>';
      if (!it.hasKey) badges += '<span class="tag red">缺 Key</span>';
      var test = it.lastTest
        ? (it.lastTest.ok
          ? '<span class="llm-test ok">上次可用 · ' + Math.round(it.lastTest.ms || 0) + 'ms</span>'
          : '<span class="llm-test fail" title="' + esc(it.lastTest.msg || '') + '">上次失败</span>')
        : '<span class="llm-test">未测试</span>';
      return '<div class="llm-row' + (it.enabled ? '' : ' off') + '" data-id="' + esc(it.id) + '">' +
        '<div class="llm-main">' +
          '<div class="llm-name"><b>' + esc(it.name) + '</b>' + badges + test + '</div>' +
          '<div class="llm-meta">' + esc(it.model) + ' · ' + esc(it.base_url) + '</div>' +
          '<div class="llm-chips">' + purposeTags(it) +
            '<span class="llm-key">' + (it.hasKey ? 'Key ' + esc(it.keyMask) : '未填 Key') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="llm-acts">' +
          '<button type="button" class="btn sm" data-llm="test">测试</button>' +
          (it.isDefault ? '' : '<button type="button" class="btn sm" data-llm="default">设为默认</button>') +
          '<button type="button" class="btn sm" data-llm="toggle">' + (it.enabled ? '停用' : '启用') + '</button>' +
          '<button type="button" class="btn sm" data-llm="edit">编辑</button>' +
          '<button type="button" class="btn sm" data-llm="del">删除</button>' +
        '</div>' +
      '</div>';
    }).join('') + (d.envConfigured
      ? '<div class="llm-hint" style="margin-top:8px">检测到环境变量 <code>LLM_BASE_URL / LLM_API_KEY / LLM_MODEL</code>：未配置入库模型时会自动用它兜底。正式环境建议在这里录入，便于随时切换。</div>'
      : '');
    bindRows();
  }

  function bindRows() {
    var box = $('llmList');
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('[data-llm]'), function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.llm-row');
        var id = row && row.getAttribute('data-id');
        var act = btn.getAttribute('data-llm');
        if (!id) return;
        if (act === 'test') runTest(id, btn);
        else if (act === 'default') setDefault(id);
        else if (act === 'toggle') toggle(id);
        else if (act === 'edit') openForm(id);
        else if (act === 'del') removeIt(id);
      });
    });
  }

  /* ---------------- 表单 ---------------- */
  function openForm(id) {
    var b = null;
    var it = null;
    if (id && S.data) it = (S.data.items || []).filter(function (x) { return x.id === id; })[0];
    S.editing = it ? it.id : '';
    S.models = [];
    var purposes = (S.data && S.data.purposes) || [];
    var picked = it ? (it.purposes || []) : [];
    var f = $('llmForm');
    if (!f) return;
    f.style.display = '';
    f.innerHTML =
      '<div class="llm-form-hd"><b>' + (it ? '编辑模型' : '新增模型') + '</b>' +
        '<span class="llm-form-sub">接口地址与模型名以服务商文档为准；保存前可先「测试连接」</span></div>' +
      '<div class="llm-grid">' +
        '<label class="llm-fld"><span>名称</span><input id="llmFName" value="' + esc(it ? it.name : '') + '" placeholder="例如 通义千问 · 评论" autocomplete="off"></label>' +
        '<label class="llm-fld"><span>接口地址（OpenAI 兼容）</span><input id="llmFBase" value="' + esc(it ? it.base_url : '') + '" placeholder="https://api.openai.com/v1" autocomplete="off"></label>' +
        '<label class="llm-fld"><span>API Key' + (it && it.hasKey ? '（留空不修改）' : '') + '</span><input id="llmFKey" type="password" placeholder="' + (it && it.hasKey ? '已保存 ' + esc(it.keyMask) : 'sk-...') + '" autocomplete="off"></label>' +
        '<label class="llm-fld"><span>模型名</span><input id="llmFModel" value="' + esc(it ? it.model : '') + '" list="llmModelList" placeholder="gpt-4o-mini / qwen-plus / deepseek-chat" autocomplete="off">' +
          '<datalist id="llmModelList"></datalist></label>' +
        '<label class="llm-fld sm"><span>温度</span><input id="llmFTemp" type="number" step="0.05" min="0" max="2" value="' + (it ? it.temperature : 0.7) + '"></label>' +
        '<label class="llm-fld sm"><span>最大 tokens</span><input id="llmFMax" type="number" min="64" max="16384" value="' + (it ? it.max_tokens : 2048) + '"></label>' +
        '<label class="llm-fld sm"><span>超时（毫秒）</span><input id="llmFTimeout" type="number" min="5000" max="300000" step="1000" value="' + (it ? it.timeout_ms : 60000) + '"></label>' +
      '</div>' +
      '<div class="llm-purposes"><span>用途</span>' +
        purposes.map(function (p) {
          return '<label class="llm-chk"><input type="checkbox" data-purpose="' + esc(p.id) + '"' +
            (picked.indexOf(p.id) >= 0 ? ' checked' : '') + '> ' + esc(p.name) +
            '<em title="' + esc(p.desc) + '">' + esc(p.desc) + '</em></label>';
        }).join('') +
        '<span class="llm-purposes-tip">全不勾 = 所有用途都能用（适合只配一个模型的情况）</span>' +
      '</div>' +
      '<div class="llm-form-acts">' +
        '<label class="llm-chk inline"><input type="checkbox" id="llmFOn"' + (!it || it.enabled ? ' checked' : '') + '> 启用</label>' +
        '<label class="llm-chk inline"><input type="checkbox" id="llmFDef"' + (it && it.isDefault ? ' checked' : '') + '> 设为默认</label>' +
        '<span style="flex:1"></span>' +
        '<button type="button" class="btn sm" id="llmFModels">拉取模型清单</button>' +
        '<button type="button" class="btn sm" id="llmFTest">测试连接</button>' +
        '<button type="button" class="btn sm" id="llmFCancel">取消</button>' +
        '<button type="button" class="btn sm primary" id="llmFSave">保存</button>' +
      '</div>' +
      '<div class="llm-form-msg" id="llmFMsg"></div>';

    if ((b = $('llmFCancel'))) b.addEventListener('click', closeForm);
    if ((b = $('llmFSave'))) b.addEventListener('click', saveForm);
    if ((b = $('llmFTest'))) b.addEventListener('click', function () { testForm(b); });
    if ((b = $('llmFModels'))) b.addEventListener('click', fillModels);
    var nameEl = $('llmFName');
    if (nameEl && !it) { try { nameEl.focus(); } catch (e) {} }
  }

  function closeForm() {
    var f = $('llmForm');
    if (f) { f.style.display = 'none'; f.innerHTML = ''; }
    S.editing = null;
  }

  function formBody() {
    var purposes = [];
    Array.prototype.forEach.call(document.querySelectorAll('#llmForm [data-purpose]'), function (cb) {
      if (cb.checked) purposes.push(cb.getAttribute('data-purpose'));
    });
    return {
      id: S.editing || '',
      name: (($('llmFName') || {}).value || '').trim(),
      base_url: (($('llmFBase') || {}).value || '').trim(),
      api_key: (($('llmFKey') || {}).value || '').trim(),
      model: (($('llmFModel') || {}).value || '').trim(),
      temperature: Number(($('llmFTemp') || {}).value),
      max_tokens: Number((($('llmFMax') || {}).value)),
      timeout_ms: Number((($('llmFTimeout') || {}).value)),
      purposes: purposes,
      enabled: !!($('llmFOn') && $('llmFOn').checked),
      isDefault: !!($('llmFDef') && $('llmFDef').checked)
    };
  }

  function formMsg(text, kind) {
    var m = $('llmFMsg');
    if (!m) return;
    m.className = 'llm-form-msg' + (kind ? ' ' + kind : '');
    m.textContent = text || '';
  }

  async function testForm(btn) {
    var b = formBody();
    if (!b.base_url || !b.model || (!b.api_key && !S.editing)) {
      formMsg('先填接口地址、模型名和 API Key 再测试', 'fail');
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
    formMsg('正在真实调用一次（约 1~10 秒）…');
    var r = await api('/v1/admin/llm/test', b, { timeout: 120000 });
    if (btn) { btn.disabled = false; btn.textContent = '测试连接'; }
    var d = (r && r.data) || {};
    if (r && r.ok && d.ok) {
      formMsg('可用 · ' + Math.round(d.ms || 0) + 'ms · 模型回显「' + (d.reply || '').slice(0, 30) + '」', 'ok');
    } else {
      formMsg('失败：' + (d.error || errOf(r)), 'fail');
    }
  }

  async function fillModels() {
    var b = formBody();
    if (!b.base_url) { formMsg('先填接口地址', 'fail'); return; }
    formMsg('正在拉取模型清单…');
    var r = await api('/v1/admin/llm/models', {
      id: b.id || '', base_url: b.base_url, api_key: b.api_key
    }, { timeout: 20000 });
    var d = (r && r.data) || {};
    if (!d.ok || !(d.items || []).length) {
      formMsg('网关没有返回模型清单（手填模型名即可）：' + (d.error || ''), 'fail');
      return;
    }
    var dl = $('llmModelList');
    if (dl) dl.innerHTML = d.items.map(function (x) { return '<option value="' + esc(x) + '">'; }).join('');
    formMsg('已拉到 ' + d.items.length + ' 个模型，点模型名输入框可从下拉里选', 'ok');
  }

  async function saveForm() {
    var b = formBody();
    if (!b.base_url) { formMsg('接口地址不能为空', 'fail'); return; }
    if (!b.model) { formMsg('模型名不能为空', 'fail'); return; }
    if (!S.editing && !b.api_key) { formMsg('新增模型必须填 API Key', 'fail'); return; }
    var btn = $('llmFSave');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    var r = await api('/v1/admin/llm', b);
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
    if (!r || !r.ok) { formMsg(errOf(r), 'fail'); return; }
    S.data = r.data && r.data.list ? r.data.list : S.data;
    S.loaded = true;
    closeForm();
    render();
    toast('模型已保存：' + (b.name || b.model), 'ok');
  }

  /* ---------------- 行内动作 ---------------- */
  async function runTest(id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '测试中'; }
    var r = await api('/v1/admin/llm/test', { id: id }, { timeout: 120000 });
    if (btn) { btn.disabled = false; btn.textContent = '测试'; }
    var d = (r && r.data) || {};
    if (r && r.ok && d.ok) toast('可用 · ' + Math.round(d.ms || 0) + 'ms', 'ok');
    else toast('不可用：' + (d.error || errOf(r)), 'err');
    await load(true);
  }

  async function setDefault(id) {
    var r = await api('/v1/admin/llm/default', { id: id });
    if (!r || !r.ok) { toast(errOf(r), 'err'); return; }
    S.data = r.data && r.data.list ? r.data.list : S.data;
    render();
    toast('已设为默认模型', 'ok');
  }

  async function toggle(id) {
    var it = (S.data.items || []).filter(function (x) { return x.id === id; })[0];
    var r = await api('/v1/admin/llm/enable', { id: id, enabled: !(it && it.enabled) });
    if (!r || !r.ok) { toast(errOf(r), 'err'); return; }
    S.data = r.data && r.data.list ? r.data.list : S.data;
    render();
    toast(it && it.enabled ? '已停用' : '已启用', 'ok');
  }

  async function removeIt(id) {
    var it = (S.data.items || []).filter(function (x) { return x.id === id; })[0];
    if (!window.confirm('删除模型配置「' + ((it && it.name) || id) + '」？\n\n删除后如果它是默认模型，业务会自动切到另一条可用配置；都删完则回退本地模板。')) return;
    var r = await api('/v1/admin/llm/' + encodeURIComponent(id), null, { method: 'DELETE' });
    if (!r || !r.ok) { toast(errOf(r), 'err'); return; }
    S.data = r.data && r.data.list ? r.data.list : S.data;
    render();
    toast('已删除', 'ok');
  }

  /* ---------------- 挂载 ---------------- */
  function mount() {
    if (!ensure()) return;
    load(false);
  }

  function boot() {
    setTimeout(mount, 900);
    /* 切到「风控与设置」时补一次（用户可能刚在别处改了配置） */
    try {
      var _go = window.go;
      if (typeof _go === 'function' && !_go.__llmWrapped) {
        var wrapped = function (v) {
          var r = _go.apply(null, arguments);
          if (v === 'v-settings') setTimeout(mount, 80);
          return r;
        };
        wrapped.__llmWrapped = 1;
        window.go = wrapped;
      }
    } catch (e) {}
    var nav = document.querySelector('.nav-item[data-view="' + HOST + '"]');
    if (nav) nav.addEventListener('click', function () { setTimeout(mount, 120); });
  }

  window.__LLM = { load: load, state: S, mount: mount };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
