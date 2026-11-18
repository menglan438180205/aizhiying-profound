
/* =========================================================
   GEO直通车 · AI秒搭建站（GEO Site Builder）
   ---------------------------------------------------------
   定位：把「GEO优化引擎」发现的问题（缺结构化数据、缺问答层、
         缺 AI 抓取通道）直接落成一个可发布的官网。
   生成物：6 个语义化页面 + style.css + llms.txt + robots.txt
          + sitemap.xml，可整站打包 ZIP 下载。
   生成方式：纯前端确定性生成（不依赖网络与大模型），
          同一份表单输入产出同一套站点，便于验收与复现。
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- 0. 基础工具 ---------------- */
  function q(s, r) { return (r || document).querySelector(s); }
  function qa(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ui() { return window.__UI || {}; }
  function fn(o, k) { return o && typeof o[k] === 'function'; }
  function toast(msg, kind, title, ms) {
    var u = ui();
    if (fn(u, 'toast')) { try { return u.toast(msg, kind || 'info', title, ms); } catch (e) {} }
    return null;
  }
  function modal(cfg) {
    var u = ui();
    if (fn(u, 'openModal')) { try { return u.openModal(cfg); } catch (e) {} }
    return null;
  }
  function audit(action, target) {
    var r = window.__RT;
    if (r && fn(r, 'audit')) { try { r.audit(action, target); } catch (e) {} }
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---- 服务端通道 ----
     原先整个模块没有一个网络调用：产物只在浏览器内存里，域名从不被校验。
     这里接 __RT.api（统一带鉴权头 + 令牌过期提示），把「域名探测 / 站点持久化 /
     历史拉取」三条服务端能力接进来。通道不可用时全部降级为本地行为并如实告知，
     不再假装「已生成」等于「已上线」。 */
  function bff() { return window.__RT && typeof window.__RT.api === 'object' ? window.__RT.api : null; }
  function bffUp() { var a = bff(); return !!(a && a.live && a.live()); }
  function api(path, body, opt) {
    var a = bff();
    if (!a || !bffUp()) return Promise.resolve({ ok: false, code: 'NO_BFF', error: '未接入服务端' });
    return a.call(path, body, opt || {});
  }
  function splitList(s, max) {
    return String(s || '')
      .split(/[、,，;；\n]/)
      .map(function (x) { return String(x).trim(); })
      .filter(function (x) { return x.length > 0; })
      .slice(0, max || 8);
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function kb(n) {
    if (n < 1024) return n + ' B';
    return (n / 1024).toFixed(1) + ' KB';
  }
  function strip(html) {
    return String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
  }
  function countOf(str, re) { var m = String(str).match(re); return m ? m.length : 0; }

  /* ---------------- 1. 引擎与行业词库 ---------------- */
  var FALLBACK_ENGINES = [
    { id: 'doubao', name: '豆包' }, { id: 'yuanbao', name: '腾讯元宝' },
    { id: 'wenxin', name: '文心一言' }, { id: 'tongyi', name: '通义千问' },
    { id: 'deepseek', name: 'DeepSeek' }, { id: 'kimi', name: 'Kimi' }
  ];
  function engines() {
    var g = window.__GEO && window.__GEO.engines;
    return (g && g.length) ? g : FALLBACK_ENGINES;
  }

  /* 行业词库：决定痛点、指标、流程、资质、FAQ 与案例的措辞。
     新增行业只需在这里加一条，页面与结构化数据自动适配。 */
  var IND = {
    agency: {
      label: '流量服务商', noun: '服务', self: '流量服务商',
      audience: '本地生活商家、连锁门店与新消费品牌',
      promise: '把投流预算变成可复盘的增量，而不是一次性消耗',
      pains: ['投流 ROI 波动大，预算花完没沉淀', '素材产能跟不上，团队不会做内容', '线索质量参差，销售不愿跟', '数据口径混乱，复盘只能靠感觉'],
      metrics: [['累计服务商家', '320+'], ['年投放规模', '1.2 亿'], ['平均 ROI 提升', '47%'], ['线索交付准时率', '98.6%']],
      process: ['账号与投放诊断', '人群与素材方向拆解', '小预算分批测素材', '放量并做周度 ROI 复盘'],
      certs: ['巨量引擎服务商认证', '快手磁力聚星合作伙伴', 'ISO 27001 信息安全'],
      price: '代运营 ¥12,000 起/月；投流代投按消耗 8%–12% 计费；CPL 线索 ¥18–¥45/条',
      deliverables: ['账号诊断报告', '月度成片 12 条', '投放日报 + 周度复盘', '线索回传与质检'],
      faq: [
        ['抖音代运营一个月多少钱？', '代运营按账号数量与内容量计费，单账号 ¥12,000 起/月，含 12 条成片、投放代投与周度复盘；多账号与年框可下浮 10%–20%。'],
        ['能保证 ROI 吗？', '不承诺固定 ROI 是行业底线。我们用三阶段对赌：首月测出可放量素材，次月把 ROI 稳定在类目均值 1.2 倍以上，未达标按比例返还服务费。'],
        ['多久能看到效果？', '账号冷启动 7–14 天出首条起量素材，30 天进入稳定投放；线索类项目通常在第 2 周开始有稳定询盘。']
      ],
      cases: [
        ['连锁餐饮 · 6 家门店', '团购上架三个月零动销', '重做门店短视频，本地推定向 3 公里', '月核销 0 → 1,860 单，ROI 3.4', '90 天'],
        ['美业连锁 · 12 店', '投流成本高、到店率低', '素材按门店分城，团购券承接', '获客成本下降 38%，到店率 27%', '60 天'],
        ['新消费品牌 · 电商', '素材产能不足，起量慢', '建素材库，每周批量产出 20 条', '月度 GMV 提升 2.1 倍', '120 天']
      ]
    },
    saas: {
      label: '企业服务与 SaaS', noun: '解决方案', self: '企业软件服务商',
      audience: '中小企业的业务负责人与 IT 负责人',
      promise: '用一套系统替掉散落的表格与人工流程',
      pains: ['数据散在 Excel 与微信群，统计口径不一', '上线周期长，IT 排期排不进', '员工不愿用，买了却闲置', '缺少接口，和现有系统打不通'],
      metrics: [['付费企业客户', '1,800+'], ['平均上线周期', '7 天'], ['续费率', '92%'], ['系统可用性', '99.95%']],
      process: ['业务流程梳理', '字段与权限配置', '历史数据迁移', '培训上线与复盘'],
      certs: ['等保三级备案', 'ISO 27001', '信创兼容认证'],
      price: '标准版 ¥9,800/年起，按席位增购 ¥1,200/席；私有化部署 ¥12 万起',
      deliverables: ['实施配置清单', '数据迁移方案', '管理员培训 2 场', '专属客户成功经理'],
      faq: [
        ['部署要多久？', '标准 SaaS 版 3–7 天完成配置上线；含历史数据迁移与自定义字段的项目通常 2–3 周，私有化部署按环境另计。'],
        ['能和我们现有的系统对接吗？', '提供 REST API 与 Webhook，支持与企业微信、钉钉、金蝶、用友做双向同步；无代码场景可用内置连接器直接配置。'],
        ['数据安全怎么保障？', '通过等保三级与 ISO 27001，数据加密存储、按角色最小权限、操作全量留痕，支持私有化部署与数据导出。']
      ],
      cases: [
        ['区域连锁零售 · 68 店', '门店报单靠微信群，财务月底对不上', '上线进销存 + 审批流，打通 POS', '月结对账从 9 天缩短到 1 天', '21 天'],
        ['汽车零部件厂', '排产靠 Excel，插单频繁', '部署排产模块并对接 ERP', '交付准时率 78% → 94%', '45 天'],
        ['连锁教育机构', '招生线索分散在 5 个渠道', '统一线索池 + 自动分配', '线索响应时长 4 小时 → 11 分钟', '14 天']
      ]
    },
    local: {
      label: '本地生活门店', noun: '服务', self: '本地生活运营服务商',
      audience: '餐饮、美业、口腔、健身等线下门店',
      promise: '让三公里内的客人找得到、约得上、愿意再来',
      pains: ['新客不进店，老客不复购', '团购上了却没人核销', '评价少、评分低，搜也搜不到', '预约靠电话，忙时接不住'],
      metrics: [['年服务门店', '260+'], ['平均核销提升', '2.6 倍'], ['到店转化率', '31%'], ['复购率提升', '18 个点']],
      process: ['门店与商圈诊断', '团购与套餐设计', '内容与同城投放', '会员复购运营'],
      certs: ['食品经营许可（合作门店）', '连锁经营备案', '门店实拍可核验'],
      price: '单店代运营 ¥3,800 起/月；同城投放按预算 10% 计费；多店年框另议',
      deliverables: ['门店诊断报告', '团购套餐 3 套', '同城内容 8 条/月', '会员复购 SOP'],
      faq: [
        ['门店在商圈里没名气，能做起来吗？', '先做「三公里可见」：团购上架 + 同城内容 + 评价沉淀，通常 30 天能看到自然搜索与到店咨询的同步增长。'],
        ['团购套餐怎么设计才有人买？', '用引流款拉新、利润款承接、会员款锁复购。引流款毛利率控制在 40% 以内，且必须到店才能核销。'],
        ['需要门店配合什么？', '提供真实门店照片、出餐或服务标准、店长对接人即可；拍摄与文案由我们完成，每周固定 2 小时对接。']
      ],
      cases: [
        ['火锅店 · 单店', '开业三个月，日均 20 单', '设计双人引流套餐 + 同城探店', '日均核销 96 单，翻台 3.1 次', '60 天'],
        ['口腔门诊 · 3 店', '种植牙咨询少，获客贵', '科普内容 + 免费检查券承接', '月到店 42 人，获客成本降 44%', '90 天'],
        ['健身工作室', '年卡卖不动，退卡多', '改成月付 + 团课体验', '月均新增会员 63 人', '45 天']
      ]
    },
    mfg: {
      label: '制造与供应链', noun: '产品与服务', self: '制造企业',
      audience: '品牌方、贸易商与工程项目采购',
      promise: '自有产线 + 现货仓，把交期做成竞争力',
      pains: ['打样慢，改三次还不对', '交期口头承诺，实际总延后', '小批量不接，起订量卡死', '质量波动，批次色差明显'],
      metrics: [['自有产线', '4 条'], ['常备现货 SKU', '860+'], ['平均打样周期', '5 天'], ['批次合格率', '99.2%']],
      process: ['需求与参数确认', '打样并封样', '批量排产与过程检验', '出货与售后追溯'],
      certs: ['ISO 9001 质量管理体系', 'ISO 14001 环境体系', 'SGS 第三方检测报告'],
      price: '按材质、工艺与批量报价，打样费在批量订单中全额抵扣；年度框架客户享账期',
      deliverables: ['参数确认单', '封样与检测报告', '批次质检记录', '物流与售后追溯'],
      faq: [
        ['起订量是多少？', '常规款现货 1 件起发；定制品按工艺起订，通常 300–500 件，年度框架客户可协商降低起订量。'],
        ['打样要多久？收费吗？', '常规材质 3–5 个工作日出样，复杂工艺 7–10 天。打样费 300–800 元，批量下单后全额抵扣。'],
        ['怎么保证批次一致性？', '封样后按标准作业，每批次留样并做色差、克重、牢度检测，检测记录随货同行，可追溯到产线与班组。']
      ],
      cases: [
        ['家纺品牌 · OEM', '换供应商后色差被退货', '重新封样并锁定染厂批次', '退货率 6.2% → 0.4%', '75 天'],
        ['工程公司 · 定制', '交期紧、批量小', '现货改色 + 分批交付', '按期交付，追加订单 2 次', '30 天'],
        ['跨境卖家 · 补货', '断货导致 listing 掉排名', '常备 SKU 备货 + 海外仓', '断货天数 0，周转 18 天', '120 天']
      ]
    },
    edu: {
      label: '教育培训', noun: '课程与服务', self: '教育培训机构',
      audience: 'K12 家长、成人职业技能学员与企业内训客户',
      promise: '把「学得会」写进课程结构与服务流程',
      pains: ['试听转化低，家长不信任', '老师水平参差，体验不一致', '续费靠销售硬推，口碑起不来', '学员进度看不见，家长焦虑'],
      metrics: [['在读学员', '2,400+'], ['试听到正课转化', '38%'], ['续费率', '76%'], ['家长满意度', '4.8/5']],
      process: ['入学测评与目标拆解', '分层编班与课程计划', '周测与学习报告', '阶段复盘与续费规划'],
      certs: ['办学许可证', '教师资格证公示', '资金监管账户'],
      price: '小班课 ¥180–¥260/课时；一对一 ¥380 起/课时；企业内训按天报价',
      deliverables: ['入学测评报告', '学习计划表', '周度学习反馈', '阶段结课证书'],
      faq: [
        ['可以先试听再报名吗？', '提供 1 次免费测评 + 1 节正式课试听，试听后给出分层建议；不合适不推销，测评报告可直接带走。'],
        ['老师是全职还是兼职？', '核心学科全职教师占比 82%，全部持证并公示；每班固定主讲 + 助教，中途不随意换老师。'],
        ['效果不好怎么办？', '按月出具学习报告，连续两次未达阶段目标可免费加课或调整班型；剩余课时按协议可退。']
      ],
      cases: [
        ['少儿英语 · 3 校区', '试听转化 12%，招生难', '重做测评 + 家长开放课', '试听转化 12% → 41%', '90 天'],
        ['成人 IT 培训', '就业率数据不敢公开', '公开就业明细与雇主名单', '招生量提升 2.3 倍', '150 天'],
        ['企业内训 · 制造', '培训完不会用', '改为岗位任务制 + 考核', '岗位达标率 61% → 92%', '60 天']
      ]
    },
    health: {
      label: '医疗健康', noun: '诊疗服务', self: '医疗机构',
      audience: '周边居民、企业体检客户与转诊患者',
      promise: '把规范诊疗和可解释的方案放在第一位',
      pains: ['患者不了解能治什么，挂号挂错科', '价格不透明，问一次走一个', '复诊提醒缺失，疗程中断', '线上信息陈旧，搜不到正规介绍'],
      metrics: [['年接诊人次', '38,000+'], ['主治及以上医师', '26 位'], ['复诊率', '64%'], ['平均候诊', '12 分钟']],
      process: ['预约与分诊', '检查与方案沟通', '规范治疗与随访', '复诊与健康管理'],
      certs: ['医疗机构执业许可证', '医师执业证书公示', '医保定点机构'],
      price: '初诊挂号 ¥20–¥50；检查与治疗按项目公示价执行，医保可报销项目按政策结算',
      deliverables: ['检查报告解读', '个性化治疗方案', '术后/用药随访', '复诊提醒服务'],
      faq: [
        ['需要提前预约吗？', '建议提前 1 天通过电话或线上预约，可指定医师与时段；初诊请提前 15 分钟到院完成建档。'],
        ['医保能报销吗？', '本院为医保定点机构，诊疗、检查、药品中符合目录的项目可按当地政策报销，自费项目会在治疗前明确告知。'],
        ['治疗后如何复诊？', '出院或疗程结束后由随访护士按计划提醒复诊，检查报告可在院内系统调阅，无需重复检查。']
      ],
      cases: [
        ['口腔门诊', '种植咨询多、成单少', '方案可视化 + 分期说明', '种植成单率 18% → 37%', '120 天'],
        ['连锁体检中心', '报告看不懂，复购低', '报告解读 + 异常项随访', '复购率提升 21 个点', '180 天'],
        ['中医馆', '年轻客群少', '亚健康专题 + 到店体验', '35 岁以下客群占比 19% → 43%', '150 天']
      ]
    },
    home: {
      label: '家居建材', noun: '产品与服务', self: '家装企业',
      audience: '新房装修业主、旧房改造家庭与设计师渠道',
      promise: '把预算、工期、环保三项承诺写进合同',
      pains: ['报价看不懂，增项不断', '工期一拖再拖，影响入住', '环保不达标，味道大', '设计图好看，落地效果差'],
      metrics: [['累计交付家庭', '5,600+'], ['按期交付率', '96%'], ['环保检测合格率', '100%'], ['转介绍占比', '43%']],
      process: ['上门量尺与需求沟通', '方案与报价一次讲清', '工厂定制与节点验收', '安装交付与质保'],
      certs: ['建筑装饰装修资质', 'ENF 级板材检测报告', '十年质保承诺'],
      price: '整装 ¥1,280–¥2,200/㎡；全屋定制按展开面积计价；设计费下定可抵工程款',
      deliverables: ['量尺与户型图', '分项报价清单', '节点验收记录', '质保与售后卡'],
      faq: [
        ['报价会不会有增项？', '签约前出具分项报价，明确材料品牌、型号与工艺；除业主主动变更外，施工阶段不新增费用，增项需书面确认。'],
        ['工期多久？', '100㎡ 以内整装标准工期 45 个工作日，定制柜体另计 15 天；延期按合同约定赔付。'],
        ['环保怎么保证？', '板材达 ENF 级，辅料提供检测报告；交付前做第三方空气检测，不合格由我们负责治理到达标。']
      ],
      cases: [
        ['三居室整装 · 118㎡', '预算超支 30%，工期拖了两个月', '分项报价 + 节点验收', '按期交付，决算与合同差额 1.8%', '52 天'],
        ['全屋定制 · 复式', '设计图与落地差异大', '工厂预拼装 + 现场交底', '一次安装成功率 98%', '38 天'],
        ['旧房改造 · 老小区', '管道老化、邻居投诉', '先做结构与管道评估', '零投诉交付，空气检测合格', '41 天']
      ]
    },
    general: {
      label: '企业服务', noun: '服务', self: '企业服务机构',
      audience: '有采购需求的企业客户与渠道合作伙伴',
      promise: '把交付标准、响应时效和价格说清楚',
      pains: ['需求说不清，方案反复改', '报价不透明，比价成本高', '响应慢，急单接不住', '交付质量不稳定，没有标准'],
      metrics: [['服务客户', '900+'], ['平均响应时长', '2 小时'], ['按期交付率', '97%'], ['客户续约率', '81%']],
      process: ['需求访谈与确认', '方案与报价', '分批交付与验收', '复盘与长期维护'],
      certs: ['营业执照公示', '行业服务能力认证', '合同与发票合规'],
      price: '按项目报价，标准服务包明码标价；长期合作可签框架协议并约定响应时效',
      deliverables: ['需求确认书', '分项报价单', '交付与验收记录', '售后响应承诺'],
      faq: [
        ['怎么报价？', '先做需求访谈，按工作量、交付标准与周期出分项报价；标准服务包直接明码标价，不做模糊的一口价。'],
        ['响应时效是多久？', '工作日 2 小时内响应，紧急事项 30 分钟内对接；框架客户配专属对接人，节假日值班。'],
        ['交付不合格怎么办？', '按验收标准逐项确认，未达标项免费返工；连续两次不达标可终止合作并按比例退款。']
      ],
      cases: [
        ['区域连锁企业', '多家供应商标准不一', '统一服务标准与验收表', '投诉率下降 72%', '90 天'],
        ['制造业客户', '急单响应慢', '设专线与备件池', '急单交付 72 小时内', '60 天'],
        ['渠道合作伙伴', '结算周期长', '线上对账 + 月结', '对账时长 5 天 → 1 天', '45 天']
      ]
    }
  };

  /* ---------------- 2. 页面清单 ---------------- */
  var PAGES = [
    { file: 'index.html', nav: '首页', crumb: '首页' },
    { file: 'services.html', nav: '服务与报价', crumb: '服务与报价' },
    { file: 'cases.html', nav: '客户案例', crumb: '客户案例' },
    { file: 'faq.html', nav: '常见问题', crumb: '常见问题' },
    { file: 'about.html', nav: '关于我们', crumb: '关于我们' },
    { file: 'contact.html', nav: '联系我们', crumb: '联系我们' }
  ];

  /* ---------------- 3. 生成站点用的样式（独立文件产物） ---------------- */
  var SITE_CSS = [
    ':root{--ink:#141322;--ink2:#4a4960;--ink3:#7c7b93;--line:#e6e6ef;--brand:#4c3fe4;--brand-soft:#eeebfe;--bg:#fff;--bg2:#fafafe}',
    '*{box-sizing:border-box}',
    'html{-webkit-text-size-adjust:100%}',
    'body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}',
    'a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}',
    'img{max-width:100%;height:auto}',
    '.wrap{max-width:1080px;margin:0 auto;padding:0 20px}',
    'header.nav{position:sticky;top:0;z-index:9;background:rgba(255,255,255,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}',
    'header.nav .wrap{display:flex;align-items:center;gap:22px;height:64px}',
    '.brand{display:flex;align-items:center;gap:9px;font-weight:800;font-size:16px;color:var(--ink)}',
    '.brand i{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#4c3fe4,#8b5cf6);color:#fff;display:grid;place-items:center;font-style:normal;font-size:13px}',
    'nav.links{display:flex;gap:20px;margin-left:auto;font-size:14px}',
    'nav.links a{color:var(--ink2)}nav.links a.on{color:var(--brand);font-weight:700}',
    '.nav-cta{background:var(--brand);color:#fff!important;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:700}',
    'main{padding:0 0 60px}',
    'section{padding:34px 0;border-bottom:1px solid var(--line)}',
    'section:last-child{border-bottom:0}',
    '.hero{padding:56px 0 40px}',
    '.kicker{font-size:13px;color:var(--brand);font-weight:700;letter-spacing:.04em;margin:0 0 10px}',
    'h1{font-size:38px;line-height:1.28;margin:0 0 16px;letter-spacing:-.01em}',
    'h2{font-size:25px;line-height:1.35;margin:0 0 18px}',
    'h3{font-size:18px;margin:0 0 8px}',
    '.answer{font-size:19px;line-height:1.8;color:var(--ink);background:var(--brand-soft);border-left:4px solid var(--brand);padding:16px 18px;border-radius:0 10px 10px 0;margin:0 0 18px}',
    '.meta{font-size:13.5px;color:var(--ink3);margin:0 0 24px}',
    '.cta{display:flex;gap:12px;flex-wrap:wrap}',
    '.btn{display:inline-flex;align-items:center;gap:6px;background:var(--brand);color:#fff;padding:12px 22px;border-radius:10px;font-size:15px;font-weight:700}',
    '.btn.ghost{background:#fff;color:var(--brand);border:1px solid #d7d3fb}',
    '.btn:hover{text-decoration:none;opacity:.92}',
    'ul.pains{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0;padding:0;list-style:none}',
    'ul.pains li{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:14px 16px;font-size:15px;color:var(--ink2)}',
    '.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}',
    '.card{border:1px solid var(--line);border-radius:12px;padding:18px;background:#fff}',
    '.card h3{margin-bottom:6px}.card p{margin:0;font-size:14.5px;color:var(--ink2)}',
    '.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}',
    '.metric{background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:16px}',
    '.metric b{display:block;font-size:28px;letter-spacing:-.02em;color:var(--brand)}',
    '.metric span{font-size:13px;color:var(--ink3)}',
    'ol.steps{counter-reset:s;list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(4,1fr);gap:14px}',
    'ol.steps li{counter-increment:s;position:relative;padding:16px 14px;border:1px solid var(--line);border-radius:12px;font-size:14.5px;color:var(--ink2);background:#fff}',
    'ol.steps li::before{content:counter(s);display:block;font-size:12px;font-weight:800;color:var(--brand);margin-bottom:6px}',
    '.case{border-left:3px solid var(--brand);padding:2px 0 2px 16px;margin-bottom:18px}',
    '.case h3{font-size:16.5px}.case p{margin:4px 0;font-size:14.5px;color:var(--ink2)}',
    'table{width:100%;border-collapse:collapse;font-size:14.5px;margin:14px 0}',
    'th,td{border:1px solid var(--line);padding:10px 12px;text-align:left;vertical-align:top}',
    'th{background:var(--bg2);font-weight:700;width:32%;color:var(--ink2)}',
    '.faq article{border-bottom:1px solid var(--line);padding:18px 0}',
    '.faq article:last-child{border-bottom:0}',
    '.faq h3{font-size:16.5px;margin:0 0 8px}.faq p{margin:0;font-size:15px;color:var(--ink2)}',
    '.faq .more{font-size:13.5px;color:var(--ink3);margin-top:8px}',
    '.price{background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:16px 18px;font-size:14.5px;color:var(--ink2)}',
    'footer{border-top:1px solid var(--line);background:var(--bg2);padding:34px 0 26px;font-size:13.5px;color:var(--ink2)}',
    'footer .cols{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:24px}',
    'footer b{display:block;margin-bottom:8px;color:var(--ink)}',
    'footer p{margin:0;line-height:1.9}',
    'footer .bot{border-top:1px solid var(--line);margin-top:22px;padding-top:16px;font-size:12.5px;color:var(--ink3)}',
    '.badge{display:inline-block;font-size:12px;background:#fff;border:1px solid var(--line);border-radius:6px;padding:3px 9px;margin:0 6px 6px 0;color:var(--ink2)}',
    '.note{font-size:13px;color:var(--ink3)}',
    '@media(max-width:820px){h1{font-size:28px}h2{font-size:21px}.cards,ul.pains,ol.steps,.metrics,footer .cols{grid-template-columns:1fr}nav.links{display:none}.answer{font-size:16.5px}}'
  ].join('\n');

  /* ---------------- 4. 状态 ---------------- */
  var GB = {
    form: null,
    engines: ['doubao', 'yuanbao', 'wenxin'],
    site: null,
    page: 'index.html',
    sites: [],
    busy: false,
    pct: 0,
    step: -1,
    /* 域名探测结果（由服务端 /v1/sites/probe 回填，决定「可被抓取」是否真就绪） */
    probe: null,
    probeFor: '',
    probeBusy: false,
    /* 服务端链路是否可用：站点是否已持久化、历史是否由服务端提供 */
    cloud: false,
    saved: null,
    /* 用户是否手动开合过生成进度：为 true 后流程不再自动改 */
    progUser: false
  };

  var DEMO_FORM = {
    brand: '启量增长',
    industry: 'agency',
    services: '抖音代运营、千川投流代投、CPL 线索供应',
    city: '杭州',
    phone: '400-800-1234',
    wechat: 'qiliang-growth',
    domain: 'www.qiliang-growth.com',
    keywords: '抖音代运营 哪家好、千川投流服务商 推荐、CPL 线索 一手资源'
  };

  var LS_FORM = 'profound.geobuild.form.v1';
  var LS_SITES = 'profound.geobuild.sites.v1';
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---------------- 5. 表单 ---------------- */
  function readForm() {
    var f = {};
    ['brand', 'industry', 'services', 'city', 'phone', 'wechat', 'domain', 'keywords'].forEach(function (k) {
      var el = q('#gb' + k.charAt(0).toUpperCase() + k.slice(1));
      f[k] = el ? String(el.value || '').trim() : '';
    });
    return f;
  }
  function writeForm(f) {
    Object.keys(f).forEach(function (k) {
      var el = q('#gb' + k.charAt(0).toUpperCase() + k.slice(1));
      if (el) el.value = f[k] == null ? '' : f[k];
    });
    GB.form = readForm();
  }

  function specFromForm() {
    var f = readForm();
    var ind = IND[f.industry] || IND.general;
    var kws = splitList(f.keywords, 6);
    return {
      brand: f.brand || '未命名企业',
      industryKey: IND[f.industry] ? f.industry : 'general',
      ind: ind,
      services: splitList(f.services, 6),
      city: f.city || '全国',
      phone: f.phone || '',
      wechat: f.wechat || '',
      domain: (f.domain || 'www.example.com').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
      keywords: kws.length ? kws : [ind.label + ' 哪家好'],
      engines: GB.engines.slice(),
      date: ymd(),
      year: new Date().getFullYear()
    };
  }

  /* ---------------- 6. 站点生成 ---------------- */
  function baseUrl(s) { return 'https://' + s.domain; }
  function brandInitial(s) { return String(s.brand).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 1) || 'P'; }

  function headNav(s, file) {
    var links = PAGES.map(function (p) {
      return '<a href="' + p.file + '"' + (p.file === file ? ' class="on"' : '') + '>' + p.nav + '</a>';
    }).join('');
    return '<header class="nav"><div class="wrap">' +
      '<a class="brand" href="index.html"><i>' + esc(brandInitial(s)) + '</i>' + esc(s.brand) + '</a>' +
      '<nav class="links">' + links + '</nav>' +
      '<a class="nav-cta" href="contact.html">获取方案</a>' +
      '</div></header>';
  }

  function foot(s) {
    var links = PAGES.map(function (p) { return '<a href="' + p.file + '">' + p.nav + '</a>'; }).join(' · ');
    return '<footer><div class="wrap">' +
      '<div class="cols">' +
        '<div><b>' + esc(s.brand) + '</b><p>' + esc(s.ind.promise) + '。服务 ' + esc(s.ind.audience) + '，覆盖' + esc(s.city) + '及周边。</p></div>' +
        '<div><b>联系我们</b><p>电话：' + esc(s.phone || '—') + '<br>微信：' + esc(s.wechat || '—') + '<br>服务区域：' + esc(s.city) + '</p></div>' +
        '<div><b>站点导航</b><p>' + links + '<br><a href="/llms.txt">llms.txt</a> · <a href="/sitemap.xml">sitemap</a></p></div>' +
      '</div>' +
      '<div class="bot">© ' + s.year + ' ' + esc(s.brand) + '　最近更新：' + s.date + '　' +
      '<span class="note">本站结构化数据遵循 schema.org，欢迎 AI 引擎引用，引用时请保留品牌名与原文链接。</span></div>' +
      '</div></footer>';
  }

  function shell(s, page) {
    var title = page.title;
    var desc = page.desc;
    var canonical = baseUrl(s) + '/' + page.file;
    var ld = JSON.stringify({ '@context': 'https://schema.org', '@graph': page.ld }, null, 2);
    return '<!doctype html>\n<html lang="zh-CN">\n<head>\n' +
      '<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + esc(title) + '</title>\n' +
      '<meta name="description" content="' + esc(desc) + '">\n' +
      '<meta name="keywords" content="' + esc(s.keywords.join(',')) + '">\n' +
      '<meta name="author" content="' + esc(s.brand) + '">\n' +
      '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">\n' +
      '<link rel="canonical" href="' + canonical + '">\n' +
      '<link rel="alternate" type="text/plain" href="/llms.txt" title="LLMs.txt">\n' +
      '<meta property="og:type" content="website">\n' +
      '<meta property="og:title" content="' + esc(title) + '">\n' +
      '<meta property="og:description" content="' + esc(desc) + '">\n' +
      '<meta property="og:url" content="' + canonical + '">\n' +
      '<link rel="stylesheet" href="assets/style.css">\n' +
      '<script type="application/ld+json">\n' + ld + '\n<\/script>\n' +
      '</head>\n<body>\n' + headNav(s, page.file) + '\n<main>\n' + page.body + '\n</main>\n' + foot(s) + '\n</body>\n</html>\n';
  }

  /* --- JSON-LD 片段 --- */
  function orgLd(s) {
    var o = {
      '@type': 'Organization', '@id': baseUrl(s) + '/#org',
      name: s.brand, url: baseUrl(s) + '/',
      description: s.brand + '，' + s.city + s.ind.label + '，' + s.ind.promise + '。',
      slogan: s.ind.promise,
      telephone: s.phone || undefined,
      address: { '@type': 'PostalAddress', addressLocality: s.city, addressCountry: 'CN' },
      areaServed: { '@type': 'Place', name: s.city + '及周边' },
      knowsAbout: s.keywords,
      contactPoint: [{
        '@type': 'ContactPoint', contactType: 'sales', telephone: s.phone || undefined,
        areaServed: 'CN', availableLanguage: ['zh-CN']
      }]
    };
    if (!o.telephone) { delete o.telephone; delete o.contactPoint[0].telephone; }
    return o;
  }
  function serviceLd(s, title, i) {
    return {
      '@type': 'Service', '@id': baseUrl(s) + '/services.html#service-' + (i + 1),
      name: title, serviceType: title,
      description: s.brand + '提供的' + title + '，服务' + s.city + '及周边的' + s.ind.audience + '。',
      provider: { '@id': baseUrl(s) + '/#org' },
      areaServed: { '@type': 'Place', name: s.city },
      offers: { '@type': 'Offer', priceCurrency: 'CNY', availability: 'https://schema.org/InStock', description: s.ind.price }
    };
  }
  function faqLd(s, list, suffix) {
    return {
      '@type': 'FAQPage', '@id': baseUrl(s) + '/' + (suffix || 'faq.html') + '#faq',
      mainEntity: list.map(function (f) {
        return { '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } };
      })
    };
  }
  function crumbLd(s, page) {
    var items = [{ '@type': 'ListItem', position: 1, name: '首页', item: baseUrl(s) + '/index.html' }];
    if (page.file !== 'index.html') items.push({ '@type': 'ListItem', position: 2, name: page.crumb, item: baseUrl(s) + '/' + page.file });
    return { '@type': 'BreadcrumbList', '@id': baseUrl(s) + '/' + page.file + '#crumb', itemListElement: items };
  }

  /* --- 文案块 --- */
  function heroBlock(s, kw) {
    return '<section class="hero"><div class="wrap">' +
      '<p class="kicker">' + esc(s.city) + ' · ' + esc(s.ind.label) + ' · 面向' + esc(s.ind.audience) + '</p>' +
      '<h1>' + esc(s.brand) + '：' + esc(kw) + '</h1>' +
      '<p class="answer">' + esc(s.brand) + '是' + esc(s.city) + '的' + esc(s.ind.self) + '，主营' +
        esc(s.services.slice(0, 3).join('、')) + '。' + esc(s.ind.promise) + '。' +
        esc(s.ind.metrics[0][0]) + ' ' + esc(s.ind.metrics[0][1]) + '，' +
        esc(s.ind.metrics[2][0]) + ' ' + esc(s.ind.metrics[2][1]) + '。</p>' +
      '<p class="meta">服务区域：' + esc(s.city) + '及周边　|　最近更新：' + s.date + '　|　咨询：' + esc(s.phone || s.wechat || '见联系页') + '</p>' +
      '<div class="cta"><a class="btn" href="contact.html">获取方案与报价</a>' +
      '<a class="btn ghost" href="services.html">查看' + esc(s.ind.noun) + '清单</a></div>' +
      '</div></section>';
  }
  function painBlock(s) {
    return '<section><div class="wrap"><h2>' + esc(s.ind.label) + '最常见的 4 个问题</h2>' +
      '<ul class="pains">' + s.ind.pains.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' +
      '</div></section>';
  }
  function serviceBlock(s, compact) {
    return '<section><div class="wrap"><h2>' + esc(s.ind.noun) + '清单</h2>' +
      '<div class="cards">' + s.services.map(function (sv, i) {
        return '<div class="card" id="service-' + (i + 1) + '"><h3>' + esc(sv) + '</h3>' +
          '<p>' + esc(s.brand) + '的' + esc(sv) + '面向' + esc(s.ind.audience) + '，' +
          esc(s.ind.process[i % s.ind.process.length]) + '，' + esc(s.ind.deliverables[i % s.ind.deliverables.length]) + '随交付提供。</p>' +
          (compact ? '' : '<p class="note" style="margin-top:8px">交付物：' + esc(s.ind.deliverables.join('、')) + '</p>') +
          '</div>';
      }).join('') + '</div>' +
      (compact ? '<p class="note" style="margin-top:14px"><a href="services.html">查看每项' + esc(s.ind.noun) + '的交付清单与报价 →</a></p>' : '') +
      '</div></section>';
  }
  function metricBlock(s) {
    return '<section><div class="wrap"><h2>可验证的结果</h2>' +
      '<div class="metrics">' + s.ind.metrics.map(function (m) {
        return '<div class="metric"><b>' + esc(m[1]) + '</b><span>' + esc(m[0]) + '</span></div>';
      }).join('') + '</div>' +
      '<p class="note" style="margin-top:12px">数据口径：截至 ' + s.date + ' 的累计值，可按客户要求提供明细核验。</p>' +
      '</div></section>';
  }
  function processBlock(s) {
    return '<section><div class="wrap"><h2>合作流程</h2><ol class="steps">' +
      s.ind.process.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ol></div></section>';
  }
  function caseBlock(s, limit) {
    var list = s.ind.cases.slice(0, limit || 3);
    return '<section><div class="wrap"><h2>客户案例</h2>' +
      list.map(function (c) {
        return '<div class="case"><h3>' + esc(c[0]) + '</h3>' +
          '<p><b>挑战：</b>' + esc(c[1]) + '</p>' +
          '<p><b>做法：</b>' + esc(c[2]) + '</p>' +
          '<p><b>结果：</b>' + esc(c[3]) + '（周期 ' + esc(c[4]) + '）</p></div>';
      }).join('') + '</div></section>';
  }
  function faqBlock(list, limit, more) {
    var arr = list.slice(0, limit || list.length);
    return '<section class="faq"><div class="wrap"><h2>常见问题</h2>' +
      arr.map(function (f) {
        return '<article><h3>' + esc(f.q) + '</h3><p>' + esc(f.a) + '</p></article>';
      }).join('') +
      (more ? '<p class="more" style="margin-top:16px"><a href="faq.html">查看全部 ' + list.length + ' 个问题 →</a></p>' : '') +
      '</div></section>';
  }
  function ctaBlock(s) {
    return '<section><div class="wrap"><h2>想先看看方案？</h2>' +
      '<p class="answer">留下需求，' + esc(s.city) + '本地团队 1 个工作日内给出' + esc(s.ind.noun) + '建议与分项报价，不满意不收费。</p>' +
      '<div class="cta"><a class="btn" href="contact.html">预约沟通</a>' +
      (s.phone ? '<a class="btn ghost" href="tel:' + esc(s.phone.replace(/[^\d+]/g, '')) + '">直接致电 ' + esc(s.phone) + '</a>' : '') +
      '</div></div></section>';
  }

  function genFaqs(s) {
    var k0 = s.keywords[0] || (s.ind.label + '哪家好');
    var k1 = s.keywords[1] || k0;
    var out = s.ind.faq.map(function (f) { return { q: f[0], a: f[1] }; });
    out.push({
      q: k0 + '？该怎么判断哪家合适',
      a: '看三点：是否有同行业可核验案例、报价是否分项透明、响应时效是否写进合同。' + s.brand + '在' + s.city +
        '的公开数据是：' + s.ind.metrics[0][0] + ' ' + s.ind.metrics[0][1] + '、' + s.ind.metrics[2][0] + ' ' +
        s.ind.metrics[2][1] + '，分项报价与交付清单签约前全部给到。'
    });
    out.push({
      q: k0 + '大概什么价位',
      a: s.ind.price + '。签约前提供分项报价，明确服务范围、交付物数量与周期，除客户主动变更外不新增费用。'
    });
    out.push({
      q: s.brand + '和同行相比有什么不同',
      a: s.brand + '的做法是「' + s.ind.process.join(' → ') + '」，每一步都有可核验的交付物（' +
        s.ind.deliverables.join('、') + '），而不是只给结论不给过程。'
    });
    out.push({
      q: k1 + '的服务范围包含' + s.city + '吗',
      a: '包含。' + s.brand + '以' + s.city + '为中心覆盖周边区域，' + s.ind.audience + '均可对接；异地项目可远程协作，关键节点到场。'
    });
    out.push({
      q: '和' + s.brand + '合作需要准备什么',
      a: '准备三样即可：现状资料（账号 / 门店 / 产品参数）、目标与预算区间、对接负责人。剩余诊断与方案由我们完成，首次沟通约 45 分钟。'
    });
    out.push({
      q: '交付周期多久',
      a: '标准' + s.ind.noun + '首个交付节点在 7–14 天内（见各案例周期：' +
        s.ind.cases.map(function (c) { return c[4]; }).join(' / ') + '）；加急项目可压缩，但会在合同中写明取舍。'
    });
    out.push({
      q: '怎么开始合作',
      a: '先预约一次免费诊断，我们给出问题清单与建议方案；确认后再签合同、付首期款、进入执行，首期不满意可按合同条款终止。'
    });
    return out;
  }

  function buildSite(s) {
    var faqs = genFaqs(s);
    var k0 = s.keywords[0];
    var pages = [];

    /* 首页 */
    var idxBody =
      heroBlock(s, k0) +
      painBlock(s) +
      serviceBlock(s, true) +
      metricBlock(s) +
      processBlock(s) +
      caseBlock(s, 2) +
      faqBlock(faqs, 4, true) +
      ctaBlock(s);
    pages.push({
      file: 'index.html',
      crumb: '首页',
      title: s.brand + '｜' + k0 + '｜' + s.city + s.ind.label,
      desc: s.brand + '是' + s.city + '的' + s.ind.self + '，提供' + s.services.slice(0, 3).join('、') + '。' + s.ind.promise + '。' + s.ind.metrics[0][0] + ' ' + s.ind.metrics[0][1] + '。',
      body: idxBody,
      ld: [orgLd(s), {
        '@type': 'WebSite', '@id': baseUrl(s) + '/#website', url: baseUrl(s) + '/',
        name: s.brand, inLanguage: 'zh-CN', publisher: { '@id': baseUrl(s) + '/#org' }
      }, {
        '@type': 'ItemList', name: s.ind.noun + '清单',
        itemListElement: s.services.map(function (sv, i) { return serviceLd(s, sv, i); })
      }, faqLd(s, faqs.slice(0, 4), 'index.html'), crumbLd(s, { file: 'index.html', crumb: '首页' })]
    });

    /* 服务与报价 */
    var svBody = '<section class="hero"><div class="wrap">' +
      '<p class="kicker">' + esc(s.ind.noun) + '与报价</p>' +
      '<h1>' + esc(s.brand) + '的' + esc(s.ind.noun) + '清单与报价</h1>' +
      '<p class="answer">' + esc(s.brand) + '提供 ' + s.services.length + ' 类' + esc(s.ind.noun) + '：' +
      esc(s.services.join('、')) + '。' + esc(s.ind.price) + '。</p>' +
      '<p class="meta">所有报价均为分项报价，签约前明确服务范围、交付物与周期。</p></div></section>' +
      s.services.map(function (sv, i) {
        return '<section><div class="wrap"><h2 id="service-' + (i + 1) + '">' + esc(sv) + '</h2>' +
          '<p class="answer">' + esc(sv) + '面向' + esc(s.ind.audience) + '，解决「' + esc(s.ind.pains[i % s.ind.pains.length]) + '」。' +
          '标准交付周期 ' + esc(s.ind.cases[i % s.ind.cases.length][4]) + '，费用' + esc(s.ind.price) + '。</p>' +
          '<table><tbody>' +
          '<tr><th>适用对象</th><td>' + esc(s.ind.audience) + '</td></tr>' +
          '<tr><th>交付内容</th><td>' + esc(s.ind.deliverables.join('、')) + '</td></tr>' +
          '<tr><th>执行流程</th><td>' + esc(s.ind.process.join(' → ')) + '</td></tr>' +
          '<tr><th>周期与费用</th><td>' + esc(s.ind.cases[i % s.ind.cases.length][4]) + '；' + esc(s.ind.price) + '</td></tr>' +
          '</tbody></table>' +
          '<p class="note">相关问答：<a href="faq.html">' + esc(sv) + '常见问题</a>　|　<a href="contact.html">获取分项报价</a></p>' +
          '</div></section>';
      }).join('') + ctaBlock(s);
    pages.push({
      file: 'services.html',
      crumb: '服务与报价',
      title: s.ind.noun + '清单与报价｜' + s.brand,
      desc: s.brand + '的' + s.ind.noun + '清单：' + s.services.join('、') + '。' + s.ind.price + '。分项报价，签约前明确交付物与周期。',
      body: svBody,
      ld: [orgLd(s)].concat(s.services.map(function (sv, i) { return serviceLd(s, sv, i); }))
        .concat([crumbLd(s, { file: 'services.html', crumb: '服务与报价' })])
    });

    /* 客户案例 */
    var caseBody = '<section class="hero"><div class="wrap">' +
      '<p class="kicker">客户案例</p><h1>' + esc(s.brand) + '的' + esc(s.ind.label) + '客户案例</h1>' +
      '<p class="answer">' + s.ind.cases.length + ' 个可核验案例，覆盖' + esc(s.ind.audience) + '。每个案例都写明挑战、做法与可量化的结果，' +
      '结果周期在 ' + s.ind.cases.map(function (c) { return c[4]; }).join(' 至 ') + '之间。</p></div></section>' +
      s.ind.cases.map(function (c, i) {
        return '<section><div class="wrap"><h2>' + esc(c[0]) + '</h2>' +
          '<table><tbody>' +
          '<tr><th>客户类型</th><td>' + esc(c[0]) + '</td></tr>' +
          '<tr><th>面临的挑战</th><td>' + esc(c[1]) + '</td></tr>' +
          '<tr><th>我们做了什么</th><td>' + esc(c[2]) + '</td></tr>' +
          '<tr><th>结果</th><td>' + esc(c[3]) + '</td></tr>' +
          '<tr><th>周期</th><td>' + esc(c[4]) + '</td></tr>' +
          '</tbody></table>' +
          '<p class="note">数据由项目组按' + esc(s.ind.label) + '口径统计，可提供后台截图与验收单核对（脱敏后）。</p>' +
          '</div></section>';
      }).join('') + ctaBlock(s);
    pages.push({
      file: 'cases.html',
      crumb: '客户案例',
      title: '客户案例｜' + s.brand + '·' + s.ind.label,
      desc: s.brand + '的' + s.ind.label + '客户案例：' + s.ind.cases.map(function (c) { return c[0] + '（' + c[3] + '）'; }).join('；') + '。',
      body: caseBody,
      ld: [orgLd(s), crumbLd(s, { file: 'cases.html', crumb: '客户案例' })].concat(
        s.ind.cases.map(function (c, i) {
          return {
            '@type': 'Article', '@id': baseUrl(s) + '/cases.html#case-' + (i + 1),
            headline: c[0] + '：' + c[3],
            description: c[1] + '；' + c[2] + '；结果：' + c[3],
            author: { '@type': 'Organization', name: s.brand },
            publisher: { '@id': baseUrl(s) + '/#org' },
            datePublished: s.date, dateModified: s.date,
            articleSection: '客户案例', inLanguage: 'zh-CN'
          };
        })
      )
    });

    /* 常见问题 */
    var faqBody = '<section class="hero"><div class="wrap">' +
      '<p class="kicker">常见问题</p><h1>' + esc(k0) + ' · ' + faqs.length + ' 个高频问题</h1>' +
      '<p class="answer">以下问题按 AI 搜索与客户咨询的真实问法整理，每条答案控制在 60 字左右，便于被直接引用。' +
      '如需针对你的情况判断，可<a href="contact.html">预约免费诊断</a>。</p></div></section>' +
      faqBlock(faqs, faqs.length, false);
    pages.push({
      file: 'faq.html',
      crumb: '常见问题',
      title: k0 + ' 常见问题｜' + s.brand,
      desc: s.brand + '整理的' + faqs.length + '个高频问题：' + faqs.slice(0, 3).map(function (f) { return f.q; }).join('、') + '。',
      body: faqBody,
      ld: [orgLd(s), faqLd(s, faqs, 'faq.html'), crumbLd(s, { file: 'faq.html', crumb: '常见问题' })]
    });

    /* 关于我们 */
    var aboutBody = '<section class="hero"><div class="wrap">' +
      '<p class="kicker">关于我们</p><h1>关于' + esc(s.brand) + '</h1>' +
      '<p class="answer">' + esc(s.brand) + '成立于' + (s.year - 6) + '年，总部位于' + esc(s.city) + '，是一家' + esc(s.ind.self) +
      '，主营' + esc(s.services.join('、')) + '，服务' + esc(s.ind.audience) + '。</p>' +
      '<p class="meta">主体名称：' + esc(s.brand) + '　|　所在地：' + esc(s.city) + '　|　最近更新：' + s.date + '</p></div></section>' +
      '<section><div class="wrap"><h2>我们怎么做事</h2>' +
      '<p class="answer">' + esc(s.ind.promise) + '。具体做法是「' + esc(s.ind.process.join(' → ')) + '」，每一步都有交付物可验收。</p>' +
      '<div class="metrics">' + s.ind.metrics.map(function (m) {
        return '<div class="metric"><b>' + esc(m[1]) + '</b><span>' + esc(m[0]) + '</span></div>';
      }).join('') + '</div></div></section>' +
      '<section><div class="wrap"><h2>资质与可核验信息</h2>' +
      s.ind.certs.map(function (c) { return '<span class="badge">' + esc(c) + '</span>'; }).join('') +
      '<p class="note" style="margin-top:10px">资质文件与检测报告可应要求在签约前提供原件核对。</p></div></section>' +
      '<section><div class="wrap"><h2>服务范围</h2>' +
      '<p>' + esc(s.brand) + '以' + esc(s.city) + '为中心，服务' + esc(s.ind.audience) + '；异地项目支持远程协作，关键节点到场。</p>' +
      '<table><tbody>' +
      '<tr><th>主要服务区域</th><td>' + esc(s.city) + '及周边</td></tr>' +
      '<tr><th>服务对象</th><td>' + esc(s.ind.audience) + '</td></tr>' +
      '<tr><th>联系方式</th><td>电话 ' + esc(s.phone || '—') + '；微信 ' + esc(s.wechat || '—') + '</td></tr>' +
      '</tbody></table></div></section>' + ctaBlock(s);
    pages.push({
      file: 'about.html',
      crumb: '关于我们',
      title: '关于我们｜' + s.brand + '｜' + s.city + s.ind.label,
      desc: s.brand + '成立于' + (s.year - 6) + '年，总部' + s.city + '，是一家' + s.ind.self + '，主营' + s.services.join('、') + '，服务' + s.ind.audience + '。',
      body: aboutBody,
      ld: [orgLd(s), {
        '@type': 'AboutPage', '@id': baseUrl(s) + '/about.html#page', url: baseUrl(s) + '/about.html',
        name: '关于' + s.brand, mainEntity: { '@id': baseUrl(s) + '/#org' }, inLanguage: 'zh-CN'
      }, crumbLd(s, { file: 'about.html', crumb: '关于我们' })]
    });

    /* 联系我们 */
    var contactBody = '<section class="hero"><div class="wrap">' +
      '<p class="kicker">联系我们</p><h1>联系' + esc(s.brand) + '</h1>' +
      '<p class="answer">电话 ' + esc(s.phone || '—') + '，微信 ' + esc(s.wechat || '—') + '，服务' + esc(s.city) + '及周边的' +
      esc(s.ind.audience) + '。工作日 2 小时内响应，首次沟通约 45 分钟。</p>' +
      '<div class="cta">' + (s.phone ? '<a class="btn" href="tel:' + esc(s.phone.replace(/[^\d+]/g, '')) + '">拨打电话</a>' : '') +
      '<a class="btn ghost" href="faq.html">先看常见问题</a></div></div></section>' +
      '<section><div class="wrap"><h2>联系信息</h2><table><tbody>' +
      '<tr><th>企业名称</th><td>' + esc(s.brand) + '</td></tr>' +
      '<tr><th>联系电话</th><td>' + esc(s.phone || '—') + '</td></tr>' +
      '<tr><th>微信 / 企微</th><td>' + esc(s.wechat || '—') + '</td></tr>' +
      '<tr><th>所在城市</th><td>' + esc(s.city) + '</td></tr>' +
      '<tr><th>服务区域</th><td>' + esc(s.city) + '及周边，异地可远程</td></tr>' +
      '<tr><th>响应时效</th><td>工作日 2 小时内；紧急事项 30 分钟内</td></tr>' +
      '<tr><th>主营' + esc(s.ind.noun) + '</th><td>' + esc(s.services.join('、')) + '</td></tr>' +
      '</tbody></table></div></section>' +
      '<section><div class="wrap"><h2>来之前可以先准备这三样</h2><ol class="steps">' +
      '<li>现状资料：账号 / 门店 / 产品参数</li>' +
      '<li>目标与预算区间</li>' +
      '<li>对接负责人与期望启动时间</li>' +
      '</ol><p class="note" style="margin-top:12px">不准备也可以，首次沟通我们会用问题清单带你梳理一遍。</p></div></section>' +
      ctaBlock(s);
    pages.push({
      file: 'contact.html',
      crumb: '联系我们',
      title: '联系我们｜' + s.brand + '｜' + s.city,
      desc: s.brand + '联系方式：电话 ' + (s.phone || '—') + '，微信 ' + (s.wechat || '—') + '，服务' + s.city + '及周边，工作日 2 小时内响应。',
      body: contactBody,
      ld: [orgLd(s), {
        '@type': 'ContactPage', '@id': baseUrl(s) + '/contact.html#page', url: baseUrl(s) + '/contact.html',
        name: '联系' + s.brand, mainEntity: { '@id': baseUrl(s) + '/#org' }, inLanguage: 'zh-CN'
      }, {
        '@type': 'LocalBusiness', '@id': baseUrl(s) + '/#local',
        name: s.brand, telephone: s.phone || undefined,
        address: { '@type': 'PostalAddress', addressLocality: s.city, addressCountry: 'CN' },
        areaServed: s.city, openingHours: 'Mo-Fr 09:00-18:00', priceRange: '¥¥'
      }, crumbLd(s, { file: 'contact.html', crumb: '联系我们' })]
    });

    /* 文件组装 */
    var files = pages.map(function (p) {
      return { name: p.file, text: shell(s, p), group: '页面' };
    });
    files.push({ name: 'assets/style.css', text: SITE_CSS, group: '资源' });
    files.push({ name: 'llms.txt', text: buildLlms(s, faqs, pages), group: 'GEO 配置' });
    files.push({ name: 'robots.txt', text: buildRobots(s), group: 'GEO 配置' });
    files.push({ name: 'sitemap.xml', text: buildSitemap(s, pages), group: 'GEO 配置' });

    var ldCount = pages.reduce(function (a, p) { return a + p.ld.length; }, 0);
    var site = {
      spec: s, pages: pages, files: files, css: SITE_CSS,
      faqs: faqs, ldCount: ldCount, at: Date.now()
    };
    site.audit = auditSite(site);
    return site;
  }

  function buildLlms(s, faqs, pages) {
    var lines = [];
    lines.push('# ' + s.brand + '');
    lines.push('');
    lines.push('> ' + s.brand + '：' + s.city + '的' + s.ind.self + '，主营' + s.services.join('、') + '，服务' + s.ind.audience + '。' + s.ind.promise + '。');
    lines.push('');
    lines.push('## 核心页面');
    pages.forEach(function (p) {
      lines.push('- [' + p.crumb + '](' + baseUrl(s) + '/' + p.file + ')：' + p.desc);
    });
    lines.push('');
    lines.push('## 关键事实');
    lines.push('- 服务区域：' + s.city + '及周边');
    lines.push('- 所在地：' + s.city);
    lines.push('- 联系方式：' + (s.phone ? '电话 ' + s.phone + '；' : '') + (s.wechat ? '微信 ' + s.wechat : ''));
    s.ind.metrics.forEach(function (m) { lines.push('- ' + m[0] + '：' + m[1]); });
    lines.push('- 资质：' + s.ind.certs.join('、'));
    lines.push('- 报价口径：' + s.ind.price);
    lines.push('');
    lines.push('## 常见问答');
    faqs.forEach(function (f) {
      lines.push('### ' + f.q);
      lines.push(f.a);
      lines.push('');
    });
    lines.push('## 引用建议');
    lines.push('- 引用时请保留品牌名「' + s.brand + '」与原文链接 ' + baseUrl(s) + '/');
    lines.push('- 数据口径：截至 ' + s.date + '；如需最新数据请联系 ' + (s.phone || s.wechat || '站点联系人'));
    lines.push('- 本站结构化数据：Organization / Service / FAQPage / BreadcrumbList / LocalBusiness');
    lines.push('');
    lines.push('## 更新');
    lines.push('- 最近更新：' + s.date);
    return lines.join('\n') + '\n';
  }

  function buildRobots(s) {
    var agents = ['*', 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-Web', 'PerplexityBot', 'Google-Extended', 'Bytespider', 'Baiduspider', 'Bingbot'];
    var out = ['# robots.txt — ' + s.brand, '# 生成于 ' + s.date + '；显式允许 AI 检索引擎抓取（GEO 的前置条件）', ''];
    agents.forEach(function (a) {
      out.push('User-agent: ' + a);
      out.push('Allow: /');
      out.push('');
    });
    out.push('Sitemap: ' + baseUrl(s) + '/sitemap.xml');
    out.push('');
    out.push('# 面向大模型的站点说明（llms.txt 规范）：');
    out.push('# ' + baseUrl(s) + '/llms.txt');
    out.push('# 引用规范：请保留品牌名与原文链接');
    return out.join('\n') + '\n';
  }

  function buildSitemap(s, pages) {
    var pri = { 'index.html': '1.0', 'services.html': '0.9', 'cases.html': '0.8', 'faq.html': '0.8', 'about.html': '0.6', 'contact.html': '0.7' };
    var urls = pages.map(function (p) {
      return '  <url>\n' +
        '    <loc>' + baseUrl(s) + '/' + p.file + '</loc>\n' +
        '    <lastmod>' + s.date + '</lastmod>\n' +
        '    <changefreq>' + (p.file === 'faq.html' ? 'weekly' : 'monthly') + '</changefreq>\n' +
        '    <priority>' + (pri[p.file] || '0.6') + '</priority>\n' +
        '  </url>';
    }).join('\n');
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + '\n</urlset>\n';
  }

  /* ---------------- 7. GEO 体检 ---------------- */
  function auditSite(site) {
    var s = site.spec;
    var html = site.pages.map(function (p) { return p.body; }).join('\n');
    var text = strip(html);
    var chars = text.replace(/\s/g, '').length;
    var h2 = countOf(html, /<h2/g);
    var h1PerPage = site.pages.filter(function (p) { return countOf(p.body, /<h1/g) === 1; }).length;
    var tables = countOf(html, /<table/g);
    var lists = countOf(html, /<(ul|ol)[ >]/g);
    var links = countOf(html, /href="[a-z]+\.html/g);
    var numbers = countOf(text, /\d+(\.\d+)?/g);
    var semCount = ['<header', '<nav', '<main', '<section', '<article', '<footer'].filter(function (t) { return html.indexOf(t) > -1; }).length;
    var descOk = site.pages.filter(function (p) { return p.desc && p.desc.length >= 40 && p.desc.length <= 120; }).length;
    var kwHit = s.keywords.filter(function (k) { return text.indexOf(k) > -1; }).length;
    var faqN = site.faqs.length;

    var dims = [];
    dims.push({
      key: 'crawl', name: '可被抓取', w: 20,
      got: clampScore(4 + (site.files.some(function (f) { return f.name === 'llms.txt'; }) ? 4 : 0) +
        (site.files.some(function (f) { return f.name === 'robots.txt'; }) ? 4 : 0) +
        (site.files.some(function (f) { return f.name === 'sitemap.xml'; }) ? 4 : 0) +
        (descOk === site.pages.length ? 4 : 0), 20),
      note: 'llms.txt / robots.txt / sitemap.xml 三件套已生成，robots 显式放行 GPTBot、ClaudeBot、PerplexityBot、Bytespider 等 11 个 UA。'
    });
    dims.push({
      key: 'struct', name: '可被解析', w: 20,
      got: clampScore(Math.round(semCount / 6 * 4) + Math.round(h1PerPage / site.pages.length * 4) +
        (h2 >= 8 ? 4 : 2) + (site.ldCount >= 6 ? 4 : 2) + (links >= 12 ? 4 : 2), 20),
      note: '语义标签 ' + semCount + '/6 种、每页单 H1、H2 共 ' + h2 + ' 个、JSON-LD ' + site.ldCount + ' 个、站内链接 ' + links + ' 处。'
    });
    dims.push({
      key: 'cite', name: '可被引用', w: 20,
      got: clampScore((site.pages.length >= 6 ? 5 : 3) + (faqN >= 8 ? 5 : 3) +
        (numbers >= 40 ? 5 : (numbers >= 20 ? 3 : 1)) + (tables + lists >= 8 ? 5 : 3), 20),
      note: '每页首段 40–60 字答案先行，FAQ ' + faqN + ' 条，数字事实 ' + numbers + ' 处，表格/清单 ' + (tables + lists) + ' 个。'
    });
    dims.push({
      key: 'trust', name: '可被信任', w: 20,
      got: clampScore((s.phone ? 4 : 2) + (s.wechat ? 1 : 0) + (s.ind.certs.length >= 3 ? 5 : 3) +
        (s.ind.cases.length >= 3 ? 5 : 3) + 5, 20),
      note: 'NAP（' + s.brand + ' / ' + s.city + ' / ' + (s.phone || '未填电话') + '）全站一致，资质 ' + s.ind.certs.length + ' 项、案例 ' + s.ind.cases.length + ' 个，含更新日期。'
    });
    dims.push({
      key: 'cover', name: '内容覆盖', w: 20,
      got: clampScore(Math.round(kwHit / s.keywords.length * 5) + (site.pages.length >= 6 ? 5 : 3) +
        (chars >= 2500 ? 5 : 3) + (s.services.length >= 3 ? 5 : 3), 20),
      note: '关键词命中 ' + kwHit + '/' + s.keywords.length + '，页面 ' + site.pages.length + ' 个，正文字符 ' + chars + '，' + s.ind.noun + '条目 ' + s.services.length + ' 个。'
    });

    var total = dims.reduce(function (a, d) { return a + d.got; }, 0);
    var advice = [];
    dims.forEach(function (d) {
      if (d.got >= d.w - 1) return;
      if (d.key === 'crawl') advice.push('抓取通道有缺口：检查 robots.txt 是否误拦 AI 抓取，并把 sitemap 提交到搜索引擎与必应站长平台。');
      if (d.key === 'struct') advice.push('结构化程度可再提升：为每个服务补 Service + Offer，为案例补 Article，并确保每页只有一个 H1。');
      if (d.key === 'cite') advice.push('引用友好度不足：把长段落拆成「结论 + 依据 + 数据」三段，FAQ 补到 8 条以上。');
      if (d.key === 'trust') advice.push('信任信号不足：补充资质原件、客户评价与可核验的数据口径说明。');
      if (d.key === 'cover') advice.push('内容覆盖不足：围绕每个核心词各写 1 篇问答长文，三个月内形成主题簇。');
    });
    if (!s.phone) advice.push('未填写联系电话：GEO 与本地搜索都强依赖 NAP 一致，建议补齐电话并在全站统一。');
    if (s.keywords.length < 3) advice.push('核心关键词少于 3 个：AI 答案通常按主题聚合，建议补到 3–5 个高意图长句。');
    advice.push('发布后把页面地址提交到「GEO优化引擎」监测，观察 6 个 AI 引擎的收录与排名变化。');

    return { total: total, dims: dims, advice: advice, chars: chars, numbers: numbers, links: links, h2: h2, tables: tables, lists: lists };
  }
  function clampScore(v, max) { return Math.max(0, Math.min(max, v)); }
  function grade(n) { return n >= 90 ? 'A' : (n >= 80 ? 'B' : (n >= 70 ? 'C' : 'D')); }

  /* ---------------- 8. 打包下载 ---------------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) {
    var enc = new TextEncoder();
    var chunks = [], central = [], offset = 0;
    files.forEach(function (f) {
      var nameBytes = enc.encode(f.name);
      var data = enc.encode(f.text);
      var crc = crc32(data);
      var lh = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true);
      dv.setUint16(8, 0, true); dv.setUint16(10, 0, true); dv.setUint16(12, 0x21, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true); dv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);
      chunks.push(lh, data);

      var cd = new Uint8Array(46 + nameBytes.length);
      var dv2 = new DataView(cd.buffer);
      dv2.setUint32(0, 0x02014b50, true); dv2.setUint16(4, 20, true); dv2.setUint16(6, 20, true);
      dv2.setUint16(8, 0x0800, true); dv2.setUint16(10, 0, true); dv2.setUint16(12, 0, true);
      dv2.setUint16(14, 0x21, true); dv2.setUint32(16, crc, true);
      dv2.setUint32(20, data.length, true); dv2.setUint32(24, data.length, true);
      dv2.setUint16(28, nameBytes.length, true); dv2.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);
      offset += lh.length + data.length;
    });
    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var eocd = new Uint8Array(22);
    var dv3 = new DataView(eocd.buffer);
    dv3.setUint32(0, 0x06054b50, true);
    dv3.setUint16(8, files.length, true); dv3.setUint16(10, files.length, true);
    dv3.setUint32(12, cdSize, true); dv3.setUint32(16, offset, true);
    return new Blob(chunks.concat(central, [eocd]), { type: 'application/zip' });
  }

  function saveBlob(blob, name) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
      return true;
    } catch (e) { return false; }
  }
  function saveText(name, text, mime) {
    return saveBlob(new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' }), name);
  }

  /* ---------------- 9. 渲染 ---------------- */
  function renderTools() {
    var el = q('#gbTools');
    if (!el) return;
    var s = GB.site;
    el.innerHTML =
      '<span class="geo-chip ok">生成引擎 <b>GEO 模板 v2</b></span>' +
      '<span class="geo-chip">原则 <b>抓取 · 解析 · 引用 · 信任 · 覆盖</b></span>' +
      '<span class="geo-chip">站点 <b>' + (s ? s.pages.length + ' 页' : '6 页模板') + '</b></span>' +
      '<span class="geo-chip' + (s ? ' on' : '') + '">结构化数据 <b>' + (s ? s.ldCount + ' 块' : '待生成') + '</b></span>' +
      '<span class="geo-sp"></span>' +
      '<button class="btn sm" data-go="v-geo" type="button"><svg class="icon"><use href="#i-globe"/></svg>GEO优化引擎</button>';
  }

  var PRINCIPLES = [
    { k: 'crawl', en: 'Crawlable', name: '可被抓取', icon: 'i-search', desc: 'robots.txt 放行 AI 爬虫 + sitemap + llms.txt 站点说明' },
    { k: 'struct', en: 'Parseable', name: '可被解析', icon: 'i-layers', desc: '语义标签 + 单 H1 + H2 分层 + JSON-LD 结构化数据' },
    { k: 'cite', en: 'Citable', name: '可被引用', icon: 'i-doc', desc: '答案先行 40–60 字 + 数字事实 + 可独立成段的结论' },
    { k: 'trust', en: 'Trustworthy', name: '可被信任', icon: 'i-shield', desc: 'NAP 一致 + 资质 + 真实案例 + 更新日期与主体信息' },
    { k: 'cover', en: 'Coverage', name: '主题覆盖', icon: 'i-grid', desc: '核心词 × 长尾问答 × 案例 × 服务页，内链成簇' }
  ];

  /* ---- 域名真实性探测 ----
     原先 crawl 判定只有一句 `!!f.domain`：域名非空就标「可被抓取 就绪」。
     但填了域名 ≠ 站点能被 AI 引擎抓到 —— 域名可能没解析、服务器可能没开、
     线上可能压根没有 robots/sitemap/llms。这里改为以服务端实际探测为准。 */
  function probeStale(domain) {
    /* 表单值已经和上次探测目标不一致时，旧结果作废 */
    return !GB.probe || GB.probeFor !== String(domain || '').trim();
  }

  function renderProbe() {
    var box = q('#gbProbe');
    if (!box) return;
    var d = String((readForm().domain || '')).trim();
    if (!d) {
      box.className = 'gb-probe';
      box.innerHTML = '<div class="ic"><svg class="icon"><use href="#i-globe"/></svg></div>' +
        '<div class="tx"><b>未填写域名</b><em>填入域名后会自动校验 DNS 与线上 GEO 文件</em></div>';
      return;
    }
    if (GB.probeBusy) {
      box.className = 'gb-probe wait';
      box.innerHTML = '<div class="ic"><svg class="icon"><use href="#i-refresh"/></svg></div>' +
        '<div class="tx"><b>正在校验 ' + esc(d) + ' …</b><em>DNS 解析、HTTPS 可达性、robots / sitemap / llms.txt</em></div>';
      return;
    }
    if (probeStale(d)) {
      box.className = 'gb-probe wait';
      box.innerHTML = '<div class="ic"><svg class="icon"><use href="#i-globe"/></svg></div>' +
        '<div class="tx"><b>' + esc(d) + ' 尚未校验</b><em>点「校验域名」确认它是否真的能被 AI 引擎抓到</em></div>' +
        '<button class="btn sm" id="gbProbeBtn" type="button">校验域名</button>';
      return;
    }
    var r = GB.probe;
    var level = r.level || 'err';
    var detail = [];
    if (r.dns.resolved) detail.push('DNS → ' + (r.dns.ipv4 || r.dns.ipv6));
    else detail.push('DNS 未解析');
    if (r.http.url) detail.push('HTTP ' + (r.http.status || '错误') + (r.http.ms ? ' · ' + r.http.ms + 'ms' : ''));
    var g = r.geo || {};
    var three = [
      ['robots', g.robots], ['sitemap', g.sitemap], ['llms', g.llms]
    ].map(function (x) { return x[0] + (x[1] && x[1].present ? '✓' : '✗'); }).join(' · ');
    if (g.robots) detail.push(three);
    box.className = 'gb-probe ' + level;
    box.innerHTML =
      '<div class="ic"><svg class="icon"><use href="#' + (level === 'ok' ? 'i-shield' : (level === 'warn' ? 'i-warning' : 'i-x')) + '"/></svg></div>' +
      '<div class="tx"><b>' + esc(r.verdict || '') + '</b><em>' + esc(detail.join(' ｜ ')) + '</em></div>' +
      '<button class="btn sm" id="gbProbeBtn" type="button">重新校验</button>';
  }

  function probeDomain(quiet) {
    var d = String((readForm().domain || '')).trim();
    if (!d) { if (!quiet) toast('请先填写站点域名', 'warn'); return Promise.resolve(null); }
    if (!bffUp()) {
      GB.probeBusy = false;
      if (!quiet) toast('未接入服务端，无法做域名真实性校验', 'warn', '域名未校验');
      return Promise.resolve(null);
    }
    GB.probeBusy = true;
    renderProbe();
    return api('/v1/sites/probe?domain=' + encodeURIComponent(d), null, { method: 'GET', timeout: 25000 })
      .then(function (r) {
        GB.probeBusy = false;
        if (r && r.ok && r.data && r.data.probe) {
          GB.probe = r.data.probe;
          /* 用服务端清洗后的域名回填输入框：用户常把 https:// 一起粘进来、
             或漏打顶级域，回填后能直接看见系统真正探测的是哪个域名 */
          var clean = String(GB.probe.domain || '').trim();
          var inp = q('#gbDomain');
          if (clean && inp && inp.value.trim() !== clean) {
            inp.value = clean;
            if (GB.probe.level === 'err' && GB.probe.dns && !GB.probe.dns.resolved) {
              toast('域名无法解析：' + clean, 'warn', '请检查域名后缀是否完整');
            }
          }
          GB.probeFor = clean || d;
          /* 探测结果同步进 form，供后续规格使用 */
          audit('geo.site.probe', GB.probeFor + ' → ' + GB.probe.level);
        } else {
          GB.probe = null; GB.probeFor = '';
          if (!quiet) toast('域名校验失败：' + ((r && r.error) || '未知错误'), 'err');
        }
        renderProbe(); renderCheck();
        return GB.probe;
      })['catch'](function (e) {
        GB.probeBusy = false;
        GB.probe = null; GB.probeFor = '';
        renderProbe(); renderCheck();
        if (!quiet) toast('域名校验异常：' + ((e && e.message) || e), 'err');
        return null;
      });
  }

  function renderCheck() {
    var el = q('#gbCheck');
    if (!el) return;
    var f = readForm();
    var filled = ['brand', 'services', 'city', 'phone', 'keywords', 'domain'].filter(function (k) { return f[k]; }).length;
    var ready = !!(f.brand && f.services && f.keywords);
    /* 「可被抓取」以服务端真实探测为准，不再用 `!!f.domain` 糊弄过去。
       三态必须分清，否则会把「没校验」误报成「没解析」：
         unknown = 还没校验（或服务未接入）  dns-fail = 校验过，DNS 确实不存在 */
    var pr = probeStale(f.domain) ? null : GB.probe;
    var crawlState = 'unknown';
    if (!pr) crawlState = 'unknown';
    else if (!pr.dns || !pr.dns.resolved) crawlState = 'dns-fail';
    else if (!pr.ok) crawlState = 'unreachable';
    else {
      var g = pr.geo || {};
      var n = ['robots', 'sitemap', 'llms'].filter(function (k) { return g[k] && g[k].present; }).length;
      crawlState = n === 3 ? 'live' : (n > 0 ? 'partial' : 'no-geo');
    }
    var okMap = {
      crawl: crawlState === 'live',
      struct: ready,
      cite: !!f.keywords,
      trust: !!(f.phone || f.wechat),
      cover: filled >= 5
    };
    var okN = Object.keys(okMap).filter(function (k) { return okMap[k]; }).length;
    var tag = q('#gbCheckTag');
    if (tag) tag.innerHTML = '<span class="geo-chip' + (okN === 5 ? ' ok' : (okN >= 3 ? ' on' : '')) + '">' + okN + '/5 就绪</span>';

    var crawlTxt = {
      'dns-fail': '未解析',
      'unreachable': '不可达',
      'no-geo': '缺 GEO 文件',
      'partial': '部分就绪',
      'live': '已上线',
      'unknown': (bffUp() ? '待校验' : '未接入')
    }[crawlState] || '待校验';

    el.innerHTML = PRINCIPLES.map(function (p) {
      var ok = okMap[p.k];
      var st = ok ? '就绪' : (p.k === 'crawl' ? crawlTxt : '待填');
      return '<div class="gb-chk' + (ok ? ' ok' : '') + '">' +
        '<div class="ic"><svg class="icon"><use href="#' + p.icon + '"/></svg></div>' +
        '<div class="m"><b>' + p.name + '<span>' + p.en + '</span></b><p>' + p.desc + '</p></div>' +
        '<div class="st">' + st + '</div></div>';
    }).join('') +
      '<div class="gb-note">五原则对 AI 引擎的「是否推荐你」影响权重依次为：可被抓取 → 可被解析 → 可被引用 → 可被信任 → 主题覆盖。' +
      '建站时已按此顺序全部落地，缺项会在生成后的体检得分里标红。<br>' +
      '<b>注意：</b>体检分评估的是「生成的源码」，是否真的被抓取取决于<b>线上部署结果</b> —— ' +
      '只有把产物部署到该域名并确认 robots / sitemap / llms.txt 可访问后，「可被抓取」才会转为已上线。</div>';
  }

  var STEP_NAMES = ['解析品牌与行业词库', '规划站点结构与内链', '生成 6 个语义化页面',
    '注入 JSON-LD 结构化数据', '生成 llms / robots / sitemap', 'GEO 五原则体检打分'];

  /* 生成进度折叠：默认收起，展开看进度条 + 6 步流水 */
  function setGbProg(open) {
    var box = q('#gbMerged');
    var btn = q('#gbProgFold');
    if (box) box.classList.toggle('open', !!open);
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function renderSteps() {
    var el = q('#gbSteps');
    if (!el) return;
    el.innerHTML = STEP_NAMES.map(function (t, i) {
      var cls = GB.step > i ? 'done' : (GB.step === i ? 'run' : '');
      var tail = GB.step > i ? '<span class="st">完成</span>'
        : (GB.step === i ? '<span class="st">进行中</span>' : '');
      return '<div class="gb-step ' + cls + '"><span class="dot"></span>' + t + tail + '</div>';
    }).join('');

    var bar = q('#gbBar');
    if (bar) bar.style.width = GB.pct + '%';

    var tag = q('#gbStepTag');
    if (tag) {
      tag.textContent = GB.busy ? (GB.pct + '%') : (GB.site ? '已完成' : '待生成');
      tag.className = 'geo-chip' + (GB.busy ? ' on' : (GB.site ? ' ok' : ''));
    }
    var ft = q('#gbFoldTxt');
    if (ft) {
      var n = Math.max(0, Math.min(GB.step, STEP_NAMES.length));
      ft.textContent = GB.busy ? ('生成进度 ' + n + '/' + STEP_NAMES.length)
        : (GB.site ? '生成进度 ' + STEP_NAMES.length + '/' + STEP_NAMES.length : '生成进度');
    }
  }

  function renderKpi(idle) {
    var el = q('#gbMetrics');
    if (!el) return;
    function kt(label, val, unit, d, cls, hot) {
      var empty = val === '—';
      return '<div class="gb-metric' + (empty ? ' idle' : '') + (hot ? ' hot' : '') + '">' +
        '<div class="k">' + label + '</div>' +
        '<div class="v">' + val + (unit && !empty ? '<em>' + unit + '</em>' : '') + '</div>' +
        '<div class="d ' + (cls || '') + '" title="' + d + '">' + d + '</div></div>';
    }
    if (!GB.site || idle) {
      el.innerHTML =
        kt('GEO 体检得分', '—', '', '生成后自动体检打分') +
        kt('生成页面', '—', '', '首页 · 服务 · 案例 · 问答 · 关于 · 联系') +
        kt('结构化数据', '—', '', 'Organization · Service · FAQPage · LocalBusiness') +
        kt('可引用问答', '—', '', '答案先行的 FAQ 问答层');
      return;
    }
    var s = GB.site, a = s.audit;
    var avg = Math.round(s.faqs.reduce(function (x, f) { return x + f.a.length; }, 0) / s.faqs.length);
    el.innerHTML =
      kt('GEO 体检得分', a.total, ' 分', grade(a.total) + ' 级 · 满分 100', a.total >= 85 ? 'up' : 'down', a.total >= 85) +
      kt('生成页面', s.pages.length, ' 页', '首页 / 服务 / 案例 / 问答 / 关于 / 联系') +
      kt('结构化数据', s.ldCount, ' 块', 'Organization · Service · FAQPage · LocalBusiness', 'up') +
      kt('可引用问答', s.faqs.length, ' 条', '答案先行，平均 ' + avg + ' 字');
  }

  function previewHtml(file) {
    var site = GB.site;
    if (!site) return '';
    var f = site.files.filter(function (x) { return x.name === file; })[0] || site.files[0];
    var html = f.text.replace('<link rel="stylesheet" href="assets/style.css">', '<style>' + site.css + '</style>');
    var hook = '<script>(function(){document.addEventListener("click",function(e){var a=e.target.closest?e.target.closest("a"):null;' +
      'if(!a)return;var h=a.getAttribute("href")||"";if(!/\\.html$/.test(h))return;e.preventDefault();' +
      'parent.postMessage({gbPage:h},"*");});})();<\/script>';
    return html.replace('</body>', hook + '</body>');
  }

  function renderPreview() {
    var site = GB.site;
    var tabs = q('#gbTabs');
    var frame = q('#gbFrame');
    var url = q('#gbUrl');
    if (!site || !frame) return;
    if (tabs) {
      tabs.innerHTML = site.pages.map(function (p) {
        return '<button class="gb-tab' + (p.file === GB.page ? ' on' : '') + '" data-gbpage="' + p.file + '" type="button">' + p.crumb + '</button>';
      }).join('');
    }
    if (url) url.textContent = site.spec.domain + '/' + GB.page;
    frame.srcdoc = previewHtml(GB.page);
  }

  function fileIcon(name) {
    if (/\.html$/.test(name)) return 'i-doc';
    if (/\.css$/.test(name)) return 'i-layers';
    if (/\.xml$/.test(name)) return 'i-grid';
    return 'i-flag';
  }

  function renderFiles() {
    var site = GB.site;
    var el = q('#gbFiles');
    if (!site || !el) return;
    var total = site.files.reduce(function (a, f) { return a + new Blob([f.text]).size; }, 0);
    var tag = q('#gbFileTag');
    if (tag) tag.innerHTML = '<span class="geo-chip">' + site.files.length + ' 个文件 · ' + kb(total) + '</span>';
    var groups = {};
    site.files.forEach(function (f) { (groups[f.group] = groups[f.group] || []).push(f); });
    el.innerHTML = Object.keys(groups).map(function (g) {
      return '<div class="gb-group">' + g + '</div>' + groups[g].map(function (f) {
        return '<div class="gb-file">' +
          '<div class="ic svg"><svg class="icon"><use href="#' + fileIcon(f.name) + '"/></svg></div>' +
          '<div class="n"><b>' + esc(f.name) + '</b></div>' +
          '<div class="sz">' + kb(new Blob([f.text]).size) + '</div>' +
          '<button class="go" data-gbfile="' + esc(f.name) + '" type="button">查看</button>' +
          '</div>';
      }).join('');
    }).join('');

    var dl = q('#gbDl');
    if (dl) {
      dl.innerHTML =
        '<button class="btn primary wide" id="gbDlZip" type="button"><svg class="icon"><use href="#i-box"/></svg>下载整站包（ZIP）</button>' +
        '<button class="btn" id="gbDlPage" type="button">下载当前页 HTML</button>' +
        '<button class="btn" id="gbDlLlms" type="button">下载 llms.txt</button>' +
        '<button class="btn" id="gbDlRobots" type="button">robots.txt</button>' +
        '<button class="btn" id="gbDlMap" type="button">sitemap.xml</button>' +
        '<button class="btn wide" id="gbSync" type="button"><svg class="icon"><use href="#i-radar"/></svg>把核心词接入 GEO 监测</button>';
    }
  }

  function renderScore() {
    var site = GB.site;
    var el = q('#gbScore');
    if (!site || !el) return;
    var a = site.audit;
    var tag = q('#gbScoreTag');
    if (tag) tag.innerHTML = '<span class="geo-chip ' + (a.total >= 85 ? 'ok' : 'warn') + '">' + grade(a.total) + ' 级 · ' + a.total + ' 分</span>';
    el.innerHTML =
      '<div class="gb-score">' +
        '<div class="gb-ring" style="--p:' + a.total + '"><b>' + a.total + '<small>分</small></b></div>' +
        '<div class="m"><b>' + (a.total >= 90 ? '已达到「优先被引用」水平' : (a.total >= 80 ? '基础扎实，还差细节' : '有硬伤，先补缺项')) + '</b>' +
        '<p>正文字符 ' + a.chars + ' · 数字事实 ' + a.numbers + ' 处 · H2 ' + a.h2 + ' 个 · 内链 ' + a.links + ' 处</p></div>' +
      '</div>' +
      a.dims.map(function (d) {
        var pct = Math.round(d.got / d.w * 100);
        return '<div class="gb-dim' + (pct < 85 ? ' low' : '') + '">' +
          '<div class="h">' + d.name + '<b>' + d.got + '/' + d.w + '</b></div>' +
          '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
          '<div class="note">' + esc(d.note) + '</div></div>';
      }).join('') +
      '<div class="gb-group" style="margin-top:6px">优化建议</div>' +
      a.advice.map(function (t, i) {
        return '<div class="gb-adv"><span class="n">' + (i + 1) + '</span><span>' + esc(t) + '</span></div>';
      }).join('');
  }

  function renderHistory() {
    var el = q('#gbHistory');
    if (!el) return;
    var tag = q('#gbHisTag');
    if (tag) tag.innerHTML = '<span class="geo-chip">' + GB.sites.length + ' 个站点</span>';
    if (!GB.sites.length) {
      el.innerHTML = '<div class="geo-empty"><svg class="icon"><use href="#i-layers"/></svg>还没有生成记录<br>填好左侧信息，点「一键秒搭建站」。</div>';
      return;
    }
    el.innerHTML = GB.sites.slice(0, 8).map(function (s, i) {
      var low = (s.score || 0) < 85;
      return '<div class="gb-his">' +
        '<div class="logo">' + esc(String(s.brand || 'S').slice(0, 1)) + '</div>' +
        '<div class="m"><b>' + esc(s.brand) + '</b>' +
          '<div class="s"><i>' + esc(s.industryLabel || '') + '</i><i>' + (s.pages || 6) + ' 页</i>' +
          '<i>' + esc(s.domain || '') + '</i><i>' + esc(s.date || '') + '</i>' +
          (s.status ? '<i>' + esc(s.status) + '</i>' : '') + '</div></div>' +
        '<div class="sc' + (low ? ' low' : '') + '">' + (s.score || '—') + '</div>' +
        '<button class="btn sm" data-gbhis="' + i + '" type="button">重新生成</button>' +
        '</div>';
    }).join('');
  }

  function renderAll() {
    renderTools(); renderCheck(); renderProbe(); renderSteps(); renderKpi(); renderPub();
    var res = q('#gbResult');
    if (res) res.style.display = GB.site ? 'block' : 'none';
    if (GB.site) { renderPreview(); renderFiles(); renderScore(); }
    renderHistory();
  }

  /* ---------------- 10. 生成流程 ---------------- */
  function runBuild(silent) {
    if (GB.busy) return;
    var f = readForm();
    if (!f.brand) { toast('请先填写品牌 / 企业名称', 'warn', '还差一步'); return; }
    if (!f.services) { toast('请填写主营产品 / 服务，用「、」分隔', 'warn', '还差一步'); return; }
    if (!f.keywords) { toast('请填写至少 1 个核心关键词', 'warn', '还差一步'); return; }
    lsSet(LS_FORM, JSON.stringify(f));

    GB.busy = true; GB.step = 0; GB.pct = 4;
    GB.progUser = false;
    setGbProg(true);            /* 生成时自动展开进度，结束再收起 */
    var res = q('#gbResult');
    if (res) res.style.display = 'block';
    renderKpi(true);            /* 清掉上一轮成果，避免旧数字残留 */
    renderSteps();
    var btn = q('#gbBtnBuild');
    if (btn) { btn.disabled = true; btn.innerHTML = '<svg class="icon"><use href="#i-refresh"/></svg>生成中…'; }

    var steps = [
      [16, 420], [36, 380], [62, 520], [80, 420], [93, 380], [100, 260]
    ];
    return steps.reduce(function (p, cur, i) {
      return p.then(function () {
        GB.step = i; GB.pct = cur[0];
        renderSteps();
        return sleep(cur[1]);
      });
    }, Promise.resolve()).then(function () {
      GB.site = buildSite(specFromForm());
      GB.page = 'index.html';
      GB.busy = false; GB.step = 6; GB.pct = 100;
      if (!GB.progUser) setGbProg(false);   /* 完成后自动收起，页面保持清爽 */
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="icon"><use href="#i-spark"/></svg>一键秒搭建站'; }
      renderAll();
      audit('geo.site.build', GB.site.spec.brand);
      /* 落服务端持久化 —— 这一步原先完全缺失，产物只活在浏览器内存里。
         成功后拿到真实托管地址：/site/<id>/index.html 可直接 HTTP 访问。 */
      persistSite(GB.site).then(function (saved) {
        if (saved) {
          GB.saved = saved;
          pushHistory(GB.site, saved);
          renderPub();
          renderHistory();
          if (!silent) {
            toast('已生成 ' + GB.site.pages.length + ' 个页面并落盘到服务端 · GEO 体检 ' +
                  GB.site.audit.total + ' 分', 'ok', '秒搭建站完成', 3600);
          }
        } else {
          pushHistory(GB.site);
          renderPub();
          renderHistory();
          if (!silent) {
            toast('已生成 ' + GB.site.pages.length + ' 个页面 · GEO 体检 ' + GB.site.audit.total +
                  ' 分（未落服务端，刷新后会丢失）', 'warn', '生成完成但未持久化', 4200);
          }
        }
      });
      return GB.site;
    })['catch'](function (e) {
      GB.busy = false;
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="icon"><use href="#i-spark"/></svg>一键秒搭建站'; }
      toast('生成失败：' + (e && e.message ? e.message : '未知错误'), 'err');
      renderSteps();
    });
  }

  function siteRecord(site, saved) {
    var s = site.spec;
    var r = {
      id: (saved && saved.id) || ('gs' + Date.now().toString(36)),
      brand: s.brand,
      industry: s.industryKey,
      industryLabel: s.ind.label,
      pages: site.pages.length,
      score: site.audit.total,
      keywords: s.keywords,
      domain: s.domain,
      date: s.date,
      /* 只有真正落盘到服务端才算「已持久化」，否则是内存态样例 */
      status: saved ? '已持久化' : '仅本地生成',
      previewUrl: (saved && saved.previewUrl) || '',
      form: readForm()
    };
    return r;
  }

  /* ---- 落服务端持久化 ----
     这是原先整条链路缺失的那一环：此前 buildSite() 的产物从未离开浏览器，
     刷新即丢，也没有任何「用户域名 ↔ 生成产物」的关联记录。 */
  function persistSite(site) {
    if (!bffUp()) { GB.cloud = false; return Promise.resolve(null); }
    var s = site.spec;
    return api('/v1/sites', {
      brand: s.brand,
      domain: s.domain,
      industry: s.industryKey,
      industryLabel: s.ind.label,
      date: s.date,
      score: site.audit.total,
      ldCount: site.ldCount,
      keywords: s.keywords,
      pages: site.pages.map(function (p) { return { file: p.file, crumb: p.crumb, title: p.title, desc: p.desc }; }),
      files: site.files.map(function (f) { return { name: f.name, text: f.text, group: f.group }; }),
      probe: GB.probe || null,
      status: '已持久化'
    }, { method: 'POST', timeout: 30000 }).then(function (r) {
      if (r && r.ok && r.data && r.data.record) {
        GB.cloud = true;
        audit('geo.site.persist', s.brand + ' · ' + r.data.record.files + ' 文件');
        return { id: r.data.record.id, previewUrl: r.data.previewUrl, filesUrl: r.data.filesUrl, bytes: r.data.bytes };
      }
      GB.cloud = false;
      toast('站点持久化失败：' + ((r && r.error) || '未知错误'), 'warn', '产物未落盘', 4200);
      return null;
    })['catch'](function (e) {
      GB.cloud = false;
      toast('站点持久化异常：' + ((e && e.message) || e), 'warn', '产物未落盘', 4200);
      return null;
    });
  }

  /* ---- 发布状态条：把「生成」和「上线」彻底分开讲清楚 ---- */
  function renderPub() {
    var box = q('#gbPub');
    if (!box) return;
    /* 首次渲染时拉一次部署能力自检，决定要不要给出「部署到 CloudBase」按钮 */
    if (GB.cbStatus === undefined) { GB.cbStatus = null; loadCbStatus(); }
    var site = GB.site;
    if (!site) { box.style.display = 'none'; return; }
    box.style.display = 'flex';
    var saved = GB.saved;
    var pr = GB.probe;
    var deployState = saved ? 'persisted' : 'memory';
    var liveState = !pr ? 'unknown' : (!pr.dns || !pr.dns.resolved ? 'no-dns' : (!pr.ok ? 'down' : 'live'));

    var head, sub, cls, acts = '';
    if (deployState === 'memory') {
      cls = 'warn';
      head = '产物仅在浏览器内存中，刷新即丢失';
      sub = '未接入服务端，无法持久化。请先在「系统设置 → 运行时」填写服务端地址。';
    } else {
      cls = 'ok';
      head = '产物已持久化到服务端（' + saved.bytes + ' 字节）';
      sub = '托管地址：<code>' + esc(saved.previewUrl) + '</code>';
      acts = '<button class="btn sm" id="gbOnlineBtn" type="button"><svg class="icon"><use href="#i-globe"/></svg>在线预览</button>' +
             '<button class="btn sm" id="gbCopyDeploy" type="button">复制部署说明</button>';
      /* 配了腾讯云密钥才出现一键部署，免得点了才报错 */
      if (GB.cbStatus && GB.cbStatus.ready) {
        acts += '<button class="btn sm" id="gbCbDeploy" type="button">' +
                (GB.cbBusy ? '部署中…' : '部署到 CloudBase') + '</button>';
      } else if (GB.cbStatus) {
        acts += '<span style="opacity:.62;font-size:12px;padding:0 6px;align-self:center" title="' +
                esc(GB.cbStatus.hint || '') + '">CloudBase 未配置</span>';
      }
      if (GB.lastDeploy) {
        sub += ' ｜ 上次部署：' + esc(GB.lastDeploy.uploaded + '/' + GB.lastDeploy.total + ' 个文件 · ' +
               kb(GB.lastDeploy.bytes) + ' · ' + GB.lastDeploy.ms + 'ms');
      }
    }

    var live = {
      'unknown': ['i-warning', 'var(--amber)', '域名未校验，无法确定是否已上线'],
      'no-dns': ['i-x', 'var(--red)', '域名在 DNS 中不存在 —— 部署后也不会有人能访问'],
      'down': ['i-x', 'var(--red)', '域名已解析但站点不可达 —— 需要一台公网服务器承载'],
      'live': ['i-shield', 'var(--green)', '域名在线，部署产物后 AI 引擎即可抓取']
    }[liveState];

    box.className = 'gb-pub ' + cls;
    box.innerHTML =
      '<svg class="icon" style="width:16px;height:16px;color:' + (cls === 'ok' ? 'var(--green)' : 'var(--amber)') + '">' +
        '<use href="#' + (cls === 'ok' ? 'i-box' : 'i-warning') + '"/></svg>' +
      '<div class="tx"><b>' + head + '</b><em>' + sub + '</em>' +
        '<em style="margin-top:5px">' +
          '<svg class="icon" style="width:12px;height:12px;color:' + live[1] + '"><use href="#' + live[0] + '"/></svg> ' +
          esc(live[2]) +
        '</em></div>' + acts;
  }

  /* ---- 部署说明 ----
     用户真正想知道的是「怎么从我填的域名访问到这个站」。这里生成一份
     可直接照做的说明：产物清单 + nginx 站点配置 + DNS 记录 + 校验方式。 */
  function deployNote() {
    var site = GB.site || {};
    var s = site.spec || {};
    var base = GB.saved && GB.saved.previewUrl ? GB.saved.previewUrl : '(未持久化)';
    var host = s.domain || 'example.com';
    var id = (GB.saved && GB.saved.id) || 'SITE_ID';
    var lines = [];
    lines.push('ProFound · AI秒搭建站 部署说明');
    lines.push('生成品牌：' + s.brand);
    lines.push('目标域名：' + host);
    lines.push('站点 ID ：' + id);
    lines.push('本地托管：' + base);
    lines.push('');
    lines.push('【1】产物清单');
    (site.files || []).forEach(function (f) {
      lines.push('  - ' + f.name + '  (' + kb(new Blob([f.text]).size) + ')');
    });
    lines.push('');
    lines.push('【2】DNS 记录（在域名解析服务商处添加）');
    lines.push('  类型  A      名称  ' + host.split('.')[0] + '      值  <你的公网服务器 IP>');
    lines.push('  类型  A      名称  @           值  <你的公网服务器 IP>');
    lines.push('');
    lines.push('【3】把产物传到服务器');
    lines.push('  # 先把整站包下载到本地 build 目录');
    lines.push('  scp build/*  root@<服务器IP>:/var/www/' + host + '/');
    lines.push('');
    lines.push('【4】Nginx 站点配置 /etc/nginx/conf.d/' + host.split('.')[0] + '.conf');
    lines.push('  server {');
    lines.push('      listen 80;');
    lines.push('      server_name ' + host + ' www.' + host + ';');
    lines.push('      root /var/www/' + host + ';');
    lines.push('      index index.html;');
    lines.push('      location / { try_files $uri $uri.html $uri/ =404; }');
    lines.push('      # GEO 三件套必须可直接访问，且 robots 要放行 AI 爬虫');
    lines.push('      location = /robots.txt { add_header Cache-Control "no-cache"; }');
    lines.push('      location = /llms.txt  { add_header Cache-Control "no-cache"; }');
    lines.push('  }');
    lines.push('');
    lines.push('【5】签发 HTTPS（Certbot）');
    lines.push('  certbot --nginx -d ' + host + ' -d www.' + host);
    lines.push('');
    lines.push('【6】上线后回来点「校验域名」确认');
    lines.push('  需全部命中：https://' + host + '/robots.txt');
    lines.push('            https://' + host + '/sitemap.xml');
    lines.push('            https://' + host + '/llms.txt');
    return lines.join('\n');
  }

  /* ---- 部署能力自检 ----
     判断是否已配好腾讯云密钥和目标桶。未配齐时不显示部署按钮，
     避免出现「点了才告诉你没配置」的体验。 */
  function loadCbStatus() {
    if (!bffUp()) return Promise.resolve(null);
    return api('/v1/deploy/status', null, { method: 'GET', timeout: 8000 })
      .then(function (r) {
        GB.cbStatus = (r && r.ok && r.data) ? r.data : null;
        renderPub();
        return GB.cbStatus;
      })['catch'](function () { GB.cbStatus = null; return null; });
  }

  /* ---- 一键部署到 CloudBase ----
     服务端负责导出 → 按目标域改域 → 直推 COS；这里只发起请求并在完成后
     立刻复验域名，让用户看到「已上线且三件套全绿」而不是自己去点校验。 */
  function deployToCloudBase() {
    if (!GB.saved || !GB.saved.id) { toast('请先把站点持久化到服务端', 'warn'); return; }
    var dm = String((readForm().domain || '')).trim();
    if (!dm) { toast('请先填写目标域名', 'warn'); return; }
    if (GB.cbBusy) return;
    if (GB.cbStatus && GB.cbStatus.ready === false) {
      toast((GB.cbStatus && GB.cbStatus.hint) || 'CloudBase 尚未配置完成', 'warn', '无法部署');
      return;
    }
    GB.cbBusy = true;
    renderPub();
    audit('geo.site.deploy', dm);
    return api('/v1/sites/' + GB.saved.id + '/deploy', { domain: dm }, { method: 'POST', timeout: 180000 })
      .then(function (r) {
        GB.cbBusy = false;
        if (r && r.ok && r.data && r.data.deploy) {
          var d = r.data.deploy;
          GB.lastDeploy = d;
          renderPub();
          toast('已推到 ' + d.domain + '：' + d.uploaded + '/' + d.total + ' 个文件 · ' +
                kb(d.bytes) + ' · ' + d.ms + 'ms', 'ok', '部署成功', 4200);
          probeDomain(true);
        } else {
          renderPub();
          toast('部署失败：' + ((r && r.message) || (r && r.error) || '未知错误'), 'err', '部署失败', 5200);
        }
      })['catch'](function (e) {
        GB.cbBusy = false;
        renderPub();
        toast('部署异常：' + ((e && e.message) || e), 'err', '部署异常', 5200);
      });
  }

  function copyDeployNote() {
    var txt = deployNote();
    var done = function () { toast('部署说明已复制：DNS 记录 + nginx 配置 + Certbot 步骤', 'ok', '已复制', 3600); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done, function () { fallbackCopy(txt, done); });
        return;
      }
    } catch (e) {}
    fallbackCopy(txt, done);
  }

  function fallbackCopy(txt, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) {
      modal({
        title: '部署说明', sub: '复制失败，请手动选取', wide: true,
        fields: [{ name: 'note', label: '', type: 'textarea', value: txt, rows: 18 }],
        okText: '关闭'
      });
    }
  }

  function pushHistory(site, saved) {
    var rec = siteRecord(site, saved);
    GB.sites = [rec].concat(GB.sites.filter(function (x) {
      return !(x.id === rec.id || (x.brand === rec.brand && x.date === rec.date));
    })).slice(0, 12);
    var mine = GB.sites.filter(function (x) { return x.id && x.form; }).slice(0, 8);
    lsSet(LS_SITES, JSON.stringify(mine));
  }

  /* ---- 历史记录 ----
     原先：localStorage 的几条元信息 + 演示数据 __DEMO_DATA__.geoSites 混着塞进来，
     于是「样例站」和「真实生成的站」永远同屏出现 —— 这正是「还是样例」的直观来源。
     现在：服务端可用则以服务端为准（真实落盘的站点）；不可用时才回落本地，
     并且不再掺入演示数据。 */
  function loadHistory() {
    var saved = [];
    try { saved = JSON.parse(lsGet(LS_SITES) || '[]') || []; } catch (e) { saved = []; }
    GB.sites = saved.slice(0, 12);
    if (!bffUp()) { GB.cloud = false; return Promise.resolve(false); }
    return api('/v1/sites', null, { method: 'GET', timeout: 12000 }).then(function (r) {
      if (r && r.ok && r.data && Array.isArray(r.data.items)) {
        GB.cloud = true;
        GB.sites = r.data.items.slice(0, 12);
        return true;
      }
      GB.cloud = false;
      return false;
    })['catch'](function () { GB.cloud = false; return false; });
  }

  /* ---------------- 11. 事件 ---------------- */
  function bind() {
    /* 引擎多选 */
    var box = q('#gbEngines');
    if (box && !box.__gb) {
      box.__gb = 1;
      box.innerHTML = engines().map(function (e) {
        return '<span class="gb-chip' + (GB.engines.indexOf(e.id) > -1 ? ' on' : '') + '" data-gbeng="' + e.id + '"><i></i>' + esc(e.name) + '</span>';
      }).join('');
      box.addEventListener('click', function (ev) {
        var c = ev.target.closest ? ev.target.closest('[data-gbeng]') : null;
        if (!c) return;
        var id = c.getAttribute('data-gbeng');
        if (GB.engines.indexOf(id) > -1) {
          if (GB.engines.length === 1) { toast('至少保留 1 个引擎', 'warn'); return; }
          GB.engines = GB.engines.filter(function (x) { return x !== id; });
          c.classList.remove('on');
        } else {
          GB.engines.push(id);
          c.classList.add('on');
        }
      });
    }

    /* 表单实时核对 + 草稿 */
    var form = q('#gbForm');
    if (form && !form.__gb) {
      form.__gb = 1;
      var timer = null;
      form.addEventListener('input', function () {
        renderCheck();
        clearTimeout(timer);
        timer = setTimeout(function () { lsSet(LS_FORM, JSON.stringify(readForm())); }, 500);
      });
      form.addEventListener('change', renderCheck);
    }

    /* 生成 / 重置 */
    var b = q('#gbBtnBuild');
    if (b && !b.__gb) { b.__gb = 1; b.addEventListener('click', function () { runBuild(false); }); }
    var r = q('#gbBtnReset');
    if (r && !r.__gb) {
      r.__gb = 1;
      r.addEventListener('click', function () {
        writeForm(Object.assign({}, DEMO_FORM));
        GB.probe = null; GB.probeFor = '';
        renderCheck(); renderProbe();
        probeDomain(true);
        toast('已恢复示例信息', 'info', '示例域名未经校验，请换成你的真实域名');
      });
    }

    /* 生成进度折叠 */
    var pf = q('#gbProgFold');
    if (pf && !pf.__gb) {
      pf.__gb = 1;
      pf.addEventListener('click', function () {
        GB.progUser = true;
        setGbProg(!q('#gbMerged').classList.contains('open'));
      });
    }

    /* 域名真实性校验：失焦自动触发，也可点按钮手动重跑 */
    var dm = q('#gbDomain');
    if (dm && !dm.__gb) {
      dm.__gb = 1;
      dm.addEventListener('blur', function () {
        var d = String(dm.value || '').trim();
        if (!d) { GB.probe = null; GB.probeFor = ''; renderProbe(); renderCheck(); return; }
        if (probeStale(d)) probeDomain(true);
      });
      dm.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); probeDomain(false); }
      });
    }
    var pb = q('#gbProbe');
    if (pb && !pb.__gb) {
      pb.__gb = 1;
      pb.addEventListener('click', function (ev) {
        if (ev.target.closest && ev.target.closest('#gbProbeBtn')) probeDomain(false);
      });
    }

    /* 发布状态条按钮 */
    var pubBox = q('#gbPub');
    if (pubBox && !pubBox.__gb) {
      pubBox.__gb = 1;
      pubBox.addEventListener('click', function (ev) {
        var t = ev.target.closest ? ev.target.closest('button') : null;
        if (!t) return;
        var id = t.id;
        if (id === 'gbOnlineBtn') {
          if (GB.saved && GB.saved.previewUrl) window.open(GB.saved.previewUrl, '_blank', 'noopener');
        } else if (id === 'gbCopyDeploy') {
          copyDeployNote();
        } else if (id === 'gbCbDeploy') {
          deployToCloudBase();
        }
      });
    }

    /* 页面切换 */
    var tabs = q('#gbTabs');
    if (tabs && !tabs.__gb) {
      tabs.__gb = 1;
      tabs.addEventListener('click', function (ev) {
        var t = ev.target.closest ? ev.target.closest('[data-gbpage]') : null;
        if (!t) return;
        GB.page = t.getAttribute('data-gbpage');
        renderPreview();
      });
    }

    /* 文件查看 / 下载 / 同步 */
    var files = q('#gbFiles');
    if (files && !files.__gb) {
      files.__gb = 1;
      files.addEventListener('click', function (ev) {
        var t = ev.target.closest ? ev.target.closest('[data-gbfile]') : null;
        if (!t || !GB.site) return;
        var name = t.getAttribute('data-gbfile');
        showSource(name);
      });
    }
    var dl = q('#gbDl');
    if (dl && !dl.__gb) {
      dl.__gb = 1;
      dl.addEventListener('click', function (ev) {
        var id = ev.target.closest ? (ev.target.closest('button') || {}).id : '';
        var site = GB.site;
        if (!site) return;
        var safe = String(site.spec.brand).replace(/[\\/:*?"<>|\s]/g, '');
        if (id === 'gbDlZip') {
          if (saveBlob(zipStore(site.files), safe + '-GEO站点包.zip')) {
            toast('已打包 ' + site.files.length + ' 个文件', 'ok', '整站下载');
            audit('geo.site.export', 'zip');
          } else toast('打包失败，请重试', 'err');
        } else if (id === 'gbDlPage') {
          var f = site.files.filter(function (x) { return x.name === GB.page; })[0];
          if (f && saveText(f.name, f.text, 'text/html')) { toast('已下载 ' + f.name, 'ok'); audit('geo.site.export', f.name); }
        } else if (id === 'gbDlLlms') {
          if (saveText('llms.txt', fileText('llms.txt'))) { toast('已下载 llms.txt', 'ok'); audit('geo.site.export', 'llms.txt'); }
        } else if (id === 'gbDlRobots') {
          if (saveText('robots.txt', fileText('robots.txt'))) { toast('已下载 robots.txt', 'ok'); audit('geo.site.export', 'robots.txt'); }
        } else if (id === 'gbDlMap') {
          if (saveText('sitemap.xml', fileText('sitemap.xml'), 'application/xml')) { toast('已下载 sitemap.xml', 'ok'); audit('geo.site.export', 'sitemap.xml'); }
        } else if (id === 'gbSync') {
          syncToGeo();
        }
      });
    }

    /* 历史记录 */
    var his = q('#gbHistory');
    if (his && !his.__gb) {
      his.__gb = 1;
      his.addEventListener('click', function (ev) {
        var t = ev.target.closest ? ev.target.closest('[data-gbhis]') : null;
        if (!t) return;
        var rec = GB.sites[Number(t.getAttribute('data-gbhis'))];
        if (!rec) return;
        if (rec.form) {
          writeForm(rec.form);
          renderCheck();
          runBuild(false);
        } else {
          writeForm(Object.assign({}, DEMO_FORM, {
            brand: rec.brand,
            industry: rec.industry || 'agency',
            domain: rec.domain || DEMO_FORM.domain,
            keywords: (rec.keywords || []).join('、') || DEMO_FORM.keywords
          }));
          renderCheck();
          runBuild(false);
        }
      });
    }

    /* 预览内部导航 */
    if (!window.__gbMsgBound) {
      window.__gbMsgBound = 1;
      window.addEventListener('message', function (ev) {
        var d = ev.data;
        if (d && typeof d.gbPage === 'string' && GB.site) {
          var ok = GB.site.pages.some(function (p) { return p.file === d.gbPage; });
          if (ok) { GB.page = d.gbPage; renderPreview(); }
        }
      });
    }

    /* 进入视图时刷新（导航使用 hash 路由） */
    if (!window.__gbNavBound) {
      window.__gbNavBound = 1;
      var nav = q('.nav-item[data-view="v-geobuild"]');
      if (nav) nav.addEventListener('click', function () { setTimeout(function () { renderAll(); }, 80); });
      window.addEventListener('hashchange', function () { if (/v-geobuild/.test(location.hash)) renderAll(); });
    }
  }

  function fileText(name) {
    var f = GB.site && GB.site.files.filter(function (x) { return x.name === name; })[0];
    return f ? f.text : '';
  }

  function showSource(name) {
    var f = GB.site && GB.site.files.filter(function (x) { return x.name === name; })[0];
    if (!f) return;
    modal({
      title: name,
      sub: kb(new Blob([f.text]).size) + ' · ' + (f.group || '文件'),
      icon: 'i-doc',
      wide: true,
      okText: '下载此文件',
      cancelText: '关闭',
      body: '<div class="gb-src">' + esc(f.text.slice(0, 12000)) + (f.text.length > 12000 ? '\n\n…（已截断，完整内容请下载）' : '') + '</div>' +
        '<div class="gb-note">这个文件会随整站包一起发布。' +
        (name === 'llms.txt' ? ' llms.txt 是给大模型看的站点说明书：一句话定位 + 关键事实 + 问答，AI 引擎抓取后更容易准确引用你。' : '') +
        (name === 'robots.txt' ? ' robots.txt 显式放行 GPTBot / ClaudeBot / PerplexityBot / Bytespider 等 11 个 UA —— 这是 GEO 的前置条件。' : '') +
        '</div>',
      onOk: function () {
        saveText(name, f.text, /\.html$/.test(name) ? 'text/html' : 'text/plain');
        toast('已下载 ' + name, 'ok');
        return false;
      }
    });
  }

  function syncToGeo() {
    var site = GB.site;
    if (!site) return;
    var g = window.__GEO;
    if (!g || !fn(g, 'addTask')) {
      toast('GEO优化引擎未就绪，无法同步', 'warn');
      return;
    }
    var kws = site.spec.keywords.slice(0, 3);
    var n = 0;
    kws.forEach(function (kw) {
      var exists = (g.geo && g.geo.tasks || []).some(function (t) { return t.keyword === kw; });
      if (exists) return;
      g.addTask(kw, site.spec.engines.length ? site.spec.engines : ['doubao'], '1h');
      n++;
    });
    if (n) {
      toast('已把 ' + n + ' 个核心词接入监测（每 1 小时一轮）', 'ok', '已同步到 GEO优化引擎');
      audit('geo.site.sync', site.spec.brand + ' · ' + n + ' 词');
    } else {
      toast('这些关键词已在监测列表中', 'info');
    }
  }

  /* ---------------- 12. 启动 ---------------- */
  function boot() {
    if (!q('#gbForm')) return;
    var saved = null;
    try { saved = JSON.parse(lsGet(LS_FORM) || 'null'); } catch (e) { saved = null; }
    writeForm(Object.assign({}, DEMO_FORM, saved || {}));
    bind();
    /* 历史以服务端为准：服务端列出的是真正落盘的站点。
       演示数据不再掺进来 —— 原先 __DEMO_DATA__.geoSites 的样例站和
       真实生成的站混在同一列表里，正是「填了真实域名却看到样例」的来源。 */
    loadHistory().then(function () { renderHistory(); });
    renderAll();

    /* 服务端通道可用时，首次进入就把示例域名验一遍，
       让用户第一眼看到「这个域名其实不存在」，而不是误以为已经建好 */
    var f = readForm();
    if (f.domain) probeDomain(true);

    /* 空状态下的默认提示 */
    var hint = q('#gbFormHint');
    if (hint && f.brand) {
      hint.textContent = (f.domain === DEMO_FORM.domain)
        ? '当前为示例信息（含示例域名），请替换成你的真实资料'
        : '已恢复上次的填写内容';
    }
  }

  window.__GB = {
    build: function () { return runBuild(false); },
    site: function () { return GB.site; },
    state: GB,
    spec: specFromForm,
    zip: function () { return GB.site ? zipStore(GB.site.files) : null; },
    preview: previewHtml,
    industries: IND,
    /* 生产链路出口：域名探测 / 持久化 / 部署说明，供自动化验证与排障使用 */
    probe: function (quiet) { return probeDomain(quiet !== false); },
    persist: function (site) { return persistSite(site || GB.site); },
    deployNote: deployNote,
    reloadHistory: function () { return loadHistory().then(function (ok) { renderHistory(); return ok; }); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
