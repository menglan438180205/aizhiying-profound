'use strict';
/* =========================================================
   demo/dataset.js — 全系统「演示数据」唯一来源
   ---------------------------------------------------------
   设计原则：
   1) 演示数据只属于演示环境（DEMO_MODE=1 / 非生产默认开启），
      生产环境不会加载本文件，也不会把这里的数据写进生产库。
   2) 所有模块（数据中台 / 评论区获客 / 自动加微信 / AI智能剪辑 /
      GEO直通车 / CRM / AI员工 / 会员套餐）的演示数据都在这里定义，
      页面不再各自内嵌 mock 常量。
   3) 服务端通过 GET /v1/demo/dataset 一次性下发；前端 demo 模式读取，
      生产模式该接口直接 404（DEMO_DISABLED）。

   与 data-samples/ 的区别：
     demo/dataset.js  → 演示用的「模拟业务数据」（有故事、有数字）
     data-samples/    → 生产用的「数据结构样例」（字段、类型、一条示例）
   ========================================================= */

const DAY = 864e5;
const MIN = 60e3;

function iso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

/* ---------------- 线索（评论区获客 / CRM / 中台共用） ---------------- */
const LEADS = [
  { id: 1, nickname: '李总 · 连锁餐饮', platform: 'kuaishou', keyword: '千川投流 服务商', comment: '千川投流 30 万预算，能保 ROI 吗？想先试投，能加个微信聊吗', intent_score: 96, stage: 'sent', requirement: '30 万预算 · 要 ROI 方案', wechat_note: null, amount: null },
  { id: 2, nickname: '张姐 · 美业连锁', platform: 'douyin', keyword: '抖音代运营 报价', comment: '抖音代运营一个月多少钱？我们有 6 家门店要起量', intent_score: 92, stage: 'wechat', requirement: '6 家门店 · 月度代运营', wechat_note: '张姐·美业连锁·江苏', amount: null },
  { id: 3, nickname: '赵老板 · 家居卖场', platform: 'sph', keyword: '千川投流 服务商', comment: '留个电话 138****6621，我们全年投放预算 80 万', intent_score: 89, stage: 'wechat', requirement: '年框 80 万 · 长期投放', wechat_note: '赵老板·年框投放·浙江', amount: null },
  { id: 4, nickname: '陈小姐 · 新消费品牌', platform: 'xhs', keyword: '本地生活 团购 代运营', comment: '团购上架怎么收费？先做 3 家门店试试', intent_score: 78, stage: 'nego', requirement: '团购代运营 · 3 家门店', wechat_note: '陈小姐·团购代运营·上海', amount: 12000 },
  { id: 5, nickname: '泰和教培机构', platform: 'douyin', keyword: '精准客源 CPL / 线索', comment: '招生线索能按 CPL 结算吗？我们要 500 条/月', intent_score: 81, stage: 'nego', requirement: 'CPL 500 条/月', wechat_note: '泰和·教培招生·杭州', amount: 28000 },
  { id: 6, nickname: '优家连锁', platform: 'kuaishou', keyword: '精准客源 CPL / 线索', comment: '同城，方便过来聊一下合作吗', intent_score: 74, stage: 'deal', requirement: 'CPL 线索年框', wechat_note: '优家·连锁门店·绍兴', amount: 46000 },
  { id: 7, nickname: '美好生活馆', platform: 'douyin', keyword: '抖音代运营 报价', comment: '先投 5 万试试，怎么合作？', intent_score: 83, stage: 'deal', requirement: '首单 5 万试投', wechat_note: '美好·生活馆·宁波', amount: 8600 },
  { id: 8, nickname: '周姐 · 连锁美甲', platform: 'douyin', keyword: '短视频 拍摄 外包', comment: '短视频拍摄外包，一个月能出几条', intent_score: 71, stage: 'new', requirement: '拍摄外包 · 月更 12 条', wechat_note: null, amount: null },
  { id: 9, nickname: '郑先生 · 电商卖家', platform: 'xhs', keyword: '精准客源 CPL / 线索', comment: '想找稳定线索源，量要 500 条/月', intent_score: 68, stage: 'new', requirement: '线索 500 条/月', wechat_note: null, amount: null },
  { id: 10, nickname: '刘女士 · 口腔门诊', platform: 'sph', keyword: '本地生活 团购 代运营', comment: '本地推怎么投，能带来到店吗', intent_score: 62, stage: 'sleep', requirement: '本地推 · 到店转化', wechat_note: '刘女士·口腔门诊·杭州', amount: null },
  { id: 11, nickname: '吴先生 · 招商加盟', platform: 'douyin', keyword: '精准客源 CPL / 线索', comment: '加盟线索怎么收费', intent_score: 58, stage: 'sleep', requirement: '加盟线索询价', wechat_note: '吴先生·招商加盟', amount: null },
  { id: 12, nickname: '许女士 · 网店店主', platform: 'kuaishou', keyword: '抖音代运营 报价', comment: '代运营包含拍摄吗，怎么算', intent_score: 74, stage: 'sent', requirement: '代运营 + 拍摄打包', wechat_note: null, amount: null }
];

