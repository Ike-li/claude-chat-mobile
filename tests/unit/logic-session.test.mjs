// tests/unit/logic.test.mjs —— public/js/logic.js 纯逻辑单测（node 内置 test runner，零依赖）。
// 跑法：npm test （= node --test）。覆盖 model 桥接 / effort 档位 / 状态优先级 / ANSI 配平 / esc。
// 不覆盖 DOM 接线与 iOS/Safari 平台行为（归 npm run check + 真机），见 docs/design.md 验收纪律。
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelEntryFor, effortLevelsFor, effortUiState, resolvePanelState, aggregateStates, summarizeOtherWorkspaces, projectDisplayName, shouldShowStartScreen, shouldShowComposer, shouldRestoreOptimisticBusy, shouldClearInputOnBindView, planSessionDraftSwap, isAnsweredQuestionId, shouldDropAgentEvent, presentTurnResult, formatApiRetryBanner, mergeRecentSessionsAcrossWorkspaces } from '../../public/js/logic.js';

test('aggregateStates: 优先级 permission>error>busy>done>idle', () => {
  assert.equal(aggregateStates([{ cwd: '/a', state: 'busy' }, { cwd: '/a', state: 'permission' }], ['/a'])['/a'], 'permission');
  assert.equal(aggregateStates([{ cwd: '/a', state: 'busy' }, { cwd: '/a', state: 'done' }, { cwd: '/a', state: 'error' }], ['/a'])['/a'], 'error');
  assert.equal(aggregateStates([{ cwd: '/a', state: 'error' }, { cwd: '/a', state: 'permission' }], ['/a'])['/a'], 'permission');
});

test('aggregateStates: dir 无实例缺省 idle；实例 cwd 不在 dirs 也计入', () => {
  assert.deepEqual(aggregateStates([{ cwd: '/a', state: 'busy' }], ['/a', '/b']), { '/a': 'busy', '/b': 'idle' });
  assert.deepEqual(aggregateStates([{ cwd: '/x', state: 'done' }], []), { '/x': 'done' });
});

test('aggregateStates: 空/未定义入参安全', () => {
  assert.deepEqual(aggregateStates(undefined, undefined), {});
  assert.deepEqual(aggregateStates([], ['/a']), { '/a': 'idle' });
});

test('summarizeOtherWorkspaces: 空/未定义入参 → null', () => {
  assert.equal(summarizeOtherWorkspaces(undefined, undefined, '/cur'), null);
  assert.equal(summarizeOtherWorkspaces({}, [], '/cur'), null);
  assert.equal(summarizeOtherWorkspaces({ '/a': 'idle' }, ['/a'], '/cur'), null); // idle 不点亮
});

test('summarizeOtherWorkspaces: 排除 current，单个其他目录取其状态', () => {
  assert.equal(summarizeOtherWorkspaces({ '/cur': 'permission', '/a': 'busy' }, ['/cur', '/a'], '/cur'), 'busy');
  // current 自身即便 permission 也被排除
  assert.equal(summarizeOtherWorkspaces({ '/cur': 'permission' }, ['/cur'], '/cur'), null);
});

test('summarizeOtherWorkspaces: 跨目录优先级 permission>error>done>busy', () => {
  const dirs = ['/a', '/b'];
  assert.equal(summarizeOtherWorkspaces({ '/a': 'busy', '/b': 'permission' }, dirs, '/cur'), 'permission');
  assert.equal(summarizeOtherWorkspaces({ '/a': 'done', '/b': 'error' }, dirs, '/cur'), 'error');
  assert.equal(summarizeOtherWorkspaces({ '/a': 'busy', '/b': 'done' }, dirs, '/cur'), 'done'); // done 压过 busy（与按钮汇总语义一致）
});

