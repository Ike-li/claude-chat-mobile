// tests/unit/logic.test.mjs —— public/js/logic.js 纯逻辑单测（node 内置 test runner，零依赖）。
// 跑法：npm test （= node --test）。覆盖 model 桥接 / effort 档位 / 状态优先级 / ANSI 配平 / esc。
// 不覆盖 DOM 接线与 iOS/Safari 平台行为（归 npm run check + 真机），见 docs/design.md 验收纪律。
import test from 'node:test';
import assert from 'node:assert/strict';
import { foregroundReconnectAction, syncAckAction, shouldReloadOnEnter, sessionDomCachePlan, keyboardInsetPadding, logEntryVisibleForInstance, consoleLogEntryLayout, defaultModelTileLabel, pushEnvHint, resolveDeepLinkTarget, armedTakeoverStep, formatRttMs, rttToneClass, detectServiceRestart, formatServiceNotices, shouldSendOnEnter, readAlertPrefs, writeAlertPref, ALERT_PREF_KEYS, summarizeInstanceStates, whatNeedsAttention, userBubbleFold, isSubagentPayload, formatSubagentCardTitle, isToolSummaryTruncated, formatMirrorBannerText, formatMirrorComposerHint, shouldEmitThrottledHint, taskStopUiState, acceptMirrorState, shouldResetMirrorOnViewChange } from '../../public/js/logic.js';

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

// ---- 完成提示偏好：默认开，仅 '0' 为关；localStorage 读写纯函数 ----
test.describe('readAlertPrefs / writeAlertPref：完成提示开关', () => {
  test('缺省 / 空存储 → 三项全 true（默认开）', () => {
    assert.deepEqual(readAlertPrefs(() => null), { sound: true, vibrate: true, foregroundComplete: true });
    assert.deepEqual(readAlertPrefs(() => undefined), { sound: true, vibrate: true, foregroundComplete: true });
    assert.deepEqual(readAlertPrefs(() => ''), { sound: true, vibrate: true, foregroundComplete: true });
  });
  test("显式 '0' → 关；'1' / 其他 → 开", () => {
    const store = {
      [ALERT_PREF_KEYS.sound]: '0',
      [ALERT_PREF_KEYS.vibrate]: '1',
      [ALERT_PREF_KEYS.foregroundComplete]: 'nope',
    };
    assert.deepEqual(readAlertPrefs((k) => store[k]), { sound: false, vibrate: true, foregroundComplete: true });
  });
  test('writeAlertPref 写 1/0，未知 key 不写', () => {
    const out = {};
    assert.equal(writeAlertPref((k, v) => { out[k] = v; }, 'sound', false), true);
    assert.equal(writeAlertPref((k, v) => { out[k] = v; }, 'vibrate', true), true);
    assert.equal(writeAlertPref((k, v) => { out[k] = v; }, 'nope', true), false);
    assert.deepEqual(out, {
      [ALERT_PREF_KEYS.sound]: '0',
      [ALERT_PREF_KEYS.vibrate]: '1',
    });
  });
});

// ---- 状态一瞥：live 实例汇总 + whatNeedsAttention ----
test.describe('summarizeInstanceStates：live 会话实例汇总（非 OS 进程）', () => {
  test('空 / 非数组 → total 0', () => {
    assert.deepEqual(summarizeInstanceStates([]).total, 0);
    assert.equal(summarizeInstanceStates(null).running, 0);
    assert.equal(summarizeInstanceStates(undefined).byState.busy, 0);
  });
  test('按 state 计数；无 instanceId 跳过；未知 state 归 idle', () => {
    const r = summarizeInstanceStates([
      { instanceId: 'a', state: 'busy' },
      { instanceId: 'b', state: 'busy' },
      { instanceId: 'c', state: 'permission' },
      { instanceId: 'd', state: 'error' },
      { instanceId: 'e', state: 'weird' },
      { state: 'busy' }, // 无 id
    ]);
    assert.equal(r.total, 5);
    assert.equal(r.running, 2);
    assert.equal(r.byState.busy, 2);
    assert.equal(r.byState.permission, 1);
    assert.equal(r.byState.error, 1);
    assert.equal(r.byState.idle, 1);
  });
});

