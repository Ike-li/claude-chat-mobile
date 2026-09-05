// tests/v2/server/message-ack.test.mjs —— user:message 的幂等接线：ack 语义 + 真实 send 计数
// 守护：MSG-01 / REL-01（离线重发幂等：同一 clientMessageId 只驱动一次 agent）、BE-002（校验失败的 ID 不得记入去重表，否则重发被当成功 → 消息永久丢失）
// 覆盖：ack 四态（ok / deduped / permanent / busy）+ user_message 气泡计数 + 去重按 ID 而非全记 + 空消息与超长文本两条校验失败路径的重试可达
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR；CLAUDE_BIN 走 stub，无真 turn）
//
// ★ 方案原判「MSG-01 的 send 计数在 S2 做不到，需要造能驱动 agent turn 的假 CLI」——2026-09-05 实测推翻。
//   两件事让它成立：
//   ① ack 路径根本不等 turn：首条 user:message 的 ack 实测 14ms 返回 {ok:true,instanceId:'inst_1'}。
//      懒开实例只需要 spawn 成功，而 tests/fixtures/fake-claude.sh 正是为承受这次 spawn 写的。
//   ② send 次数【外部可观测】：AgentSession.send() 里 emit('user_message') 与 queue.push() 在
//      同一条直线上、中间没有 await（agent.js「#2」注释处），且都排在 disposed / pendingTurns 双重
//      检查【之后】。所以收到几条 user_message 气泡 == 往 SDK 输入流塞了几条消息。
//   于是不必造假 CLI。ack 是「服务端怎么回话」，气泡是「有没有真的发出去」——两个独立信号同时断言，
//   才叫「没重复驱动 agent」；只断言 ack.deduped 的话，一个「标了 deduped 但还是发了一遍」的实现全绿。
//
// ⚠ 夹具的硬约束：stub 永不产出 result ⇒ 首条消息成功后 pendingTurns 恒为 1，该实例此后一直 busy。
//   所以【每个用例一台 server】，不在同一台上串多轮有效消息。busy 不是缺陷，反过来它还是好判据：
//   收到 busy 就证明上一轮的 turn 还活着（见 socket-lifecycle.test.mjs）。
//
// 不测什么 + 为什么：
//  ① in-flight 并发占用（claim/release）—— ack 只有 14ms，靠 emit 抢时序撞窗口不稳定，
//     而不稳定的测试比没有更糟。纯函数判定已在 tests/v2/message-dedup.test.mjs（S1）逐分支覆盖。
//  ② 断线重连后的历史回放 —— 属回放机制（SYNC-01），不是幂等。实测裸连收不到气泡、
//     session:open 无 ack，入口尚未查清；在查清之前写它必定是假绿。
//  ③ 附件路径的幂等 —— 需要真实上传落盘，另开用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';

const TOKEN = 'v2-message-ack-token';

