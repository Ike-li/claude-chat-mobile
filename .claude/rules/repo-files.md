---
paths:
  - "docs/**"
  - "scripts/**"
  - "tests/gates/**"
  - ".claude/rules/**"
  - ".gitattributes"
  - ".gitignore"
---

# 仓库文件与分发

- 新文件必须落进 `tests/gates/repo-inventory.js` 的某条目录前缀；往 `docs/` 加文档还要在那份 `ROOT_FILES` 里逐篇登记。`npm run check` 的 inventory 会检查分类；审计报告、进度笔记、提案等临时产物不要提交到仓库。
- 分发形态是 GitHub 对 `master` 的源码归档，裁什么由 `.gitattributes` 的 `export-ignore` 定：`tests/**` 整棵、`docs/testing.md`、`.claude/`、`CLAUDE.md` 都被裁掉。对应规则由 `tests/unit/dist-manifest.test.mjs` 验证，详见 [docs/hard-rules.md](../../docs/hard-rules.md) §4.1.1。
- 因此被 `scripts/doctor.js` import 的 `scripts/doc-consistency.js` 与 `scripts/collect-source-files.js` 必须留在 `scripts/`。
- `.claude/rules/*.md` 在 `doc-consistency` 的扫描范围内：写进去的 npm script 名、文件路径必须真实存在。
