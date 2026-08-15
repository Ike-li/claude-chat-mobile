#!/usr/bin/env node
// scripts/app-build.js —— 把 desktop/ccm-menubar.swift 编译成 CCM.app。
//
// 刻意不建 Xcode 工程：单文件 Swift + swiftc 就够，而一个 .xcodeproj 会往这个「零 GUI 依赖」
// 的仓库里塞进一整套 IDE 元数据。产物也不提交（.gitignore 掉 desktop/build/）——
// 里面烘着绝对路径、且与 CPU 架构绑定，换台机器就不对了。
//
// 五步：建 bundle 骨架 → swiftc 编译 → 渲染 Info.plist → ad-hoc 签名 → 打印下一步。
//
// ad-hoc codesign（`-s -`）不是为了过 Gatekeeper（本地编译的产物压根没有 quarantine 属性，
// 不会被拦），而是为了让 bundle identity 跨重建保持稳定 —— 否则 UserDefaults 每次重新编译
// 就重置，用户设过的「重新定位仓库」会莫名其妙丢掉。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderTemplate, stripLeadingComment } from './render-plist.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DESKTOP = join(ROOT, 'desktop');
const BUILD = join(DESKTOP, 'build');
const APP = join(BUILD, 'CCM.app');
const MACOS_DIR = join(APP, 'Contents', 'MacOS');
const BINARY = join(MACOS_DIR, 'CCM');
const INFO_PLIST = join(APP, 'Contents', 'Info.plist');

// CCMCore.swift 是纯逻辑层（零 AppKit、零 Process），app 与测试都编译它 —— 这样测试跑的
// 就是产品里那一份代码，而不是一个平行的复制品。
const CORE = join(DESKTOP, 'CCMCore.swift');
const APP_SOURCES = [CORE, join(DESKTOP, 'ccm-menubar.swift'), join(DESKTOP, 'ccm-config-window.swift')];
const TEST_SOURCES = [CORE, join(DESKTOP, 'ccm-menubar-tests.swift')];
const TEST_BIN = join(BUILD, 'ccm-core-tests');

// swiftc 参数的单一事实源。-parse-as-library 是必须的：源码末尾有顶层的 app.run()，
// 不加这个 flag 会被当成 script 模式编译，@MainActor 与顶层代码混用会报错。
// target 按宿主架构派生。写死 arm64 的话，Intel Mac 上 swiftc 会安静地交叉编译出 arm64 产物、
// codesign 通过、脚本打印「✓ 已生成」，然后 open 报「不支持」——失败点离根因很远。
export function swiftTarget(arch = process.arch) {
  return `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos13.0`;
}

export function swiftcArgs({ sources, out, target = swiftTarget(), frameworks = ['AppKit'] }) {
  const fw = frameworks.flatMap((f) => ['-framework', f]);
  return ['-O', '-parse-as-library', '-target', target, ...fw, '-o', out, ...sources];
}

// Info.plist 需要的占位符变量。少一个都会让 bundle 里出现字面量 __XXX__。
export function infoPlistVars({ version, repo, node }) {
  return { VERSION: version, REPO: repo, NODE: node };
}

// 写进 bundle 的 node 路径：与 plist 里那条同源，用登录 shell 的 `command -v node`
// （稳定 symlink），而不是 process.execPath（那是解析过 symlink 的真身，brew upgrade 后失效）。
function loginShellNode() {
  try {
    const r = spawnSync('/bin/zsh', ['-lc', 'command -v node'], { encoding: 'utf8', timeout: 5000 });
    const first = String(r?.stdout || '').trim().split('\n')[0].trim();
    if (first && existsSync(first)) return first;
  } catch { /* 回落 */ }
  return process.execPath;
}

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!r || r.status !== 0) {
    process.stderr.write(`✗ ${label} 失败\n${String(r?.stderr || r?.stdout || '未知错误').trim()}\n`);
    process.exit(1);
  }
  return r;
}

