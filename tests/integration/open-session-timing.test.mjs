// tests/integration/open-session-timing.test.mjs —— 打开会话的两条回执在【真 server】上带服务端耗时（零 token）
//
// 2026-10-31 性能改造 Stage 0：前端把 session:switch / session:history 回执里的 timing 写进打开会话那行 [PERF]
// （app/public/js/app/perf-trace.js），机主在手机上导出，改前改后拿它对照。少了它只剩客户端看到的往返时长，
// 分不清慢在服务端哪一段。
//
// 为什么在这一层：timing 是在 app/src/server/app.js 这个组装根里拼进 ack 的，单测够不到；E2E 打的是 mock
// （零 import app/src 的平行实现），真 server 把它删掉 E2E 照样绿。守键集不守键值——耗时每次都不同，
// 键少了就是那一段从日志里消失了。历史构建拆分的取值（hit / miss、读了几遍）在 tests/unit/history-messages.test.mjs。
//
// 【隔离】同 session-history-truncation.test.mjs：workDir / dataDir 走 mkdtemp；会话文件必须落在真实
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
import { getProjectDir } from '../../app/src/sessions/history.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'ccm-open-timing-token';
const HISTORY_ID = 'open-timing-history';
const SWITCH_ID = 'open-timing-switch';

let serverProc, port, workDir, dataDir, projDir, socket;

function writeTranscript(id) {
  const lines = [
    { type: 'user', uuid: `${id}-u`, message: { role: 'user', content: '你好' } },
    { type: 'assistant', uuid: `${id}-a`, message: { role: 'assistant', content: [{ type: 'text', text: '你好！' }] } },
  ];
  writeFileSync(join(projDir, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

function emit(evt, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${evt} ack 超时`)), 20_000);
    socket.emit(evt, payload, (res) => { clearTimeout(timer); resolve(res); });
  });
}

test.describe('打开会话的回执带服务端耗时（真 server，零 token）', () => {
  test.before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'ccm-opentiming-work-'));
    dataDir = mkdtempSync(join(tmpdir(), 'ccm-opentiming-data-'));
    projDir = join(homedir(), '.claude', 'projects', getProjectDir(workDir));
    mkdirSync(projDir, { recursive: true });
    writeTranscript(HISTORY_ID);
    writeTranscript(SWITCH_ID);

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
      for (const id of [HISTORY_ID, SWITCH_ID]) {
        // safe-path: 文件名是本文件写死的夹具常量，目录由一次性 workDir 编码而来；单文件删除，不递归。
        try { const f = join(projDir, `${id}.jsonl`); if (existsSync(f)) rmSync(f, { force: true }); } catch { /* 尽力 */ }
      }
      // rmdir 收尾：只删空目录，非空直接失败——挡住"顺手递归删掉别人东西"。
      try { rmdirSync(join(projDir, 'memory')); } catch { /* 不存在或非空 */ }
      try { rmdirSync(projDir); } catch { /* 非空说明有别的会话，留着 */ }
    }
  });

  test('session:history：handler 总耗时，加历史构建的拆分（首读没吃上缓存：求链、解析、读了几遍）', async () => {
    const res = await emit('session:history', { sessionId: HISTORY_ID, cwd: workDir });
    assert.equal(res.error, undefined, `不该走失败支：${res.error}`);
    assert.deepEqual(Object.keys(res.timing ?? {}).sort(), ['cache', 'chainMs', 'ms', 'parseMs', 'passes'], JSON.stringify(res.timing));
    assert.ok(Number.isFinite(res.timing.ms));
  });

  test('session:switch 新开实例：handler 总耗时，加 resume 各段；再切过去（实例已在跑）只带总耗时', async () => {
    const opened = await emit('session:switch', { sessionId: SWITCH_ID, cwd: workDir });
    assert.equal(opened.ok, true, `前提：会话要能打开：${JSON.stringify(opened)}`);
    assert.deepEqual(Object.keys(opened.timing ?? {}).sort(),
      ['defaultsMs', 'divergenceMs', 'ms', 'priorExitMs', 'readsMs', 'resolveMs', 'resumeMs'], JSON.stringify(opened.timing));
    assert.ok(Object.values(opened.timing).every(Number.isFinite), JSON.stringify(opened.timing));
    // 聚焦已在跑的实例：resume 各段是它当初打开时的数，带上就像这一次又 resume 了一遍
    const again = await emit('session:switch', { sessionId: SWITCH_ID, cwd: workDir });
    assert.equal(again.ok, true, `再切过去要成功：${JSON.stringify(again)}`);
    assert.deepEqual(Object.keys(again.timing ?? {}), ['ms'], JSON.stringify(again.timing));
  });
});
