# QA Project Context — claude-chat-mobile

## Product

- **Name:** claude-chat-mobile
- **Description:** 移动端聊天式 Web UI，把本机 claude CLI 投送到手机。目标是终端等价性：在手机上打字 = 坐在电脑前对 claude 打字。
- **Type:** Self-hosted web app（开源，面向大众自托管；每实例单用户、非多租户 SaaS）
- **Production URL:** 通过 Cloudflare Tunnel 暴露的公网域名（需 AUTH_TOKEN + CF Access 2FA）
- **Dev URL:** `http://127.0.0.1:3000`（本地直连）

### Key User Journeys

1. **发送消息并接收流式回复** — 手机输入 prompt → claude 子进程启动 → 流式输出到手机端
2. **会话管理与切换** — 查看历史会话列表、切换会话、resume 中断的会话
3. **多仓库切换** — 在不同 WORK_DIR 之间切换工作目录
4. **文件上传** — 通过手机上传图片/文件到 claude 上下文
5. **工具审批** — claude 请求工具执行时在手机端 approve/deny
6. **齿轮面板（设置）** — 切换模型、调整 effort、管理权限模式
7. **推送通知** — claude 完成任务后 Web Push 通知手机
8. **公网安全接入** — 通过 AUTH_TOKEN + CF Access 2FA 从外网访问

## Tech Stack

| Layer | Technology | Version / Notes |
|-------|-----------|-----------------|
| Runtime | Node.js | ≥20（ESM，`"type": "module"`） |
| Backend | Express | 5.0（`server.js` 单文件入口） |
| Realtime | Socket.IO | 4.8（双向 WebSocket 通信） |
| Frontend | Vanilla JS + HTML | PWA（`public/`），无框架 |
| AI | `@anthropic-ai/claude-agent-sdk` | 0.3.201（spawn claude 子进程） |
| Auth | `jose` (JWT) + `dotenv` | AUTH_TOKEN 鉴权 + CF Access |
| Push | `web-push` | VAPID Web Push |
| Tunnel | cloudflared | Cloudflare Tunnel 公网暴露 |
| Data | 文件系统 | `data/` 目录（sessions.json, devices 等） |
| Hosting | macOS LaunchAgent | 常驻服务占 3000 端口 |

## Test Stack

### Unit Tests

- **Framework:** Node.js built-in test runner (`node --test`)
- **Config:** 无独立配置文件，直接运行 `npm run test:unit`
- **Test Directory:** `test/*.test.mjs`（根级单测；数量以命令输出为准）
- **Coverage:** `npm run test:coverage`（`--experimental-test-coverage`）
- **特点:** 纯逻辑单测，零 token；CI 通过 `npm test` 一并运行

### Integration Tests

- **Framework:** Node.js built-in test runner（与单测相同）
- **Test Directory:** `test/integration/*.test.mjs`（集成测试；数量以命令输出为准）
- **Helpers:** `test/helpers/integration.mjs`（服务器启动、socket 客户端、事件收集）
- **运行:** `npm run test:integration`；`npm test` 也会包含此 lane
- **特点:** 使用 CCM_DATA_DIR 隔离；需真实 Claude agent turn 的路径在 CI 中跳过或需显式 opt-in
- **覆盖:** server/auth/upload、会话/Socket 边界，以及显式 opt-in 的真实 Claude 生命周期路径

### Visual E2E

- **Framework:** Puppeteer 25.1
- **Config:** `scripts/visual-e2e-runner.js`（自定义 runner）
- **Mock Server:** `scripts/visual-mock-server.js`（端口 3100）
- **运行:** `npm run test:visual`（mock-only；GitHub Actions 的 `visual-e2e` job 也跑）
- **视口:** iPhone X（375×812），headless Chrome
- **截图输出:** `public/test-snapshots/`

### Playwright P0 Mock Regression

- **Framework:** Playwright (`@playwright/test`)
- **Config:** `playwright.config.ts`
- **Mock Server:** `scripts/visual-mock-server.js`（默认 `127.0.0.1:33341`）
- **运行:** `npm run test:playwright:p0`
- **特点:** 零 token、mock-only、每日回归安全；详见 `specs/README.md`

### Smoke Tests

- **Framework:** 无（手写脚本）
- **Location:** `scripts/smoke*.js`（12+ 个场景脚本）
- **运行:** 手动执行（需真实 claude 进程，消耗 token）
- **场景:** M1 行走骨架、跨重启 resume、并发、上传、模型切换等

## CI/CD

- **Platform:** GitHub Actions
- **Workflow:** `.github/workflows/test.yml`
- **触发:** push to `master` / `dev` + 所有 PR
- **Jobs:**
  - `unit-test`: `npm ci` → `npm test`（单测 + 集成测试；需真 Claude 的路径在 CI 中跳过或显式 opt-in）
  - `visual-e2e`: `npm ci` → `npx puppeteer browsers install chrome` → `npm run test:visual`（Visual E2E）
