// tests/integration/local-command-broadcast.test.mjs —— 本地 slash 命令的输出发给同一会话的所有已批准端
// （验收 O59：两个页面开着同一会话，A 发 /context，B 看不到 Context Usage 表）
// 测什么：真 server + fake-claude 本地命令档（吐 system/local_command_output 再收尾）。A、B 两个已批准连接，
//         A 发 /context，B 必须收到同一条 local-cmd 的 text_delta——和普通回复走同一条广播通道。
// 这一半是服务端的。2026-10-19 复现时 A、B 收到的事件逐条一致，O59 的症状丢在前端（finalizeStreams 把正文放进
// rAF、后台标签页暂停 rAF），由 E2E local-command-output.spec.ts 守；本文件钉住「服务端不只发给发送端」。
// 零 token：fake-claude 不跑模型。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from './_spawn-server.mjs';

const TOKEN = 'it-local-cmd-broadcast-token';
const OUTPUT = '## Context Usage\n| Category | Tokens |';

test('本地命令输出：发送端之外的已批准端也收到同一条 local-cmd 增量', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-it-local-cmd-'));
  const ws = join(root, 'ws');
  mkdirSync(ws);
  const cwd = realpathSync(ws);
  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: root,
    CCM_FAKE_CLAUDE_MODE: 'turn-local-command', CCM_FAKE_CLAUDE_REPLY: OUTPUT,
  });
  const sockets = [];
  // Host: localhost = 本机 bypass，直接进 approved 房间
  const connect = deviceToken => {
    const events = [];
    const sock = ioClient(`http://127.0.0.1:${server.port}`, {
      auth: { token: TOKEN, deviceToken }, transports: ['websocket'], reconnection: false, timeout: 4000,
      extraHeaders: { Host: 'localhost' },
    });
    sockets.push(sock);
    sock.on('agent:event', e => events.push(e));
    return { sock, events, ready: new Promise(resolve => sock.once('connect', resolve)) };
  };
  const call = (sock, event, payload) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack 超时`)), 15000);
    sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
  });
  const outputsOf = c => c.events.filter(e => e.type === 'text_delta' && String(e.payload?.messageId).startsWith('local-cmd-'));

  try {
    const a = connect('it-local-cmd-a');
    const b = connect('it-local-cmd-b');
    await Promise.all([a.ready, b.ready]);
    const sent = await call(a.sock, 'user:message', { text: '/context', cwd, clientMessageId: 'local-cmd-1' });
    assert.equal(sent.ok, true, `前提：发得出去，实际 ${JSON.stringify(sent)}`);
    await waitForCondition(() => b.events.some(e => e.type === 'result'), { timeoutMs: 10_000, label: 'B 收到这一轮的 result' });

    assert.equal(outputsOf(a).length, 1, `前提：发送端收到输出，实际 ${JSON.stringify(outputsOf(a))}`);
    assert.equal(outputsOf(b).length, 1, 'B 开着同一会话却收不到本地命令的输出');
    assert.equal(outputsOf(b)[0].payload.text, OUTPUT);
    assert.equal(outputsOf(b)[0].seq, outputsOf(a)[0].seq, '两端收到的是同一条信封');
  } finally {
    for (const s of sockets) { try { s.close(); } catch { /* 已关闭 */ } }
    await killServer(server.proc);
    rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});
