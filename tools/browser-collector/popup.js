'use strict';

const $ = (id) => document.getElementById(id);
const BRIDGE = 'http://127.0.0.1:8801';

async function bridgeStatus() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch(BRIDGE + '/v1/bridge/status', { signal: ctl.signal });
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function paintBridge(st) {
  const dot = $('dot');
  const b = $('bridge');
  const tip = $('tip');
  if (!st) {
    dot.className = 'dot';
    b.textContent = '未启动';
    tip.className = 'tip';
    tip.innerHTML = '连不上本机桥。双击项目里的 <b>tools/mediacrawler-bridge/start-local.cmd</b>，窗口别关，然后回来点「立即检查任务」。';
    return;
  }
  dot.className = 'dot on';
  b.textContent = '在线 · ' + (st.host || '');
  if (st.paired) {
    $('paired').textContent = st.device && st.device.name ? st.device.name : '已配对';
    tip.className = 'tip ok';
    tip.innerHTML = '采集器已就绪。保持这个 Chrome 开着即可；<b>任务来了会自动在后台标签页读取页面</b>，读完自动关掉。';
  } else {
    $('paired').textContent = '未配对';
    tip.className = 'tip';
    tip.innerHTML = '桥在线但还没和系统配对：回到系统页面「评论区获客」左栏，点 <b>连接本机采集器</b>，输入页面显示的 6 位码即可。';
  }
}

async function paintWorker() {
  try {
    const s = await chrome.runtime.sendMessage({ type: 'status' });
    if (!s) return;
    $('ver').textContent = 'v' + s.version;
    $('done').textContent = s.stat.done;
    $('failed').textContent = s.stat.failed;
    $('got').textContent = (s.stat.lastNotes || 0) + (s.stat.lastComments || 0);
    $('job').textContent = s.stat.lastJob ? (s.busy ? '执行中…' : '已完成 ' + s.stat.lastJob.slice(-6)) : '—';
    if (!s.online) {
      $('dot').className = 'dot';
      $('bridge').textContent = '未启动';
    }
  } catch (e) { /* popup 刚开时 worker 可能还没醒 */ }
}

async function refresh() {
  const st = await bridgeStatus();
  paintBridge(st);
  await paintWorker();
  if (st && st.plugin && !st.plugin.online) {
    $('dot').className = 'dot';
    $('bridge').textContent = '桥在线 · 扩展未连';
  }
}

$('wake').addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ type: 'wake' }); } catch (e) {}
  setTimeout(refresh, 1200);
});

refresh();
setInterval(refresh, 3000);
