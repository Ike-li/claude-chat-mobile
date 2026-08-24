// tests/unit/app-build.test.mjs —— scripts/app-build.js 的参数拼装
//
// Swift 源码本身没有自动化测试（这是引入第二技术栈时明示接受的代价，见方案的风险章节）。
// 能测的是构建这一侧：swiftc 的 flag 与 Info.plist 的变量集——两者写错的表现都很隐蔽
// （-parse-as-library 少了会编译失败还好，Info.plist 少个变量则会让 bundle 里出现字面量
// __REPO__，app 照常启动、只是永远找不到仓库）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { APP_SOURCES, formatBuildTime, infoPlistVars, shouldRemoveBuildArtifact, swiftTarget, swiftcArgs, typecheckArgs, autostartTargetPath } from '../../scripts/app-build.js';
import { renderTemplate, stripLeadingComment } from '../../scripts/render-plist.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ★ 每个 test 内部各自调用，**不要在 describe 顶层算一次共享值**：
// describe 的回调是同步执行的，顶层一旦抛错（比如签名变了），整块会炸掉、内部 test
// 一个都不注册 —— 而汇总只统计注册过的 test，于是显示成 `fail 0`。
// 这个陷阱在本仓真实发生过：swiftcArgs 从 source 改成 sources 时，
// `npm run test:unit` 报 `fail 0` 却以退出码 1 结束，差点被当成全绿。
const ARGS = () => swiftcArgs({ sources: ['/x/Core.swift', '/x/a.swift'], out: '/y/CCM' });

test.describe('swiftcArgs', () => {
  // 源码末尾是 @main struct + @MainActor，不加这个 flag 会被当 script 模式编译而失败。
  test('必须带 -parse-as-library', () => {
    assert.ok(ARGS().includes('-parse-as-library'));
  });

  test('链接 AppKit（NSStatusBar / NSMenu / NSAlert 都在里面）', () => {
    const args = ARGS();
    const i = args.indexOf('-framework');
    assert.ok(i >= 0 && args[i + 1] === 'AppKit');
  });

  test('测试构建不链 AppKit（CCMCore 是纯 Foundation，链了反而多一份依赖）', () => {
    const args = swiftcArgs({ sources: ['/x/Core.swift'], out: '/y/t', frameworks: [] });
    assert.ok(!args.includes('-framework'));
  });

  test('-o 后面紧跟输出路径，源码全部排在最后且保持顺序', () => {
    const args = ARGS();
    const i = args.indexOf('-o');
    assert.equal(args[i + 1], '/y/CCM');
    assert.deepEqual(args.slice(-2), ['/x/Core.swift', '/x/a.swift'], '多文件编译要按序传给 swiftc');
  });

  test('target 下限与 Info.plist 的 LSMinimumSystemVersion 一致（13.0）', () => {
    const args = ARGS();
    const i = args.indexOf('-target');
    assert.match(args[i + 1], /macos13\.0/);
    const tpl = readFileSync(join(ROOT, 'desktop/Info.plist.template'), 'utf8');
    assert.match(tpl, /<key>LSMinimumSystemVersion<\/key>\s*<string>13\.0<\/string>/);
  });

  // 写死 arm64 的话，Intel Mac 上会安静地交叉编译出 arm64 产物、codesign 通过、
  // 打印「✓ 已生成」，然后 open 报「不支持」—— 失败点离根因很远。
  test('target 架构按宿主派生，不写死 arm64', () => {
    assert.match(swiftTarget('arm64'), /^arm64-apple-macos/);
    assert.match(swiftTarget('x64'), /^x86_64-apple-macos/);
  });
});

