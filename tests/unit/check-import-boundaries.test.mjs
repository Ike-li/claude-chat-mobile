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
} from '../../tests/gates/check-import-boundaries.js';

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
    'app/public/js/app.js': "import { x } from '../../src/agent/agent.js';\n",
    'app/src/agent/agent.js': 'export const x = 1;\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const graph = buildImportGraph(root);
  const violations = findBoundaryViolations(graph, BOUNDARY_RULES);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'frontend-no-backend');
  assert.equal(violations[0].from, 'app/public/js/app.js');
  assert.equal(violations[0].to, 'app/src/agent/agent.js');
});

test('app/src/shared 反向 import 上层域 → 被判违规（叶子层规则）', async t => {
  const root = await scaffold({
    'app/src/shared/sanitizer.js': "import { y } from '../agent/agent.js';\nexport const s = y;\n",
    'app/src/agent/agent.js': 'export const y = 2;\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const violations = findBoundaryViolations(buildImportGraph(root), BOUNDARY_RULES);
  assert.ok(violations.some(v => v.rule === 'shared-is-leaf' && v.from === 'app/src/shared/sanitizer.js'));
});

test('白名单内的前后端共享纯逻辑不报（canonicalize / logic）', async t => {
  const root = await scaffold({
    'app/src/auth/fingerprint.js': "import { c } from '../../public/js/canonicalize.js';\nexport const f = c;\n",
    'app/public/js/canonicalize.js': 'export const c = 3;\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const violations = findBoundaryViolations(buildImportGraph(root), BOUNDARY_RULES);
  assert.deepEqual(violations, []);
});

test('findCycles 抓到 a → b → a 静态循环', async t => {
  const root = await scaffold({
    'app/src/agent/a.js': "import './b.js';\nexport const a = 1;\n",
    'app/src/agent/b.js': "import './a.js';\nexport const b = 1;\n",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const cycles = findCycles(buildImportGraph(root));
  assert.ok(cycles.length >= 1);
  assert.ok(cycles[0].length >= 2);
});

test('组装根 app/src/server 被业务域反向 import → 被判违规', async t => {
  const root = await scaffold({
    'app/src/agent/agent.js': "import { io } from '../server/socket.js';\nexport const a = io;\n",
    'app/src/server/socket.js': 'export const io = 1;\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const violations = findBoundaryViolations(buildImportGraph(root), BOUNDARY_RULES);
  assert.ok(violations.some(v => v.rule === 'server-is-sink' && v.from === 'app/src/agent/agent.js'));
});

test('运行时源码 import scripts/ 工具 → 被判违规', async t => {
  const root = await scaffold({
    'app/src/ops/metrics.js': "import { d } from '../../../scripts/doctor-checks.js';\nexport const m = d;\n",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const violations = findBoundaryViolations(buildImportGraph(root), BOUNDARY_RULES);
  assert.ok(violations.some(v => v.rule === 'runtime-no-tooling' && v.from === 'app/src/ops/metrics.js'));
});

test('只跟踪项目内相对 import，忽略裸模块说明符', async t => {
  const root = await scaffold({
    'app/src/agent/agent.js': "import express from 'express';\nimport { s } from '../shared/util.js';\nexport const a = s;\n",
    'app/src/shared/util.js': 'export const s = 1;\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const graph = buildImportGraph(root);
  assert.deepEqual(graph.get('app/src/agent/agent.js'), ['app/src/shared/util.js']);
});

test('行中动态 import() 也计入依赖图（防边界规则被 await import 绕过）', async t => {
  const root = await scaffold({
    'app/server.js': "const runtime = await import('./src/server/app.js');\nexport const x = runtime;\n",
    'app/src/server/app.js': 'export const y = 1;\n',
    'app/public/js/app.js': "async function lazy() { return (await import('../../src/agent/agent.js')).x; }\nexport { lazy };\n",
    'app/src/agent/agent.js': 'export const x = 2;\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const graph = buildImportGraph(root);
  assert.deepEqual(graph.get('app/server.js'), ['app/src/server/app.js']);
  // 前端动态 import 后端 → 依赖图可见 → 边界规则可判
  const violations = findBoundaryViolations(graph, BOUNDARY_RULES);
  assert.ok(violations.some(v => v.rule === 'frontend-no-backend' && v.from === 'app/public/js/app.js'));
});
