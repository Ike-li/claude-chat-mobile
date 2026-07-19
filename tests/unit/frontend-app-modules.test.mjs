import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createAppContext } from '../../public/js/app/context.js';
import { createClientLogger } from '../../public/js/app/client-log.js';
import { createAlertController } from '../../public/js/app/alerts.js';
import { createAttachmentController, createStoredPreviewLoader } from '../../public/js/app/attachments.js';
import { createRttMonitor } from '../../public/js/app/connection-sync.js';
import { createMessageRenderer } from '../../public/js/app/message-renderer.js';
import { createAgentEventDispatcher } from '../../public/js/app/event-dispatch.js';
import { formatFileSize } from '../../public/js/app/file-browser.js';
import { createSettingsController } from '../../public/js/app/settings.js';
import { createNotificationController } from '../../public/js/app/notifications.js';
import { createTaskStatusController } from '../../public/js/app/task-status.js';
import { createSessionWorkspaceState } from '../../public/js/app/session-workspaces.js';
import { createInteractionQueueState } from '../../public/js/app/approval-questions.js';

test('app context owns shared DOM, state, dependencies and the active socket', () => {
  const dom = { messages: { id: 'messages' } };
  const state = { viewingInstanceId: 'inst-1' };
  const dependencies = { now: () => 123 };
  const context = createAppContext({ dom, state, dependencies });

  assert.equal(context.dom, dom);
  assert.equal(context.state, state);
  assert.equal(context.dependencies, dependencies);
  assert.equal(context.socket, null);

  const socket = { id: 'socket-1' };
  assert.equal(context.setSocket(socket), socket);
  assert.equal(context.socket, socket);
});

test('client logger uses the real ring buffer and reads current state from app context', () => {
  let now = 100;
  const state = { viewingInstanceId: 'inst-1', currentModel: 'sonnet' };
  const context = createAppContext({
    state,
    dependencies: { now: () => now },
  });
  const appended = [];
  const logger = createClientLogger(context, {
    capacity: 2,
    onEntry: entry => appended.push(entry),
  });

  logger.log('send', 'one');
  now = 101;
  state.viewingInstanceId = 'inst-2';
  state.currentModel = 'opus';
  logger.log('conn', 'two');
  now = 102;
  logger.log('recv', 'three');

  assert.deepEqual(logger.entries(), [
    { ts: 101, type: 'client_conn', text: 'two', instanceId: 'inst-2' },
    { ts: 102, type: 'client_recv', text: 'three', instanceId: 'inst-2', model: 'opus' },
  ]);
  assert.equal(appended.length, 3);
  assert.equal(logger.size(), 2);
  logger.clear();
  assert.deepEqual(logger.entries(), []);
});

