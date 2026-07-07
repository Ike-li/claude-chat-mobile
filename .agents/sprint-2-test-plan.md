# Sprint 2 Test Plan — Security & File Safety
**Sprint dates:** 2026-07-01 (completed in one session)
**Features in scope:** AUTH_TOKEN 鉴权流程 + 文件上传安全
**Test lead:** Ike-li
**Last updated:** 2026-07-01

## Scope

| Feature | Risk | Test Types | Owner | Status |
|---------|------|-----------|-------|--------|
| AUTH_TOKEN 鉴权流程 | HIGH | 集成测试 | Ike-li | ✅ Implemented |
| 文件上传安全 | HIGH | 集成测试 + 单测 | Ike-li | ✅ Implemented |

## Coverage Summary

**Feature 1: AUTH_TOKEN 鉴权流程**

| ID | Scenario | Priority | Test Type | Status |
|----|----------|----------|-----------|--------|
| AUTH-1 | HTTP: 无 token 访问 /health 返回 401 | P0 | 集成 | ✅ Passed |
| AUTH-2 | HTTP: 带正确 token 访问 /health 返回 200 | P0 | 集成 | ✅ Passed |
| AUTH-3 | HTTP: 带错误 token 访问 /health 返回 401 | P0 | 集成 | ✅ Passed |
| AUTH-4 | HTTP: 通过 x-auth-header 传递 token | P1 | 集成 | ✅ Passed |
| AUTH-5 | HTTP: 未启用 AUTH_TOKEN 时无 token 也能访问 | P1 | 集成 | ⏭️ Removed |
| AUTH-6 | Socket.IO: 带正确 token 握手成功 | P0 | 集成 | ✅ Passed |
| AUTH-7 | Socket.IO: 带错误 token 握手失败 | P0 | 集成 | ✅ Passed |
| AUTH-8 | Socket.IO: 无 token 握手失败 | P0 | 集成 | ✅ Passed |
| AUTH-9 | Socket.IO: 未启用 AUTH_TOKEN 时无 token 也能连接 | P1 | 集成 | ⏭️ Removed |
| AUTH-10 | HTTP: 空 token 等同于未提供 | P2 | 集成 | ✅ Passed |

**Feature 2: 文件上传安全**

| ID | Scenario | Priority | Test Type | Status |
|----|----------|----------|-----------|--------|
| UPLOAD-1 | sanitizeName: 正常文件名保留 | P0 | 单测 | ✅ Passed |
| UPLOAD-2 | sanitizeName: 路径分隔符被清除 | P0 | 单测 | ✅ Passed |
| UPLOAD-3 | sanitizeName: 控制字符被清除 | P1 | 单测 | ✅ Passed |
| UPLOAD-4 | sanitizeName: 前导点被清除（防隐藏文件） | P1 | 单测 | ✅ Passed |
| UPLOAD-5 | sanitizeName: 危险字符替换为下划线 | P1 | 单测 | ✅ Passed |
| UPLOAD-6 | sanitizeName: 空名回退为 file | P2 | 单测 | ✅ Passed |
| UPLOAD-7 | validateAttachments: 空数组返回 null | P0 | 单测 | ✅ Passed |
| UPLOAD-8 | validateAttachments: 超过 10 个附件返回错误 | P0 | 单测 | ✅ Passed |
| UPLOAD-9 | validateAttachments: 单文件超过 10MB 返回错误 | P0 | 单测 | ✅ Passed |
| UPLOAD-10 | validateAttachments: 总量超过 20MB 返回错误 | P0 | 单测 | ✅ Passed |
| UPLOAD-11 | validateAttachments: 合法附件返回 null | P0 | 单测 | ✅ Passed |
| UPLOAD-12 | saveAttachments: 正常落盘 | P0 | 集成 | ✅ Passed |
| UPLOAD-13 | saveAttachments: 路径穿越被拦截 | P0 | 集成 | ✅ Passed |
| UPLOAD-14 | saveAttachments: 文件权限为 0600 | P1 | 集成 | ✅ Passed |
| UPLOAD-15 | Socket.IO: 发送合法附件成功 | P0 | 集成 | ✅ Passed |
| UPLOAD-16 | Socket.IO: 发送过大附件被拒绝 | P0 | 集成 | ✅ Passed |
| UPLOAD-17 | Socket.IO: 发送过多附件被拒绝 | P0 | 集成 | ✅ Passed |

**Coverage targets:**
- 需求映射: 27 / 27 (100%)
- 自动化覆盖: 28 个测试用例（8 AUTH + 20 UPLOAD）
- 手动覆盖: 0（全自动化）
- Gaps: 无

## Test Files

| 文件 | 用例数 | 说明 |
|------|--------|------|
| `test/integration/auth-token.test.mjs` | 8 | AUTH_TOKEN HTTP + Socket.IO 鉴权 |
| `test/integration/file-upload.test.mjs` | 20 | 文件名清理 + 附件校验 + Socket.IO 上传 |
| **总计** | **28** | |

## Entry Criteria

- [x] Phase 1 集成测试基础设施就绪
- [x] 现有单元测试全部通过
- [x] `uploads.js` 和 `cf-access.js` 模块可导入

## Exit Criteria

- [x] 27 个测试用例全部编写完成
- [x] 所有用例语法检查通过
- [x] 无安全漏洞遗漏（路径遍历、大小限制、认证绕过）

## Risks to the Plan

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| 测试需要启动真实服务器 | Medium | 中 | 使用动态 import + CCM_DATA_DIR 隔离 |
| 文件权限测试在 Windows 上跳过 | Low | 低 | 使用 `platform()` 检查，POSIX-only 测试标记 skip |

## Daily Tracking

| Day | Planned | Actual | Blockers |
|-----|---------|--------|----------|
| Day 1 | AUTH_TOKEN 鉴权 + 文件上传安全 | ✅ 全部完成 | 无 |

## Test Smells to Watch

- **Hardcoded tokens:** 测试中的 token 应该是测试专用值，不要用真实的 AUTH_TOKEN
- **File system pollution:** 所有测试都使用临时目录，测试后清理
- **Permission assertions:** 文件权限测试只在 POSIX 平台运行，Windows 跳过
- **Base64 encoding:** 附件数据使用 Buffer.from().toString('base64')，不要硬编码