/* ---------------- 会员套餐 ---------------- */
const PLANS = [
  { code: 'quarter', name: '季度版', price: 1980, period: 'quarter', seats: 1, highlight: false, features: ['1 个微信号托管', '1 个平台接入', '500 条线索/月', 'AI 私信话术 3 套', '数据中台基础版', '在线工单支持'] },
  { code: 'basic', name: '基础版', price: 5980, period: 'year', seats: 2, highlight: false, features: ['2 个微信号托管', '2 个平台接入', '2000 条线索/月', 'AI 私信话术不限量', '5 位 AI 员工全开', '客户管理 CRM', 'AI智能剪辑 30 条/月', '1v1 客服支持'] },
  { code: 'standard', name: '标准版', price: 12800, period: 'year', seats: 5, highlight: true, features: ['5 个微信号托管', '4 大平台全开', '10000 条线索/月', 'AI智能剪辑 200 条/月', '批量发布 + 同行采集', 'GEO直通车方案', '自动加微信', '专属运营顾问'] },
  { code: 'flagship', name: '旗舰版', price: 29800, period: 'year', seats: 20, highlight: false, features: ['20 个微信号托管', '全渠道店铺客服', '线索量不设上限', 'AI 自动直播', '财务 + 交付 AI 员工', 'GEO直通车全案 + 品牌背书', '私有化话术知识库', '7×24 客户成功团队'] }
];

/* ---------------- 剪辑任务 ---------------- */
const TASKS = [
  { id: 1, title: '代运营案例 · 30 条混剪', task_type: 'edit', status: 'running', progress: 68, note: '素材 12 个 · 9:16 竖版 · 智能配音 + 字幕' },
  { id: 2, title: '千川起量 · 口播讲解版 10 条', task_type: 'edit', status: 'done', progress: 100, note: '已完成 · 已进入发布排期（今日 18:00 / 20:30）' },
  { id: 3, title: '团队实力展示 · 20 条', task_type: 'edit', status: 'queued', progress: 12, note: '等待 GPU 资源 · 队列第 2 位' }
];

/* ---------------- 评论区采集调度任务（演示种子） ----------------
   keyword/platform/every/limit/enabled → 服务端调度器字段
   kw/pf/freq/hit/on/total/lastRun        → 前端评论区获客任务卡字段
   同一份数据两处复用，避免前后端各存一套 mock。 */
