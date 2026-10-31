// tests/invariants/server/resume-divergence.test.mjs —— 续接会丢掉最新那段对话时，真 server 发送前拒收、确认后才放行
// 守护：SESSION-04（CLI 这次会接上的链不含物理上最新的对话消息时，发送前必须先拒收、由用户选分叉或仍然发送）
// 覆盖：真 app/server.js 读到真机 c78e8b47 形态的 transcript → session:switch 打开（resume 前判叶）→ user:message 被拒，
//       ack 键集 { ok, reason, permanent, error, divergence }、divergence 键集即 resumeDivergence 的七个字段，且这条【没有】
//       送进 agent（无 user_message 气泡）→ 同一 clientMessageId 带上确认重发 → 放行且只发一次。
//       正对照：去掉终端最后那两行（手机侧最后写）→ 首发直接放行，证明仪器看得见「没拦」。
//       判定不挡回执：回执一到就发，闸等后台判定落定再拒；spawn 之后追加到文件尾的行不算进判定。
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR；CLAUDE_BIN 走 stub，无真 turn）
//
// 【为什么要这一层】前端 ↔ 真 server 的这条边，E2E 守不住：E2E 打的 mock 是平行实现，负 ack 是 mock 手抄的
// （docs/testing.md「平行实现替被测对象作了答」）。删掉真 server ack 里的 divergence，前端面板就弹不出来、
// 退化成一条看不懂的报错，而 E2E 照绿。所以键集在这里守，守键集不守键值。
//
// 不测什么 + 为什么：
//  ① 判叶规则本身 —— S1（tests/unit/resume-anchor.test.mjs），夹具出自零 token 真 CLI 实测
//  ② 闸与额度墙自动继续的编排、前端两条 ack 决策 —— S1（tests/invariants/resume-divergence-gate.test.mjs）
//  ③ 面板、分叉、把话挪进新会话 —— S3（tests/e2e/specs/resume-divergence.spec.ts）
//  ④ 规则 5 置换后的重判（旧进程退出时重贴 last-prompt 的时序）—— 要真 CLI 进程写盘，S2 的 stub 不写 last-prompt
//  ⑤ 模型上下文里真的少了那一段 —— 要真模型，归 S5
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';
import { encodeProjectDir } from '../../../app/src/shared/project-dir.js';

const TOKEN = 'inv-resume-divergence-token';
const SESSION_ID = '6f0c2a55-1b7e-4a4e-9d0f-0a1b2c3d4e5f';
const DIVERGENCE_KEYS = ['anchorAt', 'anchorEntrypoint', 'anchorOnlyCount', 'droppedCount', 'newestAt', 'newestEntrypoint', 'newestUuid'];

// 真机 c78e8b47 的形态（结构字段，2026-10-16 机主授权只读）：终端一轮停在 T；手机经 SDK 在 T 下接着聊；
// 闲置终端把 away_summary / informational 挂在它记得的旧叶子 T 下；手机进程先重贴、终端后重贴 last-prompt。
// padLines：开头垫多少行 progress（不是消息，不影响判定），只为让判定的整份读盘明显慢于切换的其余部分。
function transcript(cwd, { terminalWroteLast, padLines = 0 }) {
  let clock = 0;
  const id = () => randomUUID();
  const at = () => new Date(Date.UTC(2026, 8, 3, 12, 26, clock++)).toISOString();
  const row = (fields) => ({ sessionId: SESSION_ID, cwd, isSidechain: false, timestamp: at(), ...fields });
  const [u1, a1, s1, t, u2, s3, a2, s4] = [id(), id(), id(), id(), id(), id(), id(), id()];
  const pad = `${JSON.stringify({ type: 'progress', sessionId: SESSION_ID, data: { items: Array.from({ length: 20 }, (_, k) => ({ k, v: 'abcdefgh', f: [1, 2, 3] })) } })}\n`;
  const lines = [
    row({ type: 'user', uuid: u1, parentUuid: null, entrypoint: 'cli', message: { role: 'user', content: '终端里先问的' } }),
    row({ type: 'assistant', uuid: a1, parentUuid: u1, entrypoint: 'cli', message: { role: 'assistant', content: [{ type: 'text', text: '终端里的回答' }] } }),
    row({ type: 'system', subtype: 'stop_hook_summary', uuid: s1, parentUuid: a1, entrypoint: 'cli', isMeta: false }),
    row({ type: 'system', subtype: 'turn_duration', uuid: t, parentUuid: s1, entrypoint: 'cli', isMeta: false }),
    row({ type: 'user', uuid: u2, parentUuid: t, entrypoint: 'sdk-ts', message: { role: 'user', content: '手机上接着问的' } }),
    ...(terminalWroteLast ? [row({ type: 'system', subtype: 'away_summary', uuid: s3, parentUuid: t, entrypoint: 'cli', isMeta: false })] : []),
    row({ type: 'assistant', uuid: a2, parentUuid: u2, entrypoint: 'sdk-ts', message: { role: 'assistant', content: [{ type: 'text', text: '手机上的回答' }] } }),
    { type: 'last-prompt', lastPrompt: '手机上接着问的', leafUuid: a2, sessionId: SESSION_ID },
    ...(terminalWroteLast ? [
      row({ type: 'system', subtype: 'informational', level: 'warning', uuid: s4, parentUuid: s3, entrypoint: 'cli', isMeta: false }),
      { type: 'last-prompt', lastPrompt: '终端里先问的', leafUuid: s4, sessionId: SESSION_ID },
    ] : []),
  ];
  return { text: pad.repeat(padLines) + lines.map(l => `${JSON.stringify(l)}\n`).join(''), phoneLast: a2 };
}

