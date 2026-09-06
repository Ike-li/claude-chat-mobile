// tests/v2/server/health-busy.test.mjs —— /health.busy 反映在途轮，不是「有实例」
// 守护：/health 的 busy 字段必须跟着 anyTurnRunning() 走（app.js:486 的接线）
// 覆盖：无实例 → false；开出实例且轮次在跑 → true；两次读取之间只有「发了一条消息」这一个变量
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR；CLAUDE_BIN 走 stub，无真 turn）
//
// 【从哪来】2026-09-05 阶段 3：把源码文本断言换成行为断言。
// tests/unit/instance-manager.test.mjs 里那条是 readFileSync(app.js) + 正则匹配
// /busy:\s*instanceManager\.anyTurnRunning\(\)/ —— 钉的是源码长什么样，改个变量名无故变红。
//
// ⚠ 但它【没有】被完全取代，那条源码断言有意留着，理由写在它自己的注释里：
// 本层分辨不了「用 anyTurnRunning」与「用 stateOf」。要分辨得造出「有后台任务但无在途轮」
// 的状态，而 fake-claude.sh 吞掉 stdin、不产出任何输出，S2 里造不出后台任务。
// 所以分工是：本文件钉「busy 跟着在途轮翻」，那条源码断言钉「读的是哪个函数」。
// 等 stub 能吐 init / 后台任务事件时，那条才该退役。
//
// 不测什么 + 为什么：
//  ① 轮次结束后 busy 落回 false —— stub 永不产出 result，pendingTurns 恒为 1，S2 造不出「轮次结束」。
//     那一侧由 tests/unit/instance-manager.test.mjs 的 anyTurnRunning 纯函数用例覆盖。
//  ② /health 的鉴权 —— 归 tests/v2/server/auth-gate.test.mjs。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';

const TOKEN = 'v2-health-busy-token';

let dir, server;

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ccm-v2-health-'));
  server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIR: dir, CCM_DATA_DIR: dir });
});
test.after(async () => {
  if (server) await killServer(server.proc);
  if (dir) rmSync(dir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

const health = async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/health?token=${encodeURIComponent(TOKEN)}`);
  assert.equal(res.status, 200, '/health 带正确令牌必须 200');
  return res.json();
};

// 用例顺序是有意的：先读「什么都没发生」时的 busy，再发消息、再读。
// 两次读取之间只有一个变量，busy 的翻转才归因得到。
test('起来但没人发过消息 → busy=false', async () => {
  const body = await health();
  assert.equal(body.busy, false,
    `刚起的 server 不该报 busy，实际 ${JSON.stringify(body.busy)}——`
    + 'busy 若被「有没有实例」点亮，这里就已经是 true 了');
});

test('发出一条消息、轮次在跑 → busy=true', async () => {
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'v2-health-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },   // 本机直连 bypass 设备门，本文件不测设备
  });
  try {
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
    });

    // 连上还不够：连接只会懒开实例，不产生在途轮。busy 必须由【消息】点亮而不是【连接】。
    const afterConnect = await health();
    assert.equal(afterConnect.busy, false, '仅仅连上不该点亮 busy——那是「有实例」不是「有在途轮」');

    const ack = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('user:message ack 超时')), 8000);
      sock.emit('user:message', { text: '开一轮，stub 不会回 result', clientMessageId: 'hb-1' },
        res => { clearTimeout(timer); resolve(res); });
    });
    assert.equal(ack.ok, true, `首发应被接受，实际 ${JSON.stringify(ack)}`);

    const busy = await health();
    assert.equal(busy.busy, true,
      `在途轮应点亮 /health.busy，实际 ${JSON.stringify(busy.busy)}——`
      + '不翻转就说明 /health 没接到 anyTurnRunning()，运维探针会把「正在跑」报成空闲');
  } finally {
    try { sock.close(); } catch { /* 已关闭 */ }
  }
});
