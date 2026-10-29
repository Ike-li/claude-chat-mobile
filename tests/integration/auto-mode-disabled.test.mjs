// tests/integration/auto-mode-disabled.test.mjs —— settings 写了 disableAutoMode 时，手机上切不到 Auto（#461）
//
// 测什么：真 app/server.js 子进程上，仓库 .claude/settings.json 写了 disableAutoMode。① instances 广播带
//   autoModeDisabled，前端据此把 Auto 磁贴置灰 ② 新会话页上发 user:setPermissionMode auto 被拒：回一条说明、
//   把选择器拨回，也不记成 pending——首条消息开出来的会话仍是 default ③ 已开的会话上同样被拒，不发给 CLI。
//   正对照：没写 disableAutoMode 的仓库，同一条路径照常能切到 Auto，证明拒的原因是 settings、不是 auto 本身
// 不测什么 + 为什么：① 判据（'disable' 与 true 两种写法、哪几层算数、默认档 auto→default）是纯函数，在
//   tests/unit/cli-settings-defaults.test.mjs ② 磁贴置灰与点击无效在 E2E P0-09zb ③ 禁用后真 CLI 自己怎么反应：
//   要真 CLI，留给机主
// 执行位守卫：必须是第一条 import。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from './_spawn-server.mjs';

const TOKEN = 'int-auto-mode-disabled-token';

let root, locked, open, server, sock;
const events = [];

test.before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-int-auto-off-')));
  locked = join(root, 'locked');   // settings 禁用了 auto
  open = join(root, 'open');       // 正对照：什么都没写
  mkdirSync(join(locked, '.claude'), { recursive: true });
  mkdirSync(open, { recursive: true });
  writeFileSync(join(locked, '.claude', 'settings.json'), JSON.stringify({ disableAutoMode: 'disable' }));
  server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIRS: `${locked},${open}`, CCM_DATA_DIR: join(root, 'data') });
  sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'int-auto-off-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },   // 本机直连：bypass 设备门，本文件只测权限档
  });
  sock.on('agent:event', e => events.push(e));
  await new Promise((resolve, reject) => {
    sock.on('connect', resolve);
    sock.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
  });
});

test.after(async () => {
  try { sock?.close(); } catch { /* 已关闭 */ }
  if (server) await killServer(server.proc);
  if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

const emit = (event, payload) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), 10000);
  sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
});
const waitFor = async (pred, what, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = pred();
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`等不到：${what}`);
};
const after = (mark, pred) => () => events.slice(mark).find(pred);
const refusal = e => e.type === 'system' && /disableAutoMode/.test(e.payload?.message || '');

test('正对照：没写 disableAutoMode 的仓库，新会话页切 Auto 照常暂存并回显', async () => {
  assert.equal((await emit('session:new', { cwd: open }))?.ok, true);
  const mark = events.length;
  sock.emit('user:setPermissionMode', { mode: 'auto' });
  await waitFor(after(mark, e => e.type === 'permission_mode' && e.payload?.mode === 'auto'),
    '切到 auto 的回显——这里都切不过去，下面那条「被拒」就什么都没证明');
  assert.equal(events.slice(mark).some(refusal), false, '没禁用的仓库不该收到拒切说明');
});

test('仓库禁用了 auto：新会话页上 instances 带 autoModeDisabled，切 Auto 被拒、不暂存', async () => {
  assert.equal((await emit('session:new', { cwd: locked }))?.ok, true);
  await waitFor(() => events.some(e => e.type === 'instances' && e.payload?.viewingCwd === locked && e.payload?.autoModeDisabled === true),
    'instances 带 autoModeDisabled=true（前端靠它把 Auto 置灰）');

  const mark = events.length;
  sock.emit('user:setPermissionMode', { mode: 'auto' });
  await waitFor(after(mark, refusal), '拒切说明（提到 disableAutoMode）');
  // 拒切后那帧 instances（把隐藏的 select 拨回）不断言：它和这段时间别的 instances 广播内容一样，区分不出来
  assert.equal(events.slice(mark).some(e => e.type === 'permission_mode' && e.payload?.mode === 'auto'), false,
    '被拒的 auto 不该再回显成已切换');

  const ack = await emit('user:message', { text: '开一轮，stub 不会回 result', clientMessageId: 'auto-off-first', cwd: locked });
  assert.equal(ack?.ok, true, `首发应被接受，实际 ${JSON.stringify(ack)}`);
  const inst = await waitFor(
    () => events.filter(e => e.type === 'instances').pop()?.payload?.instances?.find(i => i.cwd === locked),
    `${locked} 上懒开的实例出现在 instances 广播里`);
  assert.equal(inst.permissionMode, 'default', '被拒的 auto 还是被记成了 pending，首条消息按 auto 开了会话');
});

test('仓库禁用了 auto：已开的会话上切 Auto 同样被拒，档位拨回原档', async () => {
  const inst = events.filter(e => e.type === 'instances').pop()?.payload?.instances?.find(i => i.cwd === locked);
  assert.ok(inst?.instanceId, '前提：上一条用例在 locked 里开出了实例');
  const mark = events.length;
  sock.emit('user:setPermissionMode', { mode: 'auto', instanceId: inst.instanceId });
  await waitFor(after(mark, refusal), '拒切说明（提到 disableAutoMode）');
  const echo = await waitFor(after(mark, e => e.type === 'permission_mode' && e.instanceId === inst.instanceId), '拨回的 permission_mode');
  assert.equal(echo.payload.mode, 'default', '拨回的应是会话原来的档');
});