- **阻断:** 任一 job 失败 → CI 红 → PR 无法合并（分支保护 require check）
- **缓存:** Puppeteer Chromium 二进制文件缓存（~170MB），避免每次下载
- **制品:** 失败时上传 `public/test-snapshots/` 截图（保留 7 天）
- **Node 版本:** 20（与 `engines` 一致）
- **不跑的:** Smoke tests 不在 CI 中（需真实 claude 进程，消耗 token）

## Environments

| Environment | URL | 特点 |
|-------------|-----|------|
| Local dev | `http://127.0.0.1:3000` | 直连本机 claude，无 auth |
| Production | 公网域名（CF Tunnel） | AUTH_TOKEN + CF Access 2FA，LaunchAgent 常驻 |

- **无 staging 环境** — 个人项目，local = staging
- **数据隔离:** 生产 `data/` 目录 vs 测试用 `CCM_DATA_DIR` 环境变量隔离
- **Mock:** Visual E2E 用 `visual-mock-server.js` 模拟后端（零外部依赖）

## Quality Goals

| Metric | 目标 | 当前状态 |
|--------|------|----------|
| 单元测试行覆盖 | ≥80% 业务逻辑目标 | `coverage-check.js` 设 65% 行覆盖软门（doctor D10 warn 呈现、不阻断 CI） |
| CI 通过率 | `npm test` + `npm run test:visual` 100% | 以 GitHub Actions 为准 |
| Visual E2E | Top critical flows 覆盖 | ✅ Puppeteer lane 进 CI；Playwright P0 作为 mock-only 日常回归 |
| 测试套件时长 | Unit <3 min | 以本机/CI 输出为准 |
| Flake 容忍度 | <2% | 未追踪（单测稳定，E2E 偶有 flake） |

## Risk Areas

| Area | Risk Level | Business Impact | Notes |
|------|-----------|----------------|-------|
| **claude 子进程生命周期** | Critical | 高 — 进程挂死=手机端无响应 | idle timeout 检测 + kill，但 edge case 多（审批等待不计时） |
| **WebSocket 连接稳定性** | Critical | 高 — 断连=用户丢失上下文 | Socket.IO 自动重连，但 resume 逻辑依赖 sessions.json 持久化 |
| **公网安全（AUTH_TOKEN + CF Access）** | Important | 高 — 泄露=未授权访问本机 claude | 双层防护，CF Access 超时 2s→8s 已修，en0 IP 漂移曾致隧道断 |
| **文件上传/安全** | Important | 中 — 路径遍历/恶意文件 | 有 `file-security.test.mjs` + sanitizer，需持续覆盖新场景 |
| **多仓库切换** | Monitor | 中 — 切错目录=claude 操作错误仓库 | WORK_DIRS 配置 + 文件系统隔离 |
| **设备指纹管理** | Monitor | 低 — 新设备需手动 approve | `device.js` 脚本管理，有单测覆盖 |

## Team

- **规模:** Solo developer（Ike-li）
- **Dev:QA ratio:** ∞:0（一人全栈）
- **方法论:** 无固定 methodology，按需迭代
- **QA 策略:** 开发者自测 — 单测守 CI 门 + visual E2E 验证 UI + smoke 脚本冒烟
- **Shift-left:** 无正式 QA 流程，测试随功能一起写

## Conventions

### Test File Naming

- 单测: `test/<module>.test.mjs`（kebab-case，与源文件对应）
- E2E: `scripts/visual-e2e-runner.js`（单文件 runner，内含多个 TC）
- Smoke: `scripts/smoke-<scenario>.js`（按场景命名）

### Selectors (E2E)

- 主要使用 **id 选择器**（`#input`, `#btnSend`, `#activeStatusPill`）
- 无 `data-testid` 约定 — 前端是 vanilla JS，直接操作 DOM id
- PWA 元素通过 class + id 组合定位

### Branching & PR

- 主分支: `master`（有分支保护：require CI test 绿 + PR，但 admin 可直推）
- Commit: 中文描述 + conventional commits 格式（`feat:`, `fix:`, `docs:`）
- PR 正文: 不加 Claude 署名（仓库 PUBLIC，session 链接=噪音）

### Test Data

- 单测: fixtures 内联在 test 文件中，无共享 factory
- Visual E2E: mock server 内置响应数据
- Smoke: 使用临时目录 `/tmp/ccm-test`，`CCM_DATA_DIR` 隔离

### Code Style

- ESM（`import/export`），无 TypeScript
- 无 ESLint/Prettier 配置
- `npm run check` 做 JS 语法、文档一致性、visual mock registry guard
