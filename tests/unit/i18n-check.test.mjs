// tests/unit/i18n-check.test.mjs —— i18n 门禁自身的解析正确性
// 被测的是 tests/gates/i18n-check.js。两个方向都查：孤儿 key（字典有、代码里没人用）与
// 未翻译 key（t() 用了中文原文、字典里没有）。后者 2026-09-24 才加：此前「未翻译静默回落中文」
// 被当作设计内行为，/rewind 面板上线时 30 条文案漏翻 26 条，没有任何东西报出来。
// 覆盖：EN_DICT key 抽取 · HTML 可翻译文案抽取（含中文文本节点，不需要 data-i18n 标注）
//       · JS 里 t( 调用的 key 抽取 · 孤儿 key 扫描 · 未翻译 key 扫描 · 无 EN_DICT 时返回空而不抛
// 不测什么：index.html 静态文案的译文完整性——那边有两条有意不译（语言名「中文」、「语言 / Language」），
//           本门禁只管 t() 文案
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  extractDictKeys,
  extractHtmlCopyKeys,
  extractTCallKeys,
  stripJsComments,
  checkI18n,
} from '../../tests/gates/i18n-check.js';

async function writeFixture(root, relativePath, text) {
  const file = join(root, relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

test.describe('extractDictKeys：解析 i18n.js 的 EN_DICT key', () => {
  test('抽出单引号字符串 key，忽略值', () => {
    const src = `
      export const EN_DICT = Object.freeze({
        '设置': 'Settings',
        '发送': 'Send',
      });
    `;
    assert.deepEqual(extractDictKeys(src), ['设置', '发送']);
  });
  test('空字典 → 空数组', () => {
    assert.deepEqual(extractDictKeys('export const EN_DICT = Object.freeze({\n});'), []);
  });
  test('无 EN_DICT → 空数组，不抛错', () => {
    assert.doesNotThrow(() => extractDictKeys('export const x = 1;'));
    assert.deepEqual(extractDictKeys('export const x = 1;'), []);
  });
});

// 运行时是整树扫描（applyI18nToDocument），所以静态串「用没用到」的判定也必须整树来算：
// 任何含中文的文本节点/可翻译属性都算引用，不再依赖 data-i18n 标注。
test.describe('extractHtmlCopyKeys：解析 HTML 里全部可翻译文案', () => {
  test('抽出所有含中文的文本节点，无需 data-i18n 标注', () => {
    const html = `<div><span class="a">提示音</span><span>震动</span></div>`;
    assert.deepEqual(extractHtmlCopyKeys(html), ['提示音', '震动']);
  });
  test('抽出 title / placeholder / aria-label / alt 属性值', () => {
    const html = `<input placeholder="粘贴 AUTH_TOKEN"><button title="创建新会话" aria-label="新建"><img alt="附件预览"></button>`;
    assert.deepEqual(
      extractHtmlCopyKeys(html).sort(),
      ['创建新会话', '新建', '粘贴 AUTH_TOKEN', '附件预览'].sort(),
    );
  });
  test('纯英文/纯符号文本不入 key（词典 key 恒为中文原文）', () => {
    assert.deepEqual(extractHtmlCopyKeys('<div>English</div><span>✕</span><b>GitHub →</b>'), []);
  });
  test('HTML 注释与 script/style 内容跳过（是代码与说明，不是界面文案）', () => {
    const html = `<!-- 这是注释文案 --><script>const s = '脚本里的中文';</script><style>/* 样式注释 */</style><p>正文</p>`;
    assert.deepEqual(extractHtmlCopyKeys(html), ['正文']);
  });
  test('HTML 实体解码后才是 key（运行时 DOM 里拿到的是解码值）', () => {
    assert.deepEqual(extractHtmlCopyKeys('<div>执行 &lt;ID&gt; 命令</div>'), ['执行 <ID> 命令']);
  });
  test('空文本 / 空属性跳过，不抛错', () => {
    assert.deepEqual(extractHtmlCopyKeys('<span></span><input placeholder="">'), []);
    assert.doesNotThrow(() => extractHtmlCopyKeys(''));
  });
});

test.describe('extractTCallKeys：解析 JS 里 t(\'...\') 调用的字面量参数', () => {
  test('单引号/双引号/模板字符串（无插值）都能抽到', () => {
    const src = `
      t('单引号文案');
      t("双引号文案");
      const x = t(\`模板字符串文案\`);
    `;
    assert.deepEqual(extractTCallKeys(src), ['单引号文案', '双引号文案', '模板字符串文案']);
  });
  test('非字符串字面量参数（变量）不抽取，不抛错；三元表达式须写成 cond ? t(\'a\') : t(\'b\') 才能各自被抓到', () => {
    assert.deepEqual(extractTCallKeys(`t(dynamicVar);`), []);
    assert.deepEqual(extractTCallKeys(`cond ? t('a') : t('b');`), ['a', 'b']);
  });
  test('无 t() 调用 → 空数组', () => {
    assert.deepEqual(extractTCallKeys('const t = 1;'), []);
  });
});

// 未翻译检查只看代码，先剥注释。剥错的两个方向代价不同：少剥 → 注释里的例子被当成漏译（红，看得见）；
// 多剥 → 把字符串里的 // 当成注释，同一行后面真正的 t() 被一起剥掉（静默漏检）。下面三条守的都是后者。
test.describe('stripJsComments：剥掉注释，不碰字符串 / 模板 / 正则里的 // 与 /*', () => {
  test('行注释与块注释换成等长空白：总长度与换行位置不变', () => {
    const src = "a(); // 注释 t('甲')\n/* 块\n注释 t('乙') */ b();";
    const out = stripJsComments(src);
    assert.equal(out.length, src.length);
    assert.deepEqual([...out].map((c, i) => (c === '\n' ? i : -1)).filter(i => i >= 0),
      [...src].map((c, i) => (c === '\n' ? i : -1)).filter(i => i >= 0));
    assert.deepEqual(extractTCallKeys(out), []);
    assert.match(out, /a\(\);/);
    assert.match(out, /b\(\);/);
  });

  test("字符串与模板（含 ${} 里嵌套的模板）中的 // 不是注释：同一行后面的 t() 照样抓得到", () => {
    const src = "const u = 'https://a.example/x'; f(t('甲'));\n"
      + 'const v = `${ok ? `//b` : "c"} ${t(\'乙\')}`; g(t(\'丙\')); // 尾注释 t(\'丁\')';
    assert.deepEqual(extractTCallKeys(stripJsComments(src)), ['甲', '乙', '丙']);
  });

  test('正则字面量里的 // 与引号不是注释也不是字符串', () => {
    const src = "const re = /[\"']\\/\\/x/g; h(t('甲')); // 尾注释 t('乙')";
    assert.deepEqual(extractTCallKeys(stripJsComments(src)), ['甲']);
  });
});

test.describe('checkI18n：孤儿 key 扫描（EN_DICT 有、但代码/HTML 里再没引用）', () => {
  test('全部 key 都被引用 → 无 problems', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'app/public/js/i18n.js', `
      export const EN_DICT = Object.freeze({
        '设置': 'Settings',
        '提示音': 'Sound',
      });
    `);
    await writeFixture(root, 'app/public/index.html', `<span>提示音</span>`);
    await writeFixture(root, 'app/public/js/app.js', `someFn(t('设置'));`);

    const result = checkI18n({ rootDir: root });
    assert.deepEqual(result.problems, []);
  });

  test('词典里有但代码/HTML 都没再引用的 key → 报孤儿', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'app/public/js/i18n.js', `
      export const EN_DICT = Object.freeze({
        '设置': 'Settings',
        '已废弃的旧文案': 'Deprecated old copy',
      });
    `);
    await writeFixture(root, 'app/public/index.html', `<span>设置</span>`);

    const result = checkI18n({ rootDir: root });
    assert.deepEqual(result.problems.map(p => p.key), ['已废弃的旧文案']);
    assert.equal(result.problems[0].code, 'orphan_dict_key');
  });

  test('跨文件引用也算数（app.js 里 t()，另一个模块文件也算）', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'app/public/js/i18n.js', `
      export const EN_DICT = Object.freeze({ '保存': 'Save' });
    `);
    await writeFixture(root, 'app/public/index.html', '<div></div>');
    await writeFixture(root, 'app/public/js/app/file-browser.js', `btn.onclick = () => t('保存');`);

    const result = checkI18n({ rootDir: root });
    assert.deepEqual(result.problems, []);
  });

  // 查表式用法：t(SECTION_META[k].title) —— key 以裸字面量存在常量表里（顶层常量不能直接 t()，
  // 那会在 setLang() 之前求值），t() 只拿到变量。按 t('...') 抓引用会把这类 key 全判成孤儿。
  test("key 只作为常量表里的字面量出现、经 t(变量) 使用 → 不算孤儿", async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'app/public/js/i18n.js', `
      export const EN_DICT = Object.freeze({ '已暂存': 'Staged' });
    `);
    await writeFixture(root, 'app/public/index.html', '<div></div>');
    await writeFixture(root, 'app/public/js/app/git-changes.js', `
      const SECTION_META = [{ key: 'staged', title: '已暂存' }];
      export const render = () => append(t(SECTION_META[0].title));
    `);

    const result = checkI18n({ rootDir: root });
    assert.deepEqual(result.problems, []);
  });

  test('key 在源码里彻底不出现 → 仍报孤儿（放宽引用判定不等于关掉这道闸）', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'app/public/js/i18n.js', `
      export const EN_DICT = Object.freeze({ '谁也没引用的文案': 'Nobody references this' });
    `);
    await writeFixture(root, 'app/public/index.html', '<div></div>');
    await writeFixture(root, 'app/public/js/app.js', `const x = 1;`);

    const result = checkI18n({ rootDir: root });
    assert.deepEqual(result.problems.map(p => p.key), ['谁也没引用的文案']);
  });

  test('无 public 目录 / 空词典 → 不抛错，无 problems', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-empty-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'app/public/js/i18n.js', 'export const EN_DICT = Object.freeze({});');
    assert.doesNotThrow(() => checkI18n({ rootDir: root }));
  });
});

