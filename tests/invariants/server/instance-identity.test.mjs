// tests/invariants/server/instance-identity.test.mjs —— 客户端手里的旧实例句柄：不得命中别的会话，同一会话换了实例要跟过去
// 守护：MSG-02（客户端手里的 instanceId 不得指到另一个会话：发号跨重启不复用；带着入队时 sessionId 的重放，句柄失效或指着别的会话时改投该会话此刻的活实例，没有才按 stale 拒收）
// 覆盖：① 云端全量 review（2026-10-16）P0-2 的原样复现：A 在 projA 拿到句柄 → 重启 → B 在 projB 开会话 →
//          A 的离线队列带着旧句柄重放（升级前入队的条目，不带 sessionId）→ 必须 stale，projB 的会话里不得出现这条
//       ② 同一个旧句柄的断线续传（同一份 review 的 P2「sync:since 不比 epoch」）：重启后同一会话被续接出新实例，
//          旧句柄不得被认成它——认了，客户端拿上一进程的 lastSeq 去接新进程的序列，中间的事件就丢了
//       ③ 同一进程内：重放带着入队时的 sessionId，命中的实例跑的已是别的会话 → stale；会话对得上照常投递（正对照）
//       ④ 同一份 review 的 P2「离线同一批第 2 条起被判 stale」：终端写过之后，第 1 条触发规则 5 置换（换了实例号），
//          第 2 条带着置换前的句柄 → 必须跟到这个会话的新实例上：撞上第 1 条的在途轮落 busy（前端「未发送 + 重发」），
//          轮次结束后同一条重发送进同一个会话，而不是「目标会话已关闭」永久失败
//       ⑤ PR #218 review（Codex P2）：另一台设备正在置换同一会话（这里用切 effort 的重路径）时到达的重放——旧实例已移出、
//          新实例还没登记，改投查不到它。必须等那次续接落定再判，送进新实例，而不是在窗口里判 stale
// 槽位：S2（真 app/server.js 子进程，①② 各起两次 + 一次性 CCM_DATA_DIR + 可驱动假 CLI）
//
// ⚠ 必须真 spawn 两次（理由同 approval-restart.test.mjs）：「进程真的重启过、计数真的归零过」正是要证明的事，
//   在同一个进程里 import 两次拿到的是同一份模块状态，这条用例会在测空气。
//
// 不测什么 + 为什么：
//  ① 前端入队时记下哪个 sessionId、重放时有没有带上 —— 在 app.js 里，归 S3（tests/e2e/specs/input-send-empty.spec.ts）
//  ② 前端怎么呈现第 2 条的 busy（「未发送 + 重发」挂在哪）—— presentOfflineResendAck 归 S1（tests/invariants/logic-outbox-ack.test.mjs），
//     挂载点归 S3
//  ③ 通知深链拿着旧句柄 —— 前端 resolveDeepLinkTarget 早已按 sessionId 兜底（tests/unit/logic-deeplink.test.mjs）
//  ④ 会话此刻没有活实例（空闲回收、用户关掉了）时的重放 —— 仍按 stale 拒收，改投只认活实例，判定在 S1（tests/invariants/instance-identity.test.mjs）
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from '../../integration/_spawn-server.mjs';
import { encodeProjectDir } from '../../../app/src/shared/project-dir.js';

const TOKEN = 'inv-instance-identity-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ccm-inv-identity-'));
  mkdirSync(join(root, 'projA'));
  mkdirSync(join(root, 'projB'));
  mkdirSync(join(root, 'data'));
  return {
    root,
    projA: realpathSync(join(root, 'projA')),
    projB: realpathSync(join(root, 'projB')),
    data: join(root, 'data'),
  };
}

