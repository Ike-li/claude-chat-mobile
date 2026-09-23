// tests/invariants/server/sync-catchup.test.mjs —— 重连补缺口：sync:since 的 ack 契约与回放形态
// 守护：SYNC-01（重连用 sync:since 补环形缓冲内缺口；补发必须标 replay；实例对不上要说 found=false 让客户端清屏重载，而不是把残缺当完整）
// 覆盖：全量/增量/零补三档 + replay 标记 + 补发内容与原件逐字段一致 + found=false 两条独立判据 + diskLen 的读取条件 + 幂等 + epoch 稳定
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR；CLAUDE_BIN 走 stub，无真 turn）
//
// 分层：eventsSince 的【纯逻辑】已在 tests/unit/agent-core.test.mjs 覆盖（seq 过滤、2002 条造 trim 的
// gap 检测、已答 question / 已决 permission_request 不重放）。本文件只测它外面那层 handler——
// 那层在 eventsSince 之外还自己做了六件事，没有一件在 S1 层：found 判定、gap 的 system 提示、
// replay 标记、replayed 的计数口径、diskLen 的条件读取、unreadOnEntry 的归属判定。
//
// ⚠ 夹具口径：stub 下 sessionId 恒为 null（CLI 从不吐 init）。所以本文件传 sessionId:null 是
//   「匹配」而非「缺省」——生产里那是真 UUID。测 found=false 时特意传一个非 null 的错值，
//   走的正是 a.sessionId !== sessionId 这条判据，不是靠 null 的巧合。
//
// 不测什么 + 为什么：
//  ① gap=true（超出缓冲窗口）—— 要塞满 2000 条事件才会 trim，而 stub 一条模型事件都不产出。
//     判据本身是 eventsSince 里的纯表达式，agent-core.test.mjs 用 2002 次 emit 直接构造，比这里可靠。
//  ② replayed 排除 models —— 需要缓冲里有 models 事件，而它来自 q.supportedModels()，stub 下拿不到。
//     这条的后果很重（切入后聊天区空白），但在这一层造不出真实形态，硬造只会得到一个自证的夹具。
//  ③ 「clone 而非原地改 envelope」—— 源码注释担心的污染在当前结构下【没有可观测差异】：
//     buffer 的唯一消费者就是 eventsSince，而已广播出去的 envelope 早被 socket.io 序列化，
//     事后改动影响不到它。注释是防御性的（将来多一个消费者就成立），不为它编一条假断言。
//  ④ pending 快照的内容 —— 需要真实挂起的审批，归 approval-restart.test.mjs 那一域。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';

const TOKEN = 'inv-sync-catchup-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let dir, server, seeder, instanceId, seededEvent;

