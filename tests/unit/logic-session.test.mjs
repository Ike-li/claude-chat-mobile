// tests/unit/logic-session.test.mjs —— 会话/工作区维度的状态聚合（抽屉与首页角标的判据）
// 覆盖：aggregateStates 的状态优先级 permission>error>busy>done>idle
//       · worktree cwd 归入最长前缀父仓（K2 角标）· 实例 cwd 不在 dirs 时也要计入
//       · resolveDrawerStatus——「需要你」与「出错」优先于 Web/终端运行态
// 这里的优先级不是审美选择：把「需要你」排在运行态后面，用户就会看着一个转圈图标等一个
// 其实在等他回答的会话。
// 这份从原 logic.test.mjs 拆出，同源的还有 -content、-rendering、-ui-state。
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelEntryFor, modelLabelFor, resolveModelDisplayName, resolveGatewayModelName, resolveModelPillText, resolveSendModel, defaultResolvedModel, effortLevelsFor, effortUiState, resolvePanelState, resolvePanelCwd, resolveSessionCwd, resolveWorktreeGoneNotice, aggregateStates, owningWorkspace, resolveDrawerStatus, resolveDrawerStatusChip, formatSessionRowSubtitle, summarizeOtherWorkspaces, projectDisplayName, shouldShowStartScreen, shouldShowComposer, shouldShowTopContextPill, resolveEmptySurface, formatComposeDefaultsSummary, shouldRestoreOptimisticBusy, shouldClearInputOnBindView, planSessionDraftSwap, isAnsweredQuestionId, shouldDropAgentEvent, presentTurnResult, applyGatewaySuffix } from '../../app/public/js/logic.js';

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

test('aggregateStates: worktree cwd 归入最长前缀父仓（K2 角标）', () => {
  const dirs = ['/repo/a', '/repo/b'];
  const r = aggregateStates(
    [{ cwd: '/repo/a/.worktrees/promo', state: 'busy' }],
    dirs,
  );
  assert.equal(r['/repo/a'], 'busy');
  assert.equal(r['/repo/b'], 'idle');
});

test('resolveDrawerStatus: 需要你/出错优先于 Web 或终端运行态', () => {
  assert.equal(resolveDrawerStatus({ liveState: 'permission', terminalState: 'busy' }), 'permission');
  assert.equal(resolveDrawerStatus({ liveState: 'error', terminalState: 'busy' }), 'error');
  assert.equal(resolveDrawerStatus({ liveState: 'busy', terminalState: 'alive' }), 'busy');
});

test('resolveDrawerStatus: terminal busy 不被 idle/done live 实例遮蔽；普通终态不显示主状态', () => {
  assert.equal(resolveDrawerStatus({ liveState: 'idle', terminalState: 'busy' }), 'busy');
  assert.equal(resolveDrawerStatus({ liveState: 'done', terminalState: 'busy' }), 'busy');
  assert.equal(resolveDrawerStatus({ terminalState: 'busy' }), 'busy');
  assert.equal(resolveDrawerStatus({ terminalState: 'alive' }), null);
  assert.equal(resolveDrawerStatus({ liveState: 'done' }), null);
  assert.equal(resolveDrawerStatus({ liveState: 'aborted' }), null);
  assert.equal(resolveDrawerStatus(), null);
});

// 会话行 chip 文案：三态 kind 不变，busy 按「此刻谁在干活」区分 Web / CLI。
// 抽屉没有独立的 origin/resume 字段，驾驶组合只能用 liveState × terminalState 表达。
test('resolveDrawerStatusChip: 纯 Web 回合 → 运行中；CLI 空闲挂着不改 Web 文案', () => {
  assert.deepEqual(resolveDrawerStatusChip({ liveState: 'busy' }), { status: 'busy', label: '运行中' });
  assert.deepEqual(resolveDrawerStatusChip({ liveState: 'busy', terminalState: 'alive' }), { status: 'busy', label: '运行中' });
});

test('resolveDrawerStatusChip: CLI 正在跑（纯终端 / Web 只读镜像 / Web 空闲 tab）→ 终端运行中', () => {
  assert.deepEqual(resolveDrawerStatusChip({ terminalState: 'busy' }), { status: 'busy', label: '终端运行中' });
  assert.deepEqual(resolveDrawerStatusChip({ liveState: 'idle', terminalState: 'busy' }), { status: 'busy', label: '终端运行中' });
  assert.deepEqual(resolveDrawerStatusChip({ liveState: 'done', terminalState: 'busy' }), { status: 'busy', label: '终端运行中' });
  assert.deepEqual(resolveDrawerStatusChip({ liveState: 'aborted', terminalState: 'busy' }), { status: 'busy', label: '终端运行中' });
});

test('resolveDrawerStatusChip: Web 与 CLI 同时 busy（续接重叠 / 双写窗口）仍标终端运行中', () => {
  // Web 续接了但 CLI 回合未结束，或 Web 会话被 CLI --resume 抢走且 Web 实例还没 settle。
  // 终端 registry 是「别人正在写」的权威信号，chip 必须把来源写在标题行上。
  assert.deepEqual(resolveDrawerStatusChip({ liveState: 'busy', terminalState: 'busy' }), { status: 'busy', label: '终端运行中' });
});

test('resolveDrawerStatusChip: 需要你/出错仍优先；空闲与 CLI 挂着无主 chip', () => {
  assert.deepEqual(resolveDrawerStatusChip({ liveState: 'permission', terminalState: 'busy' }), { status: 'permission', label: '需要你' });
  assert.deepEqual(resolveDrawerStatusChip({ liveState: 'error', terminalState: 'busy' }), { status: 'error', label: '出错' });
  assert.equal(resolveDrawerStatusChip({ liveState: 'idle', terminalState: 'alive' }), null);
  assert.equal(resolveDrawerStatusChip({ terminalState: 'alive' }), null);
  assert.equal(resolveDrawerStatusChip({ liveState: 'idle' }), null);
  assert.equal(resolveDrawerStatusChip(), null);
});

// ── 2026-09-04：terminalState='waiting'（CLI 卡在对话框上等人，含权限审批框）─────────────
// 在这之前，等审批的终端会话在抽屉里与「终端开着但闲着」完全同形——只有一句副文本「终端已打开」。
// 那是最需要用户注意的状态，却被归进了最不需要的那一档（根因见 session-registry.js 的 status 枚举）。
test('resolveDrawerStatus: terminal waiting（终端等你按键）排在 busy 之前——它才是要人动手的那个', () => {
  assert.equal(resolveDrawerStatus({ terminalState: 'waiting' }), 'terminal_waiting');
  // Web 自己在跑 + CLI 卡在审批上：先说 CLI 那件事，跑完的会自己跑完，等人的不会
  assert.equal(resolveDrawerStatus({ liveState: 'busy', terminalState: 'waiting' }), 'terminal_waiting');
  assert.equal(resolveDrawerStatus({ liveState: 'idle', terminalState: 'waiting' }), 'terminal_waiting');
  // 但 Web 自己的审批/出错仍优先：那两个在手机上点一下就能处理，终端那个得走到电脑前
  assert.equal(resolveDrawerStatus({ liveState: 'permission', terminalState: 'waiting' }), 'permission');
  assert.equal(resolveDrawerStatus({ liveState: 'error', terminalState: 'waiting' }), 'error');
});