test.describe('whatNeedsAttention：ok / attention / alert', () => {
  test('全空 → ok', () => {
    assert.deepEqual(whatNeedsAttention({}), { level: 'ok', items: [] });
    assert.deepEqual(whatNeedsAttention({ instances: [], needsYou: [], service: null }), { level: 'ok', items: [] });
  });
  test('needsYou 非空 → attention', () => {
    const r = whatNeedsAttention({
      needsYou: [{ reason: 'awaiting_approval', instanceId: 'i1', title: '批 Bash' }],
      service: { deliveryFailure: null },
    });
    assert.equal(r.level, 'attention');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].kind, 'awaiting_approval');
  });
  test('instance permission 且 needsYou 空 → attention（兜底）', () => {
    const r = whatNeedsAttention({
      instances: [{ instanceId: 'i1', state: 'permission', title: 'X' }],
      needsYou: [],
    });
    assert.equal(r.level, 'attention');
    assert.equal(r.items[0].ref, 'i1');
  });
  test('deliveryFailure → alert（优先于 attention）', () => {
    const r = whatNeedsAttention({
      needsYou: [{ reason: 'awaiting_input', instanceId: 'i1' }],
      service: { deliveryFailure: { channel: 'push', at: 1, count: 2 } },
    });
    assert.equal(r.level, 'alert');
    assert.ok(r.items.some(i => i.kind === 'delivery_failure'));
    assert.ok(r.items.some(i => i.kind === 'awaiting_input'));
  });
});

// ---- userBubbleFold：用户气泡长消息折叠决策（移动端上滑看前文不被长指令顶住）----
test.describe('userBubbleFold：行数估算 + 超阈值才折叠', () => {
  test('短指令不折（单行、两三行）', () => {
    assert.deepEqual(userBubbleFold('修这个 bug'), { fold: false, lines: 1 });
    assert.deepEqual(userBubbleFold('做 A\n做 B\n做 C'), { fold: false, lines: 3 });
  });
  test('按 \\n 拆段计行', () => {
    const t = Array.from({ length: 11 }, () => 'x').join('\n'); // 11 行（含空段）
    const r = userBubbleFold(t);
    assert.equal(r.lines, 11);
    assert.equal(r.fold, true);
  });
  test('长单行按 cols 自动换行计行（中文长单行一段）', () => {
    // 105 字符 / cols 30 → 4 行；不足阈值不折
    const r = userBubbleFold('字'.repeat(105));
    assert.equal(r.lines, 4);
    assert.equal(r.fold, false);
  });
  test('长单行超阈值触发折叠', () => {
    // 360 字符 / 30 = 12 行 > 10 → fold
    const r = userBubbleFold('字'.repeat(360));
    assert.equal(r.lines, 12);
    assert.equal(r.fold, true);
  });
  test('空 / null / undefined → 不折、0 行', () => {
    assert.deepEqual(userBubbleFold(''), { fold: false, lines: 0 });
    assert.deepEqual(userBubbleFold(null), { fold: false, lines: 0 });
    assert.deepEqual(userBubbleFold(undefined), { fold: false, lines: 0 });
  });
  test('阈值参数可调（foldLines=5 → 8 行也折）', () => {
    const t = Array.from({ length: 9 }, () => 'a').join('\n'); // 9 显式行
    assert.equal(userBubbleFold(t, { foldLines: 5 }).fold, true);
    assert.equal(userBubbleFold(t, { foldLines: 10 }).fold, false);
  });
  test('cols 参数影响长单行计行', () => {
    const t = '字'.repeat(60);
    assert.equal(userBubbleFold(t, { cols: 30 }).lines, 2);  // 60/30=2
    assert.equal(userBubbleFold(t, { cols: 20 }).lines, 3);  // 60/20=3
  });
});

