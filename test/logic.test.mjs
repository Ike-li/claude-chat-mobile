// test/logic.test.mjs —— public/js/logic.js 纯逻辑单测（node 内置 test runner，零依赖）。
// 跑法：npm test （= node --test）。覆盖 model 桥接 / effort 档位 / 状态优先级 / ANSI 配平 / esc。
// 不覆盖 DOM 接线与 iOS/Safari 平台行为（归 npm run check + 真机），见 docs/design.md 验收纪律。
import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, formatToolSummary, pickPasteImageFiles, attachmentDataUrl, toolPreviewLabel, modelEntryFor, effortLevelsFor, aggregateStates, summarizeOtherWorkspaces, ansiToHtml, projectDisplayName, shouldShowStartScreen, shouldRestoreOptimisticBusy, shouldClearInputOnBindView, shouldDropAgentEvent, urlBase64ToUint8Array, foregroundReconnectAction, syncAckAction, shouldReloadOnEnter, sessionDomCachePlan, keyboardInsetPadding, logEntryVisibleForInstance, consoleLogEntryLayout, defaultModelTileLabel, withUltracodeKeyword, withUltracodeTier, resolveEffortSelection, pushEnvHint, resolveDeepLinkTarget, armedTakeoverStep, formatRttMs, rttToneClass, presentTurnResult, formatApiRetryBanner, formatContextCategories, detectServiceRestart, formatServiceNotices, parseUsageForWeb } from '../public/js/logic.js';
import { createRingBuffer } from '../public/js/ring-buffer.js';

test.describe('parseUsageForWeb（③ 套餐额度窗后端：提取 rate_limits + 降级 + 剔除隐私）', () => {
  // 一份"订阅认证 max、额度可用"的典型 usage（结构照 SDKControlGetUsageResponse 运行时形态）
  const fullUsage = () => ({
    session: { total_cost_usd: 1.23, total_api_duration_ms: 100, total_duration_ms: 200, model_usage: {} },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 42, resets_at: '2026-07-14T20:00:00Z' },
      seven_day: { utilization: 15, resets_at: '2026-07-20T00:00:00Z' },
      seven_day_opus: { utilization: 8, resets_at: '2026-07-20T00:00:00Z' },
      seven_day_sonnet: { utilization: 3, resets_at: '2026-07-20T00:00:00Z' },
      model_scoped: [{ display_name: 'Fable', utilization: 10, resets_at: '2026-07-20T00:00:00Z' }],
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    },
    behaviors: { day: { request_count: 999, session_count: 7 }, skills: [{ name: 'secret-skill' }] },
  });

  test('null / undefined / 非对象 → { available:false }（降级，不给额度窗）', () => {
    assert.deepEqual(parseUsageForWeb(null), { available: false });
    assert.deepEqual(parseUsageForWeb(undefined), { available: false });
    assert.deepEqual(parseUsageForWeb('x'), { available: false });
  });

  test('rate_limits_available:false（第三方 provider）→ { available:false }，即便 rate_limits 有值也不外露', () => {
    const u = fullUsage(); u.rate_limits_available = false;
    assert.deepEqual(parseUsageForWeb(u), { available: false });
  });

  test('剔除 behaviors 隐私（本机使用画像绝不外露）', () => {
    const r = parseUsageForWeb(fullUsage());
    assert.equal('behaviors' in r, false, 'behaviors 不得出现在输出');
    const json = JSON.stringify(r);
    assert.equal(json.includes('behaviors'), false);
    assert.equal(json.includes('secret-skill'), false);
    assert.equal(json.includes('request_count'), false);
  });

  test('提取五类命名额度窗 + model_scoped 数组（utilization / resetsAt / displayName）', () => {
    const r = parseUsageForWeb(fullUsage());
    assert.equal(r.available, true);
    assert.equal(r.rateLimits.five_hour.utilization, 42);
    assert.equal(r.rateLimits.five_hour.resetsAt, '2026-07-14T20:00:00Z');
    assert.equal(r.rateLimits.seven_day.utilization, 15);
    assert.equal(r.rateLimits.seven_day_opus.utilization, 8);
    assert.equal(r.rateLimits.seven_day_sonnet.utilization, 3);
    assert.equal(Array.isArray(r.rateLimits.model_scoped), true);
    assert.equal(r.rateLimits.model_scoped[0].displayName, 'Fable');
    assert.equal(r.rateLimits.model_scoped[0].utilization, 10);
  });

  test('保留 subscriptionType + session.totalCostUsd（非隐私）', () => {
    const r = parseUsageForWeb(fullUsage());
    assert.equal(r.subscriptionType, 'max');
    assert.equal(r.session.totalCostUsd, 1.23);
  });

  test('utilization:0 是有效值（刚开始用）不被当 falsy 丢弃', () => {
    const u = fullUsage(); u.rate_limits.five_hour.utilization = 0;
    assert.equal(parseUsageForWeb(u).rateLimits.five_hour.utilization, 0);
  });

  test('防御性：rate_limits 为 null（available:true 但无窗）→ available:true、无 rateLimits 键、不崩', () => {
    const u = fullUsage(); u.rate_limits = null;
    const r = parseUsageForWeb(u);
    assert.equal(r.available, true);
    assert.equal('rateLimits' in r, false);
  });

  test('防御性：单窗字段缺失 / 非法（utilization 非数、resets_at 非串、窗为 null）→ 跳过该窗不崩', () => {
    const u = fullUsage();
    u.rate_limits.five_hour = { utilization: 'oops', resets_at: 123 };
    u.rate_limits.seven_day = null;
    const r = parseUsageForWeb(u);
    assert.equal('five_hour' in r.rateLimits, false, 'utilization 非数 + resets_at 非串 → 整窗省略');
    assert.equal('seven_day' in r.rateLimits, false, 'null 窗省略');
    assert.equal(r.rateLimits.seven_day_opus.utilization, 8, '其余窗不受影响');
  });
});