// P1-4：已中止独立状态——前端聚合函数须认识新状态值，否则被当未知状态（rank 缺省 0）静默吞掉
test('aggregateStates: 认识 aborted（介于 done 与 busy 之间：比顺利完成更值得回头看，但已是终态不盖过在跑）', () => {
  assert.equal(aggregateStates([{ cwd: '/a', state: 'aborted' }, { cwd: '/a', state: 'done' }], ['/a'])['/a'], 'aborted');
  assert.equal(aggregateStates([{ cwd: '/a', state: 'aborted' }, { cwd: '/a', state: 'busy' }], ['/a'])['/a'], 'busy');
  assert.equal(aggregateStates([{ cwd: '/a', state: 'aborted' }, { cwd: '/a', state: 'error' }], ['/a'])['/a'], 'error');
});

// 用户点停止后，SDK 仍吐 is_error:true + ede_diagnostic 诊断串；CLI 只当中断、不当红色错误。
// presentTurnResult 把 interrupted 优先于 isError，决定条/通知/触感/挂起工具收尾文案。
test('presentTurnResult: interrupted=true 压过 isError/ede_diagnostic，不画红出错条', () => {
  const ui = presentTurnResult({
    interrupted: true,
    isError: true,
    errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'],
    durationMs: 249400,
    costUsd: 18.6533,
  });
  assert.equal(ui.kind, 'aborted');
  assert.equal(ui.errorBar, null, 'CLI 不对用户暴露 interrupt 伴随的 is_error 诊断');
  assert.match(ui.statusBar.text, /^已中止 · 249\.4s · \$18\.6533$/);
  assert.equal(ui.statusBar.cls, 'text-ink-faint');
  assert.equal(ui.notify.title, '⏹ 任务已中止');
  assert.equal(ui.failToolsMessage, '已中止');
  assert.equal(ui.haptic, 'warning');
});

test('presentTurnResult: 真错误仍红条；成功仍完成', () => {
  const err = presentTurnResult({ isError: true, errors: ['boom'], durationMs: 1200, costUsd: 0.1 });
  assert.equal(err.kind, 'error');
  assert.equal(err.errorBar.text, '出错：boom');
  assert.equal(err.errorBar.cls, 'text-danger');
  assert.equal(err.notify.title, '⚠️ 任务出错');
  assert.equal(err.failToolsMessage, 'boom');

  const ok = presentTurnResult({ isError: false, durationMs: 3210, costUsd: 1.2 });
  assert.equal(ok.kind, 'success');
  assert.equal(ok.errorBar, null);
  assert.match(ok.statusBar.text, /^完成 · 3\.2s · \$1\.2000$/);
  assert.equal(ok.notify.title, '✅ 任务完成');
  assert.equal(ok.failToolsMessage, null);
});

test('presentTurnResult: 缺字段安全', () => {
  const ui = presentTurnResult();
  assert.equal(ui.kind, 'success');
  assert.match(ui.statusBar.text, /^完成 · 0\.0s$/);
  assert.equal(presentTurnResult(null).kind, 'success');
});

// CLI: "Retrying in 4s · attempt 2/10" — web 横幅文案对齐，瞬时覆盖不堆历史条
test('formatApiRetryBanner: 限流 + 次数 + 等待秒数', () => {
  assert.equal(
    formatApiRetryBanner({ attempt: 2, maxRetries: 10, delayMs: 4000, error: 'rate_limit' }),
    '限流重试中 · 2/10 · 4s 后',
  );
});

test('formatApiRetryBanner: overloaded / 缺字段 / 非数字安全', () => {
  assert.equal(formatApiRetryBanner({ attempt: 1, maxRetries: 3, delayMs: 500, error: 'overloaded' }), '过载重试中 · 1/3 · 1s 后');
  assert.equal(formatApiRetryBanner({ attempt: 2, delayMs: 0 }), '重试中 · 第 2 次');
  assert.equal(formatApiRetryBanner({}), '重试中');
  assert.equal(formatApiRetryBanner(null), '重试中');
});

test('summarizeOtherWorkspaces: 认识 aborted（介于 done 与 error 之间）', () => {
  const dirs = ['/a', '/b'];
  assert.equal(summarizeOtherWorkspaces({ '/a': 'done', '/b': 'aborted' }, dirs, '/cur'), 'aborted');
  assert.equal(summarizeOtherWorkspaces({ '/a': 'aborted', '/b': 'error' }, dirs, '/cur'), 'error');
});

