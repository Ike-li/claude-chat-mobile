import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLifecycleIdleTimeout,
  formatLifecycleIdleReclaim,
  formatLifecycleProcessExited,
  formatLifecycleSessionError,
  formatLifecycleGatewayStall,
  buildAgentQueryOptions,
} from '../../src/agent/agent.js';
import { makeSession } from '../helpers/agent-unit.mjs';
import { getSessionLogs } from '../../src/agent/interaction-log.js';
import { getDiagLogs } from '../../src/agent/diag-log.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir } from '../../src/sessions/history.js';

// 本地 slash 命令进度相关用例共用的磁盘 fixture（隔离 tmpdir，绝不打真实 ~/.claude）
const LOCALCMD_BASE = join(tmpdir(), `ccm-lifecycle-localcmd-${process.pid}`);
const LOCALCMD_CWD = '/test/lifecycle-localcmd';
{
  const d = join(LOCALCMD_BASE, getProjectDir(LOCALCMD_CWD), 'sid-e1', 'subagents');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'agent-aone.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Angle A' }));
  writeFileSync(join(d, 'agent-aone.jsonl'), JSON.stringify({
    type: 'assistant', isSidechain: true,
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } }) + '\n');
}


// ---- lifecycle 文案（防「会话已结束」歧义）----
test.describe('formatLifecycle*', () => {
  test('idleTimeout / reclaim / processExited / sessionError 前缀稳定', () => {
    assert.equal(
      formatLifecycleIdleTimeout(10),
      '任务已中断：超过 10 分钟未收到 Claude 的任何消息（含思考/工具进度），已按挂死中断（可重新发送继续）',
    );
    assert.equal(
      formatLifecycleIdleTimeout(0.2),
      '任务已中断：超过 1 分钟未收到 Claude 的任何消息（含思考/工具进度），已按挂死中断（可重新发送继续）',
    );
    assert.equal(formatLifecycleIdleReclaim(30), '进程已回收：会话空闲超过 30 分钟（再发送或切换回来会自动续接）');
    assert.equal(formatLifecycleProcessExited(), '进程已退出：可重新发送消息继续（会话历史仍在）');
    assert.match(formatLifecycleSessionError('boom'), /^进程异常：boom$/);
    assert.match(formatLifecycleSessionError(''), /进程异常/);
  });
  test('gatewayStall：报静默秒数 + 自动中断上界 + 可操作建议，不宣称已中断', () => {
    const msg = formatLifecycleGatewayStall(95, 10);
    assert.match(msg, /95 秒/);
    assert.match(msg, /10 分钟/);
    assert.match(msg, /停止|重发|换模型/);
    assert.equal(/已中断|已按挂死/.test(msg), false, '只是告警，本轮仍在等待');
    // 归因收敛（2026-07-30）：旧文案断言「多为第三方网关限流/挂起」，但真机 6 次触发全是
    // 本地前台工具在跑（误报，已由前台工具豁免修掉）。剩余场景也未必是网关——可能是网络或
    // 长 prefill。看门狗只知道「没收到消息」，不知道为什么，文案不得替它猜。
    assert.equal(/第三方网关|限流/.test(msg), false, '不得断言未经证实的归因');
  });

  // R2（2026-08-10 真机 a90814ca）：静默秒数与本轮真实时长不同源——静默锚会被豁免分支
  // （后台任务/前台工具/本地命令在途）合法刷新，本轮起点只在 send/result 变。只报前者时，
  // 用户在一条 271 秒的连续静默里先看到「113 秒」、后看到「90 秒」，无从判断到底等了多久。
  test('R2：本轮总时长明显长于静默秒数时并报两个数', () => {
    const msg = formatLifecycleGatewayStall(90, 10, 285);
    assert.match(msg, /模型已 90 秒无响应/);
    assert.match(msg, /本轮已进行 285 秒/);
    assert.equal(/已中断|已按挂死/.test(msg), false, '仍然只是告警');
  });

  test('R2b：本轮时长缺失或与静默同源时退回原文案（不说「已 90 秒无响应，本轮已进行 90 秒」这种废话）', () => {
    assert.equal(formatLifecycleGatewayStall(95, 10).includes('本轮已进行'), false, '缺参数不得凭空造数');
    assert.equal(formatLifecycleGatewayStall(95, 10, 95).includes('本轮已进行'), false, '两数相等无信息量');
    assert.equal(formatLifecycleGatewayStall(95, 10, 99).includes('本轮已进行'), false, '差距在容差内不加噪音');
  });
});

// ---- dispose() ----
test.describe('dispose()', () => {
  test('dispose：设置 disposed/inputEnded、clearInterval、abort', () => {
    const { s } = makeSession();
    let cleared = false;
    s.idleTimer = setInterval(() => {}, 99999);
    const origClear = clearInterval;
    globalThis.clearInterval = (t) => { cleared = true; origClear(t); };
    let aborted = false;
    s.abort = { abort() { aborted = true; } };

    s.dispose();
    assert.equal(s.disposed, true);
    assert.equal(s.inputEnded, true);
    assert.equal(cleared, true);
    assert.equal(aborted, true);
    assert.equal(s.idleTimer, null);
    s.dispose();
  });

  test('dispose：resolve 所有待处理权限（permission → deny）', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.askPermission('Bash', { command: 'rm' }, { signal: ac.signal, toolUseID: 't1' });
    assert.equal(s.pendingPermissions.size, 1);
    s.dispose();
    assert.equal(s.pendingPermissions.size, 0);
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.kind === 'permission');
    assert.equal(rr.payload.outcome, 'deny');
  });

  test('dispose：resolve 所有待处理问题 + emit request_resolved + denyKinds 清理', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    assert.equal(s.pendingQuestions.size, 1);
    s.dispose();
    assert.equal(s.pendingQuestions.size, 0);
    // dispose() line ~443 先设 denyKinds.set(toolUseID,'cancelled') 再 clear()，
    // 故 dispose 后 denyKinds 为空
    assert.equal(s.denyKinds.size, 0);
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.kind === 'question');
    assert.ok(rr);
    assert.equal(rr.payload.outcome, 'aborted');
  });

  test('dispose 后再 send → disposed 守卫', async () => {
    const { s } = makeSession({ model: 'sonnet' });
    s.dispose();
    // send with same model（无 setModel await），disposed 守卫在 line ~219 拦截
    const result = await s.send('hi');
    assert.equal(result, false);
  });

  test('dispose 的 abort 抛错 → 不崩', () => {
    const { s } = makeSession();
    s.abort = { abort() { throw new Error('boom'); } };
    // 不应抛到调用方
    assert.doesNotThrow(() => s.dispose());
  });
});