const COLLECT_TASKS = [
  { keyword: '抖音代运营 报价', platform: 'douyin', every: '1h', limit: 20,
    kw: '抖音代运营 报价', pf: ['douyin', 'kuaishou'], freq: 'realtime', hit: ['多少钱', '预算', '起量'], on: true, total: 46, lastRun: '12 分钟前' },
  { keyword: '千川投流 服务商', platform: 'douyin', every: '1h', limit: 20,
    kw: '千川投流 服务商 / 起量', pf: ['douyin', 'sph'], freq: 'realtime', hit: ['预算', 'ROI', '试投'], on: true, total: 31, lastRun: '18 分钟前' },
  { keyword: '本地生活 团购 代运营', platform: 'xhs', every: '6h', limit: 15,
    kw: '本地生活 团购 代运营', pf: ['xhs', 'douyin'], freq: '600', hit: ['团购', '上架', '门店'], on: true, total: 24, lastRun: '35 分钟前' },
  { keyword: '短视频 拍摄 外包', platform: 'kuaishou', every: '6h', limit: 15,
    kw: '短视频 拍摄 外包', pf: ['kuaishou', 'sph'], freq: 'realtime', hit: ['拍摄', '剪辑', '外包'], on: true, total: 18, lastRun: '48 分钟前' },
  { keyword: '精准客源 CPL 线索', platform: 'douyin', cron: '0 9,15,21 * * *', limit: 20, enabled: false,
    kw: '精准客源 CPL / 线索', pf: ['douyin', 'kuaishou'], freq: '3600', hit: ['CPL', '线索'], on: false, total: 9, lastRun: '1 小时前' },
  { keyword: '自有作品评论区巡检', platform: 'douyin', every: '24h', limit: 30, channel: 'auto', scope: 'own', enabled: false,
    tags: ['自有内容', '官方通道'],
    kw: '自有作品评论区巡检', pf: ['douyin'], freq: '86400', hit: ['咨询', '怎么卖'], on: false, total: 0, lastRun: '未运行' }
];

/* ---------------- GEO 关键词（演示种子） ---------------- */
const GEO_KEYWORDS = [
  { kw: '抖音代运营 哪家好', intent: '采购', vol: 2400 },
  { kw: '千川投流服务商 哪家好', intent: '采购', vol: 1900 },
  { kw: '本地生活 团购代运营', intent: '代运营', vol: 880 },
  { kw: '千川代投 报价', intent: '定制', vol: 720 },
  { kw: 'CPL 线索 一手资源', intent: '货源', vol: 1500 },
  { kw: '信息流代投 服务商', intent: '采购', vol: 640 }
];

/* ---------------- 自动加微信 ---------------- */
const WECHAT = {
  metrics: { imported: 86, added: 41, rate: 47.7, blocked: 3 },
  numbers: [
    { phone: '138****6621', source: '视频号评论', note: '赵老板·家居卖场·年框投放', status: '已通过' },
    { phone: '159****3308', source: '直播间留资', note: '刘女士·口腔门诊·杭州', status: '等待通过' },
    { phone: '186****7712', source: '电话咨询', note: '孙经理·连锁美业·要方案', status: '已通过' },
    { phone: '137****9045', source: '抖音私信', note: '吴先生·招商加盟·询价', status: '已通过' }
  ],
  accounts: [
    { name: '客服号 · 小盈', status: '在线', today: 18, cap: 25, health: 98 },
    { name: '销售号 · 阿哲', status: '在线', today: 21, cap: 25, health: 95 },
    { name: '备用号 · 小舟', status: '保护期', today: 4, cap: 10, health: 88 }
  ]
};

