// tests/integration/session-history-truncation.test.mjs —— session:history 在【真 server】上报削顶前的条数（零 token）
//
// 验收 O44 / AC-06-13：超过 HISTORY_MAX_MESSAGES 的会话只回最近那一段，而 ack 此前只有 { messages }，
// 前端只能写「加载了 2000 条历史消息」，读起来像全部。修法是 ack 带上 total（削顶前的条数），
// 前端据此说「仅显示最近 N 条（共 M 条）」。
//
// 为什么在这一层：total 在 app/src/server/app.js 这个组装根里拼进 ack，单测够不到；E2E 打的是 mock
// （零 import app/src 的平行实现），真 server 把 total 删掉它照样绿。纯函数一侧在
// tests/unit/history-messages.test.mjs 与 tests/unit/logic-format.test.mjs。
//
// 【隔离】同 rewind-guards.test.mjs：workDir / dataDir 走 mkdtemp；会话文件必须落在真实
// ~/.claude/projects/<编码 cwd>/（getProjectDir 认的是真实 HOME，无法注入），目录名由一次性 workDir
// 编码而来，不会撞到别的项目；after 钩子按文件精确删，再 rmdir 收尾（只删空目录）。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, rmdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from './_spawn-server.mjs';
import { getProjectDir, HISTORY_MAX_MESSAGES } from '../../app/src/sessions/history.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'ccm-history-truncation-token';
const LONG_ID = 'history-truncation-long';
const SHORT_ID = 'history-truncation-short';
const LONG_TOTAL = HISTORY_MAX_MESSAGES + 100;

let serverProc, port, workDir, dataDir, projDir, socket;

function writeTranscript(id, count) {
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify({
    type: i % 2 === 0 ? 'user' : 'assistant',
    uuid: `${id}-${i}`,
    message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `消息 ${i}` },
  }));
  writeFileSync(join(projDir, `${id}.jsonl`), lines.join('\n') + '\n', 'utf8');
}

function emit(evt, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${evt} ack 超时`)), 20_000);
    socket.emit(evt, payload, (res) => { clearTimeout(timer); resolve(res); });
  });
}

test.describe('session:history 报削顶前的条数（真 server，零 token）', () => {
  test.before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'ccm-histtrunc-work-'));
    dataDir = mkdtempSync(join(tmpdir(), 'ccm-histtrunc-data-'));
    projDir = join(homedir(), '.claude', 'projects', getProjectDir(workDir));
    mkdirSync(projDir, { recursive: true });
    writeTranscript(LONG_ID, LONG_TOTAL);
    writeTranscript(SHORT_ID, 4);

    const started = await spawnServer({
      AUTH_TOKEN: TOKEN, WORK_DIRS: workDir, CCM_DATA_DIR: dataDir,
      CLAUDE_BIN: join(HERE, '..', 'fixtures', 'fake-claude.sh'),
    });
    serverProc = started.proc; port = started.port;
    socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: TOKEN }, transports: ['websocket'], reconnection: false,
    });
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
      setTimeout(() => reject(new Error('connect 超时')), 10_000);
    });
  });

  test.after(async () => {
    socket?.disconnect();
    if (serverProc) await killServer(serverProc);
    for (const d of [workDir, dataDir]) if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 已清理 */ } }
    if (projDir) {
      for (const id of [LONG_ID, SHORT_ID]) {
        // safe-path: 文件名是本文件写死的夹具常量，目录由一次性 workDir 编码而来；单文件删除，不递归。
        try { const f = join(projDir, `${id}.jsonl`); if (existsSync(f)) rmSync(f, { force: true }); } catch { /* 尽力 */ }
      }
      // rmdir 收尾：只删空目录，非空直接失败——挡住"顺手递归删掉别人东西"。
      try { rmdirSync(projDir); } catch { /* 非空说明有别的会话，留着 */ }
    }
  });

  test('超上限的会话：只回最近 HISTORY_MAX_MESSAGES 条，total 是磁盘上的总条数', async () => {
    const res = await emit('session:history', { sessionId: LONG_ID, cwd: workDir });
    assert.equal(res.error, undefined, `不该走失败支：${res.error}`);
    assert.equal(res.messages.length, HISTORY_MAX_MESSAGES);
    assert.equal(res.total, LONG_TOTAL, '缺 total（或报成削顶后的条数）时前端只能说「加载了 2000 条」，读起来像全部');
  });

  test('没超上限的会话：total 等于返回条数', async () => {
    const res = await emit('session:history', { sessionId: SHORT_ID, cwd: workDir });
    assert.equal(res.messages.length, 4);
    assert.equal(res.total, 4);
  });
});