// ---- checkIdle() ----
test.describe('checkIdle()', () => {
  test('pendingTurns=0 且未超空闲回收阈 → 不回收', () => {
    const { s } = makeSession({ instanceIdleReclaimMs: 60_000 });
    s.pendingTurns = 0;
    s.lastActivity = Date.now();
    s.checkIdle();
    assert.equal(s.terminating, false);
    s.dispose();
  });

  test('pendingTurns=0 且超空闲回收阈 → 回收子进程（abort + recoverable error）', () => {
    const { s, events } = makeSession({ instanceIdleReclaimMs: 1 });
    s.pendingTurns = 0;
    s.lastActivity = 0;
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.checkIdle();
    assert.equal(s.terminating, true);
    assert.equal(aborted, true);
    const err = events.find(e => e.type === 'error');
    assert.ok(err);
    assert.ok(err.payload.message.includes('空闲') || err.payload.message.includes('回收'));
    assert.equal(err.payload.recoverable, true);
    s.dispose();
  });

  // 用户正在看会话时不得空闲回收：否则 onExit reselect 会清屏，历史分块渲染的 frag 永远不落地 → 空屏。
  test('touchActivity 续期 lastActivity → 不触发空闲回收', () => {
    const { s, events } = makeSession({ instanceIdleReclaimMs: 1 });
    s.pendingTurns = 0;
    s.lastActivity = 0;
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.touchActivity();
    s.checkIdle();
    assert.equal(s.terminating, false);
    assert.equal(aborted, false);
    assert.equal(events.find(e => e.type === 'error'), undefined);
    s.dispose();
  });

  // R1（2026-08-10 真机 a90814ca）：切回会话不得给在途轮的静默看护续命。
  // 病灶是一个字段兼两职——touchActivity() 刷的 lastActivity 既当「空闲回收时钟」又当「在途轮静默时钟」。
  // 后果有二：① 挂死轮次的 idleTimeoutMs 中断保护每被切进一次就重新计时（agent.js:765 的注释早已
  // 记下这点，但没修）；② 告警里的「模型已 N 秒无响应」会跟着倒退——真机那次一条 271 秒的连续静默
  // 里先报「113 秒」、两分半后又报「90 秒」，数字比前一条还小。
  test('R1：touchActivity 不续期在途轮静默看护（切回会话不给挂死轮次续命）', () => {
    const { s } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    let interrupted = false;
    s.q = { interrupt: () => { interrupted = true; } };

    s.touchActivity();   // 用户切回本会话（server 的 user:setViewing / finishOpenFocus）
    s.checkIdle();

    assert.equal(interrupted, true, '切视图是「用户在看」，不是「模型有产出」——不得推迟挂死中断');
    s.dispose();
  });

  // 网关静默告警的出向形态过滤器（2026-08-18 重分类为 system/notice 后，各用例共用这一个判据）。
  const stallWarns = (events) => events.filter(e => e.type === 'system' && e.payload?.notice === 'gateway_stall');

  // R2c：告警分支的接线（此前只有纯函数用例，emit 那一路没人守）。
  // 2026-08-18 重分类：告警从 error 改走 system/notice——前端 error(p) 会 finalizeStreams +
  // failPendingToolCards + setBusy(false) 把在途轮当终点误杀（agent.js emitNotice 注释明文写着这条
  // 禁忌，这条告警恰是漏网者：每次告警 spinner 消失、在途工具卡被标失败、busy 闪断后靠 instances
  // 广播才拉回来）。结构化字段供通知层识别推送（tests/unit/notifications gateway_stall 组）。
  test('R2c：网关静默告警走 system/notice（不得再发 error 误杀在途轮），带结构化字段', () => {
    const { s, events } = makeSession({ idleTimeoutMs: 600_000 });
    s.pendingTurns = 1;
    s.turnStartedAt = Date.now() - 285_000; // 本轮已进行 285 秒
    s.lastActivity = Date.now() - 91_000;   // 静默锚在 91 秒前被豁免分支合法刷新过

    s.checkIdle();

    assert.equal(events.find(e => e.type === 'error'), undefined, '告警不得走 error——前端会把在途轮当终点');
    const [warn] = stallWarns(events);
    assert.ok(warn, '越过 90 秒告警线应发 system/notice 告警');
    assert.equal(warn.payload.kind, 'notice');
    assert.equal(warn.payload.level, 'warning');
    assert.match(warn.payload.message, /模型已 9[0-9] 秒无响应/);
    assert.match(warn.payload.message, /本轮已进行 28[45] 秒/, '本轮真实时长必须出现在文案里');
    assert.ok(warn.payload.seconds >= 90 && warn.payload.seconds <= 99, '静默秒数须以结构化字段透出（供推送 body）');
    assert.ok(warn.payload.turnSeconds >= 284 && warn.payload.turnSeconds <= 286, '本轮时长同为结构化字段');
    s.dispose();
  });

  // R3（2026-08-10 真机 a90814ca）：那次排障里，用户屏幕上明明有两条「模型已 N 秒无响应」，
  // 而服务端日志 `grep 秒无响应` 零命中——lifecycle error 这一路只 emit 不落盘，事后只能靠 tick
  // 相位反推。看护类判定必须自己留痕，否则下次还是只能猜。
  test('R3a：网关静默告警落会话日志（屏幕看得见，日志也查得到）', () => {
    const { s } = makeSession({ instanceId: 'r3a', idleTimeoutMs: 600_000 });
    s.pendingTurns = 1;
    s.turnStartedAt = Date.now() - 285_000;
    s.lastActivity = Date.now() - 91_000;

    s.checkIdle();

    const hit = getSessionLogs(s.logKey()).find(e => /无响应/.test(e.text || ''));
    assert.ok(hit, '告警只 emit 不落盘 → 排障时日志里查不到');
    assert.match(hit.text, /本轮已进行 28[45] 秒/, '落盘的那条要带上真实时长，不能比屏幕上的还少信息');
    s.dispose();
  });

  test('R3b：静默看护中断落会话日志（比告警更严重，此前同样不落盘）', () => {
    const { s } = makeSession({ instanceId: 'r3b', idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    s.q = { interrupt: () => {} };

    s.checkIdle();

    const hit = getSessionLogs(s.logKey()).find(e => /挂死|已中断/.test(e.text || ''));
    assert.ok(hit, '看门狗替用户按下 Esc 这件事必须可追溯');
    s.dispose();
  });

  test('R3c：静默看护豁免留痕，能指认是哪一条豁免刷新了静默锚', () => {
    const { s } = makeSession({ instanceId: 'r3c', idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    s._armSlashQuietNotice('/code-review max'); // 本地命令在途 → 走豁免分支

    s.checkIdle();

    const hit = getDiagLogs(s.logKey()).find(e => e.event === 'idle_exempt');
    assert.ok(hit, '豁免分支刷新 lastActivity 是静默秒数失真的直接来源，必须留痕');
    assert.equal(hit.detail.reason, 'local_command');
    s.dispose();
  });

  test('R3d：同一豁免持续命中只记一次（30s tick 不得把诊断缓冲刷爆）', () => {
    const { s } = makeSession({ instanceId: 'r3d', idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    s._armSlashQuietNotice('/code-review max');

    s.checkIdle();
    s.checkIdle();
    s.checkIdle();

    const hits = getDiagLogs(s.logKey()).filter(e => e.event === 'idle_exempt');
    assert.equal(hits.length, 1, '稳态豁免只记起点；原因变了才该再记一条');
    s.dispose();
  });

  // 变异检查补漏：删掉 checkIdle 里的清锚行（豁免不再命中时的 _noteIdleExemption(null)）时
  // R3c/R3d 全绿——「同一原因的第二段豁免」这条路当时无人守。真机现场恰恰是「豁免了一下又没了」，
  // 不清锚的话第二段就查不出来。
  test('R3e：豁免中断后再次命中要重新留痕', () => {
    const { s } = makeSession({ instanceId: 'r3e', idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    s.q = { interrupt: () => {} };

    s._armSlashQuietNotice('/code-review max');
    s.checkIdle();                       // 第一段豁免

    // 命令输出到手 = 豁免撤销（与 E1 那批用例同一条真实路径）
    s.map({ type: 'system', subtype: 'local_command_output', content: '<local-command-stdout>done</local-command-stdout>', session_id: 'sid-r3e' });
    s.checkIdle();                       // 走非豁免路径 → 清锚

    s._armSlashQuietNotice('/code-review max');
    s.checkIdle();                       // 第二段豁免

    const hits = getDiagLogs(s.logKey()).filter(e => e.event === 'idle_exempt');
    assert.equal(hits.length, 2, '两段独立的豁免各留一条，否则「豁免了一下又没了」事后查不出来');
    s.dispose();
  });

  test('R2d：同段静默只告一次（去重锚），锚前移后可再告', () => {
    const { s, events } = makeSession({ idleTimeoutMs: 600_000 });
    s.pendingTurns = 1;
    s.lastActivity = Date.now() - 91_000;

    s.checkIdle();
    s.checkIdle();
    assert.equal(stallWarns(events).length, 1, '同段静默重复 tick 不得刷屏');

    s.lastActivity = Date.now() - 95_000; // 锚前移 = 新静默段
    s.checkIdle();
    assert.equal(stallWarns(events).length, 2, '新静默段应能再告一次');
    s.dispose();
  });

  test('setViewed(true) → 当前查看实例不走空闲回收（即使用户长时间只读历史）', () => {
    const { s, events } = makeSession({ instanceIdleReclaimMs: 1 });
    s.pendingTurns = 0;
    s.lastActivity = 0;
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.setViewed(true);
    // 模拟用户读了很久：lastActivity 再变旧
    s.lastActivity = 0;
    s.checkIdle();
    assert.equal(s.terminating, false);
    assert.equal(aborted, false);
    assert.equal(events.find(e => e.type === 'error'), undefined);
    // 切走后可回收
    s.setViewed(false);
    s.lastActivity = 0;
    s.checkIdle();
    assert.equal(s.terminating, true);
    assert.equal(aborted, true);
    s.dispose();
  });

  // 本地 slash 命令在途豁免（agent.js#_localCommandInFlight）。
  // 病灶：/code-review 这类本地命令由 CLI 在自己进程里跑，不产 task_progress、主链也没有 tool_use
  // （2026-08-03 那批真机会话主链 assistant 条数 = 0），既有两条豁免一条都不满足 ⇒ SDK 流全空、
  // lastActivity 不刷新 ⇒ 600s 到点 interrupt() 掐掉一个正在正常干活的命令。实测超线 788s/1076s/1869s。
  test('本地 slash 命令在途 → 静默超限也不中断（既有两条豁免都不满足它）', () => {
    const { s, events } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    assert.equal(s.hasBgTasks(), false, '前提：本地命令不产 task_progress');
    assert.equal(s.hasRunningForegroundTool(), false, '前提：主链没有 tool_use');
    let interrupted = false;
    s.q = { interrupt: () => { interrupted = true; } };

    s._armSlashQuietNotice('/code-review max');   // 与 send() 同一置位点
    s.checkIdle();

    assert.equal(interrupted, false, '本地命令在途不得被静默看门狗掐掉');
    assert.equal(events.find(e => e.type === 'error'), undefined);
    assert.equal(stallWarns(events).length, 0, '豁免期也不得发静默告警');
    s.dispose();
  });

  test('普通消息（非 slash）不获豁免 —— 证明上条不是恒真断言', () => {
    const { s } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    let interrupted = false;
    s.q = { interrupt: () => { interrupted = true; } };

    s._armSlashQuietNotice('帮我看下这段代码');    // 不是 slash → 不置位
    s.checkIdle();

    assert.equal(interrupted, true, '普通消息静默挂死仍须走原中断路径');
    s.dispose();
  });

  test('豁免有上限：超 SLASH_LOCAL_COMMAND_GRACE_MS 后回到中断路径（不把误杀换成永挂）', () => {
    const { s } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    let interrupted = false;
    s.q = { interrupt: () => { interrupted = true; } };

    s._armSlashQuietNotice('/code-review max');
    s._slashCommandStartedAt = Date.now() - (46 * 60_000); // 越过 45 分钟上限
    s.checkIdle();

    assert.equal(interrupted, true, '超上限须按挂死处理');
    s.dispose();
  });

  test('命令输出到达即撤豁免（下一轮静默按常规判）', () => {
    const { s } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s._armSlashQuietNotice('/code-review');
    assert.equal(s._localCommandInFlight(), true);

    s.map({ type: 'system', subtype: 'local_command_output', content: '<local-command-stdout>done</local-command-stdout>', session_id: 'sid-lc' });
    assert.equal(s._localCommandInFlight(), false, '输出到手 = 命令跑完，豁免须撤');
    s.dispose();
  });

  test('回合 result 收尾也撤豁免（命令被中断/出错、没有输出的那条路径）', () => {
    const { s } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s._armSlashQuietNotice('/code-review');
    assert.equal(s._localCommandInFlight(), true);

    s.map({ type: 'result', subtype: 'success', session_id: 'sid-r', usage: {}, total_cost_usd: 0 });
    assert.equal(s._localCommandInFlight(), false, 'result 后不得残留豁免');
    s.dispose();
  });

  // E1 回归（2026-08-05 真机 /code-review 自查抓出）：③ 的磁盘任务把 ② 的 45 分钟上限打穿。
  // checkIdle 的豁免是 `hasBgTasks() || … || _localCommandInFlight()`——扫出子代理后 hasBgTasks()
  // 恒真，于是 _localCommandInFlight() 到期返回 false 也没用，豁免照旧；而轮询已停、任务不再刷新
  // 也不被清，要等 BG_TASK_LIFECYCLE_TTL_MS（2h）才 sweep 掉。等于把「误杀」换成了注释里说要避免的「永挂」。
  test('E1：扫出的 localcmd 任务不得让 45 分钟上限失效', async () => {
    const { s } = makeSession({ cwd: LOCALCMD_CWD, transcriptBaseDir: LOCALCMD_BASE, idleTimeoutMs: 1 });
    s.sessionId = 'sid-e1';
    s.pendingTurns = 1;
    s._armSlashQuietNotice('/code-review max');
    await s._pollLocalCommandProgress();
    assert.equal(s.hasBgTasks(), true, '前提：磁盘扫出了子代理任务');

    s._slashCommandStartedAt = Date.now() - 46 * 60_000; // 越过上限
    s.lastActivity = 0;
    let interrupted = false;
    s.q = { interrupt: () => { interrupted = true; } };
    s.checkIdle();

    assert.equal(interrupted, true, '超 45 分钟上限后必须回到中断路径，不得被自家磁盘任务续命');
    s.dispose();
  });

  test('E6：上限到期时一并清掉 localcmd 任务（否则面板永远挂着「运行中」）', async () => {
    const { s } = makeSession({ cwd: LOCALCMD_CWD, transcriptBaseDir: LOCALCMD_BASE, idleTimeoutMs: 1 });
    s.sessionId = 'sid-e1';
    s.pendingTurns = 1;
    s.q = { interrupt: () => {} };
    s._armSlashQuietNotice('/code-review max');
    await s._pollLocalCommandProgress();
    s._slashCommandStartedAt = Date.now() - 46 * 60_000;
    s.lastActivity = 0;
    s.checkIdle();
    assert.equal(s.hasBgTasks(), false, '命令已按挂死处理，磁盘观察出来的任务不该还在');
    s.dispose();
  });

  // #1 回归（2026-08-05 第二轮 review）：interrupt 的两条【强制收口】路径（settle 看门狗、
  // settleForce）只清 pendingTurns，不碰 localcmd 状态机。而 _clearLocalCommandProgress 的注释
  // 自称「命令收尾的唯一收口」——它只挂在 happy path（result / local_command_output / dispose /
  // 下次 slash）上。用户点停止后 SDK 常无配对 result，于是 grace + 3s 轮询 + localcmd 键全都还活着：
  // 面板一直「运行中」、isBusy 拦住 dispose/effort 置换，直到 45min grace 到期。
  test('#1：点停止后 settle 看门狗须一并收口 localcmd 状态机', async () => {
    const { s } = makeSession({ cwd: LOCALCMD_CWD, transcriptBaseDir: LOCALCMD_BASE });
    s.interruptSettleGraceMs = 20; // 构造参数接不进来（agent.js:310 读的是自身字段），构造后直接设
    s.sessionId = 'sid-e1';
    s.pendingTurns = 1;
    s._awaitingInterruptResult = true;
    s._armSlashQuietNotice('/code-review max');
    await s._pollLocalCommandProgress();
    assert.equal(s.hasBgTasks(), true, '前提：已扫出 localcmd 任务');

    s._armInterruptSettleWatchdog();
    await new Promise(r => setTimeout(r, 60)); // 等看门狗开火

    assert.equal(s.pendingTurns, 0, '前提：看门狗确实清了账');
    assert.equal(s.hasBgTasks(), false, '停止后面板不该还挂着「运行中」');
    assert.equal(s._localCommandInFlight(), false, 'grace 须一并撤，否则 isBusy 拦住 dispose/effort');
    s.dispose();
  });

  // #3 回归：init 换会话（/clear 等）只 bgTasks.clear()，不清在途标记/轮询表/_localCmdTaskIds。
  // 结果：清了 map 但 grace 与 timer 仍活 → 下一拍 poll 用【新】sessionId 扫盘再 upsert；
  // 而 _localCmdTaskIds 里还是旧键，收尾时 bgTaskDone 旧键是 no-op。
  test('#3：init 换 sessionId 须收口 localcmd 状态机', async () => {
    const { s } = makeSession({ cwd: LOCALCMD_CWD, transcriptBaseDir: LOCALCMD_BASE });
    s.sessionId = 'sid-e1';
    s.pendingTurns = 1;
    s._armSlashQuietNotice('/code-review max');
    await s._pollLocalCommandProgress();
    assert.equal(s._localCmdTaskIds.size, 1);

    s.map({ type: 'system', subtype: 'init', session_id: 'sid-brand-new', model: 'm', cwd: LOCALCMD_CWD });

    assert.equal(s._localCommandInFlight(), false, '换会话后旧命令的 grace 不该继续');
    assert.equal(s._localCmdProgressTimer, null, '轮询表须停，否则下一拍用新 sessionId 扫盘复活');
    assert.equal(s._localCmdTaskIds.size, 0, '旧键须清空，否则收尾 bgTaskDone 全是 no-op');
    s.dispose();
  });

  // #8 回归：localcmd 与 __notask_ 同属「磁盘/合成、无完成信号」一类，却走真任务的 2h TTL。
  // 万一某条收口路径漏清（#1/#3 就是），⏳ 与 isBusy 会比 3min 孤儿策略挂久得多。
  test('#8：localcmd 键走孤儿短 TTL，不占真任务的 2h', () => {
    const { s } = makeSession();
    s.bgTaskUpsert('localcmd:aorphan', 'local_agent', 'x');
    s.bgTaskUpsert('sdk-real', 'workflow', 'y');
    // 拨到 5 分钟前：超过孤儿 TTL(3min)、远未到真任务 TTL(2h)
    for (const t of s.bgTasks.values()) t.lastSeenAt = Date.now() - 5 * 60_000;
    s.sweepBgTasks();
    const ids = s.bgTasksList().map(x => x.taskId);
    assert.ok(!ids.includes('localcmd:aorphan'), 'localcmd 漏清时须由短 TTL 兜底');
    assert.ok(ids.includes('sdk-real'), '真 SDK 任务仍走 2h，不被误清');
    s.dispose();
  });

  test('instanceIdleReclaimMs=0 → 禁用空闲回收', () => {
    const { s, events } = makeSession({ instanceIdleReclaimMs: 0 });
    s.pendingTurns = 0;
    s.lastActivity = 0;
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.checkIdle();
    assert.equal(s.terminating, false);
    assert.equal(aborted, false);
    assert.equal(events.find(e => e.type === 'error'), undefined);
    s.dispose();
  });

  test('有后台任务 isBusy → 不走空闲回收', () => {
    const { s } = makeSession({ instanceIdleReclaimMs: 1 });
    s.pendingTurns = 0;
    s.lastActivity = 0;
    s.bgTasks.set('bg1', { taskType: 'local_agent', message: '跑', lastSeenAt: Date.now() });
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.checkIdle();
    assert.equal(s.terminating, false);
    assert.equal(aborted, false);
    s.bgTasks.clear();
    s.dispose();
  });

  test('pendingPermissions 非空 → lastActivity 刷新，不触发超时', () => {
    const { s } = makeSession({ idleTimeoutMs: 1, instanceIdleReclaimMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0; // 很久以前
    // 模拟合法 pending 条目（含 resolve，防 dispose 报错）
    s.pendingPermissions.set('x', { resolve() {}, signal: null, abortHandler: null, suggestions: null, input: null });
    s.checkIdle();
    assert.ok(s.lastActivity > 0); // 刷新为当前时间
    assert.equal(s.terminating, false);
    // 手动清理（不走 dispose 的 resolvePermission 完整路径）
    s.pendingPermissions.clear();
    s.dispose();
  });

  test('pendingQuestions 非空 → lastActivity 刷新', () => {
    const { s } = makeSession({ idleTimeoutMs: 1, instanceIdleReclaimMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    // 模拟合法 pending 条目（含 questions 数组 + resolve，防 dispose 报错）
    s.pendingQuestions.set('x', { questions: [], resolve() {}, signal: null, abortHandler: null });
    s.checkIdle();
    assert.ok(s.lastActivity > 0);
    s.pendingQuestions.clear();
    s.dispose();
  });

  // CLI 等价性：CLI 里请求挂死只是报错停在原地（Esc 中断本轮），绝不自杀会话。看门狗超时
  // 应等价于替用户按 Esc——走 interrupt() 中断在途轮，实例存活可原地重发，兑现
  // formatLifecycleIdleTimeout 文案里的「可重新发送继续」（旧行为直接 abort 杀实例 →
  // onExit → 实例被删 → 前端「会话已中断」死路页，与文案自相矛盾）。
  test('在途轮静默超时 + SDK 可中断 → 自动中断本轮但实例存活（不 abort 不 terminating）', async () => {
    const { s, events } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    let interruptCalls = 0;
    s.q = { interrupt: async () => { interruptCalls++; } };
    s.checkIdle();
    await new Promise(r => setTimeout(r, 20)); // interrupt() 异步收尾
    assert.equal(interruptCalls, 1, '应走 q.interrupt() 而非直接 abort');
    assert.equal(s.terminating, false, '中断成功不得置 terminating');
    assert.equal(aborted, false, '中断成功不得 abort 子进程');
    const err = events.find(e => e.type === 'error');
    assert.ok(err);
    assert.ok(err.payload.message.includes('未收到 Claude 的任何消息'), '仍须发 idle 超时说明（用户可见原因）');
    assert.equal(err.payload.recoverable, true);
    const sys = events.find(e => e.type === 'system' && e.payload.kind === 'interrupted');
    assert.ok(sys, '应发「已中断」（等价用户按 Esc）');
    assert.ok(s.lastActivity > 0, '触发后须刷新 lastActivity，防 30s tick 在中断未决期间重复触发');
    s.dispose();
  });

  test('在途轮静默超时 + interrupt 被拒 → settleForce 兜底（terminating + abort + 账面收口）', async () => {
    const { s, events } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.q = { interrupt: async () => { throw new Error('control lost'); } };
    s.checkIdle();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(s.terminating, true, '控制通道失败 → 保留原强杀兜底');
    assert.equal(aborted, true);
    assert.equal(s.pendingTurns, 0, 'settleForce 应收口在途轮账面');
    const sys = events.find(e => e.type === 'system' && e.payload.kind === 'interrupted');
    assert.ok(sys);
    s.dispose();
  });

  // SDK 不可达（q 缺失/无 interrupt 方法，如启动早期或已半死）：无法「按 Esc」，
  // 保留直接强杀——否则 q.interrupt?.() 返回 undefined 会被当成功，僵尸实例永不清理。
  test('在途轮静默超时 + SDK 不可达（无 q.interrupt）→ 兜底 abort 强杀', () => {
    const { s, events } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.checkIdle();
    assert.equal(s.terminating, true);
    assert.equal(aborted, true);
    const err = events.find(e => e.type === 'error');
    assert.ok(err);
    assert.ok(err.payload.message.includes('未收到 Claude 的任何消息'));
    assert.equal(err.payload.recoverable, true);
    s.dispose();
  });

  // A. 网关挂起早期告警（2026-07-28 真机 b06fb05d 前情）：web 消息进 SDK 后第三方网关零响应，
  // 到 idleTimeoutMs（默认 10 分钟）中断前用户全程零反馈——真机用户等 3 分钟就被逼去终端接手了。
  // 早期告警只提示不中断：在途轮静默超 90s 即 emit 可见告警；同段静默只告一次，新静默段可再告。
  test('在途轮静默超 90s（未到中断阈值）→ 发一次网关无响应告警且不中断；同段静默不重复，新静默段可再告', () => {
    const { s, events } = makeSession({ idleTimeoutMs: 600_000 });
    s.pendingTurns = 1;
    s.lastActivity = Date.now() - 100_000; // 100s 静默：过告警线、远未到 10 分钟
    s.checkIdle();
    assert.equal(s.terminating, false, '只告警不中断');
    const warns = () => stallWarns(events);
    assert.equal(warns().length, 1);
    assert.equal(warns()[0].payload.level, 'warning');
    s.checkIdle(); // 同段静默再 tick → 不刷屏
    assert.equal(warns().length, 1, '同段静默只告一次');
    s.lastActivity = Date.now() - 95_000; // 有过新消息后再次挂起 → 新静默段
    s.checkIdle();
    assert.equal(warns().length, 2, '新静默段可再告');
    s.dispose();
  });
  test('在途轮静默未到 90s → 不告警；idleTimeoutMs 配得比告警线还短 → 只走既有中断不叠告警', () => {
    const fresh = makeSession({ idleTimeoutMs: 600_000 });
    fresh.s.pendingTurns = 1;
    fresh.s.lastActivity = Date.now() - 30_000;
    fresh.s.checkIdle();
    assert.equal(stallWarns(fresh.events).length, 0, '30s 静默不告警');
    fresh.s.dispose();
    const tight = makeSession({ idleTimeoutMs: 1 }); // 中断阈值 < 告警线
    tight.s.pendingTurns = 1;
    tight.s.lastActivity = Date.now() - 100_000;
    tight.s.abort = { abort() {} };
    tight.s.checkIdle();
    const errs = tight.events.filter(e => e.type === 'error');
    assert.equal(errs.length, 1, '只有中断文案');
    assert.match(errs[0].payload.message, /未收到 Claude 的任何消息/);
    assert.equal(stallWarns(tight.events).length, 0, '无叠加告警');
    tight.s.dispose();
  });

  // 多子代理 / workflow 并行：主流通可长时间零消息，但 bgTasks 仍有心跳。
  // 旧行为只看 lastActivity，会在 10 分钟把整轮误杀（用户见 idle 零消息中断文案）。
  test('在途轮 + 活的后台任务 → 不静默中断，并刷新 lastActivity', () => {
    const { s, events } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0; // 远古静默
    s.bgTasks.set('bg1', { taskType: 'local_agent', message: '子代理跑', lastSeenAt: Date.now() });
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.checkIdle();
    assert.equal(s.terminating, false, '有活 bgTasks 时不得 idleTimeout 误杀');
    assert.equal(aborted, false);
    assert.ok(s.lastActivity > 0, '应刷新 lastActivity，等同「仍有活动」');
    assert.equal(events.find(e => e.type === 'error'), undefined);
    assert.equal(stallWarns(events).length, 0, '豁免期也不得发静默告警');
    s.bgTasks.clear();
    s.dispose();
  });

  test('在途轮 + 后台任务已 TTL 清掉 → 仍按静默超时中断', () => {
    const { s, events } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    // 过期孤儿（合成键，3min 短 TTL）：checkIdle 先 sweep，hasBgTasks 变 false，应走静默中断。
    // 真实 task_id 走 2h 长兜底，不能再用 3min 模拟「已死」——见 agent.js BG_TASK_ORPHAN_TTL_MS。
    s.bgTasks.set('__notask_stale', {
      taskType: 'local_agent',
      message: '已死',
      lastSeenAt: Date.now() - 180_000 - 1,
    });
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.checkIdle();
    assert.equal(s.hasBgTasks(), false, '过期孤儿 bg 应被 sweep');
    assert.equal(s.terminating, true);
    assert.equal(aborted, true);
    const err = events.find(e => e.type === 'error');
    assert.ok(err);
    assert.ok(err.payload.message.includes('未收到 Claude 的任何消息'));
    s.dispose();
  });

  // B. 前台长跑工具豁免（2026-07-30 排查真机会话 0f82d2e7）：前台 Bash 跑 E2E/测试期间，
  // tool_use 发出到 tool_result 回来之间 SDK 流零消息 → lastActivity 冻结 → 90s 后误告
  // 「模型网关无响应」（该会话一小时内 6 次，全是 playwright/单测；等模型方向从没超过 60s）。
  // 更严重：前台 Bash 硬超时 600s ≈ idleTimeoutMs 600s，30s tick 相位一偏就会误中断好好的一轮。
  // 豁免口径与 bgTasks 一致（刷新 lastActivity 后 return），但设独立上限防工具真挂死后永失保护。
  const toolUseMsg = (id, name = 'Bash') => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input: { command: 'npm run test:e2e' } }] },
  });
  const toolResultMsg = (id) => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
  });

  test('在途轮 + 前台工具在途 → 不告警不中断，并刷新 lastActivity', () => {
    const { s, events } = makeSession({ idleTimeoutMs: 600_000 });
    s.pendingTurns = 1;
    s.map(toolUseMsg('tu1'));
    assert.equal(s.hasRunningForegroundTool(), true, 'tool_use 后应记为在途前台工具');
    s.lastActivity = Date.now() - 100_000; // map 不刷 lastActivity（那是 consume 的活）：造 100s 静默
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.checkIdle();
    assert.equal(s.terminating, false, '前台工具在跑不得中断');
    assert.equal(aborted, false);
    assert.ok(s.lastActivity > Date.now() - 1000, '应刷新 lastActivity，等同「仍有活动」');
    assert.equal(events.find(e => e.type === 'error'), undefined);
    assert.equal(stallWarns(events).length, 0, '不得发网关无响应告警');
    s.dispose();
  });

  test('前台工具 tool_result 已回 → 豁免解除，恢复静默告警', () => {
    const { s, events } = makeSession({ idleTimeoutMs: 600_000 });
    s.pendingTurns = 1;
    s.map(toolUseMsg('tu1'));
    s.map(toolResultMsg('tu1'));
    assert.equal(s.hasRunningForegroundTool(), false, 'tool_result 到达应销账');
    s.lastActivity = Date.now() - 100_000;
    s.checkIdle();
    assert.equal(stallWarns(events).length, 1, '工具已回、真在等模型 → 该告警');
    s.dispose();
  });

  test('前台工具在途超 15 分钟上限 → 不再豁免（防真挂死后永失保护）', () => {
    const { s, events } = makeSession({ idleTimeoutMs: 600_000 });
    s.pendingTurns = 1;
    s.map(toolUseMsg('tu1'));
    s.pendingToolUses.set('tu1', Date.now() - 900_000 - 1); // 越过 15min 上限
    assert.equal(s.hasRunningForegroundTool(), false, '超上限的在途工具不再算「在干活」');
    s.lastActivity = Date.now() - 100_000;
    s.checkIdle();
    assert.equal(stallWarns(events).length, 1, '超上限后恢复告警');
    s.dispose();
  });

  test('多工具并行：只要还有一个未超上限就仍豁免', () => {
    const { s } = makeSession({ idleTimeoutMs: 600_000 });
    s.pendingTurns = 1;
    s.map(toolUseMsg('old'));
    s.map(toolUseMsg('fresh'));
    s.pendingToolUses.set('old', Date.now() - 900_000 - 1);
    assert.equal(s.hasRunningForegroundTool(), true, '新工具仍在跑 → 继续豁免');
    s.dispose();
  });

  // 工具被中断/审批取消时 tool_result 可能永不回来 → 在途集合会残留并永久豁免看护。
  // result（本轮收尾）是权威边界：工具不可能跨轮存活。
  test('result 到达 → 清空在途前台工具集合（防残留永久豁免）', () => {
    const { s } = makeSession({ idleTimeoutMs: 600_000 });
    s.pendingTurns = 1;
    s.map(toolUseMsg('tu1'));
    s.map({ type: 'result', subtype: 'success', duration_ms: 1, is_error: false });
    assert.equal(s.hasRunningForegroundTool(), false, '轮次收尾必须清账');
    s.dispose();
  });

  // /clear 等换会话：与同处的 bgTasks.clear() 同理由——旧会话的在途工具账不得串到新会话，
  // 否则新会话首轮会被无依据地豁免看护（result 通常会先清，但换会话不保证走到 result）。
  test('换会话 → 清空在途前台工具集合（旧会话的账不串新会话）', () => {
    const { s } = makeSession({ idleTimeoutMs: 600_000 });
    s.pendingTurns = 1;
    s.sessionId = 'old-session';
    s.map(toolUseMsg('tu1'));
    s.map({ type: 'system', subtype: 'init', session_id: 'new-session' });
    assert.equal(s.hasRunningForegroundTool(), false, '换会话须清账');
    s.dispose();
  });

  // 子 agent（Task 内部）工具不单独记账：父 Task 的 tool_use 已在主分支占位，
  // 重复记账会让子 agent 的 tool_result 提前把父级销掉。
  test('子 agent 内部工具不进在途集合', () => {
    const { s } = makeSession({ idleTimeoutMs: 600_000 });
    s.pendingTurns = 1;
    s.map({
      type: 'assistant',
      parent_tool_use_id: 'parent-task',
      message: { content: [{ type: 'tool_use', id: 'child1', name: 'Read', input: {} }] },
    });
    assert.equal(s.pendingToolUses.has('child1'), false);
    s.dispose();
  });
});

// ---- consume() 退出路径 ----
test.describe('consume() 退出路径', () => {
  test('正常结束 + sawInit 已到 + 无 resumeId → emit error(进程已退出) + onExit', async () => {
    let exited = false;
    const { s, events } = makeSession({ onExit() { exited = true; } });
    s.sawInit = true;
    s.resumeId = null;

    // 模拟一个立即可迭代完的 async iterator
    const fakeQ = {
      [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ done: true }); } }; }
    };
    await s.consume(fakeQ);

    assert.equal(exited, true);
    const err = events.find(e => e.type === 'error' && e.payload.message.includes('进程已退出'));
    assert.ok(err);
    s.dispose();
  });

  test('正常结束 + sawInit 未到 + resumeId 存在 → resumeFailed + emit error(recoverable:false) + onExit', async () => {
    let exited = false;
    const { s, events } = makeSession({ resumeId: 'bad-id', onExit() { exited = true; } });
    s.sawInit = false;

    const fakeQ = {
      [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ done: true }); } }; }
    };
    await s.consume(fakeQ);

    assert.equal(s.resumeFailed, true);
    assert.equal(exited, true);
    const err = events.find(e => e.type === 'error' && !e.payload.recoverable);
    assert.ok(err);
    assert.ok(err.payload.message.includes('无法恢复会话'));
    s.dispose();
  });

  test('resume 失败且 stream throw → 文案附 caught 原因，仍 resumeFailed + recoverable:false', async () => {
    let exited = false;
    const { s, events } = makeSession({ resumeId: 'bad-id', onExit() { exited = true; } });
    s.sawInit = false;

    const fakeQ = {
      [Symbol.asyncIterator]() {
        return {
          next() { return Promise.reject(new Error('process exited with code 1')); }
        };
      }
    };
    await s.consume(fakeQ);

    assert.equal(s.resumeFailed, true);
    assert.equal(exited, true);
    const err = events.find(e => e.type === 'error' && !e.payload.recoverable);
    assert.ok(err);
    assert.ok(err.payload.message.includes('无法恢复会话'));
    assert.ok(err.payload.message.includes('process exited with code 1'));
    s.dispose();
  });

  test('resume 撞 background agent 锁 → 文案含后台 agent，不含「历史被清理」', async () => {
    let exited = false;
    const { s, events } = makeSession({ resumeId: 'bg-locked', onExit() { exited = true; } });
    s.sawInit = false;
    const fakeQ = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return Promise.reject(new Error(
              'Session bg-locked is currently running as a background agent (bg). Use claude agents…',
            ));
          },
        };
      },
    };
    await s.consume(fakeQ);
    assert.equal(s.resumeFailed, true);
    assert.equal(exited, true);
    const err = events.find(e => e.type === 'error' && !e.payload.recoverable);
    assert.ok(err);
    assert.match(err.payload.message, /后台 agent/);
    assert.doesNotMatch(err.payload.message, /历史可能已被清理/);
    s.dispose();
  });

  // ↑ 那条用例喂的是「错误 message 里带 CLI 原文」的理想形态，而装机的 SDK 0.3.201 不产出这种形态：
  // 它的 getProcessExitError 只会造 `Claude Code process exited with code N`（上游 0.3.211 才把 stderr
  // 拼进去）。CLI 真正把 background agent 独占的原因写在 **stderr**，SDK 0.3.201 已经会把 stderr 原样
  // 转给 options.stderr（实测 stdio[2]='pipe' + stderr.on('data') → options.stderr(chunk)）。
  // 所以判据只能是「我们自己接住 stderr」——这条不依赖 SDK 版本，升级与否都成立。
  test('resume 撞 background agent 锁：原因只在 stderr、SDK 错误仅含 exit code → 文案仍指向后台 agent', async () => {
    const { s, events } = makeSession({ resumeId: 'bg-locked' });
    s.sawInit = false;
    buildAgentQueryOptions(s).stderr(
      'Error: Session bg-locked is currently running as a background agent (bg).\n'
      + 'Use `claude agents` to find and attach to it, or add --fork-session to branch off a copy.\n',
    );
    const fakeQ = {
      [Symbol.asyncIterator]() {
        return { next() { return Promise.reject(new Error('Claude Code process exited with code 1')); } };
      },
    };
    await s.consume(fakeQ);
    assert.equal(s.resumeFailed, true);
    const err = events.find(e => e.type === 'error' && !e.payload.recoverable);
    assert.ok(err);
    assert.match(err.payload.message, /后台 agent/);
    assert.doesNotMatch(err.payload.message, /CLI 未完成初始化/);
    s.dispose();
  });

  test('异常结束 → caught 路径 emit error(recoverable:true) + onExit', async () => {
    let exited = false;
    const { s, events } = makeSession({ onExit() { exited = true; } });
    s.sawInit = true;

    const fakeQ = {
      [Symbol.asyncIterator]() {
        return {
          next() { return Promise.reject(new Error('process exited with code 1')); }
        };
      }
    };
    await s.consume(fakeQ);

    assert.equal(exited, true);
    const err = events.find(e => e.type === 'error' && e.payload.recoverable === true);
    assert.ok(err);
    assert.ok(err.payload.message.includes('进程异常'));
    s.dispose();
  });

  test('terminating=true → 跳过 error emit 但不跳过 onExit', async () => {
    let exited = false;
    const { s, events } = makeSession({ onExit() { exited = true; } });
    s.terminating = true;

    const fakeQ = {
      [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ done: true }); } }; }
    };
    const countBefore = events.length;
    await s.consume(fakeQ);

    // onExit 在 `if (!this.disposed)` 块中（line ~188），不受 terminating 影响
    assert.equal(exited, true);
    // 但 error emit 在 `if (!this.disposed && !this.terminating)` 中被跳过
    assert.equal(events.length, countBefore);
    s.dispose();
  });

  test('disposed=true → 不调 onExit', async () => {
    let exited = false;
    const { s } = makeSession({ onExit() { exited = true; } });
    s.disposed = true;

    const fakeQ = {
      [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ done: true }); } }; }
    };
    await s.consume(fakeQ);

    assert.equal(exited, false);
    s.dispose();
  });

  test('consume 清理：pendingTurns 清零、denyKinds clear、pendingPermissions 全部 deny', async () => {
    const { s } = makeSession();
    const ac = new AbortController();
    s.pendingTurns = 3;
    s.askPermission('Read', { file_path: '/a' }, { signal: ac.signal, toolUseID: 't1' });
    s.denyKinds.set('old', 'denied');

    const fakeQ = {
      [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ done: true }); } }; }
    };
    await s.consume(fakeQ);

    assert.equal(s.pendingTurns, 0);
    assert.equal(s.pendingPermissions.size, 0);
    assert.equal(s.denyKinds.size, 0);
    s.dispose();
  });
});

