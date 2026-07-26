import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  extractDictKeys,
  extractHtmlCopyKeys,
  extractTCallKeys,
  checkI18n,
} from '../../scripts/i18n-check.js';

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

test.describe('checkI18n：孤儿 key 扫描（EN_DICT 有、但代码/HTML 里再没引用）', () => {
  test('全部 key 都被引用 → 无 problems', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'public/js/i18n.js', `
      export const EN_DICT = Object.freeze({
        '设置': 'Settings',
        '提示音': 'Sound',
      });
    `);
    await writeFixture(root, 'public/index.html', `<span>提示音</span>`);
    await writeFixture(root, 'public/js/app.js', `someFn(t('设置'));`);

    const result = checkI18n({ rootDir: root });
    assert.deepEqual(result.problems, []);
  });

  test('词典里有但代码/HTML 都没再引用的 key → 报孤儿', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'public/js/i18n.js', `
      export const EN_DICT = Object.freeze({
        '设置': 'Settings',
        '已废弃的旧文案': 'Deprecated old copy',
      });
    `);
    await writeFixture(root, 'public/index.html', `<span>设置</span>`);

    const result = checkI18n({ rootDir: root });
    assert.deepEqual(result.problems.map(p => p.key), ['已废弃的旧文案']);
    assert.equal(result.problems[0].code, 'orphan_dict_key');
  });

  test('跨文件引用也算数（app.js 里 t()，另一个模块文件也算）', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'public/js/i18n.js', `
      export const EN_DICT = Object.freeze({ '保存': 'Save' });
    `);
    await writeFixture(root, 'public/index.html', '<div></div>');
    await writeFixture(root, 'public/js/app/file-browser.js', `btn.onclick = () => t('保存');`);

    const result = checkI18n({ rootDir: root });
    assert.deepEqual(result.problems, []);
  });

  // 查表式用法：t(SECTION_META[k].title) —— key 以裸字面量存在常量表里（顶层常量不能直接 t()，
  // 那会在 setLang() 之前求值），t() 只拿到变量。按 t('...') 抓引用会把这类 key 全判成孤儿。
  test("key 只作为常量表里的字面量出现、经 t(变量) 使用 → 不算孤儿", async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'public/js/i18n.js', `
      export const EN_DICT = Object.freeze({ '已暂存': 'Staged' });
    `);
    await writeFixture(root, 'public/index.html', '<div></div>');
    await writeFixture(root, 'public/js/app/git-changes.js', `
      const SECTION_META = [{ key: 'staged', title: '已暂存' }];
      export const render = () => append(t(SECTION_META[0].title));
    `);

    const result = checkI18n({ rootDir: root });
    assert.deepEqual(result.problems, []);
  });

  test('key 在源码里彻底不出现 → 仍报孤儿（放宽引用判定不等于关掉这道闸）', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'public/js/i18n.js', `
      export const EN_DICT = Object.freeze({ '谁也没引用的文案': 'Nobody references this' });
    `);
    await writeFixture(root, 'public/index.html', '<div></div>');
    await writeFixture(root, 'public/js/app.js', `const x = 1;`);

    const result = checkI18n({ rootDir: root });
    assert.deepEqual(result.problems.map(p => p.key), ['谁也没引用的文案']);
  });

  test('无 public 目录 / 空词典 → 不抛错，无 problems', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-empty-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'public/js/i18n.js', 'export const EN_DICT = Object.freeze({});');
    assert.doesNotThrow(() => checkI18n({ rootDir: root }));
  });
});
