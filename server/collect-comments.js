'use strict';
/* =========================================================
   collect-comments.js — 作品评论任务（拟稿 → 排队 → 采集端发布 → 回执）
   ---------------------------------------------------------
   为什么独立成模块：
     评论是「对外动作」，和「采集读页面」不是同一类风险。它需要
     单独的三道闸门，不能散落在路由里：

       ① 节奏闸门  notBefore 时间戳，一条一条铺开（默认 45~90 秒）
       ② 日限额    COMMENT_DAILY_CAP（默认 40 条/天）
       ③ 去重      同一作品只保留一条记录；正文与最近发过的做近似比对

   数据流向：
     页面「评论」→ POST /v1/collect/comments
       → collect_comments（status=pending, notBefore=排期）
       → DeviceHub 队列 → 本机桥 → 扩展打开作品页 → 填框 → 点发送
       → 回执 → collect_comments（status=sent / failed + reason）
   ========================================================= */

const commentWriter = require('./comment-writer');
const ledger = require('./collect/ledger');

const PACE_MIN_MS = Number(process.env.COMMENT_PACE_MIN_MS || 45000);
const PACE_MAX_MS = Number(process.env.COMMENT_PACE_MAX_MS || 90000);
const DAILY_CAP = Number(process.env.COMMENT_DAILY_CAP || 40);
const FIRST_DELAY_MS = Number(process.env.COMMENT_FIRST_DELAY_MS || 8000);

const nowIso = ledger.nowIso;
const noteKeyOf = ledger.noteKeyOf;

function cleanText(s) {
  return String(s || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, commentWriter.MAX_LEN);
}

