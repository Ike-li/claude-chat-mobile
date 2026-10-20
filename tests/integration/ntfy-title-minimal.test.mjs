// tests/integration/ntfy-title-minimal.test.mjs —— ntfy 的标题不带会话标题（验收 O33，AC-22-11）
// 测什么：真 server + fake-claude turn 档 + 本地假 ntfy 端点。客户端上报「在后台」，回合收尾触发完成推送；
//         ntfy 收到的标题只有「事件 · 项目」，不含会话标题——没有 AI 标题时会话标题就是第一条消息的原文。
// 这一层守的是组装根里 emitNotify 那一行（构建函数给的 ntfyTitle 有没有真的用上）；各类推送的 ntfyTitle 由
// tests/invariants/notifications.test.mjs 的 SEC-04 逐类钉住。零 token：fake-claude 不跑模型。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from './_spawn-server.mjs';

const TOKEN = 'it-ntfy-title-token';
const FIRST_MESSAGE = '把 sk-live-SUPERSECRET 填进配置';

test('ntfy 完成推送：标题只有事件与项目，第一条消息的原文不进第三方明文标题', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-it-ntfy-title-'));
  const ws = join(root, 'proj-ntfy');
  mkdirSync(ws);
  const cwd = realpathSync(ws);
  const hits = [];
  const ntfy = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { hits.push(JSON.parse(body)); } catch { hits.push({ raw: body }); } res.end('{"id":"mock"}'); });
  });
  await new Promise(resolve => ntfy.listen(0, '127.0.0.1', resolve));
  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: root, CCM_FAKE_CLAUDE_MODE: 'turn',
    NTFY_URL: `http://127.0.0.1:${ntfy.address().port}`, NTFY_TOPIC: 'ccm-it-ntfy-title',
  });
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'it-ntfy-title' }, transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  try {
    await new Promise(resolve => sock.once('connect', resolve));
    sock.emit('client:presence', { hidden: true }); // 人不在前台：完成推送才会发
    const sent = await new Promise(resolve => sock.emit('user:message', { text: FIRST_MESSAGE, cwd, clientMessageId: 'ntfy-title-1' }, resolve));
    assert.equal(sent.ok, true, `前提：发得出去，实际 ${JSON.stringify(sent)}`);
    const hit = await waitForCondition(() => hits.find(h => /任务完成/.test(h.title ?? '')), { timeoutMs: 15_000, label: 'ntfy 收到完成推送' });
    assert.match(hit.title, new RegExp(basename(cwd)), '项目名要留，否则分不清是哪个项目');
    assert.doesNotMatch(hit.title, /SUPERSECRET/, `会话标题（第一条消息的原文）进了 ntfy 明文标题：${hit.title}`);
    assert.doesNotMatch(JSON.stringify(hit), /SUPERSECRET/, 'ntfy 请求的任何字段都不该带用户原话');
  } finally {
    sock.close();
    await killServer(server.proc);
    ntfy.close();
    rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});