test('projectDisplayName: 顶部/空状态只显示项目名，不显示完整路径', () => {
  assert.equal(projectDisplayName('/Users/you/code/claude-chat-mobile'), 'claude-chat-mobile');
  assert.equal(projectDisplayName('/Users/you/code/claude-chat-mobile/'), 'claude-chat-mobile');
  assert.equal(projectDisplayName(''), '无项目');
  assert.equal(projectDisplayName(null), '无项目');
});

test('shouldShowStartScreen: 仅无实例或无 session 的新会话显示启动页', () => {
  assert.equal(shouldShowStartScreen({ viewingInstanceId: null, sessionId: null }), true);
  assert.equal(shouldShowStartScreen({ viewingInstanceId: 'inst_1', sessionId: null }), true);
  assert.equal(shouldShowStartScreen({ viewingInstanceId: 'inst_1', sessionId: 'abc' }), false);
});

// 空首页枢纽不展示底部输入条：须先选会话或点 ＋ 进入 compose 就绪态。
test('shouldShowComposer: 空首页隐藏；composeReady/有 session/首发在途显示', () => {
  assert.equal(shouldShowComposer({ viewingInstanceId: null, sessionId: null }), false);
  assert.equal(shouldShowComposer({ viewingInstanceId: 'inst_1', sessionId: null }), false);
  assert.equal(shouldShowComposer({ viewingInstanceId: null, sessionId: null, composeReady: true }), true);
  assert.equal(shouldShowComposer({ viewingInstanceId: 'inst_1', sessionId: null, composeReady: true }), true);
  assert.equal(shouldShowComposer({ viewingInstanceId: 'inst_1', sessionId: 'abc' }), true);
  assert.equal(shouldShowComposer({ viewingInstanceId: null, sessionId: null, pendingFirstSend: true }), true);
  // 有 session 时 composeReady 无关
  assert.equal(shouldShowComposer({ viewingInstanceId: 'inst_1', sessionId: 'abc', composeReady: false }), true);
});

// 空首页「最近活跃」：跨全部 workdir 的 session:list 结果合并后按 lastUsedAt 降序取 topN，
// 每条带 cwd + workspaceName，方便一键 session:switch 到任意工作区会话（不必先展开侧栏目录树）。
test('mergeRecentSessionsAcrossWorkspaces: 跨 cwd 合并、按 lastUsedAt 降序截断、补 workspaceName', () => {
  const merged = mergeRecentSessionsAcrossWorkspaces([
    {
      cwd: '/Users/you/code/claude-chat-mobile',
      sessions: [
        { id: 'a1', title: '旧会话 A', lastUsedAt: 1000 },
        { id: 'a2', title: '新会话 A', lastUsedAt: 3000 },
      ],
    },
    {
      cwd: '/Users/you/code/ai_video',
      sessions: [
        { id: 'b1', title: '中会话 B', lastUsedAt: 2000 },
      ],
    },
    {
      cwd: '/Users/you/code/empty',
      sessions: [],
    },
  ], { limit: 2 });
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(s => s.id), ['a2', 'b1']);
  assert.equal(merged[0].cwd, '/Users/you/code/claude-chat-mobile');
  assert.equal(merged[0].workspaceName, 'claude-chat-mobile');
  assert.equal(merged[1].workspaceName, 'ai_video');
  assert.equal(merged[0].title, '新会话 A');
});

test('mergeRecentSessionsAcrossWorkspaces: 缺 lastUsedAt 排后；无 id 跳过；空入参安全', () => {
  const merged = mergeRecentSessionsAcrossWorkspaces([
    {
      cwd: '/x/foo',
      sessions: [
        { id: 'with-time', title: '有时间', lastUsedAt: 50 },
        { id: 'no-time', title: '无时间' },
        { title: '无 id', lastUsedAt: 9999 },
        null,
      ],
    },
  ], { limit: 10 });
  assert.deepEqual(merged.map(s => s.id), ['with-time', 'no-time']);
  assert.equal(merged[1].workspaceName, 'foo');
  assert.deepEqual(mergeRecentSessionsAcrossWorkspaces(null), []);
  assert.deepEqual(mergeRecentSessionsAcrossWorkspaces([]), []);
  assert.deepEqual(mergeRecentSessionsAcrossWorkspaces([{ cwd: '/x', sessions: null }]), []);
});

