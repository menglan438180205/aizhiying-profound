'use strict';
/* =========================================================
   collect-adapters/normalize.js — 上游返回结构归一化
   ---------------------------------------------------------
   各家上游（官方网关 / 自建爬虫 / 第三方供应商）返回的壳层与
   字段名都不一样。这一层做多别名兜底，让上游「差不多对」就能接：
     · 壳层：data.comments / data.list / data.items / comments /
             list / items / data[] / 顶层数组
     · 昵称：nickname | nick_name | user | author | username
     · 正文：comment | content | text | body
     · 作品：video_title | title | video | note_title
     · 点赞：likes | like_count | digg_count | liked_count
     · 时间：at | time | create_time | created_at | date
     · 地域：region | ip_region | city
   空评论一律丢弃（filter），避免把「加载更多」之类的占位当线索。

   ⚠️ 为什么要有 normalizeDetailed：
   归一化最危险的失败不是抛异常，而是**静默返回空数组**。
   上游改版（字段换名、壳层改名）时，服务收到 200 + 一个
   「结构不认识」的 JSON，旧实现直接 return []，链路全程没有错误，
   任务却记 status='ok'、note 写「本轮无新增」——
   销售看到的「采集成功」，线索池却是空的。这是本系统最致命的故障类型：
   **它不报错，只给错答案。**

   所以这里把「合法空结果」和「结构不认识」区分开：
     - normalize()          —— 兼容旧调用方，仍返回数组
     - normalizeDetailed()  —— 返回 { items, status, reason, dropped }
                              status: 'ok' | 'empty' | 'shape_changed' | 'invalid_body'
   上层（http-provider.js）据此把 shape_changed 转成显式 502，
   让任务记 failed 而不是 ok。
   ========================================================= */

/* 壳层探测表：命中即认为结构可识别 */
const SHELL_PROBES = [
  ['data.comments', (j) => j.data && j.data.comments],
  ['data.list', (j) => j.data && j.data.list],
  ['data.items', (j) => j.data && j.data.items],
  ['comments', (j) => j.comments],
  ['list', (j) => j.list],
  ['items', (j) => j.items],
  ['data[]', (j) => (Array.isArray(j.data) ? j.data : null)],
  ['[]', (j) => (Array.isArray(j) ? j : null)]
];

/* 字段别名：全部缺失时说明上游字段也漂移了 */
const FIELD_ALIASES = {
  nickname: ['nickname', 'nick_name', 'user', 'author', 'username'],
  comment: ['comment', 'content', 'text', 'body'],
  video_title: ['video_title', 'title', 'video', 'note_title'],
  likes: ['likes', 'like_count', 'digg_count', 'liked_count'],
  at: ['at', 'time', 'create_time', 'created_at', 'date'],
  region: ['region', 'ip_region', 'city'],
  /* 来源回链：缺了这三个字段，线索只是一句没有出处的话，
     销售点不回原视频，也就接不上语境私信 */
  cid: ['cid', 'comment_id', 'commentId'],
  video_url: ['video_url', 'note_url', 'share_url', 'aweme_url'],
  author: ['author', 'note_author', 'blogger', 'creator'],
  keyword: ['keyword', 'source_keyword']
};