test.describe('formatContextCategories: SDK ctx categories → 过滤/降序/pct 展示行（Part3）', () => {
  test('按 tokens 降序、过滤 0/负、算 pct（相对 maxTokens）', () => {
    const cats = [
      { name: 'Skills', tokens: 5000, color: '#a' },
      { name: 'Free space', tokens: 195000, color: '#b' },
      { name: 'Empty', tokens: 0, color: '#c' },
    ];
    assert.deepEqual(formatContextCategories(cats, 200000), [
      { name: 'Free space', tokens: 195000, pct: 98, deferred: false }, // 195k/200k=97.5→98
      { name: 'Skills', tokens: 5000, pct: 3, deferred: false },        // 5k/200k=2.5→3
    ]);
  });
  test('isDeferred 透传', () => {
    assert.deepEqual(formatContextCategories([{ name: 'MCP', tokens: 100, isDeferred: true }], 1000), [{ name: 'MCP', tokens: 100, pct: 10, deferred: true }]);
  });
  test('无/非法 maxTokens → pct=null（仍给 name/tokens）', () => {
    assert.deepEqual(formatContextCategories([{ name: 'X', tokens: 100 }], null), [{ name: 'X', tokens: 100, pct: null, deferred: false }]);
    assert.deepEqual(formatContextCategories([{ name: 'X', tokens: 100 }], 0), [{ name: 'X', tokens: 100, pct: null, deferred: false }]);
  });
  test('非数组 / 空 → []', () => {
    assert.deepEqual(formatContextCategories(null, 1000), []);
    assert.deepEqual(formatContextCategories([], 1000), []);
    assert.deepEqual(formatContextCategories(undefined, 1000), []);
  });
  test('过滤缺 name / 非有限 tokens 的坏项', () => {
    assert.deepEqual(formatContextCategories([{ tokens: 100 }, { name: 'ok', tokens: 50 }, { name: 'bad', tokens: NaN }], 1000), [{ name: 'ok', tokens: 50, pct: 5, deferred: false }]);
  });
});

test('esc: 转义 HTML 元字符', () => {
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(5), '5');
});

// 工具卡片摘要可读化：agent 侧 stringify 是紧凑单行，手机展开一坨难读。
// formatToolSummary 只负责「能 parse 的 JSON → 缩进 pretty；非 JSON/空 → 原样」，不碰 DOM/hljs。
test('formatToolSummary: 紧凑 JSON 对象 → 2 空格缩进', () => {
  const raw = '{"file_path":"/a.js","old_string":"x"}';
  assert.equal(formatToolSummary(raw), '{\n  "file_path": "/a.js",\n  "old_string": "x"\n}');
});

test('formatToolSummary: JSON 数组同样 pretty', () => {
  assert.equal(formatToolSummary('[1,{"a":2}]'), '[\n  1,\n  {\n    "a": 2\n  }\n]');
});

test('formatToolSummary: 非 JSON 纯文本原样返回（Bash 命令、脱敏占位符、错误文案）', () => {
  assert.equal(formatToolSummary('ls -la /tmp'), 'ls -la /tmp');
  assert.equal(formatToolSummary('（base64 数据，约 48KB，已省略）'), '（base64 数据，约 48KB，已省略）');
  assert.equal(formatToolSummary('Error: permission denied'), 'Error: permission denied');
});

test('formatToolSummary: 截断后的残缺 JSON 不抛、原样返回（agent 的 TOOL_SUMMARY_CAP 会切尾）', () => {
  const truncated = '{"file_path":"/a.js","content":"hello wor'; // 缺闭合
  assert.equal(formatToolSummary(truncated), truncated);
});

test('formatToolSummary: 空/非字符串安全', () => {
  assert.equal(formatToolSummary(''), '');
  assert.equal(formatToolSummary(null), '');
  assert.equal(formatToolSummary(undefined), '');
  assert.equal(formatToolSummary(42), '42');
});

// 剪贴板粘贴图片：桌面 Chrome 截图/复制图后 Ctrl/Cmd+V 应进附件托盘。
// pickPasteImageFiles 只从 DataTransfer 里挑 image/* 文件项；纯文本粘贴返回空，交给浏览器默认。
test('pickPasteImageFiles: 无 clipboardData / 空 items → 空数组', () => {
  assert.deepEqual(pickPasteImageFiles(null), []);
  assert.deepEqual(pickPasteImageFiles({}), []);
  assert.deepEqual(pickPasteImageFiles({ items: [] }), []);
});

test('pickPasteImageFiles: 纯文本粘贴 → 空（不拦截默认粘贴文字）', () => {
  const items = [{ kind: 'string', type: 'text/plain', getAsFile: () => null }];
  assert.deepEqual(pickPasteImageFiles({ items }), []);
});

test('pickPasteImageFiles: image/png file 项 → 取出 File', () => {
  const file = { name: 'clip.png', type: 'image/png', size: 12 };
  const items = [
    { kind: 'string', type: 'text/plain', getAsFile: () => null },
    { kind: 'file', type: 'image/png', getAsFile: () => file },
  ];
  assert.deepEqual(pickPasteImageFiles({ items }), [file]);
});

test('pickPasteImageFiles: 多张图按顺序收集；非图片 file 跳过；getAsFile 空跳过', () => {
  const a = { name: 'a.png', type: 'image/png', size: 1 };
  const b = { name: 'b.jpeg', type: 'image/jpeg', size: 2 };
  const items = [
    { kind: 'file', type: 'image/png', getAsFile: () => a },
    { kind: 'file', type: 'application/pdf', getAsFile: () => ({ name: 'x.pdf', type: 'application/pdf' }) },
    { kind: 'file', type: 'image/jpeg', getAsFile: () => null },
    { kind: 'file', type: 'image/jpeg', getAsFile: () => b },
  ];
  assert.deepEqual(pickPasteImageFiles({ items }), [a, b]);
});

test('pickPasteImageFiles: items 不是可迭代 → 空数组，不抛', () => {
  assert.deepEqual(pickPasteImageFiles({ items: null }), []);
  assert.deepEqual(pickPasteImageFiles({ items: 42 }), []);
});