test('mergeRecentSessionsAcrossWorkspaces: limit 默认 8，非法 limit 回落', () => {
  const many = {
    cwd: '/x/p',
    sessions: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: `t${i}`, lastUsedAt: i + 1 })),
  };
  assert.equal(mergeRecentSessionsAcrossWorkspaces([many]).length, 8);
  assert.equal(mergeRecentSessionsAcrossWorkspaces([many], { limit: 0 }).length, 8);
  assert.equal(mergeRecentSessionsAcrossWorkspaces([many], { limit: -1 }).length, 8);
  assert.equal(mergeRecentSessionsAcrossWorkspaces([many], { limit: 3 }).length, 3);
  // 最新应是 lastUsedAt 最大
  assert.equal(mergeRecentSessionsAcrossWorkspaces([many], { limit: 1 })[0].id, 's11');
});

// 新会话首发的乐观 busy（"正在执行任务"）在服务端懒开实例并广播 instances 后，会被 setInstances→bindView→
// clearView 的 setBusy(false) 冲掉，直到首个 delta 才重现（已有会话发消息因不触发 bindView 而无此问题）。
// 仅当：发送时置了首发标志 + 已绑定到新实例 + 该实例尚无 sessionId（=新建 FRESH、SDK init 未回，区别于
// session:switch 打开的已有会话）时，应在 bindView 后同步补回 busy。
test('shouldRestoreOptimisticBusy: 仅新会话首发懒开绑定到新建实例(无 sessionId)时补回乐观 busy', () => {
  assert.equal(shouldRestoreOptimisticBusy({ pendingFirstSend: true, viewingInstanceId: 'inst_1', sessionId: null }), true);
  // 无标志（已有会话发消息/普通状态刷新）：不补
  assert.equal(shouldRestoreOptimisticBusy({ pendingFirstSend: false, viewingInstanceId: 'inst_1', sessionId: null }), false);
  // session:switch 打开已有会话（有 sessionId）：不补，避免给 idle 会话误显 busy
  assert.equal(shouldRestoreOptimisticBusy({ pendingFirstSend: true, viewingInstanceId: 'inst_1', sessionId: 'abc' }), false);
  // 仍是空首页（懒开广播尚未到，viewing 仍为空）：不补
  assert.equal(shouldRestoreOptimisticBusy({ pendingFirstSend: true, viewingInstanceId: null, sessionId: null }), false);
  // 空/未定义入参安全
  assert.equal(shouldRestoreOptimisticBusy(), false);
});

// externalDirty / effort 等同会话静默换实例：send() 已 setBusy(true)，随后 dispose+resume 换 instanceId、
// sessionId 不变 → bindView→clearView 冲掉 busy。须靠 pendingSendBusy + 同 sessionId 补回。
// 注意：有 sessionId 时不得仅凭 pendingFirstSend 补回（那是 session:switch 打开已有会话的误伤面）。
test('shouldRestoreOptimisticBusy: 同会话静默换实例且 pendingSendBusy 时补回乐观 busy', () => {
  assert.equal(shouldRestoreOptimisticBusy({
    pendingSendBusy: true,
    viewingInstanceId: 'inst_new',
    sessionId: 'sess_1',
    prevSessionId: 'sess_1',
  }), true);
  // 真切到另一会话：不补（避免把 A 的发送态挂到 B）
  assert.equal(shouldRestoreOptimisticBusy({
    pendingSendBusy: true,
    viewingInstanceId: 'inst_b',
    sessionId: 'sess_b',
    prevSessionId: 'sess_a',
  }), false);
  // 无 pendingSendBusy（纯 effort 切档且用户未在发送窗口）：不补
  assert.equal(shouldRestoreOptimisticBusy({
    pendingSendBusy: false,
    viewingInstanceId: 'inst_new',
    sessionId: 'sess_1',
    prevSessionId: 'sess_1',
  }), false);
  // 缺 prevSessionId：无法判定同会话，不补（bindView 内首发路径也不应误命中 swap 分支）
  assert.equal(shouldRestoreOptimisticBusy({
    pendingSendBusy: true,
    viewingInstanceId: 'inst_new',
    sessionId: 'sess_1',
  }), false);
  // pendingFirstSend + 有 sessionId 仍不补（保持 session:switch 护栏）
  assert.equal(shouldRestoreOptimisticBusy({
    pendingFirstSend: true,
    pendingSendBusy: false,
    viewingInstanceId: 'inst_1',
    sessionId: 'sess_1',
    prevSessionId: 'sess_1',
  }), false);
});

