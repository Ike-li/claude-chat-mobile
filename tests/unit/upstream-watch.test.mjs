// tests/unit/upstream-watch.test.mjs —— 上游版本守望的纯逻辑单测，不打网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseVersion,
  compareVersions,
  countBehind,
  parseChangelog,
  sliceChangelog,
  renderChangelog,
  patchOf,
  pairingNote,
  buildIssue,
  readPinned,
  collect,
  main,
  WATCHED,
  EXPAND_RECENT,
} from '../../scripts/upstream-watch.js';

// ──────────────────────── 版本解析与比较 ────────────────────────

test('parseVersion 只认三段数字，预发布版一律拒绝', () => {
  assert.deepEqual(parseVersion('0.3.201'), [0, 3, 201]);
  assert.deepEqual(parseVersion(' 2.1.220 '), [2, 1, 220]);
  assert.equal(parseVersion('2.1.220-beta.1'), null, '预发布版不能当升级目标');
  assert.equal(parseVersion('2.1'), null);
  assert.equal(parseVersion(undefined), null);
});

test('compareVersions 逐段比较而不是字典序', () => {
  assert.equal(compareVersions('0.3.201', '0.3.220'), -1);
  assert.equal(compareVersions('0.3.220', '0.3.201'), 1);
  assert.equal(compareVersions('0.3.220', '0.3.220'), 0);
  // 字典序会把 "0.3.99" 判成大于 "0.3.201"
  assert.equal(compareVersions('0.3.99', '0.3.201'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
});

test('countBehind 数区间 (pinned, latest] 内的正式版', () => {
  const versions = ['0.3.200', '0.3.201', '0.3.210', '0.3.220', '0.3.221'];
  // 不含 pinned 自己，不含超过 latest 的
  assert.equal(countBehind(versions, '0.3.201', '0.3.220'), 2);
  assert.equal(countBehind(versions, '0.3.220', '0.3.220'), 0, '已是最新则落后 0');
});

test('countBehind 忽略预发布版', () => {
  const versions = ['0.3.201', '0.3.210-beta.1', '0.3.215', '0.3.220'];
  assert.equal(countBehind(versions, '0.3.201', '0.3.220'), 2, 'beta 不该计入落后数');
});

test('countBehind 对无法解析的版本给 null 而不是 0', () => {
  assert.equal(countBehind(['1.0.0'], 'nonsense', '1.0.0'), null, 'null 表示无从判断，与「不落后」是两回事');
});

// ──────────────────────── CHANGELOG 解析 ────────────────────────

const SAMPLE = `# Changelog

## 0.3.220

- Updated to parity with Claude Code v2.1.220

## 0.3.219

- Added opt-in \`cancel_queued\`
- Fixed the initialize response

## 0.3.218

- \`SkillToolOutput\` now reports background
`;

test('parseChangelog 按 ## 分段并保持新→旧顺序', () => {
  const secs = parseChangelog(SAMPLE);

  assert.deepEqual(secs.map(s => s.version), ['0.3.220', '0.3.219', '0.3.218']);
  assert.match(secs[1].body, /cancel_queued/);
  assert.doesNotMatch(secs[0].body, /cancel_queued/, '段落不能串到下一版');
});

test('parseChangelog 不把一级标题 # Changelog 当版本', () => {
  assert.equal(parseChangelog(SAMPLE).some(s => s.version === 'Changelog'), false);
});

test('parseChangelog 对空输入给空数组', () => {
  assert.deepEqual(parseChangelog(''), []);
  assert.deepEqual(parseChangelog(null), []);
});

test('sliceChangelog 取 (pinned, latest] 且不含 pinned 自己', () => {
  const picked = sliceChangelog(parseChangelog(SAMPLE), '0.3.218', '0.3.220');

  assert.deepEqual(picked.map(s => s.version), ['0.3.220', '0.3.219'], 'pinned 是已在用的版本，不该重复列出');
});

// ──────────────────────── 渲染与截断 ────────────────────────

const manySections = n => Array.from({ length: n }, (_, i) => ({ version: `0.3.${300 - i}`, body: `- change ${i}` }));

test('少于展开上限时全部展开、不出现折叠块', () => {
  const md = renderChangelog(manySections(3));

  assert.doesNotMatch(md, /<details>/);
  assert.match(md, /#### 0\.3\.300/);
});

test('超过展开上限时其余折进 details', () => {
  const md = renderChangelog(manySections(EXPAND_RECENT + 3));

  assert.match(md, /<details>/);
  assert.match(md, new RegExp(`更早的 3 个版本`));
  // 前 EXPAND_RECENT 个在折叠块之前
  assert.ok(md.indexOf('#### 0.3.300') < md.indexOf('<details>'));
});

test('折叠区超预算时截断，并明确写出还剩多少版未列出', () => {
  const big = Array.from({ length: 20 }, (_, i) => ({ version: `0.3.${300 - i}`, body: 'x'.repeat(2000) }));
  const md = renderChangelog(big, { expand: 2, budget: 5000, changelogUrl: 'https://example.com/CHANGELOG.md' });

  assert.match(md, /还有 \d+ 个版本未列出/, '静默截断会让人以为已经看全了');
  assert.match(md, /example\.com\/CHANGELOG\.md/, '截断时必须给出完整 changelog 的去处');
});

test('无变更区间时渲染成空串而不是空的 details 壳', () => {
  assert.equal(renderChangelog([]), '');
});

// ──────────────────────── patch 配对 ────────────────────────

test('patch 号相同判为同一批发布', () => {
  assert.match(pairingNote('0.3.220', '2.1.220'), /配对/);
  assert.doesNotMatch(pairingNote('0.3.220', '2.1.220'), /⚠️/);
});

test('patch 号不同时明确警告（本仓库当前就是这个状态）', () => {
  const note = pairingNote('0.3.201', '2.1.220');

  assert.match(note, /⚠️/);
  assert.match(note, /不是同一批/);
  assert.match(note, /201 vs 220/);
});

test('版本无法解析时不下配对结论', () => {
  assert.equal(pairingNote('nonsense', '2.1.220'), null);
});

test('patchOf 取第三段', () => {
  assert.equal(patchOf('2.1.220'), 220);
  assert.equal(patchOf('bad'), null);
});

// ──────────────────────── issue 文案 ────────────────────────

const report = ({ sdkBehind = 19, cliBehind = 0 } = {}) => ({
  pinned: { sdk: '0.3.201', cli: '2.1.220' },
  stable: '2.1.212',
  items: [
    { key: 'sdk', pkg: WATCHED.sdk.pkg, label: 'Agent SDK', pinned: '0.3.201', latest: '0.3.220', behind: sdkBehind, changelog: '#### 0.3.220\n\n- parity', latestPublishedAt: '2026-07-24T23:11:19.727Z' },
    { key: 'cli', pkg: WATCHED.cli.pkg, label: 'claude CLI', pinned: '2.1.220', latest: '2.1.220', behind: cliBehind, changelog: '', latestPublishedAt: '2026-07-24T23:11:21.821Z' },
  ],
});

test('标题只列真正落后的那些依赖', () => {
  const { title } = buildIssue(report(), { now: new Date('2026-08-03T00:00:00Z') });

  assert.equal(title, '依赖落后上游：Agent SDK 落后 19 版');
  assert.doesNotMatch(title, /claude CLI/, '没落后的不该出现在标题里');
});

test('标题不含日期——workflow 靠标题是否变化决定要不要再发一封邮件', () => {
  const a = buildIssue(report(), { now: new Date('2026-08-03T00:00:00Z') }).title;
  const b = buildIssue(report(), { now: new Date('2026-08-09T00:00:00Z') }).title;

  assert.equal(a, b, '同样的落后状态隔几天再查，标题必须一致，否则会天天来一封重复邮件');
  assert.notEqual(
    buildIssue(report({ sdkBehind: 20 })).title,
    buildIssue(report({ sdkBehind: 19 })).title,
    '落后版数真的前进了则标题必须变，这才触发新通知',
  );
});

test('表格列出所有被监控依赖（含未落后的，便于一眼看全）', () => {
  const { body } = buildIssue(report());

  assert.match(body, /Agent SDK \| `0\.3\.201`/);
  assert.match(body, /claude CLI \| `2\.1\.220`/);
  assert.match(body, /\*\*19 版\*\*/);
});

test('只为落后的依赖附 changelog 段落', () => {
  const { body } = buildIssue(report());

  assert.match(body, /### Agent SDK：`0\.3\.201` → `0\.3\.220` 改了什么/);
  assert.doesNotMatch(body, /### claude CLI：.*改了什么/, '没落后就没有变更区间可列');
});

test('正文带上 stable 线提示与配对警告', () => {
  const { body } = buildIssue(report());

  assert.match(body, /stable.*`2\.1\.212`/s);
  assert.match(body, /不是同一批/);
});

test('正文提示 verifiedWith 是实测背书、不要手改', () => {
  const { body } = buildIssue(report());

  assert.match(body, /verifiedWith\.claudeCli.*实测背书/s, 'CI 自动改这个字段等于伪造背书，必须写清楚');
});

// ──────────────────────── readPinned ────────────────────────

test('readPinned 从 package.json 取两个基准值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { [WATCHED.sdk.pkg]: '0.3.201' },
    verifiedWith: { claudeCli: '2.1.220' },
  }));

  assert.deepEqual(readPinned(dir), { sdk: '0.3.201', cli: '2.1.220' });
});

test('readPinned 在字段缺失时给 null 而不是崩', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));

  assert.deepEqual(readPinned(dir), { sdk: null, cli: null });
});