test('resolveDrawerStatusChip: terminal waiting → 「终端需要你」，与 Web 侧「需要你」区分开', () => {
  assert.deepEqual(resolveDrawerStatusChip({ terminalState: 'waiting' }), { status: 'terminal_waiting', label: '终端需要你' });
  assert.deepEqual(resolveDrawerStatusChip({ liveState: 'busy', terminalState: 'waiting' }), { status: 'terminal_waiting', label: '终端需要你' });
  // 措辞必须不同：Web 的「需要你」点开就能批，终端的批不了，只能去电脑上按
  assert.deepEqual(resolveDrawerStatusChip({ liveState: 'permission' }), { status: 'permission', label: '需要你' });
});

// 2026-09-06：外部驾驶员不只有终端了。桌面端 Code 模式（Claude.app 的 Code 标签）跑的是同一份
// claude 二进制，但把它说成"终端"会给出错的处理预期——用户会去翻终端标签页，而回合其实跑在
// 桌面 app 的窗口里。状态轴不变（都是 busy/alive），只有措辞按来源分。
test('resolveDrawerStatusChip: 桌面端 Code 模式驾驶 → 桌面端运行中，不冒充"终端"', () => {
  assert.deepEqual(
    resolveDrawerStatusChip({ terminalState: 'busy', terminalSource: 'claude-desktop' }),
    { status: 'busy', label: '桌面端运行中' },
  );
  // Web 侧同时 busy 时仍以外部驾驶员为准（与 cli 同规矩），只是措辞跟着来源走
  assert.deepEqual(
    resolveDrawerStatusChip({ liveState: 'busy', terminalState: 'busy', terminalSource: 'claude-desktop' }),
    { status: 'busy', label: '桌面端运行中' },
  );
  // 来源明确是 cli / 缺失 / 未知取值：一律回落"终端运行中"（= 引入本字段之前的行为）
  assert.deepEqual(resolveDrawerStatusChip({ terminalState: 'busy', terminalSource: 'cli' }), { status: 'busy', label: '终端运行中' });
  assert.deepEqual(resolveDrawerStatusChip({ terminalState: 'busy' }), { status: 'busy', label: '终端运行中' });
  assert.deepEqual(resolveDrawerStatusChip({ terminalState: 'busy', terminalSource: 'brand-new' }), { status: 'busy', label: '终端运行中' });
  // 纯 Web 回合不受来源影响：terminalState 不是 busy 时来源无意义
  assert.deepEqual(resolveDrawerStatusChip({ liveState: 'busy', terminalSource: 'claude-desktop' }), { status: 'busy', label: '运行中' });
});

test('formatSessionRowSubtitle: 桌面端已打开与终端已打开分开说', () => {
  assert.equal(
    formatSessionRowSubtitle({ whenText: '9/6', terminalState: 'alive', terminalSource: 'claude-desktop', shortId: 'abcdef12' }),
    '桌面端已打开 · 9/6 · abcdef12',
  );
  assert.equal(
    formatSessionRowSubtitle({ whenText: '9/6', terminalState: 'alive', terminalSource: 'cli', shortId: 'abcdef12' }),
    '终端已打开 · 9/6 · abcdef12',
  );
  // 来源缺失回落终端（老服务端的行）
  assert.equal(
    formatSessionRowSubtitle({ whenText: '9/6', terminalState: 'alive', shortId: 'abcdef12' }),
    '终端已打开 · 9/6 · abcdef12',
  );
});

// worktree 目录已被删掉的会话现在仍列在抽屉里（transcript 还在盘上），但它**点不开**——
// cwd 没了，SDK 起不来。不在行上说这一句，用户只能靠点一次、读一段报错才知道，而这一行
// 跟活着的 worktree 行长得一模一样。
test('formatSessionRowSubtitle: worktree 已删的行要当场看得出来', () => {
  assert.equal(
    formatSessionRowSubtitle({ whenText: '9/13', worktree: 'chatgpt-gbwh', worktreeGone: true, shortId: '5a8793ca' }),
    'worktree chatgpt-gbwh（已删除） · 9/13 · 5a8793ca',
    '不标出来 = 用户点一次才知道打不开，而这行和活着的 worktree 行没有任何区别',
  );
  assert.equal(
    formatSessionRowSubtitle({ whenText: '9/13', worktree: 'alive-one', shortId: '5a8793ca' }),
    'worktree alive-one · 9/13 · 5a8793ca',
    '活着的 worktree 不许带这个后缀',
  );
  // 非 worktree 行不受影响：即便服务端漏带 worktree 名也不该凭空冒出一个「（已删除）」
  assert.equal(
    formatSessionRowSubtitle({ whenText: '9/13', worktreeGone: true, shortId: '5a8793ca' }),
    '9/13 · 5a8793ca',
  );
});

// 文件/改动面板跟的是「当前会话在哪个工作树」，不是「当前工作区」。这两者在托管 worktree
// 打开时会分叉：工作区轴仍是父仓（不新增抽屉条目），而 claude 实际在 worktree 里改文件。
// 判错的症状是改动面板空着——而「看起来没改动」和「真的没改动」在 UI 上无法区分。
test('resolvePanelCwd: 跟当前实例的 cwd，无实例时回落工作区 cwd', () => {
  const instances = [
    { instanceId: 'i1', cwd: '/repo' },
    { instanceId: 'i2', cwd: '/repo/.claude/worktrees/feature-x' },
  ];
  assert.equal(
    resolvePanelCwd({ instances, viewingInstanceId: 'i2', workspaceCwd: '/repo' }),
    '/repo/.claude/worktrees/feature-x',
    '回落工作区 cwd 会让 worktree 会话的改动面板显示父仓的 diff',
  );
  assert.equal(resolvePanelCwd({ instances, viewingInstanceId: 'i1', workspaceCwd: '/repo' }), '/repo');
  // 空首页/实例已关闭：回落工作区 cwd，与从前同形
  assert.equal(resolvePanelCwd({ instances, viewingInstanceId: null, workspaceCwd: '/repo' }), '/repo');
  assert.equal(resolvePanelCwd({ instances, viewingInstanceId: 'gone', workspaceCwd: '/repo' }), '/repo');
  assert.equal(resolvePanelCwd({ instances: null, viewingInstanceId: 'i1', workspaceCwd: '/repo' }), '/repo');
  assert.equal(resolvePanelCwd({}), null);
});

