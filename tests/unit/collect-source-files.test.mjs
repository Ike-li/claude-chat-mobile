// tests/unit/collect-source-files.test.mjs —— 语法检查的文件遍历器
// 覆盖：递归发现项目 JS、跳过 node_modules（扫进依赖会让语法门禁在别人的代码上报错）。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectSyntaxFiles } from '../../scripts/collect-source-files.js';

test('source file walker discovers nested project JavaScript without scanning dependencies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-syntax-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, 'app', 'src', 'server'), { recursive: true });
  await mkdir(join(root, 'app', 'public', 'js', 'app'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true });
  await writeFile(join(root, 'app/server.js'), 'export {};\n');
  await writeFile(join(root, 'app', 'src', 'server', 'app.js'), 'export {};\n');
  await writeFile(join(root, 'app', 'public', 'js', 'app', 'context.js'), 'export {};\n');
  await writeFile(join(root, 'node_modules', 'ignored', 'broken.js'), 'not valid {\n');

  assert.deepEqual(collectSyntaxFiles(root), [
    'app/public/js/app/context.js',
    'app/server.js',
    'app/src/server/app.js',
  ]);
});