function pick(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * 详细归一化：区分「合法空」与「结构不认识」。
 * @returns {{items:Array, status:'ok'|'empty'|'shape_changed'|'invalid_body',
 *            reason:string, dropped:number, shell:string, missingFields:string[]}}
 */
function normalizeDetailed(json, payload) {
  const platform = (payload && payload.platform) || 'douyin';

  /* 上游返回空体 / 非 JSON —— 这是「读不到」，不是「没有」 */
  if (json === null || json === undefined) {
    return {
      items: [], status: 'invalid_body', dropped: 0, shell: '',
      reason: '上游返回空体或非 JSON（可能是网关错误页或超时被截断），无法判定是「无评论」还是「读失败」',
      missingFields: []
    };
  }

  /* 顶层不是对象也不是数组 —— 结构不认识 */
  if (typeof json !== 'object') {
    return {
      items: [], status: 'shape_changed', dropped: 0, shell: '',
      reason: '上游返回的顶层类型是 ' + typeof json + '，不是预期的对象或数组',
      missingFields: []
    };
  }

  let arr = null;
  let shell = '';
  for (let i = 0; i < SHELL_PROBES.length; i++) {
    const candidate = SHELL_PROBES[i][1](json);
    if (Array.isArray(candidate)) { arr = candidate; shell = SHELL_PROBES[i][0]; break; }
  }

  /* 关键分支：拿到对象但认不出任何壳层 —— 上游改版了。
     这里**不能**静默返回空数组，必须标记 shape_changed。 */
  if (!arr) {
    const keys = Object.keys(json).slice(0, 8);
    return {
      items: [], status: 'shape_changed', dropped: 0, shell: '',
      reason: '上游返回了对象但认不出任何已知壳层（已知壳层：' + SHELL_PROBES.map((p) => p[0]).join('/')
        + '），实际顶层字段：[' + keys.join(', ') + ']。这通常是上游改版导致的结构漂移，'
        + '不能当作「本轮无评论」处理',
      missingFields: []
    };
  }

  /* 壳层命中，但数组是空的 —— 这是合法的「真的没有」 */
  if (!arr.length) {
    return {
      items: [], status: 'empty', dropped: 0, shell,
      reason: '上游返回了合法的空列表（壳层 ' + shell + '），本轮确实没有新评论',
      missingFields: []
    };
  }

  /* 逐条归一化 */
  const items = [];
  const missingFields = new Set();
  let dropped = 0;
  let atFallback = 0;

  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (!c || typeof c !== 'object') { dropped++; continue; }

    const rawNick = pick(c, FIELD_ALIASES.nickname);
    const rawComment = pick(c, FIELD_ALIASES.comment);
    const rawAt = pick(c, FIELD_ALIASES.at);
    const rawVideo = pick(c, FIELD_ALIASES.video_title);

    /* 正文是线索本体：缺了就是无效条目，丢弃并计数 */
    if (!rawComment) { dropped++; missingFields.add('comment'); continue; }
    if (rawNick === undefined) missingFields.add('nickname');
    if (rawAt === undefined) { missingFields.add('at'); atFallback++; }
    if (rawVideo === undefined) missingFields.add('video_title');

    items.push({
      nickname: rawNick === undefined ? '匿名用户' : rawNick,
      comment: rawComment,
      video_title: rawVideo === undefined ? '' : rawVideo,
      likes: Number(pick(c, FIELD_ALIASES.likes) || 0),
      /* 时间缺失时不再伪造「当前时间」——
         伪造时间会让旧线索看起来刚发布，直接影响销售判断新鲜度。
         留空由上层标记为未知。 */
      at: rawAt === undefined ? '' : rawAt,
      platform: c.platform || platform,
      region: c.region || c.ip_region || c.city || (payload && payload.region) || '',
      cid: pick(c, FIELD_ALIASES.cid) === undefined ? '' : String(pick(c, FIELD_ALIASES.cid)),
      video_url: pick(c, FIELD_ALIASES.video_url) || '',
      author: pick(c, FIELD_ALIASES.author) || '',
      keyword: pick(c, FIELD_ALIASES.keyword) || ''
    });
  }

  /* 全被丢掉 = 结构漂移的另一种表现：壳层在、字段名全变了 */
  if (!items.length) {
    return {
      items: [], status: 'shape_changed', dropped, shell,
      reason: '上游壳层 ' + shell + ' 可识别，但 ' + arr.length
        + ' 条记录的正文字段全部缺失（可能是 comment/content/text/body 已改名），无法提取线索',
      missingFields: Array.from(missingFields)
    };
  }

  return {
    items,
    status: 'ok',
    dropped,
    shell,
    missingFields: Array.from(missingFields),
    reason: atFallback
      ? ('已归一化 ' + items.length + ' 条，其中 ' + atFallback + ' 条缺少时间字段（时间留空，不伪造）')
      : ('已归一化 ' + items.length + ' 条' + (dropped ? '，丢弃无效 ' + dropped + ' 条' : ''))
  };
}

/** 兼容旧调用方：只取数组。行为与旧版一致，但走 detailed 路径。 */
function normalize(json, payload) {
  return normalizeDetailed(json, payload).items;
}

module.exports = { normalize, normalizeDetailed };
