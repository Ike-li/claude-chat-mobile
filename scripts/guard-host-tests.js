#!/usr/bin/env node
// scripts/guard-host-tests.js —— PreToolUse 钩子：宿主机上跑破坏性命令前先要确认
//
// 【为什么需要机制而不是文档】2026-08-02 那次把 ~/.claude/projects 整棵树删光（70 个项目 /
// 291 memory / 2990 transcript），根因不是没看见警告，是【没把 npm run mutate 归类成破坏性操作】。
// 文档只能约束"读了并且正确应用规则的人"，而失败恰恰发生在归类那一步。钩子不依赖归类判断：
// 命令文本命中就拦，拦错了顶多多按一次确认。
//
// 【判据：测试域内的白名单】CLAUDE.md 讲的一直是白名单——"不在名单上的默认进容器，判断错了顶多
// 多跑一次容器，代价不对称地小"。第一版却实现成了黑名单（列出已知危险模式），理由是"Bash 命令
// 形态太自由，穷举安全形态不现实"。那个理由只在【对全部命令】做白名单时成立：git/ls/grep 确实
// 穷举不完。但本钩子要管的根本不是全部命令，只是"会跑测试 / 会执行被改坏的源码"这一小片。
// 把范围收到那一片之后，白名单立刻变得可穷举——就是 CLAUDE.md 那四条。
//
// 于是判据变成两层：
//   ① 这一段命令落在测试域里吗？不在 → 不管（日常命令零打扰）。
//   ② 在域里 → 只有名单上的形态放行，其余一律要确认。
// 黑名单要求"每遇到一个新命令都正确归类"，而 8/2 那次事故的失败点恰恰是归类那一步
// （没把 npm run mutate 归类成破坏性操作）。白名单不需要预先想到它。
//
// 【按段判定，不看整条命令】旧实现只要命令里任何位置出现 docker 就整条放行，文件头自己都写了
// `echo docker && npm run mutate` 能绕过。现在按 | && || ; 切段、逐段判：docker 只豁免它所在的
// 那一段。这不是为了对抗谁——是因为「先 docker ps 再 npm test」是很自然的手滑形态。
//
// 【它仍挡不住什么】判据是命令【文本】，所以间接形态一律看不见：`sh -c "$CMD"`、`$(...)` 里的
// 命令、shell 别名、以及任何把脚本名拼出来的写法。这是防手滑的护栏，不是对抗性沙箱——真正
// 不依赖任何判断的隔离是容器本身（Dockerfile.test 里 HOME 是一次性目录），钩子只负责提醒你用它。
import { readFileSync } from 'node:fs';

// 宿主机放行的 npm 脚本（CLAUDE.md 的四条 + 同源别名）。
// test:e2e 在内：它打的是 tests/e2e/mock/server.js（纯 mock，已核实不碰 ~/.claude），
// 且文本度量类断言在 Linux 容器下与 macOS 字体不同，宿主机跑反而更贴近真实渲染。
const HOST_ALLOWED_SCRIPTS = new Set([
  'lint', 'lint:fix', 'check',
  'test:unit', 'test:e2e', 'test:visual', 'test:playwright', 'test:playwright:p0',
]);

// 「这一段会跑测试 / 执行被改坏的源码」——本钩子的管辖范围。
// 命中即进入白名单判定；不命中直接放行（git/ls/grep/npm run inventory:update 一概不打扰）。
const TEST_DOMAIN = [
  /\bnpm\s+(?:run\s+)?[\w:.-]*test[\w:.-]*/,   // npm test / npm run test:xxx / npm run pretest
  /\bnpm\s+t\b/,
  /\bnpm\s+run\s+[\w:.-]*mutate[\w:.-]*/,
  /\bscripts\/mutate\.js\b/,
  /\bnode\b[^|&;]*--test\b/,                   // 裸 node --test，绕过 npm 脚本
  /\bRUN_CLAUDE_INTEGRATION\b/,
];

// 已知形态的具体理由。理由必须点名到文件和形态：8/2 的根因是归类判断失败，而"包含集成测试那一档"
// 这种抽象说法帮不上归类——看的人还是得自己去查它到底碰什么。
const REASONS = [
  { re: /\bnpm\s+run\s+[\w:.-]*mutate|\bscripts\/mutate\.js\b/, why: '变异检查会【故意把源码改坏再跑测试】，被改坏的可能正是算删除路径的代码——上次删库就是这么发生的' },
  { re: /\bRUN_CLAUDE_INTEGRATION\b/, why: '会跑 7 个需要真 agent turn 的文件：慢、耗 token、不稳' },
  { re: /\bnpm\s+run\s+[\w:.-]*smoke/, why: '冒烟测试真实调用 claude，消耗额度' },
  { re: /\bnpm\s+run\s+test:integration\b/, why: '集成测试会起真 server 并 spawn claude，且有用例按设计操作真实 ~/.claude/projects' },
  { re: /\bnpm\s+(?:test|t)\b(?!:)/, why: 'npm test 会跑 tests/integration/session-delete.test.mjs——它在真实 ~/.claude/projects 下做 recursive rmSync，且目录段【由被测代码算出】，与 8/2 删库同形态' },
  // ★ 白名单反转补上的洞：approval-store / audit / devices 的落盘路径是【模块级常量】，在 import
  // 求值那一刻就锁定了，只有 --import 预加载改得动。裸 node --test 会把它们写进真实 data/。
  { re: /\bnode\b[^|&;]*--test\b/, why: '直接跑测试文件绕过了 --import ./tests/setup/preload-env.mjs，而 approval-store/audit/devices 的落盘路径是模块级常量、只有预加载改得动——不带它就会写进真实 data/' },
];
const FALLBACK_REASON = '这一段落在「会跑测试 / 会执行被改坏的源码」的范围内，但不在宿主机白名单上'
  + '（白名单只有 npm run lint / check / test:unit / test:e2e，外加带 preload-env 的 tests/unit 单文件跑法）';