// 发送前点托盘附件预览：用完整 base64 拼 data URI（比 thumb 清晰）；非图片/无 data → null。
test('attachmentDataUrl: 图片 + base64 → data URI', () => {
  assert.equal(
    attachmentDataUrl({ mimeType: 'image/png', data: 'abc123' }),
    'data:image/png;base64,abc123'
  );
});

test('attachmentDataUrl: 非图片 / 缺 data → null（托盘不弹灯箱）', () => {
  assert.equal(attachmentDataUrl({ mimeType: 'application/pdf', data: 'abc' }), null);
  assert.equal(attachmentDataUrl({ mimeType: 'image/jpeg', data: '' }), null);
  assert.equal(attachmentDataUrl({ mimeType: 'image/jpeg' }), null);
  assert.equal(attachmentDataUrl(null), null);
});

test('attachmentDataUrl: mime 缺省但 data 在 → 不猜成图片，返回 null', () => {
  // 没有 image/* 类型就不当图片预览，避免把任意 base64 当图打开
  assert.equal(attachmentDataUrl({ data: 'abc' }), null);
  assert.equal(attachmentDataUrl({ mimeType: 'application/octet-stream', data: 'abc' }), null);
});

// 工具卡片预览入口：Read 只读文件、Edit/Write 才是变更——文案不能写死「预览变更」
test('toolPreviewLabel: Read / changeKind=read → 预览文件', () => {
  assert.match(toolPreviewLabel({ name: 'Read' }), /预览文件/);
  assert.match(toolPreviewLabel({ changeKind: 'read' }), /预览文件/);
  assert.ok(!toolPreviewLabel({ name: 'Read' }).includes('变更'));
});

test('toolPreviewLabel: Edit/Write/MultiEdit/NotebookEdit → 预览变更', () => {
  assert.match(toolPreviewLabel({ name: 'Edit', changeKind: 'edit' }), /预览变更/);
  assert.match(toolPreviewLabel({ name: 'Write', changeKind: 'write' }), /预览变更/);
  assert.match(toolPreviewLabel({ name: 'MultiEdit', changeKind: 'multiedit' }), /预览变更/);
  assert.match(toolPreviewLabel({ name: 'NotebookEdit', changeKind: 'notebook' }), /预览变更/);
});

test('toolPreviewLabel: changeKind 优先于 name（防前端只传一种字段）', () => {
  assert.match(toolPreviewLabel({ name: 'Edit', changeKind: 'read' }), /预览文件/);
  assert.match(toolPreviewLabel({ name: 'Read', changeKind: 'edit' }), /预览变更/);
});

test('toolPreviewLabel: 缺省安全，不抛', () => {
  assert.match(toolPreviewLabel(), /预览/);
  assert.match(toolPreviewLabel(null), /预览/);
});

test('withUltracodeKeyword: 单轮 ultracode 关键词前缀且不重复', () => {
  assert.equal(withUltracodeKeyword('重构日期工具'), 'ultracode 重构日期工具');
  assert.equal(withUltracodeKeyword('  重构日期工具  '), 'ultracode 重构日期工具');
  assert.equal(withUltracodeKeyword('ultracode 重构日期工具'), 'ultracode 重构日期工具');
  assert.equal(withUltracodeKeyword('UltraCode 重构日期工具'), 'UltraCode 重构日期工具');
  assert.equal(withUltracodeKeyword(''), 'ultracode');
});

// ultracode 是 CLI /effort 菜单 xhigh 之上的最高档（= xhigh effort + workflow 编排），
// 仅在支持 xhigh 的模型上出现。这两个纯函数把「档位列表拼装」与「选中后的行为解析」抽出可测。
test('withUltracodeTier: 含 xhigh 才追加 ultracode 最高档（镜像 CLI /effort），幂等', () => {
  assert.deepEqual(withUltracodeTier(['low', 'medium', 'high', 'xhigh']), ['low', 'medium', 'high', 'xhigh', 'ultracode']);
  assert.deepEqual(withUltracodeTier(['low', 'medium']), ['low', 'medium']); // 无 xhigh → 该模型不够格，不加
  assert.deepEqual(withUltracodeTier([]), []);
  assert.deepEqual(withUltracodeTier(['low', 'xhigh', 'ultracode']), ['low', 'xhigh', 'ultracode']); // 已含 → 不重复
  assert.deepEqual(withUltracodeTier(null), []);
});

test('resolveEffortSelection: ultracode 档借道 xhigh + 武装关键词，其余档不武装', () => {
  assert.deepEqual(resolveEffortSelection('ultracode'), { effort: 'xhigh', ultracode: true });
  assert.deepEqual(resolveEffortSelection('xhigh'), { effort: 'xhigh', ultracode: false });
  assert.deepEqual(resolveEffortSelection('low'), { effort: 'low', ultracode: false });
  assert.deepEqual(resolveEffortSelection(''), { effort: null, ultracode: false });
  assert.deepEqual(resolveEffortSelection(null), { effort: null, ultracode: false });
});

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

test('ansiToHtml: 纯文本被 esc', () => {
  assert.equal(ansiToHtml('a<b>'), 'a&lt;b&gt;');
});

test('ansiToHtml: 24-bit 前景色 → span', () => {
  assert.equal(ansiToHtml('\x1b[38;2;255;0;0mhi\x1b[0m'), '<span style="color:rgb(255,0,0)">hi</span>');
});

test('ansiToHtml: 未闭合 span 结尾配平', () => {
  assert.equal(ansiToHtml('\x1b[38;2;1;2;3mhi'), '<span style="color:rgb(1,2,3)">hi</span>');
});

test('ansiToHtml: \\x1b[m 空 reset 也闭合', () => {
  assert.equal(ansiToHtml('\x1b[38;2;0;0;0mx\x1b[m'), '<span style="color:rgb(0,0,0)">x</span>');
});

test('ansiToHtml: 非颜色 SGR 吞序列、保留文本、不留游离 span', () => {
  assert.equal(ansiToHtml('\x1b[1mbold\x1b[0m'), 'bold');
});