test('the HTML shell loads app.css and contains no inline style block', async () => {
  const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../../public/css/app.css', import.meta.url), 'utf8');

  assert.match(html, /<link rel="stylesheet" href="\/css\/app\.css">/);
  assert.doesNotMatch(html, /<style(?:\s|>)/i);
  assert.match(css, /:root\s*\{/);
  assert.match(css, /\.msg-body\s*\{/);
});

test('alert controller owns persisted preferences while tap haptics remain unconditional', () => {
  const values = new Map();
  const vibrations = [];
  const context = createAppContext({
    dependencies: {
      window: {},
      navigator: { vibrate: pattern => vibrations.push(pattern) },
      storage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
    },
  });
  const alerts = createAlertController(context);

  assert.deepEqual(alerts.preferences(), {
    sound: true,
    vibrate: true,
    foregroundComplete: true,
  });
  alerts.haptic('success');
  alerts.setPreference('vibrate', false);
  alerts.haptic('warning');
  alerts.haptic('tap');

  assert.deepEqual(vibrations, [[15, 80, 15], 12]);
  assert.equal(values.get('ccm_alert_vibrate'), '0');
  assert.equal(alerts.preferences().vibrate, false);
});

test('attachment controller owns pending attachment state without leaking mutable arrays', () => {
  const context = createAppContext();
  const changes = [];
  const attachments = createAttachmentController(context, {
    autoBind: false,
    onChange: items => changes.push(items),
  });
  const first = { _id: 'a', name: 'a.txt', size: 3, data: 'YWJj' };

  attachments.setItems([first]);
  const snapshot = attachments.items();
  snapshot.length = 0;

  assert.equal(attachments.items().length, 1);
  assert.deepEqual(attachments.payload(), [{ name: 'a.txt', size: 3, data: 'YWJj' }]);
  attachments.clear();
  assert.deepEqual(attachments.items(), []);
  assert.equal(changes.length, 2);
});

// 用户点 chip ✕ 移除附件：按 _id 删；payload/草稿回灌可能丢 _id，setItems 须补齐否则 filter 永 false。
test('attachment controller remove filters by _id and backfills missing ids on setItems', () => {
  let seq = 0;
  const context = createAppContext({
    dependencies: {
      now: () => 1000 + seq,
      random: () => 0.123456789 + (seq++ * 0.01),
    },
  });
  const attachments = createAttachmentController(context, { autoBind: false });

  attachments.setItems([
    { name: 'keep.txt', size: 1, data: 'YQ==' },
    { name: 'drop.txt', size: 1, data: 'Yg==' },
  ]);
  const [keep, drop] = attachments.items();
  assert.ok(keep._id, 'setItems 无 _id 时应补齐');
  assert.ok(drop._id);
  assert.notEqual(keep._id, drop._id);

  assert.equal(attachments.remove(drop._id), true);
  assert.deepEqual(
    attachments.items().map(a => a.name),
    ['keep.txt'],
  );
  assert.equal(attachments.remove('missing-id'), false);
  assert.equal(attachments.items().length, 1);

  // 保留已有 _id，不重写
  attachments.setItems([{ _id: 'stable', name: 'x.bin', size: 2, data: 'eA==' }]);
  assert.equal(attachments.items()[0]._id, 'stable');
});

// ── E18 附件预览：createStoredPreviewLoader ──────────────────────────────────────
// 气泡附件点击 → browse:read base64 分页拉原图 → Blob → FileReader.readAsDataURL → 灯箱。
// fake FileReader 用真 Blob.arrayBuffer() 还原字节再拼 data URL——端到端验证分片拼装正确性。
function makePreviewHarness({ fileBytes, chunkBytes = 10, ackOverride = null, deferFirstChunk = false } = {}) {
  const emits = [];
  const socket = {
    emit(event, payload, ack) {
      emits.push({ event, payload });
      if (ackOverride) return ackOverride(payload, ack);
      const offset = payload.offset || 0;
      const slice = fileBytes.subarray(offset, offset + (payload.maxBytes || chunkBytes));
      const reply = () => ack({
        ok: true,
        content: Buffer.from(slice).toString('base64'),
        totalSize: fileBytes.length,
        bytesRead: slice.length,
        truncated: offset + slice.length < fileBytes.length,
        binary: true,
      });
      if (deferFirstChunk && offset === 0) setTimeout(reply, 5);
      else reply();
    },
  };
  class FakeFileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(buf => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
        this.onload?.();
      }, err => this.onerror?.(err));
    }
  }
  const context = createAppContext({ dependencies: { FileReader: FakeFileReader } });
  context.setSocket(socket);
  const bars = [];
  const opened = [];
  const loader = createStoredPreviewLoader(context, {
    addBar: (text, cls) => bars.push({ text, cls }),
    openPreviewUrl: (name, url) => opened.push({ name, url }),
    chunkBytes,
  });
  return { loader, emits, bars, opened };
}

test('stored preview loader fetches a single-chunk image and opens the lightbox with exact bytes', async () => {
  const fileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
  const { loader, emits, opened, bars } = makePreviewHarness({ fileBytes, chunkBytes: 100 });
  await loader.open({ cwd: '/w', storedName: '123-abcd1234-p.png', name: 'p.png', mimeType: 'image/png' });
  assert.equal(emits.length, 1);
  assert.equal(emits[0].event, 'browse:read');
  assert.equal(emits[0].payload.relPath, '.ccm-uploads/123-abcd1234-p.png');
  assert.equal(emits[0].payload.encoding, 'base64');
  assert.equal(emits[0].payload.cwd, '/w');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].name, 'p.png');
  assert.equal(opened[0].url, `data:image/png;base64,${fileBytes.toString('base64')}`);
  assert.deepEqual(bars.filter(b => b.cls === 'text-danger'), []);
});