test.describe('infoPlistVars', () => {
  // ★ 这条是真正扛事的：模板里每个 __XXX__ 都必须有对应的 key，否则 bundle 里会留下
  // 字面量占位符——app 照常启动，只是永远找不到仓库，而且没有任何报错。
  test('覆盖模板里的全部占位符', () => {
    const tpl = stripLeadingComment(readFileSync(join(ROOT, 'desktop/Info.plist.template'), 'utf8'));
    const placeholders = [...tpl.matchAll(/__([A-Z_]+)__/g)].map((m) => m[1]);
    assert.ok(placeholders.length > 0, '模板里应当有占位符');

    const vars = infoPlistVars({ version: '1.0.0', repo: '/r', node: '/n', buildTime: '2026-08-24 03:47', buildCommit: '39aea4f', buildNumber: '1787561239' });
    for (const p of new Set(placeholders)) {
      assert.ok(Object.hasOwn(vars, p), `infoPlistVars 缺少 ${p}`);
    }
  });

  test('渲染后不残留任何占位符', () => {
    const tpl = stripLeadingComment(readFileSync(join(ROOT, 'desktop/Info.plist.template'), 'utf8'));
    const out = renderTemplate(tpl, infoPlistVars({ version: '1.0.0', repo: '/r', node: '/n', buildTime: '2026-08-24 03:47', buildCommit: '39aea4f', buildNumber: '1787561239' }));
    assert.ok(!/__[A-Z_]+__/.test(out), `仍有占位符：${out.match(/__[A-Z_]+__/g)}`);
  });

  test('路径含 & 与空格时被 XML 转义（复用 render-plist 的 TC-009 保护）', () => {
    const tpl = stripLeadingComment(readFileSync(join(ROOT, 'desktop/Info.plist.template'), 'utf8'));
    const out = renderTemplate(tpl, infoPlistVars({
      version: '1.0.0',
      repo: '/Users/you/AT&T code/repo',
      node: '/n',
    }));
    assert.ok(out.includes('AT&amp;T code'), '& 必须转义，否则是非法 XML');
    assert.ok(!/&(?!amp;|lt;|gt;)/.test(out), '不应有未转义的裸 &');
  });

  test('LSUIElement 为真（无 Dock 图标，只在菜单栏出现）', () => {
    const tpl = readFileSync(join(ROOT, 'desktop/Info.plist.template'), 'utf8');
    assert.match(tpl, /<key>LSUIElement<\/key>\s*<true\/>/);
  });

  test('CFBundleExecutable 与构建产物的二进制文件名一致（写错则 bundle 起不来）', () => {
    const tpl = readFileSync(join(ROOT, 'desktop/Info.plist.template'), 'utf8');
    assert.match(tpl, /<key>CFBundleExecutable<\/key>\s*<string>CCM<\/string>/);
  });
});

// ── autostartTargetPath ────────────────────────────────────────────────────
// 2026-08-18 在机主真机上踩到：跑 npm run app:install 的人，看到的最后一条可复制命令
// 是 `service.js install menubar --app="<repo>/desktop/build/CCM.app"` —— 那条提示排在
// --install 分支【之前】，固定打印构建产物路径。照着做，开机自启就钉在一个 gitignore
// 的目录上，git clean / 换分支之后静默失效。
test.describe('autostartTargetPath', () => {
  const BUILD = '/Users/you/code/claude-chat-mobile/desktop/build/CCM.app';

  test('装进 /Applications 后自启指向那个稳定位置，不是刚才的构建产物', () => {
    assert.equal(autostartTargetPath(BUILD, { installed: true }), '/Applications/CCM.app');
  });

  test('只编译不安装 → 只能指向构建产物（调用方另给风险提示）', () => {
    assert.equal(autostartTargetPath(BUILD, { installed: false }), BUILD);
  });
});

