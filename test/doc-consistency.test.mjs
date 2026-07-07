import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkDocConsistency,
  extractDocumentedNpmScripts,
} from '../scripts/doc-consistency.js';

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

test('current docs stay consistent with package scripts and dependency versions', () => {
  const result = checkDocConsistency();
  assert.deepEqual(result.problems, []);
});
