// tests/unit/logic-panel-state.test.mjs —— panel-state.js 纯函数与状态机判定单测
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLiveActivityText,
  INTERRUPT_PENDING_TIMEOUT_MS,
  shouldClearInterruptPendingOnSystem,
  systemBarClass,
  formatStreamPreviewIntervalMs,
  STATUS_ICONS,
  STATUS_ICON_TONES,
  statusIconSpec,
  resolvePanelState,
  resolveDrawerStatus,
  resolveDrawerStatusChip,
  formatSessionRowSubtitle,
  resolvePanelCwd,
  owningWorkspace,
  aggregateStates,
  summarizeOtherWorkspaces,
  projectDisplayName,
  shouldShowStartScreen,
  wasViewingInstanceDestroyed,
  detectServerRestart,
  resolveEmptySurface,
  formatComposeDefaultsSummary,
  shouldShowTopContextPill,
  sessionIdBlockView,
  shouldShowRttChip,
  shouldShowComposer,
  mergeRecentSessionsAcrossWorkspaces,
  summarizeRecentsLoad,
  shouldRestoreOptimisticBusy,
  whatNeedsAttention,
  resolveHeaderConnBadge,
  resolveHeaderAttentionChip,
  resolveDeepLinkTarget,
  resolveSheetDragEnd,
  shouldRerenderSessionList,
  buildDirInstanceSignatures,
  diffDirSignatures,
} from '../../app/public/js/logic/panel-state.js';
import { setLang } from '../../app/public/js/i18n.js';

test.beforeEach(() => setLang('zh'));

// 1. formatLiveActivityText
test.describe('formatLiveActivityText —— 活动行文案', () => {
  test('典型输入：stopping / sending / default', () => {
    assert.equal(formatLiveActivityText('stopping'), '正在停止…');
    assert.equal(formatLiveActivityText('sending'), '正在发送…');
    assert.equal(formatLiveActivityText('default'), 'Claude 正在执行任务...');
  });

  test('边界输入：无参、null、undefined、空串、数字、非预期字符串', () => {
    assert.equal(formatLiveActivityText(), 'Claude 正在执行任务...');
    assert.equal(formatLiveActivityText(null), 'Claude 正在执行任务...');
    assert.equal(formatLiveActivityText(undefined), 'Claude 正在执行任务...');
    assert.equal(formatLiveActivityText(''), 'Claude 正在执行任务...');
    assert.equal(formatLiveActivityText(0), 'Claude 正在执行任务...');
    assert.equal(formatLiveActivityText('other_random_kind'), 'Claude 正在执行任务...');
  });

  test('产品语义：i18n 语言切换支持', () => {
    setLang('en');
    assert.equal(formatLiveActivityText('stopping'), 'Stopping…');
    assert.equal(formatLiveActivityText('sending'), 'Sending…');
    assert.equal(formatLiveActivityText('default'), 'Claude is working...');
  });
});

// 2. INTERRUPT_PENDING_TIMEOUT_MS
test.describe('INTERRUPT_PENDING_TIMEOUT_MS —— 中断安全超时常量', () => {
  test('典型与产品语义：超时时间为 12,000 ms（12 秒）', () => {
    assert.equal(INTERRUPT_PENDING_TIMEOUT_MS, 12000);
    assert.equal(typeof INTERRUPT_PENDING_TIMEOUT_MS, 'number');
  });

  test('边界检查：为有限正整数', () => {
    assert.ok(Number.isFinite(INTERRUPT_PENDING_TIMEOUT_MS));
    assert.ok(INTERRUPT_PENDING_TIMEOUT_MS > 0);
  });
});

// 3. shouldClearInterruptPendingOnSystem
test.describe('shouldClearInterruptPendingOnSystem —— 清除中断 pending 判定', () => {
  test('典型输入：interrupted、no_interruptible_task、以及匹配中文文案', () => {
    assert.equal(shouldClearInterruptPendingOnSystem({ kind: 'interrupted' }), true);
    assert.equal(shouldClearInterruptPendingOnSystem({ kind: 'no_interruptible_task' }), true);
    assert.equal(shouldClearInterruptPendingOnSystem({ message: '当前没有可中断的任务' }), true);
    assert.equal(shouldClearInterruptPendingOnSystem({ message: '系统提示：没有可中断的任务正在执行' }), true);
  });

  test('边界输入：null、undefined、空对象、数字、非对象、无匹配字段', () => {
    assert.equal(shouldClearInterruptPendingOnSystem(null), false);
    assert.equal(shouldClearInterruptPendingOnSystem(undefined), false);
    assert.equal(shouldClearInterruptPendingOnSystem({}), false);
    assert.equal(shouldClearInterruptPendingOnSystem(0), false);
    assert.equal(shouldClearInterruptPendingOnSystem('string'), false);
    assert.equal(shouldClearInterruptPendingOnSystem({ kind: 'other' }), false);
    assert.equal(shouldClearInterruptPendingOnSystem({ message: null }), false);
    assert.equal(shouldClearInterruptPendingOnSystem({ message: 12345 }), false);
  });

  test('产品语义：后端失败回执与中止成功必须清位，其余 notice 不得误清', () => {
    assert.equal(shouldClearInterruptPendingOnSystem({ kind: 'notice', message: '已完成' }), false);
    assert.equal(shouldClearInterruptPendingOnSystem({ kind: 'task_notification' }), false);
  });
});

// 4. systemBarClass
test.describe('systemBarClass —— 系统条语义色', () => {
  test('典型输入：notice 下的 error / warning / info', () => {
    assert.equal(systemBarClass({ kind: 'notice', level: 'error' }), 'text-danger');
    assert.equal(systemBarClass({ kind: 'notice', level: 'warning' }), 'text-warning');
    assert.equal(systemBarClass({ kind: 'notice', level: 'info' }), 'text-ink-faint');
  });

  test('边界输入：null、undefined、空对象、非对象、空串', () => {
    assert.equal(systemBarClass(null), 'text-ink-faint');
    assert.equal(systemBarClass(undefined), 'text-ink-faint');
    assert.equal(systemBarClass({}), 'text-ink-faint');
    assert.equal(systemBarClass('notice'), 'text-ink-faint');
    assert.equal(systemBarClass(0), 'text-ink-faint');
  });

  test('产品语义：非 notice 语义下 level 不生效，恒返回中性灰防止误染色', () => {
    assert.equal(systemBarClass({ kind: 'interrupted', level: 'error' }), 'text-ink-faint');
    assert.equal(systemBarClass({ kind: 'compacted', level: 'warning' }), 'text-ink-faint');
    assert.equal(systemBarClass({ level: 'error' }), 'text-ink-faint');
  });
});

// 5. formatStreamPreviewIntervalMs
test.describe('formatStreamPreviewIntervalMs —— 流式预览节流间隔', () => {
  test('典型输入：合法正数值', () => {
    assert.equal(formatStreamPreviewIntervalMs(100), 100);
    assert.equal(formatStreamPreviewIntervalMs(50), 50);
    assert.equal(formatStreamPreviewIntervalMs('120'), 120);
  });

  test('边界输入：0、负数、NaN、Infinity、null、undefined、空串、非法字符串', () => {
    assert.equal(formatStreamPreviewIntervalMs(0), 80);
    assert.equal(formatStreamPreviewIntervalMs(-10), 80);
    assert.equal(formatStreamPreviewIntervalMs(NaN), 80);
    assert.equal(formatStreamPreviewIntervalMs(Infinity), 80);
    assert.equal(formatStreamPreviewIntervalMs(-Infinity), 80);
    assert.equal(formatStreamPreviewIntervalMs(null), 80);
    assert.equal(formatStreamPreviewIntervalMs(undefined), 80);
    assert.equal(formatStreamPreviewIntervalMs(''), 80);
    assert.equal(formatStreamPreviewIntervalMs('not_a_number'), 80);
  });

  test('产品语义：缺省或非法回落兜底 80ms', () => {
    assert.equal(formatStreamPreviewIntervalMs(), 80);
  });
});

