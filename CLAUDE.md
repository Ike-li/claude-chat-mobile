# 项目概述

> `AGENTS.md` 是指向本文件的符号链接。修改本文件即同时更新两者，不要新建独立的 `AGENTS.md`。

移动端聊天式 Web UI，把**本机 claude CLI** 接到手机上。目标是终端等价性："坐在电脑前对 claude 打字"和"在手机上打字"效果一样。

技术栈：Node ≥20 · ESM · Express 5 · Socket.io · Agent SDK · `jose`（JWT）· `web-push`（离线推送）；**版本号一律以 `package.json` 为准**。测试用内置 `node --test` + Playwright。运行时代码在 `app/`（`app/src/` 后端 · `app/public/` 前端 · `app/server.js` 入口），测试与门禁全在 `tests/`，用户要敲的装机运维命令在 `scripts/`，macOS 菜单栏在 `desktop/`。

**产品立场 n=1 自托管**（单用户、无多租户）。硬性规则、n=1 取舍、已决「不做」的技术债见 [docs/hard-rules.md](docs/hard-rules.md)。

按目录生效的细则在 `.claude/rules/`，读写对应文件时自动加载。

## 动手前

- 不知道某个功能该怎么做时：**CLI 有什么 web 就有什么**，先去找 claude code CLI 是怎么实现的。Agent SDK 文档在 https://code.claude.com/docs/en/agent-sdk/overview ，尽量不重复造轮子。
- 改动涉及同步链路、推送、镜像锁、事件回放时，**先读 [docs/architecture.md](docs/architecture.md)**——判据都在那里，凭直觉改这几处基本会错。
- 要新增、修改或删除任何测试文件之前，**先读 [docs/testing.md](docs/testing.md)**。
- **不开无鉴权的 HTTP 数据端点**：`/health`、`/metrics`、历史回显都过鉴权。
- 桌面端 CCM.app 或另一个 server 占着端口时，**勿再手动 `npm start`**；临时起 server 必须带一次性的 `CCM_DATA_DIR`，否则写进生产 `data/`。

## 测试跑在哪：宿主机只跑白名单，其余进容器

- **宿主机只跑** `npm run lint`、`npm run check`、`npm run test:unit`、`npm run test:e2e` 及其同源别名（真相源 `tests/gates/guard-host-tests.js` 的 `HOST_ALLOWED_SCRIPTS`）。`test:invariants:server` 与 `test:invariants:env` 不在名单上，别照后缀类推。
- **其余一律进容器**：`npm run test:docker`、`npm run mutate:docker -- <文件>` 等，首次先 `npm run docker:build`。PreToolUse 钩子对有容器替代的命令直接 deny 并指出改跑哪条。
- **要人单独授权的三类**（真凭据、花真额度）：`RUN_CLAUDE_INTEGRATION=1`、`npm run test:smoke`、用 `tests/acceptance/env/up.mjs` 起含 E3 的验收环境。
- 为什么是白名单：2026-08-02 宿主机跑 `mutate` 删光了 `~/.claude/projects`。不在名单上的默认进容器，判断错了顶多多跑一次容器。详见 [docs/hard-rules.md](docs/hard-rules.md) §4.2。
- 跑 E2E：本机必带 `NO_PROXY=127.0.0.1,localhost`；`--grep` 的模式带空格必须加引号；`--only-changed` 在本仓会选出 0 个测试然后报绿；全量用 `npm run test:e2e:parallel`。见 docs/testing.md §4。

## 分支纪律

- 日常改动走 feature 分支 → PR → `dev`，不在 `dev`、`master` 上直接提交。**默认分支是 `master`，开 PR 必须显式 `--base dev`**。
- `master` 只接受 `scripts/release.sh` 开的 `dev` → `master` 发版 PR，HEAD 恒等于最新发布——装机 `curl` 直接拉 `master` 的源码归档。发版 PR 产生 merge commit，`master` 不等于 `dev` 的 tip 是正常的，不要把 `master` 合回 `dev`。

## 文档

[docs/architecture.md](docs/architecture.md)（双通道、单驾驶员、回放、推送）· [docs/testing.md](docs/testing.md) 与 [tests/README.md](tests/README.md)（怎么写测试、执行槽、不变量编号）· [docs/display-contracts.md](docs/display-contracts.md)（模型、effort、statusline 展示语义；改契约先改 `tests/unit/display-contracts.test.mjs`）· [docs/deployment.md](docs/deployment.md)（常驻、隧道、CF Access）· [docs/getting-started.md](docs/getting-started.md)（装机与运维命令）

# Compact instructions

压缩时必须保留，宁可多留：

- 当前任务目标，以及用户原话里的约束和停止点（例如「先出方案等批准」「只改某个文件」）
- 已完成和未完成的步骤；有根目录 `TASKS.md` 时写明以它为准
- 改过、新建、删除的文件路径，所在分支或 worktree，未提交的改动，已开的 PR 号
- 关键决策、否决的方案及理由、用户已经拍板的选项
- 跑过的验证命令和结果（哪条红、为什么红）、明知还没验证的项
- 仍在后台运行的命令、子代理或临时 server（端口、`CCM_DATA_DIR`）

可以丢：读过的文件全文、长工具输出原文、已被推翻的中间推测。