// ── typecheckArgs ──────────────────────────────────────────────────────────
// 为什么需要它：npm run check 此前只编译 CCMCore + CCMProcess + 测试（TEST_SOURCES），
// 而三个 GUI 文件共 1842 行（占生产 Swift 的 67%）连语法都不过一遍——改坏了 check 照样全绿，
// 只有人手动跑 app:build 才暴露。全量 -typecheck 实测 1.5 秒，便宜到可以无条件进门禁。
test.describe('typecheckArgs', () => {
  const ARGS = () => typecheckArgs({ sources: ['/x/a.swift', '/x/b.swift'] });

  test('是 -typecheck 而不是 -o：只做类型检查，不产出任何文件', () => {
    const args = ARGS();
    assert.ok(args.includes('-typecheck'));
    assert.ok(!args.includes('-o'), '带 -o 就变成真编译了，会写 build 产物并慢一个数量级');
  });

  test('链接 AppKit —— GUI 文件里全是 NSMenu / NSAlert / NSWindow，不链必然报未定义', () => {
    const args = ARGS();
    const i = args.indexOf('-framework');
    assert.ok(i >= 0 && args[i + 1] === 'AppKit');
  });

  test('target 与真编译同源（按宿主派生），否则会检查一个跟产物不同的平台', () => {
    const args = ARGS();
    const i = args.indexOf('-target');
    assert.equal(args[i + 1], swiftTarget());
  });

  test('源码排在最后且保持顺序', () => {
    assert.deepEqual(ARGS().slice(-2), ['/x/a.swift', '/x/b.swift']);
  });
});

// ── APP_SOURCES 的完备性 ───────────────────────────────────────────────────
// ★ 这条才是编译闸真正的防线。typecheckArgs 只保证「传进去的文件被检查」，
// 保证不了「该传的都传了」——新加一个 desktop/*.swift 却忘了写进 APP_SOURCES，
// 那个文件既不进 app 也不进门禁，症状是「我明明写了代码，菜单里没有」。
test.describe('APP_SOURCES 覆盖 desktop 下每一个产品 .swift', () => {
  test('除测试断言集外，desktop/*.swift 全部在 APP_SOURCES 里', () => {
    const dir = join(ROOT, 'desktop');
    const onDisk = readdirSync(dir)
      .filter((f) => f.endsWith('.swift') && f !== 'ccm-menubar-tests.swift')
      .sort();
    const declared = APP_SOURCES.map((p) => p.split('/').pop()).sort();
    assert.deepEqual(declared, onDisk,
      '新增的 desktop/*.swift 必须同时写进 APP_SOURCES，否则它既不进 app 也不进编译闸');
  });
});

// ── shouldRemoveBuildArtifact ──────────────────────────────────────────────
// 2026-08-24 机主报「Spotlight 里老是有两个 CCM」。实测 LaunchServices 把两个 bundle
// 注册到了**同一个 identifier**（com.ccm.menubar）下：/Applications 那份和
// desktop/build 那份 —— 同名、同图标、同版本号，界面上分不出哪个是哪个。
// 根因是构建管线：app-build 永远先编到 desktop/build/CCM.app，--install 只是 ditto 一份
// 出去，中间产物从不删除。装完之后它已经没有用途了，只剩下制造二义性。
//
// 判据抽成纯函数而不是写在 main() 里，是因为判错的后果很重：**删掉一个正被开机自启
// 使用的 app**。判据留在取数侧就是零覆盖（改成无条件 return true 全套单测照样绿）。
test.describe('shouldRemoveBuildArtifact', () => {
  const BUILD_APP = '/Users/you/code/claude-chat-mobile/desktop/build/CCM.app';

  test('只编译不安装 → 保留：此时构建产物就是最终产物（getting-started 教的「先看一眼」那条路）', () => {
    const r = shouldRemoveBuildArtifact({ installed: false, buildAppPath: BUILD_APP });
    assert.equal(r.remove, false);
    assert.match(r.reason, /不安装|最终产物/);
  });

  test('装进 /Applications 且自启不指向它 → 删除', () => {
    const r = shouldRemoveBuildArtifact({
      installed: true, buildAppPath: BUILD_APP, autostartAppPath: '/Applications/CCM.app',
    });
    assert.equal(r.remove, true);
  });

  test('读不到自启配置（没装自启 / plutil 失败）→ 删除：清理是安全方向', () => {
    const r = shouldRemoveBuildArtifact({ installed: true, buildAppPath: BUILD_APP, autostartAppPath: null });
    assert.equal(r.remove, true);
  });

  // ★ 这一支是整条改动唯一会造成真实损害的路径：自启指向构建产物虽然是个已被
  //   service.js 警告过的状态，但它**仍然是能用的**，删掉就把它变成静默失效。
  test('自启正指向构建产物 → 保留，并说清楚要先重新勾一次自启', () => {
    const r = shouldRemoveBuildArtifact({
      installed: true, buildAppPath: BUILD_APP, autostartAppPath: BUILD_APP,
    });
    assert.equal(r.remove, false);
    assert.match(r.reason, /开机自启/);
  });

  test('尾斜杠不算两个路径：plist 里带 / 时同样要认出来', () => {
    const r = shouldRemoveBuildArtifact({
      installed: true, buildAppPath: BUILD_APP, autostartAppPath: `${BUILD_APP}/`,
    });
    assert.equal(r.remove, false, '尾斜杠没归一化就会删掉正在被自启使用的 app');
  });
});