// ---- ring-buffer 环形缓冲 ----
test('createRingBuffer: push + toArray + 基本读写', () => {
  const b = createRingBuffer(3);
  assert.equal(b.size(), 0);
  b.push('a');
  assert.equal(b.size(), 1);
  assert.deepEqual(b.toArray(), ['a']);
  b.push('b'); b.push('c');
  assert.deepEqual(b.toArray(), ['a', 'b', 'c']);
});

test('createRingBuffer: 溢出：保留最新 N 条', () => {
  const b = createRingBuffer(3);
  b.push('a'); b.push('b'); b.push('c'); b.push('d');
  assert.equal(b.size(), 3);
  assert.deepEqual(b.toArray(), ['b', 'c', 'd']);
});

test('createRingBuffer: clear + isEmpty', () => {
  const b = createRingBuffer(3);
  b.push('x'); b.push('y');
  assert.equal(b.isEmpty(), false);
  b.clear();
  assert.equal(b.isEmpty(), true);
  assert.equal(b.size(), 0);
  assert.deepEqual(b.toArray(), []);
});

test('createRingBuffer: head/tail（首尾查看不取出）', () => {
  const b = createRingBuffer(3);
  b.push('first'); b.push('second');
  assert.equal(b.head(), 'first');
  assert.equal(b.tail(), 'second');
  b.push('third'); b.push('fourth'); // 'first' 溢出
  assert.equal(b.head(), 'second');
  assert.equal(b.tail(), 'fourth');
});

test('createRingBuffer: cap=0 永不存储', () => {
  const b = createRingBuffer(0);
  b.push('x');
  assert.equal(b.isEmpty(), true);
  assert.equal(b.size(), 0);
});

test('createRingBuffer: cap=1 边界', () => {
  const b = createRingBuffer(1);
  b.push('a'); b.push('b');
  assert.equal(b.size(), 1);
  assert.equal(b.head(), 'b');
  assert.equal(b.tail(), 'b');
});

// ---- urlBase64ToUint8Array：VAPID 公钥解码（E15） ----
test('urlBase64ToUint8Array: 标准 URL-safe base64 解码', () => {
  // "AQAB" in URL-safe base64 without padding → Uint8Array [1, 0, 1]
  const result = urlBase64ToUint8Array('AQAB');
  assert.ok(result instanceof Uint8Array);
  assert.equal(result.length, 3);
  assert.equal(result[0], 1);
  assert.equal(result[1], 0);
  assert.equal(result[2], 1);
});

test('urlBase64ToUint8Array: 含 - 和 _ 的 URL-safe 字符', () => {
  // "-_" in URL-safe base64 = "+/" in standard base64 → "/w" which decodes to 0xff
  const result = urlBase64ToUint8Array('-_w');
  assert.ok(result instanceof Uint8Array);
  assert.equal(result.length, 2);
  // - → +, _ → /: "+/w" in base64 → 0xfb, 0xfc
  assert.equal(result[0], 0xfb);
});

test('urlBase64ToUint8Array: 空串 → 空数组', () => {
  const result = urlBase64ToUint8Array('');
  assert.ok(result instanceof Uint8Array);
  assert.equal(result.length, 0);
});

test('urlBase64ToUint8Array: 自动补填充', () => {
  // "AA" is 2 chars → needs 2 padding chars ("AA==")
  // "AA==" in base64 = single byte 0x00
  const result = urlBase64ToUint8Array('AA');
  assert.equal(result.length, 1);
  assert.equal(result[0], 0);
});

// ---- pushEnvHint：Web Push 环境判定（E15 / ②2a）——手机「没触发过」多半卡在这几道门 ----
test.describe('pushEnvHint：移动端 Web Push 前提判定', () => {
  const base = { isSecureContext: true, isIOS: false, isStandalone: false, hasPushManager: true };
  test('局域网 http（非 secure context）→ need-https（优先级最高，压过一切）', () => {
    assert.equal(pushEnvHint({ ...base, isSecureContext: false }), 'need-https');
    assert.equal(pushEnvHint({ ...base, isSecureContext: false, isIOS: true, isStandalone: true }), 'need-https');
  });
  test('iOS 未加主屏 → ios-add-home（Safari 标签页无 PushManager，必须先装 PWA）', () => {
    assert.equal(pushEnvHint({ ...base, isIOS: true, isStandalone: false }), 'ios-add-home');
  });
  test('iOS 已加主屏 + 有 PushManager → ready', () => {
    assert.equal(pushEnvHint({ ...base, isIOS: true, isStandalone: true }), 'ready');
  });
  test('iOS 已加主屏但无 PushManager（旧 iOS <16.4）→ unsupported', () => {
    assert.equal(pushEnvHint({ ...base, isIOS: true, isStandalone: true, hasPushManager: false }), 'unsupported');
  });
  test('非 iOS 浏览器有 PushManager → ready（标签页也能收）', () => {
    assert.equal(pushEnvHint(base), 'ready');
  });
  test('非 iOS 无 PushManager → unsupported', () => {
    assert.equal(pushEnvHint({ ...base, hasPushManager: false }), 'unsupported');
  });
  test('缺省入参不抛（环境未知时保守回 need-https）', () => {
    assert.doesNotThrow(() => pushEnvHint());
    assert.equal(pushEnvHint(), 'need-https');
  });
});

