// 验收：站点上提到的 socket 事件名，必须真实存在于 protocol.js。
//
// 不是检查「数字写对了没」—— 数字对而列表错，正是 2026-09-21 修之前的状态：
// 表头写 27 种、列了 27 项，其中 worktree_status 与 background_tasks_changed
// 在代码里根本不存在，而真实数量是 31。只核数字的检查会给这种表放行。
//
// 2026-10-27 手册 docs-site/ 与 llms-full.txt 删除后，站点上已经没有列全事件的总表，
// 事件名只零散出现在架构图和 skill.md 里，所以这里只剩一件事：抓写错的事件名。
// 图上的事件总数（「共 N 种 type」）由主仓 tests/gates/check-diagram-claims.js 守。
//
// 用法：node _build/check-event-contract.mjs
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// 真相源在主工作树的 app/src/shared/protocol.js —— gh-pages 是孤儿分支、没有产品
// 代码。位置用 git 问出来而不是写死：worktree 可以被挪走，写死的路径挪完就静默失效。
const MAIN_REPO = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: ROOT, encoding: 'utf8' }).trim());
const PROTOCOL = join(MAIN_REPO, 'app/src/shared/protocol.js');
if (!existsSync(PROTOCOL)) {
  console.error(`找不到 protocol.js：${PROTOCOL}\n主工作树不在预期位置，无法核对事件契约。`);
  process.exit(2);
}
const { AGENT_EVENT_TYPES, INBOUND_SOCKET_EVENTS } = await import(pathToFileURL(PROTOCOL).href);

const OUT = new Set(AGENT_EVENT_TYPES);
const IN = new Set(INBOUND_SOCKET_EVENTS);

// 「像事件名」的判据从真值推出来：入向看冒号前的前缀，出向看第一个下划线前的前缀。
// 原先手写的前缀表漏了 folders: 与 image:，这两类事件名写错了也抓不到。
// 出向另加历史上出过错名、但真值里没有的前缀：worktree_status、background_tasks_changed
// 就是这么来的，只按真值推会把它们放过去。
const IN_PREFIX = new Set(INBOUND_SOCKET_EVENTS.map((e) => e.split(':')[0]));
const OUT_PREFIX = new Set([
  ...AGENT_EVENT_TYPES.filter((e) => e.includes('_')).map((e) => e.split('_')[0]),
  'worktree', 'background',
]);

// 同形但不是事件的名字。
// npm 脚本名（hooks:install、statusline:install…）与入向事件同形，直接取主仓 package.json 的 scripts 排掉。
const NPM_SCRIPTS = new Set(Object.keys(JSON.parse(readFileSync(join(MAIN_REPO, 'package.json'), 'utf8')).scripts));
// CLI 上报给 server 的 system 子类型，与出向事件同前缀，但不经 socket 下发。
const CLI_SUBTYPES = new Set(['task_started']);

// 扫会上线的文本页面。demo/ 是原样拷贝的产品前端代码，不是文档，排除。
const FILES = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
  .filter((f) => /\.(html|txt|md)$/.test(f) && !/^(demo|seo-baseline|\.claude|_build)\//.test(f));

let bad = 0;
let recognized = 0;
for (const f of FILES) {
  const text = readFileSync(`${ROOT}/${f}`, 'utf8');
  // 入向事件形如 a:b，出向是下划线小写词
  const inbound = new Set([...text.matchAll(/\b([a-z]+:[a-zA-Z:]+)\b/g)].map((m) => m[1])
    .filter((t) => IN_PREFIX.has(t.split(':')[0])));
  const outbound = new Set([...text.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map((m) => m[1])
    .filter((t) => OUT_PREFIX.has(t.split('_')[0])));

  // 页面上提到了、但代码里没有 —— 最坏的一种错：读者会去用一个不存在的事件
  const ghostIn = [...inbound].filter((t) => !IN.has(t) && !NPM_SCRIPTS.has(t));
  const ghostOut = [...outbound].filter((t) => !OUT.has(t) && !CLI_SUBTYPES.has(t));
  recognized += [...inbound].filter((t) => IN.has(t)).length + [...outbound].filter((t) => OUT.has(t)).length;

  if (ghostIn.length || ghostOut.length) {
    console.log(`✗ ${f}`);
    if (ghostIn.length) console.log(`    代码里不存在的入向事件: ${ghostIn.join(', ')}`);
    if (ghostOut.length) console.log(`    代码里不存在的出向事件: ${ghostOut.join(', ')}`);
    bad += 1;
  }
}

// 一个真实事件名都没认出来，说明文件清单或正则失效了，不能报绿
if (recognized === 0) {
  console.log(`✗ 扫了 ${FILES.length} 个文件，一个真实事件名都没认出来，文件清单或正则多半失效了`);
  bad += 1;
}

console.log(bad === 0
  ? `\n事件名验收通过：${FILES.length} 个页面里认出 ${recognized} 处事件名，都在 protocol.js 里（出向 ${OUT.size} · 入向 ${IN.size}）`
  : `\n未通过：${bad} 项`);
process.exit(bad === 0 ? 0 : 1);
