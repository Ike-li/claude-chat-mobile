# 项目概述

移动端聊天式 Web UI，把**本机 claude CLI** 接到手机上。目标是终端等价性："坐在电脑前对 claude 打字"和"在手机上打字"效果一样。

技术栈：Node ≥20 · ESM · Express 5 · Socket.io 4 · `@anthropic-ai/claude-agent-sdk` 0.3.201 · `jose` 6（JWT）· `web-push`（离线推送）· 测试用内置 `node --test` + Playwright（移动端 UI E2E，断言基于 DOM 状态非像素比对）；gifenc/pngjs 仅供 `scripts/make-demo-gif.js` 生成宣传用 demo.gif，非测试工具链。

当你不知道怎么处理功能时，CLI 有什么 web 就有什么，请找一找 claude code cli 是怎么实现这个功能的。
Agent SDK：https://code.claude.com/docs/en/agent-sdk/overview，尽量不要重复造轮子
发送路径(Web→Agent SDK→Claude Code CLI)和接收路径(Claude code CLI→Agent SDK→Web)

## 分支纪律

**日常开发一律在 `dev` 分支，不要在 `master` 上直接改**（`master` = 稳定分支 / GitHub 默认 / `clone` 默认拿到，有分支保护）。功能做完再由 `dev` ff 合并进 `master` 并发版（用 `scripts/release.sh`；分支与发布模型见 `docs/design.md §7`）。

## 常用命令

> ⚠️ **生产部署 = 常驻服务**（macOS LaunchAgent / Linux systemd 占着 3000 端口，固定公网域名 + Cloudflare Access 2FA）：**勿手动 `npm start`**（会撞端口）；改 `.env`/代码后须**重启常驻 server 进程**才生效。**例外**：`workdirs.json` 支持热加载，改完即生效、免重启（server 监听文件变化，被移除目录上的已开会话继续运行、仅拒新开）。

```bash
npm start          # node server.js（默认端口 3000）
npm run dev        # node --watch server.js
npm run check      # ESLint（语法+死代码+未定义引用）+ 模块边界守卫（分层不变量+零循环依赖）+ 双向事件契约（出向 agent:event 类型 + 入向 socket 事件名）+ 文档一致性 + visual mock registry guard + 禁止模式 + inventory（零 token、最快）
npm run lint       # 仅 ESLint（eslint .）；lint:fix 自动修可修项
npm test           # 单测 + 可靠集成(server/auth/upload)；claude-turn 集成默认跳过；--test-force-exit 保证退出。CI 里集成整体 skip
npm run test:unit  # node --test tests/unit/*.test.mjs：仅纯逻辑单测（零 token、最快）
npm run test:integration # 仅集成测试（起真 server，需本机 claude CLI）
RUN_CLAUDE_INTEGRATION=1 npm test  # 连同需真 claude agent turn 的集成测试(claude-lifecycle/session-switch/websocket-events：慢/耗 token/不稳)一起跑
npm run test:e2e   # Playwright 移动端 UI 回归（零外部依赖 mock server）
npm run test:visual # test:e2e 的兼容别名

# 启动前自检配置
node scripts/doctor.js              # 11 项自检：AUTH_TOKEN/CLAUDE_BIN/WORK_DIR(S)/CCM_DATA_DIR/PORT/WEB_STATUSLINE/ANTHROPIC_* + 配置权限/文档一致性/前端语法/覆盖率
node scripts/doctor.js --env=prod.env  # 指定 .env 文件

# 设备指纹审批与管理
node scripts/device.js list         # 列出所有受信任和等待确认的设备
node scripts/device.js approve <ID> # 批准指定设备 ID
node scripts/device.js deny <ID>    # 拒绝/删除指定设备 ID

# 冒烟验收（真实调用 claude 消耗 token；runner 自动使用随机端口和临时 CCM_DATA_DIR）
npm run test:smoke -- --list
npm run test:smoke -- --scenario core
```

健康检查：`GET /health` → `{status, sessionId, busy, versions, timestamp}`（设了 `AUTH_TOKEN` 时需带 `?token=` 或 `x-auth-token` 头，否则 401）。运行时可观测（NFR-15/docs/design.md）：`GET /metrics`（同样鉴权）→ `{metrics{activeSessions,events,catchUpHits,catchUpReloads,rateLimitLockouts,pushSuccess,pushFailure,ntfyFailure,clientErrors}, state, states, timestamp}`——指标最小集 + StateProbe 五类状态分类（后端产出四类，host_offline 由客户端心跳判定）；JSON 非 Prometheus 文本（n=1 无 scraper）。历史回显走鉴权的 `session:history` socket 事件，不开无鉴权 HTTP 数据端点。服务状态可见性（判定化）：`instances` 广播额外带 `service{startedAt,deliveryFailure,rateLimitLockout,clientError}` 字段（startedAt 供面板"运行时长/启动于"展示 + 推送投递健康 + 登录限速锁定 + 前端错误告警，告警均带 24h 时效窗自动退场；与"需要你(N)"聚合是不同轴，不混判）；服务状态面板只渲染 基础+判定化告警 两段，不展示裸计数器（对人无参照系不可解读，原始计数留 `/metrics` 巡检端点）。
