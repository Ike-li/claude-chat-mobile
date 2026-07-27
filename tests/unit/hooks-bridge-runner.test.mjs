// hook runner 的进程级契约（spawn 真脚本，同 statusline-bridge-runner.test.mjs 套路）。
// 红线：runner 由 claude CLI 在每轮结束时执行——它必须 best-effort，且 **stdout 恒空**：
// Stop hook 的 stdout 会被 CLI 当作决策 JSON 解析（可返回 {decision:'block'} 阻断行为），
// 我们吐任何东西都可能干扰用户的真实会话。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNNER = new URL('../../scripts/hooks-bridge.js', import.meta.url).pathname;
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CWD = '/Users/you/code/demo';

function runHook(input, { env = {}, dir } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [RUNNER], {
      // CCM_HOOKS_ORIGIN 必须显式清空再由用例按需覆盖：跑测试的这个 shell 自己可能就在 ccm 的 SDK
      // 子进程里（机主从手机端驱动本会话时就是如此），继承下来会让 runner 按设计静默退出，
      // 于是所有"应当写事件"的用例集体变红——环境泄漏进测试的经典形态，实测踩到。
      env: { ...process.env, CCM_HOOKS_ORIGIN: '', CLI_HOOKS_DIR: dir ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ccm-hooks-run-'));
}

test('runner：正常 Stop 事件落盘可验证的事件文件，exit 0 且 stdout 恒空', async () => {
  const dir = tempDir();
  try {
    const { code, stdout } = await runHook(JSON.stringify({
      hook_event_name: 'Stop', session_id: SID, cwd: CWD, message: '不该落盘的正文',
    }), { dir });
    assert.equal(code, 0);
    assert.equal(stdout, '', 'stdout 会被 CLI 当决策 JSON 解析，必须为空');
    const names = readdirSync(dir);
    assert.equal(names.length, 1);
    const event = JSON.parse(readFileSync(join(dir, names[0]), 'utf8'));
    assert.equal(event.hookEventName, 'Stop');
    assert.equal(event.sessionId, SID);
    assert.equal(event.cwd, CWD);
    assert.equal('message' in event, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner：CCM_HOOKS_ORIGIN=web-sdk 时静默退出不写事件（防 web 驱动的轮次重复推送）', async () => {
  const dir = tempDir();
  try {
    const { code, stdout } = await runHook(JSON.stringify({
      hook_event_name: 'Stop', session_id: SID, cwd: CWD,
    }), { dir, env: { CCM_HOOKS_ORIGIN: 'web-sdk' } });
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner：坏 JSON / 非白名单事件 → 不写、仍 exit 0（绝不影响 CLI 本身）', async () => {
  const dir = tempDir();
  try {
    const bad = await runHook('{broken', { dir });
    assert.equal(bad.code, 0);
    const other = await runHook(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SID, cwd: CWD }), { dir });
    assert.equal(other.code, 0);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner：目标目录不可用（路径被文件占住）→ 吞掉异常仍 exit 0', async () => {
  const parent = tempDir();
  try {
    const blocked = join(parent, 'blocked');
    writeFileSync(blocked, 'not a directory');
    const { code, stdout } = await runHook(JSON.stringify({
      hook_event_name: 'Stop', session_id: SID, cwd: CWD,
    }), { dir: blocked });
    assert.equal(code, 0);
    assert.equal(stdout, '');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
