// CLI session lock —— 会话被别的 claude 进程独占时的用户文案。
//
// 2026-07-30：本文件曾覆盖 findBgLocksForSession / shouldReleaseBgLock / releaseBgLocksForSession /
// prepareSessionForWebResume / parseAgentsJson / prepareResumeInParallel 一整套「web resume 前
// SIGTERM 掉占用者」的自动释放逻辑，随该逻辑一并删除（理由见 src/ops/cli-bg-session-lock.js 头注释）。
// 「谁算占用者」的判据现在归 session-registry.js 的 findBlockingLiveAgent，测试在 session-registry.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSessionLockError } from '../../src/ops/cli-bg-session-lock.js';

test.describe('formatSessionLockError', () => {
  test('background / interactive 文案可区分，且不含「历史被清理」', () => {
    const bg = formatSessionLockError({ kind: 'background', name: 'top-right', pid: 1 });
    assert.match(bg, /后台/);
    assert.doesNotMatch(bg, /历史可能已被清理/);
    const inter = formatSessionLockError({ kind: 'interactive', name: 'cli', pid: 2 });
    assert.match(inter, /终端 CLI|驾驶/);
    const raw = formatSessionLockError({ rawMessage: 'Session x is currently running as a background agent (bg).' });
    assert.match(raw, /后台 agent/);
  });

  // 注册表自报 kind='bg'，而 `claude agents --json` 对同一进程报 'background'——只认后者会漏出
  // 「无法恢复会话（CLI 未完成初始化）」这种驴唇不对马嘴的兜底文案。
  test("kind='bg'（注册表口径）同样按后台占用出文案，且不再宣称已尝试释放", () => {
    const bg = formatSessionLockError({ kind: 'bg', name: '排查模型网关超时问题', pid: 57573 });
    assert.match(bg, /后台/);
    assert.match(bg, /57573/);
    assert.match(bg, /排查模型网关超时问题/);
    assert.match(bg, /claude agents/);      // 指向 CLI 官方出路
    assert.doesNotMatch(bg, /已尝试释放/);   // 契约已改：不碰对方进程
    assert.doesNotMatch(bg, /未完成初始化/); // 不得落到通用兜底
  });

  test('无 kind 且无 rawMessage → 通用兜底；有 rawMessage 则透传', () => {
    assert.match(formatSessionLockError({}), /无法恢复会话/);
    assert.equal(formatSessionLockError({ rawMessage: 'disk on fire' }), 'disk on fire');
  });
});
