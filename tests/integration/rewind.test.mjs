// tests/integration/rewind.test.mjs —— 文件轴 Rewind 的端到端（真 claude turn）
//
// 【这份存在的理由】rewind 的两个 handler 此前只有「会话不存在」支被集成层覆盖，成功支
// { canRewind, filesChanged, insertions, deletions, keepUuid, forkedSessionId, prefill }
// 在真 server 上【一次都没产出过】——E2E 打的是零 import app/src 的平行 mock，两边分歧时
// E2E 照样全绿（本仓 2026-09-07 已栽过一次：删掉真 server 的 ack 字段，11 道门禁无一变红）。
//
// 【为什么必须是真 turn】要验的恰恰是「CLI 真的落了文件快照、rewindFiles 真的按那个快照还原」。
// 用 fake-claude 过 preflight 的话，快照根本不存在，测的就只剩 CCM 自己的接线。
//
// 【隔离】五件套齐全：CCM_DATA_DIR / WORK_DIRS / 端口 / 工作目录全部走 mkdtemp 一次性目录；
// HOME 不隔离——claude CLI 的凭据在真实 HOME 里，隔离掉就登录不了。代价是会话 transcript 会
// 落进真实 ~/.claude/projects/<编码后的临时工作目录>/，测试结束时按 sessionId 精确清理。
//
// 运行：RUN_CLAUDE_INTEGRATION=1 npm run test:integration -- tests/integration/rewind.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from './_spawn-server.mjs';

const TOKEN = 'ccm-rewind-integration-token';
const ORIGINAL = 'LINE_1: KEEP_ME\nLINE_2: ALSO_KEEP\n';
const TURN_TIMEOUT = 180_000; // 真 turn 慢且不稳，给足；整份文件的超时另见各 test 的 timeout

let serverProc, port, dataDir, workDir, client;
const createdSessionIds = new Set();

