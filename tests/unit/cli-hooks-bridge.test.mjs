// CLI hooks 桥核心：把 claude CLI 的 hook 事件 JSON 规范化落盘为投递箱事件，server 侧扫描消费。
// 投递箱而非 HTTP：hook 命令要写进用户全局 ~/.claude/settings.json，走 HTTP 就得把 AUTH_TOKEN
// 写进命令串（dotfiles 同步/ps 可见）；文件通道无秘密，且 server 离线时仍能做安装回环验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLI_HOOKS_SCHEMA_VERSION,
  HOOK_EVENT_TTL_MS,
  normalizeCliHookInput,
  writeCliHookEvent,
  scanHookEvents,
  sweepHookEvents,
  isVerifyEvent,
  writeHookVerifyAck,
  readHookVerifyAck,
} from '../../src/ops/cli-hooks-bridge.js';

const CWD = '/Users/you/code/demo';
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ccm-hooks-'));
}

const stopInput = JSON.stringify({
  hook_event_name: 'Stop',
  session_id: SID,
  cwd: CWD,
  transcript_path: '/Users/you/.claude/projects/x/y.jsonl',
  message: '需要你确认某个危险操作',
});

test('normalizeCliHookInput：白名单字段规范化，正文/路径刻意不落盘（SEC-04 最小化）', () => {
  const event = normalizeCliHookInput(stopInput, { capturedAt: 1_785_000_000_000 });
  assert.deepEqual(event, {
    schemaVersion: CLI_HOOKS_SCHEMA_VERSION,
    source: 'claude-cli-hook',
    hookEventName: 'Stop',
    sessionId: SID,
    cwd: CWD,
    capturedAt: 1_785_000_000_000,
  });
  // server 的决策只需要"哪个会话、什么事件"；正文进了投递箱等于把会话内容写到第二处磁盘
  assert.equal('message' in event, false);
  assert.equal('transcriptPath' in event, false);
});

test('normalizeCliHookInput：非白名单事件名/缺字段/坏 JSON → null（不写空事件）', () => {
  const at = { capturedAt: 1 };
  assert.equal(normalizeCliHookInput(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SID, cwd: CWD }), at), null);
  assert.equal(normalizeCliHookInput(JSON.stringify({ hook_event_name: 'Stop', cwd: CWD }), at), null);
  assert.equal(normalizeCliHookInput(JSON.stringify({ hook_event_name: 'Stop', session_id: SID }), at), null);
  assert.equal(normalizeCliHookInput('{broken', at), null);
  assert.equal(normalizeCliHookInput('null', at), null);
  assert.equal(normalizeCliHookInput('', at), null);
  assert.equal(normalizeCliHookInput(undefined, at), null);
});

test('normalizeCliHookInput：Notification 也在白名单', () => {
  const e = normalizeCliHookInput(JSON.stringify({ hook_event_name: 'Notification', session_id: SID, cwd: CWD }), { capturedAt: 5 });
  assert.equal(e?.hookEventName, 'Notification');
});

test('writeCliHookEvent → scanHookEvents：原子写 0600、目录 0700、读后即删', () => {
  const dir = tempDir();
  try {
    const event = normalizeCliHookInput(stopInput, { capturedAt: 1_785_000_000_000 });
    const path = writeCliHookEvent(event, { dir });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(readdirSync(dir).filter(n => n.endsWith('.tmp')).length, 0, '无临时文件残留');

    const got = scanHookEvents({ dir, now: 1_785_000_001_000 });
    assert.equal(got.events.length, 1);
    assert.deepEqual(got.events[0], event);
    assert.equal(readdirSync(dir).length, 0, '事件是信号不是数据：消费即删');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanHookEvents：超 TTL 的陈旧事件只删不返回（笔记本睡醒不补一堆旧通知）', () => {
  const dir = tempDir();
  try {
    const old = normalizeCliHookInput(stopInput, { capturedAt: 1_000_000 });
    writeCliHookEvent(old, { dir });
    const got = scanHookEvents({ dir, now: 1_000_000 + HOOK_EVENT_TTL_MS + 1 });
    assert.equal(got.events.length, 0);
    assert.equal(got.expired, 1);
    assert.equal(readdirSync(dir).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanHookEvents：坏 JSON/超大/schema 不符一律删掉不返回；.tmp 不碰', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, '1-Stop-1-aaaaaa.json'), '{broken', { mode: 0o600 });
    writeFileSync(join(dir, '2-Stop-1-bbbbbb.json'), JSON.stringify({ schemaVersion: 999, source: 'x' }), { mode: 0o600 });
    writeFileSync(join(dir, '.3-Stop-1-cccccc.json.tmp'), '{}', { mode: 0o600 });
    const got = scanHookEvents({ dir, now: 2_000_000 });
    assert.equal(got.events.length, 0);
    assert.equal(got.invalid, 2);
    const left = readdirSync(dir);
    assert.deepEqual(left, ['.3-Stop-1-cccccc.json.tmp'], '半写中的 .tmp 不属于扫描面');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanHookEvents：目录不存在 → 空结果不抛（server 先于安装启动）', () => {
  const got = scanHookEvents({ dir: join(tmpdir(), 'ccm-hooks-absent'), now: 1 });
  assert.deepEqual(got, { events: [], expired: 0, invalid: 0 });
});

test('scanHookEvents：单次处理有上限，超出部分直接删（防积压拖垮一次 tick）', () => {
  const dir = tempDir();
  try {
    for (let i = 0; i < 12; i++) {
      writeCliHookEvent(normalizeCliHookInput(stopInput, { capturedAt: 1_785_000_000_000 + i }), { dir });
    }
    const got = scanHookEvents({ dir, now: 1_785_000_000_500, maxFiles: 5 });
    assert.equal(got.events.length, 5);
    assert.equal(readdirSync(dir).length, 0, '未处理的也删掉，不留到下次');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sweepHookEvents：server 启动全清扫（积压事件零重放）', () => {
  const dir = tempDir();
  try {
    writeCliHookEvent(normalizeCliHookInput(stopInput, { capturedAt: 1 }), { dir });
    writeCliHookEvent(normalizeCliHookInput(stopInput, { capturedAt: 2 }), { dir });
    assert.equal(sweepHookEvents({ dir }), 2);
    assert.equal(readdirSync(dir).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verify 事件：isVerifyEvent 识别 + ack 回执可写可读（消灭"被消费 vs 从未写入"歧义）', () => {
  const dir = tempDir();
  try {
    const verifyId = 'ccm-verify-1234';
    const e = normalizeCliHookInput(JSON.stringify({ hook_event_name: 'Stop', session_id: verifyId, cwd: CWD }), { capturedAt: 9 });
    assert.equal(isVerifyEvent(e), true);
    assert.equal(isVerifyEvent(normalizeCliHookInput(stopInput, { capturedAt: 9 })), false);

    assert.equal(readHookVerifyAck(verifyId, { dir }), false);
    const ackPath = writeHookVerifyAck(verifyId, { dir });
    assert.equal(statSync(ackPath).mode & 0o777, 0o600);
    assert.equal(readHookVerifyAck(verifyId, { dir }), true);
    // 文件名不得原样带 verifyId（与 statusline 快照同款 sha256 归一）
    assert.equal(readdirSync(dir).some(n => n.includes(verifyId)), false);
    assert.ok(JSON.parse(readFileSync(ackPath, 'utf8')).ackedAt >= 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
