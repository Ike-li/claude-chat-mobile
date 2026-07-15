import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildImportGraph,
  findCycles,
  findBoundaryViolations,
  analyze,
  BOUNDARY_RULES,
} from '../../scripts/check-import-boundaries.js';

async function scaffold(files) {
  const root = await mkdtemp(join(tmpdir(), 'ccm-boundaries-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body);
  }
  return root;
}

test('真实仓库：无循环依赖、无边界违规（保护当前干净分层）', () => {
  const result = analyze(process.cwd());
  assert.deepEqual(result.cycles, [], `发现循环依赖：\n${result.cycles.map(c => c.join(' → ')).join('\n')}`);
  assert.deepEqual(
    result.violations,
    [],
    `发现边界违规：\n${result.violations.map(v => `[${v.rule}] ${v.from} → ${v.to}`).join('\n')}`,
  );
});

test('前端 import 后端 → 被判违规', async t => {
  const root = await scaffold({
    'public/js/app.js': "import { x } from '../../src/agent/agent.js';\n",
    'src/agent/agent.js': 'export const x = 1;\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const graph = buildImportGraph(root);
  const violations = findBoundaryViolations(graph, BOUNDARY_RULES);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'frontend-no-backend');
  assert.equal(violations[0].from, 'public/js/app.js');
  assert.equal(violations[0].to, 'src/agent/agent.js');
});

test('src/shared 反向 import 上层域 → 被判违规（叶子层规则）', async t => {
  const root = await scaffold({
    'src/shared/sanitizer.js': "import { y } from '../agent/agent.js';\nexport const s = y;\n",
    'src/agent/agent.js': 'export const y = 2;\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const violations = findBoundaryViolations(buildImportGraph(root), BOUNDARY_RULES);
  assert.ok(violations.some(v => v.rule === 'shared-is-leaf' && v.from === 'src/shared/sanitizer.js'));
});

test('白名单内的前后端共享纯逻辑不报（canonicalize / logic）', async t => {
  const root = await scaffold({
    'src/auth/fingerprint.js': "import { c } from '../../public/js/canonicalize.js';\nexport const f = c;\n",
    'public/js/canonicalize.js': 'export const c = 3;\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const violations = findBoundaryViolations(buildImportGraph(root), BOUNDARY_RULES);
  assert.deepEqual(violations, []);
});

test('findCycles 抓到 a → b → a 静态循环', async t => {
  const root = await scaffold({
    'src/agent/a.js': "import './b.js';\nexport const a = 1;\n",
    'src/agent/b.js': "import './a.js';\nexport const b = 1;\n",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const cycles = findCycles(buildImportGraph(root));
  assert.ok(cycles.length >= 1);
  assert.ok(cycles[0].length >= 2);
});

test('组装根 src/server 被业务域反向 import → 被判违规', async t => {
  const root = await scaffold({
    'src/agent/agent.js': "import { io } from '../server/socket.js';\nexport const a = io;\n",
    'src/server/socket.js': 'export const io = 1;\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const violations = findBoundaryViolations(buildImportGraph(root), BOUNDARY_RULES);
  assert.ok(violations.some(v => v.rule === 'server-is-sink' && v.from === 'src/agent/agent.js'));
});

test('运行时源码 import scripts/ 工具 → 被判违规', async t => {
  const root = await scaffold({
    'src/ops/metrics.js': "import { d } from '../../scripts/doctor-checks.js';\nexport const m = d;\n",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const violations = findBoundaryViolations(buildImportGraph(root), BOUNDARY_RULES);
  assert.ok(violations.some(v => v.rule === 'runtime-no-tooling' && v.from === 'src/ops/metrics.js'));
});

test('只跟踪项目内相对 import，忽略裸模块说明符', async t => {
  const root = await scaffold({
    'src/agent/agent.js': "import express from 'express';\nimport { s } from '../shared/util.js';\nexport const a = s;\n",
    'src/shared/util.js': 'export const s = 1;\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const graph = buildImportGraph(root);
  assert.deepEqual(graph.get('src/agent/agent.js'), ['src/shared/util.js']);
});
