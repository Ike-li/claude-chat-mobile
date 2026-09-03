// tests/unit/agent-sessions-routing.test.mjs —— Bug B 端到端回归。
// 验证 app/src/agent/agent.js 的 onSessionId 触发链 × app/src/sessions/sessions.js 的路由代次守卫，
// 在真实的"同一实例两次触发 system/init"（模拟 session:new 之后、未被 dispose 的旧实例因
// 后台任务汇报等原因又跑了一轮）场景下正确协作——不需要真实 CLI 子进程或新的 mock 基建，
// 复用既有 tests/helpers/agent-unit.mjs（makeSession）+ 现有测试通用的 s.map() 直接注入手法。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeSession } from '../helpers/agent-unit.mjs';

let S;       // sessions 模块（动态 import，需先设 CCM_SESSIONS_FILE 再加载）
let TMP_DIR;

test.describe('session:new 后旧实例路由代次守卫（Bug B 回归）', () => {
  test.before(async () => {
    TMP_DIR = mkdtempSync(join(tmpdir(), 'ccm-agent-sessions-routing-test-'));
    process.env.CCM_SESSIONS_FILE = join(TMP_DIR, 'sessions.json'); // 必须在 import 前设
    S = await import('../../app/src/sessions/sessions.js');
  });

  test.after(() => {
    delete process.env.CCM_SESSIONS_FILE;
    if (TMP_DIR) rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('新建会话后，旧实例的后台活动不应劫持路由指针', () => {
    const cwd = '/tmp/bug-b-e2e';
    const generation = S.getGeneration(cwd); // 模拟 openInstance() 里对本实例捕获的代次快照

    const { s } = makeSession({
      cwd,
      onSessionId(sid, firstMessage, model) {
        // 与 app/src/server/app.js 的 onSessionId 回调对齐：把闭包捕获的 generation 一并传给 upsertSession
        S.upsertSession({ id: sid, title: firstMessage, cwd, model, generation });
      },
    });

    // 首次 init：合法建立该 cwd 的路由指针
    s.map({ type: 'system', subtype: 'init', session_id: 'sid-old', model: 'opus', cwd });
    assert.equal(S.getCurrent(cwd), 'sid-old');

    // 模拟 session:new：该 cwd 代次前进 + 清空指针（旧实例不 dispose，后台继续跑）
    S.bumpGeneration(cwd);
    S.setCurrent(cwd, null);

    // 模拟旧实例（仍持有创建时捕获的旧 generation 闭包）后续一轮后台活动
    // （如后台任务完成自动汇报）再次触发 system/init
    s.map({ type: 'system', subtype: 'init', session_id: 'sid-old', model: 'opus', cwd });

    // 断言：指针没有被复活——这正是本次修复要堵住的洞
    assert.equal(S.getCurrent(cwd), null);

    s.dispose();
  });

  test('对照：不传 generation（旧调用方式）时旧实例活动会复活指针——证明上面的回归测试确实在验证代次机制而非恒真断言', () => {
    const cwd = '/tmp/bug-b-e2e-control';
    const { s } = makeSession({
      cwd,
      onSessionId(sid, firstMessage, model) {
        S.upsertSession({ id: sid, title: firstMessage, cwd, model }); // 故意不传 generation
      },
    });

    s.map({ type: 'system', subtype: 'init', session_id: 'sid-old', model: 'opus', cwd });
    assert.equal(S.getCurrent(cwd), 'sid-old');

    S.bumpGeneration(cwd);
    S.setCurrent(cwd, null);

    s.map({ type: 'system', subtype: 'init', session_id: 'sid-old', model: 'opus', cwd });

    // 没有代次保护时，指针确实会被复活——这是修复前的真实行为，此测试只是验证测试本身有效，不是期望行为
    assert.equal(S.getCurrent(cwd), 'sid-old');

    s.dispose();
  });
});

// ---- sessionId 首达兜底认领（agent.js#_claimSessionIdEarly）----
// 病灶：sessionId 的唯一来源曾是 system/init，而 CLI 执行本地 slash 命令（web 端 /code-review 等）
// 时整条命令跑在独立 fork 上下文里，init 要等命令跑完才投。2026-08-05 隔离探针实测 init 132s 才到、
// 同流上 rate_limit_event 9.5s 就带着 session_id 到了；真机 11 次 web /code-review 延迟 124s~1869s，
// 其中 2 次（中途按停止）从头到尾没拿到过 id。期间前端：会话设置无 session id、标题恒「新会话」、
// 历史与镜像无从查起（三者都以 sessionId 为键）。
test.describe('sessionId 首达兜底：不独等 system/init', () => {
  test('非 init 消息带 session_id → 立即认领并触发 onSessionId（这是本次修复的核心行为）', () => {
    const calls = [];
    const { s } = makeSession({ onSessionId: (sid, title, model) => calls.push({ sid, title, model }) });
    s.firstMessage = '/code-review';

    // 探针实测的真实首条消息形态：rate_limit_event 带完整 session_id，早于 init 122 秒
    s.map({ type: 'rate_limit_event', session_id: 'sid-early', rate_limit_info: {} });

    assert.equal(s.sessionId, 'sid-early', 'init 之前就该拿到 sessionId');
    assert.equal(calls.length, 1, 'onSessionId 须被触发（否则 sessions.json 无条目、前端标题仍是「新会话」）');
    assert.equal(calls[0].sid, 'sid-early');
    assert.equal(calls[0].title, '/code-review', 'firstMessage 须作标题带出');
    assert.equal(calls[0].model, undefined, '早到消息不带模型名，须传 undefined 让下游 if(model) 守卫跳过');
    s.dispose();
  });

  test('事件信封随即带上真 sessionId（前端按它分流；空 id 正是「只有计时器、别的都没有」的成因）', () => {
    const { s, events } = makeSession();
    s.map({ type: 'rate_limit_event', session_id: 'sid-envelope', rate_limit_info: {} });
    s.emit('system', { message: 'x' });
    assert.equal(events.at(-1).sessionId, 'sid-envelope');
    s.dispose();
  });

  test('已有 sessionId（resume 场景）不被后续消息改写', () => {
    const calls = [];
    const { s } = makeSession({ onSessionId: sid => calls.push(sid) });
    s.sessionId = 'sid-resumed';
    s.map({ type: 'rate_limit_event', session_id: 'sid-other', rate_limit_info: {} });
    assert.equal(s.sessionId, 'sid-resumed', 'resume 的 id 是权威，非 init 消息无权改写');
    assert.equal(calls.length, 0);
    s.dispose();
  });

  test('非法 session_id（非字符串/空串）不认领——与 init 分支同口径，不让坏路由键进事件信封', () => {
    const { s } = makeSession();
    for (const bad of [123, {}, [], '', null, undefined]) {
      s.map({ type: 'rate_limit_event', session_id: bad, rate_limit_info: {} });
      assert.equal(s.sessionId, null, `session_id=${JSON.stringify(bad)} 不该被认领`);
    }
    s.dispose();
  });

  test('早期认领后 init 仍照常对账（换会话清理、model 回填不受影响）', () => {
    const calls = [];
    const { s } = makeSession({ onSessionId: (sid, title, model) => calls.push({ sid, model }) });
    s.map({ type: 'rate_limit_event', session_id: 'sid-x', rate_limit_info: {} });
    assert.equal(calls.length, 1);

    // 同 id 的 init 到达：带真实 model，须再触发一次 onSessionId 补齐（upsertSession 的 if(model) 才填得上）
    s.map({ type: 'system', subtype: 'init', session_id: 'sid-x', model: 'claude-opus-5', cwd: '/tmp/test' });
    assert.equal(s.sawInit, true);
    assert.equal(calls.length, 2, 'init 须照常触发 onSessionId，否则模型名永远补不上');
    assert.equal(calls[1].model, 'claude-opus-5');
    s.dispose();
  });
});