// ── 构建身份 ───────────────────────────────────────────────────────────────
// 2026-08-24：机主问「Spotlight 里为什么两个 CCM」。实测两份 bundle 的
// CFBundleShortVersionString 完全相同（都是 package.json 的 1.6.0），LaunchServices 里
// 记的 version 字段也一样 —— 版本号在这个问题上**零判别力**。排障时只能去 stat 二进制
// 的 mtime。commit 与构建号才是能回答「我跑的是哪一份、含不含某个修复」的字段。
test.describe('构建身份', () => {
  test('formatBuildTime 补零到固定宽度（月/日/时/分个位数时最容易错）', () => {
    // 用固定 epoch 只断言形状：本地时区不同则具体数字不同，断言内容会脆。
    assert.match(formatBuildTime(1787561239000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.match(formatBuildTime(Date.UTC(2026, 0, 2, 3, 4)), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  test('CFBundleVersion 用构建号而不是 semver —— 否则两份 bundle 在 LS 里无从排序', () => {
    const tplPath = join(ROOT, 'desktop', 'Info.plist.template');
    const tpl = stripLeadingComment(readFileSync(tplPath, 'utf8'));
    const out = renderTemplate(tpl, infoPlistVars({
      version: '1.6.0', repo: '/r', node: '/n',
      buildTime: '2026-08-24 03:47', buildCommit: '39aea4f', buildNumber: '1787561239',
    }));
    assert.match(out, /<key>CFBundleVersion<\/key>\s*<string>1787561239<\/string>/);
    assert.match(out, /<key>CFBundleShortVersionString<\/key>\s*<string>1\.6\.0<\/string>/);
  });

  test('构建时间与 commit 都进 bundle：Swift 侧靠它们自证身份', () => {
    const tpl = stripLeadingComment(readFileSync(join(ROOT, 'desktop', 'Info.plist.template'), 'utf8'));
    const out = renderTemplate(tpl, infoPlistVars({
      version: '1.6.0', repo: '/r', node: '/n',
      buildTime: '2026-08-24 03:47', buildCommit: '39aea4f-dirty', buildNumber: '1787561239',
    }));
    assert.match(out, /<key>CCMBuildTime<\/key>\s*<string>2026-08-24 03:47<\/string>/);
    assert.match(out, /<key>CCMBuildCommit<\/key>\s*<string>39aea4f-dirty<\/string>/);
  });

  test('拿不到构建号时回落到 version —— 可观测性缺失不该产出空的 CFBundleVersion', () => {
    const vars = infoPlistVars({ version: '1.6.0', repo: '/r', node: '/n' });
    assert.equal(vars.BUILD_NUMBER, '1.6.0');
    assert.equal(vars.BUILD_COMMIT, 'unknown', '非 git 检出时必须是可识别的占位，不是空串');
  });
});
