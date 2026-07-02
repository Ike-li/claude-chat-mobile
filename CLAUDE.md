# 项目概述

移动端聊天式 Web UI，把**本机 claude CLI** 投送到手机——目标是终端等价性："坐在电脑前对 claude 打字"和"在手机上打字"效果一样。

## 常用命令

> ⚠️ **生产部署 = 常驻服务**（macOS LaunchAgent / Linux systemd 占着 3000 端口，固定公网域名 + Cloudflare Access 2FA）：**勿手动 `npm start`**（会撞端口）；改 `.env`/代码后须**重启常驻 server 进程**才生效。**例外**：`workdirs.json` 支持热加载——改完即生效、免重启（server 监听文件变化，被移除目录上的已开会话继续运行、仅拒新开）。

```bash
npm start          # node server.js（默认端口 3000）
npm run dev        # node --watch server.js
npm test           # 单测 + 可靠集成(server/auth/upload)；claude-turn 集成默认跳过；--test-force-exit 保证退出。CI 里集成整体 skip
npm run test:unit  # node --test test/*.test.mjs：仅纯逻辑单测（零 token、最快）
npm run test:integration # 仅集成测试（起真 server，需本机 claude CLI）
RUN_CLAUDE_INTEGRATION=1 npm test  # 连同需真 claude agent turn 的集成测试(claude-lifecycle/session-switch/websocket-events：慢/耗 token/不稳)一起跑
npm run test:visual # puppeteer 移动端视觉回归 E2E（零外部依赖 mock server）

# 启动前自检配置
node scripts/doctor.js              # 检查 AUTH_TOKEN/CLAUDE_BIN/WORK_DIR(S)/PORT/settings.json/ANTHROPIC_*
node scripts/doctor.js --env=prod.env  # 指定 .env 文件

# 设备指纹审批与管理
node scripts/device.js list         # 列出所有受信任和等待确认的设备
node scripts/device.js approve <ID> # 批准指定设备 ID
node scripts/device.js deny <ID>    # 拒绝/删除指定设备 ID

# 冒烟验收（真实调用 claude 消耗 token）
# ⚠️ e2e 前先备份会话指针：cp data/sessions.json data/sessions.json.bak && rm data/sessions.json
AUTH_TOKEN='' PORT=3100 WORK_DIR=/tmp/ccm-test node server.js   # 终端 1：测试 server
node scripts/smoke.js              # 终端 2：M1 行走骨架（A1/A2/A4/A6/A9 + 会话切换）
node scripts/smoke.js --phase2     # 重启终端 1 后：跨重启 resume
```

健康检查：`GET /health` → `{status, sessionId, busy, versions, timestamp}`（设了 `AUTH_TOKEN` 时需带 `?token=` 或 `x-auth-token` 头，否则 401）。历史回显走鉴权的 `session:history` socket 事件，不开无鉴权 HTTP 数据端点。