// 一台隔离 server + 一条已连上的 socket，跑完必定收尸。
async function withClient(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-v2-msg-'));
  const server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIR: dir, CCM_DATA_DIR: dir });
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'v2-msg-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },   // 本机直连：bypass 设备门，本文件只测幂等
  });
  sock.on('agent:event', e => events.push(e));
  try {
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
    });
    const send = payload => new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`user:message 的 ack 超时——悬挂的 ack 在手机上就是永远转圈：${JSON.stringify(payload)}`)),
        8000,
      );
      sock.emit('user:message', payload, res => { clearTimeout(timer); resolve(res); });
    });
    // 气泡是广播，与 ack 不同步。settle 等的是一次【确定会发生或确定不会发生】的广播，
    // 不是在赌竞态窗口——ack 已经返回，服务端要发的都已发出，这里只是让它到达客户端。
    const bubbles = async () => {
      await new Promise(r => setTimeout(r, 250));
      return events.filter(e => e.type === 'user_message');
    };
    return await fn({ send, bubbles, events });
  } finally {
    try { sock.close(); } catch { /* 已关闭 */ }
    await killServer(server.proc);
    rmSync(dir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
}

test('REL-01：同一 clientMessageId 重发 → ack 标 deduped，且只往 agent 发了一次', async () => {
  await withClient(async ({ send, bubbles }) => {
    const first = await send({ text: '第一条', clientMessageId: 'dup-1' });
    assert.equal(first.ok, true, `首发应被接受，实际 ${JSON.stringify(first)}`);
    assert.ok(!first.deduped, '首发不得标 deduped');
    assert.ok(first.instanceId, 'ack 要带回落点实例，客户端据此对账乐观气泡');

    const again = await send({ text: '第一条', clientMessageId: 'dup-1' });
    assert.equal(again.ok, true, '重复消息是「已处理过」不是失败——ok:false 会让客户端无限重发');
    assert.equal(again.deduped, true, '重发必须标 deduped');

    // ★ 第二个独立信号：ack 说「去重了」，气泡说「确实没再发一次」。
    // 只看 ack 的话，一个「标了 deduped 但仍调了 a.send()」的实现照样全绿。
    const list = await bubbles();
    assert.equal(list.length, 1,
      `重发同一 clientMessageId 只允许往 SDK 输入流塞一次，实际气泡 ${list.length} 条：`
      + `${JSON.stringify(list.map(b => b.payload?.text))}`);
    assert.equal(list[0].payload?.clientMessageId, 'dup-1',
      '气泡要透传 clientMessageId，否则前端的离线乐观气泡无从精确对账（FE-002）');
  });
});

test('去重是按 ID 记的，不是「凡是来过的都算重复」', async () => {
  await withClient(async ({ send }) => {
    assert.equal((await send({ text: 'a', clientMessageId: 'k-a' })).ok, true);

    // 换一个 ID：此刻实例正 busy，所以期望的拒绝理由是 busy 而【不是】deduped。
    // 一个「把所有消息都当重复」的实现会在这里返回 deduped:true —— 用户的新消息被静默吞掉，
    // 而客户端收到 ok:true 会把它从待发队列里删掉，消息就此消失。
    const other = await send({ text: 'b', clientMessageId: 'k-b' });
    assert.ok(!other.deduped, `新 clientMessageId 绝不能被判成重复，实际 ${JSON.stringify(other)}`);
    assert.equal(other.busy, true, '当前实例有在途轮，正确的拒绝理由是 busy');

    // 无 clientMessageId（旧客户端未升级）：不走去重路径，同样只应撞 busy。
    const legacy = await send({ text: 'c' });
    assert.ok(!legacy.deduped, '没有 clientMessageId 就没有去重依据，不得凭空判重');
  });
});

test('BE-002：空消息校验失败后，同一 ID 重发合法内容必须真的发出去', async () => {
  // 这是「假成功丢消息」的根因用例。旧实现在【查询即登记】：校验失败的 ID 也被记进去重表，
  // 于是用户修好内容重发时命中去重，拿到 {ok:true,deduped:true} —— 客户端当成功、删掉待发项，
  // 而服务端从头到尾没发过任何东西。消息永久消失，两侧都不报错。
  await withClient(async ({ send, bubbles }) => {
    const rejected = await send({ text: '', clientMessageId: 'be002-empty' });
    assert.equal(rejected.ok, false, '空消息必须被拒');
    assert.equal(rejected.permanent, true, '内容非法重发必再失败，要告诉客户端别重试');

    const retried = await send({ text: '这次有内容了', clientMessageId: 'be002-empty' });
    assert.equal(retried.ok, true, `同一 ID 修好内容后必须能发出去，实际 ${JSON.stringify(retried)}`);
    assert.ok(!retried.deduped,
      '校验失败的 ID 被记进了去重表 —— 这条重发会被当成「已处理」，消息就此永久丢失');

    const list = await bubbles();
    assert.equal(list.length, 1, '被拒的那条不该留下气泡，修好后的那条必须留下');
    assert.equal(list[0].payload?.text, '这次有内容了');
  });
});

test('BE-002 第二条校验路径：超长文本被拒后，同一 ID 重发短文本仍可达', async () => {
  // 两条校验失败路径要分别验：它们各自 return，共用的只是「不得提前 commit」这条纪律。
  // 只测其中一条的话，另一条上重新引入提前登记不会有任何测试变红。
  await withClient(async ({ send }) => {
    const tooLong = await send({ text: 'x'.repeat(50001), clientMessageId: 'be002-long' });
    assert.equal(tooLong.ok, false, '超过 50000 字符必须被拒');
    assert.equal(tooLong.permanent, true);

    const retried = await send({ text: '短一点', clientMessageId: 'be002-long' });
    assert.equal(retried.ok, true, `同一 ID 改短后必须能发出去，实际 ${JSON.stringify(retried)}`);
    assert.ok(!retried.deduped);
  });
});
