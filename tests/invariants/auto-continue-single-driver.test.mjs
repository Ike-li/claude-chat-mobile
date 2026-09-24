// tests/invariants/auto-continue-single-driver.test.mjs —— 额度墙自动续跑不得绕过单驾驶员
// 守护：SESSION-01（终端仍在驾驶时 Web 不得向同一会话发新消息——server 自己到点发起的续跑同样是 Web 在写）
// 测什么：调度器到点复核接上【真】注册表（listTerminalSessionStates）与【真】transcript 尾窗
//   （readTranscriptTailEntries），终端 / 桌面端开着这个会话、或终端在墙之后写过，都不得代发；
//   外加一条正对照——两者都干净时确实会发，证明这套仪器看得见「发了」。
// 不测什么 + 为什么：① 判定规则本身（尾部怎么认、注册表怎么归一）在 quota-auto-continue / session-registry
//   的单测里，这里只证接线后方向对 ② 真 server 组装根上的接线（app.js 的注入）属 S2，未建——本仓 S2 的
//   假 CLI 不产出额度墙，要造墙得先给 fake-claude 加场景，成本与收益不成比例 ③ 真 CLI 撞真墙属 S5，
//   要真额度耗尽，无法按需复现。
// 槽位：S1（编排 + 一次性目录真 fs：注册表 json 与 transcript jsonl 都真落盘）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAutoContinue } from '../../app/src/server/auto-continue.js';
import { AUTO_CONTINUE_JITTER_MIN_MS } from '../../app/src/agent/quota-auto-continue.js';
import { getProjectDir, readTranscriptTailEntries } from '../../app/src/sessions/history.js';
import { listTerminalSessionStates } from '../../app/src/sessions/session-registry.js';

const SID = '6f0c2a55-1b7e-4a4e-9d0f-0a1b2c3d4e5f';
const CWD = '/Users/you/code/app';
const T0 = Date.UTC(2026, 8, 22, 17, 48, 20);
const RESET_S = Math.floor(T0 / 1000) + 3 * 3600;
const FIRE_AT = RESET_S * 1000 + AUTO_CONTINUE_JITTER_MIN_MS;
const QUOTA = { status: 'rejected', resetsAt: RESET_S, rateLimitType: 'five_hour', isUsingOverage: false };

const ROOTS = [];
test.after(() => {
  for (const dir of ROOTS) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ } }
});

function setup() {
  const projects = mkdtempSync(join(tmpdir(), 'ccm-ac-tx-'));
  const registry = mkdtempSync(join(tmpdir(), 'ccm-ac-reg-'));
  ROOTS.push(projects, registry);
  return { projects, registry };
}

// 真机形态（2026-09-11 d257416a 第 100 行，除 uuid/时刻外照抄）
const wallEntry = { type: 'assistant', uuid: 'wall-1', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, quotaLimits: QUOTA, entrypoint: 'sdk-ts', isSidechain: false, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 3pm (America/Chicago)" }] } };
const human = (text, entrypoint = 'sdk-ts') => ({ type: 'user', uuid: `u-${text}`, entrypoint, isSidechain: false, message: { role: 'user', content: text } });

function writeTranscript(projects, entries) {
  const dir = join(projects, getProjectDir(CWD));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SID}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

// 用本进程 pid：注册表消费者会 pid 验活，自己的 pid 保证「活着」而无需注入 isAlive。
// 绝不写进真实 ~/.claude/sessions——带活 pid 的条目会让正在跑的 server 看到幻影终端会话。
function writeRegistryEntry(registry, { entrypoint, status }) {
  writeFileSync(join(registry, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: SID, cwd: CWD, entrypoint, kind: 'interactive',
    ...(status ? { status, statusUpdatedAt: T0 } : {}), startedAt: T0, version: '2.1.280',
  }));
}

function makeScheduler({ projects, registry }) {
  let now = T0;
  const sent = [];
  const inst = {
    pendingTurns: 0, externalDirty: false,
    async send(text, model, opts) { sent.push({ text, opts }); return true; },
    emitNotice() {},
  };
  const ac = createAutoContinue({
    now: () => now,
    random: () => 0,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    isAutoEnabled: () => true,
    readTailEntries: (sid, cwd) => readTranscriptTailEntries(sid, cwd, { baseDir: projects }),
    listTerminalStates: () => listTerminalSessionStates({ dir: registry }),
    getLiveInstance: () => inst,
    resumeInstance: async () => inst,
  });
  ac.onWall({ sessionId: SID, cwd: CWD, instance: inst, wall: { uuid: 'wall-1', quota: QUOTA, fallback: null, turnOrigin: 'human', turnHadOutput: true } });
  const fireNow = async () => {
    now = FIRE_AT - 10_000; await ac.tick();
    now = FIRE_AT + 1; await ac.tick();
    await ac.idle();
  };
  return { ac, sent, fireNow };
}

test('正对照：注册表里没有别的驾驶员、墙仍是尾部 → 到点确实发出（仪器看得见「发了」）', async () => {
  const roots = setup();
  writeTranscript(roots.projects, [human('跑个长任务'), wallEntry]);
  const { sent, fireNow } = makeScheduler(roots);
  await fireNow();
  assert.equal(sent.length, 1, '这条不绿，下面几条「没发」就证明不了任何事');
});

test('终端 CLI 正开着这个会话（闲着也算）→ 不代发', async () => {
  const roots = setup();
  writeTranscript(roots.projects, [human('跑个长任务'), wallEntry]);
  writeRegistryEntry(roots.registry, { entrypoint: 'cli', status: 'idle' });
  const { ac, sent, fireNow } = makeScheduler(roots);
  await fireNow();
  assert.equal(sent.length, 0, '终端 REPL 的内存上下文停在墙那里，web 一写，终端下一句就从旧叶子分叉');
  assert.equal(ac.snapshot()[0]?.phase, 'stale', '不发但要让用户看得见，由人决定');
});

test('桌面端 Code 标签开着这个会话（不自报 status）→ 不代发', async () => {
  const roots = setup();
  writeTranscript(roots.projects, [human('跑个长任务'), wallEntry]);
  writeRegistryEntry(roots.registry, { entrypoint: 'claude-desktop' });
  const { sent, fireNow } = makeScheduler(roots);
  await fireNow();
  assert.equal(sent.length, 0);
});

test('终端在墙之后已经写过（进程已退出、注册表里没有它）→ 不代发', async () => {
  const roots = setup();
  writeTranscript(roots.projects, [human('跑个长任务'), wallEntry, human('额度恢复了，我在终端接着干', 'cli')]);
  const { ac, sent, fireNow } = makeScheduler(roots);
  await fireNow();
  assert.equal(sent.length, 0, '接着那句发出去就是第二条 parentUuid 链');
  assert.equal(ac.snapshot().length, 0);
});
