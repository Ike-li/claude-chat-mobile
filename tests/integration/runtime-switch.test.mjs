// tests/integration/runtime-switch.test.mjs —— 回合进行中还能改哪些参数（真 server + 可驱动假 CLI）
//
// 三个轴的 busy 语义各不相同，且【不对称是有意的】——它们受约束的理由根本不是同一个：
//   · 思考强度：具体档互切走控制请求（放行）／回模型默认要置换实例（拒绝）
//   · 权限档：影响的是工具审批闸门而非 API 请求参数，推迟生效就失去意义 → 全程放行
//   · 模型：没有独立控制事件，随 user:message 捎带，而在途轮闸会拒收消息 → 中途够不着
// 把三条放一个文件，是因为「回合进行中能改什么」是同一个产品问题，读的人需要一次看全。
//
// 【为什么必须在这一层】观察点是 socket handler 的分支走向：回合进行中切【具体档】要走轻路径
// （apply_flag_settings 控制请求、不置换实例）并广播 effort_mode；切回【模型默认】要被 busy 守卫拦下。
// 纯函数层表达不了「守卫在 a.setEffort() 调用之前还是之后」，而那正是 2026-09-09 修的缺陷所在——
// 守卫（7febabc，2026-07-28）加在分叉【之前】，那时切档必然 dispose+resume，拦住是对的；
// 439bb02 把具体档互切改成控制请求后轻路径不再置换实例，守卫却没跟着下移，于是把本来安全的
// 轻路径一起拦了。这个 handler 在此之前【零测试覆盖】，所以那次改造挪不挪守卫都不会有东西变红。
//
// 【前置态怎么造】CCM_FAKE_CLAUDE_MODE=init：应答 initialize、首条 user 时吐 system/init
// （于是拿得到 sessionId，绕开 handler 里「FRESH 只记 pending」那条分支），但【不吐 result】
// ⇒ pendingTurns 停在 1、实例恒 busy。假 CLI 对任何 control_request 一律回 success
// （tests/fixtures/fake-claude.mjs），所以轻路径走得通，不会超时成 needsSwap 以外的第三种失败。
//
// 不测什么 + 为什么：
//  ① 档位是否真被 CLI 应用 —— 假 CLI 无差别回 success，这一层证不了。真 CLI 的四条静默失败边界
//     （非法值被 zod 吞 / ultracode 不回落 / null 清不回默认 / 切模型连带重置）由
//     tests/unit/agent-control.test.mjs 的 setEffort() 组覆盖，那里 mock 的是 q，造得出 reject 与超时。
//  ② 轮次中途切档在【本轮】还是【下一轮】生效 —— 要观察思考深度实际变化，需真模型，归 S5。
//  ③ 重路径置换后的实例接续 —— 与 externalDirty 走同一条 dedupedResume，已由
//     tests/invariants/server/external-dirty.test.mjs 覆盖，不在此重复。
//
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR + 可驱动假 CLI）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from './_spawn-server.mjs';

const TOKEN = 'effort-switch-token';
const SESSION_ID = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';