/* ---------------- CRM 看板 ---------------- */
const CRM = {
  columns: [
    { key: 'new', name: '新线索', count: 128, cards: [
      { name: '周姐 · 连锁美甲', platform: 'douyin', note: '短视频拍摄外包 · 月更 12 条', tag: '意向 71', tone: 'amber' },
      { name: '郑先生 · 电商卖家', platform: 'xhs', note: '小红书 · 1 小时前', tag: '意向 68', tone: 'amber' }
    ] },
    { key: 'sent', name: '已私信', count: 64, cards: [
      { name: '李总 · 连锁餐饮', platform: 'kuaishou', note: '已发 2 条 · 待回复', tag: '意向 96', tone: 'green' },
      { name: '许女士 · 网店店主', platform: 'kuaishou', note: '已发 1 条 · 已读', tag: '意向 74', tone: 'amber' }
    ] },
    { key: 'wechat', name: '已加微', count: 312, cards: [
      { name: '张姐美业连锁', platform: 'douyin', note: '备注：团购代运营', tag: '意向 92', tone: 'green' },
      { name: '赵老板 · 家居卖场', platform: 'sph', note: '备注：长期投放', tag: '意向 89', tone: 'green' }
    ] },
    { key: 'nego', name: '洽谈中', count: 96, cards: [
      { name: '陈小姐 · 新消费品牌', platform: 'xhs', note: '已报价 · 等确认', tag: '预计 ¥12,000', tone: 'accent' },
      { name: '泰和教培机构', platform: 'douyin', note: '等方案中 · 3 天未回', tag: '预计 ¥28,000', tone: 'accent' }
    ] },
    { key: 'deal', name: '已成交', count: 86, cards: [
      { name: '优家连锁 · 复购', platform: 'kuaishou', note: '年框 46,000 · 已回款', tag: '¥46,000', tone: 'violet' },
      { name: '美好生活馆', platform: 'douyin', note: '首单 · 待交付', tag: '¥8,600', tone: 'violet' }
    ] },
    { key: 'sleep', name: '待唤醒', count: 42, cards: [
      { name: '刘女士 · 口腔门诊', platform: 'sph', note: '7 天未互动', tag: '建议回访', tone: 'red' },
      { name: '吴先生 · 招商加盟', platform: 'douyin', note: '已报价未回', tag: '建议回访', tone: 'red' }
    ] }
  ]
};

/* ---------------- AI智能剪辑 ---------------- */
const MATRIX = {
  assets: [
    { name: '品牌宣传片 · 60s', type: '视频', duration: '00:58', size: '86.4 MB', status: '已入库' },
    { name: '门店实拍 · 12 段', type: '视频', duration: '04:12', size: '212 MB', status: '已入库' },
    { name: '客户案例图 · 24 张', type: '图片', duration: '—', size: '38.1 MB', status: '已入库' },
    { name: '口播素材 · 6 条', type: '音频', duration: '03:26', size: '12.8 MB', status: '已入库' }
  ],
  jobs: [
    { title: '代运营案例 · 30 条混剪', ratio: '9:16', status: '渲染中', progress: 68 },
    { title: '千川起量 · 口播讲解 10 条', ratio: '9:16', status: '已完成', progress: 100 },
    { title: '团队实力展示 · 20 条', ratio: '16:9', status: '排队中', progress: 12 }
  ]
};

/* ---------------- AI自动直播 ---------------- */
const LIVE = {
  rooms: [
    { name: '抖音 · 品牌自播间', anchor: '数字人 · 小盈', status: '直播中', viewers: 1286, duration: '02:14:36' },
    { name: '视频号 · 门店引流', anchor: '数字人 · 阿哲', status: '已结束', viewers: 642, duration: '01:48:02' }
  ]
};

/* ---------------- 风控与设置 ---------------- */
const SETTINGS = {
  members: [
    { name: '王总（你）', role: '超级管理员 · 全部权限', tag: '所有者' },
    { name: '刘主管', role: '销售跟进 · 客户管理 · 不可导出', tag: '销售' },
    { name: '孙客服', role: '仅客服会话与订单查询', tag: '客服' }
  ],
  logs: [
    { time: '10:42', actor: '系统', action: '采集任务「抖音代运营 报价」执行完成', result: '新增 12 条线索' },
    { time: '10:18', actor: '王总', action: '开启「高意向人工复核」策略', result: '已生效' },
    { time: '09:56', actor: '销售 AI 员工', action: '自动加微 8 人', result: '通过 5 人' },
    { time: '09:30', actor: '系统', action: 'GEO 监测任务全量刷新', result: '6 个关键词' }
  ]
};

