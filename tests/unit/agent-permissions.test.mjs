import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession, awaitTtlSettled } from '../helpers/agent-unit.mjs';

// ---- 权限闸门 ----
test.describe('权限闸门', () => {
  test('sdkPermissionMode：bypass → default，其余原样', () => {
    const { s } = makeSession();
    assert.equal(s.sdkPermissionMode(), 'default');
    s.permissionMode = 'plan';
    assert.equal(s.sdkPermissionMode(), 'plan');
    s.permissionMode = 'bypassPermissions';
    assert.equal(s.sdkPermissionMode(), 'default');
    s.permissionMode = 'dontAsk';
    assert.equal(s.sdkPermissionMode(), 'dontAsk');
    s.dispose();
  });

  test('handleCanUseTool：AskUserQuestion → handleQuestion', () => {
    const { s } = makeSession();
    const result = s.handleCanUseTool('AskUserQuestion', { questions: [] }, { signal: new AbortController().signal, toolUseID: 'q1' });
    // 空 questions → allow
    assert.deepEqual(result, { behavior: 'allow', updatedInput: { questions: [] } });
    s.dispose();
  });

  test('handleCanUseTool：dontAsk → deny（防御纵深）', () => {
    const { s } = makeSession({ permissionMode: 'dontAsk' });
    const result = s.handleCanUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 't1' });
    assert.equal(result.behavior, 'deny');
    assert.equal(result.interrupt, true);
    s.dispose();
  });

  test('handleCanUseTool：bypassPermissions → allow', () => {
    const { s } = makeSession({ permissionMode: 'bypassPermissions' });
    const result = s.handleCanUseTool('Read', { file_path: '/a' }, { signal: new AbortController().signal, toolUseID: 't1' });
    assert.equal(result.behavior, 'allow');
    s.dispose();
  });

  test('handleCanUseTool：default → askPermission（返回 Promise）', () => {
    const { s } = makeSession();
    const result = s.handleCanUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 't1' });
    assert.ok(result instanceof Promise);
    // 不应影响已有 Promise — 清理
    s.resolvePermission('t1', 'deny');
    s.dispose();
  });

  test('askPermission：emit permission_request + pendingPermissions 写入', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    const promise = s.askPermission('Bash', { command: 'rm -rf /' }, { signal: ac.signal, toolUseID: 't1' });
    assert.ok(promise instanceof Promise);
    assert.equal(s.pendingPermissions.size, 1);
    const pr = events.find(e => e.type === 'permission_request');
    assert.ok(pr);
    assert.equal(pr.payload.requestId, 't1');
    assert.equal(pr.payload.name, 'Bash');
    assert.ok(pr.payload.input.command.includes('rm'));
    // 清理
    s.resolvePermission('t1', 'deny');
    s.dispose();
  });

  test('resolvePermission(allow)：removeEventListener + emit request_resolved + alwaysThisSession', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    let removed = false;
    const origRemove = ac.signal.removeEventListener;
    ac.signal.removeEventListener = (type, fn) => { removed = true; origRemove.call(ac.signal, type, fn); };

    s.askPermission('Read', { file_path: '/a.txt' }, {
      signal: ac.signal, toolUseID: 't1',
      suggestions: [{ destination: 'session', permission: 'allow', toolName: 'Read' }]
    });
    // NFR-17 审批完整性绑定：allow 决策须回传与 askPermission 时锚定 fp 匹配的 op，否则 fail-closed 拒绝。
    s.resolvePermission('t1', 'allow', true, { tool: 'Read', args: { file_path: '/a.txt' }, cwd: s.cwd });

    assert.equal(removed, true);
    assert.equal(s.pendingPermissions.size, 0);
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
    assert.ok(rr);
    assert.equal(rr.payload.outcome, 'allow');
    s.dispose();
  });

  test('resolvePermission(deny)：denyKinds 设置 + request_resolved', async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.askPermission('Bash', { command: 'rm' }, { signal: ac.signal, toolUseID: 't1' });
    s.resolvePermission('t1', 'deny');
    assert.equal(s.denyKinds.get('t1'), 'denied');
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
    assert.equal(rr.payload.outcome, 'deny');
    s.dispose();
  });

  // 审批 TTL（承接 OQ-05 fail-closed）
  test('askPermission：permission_request payload 附 createdAt/expiresAt（expiresAt=createdAt+TTL）', () => {
    const { s, events } = makeSession({ approvalTtlMs: 5000 });
    const ac = new AbortController();
    s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 't1' });
    const pr = events.find(e => e.type === 'permission_request');
    assert.ok(typeof pr.payload.createdAt === 'number');
    assert.equal(pr.payload.expiresAt, pr.payload.createdAt + 5000);
    s.resolvePermission('t1', 'deny');
    s.dispose();
  });

  test('resolvePermission：已过期 → 不论 decision 一律按 deny 处理，outcome=expired', async () => {
    const { s, events } = makeSession({ approvalTtlMs: 1 }); // 1ms TTL，立刻过期
    const ac = new AbortController();
    const promise = s.askPermission('Bash', { command: 'rm -rf /' }, { signal: ac.signal, toolUseID: 't1' });
    await new Promise(r => setTimeout(r, 20)); // 确保已越过 1ms TTL
    // 过期检查先于完整性校验，op 是否匹配不影响本测试结论——仍传正确 op 保持调用形态真实。
    s.resolvePermission('t1', 'allow', false, { tool: 'Bash', args: { command: 'rm -rf /' }, cwd: s.cwd }); // 即便传 allow，过期后也不应放行
    const result = await promise;
    assert.equal(result.behavior, 'deny', '过期后不可再兑现，即便传 allow 也必须 deny（fail-closed）');
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
    assert.equal(rr.payload.outcome, 'expired', 'outcome 应标 expired，区别于用户主动 allow/deny');
    assert.equal(s.denyKinds.get('t1'), 'denied');
    s.dispose();
  });

  test('审批到期无人处理 → 到期 timer 自动 fail-closed deny + emit expired（BE-003：防 SDK canUseTool Promise 永久悬置）', { timeout: 3000 }, async () => {
    const { s, events } = makeSession({ approvalTtlMs: 30 });
    const ac = new AbortController();
    // 纯靠到期 timer 结算：全程【不】调用 resolvePermission，模拟无人处理审批的场景。
    const promise = s.askPermission('Bash', { command: 'sleep 999' }, { signal: ac.signal, toolUseID: 't1' });
    assert.equal(s.pendingPermissions.size, 1, '刚请求时应挂起');
    // 同 agent-questions 的 AG-001：expiryTimer 是 unref 的，此处仅靠 approvalStore 落盘 I/O
    // 侥幸撑住事件循环，不是保证 —— 用 helper 显式还原前提。无到期 timer 时此处永不 resolve（靠 test timeout 兜底红）。
    const result = await awaitTtlSettled(promise);
    assert.equal(result.behavior, 'deny', '到期后 fail-closed deny');
    assert.equal(result.interrupt, false, 'expired 不 interrupt 在途轮');
    assert.equal(s.pendingPermissions.size, 0, '到期后 pending 清空，不再悬置');
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
    assert.equal(rr?.payload.outcome, 'expired', 'outcome 标 expired');
    assert.equal(s.denyKinds.get('t1'), 'denied');
    s.dispose();
  });

  test('resolvePermission：未过期时 TTL 机制不影响正常 allow/deny（回归）', async () => {
    const { s, events } = makeSession({ approvalTtlMs: 60_000 }); // 60s，测试期间不可能过期
    const ac = new AbortController();
    const promise = s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 't1' });
    s.resolvePermission('t1', 'allow', false, { tool: 'Bash', args: { command: 'ls' }, cwd: s.cwd });
    const result = await promise;
    assert.equal(result.behavior, 'allow');
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
    assert.equal(rr.payload.outcome, 'allow');
    s.dispose();
  });

  // 审批完整性绑定（承接 AD-7/NFR-17，"所批即所行"）
  test.describe('审批完整性绑定（NFR-17）', () => {
    test('askPermission：permission_request payload 附 fp，且等于 fingerprintSync({tool,args,cwd})', async () => {
      const { fingerprintSync } = await import('../../app/src/auth/fingerprint.js');
      const { s, events } = makeSession({ cwd: '/tmp/proj' });
      const ac = new AbortController();
      s.askPermission('Bash', { command: 'ls -la' }, { signal: ac.signal, toolUseID: 't1' });
      const pr = events.find(e => e.type === 'permission_request');
      assert.equal(pr.payload.fp, fingerprintSync({ tool: 'Bash', args: { command: 'ls -la' }, cwd: '/tmp/proj' }));
      s.resolvePermission('t1', 'deny');
      s.dispose();
    });

    test('resolvePermission(allow)：clientOp 与锚定 fp 不符（参数被篡改）→ fail-closed deny，outcome=integrity_mismatch', async () => {
      const { s, events } = makeSession();
      const ac = new AbortController();
      const promise = s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 't1' });
      // 客户端回传的 op 与卡片渲染/锚定时的 { command: 'ls' } 不一致——模拟传输层被篡改
      s.resolvePermission('t1', 'allow', false, { tool: 'Bash', args: { command: 'rm -rf /' }, cwd: s.cwd });
      const result = await promise;
      assert.equal(result.behavior, 'deny', '完整性不符必须 fail-closed 拒绝，即便 decision 是 allow');
      assert.equal(result.interrupt, false);
      const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
      assert.equal(rr.payload.outcome, 'integrity_mismatch');
      assert.equal(s.denyKinds.get('t1'), 'denied');
      s.dispose();
    });

    test('resolvePermission(allow)：clientOp 缺失（未回传 op）→ fail-closed deny，outcome=integrity_mismatch', async () => {
      const { s, events } = makeSession();
      const ac = new AbortController();
      const promise = s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 't1' });
      s.resolvePermission('t1', 'allow', false); // 不传 clientOp（如旧客户端/协议缺字段）
      const result = await promise;
      assert.equal(result.behavior, 'deny');
      const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
      assert.equal(rr.payload.outcome, 'integrity_mismatch');
      s.dispose();
    });

    test('resolvePermission(allow)：clientOp 的 cwd 与锚定不符（args/tool 不变）→ fail-closed deny', async () => {
      const { s, events } = makeSession({ cwd: '/workdir-a' });
      const ac = new AbortController();
      const promise = s.askPermission('Read', { file_path: '/x' }, { signal: ac.signal, toolUseID: 't1' });
      s.resolvePermission('t1', 'allow', false, { tool: 'Read', args: { file_path: '/x' }, cwd: '/workdir-b' });
      const result = await promise;
      assert.equal(result.behavior, 'deny');
      const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
      assert.equal(rr.payload.outcome, 'integrity_mismatch');
      s.dispose();
    });

    test('resolvePermission(deny)：不校验完整性——clientOp 缺失/不符也不影响 deny 决策本身正常生效', async () => {
      const { s, events } = makeSession();
      const ac = new AbortController();
      const promise = s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 't1' });
      s.resolvePermission('t1', 'deny', false); // deny 决策：不传 clientOp，不应被误判为 integrity_mismatch
      const result = await promise;
      assert.equal(result.behavior, 'deny');
      const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
      assert.equal(rr.payload.outcome, 'deny', 'deny 路径的 outcome 应保持 deny，不应被完整性校验分支抢先接管');
      s.dispose();
    });

    test('pendingRequestsSnapshot()：真实 askPermission 产生的 fp 原样出现在快照里（非手造数据）', async () => {
      const { fingerprintSync } = await import('../../app/src/auth/fingerprint.js');
      const { s } = makeSession({ cwd: '/tmp/proj' });
      const ac = new AbortController();
      s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 't1' });
      const snap = s.pendingRequestsSnapshot();
      assert.equal(snap.permissions[0].fp, fingerprintSync({ tool: 'Bash', args: { command: 'ls' }, cwd: '/tmp/proj' }));
      s.resolvePermission('t1', 'deny');
      s.dispose();
    });
  });

  // 持久化台账（approval_request 表，承接 NFR-16/19/22，Phase 4）——askPermission/resolvePermission
  // 写穿透到 approval-store.js。测试用真实模块（非 mock）：CCM_APPROVAL_STORE_FILE 由
  // tests/setup/preload-env.mjs 重定向到一次性临时文件，不碰真实 data/approval-requests.json。
  test.describe('审批持久化台账（NFR-16/19，Phase 4）', () => {
    test('askPermission：立即在台账里生成一条 status=pending 记录', async () => {
      const AS = await import('../../app/src/agent/approval-store.js');
      const { s } = makeSession({ cwd: '/tmp/proj-store-1' });
      const ac = new AbortController();
      s.askPermission('Bash', { command: 'echo a' }, { signal: ac.signal, toolUseID: 'store-t1' });
      const r = AS.getByReqId('store-t1');
      assert.ok(r);
      assert.equal(r.status, 'pending');
      assert.equal(r.tool, 'Bash');
      assert.equal(r.cwd, '/tmp/proj-store-1');
      assert.equal(r.sessionId, s.sessionId);
      s.resolvePermission('store-t1', 'deny');
      s.dispose();
    });

    test('resolvePermission(allow)：台账 status 更新为 allow，返回值为 "allow"', async () => {
      const AS = await import('../../app/src/agent/approval-store.js');
      const { s } = makeSession();
      const ac = new AbortController();
      s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 'store-t2' });
      const outcome = s.resolvePermission('store-t2', 'allow', false, { tool: 'Bash', args: { command: 'ls' }, cwd: s.cwd });
      assert.equal(outcome, 'allow');
      assert.equal(AS.getByReqId('store-t2').status, 'allow');
      s.dispose();
    });

    test('resolvePermission(deny)：台账 status 更新为 deny，返回值为 "deny"', async () => {
      const AS = await import('../../app/src/agent/approval-store.js');
      const { s } = makeSession();
      const ac = new AbortController();
      s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 'store-t3' });
      const outcome = s.resolvePermission('store-t3', 'deny');
      assert.equal(outcome, 'deny');
      assert.equal(AS.getByReqId('store-t3').status, 'deny');
      s.dispose();
    });

    test('resolvePermission：完整性校验失败 → 台账 status=integrity_mismatch，返回值同 outcome', async () => {
      const AS = await import('../../app/src/agent/approval-store.js');
      const { s } = makeSession();
      const ac = new AbortController();
      s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 'store-t4' });
      const outcome = s.resolvePermission('store-t4', 'allow', false, { tool: 'Bash', args: { command: 'rm -rf /' }, cwd: s.cwd });
      assert.equal(outcome, 'integrity_mismatch');
      assert.equal(AS.getByReqId('store-t4').status, 'integrity_mismatch');
      s.dispose();
    });

    test('已过期 → 到期 timer 主动结算：台账 status=expired，过期后再提交扑空（BE-003）', async () => {
      const AS = await import('../../app/src/agent/approval-store.js');
      const { s } = makeSession({ approvalTtlMs: 1 });
      const ac = new AbortController();
      const promise = s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 'store-t5' });
      // BE-003：到期由 timer 主动结算（不再依赖有人提交才惰性发现过期）——await 到 Promise 被 timer resolve。
      // expiryTimer 是 unref 的，同上用 helper 撑住事件循环。
      const result = await awaitTtlSettled(promise);
      assert.equal(result.behavior, 'deny', '过期 fail-closed deny');
      assert.equal(AS.getByReqId('store-t5').status, 'expired', '台账记 expired');
      // 过期后再提交（即便 allow）扑空——已被 timer 结算，返回 undefined，绝不放行（fail-closed 保证仍在）。
      const outcome = s.resolvePermission('store-t5', 'allow', false, { tool: 'Bash', args: { command: 'ls' }, cwd: s.cwd });
      assert.equal(outcome, undefined, '已被 timer 结算，再提交扑空');
      s.dispose();
    });

    test('resolvePermission：找不到 pending（已消费/已 abort）→ 返回 undefined，不写台账', async () => {
      const { s } = makeSession();
      const outcome = s.resolvePermission('never-existed-reqid', 'allow');
      assert.equal(outcome, undefined);
      s.dispose();
    });

    test('abort：台账 status 更新为 aborted', async () => {
      const AS = await import('../../app/src/agent/approval-store.js');
      const { s } = makeSession();
      const ac = new AbortController();
      s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 'store-t6' });
      ac.abort();
      assert.equal(AS.getByReqId('store-t6').status, 'aborted');
      s.dispose();
    });
  });

  test('abort signal 触发 → pendingPermissions.delete + request_resolved(aborted) + denyKinds(cancelled)', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.askPermission('Bash', { command: 'rm' }, { signal: ac.signal, toolUseID: 't1' });
    ac.abort();
    assert.equal(s.pendingPermissions.size, 0);
    assert.equal(s.denyKinds.get('t1'), 'cancelled');
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.outcome === 'aborted');
    assert.ok(rr);
    s.dispose();
  });

  test('setPermissionMode：无效档 → emit error', () => {
    const { s, events } = makeSession();
    s.setPermissionMode('invalid');
    const err = events.find(e => e.type === 'error');
    assert.ok(err);
    assert.ok(err.payload.message.includes('未知权限档'));
    s.dispose();
  });

  test('setPermissionMode：有效档 → 更新 permissionMode', async () => {
    const { s } = makeSession();
    // setPermissionMode 是 async——可选链 await this.q?.setPermissionMode 对 null q 即 no-op
    await s.setPermissionMode('plan');
    assert.equal(s.permissionMode, 'plan');
    s.dispose();
  });

  // 闸门读的是 this.permissionMode，而它在 await _raceControlRequest 之后才赋值；该 RPC 最长可挂
  // interruptTimeoutMs(10s)（限流重试时常见），且 user:setPermissionMode 没有 busy 守卫、轮次进行中可调。
  // 方向不对称：升权与切 dontAsk 的在飞窗口都是 fail-safe，唯独【从 bypass 降出来】是 fail-open——
  // 用户主动降权的这 10 秒里，模型发起的任何工具仍被 bypass 分支零弹窗放行。
  test('setPermissionMode：从 bypassPermissions 降档必须立即生效，不等 SDK 回包', async () => {
    const { s } = makeSession();
    s.permissionMode = 'bypassPermissions';
    let release;
    const inFlight = new Promise(r => { release = r; });
    s.q = { setPermissionMode: () => inFlight };

    const pending = s.setPermissionMode('default');
    await Promise.resolve(); // 让出一拍：RPC 已发出、尚未回包

    assert.equal(s.permissionMode, 'default', 'RPC 在飞期间就必须已经不是 bypass');
    const gate = s.handleCanUseTool('Bash', { command: 'rm -rf ~/important' }, { signal: new AbortController().signal, toolUseID: 't1' });
    assert.notEqual(gate?.behavior, 'allow', '降权窗口内不得再走 bypass 直接放行');

    release();
    await pending;
    assert.equal(s.permissionMode, 'default');
    s.dispose();
  });

  test("setPermissionMode：'auto'（SDK 实际支持的第 6 档，模型分类器自动批准/拒绝）应被接受，不报未知权限档（code-review P1）", async () => {
    const { s, events } = makeSession();
    const ok = await s.setPermissionMode('auto');
    assert.equal(ok, true);
    assert.equal(s.permissionMode, 'auto');
    assert.equal(events.find(e => e.type === 'error'), undefined);
    s.dispose();
  });

  // 回归：q.setPermissionMode 和 q.interrupt 走同一条 control_request 通道，限流重试期间同样可能
  // 永不回包。超时后应等同于既有的"SDK 抛错"分支——emit error、保留原档、返回 false，而不是让
  // setPermissionMode()（进而调用方 server 的 socket ack）永久 hang。
  test('setPermissionMode：SDK 挂起超时 → 优雅降级，保留原档，emit error（不永久 hang）', async () => {
    const { s, events } = makeSession({ permissionMode: 'default' });
    s.interruptTimeoutMs = 20; // 单测加速：与 interrupt 共用同一超时配置
    s.q = { setPermissionMode() { return new Promise(() => {}); } }; // 永不 resolve
    const ok = await s.setPermissionMode('plan');
    assert.equal(ok, false);
    assert.equal(s.permissionMode, 'default', '切换未完成，保留原档');
    const err = events.find(e => e.type === 'error');
    assert.ok(err);
    assert.ok(err.payload.message.includes('权限档切换失败'));
    s.dispose();
  });

  // 批准内含的模式切换：若 SDK 经 canUseTool 的 suggestions 给出 setMode PermissionUpdate，批准时应始终
  // 应用（非「始终允许」可选项）→ 回传 SDK + 更新本实例档 + emit permission_mode 让 server 同步手机端图标。
  // 注：这是「SDK 主动下发 suggestion」的前向兼容路径——实测当前 SDK 的 ExitPlanMode 并不走这里（见下条），
  // 但别的工具/未来版本可能给 setMode，故此路径优先于兜底。
  test('resolvePermission(allow)：setMode suggestion → 应用 + emit permission_mode + 更新 permissionMode', async () => {
    const { s, events } = makeSession({ permissionMode: 'plan' });
    const ac = new AbortController();
    const promise = s.askPermission('SomeTool', { x: 1 }, {
      signal: ac.signal, toolUseID: 't1',
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
    });
    s.resolvePermission('t1', 'allow', false, { tool: 'SomeTool', args: { x: 1 }, cwd: s.cwd }); // 非「始终允许」，但 setMode 仍应应用
    const result = await promise;
    assert.equal(result.behavior, 'allow');
    assert.deepEqual(result.updatedPermissions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
    assert.equal(s.permissionMode, 'acceptEdits'); // 本实例档跟随
    const pm = events.find(e => e.type === 'permission_mode');
    assert.ok(pm, '应 emit permission_mode 供 server 同步前端图标');
    assert.equal(pm.payload.mode, 'acceptEdits');
    s.dispose();
  });

  // 回归（核心 bug）：实测 SDK 的 ExitPlanMode checkPermissions 只回 {behavior:'ask'}、不带任何 setMode
  // suggestion → 批准后若不兜底则 updatedPermissions 为空、SDK 内部仍停 plan、前端图标停「计划模式」。
  // 兜底须对 ExitPlanMode 合成「退出到 default」=回传 SDK 退 plan + emit permission_mode 同步前端。
  test('resolvePermission(allow)：ExitPlanMode 无 suggestion → 兜底合成 setMode default（退出 plan）', async () => {
    const { s, events } = makeSession({ permissionMode: 'plan' });
    const ac = new AbortController();
    const promise = s.askPermission('ExitPlanMode', { plan: '…' }, {
      signal: ac.signal, toolUseID: 't1', suggestions: undefined // 真 SDK 行为：无 suggestions
    });
    s.resolvePermission('t1', 'allow', false, { tool: 'ExitPlanMode', args: { plan: '…' }, cwd: s.cwd });
    const result = await promise;
    assert.equal(result.behavior, 'allow');
    assert.deepEqual(result.updatedPermissions, [{ type: 'setMode', mode: 'default', destination: 'session' }],
      '须回传合成 setMode default 让 SDK 真退出 plan');
    assert.equal(s.permissionMode, 'default'); // 本实例档退出 plan
    const pm = events.find(e => e.type === 'permission_mode');
    assert.ok(pm, '应 emit permission_mode 供 server 同步前端图标');
    assert.equal(pm.payload.mode, 'default');
    s.dispose();
  });

  // 对齐 CLI plan-exit：用户批准时可选手 default / acceptEdits / bypassPermissions
  test('resolvePermission(allow)：ExitPlanMode + exitMode=acceptEdits → setMode acceptEdits', async () => {
    const { s, events } = makeSession({ permissionMode: 'plan' });
    const ac = new AbortController();
    const promise = s.askPermission('ExitPlanMode', { plan: '…' }, {
      signal: ac.signal, toolUseID: 't1', suggestions: undefined
    });
    s.resolvePermission('t1', 'allow', false, { tool: 'ExitPlanMode', args: { plan: '…' }, cwd: s.cwd }, { exitMode: 'acceptEdits' });
    const result = await promise;
    assert.deepEqual(result.updatedPermissions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
    assert.equal(s.permissionMode, 'acceptEdits');
    assert.equal(events.find(e => e.type === 'permission_mode')?.payload.mode, 'acceptEdits');
    s.dispose();
  });

  test('resolvePermission(allow)：ExitPlanMode + exitMode=bypassPermissions → setMode bypass', async () => {
    const { s } = makeSession({ permissionMode: 'plan' });
    const ac = new AbortController();
    const promise = s.askPermission('ExitPlanMode', { plan: '…' }, {
      signal: ac.signal, toolUseID: 't1', suggestions: undefined
    });
    s.resolvePermission('t1', 'allow', false, { tool: 'ExitPlanMode', args: { plan: '…' }, cwd: s.cwd }, { exitMode: 'bypassPermissions' });
    const result = await promise;
    assert.equal(result.updatedPermissions[0].mode, 'bypassPermissions');
    assert.equal(s.permissionMode, 'bypassPermissions');
    s.dispose();
  });

  test('resolvePermission(allow)：ExitPlanMode + 非法 exitMode → 回落 default', async () => {
    const { s } = makeSession({ permissionMode: 'plan' });
    const ac = new AbortController();
    const promise = s.askPermission('ExitPlanMode', { plan: '…' }, {
      signal: ac.signal, toolUseID: 't1', suggestions: undefined
    });
    s.resolvePermission('t1', 'allow', false, { tool: 'ExitPlanMode', args: { plan: '…' }, cwd: s.cwd }, { exitMode: 'nope' });
    const result = await promise;
    assert.equal(result.updatedPermissions[0].mode, 'default');
    s.dispose();
  });

  test('resolvePermission(allow)：无 setMode 且非 alwaysThisSession → 不改档、不 emit permission_mode、updatedPermissions 为空', async () => {
    const { s, events } = makeSession({ permissionMode: 'default' });
    const ac = new AbortController();
    const promise = s.askPermission('Bash', { command: 'ls' }, {
      signal: ac.signal, toolUseID: 't1',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }]
    });
    s.resolvePermission('t1', 'allow', false, { tool: 'Bash', args: { command: 'ls' }, cwd: s.cwd });
    const result = await promise;
    assert.equal(result.updatedPermissions, undefined); // 非 always + 无 setMode → 不带
    assert.equal(s.permissionMode, 'default');
    assert.equal(events.find(e => e.type === 'permission_mode'), undefined);
    s.dispose();
  });

  test('resolvePermission(allow)：alwaysThisSession → 回传 session 范围规则（保持原行为）', async () => {
    const { s } = makeSession();
    const ac = new AbortController();
    const rules = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }];
    const promise = s.askPermission('Bash', { command: 'ls' }, {
      signal: ac.signal, toolUseID: 't1', suggestions: rules
    });
    s.resolvePermission('t1', 'allow', true, { tool: 'Bash', args: { command: 'ls' }, cwd: s.cwd });
    const result = await promise;
    assert.deepEqual(result.updatedPermissions, rules);
    s.dispose();
  });
});