// ---- resolveDeepLinkTarget：通知深链落地 + instanceId 失效回退（②2c）----
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
  test('有 DOM 缓存 + replayed>0（切 tab 秒恢复）→ keep，不重载以免丢实时 thinking', () => {
    assert.equal(shouldReloadOnEnter({ replayed: 5, gap: false, hasCache: true, diskLen: 99, seenDiskLen: 0 }), 'keep');
  });
  test('整页刷新/无 DOM 缓存：replayed>0 仍须 reload（活缓冲≠全量历史，BUFFER_CAP 外全丢）', () => {
    // 复刻 PWA 下拉刷新 bug：hard reload 后 sessionDomCache 清空(hasCache=false)，server 实例仍在、
    // sync:since(0) 回放环形缓冲(≤500 事件) → replayed>0；旧逻辑 keep 跳过 session:history，
    // 只剩缓冲里能拼出的最近一两轮，磁盘里更早的对话永久丢失到下次手动切会话。
    assert.equal(shouldReloadOnEnter({ replayed: 50, gap: false, hasCache: false, diskLen: 200, seenDiskLen: 0 }), 'reload');
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
  test('gap 优先于 hasCache=false 的 reload 分支（有缺口仍 reload，口径一致）', () => {
    assert.equal(shouldReloadOnEnter({ replayed: 9, gap: true, hasCache: false, diskLen: 0, seenDiskLen: 0 }), 'reload');
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

// ── shouldSendOnEnter：移动端回车发送截断修复（2026-07-13 排查报告 §8.1）──
// 桌面物理键盘有 Shift+Enter 这个「换行逃生舱」，触屏软键盘没有——同样一律拿「非 Shift 回车」当
// 发送信号，会把触屏用户想换行分段的操作误判成发送，截断成两条消息。触屏设备下回车不再发送，
// 只走 textarea 默认换行，发送收窄为仅走发送按钮。
test.describe('shouldSendOnEnter（回车是否触发发送——移动端回车语义修复）', () => {
  test('非触摸设备 + 无 Shift → true（桌面 Enter 发送，维持现状）', () => {
    assert.equal(shouldSendOnEnter({ shiftKey: false, isTouchDevice: false }), true);
  });
  test('非触摸设备 + Shift → false（桌面 Shift+Enter 换行，维持现状）', () => {
    assert.equal(shouldSendOnEnter({ shiftKey: true, isTouchDevice: false }), false);
  });
  test('触摸设备 + 无 Shift → false（本次修复：手机回车=换行，不发送）', () => {
    assert.equal(shouldSendOnEnter({ shiftKey: false, isTouchDevice: true }), false);
  });
  test('触摸设备 + Shift → false（触摸设备下回车恒不发送，与 Shift 无关）', () => {
    assert.equal(shouldSendOnEnter({ shiftKey: true, isTouchDevice: true }), false);
  });
  test('空入参安全 → true（不崩，且延续修复前的桌面默认行为）', () => {
    assert.equal(shouldSendOnEnter({}), true);
    assert.equal(shouldSendOnEnter(), true);
  });
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

// 子 agent 可折叠卡片（切片 C）：事件是否归入子 agent 卡 + 标题文案。
// app.js 用这两个纯函数决定「主流气泡 vs 嵌套卡」；DOM 接线归 visual E2E。
test.describe('isSubagentPayload / formatSubagentCardTitle（子 agent 嵌套卡片）', () => {
  test('parentToolUseId 非空字符串 → true（后端分流字段）', () => {
    assert.equal(isSubagentPayload({ parentToolUseId: 'agent-1', text: 'hi' }), true);
    assert.equal(isSubagentPayload({ parentToolUseId: 'x', subagentType: 'code-reviewer' }), true);
  });

  test('主会话事件（无 parentToolUseId / 空 / 非字符串）→ false', () => {
    assert.equal(isSubagentPayload({ messageId: 'm1', text: 'hi' }), false);
    assert.equal(isSubagentPayload({ parentToolUseId: '' }), false);
    assert.equal(isSubagentPayload({ parentToolUseId: null }), false);
    assert.equal(isSubagentPayload({ parentToolUseId: 42 }), false);
    assert.equal(isSubagentPayload(null), false);
    assert.equal(isSubagentPayload(undefined), false);
  });

  test('标题：有类型 + 运行中 → 「🤖 {type} 运行中」', () => {
    assert.equal(formatSubagentCardTitle({ subagentType: 'code-reviewer', running: true }), '🤖 code-reviewer 运行中');
  });

  test('标题：有类型 + 已完成 → 「🤖 {type} 已完成」', () => {
    assert.equal(formatSubagentCardTitle({ subagentType: 'Explore', running: false }), '🤖 Explore 已完成');
  });

  test('标题：类型缺失/空白 → 兜底「子 agent」', () => {
    assert.equal(formatSubagentCardTitle({ running: true }), '🤖 子 agent 运行中');
    assert.equal(formatSubagentCardTitle({ subagentType: '  ', running: false }), '🤖 子 agent 已完成');
    assert.equal(formatSubagentCardTitle({ subagentType: null, running: true }), '🤖 子 agent 运行中');
  });

  test('标题：running 默认 true（懒创建时未传也显示运行中）', () => {
    assert.equal(formatSubagentCardTitle({ subagentType: 'Plan' }), '🤖 Plan 运行中');
  });
});

test.describe('isToolSummaryTruncated（工具卡展开全文门）', () => {
  test('显式 truncated:true/false 优先于嗅探', () => {
    assert.equal(isToolSummaryTruncated('短', { truncated: true }), true);
    assert.equal(isToolSummaryTruncated('x …（已截断）', { truncated: false }), false);
  });
  test('无 flag 时嗅探尾缀「 …（已截断）」', () => {
    assert.equal(isToolSummaryTruncated('hello …（已截断）'), true);
    assert.equal(isToolSummaryTruncated('hello full output'), false);
    assert.equal(isToolSummaryTruncated(null), false);
  });
});

test.describe('formatMirrorBannerText（只读锁横幅三态）', () => {
  test('armed / stale 优先', () => {
    assert.match(formatMirrorBannerText({ armed: true }), /已请求接管/);
    assert.match(formatMirrorBannerText({ stale: true }), /疑似中断/);
  });
  test('driving 默认句：无秒数倒计时', () => {
    const t = formatMirrorBannerText({});
    assert.match(t, /终端驾驶中/);
    assert.match(t, /只读追平/);
    assert.match(t, /接管|自动可写/);
    assert.equal(/\d+\s*s/.test(t), false, '不应展示约 Ns 假精密倒计时');
  });
});

// 驾驶中点输入区时的可操作说明（disabled 吞点击 → 需主动 addBar；与横幅短句互补）
test.describe('formatMirrorComposerHint（点输入区说明三态）', () => {
  test('armed：等待自动切换 + 可取消', () => {
    const t = formatMirrorComposerHint({ armed: true });
    assert.match(t, /已请求接管|等待|自动可写/);
    assert.match(t, /取消接管/);
  });
  test('stale：确认终端已停后接管', () => {
    const t = formatMirrorComposerHint({ stale: true });
    assert.match(t, /疑似中断/);
    assert.match(t, /接管 CLI 会话/);
  });
  test('driving：能/不能/硬要怎么做；无假精密倒计时', () => {
    const t = formatMirrorComposerHint({});
    assert.match(t, /终端驾驶中|只读追平/);
    assert.match(t, /不能/);
    assert.match(t, /能/);
    assert.match(t, /接管 CLI 会话/);
    assert.equal(/\d+\s*s/.test(t), false);
  });
  test('armed 优先于 stale', () => {
    assert.match(formatMirrorComposerHint({ armed: true, stale: true }), /已请求接管|取消接管/);
  });
});

test.describe('shouldEmitThrottledHint（同文案节流）', () => {
  test('首次必发', () => {
    assert.equal(shouldEmitThrottledHint({ lastText: '', lastAt: 0, nextText: 'hello', now: 1000, throttleMs: 2500 }), true);
  });
  test('同文案在节流窗内不发', () => {
    assert.equal(shouldEmitThrottledHint({
      lastText: 'hello', lastAt: 1000, nextText: 'hello', now: 2000, throttleMs: 2500,
    }), false);
  });
  test('同文案过节流窗再发', () => {
    assert.equal(shouldEmitThrottledHint({
      lastText: 'hello', lastAt: 1000, nextText: 'hello', now: 4000, throttleMs: 2500,
    }), true);
  });
  test('换文案立即发（armed/stale 切换）', () => {
    assert.equal(shouldEmitThrottledHint({
      lastText: 'a', lastAt: 1000, nextText: 'b', now: 1100, throttleMs: 2500,
    }), true);
  });
  test('空文案不发', () => {
    assert.equal(shouldEmitThrottledHint({ lastText: '', lastAt: 0, nextText: '', now: 1, throttleMs: 2500 }), false);
  });
});

// 跨工作区/跨会话误锁守卫：CLI 在 A 驾驶时，切到 B 新会话不得接纳 A 的 readonly=true。
test.describe('acceptMirrorState（mirror_state 归属）', () => {
  test('readonly=false 一律接受（权威解锁，含空 idle 快照）', () => {
    assert.equal(acceptMirrorState({ readonly: false, eventInstanceId: null, viewingInstanceId: null }), true);
    assert.equal(acceptMirrorState({ readonly: false, eventInstanceId: 'inst_A', viewingInstanceId: 'inst_B' }), true);
    assert.equal(acceptMirrorState({ readonly: false }), true);
  });
  test('readonly=true 且 instanceId 匹配当前 viewing → 接受', () => {
    assert.equal(acceptMirrorState({
      readonly: true, eventInstanceId: 'inst_A', viewingInstanceId: 'inst_A',
    }), true);
  });
  test('readonly=true 但指向别的 tab → 拒绝（防跨会话误锁）', () => {
    assert.equal(acceptMirrorState({
      readonly: true, eventInstanceId: 'inst_A', viewingInstanceId: 'inst_B',
    }), false);
  });
  test('readonly=true 但 viewing 为空首页/新会话 → 拒绝', () => {
    assert.equal(acceptMirrorState({
      readonly: true, eventInstanceId: 'inst_A', viewingInstanceId: null,
    }), false);
  });
  test('readonly=true 但事件缺 instanceId → 拒绝（无主不上锁）', () => {
    assert.equal(acceptMirrorState({
      readonly: true, eventInstanceId: null, viewingInstanceId: 'inst_A',
    }), false);
    assert.equal(acceptMirrorState({
      readonly: true, eventInstanceId: '', viewingInstanceId: 'inst_A',
    }), false);
  });
});

test.describe('shouldResetMirrorOnViewChange（切视图/工作区先本地清锁）', () => {
  test('viewing 变了 → 清', () => {
    assert.equal(shouldResetMirrorOnViewChange({
      prevViewing: 'inst_A', nextViewing: 'inst_B',
    }), true);
    assert.equal(shouldResetMirrorOnViewChange({
      prevViewing: 'inst_A', nextViewing: null,
    }), true);
  });
  test('viewing 不变且 cwd 不变 → 不清', () => {
    assert.equal(shouldResetMirrorOnViewChange({
      prevViewing: 'inst_A', nextViewing: 'inst_A',
      prevCwd: '/a', nextCwd: '/a', cwdSeen: true,
    }), false);
    assert.equal(shouldResetMirrorOnViewChange({
      prevViewing: null, nextViewing: null,
    }), false);
  });
  test('空首页内换工作区（viewing 恒 null、cwd 变）→ 清', () => {
    assert.equal(shouldResetMirrorOnViewChange({
      prevViewing: null, nextViewing: null,
      prevCwd: '/a', nextCwd: '/b', cwdSeen: true,
    }), true);
  });
  test('首帧（cwdSeen=false）不因 cwd 冒充切换而清', () => {
    assert.equal(shouldResetMirrorOnViewChange({
      prevViewing: null, nextViewing: null,
      prevCwd: null, nextCwd: '/a', cwdSeen: false,
    }), false);
  });
});

test.describe('taskStopUiState（后台任务停止按钮）', () => {
  test('有 taskId 且横幅可见 → canStop', () => {
    assert.deepEqual(taskStopUiState({ taskId: 't1', bannerVisible: true }), { canStop: true, taskId: 't1' });
  });
  test('无 taskId / 横幅隐藏 → 不可停', () => {
    assert.equal(taskStopUiState({ taskId: '', bannerVisible: true }).canStop, false);
    assert.equal(taskStopUiState({ taskId: 't1', bannerVisible: false }).canStop, false);
    assert.equal(taskStopUiState({}).canStop, false);
  });
});