// ──────────────────────── collect / main（假网络）────────────────────────

function fakeNet({ sdkLatest = '0.3.220', cliLatest = '2.1.220', sdkVersions, cliVersions, changelogFails = false } = {}) {
  const packument = (latest, versions, extraTags = {}) => ({
    'dist-tags': { latest, ...extraTags },
    versions: Object.fromEntries((versions ?? [latest]).map(v => [v, {}])),
    time: { [latest]: '2026-07-24T23:11:19.727Z' },
  });
  return async url => {
    const u = String(url);
    if (u.includes('CHANGELOG.md')) {
      if (changelogFails) return { ok: false, status: 500, text: async () => '' };
      return { ok: true, text: async () => SAMPLE };
    }
    if (u.includes(encodeURIComponent(WATCHED.sdk.pkg)) || u.includes(WATCHED.sdk.pkg)) {
      return { ok: true, json: async () => packument(sdkLatest, sdkVersions) };
    }
    return { ok: true, json: async () => packument(cliLatest, cliVersions, { stable: '2.1.212' }) };
  };
}

function fixtureRoot(pinnedSdk = '0.3.201', pinnedCli = '2.1.220') {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { [WATCHED.sdk.pkg]: pinnedSdk },
    verifiedWith: { claudeCli: pinnedCli },
  }));
  return dir;
}

