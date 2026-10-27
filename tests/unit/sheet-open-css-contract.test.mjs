// #369：sheet 开合过渡认 .ccm-sheet 类选择器，禁止再维护 modal ID 白名单。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const css = readFileSync(join(root, 'app/public/css/app.css'), 'utf8');
const html = readFileSync(join(root, 'app/public/index.html'), 'utf8');

const OPEN_SHEET_MODAL_IDS = [
  'permModal', 'questionModal', 'moreModal', 'sessionMenuModal', 'confirmModal',
  'rewindModal', 'consoleModal', 'workspaceModal', 'folderPickerModal',
  'serviceStatusModal', 'envConfigModal',
];

test('#369 app.css 用 .ccm-sheet.sheet-open，不再枚举 modal ID 做开合过渡', () => {
  assert.match(css, /\.ccm-sheet\.sheet-open\s*\{/, '须有 .ccm-sheet.sheet-open 规则');
  assert.match(css, /\.ccm-sheet\s*\{/, '须有 .ccm-sheet 关闭态规则');
  assert.match(css, /\.ccm-sheet\.ccm-sheet-kb/, '键盘优先 sheet（会话菜单）须有不过渡 visibility 的修饰类');
  // 旧 ID 白名单回归：这些串联选择器一旦回来，新 modal 又会漏过渡
  assert.doesNotMatch(
    css,
    /#permModal\.sheet-open\s*,\s*#questionModal\.sheet-open/,
    '不得恢复 #permModal.sheet-open, #questionModal.sheet-open … ID 白名单',
  );
  assert.doesNotMatch(
    css,
    /#permModal\s*,\s*#questionModal\s*,\s*#consoleModal\s*,\s*#confirmModal\s*,\s*#moreModal/,
    '不得恢复关闭态 ID 枚举列表',
  );
});

test('#369 prefers-reduced-motion 覆盖 .ccm-sheet（不再只列部分 ID）', () => {
  const reduceBlocks = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\s*\}/g)]
    .map(m => m[1]);
  assert.ok(reduceBlocks.length, '须有 prefers-reduced-motion: reduce 块');
  const joined = reduceBlocks.join('\n');
  assert.match(joined, /\.ccm-sheet/, '减弱动效须关掉 .ccm-sheet 过渡');
  assert.match(joined, /\.ccm-sheet\s*>\s*div/, '减弱动效须关掉卡片 translate 过渡');
});

test('#369 openSheet 管理的 modal 根节点在 HTML 上带 .ccm-sheet', () => {
  for (const id of OPEN_SHEET_MODAL_IDS) {
    const m = html.match(new RegExp(`id="${id}"\\s+class="([^"]*)"`));
    assert.ok(m, `缺少 #${id}`);
    const classes = m[1].split(/\s+/);
    assert.ok(classes.includes('ccm-sheet'), `#${id} 须带 ccm-sheet`);
  }
  const menu = html.match(/id="sessionMenuModal"\s+class="([^"]*)"/);
  assert.ok(menu[1].split(/\s+/).includes('ccm-sheet-kb'), '#sessionMenuModal 须带 ccm-sheet-kb（不过渡 visibility）');
});
