// tests/unit/logic.test.mjs —— public/js/logic.js 纯逻辑单测（node 内置 test runner，零依赖）。
// 跑法：npm test （= node --test）。覆盖 model 桥接 / effort 档位 / 状态优先级 / ANSI 配平 / esc。
// 不覆盖 DOM 接线与 iOS/Safari 平台行为（归 npm run check + 真机），见 docs/design.md 验收纪律。
import test from 'node:test';
import assert from 'node:assert/strict';
import { foregroundReconnectAction, syncAckAction, shouldReloadOnEnter, shouldForceScrollAfterReplay, shouldStickScrollToBottom, shouldAckUnreadOnScroll, resolveReplayBufferAction, REPLAY_BUFFER_RELOAD_THRESHOLD, sessionDomCachePlan, keyboardInsetPadding, logEntryVisibleForInstance, consoleLogEntryLayout, defaultModelTileLabel, pushEnvHint, resolveDeepLinkTarget, formatRttMs, rttToneClass, formatServiceNotices, shouldSendOnEnter, readAlertPrefs, writeAlertPref, ALERT_PREF_KEYS, readPushPreviewPref, writePushPreviewPref, PUSH_PREVIEW_PREF_KEY, whatNeedsAttention, userBubbleFold, isSubagentPayload, isSpawnToolName, formatBgTaskRowLabel, formatSubagentCardTitle, isToolSummaryTruncated, taskStopUiState, bgTaskListCollapsed, resolveSheetDragEnd } from '../../public/js/logic.js';

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

// ---- 推送内容预览偏好：⑧ 与完成提示反极性——默认关，仅 '1' 为开（泄露面更大，须显式选） ----
test.describe('readPushPreviewPref / writePushPreviewPref：推送内容预览开关', () => {
  test('缺省 / 空存储 → false（默认关，与 ALERT_PREF_KEYS 相反极性）', () => {
    assert.equal(readPushPreviewPref(() => null), false);
    assert.equal(readPushPreviewPref(() => undefined), false);
    assert.equal(readPushPreviewPref(() => ''), false);
    assert.equal(readPushPreviewPref(() => '0'), false);
  });
  test("显式 '1' → true；其它任意值仍为 false（严格等于 '1' 才开）", () => {
    assert.equal(readPushPreviewPref(() => '1'), true);
    assert.equal(readPushPreviewPref(() => 'yes'), false);
    assert.equal(readPushPreviewPref(() => 'true'), false);
  });
  test('writePushPreviewPref 写 1/0 到固定 key', () => {
    const out = {};
    assert.equal(writePushPreviewPref((k, v) => { out[k] = v; }, true), true);
    assert.deepEqual(out, { [PUSH_PREVIEW_PREF_KEY]: '1' });
    assert.equal(writePushPreviewPref((k, v) => { out[k] = v; }, false), true);
    assert.deepEqual(out, { [PUSH_PREVIEW_PREF_KEY]: '0' });
  });
  test('非函数 setItem → 不写、返回 false，不抛错', () => {
    assert.equal(writePushPreviewPref(null, true), false);
    assert.doesNotThrow(() => writePushPreviewPref(undefined, true));
  });
});

