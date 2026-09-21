// 验收：从站点文档里把事件名**反向提取**出来，与 protocol.js 比对。
//
// 不是检查「数字写对了没」—— 数字对而列表错，正是 2026-09-21 修之前的状态：
// 表头写 27 种、列了 27 项，其中 worktree_status 与 background_tasks_changed
// 在代码里根本不存在，而真实数量是 31。只核数字的检查会给这种表放行。
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
let bad = 0;

// 站点上「列事件清单」的表所在的文件
const FILES = ['llms-full.txt',
  ...['api-events', 'events-sync'].flatMap((n) => [
    `docs-site/pages/${n}.md`, `docs-site/pages/${n}.html`, `docs-site/fragments/${n}.html`])];

for (const f of FILES) {
  const p = `${ROOT}/${f}`;
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');

  // 入向事件形如 a:b，出向是下划线小写词。分别提取，只认真正像事件名的 token。
  // `npm run service:restart` 这类脚本名同形，必须排掉 —— 第一版没排，
  // 于是报出 4 个「代码里不存在的事件」，而它们根本不是事件。
  const inbound = new Set([...text.matchAll(/(?<!npm run )\b([a-z]+:[a-zA-Z:]+)\b/g)].map((m) => m[1])
    .filter((t) => /^(session|user|sync|mirror|conn|client|read|browse|files|attachment|git|hooks|task|tool|service|doctor|dev|logs|audit|push|config|env|permissions|connect|statusline|subagent):/.test(t)));
  const outbound = new Set([...text.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map((m) => m[1]));

  // 文档里提到了、但代码里没有 —— 这是最坏的一种错：读者会去用一个不存在的事件
  const ghostIn = [...inbound].filter((t) => !IN.has(t));
  const ghostOut = [...outbound].filter((t) => OUT.has(t) === false
    && AGENT_EVENT_TYPES.some((r) => r.includes('_')) // 只在确实像事件名时才判
    && /^(text|thinking|tool|permission|request|user|status|effort|mirror|task|api|background|device|pending|session|history|diag|prompt|rewind|slash|trusted|worktree)_/.test(t));

  if (ghostIn.length || ghostOut.length) {
    console.log(`✗ ${f}`);
    if (ghostIn.length) console.log(`    代码里不存在的入向事件: ${ghostIn.join(', ')}`);
    if (ghostOut.length) console.log(`    代码里不存在的出向事件: ${ghostOut.join(', ')}`);
    bad += 1;
  }
}

// 主表（api-events）必须把真值列全
const main = readFileSync(`${ROOT}/docs-site/pages/api-events.md`, 'utf8');
const missOut = AGENT_EVENT_TYPES.filter((t) => !main.includes(t));
const missIn = INBOUND_SOCKET_EVENTS.filter((t) => !main.includes(t));
if (missOut.length) { console.log(`✗ api-events.md 漏了 ${missOut.length} 个出向事件: ${missOut.join(', ')}`); bad += 1; }
if (missIn.length) { console.log(`✗ api-events.md 漏了 ${missIn.length} 个入向事件: ${missIn.join(', ')}`); bad += 1; }

// 数字与真值一致
for (const [f, pat, want] of [
  ['docs-site/pages/api-events.md', /出向 agent:event 契约类型 \((\d+) 种\)/, AGENT_EVENT_TYPES.length],
  ['docs-site/pages/api-events.md', /入向 Socket 契约事件 \((\d+) 种\)/, INBOUND_SOCKET_EVENTS.length],
  ['llms.txt', /(\d+) outbound agent:event types/, AGENT_EVENT_TYPES.length],
  ['llms.txt', /& (\d+) inbound socket events/, INBOUND_SOCKET_EVENTS.length],
]) {
  const got = readFileSync(`${ROOT}/${f}`, 'utf8').match(pat)?.[1];
  if (String(want) !== got) { console.log(`✗ ${f} ${pat} = ${got}，应为 ${want}`); bad += 1; }
}

console.log(bad === 0
  ? `\n事件契约验收通过：站点清单与 protocol.js 一致（出向 ${OUT.size} · 入向 ${IN.size}）`
  : `\n未通过：${bad} 项`);
process.exit(bad === 0 ? 0 : 1);