// 起一台 server、跑完必定收尸。两次启动共用同一个数据目录：真重启也是同一份 sessions.json。
async function withBoot({ projA, projB, data }, env, fn) {
  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: `${projA},${projB}`, CCM_DATA_DIR: data, ...env,
  });
  const sockets = [];
  try {
    return await fn({
      connect: async tag => {
        const events = [];
        const sock = ioClient(`http://127.0.0.1:${server.port}`, {
          auth: { token: TOKEN, deviceToken: `inv-identity-${tag}` },
          transports: ['websocket'], reconnection: false, timeout: 4000,
          extraHeaders: { Host: 'localhost' }, // 本机直连：bypass 设备门，本文件只测路由
        });
        sockets.push(sock);
        sock.on('agent:event', e => events.push(e));
        await new Promise((resolve, reject) => {
          sock.on('connect', resolve);
          sock.on('connect_error', reject);
          setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
        });
        const call = (event, payload) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时：${JSON.stringify(payload)}`)), 15000);
          sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
        });
        const emit = (event, payload) => sock.emit(event, payload); // 没有 ack 的事件（如 user:setEffort）
        return { events, call, emit };
      },
    });
  } finally {
    for (const s of sockets) { try { s.close(); } catch { /* 已关闭 */ } }
    await killServer(server.proc);
  }
}

const turnDone = (events, instanceId) => waitForCondition(
  () => events.find(e => e.type === 'result' && e.instanceId === instanceId),
  { timeoutMs: 10000, label: `实例 ${instanceId} 的回合收尾` },
);

test('MSG-02（review P0-2）：重启后，带着旧句柄的离线重放不得投进别的项目的会话', async () => {
  const dirs = makeRoot();
  const env = { CCM_FAKE_CLAUDE_MODE: 'turn' }; // 回合会收尾：B 的实例空闲时，误投会被直接收下开跑
  try {
    let handleA;
    await withBoot(dirs, env, async ({ connect }) => {
      const a = await connect('a');
      const ack = await a.call('user:message', { text: 'A 在 projA 说的', cwd: dirs.projA, clientMessageId: 'a-1' });
      assert.equal(ack.ok, true, `前提：A 的首条消息要开出实例，实际 ${JSON.stringify(ack)}`);
      handleA = ack.instanceId;
    });

    await withBoot(dirs, env, async ({ connect }) => {
      const b = await connect('b');
      const ackB = await b.call('user:message', { text: 'B 在 projB 说的', cwd: dirs.projB, clientMessageId: 'b-1' });
      assert.equal(ackB.ok, true, `前提：B 的首条消息要开出实例，实际 ${JSON.stringify(ackB)}`);
      const doneB = await turnDone(b.events, ackB.instanceId);

      // A 重连，离线队列按 deliverOutboxItem 的形状重放。升级前入队的条目没有 sessionId，只有句柄和 cwd。
      const a = await connect('a-again');
      const seenBeforeReplay = a.events.length;
      const replay = await a.call('user:message', {
        text: '离线时排在 projA 的', cwd: dirs.projA, instanceId: handleA, clientMessageId: 'a-queued', fromOutbox: true,
      });
      await sleep(250); // ack 已回，服务端要广播的都已发出，这里只等它到达客户端
      const landed = b.events.filter(e => e.type === 'user_message' && e.payload?.clientMessageId === 'a-queued');
      assert.deepEqual(landed.map(e => ({ cwd: e.cwd, sessionId: e.sessionId })), [],
        `A 排在 projA 的消息落进了 B 的会话（projB=${dirs.projB}，sessionId=${doneB.sessionId}）：模型会在错误的仓库里执行它`);
      assert.equal(replay.ok, false, `旧句柄在新进程里不该命中任何实例，实际 ${JSON.stringify(replay)}`);
      assert.equal(replay.stale, true,
        `必须按 stale 拒收：客户端据此停止重试、交还原文，而不是当成忙碌留着「重发」按钮，实际 ${JSON.stringify(replay)}`);
      // 验收 O126：离线重放的拒收由前端按条目交代（原文进了死信暂存、回到那个会话才交还）。服务端再推一行
      // 「目标会话已关闭，请刷新后重发」会落在用户眼前那一屏上——刷新找不回原文，这是错误指引。
      const notices = a.events.slice(seenBeforeReplay).filter(e => e.type === 'system' || e.type === 'error');
      assert.deepEqual(notices.map(e => e.payload?.message), [],
        '离线重放被判 stale 时服务端不该再推提示行：回执归前端（它知道原文存在哪、该回哪个会话）');
    });
  } finally {
    rmSync(dirs.root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});

// transcript 一行（history.js 的解析形状），链由调用方串起来——断链的夹具在真实世界不存在（见 external-dirty.test.mjs）。
function transcriptLine(sessionId, type, text, cwd, parentUuid, uuid) {
  return `${JSON.stringify({
    type, uuid, parentUuid, sessionId, cwd, isMeta: false,
    timestamp: new Date().toISOString(),
    message: { role: type, content: [{ type: 'text', text }] },
  })}\n`;
}

test('MSG-02（review P2）：重启后同一会话被续接出新实例，旧句柄的断线续传不得被认成它', async () => {
  const dirs = makeRoot();
  const sessionId = randomUUID();
  // session:switch 先查 transcript 在不在。只在容器 / CI 跑（test:invariants:server 不在宿主机白名单），
  // 那里的 HOME 本身就是一次性目录；cwd 是 mkdtemp 出来的，编码出的 project 目录也不会撞上别的会话。
  const projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(dirs.projA));
  mkdirSync(projectDir, { recursive: true });
  const u1 = randomUUID();
  writeFileSync(join(projectDir, `${sessionId}.jsonl`),
    transcriptLine(sessionId, 'user', '终端里说过的', dirs.projA, null, u1)
      + transcriptLine(sessionId, 'assistant', '终端里的回答', dirs.projA, u1, randomUUID()));
  // 钉死假 CLI 报的 session_id：续接后实例跑的仍是同一个会话，续传的会话核对挡不住，只剩句柄本身
  const env = { CCM_FAKE_CLAUDE_MODE: 'turn', CCM_FAKE_CLAUDE_SESSION_ID: sessionId };
  try {
    let handle;
    let lastSeq = 0;
    await withBoot(dirs, env, async ({ connect }) => {
      const a = await connect('a');
      const opened = await a.call('session:switch', { sessionId, cwd: dirs.projA });
      assert.equal(opened.ok, true, `前提：要能打开这个会话，实际 ${JSON.stringify(opened)}`);
      handle = opened.instanceId;
      const ack = await a.call('user:message', { text: '续接后说一句', instanceId: handle, clientMessageId: 'a-1' });
      assert.equal(ack.ok, true, JSON.stringify(ack));
      await turnDone(a.events, handle);
      lastSeq = Math.max(...a.events.filter(e => e.instanceId === handle).map(e => e.seq));
      assert.ok(lastSeq > 0, '前提：客户端手里要有上一进程的续传基线');
    });

    await withBoot(dirs, env, async ({ connect }) => {
      const b = await connect('b');
      const reopened = await b.call('session:switch', { sessionId, cwd: dirs.projA });
      assert.equal(reopened.ok, true, `前提：重启后同一会话要能再打开，实际 ${JSON.stringify(reopened)}`);

      const a = await connect('a-again');
      const synced = await a.call('sync:since', { instanceId: handle, sessionId, lastSeq });
      assert.equal(synced.found, false,
        `上一进程的句柄 ${handle} 被认成了新进程的实例 ${reopened.instanceId}：客户端会拿旧序列的 lastSeq=${lastSeq} `
        + `去接新序列，以为没漏东西（实际 ${JSON.stringify(synced)}）`);
    });
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });   // safe-rm: mkdtemp 一次性目录
    rmSync(projectDir, { recursive: true, force: true });  // safe-rm: 目录名由本用例一次性 cwd 编码而来
  }
});

test('MSG-02：重放带着入队时的会话，命中的实例跑的已是别的会话 → stale；对得上照常投递', async () => {
  const dirs = makeRoot();
  try {
    await withBoot(dirs, { CCM_FAKE_CLAUDE_MODE: 'turn' }, async ({ connect }) => {
      const b = await connect('b');
      const ackB = await b.call('user:message', { text: 'B 在 projB 说的', cwd: dirs.projB, clientMessageId: 'b-1' });
      assert.equal(ackB.ok, true, JSON.stringify(ackB));
      const { sessionId } = await turnDone(b.events, ackB.instanceId);
      assert.ok(sessionId, '前提：回合收尾时实例要已有会话');

      const replay = payload => b.call('user:message', {
        cwd: dirs.projB, instanceId: ackB.instanceId, fromOutbox: true, ...payload,
      });
      const foreign = await replay({ text: '入队时属于别的会话', sessionId: `${sessionId}-other`, clientMessageId: 'q-foreign' });
      assert.equal(foreign.stale, true, `实例还是那个实例，跑的却不是入队时那个会话，必须拒收，实际 ${JSON.stringify(foreign)}`);

      // 正对照：会话对得上的重放照常送达——否则上面那条 stale 可能只是「带了 sessionId 就一律拒」
      const own = await replay({ text: '入队时就属于它', sessionId, clientMessageId: 'q-own' });
      assert.equal(own.ok, true, `会话对得上的重放不该被拦，实际 ${JSON.stringify(own)}`);
      await sleep(250);
      const texts = b.events.filter(e => e.type === 'user_message').map(e => e.payload?.text);
      assert.ok(!texts.includes('入队时属于别的会话'), `被拒的那条不该进会话：${JSON.stringify(texts)}`);
      assert.ok(texts.includes('入队时就属于它'), `对得上的那条要真的发出去：${JSON.stringify(texts)}`);
    });
  } finally {
    rmSync(dirs.root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});

// ④ 的时序照 external-dirty.test.mjs：catchUpTick 每 2500ms 一拍，先建基线再判增长——在基线之前追加，
// 追加的内容会被当成基线本身，externalDirty 永不置位，第 1 条就不会置换，这条用例测的就是空气。
const TICK_MS = 2500;

test('MSG-02（review P2）：第 1 条触发规则 5 置换之后，同一批第 2 条带着旧句柄要跟到这个会话的新实例，不得判 stale', async () => {
  const dirs = makeRoot();
  const sessionId = randomUUID();
  // 只在容器 / CI 跑（test:invariants:server 不在宿主机白名单），那里的 HOME 本身就是一次性目录。
  const projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(dirs.projA));
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${sessionId}.jsonl`);
  // 种子：终端先聊过一轮，链串好（断链的夹具在真实世界不存在，见 external-dirty.test.mjs）
  const seedUser = randomUUID();
  const seedAssistant = randomUUID();
  writeFileSync(transcript,
    transcriptLine(sessionId, 'user', '终端里先说的', dirs.projA, null, seedUser)
      + transcriptLine(sessionId, 'assistant', '终端里的回答', dirs.projA, seedUser, seedAssistant));
  const env = {
    CCM_FAKE_CLAUDE_MODE: 'turn',               // 回合会收尾：空闲时才走得到「该置换」那一侧
    CCM_FAKE_CLAUDE_SESSION_ID: sessionId,      // 钉死 sid：置换 resume 的还是这个会话，transcript 落点也算得出
    CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '2000',    // 回合跑 2s：第 2 条到达时第 1 条一定还在跑，同真模型的常态
  };
  try {
    await withBoot(dirs, env, async ({ connect }) => {
      const phone = await connect('phone');
      const opened = await phone.call('user:message', { text: '在线时说的', cwd: dirs.projA, clientMessageId: 'p-0' });
      assert.equal(opened.ok, true, `前提：首条消息要开出实例，实际 ${JSON.stringify(opened)}`);
      const handle = opened.instanceId;
      await turnDone(phone.events, handle);

      // 基线建牢之后，终端在同一会话上又跑了一轮（接在种子那条链的末端）
      await sleep(TICK_MS * 2 + 500);
      const extUser = randomUUID();
      appendFileSync(transcript,
        transcriptLine(sessionId, 'user', '终端后来又说的', dirs.projA, seedAssistant, extUser)
          + transcriptLine(sessionId, 'assistant', '终端的新回答', dirs.projA, extUser, randomUUID()));
      await waitForCondition(
        () => phone.events.some(e => e.type === 'history_append' && e.payload?.external),
        { timeoutMs: TICK_MS * 4, intervalMs: 150, label: 'catchUpTick 观察到终端写入（externalDirty 置位的前提）' },
      );

      // 离线时排着的两条：形状照 deliverOutboxItem，句柄与会话都是入队那一刻的。
      // 逐条重放、等上一条 ack 回来再发下一条，同 processOfflineQueue。
      const queued = n => ({
        text: `离线时打的第 ${n} 条`, cwd: dirs.projA, instanceId: handle, sessionId,
        clientMessageId: `q-${n}`, fromOutbox: true,
      });
      const first = await phone.call('user:message', queued(1));
      assert.equal(first.ok, true, `第 1 条应被接受，实际 ${JSON.stringify(first)}`);
      assert.notEqual(first.instanceId, handle,
        '前提：第 1 条要触发规则 5 置换（dispose + resume 换了实例号）；没换就测不到缺陷窗口');

      const second = await phone.call('user:message', queued(2));
      assert.notEqual(second.stale, true,
        `第 2 条带着置换前的句柄被判成「目标会话已关闭」，前端会落永久失败、不给重发：会话明明还开着，`
        + `只是换了实例号（${handle} → ${first.instanceId}）。实际 ${JSON.stringify(second)}`);
      assert.equal(second.busy, true,
        `第 1 条的回合还在跑，第 2 条应按在途轮拒收（前端落「未发送 + 重发」），实际 ${JSON.stringify(second)}`);

      // 回合跑完之后点「重发」：同一条、同一个旧句柄，送进同一个会话的新实例
      await turnDone(phone.events, first.instanceId);
      const resent = await phone.call('user:message', queued(2));
      assert.equal(resent.ok, true, `轮次结束后重发应送达，实际 ${JSON.stringify(resent)}`);
      await sleep(250); // ack 已回，服务端要广播的都已发出，这里只等它到达客户端
      const landed = phone.events.filter(e => e.type === 'user_message' && e.payload?.clientMessageId === 'q-2');
      assert.deepEqual(landed.map(e => ({ instanceId: e.instanceId, sessionId: e.sessionId })),
        [{ instanceId: first.instanceId, sessionId }],
        '第 2 条要恰好送进一次，而且落在入队时那个会话此刻的实例上');
    });
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });   // safe-rm: mkdtemp 一次性目录
    rmSync(projectDir, { recursive: true, force: true });  // safe-rm: 目录名由本用例一次性 cwd 编码而来
  }
});

