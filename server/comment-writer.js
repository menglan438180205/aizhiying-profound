'use strict';
/* =========================================================
   comment-writer.js — 评论正文生成
   ---------------------------------------------------------
   三种来源，优先级从高到低：
     1. manual  用户手写（原样使用）
     2. llm     store 里配了 llm_cfg 时走 OpenAI 兼容 chat/completions
     3. local   没配模型 / 调用失败时的本地仿写兜底（模板 + 标题主题词）

   为什么必须有本地兜底：
     采集链路已经能跑通，但大模型是可选配置。没有模型的机器上
     「AI 仿写」不能直接变成死按钮 —— 那就退化成模板仿写，
     照样给出可发布的人话，只是多样性差一点。

   安全/合规约束（写死在 prompt 与模板里）：
     · 不出现联系方式、微信号、链接、二维码引导 —— 平台会静默限流
     · 不做夸张营销词（"最便宜/包成功"），评论是给人看的，不是广告位
     · 长度上限 120 字（抖音/小红书的评论框都在这个量级）
   ========================================================= */

const { llmChat, llmEnabled } = require('./geo-engine');

const MAX_LEN = 120;

const PLATFORM_LABEL = { douyin: '抖音', xhs: '小红书', xiaohongshu: '小红书', kuaishou: '快手', sph: '视频号' };

/* 主题词：只敢用「用户自己输入过的关键词」。
   从标题里硬切中文片段很难不出残句（"装修报价怎么" / "小户型收"），
   而这些作品的 keyword 本来就是搜索词，语义干净、读起来自然。
   没有关键词就退回「不提主题」的通用句，宁可不具体，也不要读着别扭。 */
