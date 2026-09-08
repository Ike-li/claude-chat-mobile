// scripts/dist-manifest.js —— 算「分发树必须包含哪些文件」。
//
// 分发形态是 GitHub 的源码归档（/archive/refs/heads/master.tar.gz）= `git archive` + .gitattributes(export-ignore)：
// 用户 curl 下来的直接是一棵装机即可运行的源码树，发版不打包、不上传资产。选 git archive 不选 `npm pack`
// 的原因是实测出来的硬约束：**npm 无条件排除 package-lock.json**（写进 files 字段也没用），而用户要靠它
// `npm ci --omit=dev` 复现依赖树；且本包是 private、无 main/bin，本来就不是给人 `npm install` 的。
// 代价：export-ignore 是文件级的，package.json 原样进包——test/check/lint 类命令与 devDependencies 都还在，
// 只是跑不了（引用的 tests/ 已裁、二进制在 --omit=dev 下装不出来）。文档明写这一点，不改写任何文件。
//
// 闭包 = ① 从用户会执行的入口静态展开的相对 import 图 ② 代码按路径读、import 图看不见的文件。
// ② 是这里唯一的人工清单，也是最容易漏的一类——漏了不会有任何静态报错，
// 只在用户跑到那一步时炸（如 service:install 找不到 plist 模板）。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// 用户装机/运维真正会执行的入口：package.json 里非测试的 scripts + 文档里的 `node scripts/xxx.js`。
// 门禁类（check-*/contract-check/repo-inventory/mutate/…）刻意不在此列——它们是维护者工具。
export const DIST_ENTRIES = Object.freeze([
  'app/server.js',                          // npm start / npm run dev
  'scripts/setup.js',                   // npm run setup
  'scripts/doctor.js',                  // node scripts/doctor.js
  'scripts/device.js',                  // node scripts/device.js
  'scripts/config.js',                  // node scripts/config.js
  'scripts/service.js',                 // npm run service:*
  'scripts/uninstall.js',               // npm run uninstall
  'scripts/app-build.js',               // npm run app:install / app:build
  'scripts/statusline-bridge-setup.js', // npm run statusline:*
  'scripts/statusline-bridge.js',       // 桥本体，被 ~/.claude 的配置直接调用
  'scripts/hooks-bridge-setup.js',      // npm run hooks:*
  'scripts/hooks-bridge.js',            // 同上
]);

// import 图看不见的运行时依赖：代码里以【路径字符串】引用，静态分析扫不到。
export const EXTRA_RUNTIME_FILES = Object.freeze([
  'scripts/rotate-logs.sh',                        // app/src/ops/service-units.js 的 ROTATE_SUFFIX
  'desktop/launchd/log-rotate.plist.template',     // service-units.js:115
  'desktop/launchd/menubar.plist.template',        // service-units.js:131
  'desktop/launchd/server.plist.template',         // 受管 server unit
  'desktop/launchd/tunnel.plist.template',         // 受管隧道 unit
  'desktop/Info.plist.template',                   // scripts/app-build.js 渲染 bundle
  'desktop/CCMCore.swift',                         // 以下五份由 app-build.js 交给 swiftc
  'desktop/CCMProcess.swift',
  'desktop/ccm-menubar.swift',
  'desktop/ccm-config-window.swift',
  'desktop/ccm-console-window.swift',
  'app/public/js/canonicalize.js',                     // 前后端共用（边界豁免），也被 app/src/ import
  'package.json',
  'package-lock.json',
]);

/**
 * 从源码里提取所有 import 说明符（静态 + 动态）。
 *
 * 【为什么要逐行剥注释】动态 import 的正则无法像静态那样做行首锚定，于是会扫进散文里的
 * 示例代码——实测 app/src/shared/log-time.js 的头注释写着「入口在 app/server.js 的动态 import('app.js') 之前安装」，
 * 裸匹配把 'app.js' 当成了一个未声明的 npm 包。判据收窄成「跳过 trim 后以 // 、* 、/* 开头的行」：
 * 真实的 import 语句不会以这三者开头，而这三者覆盖了行注释与块注释的续行。
 */
function extractSpecs(src) {
  const code = src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
  return [
    ...code.matchAll(/^\s*(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/gm),
    ...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);
}

/**
 * 收集一批文件里用到的【裸包名】（即会去 node_modules 找的那些），归一到包名粒度：
 * `@scope/pkg/sub` → `@scope/pkg`，`pkg/sub` → `pkg`。
 * 用途：断言生产代码只依赖 dependencies——若某个生产文件 import 了 devDependency，
 * 用户 `npm ci --omit=dev` 之后才会炸，而那时已经装机失败了。
 */
export function bareImports(root, files) {
  const pkgs = new Set();
  for (const file of files) {
    const abs = join(root, file);
    if (!existsSync(abs) || !/\.(js|mjs)$/.test(file)) continue;
    for (const spec of extractSpecs(readFileSync(abs, 'utf8'))) {
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      const parts = spec.split('/');
      pkgs.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    }
  }
  return [...pkgs].sort();
}

/** 解析一条相对 import 到仓库相对路径；裸包名（node_modules）返回 null。 */
function resolveSpec(root, fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(root, dirname(fromFile), spec);
  for (const cand of [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js')]) {
    if (existsSync(cand)) return relative(root, cand);
  }
  return null;
}

/**
 * 从 DIST_ENTRIES 出发展开静态 import 图，并入 EXTRA_RUNTIME_FILES。
 * 返回排序后的仓库相对路径数组。
 */
export function productionClosure(root) {
  const seen = new Set();

  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const abs = join(root, file);
    if (!existsSync(abs) || !/\.(js|mjs)$/.test(file)) return;
    for (const spec of extractSpecs(readFileSync(abs, 'utf8'))) {
      const target = resolveSpec(root, file, spec);
      if (target) walk(target);
    }
  };

  for (const entry of DIST_ENTRIES) walk(entry);
  for (const extra of EXTRA_RUNTIME_FILES) seen.add(extra);
  return [...seen].sort();
}

// CLI：`node scripts/dist-manifest.js` 打印闭包；`--check` 对比 git archive 的实际输出。
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const root = join(import.meta.dirname, '..');
  const closure = productionClosure(root);
  if (process.argv.includes('--check')) {
    const shipped = new Set(
      execFileSync('sh', ['-c', 'git archive --worktree-attributes --format=tar HEAD | tar t'], {
        cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      }).trim().split('\n'),
    );
    const missing = closure.filter(f => !shipped.has(f));
    if (missing.length) {
      console.error(`✗ 分发包缺少 ${missing.length} 个生产必需文件：\n  ${missing.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`✅ 分发包覆盖全部 ${closure.length} 个生产必需文件（打包 ${shipped.size} 项）。`);
  } else {
    console.log(closure.join('\n'));
    console.error(`\n共 ${closure.length} 个文件（不含整目录保留的 app/public/ docs/ desktop/）。`);
  }
}