test('stored preview loader reassembles multi-chunk fetches by offset even when acks land out of order', async () => {
  const fileBytes = Buffer.from(Array.from({ length: 25 }, (_, i) => (i * 7 + 3) % 256));
  const { loader, emits, opened } = makePreviewHarness({ fileBytes, chunkBytes: 10, deferFirstChunk: true });
  await loader.open({ cwd: '/w', storedName: '1-aaaaaaaa-x.png', name: 'x.png', mimeType: 'image/png' });
  assert.equal(emits.length, 3); // 25 字节 / 10 每片 → 3 片
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, `data:image/png;base64,${fileBytes.toString('base64')}`);
});

test('stored preview loader caches by cwd+storedName and skips refetch on second open', async () => {
  const fileBytes = Buffer.from([1, 2, 3]);
  const { loader, emits, opened } = makePreviewHarness({ fileBytes, chunkBytes: 100 });
  await loader.open({ cwd: '/w', storedName: '1-bbbbbbbb-c.png', name: 'c.png', mimeType: 'image/png' });
  await loader.open({ cwd: '/w', storedName: '1-bbbbbbbb-c.png', name: 'c.png', mimeType: 'image/png' });
  assert.equal(emits.length, 1); // 第二次走缓存不 emit
  assert.equal(opened.length, 2);
  assert.equal(opened[0].url, opened[1].url);
});

test('stored preview loader rejects oversized files with a toast and no lightbox', async () => {
  const { loader, emits, opened, bars } = makePreviewHarness({
    fileBytes: Buffer.alloc(4),
    ackOverride: (_payload, ack) => ack({ ok: true, content: 'AAAA', totalSize: 11 * 1024 * 1024, bytesRead: 3, truncated: true, binary: true }),
  });
  await loader.open({ cwd: '/w', storedName: '1-cccccccc-big.png', name: 'big.png', mimeType: 'image/png' });
  assert.equal(emits.length, 1); // 只发了首片探测
  assert.equal(opened.length, 0);
  assert.ok(bars.some(b => b.text.includes('过大')));
});

test('stored preview loader falls back to the thumb with a toast when the file is gone', async () => {
  const { loader, opened, bars } = makePreviewHarness({
    fileBytes: Buffer.alloc(0),
    ackOverride: (_payload, ack) => ack({ ok: false, error: '路径不在授权范围内，或不是文件' }),
  });
  await loader.open({ cwd: '/w', storedName: '1-dddddddd-gone.png', name: 'gone.png', mimeType: 'image/png', thumb: 'data:image/jpeg;base64,thumb' });
  assert.ok(bars.some(b => b.cls === 'text-danger'));
  assert.deepEqual(opened, [{ name: 'gone.png', url: 'data:image/jpeg;base64,thumb' }]); // 降级放大 thumb
});

test('stored preview loader refuses path-like storedName and non-image types without emitting', async () => {
  const { loader, emits, opened, bars } = makePreviewHarness({ fileBytes: Buffer.alloc(1) });
  await loader.open({ cwd: '/w', storedName: '../escape.png', name: 'escape.png', mimeType: 'image/png' });
  await loader.open({ cwd: '/w', storedName: 'sub/dir.png', name: 'dir.png', mimeType: 'image/png' });
  await loader.open({ cwd: '/w', storedName: '1-eeeeeeee-doc.pdf', name: 'doc.pdf', mimeType: 'application/pdf' });
  await loader.open({ cwd: '/w', storedName: '1-ffffffff-noext', name: 'noext' }); // 无 mime 且扩展名猜不出
  assert.equal(emits.length, 0);
  assert.equal(opened.length, 0);
  assert.equal(bars.length, 4);
});

test('stored preview loader guesses image mime from the file name when meta lacks mimeType', async () => {
  const fileBytes = Buffer.from([9, 9, 9]);
  const { loader, opened } = makePreviewHarness({ fileBytes, chunkBytes: 100 });
  await loader.open({ cwd: '/w', storedName: '1-99999999-shot.webp', name: 'shot.webp' }); // 历史路径无 mimeType
  assert.equal(opened.length, 1);
  assert.ok(opened[0].url.startsWith('data:image/webp;base64,'));
});