// bindView 切视图时是否该清空输入框未发送草稿。思考强度/模型切档会让后端 dispose 旧实例 + resume 同会话
// 开新实例（instanceId 变了、sessionId 不变），这只是底层实例被静默替换、用户视角仍在同一个聊天里——
// 此时清空草稿是误伤（真实 bug：切效果强度/模型会清空正在输入的指令）。真正切到另一个会话/全新未开会话
// 才应该清空（用户明确导航离开，草稿属于旧会话）。
test('shouldClearInputOnBindView: 同一会话静默换实例保留草稿，真实切会话才清空', () => {
  // 同一非空 sessionId（effort/model 触发的 dispose+recreate，同会话换了个 instanceId）：保留草稿
  assert.equal(shouldClearInputOnBindView({ prevSessionId: 'sess_1', newSessionId: 'sess_1' }), false);
  // 真实切到另一个已有会话：清空
  assert.equal(shouldClearInputOnBindView({ prevSessionId: 'sess_1', newSessionId: 'sess_2' }), true);
  // 切到全新未开会话（newSessionId 尚无）：清空
  assert.equal(shouldClearInputOnBindView({ prevSessionId: 'sess_1', newSessionId: null }), true);
  // 从空首页首次绑定到会话：清空（无「同一会话」可言）
  assert.equal(shouldClearInputOnBindView({ prevSessionId: null, newSessionId: 'sess_1' }), true);
  // 两端都空（新会话间切换/初始态）：清空，无法判定是否同一草稿归属
  assert.equal(shouldClearInputOnBindView({ prevSessionId: null, newSessionId: null }), true);
  // 空/未定义入参安全：默认清空（保守，不吞真实切换场景）
  assert.equal(shouldClearInputOnBindView(), true);
});

