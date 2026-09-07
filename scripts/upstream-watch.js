#!/usr/bin/env node
// scripts/upstream-watch.js —— 上游版本守望：本仓库钉的 Agent SDK 落后了没有
//
// 【手动拉取，不再每日推送】原设计每天开 / 更新一条 issue 发邮件，实测失效：那条 issue 挂了
// 35 天、27 条「上游又前进了」评论、零人类响应。两个原因叠加：
// · **报的指标不对** —— 对 `0.3.202→0.3.226` 共 67 条 changelog 逐条核对的结论是「SDK 是瘦
//   transport，真命中只有 3 条，别被版本差数吓到」。而它每天报的恰恰就是版本差数。
// · **降噪判据选错了轴** —— 原设计让标题只含落后版数、不含日期，指望「只在版数前进时才发邮件」
//   来降噪；但上游几乎天天发版，这个条件也就天天成立，降噪率约等于 0。判据得选在「我该不该
//   行动」上，选在「数字变没变」上必然退化成全量噪音。
// 所以改成：想核对的时候自己跑，拿一份带判据的 changelog 摘录。这也正是它唯一兑现过价值的
// 形态 —— 那次逐条核对抓出了 stderr 未接住、projectDir 漏截断两个真 bug。
//
// 【为什么不再监控 claude CLI】原先拿 `verifiedWith.claudeCli` 比上游 latest。那个字段是
// `scripts/release.sh` 发版时写入的**实测背书快照**，语义是历史存档；而本仓库
// `pathToClaudeCodeExecutable` 指向的是使用者机器上的 CLI —— CLI 是运行时环境，不是本仓库
// 钉住的依赖。拿一个只随发版更新的快照去比每天发版的上游，落后是结构性必然，报出来对应不到
// 任何行动。同理删掉了 patch 号配对检查：它在这两个字段上恒亮警告。
//
// 产出去哪：
// · 本地 `npm run watch:upstream` —— 报告走 stdout，进度走 stderr，不落任何文件
// · GitHub Actions 手动 Run workflow —— 同一份报告进 job summary 那一页
//
// 设计约束：
// · 零依赖 —— Node 内置 fetch，不给本仓库增加任何 npm 包。
// · 无状态 —— 对比基准就是 package.json 里钉的版本，它本身就是状态。
// · 网络集中在 fetchJson / fetchText 两处且可注入 —— 其余是纯函数，单测不打网。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org';

// 展开最近几个版本的完整条目，更早的折进 <details>。跨几十版的 changelog 实测能到 6 万字符，
// 全展开没人读得完，job summary 也有 1MB 上限。
export const EXPAND_RECENT = 5;
// 折叠区的硬预算：超出就截断并注明还剩多少版没列，绝不悄悄吞掉。
export const COLLAPSED_BUDGET = 12_000;

// 监控对象。只剩 sdk 一条轴（CLI 为何移除见文件头），但保留表结构，将来加包是零成本的。
export const WATCHED = {
  sdk: {
    pkg: '@anthropic-ai/claude-agent-sdk',
    label: 'Agent SDK',
    changelog: 'https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md',
    repo: 'anthropics/claude-agent-sdk-typescript',
  },
};

// ──────────────────────── IO（网络只在这两处）────────────────────────

