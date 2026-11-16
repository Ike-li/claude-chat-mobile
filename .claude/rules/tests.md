---
paths:
  - "tests/**"
---

# 测试文件

写、改、删测试前先读 [docs/testing.md](../../docs/testing.md)。这里只列最常判错的几件：

- **测试目录按编号表决定**：编号表（[tests/README.md](../../tests/README.md)）里查得到就进 `invariants/` 并写 `// 守护：<编号>`；查不到就进 `unit/`，不写守护行。由 `check-invariant-ids.js` 检查。两套编号并存（新的 `AUTH-01` 类与生产代码注释里先有的 `FILES-1`/`SEC-01`/`SRV-003` 类），不认识就去查 tests/README.md，别照编号猜。
- **失败方向是逐条选过的**：有两条的正确方向恰恰是「不拒绝」——`trusted-devices.json` 瞬时读失败保留 last-good；鉴权通过后 handler 抛 500 不计入限速。按「所有异常都该拒绝」写会把它们测反。
- **验证测试能检测出缺陷**：两侧验收的证据（注入了什么、哪条红了）写进 commit 的 `Tested:` trailer，不写就是没做。只记录正常测试通过不足以证明缺陷能被检测到。
- `tests/invariants/env/`、`tests/invariants/server/`、`tests/integration/` 下的文件，第一条 import 必须是 `tests/setup/require-disposable-env.mjs`。排在被测模块后面等于没接上，`check-disposable-env-guard.js` 会拦。
- 测试里的递归删除必须追溯到 `mkdtemp`，否则写 `// safe-rm: 理由`。它和生产代码的 `// safe-path:` 不通用。
- 「单测」不等于纯函数：不少 unit 文件用 mkdtemp 临时目录或 spawnSync 跑本仓脚本，隔离靠 preload-env 加一次性目录。
- 门禁住在 `tests/gates/`，但 `scripts/doc-consistency.js` 与 `scripts/collect-source-files.js` 不能挪进来：`scripts/doctor.js` import 它们，而 `tests/**` 在分发包里被整棵裁掉。