// ---- resolveDeepLinkTarget：通知深链落地 + instanceId 失效回退（②2c）----
// 通知携带 instanceId + sessionId + cwd。落地时对照客户端 instances 快照：命中 → 切视图；
// 实例已失效（懒重生/关闭/epoch 变化）但会话在 → 走 session:switch 懒 resume；都没有 → 打开会话列表。
test.describe('resolveDeepLinkTarget：通知深链落地策略', () => {
  const instances = [{ instanceId: 'inst_1' }, { instanceId: 'inst_2' }];
  test('instanceId 命中 live → setViewing', () => {
    assert.deepEqual(resolveDeepLinkTarget({ instanceId: 'inst_2', sessionId: 's2', cwd: '/r' }, instances),
      { action: 'setViewing', instanceId: 'inst_2' });
  });
  test('instanceId 失效但有 sessionId → switch（带 cwd，懒 resume 接住实例重生/关闭）', () => {
    assert.deepEqual(resolveDeepLinkTarget({ instanceId: 'gone', sessionId: 's9', cwd: '/r' }, instances),
      { action: 'switch', sessionId: 's9', cwd: '/r' });
  });
  test('instanceId 失效且无 sessionId → list', () => {
    assert.deepEqual(resolveDeepLinkTarget({ instanceId: 'gone' }, instances), { action: 'list' });
  });
  test('无 target / 无 instanceId → list', () => {
    assert.deepEqual(resolveDeepLinkTarget(null, instances), { action: 'list' });
    assert.deepEqual(resolveDeepLinkTarget({}, instances), { action: 'list' });
  });
  test('instances 缺省不抛（冷启动 instances 未到）', () => {
    assert.deepEqual(resolveDeepLinkTarget({ instanceId: 'x', sessionId: 's', cwd: '/r' }),
      { action: 'switch', sessionId: 's', cwd: '/r' });
  });
});

// 连接 RTT 展示：手机顶栏实时延迟文案/色阶（纯格式，不碰 DOM/socket）。
test.describe('formatRttMs / rttToneClass', () => {
  test('formatRttMs: 合法毫秒 → 整数 ms；≥1s 用 1 位小数 s', () => {
    assert.equal(formatRttMs(0), '0ms');
    assert.equal(formatRttMs(42), '42ms');
    assert.equal(formatRttMs(42.6), '43ms');
    assert.equal(formatRttMs(999), '999ms');
    assert.equal(formatRttMs(1000), '1.0s');
    assert.equal(formatRttMs(1234), '1.2s');
    assert.equal(formatRttMs(10500), '10.5s');
  });

  test('formatRttMs: 非法/未知 → 空串（断线或未测到时隐藏）', () => {
    assert.equal(formatRttMs(null), '');
    assert.equal(formatRttMs(undefined), '');
    assert.equal(formatRttMs(NaN), '');
    assert.equal(formatRttMs(-1), '');
    assert.equal(formatRttMs(Infinity), '');
    assert.equal(formatRttMs('42'), ''); // 非 number 不静默 coerce
  });

  test('rttToneClass: 色阶 good/ok/warn/bad（语义 class 名，接线层拼 text-）', () => {
    assert.equal(rttToneClass(40), 'good');   // <150
    assert.equal(rttToneClass(149), 'good');
    assert.equal(rttToneClass(150), 'ok');    // <400
    assert.equal(rttToneClass(399), 'ok');
    assert.equal(rttToneClass(400), 'warn');  // <1000
    assert.equal(rttToneClass(999), 'warn');
    assert.equal(rttToneClass(1000), 'bad');
    assert.equal(rttToneClass(5000), 'bad');
  });

  test('rttToneClass: 非法 → 空串（与 format 对齐，接线层不着色）', () => {
    assert.equal(rttToneClass(null), '');
    assert.equal(rttToneClass(undefined), '');
    assert.equal(rttToneClass(NaN), '');
    assert.equal(rttToneClass(-3), '');
  });
});

// 移动端重连决策（修「切后台→切回卡住不更新」）：覆盖 plan 四分支 + 关键消歧边角。
test.describe('foregroundReconnectAction / syncAckAction', () => {
  test('① 未连接 → connect（直接重连，connect handler 会 sync）', () => {
    assert.equal(foregroundReconnectAction(false), 'connect');
  });

  test('connected=true → probe（半开会撒谎，不能直接判健康，走探活补发）', () => {
    assert.equal(foregroundReconnectAction(true), 'probe');
  });

  test('② 探测 timeout（err）→ reconnect：强制干净重连', () => {
    assert.equal(syncAckAction(new Error('operation has timed out'), undefined), 'reconnect');
  });

  test('③ ack found=false（实例已没了）→ reload：清屏重载历史', () => {
    assert.equal(syncAckAction(null, { replayed: 0, gap: false, found: false }), 'reload');
  });

  test('③b ack gap=true（缓冲超窗、回放残缺）→ reload：清屏全量重载，不把残缺当完整', () => {
    // 长断线漏 >500 事件：后端只回放残存的最近 500 + 标 gap=true。仅 none 会留下中间缺口 → 须 reload 全量补。
    assert.equal(syncAckAction(null, { replayed: 200, gap: true, found: true }), 'reload');
  });

  test('④ ack found=true + 有回放 → none：交给 agent:event 去重增量渲染', () => {
    assert.equal(syncAckAction(null, { replayed: 3, gap: false, found: true }), 'none');
  });

  test('消歧边角：实例还在但无新事件（replayed=0, found=true）→ none，不误 reload', () => {
    assert.equal(syncAckAction(null, { replayed: 0, gap: false, found: true }), 'none');
  });

  test('err 优先于 res：超时即便带 res 也判 reconnect', () => {
    assert.equal(syncAckAction(new Error('timeout'), { found: false }), 'reconnect');
  });

  test('普通 connect 路径 err=null + res 缺省 → none（无 ack 内容不误动作）', () => {
    assert.equal(syncAckAction(null, undefined), 'none');
  });
});

