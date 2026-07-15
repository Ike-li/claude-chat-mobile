#!/usr/bin/env node
// 模块边界守卫：静态解析项目内相对 import，强制分层不变量 + 零循环依赖。
// 定位：AI 后续会话最擅长「为眼前任务 import 任何能用的东西」，刚拆好的结构会
// 慢慢缠死。此门把「脑子里的约定」变成 npm run check 的一道硬闸。
//
// 不引 madge 等第三方：CI 不联网、且规则只需静态相对 import 图，自实现 ~120 行足够。
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 扫描根：运行时源码三处。tests/scripts 不设边界（工具与测试可跨域引用）。
const SCAN_ROOTS = ['src', 'public/js'];
const EXTRA_FILES = ['server.js'];

// import/export ... from '...'、动态 import('...')、副作用 import '...'
const IMPORT_RE =
  /(?:^|\n)\s*(?:import\s[^'"]*?from\s*|import\s*\(\s*|export\s[^'"]*?from\s*|import\s*)['"]([^'"]+)['"]/g;

// 分层规则。violation 判定：from 匹配 fromPrefix 且 to 匹配 toTest 且不在白名单。
export const BOUNDARY_RULES = [
  {
    name: 'frontend-no-backend',
    describe: '前端（public/js）不得 import 后端（src/）',
    from: p => p.startsWith('public/js/'),
    to: p => p.startsWith('src/'),
  },
  {
    name: 'backend-no-frontend',
    describe: '后端（src/、server.js）不得 import 前端（public/js），共享纯逻辑除外',
    from: p => p.startsWith('src/') || p === 'server.js',
    to: p => p.startsWith('public/js/'),
  },
  {
    name: 'shared-is-leaf',
    describe: 'src/shared 是叶子层，不得反向 import 其他后端域',
    from: p => p.startsWith('src/shared/'),
    to: p => p.startsWith('src/') && !p.startsWith('src/shared/'),
  },
  {
    name: 'server-is-sink',
    describe: 'src/server 是组装根，只有 server.js 与 src/server 自身可以 import 它',
    from: p => !p.startsWith('src/server/') && p !== 'server.js',
    to: p => p.startsWith('src/server/'),
  },
  {
    name: 'runtime-no-tooling',
    describe: '运行时源码不得 import 维护脚本（scripts/）或测试（tests/）',
    from: () => true,
    to: p => p.startsWith('scripts/') || p.startsWith('tests/'),
  },
];

// 前后端共享的框架无关纯逻辑：浏览器 <script> 与 node:test 同时消费，两侧 import 合法。
// 收窄到具体文件而非目录，避免变成「随便跨界」的后门。
export const SHARED_ALLOWLIST = new Set([
  'public/js/canonicalize.js', // src/auth/fingerprint.js 与浏览器共用规范化
  'public/js/logic.js', // src/server 与浏览器共用纯决策逻辑（node:test 直接覆盖）
]);

function listFiles(root) {
  const files = [];
  const skip = new Set(['node_modules', '.git', 'data', '.ccm-uploads']);
  const visit = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!skip.has(e.name)) visit(join(dir, e.name));
      } else if (/\.(?:js|mjs)$/.test(e.name)) {
        files.push(relative(root, join(dir, e.name)));
      }
    }
  };
  for (const r of SCAN_ROOTS) {
    try {
      visit(join(root, r));
    } catch {
      // 扫描根不存在（如临时夹具只建了一侧）→ 跳过
    }
  }
  for (const f of EXTRA_FILES) {
    try {
      readFileSync(join(root, f));
      files.push(f);
    } catch {
      // 可选文件缺失 → 跳过
    }
  }
  return files.sort();
}

export function buildImportGraph(root = ROOT) {
  const graph = new Map();
  for (const rel of listFiles(root)) {
    const src = readFileSync(join(root, rel), 'utf8');
    const deps = [];
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // 只跟踪项目内相对 import
      deps.push(relative(root, resolve(join(root, dirname(rel)), spec)));
    }
    graph.set(rel, deps);
  }
  return graph;
}

export function findBoundaryViolations(graph, rules = BOUNDARY_RULES) {
  const violations = [];
  for (const [from, deps] of graph) {
    for (const to of deps) {
      if (SHARED_ALLOWLIST.has(to)) continue;
      for (const rule of rules) {
        if (rule.from(from) && rule.to(to)) {
          violations.push({ rule: rule.name, describe: rule.describe, from, to });
        }
      }
    }
  }
  return violations;
}

// Tarjan 式 DFS 找回边；只报项目内节点间的静态循环。
export function findCycles(graph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const stack = [];
  const cycles = [];
  const dfs = node => {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of graph.get(node) || []) {
      if (!graph.has(dep)) continue; // 图外目标（如 .json 或漏解析）→ 忽略
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        cycles.push([...stack.slice(stack.indexOf(dep)), dep]);
      } else if (c === WHITE) {
        dfs(dep);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };
  for (const node of graph.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) dfs(node);
  }
  return cycles;
}

export function analyze(root = ROOT) {
  const graph = buildImportGraph(root);
  return {
    graph,
    violations: findBoundaryViolations(graph),
    cycles: findCycles(graph),
  };
}

function main() {
  const { violations, cycles } = analyze(ROOT);
  const problems = [];
  if (violations.length) {
    problems.push('模块边界违规：');
    for (const v of violations) problems.push(`  [${v.rule}] ${v.from} → ${v.to}\n    ${v.describe}`);
  }
  if (cycles.length) {
    problems.push('循环依赖：');
    for (const c of cycles) problems.push('  ' + c.join(' → '));
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('模块边界 OK（无跨层违规、无循环依赖）');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