// ---- 跨实例隔离（跨 tab 审批/提问回答不串台）----
// 坐实诊断「安全」结论的服务端支柱：user:approve/answer → routeInstance(instanceId)?.resolvePermission/
// resolveQuestion(requestId)。不变量 = 回答按 (instanceId→实例) + (requestId→该实例内挂起项) 双重定位。
// 错 instanceId（切到 tab Y 后误用 Y 的 instanceId 回答 tab X 的弹窗）→ 目标实例无此 requestId →
// no-op：X 审批仍挂起、Y 审批不受波及，绝不跨实例误批/误拒。配合前端 clearView 切 tab 清弹窗（已静态确认），
// 即便前端那道闸失守，服务端这道双重定位仍兜底。
test.describe('跨实例隔离（跨 tab 回答不串台）', () => {
  test('resolvePermission：错 instanceId 路由是 no-op，两实例审批互不影响', () => {
    const X = makeSession({ instanceId: 'inst_X' });
    const Y = makeSession({ instanceId: 'inst_Y' });
    X.s.askPermission('Bash', { command: 'x' }, { signal: new AbortController().signal, toolUseID: 'reqX' });
    Y.s.askPermission('Bash', { command: 'y' }, { signal: new AbortController().signal, toolUseID: 'reqY' });
    // 切到 Y 后误用 Y 的 instanceId 答 X 弹窗的 requestId：routeInstance(Y).resolvePermission(reqX)
    Y.s.resolvePermission('reqX', 'allow');
    assert.equal(X.s.pendingPermissions.size, 1, 'reqX 仍挂起（错路由 no-op，未被误批）');
    assert.equal(Y.s.pendingPermissions.size, 1, 'reqY 未受波及');
    X.s.dispose(); Y.s.dispose();
  });

  test('resolvePermission：正确路由只解决目标实例，邻居 Promise 不 resolve', async () => {
    const X = makeSession({ instanceId: 'inst_X' });
    const Y = makeSession({ instanceId: 'inst_Y' });
    let outY = 'pending';
    const pX = X.s.askPermission('Bash', { command: 'x' }, { signal: new AbortController().signal, toolUseID: 'reqX' });
    Y.s.askPermission('Bash', { command: 'y' }, { signal: new AbortController().signal, toolUseID: 'reqY' }).then(r => { outY = r.behavior; });
    X.s.resolvePermission('reqX', 'allow', false, { tool: 'Bash', args: { command: 'x' }, cwd: X.s.cwd });
    assert.equal((await pX).behavior, 'allow', 'reqX 解决为 allow');
    assert.equal(X.s.pendingPermissions.size, 0);
    assert.equal(Y.s.pendingPermissions.size, 1, 'reqY 仍挂起');
    assert.equal(outY, 'pending', 'reqY 的 Promise 未被 resolve');
    X.s.dispose(); Y.s.dispose();
  });

  test('相同 requestId 跨实例不碰撞（各自 pendingPermissions 独立）', async () => {
    const X = makeSession({ instanceId: 'inst_X' });
    const Y = makeSession({ instanceId: 'inst_Y' });
    const pX = X.s.askPermission('Bash', { command: 'x' }, { signal: new AbortController().signal, toolUseID: 'dup' });
    const pY = Y.s.askPermission('Bash', { command: 'y' }, { signal: new AbortController().signal, toolUseID: 'dup' });
    X.s.resolvePermission('dup', 'deny'); // 只动 X 的 'dup'
    assert.equal((await pX).behavior, 'deny');
    assert.equal(X.s.pendingPermissions.size, 0);
    assert.equal(Y.s.pendingPermissions.size, 1, '同名 requestId 在 Y 仍挂起');
    Y.s.resolvePermission('dup', 'allow', false, { tool: 'Bash', args: { command: 'y' }, cwd: Y.s.cwd });
    assert.equal((await pY).behavior, 'allow');
    X.s.dispose(); Y.s.dispose();
  });

  test('resolveQuestion：错 instanceId 路由是 no-op，两实例提问互不影响', () => {
    const X = makeSession({ instanceId: 'inst_X' });
    const Y = makeSession({ instanceId: 'inst_Y' });
    X.s.handleQuestion({ questions: [{ question: 'QX', options: ['A', 'B'] }] }, { signal: new AbortController().signal, toolUseID: 'qX' });
    Y.s.handleQuestion({ questions: [{ question: 'QY', options: ['A', 'B'] }] }, { signal: new AbortController().signal, toolUseID: 'qY' });
    Y.s.resolveQuestion('qX#0', 0); // 误用 Y 回答 X 的 question requestId
    assert.equal(X.s.pendingQuestions.size, 1, 'qX 仍挂起');
    assert.equal(Y.s.pendingQuestions.size, 1, 'qY 未受波及');
    X.s.dispose(); Y.s.dispose();
  });
});