// 跑 CCMCore 的断言集。Foundation 就够，不链 AppKit（测试里没有 GUI 类型）。
export function runTests() {
  mkdirSync(BUILD, { recursive: true });
  process.stdout.write('编译 CCMCore 测试…\n');
  run('swiftc', swiftcArgs({ sources: TEST_SOURCES, out: TEST_BIN, frameworks: [] }), 'swiftc(test)');
  const r = spawnSync(TEST_BIN, [], { encoding: 'utf8', stdio: 'inherit' });
  if (!r || r.status !== 0) {
    process.stderr.write('✗ CCMCore 测试未通过\n');
    process.exit(1);
  }
}

export function main({ test = true } = {}) {
  if (process.platform !== 'darwin') {
    process.stderr.write('菜单栏应用仅支持 macOS。\n');
    process.exitCode = 1;
    return;
  }
  if (!spawnSync('/usr/bin/which', ['swiftc'], { encoding: 'utf8' })?.stdout?.trim()) {
    process.stderr.write('找不到 swiftc。装 Xcode Command Line Tools：xcode-select --install\n');
    process.exitCode = 1;
    return;
  }

  // 先跑测试再编译产物：纯逻辑挂了就没必要出包了
  if (test) runTests();

  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const node = loginShellNode();

  // 全量重建：增量编译单文件没意义，而残留的旧 bundle 内容会让人困惑。
  rmSync(APP, { recursive: true, force: true }); // safe-rm: 目标恒为 <repo>/desktop/build/CCM.app，两段目录名都是本文件里的字面量常量，不含任何运行期计算
  mkdirSync(MACOS_DIR, { recursive: true });

  process.stdout.write('编译 Swift…\n');
  run('swiftc', swiftcArgs({ sources: APP_SOURCES, out: BINARY }), 'swiftc');

  process.stdout.write('渲染 Info.plist…\n');
  const tpl = stripLeadingComment(readFileSync(join(DESKTOP, 'Info.plist.template'), 'utf8'));
  const rendered = renderTemplate(tpl, infoPlistVars({ version, repo: ROOT, node }));
  // 精确匹配占位符形态：宽泛的 includes('__') 会把仓库路径里的双下划线
  // （/Users/you/my__work/…）误判成未替换，报一句与真实原因完全无关的错。
  if (/__[A-Z_]+__/.test(rendered)) {
    process.stderr.write(`✗ Info.plist 仍有未替换的占位符\n`);
    process.exit(1);
  }
  // 这里不用 writeOwnerOnlyFile：Info.plist 不是秘密，且 0600 会让 LaunchServices 读不到。
  writeFileSync(INFO_PLIST, rendered);

  process.stdout.write('ad-hoc 签名…\n');
  run('codesign', ['--force', '--sign', '-', APP], 'codesign');

  process.stdout.write(`\n✓ 已生成 ${APP}\n`);
  process.stdout.write(`  试运行：open ${APP}\n`);
  process.stdout.write('  开机自启：在菜单栏里勾「开机自启（菜单栏）」，或 node scripts/service.js install menubar --app="'
    + APP + '"\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.includes('--test-only')) {
    // ★ 这条路径挂在 `npm run check` 里，所以「跑不了」必须是**跳过**而不是失败：
    // CI 的三个 job 全在 ubuntu-latest（没有 swiftc），Linux 用户也不该因为编译不了 Swift
    // 就过不了门禁。而在机主的 Mac 上它会真跑 —— 此前 CCMCore 的 80 条断言不在任何门禁里，
    // 只有人手动敲 `npm run app:test` 才会执行。
    if (process.platform !== 'darwin') {
      process.stdout.write('非 macOS，跳过 Swift 测试\n');
    } else if (!spawnSync('/usr/bin/which', ['swiftc'], { encoding: 'utf8' })?.stdout?.trim()) {
      process.stdout.write('未装 swiftc，跳过 Swift 测试（装 Xcode CLT 后即纳入 npm run check）\n');
    } else {
      runTests();
    }
  } else {
    main();
  }
}
