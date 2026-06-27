// scripts/smoke-effort.js —— ADR-015 思考强度切换契约验收（零 token）：
// 台阶3（ADR-010）后 effort 升为 per-instance：setEffort 作用于指定实例（instanceId 参数，缺省
// viewingInstanceId）。新会话懒创建期（viewingInstanceId===null、无实例）切档 = 存 pending（按 viewingCwd）
// + echo 新档（ADR-0015「新会话预设档」），首条消息懒开实例时消费（null=模型默认是合法档，用 Map.has 判存在）。本测验证：
//   - 新连接重放 effort_mode（无实例、未设 pending 时 null）
//   - 新会话懒创建期切档 → echo 新档 + 存 pending（不广播给他设备）
//   - 非法档拒绝（单发拨回 null、不存 pending）
//   - 合成事件格式（epoch=server, seq=0）
//   - CLI 档位表漂移检测（--effort bogus warning 携权威档位表）
// 真实切档行为（有实例时广播+置换、setEffort 真注入 --effort）由真 token 轮次观察验证；
// pending 被首条消息懒开实例消费（instances 携新档）由 /verify 假 CLAUDE_BIN 零 token 实证。
// Per-instance 路由逻辑由 smoke-stage3-concurrent.js 的「非法 instanceId 缺省落 viewingInstanceId」覆盖。
import { execFile } from 'node:child_process';
import {
  makeChecker, sleep, waitHealth, connectSocket,
  spawnServer, killServer, makeWorkDir, rmWorkDir,
  onSignal, lastEventOf
} from './test-helpers.mjs';

const APP_PORT = 3251;
const workDir = makeWorkDir('ccm-effort-');
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const { check, exitOnFailure } = makeChecker();

let server = null;
onSignal(() => { server && killServer(server); rmWorkDir(workDir); });

async function setEffort(s, events, level) {
  const before = events.length;
  s.emit('user:setEffort', { level });
  await sleep(300);
  return events.slice(before);
}

function cliEffortLevels() {
  return new Promise(resolve => {
    execFile('claude', ['--effort', 'bogus', '--version'], { timeout: 10000 }, (err, stdout, stderr) => {
      const m = /Valid values:\s*([^.\n]+)/.exec(`${stdout}\n${stderr}`);
      resolve(m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : null);
    });
  });
}

const run = async () => {
  server = spawnServer(APP_PORT, workDir);
  await waitHealth(APP_PORT);

  const { socket: s1, events: e1 } = await connectSocket(APP_PORT, { label: 'dev1' });
  await sleep(500);

  const replay = lastEventOf(e1, 'effort_mode');
  check('新连接重放 effort_mode level=null（无实例时缺省）', replay?.payload.level === null, JSON.stringify(replay?.payload));
  check('重放为合成事件（epoch=server, seq=0, sessionId=null）',
    replay?.epoch === 'server' && replay?.seq === 0 && replay?.sessionId === null);

  let got = await setEffort(s1, e1, 'high');
  const echoHigh = got.find(e => e.type === 'effort_mode');
  check('新会话懒创建期切 high → echo 新档 high（存 pending，不再丢弃设置）',
    echoHigh?.payload.level === 'high', JSON.stringify(echoHigh?.payload));
  check('新会话切档 echo 带 instanceId:null（前端不过滤、照常上屏）',
    echoHigh !== undefined && echoHigh.instanceId === null, 'instanceId=' + JSON.stringify(echoHigh?.instanceId));

  got = await setEffort(s1, e1, 'hacker');
  check('非法档单发拨回 effort_mode level=null（不存储）',
    got.find(e => e.type === 'effort_mode')?.payload.level === null);
  check('非法档触发 system 错误提示', got.some(e => e.type === 'system' && /未知思考强度档/.test(e.payload?.message)));

  // pending 是 socket 级（按 viewingCwd 暂存、只 echo 给设档那台、不进 effortOf），故另一设备此空窗期
  // 连上重放 effortOf(null)=null，直到首条消息开实例后 instances 广播才一致。
  const { socket: s2, events: e2 } = await connectSocket(APP_PORT, { label: 'dev2' });
  await sleep(500);
  check('多设备：新连接重放 level=null（pending 不广播给他设备，首条消息开实例后才一致）',
    lastEventOf(e2, 'effort_mode')?.payload.level === null, JSON.stringify(lastEventOf(e2, 'effort_mode')?.payload));

  const cliLevels = await cliEffortLevels();
  check('CLI 档位表与 server 硬编码一致（漂移检测）',
    cliLevels && EFFORT_LEVELS.every(l => cliLevels.includes(l)) && cliLevels.length === EFFORT_LEVELS.length,
    `CLI: [${cliLevels?.join(', ')}], server: [${EFFORT_LEVELS.join(', ')}]`);

  s1.close(); s2.close();
  killServer(server); rmWorkDir(workDir);
  exitOnFailure();
};

run().catch(e => { console.error('❌ 测试异常:', e.message); server && killServer(server); rmWorkDir(workDir); process.exit(1); });
