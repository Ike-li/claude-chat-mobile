---
paths:
  - "app/src/**"
  - "app/server.js"
  - "scripts/*.js"
---

# 后端

- 按域分层：`agent/`（SDK 会话驱动、审批、CLI 镜像态判定）· `sessions/`（会话注册表、transcript 历史与 catchUp、工作区、「需要你」聚合）· `server/`（组装根）· `auth/`（限速、CF Access、设备信任）· `files/` · `ops/`（配置、doctor、通知与推送、statusline、受管服务）· `shared/`（叶子层，`protocol.js` 是事件契约真相源）。边界由 `tests/gates/check-import-boundaries.js` 硬闸执行，违反时它会说清是哪条。
- 新状态进所属域模块，别再放进 `app/src/server/app.js` 顶层作用域。存量不动。
- `app/src/**` 里算项目根是**三层**向上（`app/src/server/app.js` 的 `HERE`、`app/src/shared/data-dir.js` 的 `PROJECT_ROOT`）。`data/`、`scripts/`、`ccm.config.json` 在仓库根；少一层会让它们全部解析到 `app/` 下，且不报任何错。
- 配置：`ccm.config.json` 存在时优先，缺失才回落 `.env`；环境变量始终压过文件。schema 单一事实源是 `app/src/ops/env-schema.js`，读写与类型归一在 `app/src/ops/config-file.js`。**读写必须同源**，写错源等于假成功。
- 生产代码里追不到一次性目录、目录段由代码算出的单文件删除，要写 `// safe-path: 理由`。它不放行递归删除。
- **限速锁定的措辞按来源分档**：本机来源绝不说成「有人在暴力尝试」。
- 注释里的 `// 守护：SRV-003` 之类编号，去 [tests/README.md](../../tests/README.md) 查，别照编号猜。
