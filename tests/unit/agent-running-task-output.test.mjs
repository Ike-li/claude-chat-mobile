// tests/unit/agent-running-task-output.test.mjs —— 运行中后台任务的输出（对齐终端 /tasks 详情页）
//
// 测什么：AgentSession.readRunningTaskOutput 对运行中 / 不支持 / SDK 缺方法 / CLI 报错各自的结果，
//   以及它经真 SDK 走到（假）CLI 的控制请求。getTaskOutput 是 Query 上没声明的方法，
//   上游删掉时 agent.js 只会回落文案、不报错，所以最后一组用真 SDK 咬住这件事。
// 不测什么 + 为什么：① 真 CLI 的回包：fake-claude 的形状取自 2.1.318 零 token 实测，真 CLI 改形状这里看不到，
//   要靠升级时重跑探针。② 路由与纯文本化：在 socket-task-output.test.mjs。
// 槽位：S1（假 q；最后一组是真 SDK + fake-claude，零 token）

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { makeSession } from '../helpers/agent-unit.mjs';
import { getDiagLogs, record } from '../../app/src/agent/diag-log.js';

const RUNNING = [
  { task_id: 'bshell', task_type: 'local_bash', description: 'npm run dev' },
  { task_id: 'aagent', task_type: 'local_agent', description: 'review', subagent_type: 'code-reviewer' },
  { task_id: 'wflow', task_type: 'local_workflow', description: 'spec' },
  { task_id: 'mmcp', task_type: 'monitor_mcp', description: 'watch' },
];

function sessionWith(q) {
  const { s, dispose } = makeSession();
  s.q = q;
  s.reconcileBgTasks(RUNNING);
  return { s, dispose };
}

describe('readRunningTaskOutput', () => {
  it('运行中的后台命令：取到 CLI 给的末尾输出', async () => {
    const asked = [];
    const { s, dispose } = sessionWith({
      getTaskOutput: async (id) => { asked.push(id); return { output: 'line 9\n', total_bytes: 9000, truncated: true }; },
    });
    assert.deepEqual(await s.readRunningTaskOutput('bshell'), { ok: true, text: 'line 9\n', truncated: true, size: 9000 });
    assert.deepEqual(asked, ['bshell'], '任务 id 要原样交给 SDK，且只问一次');
    dispose();
  });

  it('子代理、工作流、MCP 监视：明确不支持，不去问 CLI', async () => {
    let asked = 0;
    const { s, dispose } = sessionWith({ getTaskOutput: async () => { asked++; return { output: '' }; } });
    for (const id of ['aagent', 'wflow', 'mmcp']) {
      assert.deepEqual(await s.readRunningTaskOutput(id), { ok: false, reason: 'unsupported' }, `${id} 不是 CLI 认的 shell 任务`);
    }
    assert.equal(asked, 0, 'CLI 只认 local_bash，打过去只会换回一条英文报错');
    dispose();
  });

  it('不在运行的 id 不打 SDK', async () => {
    let asked = 0;
    const { s, dispose } = sessionWith({ getTaskOutput: async () => { asked++; return { output: '' }; } });
    for (const id of ['ghost', '', null, undefined, 7]) {
      assert.deepEqual(await s.readRunningTaskOutput(id), { ok: false, reason: 'unavailable' });
    }
    assert.equal(asked, 0);
    dispose();
  });

  it('SDK 没有这个方法：回落，不抛错', async () => {
    const { s, dispose } = sessionWith({});
    assert.deepEqual(await s.readRunningTaskOutput('bshell'), { ok: false, reason: 'unavailable' });
    dispose();
  });

  it('实例已 dispose：不再打 SDK', async () => {
    let asked = 0;
    const { s } = sessionWith({ getTaskOutput: async () => { asked++; return { output: '' }; } });
    s.dispose();
    s.bgTasks.set('bshell', { taskType: 'local_bash' }); // dispose 清了注册表；留一条才能走到 disposed 这道判断
    assert.deepEqual(await s.readRunningTaskOutput('bshell'), { ok: false, reason: 'unavailable' });
    assert.equal(asked, 0);
  });

  it('回包形状不对（未声明接口，上游没有承诺）：回落，不把 undefined 当输出', async () => {
    const { s, dispose } = sessionWith({ getTaskOutput: async () => ({}) });
    assert.deepEqual(await s.readRunningTaskOutput('bshell'), { ok: false, reason: 'unavailable' });
    dispose();
  });

  it('CLI 报错：带上原因，不向外抛', async () => {
    const { s, dispose } = sessionWith({ getTaskOutput: async () => { throw new Error('boom'); } });
    assert.deepEqual(await s.readRunningTaskOutput('bshell'), { ok: false, reason: 'error', error: 'boom' });
    dispose();
  });

  it('控制请求挂住：有限时间内结束（限流重试期间不回包是真实形态）', { timeout: 2_000 }, async () => {
    const { s, dispose } = sessionWith({ getTaskOutput: () => new Promise(() => {}) });
    s.interruptTimeoutMs = 10;
    const res = await s.readRunningTaskOutput('bshell');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'error');
    assert.match(res.error, /timeout/);
    dispose();
  });

  it('轮询不挤掉诊断时间线：盯着输出几分钟，之前的状态转换还在', async () => {
    const { s, dispose } = sessionWith({ getTaskOutput: async () => ({ output: 'x', total_bytes: 1, truncated: false }) });
    const key = s.logKey();
    record(key, 'interrupt', 'state_transition_before_polling');
    for (let i = 0; i < 150; i++) await s.readRunningTaskOutput('bshell');
    assert.ok(
      getDiagLogs(key).some(e => e.event === 'state_transition_before_polling'),
      '环形缓冲只有 100 条，轮询的 race_settle 不走心跳限额就会把真正有用的记录全冲掉',
    );
    dispose();
  });
});

