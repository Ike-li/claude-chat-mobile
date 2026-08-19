# 项目概述

移动端聊天式 Web UI，把**本机 claude CLI** 接到手机上。目标是终端等价性："坐在电脑前对 claude 打字"和"在手机上打字"效果一样。

技术栈：Node ≥20 · ESM · Express 5 · Socket.io 4 · `@anthropic-ai/claude-agent-sdk` 0.3.201 · `jose` 6（JWT）· `web-push`（离线推送）· 测试用内置 `node --test` + Playwright（移动端 UI E2E，断言基于 DOM 状态非像素比对）。

当你不知道怎么处理功能时，CLI 有什么 web 就有什么，请找一找 claude code cli 是怎么实现这个功能的。
Agent SDK：https://code.claude.com/docs/en/agent-sdk/overview，尽量不要重复造轮子
新功能的状态别再落 `public/js/app.js` / `src/server/app.js` 顶层作用域：前端新状态进 `public/js/app/` 模块（工厂 + context 注入，样板见 `public/js/app/event-dispatch.js`），后端新状态进所属域模块。存量不动。

双向实时同步走 Socket.io，出向消息统一收敛成 `agent:event` 信封（type 白名单见 `src/shared/protocol.js` 的 `AGENT_EVENT_TYPES`，当前 26 种；seq+epoch 去重回放，`npm run check` 校验出入向事件契约）；并存这几条通道——Web 主动发消息用发送路径(Web→Agent SDK→Claude Code CLI)/接收路径(Claude Code CLI→Agent SDK→Web)，SDK 流式转发+攒批缓冲；CLI 终端直接驱动则不经过 Agent SDK，靠磁盘 transcript 轮询（`catchUpTick`）同步只读镜像，"单驾驶员模型"防两端同时写分叉（Web 发消息前若检测到外部写入，先 dispose 旧 SDK 子进程再 resume 吸收）；设备审批靠文件监听 `trusted-devices.json` 广播（四个入口：桌面端菜单栏、web 端已信任设备远程准入、headless 终端回车/deny（要 TTY，launchd 起的 server 没有）、`scripts/device.js`）；新设备入列会推一条不含 ID/IP 的通知（5 分钟节流）；终端会话的「回合结束/需要你」可选装 CLI hooks 桥（`npm run hooks:install`，事件走 `~/.claude/ccm/hooks-v1/` 文件投递箱 + server fs.watch，把轮询变即时信号，未装则回落轮询）；离线唤醒走 web-push/ntfy——**审批/提问/后台任务完成无条件推**（用户可能锁屏或在别的 app），只有回合完成的 `result` 在「approved 房间有前台可见连接」时才抑制（前台判据是客户端上报的 `client:presence`，不是 socket 连着）；body 默认最小化不含正文，用户可按设备开启「推送内容预览」后改发 `previewBody`（见 `src/ops/notifications.js`、`notify-channels.js`）。

**产品立场 n=1 自托管**（单机主、无多租户）。硬性规则、n=1 取舍、已决「不做」的技术债（AD-5 / SP-10 等）见 [docs/hard-rules.md](docs/hard-rules.md)。历史 design 文档已下线，以该文 + 实现为准。

## 分支纪律

**日常开发一律在 `dev` 分支，不要在 `master` 上直接改**（`master` = 稳定分支 / GitHub 默认 / `clone` 默认拿到，有分支保护）。功能做完再由 `dev` ff 合并进 `master` 并发版（用 `scripts/release.sh`）。

其他分支的常驻 worktree 检出位是仓库外的平级兄弟目录（`../claude-chat-mobile-<分支名>`，如 `claude-chat-mobile-promo`=宣传创作区、`claude-chat-mobile-gh-pages`=展示站、`claude-chat-mobile-third-party`=三方代理专用），**不是本分支源码**，物理上不在本仓库树内，开发/搜索/审查天然不会扫到，无需额外排除规则。

## 测试跑在哪：宿主机只跑白名单，其余进容器

**宿主机上只允许跑这四条**：`npm run lint`、`npm run check`、`npm run test:unit`、`npm run test:e2e`
（钩子的白名单还含同源别名：`lint:fix`、`test:visual`、`test:playwright`、`test:playwright:p0`，见 `scripts/guard-host-tests.js` 的 `HOST_ALLOWED_SCRIPTS`）。
前三条不起 server、不 spawn claude；E2E 打的是 `tests/e2e/mock/server.js`（纯 mock，零外部依赖，
已核实不碰 `~/.claude`）。