// 6. STATUS_ICONS & 7. STATUS_ICON_TONES
test.describe('STATUS_ICONS & STATUS_ICON_TONES —— 状态图标与色调表', () => {
  test('典型输入：覆盖所有 8 个已知状态 kind', () => {
    const expectedKinds = ['pending', 'busy', 'ok', 'error', 'warn', 'denied', 'answered', 'aborted'];
    for (const kind of expectedKinds) {
      assert.ok(STATUS_ICONS[kind], `缺少 kind: ${kind}`);
      assert.ok(STATUS_ICONS[kind].tone, `kind: ${kind} 缺少 tone`);
      assert.ok(STATUS_ICONS[kind].label, `kind: ${kind} 缺少 label`);
      assert.ok(STATUS_ICONS[kind].path, `kind: ${kind} 缺少 path`);
    }
  });

  test('产品语义：answered / aborted 必须使用中性色 text-ink-soft', () => {
    assert.equal(STATUS_ICONS.answered.tone, 'text-ink-soft');
    assert.equal(STATUS_ICONS.aborted.tone, 'text-ink-soft');
  });

  test('STATUS_ICON_TONES 完整性与无重复集合断言', () => {
    assert.ok(Array.isArray(STATUS_ICON_TONES));
    assert.ok(STATUS_ICON_TONES.length > 0);
    const unique = new Set(STATUS_ICON_TONES);
    assert.equal(unique.size, STATUS_ICON_TONES.length);
    assert.ok(STATUS_ICON_TONES.includes('text-warning'));
    assert.ok(STATUS_ICON_TONES.includes('text-success'));
    assert.ok(STATUS_ICON_TONES.includes('text-danger'));
    assert.ok(STATUS_ICON_TONES.includes('text-ink-soft'));
  });
});

// 8. statusIconSpec
test.describe('statusIconSpec —— 状态图标规格计算', () => {
  test('典型输入：返回 html、label、kind、tone', () => {
    const spec = statusIconSpec('ok');
    assert.equal(spec.kind, 'ok');
    assert.equal(spec.tone, 'text-success');
    assert.equal(spec.label, '成功');
    assert.ok(spec.html.includes('class="status-svg"'));
    assert.ok(spec.html.includes('viewBox="0 0 24 24"'));
  });

  test('边界输入：未知 kind、null、undefined、空串、数字回落至 pending', () => {
    const fallbackNull = statusIconSpec(null);
    assert.equal(fallbackNull.kind, 'pending');
    assert.equal(fallbackNull.tone, 'text-warning');
    assert.equal(fallbackNull.label, '进行中');

    assert.equal(statusIconSpec(undefined).kind, 'pending');
    assert.equal(statusIconSpec('').kind, 'pending');
    assert.equal(statusIconSpec('non_existent').kind, 'pending');
    assert.equal(statusIconSpec(123).kind, 'pending');
  });

  test('产品语义：i18n 标签转换', () => {
    setLang('en');
    assert.equal(statusIconSpec('ok').label, 'Succeeded');
    assert.equal(statusIconSpec('error').label, 'Error');
    assert.equal(statusIconSpec('pending').label, 'In progress');
  });
});

// 9. resolvePanelState
test.describe('resolvePanelState —— 设置面板状态数据源解析', () => {
  test('典型输入：Web 模式与 CLI 镜像模式', () => {
    const webState = resolvePanelState({
      mirrorReadonly: false,
      observedCli: { model: 'cli-model', permissionMode: 'bypass', effort: 'low' },
      web: { model: 'web-model', permissionMode: 'ask', effort: 'high' },
    });
    assert.deepEqual(webState, {
      source: 'web',
      model: 'web-model',
      permissionMode: 'ask',
      effort: 'high',
    });

    const cliState = resolvePanelState({
      mirrorReadonly: true,
      observedCli: { model: 'cli-model', permissionMode: 'bypass', effort: 'low' },
      web: { model: 'web-model', permissionMode: 'ask', effort: 'high' },
    });
    assert.deepEqual(cliState, {
      source: 'cli',
      model: 'cli-model',
      permissionMode: 'bypass',
      effort: 'low',
    });
  });

  test('边界输入：空入参、undefined、null 字段、0/空串/false', () => {
    assert.deepEqual(resolvePanelState(), {
      source: 'web',
      model: null,
      permissionMode: null,
      effort: null,
    });
    assert.deepEqual(resolvePanelState({ mirrorReadonly: true }), {
      source: 'cli',
      model: null,
      permissionMode: null,
      effort: null,
    });
    const withFalsy = resolvePanelState({
      mirrorReadonly: false,
      web: { model: '', permissionMode: 0, effort: false },
    });
    assert.equal(withFalsy.model, '');
    assert.equal(withFalsy.permissionMode, 0);
    assert.equal(withFalsy.effort, false);
  });

  test('产品语义：CLI 镜像态缺失字段绝不能拿 Web 偏好补空', () => {
    const cliMissing = resolvePanelState({
      mirrorReadonly: true,
      observedCli: { model: null },
      web: { model: 'web-fallback', permissionMode: 'ask', effort: 'max' },
    });
    assert.equal(cliMissing.source, 'cli');
    assert.equal(cliMissing.model, null);
    assert.equal(cliMissing.permissionMode, null);
    assert.equal(cliMissing.effort, null);
  });
});

// 10. resolveDrawerStatus
test.describe('resolveDrawerStatus —— 抽屉状态解析与优先级', () => {
  test('典型输入：liveState 与 terminalState 各态', () => {
    assert.equal(resolveDrawerStatus({ liveState: 'permission' }), 'permission');
    assert.equal(resolveDrawerStatus({ liveState: 'error' }), 'error');
    assert.equal(resolveDrawerStatus({ terminalState: 'waiting' }), 'terminal_waiting');
    assert.equal(resolveDrawerStatus({ liveState: 'busy' }), 'busy');
    assert.equal(resolveDrawerStatus({ terminalState: 'busy' }), 'busy');
    assert.equal(resolveDrawerStatus({ bgLocked: true }), 'bg_locked');
  });

  test('边界输入：无参、空对象、终态 (done / aborted / idle) 返回 null', () => {
    assert.equal(resolveDrawerStatus(), null);
    assert.equal(resolveDrawerStatus({}), null);
    assert.equal(resolveDrawerStatus({ liveState: 'done', terminalState: 'idle' }), null);
    assert.equal(resolveDrawerStatus({ liveState: 'aborted' }), null);
  });

  test('产品语义：优先级顺位 permission > error > terminal_waiting > busy > bg_locked', () => {
    assert.equal(resolveDrawerStatus({ liveState: 'permission', terminalState: 'waiting', bgLocked: true }), 'permission');
    assert.equal(resolveDrawerStatus({ liveState: 'error', terminalState: 'waiting' }), 'error');
    assert.equal(resolveDrawerStatus({ liveState: 'busy', terminalState: 'waiting' }), 'terminal_waiting');
    assert.equal(resolveDrawerStatus({ liveState: 'busy', bgLocked: true }), 'busy');
    assert.equal(resolveDrawerStatus({ liveState: 'idle', terminalState: 'idle', bgLocked: true }), 'bg_locked');
  });
});

