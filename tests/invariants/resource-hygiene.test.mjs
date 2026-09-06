// tests/invariants/resource-hygiene.test.mjs —— RESOURCE-01：开合 N 次后句柄不随 N 涨
// 守护：RESOURCE-01（方案 §6）——「开合 N 次后 FD / listener / timer / child / watcher
//       不随 N 线性涨」。不测 QPS、不做 soak（方案 §17 明确不做）。
// 覆盖：approval-store 防抖写的 timer 复用（真 timer，进程句柄表可见）
//       + approval-lifecycle 留存扫描 timer 的注入式开合归零
// 槽位：S1（进程自身的活动句柄表 + 注入替身，零 IO、不起 server）
//
// 【为什么此前是零】2026-09-05 全树搜 listenerCount / getActiveResourcesInfo /
// _getActiveHandles / RESOURCE-01 —— 一条都没有。Swift 侧反倒有（ccm-menubar-tests.swift 的
// testRunSyncResourceHygiene 真 spawn 数 /dev/fd，是 2026-08-22 菜单栏持有 2550 个 pipe fd
// 撞上限自锁之后补的），Node 侧一直没人守。
//
// ★【判据必须先自证能看见】每一节都先跑一条正对照：故意造出泄漏，断言【计量确实会涨】。
// 这不是仪式。本文件第一版选的目标是 createHooksInbox 的 fs.watch，写完跑正对照才发现
// getActiveResourcesInfo 对它【完全失明】：20 个未关闭的 watcher，activeResources /
// _getActiveHandles / _getActiveRequests / /dev/fd 四个计量全是 0 变化。
// 原因是 hooks-inbox.js:77 调了 watcher.unref()，而那个 API 只返回「正在维持事件循环存活」
// 的资源；darwin 的 FSEvents 也不占可见 FD。没有正对照的话，那一版会是一条【永远绿】的
// RESOURCE-01——清单上打了勾，缺口原封不动，比没有测试更糟。
//
// 不测什么 + 为什么：
//  ① createHooksInbox 的 watcher —— 见上，S1 观测不到。它的 RESOURCE-01 只能在 S2 用
//     真 server 子进程 + lsof/proc 数 FD，或在 Linux 上数 inotify fd。留给 S2 槽。
//  ② app.js 的 statusInterval / serviceSampleInterval —— 在组装根里，单测加载不了那个文件。
//  ③ 内存与 GC 行为 —— 本仓不做 soak。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { startApprovalRetentionSweep } from '../../app/src/agent/approval-lifecycle.js';

const timerCount = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;

let AS;
let TMP_DIR;

test.before(async () => {
  TMP_DIR = mkdtempSync(join(tmpdir(), 'ccm-inv-res-'));
  process.env.CCM_APPROVAL_STORE_FILE = join(TMP_DIR, 'approval-requests.json');
  AS = await import('../../app/src/agent/approval-store.js');
});

test.after(() => {
  AS?.flushSaveSync?.();
  delete process.env.CCM_APPROVAL_STORE_FILE;
  if (TMP_DIR) rmSync(TMP_DIR, { recursive: true, force: true }); // safe-rm: 上面 mkdtemp 建的一次性目录
});

const mkReq = (i) => ({
  reqId: `res-${i}`, sessionId: 's', tool: 'Bash', args: {}, cwd: '/w',
  fingerprint: `fp-${i}`, createdAt: 1000 + i, expiresAt: 9_000_000,
});

