// tests/invariants/server/settings-mode-escalation.test.mjs —— 真 server 上，仓库 settings 的升级档进不了新会话
// 守护：APPROVAL-03（project / local 层 settings 的 defaultMode 不得升级新会话的初始权限档；user 层照常生效）
// 测什么：真 app/server.js 子进程上，已连接文件夹里的仓库提交了 permissions.defaultMode=bypassPermissions，
//   在它的新会话页发首条消息懒开出来的 FRESH 实例，权限档是 default。正对照：另一个仓库写 plan，同一条路径
//   开出来就是 plan，证明这条路径读到了仓库 settings、不是读不到才落 default
// 不测什么 + 为什么：① 各层各档的取舍在 S1（tests/invariants/settings-mode-escalation.test.mjs）
//   ② user 层照常生效只在 S1 测：这里要写 HOME 下的 ~/.claude/settings.json，同一个 job 里别的 S2 文件也读它
//   ③ 空首页显示的 defaultPermissionMode 不单独断言：session:new 先推的那一帧本来就是 L4 的 default，
//   「等到它是 default」在修复前也会通过；它和 FRESH 读的是同一份缓存 ④ CLI 起来后自报的档（init 对账）：
//   fake-claude 不吐 init，属 S5
// 槽位：S2（真 app/server.js 子进程 + 假 CLI + 一次性 CCM_DATA_DIR；无真 turn）
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';

const TOKEN = 'inv-mode-escalation-token';

let root, thirdParty, planned, server, sock;
const events = [];

test.before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-inv-mode-escalation-')));
  thirdParty = join(root, 'third-party');   // 提交了免审批档的第三方仓库
  planned = join(root, 'planned');          // 正对照：写的是非升级档
  for (const [dir, mode] of [[thirdParty, 'bypassPermissions'], [planned, 'plan']]) {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: mode } }));
  }
  server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIRS: `${thirdParty},${planned}`, CCM_DATA_DIR: join(root, 'data') });
  sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'inv-mode-escalation-device' },
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
  const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时——悬挂的 ack 在手机上就是永远转圈`)), 10000);
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

// 照手机上的操作：进 cwd 的新会话页、发首条消息，懒开一个 FRESH 实例，返回它开出来的权限档
async function freshInstanceMode(cwd, clientMessageId) {
  assert.equal((await emit('session:new', { cwd }))?.ok, true);
  const ack = await emit('user:message', { text: '开一轮，stub 不会回 result', clientMessageId, cwd });
  assert.equal(ack?.ok, true, `首发应被接受，实际 ${JSON.stringify(ack)}`);
  const inst = await waitFor(
    () => events.filter(e => e.type === 'instances').pop()?.payload?.instances?.find(i => i.cwd === cwd),
    `${cwd} 上懒开的实例出现在 instances 广播里`);
  return inst.permissionMode;
}

test('正对照：仓库写的非升级档 plan，新会话就以 plan 开（这条路径读得到仓库 settings）', async () => {
  assert.equal(await freshInstanceMode(planned, 'mode-esc-planned'), 'plan',
    '新会话没拿到仓库 settings 里的 plan——读不到时下一条恒为 default，那条断言就什么都没证明');
});

test('第三方仓库提交了 bypassPermissions：在它里面新开的会话仍是 default', async () => {
  assert.equal(await freshInstanceMode(thirdParty, 'mode-esc-third-party'), 'default',
    '仓库的 .claude/settings.json 把手机上新开的会话设成了免审批：采纳 defaultMode 前没过 filterEscalatingDefaultMode');
});