// 11. resolveDrawerStatusChip
test.describe('resolveDrawerStatusChip —— 抽屉状态 Chip 文案与来源解析', () => {
  test('典型输入：各状态 chip 结构及文案', () => {
    assert.deepEqual(resolveDrawerStatusChip({ liveState: 'permission' }), {
      status: 'permission',
      label: '需要你',
    });
    assert.deepEqual(resolveDrawerStatusChip({ liveState: 'error' }), {
      status: 'error',
      label: '出错',
    });
    assert.deepEqual(resolveDrawerStatusChip({ terminalState: 'waiting' }), {
      status: 'terminal_waiting',
      label: '终端需要你',
    });
    assert.deepEqual(resolveDrawerStatusChip({ bgLocked: true }), {
      status: 'bg_locked',
      label: '后台占用',
    });
  });

  test('边界输入：空入参、idle 状态返回 null', () => {
    assert.equal(resolveDrawerStatusChip(), null);
    assert.equal(resolveDrawerStatusChip({ liveState: 'idle', terminalState: 'idle' }), null);
    assert.equal(resolveDrawerStatusChip({}), null);
  });

  test('产品语义：busy 下按驾驶方细分文案（终端 / 桌面端 / 后台任务 / Web）', () => {
    // 1) 纯 Web 回合 -> 运行中
    assert.deepEqual(resolveDrawerStatusChip({ liveState: 'busy' }), {
      status: 'busy',
      label: '运行中',
    });
    // 2) 终端直跑 -> 终端运行中
    assert.deepEqual(resolveDrawerStatusChip({ terminalState: 'busy' }), {
      status: 'busy',
      label: '终端运行中',
    });
    // 3) 桌面端 Code 模式 -> 桌面端运行中
    assert.deepEqual(resolveDrawerStatusChip({ terminalState: 'busy', terminalSource: 'claude-desktop' }), {
      status: 'busy',
      label: '桌面端运行中',
    });
    // 4) 后台任务独占同时在跑 -> 后台任务运行中
    assert.deepEqual(resolveDrawerStatusChip({ liveState: 'busy', bgLocked: true }), {
      status: 'busy',
      label: '后台任务运行中',
    });
  });

  // 「服务告警不进 chip」这条产品铁律在这一层是【靠接口形状】保证的——本函数只解构
  // liveState/terminalState/terminalSource/bgLocked，压根看不见服务告警，没有可测的分支。
  // 所以这里测的是真正属于本函数的那半：idle 不出 chip。
  test('产品语义：idle 不出 chip（chip 只表达「点一下就能处理」的待办）', () => {
    assert.equal(resolveDrawerStatusChip({ liveState: 'idle' }), null);
  });
});

// 12. formatSessionRowSubtitle
test.describe('formatSessionRowSubtitle —— 会话行副文本格式化', () => {
  test('典型输入：完整各字段拼接', () => {
    const text = formatSessionRowSubtitle({
      worktree: 'feat-1',
      terminalState: 'alive',
      whenText: '10分钟前',
      liveOpen: true,
      shortId: 'sess_99',
    });
    assert.equal(text, 'worktree feat-1 · 终端已打开 · 10分钟前 · 已打开 · sess_99');
  });

  test('边界输入：无参、空对象、非字符串 worktree、空白 worktree、shortId=0', () => {
    assert.equal(formatSessionRowSubtitle(), '');
    assert.equal(formatSessionRowSubtitle({}), '');
    assert.equal(formatSessionRowSubtitle({ worktree: '   ' }), '');
    assert.equal(formatSessionRowSubtitle({ worktree: null }), '');
    assert.equal(formatSessionRowSubtitle({ worktree: 1234 }), '');
    // shortId 为 0 时由于 if (shortId) 为假不拼接
    assert.equal(formatSessionRowSubtitle({ shortId: 0 }), '');
  });

  test('产品语义：terminalSource 为 claude-desktop 时显示桌面端已打开', () => {
    const desktopText = formatSessionRowSubtitle({
      terminalState: 'alive',
      terminalSource: 'claude-desktop',
    });
    assert.equal(desktopText, '桌面端已打开');
  });
});

// 13. resolvePanelCwd
test.describe('resolvePanelCwd —— 面板目标工作目录解析', () => {
  test('典型输入：从 instances 匹配当前 viewingInstanceId', () => {
    const instances = [
      { instanceId: 'inst_1', cwd: '/work/tree/path' },
      { instanceId: 'inst_2', cwd: '/other/path' },
    ];
    assert.equal(resolvePanelCwd({ instances, viewingInstanceId: 'inst_1', workspaceCwd: '/work' }), '/work/tree/path');
  });

  test('边界输入：空入参、instances 非数组、找不到实例回落 workspaceCwd 或 null', () => {
    assert.equal(resolvePanelCwd(), null);
    assert.equal(resolvePanelCwd({ instances: null, workspaceCwd: '/fallback' }), '/fallback');
    assert.equal(resolvePanelCwd({ instances: [], viewingInstanceId: 'inst_missing', workspaceCwd: '/fallback' }), '/fallback');
    assert.equal(resolvePanelCwd({ workspaceCwd: '' }), null);
  });

  test('产品语义：worktree 会话打开时取 worktree 真实 cwd，无实例时回落父仓', () => {
    const instances = [{ instanceId: 'i1', cwd: '/repo/.claude/worktrees/w1' }];
    assert.equal(resolvePanelCwd({ instances, viewingInstanceId: 'i1', workspaceCwd: '/repo' }), '/repo/.claude/worktrees/w1');
    assert.equal(resolvePanelCwd({ instances, viewingInstanceId: 'i2', workspaceCwd: '/repo' }), '/repo');
  });
});

// 14. owningWorkspace
test.describe('owningWorkspace —— 工作区归属与最长前缀判定', () => {
  test('典型输入：精确命中与最长前缀匹配', () => {
    const dirs = ['/repo', '/repo/sub-proj'];
    assert.equal(owningWorkspace('/repo', dirs), '/repo');
    assert.equal(owningWorkspace('/repo/sub-proj/src/app', dirs), '/repo/sub-proj');
    assert.equal(owningWorkspace('/repo/other/src', dirs), '/repo');
  });

  test('边界输入：null、undefined、空串、dirs 非数组或包含非字符串', () => {
    assert.equal(owningWorkspace(null, ['/a']), null);
    assert.equal(owningWorkspace('', ['/a']), null);
    assert.equal(owningWorkspace('/a', null), null);
    assert.equal(owningWorkspace('/a', []), null);
    assert.equal(owningWorkspace('/a/b', ['/a', null, 123, '']), '/a');
  });

  test('产品语义：目录边界严密防混淆，/repo-other 不得误匹配 /repo', () => {
    const dirs = ['/repo'];
    assert.equal(owningWorkspace('/repo-other/sub', dirs), null);
    assert.equal(owningWorkspace('/repo/worktree-1', dirs), '/repo');
    // dirs 带尾部斜杠
    assert.equal(owningWorkspace('/repo/sub', ['/repo/']), '/repo/');
  });
});

// 15. aggregateStates
test.describe('aggregateStates —— 按工作区聚合状态', () => {
  test('典型输入：多实例状态聚合取最高优先级', () => {
    const dirs = ['/a', '/b'];
    const instances = [
      { cwd: '/a', state: 'idle' },
      { cwd: '/a', state: 'busy' },
      { cwd: '/b', state: 'done' },
    ];
    assert.deepEqual(aggregateStates(instances, dirs), {
      '/a': 'busy',
      '/b': 'done',
    });
  });

  test('边界输入：null、undefined、空数组、未知状态不覆盖 idle', () => {
    assert.deepEqual(aggregateStates(null, null), {});
    assert.deepEqual(aggregateStates([], ['/a']), { '/a': 'idle' });
    const unknownState = aggregateStates([{ cwd: '/a', state: 'invalid_unknown' }], ['/a']);
    assert.equal(unknownState['/a'], 'idle');
  });

  test('产品语义：优先级 permission > error > busy > aborted > done > idle', () => {
    const dirs = ['/x'];
    assert.equal(aggregateStates([{ cwd: '/x', state: 'done' }, { cwd: '/x', state: 'aborted' }], dirs)['/x'], 'aborted');
    assert.equal(aggregateStates([{ cwd: '/x', state: 'aborted' }, { cwd: '/x', state: 'busy' }], dirs)['/x'], 'busy');
    assert.equal(aggregateStates([{ cwd: '/x', state: 'busy' }, { cwd: '/x', state: 'error' }], dirs)['/x'], 'error');
    assert.equal(aggregateStates([{ cwd: '/x', state: 'error' }, { cwd: '/x', state: 'permission' }], dirs)['/x'], 'permission');
  });

  test('产品语义：worktree 实例状态聚合到父工作区', () => {
    const dirs = ['/repo'];
    const instances = [{ cwd: '/repo/.claude/worktrees/feat', state: 'permission' }];
    assert.deepEqual(aggregateStates(instances, dirs), {
      '/repo': 'permission',
    });
  });
});