test('RTT monitor renders latency through app context and clears stale values', () => {
  const rtt = { textContent: '', className: '', title: '' };
  const wrap = { title: '' };
  const statuses = [];
  const context = createAppContext({ dom: { connRtt: rtt, connDotWrap: wrap } });
  const monitor = createRttMonitor(context, { setStatus: value => statuses.push(value) });

  // 人话前缀「延迟」+ 数值；慢链路用 danger 色；状态行/绿点 title 同步带「延迟」
  assert.equal(monitor.render(1250), '1.3s');
  assert.equal(rtt.textContent, '延迟 1.3s');
  assert.match(rtt.className, /conn-rtt-chip/);
  assert.match(rtt.className, /text-danger/);
  assert.doesNotMatch(rtt.className, /\bhidden\b/);
  assert.equal(rtt.title, '手机到主机往返延迟 1.3s');
  assert.equal(wrap.title, '已连接 · 延迟 1.3s');
  assert.deepEqual(statuses, ['已连接 · 延迟 1.3s']);

  // 健康链路：不与绿点抢 success 色，用中性 ink-soft
  assert.equal(monitor.render(80), '80ms');
  assert.equal(rtt.textContent, '延迟 80ms');
  assert.match(rtt.className, /text-ink-soft/);
  assert.doesNotMatch(rtt.className, /text-success/);

  monitor.clear();
  assert.equal(rtt.textContent, '');
  assert.match(rtt.className, /hidden/);
  assert.match(rtt.className, /conn-rtt-chip/);
});

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

test('agent event dispatcher keeps instance, epoch and sequence boundaries in shared state', () => {
  const handled = [];
  const resets = [];
  const sessions = [];
  const state = {
    viewingInstanceId: 'inst-1',
    instancesReady: true,
    curEpoch: null,
    lastSeq: 0,
    currentSessionId: null,
  };
  const context = createAppContext({ state });
  const dispatch = createAgentEventDispatcher(context, {
    handlers: () => ({ result: payload => handled.push(payload) }),
    onEpochReset: epoch => resets.push(epoch),
    onSessionId: sessionId => sessions.push(sessionId),
  });

  assert.equal(dispatch({ type: 'result', instanceId: 'inst-2', epoch: 'e1', seq: 1 }), 'dropped');
  assert.equal(dispatch({ type: 'result', instanceId: 'inst-1', epoch: 'e1', seq: 1, sessionId: 's1', payload: { ok: true } }), 'handled');
  assert.equal(dispatch({ type: 'result', instanceId: 'inst-1', epoch: 'e1', seq: 1, payload: { ok: false } }), 'duplicate');

  assert.deepEqual(resets, ['e1']);
  assert.deepEqual(sessions, ['s1']);
  assert.deepEqual(handled, [{ ok: true }]);
  assert.equal(state.curEpoch, 'e1');
  assert.equal(state.lastSeq, 1);
});

test('file browser formats byte counts consistently for directory and content pages', () => {
  assert.equal(formatFileSize(100), '100B');
  assert.equal(formatFileSize(1536), '1.5KB');
  assert.equal(formatFileSize(2 * 1024 * 1024), '2.0MB');
  assert.equal(formatFileSize(Number.NaN), '');
});