test.describe('shouldReloadOnEnter：切入会话时该用缓存/活缓冲还是磁盘全量重载', () => {
  test('replayed>0（web 活跃、活缓冲是渲染真相）→ keep，绝不重载以免丢实时', () => {
    assert.equal(shouldReloadOnEnter({ replayed: 5, gap: false, hasCache: true, diskLen: 99, seenDiskLen: 0 }), 'keep');
  });
  test('gap（缓冲超窗有缺口）→ reload（同 syncAckAction 口径）', () => {
    assert.equal(shouldReloadOnEnter({ replayed: 3, gap: true, hasCache: true, diskLen: 3, seenDiskLen: 3 }), 'reload');
  });
  test('replayed=0 且无缓存 → load（聊天区空、拉磁盘首次填充）', () => {
    assert.equal(shouldReloadOnEnter({ replayed: 0, gap: false, hasCache: false, diskLen: 5, seenDiskLen: 0 }), 'load');
  });
  test('盲区修复：replayed=0 + 有缓存 + 磁盘被外部写长(diskLen>seenDiskLen) → reload', () => {
    // 复刻原始 bug：web 离开期间 CLI 外部 resume 写盘，活缓冲(replayed)无那些消息、却有旧 DOM 缓存 →
    // 旧逻辑走 keep 永不拉盘。修复后磁盘 ahead 即清屏全量重载。
    assert.equal(shouldReloadOnEnter({ replayed: 0, gap: false, hasCache: true, diskLen: 5, seenDiskLen: 2 }), 'reload');
  });
  test('replayed=0 + 有缓存 + 磁盘未 ahead(diskLen<=seenDiskLen) → keep（缓存最新、保留 DOM 秒恢复）', () => {
    assert.equal(shouldReloadOnEnter({ replayed: 0, gap: false, hasCache: true, diskLen: 2, seenDiskLen: 2 }), 'keep');
  });
  test('seenDiskLen 未知(undefined→0) + 磁盘有内容 → reload（保守，内容一致不产生 bug）', () => {
    assert.equal(shouldReloadOnEnter({ replayed: 0, gap: false, hasCache: true, diskLen: 3 }), 'reload');
  });
  test('gap 优先于 replayed>0（有回放但有缺口仍重载）', () => {
    assert.equal(shouldReloadOnEnter({ replayed: 9, gap: true, hasCache: true, diskLen: 0, seenDiskLen: 0 }), 'reload');
  });
});

test.describe('sessionDomCachePlan：同会话 DOM 缓存跨 instance 复用（历史不可变）', () => {
  test('无缓存 / 空节点 → 不恢复', () => {
    assert.deepEqual(sessionDomCachePlan({ cached: null, currentInstanceId: 'i1' }), {
      restore: false, resumeFromSeq: 0, reuseSeqBaseline: false, epoch: null, lastSeq: 0,
    });
    assert.equal(sessionDomCachePlan({ cached: { nodes: [], instanceId: 'i1', lastSeq: 3, epoch: 'e' }, currentInstanceId: 'i1' }).restore, false);
  });

  test('同 instance → 恢复 DOM 并复用 lastSeq/epoch 做增量续传', () => {
    const plan = sessionDomCachePlan({
      cached: { nodes: [{}], instanceId: 'i1', lastSeq: 12, epoch: 'ep-a' },
      currentInstanceId: 'i1',
    });
    assert.equal(plan.restore, true);
    assert.equal(plan.reuseSeqBaseline, true);
    assert.equal(plan.resumeFromSeq, 12);
    assert.equal(plan.lastSeq, 12);
    assert.equal(plan.epoch, 'ep-a');
  });

  test('同会话不同 instance（effort/model 切档）→ 仍恢复 DOM，但 seq 从 0 跟新实例', () => {
    // 已完成的工具卡片/对话不会变；旧 instance 的 seq 空间对新缓冲无效，不能复用 lastSeq。
    const plan = sessionDomCachePlan({
      cached: { nodes: [{}, {}], instanceId: 'old-inst', lastSeq: 40, epoch: 'ep-old' },
      currentInstanceId: 'new-inst',
    });
    assert.equal(plan.restore, true);
    assert.equal(plan.reuseSeqBaseline, false);
    assert.equal(plan.resumeFromSeq, 0);
    assert.equal(plan.lastSeq, 0);
    assert.equal(plan.epoch, null);
  });
});

test.describe('keyboardInsetPadding：底部输入区随键盘让位的 padding（附件回流空白 bug 防回归）', () => {
  test('输入框未聚焦 → 一律回落 baseBottom（即便 viewport 仍报错配的大 inset）', () => {
    // E17 附件流：文件选择器抢/还焦点期间瞬时 innerHeight 全屏、viewportHeight 仍小，
    // 若不按焦点门控就会把半屏空白卡死。键盘应已收起 → 必须回落静息值。
    assert.equal(keyboardInsetPadding({ innerHeight: 800, viewportHeight: 400, inputFocused: false, baseBottom: 12 }), 12);
  });

  test('iOS 聚焦：layout viewport 不动、键盘只缩 visualViewport → 补键盘高度', () => {
    assert.equal(keyboardInsetPadding({ innerHeight: 800, viewportHeight: 460, inputFocused: true, baseBottom: 12 }), 352); // 12 + (800-460)
  });

  test('Android resizes-content 聚焦：innerHeight 随键盘一起缩 ≈ viewportHeight → 不补', () => {
    assert.equal(keyboardInsetPadding({ innerHeight: 460, viewportHeight: 460, inputFocused: true, baseBottom: 12 }), 12);
  });

  test('扣除 visualViewport.offsetTop（页面被键盘上推时）', () => {
    assert.equal(keyboardInsetPadding({ innerHeight: 800, viewportHeight: 460, viewportOffsetTop: 40, inputFocused: true, baseBottom: 0 }), 300); // 800-460-40
  });

  test('inset 为负 / NaN / 0 → 回落 baseBottom，不写负 padding', () => {
    assert.equal(keyboardInsetPadding({ innerHeight: 400, viewportHeight: 800, inputFocused: true, baseBottom: 8 }), 8);
    assert.equal(keyboardInsetPadding({ innerHeight: NaN, viewportHeight: 400, inputFocused: true, baseBottom: 8 }), 8);
    assert.equal(keyboardInsetPadding({ innerHeight: 800, viewportHeight: 800, inputFocused: true, baseBottom: 8 }), 8);
  });

  test('缺省入参安全：baseBottom 默认 0', () => {
    assert.equal(keyboardInsetPadding({ innerHeight: 800, viewportHeight: 400, inputFocused: false }), 0);
  });
});

