// tests/unit/dist-package-rewrite.test.mjs —— 分发包 package.json 的改写规则。
//
// export-ignore 是文件级的，裁不掉 package.json 内部的字段，而它天生是混合体：
// start/setup/doctor 和 test/check/mutate 挤在同一个 scripts 对象里。裁剪后包内近一半命令
// 指向已不存在的文件，用户敲下去只拿到 ENOENT——所以打包时要按【可达性】重写这一个文件。
//
// 判据不是维护第二份白名单（必然与 .gitattributes 分叉），而是问同一个问题：
// 这条命令引用的文件还在包里吗？用的二进制还装得上吗？转发的目标还活着吗？
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { rewritePackageJson } from '../../scripts/dist-manifest.js';
import { shippedFiles } from '../helpers/worktree-tree.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

const SHIPPED = new Set([
  'server.js', 'package.json',
  'scripts/setup.js', 'scripts/doctor.js', 'scripts/service.js', 'scripts/app-build.js',
]);

function rewrite(pkg) {
  return rewritePackageJson(pkg, { shipped: SHIPPED });
}

test('保留引用文件仍在包内的命令', () => {
  const out = rewrite({
    scripts: {
      start: 'node server.js',
      dev: 'node --watch server.js',
      setup: 'node scripts/setup.js',
      'service:status': 'node scripts/service.js status',
    },
  });
  assert.deepEqual(Object.keys(out.scripts).sort(), ['dev', 'service:status', 'setup', 'start']);
});

test('删除引用了被裁文件的命令', () => {
  const out = rewrite({
    scripts: {
      start: 'node server.js',
      'test:unit': 'node --test tests/unit/*.test.mjs',
      mutate: 'node tests/gates/mutate.js',
      'test:docker': 'docker compose -f docker-compose.test.yml run --rm test npm test',
    },
  });
  assert.deepEqual(Object.keys(out.scripts), ['start']);
});

test('删除依赖 devDependency 二进制的命令（eslint / playwright）', () => {
  const out = rewrite({
    scripts: {
      start: 'node server.js',
      lint: 'eslint .',
      'lint:fix': 'eslint . --fix',
      'test:e2e': 'playwright test',
    },
  });
  assert.deepEqual(Object.keys(out.scripts), ['start']);
});

// test:visual → test:e2e → playwright。只删第一层会留下一条「看起来能跑、一敲就 ENOENT」的转发。
test('递归删除转发到已删命令的别名', () => {
  const out = rewrite({
    scripts: {
      start: 'node server.js',
      'test:e2e': 'playwright test',
      'test:visual': 'npm run test:e2e',
      'test:all': 'npm run test:visual && npm run start',
    },
  });
  assert.deepEqual(Object.keys(out.scripts), ['start'], '转发链必须整条删掉，不能只删第一层');
});

test('保留转发到仍存活命令的别名', () => {
  const out = rewrite({
    scripts: { start: 'node server.js', serve: 'npm run start' },
  });
  assert.deepEqual(Object.keys(out.scripts).sort(), ['serve', 'start']);
});

test('删掉 devDependencies，dependencies 与其余字段原样保留', () => {
  const out = rewrite({
    name: 'claude-chat-mobile',
    version: '1.6.2',
    private: true,
    type: 'module',
    engines: { node: '>=20' },
    scripts: { start: 'node server.js' },
    dependencies: { express: '^5.0.0' },
    devDependencies: { eslint: '^9.0.0' },
  });
  assert.equal(Object.hasOwn(out, 'devDependencies'), false);
  assert.deepEqual(out.dependencies, { express: '^5.0.0' });
  assert.equal(out.name, 'claude-chat-mobile');
  assert.equal(out.version, '1.6.2');
  assert.equal(out.type, 'module');
  assert.deepEqual(out.engines, { node: '>=20' });
});

// 端到端：拿真实 package.json + 真实裁剪结果跑一遍，断言留下的命令条条能跑。
// 上面的用例喂的是手写夹具，夹具编错契约时会恒绿（这个仓库踩过这个坑）；这条用真数据兜底。
test('端到端：真实 package.json 改写后，保留的命令引用的文件都在包里', () => {
  // 基于工作区 tree（不是 HEAD）：未提交的改动必须计入，否则测的是上一次提交的结构。
  const shipped = shippedFiles(ROOT);

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const out = rewritePackageJson(pkg, { shipped });

  assert.equal(Object.hasOwn(out, 'devDependencies'), false);
  assert.deepEqual(out.dependencies, pkg.dependencies, 'dependencies 不得被改动');

  // 装机路径上的命令必须活着。
  for (const must of ['start', 'dev', 'setup', 'uninstall', 'config', 'service:install', 'hooks:install', 'app:install']) {
    assert.ok(Object.hasOwn(out.scripts, must), `生产命令 ${must} 被误删`);
  }
  // 测试/门禁命令必须没了。
  for (const gone of ['test', 'test:unit', 'test:e2e', 'test:visual', 'check', 'lint', 'mutate', 'inventory:check', 'test:docker']) {
    assert.equal(Object.hasOwn(out.scripts, gone), false, `不可用命令 ${gone} 残留在分发包里`);
  }

  // 核心不变量：留下的每条命令，引用的仓库文件都必须在包内。
  const dangling = [];
  for (const [name, cmd] of Object.entries(out.scripts)) {
    const refs = [...cmd.matchAll(/(?:^|\s)((?:scripts|tests|src|public|desktop|playground)\/[\w./-]+)/g)].map(m => m[1]);
    for (const ref of refs) if (!shipped.has(ref)) dangling.push(`${name} → ${ref}`);
  }
  assert.deepEqual(dangling, [], '保留的命令引用了被裁掉的文件');
});

test('不改动入参（打包脚本会先读原文件再写新文件）', () => {
  const input = {
    scripts: { start: 'node server.js', lint: 'eslint .' },
    devDependencies: { eslint: '^9.0.0' },
  };
  rewrite(input);
  assert.deepEqual(Object.keys(input.scripts).sort(), ['lint', 'start']);
  assert.equal(Object.hasOwn(input, 'devDependencies'), true);
});
