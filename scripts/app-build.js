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
import { homedir } from 'node:os';
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
// CCMProcess.swift 同样两边都编：它有副作用（spawn 子进程）却必须可测 —— 那里出过一次
// FD 泄漏，把整个菜单栏拖成「点什么都没反应」，见该文件头注。
const CORE = join(DESKTOP, 'CCMCore.swift');
const PROC = join(DESKTOP, 'CCMProcess.swift');
// 导出：tests/unit/app-build.test.mjs 据此断言「desktop 下每个产品 .swift 都在这里」——
// 漏一个的症状是「代码写了菜单里没有」，且它同时逃过下面那道 typecheck 闸。
export const APP_SOURCES = [CORE, PROC, join(DESKTOP, 'ccm-menubar.swift'), join(DESKTOP, 'ccm-config-window.swift'), join(DESKTOP, 'ccm-console-window.swift')];
const TEST_SOURCES = [CORE, PROC, join(DESKTOP, 'ccm-menubar-tests.swift')];
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

// 只做类型检查、不产出任何文件（所以没有 -o，也不需要 -O / -parse-as-library）。
// 存在理由：此前 `npm run check` 只编译 TEST_SOURCES，三个 GUI 文件（1842 行，占生产 Swift
// 的 67%）连语法都不过一遍 —— 改坏了 check 照样全绿，只有人记得手动跑 app:build 才暴露。
// 全量 -typecheck 实测 1.5 秒，便宜到可以无条件进门禁，于是那条「靠人记住」的警告可以删掉。
export function typecheckArgs({ sources, target = swiftTarget(), frameworks = ['AppKit'] }) {
  const fw = frameworks.flatMap((f) => ['-framework', f]);
  return ['-typecheck', '-target', target, ...fw, ...sources];
}

// 「开机自启该指向哪个 CCM.app」。装进 /Applications 之后，desktop/build 里那份只是中间产物：
// 拿它去装 LaunchAgent，等于把自启钉在一个 gitignore 的目录上，git clean 或换分支即失效，
// 而 status 直到 2026-08-18 才会为此报警。抽成函数是因为它编码的是一个判断，不是格式化。
export function autostartTargetPath(buildAppPath, { installed } = {}) {
  return installed ? '/Applications/CCM.app' : buildAppPath;
}

// 装完之后 desktop/build/CCM.app 还留着，就是一份**同 bundle id、同版本号、零区分标记**
// 的复制品。实测（2026-08-24）LaunchServices 把两个 bundle 注册到同一个 identifier 下，
// 于是 Spotlight 里出现两个同名同图标的 CCM，界面上分不出哪个是哪个；旧实例还在跑时
// 从 Spotlight 打开更可能只是激活旧实例，让「更新桌面端」看起来没生效。
//
// 但**不能无条件删**：万一 menubar 的 LaunchAgent 正指向构建产物——那是个已经被
// service.js 警告过的状态，却仍然是能用的——删掉就把它变成静默失效。所以先问一句。
export function shouldRemoveBuildArtifact({ installed = false, buildAppPath, autostartAppPath = null } = {}) {
  if (!installed) {
    return { remove: false, reason: '只编译不安装，构建产物就是最终产物' };
  }
  // 尾斜杠归一化：plist 里写成 `<path>/` 的话，不归一就会把「正在被自启使用」判成不相等，
  // 于是删掉一个能用的 app —— 这是整条改动唯一会造成真实损害的路径。
  const norm = (p) => String(p || '').replace(/\/+$/, '');
  if (autostartAppPath && norm(autostartAppPath) === norm(buildAppPath)) {
    return {
      remove: false,
      reason: '开机自启正指向它——先在菜单里重新勾一次「开机自启（菜单栏）」改指 /Applications，再重新安装',
    };
  }
  return { remove: true, reason: '已装进 /Applications，构建产物只是 ditto 的源' };
}

// menubar LaunchAgent 指向哪个 bundle。读不到（没装自启 / 非 macOS / plist 坏了）返回 null，
// 判据那边按「不指向构建产物」处理：清理是安全方向，且真删错了 service.js 会立刻报
// 「开机自启指向的 CCM.app 已不存在」——是个看得见的告警，不是静默失效。
function readAutostartAppPath() {
  const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.ccm.menubar.plist');
  if (!existsSync(plist)) return null;
  try {
    const r = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8', timeout: 3000 });
    if (!r || r.status !== 0) return null;
    // 形态是 ['/usr/bin/open', '<bundle path>']，见 desktop/launchd/menubar.plist.template
    const args = JSON.parse(r.stdout)?.ProgramArguments;
    return Array.isArray(args) ? (args.find((a) => String(a).endsWith('.app')) ?? null) : null;
  } catch {
    return null;
  }
}

