// tests/unit/logic-rendering.test.mjs —— 终端输出的渲染（ANSI → HTML）与环形缓冲
// ansiToHtml 的输出直接进 innerHTML，所以两条硬约束：先 esc 再着色，且【任何输入都不得留下游离 span】
// ——未闭合的标签会把后面整页的 DOM 结构吃掉。
// 覆盖：24-bit 前景色 · 未闭合 span 的结尾配平 · 空 reset（\x1b[m）也闭合 · 非颜色 SGR 吞序列保留文本
// 这份从原 logic.test.mjs 拆出，同源的还有 -content、-session、-ui-state。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ansiToHtml, urlBase64ToUint8Array, nextHistoryRenderChunk, historyRenderSplit, resolveUnreadAnchorIndex, formatPushStatusRow, describePushTestResult } from '../../app/public/js/logic.js';
import { createRingBuffer } from '../../app/public/js/ring-buffer.js';

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

// ---- nextHistoryRenderChunk：长会话切入分块渲染的推进数学（不碰 DOM，纯计算） ----
test.describe('nextHistoryRenderChunk', () => {
  test('整除边界：total 恰好是 chunkSize 的倍数，分两步推进', () => {
    const step1 = nextHistoryRenderChunk({ processed: 0, total: 80, chunkSize: 40 });
    assert.deepEqual(step1, { end: 40, done: false });
    const step2 = nextHistoryRenderChunk({ processed: 40, total: 80, chunkSize: 40 });
    assert.deepEqual(step2, { end: 80, done: true });
  });

  test('余数块：95 条、每块 40，推进 40/40/15，最后一步 done', () => {
    const step1 = nextHistoryRenderChunk({ processed: 0, total: 95, chunkSize: 40 });
    assert.deepEqual(step1, { end: 40, done: false });
    const step2 = nextHistoryRenderChunk({ processed: 40, total: 95, chunkSize: 40 });
    assert.deepEqual(step2, { end: 80, done: false });
    const step3 = nextHistoryRenderChunk({ processed: 80, total: 95, chunkSize: 40 });
    assert.deepEqual(step3, { end: 95, done: true });
  });

  test('total < chunkSize：一步处理完，done=true', () => {
    const step = nextHistoryRenderChunk({ processed: 0, total: 15, chunkSize: 40 });
    assert.deepEqual(step, { end: 15, done: true });
  });

  test('chunkSize<=0 防呆：至少推进 1 条，不死循环', () => {
    const step = nextHistoryRenderChunk({ processed: 0, total: 3, chunkSize: 0 });
    assert.equal(step.end, 1);
    assert.equal(step.done, false);
    const stepNeg = nextHistoryRenderChunk({ processed: 0, total: 3, chunkSize: -5 });
    assert.equal(stepNeg.end, 1);
  });

  test('total=0：一步 done=true，end=0', () => {
    assert.deepEqual(nextHistoryRenderChunk({ processed: 0, total: 0, chunkSize: 40 }), { end: 0, done: true });
  });
});