// ⑤ 置换的两条路径（externalDirty、切 effort 的重路径）都是先 disposeInstance（旧实例同步移出），再 await dedupedResume；
// 新实例要等 openResumeInstance 里「等同会话旧进程退出」与几路读盘都走完才登记。这段窗口里 resumeInFlight 已经有
// 这个会话，instanceForSession 却查不到任何实例。
test('MSG-02（PR #218 review）：另一台设备正在置换同一会话时到达的重放，等置换落定后送进新实例，不得判 stale', async () => {
  const dirs = makeRoot();
  const env = {
    CCM_FAKE_CLAUDE_MODE: 'turn',
    // 旧进程读到 stdin EOF 后隔 500ms 才退（往一次性目录里的文件追加一行再退）：置换里「等同会话旧进程退出」那一步
    // 因此至少等这么久，窗口被撑开到能确定地打进去。不设的话假 CLI 立刻退，窗口只有几十毫秒，用例赌的是调度。
    CCM_FAKE_CLAUDE_EXIT_APPEND: join(dirs.root, 'fake-exit.log'),
  };
  try {
    await withBoot(dirs, env, async ({ connect }) => {
      const phone = await connect('phone');
      const laptop = await connect('laptop');
      const opened = await phone.call('user:message', { text: '在线时说的', cwd: dirs.projA, clientMessageId: 'r-0' });
      assert.equal(opened.ok, true, `前提：首条消息要开出实例，实际 ${JSON.stringify(opened)}`);
      const handle = opened.instanceId;
      const { sessionId } = await turnDone(phone.events, handle);
      assert.ok(sessionId, '前提：回合收尾时实例要已有会话');

      // 另一台设备切思考强度：先切到具体档（轻路径，只发控制请求、不换实例），再切回「没指定」——这一步要置换实例
      laptop.emit('user:setEffort', { instanceId: handle, level: 'high' });
      await waitForCondition(
        () => phone.events.some(e => e.type === 'effort_mode' && e.instanceId === handle && e.payload?.level === 'high'),
        { label: '轻路径切到 high（置换的前提：回到「没指定」才走重路径）' },
      );
      laptop.emit('user:setEffort', { instanceId: handle, level: null });
      // 重路径在 disposeInstance 之前同步发这条：收到它时旧实例已移出，新实例还在等旧进程退出
      await waitForCondition(
        () => laptop.events.some(e => e.type === 'system' && e.instanceId === handle && e.payload?.kind === 'resuming'),
        { label: '切 effort 的重路径开始置换' },
      );

      const replay = await phone.call('user:message', {
        text: '离线时排着的', cwd: dirs.projA, instanceId: handle, sessionId, clientMessageId: 'q-race', fromOutbox: true,
      });
      assert.notEqual(replay.stale, true,
        `置换进行中到达的重放被判成「目标会话已关闭」，前端会永久停止重试：那个会话正在续接，几百毫秒后就有新实例。实际 ${JSON.stringify(replay)}`);
      assert.equal(replay.ok, true, `等置换落定后应送进新实例，实际 ${JSON.stringify(replay)}`);
      assert.notEqual(replay.instanceId, handle, '前提：重放落在置换出来的新实例上（旧号已作废）');
      await sleep(250); // ack 已回，服务端要广播的都已发出，这里只等它到达客户端
      const landed = phone.events.filter(e => e.type === 'user_message' && e.payload?.clientMessageId === 'q-race');
      assert.deepEqual(landed.map(e => ({ instanceId: e.instanceId, sessionId: e.sessionId })),
        [{ instanceId: replay.instanceId, sessionId }],
        '重放要恰好送进一次，落在这个会话置换后的实例上');
    });
  } finally {
    rmSync(dirs.root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});