// bindView 切会话时未发送草稿（文字 + 附件）按 sessionId 存/取。
// 与 shouldClearInputOnBindView 同判定边界：同会话静默换实例 = keep；真实导航 = swap（存旧取新）。
test('planSessionDraftSwap: 同会话 keep；切会话存旧草稿并恢复目标会话草稿', () => {
  const attB = [{ _id: 'b1', name: 'b.png', mimeType: 'image/png', size: 10, data: 'x' }];
  const drafts = new Map([['sess_2', { text: '已缓存的 B 草稿', attachments: attB }]]);
  // 同会话静默换实例：不碰输入/附件、不读写缓存
  assert.deepEqual(
    planSessionDraftSwap({
      prevSessionId: 'sess_1', newSessionId: 'sess_1',
      currentDraft: '正在写', currentAttachments: [{ _id: 'a' }], drafts,
    }),
    { action: 'keep' },
  );
  // A→B：把 A 当前输入+附件存走，恢复 B 的缓存
  const attA = [{ _id: 'a1', name: 'a.txt', mimeType: 'text/plain', size: 3, data: 'abc' }];
  assert.deepEqual(
    planSessionDraftSwap({
      prevSessionId: 'sess_1', newSessionId: 'sess_2',
      currentDraft: 'A 的草稿', currentAttachments: attA, drafts,
    }),
    {
      action: 'swap',
      save: { sessionId: 'sess_1', text: 'A 的草稿', attachments: attA },
      restoreText: '已缓存的 B 草稿',
      restoreAttachments: attB,
    },
  );
  // A→B 但 B 无缓存：存 A，文字/附件都置空
  assert.deepEqual(
    planSessionDraftSwap({
      prevSessionId: 'sess_1', newSessionId: 'sess_2',
      currentDraft: 'A 的草稿', currentAttachments: attA, drafts: new Map(),
    }),
    {
      action: 'swap',
      save: { sessionId: 'sess_1', text: 'A 的草稿', attachments: attA },
      restoreText: '',
      restoreAttachments: [],
    },
  );
  // A→新会话(null)：存 A，恢复空
  assert.deepEqual(
    planSessionDraftSwap({
      prevSessionId: 'sess_1', newSessionId: null,
      currentDraft: 'A 的草稿', currentAttachments: attA, drafts,
    }),
    {
      action: 'swap',
      save: { sessionId: 'sess_1', text: 'A 的草稿', attachments: attA },
      restoreText: '',
      restoreAttachments: [],
    },
  );
  // 空首页→会话：无从存，恢复该会话缓存（若有）
  assert.deepEqual(
    planSessionDraftSwap({
      prevSessionId: null, newSessionId: 'sess_2',
      currentDraft: '首页乱打', currentAttachments: attA, drafts,
    }),
    { action: 'swap', save: null, restoreText: '已缓存的 B 草稿', restoreAttachments: attB },
  );
  // 两端都空 / 未定义：swap 到空，不存
  assert.deepEqual(
    planSessionDraftSwap({ prevSessionId: null, newSessionId: null, currentDraft: 'x' }),
    { action: 'swap', save: null, restoreText: '', restoreAttachments: [] },
  );
  assert.deepEqual(planSessionDraftSwap(), { action: 'swap', save: null, restoreText: '', restoreAttachments: [] });
  // currentDraft 非字符串 / currentAttachments 非数组：安全归一
  const bad = planSessionDraftSwap({ prevSessionId: 's', newSessionId: 't', currentDraft: null, currentAttachments: null });
  assert.equal(bad.save.text, '');
  assert.deepEqual(bad.save.attachments, []);
  // 存出的 attachments 是浅拷贝，改入参数组不影响 save
  const mutable = [{ _id: 'm' }];
  const saved = planSessionDraftSwap({
    prevSessionId: 's', newSessionId: 't', currentDraft: '', currentAttachments: mutable,
  }).save.attachments;
  mutable.push({ _id: 'extra' });
  assert.equal(saved.length, 1);
  // 旧缓存形态（纯 string）兼容：当文字恢复，附件空
  assert.deepEqual(
    planSessionDraftSwap({
      prevSessionId: 'a', newSessionId: 'legacy', currentDraft: '',
      drafts: new Map([['legacy', '旧纯文字']]),
    }),
    { action: 'swap', save: { sessionId: 'a', text: '', attachments: [] }, restoreText: '旧纯文字', restoreAttachments: [] },
  );
});

// 已答提问 requestId 忽略判定（防切会话/sync 重弹）
test('isAnsweredQuestionId: 精确命中 / 整组 toolUseID 覆盖 #i / 安全默认', () => {
  const ids = new Set(['tool_a#0', 'tool_b']);
  assert.equal(isAnsweredQuestionId('tool_a#0', ids), true);
  assert.equal(isAnsweredQuestionId('tool_a#1', ids), false); // 仅 #0 入库时 #1 不覆盖
  assert.equal(isAnsweredQuestionId('tool_b#0', ids), true);  // 整组 tool_b → 所有 #i
  assert.equal(isAnsweredQuestionId('tool_b#9', ids), true);
  assert.equal(isAnsweredQuestionId('tool_b', ids), true);
  assert.equal(isAnsweredQuestionId('other#0', ids), false);
  assert.equal(isAnsweredQuestionId('tool_a#0', null), false);
  assert.equal(isAnsweredQuestionId('', ids), false);
  assert.equal(isAnsweredQuestionId(null, ids), false);
});

