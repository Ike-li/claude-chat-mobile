// tests/unit/repository-inventory.test.mjs —— 未分类文件闸自身
// 覆盖：真实仓库每个文件都命中一条规则 · docs/ 不通配放行（新 .md 必须显式登记）
//       · 拒绝历史遗留根目录与散落的测试文件
//       · 【扫描面为空时报错】——git ls-files 返回空必须是红，不能当成「没有未分类文件」
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyRepositoryPath, checkRepositoryInventory } from '../../tests/gates/repo-inventory.js';

// 两个判据要分开，否则会【过度 skip】：
//
// · repoIsGitWorktree —— 本仓库当前是否有 git 视图。隔离测试容器里 .git 是 worktree 指针文件、
//   指向宿主机路径（gitdir: /Users/.../.git/worktrees/xxx），容器里解析不到 → git 报
//   "not a git repository"。那不是仓库清单出了问题，是环境没有 git 视图；判成 fail 会让容器里的
//   整轮测试红在一个与被测行为无关的事上。从 tarball 解压跑测试同理。
// · gitBinary —— 只问 git 命令在不在。自己 mkdtemp + git init 的用例只需要这一条，
//   拿上面那条门控它就会在容器里被无谓跳过，而那恰恰是容器该覆盖的一条。
const repoIsGitWorktree = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
  cwd: process.cwd(), encoding: 'utf8',
}).status === 0;
const gitBinary = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

test('final inventory rejects legacy roots and loose test files', () => {
  assert.equal(classifyRepositoryPath('agent.js'), null);
  assert.equal(classifyRepositoryPath('.agents/plan.md'), null);
  assert.equal(classifyRepositoryPath('specs/plan.md'), null);
  assert.equal(classifyRepositoryPath('tests/loose.test.mjs'), null);
});

test('docs/ 不再通配放行：新 .md 须显式登记，未登记的历史文档同样被拒', () => {
  // 一次性产物（审计报告/进度笔记/提案）落进 docs/ 应被拒绝——这是本闸存在的理由
  assert.equal(classifyRepositoryPath('docs/one-off-audit-2026-08-01.md'), null);
  assert.equal(classifyRepositoryPath('docs/new-proposal.md'), null);
  // 已随宣传层下线的文档不再登记，回流应被拒
  assert.equal(classifyRepositoryPath('docs/design.md'), null);
  assert.equal(classifyRepositoryPath('docs/index.html'), null);
  assert.equal(classifyRepositoryPath('docs/screenshots/01-stream.png'), null);
  // 现存长期文档仍正常分类
  assert.equal(classifyRepositoryPath('docs/deployment.md')?.category, 'Documentation');
});

// 扫描面塌了必须红。空清单在结构上与「全部合规」无法区分，而本闸的失效恰恰是静默的：
// 没有任何别的东西会因为它扫了 0 个文件而报警。
// 用真实的空 git 仓库测——git 视图正常、只是一个文件都没有，这才是「扫描面塌陷」的真形态
// （拿不存在的目录测的是 spawn 失败，那条路径由 main() 的 try/catch 兜住，是另一回事）。
test('扫描面为空时报错，不当成「没有未分类文件」', { skip: gitBinary ? false : '需要 git 命令' }, () => {
  const empty = mkdtempSync(join(tmpdir(), 'ccm-inventory-empty-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: empty });
    const result = checkRepositoryInventory({ rootDir: empty });
    assert.equal(result.ok, false);
    assert.match(result.reason, /扫描面/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('repository inventory classifies every tracked or unignored project file', {
  skip: repoIsGitWorktree ? false : '本用例需要可用的 git 工作树（容器/tarball 环境下 git 视图不可用）',
}, () => {
  const result = spawnSync(
    process.execPath,
    ['tests/gates/repo-inventory.js'],
    { cwd: process.cwd(), encoding: 'utf8' },
  );

  assert.equal(
    result.status,
    0,
    `inventory check failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /repository inventory OK/);
});
