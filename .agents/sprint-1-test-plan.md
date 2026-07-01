# Sprint 1 Test Plan — Integration Foundation
**Sprint dates:** 2026-07-01 - 2026-07-14 (2 weeks)
**Features in scope:** 集成测试基础设施 + Top 2 高风险区域覆盖
**Test lead:** Ike-li
**Last updated:** 2026-07-01

## Scope

| Feature | Risk | Test Types | Owner | Status |
|---------|------|-----------|-------|--------|
| claude 子进程生命周期 | CRIT | 集成测试 | Ike-li | Not Started |
| WebSocket 事件流 | CRIT | 集成测试 | Ike-li | Not Started |
| 现有单元测试套件 | - | 回归 | CI | ✅ 315 pass |

**不在本 Sprint 范围：**
- AUTH_TOKEN / CF Access 集成测试（Phase 2）
- 文件上传安全集成测试（Phase 2）
- Visual E2E 接入 CI（Phase 3）

## Coverage Summary

**Feature 1: claude 子进程生命周期**

| ID | Scenario | Priority | Test Type | Status |
|----|----------|----------|-----------|--------|
| CL-1 | Happy path: spawn → 收到回复 → 正常退出 | P0 | 集成 | Implemented |
| CL-2 | Idle timeout: 子进程超时自动 kill | P0 | 集成 | Implemented |
| CL-3 | 审批等待: idle timer 暂停（工具审批期间不计时） | P1 | 集成 | Implemented |
| CL-4 | 异常退出: 子进程 crash → 通知前端 | P1 | 集成 | Implemented |
| CL-5 | 并发: 多个会话同时 spawn 子进程 | P2 | 集成 | Implemented |
| CL-6 | 超长对话: context window 满 → 行为正确 | P2 | 集成 | Implemented |

**Feature 2: WebSocket 事件流**

| ID | Scenario | Priority | Test Type | Status |
|----|----------|----------|-----------|--------|
| WS-1 | Happy path: 建立连接 → 发送消息 → 收到流式回复 | P0 | 集成 | Implemented |
| WS-2 | 断线重连: 网络中断 → 自动重连 → 恢复会话 | P0 | 集成 | Implemented |
| WS-3 | 会话切换: 切换 sessionId → 正确加载历史 | P1 | 集成 | Implemented |
| WS-4 | 并发消息: 快速连续发送 → 不丢失、不乱序 | P1 | 集成 | Implemented |
| WS-5 | 认证: 无 token 连接被拒绝 | P1 | 集成 | Implemented |
| WS-6 | 服务端重启: 客户端检测断开 → 重连 → resume | P2 | 集成 | Implemented |

**Coverage targets:**
- 需求映射: 12 / 12 (100%)
- 自动化覆盖: 12 个集成测试用例
- 手动覆盖: 0（本 sprint 全自动化）
- Gaps: 无

## Effort Budget

**估算依据（参考值）：**
- 集成测试写入: 1 hr/用例
- 集成测试执行: 5-30 sec/用例
- 环境搭建 & mock: 2 hrs（一次性）

**本 Sprint 工作量：**

| 活动 | 估算 | 说明 |
|------|------|------|
| 集成测试基础设施搭建 | 2h | CCM_DATA_DIR 隔离、mock helpers、测试 fixture |
| CL-1~CL-6 写入 | 6h | 6 个用例 × 1h |
| WS-1~WS-6 写入 | 6h | 6 个用例 × 1h |
| 调试 & 修复 | 3h | mock 不稳定、异步时序问题 |
| 现有单测回归 | 0.5h | CI 自动跑，只看结果 |
| **总工作量** | **17.5h** | |

**可用时间：**
- 2 周 × 5 天 × 2h/天（业余项目时间）= 20h
- Buffer: 2.5h (12.5%)

**Delta: +2.5h 余量** ✅

## Environment & Data

- **测试环境:** 本地 `http://127.0.0.1:3000`
- **数据隔离:** `CCM_DATA_DIR=/tmp/ccm-test-$(date +%s)` 每次测试用新目录
- **Mock claude:** 不 mock（集成测试需要真实 claude 子进程）
- **测试 fixture:** 内联在测试文件中
- **清理:** 测试结束后 `rm -rf $CCM_DATA_DIR`

## Entry Criteria

- [x] 现有 315 单元测试全部通过
- [x] `node scripts/doctor.js` 配置检查通过
- [ ] claude CLI 可用且能正常响应（`claude --version` 验证）
- [ ] `CCM_DATA_DIR` 隔离机制验证（不影响生产 data/）

## Exit Criteria

- [ ] 12 个集成测试用例全部编写完成
- [ ] 所有用例在本地通过（`npm test` 包含新用例）
- [ ] CI 绿（新用例不影响现有 315 个单测）
- [ ] 无 P0/P1 未修复的测试基础设施问题
- [ ] CL-1, CL-2, WS-1, WS-2 四个 P0 用例稳定运行 ≥5 次无 flake

## Risks to the Plan

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| claude 子进程启动慢，测试超时 | Medium | 中 | 设置合理 timeout（30s），mock 非核心交互 |
| 异步时序问题导致 flaky test | High | 高 | 使用 await/事件驱动，避免 sleep；P0 用例跑 10 次验证稳定性 |
| 真实 claude 消耗 token | Low | 低 | 集成测试用短 prompt，控制在 100 token/用例内 |
| 业余时间不足，Sprint 目标缩减 | Medium | 中 | 优先完成 CL-1, CL-2, WS-1, WS-2 四个 P0；P2 可延期 |

## Daily Tracking

| Day | Planned | Actual | Blockers |
|-----|---------|--------|----------|
| Day 1 | 集成测试基础设施搭建 + CL-1~CL-6 + WS-1~WS-6 | ✅ 全部完成 | 无 |

## Test Smells to Watch

- **Brittle assertions:** 集成测试不要断言内部实现细节（如具体的 JSON key 顺序），只断言行为
- **Slow tests:** 单个集成测试 >5s 需要优化（mock 或减少 I/O）
- **Resource leaks:** 子进程未 kill、临时目录未清理 → 影响后续测试
- **Flaky network:** WebSocket 测试避免依赖真实网络延迟，用事件驱动