test.describe('logEntryVisibleForInstance：交互日志按实例分流（切工作区残留上个区日志 bug 防回归）', () => {
  test('实例匹配 → 可见；不匹配 → 隐藏（核心泄漏修复）', () => {
    assert.equal(logEntryVisibleForInstance({ type: 'client_send', instanceId: 'A' }, 'A'), true);
    assert.equal(logEntryVisibleForInstance({ type: 'client_recv', instanceId: 'A' }, 'B'), false);
    assert.equal(logEntryVisibleForInstance({ type: 'client_stream', instanceId: 'A' }, 'B'), false);
  });

  test('client_conn 连接级事件无工作区归属 → 任何实例下恒显', () => {
    assert.equal(logEntryVisibleForInstance({ type: 'client_conn', instanceId: 'A' }, 'B'), true);
    assert.equal(logEntryVisibleForInstance({ type: 'client_conn', instanceId: null }, 'A'), true);
    // 首页(viewing=null、无选中实例)也恒显——loadConsoleLogs 的无实例分支据此渲染断连/重连痕迹，
    // 否则首页打开日志抽屉一片空白（实测暴露：conn 日志丢失）。
    assert.equal(logEntryVisibleForInstance({ type: 'client_conn', instanceId: null }, null), true);
  });

  test('空首页两端 instanceId 皆 null → 可见；一端 null 一端有值 → 隐藏', () => {
    assert.equal(logEntryVisibleForInstance({ type: 'client_send', instanceId: null }, null), true);
    assert.equal(logEntryVisibleForInstance({ type: 'client_send', instanceId: null }, 'A'), false);
    assert.equal(logEntryVisibleForInstance({ type: 'client_send', instanceId: 'A' }, null), false);
    // undefined 与 null 等价（旧条目无 instanceId 字段时不误判为某实例）
    assert.equal(logEntryVisibleForInstance({ type: 'client_send' }, null), true);
  });

  test('空 entry → false（不渲染）', () => {
    assert.equal(logEntryVisibleForInstance(null, 'A'), false);
    assert.equal(logEntryVisibleForInstance(undefined, null), false);
  });
});

// 交互日志行布局契约：修「移动端 chip 把正文挤成一字宽竖排」。
// 旧实现 row 横向 flex + chip shrink-0 → 正文可用宽 ≈ 0 → break-all 逐字竖排（真机截图复现）。
// 新契约：row 纵向；meta 可换行；body 满宽 + break-words（非 break-all）。
test.describe('consoleLogEntryLayout：交互日志 chip/正文分行防竖排', () => {
  test('返回 row/meta/body 三组 class，锁定纵向 + meta 换行 + body 满宽可断词', () => {
    const L = consoleLogEntryLayout();
    assert.equal(typeof L.row, 'string');
    assert.equal(typeof L.meta, 'string');
    assert.equal(typeof L.body, 'string');

    // 纵向堆叠：禁止 items-start 单行横向（那是旧实现的根因）
    assert.match(L.row, /\bflex\b/);
    assert.match(L.row, /\bflex-col\b/);
    assert.doesNotMatch(L.row, /\bitems-start\b/);

    // chip 行可换行，避免多个 badge 再挤正文
    assert.match(L.meta, /\bflex\b/);
    assert.match(L.meta, /\bflex-wrap\b/);
    assert.match(L.meta, /\bmin-w-0\b/);

    // 正文独占一行、可断词（中文长句正常折行，而非 break-all 逐字竖排）
    assert.match(L.body, /\bw-full\b/);
    assert.match(L.body, /\bmin-w-0\b/);
    assert.match(L.body, /\bbreak-words\b/);
    assert.match(L.body, /\bwhitespace-pre-wrap\b/);
    assert.doesNotMatch(L.body, /\bbreak-all\b/);
  });
});

// defaultModelTileLabel：模型网格里「默认磁贴」（data-model=""）显示什么文案。
// currentModel 有值=用户已选/已知具体模型 → 显通用文案（该磁贴非激活）。
// currentModel 空 + 已知 cwd 默认 → 显真实默认名（诚实：cwd 级最佳猜测，非该会话确定值；续接无记录会话
// 首条消息后由 init.model 校正）。发送语义不受此影响（modelInput.value 恒空、不传 --model）。
test.describe('defaultModelTileLabel: 默认磁贴文案', () => {
  test('currentModel 有值 → 通用文案（无视 cwdDefaultModel）', () => {
    assert.deepEqual(defaultModelTileLabel({ currentModel: 'opus', cwdDefaultModel: 'sonnet' }),
      { title: '沿用当前模型', subtitle: '不指定特定模型', showsName: false });
  });
  test('currentModel 空 + cwdDefaultModel 有 → 显真实默认名、showsName:true', () => {
    assert.deepEqual(defaultModelTileLabel({ currentModel: '', cwdDefaultModel: 'sonnet' }),
      { title: '默认模型', subtitle: 'sonnet', showsName: true });
  });
  test('后缀剥离：claude-opus-4-8[1m] → claude-opus-4-8', () => {
    assert.equal(defaultModelTileLabel({ currentModel: '', cwdDefaultModel: 'claude-opus-4-8[1m]' }).subtitle,
      'claude-opus-4-8');
  });
  test('两者皆空 → 通用文案（兜底，不泄漏）', () => {
    assert.deepEqual(defaultModelTileLabel({ currentModel: '', cwdDefaultModel: '' }),
      { title: '沿用当前模型', subtitle: '不指定特定模型', showsName: false });
  });
  test('null/undefined 入参安全 → 通用文案，不抛', () => {
    assert.equal(defaultModelTileLabel({}).showsName, false);
    assert.equal(defaultModelTileLabel().showsName, false);
  });
});

// ── armedTakeoverStep：排队接管状态机（接管=等终端本轮完结再放行，纯 web 侧） ──
// armed 期间只有三个出口：本轮完结自动放行(unlock-focus) / 等待中疑似中断自动完成接管(unlock-stale)
// / 切会话撤销(disarm)；其余一律不动作。未 armed 时对任何信号零影响（不干扰现有 onMirrorState 路径）。
test('armedTakeoverStep: 未 armed → 任何信号均 none', () => {
  assert.deepEqual(armedTakeoverStep({ armed: false }, { kind: 'mirror', readonly: false }), { action: 'none' });
  assert.deepEqual(armedTakeoverStep({}, { kind: 'switch' }), { action: 'none' });
  assert.deepEqual(armedTakeoverStep(undefined, undefined), { action: 'none' });
});

