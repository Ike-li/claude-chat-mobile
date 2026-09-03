// server 侧投递箱：监听 events 目录 → 批量消费 → 回调。watch 只是"更快的触发器"，
// 真相仍由 scanHookEvents 提供；watch 建不起来时退化成现有 2.5s 轮询，功能不缺失。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHooksInbox } from '../../app/src/server/hooks-inbox.js';
import {
  normalizeCliHookInput,
  writeCliHookEvent,
  readHookVerifyAck,
} from '../../app/src/ops/cli-hooks-bridge.js';

const SID = 'sess-inbox';
const CWD = '/Users/you/code/demo';

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'ccm-inbox-'));
  return { root, events: join(root, 'events'), acks: join(root, 'acks') };
}

function put(eventsDir, over = {}) {
  const event = normalizeCliHookInput(JSON.stringify({
    hook_event_name: 'Stop', session_id: SID, cwd: CWD, ...over,
  }), { capturedAt: Date.now() });
  return writeCliHookEvent(event, { dir: eventsDir });
}

test('启动即清扫积压事件，且不把它们喂给回调（离线期间的旧信号零重放）', () => {
  const d = dirs();
  try {
    put(d.events);
    put(d.events);
    const seen = [];
    const inbox = createHooksInbox({
      eventsDir: d.events, acksDir: d.acks, enabled: true, onEvents: e => seen.push(...e),
    });
    try {
      assert.deepEqual(seen, []);
      assert.deepEqual(readdirSync(d.events), []);
    } finally { inbox.close(); }
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test('scanNow：新事件被消费并交给回调，文件随即删除', () => {
  const d = dirs();
  try {
    const seen = [];
    const inbox = createHooksInbox({
      eventsDir: d.events, acksDir: d.acks, enabled: true, onEvents: e => seen.push(...e),
    });
    try {
      put(d.events);
      inbox.scanNow();
      assert.equal(seen.length, 1);
      assert.equal(seen[0].sessionId, SID);
      assert.deepEqual(readdirSync(d.events), []);
    } finally { inbox.close(); }
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test('verify 事件：写 ack 回执且不进业务回调（安装验证不该触发推送/刷新）', () => {
  const d = dirs();
  try {
    const seen = [];
    const inbox = createHooksInbox({
      eventsDir: d.events, acksDir: d.acks, enabled: true, onEvents: e => seen.push(...e),
    });
    try {
      put(d.events, { session_id: 'ccm-verify-xyz' });
      inbox.scanNow();
      assert.deepEqual(seen, [], 'verify 事件不进业务回调');
      assert.equal(readHookVerifyAck('ccm-verify-xyz', { dir: d.acks }), true);
    } finally { inbox.close(); }
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test('enabled:false（CLI_HOOKS_BRIDGE=off）：不清扫、不消费、不建目录', () => {
  const d = dirs();
  try {
    const path = put(d.events);
    const seen = [];
    const inbox = createHooksInbox({
      eventsDir: d.events, acksDir: d.acks, enabled: false, onEvents: e => seen.push(...e),
    });
    try {
      inbox.scanNow();
      assert.deepEqual(seen, []);
      assert.ok(readdirSync(d.events).includes(path.split('/').pop()), '停用时事件原样留着');
    } finally { inbox.close(); }
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test('回调抛异常不能掀翻 inbox（下一次 scan 仍工作）', () => {
  const d = dirs();
  try {
    let calls = 0;
    const inbox = createHooksInbox({
      eventsDir: d.events, acksDir: d.acks, enabled: true,
      onEvents: () => { calls += 1; throw new Error('boom'); },
    });
    try {
      put(d.events);
      inbox.scanNow();
      put(d.events);
      inbox.scanNow();
      assert.equal(calls, 2);
    } finally { inbox.close(); }
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test('watch 触发：落一个事件文件后无需手动 scan 也会被消费', async () => {
  const d = dirs();
  try {
    let resolveSeen;
    const got = new Promise(r => { resolveSeen = r; });
    const inbox = createHooksInbox({
      eventsDir: d.events, acksDir: d.acks, enabled: true, debounceMs: 20,
      onEvents: e => { if (e.length) resolveSeen(e); },
    });
    try {
      put(d.events);
      const events = await Promise.race([
        got,
        new Promise((_, reject) => setTimeout(() => reject(new Error('watch 未在 3s 内触发')), 3000)),
      ]);
      assert.equal(events[0].sessionId, SID);
    } finally { inbox.close(); }
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});
