#!/usr/bin/env node
// scripts/upstream-watch.js —— 上游版本守望：本仓库钉的 Agent SDK / claude CLI 落后了没有
//
// 本项目与两个上游强绑定：package.json 钉死 @anthropic-ai/claude-agent-sdk，
// verifiedWith.claudeCli 记录实测背书过的 CLI 版本（README 徽章直接读它）。两者都升级得快，
// 此前没有任何机制知道上游发了新版——SDK 曾在无人察觉的情况下落后 19 个版本近三周。
//
// 本脚本每天由 .github/workflows/upstream-watch.yml 跑一次：查 npm registry，与 package.json
// 对比，落后就开 issue（GitHub 把它发成邮件），并从上游 CHANGELOG.md 摘出这期间改了什么。
//
// 设计约束：
// · 零依赖 —— Node 内置 fetch，不给本仓库增加任何 npm 包。
// · 无状态 —— 对比基准就是 package.json 里钉的版本，它本身就是状态，不需要 state 文件。
//   （这也意味着升级 package.json 后 issue 会自动追平关闭，不需要手工同步任何东西。）
// · 退出码恒 0 —— 上游发版不是本仓库的错，不该把 job 染红。结论走 stdout / GITHUB_OUTPUT。
// · 网络集中在 fetchJson / fetchText 两处且可注入 —— 其余是纯函数，单测不打网。
//
// 本地手动跑：npm run watch:upstream

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org';

// 展开最近几个版本的完整条目，更早的折进 <details>。CLI 跨 18 版的 changelog 实测 62088 字符，
// 而 issue body 上限 65536——全展开会直接撑爆，且 519 行没人读得完。
export const EXPAND_RECENT = 5;
// 折叠区的硬预算：超出就截断并注明还剩多少版没列，绝不悄悄吞掉。
export const COLLAPSED_BUDGET = 12_000;