// worktree 目录被删掉之后（2026-09-13 真机形态）：实例 cwd 仍指向那条已不存在的路径——它必须
// 保持原样，transcript 就落在按它算出的 project 目录里，改掉就是「历史消息加载失败」。
// 所以服务端另发一个 panelCwd 字段承担展示/文件/git 轴，本函数优先认它。
// 不认的话，文件面板拿悬空路径去 realpath，用户看到的是「路径不在授权范围内」，
// 改动面板则是一条 git fatal —— 两条都在说技术细节，没有一条说得出「worktree 已经被删了」。
test('resolvePanelCwd: worktree 目录已删时用服务端给的 panelCwd，不是驾驶轴 cwd', () => {
  const instances = [
    { instanceId: 'i1', cwd: '/repo/.claude/worktrees/gone', panelCwd: '/repo', worktreeGone: true },
    { instanceId: 'i2', cwd: '/repo/.claude/worktrees/alive', panelCwd: '/repo/.claude/worktrees/alive' },
  ];
  assert.equal(
    resolvePanelCwd({ instances, viewingInstanceId: 'i1', workspaceCwd: '/repo' }), '/repo',
    '仍用悬空的驾驶轴 cwd = 文件面板报「不在授权范围内」、改动面板报 git fatal',
  );
  assert.equal(
    resolvePanelCwd({ instances, viewingInstanceId: 'i2', workspaceCwd: '/repo' }),
    '/repo/.claude/worktrees/alive',
    '活着的 worktree 仍看自己那棵树——panelCwd 只在悬空时才与 cwd 分叉',
  );
  // 旧 server（未下发 panelCwd）连上新前端：回落 cwd，与引入本字段之前逐字同形
  assert.equal(
    resolvePanelCwd({ instances: [{ instanceId: 'i3', cwd: '/repo' }], viewingInstanceId: 'i3', workspaceCwd: '/x' }),
    '/repo',
  );
});

// ★ 两条轴必须分开，合并任何一侧都会静默出错，而且两种错法长得完全不一样：
//   · transcript 轴（loadHistory 拿它去算 project 目录）用了父仓 → 「历史消息加载失败」，
//     而磁盘上那份 jsonl 完好无损（agent.js handleCwdChanged 整段注释就是在讲这个症状）；
//   · 展示轴（文件/改动面板）用了悬空 cwd → 「路径不在授权范围内」+ git fatal。
// 同一个 instances 数组同时喂这两个消费者，所以这里用同一份夹具各断一次。
test('resolveSessionCwd: transcript 轴恒跟驾驶轴，worktree 删了也不许改', () => {
  const instances = [
    { instanceId: 'i1', cwd: '/repo/.claude/worktrees/chatgpt-gbwh', panelCwd: '/repo', worktreeGone: true },
  ];
  assert.equal(
    resolveSessionCwd({ instances, viewingInstanceId: 'i1', workspaceCwd: '/repo' }),
    '/repo/.claude/worktrees/chatgpt-gbwh',
    'transcript 就落在按这条路径算出的 project 目录里——换成父仓 = 历史消息加载失败，而文件还好端端在盘上',
  );
  assert.notEqual(
    resolveSessionCwd({ instances, viewingInstanceId: 'i1', workspaceCwd: '/repo' }),
    resolvePanelCwd({ instances, viewingInstanceId: 'i1', workspaceCwd: '/repo' }),
    '两条轴在 worktree 已删这一档必须分叉——合成一个函数就必然有一侧是错的',
  );
  assert.equal(resolveSessionCwd({ instances, viewingInstanceId: null, workspaceCwd: '/repo' }), '/repo');
  assert.equal(resolveSessionCwd({}), null);
});

// 光把面板悄悄换成父仓还不够：用户点开「改动」看到的是主仓的 diff，而他以为在看 worktree 的。
// 「看起来没改动」和「真的没改动」在 UI 上无法区分——这正是 resolvePanelCwd 当初存在的理由，
// 回落父仓时同一个风险原样成立，所以必须显式说一句那棵树已经没了。
test('resolveWorktreeGoneNotice: 只在 worktree 已删时出提示，带出两边的名字', () => {
  const instances = [
    { instanceId: 'i1', cwd: '/repo/.claude/worktrees/chatgpt-gbwh', panelCwd: '/repo', worktreeGone: true },
    { instanceId: 'i2', cwd: '/repo/.claude/worktrees/alive', panelCwd: '/repo/.claude/worktrees/alive', worktreeGone: false },
    { instanceId: 'i3', cwd: '/repo', panelCwd: '/repo', worktreeGone: false },
  ];
  assert.deepEqual(
    resolveWorktreeGoneNotice({ instances, viewingInstanceId: 'i1' }),
    { worktree: 'chatgpt-gbwh', parent: 'repo' },
    '不出提示 = 用户在主仓的 diff 上做合并判断，却以为看的是 worktree',
  );
  assert.equal(resolveWorktreeGoneNotice({ instances, viewingInstanceId: 'i2' }), null, '活着的 worktree 不该报删除');
  assert.equal(resolveWorktreeGoneNotice({ instances, viewingInstanceId: 'i3' }), null, '普通会话不该报删除');
  // 旧 server / 空首页 / 实例已关：一律不出提示
  assert.equal(resolveWorktreeGoneNotice({ instances, viewingInstanceId: null }), null);
  assert.equal(resolveWorktreeGoneNotice({ instances: null, viewingInstanceId: 'i1' }), null);
  assert.equal(resolveWorktreeGoneNotice({}), null);
});

// 托管 worktree 的会话并进父仓列表后（2026-09-11），同一页里混着两个工作树的会话。
// 不标出来的话，「这条改的是父仓还是某个 worktree」在合并前完全无从判断——而那正是
// 用户点开它要做的第一个决定。放最前：truncate 先吃尾部，归属比时间戳更不能丢。
test('formatSessionRowSubtitle: worktree 名排在最前，父仓行不受影响', () => {
  assert.equal(
    formatSessionRowSubtitle({ worktree: 'feature-x', whenText: '9/11', shortId: 'abcdef12' }),
    'worktree feature-x · 9/11 · abcdef12',
  );
  // 与终端来源并存时仍在最前（两者都是"这条会话属于谁"，worktree 是更外层的归属）
  assert.equal(
    formatSessionRowSubtitle({ worktree: 'wt-a', whenText: '9/11', terminalState: 'alive', terminalSource: 'cli' }),
    'worktree wt-a · 终端已打开 · 9/11',
  );
  // 正对照：父仓行（无 worktree 字段）逐字不变
  assert.equal(
    formatSessionRowSubtitle({ whenText: '9/11', shortId: 'abcdef12' }),
    '9/11 · abcdef12',
  );
  // 空串/非字符串不得渲染成空段（会多出一个悬空的 ' · '）
  for (const bad of ['', '   ', null, undefined, 42]) {
    assert.equal(formatSessionRowSubtitle({ worktree: bad, whenText: '9/11' }), '9/11', `worktree=${JSON.stringify(bad)}`);
  }
});

