// tests/invariants/server/external-dirty.test.mjs —— SRV-003：终端写过之后，web 发送前必须置换实例
// 守护：SESSION-01 / SRV-003（externalDirty 为真且空闲时 dispose+resume 吸收外部轮次，
//       否则 SDK 子进程内存里没有那些轮次 → 模型看不到 → 从旧位置分叉出第二条 parentUuid 链）
// 覆盖：真实 transcript 外部增长 → catchUpTick 观察到 → 下一条 web 消息落在【新实例】上
//       · 纯后台任务期（pendingTurns=0 但有后台任务）的终端写入同样要被观察到，且下一条 web 消息
//         不得送进陈旧实例（2026-09-22 review P0：镜像引擎曾把后台任务期当成「己方在写盘」）
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR + 可驱动假 CLI）
//
// 【从哪来】2026-09-05 阶段 3：把源码文本断言换成行为断言。
// tests/invariants/cli-mirror-state.test.mjs 里那条是 readFileSync(app.js) + indexOf 比三个源码字符串的
// 先后（`if (a.externalDirty && a.sessionId)` → `if (a.isBusy())` → `await dedupedResume`）。
// 那种断言钉的是源码长什么样：改个变量名无故变红，保持文本不变而改坏行为照样绿。
//
// 【为什么以前写不了】原 fake-claude.sh 不产出任何输出 ⇒ a.sessionId 恒为 null，
// 而守卫是 `if (a.externalDirty && a.sessionId)` —— 整条分支不可达。
// 可驱动档（CCM_FAKE_CLAUDE_MODE=turn，见 tests/fixtures/fake-claude.mjs）解除了这个前提。
//
// ★【时序是这条用例的核心，不是凑出来的 sleep】catchUpTick 每 2500ms 跑一次，先建基线再判增长。
// 若在基线建立【之前】就追加，追加的内容会被当成基线本身，externalDirty 永不置位——
// 实测过：ack1 后 1.2s 就追加 ⇒ history_append(external) 恒为 0，用例看起来「功能没实现」。
// 所以两段等待都有下限含义：先等足两个 tick 让基线建牢，追加后再等足三个 tick 让它被观察到。
// 第二段用轮询到条件（外部 history_append 出现）而不是死等，坏掉时才耗满上限。
//
// 不测什么 + 为什么：
//  ① 侧二（忙碌时【不】置换）的「在途轮」那一维 —— 判定纯函数 externalDirtyBusyNack 已在
//     tests/unit/instance-routing.test.mjs 逐维覆盖（11 处断言）。本层要造它需要
//     「己方 turn 在跑的同时磁盘外部增长」，而 mirror-engine 的 localBusy 分支会把
//     在途轮期间的增长归因为己方写入、有意不标 externalDirty（2026-07-18 修的就是这条），
//     所以这一维在 S2 造不出干净的前置态。「后台任务」那一维造得出（fake-claude 的 turn-bg 档），
//     由本文件第二条用例覆盖。
//  ② 置换后模型是否真看到了那些轮次 —— 需要真模型，归 S5。

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';
import { encodeProjectDir } from '../../../app/src/shared/project-dir.js';

const TOKEN = 'inv-external-dirty-token';
const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const TICK_MS = 2500;   // mirror-engine 的 CATCH_UP_INTERVAL_MS

const sleep = ms => new Promise(r => setTimeout(r, ms));

// transcript 一行：CLI 落盘的形状（history.js 按 type/message/uuid/parentUuid 解析，isMeta 过滤）。
//
// 【uuid 必须由调用方串起来】2026-09-19：原实现在函数内部自己 randomUUID() 生成 uuid，而调用方
// 传进来的 parentUuid 是另外随机生成的一个值——**parentUuid 指向的条目根本不存在，链从来没接上**。
// 回显改成跟随 CLI 当前链之后这条就露馅了：链真相源只认得出物理最后那一条（其余全是够不到的孤点），
// 于是 baseline 恒等于 1、外部增长永远观察不到，用例的自我保护断言直接红。真实 CLI 写的 transcript
// 是一条完整的 parentUuid 链，这种断链形态在真实世界不存在，所以是夹具编错了外部契约、不是实现缺陷。
function transcriptLine(type, text, cwd, parentUuid = null, uuid = randomUUID()) {
  return `${JSON.stringify({
    type,
    uuid,
    parentUuid,
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
    cwd,
    isMeta: false,
    message: { role: type, content: [{ type: 'text', text }] },
  })}\n`;
}