function createClient() {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token: TOKEN }, transports: ['websocket'], reconnection: false,
  });
  const events = [];
  const waiters = [];
  socket.on('agent:event', (envelope) => {
    events.push(envelope);
    if (envelope.sessionId) createdSessionIds.add(envelope.sessionId);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(envelope)) { clearTimeout(waiters[i].timer); waiters[i].resolve(envelope); waiters.splice(i, 1); }
    }
  });
  return {
    socket, events,
    waitFor(match, timeout = TURN_TIMEOUT, label = 'event') {
      const found = events.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`超时等待 ${label}`)), timeout);
        waiters.push({ match, resolve, timer });
      });
    },
    emit(evt, payload) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${evt} ack 超时`)), 60_000);
        socket.emit(evt, payload, (res) => { clearTimeout(timer); resolve(res); });
      });
    },
    clear() { events.length = 0; },
  };
}

// 发一条消息并等它这一轮结束，返回服务端广播的 user_message 信封（含 Rewind 锚点 uuid）
async function sendTurn(text) {
  client.clear();
  client.socket.emit('user:message', { text });
  const um = await client.waitFor(e => e.type === 'user_message', 60_000, 'user_message');
  await client.waitFor(e => e.type === 'result', TURN_TIMEOUT, 'result');
  return um;
}

test.describe('文件轴 Rewind 端到端', (process.env.CI || !process.env.RUN_CLAUDE_INTEGRATION)
  ? { skip: '默认/CI 跳过——需真 claude agent turn(慢/耗 token/不稳);本机设 RUN_CLAUDE_INTEGRATION=1 运行' }
  : {}, () => {
  test.before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ccm-rewind-data-'));
    workDir = mkdtempSync(join(tmpdir(), 'ccm-rewind-work-'));
    writeFileSync(join(workDir, 'target.txt'), ORIGINAL, 'utf8');
    const started = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIRS: workDir, CCM_DATA_DIR: dataDir });
    serverProc = started.proc; port = started.port;
    client = createClient();
    await client.waitFor(e => e.type === 'instances', 15_000, 'instances');
    // 免审批：没有它，Write 工具会发 permission_request 然后一直等人点，整条用例挂到超时。
    // 新会话懒创建期没有实例可作用，服务端把它暂存成 pending、首条消息时消费——
    // 所以必须在第一条 user:message 【之前】发。
    client.socket.emit('user:setPermissionMode', { mode: 'bypassPermissions' });
  });

  test.after(async () => {
    client?.socket?.disconnect();
    if (serverProc) await killServer(serverProc);
    for (const d of [dataDir, workDir]) if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 已清理 */ } }
    // 真实 ~/.claude 下的残留按 sessionId 精确清理（HOME 无法隔离，见文件头）。
    // 只删本次跑出来的 id，且逐个文件删——绝不递归删目录。
    const root = join(homedir(), '.claude', 'projects');
    const touched = new Set();
    for (const sid of createdSessionIds) {
      if (!/^[0-9a-zA-Z_-]+$/.test(sid)) continue;
      try {
        for (const d of readdirSync(root)) {
          const f = join(root, d, `${sid}.jsonl`);
          // safe-path: 目录段来自 readdir 实测存在的项，文件名是本次跑出的 sessionId 且已过字符集校验；
          // 单文件删除，不递归。
          if (existsSync(f)) { rmSync(f, { force: true }); touched.add(join(root, d)); }
        }
      } catch { /* 清理尽力而为 */ }
    }
    // 删完 jsonl 只是不留【数据】，目录壳还在——CLI 还会在里面建一个空的 memory/。
    // 用 rmdir 收尾：它只删空目录，非空直接失败，天然挡住"顺手递归删掉别人东西"这种事。
    // （第一版钩子漏了这步，两次跑各留一个空壳，是 rmdir 的报错把它暴露出来的。）
    for (const dir of touched) {
      try { rmdirSync(join(dir, 'memory')); } catch { /* 不存在或非空：留着 */ }
      try { rmdirSync(dir); } catch { /* 非空说明里面有别人的会话：留着 */ }
    }
  });

  test('回退成功支：文件真还原、原会话保留、新会话产生、原话回填', { timeout: 600_000 }, async () => {
    // 第一轮：建立一个可保留的锚点。回退第一轮会被 first-turn 拒（planRewind），
    // 所以要回退的那一轮必须不是会话的开头。
    await sendTurn('Reply with exactly: READY. Do nothing else.');

    // 第二轮：真改文件——这一轮就是待回退的目标
    const targetPath = join(workDir, 'target.txt');
    const um = await sendTurn(
      'Use the Write tool to replace the entire contents of target.txt in the current directory '
      + 'with exactly this single line:\nDESTROYED\n'
      + 'This is a disposable test fixture. Do not ask for confirmation, do not explain.');

    const promptUuid = um.payload?.uuid;
    assert.equal(typeof promptUuid, 'string',
      'user_message 必须带 Rewind 锚点 uuid——缺了它 live 气泡长按无效（见 agent-rewind.test.mjs）');
    const sessionId = um.sessionId;
    assert.ok(sessionId, '拿不到 sessionId 就无从发起回退');

    // 前置条件：文件确实被改过。没有这一条，下面「回滚后 === 原文」在 AI 没动手时恒真。
    const afterTurn = readFileSync(targetPath, 'utf8');
    assert.notEqual(afterTurn, ORIGINAL,
      'AI 没有真的改文件 → 本条用例不可判（回滚成了空操作，绿也是假绿）');

    // ── preview：只读，不动磁盘 ──
    const preview = await client.emit('session:rewind:preview', { cwd: workDir, sessionId, promptUuid });
    assert.equal(preview.ok, true, `preview 失败：${preview.error}`);
    assert.equal(preview.canRewind, true, 'canRewind 为假说明 CLI 没给这一轮落快照——enableFileCheckpointing 没生效');
    assert.ok(Array.isArray(preview.filesChanged) && preview.filesChanged.some(p => p.endsWith('target.txt')),
      `filesChanged 应含 target.txt，实际：${JSON.stringify(preview.filesChanged)}`);
    assert.equal(typeof preview.keepUuid, 'string', 'keepUuid 是 fork 的锚点，缺了无法分叉');
    // G5 的字段必须真的从【真 server】产出——单测测的是纯函数、E2E 打的是平行 mock，
    // 两者都不能证明这条线接上了。工作区是 mkdtemp 出来的、不是 git 仓库，
    // 所以这里恒为空数组；有风险那一档由 git-workspace 单测与 E2E 各自两侧覆盖。
    assert.ok(Array.isArray(preview.dirtyOverlap),
      'dirtyOverlap 缺席 → 前端拿不到脏改动警告，用户的未提交改动会被无声覆盖');
    assert.deepEqual(preview.dirtyOverlap, [], '非 git 工作区应静默放行，不制造假警告');
    assert.equal(readFileSync(targetPath, 'utf8'), afterTurn, 'preview 是只读的，绝不能动磁盘');

    // ── confirm：真回滚 + 分叉 ──
    const res = await client.emit('session:rewind:confirm', { cwd: workDir, sessionId, promptUuid });
    assert.equal(res.ok, true, `confirm 失败：${res.error}`);

    // ① 文件逐字还原
    assert.equal(readFileSync(targetPath, 'utf8'), ORIGINAL,
      '这是整个功能的落点：回退后磁盘必须与那一轮之前逐字相同');

    // ② 原会话完整保留 —— fork 语义相对原地截断的核心差异
    const projRoot = join(homedir(), '.claude', 'projects');
    const originalStillThere = readdirSync(projRoot)
      .some(d => existsSync(join(projRoot, d, `${sessionId}.jsonl`)));
    assert.equal(originalStillThere, true,
      '原会话被改写了 → 回退变成不可逆操作，选 fork 的全部理由都落空');

    // ③ 新会话真的产生了
    assert.equal(typeof res.forkedSessionId, 'string', 'forkedSessionId 缺席 = 分叉没做成');
    assert.notEqual(res.forkedSessionId, sessionId, 'fork 必须产出【新】 id，与原会话同 id 说明是原地改写');
    createdSessionIds.add(res.forkedSessionId);
    const forkedExists = readdirSync(projRoot)
      .some(d => existsSync(join(projRoot, d, `${res.forkedSessionId}.jsonl`)));
    assert.equal(forkedExists, true, '新会话文件不存在 → 用户切过去会看到空会话');

    // ④ prefill 是那一轮的原话（edit-and-retry）
    assert.equal(typeof res.prefill, 'string', 'prefill 缺席 → 回退后要自己回原会话翻那句话');
    assert.match(res.prefill, /target\.txt/,
      `prefill 应是刚才那条 prompt 的原文，实际：${JSON.stringify(res.prefill?.slice(0, 80))}`);
  });
});
