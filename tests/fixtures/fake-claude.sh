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
#
# ⚠️ 非 --version 分支必须【读完 stdin 再退出】，不能直接 exit 0。
# 真 CLI 在 SDK 模式下是长驻的：SDK spawn 它之后立刻往 stdin 写控制消息。stub 若立即退出，
# 管道读端已关闭，SDK 那次 write 抛 EPIPE —— 且它在 SDK 内部（sdk.mjs 的 xy.write）不被 catch，
# 直接冒成 uncaughtException 打死整个测试进程。
# 表现：config-refresh.test.mjs 在 CI 报 `before hook generated asynchronous activity after the
# test ended`（客户端一连接、server 懒开 SDK 实例就触发，与该用例断言的行为无关）。
# 本地不复现——本地 CLAUDE_BIN 指向真 claude，它不会提前关掉管道。
# 这类接线测试无法避免 spawn：server 在客户端连接时就会懒开实例。所以 stub 得活着承受这次
# spawn，安静吞掉输入、不产出任何响应（"拿到空输出而失败"的语义不变，只是失败方式从
# 打死进程变回可控的等不到响应）。
case "$1" in
  --version|-v) echo "0.0.0-fake (Claude Code CI stub)" ;;
  *) cat > /dev/null 2>&1; exit 0 ;;
esac