test('formatSessionRowSubtitle: CLI 空闲来源提到时间前面；busy 不再把「终端」塞进副行', () => {
  assert.equal(
    formatSessionRowSubtitle({ whenText: '8/27', liveOpen: true, shortId: 'abcdef12' }),
    '8/27 · 已打开 · abcdef12',
  );
  assert.equal(
    formatSessionRowSubtitle({ whenText: '8/27', terminalState: 'busy', shortId: 'abcdef12' }),
    '8/27 · abcdef12',
  );
  assert.equal(
    formatSessionRowSubtitle({ whenText: '8/27', liveOpen: true, terminalState: 'busy', shortId: 'abcdef12' }),
    '8/27 · 已打开 · abcdef12',
  );
  assert.equal(
    formatSessionRowSubtitle({ whenText: '8/27', terminalState: 'alive', shortId: 'abcdef12' }),
    '终端已打开 · 8/27 · abcdef12',
  );
  assert.equal(
    formatSessionRowSubtitle({ whenText: '8/27', liveOpen: true, terminalState: 'alive', shortId: 'abcdef12' }),
    '终端已打开 · 8/27 · 已打开 · abcdef12',
  );
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

test('summarizeOtherWorkspaces: 只汇总需要关注的 permission>error>terminal_waiting>busy，忽略正常终态', () => {
  const dirs = ['/a', '/b'];
  assert.equal(summarizeOtherWorkspaces({ '/a': 'busy', '/b': 'permission' }, dirs, '/cur'), 'permission');
  assert.equal(summarizeOtherWorkspaces({ '/a': 'done', '/b': 'error' }, dirs, '/cur'), 'error');
  assert.equal(summarizeOtherWorkspaces({ '/a': 'busy', '/b': 'done' }, dirs, '/cur'), 'busy');
  assert.equal(summarizeOtherWorkspaces({ '/a': 'done', '/b': 'aborted' }, dirs, '/cur'), null);
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

// 出错分支有意不改 CLI 化：出错时更需要显式秒数+成本，保留中文灰条+红色错误条（用户确认「出错分支不变」）。
test('presentTurnResult: 真错误仍中文灰条 + 红条（不 CLI 化）', () => {
  const err = presentTurnResult({ isError: true, errors: ['boom'], durationMs: 1200, costUsd: 0.1 });
  assert.equal(err.kind, 'error');
  assert.match(err.statusBar.text, /^完成 · 1\.2s · \$0\.1000$/);
  assert.equal(err.errorBar.text, '出错：boom');
  assert.equal(err.errorBar.cls, 'text-danger');
  assert.equal(err.notify.title, '⚠️ 任务出错');
  assert.equal(err.failToolsMessage, 'boom');
});

// 成功轮收尾对齐 CLI turn_duration：✻ <过去式动词> for <时长>，累计 cost 移到状态栏、不再挂后缀。
test('presentTurnResult: 成功轮收尾 CLI 化 ✻ verb for Ns，无 cost 后缀', () => {
  const ok = presentTurnResult({ isError: false, durationMs: 3210, costUsd: 1.2 }, { rand: () => 3 / 8 });
  assert.equal(ok.kind, 'success');
  assert.equal(ok.errorBar, null);
  assert.equal(ok.statusBar.text, '✻ Cogitated for 3s');
  assert.equal(ok.statusBar.cls, 'text-ink-faint');
  assert.equal(ok.notify.title, '✅ 任务完成');
  assert.equal(ok.notify.body, '用时 3.2s'); // 通知仍带精确秒（非聊天流，不属终端等价范围）
  assert.equal(ok.failToolsMessage, null);
});

test('presentTurnResult: 缺字段安全（durationMs 缺省 0 → for 0s）', () => {
  const ui = presentTurnResult(undefined, { rand: () => 0 });
  assert.equal(ui.kind, 'success');
  assert.equal(ui.statusBar.text, '✻ Baked for 0s');
  assert.equal(presentTurnResult(null).kind, 'success'); // payload=null 仍安全
});

// terminal_waiting（2026-09-06）：#sessionsDot 此前对它完全失明——rank 表只登记了 busy/error/
// permission，未登记的状态 rank 缺省 0 被静默吞掉。后果是「页外的终端卡在审批框上」在抽屉折叠时
// 顶部毫无表示，而同一个目录只要另有个在跑的会话反倒会亮「运行中」——更轻的状态盖过更重的。
// 序与 resolveDrawerStatus 逐字同源（permission > error > terminal_waiting > busy），刻意不另立
// 一套：同样这四个状态在产品里出现两套优先级，迟早分叉，且分叉后两边都"看着对"。
test('summarizeOtherWorkspaces: terminal_waiting 点亮顶部，序与 resolveDrawerStatus 同源', () => {
  const dirs = ['/a', '/b'];
  assert.equal(summarizeOtherWorkspaces({ '/a': 'terminal_waiting' }, ['/a'], '/cur'), 'terminal_waiting');
  // 比 busy 重：等人的终端不会自己走完，在跑的会
  assert.equal(summarizeOtherWorkspaces({ '/a': 'busy', '/b': 'terminal_waiting' }, dirs, '/cur'), 'terminal_waiting');
  // 比 error / permission 轻：那两个点开就能看见/就能批，这个手机上批不了
  assert.equal(summarizeOtherWorkspaces({ '/a': 'terminal_waiting', '/b': 'error' }, dirs, '/cur'), 'error');
  assert.equal(summarizeOtherWorkspaces({ '/a': 'terminal_waiting', '/b': 'permission' }, dirs, '/cur'), 'permission');
});

test('summarizeOtherWorkspaces: aborted 不点亮顶部，但不遮蔽 error', () => {
  const dirs = ['/a', '/b'];
  assert.equal(summarizeOtherWorkspaces({ '/a': 'done', '/b': 'aborted' }, dirs, '/cur'), null);
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

// 回归（全新会话首轮点停止后不跳回主页）：freshInterrupted=true 时，即使 sessionId 仍为空，也不应
// 判定为"应显示启动页"——前提是仍有 viewingInstanceId（真正无实例的空首页不受影响，见最后一条）。
test('shouldShowStartScreen: freshInterrupted 例外——sessionId 未到但已中断且仍在看该实例，不显示启动页', () => {
  assert.equal(shouldShowStartScreen({ viewingInstanceId: 'inst_1', sessionId: null, freshInterrupted: true }), false);
  // 有 sessionId 时 freshInterrupted 无关紧要（本就不该显示启动页）
  assert.equal(shouldShowStartScreen({ viewingInstanceId: 'inst_1', sessionId: 'abc', freshInterrupted: true }), false);
  // 无 viewingInstanceId（真正的空首页）：freshInterrupted 不能凭空绕过——须仍显示启动页
  assert.equal(shouldShowStartScreen({ viewingInstanceId: null, sessionId: null, freshInterrupted: true }), true);
  // 默认值：不传 freshInterrupted 时行为与既有测试完全一致（上一个 test 已覆盖，这里补一条显式对照）
  assert.equal(shouldShowStartScreen({ viewingInstanceId: 'inst_1', sessionId: null }), true);
});

// 顶部文件夹 pill（文件浏览 + git 改动 + 未提交改动角标）：判据是「工作区定了没有」，不是「会话建了没有」
// ——它背后的 git:status / files:browse 只要 cwd。空首页尚未选区故隐藏；compose 页（点 ＋ 的会话懒创建
// 窗口）工作区已定，必须显示。
test('shouldShowTopContextPill: 真实会话恒显；compose 有 cwd 即显；空首页隐藏', () => {
  // 真实会话：原样
  assert.equal(shouldShowTopContextPill({ viewingInstanceId: 'inst_1', sessionId: 'abc' }), true);
  // 空首页（未点 ＋）：工作区未选定，pill 无处可指
  assert.equal(shouldShowTopContextPill({ viewingInstanceId: null, sessionId: null }), false);
  assert.equal(shouldShowTopContextPill({ viewingInstanceId: null, sessionId: null, cwd: '/repo' }), false);
  // compose 页：session 还没建，但工作区已定 → 显示
  assert.equal(shouldShowTopContextPill({ viewingInstanceId: null, sessionId: null, composeReady: true, cwd: '/repo' }), true);
  // compose 但 cwd 未知（冷启动 instances 未到）：仍隐藏，不给一个指向 null 的入口
  assert.equal(shouldShowTopContextPill({ viewingInstanceId: null, sessionId: null, composeReady: true, cwd: null }), false);
  // 首发在途：懒开了实例但 sessionId 未到，compose 表面仍在（bindView 提前 return）→ 不得闪断
  assert.equal(shouldShowTopContextPill({ viewingInstanceId: 'inst_1', sessionId: null, composeReady: true, cwd: '/repo' }), true);
  // 非 compose 且无 session（实例被摧毁的空表面）：隐藏
  assert.equal(shouldShowTopContextPill({ viewingInstanceId: 'inst_1', sessionId: null, cwd: '/repo' }), false);
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

// 回归（全新会话首轮点停止后不跳回主页）：freshInterrupted 时输入条仍应可见——中断后 pendingFirstSend
// 早已被一次性消费为 false，若不加这个例外，composer 会跟着"判定该显示启动页"一起被隐藏。
test('shouldShowComposer: freshInterrupted=true 时输入条仍可见（即使 pendingFirstSend 已消费为 false）', () => {
  assert.equal(shouldShowComposer({ viewingInstanceId: 'inst_1', sessionId: null, freshInterrupted: true }), true);
  assert.equal(shouldShowComposer({ viewingInstanceId: 'inst_1', sessionId: null, freshInterrupted: false }), false);
  // 回归：调用方常用 "viewingInstanceId === freshInterruptedInstanceId" 算 freshInterrupted——
  // 两者都是 null（真空首页、从未中断过）时这个比较会巧合为 true，纯函数自己必须兜住，不能被绕过。
  assert.equal(shouldShowComposer({ viewingInstanceId: null, sessionId: null, freshInterrupted: true }), false);
});

// ＋ / 🏠 空表面分流：home=最近枢纽；compose=干净新会话页（无最近列表）；有 session 不进空表面。
test('resolveEmptySurface: home / compose / none 三分', () => {
  assert.equal(resolveEmptySurface({ viewingInstanceId: null, sessionId: null }), 'home');
  assert.equal(resolveEmptySurface({ viewingInstanceId: null, sessionId: null, composeReady: false }), 'home');
  assert.equal(resolveEmptySurface({ viewingInstanceId: null, sessionId: null, composeReady: true }), 'compose');
  assert.equal(resolveEmptySurface({ viewingInstanceId: 'inst_1', sessionId: null, composeReady: true }), 'compose');
  assert.equal(resolveEmptySurface({ viewingInstanceId: 'inst_1', sessionId: null, composeReady: false }), 'home');
  assert.equal(resolveEmptySurface({ viewingInstanceId: 'inst_1', sessionId: 'abc', composeReady: true }), 'none');
  assert.equal(resolveEmptySurface({ viewingInstanceId: 'inst_1', sessionId: 'abc' }), 'none');
});

// 回归（全新会话首轮点停止后不跳回主页）：freshInterrupted 时无论 composeReady 与否都应是 'none'
// （保留已渲染的聊天内容，不切去 home/compose 任一空表面）。
test('resolveEmptySurface: freshInterrupted=true → none（不落 home 也不落 compose）', () => {
  assert.equal(resolveEmptySurface({ viewingInstanceId: 'inst_1', sessionId: null, freshInterrupted: true }), 'none');
  assert.equal(resolveEmptySurface({ viewingInstanceId: 'inst_1', sessionId: null, composeReady: true, freshInterrupted: true }), 'none');
  // 无 viewingInstanceId 时 freshInterrupted 不应凭空生效
  assert.equal(resolveEmptySurface({ viewingInstanceId: null, sessionId: null, freshInterrupted: true }), 'home');
});

// 新会话页默认档摘要：模型 · 权限 · 思考；缺项跳过；全空回落固定文案。
test('formatComposeDefaultsSummary: 拼装工作区新会话默认档文案', () => {
  assert.equal(
    formatComposeDefaultsSummary({
      modelLabel: 'Default (recommended)',
      modeLabel: '默认审批',
      effortLabel: 'xhigh',
    }),
    'Default (recommended) · 默认审批 · xhigh',
  );
  assert.equal(
    formatComposeDefaultsSummary({ modelLabel: 'opus', modeLabel: '', effortLabel: 'high' }),
    'opus · high',
  );
  assert.equal(formatComposeDefaultsSummary({}), '使用工作区默认配置');
  assert.equal(formatComposeDefaultsSummary({ modelLabel: '  ', modeLabel: null }), '使用工作区默认配置');
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
// sessionId 不变 → bindView→clearView 冲掉 busy。须靠 pendingSendBusySessionId 命中当前 sessionId 才补回。
// 注意：有 sessionId 时不得仅凭 pendingFirstSend 补回（那是 session:switch 打开已有会话的误伤面）。
// pendingSendBusySessionId 直接记录"这条乐观 busy 属于哪个 session"（取代旧版裸 boolean + prevSessionId
// 比对）：旧版只比较"这次切换前后 session 是否一致"，不追问 busy 标志本身是不是这个 session 的——若 A
// 发送后用户直接甩开 A（未等 result/error 到达），标志会一直卡 true；用户之后切到完全无关的 B，B 若自己再
// 触发一次同会话换实例，旧版会因为"B 换实例前后 session 一致"就误把 A 遗留的标志套到 B 头上。
test('shouldRestoreOptimisticBusy: 同会话静默换实例且 pendingSendBusySessionId 命中当前会话时补回乐观 busy', () => {
  assert.equal(shouldRestoreOptimisticBusy({
    pendingSendBusySessionId: 'sess_1',
    viewingInstanceId: 'inst_new',
    sessionId: 'sess_1',
  }), true);
  // 真切到另一会话：不补（避免把 A 的发送态挂到 B）
  assert.equal(shouldRestoreOptimisticBusy({
    pendingSendBusySessionId: 'sess_a',
    viewingInstanceId: 'inst_b',
    sessionId: 'sess_b',
  }), false);
  // 回归：陈旧标志属于早已离开、从未等到 result/error 的会话 A；用户之后完全独立地进了会话 B，
  // B 自己再触发一次同会话换实例（B 的 sessionId 前后一致）——A 的陈旧标志不该被误判命中 B。
  assert.equal(shouldRestoreOptimisticBusy({
    pendingSendBusySessionId: 'sess_a', // 陈旧，属于早被甩开的 A
    viewingInstanceId: 'inst_b_v2',
    sessionId: 'sess_b', // B 自己的换实例，前后 sessionId 都是 sess_b，与 A 无关
  }), false);
  // 无 pendingSendBusySessionId（纯 effort 切档且用户未在发送窗口）：不补
  assert.equal(shouldRestoreOptimisticBusy({
    pendingSendBusySessionId: null,
    viewingInstanceId: 'inst_new',
    sessionId: 'sess_1',
  }), false);
  // pendingFirstSend + 有 sessionId 仍不补（保持 session:switch 护栏）
  assert.equal(shouldRestoreOptimisticBusy({
    pendingFirstSend: true,
    pendingSendBusySessionId: null,
    viewingInstanceId: 'inst_1',
    sessionId: 'sess_1',
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
// 新会话在发出第一条消息前没有 sessionId。bindView 被 setInstances 无条件调用，
// 而 broadcastInstances() 在服务端有 28 个触发点且都是 io.emit 全员广播——于是
// 「新会话已就绪、还没发第一条」这整段时间里，任何一个实例的状态变化（别的会话跑完
// 一轮、审批、实例退出……）都会走一次 bindView。
//
// 判据若要求 newSessionId 非空才 keep，这些广播就全部落进 swap 分支，拿 restoreText=''
// 覆盖输入框——用户正在斟酌的一段长 prompt 会无声消失。E2E 的 P0-33 / P0-12c / P0-13
// 稳定红就是撞的这个（fill 之后几十毫秒内被清空，发送按钮因 hasContent=false 隐藏，
// 点击超时 45s）。
test('planSessionDraftSwap: 新会话期间反复收到广播不碰输入框（两侧都无 sessionId）', () => {
  const drafts = new Map();
  const call = () => planSessionDraftSwap({
    prevSessionId: null, newSessionId: null,
    currentDraft: '我正在斟酌的一段长 prompt', currentAttachments: [], drafts,
  });
  // 连续三次广播都必须 keep：action 一旦是 swap，调用方就会把 restoreText 写回输入框。
  for (let i = 0; i < 3; i++) assert.deepEqual(call(), { action: 'keep' });
});

// 反向对照：真正离开一个会话时仍然要存旧草稿并清空，否则这条修复会顺手废掉
// 「切走再切回草稿还在」那个功能（本函数当初就是为它加的）。
test('planSessionDraftSwap: 从会话导航到空首页仍然 swap（存旧草稿、清输入框）', () => {
  const plan = planSessionDraftSwap({
    prevSessionId: 'sess_1', newSessionId: null, currentDraft: '未发出的话', currentAttachments: [],
  });
  assert.equal(plan.action, 'swap');
  assert.deepEqual(plan.save, { sessionId: 'sess_1', text: '未发出的话', attachments: [] });
  assert.equal(plan.restoreText, '');
});

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
  // 【2026-09-18 行为变更】两端都空 / 未定义 → keep，不再 swap 到空。
  // 原断言钉的是「两侧都没有会话时也当作切换」，而那个行为会丢用户正在打的字：
  // 新会话在发出第一条消息前没有 sessionId，bindView 又被 setInstances 无条件调用，
  // 于是那段时间里任何一次 instances 广播（服务端 28 个触发点，全员广播）都会
  // 走 swap → restoreText='' → 覆盖输入框。判据改成「会话身份没变就不碰草稿」。
  assert.deepEqual(
    planSessionDraftSwap({ prevSessionId: null, newSessionId: null, currentDraft: 'x' }),
    { action: 'keep' },
  );
  assert.deepEqual(planSessionDraftSwap(), { action: 'keep' });
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

// select 文案：displayName 优先（方案 B 磁贴用 wire，select 仍可显档位名）
test('resolveModelDisplayName: 有 displayName → 用 displayName', () => {
  const list = [{ value: 'opus', displayName: 'Opus', resolvedModel: 'mimo-v2.5-pro-ultraspeed' }];
  assert.equal(resolveModelDisplayName('opus', list), 'Opus');
});

test('resolveModelDisplayName: 无 displayName → value', () => {
  assert.equal(resolveModelDisplayName('sonnet', [{ value: 'sonnet' }]), 'sonnet');
});

test('resolveGatewayModelName: 有 resolvedModel → wire', () => {
  const list = [{ value: 'opus', resolvedModel: 'mimo-v2.5-pro-ultraspeed' }];
  assert.equal(resolveGatewayModelName('opus', list), 'mimo-v2.5-pro-ultraspeed');
});

// 方案 B pill：优先 wire
test('resolveModelPillText: 已选 + resolved → 显 wire', () => {
  const list = [{ value: 'opus', resolvedModel: 'grok-4.5' }];
  assert.equal(resolveModelPillText({ model: 'opus', modelsList: list }), 'grok-4.5');
});

test('resolveModelPillText: 已选无 resolved → 原样+后缀', () => {
  assert.equal(resolveModelPillText({ model: 'opus', gatewaySuffix: '[1m]', modelsList: [] }), 'opus[1m]');
});

test('resolveModelPillText: 空选 + default.resolved → wire', () => {
  const list = [
    { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'grok-4.5[1m]' },
  ];
  assert.equal(resolveModelPillText({
    model: '',
    modelsList: list,
    cliDefaultLabel: 'Default (recommended)',
  }), 'grok-4.5[1m]');
});

test('resolveModelPillText: 空选无 wire → cliDefaultLabel', () => {
  assert.equal(resolveModelPillText({
    model: '',
    modelsList: [{ value: 'default', displayName: 'Default (recommended)' }],
    cliDefaultLabel: 'Default (recommended)',
  }), 'Default (recommended)');
});

test('resolveModelPillText: 全空 → 「默认」', () => {
  assert.equal(resolveModelPillText({}), '默认');
});

test('resolveSendModel: 空/default pin default wire；档位选中 pin 其 wire', () => {
  const list = [
    { value: 'default', resolvedModel: 'grok-4.5' },
    { value: 'opus', resolvedModel: 'grok-4.5' },
  ];
  assert.equal(defaultResolvedModel(list), 'grok-4.5');
  assert.equal(resolveSendModel({ selectValue: '', modelsList: list }), 'grok-4.5');
  assert.equal(resolveSendModel({ selectValue: 'default', modelsList: list }), 'grok-4.5');
  assert.equal(resolveSendModel({ selectValue: 'opus', modelsList: list }), 'grok-4.5'); // pin wire
  assert.equal(resolveSendModel({ selectValue: 'grok-4.5', modelsList: list }), 'grok-4.5');
  assert.equal(resolveSendModel({ selectValue: 'haiku', modelsList: [] }), 'haiku'); // 无列表原样
  assert.equal(resolveSendModel({ selectValue: '', modelsList: [] }), undefined);
});

// 强度档挂在模型下展示，标题要说清是「谁的」档。与磁贴主标题同源用 displayName，
// 桥接路径与 effortLevelsFor 一致（都走 modelEntryFor），避免两处各解析一套导致标题与档位对不上。
test('modelLabelFor: 取 displayName，桥接别名与 [1m] 后缀', () => {
  const ml = [
    { value: 'opus[1m]', displayName: 'Claude 3 Opus (1m Context)', supportedEffortLevels: ['low'] },
    { value: 'haiku', displayName: 'Claude 3.5 Haiku' },
  ];
  assert.equal(modelLabelFor('opus[1m]', ml), 'Claude 3 Opus (1m Context)');
  assert.equal(modelLabelFor('claude-opus-4-8[1m]', ml), 'Claude 3 Opus (1m Context)'); // 别名桥接
  assert.equal(modelLabelFor('haiku', ml), 'Claude 3.5 Haiku'); // 不支持 effort 的也要有名字可说
});

test('modelLabelFor: 无 displayName 回退 value；解析不到回退原值', () => {
  assert.equal(modelLabelFor('sonnet', [{ value: 'sonnet' }]), 'sonnet');
  assert.equal(modelLabelFor('unknown-model', [{ value: 'sonnet', displayName: 'S' }]), 'unknown-model');
});

// 空模型 = CLI「不 pin」语义（value:"default"），此时没有具体模型可归属，返回空串让调用方
// 走「当前模型」的兜底文案，不能硬塞一个 'default' 字面量给用户看。
test('modelLabelFor: 空值不伪造名字', () => {
  assert.equal(modelLabelFor('', [{ value: 'sonnet', displayName: 'S' }]), '');
  assert.equal(modelLabelFor(null, []), '');
  assert.equal(modelLabelFor(undefined, undefined), '');
});

test('effortLevelsFor: 模型支持 → 列其档', () => {
  const ml = [{ value: 'opus[1m]', supportedEffortLevels: ['low', 'high', 'max'] }];
  assert.deepEqual(effortLevelsFor('opus[1m]', ml), { hidden: false, levels: ['low', 'high', 'max'] });
  assert.notEqual(effortLevelsFor('opus[1m]', ml).levels, ml[0].supportedEffortLevels); // 拷贝而非原数组引用
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

// detectAtMentionQuery/applyAtMentionPick → logic-composer-mention.test.mjs；resolveForkAnchorUuid →
// logic-history-fork.test.mjs（按行为域拆分惯例，见 source-layout.test.mjs）。

// 7febabc 回归：resolveSendModel 改成返回 wire（entry.resolvedModel）后，app.js 的后缀守卫仍比 m.value，
// 而 wire 按设计不等于任何条目的 value → 守卫恒失效 → 每次显式选模型都送出重复后缀的非法模型名。
// fixture 口径与 tests/unit/display-contracts.test.mjs 一致。
test.describe('applyGatewaySuffix：候选内的 wire 不得被二次贴后缀', () => {
  const list = [
    { value: 'default', resolvedModel: 'grok-4.5[1m]' },
    { value: 'opus', resolvedModel: 'grok-4.5' },
  ];
  test('wire 已是候选的 resolvedModel → 原样发送', () => {
    assert.equal(applyGatewaySuffix('grok-4.5[1m]', '[1m]', list), 'grok-4.5[1m]');
    assert.equal(applyGatewaySuffix('grok-4.5', '[1m]', list), 'grok-4.5');
  });
  test('候选内的裸别名 → 原样发送（S5 原有行为）', () => {
    assert.equal(applyGatewaySuffix('opus', '[1m]', list), 'opus');
  });
  test('不在候选里的自设名 → 仍回贴后缀（S5 的目标场景）', () => {
    assert.equal(applyGatewaySuffix('deepseek-v4', '[1m]', list), 'deepseek-v4[1m]');
  });
  test('无后缀 / 无模型 → 原样返回', () => {
    assert.equal(applyGatewaySuffix('grok-4.5', '', list), 'grok-4.5');
    assert.equal(applyGatewaySuffix('', '[1m]', list), '');
    assert.equal(applyGatewaySuffix(undefined, '[1m]', list), undefined);
  });
});

// ── 2026-09-07：bgLocked（会话被 `claude agents` 的后台 job 独占，web 点了会被拒）──────────
// 在这之前这类会话在抽屉里是【完全无 chip】的（占用者自报 idle → terminalState='alive' → 三态全不命中），
// 副文本只有一句「终端已打开」。用户点下去才知道打不开，而且当时那条错误还落在别的会话里。
// 优先级刻意排在最低：它是「此路不通」的说明，不是待办，不该压过点一下就能处理的「需要你」。
test('resolveDrawerStatus: bgLocked 是最低档，任何真状态都压过它', () => {
  assert.equal(resolveDrawerStatus({ bgLocked: true }), 'bg_locked');
  assert.equal(resolveDrawerStatus({ liveState: 'idle', terminalState: 'alive', bgLocked: true }), 'bg_locked');
  assert.equal(resolveDrawerStatus({ liveState: 'permission', bgLocked: true }), 'permission');
  assert.equal(resolveDrawerStatus({ liveState: 'error', bgLocked: true }), 'error');
  assert.equal(resolveDrawerStatus({ terminalState: 'waiting', bgLocked: true }), 'terminal_waiting');
  assert.equal(resolveDrawerStatus({ terminalState: 'busy', bgLocked: true }), 'busy');
  // 不传这一维时行为必须与引入之前完全一致——目录角标走的就是这条路（drawerStateForDir 不喂 bgLocked）
  assert.equal(resolveDrawerStatus({ liveState: 'idle', terminalState: 'alive' }), null);
});

test('resolveDrawerStatusChip: 占用者闲着 → 后台占用；占用者在跑 → 后台任务运行中', () => {
  assert.deepEqual(resolveDrawerStatusChip({ terminalState: 'alive', bgLocked: true }),
    { status: 'bg_locked', label: '后台占用' });
  // busy × bgLocked 两件事都真，措辞要同时带上：说成「终端运行中」会把人指向错误的接管路径
  // （那不是一个终端窗口，走到电脑前打开终端也看不到它）。
  assert.deepEqual(resolveDrawerStatusChip({ terminalState: 'busy', bgLocked: true }),
    { status: 'busy', label: '后台任务运行中' });
  assert.deepEqual(resolveDrawerStatusChip({ liveState: 'busy', bgLocked: true }),
    { status: 'busy', label: '后台任务运行中' });
  // 没被占用时一个字都不能变
  assert.deepEqual(resolveDrawerStatusChip({ terminalState: 'busy' }), { status: 'busy', label: '终端运行中' });
  assert.deepEqual(resolveDrawerStatusChip({ terminalState: 'busy', terminalSource: 'claude-desktop' }),
    { status: 'busy', label: '桌面端运行中' });
  assert.equal(resolveDrawerStatusChip({ terminalState: 'alive' }), null);
});

// 托管 worktree 的实例 cwd 是 `<父仓>/.claude/worktrees/<name>`，不在白名单 dirs 里。它必须归到
// 父仓，否则在任何按工作区分组的视图里都会凭空消失——角标与 sessionsDot（K2）是一处，会话行的
// 「已打开」判定是另一处：liveMap 对 worktree 行恒空时，开着的会话被画成未打开（丢运行态、丢关闭
// 入口），点一下还白走一趟 reopen。抽成共享判据就是为了这两处不再各写一份前缀匹配。
test.describe('owningWorkspace：worktree 实例归到父仓', () => {
  const dirs = ['/repo/a', '/repo/b'];

  test('白名单目录本身 → 原样', () => {
    assert.equal(owningWorkspace('/repo/a', dirs), '/repo/a');
  });

  test('托管 worktree → 归父仓（不归的话那一行会被当成没打开）', () => {
    assert.equal(owningWorkspace('/repo/a/.claude/worktrees/ccm-20260912-0130-ab12', dirs), '/repo/a');
  });

  test('嵌套工作区取最长前缀，不能归错到外层', () => {
    assert.equal(owningWorkspace('/repo/a/sub/.claude/worktrees/w1', ['/repo/a', '/repo/a/sub']), '/repo/a/sub');
  });

  test('前缀必须落在目录边界上：/repo/ab 不属于 /repo/a', () => {
    assert.equal(owningWorkspace('/repo/ab', dirs), null);
  });

  test('完全无关的路径 → null（调用方自己决定回落）', () => {
    assert.equal(owningWorkspace('/elsewhere/x', dirs), null);
  });

  test('空输入不抛', () => {
    assert.equal(owningWorkspace('', dirs), null);
    assert.equal(owningWorkspace(null, dirs), null);
    assert.equal(owningWorkspace('/repo/a', null), null);
  });
});

// aggregateStates 改用 owningWorkspace 之后，K2 那条行为必须原样成立。
test('aggregateStates：worktree 实例的状态点亮父仓（K2 回归锚点）', () => {
  const out = aggregateStates(
    [{ cwd: '/repo/a/.claude/worktrees/w1', state: 'busy' }],
    ['/repo/a', '/repo/b'],
  );
  assert.equal(out['/repo/a'], 'busy', 'worktree 在跑，父仓却显示空闲 —— 用户看不到它');
  assert.equal(out['/repo/b'], 'idle');
});

// 【PR #89 review P1-a】显式「新建会话」必须给干净的开始。
// 判据改成「会话身份没变就 keep」之后，用户已经在一个未发送的新会话页时两侧都是 null，
// btnNew / 目录行＋ 里那次 applySessionDraftSwap 就成了 no-op——再按一次新建、或点另一个
// 工作区的＋，输入框里的字和附件会被原样带进「新会话已就绪」那一页。
// keep 是为了挡住 instances 广播（非用户意图），不该连用户自己点的导航一起挡掉。
test('planSessionDraftSwap: forceSwap 让显式新建绕过 keep，两侧都空也要清干净', () => {
  const drafts = new Map();
  const args = {
    prevSessionId: null, newSessionId: null,
    currentDraft: '上一页没发出去的字', currentAttachments: [{ name: 'a.png' }], drafts,
  };
  // 不传 forceSwap：广播驱动那条路，维持 keep（不碰输入框）
  assert.deepEqual(planSessionDraftSwap(args), { action: 'keep' });
  // 传 forceSwap：用户显式新建，必须 swap 到空
  const forced = planSessionDraftSwap({ ...args, forceSwap: true });
  assert.equal(forced.action, 'swap');
  assert.equal(forced.restoreText, '');
  assert.deepEqual(forced.restoreAttachments, []);
  // prevSessionId 为空 → 无处可存，save 必须是 null（不能凭空造一个 key）
  assert.equal(forced.save, null);
});

test('planSessionDraftSwap: forceSwap 在有旧会话时仍然先存旧草稿', () => {
  const plan = planSessionDraftSwap({
    prevSessionId: 'sess_1', newSessionId: null,
    currentDraft: '属于 sess_1 的草稿', currentAttachments: [], forceSwap: true,
  });
  assert.equal(plan.action, 'swap');
  assert.deepEqual(plan.save, { sessionId: 'sess_1', text: '属于 sess_1 的草稿', attachments: [] });
  assert.equal(plan.restoreText, '');
});

test('planSessionDraftSwap: forceSwap 不影响同会话静默换实例（那仍然必须 keep）', () => {
  // effort/model 切档会 dispose+resume 同一个会话，此时 bindView 不传 forceSwap，
  // 草稿必须原样留着——这条防止「为修新建而把静默换实例也一起清了」。
  assert.deepEqual(
    planSessionDraftSwap({ prevSessionId: 'sess_1', newSessionId: 'sess_1', currentDraft: 'x' }),
    { action: 'keep' },
  );
});
