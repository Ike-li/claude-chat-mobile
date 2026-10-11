// tests/integration/lazy-open-prefs.test.mjs —— 空首页设的档位，懒开到别的目录时不能丢
//
// 形态（2026-09-24 查出的既有缺陷）：空首页（还没有实例）上切权限档 / 思考强度，server 按 viewingCwd
// （项目轴：仓库）暂存；首条消息带「在新 worktree 里开」时，实例懒开在新建的 worktree 路径上，而
// openInstance 按实例 cwd（驾驶轴：worktree）去取暂存值——键不一样，用户刚选的 plan 静默变回 default。
// 无文件夹会话（scratch）是同一个形态：暂存在 scratch 根，实例开在 mkdtemp 出来的子目录。
// 修复：暂存与取用统一按项目轴（workspaceCwdOf）归键。
//
// 不测什么 + 为什么：档位的优先级规则本身（L0 pending > L3 CLI settings > L4 硬默认）是纯函数，
// 在 tests/unit/cli-settings-defaults*.test.mjs；这里只证明懒开路径上 L0 没被丢掉。
// 执行位守卫：必须是第一条 import。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from './_spawn-server.mjs';

const TOKEN = 'int-lazy-open-prefs-token';

test('空首页设成 plan，首条消息懒开到新 worktree：实例仍是 plan', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-int-lazyprefs-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-m', 'init');

  const server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIRS: repo, CCM_DATA_DIR: join(root, 'data') });
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'int-lazyprefs-device' },
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
    const emit = (event, payload) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), 20000);
      sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
    });

    // 空首页：没有实例，切档只能暂存（server 回显 permission_mode 让前端 select 立刻上屏）
    await emit('session:new', { cwd: repo });
    sock.emit('user:setPermissionMode', { mode: 'plan' });
    const deadline = Date.now() + 5000;
    while (!events.some(e => e.type === 'permission_mode' && e.payload?.mode === 'plan') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(events.some(e => e.type === 'permission_mode' && e.payload?.mode === 'plan'), '前提：空首页切档被暂存并回显');

    const res = await emit('user:message', {
      text: '在新 worktree 里做', cwd: repo, useWorktree: true, sourceBranch: 'main', clientMessageId: 'lazy-prefs-1',
    });
    assert.equal(res?.ok, true, `首条消息应被接受：${JSON.stringify(res)}`);
    const inst = events.filter(e => e.type === 'instances').pop()?.payload?.instances?.find(i => i.instanceId === res.instanceId);
    assert.ok(inst?.cwd?.includes(join('.claude', 'worktrees')), `前提：实例开在新 worktree 里，实际 ${inst?.cwd}`);
    assert.equal(inst.permissionMode, 'plan',
      '空首页选的 plan 在懒开到 worktree 时丢了——暂存按仓库归键、取用按 worktree 路径归键，键不一样');
  } finally {
    try { sock.close(); } catch { /* 已关闭 */ }
    await killServer(server.proc);
    rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});
