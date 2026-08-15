import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkDocConsistency,
  extractDocumentedNpmScripts,
} from '../../scripts/doc-consistency.js';

async function writeFixture(root, relativePath, text) {
  const file = join(root, relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

test('extractDocumentedNpmScripts finds only package-backed npm commands', () => {
  const commands = extractDocumentedNpmScripts(`
    npm start
    npm test
    npm run check
    npm run test:playwright:p0 -- --project=chromium
    npm install --omit=dev
    npm ci
  `);

  assert.deepEqual(commands, new Set(['start', 'test', 'check', 'test:playwright:p0']));
});

test('doc consistency reports unknown documented npm scripts and dependency version drift', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-doc-consistency-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'package.json', JSON.stringify({
    scripts: { start: 'node server.js', check: 'node --check server.js' },
    dependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.201' },
  }));
  await writeFixture(root, 'README.md', `
    Use \`npm run missing\` for the old path.
    Stack: \`@anthropic-ai/claude-agent-sdk\` 0.1.
  `);

  const result = checkDocConsistency({
    rootDir: root,
    docGlobs: ['README.md'],
  });

  assert.deepEqual(result.problems.map(problem => problem.code), [
    'unknown_npm_script',
    'dependency_version_drift',
  ]);
  assert.equal(result.problems[0].script, 'missing');
  assert.equal(result.problems[1].actual, '0.3.201');
});

// 此前 dependencyNames 只有 SDK 一条，express/socket.io/jose 在文档里写错 major 不会被拦。
// 这几个是 CLAUDE.md 技术栈行对外宣称的核心依赖，升 major 时最容易忘了改文档。
// 判据：文档写几段就比几段（写「Express 5」只比 major），package.json 侧先剥掉 ^/~ 等 range 前缀。
test('doc consistency 拦住核心依赖的 major 版本漂移（不只 SDK）', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-doc-dep-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'package.json', JSON.stringify({
    scripts: {},
    dependencies: { express: '^5.0.0', 'socket.io': '^4.8.0', jose: '^6.2.3' },
  }));
  // Express 的 major 写错（实际 5），Socket.io 与 jose 写对 —— 只该报前者
  await writeFixture(root, 'README.md', 'Stack: Express 4 · Socket.io 4 · `jose` 6');

  const result = checkDocConsistency({ rootDir: root, docGlobs: ['README.md'] });

  assert.deepEqual(result.problems.map(problem => problem.code), ['dependency_version_drift']);
  assert.equal(result.problems[0].dependency, 'express');
  assert.equal(result.problems[0].documented, '4');
  assert.equal(result.problems[0].actual, '^5.0.0');
});

// 契约计数（agent:event type 数 / 入向 socket 事件数）此前只活在散文里，靠一句「散文数字若漂移
// 以代码为准」的免责声明兜底——而免责声明等于承认这条信息不可信。实测 2026-08-15：hard-rules
// 写「入向当前 40 个」，protocol.js 实际 42 个，doc-consistency 全绿却发现不了。
// 判据用【行内锚点】：同一行必须出现 AGENT_EVENT_TYPES / INBOUND_SOCKET_EVENTS 才校验，
// 否则文档里任何「N 个」都会被误判（CLAUDE.md 有「7 个文件」「70 个项目」等无关计数）。
test('doc consistency 拦住契约计数漂移（出向 type 数 / 入向事件数）', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-doc-contract-count-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'package.json', JSON.stringify({ scripts: {}, dependencies: {} }));
  await writeFixture(root, 'README.md', [
    '| type 白名单 | `AGENT_EVENT_TYPES` 为唯一真相源（当前 99 种）|',
    '| 入向 | 同文件 `INBOUND_SOCKET_EVENTS`（当前 42 个）|',
  ].join('\n'));

  const result = checkDocConsistency({
    rootDir: root,
    docGlobs: ['README.md'],
    contractCounts: { outbound: 26, inbound: 42 },
  });

  // 出向写错该报，入向写对不该报
  assert.deepEqual(result.problems.map(problem => problem.code), ['contract_count_drift']);
  assert.equal(result.problems[0].documented, 99);
  assert.equal(result.problems[0].actual, 26);
});

test('doc consistency 不误判无锚点行里的计数', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-doc-contract-noanchor-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'package.json', JSON.stringify({ scripts: {}, dependencies: {} }));
  // 都是无关计数，同行没有契约符号 → 一条都不该报
  await writeFixture(root, 'README.md', [
    '需真 agent turn 的共 7 个文件，默认跳过。',
    '那次删掉了当前 70 个项目 / 291 memory。',
    '出向信封当前 26 种是另一回事，但本行没写符号名。',
  ].join('\n'));

  const result = checkDocConsistency({
    rootDir: root,
    docGlobs: ['README.md'],
    contractCounts: { outbound: 26, inbound: 42 },
  });

  assert.deepEqual(result.problems, []);
});

// 中英文档是孪生体（architecture.md ↔ architecture.en.md），只守中文会造成【守卫不对称】：
// 改 AGENT_EVENT_TYPES 时中文红、英文静默失真而 npm run check 全绿。2026-08-15 独立审查发现
// docs/architecture.en.md 的「All 26 types」正是这种漏网——它在扫描面内，但判据是纯中文量词。
test('doc consistency 同样拦住英文文档里的契约计数漂移', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-doc-contract-en-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'package.json', JSON.stringify({ scripts: {}, dependencies: {} }));
  await writeFixture(root, 'README.md', [
    'The `AGENT_EVENT_TYPES` whitelist: all 99 types are covered today.',
    'Inbound `INBOUND_SOCKET_EVENTS` currently has 42 events.',
  ].join('\n'));

  const result = checkDocConsistency({
    rootDir: root,
    docGlobs: ['README.md'],
    contractCounts: { outbound: 26, inbound: 42 },
  });

  assert.deepEqual(result.problems.map(problem => problem.code), ['contract_count_drift']);
  assert.equal(result.problems[0].documented, 99);
  assert.equal(result.problems[0].actual, 26);
});

test('current docs stay consistent with package scripts and dependency versions', () => {
  const result = checkDocConsistency();
  assert.deepEqual(result.problems, []);
});
