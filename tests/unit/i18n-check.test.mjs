import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  extractDictKeys,
  extractDataI18nKeys,
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

test.describe('extractDataI18nKeys：解析 HTML 里 [data-i18n] 元素的文本', () => {
  test('抽出简单文本节点', () => {
    const html = `<div><span class="a" data-i18n>提示音</span><span data-i18n>震动</span></div>`;
    assert.deepEqual(extractDataI18nKeys(html), ['提示音', '震动']);
  });
  test('data-i18n-placeholder 等前缀相似属性不会被误当作 data-i18n（词边界判定）', () => {
    const html = `<input data-i18n-placeholder="占位符文本">`;
    assert.deepEqual(extractDataI18nKeys(html), []);
  });
  test('空文本节点跳过（如占位符空 span）', () => {
    const html = `<span data-i18n></span>`;
    assert.deepEqual(extractDataI18nKeys(html), []);
  });
  test('无 data-i18n → 空数组', () => {
    assert.deepEqual(extractDataI18nKeys('<div>普通文本</div>'), []);
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
    await writeFixture(root, 'public/index.html', `<span data-i18n>提示音</span>`);
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
    await writeFixture(root, 'public/index.html', `<span data-i18n>设置</span>`);

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

  test('无 public 目录 / 空词典 → 不抛错，无 problems', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ccm-i18n-empty-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFixture(root, 'public/js/i18n.js', 'export const EN_DICT = Object.freeze({});');
    assert.doesNotThrow(() => checkI18n({ rootDir: root }));
  });
});
