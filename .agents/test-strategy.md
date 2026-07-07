# Test Strategy — claude-chat-mobile
## Version 1.1 | Last Updated: 2026-07-06 | Owner: Ike-li

### 1. Executive Summary

claude-chat-mobile 是一个开源、面向大众自托管的工具，把本机 claude CLI 投送到手机端。作为每实例单用户、非多租户 SaaS 的项目，测试策略聚焦于**防止回归导致手机端不可用**，而非追求企业级覆盖率。当前 CI 已跑 `npm test` 与 mock-only Puppeteer visual E2E；本地另有 Playwright P0 mock 回归 lane。策略目标是保持这些 lane 语义清晰：日常回归零 token，真实 Claude / 生产 smoke 显式 opt-in。

### 2. Scope & Objectives

**In scope:**
- 后端逻辑（server.js、claude 子进程管理、Socket.IO 通信）
- 前端交互（vanilla JS PWA、流式输出、工具审批）
- 安全层（AUTH_TOKEN、CF Access、设备指纹）
- 数据持久化（sessions.json、devices、uploads）

**Out of scope:**
- Claude CLI 本身（上游依赖，只测集成边界）
- Cloudflare Tunnel 基础设施（运维层面）
- 第三方库内部逻辑

**Objectives:**
1. 保持 `npm test` 与 `npm run test:visual` 100% 通过。
2. 继续把 P0 浏览器回归保持为 mock-only、零 token、可每日运行。
3. 真实 Claude、Cloudflare Access、Web Push、生产域名 smoke 保持显式 opt-in。
4. 对文档/测试协议漂移使用 `npm run check` 与 `npm run contract:check` 提前拦截。

### 3. Test Levels

| Level | Framework | Current | Target | Run Frequency |
|-------|-----------|---------|--------|---------------|
| **Unit** | Node.js built-in test runner | `test/*.test.mjs` | 随功能增长 | Every commit (CI via `npm test`) |
| **Integration** | Node.js built-in test runner | `test/integration/*.test.mjs` | 覆盖高风险边界 | Every PR (CI skips/gates real Claude paths) |
| **E2E (Visual)** | Puppeteer 25.1 | `scripts/visual-e2e-runner.js` | 保持 mock-only CI lane | Every commit (CI) |
| **Playwright P0** | Playwright | `tests/p0/*.spec.ts` | daily-safe browser regression | Local/daily regression |
| **Smoke** | 手写脚本 | 12+ scenarios | 12+ (semi-auto) | Pre-release |
| **Security** | 单测 + 集成 + mock UI | 基础已覆盖 | 保持 | Every commit |

**不需要的层级：**
- Performance testing — 个人工具，用户=自己，无 SLA
- Accessibility testing — 内部工具，无合规要求
- Load testing — 单用户，无并发压力

### 4. Test Pyramid Analysis

**当前状态：**
```
        Visual/Playwright mock E2E
       ─────────────────────────
      Integration / protocol guards
     ─────────────────────────────
    Unit / pure logic
   ──────────────────────
```

**形状：Pragmatic pyramid**。底层纯逻辑测试快，中层 Node/socket/protocol 保护行为边界，上层只保留 mock-only UI 回归；真实 Claude 和生产环境 smoke 不进日常 lane。

**Action Plan:**
1. 新功能优先补行为测试，避免只追 coverage。
2. 浏览器 P0 优先走 Playwright mock lane；旧 Puppeteer visual lane 保持 CI 守门。
3. 真实 Claude / Cloudflare / Web Push 只做 P2 opt-in smoke。

### 5. Risk Assessment

