// tests/integration/service-self-start-record.test.mjs —— 没真正起来的启动不进「重启记录」（验收 O18 / AC-01-12、AC-17-01）
//
// 非 macOS 平台上，「重启记录」的唯一来源是 server 自己写的 started / restarted（service-sampler.recordSelfStart）。
// 此前它在模块求值时就写，早于 listen：缺令牌被拒、端口被占这类启动失败，退出前已经记了一条。临时数据目录里两次
// 失败启动留下两条，服务状态面板把没起来的启动也算成重启，崩溃循环告警的频率跟着虚高。
// 现在只在 listen 成功之后写。本文件三条：端口被占 → 不记；被拒绝启动 → 不记；正常起来 → 记一条（对照）。
// 只在 Linux 容器里有意义：darwin 上 recordSelfStart 早退（launchctl 快照那条路负责）。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripInheritedEnv } from '../helpers/spawn-env.mjs';
import { spawnServer, killServer } from './_spawn-server.mjs';

const dirs = [];
function tempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function selfStartEvents(dataDir) {
  const file = join(dataDir, 'service-events.json');
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')).filter(e => e.label?.endsWith('server'));
}

// 跑一个预期起不来的 server，等它自己退出
function runFailingServer(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['app/server.js'], {
      env: {
        ...stripInheritedEnv(process.env),
        DEV_MODE: '0',
        CCM_TEST_PRESERVE_EMPTY_ENV: '1',
        LOG_TERMINAL: 'off',
        CF_ACCESS_HOSTNAME: '', CF_ACCESS_TEAM: '', CF_ACCESS_AUD: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });
    let stderr = '';
    proc.stderr.on('data', c => { stderr += c; });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('server 10s 内没有自己退出')); }, 10_000);
    proc.on('exit', code => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

test('端口被占、启动失败 → 不记 started / restarted', async () => {
  const blocker = createServer();
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  try {
    const dataDir = tempDir('ccm-selfstart-busy-');
    const { code, stderr } = await runFailingServer({
      PORT: String(port), BIND_MODE: 'loopback', AUTH_TOKEN: 'selfstart-token',
      CCM_DATA_DIR: dataDir, WORK_DIRS: dataDir,
    });
    assert.equal(code, 1);
    assert.match(stderr, /已被占用|EADDRINUSE/);
    assert.deepEqual(selfStartEvents(dataDir), [], '没起来的这次启动不该进重启记录');
  } finally {
    blocker.close();
  }
});

test('缺令牌被拒绝启动 → 不记 started / restarted', async () => {
  const dataDir = tempDir('ccm-selfstart-refused-');
  const { code } = await runFailingServer({
    CCM_TEST_EPHEMERAL_PORT: '1', AUTH_TOKEN: '',
    CCM_DATA_DIR: dataDir, WORK_DIRS: dataDir,
  });
  assert.notEqual(code, 0);
  assert.deepEqual(selfStartEvents(dataDir), []);
});

test('对照：正常起来 → 记一条 started', async () => {
  const dataDir = tempDir('ccm-selfstart-ok-');
  const { proc } = await spawnServer({
    AUTH_TOKEN: 'selfstart-token', CCM_DATA_DIR: dataDir, WORK_DIRS: dataDir,
    CF_ACCESS_HOSTNAME: '', CF_ACCESS_TEAM: '', CF_ACCESS_AUD: '',
  });
  try {
    const events = selfStartEvents(dataDir);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'started');
  } finally {
    await killServer(proc);
  }
});
