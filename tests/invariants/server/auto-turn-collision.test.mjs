// tests/invariants/server/auto-turn-collision.test.mjs —— 手动发送撞上汇报轮时，在跑的这条不得被报成空闲
// 守护：OPS-04（在途轮的判据只认 pendingTurns；CLI 自己起的轮的 result 不得结算还排在 CLI 队列里的消息）
// 测什么：真 server + 假 CLI 的 turn-autoreport-collide 档——汇报轮等首字节时手动发一条，它排在汇报轮后面。
//         断言：汇报轮的 result 到了以后、这条的 result 到之前，/health.busy 为 true、instances.turnRunning 没有
//         掉成 false、第三条被在途轮闸拒掉；这条的 result 到了以后账面归零。
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR + fake-claude turn-autoreport-collide 档）
//
// 【缺陷的真实形态】2026-11-06 真 CLI 2.1.318 + 真 server + 假 API 复现。汇报轮的 result 不带 user_message_uuid，
//   FIFO 把人发那条的槽结算给它：这条还在跑，turnRunning 已是 false，/health.busy 也是 false，第三条被放行。
//   有 pendingAutoTurn 时到这条的 message_start 才合成回来；Monitor 事件起的轮没有这个 flag，点过停止或 flag 过期也
//   没有，这条整轮都没有停止钮。
//
// 【等待窗口】这条的回合压 1.5 秒收尾，/health 与第三条都在这段时间里问。
//
// 不测什么 + 为什么：
//  ① 线上帧次序本身——夹具照真 CLI 探针写，判据细节由 tests/unit/agent-control.test.mjs 用同样的帧逐条钉住；
//  ② 前端拿到 turnRunning 之后怎么切停止钮——logic/composer 的纯函数与 S3。

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from '../../integration/_spawn-server.mjs';

const TOKEN = 'inv-auto-collide-token';

test('OPS-04：汇报轮的 result 不把排在它后面的这条报成空闲', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-inv-autocollide-'));
  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: dir, CCM_DATA_DIR: dir,
    CCM_FAKE_CLAUDE_MODE: 'turn-autoreport-collide',
    CCM_FAKE_CLAUDE_AUTOREPORT_MS: '100',
    CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '1500',
  });
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'inv-autocollide-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  sock.on('agent:event', e => events.push(e));
  const send = (text, clientMessageId, instanceId) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('user:message ack 超时')), 15000);
    sock.emit('user:message', { text, cwd: dir, clientMessageId, instanceId }, res => { clearTimeout(timer); resolve(res); });
  });

  try {
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
    });
    const first = await send('开个后台任务', 'collide-1');
    assert.equal(first.ok, true, `首发应被接受，实际 ${JSON.stringify(first)}`);
    const id = first.instanceId;
    const resultCount = () => events.filter(e => e.type === 'result' && e.instanceId === id).length;

    await waitForCondition(() => events.some(e => e.type === 'task_notification' && e.instanceId === id),
      { timeoutMs: 10_000, label: '前置：后台任务完成通知到达，汇报轮开始等首字节' });
    const second = await send('手动发的', 'collide-2', id);
    assert.equal(second.ok, true, `汇报轮等首字节时账面是 0，这条应被接受，实际 ${JSON.stringify(second)}`);

    await waitForCondition(() => resultCount() === 2, { timeoutMs: 10_000, label: '前置：汇报轮的 result 到达' });
    const autoReportEnded = events.findLastIndex(e => e.type === 'result' && e.instanceId === id);

    const health = await fetch(`http://127.0.0.1:${server.port}/health`, { headers: { 'x-auth-token': TOKEN } }).then(r => r.json());
    assert.equal(health.busy, true, `这条还在跑，/health.busy 应为 true，实际 ${JSON.stringify(health)}`);
    const third = await send('第三条', 'collide-3', id);
    assert.equal(third.ok, false, `在途轮期间第三条不得放行，实际 ${JSON.stringify(third)}`);
    assert.equal(third.busy, true, `拒绝理由应是在途轮，实际 ${JSON.stringify(third)}`);

    await waitForCondition(() => resultCount() === 3, { timeoutMs: 10_000, label: '这条自己的 result 到达' });
    const thisTurnEnded = events.findLastIndex(e => e.type === 'result' && e.instanceId === id);
    const reportedIdleMidway = events.slice(autoReportEnded, thisTurnEnded)
      .some(e => e.type === 'instances' && e.payload?.instances?.find?.(x => x.instanceId === id)?.turnRunning === false);
    assert.equal(reportedIdleMidway, false, '汇报轮结束到这条结束之间，广播不得说它空闲（否则其它端停止钮消失）');

    const after = await fetch(`http://127.0.0.1:${server.port}/health`, { headers: { 'x-auth-token': TOKEN } }).then(r => r.json());
    assert.equal(after.busy, false, `这条结束后账面应归零，实际 ${JSON.stringify(after)}`);
  } finally {
    try { sock.close(); } catch { /* 已关闭 */ }
    await killServer(server.proc);
    rmSync(dir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});