// ---- historyRenderSplit：长会话切入先画最近一段，切点只落在回合边界（主链用户文本） ----
test.describe('historyRenderSplit', () => {
  const user = (content, extra = {}) => ({ role: 'user', content, ...extra });
  const reply = (content, extra = {}) => ({ role: 'assistant', content, ...extra });

  test('最近段至少 minRecent 条，切在离那条线最近的主链用户消息上；tool_result 也是 role=user，不算边界', () => {
    const msgs = [
      user('u0'), reply('a1'), user('u2'), reply('a3'),
      { kind: 'tool_result', role: 'user', toolUseId: 'orphan', ok: true },
      reply('a5'), reply('a6'),
    ];
    assert.equal(historyRenderSplit(msgs, 3).cut, 2);
  });

  // 早段后画：配对表 / 子 agent 卡若跨了切点，结果会找不到卡、子卡会建在错的位置
  test('工具配对、子 agent 分组跨了某个边界，就退到更早的边界；退无可退则不切', () => {
    const toolUse = (id, name = 'Bash') => ({ kind: 'tool_use', role: 'assistant', toolUseId: id, name });
    const toolResult = id => ({ kind: 'tool_result', role: 'user', toolUseId: id, ok: true });
    // 回合中途插进来的用户消息（排队消息）落在 tool_use 与 tool_result 之间
    const pairAcross = [
      user('u0'), reply('a1'), user('u2'), reply('a3'),
      toolUse('T'), user('u5'), toolResult('T'), reply('a7'), reply('a8'),
    ];
    assert.equal(historyRenderSplit(pairAcross, 3).cut, 2);
    // 子 agent 条目路由进 parentToolUseId 那张卡，卡建在 spawn 的 tool_use 处
    const groupAcross = [
      user('u0'), reply('a1'), user('u2'), toolUse('P', 'Agent'), toolResult('P'),
      user('u5'), reply('sub', { parentToolUseId: 'P', isSidechain: true }), reply('a7'), reply('a8'),
    ];
    assert.equal(historyRenderSplit(groupAcross, 3).cut, 2);
    // 只带 isSidechain 的旧形态共用一张「sidechain」卡
    const legacySidechain = [
      user('u0'), reply('s1', { isSidechain: true }), reply('a2'),
      user('u3'), user('s4', { isSidechain: true }), reply('a5'), reply('a6'),
    ];
    assert.equal(historyRenderSplit(legacySidechain, 3).cut, 0);
  });

  // 最近段先画，它开头那条要不要出日期线 / 时刻行，取决于切点前最后一条打了时间戳的气泡。
  // 只有主链文本气泡打戳：思考、工具卡、压缩标记、API 报错条、子 agent 正文都不打，没有 ts 的也跳过
  test('seedPrevTs = 切点前最后一条主链文本气泡的时间戳；一条都没有就是 null（会话首条）', () => {
    const at = iso => ({ timestamp: iso });
    const msgs = [
      user('u0', at('2026-10-01T08:00:00Z')),
      reply('a1', at('2026-10-01T08:01:00Z')),
      reply('no-ts'),
      { kind: 'thinking', role: 'assistant', content: 't', ...at('2026-10-02T09:00:00Z') },
      { kind: 'tool_use', role: 'assistant', toolUseId: 'X', name: 'Bash', ...at('2026-10-02T09:00:01Z') },
      { kind: 'tool_result', role: 'user', toolUseId: 'X', ok: true, ...at('2026-10-02T09:00:02Z') },
      { role: 'system', kind: 'compact_summary', content: '', ...at('2026-10-02T09:00:03Z') },
      reply('API Error: 529', { isApiErrorMessage: true, ...at('2026-10-02T09:00:04Z') }),
      reply('sub', { isSidechain: true, parentToolUseId: 'Q', ...at('2026-10-02T09:00:05Z') }),
      reply('sub2', { isSidechain: true, parentToolUseId: 'Q', ...at('2026-10-02T09:00:06Z') }),
      user('u10', at('2026-10-03T10:00:00Z')),
      reply('a11', at('2026-10-03T10:00:01Z')),
    ];
    assert.deepEqual(historyRenderSplit(msgs, 2), { cut: 10, seedPrevTs: Date.parse('2026-10-01T08:01:00Z') });
    const noStampBefore = [reply('no-ts'), user('u1'), reply('a2'), user('u3', at('2026-10-03T10:00:00Z')), reply('a4')];
    assert.deepEqual(historyRenderSplit(noStampBefore, 2), { cut: 3, seedPrevTs: null });
  });

  // suffix：msgs 只是历史的最近一段（session:history 先传的那段），更早的还在路上，最后才接到最前面。
  // 一个 key 在这段里首次出现的不是开它的 tool_use，开它的那条就在更早那段里，等于从 0 之前就开着
  test('suffix：开卡的 tool_use 不在这段里的 key 视为从段首之前开始，切点要退到它之后', () => {
    const toolUse = (id, name = 'Bash') => ({ kind: 'tool_use', role: 'assistant', toolUseId: id, name });
    const toolResult = id => ({ kind: 'tool_result', role: 'user', toolUseId: id, ok: true });
    // 切点前都有打了戳的气泡：不切只能是因为这个 key，不是下一条那个缘故
    const stampedA1 = reply('a1', { timestamp: '2026-10-01T08:00:00Z' });
    const orphanResult = [user('u0'), stampedA1, user('u2'), toolResult('E'), reply('a4'), reply('a5')];
    assert.equal(historyRenderSplit(orphanResult, 3).cut, 2);
    assert.equal(historyRenderSplit(orphanResult, 3, { suffix: true }).cut, 0);
    const orphanGroup = [user('u0'), stampedA1, user('u2'), reply('sub', { parentToolUseId: 'P', isSidechain: true }), reply('a4'), reply('a5')];
    assert.equal(historyRenderSplit(orphanGroup, 3, { suffix: true }).cut, 0);
    // 开卡的就在这段里：和整份时一样切（切点前得有一条打了戳的气泡，见下一条）
    const opened = [user('u0'), stampedA1, user('u2'), toolUse('T'), toolResult('T'), reply('a5')];
    assert.equal(historyRenderSplit(opened, 3, { suffix: true }).cut, 2);
  });

  // 整份时 null 表示会话首条；只有一段时 null 只说明这段里没有，更早那段里有没有不知道，日期线会画错
  test('suffix：切点前这段里没有打了时间戳的气泡就不切在那里', () => {
    const at = iso => ({ timestamp: iso });
    const noStampBefore = [reply('no-ts'), user('u1'), reply('a2'), user('u3', at('2026-10-03T10:00:00Z')), reply('a4')];
    assert.deepEqual(historyRenderSplit(noStampBefore, 2, { suffix: true }), { cut: 0, seedPrevTs: null });
    const stamped = [reply('a0', at('2026-10-01T08:00:00Z')), user('u1'), reply('a2'), user('u3'), reply('a4')];
    assert.deepEqual(historyRenderSplit(stamped, 2, { suffix: true }), { cut: 3, seedPrevTs: Date.parse('2026-10-01T08:00:00Z') });
  });
});

