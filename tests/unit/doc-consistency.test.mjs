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

test('current docs stay consistent with package scripts and dependency versions', () => {
  const result = checkDocConsistency();
  assert.deepEqual(result.problems, []);
});
