'use strict';
/* =========================================================
   intent.js — 评论意向判定（可解释的打分器）
   ---------------------------------------------------------
   为什么是规则而不是模型：
     1) 评论只有十几个字，上下文极少，大模型反而容易过度解读；
     2) 打分要给得出理由 —— 销售看到「92 分」时必须能看见
        「命中：多少钱 +36 / 疑问句 +8」，否则他不信这个分；
     3) 零成本、零延迟、可离线，不依赖任何上游额度。

   输出契约（前端与线索池共用）：
     { score, level, intent, hits: [{ word, weight, tag }], reason }
     level: high | mid | low | noise

   一条铁律：**不要为了好看抬高分数**。宁可判低，让人工复核，
   也不要让销售按 96 分去追一个「哈哈哈」。
   ========================================================= */

/* 强意向：直接暴露购买/联系动作 */
const RULES = [
  {
    id: 'contact', tag: '要联系方式', w: 36,
    re: /(加|留)(个|一下|下)?\s*(微信|微|vx|wx|v信|威信|电话|联系方式)|怎么联系|私信我|私我|\/?v[:：]|微信多少|电话多少|联系方式/i
  },
  {
    id: 'price', tag: '问价', w: 34,
    re: /多少钱|什么价|啥价|价格|报价|收费|费用|单价|一平|怎么卖|卖多少|预算|几折|优惠|套餐价/
  },
  {
    id: 'coop', tag: '求合作', w: 27,
    re: /能(上门|做|接|来|帮我)|可以(做|接|上门)吗|怎么合作|合作方式|求带|带我|接单吗|在吗|有人在吗/
  },
  {
    id: 'agency', tag: '招商加盟', w: 25,
    re: /加盟|代理|分销|招代理|渠道合作|城市合伙|区域代理/
  },
  {
    id: 'compare', tag: '比价选型', w: 18,
    re: /求推荐|哪家(好|靠谱)|怎么选|靠谱吗|有推荐|对比|区别|哪家强|选哪个/
  },
  {
    id: 'interest', tag: '初步了解', w: 14,
    re: /想了解|了解一下|咨询|问问|请教|新手|小白|刚开始|准备做|打算做/
  },
  {
    id: 'doubt', tag: '效果疑虑', w: 10,
    re: /效果|案例|真的吗|有用吗|管用吗|多久(能|见)|能保(证)?|靠谱/
  }
];

/* 纯噪音：无任何意向命中时，命中这些直接归零 */
const NOISE_RE = /^(哈+|呵+|嘿+|沙发|顶|路过|打卡|好看|已阅|学习(了)?|收藏(了)?|马克|留名|赞|牛|绝了|(\d{1,3})|[\s\p{Emoji_Presentation}]+)$/u;
/* 反讽/否定：出现时降权 */
const NEG_RE = /(太贵|不值|坑人|骗子|垃圾|避雷|翻车|后悔|别买|不推荐|差评)/;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * 对一条评论打分。
 * @param {string} text 评论正文
 * @param {string[]} [words] 目标自定义的意向词（命中额外计 22 分）
 * @returns {{score:number, level:string, intent:string, hits:Array, reason:string}}
 */
function score(text, words) {
  const s = String(text || '').trim();
  if (!s) return { score: 0, level: 'noise', intent: '空', hits: [], reason: '空评论' };

  const hits = [];
  let total = 0;
  let intent = '';

  const extra = (Array.isArray(words) ? words : [])
    .map((w) => String(w || '').trim())
    .filter(Boolean);

  /* ① 自定义意向词（运营自己定义的最准，优先级高于内置词表） */
  extra.forEach((w) => {
    if (s.indexOf(w) >= 0) {
      hits.push({ word: w, weight: 22, tag: '自定义词' });
      total += 22;
      if (!intent) intent = '自定义命中';
    }
  });

  /* ② 内置规则：同一规则只计一次，取该规则最高权重 */
  RULES.forEach((r) => {
    const m = s.match(r.re);
    if (!m) return;
    hits.push({ word: m[0], weight: r.w, tag: r.tag });
    total += r.w;
    /* 需求类型取权重最高的那条 */
    if (!intent || r.w >= (RULES.find((x) => x.tag === intent) || { w: 0 }).w) intent = r.tag;
  });

  /* ③ 疑问句式加分：在问，说明有需求 */
  if (/[?？]|怎么|多少|哪|能不能|可不可以|有没有/.test(s)) {
    hits.push({ word: '疑问句', weight: 8, tag: '句式' });
    total += 8;
  }

  /* ④ 长度校正：太短信息量不足；长文本通常是真的在描述需求 */
  if (s.length < 5) {
    hits.push({ word: '文本过短', weight: -12, tag: '校正' });
    total -= 12;
  } else if (s.length >= 30) {
    total += 4;
  }

  /* ⑤ 负面表述降权：会骂人的通常不是客户，先降再说 */
  if (NEG_RE.test(s)) {
    hits.push({ word: '负面表述', weight: -18, tag: '校正' });
    total -= 18;
  }

  /* ⑥ 纯噪音覆盖：没有任何意向命中且整体是水词 */
  const hasIntentHit = hits.some((h) => h.weight > 0 && h.tag !== '句式');
  if (!hasIntentHit && NOISE_RE.test(s)) {
    return { score: 3, level: 'noise', intent: '噪音', hits, reason: '纯互动水词，无意向信号' };
  }

  const final = clamp(Math.round(total), 0, 100);
  const level = final >= 70 ? 'high' : (final >= 45 ? 'mid' : (final >= 20 ? 'low' : 'noise'));
  const reason = hits.length
    ? hits.map((h) => h.word + (h.weight > 0 ? ' +' : ' ') + h.weight).join(' / ')
    : '未命中任何意向信号';

  return {
    score: final, level,
    intent: intent || '待判定',
    hits, reason
  };
}

/** 意向词默认表（前端「意向词」区展示与一键填充用） */
const DEFAULT_WORDS = ['多少钱', '报价', '怎么收费', '怎么联系', '加微信', '预算', '求推荐', '能上门', '加盟', '怎么合作'];

module.exports = { score, DEFAULT_WORDS, LEVELS: ['high', 'mid', 'low', 'noise'] };
