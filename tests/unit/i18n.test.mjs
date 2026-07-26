// tests/unit/i18n.test.mjs —— public/js/i18n.js 运行时词典（零构建步骤，zh 原文即 key）。
// 核心契约：zh locale 下 t() 恒等——不改变任何既有断言中文文案的测试；en locale 下查字典，
// 未收录 key 静默回落中文（渐进式覆盖，不是"未翻译就报错"）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { t, setLang, getLang, resolveInitialLang, readLangPref, writeLangPref, LANG_STORAGE_KEY, EN_DICT } from '../../public/js/i18n.js';

test.afterEach(() => setLang('zh')); // 每个用例后复位，测试间不串扰全局 currentLang

test.describe('t()：zh 恒等 + en 查字典回落', () => {
  test('默认 zh locale → 原样返回任意中文（零开销，既有测试断言不受影响）', () => {
    assert.equal(t('给 Claude 发消息...'), '给 Claude 发消息...');
    assert.equal(t('这个 key 词典里没有也一样原样返回'), '这个 key 词典里没有也一样原样返回');
  });
  test('en locale + 词典命中 → 返回译文', () => {
    setLang('en');
    const zhKey = Object.keys(EN_DICT)[0];
    assert.ok(zhKey, 'EN_DICT 至少应有一条种子词条（阶段 1 起步）');
    assert.equal(t(zhKey), EN_DICT[zhKey]);
  });
  test('en locale + 词典未命中 → 静默回落中文原文（不是报错/占位符）', () => {
    setLang('en');
    assert.equal(t('尚未翻译的字符串'), '尚未翻译的字符串');
  });
  test('en locale + 输入撞上 Object.prototype 同名属性 → 仍原样回落，不返回继承函数', () => {
    setLang('en');
    assert.equal(t('constructor'), 'constructor');
    assert.equal(t('toString'), 'toString');
    assert.equal(t('hasOwnProperty'), 'hasOwnProperty');
  });
  test('非字符串/空输入安全', () => {
    assert.equal(t(''), '');
    assert.equal(t(null), null);
    assert.equal(t(undefined), undefined);
    setLang('en');
    assert.equal(t(''), '');
  });
});

test.describe('setLang / getLang', () => {
  test('非 en 的任意值一律归一成 zh（未知输入保底不炸英文）', () => {
    setLang('en');
    assert.equal(getLang(), 'en');
    setLang('fr');
    assert.equal(getLang(), 'zh');
    setLang(null);
    assert.equal(getLang(), 'zh');
  });
});

test.describe('readLangPref：读原始存储偏好（含 auto，不做 navigator 解析）', () => {
  test("显式存 'auto' → 原样返回，不折叠成 zh/en（区别于 resolveInitialLang/getLang）", () => {
    assert.equal(readLangPref(() => 'auto'), 'auto');
  });
  test("显式存 'zh' / 'en' → 原样返回", () => {
    assert.equal(readLangPref(() => 'zh'), 'zh');
    assert.equal(readLangPref(() => 'en'), 'en');
  });
  test('未设置过 / 非函数 getItem / 未知值 → 保底 zh', () => {
    assert.equal(readLangPref(() => null), 'zh');
    assert.equal(readLangPref(null), 'zh');
    assert.equal(readLangPref(() => 'garbage'), 'zh');
  });
});

test.describe('resolveInitialLang：启动时解析语言偏好', () => {
  test('未设置过（getItem 返回 null）→ 保底 zh（不静默变英文，最不惊讶）', () => {
    assert.equal(resolveInitialLang(() => null, 'en-US'), 'zh');
  });
  test("显式存 'zh' / 'en' → 直接用，不看 navigator.language", () => {
    assert.equal(resolveInitialLang(() => 'zh', 'en-US'), 'zh');
    assert.equal(resolveInitialLang(() => 'en', 'zh-CN'), 'en');
  });
  test("显式存 'auto' → 按 navigator.language 首段判定（en 开头→en，其余→zh）", () => {
    assert.equal(resolveInitialLang(() => 'auto', 'en-US'), 'en');
    assert.equal(resolveInitialLang(() => 'auto', 'en'), 'en');
    assert.equal(resolveInitialLang(() => 'auto', 'zh-CN'), 'zh');
    assert.equal(resolveInitialLang(() => 'auto', 'fr-FR'), 'zh');
    assert.equal(resolveInitialLang(() => 'auto', undefined), 'zh');
  });
  test('非函数 getItem / 未知存储值 → 保底 zh，不抛错', () => {
    assert.doesNotThrow(() => resolveInitialLang(null, 'en-US'));
    assert.equal(resolveInitialLang(null, 'en-US'), 'zh');
    assert.equal(resolveInitialLang(() => 'garbage', 'en-US'), 'zh');
  });
});

test.describe('writeLangPref', () => {
  test('写入固定 key', () => {
    const out = {};
    assert.equal(writeLangPref((k, v) => { out[k] = v; }, 'en'), true);
    assert.deepEqual(out, { [LANG_STORAGE_KEY]: 'en' });
  });
  test('非函数 setItem → 不写、返回 false，不抛错', () => {
    assert.equal(writeLangPref(null, 'en'), false);
    assert.doesNotThrow(() => writeLangPref(undefined, 'en'));
  });
});