/* ---------------- GEO直通车 · AI秒搭建站（演示建站记录） ---------------- */
const GEO_SITES = [
  {
    id: 'gs_demo_01', brand: '启量增长', industry: 'agency', industryLabel: '流量服务商',
    pages: 6, score: 94, domain: 'www.qiliang-growth.com', date: '2026-10-12', status: '已发布',
    keywords: ['抖音代运营 哪家好', '千川投流服务商 推荐', 'CPL 线索 一手资源'],
    form: {
      brand: '启量增长', industry: 'agency', services: '抖音代运营、千川投流代投、CPL 线索供应',
      city: '杭州', phone: '400-800-1234', wechat: 'qiliang-growth',
      domain: 'www.qiliang-growth.com',
      keywords: '抖音代运营 哪家好、千川投流服务商 推荐、CPL 线索 一手资源'
    }
  },
  {
    id: 'gs_demo_02', brand: '佳美口腔', industry: 'health', industryLabel: '医疗健康',
    pages: 6, score: 88, domain: 'www.jiamei-dental.com', date: '2026-10-08', status: '待发布',
    keywords: ['种植牙 哪家好', '杭州口腔门诊 推荐'],
    form: {
      brand: '佳美口腔', industry: 'health', services: '种植牙、正畸、儿童齿科',
      city: '杭州', phone: '0571-8888-6621', wechat: 'jiamei-dental',
      domain: 'www.jiamei-dental.com',
      keywords: '种植牙 哪家好、杭州口腔门诊 推荐'
    }
  },
  {
    id: 'gs_demo_03', brand: '越信精工', industry: 'mfg', industryLabel: '制造与供应链',
    pages: 6, score: 83, domain: 'www.yuexin-mfg.com', date: '2026-09-26', status: '草稿',
    keywords: ['家纺面料 OEM', '小批量定制 面料厂'],
    form: {
      brand: '越信精工', industry: 'mfg', services: '家纺面料 OEM、小批量定制、现货供应',
      city: '绍兴', phone: '0575-8866-2019', wechat: 'yuexin-mfg',
      domain: 'www.yuexin-mfg.com',
      keywords: '家纺面料 OEM、小批量定制 面料厂'
    }
  }
];

/* ---------------- 组装 ---------------- */

/** 生成带时间戳的完整演示数据集（每次调用返回全新副本，避免被页面改动污染） */
function build() {
  const leads = LEADS.map((l, i) => Object.assign({}, l, {
    created_at: iso((i + 1) * 8 * 60 * MIN),
    updated_at: iso(i * 20 * MIN)
  }));
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    leads,
    plans: PLANS.map((p) => Object.assign({}, p, { features: p.features.slice() })),
    tasks: TASKS.map((t) => Object.assign({}, t)),
    collectTasks: COLLECT_TASKS.map((t) => Object.assign({}, t)),
    geoKeywords: GEO_KEYWORDS.map((k) => Object.assign({}, k)),
    wechat: JSON.parse(JSON.stringify(WECHAT)),
    crm: JSON.parse(JSON.stringify(CRM)),
    matrix: JSON.parse(JSON.stringify(MATRIX)),
    live: JSON.parse(JSON.stringify(LIVE)),
    geoSites: JSON.parse(JSON.stringify(GEO_SITES)),
    settings: JSON.parse(JSON.stringify(SETTINGS))
  };
}

/** 实体清单：供 /v1/demo/dataset 暴露可用键，也便于前端做类型校验 */
const ENTITIES = ['leads', 'plans', 'tasks', 'collectTasks', 'geoKeywords', 'geoSites', 'wechat', 'crm', 'matrix', 'live', 'settings'];

module.exports = {
  build,
  ENTITIES,
  LEADS, PLANS, TASKS, COLLECT_TASKS, GEO_KEYWORDS,
  WECHAT, CRM, MATRIX, LIVE, GEO_SITES, SETTINGS
};