const skipRealSdk = process.platform === 'win32'; // .sh 在 Windows 上起不了进程

describe('经真 SDK 走到 CLI', { skip: skipRealSdk }, () => {
  const FAKE_CLAUDE = fileURLToPath(new URL('../fixtures/fake-claude.sh', import.meta.url));
  const HOME = mkdtempSync(join(tmpdir(), 'ccm-task-output-'));
  const prevHome = process.env.HOME;
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  const IDLE_PROMPT = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  let q;
  let session;

  before(async () => {
    process.env.HOME = HOME;
    process.env.CLAUDE_CONFIG_DIR = join(HOME, '.claude');
    q = query({
      prompt: IDLE_PROMPT,
      options: {
        cwd: HOME,
        pathToClaudeCodeExecutable: FAKE_CLAUDE,
        env: {
          ...process.env,
          CCM_FAKE_CLAUDE_MODE: 'init',
          CCM_FAKE_CLAUDE_TASK_OUTPUT: JSON.stringify({ bshell: { output: '\u001b[31mred\u001b[0m\n', total_bytes: 14, truncated: false } }),
        },
      },
    });
    await q.initializationResult();
    session = sessionWith(q);
  }, { timeout: 15_000 });

  after(() => {
    session?.dispose();
    q?.close();
    process.env.HOME = prevHome;
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    rmSync(HOME, { recursive: true, force: true }); // safe-rm: 目录来自本文件的 mkdtemp
  });

  it('Query 上还有 getTaskOutput，运行中输出能取到', async () => {
    assert.deepEqual(
      await session.s.readRunningTaskOutput('bshell'),
      { ok: true, text: '\u001b[31mred\u001b[0m\n', truncated: false, size: 14 },
      'SDK 删了或改了 getTaskOutput 时手机上只会回落成「输出不可用」、不报错：'
      + '去新版 sdk.mjs 查 get_task_output 控制请求现在由哪个方法发出，再改 agent.js 的 readRunningTaskOutput',
    );
  });

  it('CLI 不认的 id：错误原样带回，实例不受影响', async () => {
    session.s.reconcileBgTasks([{ task_id: 'bgone', task_type: 'local_bash', description: 'x' }]);
    const res = await session.s.readRunningTaskOutput('bgone');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'error');
    assert.match(res.error, /no shell or Monitor task/);
  });
});
