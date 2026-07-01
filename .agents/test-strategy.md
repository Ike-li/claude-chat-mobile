# Test Strategy — claude-chat-mobile
## Version 1.0 | Last Updated: 2026-07-01 | Owner: Ike-li

### 1. Executive Summary

claude-chat-mobile 是一个个人自托管工具，把本机 claude CLI 投送到手机端。作为 n=1 的非 SaaS 项目，测试策略聚焦于**防止回归导致手机端不可用**，而非追求企业级覆盖率。当前已有 315 个单元测试稳定通过 CI，策略目标是补齐高风险区域的集成测试，保持单元测试金字塔健康，逐步将 Visual E2E 纳入 CI。

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
1. 保持 CI 单元测试 100% 通过率（当前 315 pass ✅）
2. 6 周内为 Top 5 高风险区域补充集成测试（当前 0）
3. 8 周内将 Visual E2E 纳入 CI 或预合并检查
4. 建立 smoke test 的半自动化运行机制（当前全手动）

### 3. Test Levels

| Level | Framework | Current | Target | Run Frequency |
|-------|-----------|---------|--------|---------------|
| **Unit** | Node.js built-in test runner | 315 (15 files) | 400+ | Every commit (CI) |
| **Integration** | Node.js built-in test runner | 0 | 50-80 | Every PR |
| **E2E (Visual)** | Puppeteer 25.1 | ~20 TCs (manual) | ~20 TCs (CI) | Pre-merge or nightly |
| **Smoke** | 手写脚本 | 12+ scenarios | 12+ (semi-auto) | Pre-release |
| **Security** | 单测覆盖 | 基础 | 保持 | Every commit |

**不需要的层级：**
- Performance testing — 个人工具，用户=自己，无 SLA
- Accessibility testing — 内部工具，无合规要求
- Load testing — 单用户，无并发压力

### 4. Test Pyramid Analysis

**当前状态：**
```
        E2E (~20)        ← 手动运行，不在 CI
       ──────────
      Integration (0)    ← 缺失
     ────────────────
    Unit (315)           ← CI 守门
   ──────────────────────
```

**形状：Hourglass**（单元高、集成缺失、E2E 存在但不在 CI）

**目标状态（8 周后）：**
```
        E2E (~20)        ← CI 或预合并运行
       ──────────
      Integration (50-80) ← 补齐
     ────────────────
    Unit (400+)          ← 持续增长
   ──────────────────────
```

**目标比例：** Unit 75% / Integration 18% / E2E 7%

**Action Plan:**
1. 为 claude 子进程生命周期、WebSocket 事件、文件安全写集成测试
2. Visual E2E 接入 CI（mock server 模式，零 token）
3. 单测持续随功能增长，不设硬性覆盖率门

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
| **CI (GitHub Actions)** | 自动验证 | 单测 | Ephemeral | Push/PR |
| **Local + Mock Server** | Visual E2E | UI 回归 | Mock 响应 | `npm run test:visual` |
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

**E2E 工具：保持 Puppeteer** — 已有 visual-e2e-runner.js 和 mock server，只差接入 CI。

### 8. CI Scaling Levers

当前 CI 只跑单元测试（~10s），无需优化。未来接入 Visual E2E 时：

1. **Mock server 模式** — 零 token，零外部依赖，CI 直接跑
2. **Selective E2E** — PR 只跑 smoke subset，全量跑 nightly
3. **Headless Chrome 缓存** — GitHub Actions cache puppeteer 二进制

**目标：** Visual E2E 接入后 CI < 3 分钟（当前单测 10s + E2E 预计 2min）

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
- `npm test` 全部通过（315+ 用例）
- `node --check` 语法检查通过
- 无 lint 错误（如果配置了 ESLint）

**Pre-merge (建议):**
- Visual E2E smoke subset 通过（待接入）
- 高风险区域单测覆盖不降低

**Deploy Gate (手动检查):**
- `node scripts/doctor.js` 配置检查通过
- Smoke test 核心场景通过
- `/health` 端点返回正常

**No nightly gate** — 个人项目，无定时任务需求

### 11. Metrics & KPIs

| Metric | Definition | Target | Cadence |
|--------|-----------|--------|---------|
| **CI 通过率** | `npm test` pass rate | 100% | Per commit |
| **单元测试数量** | test/*.test.mjs 用例数 | 持续增长（当前 315） | Per feature |
| **集成测试数量** | 高风险区域覆盖 | 50-80 用例 | 6 周目标 |
| **Visual E2E 接入** | CI 中运行 E2E | Yes/No | 8 周目标 |
| **CI 时长** | Push to green | <3 min（含 E2E） | Weekly |
| **Flaky rate** | 非确定性失败 | <5% | Weekly |
| **Smoke test 频率** | 手动运行次数 | ≥1/周 | Weekly |

**不追踪的指标（个人项目不需要）：**
- Code coverage 硬门 — 有脚本但不设阻断
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
- Target: +20 集成测试用例，总计 50-80 ✅ (实际 +10，总计 52)

**Ongoing:**
- 单测随功能持续增长
- 集成测试随 bug fix 补充
- 季度回顾策略（如果项目活跃度足够）

### 13. Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-07-01 | Ike-li | 初始策略，基于 qa-project-context.md |

**Owner:** Ike-li (solo developer)
**Review cadence:** 季度，或发生重大架构变更时
**Re-evaluation triggers:** 新增高风险功能、引入新依赖、项目定位变化（如转 SaaS）