// 起一台 server + 一条连上的 socket，并把首条消息发出去（实例懒开 → 拿到 sessionId → 停在 busy）。
// 返回的 events 是累积的 agent:event 流，各用例自己过滤。
async function openBusySession(tag) {
  const root = mkdtempSync(join(tmpdir(), `ccm-effort-${tag}-`));
  const ws = join(root, 'ws');
  mkdirSync(ws);
  const cwd = realpathSync(ws);

  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: root,
    CCM_FAKE_CLAUDE_MODE: 'init',                 // 吐 init 拿 sessionId，但不吐 result ⇒ 恒 busy
    CCM_FAKE_CLAUDE_SESSION_ID: SESSION_ID,
  });

  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: `effort-${tag}-device` },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  sock.on('agent:event', e => events.push(e));

  const cleanup = async () => {
    try { sock.close(); } catch { /* 已断开 */ }
    await killServer(server.proc);
    rmSync(root, { recursive: true, force: true });   // mkdtemp 出来的一次性根
  };

  try {
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
    });

    const ack = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('user:message ack 超时')), 15000);
      sock.emit('user:message', { text: '起一轮，别收尾', cwd, clientMessageId: `${tag}-1` },
        res => { clearTimeout(timer); resolve(res); });
    });
    assert.equal(ack.ok, true, `首发应被接受，实际 ${JSON.stringify(ack)}`);

    // 正对照：先证明实例真的停在 busy。假 CLI 若哪天开始吐 result，下面所有断言都会在
    // 空闲态上跑成假绿——「busy 时能切」和「空闲时能切」在结果上完全一样。
    // payload 的数组字段叫 instances（app.js:1068 的 `instances: list`），不是 list——
    // 写成 list 时 optional chaining 会一路吞成 undefined，正对照因此超时，这条是那次的产物。
    const lastInstances = () => [...events].reverse().find(e => e.type === 'instances')?.payload;
    await waitForCondition(
      () => lastInstances()?.instances?.some(x => x.sessionId === SESSION_ID && x.turnRunning === true),
      { timeoutMs: 15000, label: '实例进入 busy（turnRunning=true）' },
    );

    return { server, sock, events, cwd, cleanup, lastInstances };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

const setEffort = (sock, level) => sock.emit('user:setEffort', { level });

test('回合进行中切【具体档】：走轻路径生效，不被 busy 拦下', async () => {
  const { sock, events, cleanup } = await openBusySession('light');
  try {
    const before = events.length;
    setEffort(sock, 'high');

    // 轻路径成功的外部可观察面：广播一条 effort_mode，level 就是请求的档。
    const broadcast = await waitForCondition(
      () => events.slice(before).find(e => e.type === 'effort_mode' && e.payload?.level === 'high'),
      { timeoutMs: 15000, label: 'effort_mode 广播 level=high' },
    );
    assert.ok(broadcast, 'busy 时切具体档必须走 apply_flag_settings 轻路径并广播新档');

    // 反向：不得出现「当前有任务在运行」那条拒绝。守卫若还在分叉前，这里会先红在上面的
    // waitForCondition 上；这条断言钉的是「即便将来换了实现，也不许用 busy 当理由拒具体档」。
    const refused = events.slice(before).find(
      e => e.type === 'system' && /有任务在运行/.test(e.payload?.message || ''));
    assert.equal(refused, undefined,
      `具体档互切不置换实例，不该被 busy 拒绝，实际收到：${JSON.stringify(refused?.payload)}`);
  } finally {
    await cleanup();
  }
});

test('回合进行中切回【模型默认】：被守卫拦下，实例不置换', async () => {
  const { sock, events, cleanup, lastInstances } = await openBusySession('swap');
  try {
    // 先 pin 一个具体档：实例初始 effort 就是 null，不先离开的话「切回模型默认」会被 handler 的
    // 幂等闸（level === effortOf(id)）直接 return，测的就成了幂等而不是守卫。走的是上一条用例
    // 已证明可行的轻路径。
    setEffort(sock, 'high');
    await waitForCondition(
      () => events.find(e => e.type === 'effort_mode' && e.payload?.level === 'high'),
      { timeoutMs: 15000, label: '前置：先 pin 到 high' },
    );

    const instanceIdBefore = lastInstances().instances.find(x => x.sessionId === SESSION_ID).instanceId;
    const before = events.length;
    setEffort(sock, null);

    // 回「模型默认」只能靠 dispose+resume（CLI 的 applied.effort 恒是具体档，没有「未 pin」态可回），
    // 而置换会 kill 在途 turn / bg / 审批——危害与 SRV-003 同源，必须拒绝。
    const refused = await waitForCondition(
      () => events.slice(before).find(
        e => e.type === 'system' && /有任务在运行/.test(e.payload?.message || '')),
      { timeoutMs: 15000, label: '回模型默认被 busy 守卫拒绝' },
    );
    assert.match(refused.payload.message, /具体档位/,
      '拒绝文案要给出替代路径（具体档位此刻就能切），否则用户只知道被拒、不知道还能做什么');

    // 实例没被换掉——拒绝必须是真拒绝，不能先 dispose 了再报错。
    assert.equal(
      lastInstances().instances.find(x => x.sessionId === SESSION_ID)?.instanceId,
      instanceIdBefore,
      '守卫拒绝后实例 id 不得变化（变了说明置换已经发生，在途 turn 已被 kill）',
    );
  } finally {
    await cleanup();
  }
});