function kwOf(note) {
  const raw = String((note && note.keyword) || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').trim();
  if (!raw || raw.length < 2) return '';
  if (/(怎么|什么|如何|为什么|多少|可以|一个)$/.test(raw)) return '';
  return raw.slice(0, 8);
}

function pick(arr, seed) {
  if (!arr.length) return '';
  return arr[Math.abs(seed) % arr.length];
}

/* 去重比较用：只比「字」，标点/空格/表情全忽略 */
function normText(s) {
  return String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
}

function looksDup(text, recent) {
  const n = normText(text);
  if (!n) return true;
  for (let i = 0; i < recent.length; i++) {
    const r = normText(recent[i]);
    if (!r) continue;
    if (r === n) return true;
    /* 包含关系也算重复：批量发同样的话最容易被识别成机器 */
    if (n.length > 8 && r.length > 8 && (r.indexOf(n) >= 0 || n.indexOf(r) >= 0)) return true;
  }
  return false;
}

/* ---------------- 本地仿写 ---------------- */

const OPEN = [
  '说真的，', '看完有点感触，', '这个我有发言权，', '刚好最近在琢磨这个，',
  '第一次刷到讲这么细的，', '刷到这条停了一下，', '同类内容看了不少，这条算讲明白的，'
];
const TAIL_Q = [
  '方便说说具体怎么落地吗？', '想请教下新手从哪一步开始比较好？',
  '你当时是怎么选方案的，能展开讲讲吗？', '这种情况一般预算要留多少？',
  '有没有踩过什么坑，想提前避一下', '后面还会更吗，想跟着学'
];
const TAIL_E = [
  '这点我完全同意', '和我遇到的情况一模一样', '之前一直没想通，现在通了',
  '准备照这个顺序试一遍', '收藏了，回头慢慢看', '这才是真实体验'
];

function localDrafts(note, count, recent) {
  const k = kwOf(note);
  const BODY_K = [
    k + '这块我一直没搞明白，你这个思路算给我讲通了',
    '之前踩过' + k + '的坑，你说的第二点正是我当时亏的地方',
    k + '还能这么做，确实学到了',
    '我也是做' + k + '的，看完感觉方向对上了',
    '照着' + k + '的思路试了下，确实比原来省事'
  ];
  const BODY_G = [
    '这个思路我一直没搞明白，你这条算给我讲通了',
    '之前踩过同样的坑，你说的第二点正是我当时亏的地方',
    '还能这么做，确实学到了',
    '我最近也在弄类似的，看完感觉方向对上了',
    '照着这个顺序试了下，确实比原来省事'
  ];
  const body = k ? BODY_K : BODY_G;
  /* 种子用 noteKey 的字符哈希：只按长度算，同平台的作品会拿到同一句开场 */
  const key = String((note && (note.noteKey || note.url || note.title)) || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 99991;
  const out = [];
  let guard = 0;
  while (out.length < count && guard < count * 14) {
    const seed = h + out.length * 7 + guard;
    /* 先拼「开场 + 主体」，太长就砍开场；偶数条收陈述句、奇数条补提问 ——
       全是问句像客服，全是陈述像水军，长短也要有起伏才像真人。 */
    const main = pick(body, seed + 3);
    let text = pick(OPEN, seed) + main;
    if (text.length > 50) text = main;
    text += (out.length % 2 && text.length < 50) ? ('，' + pick(TAIL_Q, seed + 5)) : '。';
    text = text.slice(0, MAX_LEN);
    guard++;
    if (looksDup(text, recent) || looksDup(text, out)) continue;
    out.push(text);
  }
  if (!out.length) out.push((k ? k + '这个我熟，有问题可以问我' : '这个我熟，有问题可以问我').slice(0, MAX_LEN));
  return out;
}

/* ---------------- AI 仿写 ---------------- */

function aiPrompt(note, count, samples) {
  const pf = PLATFORM_LABEL[note && note.platform] || '短视频平台';
  const sys = '你是中文短视频平台的普通用户，正在看一条作品并留下真实评论。'
    + '要求：口语化、像真人随手打的、15-40 字、只说具体内容不空夸；'
    + '绝不出现联系方式、微信号、二维码、链接、广告词；不提 AI；不用夸张营销词；'
    + '每条只输出评论本身，一行一条，不要编号、不要引号。';
  const user = '平台：' + pf
    + '\n作品标题：' + String((note && note.title) || '（无标题）').slice(0, 80)
    + '\n作者：' + String((note && note.author) || '未知')
    + (note && note.keyword ? '\n搜它用的关键词：' + note.keyword : '')
    + (samples && samples.length ? '\n评论区已有的热评（参考语气，不要抄）：' + samples.slice(0, 5).join(' / ') : '')
    + '\n\n请写 ' + count + ' 条角度各不相同的评论（一条提问、一条共鸣、一条补充经验）。';
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

/* ---------------- 对外入口 ---------------- */

/**
 * @param store   ProFound Store（读 llm_cfg）
 * @param note    { title, author, platform, keyword, noteKey }
 * @param opt     { count, samples, recent, forceLocal }
 * @returns {Promise<{ok:boolean, source:'llm'|'local', items:{text:string}[], error?:string}>}
 */
async function draftComments(store, note, opt) {
  const o = opt || {};
  const count = Math.max(1, Math.min(5, Number(o.count) || 3));
  const recent = Array.isArray(o.recent) ? o.recent : recentTexts(store, 300);

  if (!o.forceLocal && llmEnabled(store, 'comment')) {
    const r = await llmChat(store, aiPrompt(note, count, o.samples), { temperature: 0.95, maxTokens: 500, purpose: 'comment' });
    if (r.ok) {
      const lines = String(r.text || '')
        .split(/\r?\n/)
        .map(function (x) { return x.replace(/^[\s\-*0-9.、)）]+/, '').replace(/^["“'']|["”'']$/g, '').trim(); })
        .filter(function (x) { return x.length >= 6 && x.length <= MAX_LEN && !looksDup(x, recent); })
        .slice(0, count);
      if (lines.length) {
        return { ok: true, source: 'llm', items: lines.map(function (t) { return { text: t }; }) };
      }
    }
    /* 模型失败不抛错：继续走本地兜底，前端只看到 source=local */
    const items = localDrafts(note, count, recent).map(function (t) { return { text: t }; });
    return { ok: true, source: 'local', items, error: r.error || '' };
  }

  return {
    ok: true, source: 'local',
    items: localDrafts(note, count, recent).map(function (t) { return { text: t }; })
  };
}

/** 最近发过的评论正文，用于去重（防止批量发出同一句话） */
function recentTexts(store, limit) {
  const arr = (store && store.data && store.data.collect_comments) || [];
  return arr.slice(-Math.max(20, Number(limit) || 300))
    .map(function (c) { return c && c.text; })
    .filter(Boolean);
}

module.exports = { draftComments, localDrafts, recentTexts, kwOf, normText, looksDup, MAX_LEN, PLATFORM_LABEL };
