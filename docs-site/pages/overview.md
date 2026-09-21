# 项目总览
> 定位、适用场景、技术栈与仓库形态。

- **Part**: 第一部分 · 认识项目
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~2064

---

项目面向已经在终端使用 `claude` CLI 的开发者：在手机上与同一个 Agent 对话交互，体验与效果完全等同于坐在电脑前操作终端。

## 一句话定位

移动端聊天式 Web UI，通过官方 `@anthropic-ai/claude-agent-sdk` 驱动**本机已登录的** `claude` CLI。项目不打包独立的模型后端，不另搞平行的 Agent 逻辑；无缝继承同一套 `CLAUDE.md`、MCP 工具、自定义 Skills、Hooks 以及本地会话历史（Transcripts）。

## 核心适用场景

- 长耗时任务在后台跑，人离开电脑。 终端执行中的工具审批、人机提问和后台子代理完成事件实时推送到手机通知栏，轻点即可放行或驳回。
- 同一会话，跨设备无缝续接。 手机端与终端基于同一份本地 CLI Transcript 会话记录流转；在路上掏出手机起头，回到办公室敲 claude --resume 即刻连上。
- 多项目工作区快速切换。 基于严格的工作区路径白名单，支持在多个本地 Git 仓库或 Worktree 之间一键切换并并发监视进展。
- 原生触控与移动端优化。 专为触屏调优的输入框、斜杠命令面板（ / 菜单）、相册图片直传、长按快捷操作与代码块折叠，而不是机械地缩放终端窗口。

如果只是偶尔临时查看电脑屏幕，远程桌面已足够。Claude Chat Mobile 面向的是「将移动端打造成电脑 CLI 随身等价入口」的高频生产力需求。

## 技术栈与基础选型

 Node ≥20 · ESM 规范 · Express 5 · Socket.IO 4 · compression  
    Agent 驱动  `@anthropic-ai/claude-agent-sdk` 0.3.263 · 本机 `claude` CLI  
    鉴权 / 推送  `jose` 6（JWT 验证）· `web-push`（VAPID 协议）· 可选 ntfy  
    前端架构  原生 ESM PWA 架构；依赖完全本地自托管（Tailwind / marked / highlight.js / DOMPurify）  
    测试体系  内置 `node --test`（S0–S7 执行槽分层）· Playwright 移动端 UI E2E · 容器沙箱 HOME 隔离  
    配置管理  `ccm.config.json`（结构化配置，支持工作区热重载与统一 Schema）  
    开源许可  Apache-2.0 · NOTICE 归属声明（可自托管、商用与闭源再分发）  
 

## 仓库结构与代码地图

| 目录路径 | 职责范围 | 关键约束 |
| --- | --- | --- |
| app/server.js | 运行时启动入口 | 薄封装：加载环境变量、注入安全时戳并引导 app/src/server/app.js |
| app/src/ | 服务端业务域 | 按域严密分层（agent, sessions, server, auth, files, ops, shared） |
| app/public/ | 前端 PWA 界面 | 纯静态无打包构建，静态资源与 logic 纯函数与后端零构建同源复用 |
| scripts/ | 维护者与装机工具 | setup.js 、 doctor.js 、 config.js 、 device.js 、 release.sh |
| desktop/ | macOS 状态栏应用 | 原生 Swift 状态栏菜单栏工具（CCM.app）与 LaunchAgent 模板 |
| tests/ | 测试体系唯一根目录 | unit/ 、 invariants/ 、 integration/ 、 e2e/ 、 gates/ 、 infra/ |
| docs/ | 架构真相源文档 | architecture.md 、 hard-rules.md 、 testing.md 、 display-contracts.md |

> **WARNING:** 架构脆弱点警示：项目根路径计算 — app/src/** 下计算项目根目录必须向上穿透三层（如 app/src/server/app.js 或 app/src/shared/data-dir.js）。因为 data/、scripts/ 与 ccm.config.json 位于仓库顶级根目录，若少算一层会导致数据和配置文件静默解析到 app/ 目录下且毫无报错。

## 分支纪律与工作流

- dev ：日常开发与新特性主干，日常改动一律在 dev 上进行。
- master ：生产稳定分支与 GitHub 默认分支，受分支保护。仅在发版时通过 scripts/release.sh 执行 fast-forward 合并与分发裁剪。
- gh-pages ：独立展示与全景手册分支，纯静态产物托管。
- promo ：宣发文案创作工作区，非源码逻辑。

## 装机与运行前置条件

1. Node.js 运行环境。 需 Node ≥20（推荐 LTS 版本），纯 ESM 模式运行。
2. 本机可用且已登录的 claude CLI。 执行 which claude 确认命令可寻址，且能在本地终端正常交互。
3. Anthropic 订阅或 API 凭据。 使用官方订阅沿用 CLI 登录凭据；如使用第三方网关， 必须在启动 server 的 shell 中 export ANTHROPIC_* 。写入配置文件（无论是 ccm.config.json 还是 .env ）都会在启动期被 无条件剥除并告警 ，以确保配置文件不压过 shell 中的 provider 凭据（遵循终端等价性）。
4. 操作系统支持。 以 macOS（原生支持桌面菜单栏 CCM.app 与 launchd）和 Linux（systemd / Docker）为一等支持平台。