test('SRV-003：终端写过之后，web 下一条消息必须落在置换后的新实例上', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-inv-extdirty-'));
  const ws = join(root, 'ws');
  mkdirSync(ws);
  const cwd = realpathSync(ws);

  // 一次性 cwd ⇒ encodeProjectDir 出来的项目目录也是一次性的，不会撞上别的会话。
  // 只在容器 / CI 跑（test:invariants:server 不在宿主机白名单），那里的 HOME 本身就是一次性目录。
  const projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${SESSION_ID}.jsonl`);

  // 种子：终端先聊过两句。没有它镜像建不起基线。
  // 种子两条串成真链：user(null → u1) ← assistant(u1 → u2)。u2 留给后面 append 的那轮接上去。
  const seedUser = randomUUID();
  const seedAssistant = randomUUID();
  writeFileSync(
    transcript,
    transcriptLine('user', '终端里先说的', cwd, null, seedUser)
      + transcriptLine('assistant', '终端里的回答', cwd, seedUser, seedAssistant),
  );

  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: root,
    CCM_FAKE_CLAUDE_MODE: 'turn',                 // 回合会收尾 → 空闲 → 走「该置换」那一侧
    CCM_FAKE_CLAUDE_SESSION_ID: SESSION_ID,       // 钉死 sid，好算出 transcript 落点
  });

  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'inv-extdirty-device' },
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
    const send = payload => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ack 超时：${JSON.stringify(payload)}`)), 15000);
      sock.emit('user:message', payload, res => { clearTimeout(timer); resolve(res); });
    });

    // ① web 先发一条：懒开实例、拿到 sessionId、回合收尾（turn 档）。
    const first = await send({ text: 'web 第一条', cwd, clientMessageId: 'ed-1' });
    assert.equal(first.ok, true, `首发应被接受，实际 ${JSON.stringify(first)}`);
    assert.ok(first.instanceId, 'ack 必须带回实例');

    // ② 等基线建牢。这不是保险起见的 sleep：在基线之前追加，追加内容会成为基线的一部分，
    //    externalDirty 永不置位（实测 1.2s 就追加 ⇒ 外部 append 恒为 0）。
    await sleep(TICK_MS * 2 + 500);

    // ③ 模拟终端在同一会话上又跑了一轮。
    // 接在种子那条链的末端（seedAssistant）后面，模拟终端在同一条链上继续写。
    const extUser = randomUUID();
    const extAssistant = randomUUID();
    appendFileSync(
      transcript,
      transcriptLine('user', '终端后来又说的', cwd, seedAssistant, extUser)
        + transcriptLine('assistant', '终端的新回答', cwd, extUser, extAssistant),
    );

    // ④ 轮询到「镜像观察到了外部增长」。坏掉时才耗满上限。
    const externalAppends = () => events.filter(e => e.type === 'history_append' && e.payload?.external).length;
    const deadline = Date.now() + TICK_MS * 4;
    while (externalAppends() === 0 && Date.now() < deadline) await sleep(150);
    assert.ok(
      externalAppends() > 0,
      'catchUpTick 没观察到终端写入——externalDirty 不会置位，本用例后面的断言就失去意义',
    );

    // ⑤ 再发一条：必须落在【新】实例上。同一个实例 = SDK 子进程内存里没有终端那两轮，
    //    模型看不到它们、还会从旧位置分叉出第二条 parentUuid 链。
    const second = await send({ text: 'web 第二条', cwd, clientMessageId: 'ed-2' });
    assert.equal(second.ok, true, `置换后应能正常发送，实际 ${JSON.stringify(second)}`);
    assert.notEqual(
      second.instanceId, first.instanceId,
      `终端写过之后必须置换实例吸收外部轮次，实际仍是 ${second.instanceId}——`
      + '不置换 = 模型看不到终端那两轮，从旧位置分叉',
    );

    // 第二信号：置换后的实例仍绑同一会话（置换是 dispose+resume，不是新开会话）。
    const live = events.filter(e => e.type === 'instances').pop()?.payload?.instances ?? [];
    const replaced = live.find(i => i.instanceId === second.instanceId);
    assert.ok(replaced, `新实例应出现在快照里，实际 ${JSON.stringify(live.map(i => i.instanceId))}`);
    assert.equal(replaced.sessionId, SESSION_ID, '置换必须 resume 回同一会话，不是另起一个');
  } finally {
    try { sock.close(); } catch { /* 已关闭 */ }
    await killServer(server.proc);
    rmSync(root, { recursive: true, force: true });      // safe-rm: mkdtemp 一次性目录
    rmSync(projectDir, { recursive: true, force: true }); // safe-rm: 目录名由本用例一次性 cwd 编码而来
  }
});

