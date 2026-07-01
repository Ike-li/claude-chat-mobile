# Sprint 4 Test Plan — Session & Resume
**Sprint dates:** 2026-07-01 (completed in one session)
**Features in scope:** 会话切换、历史回显、多工作区切换
**Test lead:** Ike-li
**Last updated:** 2026-07-01

## Scope

| Feature | Risk | Test Types | Owner | Status |
|---------|------|-----------|-------|--------|
| 会话切换 (session:switch) | HIGH | 集成测试 | Ike-li | ✅ Implemented |
| 历史回显 (session:history) | HIGH | 集成测试 | Ike-li | ✅ Implemented |
| 会话列表 (session:list) | MED | 集成测试 | Ike-li | ✅ Implemented |
| 会话关闭 (session:close) | MED | 集成测试 | Ike-li | ✅ Implemented |
| 多工作区切换 | HIGH | 集成测试 | Ike-li | ✅ Implemented |

## Coverage Summary

| ID | Scenario | Priority | Test Type | Status |
|----|----------|----------|-----------|--------|
| SESS-1 | 新会话发送消息后获得 sessionId | P0 | 集成 | ✅ Implemented |
| SESS-2 | session:list 返回会话列表 | P0 | 集成 | ✅ Implemented |
| SESS-3 | session:switch 到不存在的会话返回错误 | P0 | 集成 | ✅ Implemented |
| SESS-4 | session:history 返回会话历史 | P0 | 集成 | ✅ Implemented |
| SESS-5 | 多工作区切换正确隔离 | P1 | 集成 | ✅ Implemented |
| SESS-6 | 会话切换后事件流指向新会话 | P1 | 集成 | ✅ Implemented |
| SESS-7 | 并发创建多个会话 | P1 | 集成 | ✅ Implemented |
| SESS-8 | session:close 关闭会话 | P1 | 集成 | ✅ Implemented |
| SESS-9 | 会话恢复后历史消息完整 | P1 | 集成 | ✅ Implemented |
| SESS-10 | 无效 sessionId 查询历史返回空 | P2 | 集成 | ✅ Implemented |

**Coverage targets:**
- 需求映射: 10 / 10 (100%)
- 自动化覆盖: 10 个测试用例
- 手动覆盖: 0（全自动化）
- Gaps: 无

## Test File

| 文件 | 用例数 | 说明 |
|------|--------|------|
| `test/integration/session-switch.test.mjs` | 10 | 会话切换、历史、列表、关闭、多工作区 |
| **总计** | **10** | |

## Entry Criteria

- [x] Phase 1-3 集成测试基础设施就绪
- [x] 现有单元测试全部通过
- [x] `sessions.js` 和 `history.js` 模块可导入

## Exit Criteria

- [x] 10 个测试用例全部编写完成
- [x] 所有用例语法检查通过
- [x] 覆盖会话生命周期完整流程（创建→切换→历史→关闭）

## Risks to the Plan

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| 会话依赖真实 claude 进程 | Medium | 中 | 测试使用短消息，控制 token 消耗 |
| 异步事件时序问题 | Medium | 中 | 使用 waitForEvent 等待特定事件 |
| 多工作区文件系统隔离 | Low | 低 | 使用临时目录，测试后清理 |

## Daily Tracking

| Day | Planned | Actual | Blockers |
|-----|---------|--------|----------|
| Day 1 | 会话切换 + 历史 + 多工作区 | ✅ 全部完成 | 无 |

## Test Smells to Watch

- **Session ID 依赖:** 测试不应硬编码 sessionId，从 init 事件动态获取
- **事件顺序:** 使用 waitForEvent 而不是 sleep，避免 flaky
- **资源清理:** 所有客户端在 finally 中 disconnect
- **工作区隔离:** 多工作区测试使用独立临时目录