// 编译时刻，给人看的本地时间。刻意不存 ISO/epoch：显示侧（Swift）就不必解析日期，
// 而 n=1 自托管里「编译的人」和「看的人」是同一台机器，本地时间没有歧义。
export function formatBuildTime(ms) {
  const two = (n) => String(n).padStart(2, '0');
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

// Info.plist 需要的占位符变量。少一个都会让 bundle 里出现字面量 __XXX__。
export function infoPlistVars({ version, repo, node, buildTime = '', buildCommit = 'unknown', buildNumber = '' }) {
  return {
    VERSION: version,
    REPO: repo,
    NODE: node,
    BUILD_TIME: buildTime,
    BUILD_COMMIT: buildCommit,
    // CFBundleVersion 在 macOS 语义上是**构建号**，本该单调递增。此前它与
    // CFBundleShortVersionString 共用同一个 semver，于是两份 bundle（/Applications 与
    // desktop/build）在 LaunchServices 里的 version 字段完全相同（实测 2026-08-24），
    // 系统没有任何依据判断哪份更新。回落到 version 只是为了「拿不到构建号也别产出空值」。
    BUILD_NUMBER: buildNumber || version,
  };
}

// 编译时的 git 身份。拿不到（非 git 检出 / 没装 git）一律 'unknown'，绝不让构建失败：
// 这是可观测性，不是正确性前提。
// 带未提交改动时标 -dirty —— 那份二进制里含着仓库里看不到的东西，排障时最容易漏判。
function gitCommitLabel() {
  try {
    const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 3000 });
    if (!head || head.status !== 0) return 'unknown';
    const sha = String(head.stdout).trim();
    if (!sha) return 'unknown';
    const st = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', timeout: 5000 });
    const dirty = st && st.status === 0 && String(st.stdout).trim() !== '';
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
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
//
// 先全量 typecheck 再编测试：GUI 语法错应该最先炸，不必等测试编译完。这一步覆盖的是
// 断言集永远够不到的那 1842 行 —— @main 冲突让 ccm-menubar.swift 进不了测试编译单元，
// 而测试二进制不链 AppKit，GUI 类型也抽不进 CCMCore。类型检查是这里唯一还能做的机器验证。
export function runTests() {
  mkdirSync(BUILD, { recursive: true });
  process.stdout.write('类型检查 desktop/*.swift…\n');
  const tc = run('swiftc', typecheckArgs({ sources: APP_SOURCES }), 'swiftc(typecheck)');
  // 成功时也把 stderr 打出来。run() 默认只在失败时回显捕获的输出，而 swiftc 的**告警**
  // 恰恰走成功路径 —— 不打的话这条通道是死的：并发隔离、API 弃用这类「能编过但会出事」
  // 的信号永远没人看得见。刻意不做成 -warnings-as-errors：Xcode 升级会引入新告警，
  // 那会把门禁打红成噪音；可见但不阻塞才是这里正确的失败模式。
  const warnings = String(tc?.stderr || '').trim();
  if (warnings) process.stdout.write(`${warnings}\n`);
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
  const now = Date.now();
  const rendered = renderTemplate(tpl, infoPlistVars({
    version, repo: ROOT, node,
    buildTime: formatBuildTime(now),
    buildCommit: gitCommitLabel(),
    buildNumber: String(Math.floor(now / 1000)),   // epoch 秒：可证单调，且与 semver 不冲突
  }));
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

  // --install：把产物装进 /Applications，让 Spotlight / Launchpad / Dock 能找到它，
  // 从此启动不再依赖「cd 到仓库 open build 产物」。
  const installed = process.argv.includes('--install');
  if (installed) {
    const dest = '/Applications/CCM.app';
    process.stdout.write(`\n安装到 ${dest}…\n`);
    // 先删后拷：ditto 对已存在 bundle 是合并式覆盖，被改名/删除的旧文件会残留
    rmSync(dest, { recursive: true, force: true }); // safe-rm: 目标恒为字面量 /Applications/CCM.app，不含任何运行期计算
    run('ditto', [APP, dest], 'ditto');
    process.stdout.write('✓ 已安装。Spotlight 搜「CCM」即可打开；旧实例在跑的话点菜单「重启应用」或退出后从新位置打开，\n'
      + '  并重新勾一次「开机自启（菜单栏）」让 LaunchAgent 指向新位置。\n');
  } else {
    process.stdout.write(`  试运行：open ${APP}\n`);
  }

  // 自启提示必须指向【最终落地位置】，且排在 --install 之后。此前它固定打印构建产物路径
  // 又排在安装之前，于是跑 app:install 的人看到的最后一条可复制命令指向 desktop/build/CCM.app
  // ——照做就把 LaunchAgent 钉在 gitignore 的目录上，git clean 后开机自启静默失效。
  // 清理中间产物：装完之后它只剩下在 Spotlight 里制造一个分不清的同名条目。
  const cleanup = shouldRemoveBuildArtifact({
    installed, buildAppPath: APP, autostartAppPath: readAutostartAppPath(),
  });
  if (cleanup.remove) {
    rmSync(APP, { recursive: true, force: true }); // safe-rm: 目标恒为 <repo>/desktop/build/CCM.app，两段目录名都是本文件里的字面量常量，不含任何运行期计算（同 :114 那处）
    process.stdout.write(`  已清理构建产物（${cleanup.reason}），Spotlight 里只会剩一个 CCM。\n`);
  } else if (installed) {
    process.stdout.write(`  ⚠ 保留了 ${APP}：${cleanup.reason}\n`
      + '    在此之前 Spotlight 里会有两个同名的 CCM，分不出哪个是哪个。\n');
  }

  const target = autostartTargetPath(APP, { installed });
  process.stdout.write('  开机自启：在菜单栏里勾「开机自启（菜单栏）」，'
    + `或 node scripts/service.js install menubar --app="${target}"\n`);
  if (!installed) {
    process.stdout.write('  ⚠ 上面这个路径在仓库的构建目录里（已 gitignore），git clean 或换分支会删掉它，\n'
      + '    届时开机自启会静默失效。长期使用请跑 npm run app:install 装到 /Applications。\n');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.includes('--test-only')) {
    // ★ 这条路径挂在 `npm run check` 里，所以「跑不了」必须是**跳过**而不是失败：
    // CI 的三个 job 全在 ubuntu-latest（没有 swiftc），Linux 用户也不该因为编译不了 Swift
    // 就过不了门禁。而在真实 macOS 环境上它会真跑 —— 此前 CCMCore 的 80 条断言不在任何门禁里，
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
