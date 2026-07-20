// tests/unit/agent-sessions-routing.test.mjs —— Bug B 端到端回归。
// 验证 src/agent/agent.js 的 onSessionId 触发链 × src/sessions/sessions.js 的路由代次守卫，
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
    S = await import('../../src/sessions/sessions.js');
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
        // 与 src/server/app.js 的 onSessionId 回调对齐：把闭包捕获的 generation 一并传给 upsertSession
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