// 16. summarizeOtherWorkspaces
test.describe('summarizeOtherWorkspaces —— 其他工作区状态汇总', () => {
  test('典型输入：多工作区排查当前工作区后的最高优先级状态', () => {
    const availableDirs = ['/current', '/w1', '/w2'];
    const workdirStates = {
      '/current': 'permission',
      '/w1': 'busy',
      '/w2': 'terminal_waiting',
    };
    // 排除 /current，/w2 的 terminal_waiting(rank 2) 胜过 /w1 的 busy(rank 1)
    assert.equal(summarizeOtherWorkspaces(workdirStates, availableDirs, '/current'), 'terminal_waiting');
  });

  test('边界输入：null、undefined、空数组、无有效状态', () => {
    assert.equal(summarizeOtherWorkspaces(null, null, null), null);
    assert.equal(summarizeOtherWorkspaces({}, ['/a'], '/a'), null);
    assert.equal(summarizeOtherWorkspaces({ '/b': 'idle' }, ['/a', '/b'], '/a'), null);
    assert.equal(summarizeOtherWorkspaces({ '/b': 'done' }, ['/a', '/b'], '/a'), null);
  });

  test('产品语义：优先级 permission > error > terminal_waiting > busy', () => {
    const available = ['/curr', '/other1', '/other2'];
    const states1 = { '/other1': 'busy', '/other2': 'error' };
    assert.equal(summarizeOtherWorkspaces(states1, available, '/curr'), 'error');

    const states2 = { '/other1': 'error', '/other2': 'permission' };
    assert.equal(summarizeOtherWorkspaces(states2, available, '/curr'), 'permission');
  });
});

// 17. projectDisplayName
test.describe('projectDisplayName —— 项目显示名称提取', () => {
  test('典型输入：完整路径提取末段', () => {
    assert.equal(projectDisplayName('/Users/dev/code/my-project'), 'my-project');
    assert.equal(projectDisplayName('/var/repos/app-1/'), 'app-1');
  });

  test('边界输入：null、undefined、空串、根路径 /、连续斜杠', () => {
    assert.equal(projectDisplayName(null), '无项目');
    assert.equal(projectDisplayName(undefined), '无项目');
    assert.equal(projectDisplayName(''), '无项目');
    assert.equal(projectDisplayName('/'), '无项目');
    assert.equal(projectDisplayName('////'), '无项目');
  });

  test('产品语义：i18n 支持与非字符串转换', () => {
    assert.equal(projectDisplayName(12345), '12345');
    setLang('en');
    assert.equal(projectDisplayName(''), 'No project');
  });
});

// 18. shouldShowStartScreen
test.describe('shouldShowStartScreen —— 空启动页可见性判定', () => {
  test('典型输入：无 viewingInstanceId 或无 sessionId 时显示', () => {
    assert.equal(shouldShowStartScreen({ viewingInstanceId: null, sessionId: null }), true);
    assert.equal(shouldShowStartScreen({ viewingInstanceId: 'inst_1', sessionId: null }), true);
    assert.equal(shouldShowStartScreen({ viewingInstanceId: null, sessionId: 's1' }), true);
    assert.equal(shouldShowStartScreen({ viewingInstanceId: 'inst_1', sessionId: 's1' }), false);
  });

  test('边界输入：空入参、undefined', () => {
    assert.equal(shouldShowStartScreen(), true);
    assert.equal(shouldShowStartScreen({}), true);
  });

  test('产品语义：freshInterrupted 且有 viewingInstanceId 时不显启动页（保留已渲染气泡）', () => {
    assert.equal(shouldShowStartScreen({ viewingInstanceId: 'inst_1', sessionId: null, freshInterrupted: true }), false);
    // viewingInstanceId 缺失时仍必须显启动页
    assert.equal(shouldShowStartScreen({ viewingInstanceId: null, sessionId: null, freshInterrupted: true }), true);
  });

  test('产品语义：live 为真且有 viewingInstanceId 时不显启动页（流式事件已在途中）', () => {
    assert.equal(shouldShowStartScreen({ viewingInstanceId: 'inst_1', sessionId: null, live: true }), false);
    // 无 viewingInstanceId 时 live 不生效
    assert.equal(shouldShowStartScreen({ viewingInstanceId: null, live: true }), true);
  });
});

// 19. wasViewingInstanceDestroyed
test.describe('wasViewingInstanceDestroyed —— 正在查看的实例摧毁判定', () => {
  test('典型输入：曾在列表、现在消失、且无新查看目标 → 被摧毁', () => {
    assert.equal(wasViewingInstanceDestroyed({
      prevViewingInstanceId: 'inst_1',
      newViewingInstanceId: null,
      prevIds: ['inst_1', 'inst_2'],
      currIds: ['inst_2'],
    }), true);
  });

  test('边界输入：无 prevViewingInstanceId、Set 与 Array 支持', () => {
    assert.equal(wasViewingInstanceDestroyed(), false);
    assert.equal(wasViewingInstanceDestroyed({ prevViewingInstanceId: null }), false);
    assert.equal(wasViewingInstanceDestroyed({
      prevViewingInstanceId: 'inst_1',
      newViewingInstanceId: null,
      prevIds: new Set(['inst_1']),
      currIds: new Set([]),
    }), true);
  });

  test('产品语义：有新目标不是摧毁（用户主动切换）', () => {
    assert.equal(wasViewingInstanceDestroyed({
      prevViewingInstanceId: 'inst_1',
      newViewingInstanceId: 'inst_2',
      prevIds: ['inst_1'],
      currIds: [],
    }), false);
  });

  test('产品语义：用户主动关闭当前实例 (explicitCloseInstanceId) 不是意外摧毁', () => {
    assert.equal(wasViewingInstanceDestroyed({
      prevViewingInstanceId: 'inst_1',
      newViewingInstanceId: null,
      prevIds: ['inst_1'],
      currIds: [],
      explicitCloseInstanceId: 'inst_1',
    }), false);
    // 关的是别的实例，当前实例消失依然算摧毁
    assert.equal(wasViewingInstanceDestroyed({
      prevViewingInstanceId: 'inst_1',
      newViewingInstanceId: null,
      prevIds: ['inst_1'],
      currIds: [],
      explicitCloseInstanceId: 'other_inst',
    }), true);
  });

  test('产品语义：防御性判定（之前不在列表中或现在依然在列表）不判摧毁', () => {
    // 之前不在 prevIds 里
    assert.equal(wasViewingInstanceDestroyed({
      prevViewingInstanceId: 'inst_1',
      newViewingInstanceId: null,
      prevIds: ['inst_2'],
      currIds: [],
    }), false);
    // 现在依然在 currIds 里（如仅切换路由回首页）
    assert.equal(wasViewingInstanceDestroyed({
      prevViewingInstanceId: 'inst_1',
      newViewingInstanceId: null,
      prevIds: ['inst_1'],
      currIds: ['inst_1'],
    }), false);
  });
});

