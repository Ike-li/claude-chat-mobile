// tests/invariants/server/sync-external-extent.test.mjs —— 有回放的重连也要能对上「终端写过」的账
// 守护：SYNC-01（重连用 sync:since 补缺口；活缓冲里有东西时，磁盘上的外部写入同样要让客户端看得见）
// 测什么：真 server + 可驱动假 CLI（钉死 sessionId）+ 手写 transcript。web 先发一条让活缓冲里有事件，
//         于是 sync:since(lastSeq=0) 走 replayed>0 那条路；再往 transcript 追加终端写的与己方写的条目，
//         看 ack.diskExternalLen：终端写入把它推到最新那条，己方写入不推高它；diskLen 仍按原口径留空。
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR + fake-claude turn 档）
//
// 【缺陷的真实形态】2026-09-22 review P1。sync:since 只在 replayed===0 时读 diskLen——理由成立：
//   web 自己的 live 轮次不更新前端的 seenDiskLen（已知边界），replayed>0 时带磁盘总条数，前端会把
//   每一轮己方写入都当成外部写入、每次切回都整页重载。可代价是：断线期间终端 `--resume` 写进同一
//   会话的内容，只要活缓冲里也有东西（web 这边在跑、或刚跑完），前端的 diskLen 对账就是死代码，
//   那几条永远不出现在手机上，直到用户手动切走再切回。
//
// 【夹具口径】fake CLI 不落 transcript，「己方写入」由本文件手写 entrypoint:'sdk-ts' 的条目来模拟；
//   终端写入是 entrypoint:'cli'。transcript 必须串成一条 parentUuid 链（history.js 只认链上的条目，
//   断链的孤点读不出来——external-dirty.test.mjs 头注记录过这个坑）。
//
// 不测什么 + 为什么：
//  ① 前端拿到 diskExternalLen 之后怎么判 —— 纯函数 syncAckAction / shouldReloadOnEnter，
//     归 tests/unit/logic-ui-state.test.mjs。
//  ② diskLen 在 replayed=0 时照读 —— 已由 sync-catchup.test.mjs 钉住，本文件只断言它在 replayed>0 时仍留空。

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

const TOKEN = 'inv-sync-extent-token';
const SESSION_ID = '22222222-3333-4444-5555-666666666666';

// transcript 一行（CLI 落盘形状）。uuid 由调用方串成链，entrypoint 标明是谁写的。
function transcriptLine({ type, text, cwd, parentUuid, uuid, entrypoint }) {
  return `${JSON.stringify({
    type, uuid, parentUuid, entrypoint,
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
    cwd,
    isMeta: false,
    message: { role: type, content: [{ type: 'text', text }] },
  })}\n`;
}

test('SYNC-01：有回放的重连，ack 用 diskExternalLen 报出终端写到了第几条（己方写入不推高它）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-inv-syncext-'));
  const ws = join(root, 'ws');
  mkdirSync(ws);
  const cwd = realpathSync(ws);
  // 一次性 cwd ⇒ 项目目录也是一次性的。只在容器 / CI 跑，那里的 HOME 本身就是一次性目录。
  const projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${SESSION_ID}.jsonl`);

  // 链尾游标：每追加一条就接在上一条后面
  let tail = null;
  const line = (type, text, entrypoint) => {
    const uuid = randomUUID();
    const out = transcriptLine({ type, text, cwd, parentUuid: tail, uuid, entrypoint });
    tail = uuid;
    return out;
  };
  // 种子：终端先聊过两句
  writeFileSync(transcript, line('user', '终端里先说的', 'cli') + line('assistant', '终端里的回答', 'cli'));

  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: root,
    CCM_FAKE_CLAUDE_MODE: 'turn',
    CCM_FAKE_CLAUDE_SESSION_ID: SESSION_ID,
  });
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'inv-syncext-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  const events = [];
  sock.on('agent:event', e => events.push(e));

  try {
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
    });
    const call = (event, payload) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} ack 超时`)), 15000);
      sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
    });
    // web 发一条：懒开实例、拿到钉死的 sessionId，活缓冲里有了对话事件
    const sent = await call('user:message', { text: 'web 说的', cwd, clientMessageId: 'syncext-1' });
    assert.equal(sent.ok, true, `首发应被接受，实际 ${JSON.stringify(sent)}`);
    // ack 回来时实例未必已拿到 sessionId（假 CLI 的 init 随后才到）；等这一轮收尾，sync:since 才对得上会话
    const deadline = Date.now() + 10_000;
    while (!events.some(e => e.type === 'result' && e.sessionId === SESSION_ID) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(events.some(e => e.type === 'result' && e.sessionId === SESSION_ID),
      `前置：这一轮应在 10s 内收尾并带上钉死的 sessionId，实际事件 ${JSON.stringify(events.map(e => e.type))}`);
    const since = () => call('sync:since', { sessionId: SESSION_ID, lastSeq: 0, instanceId: sent.instanceId });

    const before = await since();
    assert.equal(before.found, true, `前置：实例应匹配这个会话，实际 ${JSON.stringify(before)}`);
    assert.ok(before.replayed > 0, `前置：这条用例测的就是「有回放」那条路，实际 ${JSON.stringify(before)}`);
    assert.equal(before.diskLen, null, 'diskLen 的口径不变：replayed>0 时仍留空');
    assert.equal(before.diskExternalLen, 2, `种子是终端写的两条，实际 ${JSON.stringify(before)}`);

    // 断线期间终端在同一会话上又说了一轮
    appendFileSync(transcript, line('user', '终端后来又说的', 'cli') + line('assistant', '终端的新回答', 'cli'));
    const afterTerminal = await since();
    assert.ok(afterTerminal.replayed > 0);
    assert.equal(afterTerminal.diskExternalLen, 4,
      `终端写的两条必须让它推到第 4 条，前端才知道要重载，实际 ${JSON.stringify(afterTerminal)}`);

    // 己方又写了一轮：不能推高它，否则每一轮己方写入都会被当成外部写入、切回就整页重载
    appendFileSync(transcript, line('user', 'web 又说的', 'sdk-ts') + line('assistant', 'web 的回答', 'sdk-ts'));
    const afterOwn = await since();
    assert.equal(afterOwn.diskExternalLen, 4, `己方写入不该推高它，实际 ${JSON.stringify(afterOwn)}`);
  } finally {
    sock.close();
    await killServer(server.proc);
    rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});
