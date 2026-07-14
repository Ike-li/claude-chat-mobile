// scripts/check-playwright-forbidden-patterns.js —— Playwright 测试基建硬闸（审计 TC-007）。
// specs/playwright-test-improvement-backlog.md 早把 test.only/test.skip/test.fixme/networkidle/
// waitForTimeout 列为 P0 lane 禁止模式，但此前只是文档声明、没有可执行的守卫——.codex/agents/
// playwright_test_healer.toml 配置的自动化 test healer 在测试持续失败时会自主写 test.fixme() 隐藏
// 产品回归，光靠文档约定拦不住它。本脚本把禁止清单落成 npm run check / CI 都跑的真门禁。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const TARGET_DIRS = ['tests'];
// 复核发现：此前只认 .ts，未来若加 .js/.mjs/.cjs 的 Playwright spec 会静默漏扫——tests/ 下目前
// 全是 .ts（无实际影响），但既然是硬闸就不该留这种扩展名死角。
const TARGET_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs']);
const FORBIDDEN = [
  { pattern: /\btest\.only\s*\(/, label: 'test.only(' },
  { pattern: /\btest\.skip\s*\(/, label: 'test.skip(' },
  { pattern: /\btest\.fixme\s*\(/, label: 'test.fixme(' },
  { pattern: /\bnetworkidle\b/, label: 'networkidle' },
  { pattern: /\bwaitForTimeout\s*\(/, label: 'waitForTimeout(' },
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (TARGET_EXTENSIONS.has(extname(p))) files.push(p);
  }
  return files;
}

const violations = [];
for (const dir of TARGET_DIRS) {
  for (const file of walk(dir)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const { pattern, label } of FORBIDDEN) {
        if (pattern.test(line)) violations.push(`${file}:${i + 1}: 禁止模式 "${label}" —— ${line.trim()}`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error('❌ Playwright 测试基建禁止模式检查失败：');
  violations.forEach(v => console.error(`  ${v}`));
  console.error('\n禁止原因：test.only/skip/fixme 会静默排除用例、networkidle/waitForTimeout 是已弃用的不稳定 API。');
  console.error('若确认某用例需要暂时隔离，须经人工审阅后显式处理，不得由自动化 agent 自主写入 test.fixme。');
  process.exit(1);
}
console.log('✅ Playwright 测试基建禁止模式检查通过（tests/ 下无 test.only/skip/fixme/networkidle/waitForTimeout）。');