// 20. detectServerRestart
test.describe('detectServerRestart —— 服务端重启判定', () => {
  test('典型输入：前后 startedAt 存在且不同', () => {
    assert.equal(detectServerRestart({ prevStartedAt: 1000, newStartedAt: 2000 }), true);
    assert.equal(detectServerRestart({ prevStartedAt: 1000, newStartedAt: 1000 }), false);
  });

  test('边界输入：任一侧为 null / undefined / 空参保守返回 false', () => {
    assert.equal(detectServerRestart(), false);
    assert.equal(detectServerRestart({}), false);
    assert.equal(detectServerRestart({ prevStartedAt: 1000, newStartedAt: null }), false);
    assert.equal(detectServerRestart({ prevStartedAt: null, newStartedAt: 2000 }), false);
    assert.equal(detectServerRestart({ prevStartedAt: undefined, newStartedAt: 2000 }), false);
  });

  test('产品语义：缺字段不得当成变了（防误报实例摧毁）', () => {
    assert.equal(detectServerRestart({ prevStartedAt: 0, newStartedAt: 100 }), true);
    assert.equal(detectServerRestart({ prevStartedAt: 0, newStartedAt: 0 }), false);
  });
});

// 21. resolveEmptySurface
test.describe('resolveEmptySurface —— 空表面形态分流', () => {
  test('典型输入：destroyed / none / compose / home', () => {
    assert.equal(resolveEmptySurface({ instanceDestroyed: true }), 'destroyed');
    assert.equal(resolveEmptySurface({ viewingInstanceId: 'inst_1', sessionId: 'sess_1' }), 'none');
    assert.equal(resolveEmptySurface({ viewingInstanceId: null, sessionId: null, composeReady: true }), 'compose');
    assert.equal(resolveEmptySurface({ viewingInstanceId: null, sessionId: null, composeReady: false }), 'home');
  });

  test('边界输入：空入参', () => {
    assert.equal(resolveEmptySurface(), 'home');
    assert.equal(resolveEmptySurface({}), 'home');
  });

  test('产品语义：instanceDestroyed 优先于其余三态', () => {
    assert.equal(resolveEmptySurface({
      instanceDestroyed: true,
      viewingInstanceId: 'inst_1',
      sessionId: 's1',
      composeReady: true,
    }), 'destroyed');
  });

  test('产品语义：freshInterrupted 与 live 会话流判定为 none 而非启动页', () => {
    assert.equal(resolveEmptySurface({
      viewingInstanceId: 'inst_1',
      sessionId: null,
      freshInterrupted: true,
    }), 'none');
    assert.equal(resolveEmptySurface({
      viewingInstanceId: 'inst_1',
      sessionId: null,
      live: true,
    }), 'none');
  });
});

// 22. formatComposeDefaultsSummary
test.describe('formatComposeDefaultsSummary —— 新会话默认档摘要', () => {
  test('典型输入：全字段拼接', () => {
    const summary = formatComposeDefaultsSummary({
      modelLabel: 'Claude 3.7 Sonnet',
      modeLabel: '默认模式',
      effortLabel: '高',
    });
    assert.equal(summary, 'Claude 3.7 Sonnet · 默认模式 · 高');
  });

  test('边界输入：部分为空、纯空格、非字符串、空入参回落默认文案', () => {
    assert.equal(formatComposeDefaultsSummary(), '使用工作区默认配置');
    assert.equal(formatComposeDefaultsSummary({}), '使用工作区默认配置');
    assert.equal(formatComposeDefaultsSummary({ modelLabel: '   ', modeLabel: null, effortLabel: 123 }), '使用工作区默认配置');
  });

  test('产品语义：单项或双项过滤空字段后拼接', () => {
    assert.equal(formatComposeDefaultsSummary({ modelLabel: 'Sonnet' }), 'Sonnet');
    assert.equal(formatComposeDefaultsSummary({ modelLabel: 'Sonnet', effortLabel: '低' }), 'Sonnet · 低');
  });
});

// 23. shouldShowTopContextPill
test.describe('shouldShowTopContextPill —— 顶部工作区 Pill 可见性', () => {
  test('典型输入：真实会话中恒显示', () => {
    assert.equal(shouldShowTopContextPill({ viewingInstanceId: 'i1', sessionId: 's1' }), true);
  });

  test('边界输入：无参、空对象、无 cwd 时隐藏', () => {
    assert.equal(shouldShowTopContextPill(), false);
    assert.equal(shouldShowTopContextPill({}), false);
    assert.equal(shouldShowTopContextPill({ composeReady: true, cwd: null }), false);
    assert.equal(shouldShowTopContextPill({ composeReady: true, cwd: '' }), false);
  });

  test('产品语义：composeReady 且 cwd 确定时显示，空首页尚未选工作区时隐藏', () => {
    // composeReady 且有 cwd -> 允许浏览文件/git
    assert.equal(shouldShowTopContextPill({ viewingInstanceId: null, sessionId: null, composeReady: true, cwd: '/repo' }), true);
    // 空首页 (composeReady: false) -> 隐藏
    assert.equal(shouldShowTopContextPill({ viewingInstanceId: null, sessionId: null, composeReady: false, cwd: '/repo' }), false);
  });
});

// 24. sessionIdBlockView
test.describe('sessionIdBlockView —— 会话标识块展示视图', () => {
  test('典型输入：有 sessionId 时展示 row', () => {
    const res = sessionIdBlockView({ sessionId: 'session-123' });
    assert.deepEqual(res, { showRow: true, hint: null });
  });

  test('边界输入：空入参、纯空格 sessionId、数字 sessionId', () => {
    const empty = sessionIdBlockView();
    assert.equal(empty.showRow, false);
    assert.equal(empty.hint, '发出第一条消息后，CLI 才会创建会话并分配 ID。');

    const spaces = sessionIdBlockView({ sessionId: '   ' });
    assert.equal(spaces.showRow, false);

    const nonStr = sessionIdBlockView({ sessionId: 12345 });
    assert.equal(nonStr.showRow, false);
  });

  test('产品语义：分配在途 (viewingInstanceId 或 pendingFirstSend) vs 尚未发送', () => {
    // 1) 实例在，等待分配 ID
    const assigningInst = sessionIdBlockView({ sessionId: null, viewingInstanceId: 'inst_1' });
    assert.equal(assigningInst.showRow, false);
    assert.equal(assigningInst.hint, '会话创建中，CLI 分配 ID 后显示在这里。');

    // 2) pendingFirstSend 为真
    const assigningSend = sessionIdBlockView({ sessionId: null, pendingFirstSend: true });
    assert.equal(assigningSend.showRow, false);
    assert.equal(assigningSend.hint, '会话创建中，CLI 分配 ID 后显示在这里。');

    // 3) freshInterrupted 例外，归回未发送档
    const interrupted = sessionIdBlockView({
      sessionId: null,
      viewingInstanceId: 'inst_1',
      freshInterrupted: true,
    });
    assert.equal(interrupted.showRow, false);
    assert.equal(interrupted.hint, '发出第一条消息后，CLI 才会创建会话并分配 ID。');
  });
});

// 25. shouldShowRttChip
test.describe('shouldShowRttChip —— 顶栏 RTT 芯片可见性', () => {
  test('典型输入：合法非负有限数值显示', () => {
    assert.equal(shouldShowRttChip(0), true);
    assert.equal(shouldShowRttChip(42), true);
    assert.equal(shouldShowRttChip(120.5), true);
  });

  test('边界输入：负数、NaN、Infinity、null、undefined、字符串、对象', () => {
    assert.equal(shouldShowRttChip(-1), false);
    assert.equal(shouldShowRttChip(-0.1), false);
    assert.equal(shouldShowRttChip(NaN), false);
    assert.equal(shouldShowRttChip(Infinity), false);
    assert.equal(shouldShowRttChip(-Infinity), false);
    assert.equal(shouldShowRttChip(null), false);
    assert.equal(shouldShowRttChip(undefined), false);
    assert.equal(shouldShowRttChip('42'), false);
    assert.equal(shouldShowRttChip({}), false);
  });
});

