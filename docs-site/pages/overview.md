# 项目总览
> 定位、适用场景、技术栈与仓库形态。

- **Part**: 第一部分 · 认识项目
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~2389

---

项目面向已经在终端使用 `claude` CLI 的开发者：在手机上与同一个 Agent 对话交互，目标是和坐在电脑前对终端打字效果一样。

## 一句话定位

移动端聊天式 Web UI，通过官方 `@anthropic-ai/claude-agent-sdk` 驱动**本机的** `claude` CLI：你的 CLI 怎么配就怎么用，官方订阅、API key、第三方网关、Bedrock / Vertex 一视同仁。项目不打包独立的模型后端，不另搞平行的 Agent 逻辑；沿用同一套 `CLAUDE.md`、MCP 工具、Skills、Hooks 与本地会话记录（transcript）。

## 核心适用场景

- 长任务在跑，人离开电脑。 Web 驱动的会话里，工具审批、 AskUserQuestion 提问和后台任务完成都推到锁屏，手机上直接点。终端里跑的会话，装上可选的 hooks bridge 后，回合结束与「需要你」也能即时通知到手机，但审批要回终端处理。
- 同一会话，跨设备续接。 手机端与终端基于同一份本地 transcript 流转；手机上开的会话，回到电脑敲 claude --resume 就能接上。同一时刻只有一个驾驶端，接管时会提示。
- 多个工作区之间切换。 在白名单放行的多个本地仓库或 worktree 之间切换，侧栏标出各工作区里正在运行的会话。
- 为触屏重排，不是投屏。 审批卡、提问选项、斜杠命令面板（ / 菜单）、 @ 引用文件、上传图片与粘贴截图、工具卡与变更预览，而不是把终端窗口缩小了放到手机上。

如果只是偶尔看一眼电脑屏幕，远程桌面已经够用。Claude Chat Mobile 面向的是把手机当成电脑上那个 CLI 的随身等价入口。

## 技术栈与基础选型

 Node ≥20 · ESM · Express 5 · Socket.IO 4 · compression  
    Agent 驱动  `@anthropic-ai/claude-agent-sdk` 0.3.278（dev；最新发布版 v1.12.1 为 0.3.263）· 本机 `claude` CLI  
    鉴权 / 推送  `jose` 6（JWT 验证）· `web-push`（VAPID）· 可选 ntfy  
    前端架构  原生 ESM PWA，零构建；依赖全部本地自托管（Tailwind / marked / highlight.js / DOMPurify）  
    测试体系  内置 `node --test`（S0–S7 执行槽分层）· Playwright 移动端 UI E2E · 破坏性测试进容器  
    配置管理  `ccm.config.json`（结构化配置，统一 Schema；工作区列表热加载）  
    开源许可  Apache-2.0 · NOTICE 归属声明（可自托管、商用与闭源再分发）  
 

## 仓库结构与代码地图

| 目录路径 | 职责范围 | 关键约束 |
| --- | --- | --- |
| app/server.js | 运行时启动入口 | 薄封装：加载配置并引导 app/src/server/app.js |
| app/src/ | 服务端业务域 | 按域分层（agent, sessions, server, auth, files, ops, shared），边界由 import 门禁硬闸执行 |
| app/public/ | 前端 PWA 界面 | 纯静态、零构建； js/logic/* 纯函数与单测零构建共用同一份文件 |
| scripts/ | 用户运维命令 + 少量维护者工具 | 用户命令： setup 、 doctor 、 config 、 device 、 qr 、 service 、 uninstall 与两个 CLI 桥； release.sh 等维护者工具不进分发归档 |
| desktop/ | macOS 菜单栏应用 | 原生 Swift 菜单栏工具（CCM.app）与 LaunchAgent 模板 |
| tests/ | 测试与门禁的唯一根目录 | unit/ 、 invariants/ 、 integration/ 、 e2e/ 、 gates/ 、 infra/ ；整棵树不进分发归档 |
| docs/ | 产品文档 | getting-started.md 、 deployment.md 、 architecture.md 、 hard-rules.md 、 display-contracts.md 、 testing.md |

> **WARNING:** 架构脆弱点警示：项目根路径计算 — app/src/** 下计算项目根目录必须向上穿透三层（如 app/src/server/app.js 或 app/src/shared/data-dir.js）。因为 data/、scripts/ 与 ccm.config.json 位于仓库顶级根目录，若少算一层会导致数据和配置文件静默解析到 app/ 目录下且毫无报错。

## 分支纪律与分发

- dev ：开发主线。日常改动走 feature 分支 → PR → dev，每个小改动一个 PR；dev 要求 PR 且 CI 必须绿。
- master ：对外发布的稳定版本，HEAD 恒等于最新发布，同时是 GitHub 默认分支。只接受 scripts/release.sh 开的 dev → master 发版 PR（等真 CI 绿、合并后在 master HEAD 上打 tag）。
- 分发 ：装机的 curl 直接拉 GitHub 对 master 的源码归档，GitHub 现场 git archive 并遵守 .gitattributes 的 export-ignore ；发版不打包、不上传资产。
- gh-pages ：站点（落地页、在线演示、架构图集、本手册），孤儿分支。
- promo ：宣传文案创作区，孤儿分支，非源码。

## 装机与运行前置条件

1. Node.js ≥ 20。
2. 本机 claude CLI 能在终端正常跑完一轮会话。 官方订阅要已 /login ；第三方网关不走 Anthropic 登录，永远不会出现 Not logged in ，要的是 ANTHROPIC_* 真的生效。
3. 模型通路配置属于 claude CLI，不属于本项目。 第三方网关推荐写在 CLI settings 文件的 env 块（工作区的 .claude/settings.local.json ，或 ~/.claude/settings.json ），它按工作区目录生效，macOS 桌面端拉起的常驻服务同样认。也可以在启动 server 的 shell 里 export ，但只对 headless 终端入口有效。写进 ccm.config.json / .env 的 ANTHROPIC_* 会在启动期被剥除，并在启动日志里点名。
4. 操作系统。 macOS 或 Linux；原生 Windows 属实验路径，推荐 WSL2。常驻只有两条入口：headless 终端 npm start ，或 macOS 菜单栏应用 CCM.app。
