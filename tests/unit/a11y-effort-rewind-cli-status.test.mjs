// #403：思考强度磁贴、/rewind 候选列表键盘可达；CLI 状态栏 summary 不得嵌套 button
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const appJs = readFileSync(join(root, 'app/public/js/app.js'), 'utf8');
const rewindJs = readFileSync(join(root, 'app/public/js/app/rewind-command.js'), 'utf8');
const html = readFileSync(join(root, 'app/public/index.html'), 'utf8');

test('#403 .effort-tile 用 button + aria-pressed（对齐 .perm-tile / .model-tile）', () => {
  // 磁贴模板须是 button，不得退回裸 div
  assert.match(
    appJs,
    /<button type="button"[^>]*class="[^"]*effort-tile/,
    'rebuildEffortOptions 须渲染 <button type="button" class="…effort-tile…">',
  );
  assert.match(
    appJs,
    /effort-tile[\s\S]{0,200}aria-pressed="\$\{active \? 'true' : 'false'\}"|aria-pressed="\$\{active \? 'true' : 'false'\}"[\s\S]{0,120}effort-tile/,
    'effort-tile 创建时须带 aria-pressed',
  );
  assert.match(
    appJs,
    /querySelectorAll\('\.effort-tile'\)[\s\S]{0,400}setAttribute\('aria-pressed'/,
    'setEffortMode 须同步 effort-tile 的 aria-pressed',
  );
  // 禁止再生成裸 div.effort-tile
  assert.doesNotMatch(
    appJs,
    /<div data-level="\$\{esc\(lv\)\}" class="effort-tile/,
    '不得恢复 <div class="effort-tile">',
  );
});

test('#403 renderCliPermissionMode(null) 须清掉 perm-tile 的 aria-pressed', () => {
  assert.match(
    appJs,
    /querySelectorAll\('\.perm-tile'\)[\s\S]{0,250}setAttribute\('aria-pressed', 'false'\)/,
    'CLI 权限模式未知时读屏不能仍报某一张选中',
  );
});

test('#403 /rewind 候选轮次用 button（焦点陷阱可 Tab 到）', () => {
  assert.match(
    rewindJs,
    /const tag = disabled \? 'div' : 'button'/,
    '可选项须用 button，禁用项可保留 div',
  );
  assert.match(
    rewindJs,
    /typeAttr = disabled \? '' : ' type="button"'/,
    '可选项须带 type=button',
  );
});

test('#403 #cliStatusCopy 不得嵌在 <summary> 内', () => {
  const summaryBlock = html.match(/<summary[\s\S]*?<\/summary>/g) || [];
  const cliSummary = summaryBlock.find(s => s.includes('cliSummary') || s.includes('cli-arrow'));
  assert.ok(cliSummary, '须能定位 CLI 状态栏 summary');
  assert.doesNotMatch(cliSummary, /<button[\s\S]*id="cliStatusCopy"/, 'summary 内不得嵌套 #cliStatusCopy');
  assert.match(html, /id="cliStatusBar"/, '复制按钮应与 details 并排在 #cliStatusBar 外层');
  assert.match(
    html,
    /id="cliStatusBar"[\s\S]*id="cliStatusWrap"[\s\S]*id="cliStatusCopy"/,
    '#cliStatusCopy 须在 #cliStatusBar 内、与 details 并列',
  );
});
