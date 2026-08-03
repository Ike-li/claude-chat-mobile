#!/usr/bin/env node
// scripts/guard-host-tests.mjs —— PreToolUse 钩子：宿主机上跑破坏性命令前先要确认
//
// 【为什么需要机制而不是文档】2026-08-02 那次把 ~/.claude/projects 整棵树删光（70 个项目 /
// 291 memory / 2990 transcript），根因不是没看见警告，是【没把 npm run mutate 归类成破坏性操作】。
// 文档只能约束"读了并且正确应用规则的人"，而失败恰恰发生在归类那一步。钩子不依赖归类判断：
// 命令文本命中就拦，拦错了顶多多按一次确认。
//
// 【判据：白名单思路的反面实现】理想是"只放行 lint/check/test:unit"，但 Bash 命令形态太自由
// （管道、&&、环境变量前缀、裸 node --test），穷举安全形态不现实。折中：列出【已知会碰宿主机
// ~/.claude 或执行故意弄坏的代码】的模式，命中就要确认；命令里出现 docker 视为已进容器，放行。
//
// 【它挡不住什么】命令里写个 `echo docker && npm run mutate` 就能绕过——这是防手滑的护栏，
// 不是对抗性沙箱。真正不依赖判断的隔离是容器本身（Dockerfile.test），钩子只是提醒你用它。
import { readFileSync } from 'node:fs';

// 会起真 server / spawn claude / 执行变异后的源码——都可能触到宿主机家目录
const DANGEROUS = [
  { re: /\bnpm\s+run\s+mutate\b|\bscripts\/mutate\.js\b/, why: '变异检查会【故意把源码改坏再跑测试】，被改坏的可能正是算删除路径的代码——上次删库就是这么发生的' },
  { re: /\bnpm\s+run\s+test:integration\b/, why: '集成测试会起真 server 并 spawn claude，且有用例按设计操作真实 ~/.claude/projects' },
  { re: /\bnpm\s+run\s+test:smoke\b/, why: '冒烟测试真实调用 claude，消耗额度' },
  { re: /\bRUN_CLAUDE_INTEGRATION\b/, why: '会跑 7 个需要真 agent turn 的文件：慢、耗 token、不稳' },
  { re: /\bnpm\s+(test|t)\b(?!:)/, why: 'npm test 包含集成测试那一档（CLAUDE.md 白名单里只有 lint / check / test:unit）' },
  // 不枚举 node 的中间参数：--import ./tests/setup/preload-env.mjs 这类非 `--x` 形态的参数会把
  // 逐个匹配的写法卡断（第一版就栽在这）。只要求 node ... --test ... tests/integration 依次出现。
  { re: /\bnode\b[^|&;]*--test\b[^|&;]*tests\/integration/, why: '直接跑集成测试文件，绕过了 npm 脚本但风险相同' },
];

// 命令里出现 docker = 已经进容器了，放行。容器里 HOME 是一次性目录，够不到宿主机家目录。
const IN_CONTAINER = /\bdocker\b/;

function decide(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  if (IN_CONTAINER.test(command)) return null;
  for (const { re, why } of DANGEROUS) {
    if (re.test(command)) return why;
  }
  return null;
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // 读不到/解析不了输入就别挡路——钩子自身故障不该卡住工作
  }
  if (payload?.tool_name !== 'Bash') process.exit(0);

  const why = decide(payload?.tool_input?.command);
  if (!why) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason:
        `⚠️ 这条命令按 CLAUDE.md 属于「必须进容器」那一类。\n\n原因：${why}\n\n` +
        '容器化改跑：npm run test:docker / npm run test:docker:e2e / npm run mutate:docker -- <文件>\n' +
        '（首次先 npm run docker:build）\n\n' +
        '确实要在宿主机上跑就批准——但注意宿主机的 ~/.claude 对它是可写的。',
    },
  }));
  process.exit(0);
}

export { decide };

// 仅在被直接执行时跑 main（被测试 import 时不跑）。
// 用 realpath 比对：符号链接下 import.meta.url 与 argv[1] 可能不同形（/var vs /private/var）。
if (process.argv[1]) {
  const { realpathSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  try {
    if (realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) main();
  } catch { /* 比对失败就不自动执行 */ }
}
