// scripts/smoke-permmode.js —— ADR-012 权限档切换契约验收（零 token）：
// 台阶3（ADR-010）后权限档升为 per-instance：setPermissionMode 作用于指定实例（instanceId 参数，缺省
// viewingInstanceId）。新会话懒创建期（viewingInstanceId===null、无实例）切档 = 存 pending（按 viewingCwd）
// + echo 新档让 UI 立即上屏（ADR-0012「新会话预设档」），首条消息懒开实例时消费。本测验证：
//   - 新连接重放 permission_mode（无实例、未设 pending 时 default）
//   - 新会话懒创建期切档 → echo 新档（instanceId:null，前端不过滤照常上屏）+ 存 pending（不广播给他设备）
//   - 非法档拒绝（不 echo 新档、不存 pending）
//   - 合成事件格式（epoch=server, seq=0）
// 真实切档行为（有实例时广播、setPermissionMode 真切 SDK）由 smoke-permmode-e2e.js 验证；
// pending 被首条消息懒开实例消费（instances 携新档）由 /verify 假 CLAUDE_BIN 零 token 实证。
// Per-instance 路由逻辑由 smoke-stage3-concurrent.js 的「非法 instanceId 缺省落 viewingInstanceId」覆盖。
import {
  makeChecker, sleep, waitHealth, connectSocket,
  spawnServer, killServer, makeWorkDir, rmWorkDir,
  onSignal, lastEventOf
} from './test-helpers.mjs';

const APP_PORT = 3250;
const workDir = makeWorkDir('ccm-permmode-');
const { check, exitOnFailure } = makeChecker();

let server = null;
onSignal(() => { server && killServer(server); rmWorkDir(workDir); });

async function setMode(s, events, mode) {
  const before = events.length;
  s.emit('user:setPermissionMode', { mode }); // 无 instanceId → 缺省 viewingInstanceId（此时为 null）
  await sleep(300);
  return events.slice(before);
}

const run = async () => {
  server = spawnServer(APP_PORT, workDir);
  await waitHealth(APP_PORT);

  const { socket: s1, events: e1 } = await connectSocket(APP_PORT, { label: 'dev1' });
  await sleep(500);

  // 1) 初始无实例时，重放 default
  const replay = lastEventOf(e1, 'permission_mode');
  check('新连接重放 permission_mode=default（无实例时缺省）', replay?.payload.mode === 'default', JSON.stringify(replay?.payload));
  check('重放为合成事件（epoch=server, seq=0, sessionId=null）',
    replay?.epoch === 'server' && replay?.seq === 0 && replay?.sessionId === null);

  // 2) 新会话懒创建期（viewingInstanceId===null）切档 → echo 新档 + 存 pending（ADR-0012「新会话预设档」）
  let got = await setMode(s1, e1, 'plan');
  const echoPlan = got.find(e => e.type === 'permission_mode');
  check('新会话懒创建期切 plan → echo 新档 plan（存 pending，不再丢弃设置）',
    echoPlan?.payload.mode === 'plan', JSON.stringify(echoPlan?.payload));
  check('新会话切档 echo 带 instanceId:null（前端不过滤、照常上屏 select）',
    echoPlan !== undefined && echoPlan.instanceId === null, 'instanceId=' + JSON.stringify(echoPlan?.instanceId));

  got = await setMode(s1, e1, 'bypassPermissions');
  check('新会话懒创建期切 bypass → echo 新档 bypassPermissions（pending 覆盖）',
    got.find(e => e.type === 'permission_mode')?.payload.mode === 'bypassPermissions');

  // 3) 非法档拒绝（无实例也要校验）
  got = await setMode(s1, e1, 'hacker');
  check('非法档不广播 permission_mode（server 校验拒绝）', !got.find(e => e.type === 'permission_mode'),
    '收到类型: ' + (got.map(e => e.type).join(',') || '无'));

  // 4) 新连接仍重放 default：pending 是 socket 级（按 viewingCwd 暂存、只 echo 给设档那台、不进 permModeOf），
  //    故另一设备此空窗期连上重放 permModeOf(null)=default，直到首条消息开实例后 instances 广播才一致。
  const { socket: s2, events: e2 } = await connectSocket(APP_PORT, { label: 'dev2' });
  await sleep(500);
  check('多设备：新连接重放 default（pending 不广播给他设备，首条消息开实例后才一致）',
    lastEventOf(e2, 'permission_mode')?.payload.mode === 'default', JSON.stringify(lastEventOf(e2, 'permission_mode')?.payload));

  s1.close(); s2.close();
  killServer(server); rmWorkDir(workDir);
  exitOnFailure();
};

run().catch(e => { console.error('❌ 测试异常:', e.message); server && killServer(server); rmWorkDir(workDir); process.exit(1); });
