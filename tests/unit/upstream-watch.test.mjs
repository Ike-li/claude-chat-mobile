// tests/unit/upstream-watch.test.mjs —— 上游版本守望的纯逻辑单测，不打网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseVersion,
  compareVersions,
  countBehind,
  parseChangelog,
  sliceChangelog,
  renderChangelog,
  buildReport,
  TRIAGE_NOTE,
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

// ──────────────────────── 报告文案 ────────────────────────

const report = ({ sdkBehind = 19 } = {}) => ({
  pinned: { sdk: '0.3.201' },
  items: [
    { key: 'sdk', pkg: WATCHED.sdk.pkg, label: 'Agent SDK', pinned: '0.3.201', latest: '0.3.220', behind: sdkBehind, changelog: '#### 0.3.220\n\n- parity', latestPublishedAt: '2026-07-24T23:11:19.727Z' },
  ],
});

test('落后时报告开头一句话说清落后多少', () => {
  const { summary, body } = buildReport(report(), { now: new Date('2026-09-07T00:00:00Z') });

  assert.equal(summary, '依赖落后上游：Agent SDK 落后 19 版');
  assert.match(body, /^## 依赖落后上游：Agent SDK 落后 19 版/, '摘要要当 markdown 标题打头，job summary 才有层级');
});

test('追平时不说成落后，也不附判据与 changelog', () => {
  const { summary, body } = buildReport(report({ sdkBehind: 0 }));

  assert.equal(summary, '依赖已追平上游');
  assert.doesNotMatch(body, /怎么读这份报告/, '没有要核对的东西就不该占篇幅');
  assert.doesNotMatch(body, /改了什么/);
});

test('表格列出被监控依赖的钉死值与上游 latest', () => {
  const { body } = buildReport(report());

  assert.match(body, /Agent SDK \| `0\.3\.201`/);
  assert.match(body, /\*\*19 版\*\*/);
});

test('落后时必须带上 A/B 判据段落', () => {
  const { body } = buildReport(report());

  // 这份报告存在的意义就是「带判据的摘录」。少了判据，读者看到落后 N 版的第一反应
  // 就是升级，而那个反应已经被一次 67 条的逐条核对否定过了。
  assert.ok(body.includes(TRIAGE_NOTE), '判据段落必须整段进报告');
  assert.match(body, /版本差数不是风险指标/);
  assert.match(body, /getProcessExitError/, 'A 类四块要点名，否则"分两类"是句空话');
  assert.match(body, /listSessions/);
});

test('报告不再提 issue / 邮件这套已经拆掉的机制', () => {
  const { body } = buildReport(report());

  assert.match(body, /不落文件、不开 issue、不发通知/, '读者要一眼知道这东西不会再自己冒出来');
});

test('只为落后的依赖附 changelog 段落', () => {
  assert.match(buildReport(report()).body, /### Agent SDK：`0\.3\.201` → `0\.3\.220` 改了什么/);
  assert.doesNotMatch(buildReport(report({ sdkBehind: 0 })).body, /改了什么/, '没落后就没有变更区间可列');
});

// ──────────────────────── readPinned ────────────────────────

test('readPinned 从 package.json 的 dependencies 取基准值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { [WATCHED.sdk.pkg]: '0.3.201' },
    verifiedWith: { claudeCli: '2.1.220' },
  }));

  // verifiedWith.claudeCli 是发版时写入的实测背书快照，不是本仓库钉住的依赖，
  // 拿它比上游 latest 落后是结构性必然 —— 故意不读。
  assert.deepEqual(readPinned(dir), { sdk: '0.3.201' });
});

test('readPinned 在字段缺失时给 null 而不是崩', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));

  assert.deepEqual(readPinned(dir), { sdk: null });
});

// ──────────────────────── collect / main（假网络）────────────────────────

