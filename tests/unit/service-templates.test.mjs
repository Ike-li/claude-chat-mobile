// tests/unit/service-templates.test.mjs —— desktop/launchd/*.plist.template 与 UNITS 表的契约
//
// 为什么单独一个文件：service-units.test.mjs 是**纯逻辑**测试（全部依赖可注入、一个字节都不碰盘），
// 本文件恰恰相反 —— 它故意走 scripts/service.js 里那条真实渲染路径（readFileSync 真模板 →
// renderTemplate），混进去会模糊那个文件的定位。
//
// 为什么需要它：service.js 的 renderPlist 是可注入 dep，所有 service-* 测试注入的都是假实现，
// 于是**真实渲染路径至今零测试**。后果有两档：
//
//   1. 响的：desktop/launchd/ 下的模板被当成纯文档示例删掉或挪走 —— service.js:4 的头注还记着
//      「此前有三份模板但没有一行代码调用 launchctl」，而 19222c7 之后它们成了 install 的
//      运行时数据源。删掉之后 test:unit 全绿，只有 inventory 因清单变化报 stale；
//      顺手跑一次 inventory:update 就一路绿到用户点「安装服务」才炸。
//   2. 静默的：占位符名写错时 renderTemplate 找不到就什么都不做，产出一份**合法但缺字段**的
//      plist —— plutil -lint 过、bootstrap 可能也成功，服务却指向错的路径。
//
// 所以下面四条断言里，第三条（产物含渲染后的真实值）价值最高：前两条抓炸得很响的错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVICE_UNIT_NAMES, renderVarsFor, templateFor } from '../../app/src/ops/service-units.js';
import { renderTemplate, stripLeadingComment } from '../../scripts/render-plist.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 覆盖全部 unit 需要的 ctx。值刻意取得好认（/ccm-repo 这类），断言才能验「这个值真的进去了」
// 而不是只验「没有残留占位符」—— 后者对「替换成空字符串」这个失败模式是瞎的。
const CTX = Object.freeze({
  repo: '/ccm-repo',
  node: '/ccm-node/bin/node',
  home: '/ccm-home',
  app: '/ccm-app/CCM.app',
  cloudflared: '/ccm-bin/cloudflared',
  tunnel: 'ccm-tunnel-name',
});

function renderReal(unit) {
  const raw = readFileSync(join(ROOT, templateFor(unit)), 'utf8');
  return renderTemplate(stripLeadingComment(raw), renderVarsFor(unit, CTX));
}

test.describe('desktop/launchd/*.plist.template ⇔ UNITS 表', () => {
  test('UNITS 表非空 —— 否则下面的 for 循环会静默零断言通过', () => {
    assert.ok(SERVICE_UNIT_NAMES.length >= 4, `期望至少 4 个 unit，实际 ${SERVICE_UNIT_NAMES.length}`);
  });

  for (const unit of SERVICE_UNIT_NAMES) {
    test(`${unit}: 模板文件存在`, () => {
      const rel = templateFor(unit);
      assert.ok(
        existsSync(join(ROOT, rel)),
        `${rel} 不存在。scripts/service.js:71 无条件 readFileSync 它 —— 缺了不会在这里报，`
        + '会在用户点「安装服务」那一刻才炸。',
      );
    });

    test(`${unit}: 渲染后没有残留占位符`, () => {
      const out = renderReal(unit);
      const leftover = [...out.matchAll(/__([A-Z_]+)__/g)].map((m) => m[0]);
      assert.deepEqual(
        leftover,
        [],
        `模板里有 UNITS[${unit}].vars 没声明的占位符：${leftover.join(', ')}`,
      );
    });

    // 第三条：抓「占位符名写错 → 替换成空 → 合法但缺字段」。上一条对此完全瞎，
    // 因为写错名字的那个占位符根本不叫 __X__ 的形态残留下来，它压根没被匹配到。
    test(`${unit}: 渲染后的值真的出现在产物里`, () => {
      const out = renderReal(unit);
      for (const [key, value] of Object.entries(renderVarsFor(unit, CTX))) {
        assert.ok(
          typeof value === 'string' && value.length > 0,
          `${unit} 的 ${key} 是空值 —— renderVarsFor 的 ctx 键名与 UNITS.vars 对不上`,
        );
        assert.ok(out.includes(value), `${unit} 渲染产物里找不到 ${key} 的值（${value}）`);
      }
    });
  }
});

// plutil 是 macOS 自带；Linux CI（test:docker）上没有，跳过而不是假装通过。
// 上面三条平台无关的断言已经覆盖主要失败模式，这条补的是「模板被改成非法 XML」。
test.describe('渲染产物是合法 plist（仅 macOS）', { skip: process.platform !== 'darwin' }, () => {
  for (const unit of SERVICE_UNIT_NAMES) {
    test(`${unit}: plutil -lint 通过`, () => {
      const r = spawnSync('/usr/bin/plutil', ['-lint', '-'], {
        input: renderReal(unit),
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(r.status, 0, `plutil 拒绝了 ${unit} 的渲染产物：${r.stdout || ''}${r.stderr || ''}`);
    });
  }
});