function createComments(store, deviceHub, opt) {
  const o = opt || {};
  const accounts = o.accounts || null;

  function all() { return store.data.collect_comments || (store.data.collect_comments = []); }
  function save(rec) { store.upsert('collect_comments', rec); }

  /** 下一条可发的时刻：在「已在排队的最后一条」之后加一段随机间隔 */
  function nextSlot() {
    return ledger.nextSlot(store, 'comment', PACE_MIN_MS, PACE_MAX_MS, FIRST_DELAY_MS);
  }

  function todayCount() {
    return ledger.todayCount(all());
  }

  function find(noteKey) {
    return ledger.findByKey(all(), noteKey);
  }

  function list(q) {
    const query = q || {};
    const limit = Math.max(1, Math.min(500, Number(query.limit) || 200));
    let arr = all().slice().sort(function (a, b) {
      return (Date.parse(b.sentAt || b.createdAt || 0) || 0) - (Date.parse(a.sentAt || a.createdAt || 0) || 0);
    });
    if (query.platform) arr = arr.filter(function (c) { return c.platform === query.platform; });
    if (query.campaignId) arr = arr.filter(function (c) { return c.campaignId === query.campaignId; });
    if (query.status) arr = arr.filter(function (c) { return c.status === query.status; });
    /* 执行过程：把 job 的 steps 并到记录上（前端卡片里画步骤条）。
       只在需要时（trace=1 或记录还没结束）附加，避免无谓的 200 条 join。 */
    const jobs = (store.data.collect_jobs || []);
    const out = arr.slice(0, limit).map(function (c) {
      const j = c && c.jobId ? jobs.filter(function (x) { return x && x.id === c.jobId; })[0] : null;
      const o = Object.assign({}, c);
      o.jobStatus = j ? j.status : (c.status === 'sent' ? 'done' : (c.status === 'failed' ? 'failed' : ''));
      o.steps = (j && Array.isArray(j.steps)) ? j.steps : (c.steps || []);
      return o;
    });
    return {
      items: out,
      total: all().length,
      today: todayCount(),
      cap: DAILY_CAP,
      pace: [PACE_MIN_MS, PACE_MAX_MS]
    };
  }

  async function draft(body) {
    const b = body || {};
    const note = {
      title: String(b.title || '').slice(0, 120),
      author: String(b.author || '').slice(0, 60),
      platform: String(b.platform || '').slice(0, 16),
      keyword: String(b.keyword || '').slice(0, 40),
      noteKey: noteKeyOf(b)
    };
    const r = await commentWriter.draftComments(store, note, {
      count: Number(b.count) || 3,
      samples: Array.isArray(b.samples) ? b.samples.slice(0, 6).map(String) : [],
      forceLocal: !!b.forceLocal
    });
    return Object.assign({ noteKey: note.noteKey }, r);
  }

  /** 建一条评论任务；返回 { comment, job } 或 { error } */
  function create(body) {
    const b = body || {};
    const noteKey = noteKeyOf(b);
    const platform = String(b.platform || '').toLowerCase().slice(0, 16);
    const url = String(b.url || '').slice(0, 400);
    const text = cleanText(b.text);

    if (!url || !/^https?:\/\//i.test(url)) {
      return { error: { code: 'URL_REQUIRED', message: '缺少作品链接：请先跑一轮采集拿到作品地址' } };
    }
    if (text.length < 2) {
      return { error: { code: 'TEXT_REQUIRED', message: '评论内容太短，至少写 2 个字' } };
    }
    if (todayCount() >= DAILY_CAP) {
      return { error: { code: 'DAILY_CAP', message: '今日评论已达上限 ' + DAILY_CAP + ' 条（可在 .env.local 调 COMMENT_DAILY_CAP）' } };
    }
    /* 账号级限额：只有配了 commentQuotaPerHour > 0 才生效；0 = 只受全局日限 */
    const accountId = String(b.accountId || '').slice(0, 40);
    if (accountId && accounts) {
      const acc = accounts.get(accountId);
      if (!acc) return { error: { code: 'ACCOUNT_NOT_FOUND', message: '绑定的账号不存在' } };
      if (acc.status !== 'active') {
        return { error: { code: 'ACCOUNT_INACTIVE', message: '账号「' + acc.nickname + '」已停用/过期' } };
      }
      const quota = Number(acc.commentQuotaPerHour) || 0;
      if (quota > 0) {
        const from = Date.now() - 3600000;
        const used = all().filter((c) => c.accountId === accountId
          && (c.status === 'sent' || c.status === 'pending')
          && Date.parse(c.sentAt || c.createdAt || 0) >= from).length;
        if (used >= quota) {
          return { error: { code: 'ACCOUNT_QUOTA', message: '账号「' + acc.nickname + '」近 1 小时评论已达 ' + quota + ' 条' } };
        }
      }
    }

    const exist = find(noteKey);
    if (exist && (exist.status === 'pending' || exist.status === 'sent')) {
      return {
        error: {
          code: exist.status === 'sent' ? 'ALREADY_COMMENTED' : 'COMMENT_QUEUED',
          message: exist.status === 'sent' ? '这条作品已经评论过了' : '这条作品已在发布队列里',
          comment: exist
        }
      };
    }

    const now = nowIso();
    const rec = {
      id: (exist && exist.id) || store.nextId('cm'),
      noteKey: noteKey,
      platform: platform,
      url: url,
      title: String(b.title || '').slice(0, 120),
      author: String(b.author || '').slice(0, 60),
      text: text,
      mode: String(b.mode || 'manual').slice(0, 10),
      campaignId: String(b.campaignId || '').slice(0, 40),
      accountId: String(b.accountId || '').slice(0, 40),
      withLike: !!b.withLike,
      dryRun: !!b.dryRun,
      status: 'pending',
      createdAt: now,
      sentAt: '',
      error: '',
      jobId: ''
    };

    const slot = nextSlot();
    const job = deviceHub.enqueue({
      kind: 'comment',
      platform: platform,
      url: url,
      text: text,
      campaignId: rec.campaignId || '',
      accountId: rec.accountId || '',
      title: rec.title,
      author: rec.author,
      withLike: rec.withLike,
      dryRun: !!rec.dryRun,
      notBefore: slot
    }, { commentId: noteKey });
    rec.jobId = job.id;
    rec.notBefore = slot;
    save(rec);
    return { comment: rec, job: { id: job.id, notBefore: slot } };
  }

  /** 批量：每条按自己的标题自动拟稿（AI 或本地），再依次排队 */
  async function batch(body) {
    const b = body || {};
    const items = Array.isArray(b.items) ? b.items.slice(0, 30) : [];
    const mode = String(b.mode || 'ai') === 'manual' ? 'manual' : 'ai';
    const fixed = cleanText(b.text);
    const queued = [];
    const skipped = [];

    if (!items.length) return { queued, skipped, error: { code: 'NO_ITEMS', message: '没有可评论的作品' } };

    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      let text = fixed;
      if (mode !== 'manual' || !text) {
        const d = await commentWriter.draftComments(store, {
          title: it.title, author: it.author, platform: it.platform,
          keyword: it.keyword, noteKey: noteKeyOf(it)
        }, { count: 1 });
        text = (d.items && d.items[0] && d.items[0].text) || '';
      }
      const r = create({
        noteKey: it.noteKey, note_id: it.note_id, platform: it.platform, url: it.url,
        title: it.title, author: it.author, text: text, mode: mode === 'manual' ? 'manual' : 'ai',
        campaignId: it.campaignId || b.campaignId || '',
        accountId: it.accountId || b.accountId || ''
      });
      if (r.error) skipped.push({ noteKey: noteKeyOf(it), title: it.title || '', code: r.error.code, message: r.error.message });
      else queued.push({ noteKey: r.comment.noteKey, id: r.comment.id, text: r.comment.text, notBefore: r.job.notBefore });
    }
    return { queued, skipped, today: todayCount(), cap: DAILY_CAP };
  }

  function retry(noteKey) {
    const c = find(String(noteKey || ''));
    if (!c) return { error: { code: 'NOT_FOUND', message: '没有这条评论记录' } };
    if (c.status === 'sent') return { error: { code: 'ALREADY_COMMENTED', message: '已经发过了' } };
    return create({
      noteKey: c.noteKey, platform: c.platform, url: c.url,
      title: c.title, author: c.author, text: c.text, mode: c.mode, withLike: c.withLike,
      campaignId: c.campaignId || '', accountId: c.accountId || ''
    });
  }

  /** 采集端回执 → 回写状态（由 DeviceHub.onResult 调用） */
  function onJobDone(job) {
    if (!job || job.kind !== 'comment') return;
    const key = String(job.commentId || '');
    const c = key ? find(key) : null;
    if (!c) return;
    const cmt = (job.result && job.result.comment) || null;
    const posted = !!(cmt && cmt.posted) && job.status === 'done';
    c.status = posted ? 'sent' : 'failed';
    c.sentAt = posted ? nowIso() : '';
    c.at = nowIso();
    c.error = posted ? '' : ((cmt && (cmt.reason || cmt.debug)) || job.error || '发布未确认');
    c.steps = (job.steps || []).slice(-20);
    c.liked = !!(job.result && job.result.like && (job.result.like.liked || job.result.like.already));
    save(c);
  }

  /** 清空还没发出去的评论排队（旧战役积压用）；已发/失败记录保留 */
  function clearPending(campaignId) {
    const cid = String(campaignId || '');
    let n = 0;
    all().forEach(function (c) {
      if (!c || c.status !== 'pending') return;
      if (cid && String(c.campaignId || '') !== cid) return;
      c.status = 'canceled';
      c.error = '手动清空排队';
      c.at = nowIso();
      save(c);
      n++;
    });
    return n;
  }

  return { list, draft, create, batch, retry, onJobDone, noteKeyOf, todayCount, cap: DAILY_CAP, clearPending };
}

module.exports = { createComments, noteKeyOf, DAILY_CAP, PACE_MIN_MS, PACE_MAX_MS };