function fakeNet({ sdkLatest = '0.3.220', sdkVersions, changelogFails = false } = {}) {
  return async url => {
    if (String(url).includes('CHANGELOG.md')) {
      if (changelogFails) return { ok: false, status: 500, text: async () => '' };
      return { ok: true, text: async () => SAMPLE };
    }
    return {
      ok: true,
      json: async () => ({
        'dist-tags': { latest: sdkLatest },
        versions: Object.fromEntries((sdkVersions ?? [sdkLatest]).map(v => [v, {}])),
        time: { [sdkLatest]: '2026-07-24T23:11:19.727Z' },
      }),
    };
  };
}

function fixtureRoot(pinnedSdk = '0.3.201') {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { [WATCHED.sdk.pkg]: pinnedSdk },
    verifiedWith: { claudeCli: '2.1.220' },
  }));
  return dir;
}

test('collect 算出落后数并抓 changelog', async () => {
  const out = await collect({
    fetchImpl: fakeNet({ sdkVersions: ['0.3.201', '0.3.218', '0.3.219', '0.3.220'] }),
    rootDir: fixtureRoot(),
  });

  assert.equal(out.items.length, 1, '只监控 SDK 一条轴');
  assert.equal(out.items[0].behind, 3);
  assert.ok(out.items[0].changelog.length > 0);
  assert.equal(out.behind, true);
});

test('追平时不去抓 changelog', async () => {
  const out = await collect({ fetchImpl: fakeNet({ sdkVersions: ['0.3.220'] }), rootDir: fixtureRoot('0.3.220') });

  assert.equal(out.items[0].behind, 0);
  assert.equal(out.items[0].changelog, '');
  assert.equal(out.behind, false);
});

test('CHANGELOG 抓取失败不影响「落后」这个结论本身', async () => {
  const out = await collect({
    fetchImpl: fakeNet({ sdkVersions: ['0.3.201', '0.3.220'], changelogFails: true }),
    rootDir: fixtureRoot(),
  });

  assert.equal(out.items[0].behind, 1, '抓不到 changelog 也要照报落后');
  assert.match(out.items[0].changelog, /抓取失败/);
});

// main 的输出分流：workflow 靠 `node scripts/upstream-watch.js >> "$GITHUB_STEP_SUMMARY"`
// 把报告送进 job summary。进度行若漏进 stdout，那一页就会被 "⚠️ Agent SDK: ..." 污染。
function runMain(rootDir, fetchImpl) {
  const stderr = [];
  const stdout = [];
  return main({ fetchImpl, rootDir, log: l => stderr.push(l), out: o => stdout.push(o) })
    .then(res => ({ res, stderr: stderr.join('\n'), stdout: stdout.join('\n') }));
}

test('报告走 stdout、进度走 stderr，两边不串', async () => {
  const { stdout, stderr } = await runMain(fixtureRoot(), fakeNet({ sdkVersions: ['0.3.201', '0.3.219', '0.3.220'] }));

  assert.match(stdout, /^## 依赖落后上游/, 'stdout 第一行就得是 markdown，重定向进 job summary 才干净');
  assert.doesNotMatch(stdout, /⚠️ {2}Agent SDK/, '进度行不能混进报告');
  assert.match(stderr, /⚠️ {2}Agent SDK: 钉 0\.3\.201/, '进度仍要看得见，否则本地跑没有反馈');
  assert.doesNotMatch(stderr, /## 依赖落后上游/);
});

test('追平时同样出报告，不是静默退出', async () => {
  const { stdout, res } = await runMain(fixtureRoot('0.3.220'), fakeNet({ sdkVersions: ['0.3.220'] }));

  assert.equal(res.behind, false);
  assert.match(stdout, /## 依赖已追平上游/, '手动跑一次总该看到结论，"没输出"和"脚本挂了"分不开');
});

test('main 不在仓库里落任何文件', async () => {
  const rootDir = fixtureRoot();
  const before = readdirSync(rootDir);

  await runMain(rootDir, fakeNet({ sdkVersions: ['0.3.201', '0.3.220'] }));

  assert.deepEqual(readdirSync(rootDir), before, '报告是拿来看的，不该留中间产物给门禁扫到');
});