test.describe('RESOURCE-01: approval-store 防抖写只占一个 timer', () => {
  // ★ 正对照：证明 getActiveResourcesInfo 数得到裸 setTimeout。这一条红＝本节其余断言空过。
  test('★ 量法自检：N 个未清理的 setTimeout 必须让计数涨 N', () => {
    const before = timerCount();
    const handles = Array.from({ length: 8 }, () => setTimeout(() => {}, 60_000));
    try {
      assert.equal(
        timerCount() - before, 8,
        '计量看不到普通 timer 的话，下面「防抖只占一个」的断言就是空过的',
      );
    } finally {
      for (const h of handles) clearTimeout(h);
    }
  });

  // save() 每次都先 clearTimeout(_saveTimer) 再重设。少了那一句 clear，连续 N 次写入
  // 就会挂着 N 个 200ms 定时器——常驻 server 上审批频繁的会话会一路堆上去。
  test('连续 20 次写入只挂一个防抖 timer，不是 20 个', () => {
    AS.flushSaveSync();                 // 先把可能在飞的那个清掉，基线才干净
    const before = timerCount();

    for (let i = 0; i < 20; i++) AS.recordCreated(mkReq(i));

    const delta = timerCount() - before;
    assert.equal(delta, 1, `20 次写入应只留 1 个防抖 timer，实际 +${delta}`);
  });

  test('flushSaveSync 之后回到基线（退出路径不留悬挂 timer）', () => {
    AS.flushSaveSync();
    const base = timerCount();
    AS.recordCreated(mkReq(999));
    assert.equal(timerCount() - base, 1, '写入应挂起一个防抖 timer');
    AS.flushSaveSync();
    assert.equal(timerCount(), base, 'flush 必须把防抖 timer 一并清掉，否则 shutdown 后仍悬挂');
  });
});

test.describe('RESOURCE-01: approval-lifecycle 留存扫描的开合归零', () => {
  // setIntervalImpl 可注入，所以这一节完全确定性、不依赖平台，也不依赖句柄表看不看得见。
  function fakeTimers() {
    const live = new Set();
    let seq = 0;
    const setIntervalImpl = () => {
      const h = { id: ++seq, unrefCalls: 0, unref() { this.unrefCalls += 1; } };
      live.add(h);
      return h;
    };
    return { live, setIntervalImpl, clear: (h) => live.delete(h) };
  }

  const quietStore = () => ({ purgeTerminalOlderThan: () => 0, expireAllPending: () => 0 });

  // ★ 正对照：不清理时 live 必须跟着 N 涨——否则下面「归零」是空过的。
  test('★ 量法自检：开 N 次不清理，live 计数必须为 N', () => {
    const t = fakeTimers();
    for (let i = 0; i < 15; i++) {
      startApprovalRetentionSweep({ store: quietStore(), recordAudit: () => {}, setIntervalImpl: t.setIntervalImpl });
    }
    assert.equal(t.live.size, 15);
  });

  test('开合 N 次后归零，且增量不随 N 放大（N 与 3N 两个量级）', () => {
    const t = fakeTimers();
    const cycle = (times) => {
      for (let i = 0; i < times; i++) {
        const h = startApprovalRetentionSweep({
          store: quietStore(), recordAudit: () => {}, setIntervalImpl: t.setIntervalImpl,
        });
        t.clear(h);
      }
    };
    cycle(10);
    assert.equal(t.live.size, 0, '开合 10 次后不该有残留');
    cycle(30);
    assert.equal(t.live.size, 0, '开合 30 次后仍为 0——线性泄漏的话这里会是 30');
  });

  // timer.unref() 是「留存扫描不得把进程钉在前台」的实现手段：漏调它，
  // 一个 24h 周期的 interval 会让 node 永不自然退出。
  test('返回的 timer 必须被 unref（24h 周期不得钉住事件循环）', () => {
    const t = fakeTimers();
    const h = startApprovalRetentionSweep({
      store: quietStore(), recordAudit: () => {}, setIntervalImpl: t.setIntervalImpl,
    });
    assert.equal(h.unrefCalls, 1, '不 unref 的话 24h interval 会让进程永不退出');
  });

  test('启动即扫一次（不等第一个 24h 周期）', () => {
    const t = fakeTimers();
    let sweeps = 0;
    startApprovalRetentionSweep({
      store: { purgeTerminalOlderThan: () => { sweeps += 1; return 0; }, expireAllPending: () => 0 },
      recordAudit: () => {},
      setIntervalImpl: t.setIntervalImpl,
    });
    assert.equal(sweeps, 1, '长期不重启的常驻 server 也需要治理——启动那一次不能省');
  });
});
