// tests/gates/check-playwright-forbidden-patterns.js —— Playwright 测试基建硬闸。
// test.only/test.skip/test.fixme/networkidle/waitForTimeout 会隐藏回归或引入不确定等待；
// 本脚本把禁止清单落成 npm run check / CI 都执行的确定性门禁。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 锚在脚本自身位置，不用 cwd：从别处调用时扫的仍是这个仓库，而不是碰巧的当前目录。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// ★ tests/e2e 这个路径在仓库里有第二份真相：tests/infra/playwright.config.ts 的 testDir。
//   改 config 而漏改这里，结果是 E2E 照跑、本门禁静默扫 0 个文件、npm run check 全绿——
//   所以下面扫完必须断言扫描面非空，绝不能让「一个文件都没找到」表现为「没有违规」。
const TARGET_DIRS = ['tests/e2e', 'tests/playground/e2e'];
// 只扫描 Playwright E2E 树；Node 单元测试里的平台条件 skip 是合法的。未来若加 .js/.mjs/.cjs 的
// Playwright spec 也必须纳入，避免扩展名死角。
const TARGET_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs']);
const FORBIDDEN = [
  { pattern: /\btest\.only\s*\(/, label: 'test.only(' },
  { pattern: /\btest\.skip\s*\(/, label: 'test.skip(' },
  { pattern: /\btest\.fixme\s*\(/, label: 'test.fixme(' },
  // test.describe.only 比 test.only 破坏面更大：前者让 Playwright 全项目只跑那一个 describe、
  // 其余 190+ 用例静默不执行而报告全绿；后者只排除同文件其余用例。`\btest\.only\s*\(` 中间隔着
  // `.describe` 匹配不到，此前整类漏网。
  { pattern: /\btest\.describe\.(?:only|skip|fixme)\s*\(/, label: 'test.describe.only/skip/fixme(' },
  { pattern: /\bnetworkidle\b/, label: 'networkidle' },
  { pattern: /\bwaitForTimeout\s*\(/, label: 'waitForTimeout(' },
  // 手写 new Promise(...setTimeout...) 等价于被禁的 waitForTimeout——同样是不稳定的固定等待，
  // 只是绕过了字面禁令。排除 tests/e2e/mock：那里的 setTimeout 是模拟服务端时序延迟的工具函数
  // （如 const delay = ms => new Promise(res => setTimeout(res, ms))），不是 spec 里摸鱼等待，
  // 用途完全不同——mock server.js 与 scenarios/*.js 现有 12+ 处这类合法写法。
  {
    pattern: /new\s+Promise\s*\([^)]*\bsetTimeout\s*\(/,
    label: 'new Promise(...setTimeout...)（手写睡眠，等价于被禁的 waitForTimeout）',
    excludeDirs: ['tests/e2e/mock'],
  },
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

// 根目录可注入（argv[2]），供自测在临时夹具上跑；缺省锚 ROOT。
const rootDir = process.argv[2] ? resolve(process.argv[2]) : ROOT;

const scanned = [];
const violations = [];
for (const dir of TARGET_DIRS) {
  const absDir = join(rootDir, dir);
  if (!existsSync(absDir)) continue;
  for (const file of walk(absDir)) {
    scanned.push(file);
    const rel = file.slice(rootDir.length + 1);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const { pattern, label, excludeDirs } of FORBIDDEN) {
        if (excludeDirs?.some(dir => rel.startsWith(`${dir}/`))) continue;
        if (pattern.test(line)) violations.push(`${rel}:${i + 1}: 禁止模式 "${label}" —— ${line.trim()}`);
      }
    });
  }
}

// 扫描面塌了必须红。「一个 spec 都没找到」与「没有违规」在输出上无法区分，而前者意味着这道闸
// 已经失明——TARGET_DIRS 与 playwright.config.ts 的 testDir 是两份独立真相，改一边漏一边就是这个下场。
if (scanned.length === 0) {
  console.error(`❌ Playwright 禁止模式检查：在 ${TARGET_DIRS.join(' / ')} 下没扫到任何 spec 文件。`);
  console.error('   这不是「没有违规」，是扫描面塌了——核对目录是否被改名/移动（另一份真相在 tests/infra/playwright.config.ts 的 testDir）。');
  process.exit(1);
}

if (violations.length > 0) {
  console.error('❌ Playwright 测试基建禁止模式检查失败：');
  violations.forEach(v => console.error(`  ${v}`));
  console.error('\n禁止原因：test.only/skip/fixme 会静默排除用例、networkidle/waitForTimeout 是已弃用的不稳定 API。');
  console.error('若确认某用例需要暂时隔离，须经人工审阅后显式处理，不得由自动化 agent 自主写入 test.fixme。');
  process.exit(1);
}
console.log(`✅ Playwright 测试基建禁止模式检查通过（扫了 ${scanned.length} 个 spec，无 test.only/skip/fixme/networkidle/waitForTimeout）。`);
