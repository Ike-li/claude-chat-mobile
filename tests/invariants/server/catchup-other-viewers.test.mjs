// tests/invariants/server/catchup-other-viewers.test.mjs —— 一台设备连上来，不能让其它在线端漏掉终端刚写的那段
// 守护：SYNC-01（一台设备连入触发的重定基线只对它自己生效：其余在线端照样收到终端刚写的那段 history_append；待审批设备连入不触发）
// 测什么：真 server + 可驱动假 CLI（钉死 sessionId）+ 手写 transcript。A 一直开着这个会话；终端追加一轮之后，
//         ① 另一台已批准设备 B 连上来 ② 一台待审批设备 P 连上来——两种情形下 A 都必须收到那一轮，B 不收。
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR + fake-claude turn 档）
//
// 【缺陷的真实形态】2026-09-22 review P2。每个新连接（含待审批设备）都让下一 tick 重定基线：那是为新连上的
//   那台设的（它自己会全量重载，沿用滞后 baseline 会给它推成重复气泡），可 baseline 是全局单值——上一 tick
//   之后终端写的那一段，对连接前就在线的端再也推不出去。它们不会重载，屏幕上就少了一轮，直到切走再切回。
//   锁屏解锁、切网络都会触发；待审批设备连一下也会，而它根本收不到会话内容、也不拉历史。
//
// 【时序口径】每一步之后用 mirror:syncNow 插队驱动一次 tick，不等 2.5s 定时器。仍有一个窄窗：终端追加与
//   新设备连上之间若恰好落了一次定时 tick，那一段会被正常 tick 推给 A，修复前的实现也会绿——所以两侧验收
//   里修复前那一侧要跑几次、不能只看一次。
//
// 【② 守的是什么】修复有两半：追平引擎在重定基线那一 tick 照推增量（只跳过新连上的 socket），以及待审批设备
//   连入不再触发重定基线。② 靠前一半就能绿——引擎修好后重定基线本身不再让在线端漏增量——所以它不能单独证明
//   后一半；它钉的是「待审批设备连一下，已在线的端不漏」这个用户可见的结果。
//
// 【夹具口径】同 sync-external-extent.test.mjs：fake CLI 不落 transcript，终端写入由本文件手写
//   entrypoint:'cli' 的条目；transcript 必须串成一条 parentUuid 链（断链的孤点读不出来）。
//
// 不测什么 + 为什么：
//  ① 重定基线分支里 externalDirty 的判定——mirror-engine.test.mjs（S1）与 external-dirty.test.mjs 已钉住；
//  ② 前端收到 history_append 之后怎么渲染——S3；
//  ③ B 自己那边是否全量重载——前端 bindView / sync:since 的事，归 sync-catchup / sync-external-extent。

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from '../../integration/_spawn-server.mjs';
import { encodeProjectDir } from '../../../app/src/shared/project-dir.js';

const TOKEN = 'inv-catchup-viewers-token';
const SESSION_ID = '33333333-4444-5555-6666-777777777777';

// transcript 一行（CLI 落盘形状）。uuid 由调用方串成链；全是终端写的，entrypoint 恒为 cli。
function transcriptLine({ type, text, cwd, parentUuid, uuid }) {
  return `${JSON.stringify({
    type, uuid, parentUuid, entrypoint: 'cli',
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
    cwd,
    isMeta: false,
    message: { role: type, content: [{ type: 'text', text }] },
  })}\n`;
}

