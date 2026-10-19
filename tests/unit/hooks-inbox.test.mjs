// server 侧投递箱：监听 events 目录 → 批量消费 → 回调。watch 只是"更快的触发器"，
// 真相仍由 scanHookEvents 提供；watch 建不起来时退化成现有 2.5s 轮询，功能不缺失。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
    // 超时定时器必须清掉：got 先赢时它仍挂在事件循环上，进程要等它烧完 3s 才肯退出。
    let timer;
    try {
      put(d.events);
      const events = await Promise.race([
        got,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('watch 未在 3s 内触发')), 3000); }),
      ]);
      assert.equal(events[0].sessionId, SID);
    } finally { clearTimeout(timer); inbox.close(); }
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

// 验收 O35：此前 server 启动就替用户建 ~/.claude/ccm/hooks-v1/events（为了「先起 server 后装桥」免重启），
// 于是没装过桥、或刚卸载干净的机器，server 一重启 ~/.claude/ccm 又冒出来。现在不建：目录在就盯，不在就等，
// 每隔 rearmMs 看一眼——装上（目录出现）就盯上并立刻扫一遍，卸掉（目录被删）就放手。
function waitForConsumed(inbox, got, ms = 3000) {
  let timer;
  return Promise.race([
    got,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${ms}ms 内没被消费`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

test('目录不存在（桥没装）：不替用户建目录', () => {
  const d = dirs();
  try {
    const inbox = createHooksInbox({ eventsDir: d.events, acksDir: d.acks, enabled: true, rearmMs: 20 });
    try {
      assert.equal(existsSync(d.events), false, '没装桥的机器上不该凭空出现投递箱目录');
    } finally { inbox.close(); }
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test('先起 inbox 后出现目录（先起 server 后装桥）：免重启，事件照样被消费', async () => {
  const d = dirs();
  try {
    let resolveSeen;
    const got = new Promise(r => { resolveSeen = r; });
    const inbox = createHooksInbox({
      eventsDir: d.events, acksDir: d.acks, enabled: true, debounceMs: 20, rearmMs: 20,
      onEvents: e => { if (e.length) resolveSeen(e); },
    });
    try {
      put(d.events); // 写事件会建目录，等同安装器 / runner 先落了第一条
      const events = await waitForConsumed(inbox, got);
      assert.equal(events[0].sessionId, SID);
    } finally { inbox.close(); }
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test('目录被删后又出现（卸载后重装、server 不重启）：照样被消费', async () => {
  const d = dirs();
  try {
    put(d.events); // 目录先在（启动清扫会把这条清掉）
    let resolveSeen;
    const got = new Promise(r => { resolveSeen = r; });
    const inbox = createHooksInbox({
      eventsDir: d.events, acksDir: d.acks, enabled: true, debounceMs: 20, rearmMs: 20,
      onEvents: e => { if (e.length) resolveSeen(e); },
    });
    try {
      rmSync(d.events, { recursive: true, force: true });
      await new Promise(r => setTimeout(r, 100));
      assert.equal(existsSync(d.events), false, '卸载删掉的目录不该被 inbox 自己建回来');
      put(d.events);
      const events = await waitForConsumed(inbox, got);
      assert.equal(events[0].sessionId, SID);
    } finally { inbox.close(); }
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});
