// scripts/dist-manifest.js —— 算「分发包必须包含哪些文件」。
//
// 分发形态是 `git archive` + .gitattributes(export-ignore)：产出一棵装机即可运行的源码树，
// 而不是 npm 包。选 git archive 不选 `npm pack` 的原因是实测出来的硬约束：
// **npm 无条件排除 package-lock.json**（写进 files 字段也没用），而用户要靠它 `npm ci` 复现依赖树；
// 且本包是 private、无 main/bin，本来就不是给人 `npm install` 的。
//
// 闭包 = ① 从用户会执行的入口静态展开的相对 import 图 ② 代码按路径读、import 图看不见的文件。
// ② 是这里唯一的人工清单，也是最容易漏的一类——漏了不会有任何静态报错，
// 只在用户跑到那一步时炸（如 service:install 找不到 plist 模板）。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// 分发包的装机路径是 `npm ci --omit=dev`，这些二进制来自 devDependencies，包内装不出来。
const DEV_BINARIES = Object.freeze(['eslint', 'playwright']);

/**
 * 重写分发包里的 package.json：删掉在包内跑不起来的 scripts，删掉 devDependencies。
 *
 * 【为什么必须改这一个文件】export-ignore 是文件级的，裁不掉 package.json 内部的字段，
 * 而它天生混合：start/setup/doctor 与 test/check/mutate 同在一个 scripts 对象里。
 * 不改的话包内近一半命令指向已被裁掉的文件，用户敲下去只拿到 ENOENT——
 * 那等于把「配置也隔离了」这句话说成了假话。
 *
 * 【判据是可达性，不是第二份白名单】维护一份「哪些 script 属于生产」的清单，必然与
 * .gitattributes 分叉（改了一处忘了另一处，且没有任何机制会发现）。这里问的是同一个问题：
 * 命令引用的文件还在包里吗 · 用的二进制还装得上吗 · 转发的目标还活着吗。
 *
 * @param {object} pkg          原 package.json 解析结果（不会被改动）
 * @param {object} opts
 * @param {Set<string>} opts.shipped  包内文件的相对路径集合
 * @returns {object} 新的 package.json 对象
 */
export function rewritePackageJson(pkg, { shipped, devBins = DEV_BINARIES } = {}) {
  const out = { ...pkg, scripts: { ...(pkg.scripts ?? {}) } };
  delete out.devDependencies;

  const isRunnable = (cmd) => {
    if (devBins.some((bin) => new RegExp(`(^|\\s|/)${bin}(\\s|$)`).test(cmd))) return false;
    // 命令里出现的仓库内路径：目录形式（tests/unit/）与文件形式（scripts/x.js、a.yml）都要认。
    const refs = [...cmd.matchAll(/(?:^|\s|-f\s*)((?:app|scripts|tests|desktop)\/[\w./*-]+|[\w.-]+\.(?:yml|ts|js|mjs))/g)]
      .map((m) => m[1].replace(/\*.*$/, ''));   // tests/unit/*.test.mjs → tests/unit/
    return refs.every((ref) => (ref.endsWith('/')
      ? [...shipped].some((f) => f.startsWith(ref))
      : shipped.has(ref)));
  };

  for (const [name, cmd] of Object.entries(out.scripts)) {
    if (!isRunnable(cmd)) delete out.scripts[name];
  }

  // 转发链要整条删：test:visual → test:e2e → playwright。只删第一层会留下一条
  // 「看起来能跑、一敲就报 Missing script」的别名。迭代到不动点。
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, cmd] of Object.entries(out.scripts)) {
      const targets = [...cmd.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)].map((m) => m[1]);
      if (targets.some((t) => !Object.hasOwn(out.scripts, t))) {
        delete out.scripts[name];
        changed = true;
      }
    }
  }
  return out;
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

/** 递归列出目录下所有文件的相对路径（供 --rewrite-package 算 shipped 集合）。 */
function listFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(abs, base, out);
    else out.push(relative(base, abs));
  }
  return out;
}

// CLI：`node scripts/dist-manifest.js` 打印闭包；`--check` 对比 git archive 的实际输出；
// `--rewrite-package <staged-dir>` 就地改写解包目录里的 package.json（发版打包用）。
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const root = join(import.meta.dirname, '..');
  const rewriteAt = process.argv.indexOf('--rewrite-package');
  if (rewriteAt !== -1) {
    const stage = process.argv[rewriteAt + 1];
    if (!stage || !existsSync(join(stage, 'package.json'))) {
      console.error('✗ --rewrite-package 需要一个含 package.json 的解包目录');
      process.exit(2);
    }
    const shipped = new Set(listFiles(stage));
    const before = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
    const after = rewritePackageJson(before, { shipped });
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(after, null, 2)}\n`);
    const dropped = Object.keys(before.scripts ?? {}).length - Object.keys(after.scripts ?? {}).length;
    console.log(`✅ package.json 已改写：保留 ${Object.keys(after.scripts ?? {}).length} 条命令，删除 ${dropped} 条（含 devDependencies）。`);
    process.exit(0);
  }
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
