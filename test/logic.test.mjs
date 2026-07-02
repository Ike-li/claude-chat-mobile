// test/logic.test.mjs —— public/js/logic.js 纯逻辑单测（node 内置 test runner，零依赖）。
// 跑法：npm test （= node --test）。覆盖 model 桥接 / effort 档位 / 状态优先级 / ANSI 配平 / esc。
// 不覆盖 DOM 接线与 iOS/Safari 平台行为（归 npm run check + 真机），见 docs/design.md 验收纪律。
import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, modelEntryFor, effortLevelsFor, aggregateStates, ansiToHtml, projectDisplayName, shouldShowStartScreen, shouldRestoreOptimisticBusy, shouldDropAgentEvent, urlBase64ToUint8Array, foregroundReconnectAction, syncAckAction, keyboardInsetPadding, logEntryVisibleForInstance, generateSuggestions } from '../public/js/logic.js';
import { createRingBuffer } from '../public/js/ring-buffer.js';

test('esc: 转义 HTML 元字符', () => {
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(5), '5');
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

test.describe('generateSuggestions：依上条助手消息推荐后续快捷词（中英关键词 + 通用兜底）', () => {
  test('空/无文本 → 空数组（不渲染任何 chip）', () => {
    assert.deepEqual(generateSuggestions(''), []);
    assert.deepEqual(generateSuggestions(null), []);
    assert.deepEqual(generateSuggestions(undefined), []);
  });

  test('英文关键词命中：CI/pipeline → 收工建议', () => {
    assert.ok(generateSuggestions('The CI pipeline is green').includes('确认 CI 绿了就收工'));
  });

  test('中文回复也能命中（修「英文-only 致中文回复永不触发」的 bug）', () => {
    // 本 UI 里 Claude 用中文回复，规则必须匹配中文关键词，否则永远只落通用兜底
    assert.ok(generateSuggestions('所有测试都通过了').includes('运行测试验证一下'));
    assert.ok(generateSuggestions('已经提交到仓库了').includes('把修改提交到 git'));
    assert.ok(generateSuggestions('构建时报错了').includes('帮我修复这个错误'));
  });

  test('unit / 单元测试 → 追加「写个单测」建议', () => {
    assert.ok(generateSuggestions('加个 unit test 吧').includes('帮我写个单测'));
    assert.ok(generateSuggestions('补一下单元测试').includes('帮我写个单测'));
  });

  test('无关键词的非空文本 → 落通用兜底（恒 3 条、首条为「继续」）', () => {
    const s = generateSuggestions('今天天气不错');
    assert.equal(s.length, 3);
    assert.equal(s[0], '继续');
  });

  test('多规则命中 → 去重且封顶 3 条', () => {
    const s = generateSuggestions('测试失败了，git 提交前先跑 lint 和 doctor 自检，再修下 bug');
    assert.equal(s.length, 3);
    assert.equal(new Set(s).size, s.length); // 无重复
  });

  test('「ci」按词边界匹配 → decision/efficiency 之类不误触发 CI 建议', () => {
    assert.ok(!generateSuggestions('这个 decision 提升了 efficiency').includes('确认 CI 绿了就收工'));
  });
});
