'use strict';
/* =========================================================
   collect-likes.js — 作品点赞任务（比评论轻，但仍要像人）
   ---------------------------------------------------------
   点赞和评论是同一类「对外写」，只是代价小：平台对点赞的风控比
   评论松，但短时间连点几十个同样会触发限流。所以：

     ① 节奏 12~30 秒一条（COMMENT 是 45~90 秒）
     ② 日限 200（COMMENT 是 40）
     ③ 同一作品只记一条：已点过就不再重复点（重复点会变成「取消赞」）

   数据流向：
     页面「点赞」→ POST /v1/collect/likes
       → collect_likes(status=pending, notBefore=排期)
       → DeviceHub(kind='like') → 本机桥 → 扩展打开作品页 → 点按钮 → 校验
       → 回执 → collect_likes(status=sent / failed + reason)
   ========================================================= */

const ledger = require('./collect/ledger');

const PACE_MIN_MS = Number(process.env.LIKE_PACE_MIN_MS || 12000);
const PACE_MAX_MS = Number(process.env.LIKE_PACE_MAX_MS || 30000);
const DAILY_CAP = Number(process.env.LIKE_DAILY_CAP || 200);
const FIRST_DELAY_MS = Number(process.env.LIKE_FIRST_DELAY_MS || 4000);

/* 时间/去重键/日计数/排期与评论共用 collect/ledger.js（R4 合并重复） */
const nowIso = ledger.nowIso;
const noteKeyOf = ledger.noteKeyOf;

function createLikes(store, deviceHub) {
  function all() { return store.data.collect_likes || (store.data.collect_likes = []); }
  function save(rec) { store.upsert('collect_likes', rec); }

  function nextSlot() {
    return ledger.nextSlot(store, 'like', PACE_MIN_MS, PACE_MAX_MS, FIRST_DELAY_MS);
  }

  function todayCount() {
    return ledger.todayCount(all());
  }

  function find(noteKey) {
    return ledger.findByKey(all(), noteKey);
  }

  function list(q) {
    const query = q || {};
    const limit = Math.max(1, Math.min(500, Number(query.limit) || 300));
    let arr = all().slice().sort(function (a, b) {
      return (Date.parse(b.sentAt || b.createdAt || 0) || 0) - (Date.parse(a.sentAt || a.createdAt || 0) || 0);
    });
    if (query.platform) arr = arr.filter(function (c) { return c.platform === query.platform; });
    return { items: arr.slice(0, limit), total: all().length, today: todayCount(), cap: DAILY_CAP, pace: [PACE_MIN_MS, PACE_MAX_MS] };
  }

  function create(body) {
    const b = body || {};
    const noteKey = noteKeyOf(b);
    const platform = String(b.platform || '').toLowerCase().slice(0, 16);
    const url = String(b.url || '').slice(0, 400);
    if (!url || !/^https?:\/\//i.test(url)) {
      return { error: { code: 'URL_REQUIRED', message: '缺少作品链接：点赞要打开作品页，先跑一轮采集拿到地址' } };
    }
    if (todayCount() >= DAILY_CAP) {
      return { error: { code: 'DAILY_CAP', message: '今日点赞已达上限 ' + DAILY_CAP + ' 条' } };
    }
    const exist = find(noteKey);
    if (exist && (exist.status === 'pending' || exist.status === 'sent')) {
      return {
        error: {
          code: exist.status === 'sent' ? 'ALREADY_LIKED' : 'LIKE_QUEUED',
          message: exist.status === 'sent' ? '这条作品已经点过赞了' : '这条作品已在点赞队列里',
          like: exist
        }
      };
    }
    const now = nowIso();
    const rec = {
      id: (exist && exist.id) || store.nextId('lk'),
      noteKey: noteKey,
      platform: platform,
      url: url,
      title: String(b.title || '').slice(0, 120),
      author: String(b.author || '').slice(0, 60),
      status: 'pending',
      createdAt: now,
      sentAt: '',
      error: '',
      jobId: ''
    };
    const slot = nextSlot();
    const job = deviceHub.enqueue({
      kind: 'like',
      platform: platform,
      url: url,
      title: rec.title,
      author: rec.author,
      notBefore: slot
    }, { likeId: noteKey });
    rec.jobId = job.id;
    rec.notBefore = slot;
    save(rec);
    return { like: rec, job: { id: job.id, notBefore: slot } };
  }

  function retry(noteKey) {
    const c = find(String(noteKey || ''));
    if (!c) return { error: { code: 'NOT_FOUND', message: '没有这条点赞记录' } };
    if (c.status === 'sent') return { error: { code: 'ALREADY_LIKED', message: '已经点过赞了' } };
    return create({ noteKey: c.noteKey, platform: c.platform, url: c.url, title: c.title, author: c.author });
  }

  function onJobDone(job) {
    if (!job || job.kind !== 'like') return;
    const key = String(job.likeId || job.commentId || '');
    const c = key ? find(key) : null;
    if (!c) return;
    const r = (job.result && job.result.like) || null;
    const done = !!(r && r.liked) && job.status === 'done';
    const already = !!(r && r.already);
    c.status = (done || already) ? 'sent' : 'failed';
    c.sentAt = (done || already) ? nowIso() : '';
    c.at = nowIso();
    c.already = already;
    c.error = (done || already) ? '' : ((r && (r.reason || r.debug)) || job.error || '点赞未确认');
    save(c);
  }

  /** 清空还没执行的点赞排队；已点/失败记录保留 */
  function clearPending(campaignId) {
    const cid = String(campaignId || '');
    let n = 0;
    all().forEach(function (c) {
      if (!c || c.status !== 'pending') return;
      if (cid && String(c.campaignId || '') !== cid) return;
      c.status = 'canceled';
      c.error = '手动清空排队';
      c.at = new Date().toISOString();
      save(c);
      n++;
    });
    return n;
  }

  return { list, create, retry, onJobDone, noteKeyOf, todayCount, cap: DAILY_CAP, clearPending };
}

module.exports = { createLikes, noteKeyOf, DAILY_CAP, PACE_MIN_MS, PACE_MAX_MS };