test('armedTakeoverStep: armed + readonly=false（终端本轮完结）→ unlock-focus', () => {
  assert.deepEqual(
    armedTakeoverStep({ armed: true, armedSid: 's1' }, { kind: 'mirror', readonly: false }),
    { action: 'unlock-focus' }
  );
});

test('armedTakeoverStep: armed + 仍在驾驶（readonly=true, stale=false）→ none 继续等', () => {
  assert.deepEqual(
    armedTakeoverStep({ armed: true, armedSid: 's1' }, { kind: 'mirror', readonly: true, stale: false, sessionId: 's1' }),
    { action: 'none' }
  );
});

test('armedTakeoverStep: armed + 同会话转疑似中断（stale=true）→ unlock-stale', () => {
  assert.deepEqual(
    armedTakeoverStep({ armed: true, armedSid: 's1' }, { kind: 'mirror', readonly: true, stale: true, sessionId: 's1' }),
    { action: 'unlock-stale' }
  );
});

test('armedTakeoverStep: armed + 他会话 stale → none（不误放行）', () => {
  assert.deepEqual(
    armedTakeoverStep({ armed: true, armedSid: 's1' }, { kind: 'mirror', readonly: true, stale: true, sessionId: 's2' }),
    { action: 'none' }
  );
});

test('armedTakeoverStep: armed + 切会话 → disarm', () => {
  assert.deepEqual(armedTakeoverStep({ armed: true, armedSid: 's1' }, { kind: 'switch' }), { action: 'disarm' });
});

test.describe('detectServiceRestart（服务状态可见性——每设备独立感知，本地基线对比）', () => {
  test('无本地基线 → 只建立基线，不告警（首次打开/清过 localStorage）', () => {
    assert.deepEqual(
      detectServiceRestart({ startedAt: 1000, lastSeenStartedAt: null }),
      { changed: false, nextStartedAt: 1000 }
    );
  });

  test('基线存在且不同 → changed:true（服务确实重启过）', () => {
    assert.deepEqual(
      detectServiceRestart({ startedAt: 2000, lastSeenStartedAt: 1000 }),
      { changed: true, nextStartedAt: 2000 }
    );
  });

  test('基线存在且相同 → changed:false（同一进程，非重启）', () => {
    assert.deepEqual(
      detectServiceRestart({ startedAt: 1000, lastSeenStartedAt: 1000 }),
      { changed: false, nextStartedAt: 1000 }
    );
  });

  test('startedAt 非法（防御性，字段缺失/坏数据不崩、不误判、不用坏值覆盖基线）', () => {
    assert.deepEqual(
      detectServiceRestart({ startedAt: undefined, lastSeenStartedAt: 1000 }),
      { changed: false, nextStartedAt: 1000 }
    );
    assert.deepEqual(
      detectServiceRestart({ startedAt: 'bad', lastSeenStartedAt: null }),
      { changed: false, nextStartedAt: null }
    );
    assert.deepEqual(detectServiceRestart(), { changed: false, nextStartedAt: null });
  });
});

test.describe('formatServiceNotices（服务状态可见性——组装会话面板"服务"小节文案）', () => {
  test('空 service + 无重启 → []（一切正常，不渲染小节）', () => {
    assert.deepEqual(formatServiceNotices({ service: null, restartChanged: false, now: 1000 }), []);
    assert.deepEqual(formatServiceNotices(), []);
  });

  test('仅重启 → 一行固定文案', () => {
    assert.deepEqual(
      formatServiceNotices({ service: null, restartChanged: true, now: 1000 }),
      ['🔄 服务自上次连接后已重启，请确认之前任务是否正常完成']
    );
  });

  test('仅推送失败 → 一行含"多久之前" + 渠道 + 累计次数', () => {
    const now = 1_000_000;
    assert.deepEqual(
      formatServiceNotices({
        service: { deliveryFailure: { channel: 'ntfy', at: now - 12 * 60 * 1000, count: 2 } },
        restartChanged: false,
        now
      }),
      ['🔔 推送最近失败于 12 分钟前（ntfy，累计 2 次）']
    );
  });

  test('推送失败但无 count（防御性）→ 不显示"累计 N 次"后缀', () => {
    const now = 1_000_000;
    assert.deepEqual(
      formatServiceNotices({
        service: { deliveryFailure: { channel: 'push', at: now - 5 * 60 * 1000 } },
        restartChanged: false,
        now
      }),
      ['🔔 推送最近失败于 5 分钟前（push）']
    );
  });

  test('重启 + 推送失败都命中 → 两行，重启在前、顺序稳定', () => {
    const now = 1_000_000;
    assert.deepEqual(
      formatServiceNotices({
        service: { deliveryFailure: { channel: 'push', at: now - 60 * 1000, count: 1 } },
        restartChanged: true,
        now
      }),
      [
        '🔄 服务自上次连接后已重启，请确认之前任务是否正常完成',
        '🔔 推送最近失败于 1 分钟前（push，累计 1 次）'
      ]
    );
  });

  test('"多久之前"文案跨量级：<1分钟→刚刚、<1小时→N 分钟前、<1天→N 小时前、≥1天→N 天前', () => {
    const now = 10_000_000;
    const at = (deltaMs) => now - deltaMs;
    const bodyOf = (deltaMs) => formatServiceNotices({
      service: { deliveryFailure: { channel: 'push', at: at(deltaMs) } }, restartChanged: false, now
    })[0];
    assert.match(bodyOf(30 * 1000), /^🔔 推送最近失败于 刚刚（push）$/);
    assert.match(bodyOf(45 * 60 * 1000), /^🔔 推送最近失败于 45 分钟前（push）$/);
    assert.match(bodyOf(5 * 60 * 60 * 1000), /^🔔 推送最近失败于 5 小时前（push）$/);
    assert.match(bodyOf(2 * 24 * 60 * 60 * 1000), /^🔔 推送最近失败于 2 天前（push）$/);
  });
});