// 会跑测试的解释器。域判定【只认命令头】，不认参数里出现的同名字样——否则
// `grep -rn RUN_CLAUDE_INTEGRATION src/`、`git diff -- scripts/mutate.js` 这类纯只读命令
// 都会落进闸里要人确认（2026-08-04 实测，本钩子挂在每一次 Bash 上，误拦即一轮人工往返）。
const TEST_RUNNERS = new Set(['npm', 'npx', 'node', 'pnpm', 'yarn', 'bun']);

// 取这一段真正被调用的可执行文件名：跳过 `VAR=value` 前缀与重定向，再取 basename。
// 这一步是「域判据锚到命令头」的实现，也是 docker 豁免不再被参数字样触发的前提。
function commandHead(segment) {
  for (const tok of segment.trim().split(/\s+/).filter(Boolean)) {
    if (/^[A-Za-z_]\w*=/.test(tok)) continue;          // env 前缀：CI=true npm test
    if (/^\d*[<>]/.test(tok)) continue;                // 重定向：2> / >out
    return tok.replace(/^.*\//, '');                   // ./node_modules/.bin/x → x
  }
  return '';
}

// 相对路径规范化，消解 . 与 ..——否则 `tests/unit/../integration/x.test.mjs` 满足
// startsWith('tests/unit/')，穿越回集成测试而判定仍以为在单测目录里。
function normalizeRel(p) {
  const out = [];
  for (const seg of p.replace(/^\.\//, '').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

// 段内点名的测试文件路径（tests/setup/ 是预加载器本身，不算靶子）。
function testTargets(text) {
  return (text.match(/\btests\/[\w./-]+/g) || [])
    .map(normalizeRel)
    .filter(t => !t.startsWith('tests/setup/'));
}

// 白名单脚本各自允许承载的测试目录。npm 会把 `-- ` 之后的参数原样追加到脚本命令行上，
// 所以只看脚本名等于不看它到底跑了什么：`npm run test:unit -- tests/integration/session-delete.test.mjs`
// 会在真实 ~/.claude/projects 上跑那个删除用例（preload-env 明确不隔离 transcript 目录）。
const SCRIPT_TEST_SCOPE = {
  'test:unit': 'tests/unit/',
  'test:e2e': 'tests/e2e/', 'test:visual': 'tests/e2e/',
  'test:playwright': 'tests/e2e/', 'test:playwright:p0': 'tests/e2e/',
};

function whitelistedRun(segment, script) {
  if (!script || !HOST_ALLOWED_SCRIPTS.has(script)) return false;
  const extra = segment.split(/\s--\s/).slice(1).join(' ');
  if (!extra) return true;                             // 无附加参数 → 就是白名单那条命令本身
  const scope = SCRIPT_TEST_SCOPE[script];
  const targets = testTargets(extra);
  if (!targets.length) return true;                    // 附加参数没点名测试文件（--grep 之类）
  return Boolean(scope) && targets.every(t => t.startsWith(scope));
}

// 这一段是不是在容器里跑。容器里 HOME 是一次性目录，够不到宿主机家目录。
// 只认「命令头就是 docker」或「npm 脚本名里带 docker」两种——参数里提一句 docker 不算
// （旧实现按段内任意位置匹配，`npm run mutate -- scripts/docker-check.js` 整段被豁免）。
function inContainer(head, script) {
  return head === 'docker' || (script ? /docker/.test(script) : false);
}

// 带 preload-env、且只碰 tests/unit 的单文件跑法：隔离与 npm run test:unit 完全同款，
// 必须放行——否则 TDD 的「写一个失败测试 → 最小实现」每一步都会被确认框打断。
function isIsolatedUnitRun(segment) {
  if (!/--import\s+\S*tests\/setup\/preload-env\.mjs/.test(segment)) return false;
  const specs = testTargets(segment);
  return specs.length > 0 && specs.every(t => t.startsWith('tests/unit/'));
}

function segmentReason(segment) {
  if (!segment.trim()) return null;
  const head = commandHead(segment);
  if (!TEST_RUNNERS.has(head)) return null;                          // 命令头不是解释器 → 不归本钩子管
  const script = segment.match(/\bnpm\s+run\s+([\w:.-]+)/)?.[1];
  if (inContainer(head, script)) return null;                        // 这一段已进容器
  if (!TEST_DOMAIN.some(re => re.test(segment))) return null;        // 域外（npm run inventory:update 等）
  if (whitelistedRun(segment, script)) return null;
  if (!script && isIsolatedUnitRun(segment)) return null;
  return REASONS.find(({ re }) => re.test(segment))?.why ?? FALLBACK_REASON;
}

function decide(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  // 切段：管道、逻辑连接符，以及【单个 &】（后台符）。少切一种 8/2 那条命令就能整条蒙混——
  // `npm run test:unit & npm run mutate -- x` 不切就是一段，而白名单只取段内第一个脚本名。
  // 切碎是安全方向：多切出来的片段（`2>&1` 会被切成 `2>` 和 `1`）命令头都不是解释器，自然放行。
  for (const segment of command.split(/\|\||&&|[|;&\n]/)) {
    const why = segmentReason(segment);
    if (why) return why;
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