test('collect 算出落后数并只给落后项抓 changelog', async () => {
  const rootDir = fixtureRoot();
  const out = await collect({
    fetchImpl: fakeNet({ sdkVersions: ['0.3.201', '0.3.218', '0.3.219', '0.3.220'] }),
    rootDir,
  });

  const sdk = out.items.find(i => i.key === 'sdk');
  const cli = out.items.find(i => i.key === 'cli');

  assert.equal(sdk.behind, 3);
  assert.equal(cli.behind, 0, 'CLI 钉的就是 latest');
  assert.ok(sdk.changelog.length > 0);
  assert.equal(cli.changelog, '', '没落后就不该去抓 changelog');
  assert.equal(out.stable, '2.1.212');
  assert.equal(out.behind, true);
});

test('CHANGELOG 抓取失败不影响「落后」这个结论本身', async () => {
  const rootDir = fixtureRoot();
  const out = await collect({
    fetchImpl: fakeNet({ sdkVersions: ['0.3.201', '0.3.220'], changelogFails: true }),
    rootDir,
  });

  const sdk = out.items.find(i => i.key === 'sdk');
  assert.equal(sdk.behind, 1, '抓不到 changelog 也要照报落后');
  assert.match(sdk.changelog, /抓取失败/);
});

test('全部追平时 main 不产出 issue 文件', async () => {
  const rootDir = fixtureRoot('0.3.220', '2.1.220');
  const out = await main({
    fetchImpl: fakeNet({ sdkVersions: ['0.3.220'] }),
    rootDir,
    log: () => {},
  });

  assert.equal(out.behind, false);
  assert.equal(out.issue, undefined);
  assert.equal(existsSync(join(rootDir, 'upstream-issue.md')), false);
});

test('落后时 main 把正文写进 upstream-issue.md', async () => {
  const rootDir = fixtureRoot();
  const out = await main({
    fetchImpl: fakeNet({ sdkVersions: ['0.3.201', '0.3.219', '0.3.220'] }),
    rootDir,
    log: () => {},
  });

  assert.equal(out.behind, true);
  assert.match(out.issue.title, /Agent SDK 落后 2 版/);
  assert.equal(readFileSync(join(rootDir, 'upstream-issue.md'), 'utf8').trim(), out.issue.body.trim());
});
