// tests/unit/app-build.test.mjs —— scripts/app-build.js 的参数拼装
//
// Swift 源码本身没有自动化测试（这是引入第二技术栈时明示接受的代价，见方案的风险章节）。
// 能测的是构建这一侧：swiftc 的 flag 与 Info.plist 的变量集——两者写错的表现都很隐蔽
// （-parse-as-library 少了会编译失败还好，Info.plist 少个变量则会让 bundle 里出现字面量
// __REPO__，app 照常启动、只是永远找不到仓库）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { infoPlistVars, swiftcArgs } from '../../scripts/app-build.js';
import { renderTemplate, stripLeadingComment } from '../../scripts/render-plist.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test.describe('swiftcArgs', () => {
  const args = swiftcArgs({ source: '/x/a.swift', out: '/y/CCM' });

  // 源码末尾是 @main struct + @MainActor，不加这个 flag 会被当 script 模式编译而失败。
  test('必须带 -parse-as-library', () => {
    assert.ok(args.includes('-parse-as-library'));
  });

  test('链接 AppKit（NSStatusBar / NSMenu / NSAlert 都在里面）', () => {
    const i = args.indexOf('-framework');
    assert.ok(i >= 0 && args[i + 1] === 'AppKit');
  });

  test('-o 后面紧跟输出路径，源码在最后', () => {
    const i = args.indexOf('-o');
    assert.equal(args[i + 1], '/y/CCM');
    assert.equal(args.at(-1), '/x/a.swift');
  });

  test('target 下限与 Info.plist 的 LSMinimumSystemVersion 一致（13.0）', () => {
    const i = args.indexOf('-target');
    assert.match(args[i + 1], /macos13\.0/);
    const tpl = readFileSync(join(ROOT, 'desktop/Info.plist.template'), 'utf8');
    assert.match(tpl, /<key>LSMinimumSystemVersion<\/key>\s*<string>13\.0<\/string>/);
  });
});

test.describe('infoPlistVars', () => {
  // ★ 这条是真正扛事的：模板里每个 __XXX__ 都必须有对应的 key，否则 bundle 里会留下
  // 字面量占位符——app 照常启动，只是永远找不到仓库，而且没有任何报错。
  test('覆盖模板里的全部占位符', () => {
    const tpl = stripLeadingComment(readFileSync(join(ROOT, 'desktop/Info.plist.template'), 'utf8'));
    const placeholders = [...tpl.matchAll(/__([A-Z_]+)__/g)].map((m) => m[1]);
    assert.ok(placeholders.length > 0, '模板里应当有占位符');

    const vars = infoPlistVars({ version: '1.0.0', repo: '/r', node: '/n' });
    for (const p of new Set(placeholders)) {
      assert.ok(Object.hasOwn(vars, p), `infoPlistVars 缺少 ${p}`);
    }
  });

  test('渲染后不残留任何占位符', () => {
    const tpl = stripLeadingComment(readFileSync(join(ROOT, 'desktop/Info.plist.template'), 'utf8'));
    const out = renderTemplate(tpl, infoPlistVars({ version: '1.0.0', repo: '/r', node: '/n' }));
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