async function connect(tag) {
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: `inv-sync-${tag}` },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },   // 本机直连：bypass 设备门，本文件只测补缺口
  });
  sock.on('agent:event', e => events.push(e));
  await new Promise((resolve, reject) => {
    sock.on('connect', resolve);
    sock.on('connect_error', reject);
    setTimeout(() => reject(new Error(`socket ${tag} 未能在 5s 内连上`)), 5000);
  });
  // 握手会推一批当前态快照（permission_mode / instances / mirror_state …）。它们与补缺口无关，
  // 但会陆续到达；不等它们收齐就发 sync:since，先到的那几条会被当成「补发内容」算进来。
  await sleep(300);
  const call = (event, payload) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${tag} 的 ${event} ack 超时`)), 8000);
    sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
  });
  // 补发是广播不是 ack 的一部分：ack 回来后再给一小段时间让事件到达客户端。
  // 这不是在赌竞态窗口——服务端在 done() 之前已把该发的都 emit 完了。
  //
  // 只保留【真·补发件】：占 seq 的缓冲事件，或服务端为本次 sync 单发的 replay 件（gap 提示是
  // seq=0 但带 replay:true）。握手快照两者都不是，靠这条判据摘干净，不必依赖到达时序。
  const since = async payload => {
    const from = events.length;
    const ack = await call('sync:since', { sessionId: null, ...payload });
    await sleep(250);
    return { ack, replayedEvents: events.slice(from).filter(e => e.seq > 0 || e.replay === true) };
  };
  return { sock, events, call, since, tag };
}

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ccm-inv-sync-'));
  server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIRS: dir, CCM_DATA_DIR: dir });
  // 播一条种子消息，让环形缓冲里有一件确定存在的对话内容（user_message，seq=1）。
  seeder = await connect('seeder');
  const ack = await seeder.call('user:message', { text: '种子消息', clientMessageId: 'sync-seed' });
  assert.equal(ack.ok, true, `种子消息应发出，实际 ${JSON.stringify(ack)}`);
  instanceId = ack.instanceId;
  await sleep(400);
  seededEvent = seeder.events.find(e => e.type === 'user_message');
  assert.ok(seededEvent, '前置：缓冲里必须有一条 user_message，否则后面全在测空气');
  assert.ok(seededEvent.seq > 0, '进缓冲的事件必须占 seq —— transient 事件不占，那类不该被补发');
});

test.after(async () => {
  try { seeder?.sock.close(); } catch { /* 已关闭 */ }
  if (server) await killServer(server.proc);
  if (dir) rmSync(dir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

test('全量补（lastSeq=0）：缓冲内的对话事件补齐，且每条都标 replay', async () => {
  const c = await connect('full');
  const { ack, replayedEvents } = await c.since({ lastSeq: 0, instanceId });

  assert.equal(ack.found, true);
  assert.equal(ack.gap, false, '缓冲没被 trim 过就不该报缺口——误报会让客户端白白整段重载');
  assert.equal(ack.replayed, 1, `应补回那条种子消息，实际 ack=${JSON.stringify(ack)}`);

  const bubbles = replayedEvents.filter(e => e.type === 'user_message');
  assert.equal(bubbles.length, 1, `补发条数要与 replayed 对得上，实际 ${JSON.stringify(replayedEvents.map(e => e.type))}`);
  // replay 标记决定前端 alertCue 静音：不标的话，切回一个攒了十几轮的会话会把历史 result 逐条响铃。
  assert.equal(bubbles[0].replay, true, '补发的事件必须标 replay:true，否则历史事件会被当成刚发生的');
  c.sock.close();
});

test('补发的是同一份东西：除 replay 外与原事件逐字段一致', async () => {
  // 「补上了」和「补对了」是两件事。只数条数的话，一个把 payload 丢空的实现照样全绿——
  // 用户看到的是一排空气泡。
  const c = await connect('same');
  const { replayedEvents } = await c.since({ lastSeq: 0, instanceId });
  const got = replayedEvents.find(e => e.type === 'user_message');
  assert.ok(got, '应补回 user_message');

  const { replay: _r, ...rest } = got;
  assert.deepEqual(rest, seededEvent,
    '补发内容与当初实时发出的那条必须逐字段相同（含 seq/epoch/sessionId/instanceId/cwd/ts/payload）');
  c.sock.close();
});

test('增量补：lastSeq 之后没有新事件就不补，replayed=0', async () => {
  const c = await connect('incr');
  const { ack, replayedEvents } = await c.since({ lastSeq: seededEvent.seq, instanceId });
  assert.equal(ack.found, true, '实例还在，只是没有新东西——这与「实例没了」是两回事');
  assert.equal(ack.replayed, 0);
  assert.deepEqual(replayedEvents.map(e => e.type), [],
    '已经看过的事件不得重发：重发会让前端把同一条气泡渲染两次');
  c.sock.close();
});

test('found=false 有两条独立判据：实例不存在、以及实例还在但 sessionId 对不上', async () => {
  // 两条都要验：前者是 !a，后者是 a.sessionId !== sessionId。它们在源码里是同一个 if 的两半，
  // 但语义不同——后者对应「实例被复用去跑另一个会话了」，只测前者的话，去掉 sessionId 比较
  // 不会有任何测试变红，而那意味着客户端会拿到别的会话的历史。
  const c = await connect('lost');

  const gone = await c.since({ lastSeq: 0, instanceId: 'inst_does_not_exist' });
  assert.equal(gone.ack.found, false, '实例已 dispose/重启换号时必须明说 found=false，客户端据此清屏重载');
  assert.deepEqual(gone.replayedEvents, [], 'found=false 时一条都不该补');

  const mismatched = await c.since({ sessionId: 'some-other-session-id', lastSeq: 0, instanceId });
  assert.equal(mismatched.ack.found, false,
    '实例还在但会话换了 —— 把上一个会话的缓冲补给这次请求，就是把别人的对话渲染进当前窗口');
  assert.deepEqual(mismatched.replayedEvents, []);
  c.sock.close();
});

test('found=false 时不带 pending 快照（没有实例就没有权威真相可给）', async () => {
  const c = await connect('nopending');
  const { ack } = await c.since({ lastSeq: 0, instanceId: 'inst_does_not_exist' });
  assert.equal(ack.pending, null, '实例都找不到，却回一个 pending 快照，等于凭空造出待办');
  assert.equal(ack.diskLen, null, '同理不该去读磁盘：连是哪个会话都没确定');
  c.sock.close();
});

test('diskLen 只在 replayed=0 时读：活缓冲有内容就不必对账磁盘', async () => {
  // 这个条件不是性能优化那么简单。diskLen 是给前端对账「离开期间被 CLI 从终端写过」用的
  // （logic.js shouldReloadOnEnter）；replayed>0 说明 web 这侧是活跃的、活缓冲可信，
  // 此时再塞一个磁盘条数进去，前端会拿它跟已渲染条数比，把正常状态误判成需要整页重载。
  // replayed>0 时的外部写入改由 diskExternalLen 报（不被己方写入推高），见 sync-external-extent.test.mjs。
  const c = await connect('disk');
  const active = await c.since({ lastSeq: 0, instanceId });
  assert.ok(active.ack.replayed > 0, '前置：这次应有补发内容');
  assert.equal(active.ack.diskLen, null, 'replayed>0 时不读磁盘，diskLen 必须留空');
  // stub 下种子那一轮永不收尾（pendingTurns 恒 1）：有在途轮时连 diskExternalLen 也不读——文件正被
  // 己方追加、缓存必失效，这一读是全量重建，会把前台探活（5s）拖成超时重连。
  assert.equal(active.ack.diskExternalLen, null, '有在途轮时不该为 diskExternalLen 读磁盘');

  const idle = await c.since({ lastSeq: seededEvent.seq, instanceId });
  assert.equal(idle.ack.replayed, 0, '前置：这次应无补发内容');
  assert.equal(typeof idle.ack.diskLen, 'number',
    'replayed=0 正是「切入一个可能被外部写过的会话」的候选，必须带回磁盘条数供对账');
  c.sock.close();
});

test('补缺口是只读的：同一个 lastSeq 连问两次，结果一致', async () => {
  // 重连不稳时客户端会连着问好几次。若 sync:since 有副作用（消费掉缓冲、推进游标），
  // 第二次就会拿到不同答案，表现为「刷新一次少一段历史」。
  const c = await connect('idem');
  const first = await c.since({ lastSeq: 0, instanceId });
  const second = await c.since({ lastSeq: 0, instanceId });
  assert.deepEqual(second.ack, first.ack, 'ack 必须完全一致');
  assert.deepEqual(
    second.replayedEvents.map(e => `${e.type}#${e.seq}`),
    first.replayedEvents.map(e => `${e.type}#${e.seq}`),
    '补发内容必须完全一致 —— 缓冲是可重读的窗口，不是队列',
  );
  c.sock.close();
});

test('epoch 在同一实例内稳定，且补发件与实时件同源', async () => {
  // epoch 是客户端判断「seq 还是不是同一条序列」的依据：实例重建后 seq 会从头再来，
  // 靠 epoch 变化才知道不能拿新 seq 去接旧序列。补发件若换了 epoch，客户端会把一段
  // 本可增量拼接的历史当成新纪元而整段重载。
  const c = await connect('epoch');
  const { replayedEvents } = await c.since({ lastSeq: 0, instanceId });
  const got = replayedEvents.find(e => e.type === 'user_message');
  assert.equal(got.epoch, seededEvent.epoch, '补发件的 epoch 必须与实时发出时相同');
  assert.ok(got.epoch, 'epoch 不得为空——空值等于放弃了这条判据');
  c.sock.close();
});
