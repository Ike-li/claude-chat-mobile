# 前端与 PWA
> app/public/ 分层、Socket 客户端、可安装 PWA。

- **Part**: 第四部分 · 核心实现
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~1200

---

前端采用原生纯 ESM 规范的单页应用（PWA）架构：Express 静态直接托管 `app/public/`，无需 Webpack / Vite 等前置编译，零外部 CDN 运行时依赖。

## 目录分层与职责划分

| 文件 / 目录路径 | 职责定位与架构约束 |
| --- | --- |
| app/public/index.html | HTML 宿主外壳、移动端视口设置、PWA Manifest 引用 |
| app/public/css/app.css | 样式定义（基于原生 CSS 变量系统与纯色 Tailwind Token，禁止 Alpha 复合透明度） |
| app/public/js/app.js | 顶层协调器：挂载全局 Socket、路由事件、装配子模块 |
| app/public/js/app/* | 按业务域划分的子模块工厂（如 event-dispatch.js 、 chat-ui.js ），采用 Context 依赖注入 |
| app/public/js/logic/* | 纯逻辑层 ：零依赖纯函数集合（数据进、数据出），不碰 DOM/Window/Socket，与单测零构建同源复用 |
| app/public/js/canonicalize.js | 前后端共享白名单工具：统一操作指纹与规范化逻辑 |
| app/public/vendor/ | 第三方库本地离线托管（Tailwind 运行时、marked 解析器、highlight.js 代码高亮、DOMPurify 防 XSS） |
| app/public/manifest.webmanifest | PWA 安装清单文件，支持独立全屏显示与移动端沉浸模式 |

> **TIP:** 前端状态架构原则 — 任何新功能的状态严禁再直接挂入 app.js 的顶层作用域。新状态必须进 app/public/js/app/ 域模块；纯计算逻辑一律下沉为 app/public/js/logic/* 纯函数。

## 状态管理与交互体验设计

- 鉴权凭据安全存取。 首次通过 URL Hash（ #token=... ）注入密钥，存入本地 localStorage 后立即从浏览器地址栏抹除，避免分享截图或误发 URL 泄露密钥。
- 跨设备已读状态与长按标未读。 会话列表支持长按将已读会话反向标为未读。该状态采用 LWW（Last-Write-Wins）时间戳比对模型实时同步至服务端，实现跨设备状态一致。
- 阻塞落地页智能导引。 当试图打开一个正在被后台子代理独占锁定的会话时，系统不会跳空白页，而是精准渲染该会话自身的专属阻塞提示栏，展示锁来源并在其解锁时无感自动恢复。
- 输入框长文本智能防截断。 针对手机软键盘「发送」与「换行」键行为进行针对性适配，杜绝移动端长文本发送时的意外截断问题。

## PWA 与 Service Worker

Service Worker（位于 `app/public/sw.js`，另有清理脚本 `app/public/js/sw-cleanup.js`）负责后台生命周期管理：

- 支持 Web App Manifest，在 iOS Safari 与 Android Chrome 上均可一键「添加到主屏幕」化身为独立 Native 质感应用。
- 配合 web-push 协议，在屏幕熄灭或切换到其他 App 时接收后台系统级推送；点击通知直接精准直达对应的会话标签页。