// 26. shouldShowComposer
test.describe('shouldShowComposer —— 输入框可见性判定', () => {
  test('典型输入：有 sessionId、或 composeReady、或 pendingFirstSend 时显示', () => {
    assert.equal(shouldShowComposer({ sessionId: 's1' }), true);
    assert.equal(shouldShowComposer({ composeReady: true }), true);
    assert.equal(shouldShowComposer({ pendingFirstSend: true }), true);
  });

  test('边界输入：空入参、空串 sessionId、无实例的空首页隐藏', () => {
    assert.equal(shouldShowComposer(), false);
    assert.equal(shouldShowComposer({}), false);
    assert.equal(shouldShowComposer({ sessionId: '' }), false);
    assert.equal(shouldShowComposer({ viewingInstanceId: null }), false);
  });

  test('产品语义：freshInterrupted 且有 viewingInstanceId 时保持可见', () => {
    assert.equal(shouldShowComposer({ viewingInstanceId: 'inst_1', freshInterrupted: true }), true);
    // viewingInstanceId 为空时不能凭空绕过
    assert.equal(shouldShowComposer({ viewingInstanceId: null, freshInterrupted: true }), false);
  });
});

// 27. mergeRecentSessionsAcrossWorkspaces
test.describe('mergeRecentSessionsAcrossWorkspaces —— 跨工作区合并最近会话', () => {
  test('典型输入：合并多个工作区会话并按 lastUsedAt 降序排列', () => {
    const dirLists = [
      {
        cwd: '/repo1',
        sessions: [
          { id: 's1', title: '会话1', lastUsedAt: 100 },
          { id: 's2', title: '会话2', lastUsedAt: 300 },
        ],
      },
      {
        cwd: '/repo2',
        sessions: [
          { id: 's3', title: '会话3', lastUsedAt: 200 },
        ],
      },
    ];
    const merged = mergeRecentSessionsAcrossWorkspaces(dirLists, { limit: 5 });
    assert.equal(merged.length, 3);
    assert.equal(merged[0].id, 's2');
    assert.equal(merged[1].id, 's3');
    assert.equal(merged[2].id, 's1');
  });

  test('边界输入：null、undefined、缺少字段、非法 limit（0 / 负数 / NaN / 浮点数截断）', () => {
    assert.deepEqual(mergeRecentSessionsAcrossWorkspaces(null), []);
    assert.deepEqual(mergeRecentSessionsAcrossWorkspaces([]), []);

    const invalidEntries = [
      null,
      {},
      { cwd: null },
      { cwd: '/a', sessions: null },
      { cwd: '/a', sessions: [{ id: null }, { title: '无id' }] },
    ];
    assert.deepEqual(mergeRecentSessionsAcrossWorkspaces(invalidEntries), []);

    const valid = [{ cwd: '/a', sessions: [{ id: '1', lastUsedAt: 10 }, { id: '2', lastUsedAt: 20 }] }];
    assert.equal(mergeRecentSessionsAcrossWorkspaces(valid, { limit: 0 }).length, 2); // limit=0 回落默认 8
    assert.equal(mergeRecentSessionsAcrossWorkspaces(valid, { limit: -5 }).length, 2);
    assert.equal(mergeRecentSessionsAcrossWorkspaces(valid, { limit: 'invalid' }).length, 2);
    assert.equal(mergeRecentSessionsAcrossWorkspaces(valid, { limit: 1.8 }).length, 1);
  });

  test('产品语义：worktree 真实 cwd 优先，workspaceName 覆盖与缺省标题兜底', () => {
    const dirLists = [
      {
        cwd: '/parent',
        workspaceName: '自定义名',
        sessions: [
          { id: 'w1', cwd: '/parent/.claude/worktrees/branch-1', worktree: 'branch-1', title: '' },
        ],
      },
    ];
    const res = mergeRecentSessionsAcrossWorkspaces(dirLists);
    assert.equal(res[0].cwd, '/parent/.claude/worktrees/branch-1');
    assert.equal(res[0].workspaceName, '自定义名');
    assert.equal(res[0].title, '无标题会话');
    assert.equal(res[0].worktree, 'branch-1');
  });
});

// 28. summarizeRecentsLoad
test.describe('summarizeRecentsLoad —— 最近会话加载状态汇总', () => {
  test('典型输入：包含超时目录与全量成功', () => {
    const listSuccess = [{ cwd: '/a', timedOut: false }, { cwd: '/b' }];
    assert.deepEqual(summarizeRecentsLoad(listSuccess), {
      complete: true,
      failedCount: 0,
      failedDirs: [],
    });

    const listWithTimeout = [
      { cwd: '/a', timedOut: false },
      { cwd: '/b', timedOut: true },
      { cwd: '/c', timedOut: true },
    ];
    assert.deepEqual(summarizeRecentsLoad(listWithTimeout), {
      complete: false,
      failedCount: 2,
      failedDirs: ['/b', '/c'],
    });
  });

  test('边界输入：null、undefined、空数组、非数组、畸形项', () => {
    assert.deepEqual(summarizeRecentsLoad(null), { complete: true, failedCount: 0, failedDirs: [] });
    assert.deepEqual(summarizeRecentsLoad(undefined), { complete: true, failedCount: 0, failedDirs: [] });
    assert.deepEqual(summarizeRecentsLoad([]), { complete: true, failedCount: 0, failedDirs: [] });
    assert.deepEqual(summarizeRecentsLoad([null, {}, { cwd: '' }]), { complete: true, failedCount: 0, failedDirs: [] });
  });
});

// 29. shouldRestoreOptimisticBusy
test.describe('shouldRestoreOptimisticBusy —— 乐观 Busy 状态恢复判定', () => {
  test('典型输入：新会话首发懒开 与 同会话静默换实例', () => {
    // 1) 新会话首发
    assert.equal(shouldRestoreOptimisticBusy({
      viewingInstanceId: 'inst_1',
      pendingFirstSend: true,
      sessionId: null,
    }), true);

    // 2) 同会话静默换实例
    assert.equal(shouldRestoreOptimisticBusy({
      viewingInstanceId: 'inst_2',
      sessionId: 'sess_1',
      pendingSendBusySessionId: 'sess_1',
    }), true);
  });

  test('边界输入：无 viewingInstanceId 恒为 false', () => {
    assert.equal(shouldRestoreOptimisticBusy(), false);
    assert.equal(shouldRestoreOptimisticBusy({}), false);
    assert.equal(shouldRestoreOptimisticBusy({ viewingInstanceId: null, pendingFirstSend: true }), false);
    assert.equal(shouldRestoreOptimisticBusy({ viewingInstanceId: undefined, pendingSendBusySessionId: 's1', sessionId: 's1' }), false);
  });

  test('产品语义：防止跨会话误捡（pendingSendBusySessionId 与当前 sessionId 不一致时不恢复）', () => {
    assert.equal(shouldRestoreOptimisticBusy({
      viewingInstanceId: 'inst_1',
      sessionId: 'sess_current',
      pendingSendBusySessionId: 'sess_stale_from_another',
    }), false);
  });

  test('产品语义：已存在 sessionId 的会话不能仅凭 pendingFirstSend 恢复', () => {
    assert.equal(shouldRestoreOptimisticBusy({
      viewingInstanceId: 'inst_1',
      sessionId: 'sess_existing',
      pendingFirstSend: true,
    }), false);
  });
});

