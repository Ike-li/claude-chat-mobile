#!/bin/sh
# tests/fixtures/fake-claude.sh —— CI 用的 claude CLI 占位可执行文件。
#
# 为什么需要它：src/server/app.js 的 preflight() 在找不到 claude 时 process.exit(1)，于是 21 个集成
# 测试文件此前全带 `process.env.CI ? {skip}`，理由写的是「CI 无本机 claude CLI」。后果是 CI 里
# 【没有任何 job 执行过真实后端接线】—— quality 是纯静态、unit-test 不加载 src/server/app.js、
# e2e 打的是 tests/e2e/mock/server.js 而非真 server。仓库最大的两个文件（public/js/app.js 6960 行、
# src/server/app.js 2966 行）在 CI 里零执行。
#
# 但那个限制比看上去松得多：preflight 只要求 CLAUDE_BIN 指向一个存在的文件，并（可选地）能回
# `--version`。真正需要跑 agent turn 的测试另有 RUN_CLAUDE_INTEGRATION 这道门把着——那才是
# 「需要真 CLI」的正确判据。本 stub 让不需要 turn 的接线测试在 CI 跑起来，turn 类测试照旧跳过。
#
# 边界：它只应答 --version。任何真起 agent turn 的调用都会拿到这里的空输出而失败——这是有意的，
# 失败即说明该测试被错误地归进了「不需要真 turn」那一类，应该给它加回 RUN_CLAUDE_INTEGRATION 门。
case "$1" in
  --version|-v) echo "0.0.0-fake (Claude Code CI stub)" ;;
  *) exit 0 ;;
esac
