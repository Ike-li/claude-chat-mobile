// tests/setup/require-disposable-env.mjs —— 破坏性测试的执行位守卫（有副作用：不达标就退出进程）
//
// 用法：在测试文件【最顶部】import 它，早于任何被测模块：
//     import '../../setup/require-disposable-env.mjs';
//
// 【为什么是文件顶部的 import，不是 npm 脚本的 --import】
// 挂在 npm 脚本上，`node --test tests/invariants/env/x.test.mjs` 一绕就没了——而绕过 npm 脚本
// 恰恰是最容易手滑的形态。写在文件里，任何加载这个文件的路径都必然先跑到它：npm 脚本、裸 node、
// IDE 的 run 按钮、CI、别的 agent，一视同仁。
//
// 【为什么不是钩子，也不是文档】
// tests/gates/guard-host-tests.js 是 Claude Code 的 PreToolUse 钩子，只在 agent 走 Bash 工具时触发，
// 人在终端里手敲 npm run test:invariants:env 它一次都不会响；它判的又是【命令文本】，
// `sh -c "$CMD"`、$(...)、别名、拼出来的脚本名一律看不见（那份文件的文件头自己列了这些洞）。
// 文档则要求「每次都正确归类」，而归类正是 2026-08-02 失败的那一步。
// 这三道不是替代关系：钩子拦在敲命令那一刻，本守卫拦在进程真要跑起来那一刻。
//
// 【它挡不住什么】守卫和被守的测试住在同一个仓库，改得动测试的人就删得掉这行 import。
// 它把「需要正确归类才能生效」降成「需要刻意绕过才能失效」，不是物理隔离——
// 不依赖任何判断的隔离仍然只有容器本身（Dockerfile.test 的一次性 HOME）。
// 「漏加 import」这一类由 check 链的接线完整性检查兜（铺开时接，见本次试点报告）。
import { enforceDisposableEnv } from './disposable-env.mjs';

// 相对仓库根的调用方路径，只为把拒绝信息说具体（"谁被拦了"）。
// process.argv[1] 在 node --test 的子进程里就是被跑的那个测试文件。
const caller = (process.argv[1] || '这个测试文件').replace(`${process.cwd()}/`, '');

// 判据、文案、退出码全在 disposable-env.mjs 的 enforceDisposableEnv 里——CLI 工具
// （tests/gates/mutate.js）走的是同一个函数，两种用法不会各有一份会漂移的实现。
enforceDisposableEnv(caller);
