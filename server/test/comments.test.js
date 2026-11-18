'use strict';
/* 本地单测：评论任务的排期 / 去重 / 回执（不碰网络、不发真评论） */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Store } = require('../store');
const { createComments } = require('../collect-comments');
const writer = require('../comment-writer');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-test-'));
const store = new Store(path.join(tmp, 'db.json'));

let n = 0;
const hub = {
  enqueue(payload, meta) {
    n++;
    const job = {
      id: 'dj' + n, kind: payload.kind || 'collect', platform: payload.platform,
      status: 'pending', notBefore: payload.notBefore, createdAt: new Date().toISOString(),
      commentId: (meta && meta.commentId) || ''
    };
    /* 模仿真实 DeviceHub：任务进库，否则 nextSlot() 看不到在排队的任务 */
    store.push('collect_jobs', job);
    return job;
  },
  ready() { return true; }
};

(async () => {
  const svc = createComments(store, hub, {});

  /* 1) 本地仿写：3 条、互不重复、长度合规 */
  const d = await writer.draftComments(store, { title: '装修报价怎么谈才不被坑，过来人经验', author: '老李', platform: 'douyin' }, { count: 3 });
  console.log('draft source=', d.source, 'count=', d.items.length);
  d.items.forEach((x, i) => console.log('  #' + (i + 1), x.text));
  if (d.items.length !== 3) throw new Error('draft count wrong');
  const uniq = new Set(d.items.map((x) => x.text));
  if (uniq.size !== 3) throw new Error('draft duplicated');

  /* 2) 单条建任务：拿到排期，落库 pending */
  const r1 = svc.create({
    platform: 'douyin', note_id: '7412', url: 'https://www.douyin.com/video/7412',
    title: '装修报价怎么谈', author: '老李', text: d.items[0].text, mode: 'local'
  });
  console.log('create#1', r1.error || { id: r1.comment.id, status: r1.comment.status, eta: r1.job.notBefore - Date.now() });
  if (r1.error) throw new Error(r1.error.message);

  /* 3) 同一条作品再发：必须被拦（COMMENT_QUEUED） */
  const r1b = svc.create({
    platform: 'douyin', note_id: '7412', url: 'https://www.douyin.com/video/7412',
    title: '装修报价怎么谈', author: '老李', text: '再发一条', mode: 'manual'
  });
  console.log('dup ->', r1b.error && r1b.error.code);
  if (!r1b.error || r1b.error.code !== 'COMMENT_QUEUED') throw new Error('dup not blocked');

  /* 4) 批量：3 条不同作品，排期必须递增（节奏闸门） */
  const b = await svc.batch({
    mode: 'ai',
    items: [
      { platform: 'xhs', note_id: 'a1', url: 'https://www.xiaohongshu.com/explore/a1', title: '减脂餐怎么搭配', author: '小王' },
      { platform: 'xhs', note_id: 'a2', url: 'https://www.xiaohongshu.com/explore/a2', title: '小户型收纳技巧', author: '小张' },
      { platform: 'douyin', note_id: 'b9', url: 'https://www.douyin.com/video/b9', title: '新手健身一周计划', author: '教练' }
    ]
  });
  console.log('batch queued=', b.queued.length, 'skipped=', b.skipped.length);
  b.queued.forEach((q) => console.log('  ', q.noteKey, Math.round((q.notBefore - Date.now()) / 1000) + 's', q.text.slice(0, 24)));
  if (b.queued.length !== 3) throw new Error('batch queued wrong');
  for (let i = 1; i < b.queued.length; i++) {
    if (b.queued[i].notBefore <= b.queued[i - 1].notBefore) throw new Error('pacing not increasing');
  }

  /* 5) 回执：成功 → sent；失败 → failed + 原因 */
  svc.onJobDone({ kind: 'comment', commentId: 'douyin|7412', status: 'done', result: { comment: { posted: true, text: 'x' } } });
  let c = store.data.collect_comments.filter((x) => x.noteKey === 'douyin|7412')[0];
  console.log('after done ->', c.status, c.sentAt ? 'sentAt ok' : '');
  if (c.status !== 'sent') throw new Error('receipt sent failed');

  svc.onJobDone({ kind: 'comment', commentId: 'xhs|a1', status: 'failed', error: 'NO_INPUT', result: { comment: { posted: false, reason: '没找到评论输入框' } } });
  c = store.data.collect_comments.filter((x) => x.noteKey === 'xhs|a1')[0];
  console.log('after fail ->', c.status, c.error);
  if (c.status !== 'failed') throw new Error('receipt failed state wrong');

  /* 6) 列表统计 */
  const l = svc.list({ limit: 10 });
  console.log('list total=', l.total, 'today=', l.today, 'cap=', l.cap, 'pace=', l.pace);

  /* 7) 已评论的作品不能被重发，retry 也不允许 */
  const rt = svc.retry('douyin|7412');
  console.log('retry sent ->', rt.error && rt.error.code);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nALL CHECKS PASSED');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
