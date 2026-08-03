// tests/unit/frontend-message-renderer.test.mjs —— markdown 渲染与消毒的行为域单测。
// 从 frontend-app-modules.test.mjs 分出：按行为域拆分是硬门禁（见 source-layout.test.mjs）。

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppContext } from '../../public/js/app/context.js';
import { createMessageRenderer } from '../../public/js/app/message-renderer.js';

test('message renderer owns markdown sanitization dependencies from app context', () => {
  const calls = [];
  const context = createAppContext({
    dependencies: {
      marked: {
        setOptions: options => calls.push(['options', options]),
        parse: raw => `<b>${raw}</b>`,
      },
      DOMPurify: {
        addHook: name => calls.push(['hook', name]),
        sanitize: html => html.replace('<b>', '<strong>').replace('</b>', '</strong>'),
      },
    },
  });
  const renderer = createMessageRenderer(context);

  assert.equal(renderer.renderMarkdown('safe'), '<strong>safe</strong>');
  assert.deepEqual(calls[0], ['options', { breaks: true, gfm: true }]);
  assert.deepEqual(calls[1], ['hook', 'afterSanitizeAttributes']);
});

// SEC：DOMPurify 默认表放行 <label for> 与 style 属性（实测 3.4.10）。二者组合 = 纯 HTML/CSS 点击劫持：
//   <label for="permAllow" style="position:fixed;inset:0;z-index:2147483647;opacity:.002">
// 铺满视口盖过 z-40 的 #permModal，用户点「拒绝」实际激活 <button id="permAllow"> → answerPerm('allow')。
// 审批完整性绑定挡不住它——op 指纹是真的，被篡改的是用户意图。CSP 也管不到（无脚本）。
test('markdown sanitizer forbids clickjacking and form-exfiltration primitives', () => {
  const configs = [];
  const context = createAppContext({
    dependencies: {
      marked: { setOptions() {}, parse: raw => raw },
      DOMPurify: { addHook() {}, sanitize: (html, cfg) => { configs.push(cfg); return html; } },
    },
  });

  createMessageRenderer(context).renderMarkdown('x');

  const cfg = configs[0];
  assert.ok(cfg, 'sanitize 必须带显式配置，不能沿用 DOMPurify 默认放行表');
  const tags = cfg.FORBID_TAGS || [];
  const attrs = cfg.FORBID_ATTR || [];
  for (const tag of ['label', 'form', 'button', 'select', 'textarea']) {
    assert.ok(tags.includes(tag), `必须禁 <${tag}>：可构造覆盖层或外发表单`);
  }
  for (const attr of ['style', 'for']) {
    assert.ok(attrs.includes(attr), `必须禁 ${attr} 属性：全屏覆盖 + 激活按钮的两个必要原语`);
  }
});