// ---- lastActivity 刷新（修复验证）----
test.describe('lastActivity 刷新', () => {
  test('send() 后 lastActivity 更新为当前时间', () => {
    const { s } = makeSession();
    const before = Date.now() - 10000;
    s.lastActivity = before;
    s.send('hi');
    assert.ok(s.lastActivity > before);
    s.dispose();
  });

  test('resolvePermission() 后 lastActivity 刷新', () => {
    const { s } = makeSession();
    const ac = new AbortController();
    s.askPermission('Read', { file_path: '/a' }, { signal: ac.signal, toolUseID: 't1' });
    s.lastActivity = 0;
    s.resolvePermission('t1', 'allow');
    assert.ok(s.lastActivity > 0);
    s.dispose();
  });
});

// ---- pendingRequestsSnapshot()：切入(sync:since)时重建待审批/提问卡片的权威快照 ----
// 修「角标 ⚠️ 待审批但会话内无卡片」：原始 permission_request/question 事件可能被环形缓冲 trim
// 或切视图时被前端分流丢弃，pendingPermissions/pendingQuestions 才是权威真相。payload 必须与
// askPermission 的 emit('permission_request')、handleQuestion 的 emit('question') 逐字段一致。
test.describe('pendingRequestsSnapshot()', () => {
  test('全空 → { permissions:[], questions:[] }', () => {
    const { s } = makeSession();
    assert.deepEqual(s.pendingRequestsSnapshot(), { permissions: [], questions: [] });
  });

  test('permission：requestId/name/input/cwd/fp/createdAt/expiresAt 与 emit(permission_request) 一致', () => {
    const { s } = makeSession({ cwd: '/tmp/proj' });
    // fp/createdAt/expiresAt：真实 pendingPermissions 条目总由 askPermission 写入（NFR-17 完整性绑定
    // + FR-22 悬置时长/TTL），此处手造数据代表真实形态，断言快照原样透传（而非只透传 name/input）。
    s.pendingPermissions.set('req_1', { name: 'Bash', input: { command: 'ls -la' }, resolve() {}, fp: 'abc123', createdAt: 1000, expiresAt: 2000 });
    const snap = s.pendingRequestsSnapshot();
    assert.deepEqual(snap.permissions, [{ requestId: 'req_1', name: 'Bash', input: { command: 'ls -la' }, cwd: '/tmp/proj', fp: 'abc123', createdAt: 1000, expiresAt: 2000 }]);
    assert.deepEqual(snap.questions, []);
  });

  test('question：仅补发未答项（answers[i]===null），options 归一为 {label,...} 对象', () => {
    const { s } = makeSession();
    s.pendingQuestions.set('tool_1', {
      questions: [
        { question: 'Q0?', options: ['A', 'B'] },
        { question: 'Q1?', options: [{ label: 'X' }, { label: 'Y' }] }, // 已答 → 不补发
      ],
      answers: [null, 'X'],
      resolve() {},
      createdAt: 111,
      expiresAt: 222,
    });
    const snap = s.pendingRequestsSnapshot();
    // 对齐 CLI rich options：字符串选项也会归一成 {label}；multiSelect 缺省 false
    // AG-NEW-001：createdAt/expiresAt 与 live emit('question') 对称
    assert.deepEqual(snap.questions, [{
      requestId: 'tool_1#0', text: 'Q0?', header: undefined, multiSelect: false,
      options: [{ label: 'A' }, { label: 'B' }],
      createdAt: 111, expiresAt: 222,
    }]);
    assert.deepEqual(snap.permissions, []);
  });

  test('permission + question 并存', () => {
    const { s } = makeSession({ cwd: '/w' });
    s.pendingPermissions.set('p1', { name: 'Write', input: { path: 'a.txt' }, resolve() {} });
    s.pendingQuestions.set('t1', { questions: [{ question: 'pick?', options: ['one'] }], answers: [null], resolve() {} });
    const snap = s.pendingRequestsSnapshot();
    assert.equal(snap.permissions.length, 1);
    assert.equal(snap.questions.length, 1);
    assert.equal(snap.questions[0].requestId, 't1#0');
  });
});

