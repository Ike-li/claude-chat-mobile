// tests/unit/agent-sdk-undeclared-methods.test.mjs —— agent.js 依赖、sdk.d.ts 没声明的 Query 方法还在不在
//
// 测什么：真 SDK 的 query() 返回的对象上，askSideQuestion、getSettings、getTaskOutput 仍是函数。
//   这几个方法上游没有承诺，agent.js 又是先判存在再调用，所以上游删掉时不报错，功能静默消失。
//   side-question.test.mjs、agent-control.test.mjs 用假 q，SDK 升级时照样全绿，咬不住这种情况。
//   官方 promptSuggestions 替代不了（网关和冷缓存下不出建议，recap 也没有官方接口），前两个方法要长期留着。
//   getTaskOutput 经真 SDK 的回包在 agent-running-task-output.test.mjs，这里只管它还在不在。
// 不测什么 + 为什么：① CLI 还认不认 side_question / get_settings / get_task_output 控制请求：fake-claude 对任何控制请求
//   都回 success，要真 CLI 才答得了，属 S5。② 返回值形状：这里不调用这几个方法，上游改形状看不到。
// 槽位：S1（真 SDK + fake-claude，零 token）

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const FAKE_CLAUDE = fileURLToPath(new URL('../fixtures/fake-claude.sh', import.meta.url));
const skip = process.platform === 'win32'; // .sh 在 Windows 上起不了进程

// query() 跑在本进程里，子进程的 env 又取自这里，改 process.env 两边都隔离到。
const HOME = mkdtempSync(join(tmpdir(), 'ccm-sdk-methods-'));
process.env.HOME = HOME;
process.env.CLAUDE_CONFIG_DIR = join(HOME, '.claude');

// 和生产一样是长驻输入流，永不产出，不发消息就没有回合。
const IDLE_PROMPT = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };

const METHODS = [
  {
    method: 'askSideQuestion',
    consequence: 'AgentSession.askSide() 会一律返回 null，下一步建议（maybeSuggest）和离开回来摘要（maybeRecap）静默消失，不报错',
    lookAt: '去新版 sdk.mjs 查 side_question 控制请求现在由哪个方法发出，再改 app/src/agent/agent.js 的 askSide()',
  },
  {
    method: 'getSettings',
    consequence: 'refreshEffectiveEffort() 会直接返回，没指定 effort 时手机上看不到实际生效的档（effort_mode.effective），不报错',
    lookAt: '去新版 sdk.mjs 查 get_settings 控制请求现在由哪个方法发出，再改 app/src/agent/agent.js 的 refreshEffectiveEffort()',
  },
  {
    method: 'getTaskOutput',
    consequence: 'AgentSession.readRunningTaskOutput() 会一律回落，手机上运行中的后台命令只显示「输出不可用」，看不到最新输出，不报错',
    lookAt: '去新版 sdk.mjs 查 get_task_output 控制请求现在由哪个方法发出，再改 app/src/agent/agent.js 的 readRunningTaskOutput()',
  },
];

describe('真 SDK 的 Query 上留着 agent.js 依赖的未声明方法', { skip }, () => {
  let q;

  before(async () => {
    q = query({
      prompt: IDLE_PROMPT,
      options: {
        cwd: HOME,
        pathToClaudeCodeExecutable: FAKE_CLAUDE,
        env: { ...process.env, CCM_FAKE_CLAUDE_MODE: 'init' },
      },
    });
    await q.initializationResult(); // 握手成功才说明下面看的是真连上 CLI 的 Query
  }, { timeout: 15_000 });

  after(() => {
    q?.close();
    rmSync(HOME, { recursive: true, force: true });
  });

  for (const { method, consequence, lookAt } of METHODS) {
    it(`Query.${method} 是函数`, () => {
      assert.equal(typeof q[method], 'function', `SDK 的 Query 上没有 ${method} 了：${consequence}。${lookAt}`);
    });
  }
});