| Feature | Impact | Likelihood | Score | Testing Approach |
|---------|--------|------------|-------|-----------------|
| **claude 子进程生命周期** | 5 - 进程挂死=无响应 | 4 - edge case 多 | 20 - CRIT | 集成测试（spawn/kill/idle timeout）+ 单测 |
| **WebSocket 连接** | 5 - 断连丢上下文 | 3 - 网络不稳定 | 15 - CRIT | 集成测试（connect/disconnect/resume）|
| **AUTH_TOKEN + CF Access** | 5 - 未授权访问 | 2 - 配置正确时稳定 | 10 - HIGH | 单测（token 校验）+ 集成（握手流程）|
| **文件上传/安全** | 4 - 路径遍历 | 3 - 新场景需覆盖 | 12 - HIGH | 单测（sanitizer）+ 集成（上传流程）|
| **会话切换/resume** | 4 - 切错丢失上下文 | 3 - 并发场景 | 12 - HIGH | 集成测试（多会话切换）|
| **多仓库切换** | 3 - 切错目录 | 2 - 配置驱动 | 6 - MED | 单测（路径验证）|
| **设备指纹管理** | 2 - 新设备需手动 approve | 2 - 流程简单 | 4 - LOW | 单测足够 |
| **齿轮面板设置** | 2 - UI 显示错误 | 2 - 稳定 | 4 - LOW | Visual E2E 覆盖 |

### 6. Environment Strategy

| Environment | Purpose | Test Types | Data | Trigger |
|------------|---------|------------|------|---------|
| **Local dev** | 开发反馈 | 单测、集成 | `CCM_DATA_DIR` 隔离 | `npm test` |
| **CI (GitHub Actions)** | 自动验证 | `npm test` + `npm run test:visual` | Ephemeral | Push/PR |
| **Local + Mock Server** | Browser UI 回归 | Puppeteer / Playwright P0 | Mock 响应 | `npm run test:visual` / `npm run test:playwright:p0` |
| **Local + 真实 claude** | Smoke | 端到端 | `/tmp/ccm-test` | 手动 |

**数据隔离原则：**
- 单测：fixtures 内联，零外部依赖
- 集成测试：`CCM_DATA_DIR` 环境变量指向临时目录
- Visual E2E：mock server 模拟后端，零 token
- Smoke：临时目录，用完即弃

### 7. Tool Selection Rationale

| Criteria (weight) | Node.js test runner | Vitest | Jest |
|-------------------|---------------------|--------|------|
| **Fits tech stack** (25%) | 5 — 内置，零配置 | 4 — 需要配置 ESM | 3 — ESM 支持较弱 |
| **Team familiarity** (20%) | 5 — 已在用 | 3 — 需要学习 | 3 — 需要学习 |
| **Maintenance cost** (25%) | 5 — 无依赖 | 4 — 轻量 | 3 — 较重 |
| **Speed** (15%) | 5 — 快 | 5 — 快 | 4 — 快 |
| **CI integration** (15%) | 5 — 原生 | 5 — 原生 | 5 — 原生 |
| **Weighted total** | **5.0** | **4.15** | **3.3** |

**决策：保持 Node.js built-in test runner** — 零依赖、零配置、已在 CI 稳定运行。不换工具。

**E2E 工具：双 lane 并存** — Puppeteer `test:visual` 已进 CI，Playwright `test:playwright:p0` 承担更细的 daily-safe mock UI 回归。

### 8. CI Scaling Levers

当前 CI 跑 `unit-test` 与 `visual-e2e` 两个 job。优化重点是保持它们 mock-only、零 token、互不抢生产端口：

1. **Mock server 模式** — 零 token，零外部依赖，CI 直接跑。
2. **Chrome 缓存** — GitHub Actions cache Puppeteer 二进制。
3. **Playwright P0 分离** — 不与生产 server 或真实 Claude 绑定，按需本地/每日运行。

**目标：** CI 保持在可接受时间内；新增浏览器覆盖优先放进 Playwright P0，只有关键 smoke 才进入 Puppeteer CI lane。

### 9. Entry/Exit Criteria

**Unit:**
- Entry: 代码编译通过（`node --check`）
- Exit: 所有分支覆盖、边界情况测试、CI 绿

**Integration:**
- Entry: 单测通过、`CCM_DATA_DIR` 隔离
- Exit: 覆盖 happy path + 关键 error path、无 flaky