// ---- 退出路径的清理对称性（R3/R4，2026-08-06 BUG hunting review）----
test.describe('退出路径清理对称性', () => {
  // R3：consume() 自然退出（CLI 进程自己结束 / checkIdle 空闲回收 abort / settleForce abort）没有清
  // _slashQuietTimer 与 delta 攒批表，而 emit() 无 disposed 守卫——到点仍会推一条挂着已消失
  // instanceId 的事件（server 照常 io.to('approved').emit）。dispose() 三个都清了，两条路径必须对称。
  test('R3：consume 自然退出必须与 dispose 一样清掉 slash 静默表与 delta 攒批表', async () => {
    const { s, events } = makeSession({ slashQuietNoticeMs: 20 });
    s.sawInit = true;
    s.resumeId = null;
    s.q = { setModel() { return Promise.resolve(); } };
    // 起一个 slash 静默提示表 + 一个文本攒批表（两者都是 setTimeout，到点会 emit）
    assert.equal(await s.send('/code-review'), true);
    assert.notEqual(s._slashQuietTimer, null, '前置：slash 静默表已武装');
    s._textBuf = 'partial';
    s._textTimer = setTimeout(() => s._flushText(), 20);

    const fakeQ = { [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ done: true }); } }; } };
    await s.consume(fakeQ);
    assert.equal(s.disposed, true, '前置：自然退出已标 disposed');

    assert.equal(s._slashQuietTimer, null, 'slash 静默表必须随退出清掉');
    assert.equal(s._textTimer, null, 'delta 攒批表必须随退出清掉');

    const before = events.length;
    await new Promise(r => setTimeout(r, 60));
    assert.equal(events.length, before, '实例已终，不得再往它身上 emit（挂着已消失 instanceId 的事件）');
  });

  // R4：dispose() 清 queue 时不发 queue_dropped，而 interrupt() 发。send() 返回 true 后消息可能仍在
  // this.queue（SDK 输入泵尚未取走，如 CLI 启动中 notifyInput 还是 null），此时 session:close 等路径
  // dispose 会静默丢弃；而 app.js 已 commitProcessed 去重 ID、客户端已收 ok:true 删掉 pending 气泡，
  // 同 clientMessageId 重发会命中 isProcessed 被当成功——消息永久消失且无任何痕迹。
  test('R4：dispose 丢弃未送达队列时必须发 queue_dropped，与 interrupt 对称', async () => {
    const { s, events } = makeSession();
    s.q = { setModel() { return Promise.resolve(); } };
    // notifyInput 为 null = 输入泵尚未开始等待（CLI 启动中），消息停在 queue 里
    assert.equal(s.notifyInput, null, '前置：输入泵未在等待');
    assert.equal(await s.send('未送达就被关掉', null, { clientMessageId: 'cm-lost-1' }), true);
    assert.equal(s.queue.length, 1, '前置：消息仍在队列、尚未送达 SDK');

    s.dispose();

    const dropped = events.filter(e => e.type === 'system' && e.payload?.kind === 'queue_dropped');
    assert.equal(dropped.length, 1, '静默丢弃 = 用户以为发了、实际永久消失');
    assert.deepEqual(dropped[0].payload.clientMessageIds, ['cm-lost-1']);
  });

  test('R4b：队列本就为空时 dispose 不发多余的 queue_dropped', () => {
    const { s, events } = makeSession();
    s.dispose();
    assert.equal(events.filter(e => e.payload?.kind === 'queue_dropped').length, 0);
  });
});
