// 行为域：CLI 还没吐 system/init（实例没有 sessionId）期间的视图恢复决策。
//
// 真机 2026-07-30（bc29ccc2）：web 发起 `/code-review max`，CLI 因第三方网关反复返回空/畸形响应，
// 整整 31 分钟没吐出 system/init——实例活着、轮次在跑、事件经 SDK 实时推到手机上看得见，但
// server 侧还没有 sessionId，CLI 自己的 transcript 里也一条主链消息都没有（stdout 实时流与它
// 自己的落盘是两条独立通道，前者永远更早）。此时整页刷新 / 息屏回前台 / 断网重连，前端会：
//   ① bindView 因 `!sessionId` 判定「显示空首页」当场 return —— 压根走不到 sync:since；
//   ② 即便走到了，冷入场判定又是 'reload' —— 清屏后拿 session:history 换回「会话不存在」。
// 两条都会把服务端环形缓冲里那份 CLI 已经给过的内容自己扔掉，用户看到白屏。
//
// 修复是配套的两层，缺一不可：
//   ① live 豁免（resolveEmptySurface / shouldShowStartScreen，见 logic-instance-destroyed.test.mjs）
//      —— 实例在跑就不落空首页，让 bindView 继续往下走；
//   ② hasSessionId 闸（本文件三个函数）—— 门开了之后别再清屏换一个拿不到的磁盘。
// 两层各自都有 E2E 探针验证过（tests/e2e/p0/replay-buffer.spec.ts 的 P0-NOSID：任一摘掉即当场变红）。
//
// 所有新参数一律缺省 true / false 保持既有行为，既有调用方零连坐——下面每组最后一条就是固化这点的。

import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldReloadOnEnter, syncAckAction, resolveReplayBufferAction } from '../../app/public/js/logic.js';

test.describe('shouldReloadOnEnter：无 sessionId 时不得清屏换磁盘（bindView 切视图入场）', () => {
  test('无缓存 + replayed>0 → keep（缓冲是唯一真相，清屏换空 = 自毁）', () => {
    assert.equal(shouldReloadOnEnter({ replayed: 50, gap: false, hasCache: false, hasSessionId: false }), 'keep');
  });
  test('优先于 gap（缓冲残缺也好过清屏后拿不回任何东西）', () => {
    assert.equal(shouldReloadOnEnter({ replayed: 9, gap: true, hasCache: false, hasSessionId: false }), 'keep');
  });
  test('有 DOM 缓存 + 磁盘 ahead → 仍 keep（那份 ahead 是拿不到的，清屏只会更糟）', () => {
    assert.equal(shouldReloadOnEnter({ replayed: 0, gap: false, hasCache: true, diskLen: 99, seenDiskLen: 0, hasSessionId: false }), 'keep');
  });
  test('hasSessionId 缺省 true → 整页刷新仍 reload 拉磁盘（不连坐既有冷入场修复）', () => {
    assert.equal(shouldReloadOnEnter({ replayed: 50, gap: false, hasCache: false, diskLen: 200, seenDiskLen: 0 }), 'reload');
  });
});

// 息屏回前台 / 断网重连不经 bindView，只走 requestSync 这条路径，故同一条闸两处都得有。
test.describe('syncAckAction：无 sessionId 时不得清屏换磁盘（重连 / probe 探活）', () => {
  test('found=false / gap / diskLen 都不该触发清屏拉盘 → none', () => {
    assert.equal(syncAckAction(null, { found: false, gap: true, diskLen: 99 }, { seenDiskLen: 0, hasSessionId: false }), 'none');
  });
  test('不影响 err→reconnect（连接层判定与会话身份无关）', () => {
    assert.equal(syncAckAction(new Error('timeout'), { found: false }, { hasSessionId: false }), 'reconnect');
  });
  test('hasSessionId 缺省 true → found=false 仍 reload（不连坐既有行为）', () => {
    assert.equal(syncAckAction(null, { replayed: 0, gap: false, found: false }), 'reload');
  });
});

// 二层判定：一层已判 'keep'，这层不能因为「积压超阈值」把它升级回 reload——那同样是清屏换空。
// busy 分支只覆盖「轮次进行中」，轮次结束后再刷新 busy=false，只剩这条闸兜着。
test.describe('resolveReplayBufferAction：无 sessionId 时不得把 keep 升级成 reload', () => {
  test('积压远超阈值 + 未 busy → flush', () => {
    assert.equal(resolveReplayBufferAction({ bufferedCount: 9999, priorAction: 'keep', busy: false, hasSessionId: false }), 'flush');
  });
  test('hasSessionId 缺省 true + 积压超阈值 → 仍 reload（不连坐既有行为）', () => {
    assert.equal(resolveReplayBufferAction({ bufferedCount: 9999, priorAction: 'keep', busy: false }), 'reload');
  });
});