// ── 客户端事件分流（app.js: agent:event 入口；台阶3 instanceId 分流）──
// 回归：从活跃会话切到「新会话空窗口」(viewingInstanceId=null) 时，后台活跃实例的 tool_use/tool_result/
// user_message/result 等带 instanceId 事件，曾因旧逻辑 `viewingInstanceId &&` 在 null 时短路而不被过滤，
// 污染空窗口（显示别的工作区会话的上下文）。修复：用独立的 instancesReady 标志区分「视图未知（首个
// instances 广播前，应放行重放）」与「视图已知且为 null（新会话懒开，应过滤一切带 instanceId 的后台事件）」。
test('shouldDropAgentEvent: instances 合成事件永不丢（它定义 viewingInstanceId 本身）', () => {
  assert.equal(shouldDropAgentEvent({ type: 'instances', instanceId: 'inst_A' }, null, true), false);
  assert.equal(shouldDropAgentEvent({ type: 'instances', instanceId: 'inst_B' }, 'inst_A', true), false);
});

test('shouldDropAgentEvent: 无 instanceId 的合成事件（status_line/init 重放/models）永不丢', () => {
  assert.equal(shouldDropAgentEvent({ type: 'status_line' }, 'inst_A', true), false);
  assert.equal(shouldDropAgentEvent({ type: 'models', instanceId: '' }, null, true), false);
});

test('shouldDropAgentEvent: 视图未知（首个 instances 前 ready=false）放行重放批次', () => {
  assert.equal(shouldDropAgentEvent({ type: 'tool_use', instanceId: 'inst_A' }, null, false), false);
  assert.equal(shouldDropAgentEvent({ type: 'text_delta', instanceId: 'inst_A' }, 'inst_A', false), false);
});

test('shouldDropAgentEvent: 当前查看实例的事件放行', () => {
  assert.equal(shouldDropAgentEvent({ type: 'text_delta', instanceId: 'inst_A' }, 'inst_A', true), false);
  assert.equal(shouldDropAgentEvent({ type: 'tool_result', instanceId: 'inst_A' }, 'inst_A', true), false);
});

test('shouldDropAgentEvent: 已知视图下非当前实例的事件丢弃', () => {
  assert.equal(shouldDropAgentEvent({ type: 'tool_use', instanceId: 'inst_B' }, 'inst_A', true), true);
});

test('shouldDropAgentEvent: 回归——新会话空窗口(viewing=null, ready=true) 丢弃后台活跃实例事件（防污染）', () => {
  // 旧逻辑 `viewingInstanceId &&` 在 viewing=null 时短路 → 返回 false（不丢）→ 污染空窗口。
  assert.equal(shouldDropAgentEvent({ type: 'tool_use', instanceId: 'inst_A' }, null, true), true);
  assert.equal(shouldDropAgentEvent({ type: 'tool_result', instanceId: 'inst_A' }, null, true), true);
  assert.equal(shouldDropAgentEvent({ type: 'user_message', instanceId: 'inst_A' }, null, true), true);
  assert.equal(shouldDropAgentEvent({ type: 'result', instanceId: 'inst_A' }, null, true), true);
});



test('modelEntryFor: 精确命中（字符串与对象）', () => {
  assert.equal(modelEntryFor('claude-opus-4-8', ['claude-opus-4-8']), 'claude-opus-4-8');
  const obj = { value: 'x' };
  assert.equal(modelEntryFor('x', [obj]), obj);
});

test('modelEntryFor: 后缀桥接（规范名 → 候选别名）', () => {
  const entry = { value: 'opus[1m]', supportedEffortLevels: ['low', 'high'] };
  assert.equal(modelEntryFor('claude-opus-4-8[1m]', [entry]), entry); // [1m] 后缀相等 + base 含 'opus'
  const bare = { value: 'opus' };
  assert.equal(modelEntryFor('claude-opus-4-8', [bare]), bare);       // 无后缀也桥接
});

test('modelEntryFor: 无命中 / 空列表 / 空值 → null', () => {
  assert.equal(modelEntryFor('claude-sonnet-4-6', [{ value: 'opus[1m]' }]), null); // 后缀不等
  assert.equal(modelEntryFor('x', []), null);
  assert.equal(modelEntryFor('', [{ value: 'x' }]), null);
  assert.equal(modelEntryFor('x', undefined), null);
});

