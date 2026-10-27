// tests/unit/logic-theme.test.mjs —— 本机主题偏好（浅色 / 深色 / 跟随系统）纯判定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  THEME_STORAGE_KEY,
  THEME_COLORS,
  readThemePref,
  writeThemePref,
  resolveTheme,
  themeHtmlAttribute,
  themePrefLabelKey,
} from '../../app/public/js/logic/theme.js';
import { applyThemeToDocument } from '../../app/public/js/theme.js';

const HERE = import.meta.dirname;
const bootSrc = readFileSync(join(HERE, '../../app/public/js/theme-boot.js'), 'utf8');

test('THEME_STORAGE_KEY 与 theme-boot.js 字面量一致（boot 不能 import module）', () => {
  assert.equal(THEME_STORAGE_KEY, 'ccm_theme');
  assert.match(bootSrc, /localStorage\.getItem\(['"]ccm_theme['"]\)/);
});

test('THEME_COLORS 与 index.html theme-color / :root --canvas 同源', () => {
  assert.equal(THEME_COLORS.light, '#F4F3EE');
  assert.equal(THEME_COLORS.dark, '#121211');
});

test.describe('readThemePref', () => {
  test("显式 light/dark/system → 原样", () => {
    assert.equal(readThemePref(() => 'light'), 'light');
    assert.equal(readThemePref(() => 'dark'), 'dark');
    assert.equal(readThemePref(() => 'system'), 'system');
  });
  test('未设 / 垃圾值 → system（升级最小惊讶：仍跟随系统）', () => {
    assert.equal(readThemePref(() => null), 'system');
    assert.equal(readThemePref(null), 'system');
    assert.equal(readThemePref(() => 'auto'), 'system');
    assert.equal(readThemePref(() => 'garbage'), 'system');
  });
});

test.describe('writeThemePref', () => {
  test('写入合法值', () => {
    const out = {};
    assert.equal(writeThemePref((k, v) => { out[k] = v; }, 'dark'), true);
    assert.deepEqual(out, { [THEME_STORAGE_KEY]: 'dark' });
  });
  test('非法值回落 system；无 setItem 不炸', () => {
    const out = {};
    writeThemePref((k, v) => { out[k] = v; }, 'nope');
    assert.equal(out[THEME_STORAGE_KEY], 'system');
    assert.equal(writeThemePref(null, 'dark'), false);
  });
});

test.describe('resolveTheme / themeHtmlAttribute', () => {
  test('强制档忽略 systemDark', () => {
    assert.equal(resolveTheme('light', true), 'light');
    assert.equal(resolveTheme('dark', false), 'dark');
    assert.equal(themeHtmlAttribute('light'), 'light');
    assert.equal(themeHtmlAttribute('dark'), 'dark');
  });
  test('system 跟随 systemDark；html 属性为 null（调用方 removeAttribute）', () => {
    assert.equal(resolveTheme('system', true), 'dark');
    assert.equal(resolveTheme('system', false), 'light');
    assert.equal(themeHtmlAttribute('system'), null);
    assert.equal(themeHtmlAttribute('nope'), null);
  });
});

test('themePrefLabelKey 给出中文 key（调用方再 t()）', () => {
  assert.equal(themePrefLabelKey('light'), '浅色');
  assert.equal(themePrefLabelKey('dark'), '深色');
  assert.equal(themePrefLabelKey('system'), '跟随系统');
});

function fakeDoc() {
  const attrs = new Map();
  const metas = [
    { name: 'theme-color', palette: 'light', media: '(prefers-color-scheme: light)', content: '#F4F3EE', getAttribute(k) { if (k === 'data-ccm-palette') return this.palette; if (k === 'media') return this.media; if (k === 'content') return this.content; return null; }, setAttribute(k, v) { if (k === 'media') this.media = v; if (k === 'content') this.content = v; if (k === 'data-ccm-palette') this.palette = v; }, removeAttribute(k) { if (k === 'media') this.media = null; } },
    { name: 'theme-color', palette: 'dark', media: '(prefers-color-scheme: dark)', content: '#121211', getAttribute(k) { if (k === 'data-ccm-palette') return this.palette; if (k === 'media') return this.media; if (k === 'content') return this.content; return null; }, setAttribute(k, v) { if (k === 'media') this.media = v; if (k === 'content') this.content = v; if (k === 'data-ccm-palette') this.palette = v; }, removeAttribute(k) { if (k === 'media') this.media = null; } },
  ];
  const links = {
    hljsThemeLight: { media: '(prefers-color-scheme: light)', getAttribute(k) { return k === 'media' ? this.media : null; }, setAttribute(k, v) { if (k === 'media') this.media = v; }, removeAttribute(k) { if (k === 'media') this.media = null; } },
    hljsThemeDark: { media: '(prefers-color-scheme: dark)', getAttribute(k) { return k === 'media' ? this.media : null; }, setAttribute(k, v) { if (k === 'media') this.media = v; }, removeAttribute(k) { if (k === 'media') this.media = null; } },
  };
  return {
    documentElement: {
      setAttribute(k, v) { attrs.set(k, v); },
      removeAttribute(k) { attrs.delete(k); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    },
    querySelectorAll(sel) {
      if (sel.includes('theme-color')) return metas;
      return [];
    },
    getElementById(id) { return links[id] || null; },
    _attrs: attrs,
    _metas: metas,
    _links: links,
  };
}

test.describe('applyThemeToDocument', () => {
  test('dark：写 data-theme，点亮 dark meta/link', () => {
    const doc = fakeDoc();
    assert.equal(applyThemeToDocument(doc, 'dark', { systemDark: false }), 'dark');
    assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(doc._metas.find(m => m.palette === 'dark').media, 'all');
    assert.equal(doc._metas.find(m => m.palette === 'light').media, 'not all');
    assert.equal(doc._links.hljsThemeDark.media, 'all');
    assert.equal(doc._links.hljsThemeLight.media, 'not all');
  });
  test('light：写 data-theme=light，挡住系统深色', () => {
    const doc = fakeDoc();
    applyThemeToDocument(doc, 'light', { systemDark: true });
    assert.equal(doc.documentElement.getAttribute('data-theme'), 'light');
    assert.equal(doc._metas.find(m => m.palette === 'light').media, 'all');
    assert.equal(doc._links.hljsThemeLight.media, 'all');
  });
  test('system：去掉 data-theme，还原 prefers-color-scheme media', () => {
    const doc = fakeDoc();
    applyThemeToDocument(doc, 'dark', { systemDark: false });
    applyThemeToDocument(doc, 'system', { systemDark: true });
    assert.equal(doc.documentElement.getAttribute('data-theme'), null);
    assert.equal(doc._metas.find(m => m.palette === 'light').media, '(prefers-color-scheme: light)');
    assert.equal(doc._metas.find(m => m.palette === 'dark').media, '(prefers-color-scheme: dark)');
    assert.equal(doc._links.hljsThemeLight.media, '(prefers-color-scheme: light)');
    assert.equal(doc._links.hljsThemeDark.media, '(prefers-color-scheme: dark)');
  });
});
