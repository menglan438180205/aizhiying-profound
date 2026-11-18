'use strict';
/* =========================================================
   render-worker.js — 渲染子进程（K3）
   ---------------------------------------------------------
   为什么单独一个进程：
   HTTP 接口、采集调度、GEO 调度与 FFmpeg 渲染原本挤在同一个
   Node 进程里。渲染期间字幕生成、进度解析、素材哈希都在主事件
   循环上，API 的 p95 会被拖高（演示很顺、现场一卡就崩）。

   这个 worker 只做一件事：收任务、跑 renderJob、回传进度。
   所有持久化仍由主进程负责，worker 不碰 store，避免两个进程
   同时写库。

   通信协议（IPC）：
     主 → 子  { type:'render', id, payload:{ job, dir, outDir, bgmDir } }
              { type:'cancel', id }
     子 → 主  { type:'log'|'output'|'progress'|'stage'|'media', id, ... }
              { type:'done', id, outputs }
              { type:'error', id, code, message }
   ========================================================= */

const { renderJob } = require('./renderer');

const running = new Map();   /* id -> AbortController */

function send(msg) {
  try { process.send(msg); } catch (e) { /* 主进程已断开，静默退出 */ }
}

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'cancel') {
    const ac = running.get(msg.id);
    if (ac) ac.abort();
    return;
  }

  if (msg.type !== 'render') return;

  const id = msg.id;
  const payload = msg.payload || {};
  const ac = new AbortController();
  running.set(id, ac);

  try {
    const outputs = await renderJob(payload.job || {}, {
      dir: payload.dir,
      outDir: payload.outDir,
      bgmDir: payload.bgmDir,
      signal: ac.signal,
      log: (lv, m) => send({ type: 'log', id: id, level: lv, msg: m }),
      onOutput: (o) => send({ type: 'output', id: id, output: o }),
      onProgress: (done, total, stage) => send({ type: 'progress', id: id, done: done, total: total, stage: stage }),
      onStage: (st) => send({ type: 'stage', id: id, stage: st }),
      onMedia: (m) => send({ type: 'media', id: id, media: m })
    });
    send({ type: 'done', id: id, outputs: outputs });
  } catch (e) {
    send({
      type: 'error', id: id,
      code: (e && e.code) || '',
      message: (e && e.message) || String(e)
    });
  } finally {
    running.delete(id);
  }
});

/* 主进程退出时自动收摊 */
process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
