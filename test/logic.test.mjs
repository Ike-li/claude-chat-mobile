// test/logic.test.mjs —— public/js/logic.js 纯逻辑单测（node 内置 test runner，零依赖）。
// 跑法：npm test （= node --test）。覆盖 model 桥接 / effort 档位 / 状态优先级 / ANSI 配平 / esc。
// 不覆盖 DOM 接线与 iOS/Safari 平台行为（归 npm run check + 真机），见 docs/design.md 验收纪律。
import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, modelEntryFor, effortLevelsFor, aggregateStates, summarizeOtherWorkspaces, ansiToHtml, projectDisplayName, shouldShowStartScreen, shouldRestoreOptimisticBusy, shouldDropAgentEvent, urlBase64ToUint8Array, foregroundReconnectAction, syncAckAction, shouldReloadOnEnter, keyboardInsetPadding, logEntryVisibleForInstance, defaultModelTileLabel, withUltracodeKeyword, withUltracodeTier, resolveEffortSelection, pushEnvHint, resolveDeepLinkTarget } from '../public/js/logic.js';
import { createRingBuffer } from '../public/js/ring-buffer.js';

test('esc: 转义 HTML 元字符', () => {
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(5), '5');
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
