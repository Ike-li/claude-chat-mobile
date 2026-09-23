// tests/invariants/server/auto-turn-broadcast.test.mjs —— 后台任务完成触发的自动汇报轮，一开讲就要广播「在跑」
// 守护：OPS-04（在途轮的判据只认 pendingTurns；自动汇报轮由 agent 合成账面，开轮那一刻 instances.turnRunning 就要广播出去）
// 测什么：真 server + 可驱动假 CLI 的 turn-autoreport 档——第一轮正常收尾后，CLI 再吐一条后台任务完成与下一轮的
//         message_start（那一轮不收尾）。断言：task_notification 之后，instances 广播里这个实例的 turnRunning 翻成 true，
//         且与 /health.busy 一致。
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR + fake-claude turn-autoreport 档）
//
// 【缺陷的真实形态】2026-09-22 review P2。自动汇报轮没有用户输入，账面靠 agent 在 message_start 时合成
//   （maybeSynthesizeAutoTurn）。合成只改了账面，没有伴随任何会触发广播的事件（message_start / text_delta 不在
//   STATE_BOUNDARY 里），于是其它端一直以为它空闲——只有文本、不调工具的汇报轮会一直这样到 result。这期间从别的端
//   发消息，被在途轮闸以「当前任务运行中」拒掉。/health 读的是实时账面，不受影响——两边于是说两样话。
//
// 【等待窗口】task_notification 之后只等 2 秒：修复后广播几毫秒内就到；窗口开得越长，越可能等来一次无关的广播，
//   让修复前的实现也绿。
//
// 不测什么 + 为什么：
//  ① 合成本身的条件（TTL、有无 flag、前台工具不武装）——tests/unit/agent-background-tasks.test.mjs 已逐条钉住；
//  ② 前端拿到 turnRunning 之后怎么切停止钮 / 发送闸——logic/composer 的纯函数与 S3。

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from '../../integration/_spawn-server.mjs';

const TOKEN = 'inv-auto-turn-token';

test('OPS-04：后台任务完成触发的自动汇报轮一开讲，instances 广播就说它在跑（与 /health.busy 一致）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-inv-autoturn-'));
  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: dir, CCM_DATA_DIR: dir,
    CCM_FAKE_CLAUDE_MODE: 'turn-autoreport',
  });
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'inv-autoturn-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  sock.on('agent:event', e => events.push(e));

  try {
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
    });
    const sent = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('user:message ack 超时')), 15000);
      sock.emit('user:message', { text: '开个后台任务', cwd: dir, clientMessageId: 'autoturn-1' }, res => { clearTimeout(timer); resolve(res); });
    });
    assert.equal(sent.ok, true, `首发应被接受，实际 ${JSON.stringify(sent)}`);
    const id = sent.instanceId;

    // 后台任务完成的通知到了：下一刻 CLI 就开讲汇报轮
    await waitForCondition(() => events.some(e => e.type === 'task_notification' && e.instanceId === id),
      { timeoutMs: 10_000, label: '前置：后台任务完成通知到达' });
    const notifiedAt = events.findIndex(e => e.type === 'task_notification' && e.instanceId === id);
    const runningAfterNotify = () => events.slice(notifiedAt).some(e => e.type === 'instances'
      && e.payload?.instances?.find?.(x => x.instanceId === id)?.turnRunning === true);
    await waitForCondition(runningAfterNotify, {
      timeoutMs: 2000,
      label: '自动汇报轮开讲后 instances 广播里 turnRunning=true（不播的话其它端以为它空闲，发消息被在途轮闸拒掉）',
    });

    // 同一时刻 /health 说的也是在跑：两处必须同口径
    const health = await fetch(`http://127.0.0.1:${server.port}/health`, { headers: { 'x-auth-token': TOKEN } }).then(r => r.json());
    assert.equal(health.busy, true, `/health.busy 应为 true，实际 ${JSON.stringify(health)}`);
  } finally {
    try { sock.close(); } catch { /* 已关闭 */ }
    await killServer(server.proc);
    rmSync(dir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});