// ---- resolveUnreadAnchorIndex：未读胶囊"跳到第一条未读"的定位数学（不碰 DOM，纯计算） ----
// 未读消息永远是当前已渲染顶层气泡列表的尾部 N 条（N=服务端 unreadOnEntry），不需要跨路径消息 ID，
// 渲染完成后对列表做一次位置计算即可，越界（未读数超过实际渲染条数）优雅降级为"滚到最顶部"而非报错。
test.describe('resolveUnreadAnchorIndex', () => {
  test('正常情况：定位到"倒数第 unreadCount 条"对应的下标', () => {
    assert.equal(resolveUnreadAnchorIndex(10, 3), 7);
    assert.equal(resolveUnreadAnchorIndex(5, 1), 4);
  });

  test('unreadCount 覆盖全部列表：定位到第 0 条（列表顶部）', () => {
    assert.equal(resolveUnreadAnchorIndex(5, 5), 0);
  });

  test('unreadCount 超过实际渲染条数（滑窗截断等极端场景）：clamp 到 0，不越界', () => {
    assert.equal(resolveUnreadAnchorIndex(5, 8), 0);
  });

  test('unreadCount<=0 或列表为空：返回 -1（无需定位）', () => {
    assert.equal(resolveUnreadAnchorIndex(10, 0), -1);
    assert.equal(resolveUnreadAnchorIndex(10, -1), -1);
    assert.equal(resolveUnreadAnchorIndex(0, 3), -1);
  });

  test('unreadCount 非有限数（NaN/undefined）：返回 -1，不产生 NaN 下标', () => {
    assert.equal(resolveUnreadAnchorIndex(10, Number.NaN), -1);
    assert.equal(resolveUnreadAnchorIndex(10, undefined), -1);
  });
});

// ---- pushEnvHint：Web Push 环境判定（E15 / ②2a）——手机「没触发过」多半卡在这几道门 ----


// 推送订阅状态行：这一整段是"我从来没收到过推送、界面上却看不出任何异常"逼出来的——
// 真机实测中 push-subscription.json 压根不存在（从未订阅），而 UI 里没有任何地方显示这件事，
// 铃铛按钮在"权限被拒"时还会永久隐藏。状态必须能被看见，且看得出下一步该做什么。
// 验收 AC-16-06 / O1：通知权限已被拒绝时，测试推送的回执让人「先点上方的『开启』」——此刻状态行根本没有这个按钮；
// ntfy 明明投递成功，回执只看 Web Push，说「还没订阅」。两条通道各说各的，结论看有没有一条真的发出去。
test.describe('describePushTestResult：测试推送回执两条通道各说各的', () => {
  const base = { ok: true, sent: 0, failed: 0, subscribed: false };

  test('权限已被拒绝且没订阅：说清要去站点设置改回允许，不让人去点不存在的「开启」', () => {
    const r = describePushTestResult({ ...base, ntfy: 'disabled' }, { permission: 'denied' });
    assert.match(r.text, /拒绝/);
    assert.doesNotMatch(r.text, /「开启」/);
    assert.equal(r.tone, 'warn');
  });

  // O108：need-https / ios-add-home / unsupported 三态的状态行同样没有「开启」按钮（formatPushStatusRow
  // 给 action:null）。iOS Safari 标签页里 Notification 未定义、permission 回落 'default'，只看 permission
  // 就会落进「先点开启」那句——手机上最常见的一种。
  for (const [hint, cue] of [['need-https', /HTTPS/], ['ios-add-home', /添加到主屏幕/], ['unsupported', /不支持/]]) {
    test(`环境不满足（${hint}）：说清卡在哪，不让人去点状态行上没有的「开启」`, () => {
      const r = describePushTestResult({ ...base, ntfy: 'disabled' }, { permission: 'default', hint });
      assert.doesNotMatch(r.text, /「开启」/);
      assert.match(r.text, cue);
      assert.equal(r.tone, 'warn');
    });
  }

  test('环境满足（ready）且没订阅：仍指向「开启」，那一态状态行确实有这个按钮', () => {
    const r = describePushTestResult({ ...base, ntfy: 'disabled' }, { permission: 'default', hint: 'ready' });
    assert.match(r.text, /「开启」/);
  });

  test('网页推送没订阅但 ntfy 发出去了：报成功并点名 ntfy，不只说「还没订阅」', () => {
    const r = describePushTestResult({ ...base, ntfy: 'sent' }, { permission: 'default' });
    assert.match(r.text, /ntfy/);
    assert.equal(r.tone, 'ok');
  });

  test('ntfy 投递失败：任一条失败即报错', () => {
    assert.equal(describePushTestResult({ ...base, sent: 1, subscribed: true, ntfy: 'failed' }).tone, 'danger');
  });

  test('网页推送发出且没配 ntfy：照旧报发出条数，不提 ntfy', () => {
    const r = describePushTestResult({ ...base, sent: 1, subscribed: true, ntfy: 'disabled' });
    assert.match(r.text, /已发出测试推送 1 条/);
    assert.doesNotMatch(r.text, /ntfy/);
    assert.equal(r.tone, 'ok');
  });

  test('请求本身失败（超时 / 断网）→ 报错', () => {
    assert.equal(describePushTestResult(null).tone, 'danger');
  });
});