test.describe('checkI18n：t() 用到的中文原文必须有英文译文（未翻译 key）', () => {
  const untranslatedOf = result => result.problems.filter(p => p.code === 'untranslated_t_key');

  test('t() 用了、EN_DICT 里没有的中文 key → 报 untranslated_t_key，列出用到它的文件，同一 key 只报一条', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-untr-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'app/public/js/i18n.js', `
      export const EN_DICT = Object.freeze({ '设置': 'Settings' });
    `);
    await writeFixture(root, 'app/public/index.html', '<div></div>');
    await writeFixture(root, 'app/public/js/app.js', `someFn(t('设置')); bar(t('新加的文案'));`);
    await writeFixture(root, 'app/public/js/app/panel.js', `el.textContent = t('新加的文案');`);

    const untranslated = untranslatedOf(checkI18n({ rootDir: root }));
    assert.deepEqual(untranslated.map(p => p.key), ['新加的文案'],
      '漏掉它，英文界面就会静默显示中文原文——正是 /rewind 面板 26 条漏翻没人发现的形态');
    assert.deepEqual(untranslated[0].files, ['app/public/js/app.js', 'app/public/js/app/panel.js'],
      '报错要指到文件，否则补译文的人得全仓搜这句中文');
  });

  test('不含中文的 t() 参数不要求译文（词典 key 恒为中文原文）', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-untr-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'app/public/js/i18n.js', 'export const EN_DICT = Object.freeze({});');
    await writeFixture(root, 'app/public/index.html', '<div></div>');
    await writeFixture(root, 'app/public/js/app.js', `a(t('Mock')); b(t('{n}/{total}'));`);

    assert.deepEqual(untranslatedOf(checkI18n({ rootDir: root })), []);
  });

  test('词典文件 i18n.js 自身注释里的 t() 用法示例不算用到', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-untr-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'app/public/js/i18n.js', `
      // 各模块包 t('原文')；未收录的 key 运行时回落中文
      export const EN_DICT = Object.freeze({});
    `);
    await writeFixture(root, 'app/public/index.html', '<div></div>');

    assert.deepEqual(untranslatedOf(checkI18n({ rootDir: root })), [],
      '把说明文字里的示例当成界面文案，这道闸会对着一段注释永远红');
  });

  // 顶层常量表不能直接 t()（会在 setLang() 之前求值），于是表里存中文、到取用点 t(变量)——这类 key
  // 从 t(...) 的实参上抽不到。表值用恒等的 tk('原文') 包一层，门禁才看得见（PR #175 review）。
  test("常量表里用 tk('原文') 标记、经 t(变量) 显示的中文 → 同样要求有译文", async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-untr-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'app/public/js/i18n.js', `
      export const EN_DICT = Object.freeze({ '本机': 'This machine' });
    `);
    await writeFixture(root, 'app/public/index.html', '<div></div>');
    await writeFixture(root, 'app/public/js/logic/service-diag.js', `
      const SCOPE_LABEL = { local: tk('本机'), lan: tk('局域网') };
      export const label = scope => t(SCOPE_LABEL[scope]);
    `);

    const untranslated = untranslatedOf(checkI18n({ rootDir: root }));
    assert.deepEqual(untranslated.map(p => p.key), ['局域网'],
      '表里新加一条没配译文，英文界面会显示中文——这正是 t(变量) 那条路原先完全看不见的漏译');
  });

  test("任何模块注释里的 t('中文') 用法说明都不算用到", async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-untr-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'app/public/js/i18n.js', 'export const EN_DICT = Object.freeze({});');
    await writeFixture(root, 'app/public/index.html', '<div></div>');
    await writeFixture(root, 'app/public/js/app/panel.js', `
      // 三元写成 cond ? t('开') : t('关') 才能各自被抓到
      /* 旧写法 t('已废弃的说明') 不要再用 */
      const url = 'https://example.com/a'; // 行尾注释 t('行尾示例')
      export const x = url;
    `);

    assert.deepEqual(untranslatedOf(checkI18n({ rootDir: root })), [],
      '注释不是界面文案；当真的话，谁在注释里举个例子，必需的 check 就红了');
  });

  test('有意不译的文案不包 t()（如语言名「中文」与旁边的 English），不算未翻译', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-untr-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'app/public/js/i18n.js', 'export const EN_DICT = Object.freeze({});');
    await writeFixture(root, 'app/public/index.html', '<div></div>');
    await writeFixture(root, 'app/public/js/logic/general-nav.js',
      `const label = { zh: '中文', en: 'English' }[lang];`);

    assert.deepEqual(untranslatedOf(checkI18n({ rootDir: root })), []);
  });
});