**其余一切会跑测试的命令，一律进容器**：`npm run test:docker`（容器里跑单测 + 集成）、
`npm run test:docker:e2e`、`npm run mutate:docker -- <文件>`。首次用先 `npm run docker:build`
（拉 Playwright 镜像 + npm ci，约 7 分钟）。

> `test:docker` 不含 `check`：`inventory:check` 要 `git ls-files`，而 worktree 检出的 `.git` 是指向
> 宿主机路径的指针文件，容器里解析不到。`check` 本来就在宿主机白名单里，留在宿主机跑即可。

> **为什么是白名单，不是"危险命令清单"**
> 2026-08-02 那次把机主 `~/.claude/projects` 整棵树删光（70 个项目 / 291 memory / 2990 transcript），
> 根因不是没看见警告，是**没把 `npm run mutate` 归类成破坏性操作**——它会故意把源码改坏再跑测试，
> 而被改坏的恰恰可能是算删除路径的代码（当时 `getProjectDir` 被改成恒返回 `''`，
> `join(真实根, '')` 塌成真实根本身，测试的 `rmSync` 就打上去了）。
>
> 黑名单要求"每遇到一个新命令都正确归类"，而那正是失败的那一步。白名单反过来：
> **不在名单上的默认进容器**，判断错了顶多多跑一次容器，代价不对称地小。

容器里 `HOME` 是一次性目录，`~/.claude/projects` 解析到容器内空壳——这道防线**不依赖任何代码正确性**，
和仓库里那三层代码级防护（`mutate` 的沙箱 HOME、删除点护栏、`check-destructive-deletes` 门禁）是不同的轴。

**两档例外不进容器**（需要真凭据，得单独授权）：
`RUN_CLAUDE_INTEGRATION=1`（7 个需真 agent turn 的文件）与 `npm run test:smoke`。
其余全部零 token——集成层靠 `tests/fixtures/fake-claude.sh` 过 preflight。

## 常用命令

> ⚠️ **启动只有两条入口**：headless = 终端 `npm start`；macOS 还可走 `desktop/` 的 CCM.app。桌面端占着 3000 时**勿再手动 `npm start`**。改配置/代码后，桌面端菜单里 server 一行点「重启」，headless 重启那个进程。**例外**：工作区列表支持热加载，改完即生效、免重启（`ccm.config.json` 的 `WORKDIRS` 或旧版 `workdirs.json`，server 监听文件变化，被移除目录上的已开会话继续运行、仅拒新开）。哪些项热加载由 schema 的 `reload` 标记决定，当前只有 `WORKDIRS`。

配置统一放在项目根 `ccm.config.json`（结构化 JSON，`AUTH_TOKEN`/`PORT`/`WORKDIRS`/各开关都在里面）；旧版 `.env` 仍受支持——**新文件存在时优先，缺失才回落 `.env`**。schema 单一事实源是 `src/ops/env-schema.js`，读写与类型归一在 `src/ops/config-file.js`（读写必须同源，写错源＝假成功）。环境变量始终压过文件。

```bash
npm start          # node server.js（默认端口 3000）
npm run dev        # node --watch server.js
npm run check      # ESLint（语法+死代码+未定义引用）+ 模块边界守卫（分层不变量+零循环依赖）+ 双向事件契约（出向 agent:event 类型 + 入向 socket 事件名）+ 文档一致性（含契约计数：文档写的「当前 N 种/个」按 `protocol.js` 真值校验）+ n=1 假设面登记簿（`docs/hard-rules.md` §2 表格 ⇔ 代码 `// n1: <ID>` 标记双向相等）+ i18n 词典孤儿 key 扫描 + 破坏性删除守卫（测试里的 recursive 删除必须可追溯到 mkdtemp，否则写 `// safe-rm: 理由`；生产代码里「追不到一次性目录、目录段由代码算出」的单文件删除要写 `// safe-path: 理由`——两种标记不通用，为单文件删除批的豁免不放行递归删除）+ visual mock registry guard + 禁止模式 + inventory（零 token、最快）
npm run lint       # 仅 ESLint（eslint .）；lint:fix 自动修可修项
npm test           # 单测 + tests/integration/*.test.mjs 全部（不是只跑 server/auth/upload 那几个）；其中需真 agent turn 的 7 个由 RUN_CLAUDE_INTEGRATION 门控、默认跳过；--test-force-exit 保证退出。CI 不跑本条(force-exit 会腰斩异步单测)，拆成 test:unit + test:integration 两步
npm run test:unit  # node --test tests/unit/*.test.mjs：零 token、不 spawn claude、不起 server（最快）。注意「单测」不等于「纯函数」——相当一部分文件会用 mkdtemp 临时目录或 spawnSync 跑本仓脚本（门禁类、CLI 类、文件类），隔离靠 preload-env + 一次性目录
npm run test:integration # 仅集成测试（起真 server，需本机 claude CLI）。CI 里靠 CLAUDE_BIN 指向 tests/fixtures/fake-claude.sh 过 preflight，接线类用例真跑
RUN_CLAUDE_INTEGRATION=1 npm test  # 连同需真 claude agent turn 的集成测试一起跑(慢/耗 token/不稳；共 7 个文件：claude-lifecycle/session-switch/websocket-events/aborted-state/message-idempotency/approval-integrity 整份 + file-upload 一个 describe)
npm run test:e2e   # Playwright 移动端 UI 回归（零外部依赖 mock server）
npm run test:visual # test:e2e 的兼容别名

