// #379：高频刷新节点不得挂 aria-live（延迟胶囊 / 流式气泡 / 秒表行）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(join(root, 'app/public/index.html'), 'utf8');
const appJs = readFileSync(join(root, 'app/public/js/app.js'), 'utf8');
const syncJs = readFileSync(join(root, 'app/public/js/app/connection-sync.js'), 'utf8');

test('#379 #connRtt 不得挂 aria-live（每 5s 重写会刷屏）', () => {
  const m = html.match(/<span id="connRtt"[^>]*>/);
  assert.ok(m, '#connRtt 须存在');
  assert.doesNotMatch(m[0], /aria-live/, `#connRtt tag: ${m[0]}`);
});

test('#379 流式助手气泡不得挂 aria-live（~80ms 全量 innerHTML 重写）', () => {
  assert.match(
    appJs,
    /data-testid="assistant-message"/,
    'getStream 须仍创建 assistant-message 气泡',
  );
  assert.doesNotMatch(
    appJs,
    /data-testid="assistant-message"[^`]*aria-live/,
    'assistant-message 模板不得带 aria-live',
  );
});

test('#379 #streamLiveStatus 不得挂 aria-live / aria-busy；秒表文案 aria-hidden', () => {
  const m = appJs.match(/id="streamLiveStatus"[^>]*>/);
  assert.ok(m, 'streamLiveStatus 模板须存在');
  assert.doesNotMatch(m[0], /aria-live/, `streamLiveStatus tag: ${m[0]}`);
  assert.doesNotMatch(m[0], /aria-busy/, `streamLiveStatus tag: ${m[0]}`);
  assert.match(
    appJs,
    /id="streamLiveStatusText"[^>]*aria-hidden="true"/,
    '秒表文案须 aria-hidden，避免探索焦点时也被反复读',
  );
});

test('#379 createRttMonitor 同签名跳过芯片 DOM 写入', () => {
  assert.match(syncJs, /lastChipSig/, '须跟踪上次芯片签名');
  assert.match(syncJs, /sig === lastChipSig/, '同签名须跳过写入');
});