// 30. whatNeedsAttention
test.describe('whatNeedsAttention —— 需要你待办聚合与服务告警隔离', () => {
  test('典型输入：needsYou 待办事项聚合', () => {
    const res = whatNeedsAttention({
      needsYou: [
        { reason: 'awaiting_input', instanceId: 'i1', title: '请输入确认' },
        { reason: 'awaiting_approval', sessionId: 's2', toolName: 'Bash' },
      ],
    });
    assert.equal(res.level, 'attention');
    assert.equal(res.items.length, 2);
    assert.equal(res.items[0].kind, 'awaiting_input');
    assert.equal(res.items[0].ref, 'i1');
    assert.equal(res.items[0].summary, '请输入确认');
    assert.equal(res.items[1].kind, 'awaiting_approval');
    assert.equal(res.items[1].ref, 's2');
    assert.equal(res.items[1].summary, 'Bash');
  });

  test('边界输入：空入参、空对象、空数组、包含 null 项', () => {
    assert.deepEqual(whatNeedsAttention(), { level: 'ok', items: [] });
    assert.deepEqual(whatNeedsAttention({}), { level: 'ok', items: [] });
    assert.deepEqual(whatNeedsAttention({ needsYou: [null, undefined] }), { level: 'ok', items: [] });
  });

  test('产品语义：needsYou 为空但 instance 仍处于 permission 状态时兜底补齐', () => {
    const res = whatNeedsAttention({
      needsYou: [],
      instances: [{ instanceId: 'inst_p', state: 'permission', title: '待执行' }],
    });
    assert.equal(res.level, 'attention');
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].kind, 'awaiting_approval');
    assert.equal(res.items[0].ref, 'inst_p');
    assert.equal(res.items[0].summary, '待执行');
  });

  // 本函数只解构 { instances, needsYou }——服务告警在这一层根本进不来，
  // 「两轴绝不混判」由接口形状保证，不是这里能测的。这条守的是兜底分支的【触发条件】：
  // 只有 state === 'permission' 才补条目，busy/idle 一律不算待办。
  test('产品语义：兜底分支只认 permission，busy/idle 的实例不算待办', () => {
    const res = whatNeedsAttention({
      needsYou: [],
      instances: [{ instanceId: 'i1', state: 'busy' }, { instanceId: 'i2', state: 'idle' }],
    });
    assert.equal(res.level, 'ok');
    assert.deepEqual(res.items, []);
  });
});

// 31. resolveHeaderConnBadge
test.describe('resolveHeaderConnBadge —— 顶栏连接角标解析', () => {
  test('典型输入：在线且有待办 vs 离线 vs 正常在线', () => {
    const offline = resolveHeaderConnBadge({ connected: false, everConnected: true });
    assert.deepEqual(offline, {
      visible: true,
      tone: 'danger',
      conn: 'offline',
      reason: 'offline',
      title: '未连接',
    });

    const attention = resolveHeaderConnBadge({
      connected: true,
      attentionLevel: 'attention',
      needsYouCount: 3,
    });
    assert.deepEqual(attention, {
      visible: true,
      tone: 'warning',
      conn: 'online',
      reason: 'attention',
      title: '需要你 (3)',
    });

    const normal = resolveHeaderConnBadge({ connected: true, attentionLevel: 'ok' });
    assert.deepEqual(normal, {
      visible: false,
      tone: null,
      conn: 'online',
      reason: 'ok',
      title: '',
    });
  });

  test('边界输入：无参、首次连接中 (everConnected=false) 不亮红点', () => {
    const initial = resolveHeaderConnBadge();
    assert.equal(initial.visible, false);
    assert.equal(initial.conn, 'connecting');

    const connecting = resolveHeaderConnBadge({ connected: false, everConnected: false });
    assert.equal(connecting.visible, false);
    assert.equal(connecting.conn, 'connecting');
  });

  test('产品语义：needsYouCount 为 0 或缺省时标题显示省略号', () => {
    const attZero = resolveHeaderConnBadge({ connected: true, attentionLevel: 'attention', needsYouCount: 0 });
    assert.equal(attZero.title, '需要你 (…)');
  });

  // 本函数只解构 { connected, everConnected, attentionLevel, needsYouCount }，
  // 服务告警进不来。这条守的是：在线 + 无待办 → 角标不亮。
  test('产品语义：在线且 attentionLevel 为 ok 时角标不亮', () => {
    const quiet = resolveHeaderConnBadge({ connected: true, attentionLevel: 'ok' });
    assert.equal(quiet.visible, false);
    assert.equal(quiet.reason, 'ok');
  });
});

// 32. resolveHeaderAttentionChip
test.describe('resolveHeaderAttentionChip —— 顶栏注意力 Chip 文本与准入控制', () => {
  test('典型输入：未连接、需要你、其他工作区（permission / error）', () => {
    assert.deepEqual(resolveHeaderAttentionChip({ badgeReason: 'offline' }), {
      visible: true,
      tone: 'danger',
      reason: 'offline',
      text: '未连接',
    });
    assert.deepEqual(resolveHeaderAttentionChip({ badgeReason: 'attention', needsYouCount: 2 }), {
      visible: true,
      tone: 'warning',
      reason: 'attention',
      text: '需要你 2',
    });
    assert.deepEqual(resolveHeaderAttentionChip({ badgeReason: 'ok', otherWorkspaceStatus: 'permission' }), {
      visible: true,
      tone: 'warning',
      reason: 'other-workspace',
      text: '其他工作区 · 需要你',
    });
    assert.deepEqual(resolveHeaderAttentionChip({ badgeReason: 'ok', otherWorkspaceStatus: 'error' }), {
      visible: true,
      tone: 'danger',
      reason: 'other-workspace',
      text: '其他工作区 · 出错',
    });
  });

  test('边界输入：无参、空对象、未知 reason 隐藏', () => {
    assert.deepEqual(resolveHeaderAttentionChip(), {
      visible: false,
      tone: null,
      reason: 'ok',
      text: '',
    });
    assert.deepEqual(resolveHeaderAttentionChip({}), {
      visible: false,
      tone: null,
      reason: 'ok',
      text: '',
    });
  });

  // 本函数只解构 { badgeReason, needsYouCount, otherWorkspaceStatus }，服务告警进不来。
  // 这条守的是 chip 的准入闸本身：三项都「无事」时必须不亮。
  test('产品语义：badgeReason=ok 且无待办、无其他工作区状态时 chip 必须不亮', () => {
    const res = resolveHeaderAttentionChip({
      badgeReason: 'ok',
      needsYouCount: 0,
      otherWorkspaceStatus: null,
    });
    assert.equal(res.visible, false);
    assert.equal(res.tone, null);
    assert.equal(res.text, '');
  });

  test('产品语义：其他工作区 busy 和 terminal_waiting 绝不进准入表（必须隐藏）', () => {
    const busyChip = resolveHeaderAttentionChip({ badgeReason: 'ok', otherWorkspaceStatus: 'busy' });
    assert.equal(busyChip.visible, false);

    const termWaitingChip = resolveHeaderAttentionChip({ badgeReason: 'ok', otherWorkspaceStatus: 'terminal_waiting' });
    assert.equal(termWaitingChip.visible, false);
  });
});

// 33. resolveDeepLinkTarget
test.describe('resolveDeepLinkTarget —— 通知深链落地动作解析', () => {
  test('典型输入：匹配 live 实例 -> setViewing，匹配 session -> switch，未匹配 -> list', () => {
    const instances = [
      { instanceId: 'inst_1', sessionId: 'sess_1' },
      { instanceId: 'inst_2', sessionId: 'sess_2' },
    ];
    // 1) 匹配 live 实例
    assert.deepEqual(
      resolveDeepLinkTarget({ instanceId: 'inst_1', sessionId: 'sess_1' }, instances),
      { action: 'setViewing', instanceId: 'inst_1' }
    );
    // 2) 实例不匹配但有 sessionId
    assert.deepEqual(
      resolveDeepLinkTarget({ instanceId: 'inst_stale', sessionId: 'sess_1', cwd: '/dir' }, instances),
      { action: 'switch', sessionId: 'sess_1', cwd: '/dir' }
    );
    // 3) 均无法匹配
    assert.deepEqual(
      resolveDeepLinkTarget({ instanceId: 'inst_stale' }, instances),
      { action: 'list' }
    );
  });

  test('边界输入：null target、缺 instanceId、instances 非数组', () => {
    assert.deepEqual(resolveDeepLinkTarget(null), { action: 'list' });
    assert.deepEqual(resolveDeepLinkTarget({}), { action: 'list' });
    assert.deepEqual(resolveDeepLinkTarget({ sessionId: 's1' }), { action: 'list' });
    assert.deepEqual(resolveDeepLinkTarget({ instanceId: 'i1' }, null), { action: 'list' });
  });

  test('产品语义：防重启发号重叠（instanceId 相同但 sessionId 对不上时不当 live）', () => {
    const instances = [{ instanceId: 'inst_1', sessionId: 'sess_current_project' }];
    const targetOldNotification = { instanceId: 'inst_1', sessionId: 'sess_old_another_project', cwd: '/old' };
    const res = resolveDeepLinkTarget(targetOldNotification, instances);
    assert.equal(res.action, 'switch');
    assert.equal(res.sessionId, 'sess_old_another_project');
    assert.equal(res.cwd, '/old');
  });
});

