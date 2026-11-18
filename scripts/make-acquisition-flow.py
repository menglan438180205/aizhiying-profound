# -*- coding: utf-8 -*-
"""生成「评论区截流获客」标准流程图（PNG）。"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 2600, 1860
S = 2  # 2x 绘制后缩放，文字更干净

BG = "#F5F7FB"
INK = "#1D2433"
SUB = "#5B6272"
MUTED = "#8A90A2"
ARROW = "#8A90A6"
DASH = "#B07A1F"

STRAT = ("#EAF1FF", "#2F6BFF")
READ = ("#EAF8F1", "#17A36A")
WRITE = ("#FFF3E6", "#E07A1F")
CRM = ("#F3EEFF", "#7A5AF8")
NEUTRAL = ("#FFFFFF", "#D9DEE9")
SOFT = "#F0F2F7"

FONT_REG = "C:/Windows/Fonts/msyh.ttc"
FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"

def font(size, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, int(size * S))

def sc(v):
    return int(round(v * S))

img = Image.new("RGB", (W * S, H * S), BG)
d = ImageDraw.Draw(img)

def shadow_card(x, y, w, h, fill, border, r=18, bw=2, shadow=True):
    if shadow:
        d.rounded_rectangle(
            [sc(x), sc(y + 6), sc(x + w), sc(y + h + 6)],
            radius=sc(r), fill="#E7EAF2"
        )
    d.rounded_rectangle(
        [sc(x), sc(y), sc(x + w), sc(y + h)],
        radius=sc(r), fill=fill, outline=border, width=sc(bw)
    )

def text(x, y, s, size, color=INK, bold=False):
    d.text((sc(x), sc(y)), s, font=font(size, bold), fill=color)

def center_text(cx, y, s, size, color=INK, bold=False):
    f = font(size, bold)
    w = d.textlength(s, font=f)
    d.text((sc(cx) - w / 2, sc(y)), s, font=f, fill=color)

def arrow(points, color=ARROW, width=4, head=13, dashed=False, dash=12, gap=9):
    pts = [(sc(x), sc(y)) for x, y in points]
    if not dashed:
        for i in range(len(pts) - 1):
            d.line([pts[i], pts[i + 1]], fill=color, width=sc(width))
    else:
        for i in range(len(pts) - 1):
            x1, y1 = pts[i]
            x2, y2 = pts[i + 1]
            dx, dy = x2 - x1, y2 - y1
            length = (dx * dx + dy * dy) ** 0.5
            if length == 0:
                continue
            ux, uy = dx / length, dy / length
            pos = 0
            while pos < length:
                end = min(pos + sc(dash), length)
                d.line(
                    [(x1 + ux * pos, y1 + uy * pos), (x1 + ux * end, y1 + uy * end)],
                    fill=color, width=sc(width)
                )
                pos = end + sc(gap)
    # 箭头
    (x1, y1), (x2, y2) = pts[-2], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    length = (dx * dx + dy * dy) ** 0.5
    if length == 0:
        return
    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    h = sc(head)
    w = sc(head * 0.55)
    tip = (x2, y2)
    base = (x2 - ux * h, y2 - uy * h)
    d.polygon([
        tip,
        (base[0] + px * w, base[1] + py * w),
        (base[0] - px * w, base[1] - py * w)
    ], fill=color)

def tag(x, y, label, color, bg="#FFFFFF", size=15):
    f = font(size, True)
    tw = d.textlength(label, font=f)
    pad = sc(10)
    h = sc(28)
    d.rounded_rectangle(
        [sc(x), sc(y), sc(x) + tw + pad * 2, sc(y) + h],
        radius=sc(14), fill=bg, outline=color, width=sc(1.4)
    )
    d.text((sc(x) + pad, sc(y) + sc(4)), label, font=f, fill=color)

def card(x, y, w, h, palette, title, tag_text, tag_color, lines, title_size=29, line_size=19.5):
    fill, border = palette
    shadow_card(x, y, w, h, fill, border)
    text(x + 26, y + 16, title, title_size, INK, True)
    tag(x + w - 88, y + 16, tag_text, tag_color, "#FFFFFF", 14)
    yy = y + 64
    for line in lines:
        text(x + 26, yy, line, line_size, SUB, False)
        yy += 28

def pill(x, y, w, h, label, fill="#FFFFFF", border="#D9DEE9", color=INK, size=19, bold=False):
    d.rounded_rectangle(
        [sc(x), sc(y), sc(x + w), sc(y + h)],
        radius=sc(h // 2), fill=fill, outline=border, width=sc(1.5)
    )
    f = font(size, bold)
    tw = d.textlength(label, font=f)
    d.text((sc(x + w / 2) - tw / 2, sc(y + h / 2 - size * 0.72)), label, font=f, fill=color)

# ---------------- Header ----------------
text(80, 42, "评论区截流获客 · 标准流程图", 46, INK, True)
text(82, 108, "先找需求，再做触达，最后接住线索；读链路和写链路分开，系统的按钮就不会乱。", 22, SUB)

# Legend
lx = 1760
for i, (label, color) in enumerate([
    ("读链路", READ[1]), ("写链路", WRITE[1]), ("承接", CRM[1]), ("人工复核", "#8A90A2")
]):
    d.ellipse([sc(lx), sc(78), sc(lx + 14), sc(92)], fill=color)
    text(lx + 22, 72, label, 17, SUB)
    lx += 150 if i < 3 else 0

# ---------------- Strategy ----------------
shadow_card(80, 178, 2440, 150, STRAT[0], STRAT[1])
text(108, 194, "① 策略层 · 战役配置", 31, INK, True)
tag(2418, 194, "人工", "#2F6BFF", "#FFFFFF", 14)
text(108, 238, "行业 / 城市 / 客户画像 / 卖点", 20, SUB)
text(640, 238, "关键词：保洁多少钱、开荒保洁、深度保洁…", 20, SUB)
text(108, 270, "竞品：本地同行 10 个 · 周期：每日增量 · 目标：高意向线索", 20, SUB)
text(2060, 270, "一次配置，跑一周", 18, "#2F6BFF", True)

# ---------------- Section headers ----------------
text(80, 354, "③④ 发现 / 识别 · 找需求", 27, READ[1], True)
text(80, 388, "采集 / 分析，自动为主；先看需求再看量", 17, MUTED)
text(1360, 354, "②⑤ 账号 / 触达 · 做触达", 27, WRITE[1], True)
text(1360, 388, "真实登录 + 真实页面操作，半自动 · 话术可手写 / AI 仿写", 17, MUTED)

# ---------------- Read column ----------------
RX, RW, RH, GAP = 80, 1120, 160, 22
R_Y = [380, 562, 744, 926, 1108]

card(RX, R_Y[0], RW, RH, READ, "发现", "读", READ[1], [
    "关键词搜索 / 竞品视频 / 话题 / 同城",
    "输出：候选作品链接",
    "自动：浏览器扩展或官方接口"
])
card(RX, R_Y[1], RW, RH, READ, "作品池", "读", READ[1], [
    "去重 · 按最近 / 评论多 / 同城排序",
    "展示：20 条 / 页，最多 40 页",
    "字段：标题 / 作者 / 点赞 / 评论 / 链接"
])
card(RX, R_Y[2], RW, RH, READ, "评论采集", "读", READ[1], [
    "点开评论区，抓公开评论",
    "登录墙 / 验证码 → 暂停并提示",
    "MediaCrawler：只读、非商用，不能发评论"
])
card(RX, R_Y[3], RW, RH, READ, "意向识别", "读", READ[1], [
    "意向词：多少钱 / 怎么收费 / 在哪 / 求推荐",
    "评分：高 / 中 / 低 / 噪音",
    "去重，排除同行与自己"
])
card(RX, R_Y[4], RW, RH, READ, "线索池", "读", READ[1], [
    "来源作品 + 评论原文 + 意向分",
    "状态：待跟进 / 已联系 / 已加微 / 成交",
    "高意向人工复核"
])

# ---------------- Write column ----------------
WX = 1360
card(WX, R_Y[0], RW, RH, WRITE, "账号矩阵", "写", WRITE[1], [
    "抖音 / 小红书 / 快手 / 视频号",
    "一号一环境，登录态独立",
    "养号 · 日限额 · 冷却"
])
card(WX, R_Y[1], RW, RH, WRITE, "触达策略", "写", WRITE[1], [
    "A 蹲守：回复高意向评论",
    "B 留言：目标视频下软性评论",
    "C 私信：先价值后引导"
])
card(WX, R_Y[2], RW, RH, WRITE, "执行队列", "写", WRITE[1], [
    "每账号 1 个任务并发",
    "随机间隔 45–90 秒",
    "日上限 20–40 条 · 人工审核"
])
card(WX, R_Y[3], RW, RH, WRITE, "真实浏览器执行", "写", WRITE[1], [
    "Chrome 扩展（真实登录，不是爬虫）",
    "点赞 → 点开评论 → 写入 → 发送",
    "只做真人会做的操作"
])
card(WX, R_Y[4], RW, RH, WRITE, "结果回传", "写", WRITE[1], [
    "成功 / 失败 / 步骤截图",
    "失败：登录墙 / 改版 / 限额",
    "回写线索状态"
])

# ---------------- Vertical arrows ----------------
for i in range(4):
    arrow([(RX + RW / 2, R_Y[i] + RH), (RX + RW / 2, R_Y[i + 1])], ARROW, 4, 11)
    arrow([(WX + RW / 2, R_Y[i] + RH), (WX + RW / 2, R_Y[i + 1])], ARROW, 4, 11)

# Strategy -> both
arrow([(640, 328), (640, 378)], ARROW, 4, 11)
arrow([(1920, 328), (1920, 378)], ARROW, 4, 11)
text(650, 336, "配置下发", 15, MUTED)

# Read works -> Write strategy
arrow([(RX + RW, 642), (WX, 642)], ARROW, 4, 12)
text(1208, 600, "选中作品", 15, MUTED)
text(1208, 620, "／线索", 15, MUTED)

# Write result -> Read leads (dashed feedback)
arrow([(WX, 1188), (RX + RW, 1188)], DASH, 3, 11, True)
text(1208, 1148, "回写状态", 15, DASH)

# ---------------- CRM ----------------
CRM_Y = 1300
shadow_card(80, CRM_Y, 2440, 170, CRM[0], CRM[1])
text(108, 1314, "⑥ 承接层 · 把线索变成成交", 30, INK, True)
tag(2418, 1314, "人工为主", CRM[1], "#FFFFFF", 14)
text(108, 1354, "线索不是结果；跟进、加微、成交才是结果。", 18, SUB)

items = [
    ("线索分配", "按平台 / 城市 / 意向分"),
    ("首聊话术", "先解决问题，再留联系方式"),
    ("加微 / 到店", "记录来源作品与关键词"),
    ("成交 / 复盘", "反推关键词与话术"),
]
bw, bh, gap = 560, 66, 24
bx = 104
for i, (title, sub) in enumerate(items):
    x = bx + i * (bw + gap)
    d.rounded_rectangle([sc(x), sc(1390), sc(x + bw), sc(1390 + bh)],
                        radius=sc(12), fill="#FFFFFF", outline="#D9D4F5", width=sc(1.4))
    text(x + 18, 1398, title, 21, INK, True)
    text(x + 18, 1426, sub, 15.5, SUB)
    if i < 3:
        arrow([(x + bw + 4, 1423), (x + bw + gap - 4, 1423)], "#B7A8F5", 3, 8)

# Read leads -> CRM, Write results -> CRM
arrow([(640, R_Y[4] + RH), (640, CRM_Y)], ARROW, 4, 11)
arrow([(1920, R_Y[4] + RH), (1920, CRM_Y)], ARROW, 4, 11)

# Feedback CRM -> strategy (dashed, outside left)
arrow([(80, 1385), (38, 1385), (38, 253), (80, 253)], DASH, 3, 10, True)
text(48, 1468, "虚线 = 复盘反馈", 15, DASH)

# ---------------- UI band ----------------
shadow_card(80, 1500, 2440, 74, "#FFFFFF", "#D9DEE9", 14, 1.5, False)
text(104, 1512, "界面映射", 19, INK, True)
text(200, 1512, "左栏 = 战役 / 账号   ｜   中栏 = 作品池（20 条/页）   ｜   右栏 = 线索池 / 跟进   ｜   异常统一收进「任务详情」", 18, SUB)
text(104, 1542, "护栏：一号一环境 · 日限额 · 随机间隔 · 去重 · 人工复核 · 平台规则与个人信息保护", 16.5, MUTED)

# ---------------- Metrics ----------------
text(80, 1604, "只看这条漏斗，不要用「抓了多少页」当成绩", 23, INK, True)
text(80, 1638, "40 页只是池子容量；真正的结果在最后三步。", 17, MUTED)

metrics = ["有效作品", "高意向评论", "触达", "回复率", "加微率", "成交", "封号率"]
mx, my, mw, mh, mg = 100, 1678, 300, 50, 22
for i, label in enumerate(metrics):
    x = mx + i * (mw + mg)
    fill = "#FFF1F1" if label == "封号率" else "#FFFFFF"
    border = "#E5484D" if label == "封号率" else "#D9DEE9"
    color = "#C62F35" if label == "封号率" else INK
    pill(x, my, mw, mh, label, fill, border, color, 18, True)
    if i < len(metrics) - 1:
        arrow([(x + mw + 3, my + mh / 2), (x + mw + mg - 3, my + mh / 2)], "#C3C8D6", 3, 7)

text(80, 1772, "读链路可自动；写链路必须真实浏览器；高风险动作人工确认。", 18, MUTED)
text(80, 1802, "建议节奏：每天每个关键词采集 40–60 个作品 → 审核高意向 → 每个账号 10–20 条触达 → 跟进线索 → 复盘关键词与话术。", 16.5, MUTED)

# ---------------- Downscale ----------------
out = img.resize((W, H), Image.LANCZOS)
os.makedirs("docs", exist_ok=True)
out.save("docs/comment-acquisition-flow.png", "PNG", optimize=True)
print("written docs/comment-acquisition-flow.png", out.size)
