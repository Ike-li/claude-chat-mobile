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
//      运行时数据源。删掉之后【全仓没有一处会红】：test:unit 全绿，inventory 也不会响——它查的是
//      「有没有未分类文件」，不是「登记过的文件还在不在」。一路绿到用户点「安装服务」才炸。
//      下面这几条断言是这条路径上唯一的守卫。
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

import {
  SERVICE_UNIT_NAMES, renderVarsFor, templateFor,
  extractUnitFacts, expectedFactsFor, diffUnitSemantics,
} from '../../app/src/ops/service-units.js';
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

// desktop/launchd/server.plist.template 的启动命令（`exec "__SHQ_NODE__" app/server.js`）与
// app/src/ops/service-units.js 解析它取 repo/node 的正则，CLAUDE.md 点名【必须逐字一致】——
// 漏改一边会让服务面板的 repo/node 字段静默变成 null，且此前没有任何门禁或测试盯着这条不变量：
// 三份相关测试要么只测占位符替换（上面这组）、要么用内联字符串夹具、要么用硬编码的 plist 夹具，
// 没有一条真的把渲染产物喂给解析器。这里补上真模板渲染 → 平台无关解析 → 与
// expectedFactsFor 逐字段比对，diffUnitSemantics 必须为空数组。
//
// 【为什么不用 plutil】上面那组「合法 plist」检查已经跳过了非 macOS——这条要在 CI（Linux 容器）
// 上也生效，所以直接在渲染出的 XML 文本里用正则取 <key>/<string>/<array> 三种节点、解 XML 实体，
// 不依赖任何系统工具。只覆盖本仓模板实际用到的这几种节点形状，不是通用 plist 解析器。
// 【必须单遍替换】链式 .replace() 会二次解码：先把 &amp; 换成 &，下一步的 /&lt;/ 就能命中
// 刚产出的那个 &，于是字面量文本 `&lt;`（正确转义形态是 &amp;lt;）被解成 `<`。
// CodeQL 的 js/double-escaping 把这条判成高危，判得对——一遍扫完、每个实体只经手一次即可根治。
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXmlEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => XML_ENTITIES[name]);
}
function parsePlistXmlDict(xml) {
  const obj = {};
  const re = /<key>([^<]+)<\/key>\s*(?:<string>([\s\S]*?)<\/string>|(<true\/>)|(<false\/>)|<array>([\s\S]*?)<\/array>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const [, key, str, isTrue, isFalse, arr] = m;
    if (str !== undefined) obj[key] = decodeXmlEntities(str);
    else if (isTrue) obj[key] = true;
    else if (isFalse) obj[key] = false;
    else if (arr !== undefined) {
      obj[key] = [...arr.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((s) => decodeXmlEntities(s[1]));
    }
  }
  return obj;
}

// 钉住「单遍」本身，而不只是钉住当前模板恰好没有这种内容：链式 replace 写法下
// `&amp;lt;`（字面量文本 `&lt;` 的正确转义形态）会被解成 `<`，多解了一层。
test('decodeXmlEntities 单遍解码：&amp;lt; 还原成字面量 &lt;，不得二次解成 <', () => {
  assert.equal(decodeXmlEntities('&amp;lt;'), '&lt;', '二次解码会给出 "<"');
  assert.equal(decodeXmlEntities('a &amp;amp; b'), 'a &amp; b');
  assert.equal(decodeXmlEntities('&lt;key&gt;'), '<key>', '正常单层实体仍要正确还原');
  assert.equal(decodeXmlEntities('&quot;x&quot; &apos;y&apos;'), '"x" \'y\'');
});

test.describe('模板渲染产物与 service-units.js 的解析语义逐字段一致（不依赖 plutil，全平台生效）', () => {
  for (const unit of SERVICE_UNIT_NAMES) {
    test(`${unit}: diffUnitSemantics 为空`, () => {
      const parsed = parsePlistXmlDict(renderReal(unit));
      const actual = extractUnitFacts(unit, parsed);
      const expected = expectedFactsFor(unit, CTX);
      assert.deepEqual(
        diffUnitSemantics(unit, expected, actual), [],
        `真模板渲染后解析出的语义与期望值不一致：actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
      );
    });
  }

  // 证伪：模拟「入口又挪了一次、只改了模板这一边」——service-units.js 的解析正则原样不动。
  // 不碰真实模板文件，只在内存里改一份副本喂进同一条渲染→解析→比对流水线。
  test('server: 入口从 app/server.js 挪到别处而两边只改一边 → 必须被抓出漂移', () => {
    const raw = readFileSync(join(ROOT, templateFor('server')), 'utf8')
      .replace('app/server.js', 'app/main.js');
    const rendered = renderTemplate(stripLeadingComment(raw), renderVarsFor('server', CTX));
    const actual = extractUnitFacts('server', parsePlistXmlDict(rendered));
    assert.equal(actual.repo, null, '解析器认的后缀已经不再匹配，repo 应解不出来（服务面板会静默显示 null）');
    assert.equal(actual.node, null);
    assert.deepEqual(
      diffUnitSemantics('server', expectedFactsFor('server', CTX), actual), ['shape'],
      '两个关键字段都解不出来时按 shape 漂移报告，不是逐字段比对出一堆 null≠值 的噪音',
    );
  });
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