// 34. resolveSheetDragEnd
test.describe('resolveSheetDragEnd —— 底栏 Sheet 拖拽释放判定', () => {
  test('典型输入：位移足够关闭 vs 快速下甩关闭 vs 弹回 snap', () => {
    assert.equal(resolveSheetDragEnd({ dy: 100 }), 'close');
    assert.equal(resolveSheetDragEnd({ dy: 30, velocityY: 0.6 }), 'close');
    assert.equal(resolveSheetDragEnd({ dy: 40, velocityY: 0.2 }), 'snap');
  });

  test('边界输入：空参、非数字、向上拖拽（dy < 0 恒 snap）', () => {
    assert.equal(resolveSheetDragEnd(), 'snap');
    assert.equal(resolveSheetDragEnd({ dy: -50, velocityY: 2.0 }), 'snap');
    assert.equal(resolveSheetDragEnd({ dy: 'invalid', velocityY: 'invalid' }), 'snap');
  });

  test('产品语义：自定义阈值生效判定', () => {
    assert.equal(resolveSheetDragEnd({ dy: 50, dismissPx: 40 }), 'close');
    assert.equal(resolveSheetDragEnd({ dy: 20, velocityY: 1.0, minFlickDy: 30 }), 'snap');
  });
});

// 35. shouldRerenderSessionList
test.describe('shouldRerenderSessionList —— 会话列表 SWR 重渲判定', () => {
  test('典型输入：首屏渲染、列表变动、与无变动跳过', () => {
    // 首次无缓存
    assert.equal(shouldRerenderSessionList({ hasPrevEntry: false }), true);

    const prevSessions = [{ id: 's1', title: 'A', lastUsedAt: 100, terminal: null }];
    const nextSessionsSame = [{ id: 's1', title: 'A', lastUsedAt: 100, terminal: null }];
    const nextSessionsChanged = [{ id: 's1', title: 'A', lastUsedAt: 200, terminal: null }];

    // 完全相同 -> false
    assert.equal(shouldRerenderSessionList({
      hasPrevEntry: true,
      prevSessions,
      nextSessions: nextSessionsSame,
    }), false);

    // 会话字段变更 -> true
    assert.equal(shouldRerenderSessionList({
      hasPrevEntry: true,
      prevSessions,
      nextSessions: nextSessionsChanged,
    }), true);
  });

  test('边界输入：空入参、null sessions、含有 null 项', () => {
    assert.equal(shouldRerenderSessionList(), true);
    assert.equal(shouldRerenderSessionList({ hasPrevEntry: true, prevSessions: null, nextSessions: null }), false);
    assert.equal(shouldRerenderSessionList({ hasPrevEntry: true, prevSessions: [null], nextSessions: [null] }), false);
  });

  test('产品语义：hasMore、total 变更及 pinned 置顶项变动均触发重渲', () => {
    assert.equal(shouldRerenderSessionList({
      hasPrevEntry: true,
      prevHasMore: false,
      nextHasMore: true,
    }), true);

    assert.equal(shouldRerenderSessionList({
      hasPrevEntry: true,
      prevTotal: 10,
      nextTotal: 11,
    }), true);

    assert.equal(shouldRerenderSessionList({
      hasPrevEntry: true,
      prevPinned: [{ id: 'p1', title: '置顶' }],
      nextPinned: [],
    }), true);
  });

  test('产品语义：title 前 40 字截断（超过 40 字以外的改动不重渲）', () => {
    const longTitle1 = 'a'.repeat(40) + 'xyz';
    const longTitle2 = 'a'.repeat(40) + '123';
    assert.equal(shouldRerenderSessionList({
      hasPrevEntry: true,
      prevSessions: [{ id: 's1', title: longTitle1 }],
      nextSessions: [{ id: 's1', title: longTitle2 }],
    }), false);
  });
});

// 36. buildDirInstanceSignatures & 37. diffDirSignatures
test.describe('buildDirInstanceSignatures & diffDirSignatures —— 实例签名生成与差异比对', () => {
  test('成对测试：签名相同 → 无差异', () => {
    const dirs = ['/repoA', '/repoB'];
    const instances = [
      { cwd: '/repoA', instanceId: 'i1', sessionId: 's1', title: 'Work' },
      { cwd: '/repoB', instanceId: 'i2', sessionId: 's2', title: 'Task' },
    ];
    const sig1 = buildDirInstanceSignatures(instances, dirs);
    const sig2 = buildDirInstanceSignatures(instances, dirs);
    const diff = diffDirSignatures(sig1, sig2);
    assert.deepEqual(diff, []);
  });

  test('成对测试：某个维度变了 → 差异里体现出来（且保持字母排序）', () => {
    const dirs = ['/repoB', '/repoA'];
    const inst1 = [
      { cwd: '/repoA', instanceId: 'i1', sessionId: 's1', title: 'Work' },
      { cwd: '/repoB', instanceId: 'i2', sessionId: 's2', title: 'Task' },
    ];
    const inst2 = [
      { cwd: '/repoA', instanceId: 'i1', sessionId: 's1', title: 'Work-Modified' },
      { cwd: '/repoB', instanceId: 'i2', sessionId: 's2', title: 'Task-Modified' },
    ];
    const sig1 = buildDirInstanceSignatures(inst1, dirs);
    const sig2 = buildDirInstanceSignatures(inst2, dirs);
    const diff = diffDirSignatures(sig1, sig2);
    // 必须升序排列
    assert.deepEqual(diff, ['/repoA', '/repoB']);
  });

  test('边界输入：null、undefined、空对象、无 instanceId 的实例跳过', () => {
    assert.deepEqual(buildDirInstanceSignatures(null, null), {});
    assert.deepEqual(buildDirInstanceSignatures([{ cwd: '/a' }], ['/a']), { '/a': '' });
    assert.deepEqual(diffDirSignatures(null, null), []);
    assert.deepEqual(diffDirSignatures({ '/a': 'x' }, {}), ['/a']);
    assert.deepEqual(diffDirSignatures({}, { '/b': 'y' }), ['/b']);
  });

  test('产品语义：状态字段 (busy/idle 等) 故意不进签名（避免牵动 DOM 重建）', () => {
    const dirs = ['/repo'];
    const instIdle = [{ cwd: '/repo', instanceId: 'i1', sessionId: 's1', title: 'Title', state: 'idle' }];
    const instBusy = [{ cwd: '/repo', instanceId: 'i1', sessionId: 's1', title: 'Title', state: 'busy' }];
    const sigIdle = buildDirInstanceSignatures(instIdle, dirs);
    const sigBusy = buildDirInstanceSignatures(instBusy, dirs);
    assert.deepEqual(sigIdle, sigBusy);
    assert.deepEqual(diffDirSignatures(sigIdle, sigBusy), []);
  });

  test('产品语义：title 截断前 20 字', () => {
    const dirs = ['/repo'];
    const inst1 = [{ cwd: '/repo', instanceId: 'i1', sessionId: 's1', title: 'a'.repeat(20) + 'xyz' }];
    const inst2 = [{ cwd: '/repo', instanceId: 'i1', sessionId: 's1', title: 'a'.repeat(20) + '123' }];
    assert.deepEqual(buildDirInstanceSignatures(inst1, dirs), buildDirInstanceSignatures(inst2, dirs));
  });
});
