# src/ — 前端源码（唯一真相）

`index.html` 是**构建产物**，不再手改。改代码改这里，然后：

```bash
node scripts/build.js          # src/ → index.html
node scripts/check-sync.js     # 校验产物是否已重新生成
```

发布形态不变：仍然是单个 `index.html`（约 1.0 MB），`release/deploy.ps1`、`release/gate.js` 全部按原样工作。

## 目录

| 路径 | 内容 | 规模 |
|---|---|---|
| `tpl/index.tpl.html` | 页面骨架，各块位置留 `<!--@bundle:路径-->` 占位 | 约 120 KB |
| `js/01-app.js` | 应用外壳、登录、路由、计费入口 | 67 KB |
| `js/02-qr.js` | 二维码编码器（零依赖） | 13 KB |
| `js/03-interact.js` | 交互增强层：动作表、按钮委托、演示弹层 | 128 KB |
| `js/04-runtime.js` | 运行时层：API 封装、会话、SSE | 52 KB |
| `js/05-collect.js` | 评论区获客三栏控制台 | 51 KB |
| `js/06-avatar.js` | AI 数字人工作台 | 23 KB |
| `js/07-matrix.js` | AI 智能剪辑 | 94 KB |
| `js/08-geo3.js` | GEO 优化引擎 v3（11 模块） | 69 KB |
| `js/09-geosite.js` | GEO 直通车 / AI 秒搭建站 | 89 KB |
| `js/10-colsd.js` | 采集器服务端调度面板 | 38 KB |
| `js/11-fold.js` | 中台卡片折叠 | 1 KB |
| `js/12-bootguard.js` | 启动看门狗 | 1 KB |
| `css/01-base.css` | 主样式（设计令牌、组件） | 128 KB |
| `css/02-geo3.css` | GEO 控制台样式 | 12 KB |
| `css/03-geobuild.css` | 秒搭建站样式 | 11 KB |
| `css/04-skin-bright.css` | 亮色皮肤覆盖 | 3 KB |

## 两条必须知道的规则

1. **块顺序即执行顺序**。`01 → 12` 是页面里内联脚本的真实先后顺序，中间任何一层依赖前一层定义的全局（`window.Api`、`toast`、`go`）。插入新块要同步改 `scripts/build.js` 里的 `JS_FILES`。
2. **脚本体内部的 `<style>` 标签会被当作嵌套块跳过**。`js/09-geosite.js` 里有一段 JS 字符串含 `<style></style>`，构建脚本只拆最外层块——如果把嵌套块也拆了，产物会凭空多出字节（已实测）。

## 回捞（万一有人直接改了 index.html）

```bash
node scripts/build.js --extract
```

会把当前 `index.html` 重新拆回 `src/`。拆完立刻 `node scripts/build.js` 应得到**字节完全相同**的文件；不一致说明拆分有损，不要提交。