// 监控对象。sdk 比对 package.json 的 dependencies，cli 比对 verifiedWith.claudeCli。
export const WATCHED = {
  sdk: {
    pkg: '@anthropic-ai/claude-agent-sdk',
    label: 'Agent SDK',
    changelog: 'https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md',
    repo: 'anthropics/claude-agent-sdk-typescript',
  },
  cli: {
    pkg: '@anthropic-ai/claude-code',
    label: 'claude CLI',
    changelog: 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md',
    repo: 'anthropics/claude-code',
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

// package.json 是对比基准：SDK 看 dependencies 的钉死值，CLI 看 verifiedWith.claudeCli
// （全仓库唯一记录它的地方，release.sh 发版时写入，README 徽章也读这里）。
export function readPinned(rootDir = ROOT) {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  return {
    sdk: pkg.dependencies?.[WATCHED.sdk.pkg] ?? null,
    cli: pkg.verifiedWith?.claudeCli ?? null,
  };
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

// 上游两份 CHANGELOG 都是 `## <版本号>` 分段。解析成 [{version, body}]，保持原文顺序（新→旧）。
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

// ──────────────────────── 汇总与文案 ────────────────────────

// 实测：CLI 2.1.N 与 SDK 0.3.N 由同一条流水线产出（采样 201/205/210/215/220 跨 3 周，
// SDK 恒早 2 秒发布），patch 号严格配对。据此可判断本仓库钉的两个版本是否属于同一批。
export function patchOf(v) {
  const p = parseVersion(v);
  return p ? p[2] : null;
}

export function pairingNote(sdkVersion, cliVersion) {
  const a = patchOf(sdkVersion);
  const b = patchOf(cliVersion);
  if (a === null || b === null) return null;
  if (a === b) return `本仓库钉的两个版本配对：SDK \`${sdkVersion}\` ↔ CLI \`${cliVersion}\`（同一批发布）。`;
  return `⚠️ **本仓库钉的两个版本不是同一批**：SDK \`${sdkVersion}\` ↔ CLI \`${cliVersion}\`（patch 号 ${a} vs ${b}）。上游这两个包由同一条流水线同步发布，patch 号本该相同。`;
}

export function buildIssue(report, { now = new Date() } = {}) {
  const behind = report.items.filter(i => i.behind > 0);
  const parts = behind.map(i => `${i.label} 落后 ${i.behind} 版`);
  // 标题**不带日期**：workflow 靠「标题是否变化」判断该不该再发一次通知。带日期的话每天都算变化，
  // 天天来一封邮件；只在落后版数真的前进时才变，才是有信息量的提醒节奏。
  const title = `依赖落后上游：${parts.join('，')}`;

  const body = ['| 依赖 | 本仓库钉的 | 上游 latest | 落后 | 上游发布于 |', '| --- | --- | --- | --- | --- |'];
  for (const i of report.items) {
    const when = i.latestPublishedAt ? i.latestPublishedAt.slice(0, 10) : '—';
    const behindText = i.behind > 0 ? `**${i.behind} 版**` : '—';
    body.push(`| ${i.label} | \`${i.pinned}\` | [\`${i.latest}\`](https://www.npmjs.com/package/${i.pkg}/v/${i.latest}) | ${behindText} | ${when} |`);
  }
  body.push('');

  if (report.stable) {
    body.push(`CLI 另有 \`stable\` 线，当前 \`${report.stable}\` —— 想稳一点可以升到它而不是 \`latest\`。`, '');
  }

  const note = pairingNote(report.pinned.sdk, report.pinned.cli);
  if (note) body.push(note, '');

  for (const i of behind) {
    if (!i.changelog) continue;
    body.push('---', '', `### ${i.label}：\`${i.pinned}\` → \`${i.latest}\` 改了什么`, '', i.changelog, '');
  }

  body.push(
    '---',
    '',
    `<sub>由 [upstream-watch.yml](../blob/master/.github/workflows/upstream-watch.yml) 每日检查，最后更新 ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC。`,
    '升级 `package.json` 后本 issue 会在下次检查时自动关闭 —— 不需要手工同步任何状态。',
    '`verifiedWith.claudeCli` 是**实测背书**语义，请本机验过再由 `scripts/release.sh` 写入，不要手改。</sub>',
  );

  return { title, body: body.join('\n') };
}

// ──────────────────────── 主流程 ────────────────────────

function emitOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

export async function collect({ fetchImpl = fetch, rootDir = ROOT } = {}) {
  const pinned = readPinned(rootDir);
  const items = [];
  let stable = null;

  for (const [key, meta] of Object.entries(WATCHED)) {
    const pin = pinned[key];
    const packument = await fetchJson(`${REGISTRY}/${meta.pkg}`, { fetchImpl });
    const tags = packument['dist-tags'] ?? {};
    const latest = tags.latest ?? null;
    if (key === 'cli' && tags.stable) stable = tags.stable;

    const behind = countBehind(Object.keys(packument.versions ?? {}), pin, latest) ?? 0;

    let changelog = '';
    if (behind > 0) {
      try {
        const sections = sliceChangelog(parseChangelog(await fetchText(meta.changelog, { fetchImpl })), pin, latest);
        changelog = renderChangelog(sections, { changelogUrl: `https://github.com/${meta.repo}/blob/main/CHANGELOG.md` });
      } catch {
        // CHANGELOG 抓不到不该让整条通知失败——落后这件事本身才是重点。
        changelog = `_（CHANGELOG 抓取失败，见 [上游仓库](https://github.com/${meta.repo}/blob/main/CHANGELOG.md)）_`;
      }
    }

    items.push({
      key, pkg: meta.pkg, label: meta.label, pinned: pin, latest, behind, changelog,
      latestPublishedAt: packument.time?.[latest] ?? null,
    });
  }

  return { pinned, items, stable, behind: items.some(i => i.behind > 0) };
}

export async function main({ fetchImpl = fetch, rootDir = ROOT, log = console.log } = {}) {
  const report = await collect({ fetchImpl, rootDir });

  for (const i of report.items) {
    log(i.behind > 0
      ? `⚠️  ${i.label}: 钉 ${i.pinned}，上游 ${i.latest} —— 落后 ${i.behind} 版`
      : `✅ ${i.label}: ${i.pinned} 已是最新`);
  }

  if (!report.behind) {
    emitOutput('behind', 'false');
    return report;
  }

  const issue = buildIssue(report);
  writeFileSync(join(rootDir, 'upstream-issue.md'), issue.body + '\n');
  log(`\n标题：${issue.title}`);
  log(`正文 ${issue.body.length} 字符，已写入 upstream-issue.md`);

  emitOutput('behind', 'true');
  emitOutput('issue_title', issue.title);
  return { ...report, issue };
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