test('modelEntryFor: 子串误匹配防护——mBase 在 base 中间出现但不是模型名边界', () => {
  const list = [{ value: 'deepseek-v3' }];
  // 'deepseek-v3.1' 包含 'deepseek-v3' 子串，但 .1 不是 [Nm] 后缀 → 不应误匹配
  assert.equal(modelEntryFor('deepseek-v3.1', list), null, '.1 后缀非 [Nm] → 不匹配');
  // 精确匹配不受影响
  assert.equal(modelEntryFor('deepseek-v3', list), list[0], '精确命中照常');
});

test('effortLevelsFor: 模型支持 → 列其档', () => {
  const ml = [{ value: 'opus[1m]', supportedEffortLevels: ['low', 'high', 'max'] }];
  assert.deepEqual(effortLevelsFor('opus[1m]', ml), { hidden: false, levels: ['low', 'high', 'max'] });
});

test('effortLevelsFor: 桥接后取档', () => {
  const ml = [{ value: 'opus[1m]', supportedEffortLevels: ['low', 'max'] }];
  assert.deepEqual(effortLevelsFor('claude-opus-4-8[1m]', ml), { hidden: false, levels: ['low', 'max'] });
});

test('effortLevelsFor: 解析到但不支持（haiku）→ hidden', () => {
  assert.deepEqual(effortLevelsFor('haiku', [{ value: 'haiku', supportedEffortLevels: [] }]), { hidden: true, levels: [] });
  assert.deepEqual(effortLevelsFor('haiku', [{ value: 'haiku' }]), { hidden: true, levels: [] }); // 无 supportedEffortLevels 字段
});

test('effortLevelsFor: 解析不到 → 全候选并集，不隐藏', () => {
  const ml = [{ value: 'opus[1m]', supportedEffortLevels: ['low', 'high'] }, { value: 'sonnet', supportedEffortLevels: ['low', 'medium'] }];
  const r = effortLevelsFor('unknown-xyz', ml);
  assert.equal(r.hidden, false);
  assert.deepEqual([...r.levels].sort(), ['high', 'low', 'medium']); // 并集（去重）
});

test('effortUiState: CLI 镜像档位未知时保持未知，不得从候选列表猜成 low', () => {
  assert.deepEqual(
    effortUiState(null, ['low', 'medium', 'high', 'max'], { mirrorReadonly: true }),
    {
      level: null,
      selected: '',
      label: 'CLI 档位未知',
      placeholder: 'CLI 当前档未知',
    },
  );
});

test('resolvePanelState: CLI 镜像观察值未知时不得回退 Web 的模型、模式或 effort', () => {
  assert.deepEqual(resolvePanelState({
    mirrorReadonly: true,
    observedCli: { model: null, permissionMode: null, effort: null },
    web: { model: 'Fable', permissionMode: 'bypassPermissions', effort: 'low' },
  }), {
    source: 'cli',
    model: null,
    permissionMode: null,
    effort: null,
  });
});

test('resolvePanelState: CLI 镜像态完整透传观察到的模型、模式与 effort', () => {
  assert.deepEqual(resolvePanelState({
    mirrorReadonly: true,
    observedCli: { model: 'claude-opus-4-8[1m]', permissionMode: 'auto', effort: 'max' },
    web: { model: 'Fable', permissionMode: 'bypassPermissions', effort: 'low' },
  }), {
    source: 'cli',
    model: 'claude-opus-4-8[1m]',
    permissionMode: 'auto',
    effort: 'max',
  });
});

test('resolvePanelState: 接管后整组恢复 Web 偏好，不把 CLI 观察值写回', () => {
  assert.deepEqual(resolvePanelState({
    mirrorReadonly: false,
    observedCli: { model: 'cli-model', permissionMode: 'auto', effort: 'max' },
    web: { model: 'web-model', permissionMode: 'plan', effort: 'high' },
  }), {
    source: 'web',
    model: 'web-model',
    permissionMode: 'plan',
    effort: 'high',
  });
});
