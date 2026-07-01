# Sprint 3 Test Plan — Visual E2E in CI
**Sprint dates:** 2026-07-01 (completed in one session)
**Features in scope:** 将 Visual E2E 接入 GitHub Actions CI
**Test lead:** Ike-li
**Last updated:** 2026-07-01

## Scope

| Feature | Risk | Test Types | Owner | Status |
|---------|------|-----------|-------|--------|
| Visual E2E CI 集成 | HIGH | CI/CD 配置 | Ike-li | ✅ Implemented |
| Puppeteer Chromium 缓存 | MED | CI 优化 | Ike-li | ✅ Implemented |
| 失败截图归档 | LOW | CI 制品 | Ike-li | ✅ Implemented |

## Changes

**GitHub Actions Workflow (`.github/workflows/test.yml`):**

| 变更 | 说明 |
|------|------|
| 拆分 jobs | `unit-test` + `visual-e2e` 并行执行 |
| Chromium 缓存 | `actions/cache@v4` 缓存 `~/.cache/puppeteer`（~170MB） |
| Chromium 安装 | `npx puppeteer browsers install chrome`（缓存命中时跳过） |
| 失败截图 | `actions/upload-artifact@v4` 上传 `public/test-snapshots/`（保留 7 天） |

**新增 CI Jobs:**

| Job | 步骤 | 预估时长 |
|-----|------|----------|
| `unit-test` | `npm ci` → `npm test` | ~30s |
| `visual-e2e` | `npm ci` → Chromium install → `npm run test:visual` | ~2min |

**总 CI 时长目标:** <3 min（两个 job 并行，取最长的 visual-e2e）

## Entry Criteria

- [x] `npm run test:visual` 本地可运行
- [x] `scripts/visual-e2e-runner.js` 使用 mock server（零外部依赖）
- [x] Puppeteer 25.1 已在 devDependencies

## Exit Criteria

- [x] GitHub Actions workflow 更新完成
- [x] Chromium 缓存配置完成
- [x] 失败截图归档配置完成
- [x] workflow YAML 语法检查通过

## Risks to the Plan

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Chromium 安装失败 | Low | 高 | 使用 `actions/cache` 缓存，减少下载次数 |
| Mock server 端口冲突 | Low | 低 | Mock server 使用固定端口 3100，CI 环境隔离 |
| 截图目录不存在 | Low | 低 | Runner 自动创建 `public/test-snapshots/` |
| CI 时长超 3 min | Medium | 中 | Chromium 缓存 + 并行 jobs |

## Daily Tracking

| Day | Planned | Actual | Blockers |
|-----|---------|--------|----------|
| Day 1 | 更新 workflow + 配置缓存 | ✅ 全部完成 | 无 |

## Verification

```bash
# 本地验证 workflow 语法
cat .github/workflows/test.yml | python3 -c "import sys, yaml; yaml.safe_load(sys.stdin)"

# 本地验证 Visual E2E 可运行
npm run test:visual
```

## Notes

- 单测和 Visual E2E 拆分为两个独立 jobs，可并行执行
- Chromium 缓存 key 基于 `package-lock.json` hash，依赖更新时自动刷新
- 失败时才上传截图 artifact，成功时自动清理
- Smoke tests 仍不在 CI 中（需真实 claude 进程，消耗 token）
