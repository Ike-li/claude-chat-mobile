// tests/invariants/server/sync-catchup.test.mjs —— 重连补缺口：sync:since 的 ack 契约与回放形态
// 守护：SYNC-01（重连用 sync:since 补环形缓冲内缺口；补发必须标 replay；实例对不上要说 found=false 让客户端清屏重载，而不是把残缺当完整）
// 覆盖：全量/增量/零补三档 + replay 标记 + 补发内容与原件逐字段一致 + found=false 两条独立判据 + diskLen 的读取条件 + 幂等 + epoch 稳定
//       + 元数据（models / slash_commands）照样回放、但不计入 replayed
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR；CLAUDE_BIN 走 stub，无真 turn；元数据那条另起一个可驱动 stub 的 server）
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
//  ② （已移出本节）replayed 排除 models —— 当初的理由是默认 stub 不应答 initialize、造不出 models 事件。
//     可驱动 stub（CCM_FAKE_CLAUDE_MODE=init）应答 initialize，models 与 slash_commands 都是真形态，见文件末那条。
//  ③ 「clone 而非原地改 envelope」—— 源码注释担心的污染在当前结构下【没有可观测差异】：
//     buffer 的唯一消费者就是 eventsSince，而已广播出去的 envelope 早被 socket.io 序列化，
//     事后改动影响不到它。注释是防御性的（将来多一个消费者就成立），不为它编一条假断言。
//  ④ pending 快照的内容 —— 需要真实挂起的审批，归 approval-restart.test.mjs 那一域。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from '../../integration/_spawn-server.mjs';
import { encodeProjectDir } from '../../../app/src/shared/project-dir.js';
import { HISTORY_MAX_MESSAGES } from '../../../app/src/sessions/history.js';

const TOKEN = 'inv-sync-catchup-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let dir, server, seeder, instanceId, seededEvent;

async function connect(tag, port = server.port) {
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${port}`, {
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
  // 瞬时事件（transient:true）也不是：它的 seq 沿用实例当前值、并不占位（agent.emitTransient），只看 seq>0
  // 会把 sync 收尾补推的当前态快照（前台任务集合、后台任务进度）误算成重发。
  const since = async payload => {
    const from = events.length;
    const ack = await call('sync:since', { sessionId: null, ...payload });
    await sleep(250);
    return { ack, replayedEvents: events.slice(from).filter(e => e.transient !== true && (e.seq > 0 || e.replay === true)) };
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
  assert.equal(active.ack.diskTotal, null, 'diskTotal 与 diskLen 同口径：replayed>0 时也留空');
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

// 打开一个空闲会话：续接出的实例一起来，就把 models（supportedModels）与 slash_commands（supportedCommands，#456）
// 推进缓冲——两条都出自 initialize 应答，赶在用户发第一条之前。它们照样要回放（前端拿来填模型下拉与斜杠菜单），
// 但不是对话内容。算进 replayed 的话：models 那条会让没有 DOM 缓存的切入跳过 loadHistory、聊天区空白
// （已修过）；slash_commands 那条会让 shouldReloadOnEnter 判「有回放 → reload」，清屏重拉一遍历史，
// 点击时预取的那份（#491）白拉，diskLen 也因 replayed>0 留空、对账不了。
// transcript 故意摆成超过截顶线（HISTORY_MAX_MESSAGES）：diskLen 只到 2000，预取要凭削顶前的 diskTotal 核对。
test('刚续接、缓冲里只有元数据（models / slash_commands）：照样回放，但 replayed=0 并带回 diskLen 与 diskTotal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-inv-sync-meta-'));
  const ws = join(root, 'ws');
  mkdirSync(ws);
  const cwd = realpathSync(ws);
  const sessionId = randomUUID();
  // session:switch 先查 transcript 在不在。只在容器 / CI 跑，那里的 HOME 是一次性目录；cwd 是 mkdtemp 出来的，
  // 编码出的项目目录也不会撞上别的会话。整段要串成 parentUuid 链，history.js 只认链上的条目。
  const projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
  mkdirSync(projectDir, { recursive: true });
  const line = (type, text, parentUuid, uuid) => `${JSON.stringify({
    type, uuid, parentUuid, entrypoint: 'cli', timestamp: new Date().toISOString(), sessionId, cwd, isMeta: false,
    message: { role: type, content: [{ type: 'text', text }] },
  })}\n`;
  const onDisk = HISTORY_MAX_MESSAGES + 2;
  let parent = null;
  let transcript = '';
  for (let i = 0; i < onDisk; i++) {
    const uuid = randomUUID();
    transcript += line(i % 2 ? 'assistant' : 'user', `终端里的第 ${i} 条`, parent, uuid);
    parent = uuid;
  }
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), transcript);
  const modelListFile = join(root, 'models.txt');
  writeFileSync(modelListFile, 'fake-listed-model\n');

  const metaServer = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: root,
    CCM_FAKE_CLAUDE_MODE: 'init', // 应答 initialize：models 与命令清单都藏在这条应答里
    CCM_FAKE_CLAUDE_MODEL_LIST_FILE: modelListFile,
    CCM_FAKE_CLAUDE_COMMANDS: JSON.stringify([{ name: 'deploy', description: 'Deploy the app', argumentHint: '' }]),
  });
  let c;
  try {
    c = await connect('meta', metaServer.port);
    const opened = await c.call('session:switch', { sessionId, cwd });
    assert.equal(opened.ok, true, `前置：要能打开这个会话，实际 ${JSON.stringify(opened)}`);
    // 两条都是 initialize 应答回来后异步推的：等它们以实时件（占 seq）到了再问，否则测的是「还没来」
    const live = type => c.events.some(e => e.type === type && e.instanceId === opened.instanceId && e.seq > 0);
    await waitForCondition(() => live('models') && live('slash_commands'), { timeoutMs: 15000, label: '实例推的 models 与 slash_commands' });

    const { ack, replayedEvents } = await c.since({ sessionId, lastSeq: 0, instanceId: opened.instanceId });
    assert.equal(ack.found, true, `前置：实例应匹配这个会话，实际 ${JSON.stringify(ack)}`);
    assert.deepEqual(replayedEvents.map(e => e.type).sort(), ['models', 'slash_commands'],
      '元数据照样回放：前端要靠它们填模型下拉与斜杠菜单，只是不计数');
    assert.equal(ack.replayed, 0, `缓冲里没有对话内容，replayed 必须是 0，实际 ack=${JSON.stringify(ack)}`);
    assert.equal(ack.diskLen, HISTORY_MAX_MESSAGES, `replayed=0 才带回磁盘条数（截顶后的），前端靠它对账、复用预取，实际 ack=${JSON.stringify(ack)}`);
    assert.equal(ack.diskTotal, onDisk, `截顶时条数核对不了，要带回削顶前的总条数，实际 ack=${JSON.stringify(ack)}`);
  } finally {
    try { c?.sock.close(); } catch { /* 已关闭 */ }
    await killServer(metaServer.proc);
    rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});