test.describe('formatPushStatusRow：推送订阅状态可见化', () => {
  // 只能进不能出：此前 subscribed 恒 action:null，订上之后 UI 上再没有任何退订入口，
  // 想关只能去浏览器站点设置里把权限改成「阻止」——而那会让本行翻成「已被拒绝」，
  // 把一次主动关闭说成了拒绝。开关得是双向的。
  test('已订阅 → ok 态，并给「关闭」这条出路', () => {
    const r = formatPushStatusRow({ hint: 'ready', permission: 'granted', subscribed: true });
    assert.equal(r.tone, 'ok');
    assert.match(r.value, /已开启/);
    assert.equal(r.action, 'unsubscribe');
    assert.match(r.actionText, /关闭/);
  });

  test('未授权（default）→ 给「开启」按钮', () => {
    const r = formatPushStatusRow({ hint: 'ready', permission: 'default', subscribed: false });
    assert.equal(r.action, 'subscribe');
    assert.match(r.value, /未开启/);
  });

  test('权限被拒 → 必须仍然可见并说清怎么恢复（此前按钮直接隐藏、成死路）', () => {
    const r = formatPushStatusRow({ hint: 'ready', permission: 'denied', subscribed: false });
    assert.equal(r.tone, 'warn');
    assert.match(r.value, /已被拒绝|被拒/);
    assert.match(r.hint, /浏览器|设置/);
  });

  test('已授权却没订阅上 → 报出来并给重试（此前是彻底静默）', () => {
    const r = formatPushStatusRow({ hint: 'ready', permission: 'granted', subscribed: false });
    assert.equal(r.tone, 'warn');
    assert.equal(r.action, 'subscribe');
    assert.match(r.value, /未完成|未订阅/);
  });

  // 「关掉了」和「没订上」在 permission/subscribed 两个维度上完全同形（granted + 未订阅），
  // 只有用户意图能分开它们。不分就会把一次成功的主动关闭，报成刺眼的警告色「未完成订阅」——
  // 与此前那条「已被拒绝」是同一种说反话。
  test('用户主动关掉的 → 中性地说「已关闭」，不冒充失败态', () => {
    const r = formatPushStatusRow({ hint: 'ready', permission: 'granted', subscribed: false, optedOut: true });
    assert.notEqual(r.tone, 'warn', '主动关闭不是警告');
    assert.match(r.value, /已关闭/);
    assert.equal(r.action, 'subscribe', '仍然给得出「再开」这条路');
  });

  test('环境不满足：iOS 未加主屏 / 非 HTTPS / 不支持 → 说明具体门槛，不给无效按钮', () => {
    const ios = formatPushStatusRow({ hint: 'ios-add-home', permission: 'default', subscribed: false });
    assert.match(ios.hint, /主屏/);
    assert.equal(ios.action, null);
    const http = formatPushStatusRow({ hint: 'need-https', permission: 'default', subscribed: false });
    assert.match(http.hint, /HTTPS/i);
    assert.equal(http.action, null);
    assert.equal(formatPushStatusRow({ hint: 'unsupported', permission: 'default', subscribed: false }).action, null);
  });
});