// ---- whatNeedsAttention：顶栏注意力信号（抽屉不再放 live 实例汇总）----
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
  // 空闲回收后：缓冲里常只剩 error/system 横幅类事件(replayed>0)，但 hasCache=false（clearView 后无 DOM）。
  // 必须走 reload 拉磁盘全量历史——否则只见「进程已回收」条、聊天区空白（机主 7134c083 复现）。
  test('无缓存 + 仅有回收类缓冲回放 → 仍 reload 拉磁盘历史', () => {
    assert.equal(shouldReloadOnEnter({ replayed: 1, gap: false, hasCache: false, diskLen: 123, seenDiskLen: 0 }), 'reload');
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

// 修「切回会话停在旧位置 + 内容一条条冒出来像重播」：'keep'/'none' 分支恢复的是【离开时缓存的旧内容】
// 底部，之后离开期间产生的新内容才作为 replay 事件逐条补发（各自走非强制 scrollBottom，未必够到底部）。
// 'load'/'reload' 分支已由 loadHistory 完成时的 scrollBottom(true) 兜底，不需要再触发一次。
test.describe('shouldForceScrollAfterReplay：keep/none 分支有真实补发内容时须补一次强制落底', () => {
  test('bindView 的 keep + 有回放 → 需要强制落底（旧缓存已落到错误的底部）', () => {
    assert.equal(shouldForceScrollAfterReplay({ action: 'keep', replayed: 5 }), true);
  });
  test('requestSync 的 none + 有回放 → 需要强制落底（同一机制的重连路径）', () => {
    assert.equal(shouldForceScrollAfterReplay({ action: 'none', replayed: 3 }), true);
  });
  test('keep 但无回放（replayed=0）→ 不需要，DOM 本就是最新，不产生多余滚动', () => {
    assert.equal(shouldForceScrollAfterReplay({ action: 'keep', replayed: 0 }), false);
  });
  test('load/reload 分支即便带 replayed>0 也不需要——loadHistory 完成时已 scrollBottom(true) 兜底', () => {
    assert.equal(shouldForceScrollAfterReplay({ action: 'load', replayed: 5 }), false);
    assert.equal(shouldForceScrollAfterReplay({ action: 'reload', replayed: 5 }), false);
  });
  test('reconnect（尚未真正 sync）→ 不需要，届时新一轮 sync 会重新判定', () => {
    assert.equal(shouldForceScrollAfterReplay({ action: 'reconnect', replayed: 0 }), false);
  });
  test('replayed 非法值（undefined/NaN/负数）→ 诚实按无回放处理，不误触发', () => {
    assert.equal(shouldForceScrollAfterReplay({ action: 'keep', replayed: undefined }), false);
    assert.equal(shouldForceScrollAfterReplay({ action: 'keep', replayed: NaN }), false);
    assert.equal(shouldForceScrollAfterReplay({ action: 'keep', replayed: -1 }), false);
  });
  test('未知 action → 不误触发（保守）', () => {
    assert.equal(shouldForceScrollAfterReplay({ action: 'unknown', replayed: 5 }), false);
  });
});

// 修「切会话/重连时离开期间积压的消息像打字机一样逐条蹦出」：sync:since 服务端先逐条 emit
// agent:event(replay:true) 再 ack，客户端在 emit 前就架起缓冲区（app.js + app/event-dispatch.js 的
// createReplayBuffer：begin/offer/resolve）把命中该 instanceId 的事件先入队不渲染，ack 到达后用这个
// 纯函数决定 reload（丢弃、改走 session:history 批量渲染）还是 flush（按序正常派发但抑制中间滚动、
// 最后一次强制落底）。见 logic.js 顶部注释：优先级 = priorAction 已 reload/load 最高 → busy 恒
// flush → 其余按 bufferedCount 与阈值比较。
test.describe('resolveReplayBufferAction：回放缓冲决策（reload 清屏批量 vs flush 抑制滚动增量）', () => {
  test('priorAction=reload → 恒 reload，无视 bufferedCount/busy（既有判定优先级更高，不需要这层重判）', () => {
    assert.equal(resolveReplayBufferAction({ bufferedCount: 0, priorAction: 'reload', busy: false }), 'reload');
    assert.equal(resolveReplayBufferAction({ bufferedCount: 5, priorAction: 'reload', busy: true }), 'reload');
  });
  test('priorAction=load → 恒 reload（bindView 冷入场分支，同 reload 口径一并交给既有批量渲染路径）', () => {
    assert.equal(resolveReplayBufferAction({ bufferedCount: 0, priorAction: 'load', busy: false }), 'reload');
  });
  test('busy=true → 恒 flush，即使缓冲远超阈值（进行中的流式内容只在服务端环形缓冲、不在磁盘上，reload 会丢）', () => {
    assert.equal(resolveReplayBufferAction({ bufferedCount: 9999, priorAction: 'keep', busy: true }), 'flush');
    assert.equal(resolveReplayBufferAction({ bufferedCount: 9999, priorAction: 'none', busy: true }), 'flush');
  });
  test('priorAction=keep（bindView 切视图）+ 未 busy + 缓冲低于阈值 → flush', () => {
    assert.equal(resolveReplayBufferAction({ bufferedCount: 20, priorAction: 'keep', busy: false }), 'flush');
  });
  test('priorAction=none（requestSync 重连/探活）+ 未 busy + 缓冲低于阈值 → flush（两条入口共用同一判定）', () => {
    assert.equal(resolveReplayBufferAction({ bufferedCount: 20, priorAction: 'none', busy: false }), 'flush');
  });
  test('缓冲恰好达到阈值 → reload（边界：>= 才 reload，不是 >）', () => {
    assert.equal(resolveReplayBufferAction({ bufferedCount: REPLAY_BUFFER_RELOAD_THRESHOLD, priorAction: 'keep', busy: false }), 'reload');
  });
  test('缓冲恰好阈值-1 → 仍 flush（边界另一侧，紧邻但不达标）', () => {
    assert.equal(resolveReplayBufferAction({ bufferedCount: REPLAY_BUFFER_RELOAD_THRESHOLD - 1, priorAction: 'keep', busy: false }), 'flush');
  });
  test('缓冲远超阈值（150+，真实"离开期间攒了好几轮回复"场景）→ reload', () => {
    assert.equal(resolveReplayBufferAction({ bufferedCount: 165, priorAction: 'keep', busy: false }), 'reload');
  });
  test('自定义 threshold 覆盖默认导出常量', () => {
    assert.equal(resolveReplayBufferAction({ bufferedCount: 10, priorAction: 'keep', busy: false, threshold: 5 }), 'reload');
    assert.equal(resolveReplayBufferAction({ bufferedCount: 4, priorAction: 'keep', busy: false, threshold: 5 }), 'flush');
  });
  test('缺省入参不抛，保守回 flush（bufferedCount 默认 0、busy 默认 false、priorAction 未知不当 reload/load）', () => {
    assert.doesNotThrow(() => resolveReplayBufferAction());
    assert.equal(resolveReplayBufferAction(), 'flush');
  });
});

// 客户端日志/聊天 stick-to-bottom：距底 < threshold 或 force 时才自动落底，上翻阅读时不被新内容拽回。
// 默认 threshold=120 与 app.js scrollBottom 对齐。
test.describe('shouldStickScrollToBottom：近底跟随 / 上翻不拽 / force 兜底', () => {
  // 几何：scrollHeight=1000, clientHeight=400 → 可滚范围 600；scrollTop=600 即贴底（dist=0）
  const base = { scrollHeight: 1000, clientHeight: 400 };

  test('force=true → 无论距底多远都跟随', () => {
    assert.equal(shouldStickScrollToBottom({ ...base, scrollTop: 0, force: true }), true);
    assert.equal(shouldStickScrollToBottom({ ...base, scrollTop: 600, force: true }), true);
  });

  test('贴底（dist=0）与距底 119 → 跟随', () => {
    assert.equal(shouldStickScrollToBottom({ ...base, scrollTop: 600 }), true); // dist 0
    assert.equal(shouldStickScrollToBottom({ ...base, scrollTop: 481 }), true); // dist 119
  });

  test('距底恰好 120 与更大 → 不跟随（用户在读历史）', () => {
    assert.equal(shouldStickScrollToBottom({ ...base, scrollTop: 480 }), false); // dist 120
    assert.equal(shouldStickScrollToBottom({ ...base, scrollTop: 0 }), false);   // dist 600
  });

  test('缺字段 / NaN 度量（非 force）→ 不跟随，避免误滚', () => {
    assert.equal(shouldStickScrollToBottom({}), false);
    assert.equal(shouldStickScrollToBottom({ scrollHeight: NaN, scrollTop: 0, clientHeight: 100 }), false);
    assert.equal(shouldStickScrollToBottom({ scrollHeight: 100, scrollTop: 'x', clientHeight: 50 }), false);
  });

  test('自定义 threshold：距底 50 在 threshold=40 时不跟随，在 60 时跟随', () => {
    const geo = { scrollHeight: 500, scrollTop: 150, clientHeight: 300 }; // dist 50
    assert.equal(shouldStickScrollToBottom({ ...geo, threshold: 40 }), false);
    assert.equal(shouldStickScrollToBottom({ ...geo, threshold: 60 }), true);
  });
});

// 未读胶囊第三条自动确认已读路径（用户手动滚到底部）：与「点击胶囊」「IntersectionObserver 扫到锚点」
// 并存、互不替代。核心难点——切入积压未读的会话时，回放缓冲落底是"程序性"滚动，不代表用户已经看到
// 胶囊，必须被排除；withinProgrammaticWindow 由调用方（app.js scrollBottom 维护的时间戳窗口）算好
// 传入布尔值，这里只消费结果。贴底判断复用 shouldStickScrollToBottom，默认 threshold=120。
test.describe('shouldAckUnreadOnScroll：未读胶囊「用户手动滚到底部」自动确认已读判定', () => {
  const atBottom = { scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }; // dist 0，贴底
  const notAtBottom = { scrollHeight: 1000, scrollTop: 0, clientHeight: 400 }; // dist 600，远离底部

  test('胶囊不可见 → 恒不触发，即使贴底且不在程序性窗口内', () => {
    assert.equal(shouldAckUnreadOnScroll({ pillVisible: false, withinProgrammaticWindow: false, ...atBottom }), false);
  });

  test('在程序性滚动窗口内 → 不触发，即使胶囊可见且贴底（回放缓冲落底不算"用户看到了"）', () => {
    assert.equal(shouldAckUnreadOnScroll({ pillVisible: true, withinProgrammaticWindow: true, ...atBottom }), false);
  });

  test('窗口外但不贴底 → 不触发（用户还在往上翻历史，没滚到最新消息附近）', () => {
    assert.equal(shouldAckUnreadOnScroll({ pillVisible: true, withinProgrammaticWindow: false, ...notAtBottom }), false);
  });

  test('窗口外且贴底 → 触发（唯一应该 ackUnread 的组合：胶囊可见 + 真实用户滚动 + 已到底部）', () => {
    assert.equal(shouldAckUnreadOnScroll({ pillVisible: true, withinProgrammaticWindow: false, ...atBottom }), true);
  });

  test('缺省入参不抛，保守回 false（默认 pillVisible/withinProgrammaticWindow 均 false，且几何字段缺失时 shouldStickScrollToBottom 本就判 false）', () => {
    assert.doesNotThrow(() => shouldAckUnreadOnScroll());
    assert.equal(shouldAckUnreadOnScroll(), false);
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

test.describe('formatServiceNotices（服务状态可见性——组装会话面板"服务"小节文案）', () => {
  test('空 service → []（一切正常，不渲染小节）', () => {
    assert.deepEqual(formatServiceNotices({ service: null, now: 1000 }), []);
    assert.deepEqual(formatServiceNotices(), []);
  });

  test('仅推送失败 → 一行含"多久之前" + 渠道 + 累计次数', () => {
    const now = 1_000_000;
    assert.deepEqual(
      formatServiceNotices({
        service: { deliveryFailure: { channel: 'ntfy', at: now - 12 * 60 * 1000, count: 2 } },
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
        now
      }),
      ['🔔 推送最近失败于 5 分钟前（push）']
    );
  });

  test('"多久之前"文案跨量级：<1分钟→刚刚、<1小时→N 分钟前、<1天→N 小时前、≥1天→N 天前', () => {
    const now = 10_000_000;
    const at = (deltaMs) => now - deltaMs;
    const bodyOf = (deltaMs) => formatServiceNotices({
      service: { deliveryFailure: { channel: 'push', at: at(deltaMs) } }, now
    })[0];
    assert.match(bodyOf(30 * 1000), /^🔔 推送最近失败于 刚刚（push）$/);
    assert.match(bodyOf(45 * 60 * 1000), /^🔔 推送最近失败于 45 分钟前（push）$/);
    assert.match(bodyOf(5 * 60 * 60 * 1000), /^🔔 推送最近失败于 5 小时前（push）$/);
    assert.match(bodyOf(2 * 24 * 60 * 60 * 1000), /^🔔 推送最近失败于 2 天前（push）$/);
  });
});

// 子 agent 可折叠卡片（切片 C）：事件是否归入子 agent 卡 + 标题文案。
// app.js 用这两个纯函数决定「主流气泡 vs 嵌套卡」；DOM 接线归 visual E2E。
test.describe('isSpawnToolName / formatBgTaskRowLabel（Workflow 子代理可见）', () => {
  test('Agent/Task/Workflow 为 spawn 工具，其它否', () => {
    assert.equal(isSpawnToolName('Agent'), true);
    assert.equal(isSpawnToolName('Task'), true);
    assert.equal(isSpawnToolName('Workflow'), true);
    assert.equal(isSpawnToolName('Bash'), false);
    assert.equal(isSpawnToolName('Read'), false);
    assert.equal(isSpawnToolName(''), false);
    assert.equal(isSpawnToolName(null), false);
  });
  test('formatBgTaskRowLabel：local_agent 加 🤖；洗 Search: search: 重复', () => {
    assert.equal(
      formatBgTaskRowLabel({ taskType: 'local_agent', message: 'Reading app.js', taskId: 't1' }),
      '🤖 Reading app.js',
    );
    assert.equal(
      formatBgTaskRowLabel({ taskType: 'local_agent', message: 'Explore：Searching…' }),
      '🤖 Explore：Searching…',
    );
    assert.equal(
      formatBgTaskRowLabel({ taskType: 'local_bash', message: 'npm test' }),
      '🖥 npm test',
    );
    assert.equal(
      formatBgTaskRowLabel({ message: 'Search: search:行业分布' }),
      'Search：行业分布',
    );
    assert.equal(formatBgTaskRowLabel({ message: 'Synthesize: report' }), 'Synthesize: report');
    assert.equal(formatBgTaskRowLabel({ taskId: 'abc123456789' }), 'abc123456789'.slice(0, 12));
  });
});

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

test.describe('bgTaskListCollapsed（后台任务列表折叠）', () => {
  test('单任务恒展开，不受用户表态影响', () => {
    assert.equal(bgTaskListCollapsed({ count: 1, userExpanded: null }), false);
    assert.equal(bgTaskListCollapsed({ count: 1, userExpanded: false }), false);
    assert.equal(bgTaskListCollapsed({ count: 1, userExpanded: true }), false);
  });
  test('多任务默认收起（用户未表态）', () => {
    assert.equal(bgTaskListCollapsed({ count: 2, userExpanded: null }), true);
    assert.equal(bgTaskListCollapsed({ count: 5 }), true);
  });
  test('多任务时用户表态优先于默认值', () => {
    assert.equal(bgTaskListCollapsed({ count: 3, userExpanded: true }), false);
    assert.equal(bgTaskListCollapsed({ count: 3, userExpanded: false }), true);
  });
  test('count=0 恒不折叠（横幅本就整体隐藏，值不生效但保持确定性）', () => {
    assert.equal(bgTaskListCollapsed({ count: 0, userExpanded: null }), false);
  });
});

test.describe('resolveSheetDragEnd（配置面板下拉关闭）', () => {
  test('位移 ≥ dismissPx → close', () => {
    assert.equal(resolveSheetDragEnd({ dy: 96 }), 'close');
    assert.equal(resolveSheetDragEnd({ dy: 200 }), 'close');
  });
  test('位移不够且无速度 → snap', () => {
    assert.equal(resolveSheetDragEnd({ dy: 40, velocityY: 0 }), 'snap');
    assert.equal(resolveSheetDragEnd({ dy: 0 }), 'snap');
  });
  test('快速下甩且至少移动 minFlickDy → close', () => {
    assert.equal(resolveSheetDragEnd({ dy: 30, velocityY: 0.8 }), 'close');
    // 几乎没动就甩 → 仍 snap（防误触）
    assert.equal(resolveSheetDragEnd({ dy: 10, velocityY: 1.2 }), 'snap');
  });
  test('上推（负 dy）一律 snap', () => {
    assert.equal(resolveSheetDragEnd({ dy: -40, velocityY: -1 }), 'snap');
  });
});

