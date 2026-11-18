'use strict';
/* =========================================================
   collect-adapters/local.js — 本地模拟通道
   ---------------------------------------------------------
   这不是真实抓取，只用于在没有接入任何上游时跑通
   「任务 → 去重入池 → CRM」链路。默认关闭（ALLOW_LOCAL_COLLECT=1
   才启用），输出一律带 source:'local-simulated' 与 warning，
   前端界面同步标注「模拟数据」——绝不冒充真实采集。

   scope=own 时会生成「自有作品下的评论」形态（作品名取自自有内容
   词库），便于在没有官方通道时验证 own 链路的展示与入池。
   ========================================================= */

const PALETTE = {
  douyin: { nick: ['娟娟家居', '老李沙发厂', '云姐软装', '面料老周'], vids: ['沙发套怎么选不踩坑', '雪尼尔和荷兰绒差别'] },
  kuaishou: { nick: ['阿强布艺', '小敏家纺', '老徐沙发翻新'], vids: ['沙发巾批发价来了', '抱枕面料清仓'] },
  xhs: { nick: ['家居研究所', '布艺小鹿', '软装日记本'], vids: ['奶油风沙发配色', '小户型沙发避坑'] },
  sph: { nick: ['张姐布艺', '老陈面料行'], vids: ['面料商教你砍价', '沙发巾怎么挑'] }
};

/* 自有账号作品名（scope=own 时用） */
const OWN_VIDS = {
  douyin: ['工厂实拍：雪尼尔沙发巾生产线', '荷兰绒现货色卡全览', '批发客户到厂选样实录'],
  kuaishou: ['今天发一批沙发套辅料', '抱枕面料打包现场'],
  xhs: ['面料商的选色笔记合集', '小户型沙发面料搭配思路'],
  sph: ['面料行日常：到货与发样', '沙发巾怎么挑不踩坑']
};

const OPENERS = ['求个批发价', '怎么拿样品', '加微信聊', '有现货吗', '多少米起批', '这个多少钱', '想拿货', '能发我色卡吗'];

/**
 * @param {object} payload { platform, keyword, limit, region, scope }
 * @returns {{status:number, body:object}}
 */
function collect(payload) {
  const p = payload || {};
  const pf = p.platform || 'douyin';
  const palette = PALETTE[pf] || PALETTE.douyin;
  const own = String(p.scope || '') === 'own';
  const vids = own ? (OWN_VIDS[pf] || OWN_VIDS.douyin) : palette.vids;
  const kw = p.keyword || '沙发面料';
  const limit = Math.max(1, Math.min(Number(p.limit) || 8, 30));
  const comments = [];
  for (let i = 0; i < limit; i++) {
    const opener = OPENERS[i % OPENERS.length];
    comments.push({
      nickname: palette.nick[Math.floor(Math.random() * palette.nick.length)] + (i + 1),
      comment: opener + '（' + kw + '）',
      video_title: vids[Math.floor(Math.random() * vids.length)],
      likes: Math.floor(Math.random() * 300),
      at: new Date(Date.now() - i * 3600000).toISOString(),
      platform: pf,
      region: p.region || ''
    });
  }
  return {
    status: 200,
    body: {
      ok: true,
      data: { comments },
      source: 'local-simulated',
      channel: 'local',
      scope: own ? 'own' : 'keyword',
      warning: own ? '本地模拟数据（自有内容评论区形态），非真实抓取' : '本地模拟数据，非真实抓取'
    }
  };
}

module.exports = { collect, PALETTE, OPENERS, OWN_VIDS };