**E2E:**
- Entry: 集成测试通过、mock server 启动
- Exit: 核心 UI 流程通过、截图无回归

**Release (手动部署):**
- Entry: CI 绿、smoke test 通过
- Exit: 生产环境健康检查通过（`/health`）

### 10. Quality Gates

**PR Gate (CI 自动):**
- `npm test` 全部通过。
- `npm run test:visual` 全部通过。
- 建议本地先跑 `npm run check`（JS 语法 + 文档一致性 + visual mock registry guard）。

**Pre-merge (建议):**
- `npm run contract:check` 通过（触碰事件协议/visual mock 时必跑）。
- `npm run test:playwright:p0` 通过（触碰前端行为或 mock server 时必跑）。
- 高风险区域单测覆盖不降低

**Deploy Gate (手动检查):**
- `node scripts/doctor.js` 配置检查通过
- Smoke test 核心场景通过
- `/health` 端点返回正常

**No nightly gate** — 个人项目，无定时任务需求

### 11. Metrics & KPIs

| Metric | Definition | Target | Cadence |
|--------|-----------|--------|---------|
| **CI 通过率** | `npm test` + `npm run test:visual` pass rate | 100% | Per commit |
| **单元/集成测试数量** | 行为回归用例数 | 随真实风险增长 | Per feature |
| **Playwright P0 健康** | mock UI regression pass rate | 100% | Daily/local |
| **CI 时长** | Push to green | <3 min（含 E2E） | Weekly |
| **Flaky rate** | 非确定性失败 | <5% | Weekly |
| **Smoke test 频率** | 手动运行次数 | ≥1/周 | Weekly |

**不追踪的指标（个人项目不需要）：**
- Code coverage 硬门 — 有 `coverage-check.js`（65% 行覆盖软门、doctor D10 以 warn 呈现），但 CI 不设阻断
- Defect escape rate — 无"发布"概念，持续部署
- MTTR — 自己修自己的东西，无需 SLA

### 12. Timeline & Milestones

**Phase 1 (Week 1-2): Integration Foundation**
- 为 claude 子进程生命周期写集成测试（spawn/kill/timeout）
- 为 WebSocket 事件流写集成测试（connect/message/disconnect）
- Target: +30 集成测试用例

**Phase 2 (Week 3-4): Security & File Safety** ✅
- 为 AUTH_TOKEN 鉴权流程写集成测试 ✅ (8 用例全部通过)
- 为文件上传安全写集成测试（路径遍历、大小限制）✅ (20 用例全部通过)
- Target: +20 集成测试用例 ✅ (实际 28 用例)

**Phase 3 (Week 5-6): Visual E2E in CI** ✅
- 将 `npm run test:visual` 接入 GitHub Actions（mock server 模式）✅
- 配置 headless Chrome cache ✅ (actions/cache 缓存 ~/.cache/puppeteer)
- Target: CI 包含 E2E，总时长 <3 min ✅ (unit-test ~30s + visual-e2e ~2min 并行)

**Phase 4 (Week 7-8): Session & Resume** ✅
- 为会话切换/resume 写集成测试 ✅ (10 用例)
- 为多仓库切换写集成测试 ✅ (包含在 session-switch.test.mjs)
- Target: +20 集成测试用例，总计 50-80 ✅ (Phase 4 +10，集成合计 66)

**Ongoing:**
- 单测随功能持续增长
- 集成测试随 bug fix 补充
- 季度回顾策略（如果项目活跃度足够）

### 13. Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.1 | 2026-07-06 | Ike-li | 同步当前 CI、Puppeteer/Playwright lane 与文档一致性检查 |
| 1.0 | 2026-07-01 | Ike-li | 初始策略，基于 qa-project-context.md |

**Owner:** Ike-li (solo developer)
**Review cadence:** 季度，或发生重大架构变更时
**Re-evaluation triggers:** 新增高风险功能、引入新依赖、项目定位变化（如转 SaaS）