test('SYNC-01：另一台设备连上来或待审批设备连入，已在线的端照样收到终端刚写的那一轮', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-inv-catchup-viewers-'));
  const ws = join(root, 'ws');
  mkdirSync(ws);
  const cwd = realpathSync(ws);
  // 一次性 cwd ⇒ 项目目录也是一次性的。只在容器 / CI 跑，那里的 HOME 本身就是一次性目录。
  const projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${SESSION_ID}.jsonl`);

  let tail = null;
  const line = (type, text) => {
    const uuid = randomUUID();
    const out = transcriptLine({ type, text, cwd, parentUuid: tail, uuid });
    tail = uuid;
    return out;
  };
  writeFileSync(transcript, line('user', '终端里先说的') + line('assistant', '终端里的回答'));

  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: root,
    CCM_FAKE_CLAUDE_MODE: 'turn',
    CCM_FAKE_CLAUDE_SESSION_ID: SESSION_ID,
  });
  const sockets = [];
  // Host 决定走不走设备审批：localhost 是本机 bypass（已批准），别的 Host 落待审（DEVICE-01）。
  const connect = ({ host, deviceToken }) => {
    const events = [];
    const sock = ioClient(`http://127.0.0.1:${server.port}`, {
      auth: { token: TOKEN, deviceToken },
      transports: ['websocket'], reconnection: false, timeout: 4000,
      extraHeaders: { Host: host },
    });
    sockets.push(sock);
    sock.on('agent:event', e => events.push(e));
    const ready = new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('connect_error', e => reject(new Error(`握手失败：${e?.message}`)));
    });
    return { sock, events, ready };
  };
  const call = (sock, event, payload) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack 超时`)), 15000);
    sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
  });
  const appendsOf = c => c.events.filter(e => e.type === 'history_append' && e.sessionId === SESSION_ID);
  const textsOf = env => (env?.payload?.messages || []).map(m => m.content);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  try {
    const a = connect({ host: 'localhost', deviceToken: 'inv-catchup-a' });
    await a.ready;
    // A 发一条：懒开实例、拿到钉死的 sessionId，服务端的查看目标就是这个会话
    const sent = await call(a.sock, 'user:message', { text: 'web 说的', cwd, clientMessageId: 'catchup-1' });
    assert.equal(sent.ok, true, `首发应被接受，实际 ${JSON.stringify(sent)}`);
    await waitForCondition(() => a.events.some(e => e.type === 'result' && e.sessionId === SESSION_ID),
      { timeoutMs: 10_000, label: '前置：这一轮收尾并带上钉死的 sessionId' });
    // 追平引擎切入这个会话时会广播一条带它的 mirror_state；之后再插队两次，把 busy→idle 的吸收那一步走掉
    await waitForCondition(() => a.events.some(e => e.type === 'mirror_state' && e.sessionId === SESSION_ID),
      { timeoutMs: 10_000, label: '前置：追平引擎已切入这个会话' });
    for (let i = 0; i < 2; i++) { a.sock.emit('mirror:syncNow'); await sleep(300); }
    assert.equal(appendsOf(a).length, 0, `前置：还没有任何外部增量，实际 ${JSON.stringify(appendsOf(a).map(textsOf))}`);

    // ① 终端又说了一轮，紧接着另一台已批准设备连上来（锁屏解锁 / 切网络 / 第二个标签页）
    appendFileSync(transcript, line('user', '终端追问一') + line('assistant', '终端回答一'));
    const b = connect({ host: 'localhost', deviceToken: 'inv-catchup-b' });
    await b.ready;
    a.sock.emit('mirror:syncNow');
    await waitForCondition(() => appendsOf(a).length >= 1,
      { timeoutMs: 5000, label: 'A 收到终端刚写的那一轮（B 连入触发了重定基线）' });
    assert.deepEqual(textsOf(appendsOf(a)[0]), ['终端追问一', '终端回答一'],
      'A 一直开着这个会话、不会重载；这一轮不推给它，屏幕上就永远少了这一段');
    await sleep(300); // 给「B 也收到了」一个到达的机会，再断言它没收到
    assert.equal(appendsOf(b).length, 0,
      `B 刚连上、自己会全量重载，再收一遍就是重复气泡，实际 ${JSON.stringify(appendsOf(b).map(textsOf))}`);

    // ② 终端又说了一轮，紧接着一台待审批设备连上来
    appendFileSync(transcript, line('user', '终端追问二') + line('assistant', '终端回答二'));
    const p = connect({ host: 'chat.example.com', deviceToken: randomBytes(16).toString('hex') });
    await p.ready;
    await waitForCondition(() => p.events.some(e => e.type === 'device_status' && e.payload?.status === 'pending'),
      { timeoutMs: 5000, label: '前置：P 落进待审' });
    a.sock.emit('mirror:syncNow');
    await waitForCondition(() => appendsOf(a).length >= 2,
      { timeoutMs: 5000, label: 'A 收到终端的第二轮（待审批设备连入不得吞掉它）' });
    assert.deepEqual(textsOf(appendsOf(a)[1]), ['终端追问二', '终端回答二'],
      '待审批设备收不到会话内容、也不拉历史，它连一下不该让已在线的端漏掉一轮');
    assert.equal(appendsOf(p).length, 0, 'SEC-01：待审批设备收不到会话内容');
  } finally {
    for (const s of sockets) { try { s.close(); } catch { /* 已关闭 */ } }
    await killServer(server.proc);
    rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});