test('回合进行中切【权限档】：全程放行，不受 busy 约束', async () => {
  const { sock, events, cleanup } = await openBusySession('perm');
  try {
    const before = events.length;
    // 权限档影响的是工具审批闸门，不是发给 API 的请求参数——推迟到回合结束才生效就失去了意义
    // （模型正要动手的那个工具就是用户想拦的那个）。所以这条路径【故意】没有 busy 守卫，
    // agent.setPermissionMode() 的注释也明说「本方法没有 busy 守卫、轮次进行中可被调用」。
    sock.emit('user:setPermissionMode', { mode: 'plan' });

    const broadcast = await waitForCondition(
      () => events.slice(before).find(e => e.type === 'permission_mode' && e.payload?.mode === 'plan'),
      { timeoutMs: 15000, label: 'permission_mode 广播 mode=plan' },
    );
    assert.ok(broadcast, '回合进行中切权限档必须立即生效并广播');

    // 反向：不得借 busy 拒绝。给这条一个独立断言而不只依赖上面的超时，是因为两者失败时
    // 指向的原因不同——超时可能是广播丢了，这条则明确说「被当成忙拒了」。
    const refused = events.slice(before).find(
      e => e.type === 'system' && /有任务在运行/.test(e.payload?.message || ''));
    assert.equal(refused, undefined,
      `权限档不碰实例生命周期，不该被 busy 拒绝，实际收到：${JSON.stringify(refused?.payload)}`);
  } finally {
    await cleanup();
  }
});

test('回合进行中切【模型】：够不着——模型随消息捎带，而在途轮拒收消息', async () => {
  const { sock, cwd, cleanup } = await openBusySession('model');
  try {
    // 模型没有独立控制事件：前端把选择塞进 user:message，server 在 send() 里差分调 setModel()。
    // 于是「回合进行中切模型」这个动作在协议上根本不存在——它等价于「再发一条消息」，
    // 而排队已移除（2026-07-30）后在途轮闸会直接拒收。这条用例钉的就是这个结构性事实：
    // 不是某个守卫拦了模型，是那条路径压根到不了 setModel。
    const ack = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('第二条 user:message 的 ack 超时')), 15000);
      sock.emit('user:message',
        { text: '带着新模型再发一条', model: 'claude-opus-5', cwd, clientMessageId: 'model-2' },
        res => { clearTimeout(timer); resolve(res); });
    });

    assert.equal(ack.ok, false, '在途轮期间不得收下第二条消息（收下就意味着排队回来了）');
    // ⚠ 这一维【不能省】，而且它比上一条更灵敏：2026-09-09 注入实验里把 server 的在途轮闸整条删掉，
    // ack.ok 依然是 false —— 因为 agent.send() 自己还有一层 pendingTurns 兜底。于是「拒绝」看起来
    // 还在，只有 busy 维静默消失。前端两条 present* 判定都以 ack.busy 识别「忙拒收」落 blocked 终态，
    // 漏了它会落兜底 requeue：离线队列每次重连自动重发、永不退场。只断言 ok:false 抓不住这个形态。
    assert.equal(ack.busy, true,
      'ack 必须带 busy:true——前端两条 present* 判定靠它落 blocked 终态，漏这一维会掉进离线队列永不退场');
    assert.match(ack.error || '', /运行中/, '拒绝理由要说明是在途轮，不是模型本身有问题');
  } finally {
    await cleanup();
  }
});