# 启动前自检配置
node scripts/doctor.js              # 启动自检：AUTH_TOKEN/CLAUDE_BIN/WORK_DIR(S)/PORT/WEB_STATUSLINE/CLI statusline bridge 安装态/CLI hooks 桥安装态/ANTHROPIC_* + 配置权限/文档一致性/前端语法/覆盖率/桌面端服务安装态
node scripts/doctor.js --env=prod.env  # 指定 .env 文件

# macOS 桌面端（第二条入口；下面 service:* 是它背后的 CLI，一般不用手敲）
npm run app:install                 # 编译并装进 /Applications —— Spotlight/Launchpad 可搜；升级后菜单点「重启应用」
npm run app:build                   # 只编译到 desktop/build/CCM.app，不装系统目录
npm run service:status              # 各 unit 的运行态/归属/漂移；--json 供菜单栏与 doctor 消费
npm run service:install|adopt|restart|logs|health   # adopt=接管手工安装（只写 manifest 不碰 plist）；uninstall 须 --yes
npm run uninstall -- [--purge] [--dry-run] --yes    # 一键卸载（受管服务+残留 menubar 进程+CCM.app+偏好域+两个桥+~/.claude/ccm；--purge 连数据根白名单/配置/受管日志）；只删产品自己装的，manifest 外的 unit/~/.cloudflared/~/.claude/projects 永不碰

# 设备指纹审批与管理
node scripts/device.js list         # 列出所有受信任和等待确认的设备
node scripts/device.js list --json  # 机读快照（桌面端菜单栏「🔐 N 台新设备等待批准」的数据源）
node scripts/device.js approve <ID> # 批准指定设备 ID
node scripts/device.js deny <ID>    # 拒绝/删除指定设备 ID

# 冒烟验收（真实调用 claude 消耗 token；runner 自动使用随机端口和临时 CCM_DATA_DIR）
npm run test:smoke -- --list
npm run test:smoke -- --scenario core
```

健康检查：`GET /health` → `{status, sessionId, busy, versions, buildNonce, timestamp}`（设了 `AUTH_TOKEN` 时需带 `?token=` 或 `x-auth-token` 头，否则 401）。运行时可观测：`GET /metrics`（同样鉴权）→ `{metrics{activeSessions,events,catchUpHits,catchUpReloads,rateLimitLockouts,pushSuccess,pushFailure,ntfyFailure,clientErrors,hookEventsConsumed,hookEventsIgnored,hookPushes}, state, states, timestamp}`——指标最小集 + StateProbe 五类状态分类（后端产出四类，host_offline 由客户端心跳判定）；**鉴权 JSON 快照**，非 Prometheus 文本（n=1 自托管默认无 scraper；多实例 scrape 需先改 [docs/hard-rules.md](docs/hard-rules.md) 立场）。历史回显走鉴权的 `session:history` socket 事件，不开无鉴权 HTTP 数据端点。服务状态可见性（判定化）：`instances` 广播额外带 `service{startedAt,deliveryFailure,rateLimitLockout,clientError}` 字段（startedAt 供面板"运行时长/启动于"展示 + 推送投递健康 + 登录限速锁定 + 前端错误告警，告警均带 24h 时效窗自动退场；与"需要你(N)"聚合是不同轴，不混判）；服务状态面板只渲染 基础+判定化告警 两段，不展示裸计数器（对人无参照系不可解读，原始计数留 `/metrics` 巡检端点）。
