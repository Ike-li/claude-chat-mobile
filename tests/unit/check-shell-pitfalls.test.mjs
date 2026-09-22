// tests/unit/check-shell-pitfalls.test.mjs —— shell 陷阱门禁自身
// 覆盖两块：extractWorkflowRunBlocks 纯函数（YAML run: 块提取，不需要 git）；
// checkShellPitfalls 集成（需要真实 git 仓库夹具，git ls-files 是判据的一部分）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkShellPitfalls, extractWorkflowRunBlocks } from '../gates/check-shell-pitfalls.js';

test.describe('extractWorkflowRunBlocks：GHA workflow YAML 的 run: 块提取', () => {
  test('单行形式：run: <cmd>', () => {
    const blocks = extractWorkflowRunBlocks([
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: npm ci',
      '      - run: npm run check',
    ].join('\n'));
    assert.deepEqual(blocks.map(b => b.text), ['npm ci', 'npm run check']);
    assert.equal(blocks[0].startLine, 4);
    assert.equal(blocks[1].startLine, 5);
  });

  test('块标量形式：run: |，多行内容，缩进正确剥离', () => {
    const blocks = extractWorkflowRunBlocks([
      'jobs:',
      '  build:',
      '    steps:',
      '      - name: x',
      '        run: |',
      '          echo one',
      '          echo two',
      '      - run: npm ci',
    ].join('\n'));
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].text, 'echo one\necho two');
    assert.equal(blocks[0].startLine, 6); // 内容首行，不是 "run: |" 那一行（第5行）
    assert.equal(blocks[1].text, 'npm ci');
  });

  test('块标量的 chomping 修饰符（|-、|+）与折叠形态（>）都能识别为块标量起点', () => {
    for (const marker of ['|', '|-', '|+', '>', '>-']) {
      const blocks = extractWorkflowRunBlocks([
        '      - run: ' + marker,
        '          echo x',
      ].join('\n'));
      assert.equal(blocks.length, 1, `marker=${marker} 应被识别为块标量`);
      assert.equal(blocks[0].text, 'echo x', `marker=${marker}`);
    }
  });

  test('块标量内容里缩进更深的行保留相对缩进（如 if/then 块）', () => {
    const blocks = extractWorkflowRunBlocks([
      '        run: |',
      '          if [ -z "$X" ]; then',
      '            echo empty',
      '          fi',
    ].join('\n'));
    assert.equal(blocks[0].text, 'if [ -z "$X" ]; then\n  echo empty\nfi');
  });

  test('块标量内容里的空行原样保留（不提前截断块）', () => {
    const blocks = extractWorkflowRunBlocks([
      '        run: |',
      '          echo one',
      '',
      '          echo two',
    ].join('\n'));
    assert.equal(blocks[0].text, 'echo one\n\necho two');
  });

  test('空 run: 值（既不是单行命令也不是块标量）→ 不产出条目', () => {
    const blocks = extractWorkflowRunBlocks('      - run:\n      - uses: actions/checkout@v4\n');
    assert.deepEqual(blocks, []);
  });

  test('没有任何 run: 键 → 空数组', () => {
    assert.deepEqual(extractWorkflowRunBlocks('jobs:\n  build:\n    steps:\n      - uses: x\n'), []);
  });
});

// checkShellPitfalls 需要真实 git 仓库（判据依赖 git ls-files）——每条用例各建一次性目录，
// git init + add，跑完即删。
function gitFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'ccm-shell-pitfalls-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'x@x.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'x'], { cwd: root });
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}

test.describe('checkShellPitfalls：workflow run: 块与 .sh 文件走同一套判据', () => {
  test('workflow 的 run: 块里 pipefail 下的 grep -q → 被抓住（GHA 默认 shell 隐式 pipefail，不需要文本里出现 set -o pipefail）', () => {
    const root = gitFixture({
      '.github/workflows/test.yml': [
        'jobs:',
        '  build:',
        '    steps:',
        '      - run: |',
        '          if echo "$X" | grep -q foo; then echo yes; fi',
      ].join('\n'),
    });
    try {
      const r = checkShellPitfalls({ rootDir: root });
      assert.equal(r.problems.length, 1, JSON.stringify(r.problems));
      assert.match(r.problems[0], /grep -q/);
      assert.match(r.problems[0], /\.github\/workflows\/test\.yml:5/);
    } finally { rmSync(root, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
  });

  test('workflow 的 run: 块里 $VAR 紧跟非 ASCII → 被抓住', () => {
    const root = gitFixture({
      '.github/workflows/test.yml': [
        'jobs:',
        '  build:',
        '    steps:',
        '      - run: echo "PR #$PR（更新）"',
      ].join('\n'),
    });
    try {
      const r = checkShellPitfalls({ rootDir: root });
      assert.equal(r.problems.length, 1, JSON.stringify(r.problems));
      assert.match(r.problems[0], /紧跟非 ASCII/);
    } finally { rmSync(root, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
  });

  test('workflow 的 run: 块里 grep -q 但没有 pipefail 相关陷阱以外的合法写法 → 干净通过', () => {
    const root = gitFixture({
      '.github/workflows/test.yml': [
        'jobs:',
        '  build:',
        '    steps:',
        '      - run: npm ci',
        '      - run: npm run check',
      ].join('\n'),
    });
    try {
      const r = checkShellPitfalls({ rootDir: root });
      assert.deepEqual(r.problems, []);
      assert.equal(r.workflowRunSteps, 2);
    } finally { rmSync(root, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
  });

  test('.sh 文件的既有判据不受 workflow 扫描新增影响：没有 set -o pipefail 时 grep -q 不报', () => {
    const root = gitFixture({
      'scripts/x.sh': '#!/bin/bash\nif echo "$X" | grep -q foo; then echo yes; fi\n',
    });
    try {
      const r = checkShellPitfalls({ rootDir: root });
      assert.deepEqual(r.problems, []);
      assert.equal(r.shFiles.length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
  });

  test('没有任何 .github/workflows/*.yml → workflowFiles 空数组，不报错（不是扫描面必须非空的那一类）', () => {
    const root = gitFixture({ 'scripts/x.sh': '#!/bin/bash\necho ok\n' });
    try {
      const r = checkShellPitfalls({ rootDir: root });
      assert.deepEqual(r.workflowFiles, []);
      assert.deepEqual(r.problems, []);
    } finally { rmSync(root, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
  });

  test('真实仓库当前干净（这条红了说明 workflow 或 .sh 里新增了陷阱写法）', () => {
    const r = checkShellPitfalls();
    assert.deepEqual(r.problems, [], r.problems.join('\n'));
    assert.ok(r.workflowFiles.length >= 1, 'workflow 扫描面不该是空的');
    assert.ok(r.workflowRunSteps >= 10, `run 步骤数异常偏少（${r.workflowRunSteps}）`);
  });
});
