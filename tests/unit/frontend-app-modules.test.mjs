import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createAppContext } from '../../public/js/app/context.js';
import { createClientLogger } from '../../public/js/app/client-log.js';
import { createAlertController } from '../../public/js/app/alerts.js';
import { createAttachmentController } from '../../public/js/app/attachments.js';
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
  const sound = {};
  const vibrate = {};
  const foreground = {};
  const context = createAppContext({
    dom: {
      settingsSheet: { classList: sheetClasses },
      settingsScrim: { classList: scrimClasses },
      prefAlertSound: sound,
      prefAlertVibrate: vibrate,
      prefAlertForeground: foreground,
    },
  });
  const controller = createSettingsController(context, {
    alerts: { preferences: () => ({ sound: false, vibrate: true, foregroundComplete: false }), ensureAudio: () => {} },
    autoBind: false,
  });

  controller.open();
  assert.equal(sound.checked, false);
  assert.equal(vibrate.checked, true);
  assert.equal(foreground.checked, false);
  assert.equal(sheetClasses.has('translate-y-full'), false);
  assert.equal(scrimClasses.has('hidden'), false);

  controller.close();
  assert.equal(sheetClasses.has('translate-y-full'), true);
  assert.equal(scrimClasses.has('hidden'), true);
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
  assert.equal(textNode.textContent, 'running');
  assert.equal(hidden.has('hidden'), false);
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