// 2026-09-22 review P0。纯后台任务期（web 起了个 dev server、回合已结束）：stateOf 把后台任务折进
// 'busy'，镜像引擎曾拿它当「己方在写盘」——终端在同一会话写的内容既不追平也不标 externalDirty；
// 而发送闸只拦在途轮（后台任务期本就允许发送，architecture.md「纯后台任务期不得锁发送」），于是
// 手机消息直接送进 SDK 内存停在旧位置的实例，从旧 parentUuid 分叉出第二条链。
// 修复后正确的结局是：终端写入被观察到（手机上能看见）+ 发送被拒（SRV-003：有后台任务时不能
// dispose+resume，那会杀掉用户的 dev server），拒绝原因如实说是后台任务。
test('SESSION-01：纯后台任务期终端写过之后，web 下一条消息不得送进陈旧实例', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-inv-extdirty-bg-'));
  const ws = join(root, 'ws');
  mkdirSync(ws);
  const cwd = realpathSync(ws);
  const projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${SESSION_ID}.jsonl`);

  const seedUser = randomUUID();
  const seedAssistant = randomUUID();
  writeFileSync(
    transcript,
    transcriptLine('user', '终端里先说的', cwd, null, seedUser)
      + transcriptLine('assistant', '终端里的回答', cwd, seedUser, seedAssistant),
  );

  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: root,
    CCM_FAKE_CLAUDE_MODE: 'turn-bg',              // 回合收尾但留下一个常驻后台任务
    CCM_FAKE_CLAUDE_SESSION_ID: SESSION_ID,
  });

  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'inv-extdirty-bg-device' },
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
    const send = payload => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ack 超时：${JSON.stringify(payload)}`)), 15000);
      sock.emit('user:message', payload, res => { clearTimeout(timer); resolve(res); });
    });

    const first = await send({ text: 'web 起一个 dev server', cwd, clientMessageId: 'edbg-1' });
    assert.equal(first.ok, true, `首发应被接受，实际 ${JSON.stringify(first)}`);

    // 前置：真的落在「纯后台任务期」——回合已结束、后台任务还在。造不出这个态，下面的断言就测不到缺陷窗口。
    const snapshotOf = () => events.filter(e => e.type === 'instances').pop()
      ?.payload?.instances?.find(i => i.instanceId === first.instanceId);
    const ready = Date.now() + 5000;
    while (!(snapshotOf()?.bgActive === true && snapshotOf()?.turnRunning === false) && Date.now() < ready) await sleep(100);
    assert.deepEqual(
      { bgActive: snapshotOf()?.bgActive, turnRunning: snapshotOf()?.turnRunning },
      { bgActive: true, turnRunning: false },
      '前置失败：没造出纯后台任务期（fake-claude 的 turn-bg 档没生效？）',
    );

    await sleep(TICK_MS * 2 + 500);   // 基线建牢，理由同上一条用例的 ②

    const extUser = randomUUID();
    const extAssistant = randomUUID();
    appendFileSync(
      transcript,
      transcriptLine('user', '终端后来又说的', cwd, seedAssistant, extUser)
        + transcriptLine('assistant', '终端的新回答', cwd, extUser, extAssistant),
    );

    const externalAppends = () => events.filter(e => e.type === 'history_append' && e.payload?.external).length;
    const deadline = Date.now() + TICK_MS * 4;
    while (externalAppends() === 0 && Date.now() < deadline) await sleep(150);

    const second = await send({ text: 'web 第二条', cwd, clientMessageId: 'edbg-2' });
    assert.equal(
      second.ok, false,
      `终端写过之后 web 消息被直接接受了（${JSON.stringify(second)}）——它进的是 SDK 内存里没有终端那两轮的`
      + '陈旧实例，会从旧位置分叉出第二条 parentUuid 链',
    );
    assert.equal(second.reason, 'bg_tasks',
      `拒绝原因应如实指向后台任务（有后台任务时不能 dispose+resume），实际 ${JSON.stringify(second)}`);
    assert.ok(externalAppends() > 0, '终端写入没被推到手机——纯后台任务期镜像仍在把磁盘增长当成己方写盘');
  } finally {
    try { sock.close(); } catch { /* 已关闭 */ }
    await killServer(server.proc);
    rmSync(root, { recursive: true, force: true });      // safe-rm: mkdtemp 一次性目录
    rmSync(projectDir, { recursive: true, force: true }); // safe-rm: 目录名由本用例一次性 cwd 编码而来
  }
});
