#!/usr/bin/env node
// tests/gates/repo-inventory.js —— 未分类文件闸
//
// 【它守什么】仓库里每个文件都必须命中一条目录前缀规则，或在 ROOT_FILES 里逐个显式登记，
// 否则 check 红。挡的是【零症状的积累】：一次性产物（审计报告 / 进度笔记 / 提案）悄悄回堆到
// docs/、测试文件散落到 tests/ 之外。这类东西不会让任何测试变红，只会慢慢长出来。
//
// 【它不再做什么】2026-09-04 之前它还渲染一份 571 行的 docs/repository-map.md 全文件清单。
// 那份文档零代码消费、只有三处文档链接指向它，代价却是每次增删文件都要跑一次
// inventory:update 并带一个大 diff —— 它 24 次改动里的绝大多数就是这笔税，而不是抓到问题。
// 前缀规则本身（下面这张表）才是有价值的那部分，留下；渲染出来的散文删掉。
// 分发裁剪的正确性由 tests/unit/dist-manifest.test.mjs 独立守着，从不依赖那份清单。
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 根目录文件与 docs/ 手写文档逐篇显式登记（docs/ 有意不设 .md 通配兜底）：
// 往 docs/ 新增文档必须先在此声明，否则被拒。这正是挡住一次性产物回堆的那道判据。
const ROOT_FILES = new Map([
  ['AGENTS.md', 'Instructions'],
  // 由 scripts/release.sh 在每次发版时追加，与 GitHub Release notes 同源。刻意**不**进
  // export-ignore：装机用户拿到的是源码归档，手上没有别的东西能回答「我这份比上一版多了什么」。
  ['CHANGELOG.md', 'Documentation'],
  ['CLAUDE.md', 'Instructions'],
  ['LICENSE', 'Legal'],
  ['NOTICE', 'Legal'],
  ['README.md', 'Documentation'],
  ['README.en.md', 'Documentation'],
  ['SECURITY.md', 'Documentation'],
  ['package.json', 'Project configuration'],
  ['package-lock.json', 'Generated lockfile'],
  ['app/server.js', 'Runtime entrypoint'],
  ['eslint.config.js', 'Project configuration'],
  ['.claude/settings.json', 'Project configuration'],
  ['.dockerignore', 'Test configuration'],
  ['.gitignore', 'Project configuration'],
  ['.gitattributes', 'Project configuration'],
  ['.nvmrc', 'Project configuration'],
  ['docs/architecture.en.md', 'Documentation'],
  ['docs/architecture.md', 'Documentation'],
  ['docs/deployment.md', 'Documentation'],
  ['docs/display-contracts.md', 'Documentation'],
  ['docs/getting-started.en.md', 'Documentation'],
  ['docs/getting-started.md', 'Documentation'],
  ['docs/hard-rules.md', 'Documentation'],
  ['docs/testing.md', 'Documentation'],
  // 测试树的地图与不变量词汇表。逐个登记而不是给 tests/ 开一条兜底前缀——那条前缀会让
  // 任何落在 tests/ 根的文件都过闸，正是这道闸要挡的（一次性产物悄悄回堆）。
  ['tests/README.md', 'Documentation'],
]);

// 前缀先匹配先赢，所以更具体的必须排在通配之前。
const PREFIX_RULES = [
  ['.github/', 'Automation'],
  // desktop/ = macOS 专属入口整体；launchd/ 更具体，必须排在前面
  ['desktop/launchd/', 'Desktop integration'],
  ['desktop/', 'Desktop integration'],
  ['app/src/', 'Backend source'],
  ['app/public/js/app/', 'Frontend source'],
  ['app/public/js/logic/', 'Frontend source'],
  ['app/public/js/', 'Frontend source'],
  ['app/public/css/', 'Frontend source'],
  ['app/public/vendor/', 'Vendored asset'],
  ['app/public/icons/', 'Generated asset'],
  ['app/public/', 'Frontend asset'],
  ['tests/playground/', 'Test support'],
  // tests/infra/ 与 tests/gates/ 必须排在通配的 tests/ 之前。这两条前缀取代了此前散在
  // ROOT_FILES 里的 6 个根配置条目与 12 个门禁的逐个登记。
  ['tests/infra/', 'Test configuration'],
  ['tests/gates/', 'Maintainer tooling'],
  ['tests/invariants/', 'Unit test'],
  ['tests/unit/', 'Unit test'],
  ['tests/integration/', 'Integration test'],
  ['tests/e2e/', 'E2E test'],
  ['tests/smoke/', 'Smoke test'],
  ['tests/fixtures/', 'Test support'],
  ['tests/helpers/', 'Test support'],
  ['tests/setup/', 'Test support'],
  ['scripts/', 'Maintainer tooling'],
];

export function classifyRepositoryPath(path) {
  const rootFile = ROOT_FILES.get(path);
  if (rootFile) return { category: rootFile };

  for (const [prefix, category] of PREFIX_RULES) {
    if (path.startsWith(prefix)) return { category };
  }
  return null;
}

function pathExists(rootDir, path) {
  try {
    lstatSync(join(rootDir, path));
    return true;
  } catch {
    return false;
  }
}

export function collectRepositoryFiles(rootDir = ROOT) {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: rootDir, encoding: 'utf8' },
  );
  return [...new Set(output.split('\0').filter(Boolean))]
    .filter(path => pathExists(rootDir, path))
    .sort((a, b) => a.localeCompare(b));
}

export function checkRepositoryInventory({ rootDir = ROOT } = {}) {
  const files = collectRepositoryFiles(rootDir);
  const unclassified = files.filter(path => !classifyRepositoryPath(path));
  // 扫描面为空 = git 视图不可用或前缀全部失配，绝不能当成「没有未分类文件」。
  if (files.length === 0) {
    return { ok: false, files, unclassified, reason: 'git ls-files 返回空——扫描面塌了，不是「全部合规」' };
  }
  if (unclassified.length > 0) {
    return {
      ok: false,
      files,
      unclassified,
      reason: `未分类文件（在 ROOT_FILES 登记，或让它落进一条已有的目录前缀）：\n${unclassified.map(p => `- ${p}`).join('\n')}`,
    };
  }
  return { ok: true, files, unclassified };
}

function main() {
  try {
    const result = checkRepositoryInventory({ rootDir: ROOT });
    if (!result.ok) {
      console.error(result.reason);
      process.exit(1);
    }
    console.log(`repository inventory OK (${result.files.length} files classified)`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