export async function fetchJson(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export async function fetchText(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { accept: 'text/plain' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

// package.json 的 dependencies 是对比基准：SDK 在这里钉死。
export function readPinned(rootDir = ROOT) {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  return { sdk: pkg.dependencies?.[WATCHED.sdk.pkg] ?? null };
}

// ──────────────────────── 版本比较 ────────────────────────

// 只认 x.y.z 三段数字；带预发布后缀（-beta.1）的一律排除在"可升级目标"之外。
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

// 落后了几个已发布版本：区间 (pinned, latest]，且只数正式版。
export function countBehind(allVersions, pinned, latest) {
  if (!parseVersion(pinned) || !parseVersion(latest)) return null;
  return allVersions.filter(
    v => parseVersion(v) && compareVersions(v, pinned) > 0 && compareVersions(v, latest) <= 0,
  ).length;
}

// ──────────────────────── CHANGELOG 解析 ────────────────────────

// 上游 CHANGELOG 是 `## <版本号>` 分段。解析成 [{version, body}]，保持原文顺序（新→旧）。
export function parseChangelog(text) {
  const out = [];
  const re = /^## +(.+?) *$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(String(text ?? '')))) marks.push({ version: m[1].trim(), start: m.index, bodyAt: re.lastIndex });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    out.push({ version: marks[i].version, body: text.slice(marks[i].bodyAt, end).trim() });
  }
  return out;
}

// 取 (pinned, latest] 区间的条目。pinned 自己不含——那是我们已经在用的版本。
export function sliceChangelog(sections, pinned, latest) {
  return sections.filter(
    s => parseVersion(s.version) && compareVersions(s.version, pinned) > 0 && compareVersions(s.version, latest) <= 0,
  );
}

// 近 EXPAND_RECENT 版展开，其余折进 <details> 并受 COLLAPSED_BUDGET 约束。
// 截断时必须显式写出"还有 N 版未列出"——静默截断会让人以为已经看全了。
export function renderChangelog(sections, { expand = EXPAND_RECENT, budget = COLLAPSED_BUDGET, changelogUrl = null } = {}) {
  if (!sections.length) return '';

  const shown = sections.slice(0, expand);
  const rest = sections.slice(expand);
  const lines = shown.map(s => `#### ${s.version}\n\n${s.body}`);

  if (rest.length) {
    const collapsed = [];
    let used = 0;
    let dropped = 0;
    for (const s of rest) {
      const chunk = `#### ${s.version}\n\n${s.body}`;
      if (used + chunk.length > budget) { dropped++; continue; }
      collapsed.push(chunk);
      used += chunk.length;
    }
    const summary = `更早的 ${rest.length} 个版本`;
    const tail = dropped
      ? `\n\n_还有 ${dropped} 个版本未列出（正文长度所限）${changelogUrl ? `，见 [完整 CHANGELOG](${changelogUrl})` : ''}。_`
      : '';
    lines.push(`<details>\n<summary>${summary}</summary>\n\n${collapsed.join('\n\n')}${tail}\n\n</details>`);
  }

  return lines.join('\n\n');
}

// ──────────────────────── 报告 ────────────────────────

// 判据段落。**这是这份报告最重要的部分**：没有它，读者看到「落后 62 版」的第一反应就是升级，
// 而那个反应已经被一次 67 条的逐条核对否定过了。判据跟着报告走，才不会每次重新踩一遍。
export const TRIAGE_NOTE = [
  '### 怎么读这份报告',
  '',
  '**版本差数不是风险指标。** SDK 的 transport 对 CLI stdout 是纯透传（无 type 白名单、无 schema',
  '校验、不 strip 未知字段），而本仓库 `pathToClaudeCodeExecutable` 用的是使用者机器上的 CLI。',
  '于是每条 changelog 先分两类，只有 A 类才是"落后 = 真没修"：',
  '',
  '- **A 类：`sdk.mjs` 自己的 JS 逻辑** —— 落后就是真没修。只有四块：进程错误构造',
  '  （`getProcessExitError` / stderr 拼接）、abort 监听、`canUseTool` 协议、以及不经 CLI、',
  '  SDK 自己读磁盘的 `listSessions` / `forkSession` / `deleteSession`。',
  '- **B 类：CLI 侧行为，或 CLI 新产出的字段** —— 随使用者机器上的 CLI 到手，与 SDK 版本无关，',
  '  **今天就能用，不必等升级**。新事件类型、新 meta 字段、子代理调度、工具行为改动都在这一类。',
  '',
  '判不了某条属 A 还是 B 时，最硬的工具是 SDK 包里的 `manifest.json` —— 直接写着配对的 CLI',
  '版本、commit 与各平台二进制 checksum。**纯文本 diff 完全无用**：minifier 每版重排标识符，',
  '相邻两版能差出近万处改名噪音；要比就比包内符号计数。',
].join('\n');

export function buildReport(report, { now = new Date() } = {}) {
  const behind = report.items.filter(i => i.behind > 0);
  const summary = behind.length
    ? `依赖落后上游：${behind.map(i => `${i.label} 落后 ${i.behind} 版`).join('，')}`
    : '依赖已追平上游';

  const body = [
    `## ${summary}`,
    '',
    '| 依赖 | 本仓库钉的 | 上游 latest | 落后 | 上游发布于 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const i of report.items) {
    const when = i.latestPublishedAt ? i.latestPublishedAt.slice(0, 10) : '—';
    const behindText = i.behind > 0 ? `**${i.behind} 版**` : '—';
    body.push(`| ${i.label} | \`${i.pinned}\` | [\`${i.latest}\`](https://www.npmjs.com/package/${i.pkg}/v/${i.latest}) | ${behindText} | ${when} |`);
  }
  body.push('');

  if (behind.length) {
    body.push(TRIAGE_NOTE, '');
    for (const i of behind) {
      if (!i.changelog) continue;
      body.push('---', '', `### ${i.label}：\`${i.pinned}\` → \`${i.latest}\` 改了什么`, '', i.changelog, '');
    }
  }

  body.push(
    '---',
    '',
    // 这里不放相对链接：原先的 `../blob/master/...` 是贴着 issue 页面 URL 写的，报告改进
    // job summary（/actions/runs/<id>）后同一个相对路径会解析成坏链，本地终端里更没意义。
    `<sub>由 \`npm run watch:upstream\` 或 Actions 里手动 Run workflow`,
    `（\`.github/workflows/upstream-watch.yml\`）生成，${now.toISOString().slice(0, 16).replace('T', ' ')} UTC。`,
    '本报告不落文件、不开 issue、不发通知。</sub>',
  );

  return { summary, body: body.join('\n') };
}

// ──────────────────────── 主流程 ────────────────────────

export async function collect({ fetchImpl = fetch, rootDir = ROOT } = {}) {
  const pinned = readPinned(rootDir);
  const items = [];

  for (const [key, meta] of Object.entries(WATCHED)) {
    const pin = pinned[key];
    const packument = await fetchJson(`${REGISTRY}/${meta.pkg}`, { fetchImpl });
    const latest = packument['dist-tags']?.latest ?? null;
    const behind = countBehind(Object.keys(packument.versions ?? {}), pin, latest) ?? 0;

    let changelog = '';
    if (behind > 0) {
      try {
        const sections = sliceChangelog(parseChangelog(await fetchText(meta.changelog, { fetchImpl })), pin, latest);
        changelog = renderChangelog(sections, { changelogUrl: `https://github.com/${meta.repo}/blob/main/CHANGELOG.md` });
      } catch {
        // CHANGELOG 抓不到不该让整份报告失败——落后这件事本身才是重点。
        changelog = `_（CHANGELOG 抓取失败，见 [上游仓库](https://github.com/${meta.repo}/blob/main/CHANGELOG.md)）_`;
      }
    }

    items.push({
      key, pkg: meta.pkg, label: meta.label, pinned: pin, latest, behind, changelog,
      latestPublishedAt: packument.time?.[latest] ?? null,
    });
  }

  return { pinned, items, behind: items.some(i => i.behind > 0) };
}

// 进度走 log（stderr），报告走 out（stdout）。分开是为了让 workflow 里一行
// `node scripts/upstream-watch.js >> "$GITHUB_STEP_SUMMARY"` 只拿到 markdown 报告本身。
export async function main({ fetchImpl = fetch, rootDir = ROOT, log = console.error, out = console.log } = {}) {
  const collected = await collect({ fetchImpl, rootDir });

  for (const i of collected.items) {
    log(i.behind > 0
      ? `⚠️  ${i.label}: 钉 ${i.pinned}，上游 ${i.latest} —— 落后 ${i.behind} 版`
      : `✅ ${i.label}: ${i.pinned} 已是最新`);
  }

  const report = buildReport(collected);
  out(report.body);
  return { ...collected, report };
}

// 直接运行才跑 main；被测试 import 时不执行。
// 不能只比字符串：node 加载模块会解析符号链接，import.meta.url 可能已是 realpath 而 argv[1] 不是。
function isMainEntry() {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv)).href;
  } catch {
    return import.meta.url === pathToFileURL(argv).href;
  }
}

if (isMainEntry()) {
  main().catch(err => {
    console.error(`upstream-watch 失败：${err.message}`);
    process.exit(1); // 脚本自身坏了才红
  });
}
