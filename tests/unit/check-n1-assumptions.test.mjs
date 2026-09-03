import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkN1Assumptions } from '../../tests/gates/check-n1-assumptions.js';

async function writeFixture(root, relativePath, text) {
  const file = join(root, relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

// 夹具：一份最小的 hard-rules（只有登记表格）+ 一份带标记的源码树。
async function buildFixture(root, { registered, marked }) {
  const rows = registered.map(id => `| \`${id}\` | 某个全局单值 | 某处 |`).join('\n');
  await writeFixture(root, 'docs/hard-rules.md', [
    '## 2. n=1 取舍', '', '| ID | 含义 | 代码 |', '|----|------|------|', rows, '',
  ].join('\n'));
  const body = marked.map((id, i) => `// n1: ${id} 说明文字\nlet state${i} = null;`).join('\n');
  await writeFixture(root, 'app/src/server/app.js', body || '// 无标记\n');
}

test('n=1 门禁：文档登记了但代码里没有对应标记 → 报缺失', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-n1-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await buildFixture(root, {
    registered: ['N1-VIEWING-INSTANCE', 'N1-MIRROR-LOCK'],
    marked: ['N1-VIEWING-INSTANCE'],
  });

  const result = checkN1Assumptions({ rootDir: root });

  assert.deepEqual(result.problems.map(p => p.code), ['n1_marker_missing']);
  assert.equal(result.problems[0].id, 'N1-MIRROR-LOCK');
});

test('n=1 门禁：代码里有标记但文档没登记 → 报未登记', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-n1-unregistered-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await buildFixture(root, {
    registered: ['N1-VIEWING-INSTANCE'],
    marked: ['N1-VIEWING-INSTANCE', 'N1-METRICS'],
  });

  const result = checkN1Assumptions({ rootDir: root });

  assert.deepEqual(result.problems.map(p => p.code), ['n1_marker_unregistered']);
  assert.equal(result.problems[0].id, 'N1-METRICS');
  assert.match(result.problems[0].file, /src[/\\]server[/\\]app\.js/);
});

test('n=1 门禁：双向一致 → 零 problem，且报告两侧集合', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-n1-aligned-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const ids = ['N1-VIEWING-INSTANCE', 'N1-MIRROR-LOCK', 'N1-METRICS'];
  await buildFixture(root, { registered: ids, marked: ids });

  const result = checkN1Assumptions({ rootDir: root });

  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.registered, ids.slice().sort());
  assert.deepEqual(result.marked, ids.slice().sort());
});

// 叙述性引用（表格外正文里提到某个 ID）不算登记——否则「文档里随口提一句」就能让
// 一个不存在的标记通过门禁，登记簿失去意义。登记只认表格行。
test('n=1 门禁：只有表格行算登记，正文里的叙述性引用不算', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-n1-prose-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'docs/hard-rules.md', [
    '## 2. n=1 取舍', '',
    '正文里提到 `N1-GHOST` 只是叙述，不构成登记。', '',
    '| ID | 含义 | 代码 |', '|----|------|------|',
    '| `N1-REAL` | 真登记 | 某处 |', '',
  ].join('\n'));
  await writeFixture(root, 'app/src/server/app.js', '// n1: N1-REAL 说明\nlet x = null;\n');

  const result = checkN1Assumptions({ rootDir: root });

  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.registered, ['N1-REAL']);
});

// 格式不合的标记必须【显式报错】而不是静默当成「这里没有标记」——后者会让门禁在它最想守住的
// 那条边上漏掉：有人写 `// n1: N1-NEWTHING` 忘了写理由且没登记，双向校验全绿。
// 2026-08-15 独立审查实测复现。理由是强制的：只写 ID 对「改立场那天的人」没有任何价值。
test('n=1 门禁：// n1: 开头但格式不合 → 显式报错，不静默忽略', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-n1-malformed-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'docs/hard-rules.md', [
    '## 2. n=1 取舍', '', '| ID | 含义 |', '|----|------|', '| `N1-OK` | 已登记 |', '',
  ].join('\n'));
  await writeFixture(root, 'app/src/server/app.js', [
    '// n1: N1-OK 有理由，合格',
    'let ok = null;',
    '// n1: N1-NO-REASON',            // 缺理由
    'let a = null;',
    '// n1: n1-lowercase 理由有但 ID 不合规',
    'let b = null;',
  ].join('\n'));

  const result = checkN1Assumptions({ rootDir: root });

  assert.deepEqual(result.problems.map(p => p.code), ['n1_marker_malformed', 'n1_marker_malformed']);
  assert.deepEqual(result.marked, ['N1-OK']);   // 合格的那个仍正常登记
});

test('n=1 门禁：当前仓库的登记簿与代码标记一致', () => {
  const result = checkN1Assumptions();
  assert.deepEqual(result.problems, []);
  assert.ok(result.registered.length > 0, '登记簿不该为空——§2 表格里应有 N1-* ID');
});