// 一台隔离 server + 一条已连上的 socket + 一份种好的 transcript，跑完必定收尸。
async function withSeededSession({ terminalWroteLast, padLines }, fn) {
  const root = mkdtempSync(join(tmpdir(), 'ccm-inv-resume-div-'));
  const ws = join(root, 'ws');
  mkdirSync(ws);
  const cwd = realpathSync(ws);
  // 一次性 cwd ⇒ 编码出来的项目目录也是一次性的。只在容器 / CI 跑（test:invariants:server 不在宿主机白名单），
  // 那里的 HOME 本身就是一次性目录。
  const projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
  mkdirSync(projectDir, { recursive: true });
  const seeded = transcript(cwd, { terminalWroteLast, padLines });
  const file = join(projectDir, `${SESSION_ID}.jsonl`);
  writeFileSync(file, seeded.text);

  const server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: root });
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'inv-resume-div-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },   // 本机直连：bypass 设备门，本文件只测发送闸
  });
  sock.on('agent:event', e => events.push(e));
  try {
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
    });
    const emitAck = (event, payload) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时：${JSON.stringify(payload)}`)), 15000);
      sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
    });
    // 气泡是广播、与 ack 不同步。ack 已经返回，服务端要发的都已发出，这里只是让它到达客户端，不是在赌竞态窗口。
    const bubbles = async () => {
      await new Promise(r => setTimeout(r, 250));
      return events.filter(e => e.type === 'user_message');
    };
    const t0 = Date.now();
    const opened = await emitAck('session:switch', { cwd, sessionId: SESSION_ID });
    const switchMs = Date.now() - t0;
    assert.equal(opened?.ok, true, `前提：会话要能打开：${JSON.stringify(opened)}`);
    const appendLine = obj => appendFileSync(file, `${JSON.stringify(obj)}\n`);
    return await fn({ cwd, instanceId: opened.instanceId, phoneLast: seeded.phoneLast, emitAck, bubbles, switchMs, appendLine });
  } finally {
    try { sock.close(); } catch { /* 已关闭 */ }
    await killServer(server.proc);
    rmSync(root, { recursive: true, force: true });      // safe-rm: mkdtemp 一次性目录
    rmSync(projectDir, { recursive: true, force: true }); // safe-rm: 目录名由本用例一次性 cwd 编码而来
  }
}

test('SESSION-04：终端最后重贴、手机那段不在会接上的链上 → 发送前拒收，ack 带齐面板要的事实，这条没进 agent', async () => {
  await withSeededSession({ terminalWroteLast: true }, async ({ cwd, instanceId, phoneLast, emitAck, bubbles }) => {
    const ack = await emitAck('user:message', { text: '手机上再问一句', instanceId, cwd, clientMessageId: 'rd-1' });
    // 键集：多一个、少一个都红。少了 divergence，前端出不了面板；少了 permanent，缓存的旧前端会把它塞进 outbox 反复重发
    assert.deepEqual(Object.keys(ack ?? {}).sort(), ['divergence', 'error', 'ok', 'permanent', 'reason'],
      `拒收 ack 的键集变了——前端（logic/outbox-send.js）按这些键分支：${JSON.stringify(ack)}`);
    assert.equal(ack.ok, false);
    assert.equal(ack.reason, 'resume_divergent');
    assert.equal(ack.permanent, true);
    assert.deepEqual(Object.keys(ack.divergence).sort(), DIVERGENCE_KEYS, `面板文案吃这七个字段：${JSON.stringify(ack.divergence)}`);
    assert.equal(ack.divergence.newestUuid, phoneLast, '最新那条是手机的回答');
    assert.equal(ack.divergence.droppedCount, 2, '丢的是手机那一问一答');
    assert.equal(ack.divergence.anchorOnlyCount, 0, '终端那支分叉后只有 system 行');
    assert.equal((await bubbles()).length, 0, '拒收就是没发：送进 agent 的话，模型已经从终端那一轮接上了');

    // 用户在面板上选「仍然发送」：同一 clientMessageId（拒收不记去重）带上确认的是哪一段
    const again = await emitAck('user:message', { text: '手机上再问一句', instanceId, cwd, clientMessageId: 'rd-1', ackDivergence: ack.divergence.newestUuid });
    assert.equal(again.ok, true, `确认的正是这一段 → 放行：${JSON.stringify(again)}`);
    assert.ok(!again.deduped, '拒收那次不能记进去重表，否则确认后的这次被当成「已处理」吞掉');
    const sent = await bubbles();
    assert.equal(sent.length, 1, `放行后只发一次，实际 ${sent.length} 条`);
    assert.equal(sent[0].payload?.clientMessageId, 'rd-1');
  });
});

// 判定要读整份 transcript（长会话数十 MB），2026-10-31 起不挡切换回执：回执先回，判定在后台只读 spawn 前那一刻的
// 字节，发送闸等它落定再判。这条守的是「挪出关键路径」没把闸挪漏——回执一到就发，照样要拦。
const PAD_LINES = 60_000; // 约 45MB，判定的整份读盘约 0.3s（宿主机实测）；切换的其余部分只读尾窗

test('SESSION-04：判定不挡切换回执；回执一到就发、文件尾又被新 CLI 写过，照样拒收', async () => {
  await withSeededSession({ terminalWroteLast: true, padLines: PAD_LINES }, async ({ cwd, instanceId, phoneLast, emitAck, bubbles, switchMs, appendLine }) => {
    // 新 CLI 起来后自己会往文件尾写（resume 后重贴 last-prompt）。它读盘时这行还不在，判定也不能把它算进去：
    // 这行指向手机那条，读进去分叉就「消失」了，正是这道闸要拦的那种静默丢上下文。
    appendLine({ type: 'last-prompt', lastPrompt: '手机上接着问的', leafUuid: phoneLast, sessionId: SESSION_ID });
    const t = Date.now();
    const ack = await emitAck('user:message', { text: '手机上再问一句', instanceId, cwd, clientMessageId: 'rd-early' });
    const gateMs = Date.now() - t;
    assert.equal(ack?.reason, 'resume_divergent', `判定还没落定就放行了，或把 spawn 之后写的行算了进去：${JSON.stringify(ack)}`);
    assert.equal(ack.divergence.newestUuid, phoneLast);
    assert.equal((await bubbles()).length, 0, '拒收就是没发');
    // 比先后，不设阈值：判定比切换的其余部分慢得多（填充行），回执若等判定，发送时结论早已就绪、闸几乎不用等；
    // 回执先回，这次发送就要等判定读完。
    assert.ok(gateMs > switchMs, `切换回执等了分叉判定：回执 ${switchMs}ms，随后的发送只等了 ${gateMs}ms`);
  });
});

test('SESSION-04 正对照：手机侧最后写（没有终端挂在旧叶子下的行）→ 首发直接放行', async () => {
  await withSeededSession({ terminalWroteLast: false }, async ({ cwd, instanceId, emitAck, bubbles }) => {
    const ack = await emitAck('user:message', { text: '手机上再问一句', instanceId, cwd, clientMessageId: 'rd-ctl' });
    assert.equal(ack.ok, true, `这条不绿，上面的「拒收」就证明不了任何事：${JSON.stringify(ack)}`);
    assert.equal((await bubbles()).length, 1);
  });
});
