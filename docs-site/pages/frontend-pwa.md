# 前端与 PWA
> app/public/ 分层、Socket 客户端、可安装 PWA。

- **Part**: 第四部分 · 核心实现
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~1405

---

前端是原生 ESM 的单页应用（PWA）：Express 直接托管 `app/public/` 静态文件，不经 Webpack / Vite 编译，运行期零外部 CDN 依赖。

## 目录分层与职责划分

| 文件 / 目录路径 | 职责与约束 |
| --- | --- |
| app/public/index.html | HTML 外壳、移动端视口、PWA Manifest 引用 |
| app/public/css/app.css | 样式（原生 CSS 变量体系 + Tailwind 运行时） |
| app/public/js/app.js | 顶层协调器：挂载 Socket、路由事件、装配子模块。存量状态留在这里，新状态不再往里放 |
| app/public/js/app/* | 按业务域划分的子模块工厂，Context 依赖注入（如 event-dispatch.js 、 message-renderer.js 、 drawer.js 、 rewind-command.js ） |
| app/public/js/logic/* | 纯逻辑层 ：数据进、数据出，不碰 DOM / window / socket / 应用可变态，唯一宿主外 import 是 i18n.js ；浏览器与 tests/unit/logic-*.test.mjs 零构建共用同一份文件 |
| app/public/js/canonicalize.js | 前后端唯一共用的文件：审批指纹的规范化 |
| app/public/vendor/ | 第三方库本地托管（Tailwind 运行时、marked、highlight.js、DOMPurify） |
| app/public/manifest.webmanifest | PWA 安装清单，独立全屏显示 |

> **TIP:** 前端状态架构原则 — 新功能的状态不再挂进 app.js 的顶层作用域：新状态进 app/public/js/app/ 域模块（工厂 + context 注入，样板是 event-dispatch.js）；能写成纯函数的一律先落 app/public/js/logic/*。

## 状态管理与交互设计

- 令牌存取： 首次通过 URL hash（ #token=... ）带入，存进 localStorage 后立即用 history.replaceState 从地址栏抹掉，避免截图或转发 URL 时泄露。
- 回车语义按设备区分： 触摸设备上回车是换行，发送只走发送按钮（软键盘的回车键提示也改成「换行」）；桌面仍是回车发送、Shift+Enter 换行。软键盘没有 Shift+Enter，旧行为会把多行消息在换行处切断、只发出前半段。
- 未读： 抽屉会话行与首页最近行在上次打开后有新活动才亮；抽屉会话行支持长按手动标为未读。已读位点存在服务端（ read-state.json ），换设备后读过的会话不会整屏复亮。
- 会话打不开时： 落到目标会话自己的页面，说明打不开的原因，给「重试打开」与「选择其他会话」两个出口；不在当前会话的消息流里插一条红字，免得读起来像当前会话出了事。
- 设置两级导航： 侧栏底部常驻「设置与状态」入口；一级页是六行摘要（通知、接入与设备、宿主机、行为与开关、排查、帮助），每行摘要都绑定二级页里真实存在的元素，点进去才是完整设置。首页、新会话页、会话已中断页都能打开。
- 草稿： 输入框草稿按会话保存，新会话页的草稿按工作区分槽，切走再回来不丢。

## PWA 与 Service Worker

- 添加到主屏幕： iOS Safari 与 Android Chrome 都能装成独立全屏的 PWA；PWA 与 Web Push 需要 HTTPS，iOS 还要 16.4+ 并先添加到主屏幕。
- Service Worker 只管推送： app/public/sw.js 处理 install / activate / push / 点击通知 / pushsubscriptionchange ， 不做缓存、不做离线 ；点开通知直达对应会话。 app/public/js/sw-cleanup.js 负责清理旧版遗留的 Service Worker。
