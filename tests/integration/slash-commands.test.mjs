// tests/integration/slash-commands.test.mjs —— 斜杠命令清单走 supportedCommands()（#456）
// 背景：菜单原来只吃 init.slash_commands，那只有名字，而且 CLI 要等首条消息之后才发 init——从没聊过的新工作区，
// 发消息之前菜单里只剩前端本地的 /model、/rewind。现在 scout 与每个实例起来时都拉 supportedCommands()
// （initialize 响应，带说明 / 参数提示 / 别名），server 归一后落 per-cwd 缓存并推给前端。
// fake-claude 的 CCM_FAKE_CLAUDE_COMMANDS 两处都给：initialize 响应带完整对象，system/init 只带名字（同真 CLI）。
// 零 token 成本（fake-claude，不起真 claude）。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from './_spawn-server.mjs';

const TOKEN = 'slash-commands-test-token';
// 同名两行：标了 builtin 的那行才是 /review 实际执行的，菜单说明要跟它走
const COMMANDS = [
  { name: 'deploy', description: 'Deploy the app', argumentHint: '<env>' },
  { name: 'review', description: 'plugin review', argumentHint: '' },
  { name: 'review', description: 'builtin review', argumentHint: '', builtin: true },
];

function createClient(port) {
  const socket = ioClient(`http://127.0.0.1:${port}`, { auth: { token: TOKEN }, transports: ['websocket'], reconnection: false });
  const events = [];
  socket.on('agent:event', e => events.push(e));
  return {
    socket,
    waitForConnect(timeout = 5000) {
      return new Promise((resolve, reject) => {
        if (socket.connected) return resolve();
        const timer = setTimeout(() => reject(new Error('connect timeout')), timeout);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
      });
    },
    waitForEvent(type, predicate, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const matches = e => e.type === type && (!predicate || predicate(e));
        const existing = events.find(matches);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
        const handler = e => {
          if (matches(e)) { clearTimeout(timer); socket.off('agent:event', handler); resolve(e); }
        };
        socket.on('agent:event', handler);
      });
    },
    disconnect() { socket.disconnect(); },
  };
}

const deployOf = e => (e.payload?.slashCommands || []).find(c => c?.name === 'deploy');

test.describe('斜杠命令清单：supportedCommands() 的说明在首条消息前就到、init 来了也不丢', () => {
  let proc, port, workdir, dataDir;

  test.before(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'ccm-slash-wd-'));
    dataDir = mkdtempSync(join(tmpdir(), 'ccm-slash-data-'));
    const started = await spawnServer({
      AUTH_TOKEN: TOKEN,
      WORK_DIR: workdir,
      CCM_DATA_DIR: dataDir,
      CLAUDE_BIN: join(process.cwd(), 'tests/fixtures/fake-claude.sh'),
      CCM_FAKE_CLAUDE_MODE: 'init',
      CCM_FAKE_CLAUDE_COMMANDS: JSON.stringify(COMMANDS),
      IDLE_TIMEOUT_MS: '120000',
    });
    proc = started.proc;
    port = started.port;
  });

  test.after(async () => {
    if (proc) { await killServer(proc); proc = null; }
    for (const d of [workdir, dataDir]) {
      if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  });

  test('新工作区不发消息：scout 拉到的清单带说明推到手机，同名只留 builtin 那行', async () => {
    const client = createClient(port);
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances');
      client.socket.emit('session:new', { cwd: workdir });
      const pushed = await client.waitForEvent('init', e => Boolean(deployOf(e)), 20000);
      assert.deepEqual(deployOf(pushed), { name: 'deploy', description: 'Deploy the app', argumentHint: '<env>' });
      const reviews = pushed.payload.slashCommands.filter(c => c?.name === 'review');
      assert.deepEqual(reviews, [{ name: 'review', description: 'builtin review' }]);
    } finally {
      client.disconnect();
    }
  });

  // 真 CLI 的 system/init 只带名字。server 原样转发的话，每轮 init 都把手机上的菜单降级成光秃秃的名字
  test('首条消息后的真 init 只带名字：转给手机的那份仍带说明', async () => {
    const client = createClient(port);
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances');
      client.socket.emit('user:message', { text: 'hello', clientMessageId: 'slash-live-1' });
      const live = await client.waitForEvent('init', e => e.payload?.model === 'fake-claude', 20000);
      assert.deepEqual(deployOf(live), { name: 'deploy', description: 'Deploy the app', argumentHint: '<env>' },
        `真 init 的命令被降级了：${JSON.stringify(live.payload.slashCommands)}`);
      // 实例自己拉到的清单直播给手机：同样是归一后的，同名只留 builtin 那行
      const pushed = await client.waitForEvent('slash_commands', null, 20000);
      assert.deepEqual(pushed.payload.slashCommands.filter(c => c?.name === 'review'), [{ name: 'review', description: 'builtin review' }]);
    } finally {
      client.disconnect();
    }
  });
});