test('settings controller synchronizes alert preferences when opening the sheet', () => {
  const classes = initial => {
    const values = new Set(initial);
    return {
      add: (...names) => names.forEach(name => values.add(name)),
      remove: (...names) => names.forEach(name => values.delete(name)),
      has: name => values.has(name),
    };
  };
  const sheetClasses = classes(['translate-y-full']);
  const scrimClasses = classes(['hidden']);
  const bodyClasses = classes([]);
  const htmlClasses = classes([]);
  const sound = {};
  const vibrate = {};
  const foreground = {};
  const sheetBody = { scrollTop: 42 };
  const context = createAppContext({
    dom: {
      settingsSheet: { classList: sheetClasses, scrollTop: 0 },
      settingsSheetBody: sheetBody,
      settingsScrim: { classList: scrimClasses },
      prefAlertSound: sound,
      prefAlertVibrate: vibrate,
      prefAlertForeground: foreground,
    },
  });
  const fakeDoc = {
    documentElement: { classList: htmlClasses },
    body: { classList: bodyClasses },
  };
  const controller = createSettingsController(context, {
    alerts: { preferences: () => ({ sound: false, vibrate: true, foregroundComplete: false }), ensureAudio: () => {} },
    autoBind: false,
    doc: fakeDoc,
  });

  controller.open();
  assert.equal(sound.checked, false);
  assert.equal(vibrate.checked, true);
  assert.equal(foreground.checked, false);
  assert.equal(sheetClasses.has('translate-y-full'), false);
  assert.equal(scrimClasses.has('hidden'), false);
  // 打开锁背景滚动 + 内容区滚回顶部
  assert.equal(bodyClasses.has('ccm-sheet-open'), true);
  assert.equal(htmlClasses.has('ccm-sheet-open'), true);
  assert.equal(sheetBody.scrollTop, 0);

  controller.close();
  assert.equal(sheetClasses.has('translate-y-full'), true);
  assert.equal(scrimClasses.has('hidden'), true);
  assert.equal(bodyClasses.has('ccm-sheet-open'), false);
  assert.equal(htmlClasses.has('ccm-sheet-open'), false);
});

test('notification controller only raises foreground notifications when explicitly forced', () => {
  const raised = [];
  class NotificationMock {
    static permission = 'granted';
    constructor(title, options) { raised.push({ title, options }); }
  }
  const context = createAppContext({
    dependencies: {
      document: { hidden: false },
      window: { Notification: NotificationMock },
      navigator: {},
      Notification: NotificationMock,
    },
  });
  const notifications = createNotificationController(context, { autoBind: false });

  assert.equal(notifications.notify('done', 'body'), false);
  assert.equal(notifications.notify('done', 'body', { force: true }), true);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].options.tag, 'ccm');
});

test('task status controller ignores other instances and updates the current progress banner', () => {
  const hidden = new Set(['hidden']);
  const banner = {
    classList: {
      contains: name => hidden.has(name),
      add: name => hidden.add(name),
      remove: name => hidden.delete(name),
    },
  };
  const textNode = { textContent: '' };
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText: textNode },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, { autoBind: false });

  assert.equal(status.onProgress({ instanceId: 'inst-2', payload: { message: 'wrong' } }), false);
  assert.equal(status.onProgress({ instanceId: 'inst-1', payload: { taskId: 't1', message: 'running' } }), true);
  // b4716e7 起横幅只写数量/状态（固定标签在 HTML、明细在列表行），不再回显任务 message 原文
  assert.equal(textNode.textContent, '运行中');
  assert.equal(hidden.has('hidden'), false);
  assert.equal(status.onProgress({ instanceId: 'inst-1', payload: { taskId: 't2', message: 'another' } }), true);
  assert.equal(textNode.textContent, '2 个运行中');
});

test('session workspace state exposes isolated caches through app context', () => {
  const firstContext = createAppContext();
  const secondContext = createAppContext();
  const first = createSessionWorkspaceState(firstContext);
  const second = createSessionWorkspaceState(secondContext);

  first.sessionDrafts.set('s1', { text: 'draft' });
  assert.equal(second.sessionDrafts.has('s1'), false);
  assert.equal(firstContext.state.sessionWorkspaces, first);
});

test('approval and question state caps answered IDs and recognizes grouped question IDs', () => {
  const context = createAppContext();
  const interactions = createInteractionQueueState(context, { answeredCapacity: 2 });

  interactions.markQuestionAnswered('tool#0');
  interactions.markQuestionAnswered('tool#1');
  interactions.markQuestionAnswered('new');

  assert.equal(interactions.answeredQuestionIds.has('tool#0'), false);
  assert.equal(interactions.isQuestionAnswered('tool#1'), true);
  interactions.markQuestionAnswered('group');
  assert.equal(interactions.isQuestionAnswered('group#4'), true);
});
