// #370 / #366 / #365：小范围 aria 补丁（发现 hint、工作区改动角标、关闭/返回热区与门页）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(join(root, 'app/public/index.html'), 'utf8');
const appJs = readFileSync(join(root, 'app/public/js/app.js'), 'utf8');

function tagWithId(id) {
  const re = new RegExp(`<[^>]*\\bid="${id}"[^>]*>`);
  const m = html.match(re);
  assert.ok(m, `#${id} opening tag must exist`);
  return m[0];
}

test('#365 #sidebarClose 有 aria-label', () => {
  assert.match(tagWithId('sidebarClose'), /aria-label="关闭"/);
});

test('#365 返回/关闭钮挂 hit-44（热区惯例）', () => {
  for (const id of [
    'fileBrowseBack',
    'folderPickerBack',
    'generalBack',
    'sessionBlockedBack',
    'btnConfigRefresh',
  ]) {
    assert.match(tagWithId(id), /\bhit-44\b/, `#${id} 须挂 hit-44`);
  }
  assert.match(tagWithId('fileBrowseBack'), /aria-label="返回上一级"/);
});

test('#365 #consoleModal 与门页有 dialog 名', () => {
  assert.match(tagWithId('consoleModal'), /role="dialog"/);
  assert.match(tagWithId('consoleModal'), /aria-modal="true"/);
  assert.match(tagWithId('consoleModal'), /aria-label="交互日志"/);
  for (const [id, label] of [
    ['authGate', '访问令牌'],
    ['accessRelogin', '会话已过期'],
    ['deviceModal', '等待授权'],
    ['deviceDenied', '设备未获授权'],
    ['accessHelp', '如何连接与使用'],
  ]) {
    const tag = tagWithId(id);
    assert.match(tag, /role="dialog"/, `#${id}`);
    assert.match(tag, /aria-modal="true"/, `#${id}`);
    assert.match(tag, new RegExp(`aria-label="${label}"`), `#${id}`);
  }
});

test('#370 syncComposerDiscoverHint 空聚焦时写 textarea aria-description', () => {
  assert.match(appJs, /resolveComposerDiscoverAriaDescription/);
  assert.match(appJs, /setAttribute\('aria-description'/);
  assert.match(appJs, /removeAttribute\('aria-description'\)/);
  assert.match(
    appJs,
    /composerDiscoverHint[\s\S]{0,500}setAttribute\('aria-hidden', 'true'\)/,
  );
});

test('#366 改动角标有文案时取消 aria-hidden，并刷新 pill aria-label', () => {
  assert.match(appJs, /formatTopContextPillAriaLabel/);
  assert.match(
    appJs,
    /topContextChanges\.setAttribute\('aria-hidden', text \? 'false' : 'true'\)/,
  );
  assert.match(appJs, /syncTopContextPillAriaLabel/);
  assert.match(
    appJs,
    /topContextPill\.setAttribute\('aria-label', formatTopContextPillAriaLabel/,
  );
});
