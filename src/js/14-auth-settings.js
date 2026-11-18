/* 后台邀请码设置
 * 只有 owner/admin 能读写；保存到 DATA_DIR/auth-settings.json，立即生效。
 * 单独放一个文件，避免把 01-app.js 的登录流程继续撑大。 */
(function () {
  'use strict';

  var card = document.getElementById('authCodeCard');
  if (!card) return;

  var toggle = document.getElementById('acToggle');
  var codeRow = document.getElementById('acCodeRow');
  var codeInput = document.getElementById('acCode');
  var modeTag = document.getElementById('acModeTag');
  var saveBtn = document.getElementById('acSave');
  var genBtn = document.getElementById('acGen');
  var copyBtn = document.getElementById('acCopy');
  var copyLinkBtn = document.getElementById('acCopyLink');
  var msgEl = document.getElementById('acMsg');
  var metaEl = document.getElementById('acMeta');

  var loaded = false;
  var loading = false;
  var locked = false;
  var enabled = false;
  var code = '';
  var envFallback = false;

  function setMsg(text, type) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.style.color = type === 'ok' ? 'var(--green)' : (type === 'err' ? 'var(--red)' : 'var(--text-3)');
  }

  function toastMsg(text, type) {
    try { if (window.toast) toast(text, type || 'ok', '邀请码设置'); } catch (e) {}
  }

  function render() {
    if (toggle) {
      toggle.classList.toggle('on', !!enabled);
      toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
    }
    if (codeRow) codeRow.style.display = enabled ? '' : 'none';
    if (modeTag) {
      modeTag.textContent = locked ? '仅所有者可改' : (enabled ? '邀请码注册' : '已关闭');
      modeTag.className = 'tag' + (enabled && !locked ? ' green' : '');
    }
    if (codeInput && document.activeElement !== codeInput) codeInput.value = code;
  }

  function renderMeta(s) {
    if (!metaEl) return;
    var parts = [];
    if (envFallback && (!s || s.source === 'env')) {
      parts.push('当前沿用服务器环境变量 REGISTER_CODE；保存后以后台设置为准');
    } else if (s && s.source === 'file') {
      parts.push('已保存到服务器，重启后仍然有效');
    }
    if (s && s.updatedBy) parts.push('最后修改：' + s.updatedBy);
    if (s && s.updatedAt) {
      try {
        parts.push(new Date(s.updatedAt).toLocaleString('zh-CN', { hour12: false }));
      } catch (e) { parts.push(s.updatedAt); }
    }
    metaEl.textContent = parts.join(' · ');
  }

  function apply(s) {
    s = s || {};
    enabled = s.register === 'code';
    code = String(s.code || '');
    render();
    renderMeta(s);
  }

  function lock(message) {
    locked = true;
    if (toggle) { toggle.style.opacity = '.45'; toggle.style.pointerEvents = 'none'; }
    [saveBtn, genBtn, copyBtn, copyLinkBtn, codeInput].forEach(function (el) {
      if (el) el.disabled = true;
    });
    if (modeTag) { modeTag.textContent = '仅所有者可改'; modeTag.className = 'tag'; }
    setMsg(message || '只有所有者可以修改邀请码', 'err');
  }

  async function load(force) {
    if (loading) return;
    if (loaded && !force) return;
    loading = true;
    setMsg('读取中…', '');
    try {
      var r = await Api.call('/v1/auth/settings', null, { method: 'GET', timeout: 8000 });
      if (!r || !r.ok) {
        if (r && r.status === 403) { lock(r.error || '只有所有者可以修改邀请码'); return; }
        if (r && r.status === 401) { setMsg('请先登录后再设置邀请码', 'err'); return; }
        setMsg((r && r.error) || '读取失败，请稍后重试', 'err');
        return;
      }
      envFallback = !!(r.data && r.data.envFallback);
      loaded = true;
      apply(r.data && r.data.settings);
      setMsg('', '');
    } catch (e) {
      setMsg('读取失败：' + String((e && e.message) || e), 'err');
    } finally {
      loading = false;
    }
  }

  function randomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    function group(n) {
      var out = '';
      if (window.crypto && crypto.getRandomValues) {
        var a = new Uint8Array(n);
        crypto.getRandomValues(a);
        for (var i = 0; i < n; i++) out += chars[a[i] % chars.length];
      } else {
        for (var j = 0; j < n; j++) out += chars[Math.floor(Math.random() * chars.length)];
      }
      return out;
    }
    return 'AIZY-' + group(4) + '-' + group(4) + '-' + group(4);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('复制失败'));
      } catch (e) { reject(e); }
    });
  }

  if (toggle) {
    toggle.addEventListener('click', function (e) {
      /* 阻止 01-app 的全局 .switch 再翻转一次 */
      e.preventDefault();
      e.stopPropagation();
      if (locked) return;
      enabled = !enabled;
      render();
    }, true);
    toggle.addEventListener('keydown', function (e) {
      if (locked) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        enabled = !enabled;
        render();
      }
    });
  }

  if (codeInput) {
    codeInput.addEventListener('input', function () { code = codeInput.value; });
  }

  if (genBtn) genBtn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (locked) return;
    code = randomCode();
    enabled = true;
    if (codeInput) codeInput.value = code;
    render();
    setMsg('已生成新邀请码，点「保存设置」后生效', 'ok');
  });

  if (copyBtn) copyBtn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    var text = (codeInput && codeInput.value.trim()) || code;
    if (!text) { setMsg('请先生成或填写邀请码', 'err'); return; }
    copyText(text).then(function () {
      setMsg('邀请码已复制', 'ok');
      toastMsg('邀请码已复制', 'ok');
    }).catch(function () { setMsg('复制失败，请手动选中复制', 'err'); });
  });

  if (copyLinkBtn) copyLinkBtn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    var url = location.origin + '/app/';
    copyText(url).then(function () {
      setMsg('注册链接已复制：' + url, 'ok');
      toastMsg('注册链接已复制', 'ok');
    }).catch(function () { setMsg('复制失败，请手动复制：' + url, 'err'); });
  });

  if (saveBtn) saveBtn.addEventListener('click', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (locked) return;
    var val = (codeInput && codeInput.value.trim()) || code;
    if (enabled && !val) { setMsg('开启自助注册时必须填写邀请码', 'err'); return; }
    if (enabled && !/^[A-Za-z0-9_-]{6,64}$/.test(val)) {
      setMsg('邀请码需为 6–64 位字母、数字、下划线或短横线', 'err');
      return;
    }
    if (codeInput) codeInput.value = val;
    code = val;
    saveBtn.disabled = true;
    var old = saveBtn.textContent;
    saveBtn.textContent = '保存中…';
    setMsg('', '');
    try {
      var r = await Api.call('/v1/auth/settings', {
        register: enabled ? 'code' : 'closed',
        code: val
      }, { method: 'PUT', timeout: 10000 });
      if (!r || !r.ok) {
        if (r && r.status === 403) { lock(r.error || '只有所有者可以修改邀请码'); return; }
        setMsg((r && r.error) || '保存失败，请稍后重试', 'err');
        return;
      }
      envFallback = false;
      loaded = true;
      apply(r.data && r.data.settings);
      setMsg('已保存，注册入口立即生效', 'ok');
      toastMsg('邀请码设置已保存', 'ok');
    } catch (err) {
      setMsg('保存失败：' + String((err && err.message) || err), 'err');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = old;
    }
  });

  /* 打开“风控与设置”时再拉取：页面刚加载时可能还没登录 */
  function bindOpen(el) {
    if (!el) return;
    el.addEventListener('click', function () { setTimeout(function () { load(false); }, 0); });
  }
  var nav = document.querySelector('[data-view="v-settings"]');
  bindOpen(nav);
  Array.prototype.forEach.call(document.querySelectorAll('[data-go="v-settings"]'), bindOpen);
  window.addEventListener('hashchange', function () {
    if (String(location.hash || '').indexOf('v-settings') > -1) load(false);
  });

  render();
})();
