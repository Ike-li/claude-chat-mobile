// tests/v2/notifications.test.mjs —— 推送抑制矩阵、正文最小化与深链构造
// 守护：NOTIFY-01（只有 result 会被抑制，判据是前台可见而非 socket 连着）、
//       SEC-04（正文不进第三方明文通道，body 只留工具名，input 正文另走 previewBody）
// 覆盖：抑制矩阵 + 发送时刻取 live/snapshot 的分流 + 前台判据的保守方向
//       + ntfy 深链不带完整 cwd + 标题身份拼接
// 槽位：S1（纯函数，零 IO、不发网络）
//
// 不测什么 + 为什么：
//  ① 真实 APNs / FCM / ntfy 投递 —— 需外部服务与真凭据，不进 PR（属发版手测）。
//  ② OPS-3 的 notify_failed 双通道状态翻转 —— 判定活在 server 的 StateProbe 里，
//     不在本模块，属 S2 测点。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  notificationForEvent,
  notifyHasClientsAtSend,
  hasForegroundApprovedClient,
  formatNotifyIdentity,
  sanitizeNotifySessionTitle,
  ntfyMetaFor,
  shouldNotifyBackgroundRunning,
  notificationForBackgroundRunning,
  notificationForCliHook,
  notificationForDeviceRequest,
  throttleNotify,
  clearNotifyPending,
  describeDeliveryError,
  isValidPushSubscription,
  NOTIFY_THROTTLE_CAP,
} from '../../app/src/ops/notifications.js';

test.describe('NOTIFY-01 抑制矩阵：只有 result 让位于前台', () => {
  test('result：前台有人 → 不推（返回 null）', () => {
    const n = notificationForEvent('result', { durationMs: 1500 }, { hasClients: true });
    assert.equal(n, null);
  });

  test('result：前台无人 → 推，标题区分完成/出错/已中止', () => {
    const done = notificationForEvent('result', { durationMs: 1500 }, { hasClients: false });
    assert.match(done.title, /任务完成/);
    assert.equal(done.body, '用时 1.5s');

    const err = notificationForEvent('result', { isError: true, durationMs: 1000 }, { hasClients: false });
    assert.match(err.title, /任务出错/);

    // 对齐 CLI：interrupt 终态即使带 isError 也算「已中止」，不是「出错」——两者对用户的含义不同
    const stopped = notificationForEvent('result', { interrupted: true, isError: true, durationMs: 1000 }, { hasClients: false });
    assert.match(stopped.title, /已中止/);
    assert.doesNotMatch(stopped.title, /出错/);
  });

  test('permission_request：前台有人也照推（用户可能锁屏或在别的 app）', () => {
    const n = notificationForEvent('permission_request', { name: 'Bash' }, { hasClients: true });
    assert.notEqual(n, null, '审批是无条件推的类型，hasClients 不得让它静音');
    assert.match(n.body, /Bash/);
  });

  test('question：前台有人也照推', () => {
    const n = notificationForEvent('question', { text: '选哪个？' }, { hasClients: true });
    assert.notEqual(n, null);
  });

  test('未知事件类型 → null，不构造出无意义通知', () => {
    assert.equal(notificationForEvent('totally_unknown_type', {}, { hasClients: false }), null);
  });

  test('opts 省略 hasClients 时按「无前台」处理 → result 照推', () => {
    // 默认值决定了新调用方忘传时的方向。默认「无前台」= 宁可多推一条，也不静默吞掉完成通知
    // （吞通知的症状是"应用像消失了"，比多一条推送难查得多）。
    const n = notificationForEvent('result', { durationMs: 1000 });
    assert.notEqual(n, null, '不传 hasClients 不得被当成「有前台」而静音');
  });
});

test.describe('SEC-04 正文最小化：命令参数不进推送正文', () => {
  test('permission_request 的 body 只有工具名，绝不含 input 参数', () => {
    const secret = 'rm -rf /etc/passwd --token=SUPERSECRET';
    const n = notificationForEvent('permission_request',
      { name: 'Bash', input: { command: secret } }, { hasClients: false });
    assert.match(n.body, /需要你授权：Bash/);
    assert.doesNotMatch(n.body, /SUPERSECRET/, 'body 是默认通道，绝不能带命令正文');
    assert.doesNotMatch(n.body, /rm -rf/);
  });

  test('input 正文只出现在 previewBody（用户显式开预览才用的独立字段）', () => {
    const n = notificationForEvent('permission_request',
      { name: 'Bash', input: { command: 'ls -la' } }, { hasClients: false });
    assert.match(n.previewBody, /ls -la/, '预览通道保留细节');
    assert.notEqual(n.previewBody, n.body, '两个字段必须可区分，否则开关失去意义');
  });

  test('无 input 时 previewBody 退化为工具名，不产出 "undefined" 字样', () => {
    const n = notificationForEvent('permission_request', { name: 'Read' }, { hasClients: false });
    assert.doesNotMatch(n.previewBody, /undefined/);
    assert.match(n.previewBody, /Read/);
  });

  test('工具名缺失时用占位「工具」，不泄漏 undefined 给用户', () => {
    const n = notificationForEvent('permission_request', {}, { hasClients: false });
    assert.match(n.body, /工具/);
    assert.doesNotMatch(n.body, /undefined/);
  });

  test('工具名是空串时保留空串，不悄悄替换成占位（?? 只兜 null/undefined）', () => {
    const n = notificationForEvent('permission_request', { name: '' }, { hasClients: false });
    assert.equal(n.body, '需要你授权：', '空串是「上游给了空名字」，与「没给名字」是两种状态');
    assert.equal(n.previewBody, '', '预览通道同样不把空串替换成占位');
  });

  test('input 不是对象时不做 JSON 序列化，previewBody 只留工具名', () => {
    // `p.input && typeof p.input === 'object'` 两个条件缺一不可：写成 || 会让字符串 input
    // 被 JSON.stringify 成带引号的怪串塞进预览。
    for (const notObject of ['一段字符串', 42, true]) {
      const n = notificationForEvent('permission_request',
        { name: 'Bash', input: notObject }, { hasClients: false });
      assert.equal(n.previewBody, 'Bash', `input=${JSON.stringify(notObject)} 不该被序列化进预览`);
    }
  });
});

test.describe('发送时刻的判据：result 用现场值，其余用快照', () => {
  test('result / system 取 live——peek 标题可能耗几百 ms，人已回前台就不该再推', () => {
    assert.equal(notifyHasClientsAtSend('result', false, true), true, 'live 为真则视为有前台');
    assert.equal(notifyHasClientsAtSend('result', true, false), false, '快照为真但现场已无人 → 仍要推');
    assert.equal(notifyHasClientsAtSend('system', false, true), true);
  });

  test('permission / question 取快照——它们无条件推，不受这几百 ms 影响', () => {
    assert.equal(notifyHasClientsAtSend('permission_request', true, false), true);
    assert.equal(notifyHasClientsAtSend('question', false, true), false);
  });

  test('非布尔值一律不算「有前台」（=== true 严格判定）', () => {
    assert.equal(notifyHasClientsAtSend('result', undefined, undefined), false);
    assert.equal(notifyHasClientsAtSend('question', 1, 1), false, '真值但非 true 不算数');
  });
});

test.describe('前台判据：hidden 是客户端上报的，不是「socket 连着」', () => {
  test('无连接 → 无前台', () => {
    assert.equal(hasForegroundApprovedClient([]), false);
  });

  test('全部上报 hidden=true（页面在后台）→ 无前台，result 该推', () => {
    assert.equal(hasForegroundApprovedClient([{ data: { hidden: true } }, { data: { hidden: true } }]), false);
  });

  test('只要一个可见就算有前台', () => {
    assert.equal(hasForegroundApprovedClient([{ data: { hidden: true } }, { data: { hidden: false } }]), true);
  });

  test('尚未上报 presence 的连接【视为前台】——保守方向，宁可少推不误炸', () => {
    // 产品选定的失败方向：缺信息时不推。若反过来当成后台，用户正盯着屏幕却收到推送。
    assert.equal(hasForegroundApprovedClient([{ data: {} }]), true, '连上但没报 presence');
    assert.equal(hasForegroundApprovedClient([{}]), true, '连 data 都没有');
    assert.equal(hasForegroundApprovedClient([null]), true, '异常项同样走保守分支，不抛错');
  });
});

test.describe('ntfy 深链：第三方明文通道不带完整 cwd', () => {
  test('click 深链只带 instance 与 session', () => {
    const meta = ntfyMetaFor('result',
      { instanceId: 'i-1', sessionId: 's-1', cwd: '/Users/someone/private/repo' },
      'https://example.com');
    assert.match(meta.click, /instance=i-1/);
    assert.match(meta.click, /session=s-1/);
    assert.doesNotMatch(meta.click, /private/, 'cwd 明文经第三方 = SEC-04 红线');
    assert.doesNotMatch(meta.click, /Users/);
  });

  test('无 publicUrl 或无 instanceId → 不产出 click（宁可没深链也不给半个）', () => {
    assert.equal(ntfyMetaFor('result', { instanceId: 'i-1' }, '').click, undefined);
    assert.equal(ntfyMetaFor('result', { sessionId: 's-1' }, 'https://example.com').click, undefined);
  });

  test('需即时响应的四类走高优先级，其余普通', () => {
    for (const t of ['permission_request', 'question', 'cli_hook_notification', 'device_request']) {
      assert.equal(ntfyMetaFor(t, {}, '').priority, 5, `${t} 需要用户立刻处理`);
    }
    assert.equal(ntfyMetaFor('result', {}, '').priority, 3);
  });

  test('publicUrl 末尾多余斜杠不产生双斜杠', () => {
    const meta = ntfyMetaFor('result', { instanceId: 'i-1' }, 'https://example.com///');
    assert.doesNotMatch(meta.click, /com\/\/+#/);
  });

  test('未知 type 的 tags 归一为空数组，不是 undefined（下游要 join，undefined 会炸）', () => {
    const meta = ntfyMetaFor('some_future_event_type', {}, '');
    assert.ok(Array.isArray(meta.tags), 'tags 必须始终是数组');
    assert.deepEqual(meta.tags, []);
  });
});

test.describe('标题身份：让用户一眼看出是哪个项目哪个会话', () => {
  test('三段用 · 连接：事件 · 项目 · 会话', () => {
    const t = formatNotifyIdentity('✅ 任务完成', { cwd: '/home/u/my-repo', sessionTitle: '修登录' });
    assert.equal(t, '✅ 任务完成 · my-repo · 修登录');
  });

  test('缺项自动省略，不留下空段或悬挂的分隔符', () => {
    assert.equal(formatNotifyIdentity('✅ 完成', {}), '✅ 完成');
    assert.equal(formatNotifyIdentity('✅ 完成', { cwd: '/home/u/repo' }), '✅ 完成 · repo');
    assert.doesNotMatch(formatNotifyIdentity('✅ 完成', { sessionTitle: '  ' }), /·\s*$/);
  });

  test('三个占位会话名不进标题——英文那份漏了等于对英文界面用户失效', () => {
    // 'New session' 是前端 i18n 给「新会话」的英文译文，标题是翻译后才传上来的。只认中文
    // 那份，英文界面用户就会收到「✅ 完成 · proj · New session」这种假标题。
    // 这三个值与 public/js/logic/session-search.js 的同名集合逐字相等（另有跨端对照闸守着）。
    for (const placeholder of ['新会话', '(无标题)', 'New session']) {
      assert.equal(sanitizeNotifySessionTitle(placeholder), '', `占位名 "${placeholder}" 不该进标题`);
    }
  });

  test('真实会话名保留；换行压成空格；超 40 字截断', () => {
    assert.equal(sanitizeNotifySessionTitle('修复登录跳转'), '修复登录跳转');
    assert.equal(sanitizeNotifySessionTitle(' 修复\n 登录 '), '修复 登录', '锁屏一行很窄，换行要压平');
    const long = sanitizeNotifySessionTitle('x'.repeat(50));
    assert.equal(long.length, 41, '40 字 + 省略号');
    assert.ok(long.endsWith('…'));
  });

  test('非字符串输入返回空串，不抛错也不产出 "null"', () => {
    for (const bad of [null, undefined, 42, {}]) {
      assert.equal(sanitizeNotifySessionTitle(bad), '');
    }
  });

  test('项目名取路径尾段：根路径与 Windows 反斜杠都不能产出空段或整串', () => {
    // 实现故意不用 node:path 的 basename——它对这两个形态都答错：
    // basename('/') === '' 会漏出「✅ 完成 ·  · 标题」的空段；
    // basename('C:\\code\\proj') 在 POSIX 上返回整串，把整条 Windows 路径塞进横幅。
    assert.equal(formatNotifyIdentity('✅ 完成', { cwd: '/' }), '✅ 完成', '根路径不产出空段');
    assert.equal(formatNotifyIdentity('✅ 完成', { cwd: 'C:\\code\\proj' }), '✅ 完成 · proj',
      'Windows 路径只取尾段，不整串塞进通知');
    assert.equal(formatNotifyIdentity('✅ 完成', { cwd: '/home/u/repo/' }), '✅ 完成 · repo',
      '尾部斜杠不影响取尾段');
  });
});

// ── 非 envelope 触发的三类通知 ──────────────────────────────────────────────
// 本节补的是变异对比里 v2 相对旧测试【整块缺失】的覆盖面（约 28 个变异点）。
// 这三类的触发源都不是 agent:event，所以刻意与 notificationForEvent 分列，
// 免得「type 对应真实 envelope 类型」那条隐含契约变模糊。
test.describe('后台运行提示：只在「刚离开前台且确实在跑」时发', () => {
  test('三个条件必须精确成立，任一不满足就不发', () => {
    const yes = { hadForeground: true, hasForeground: false, hasBusyInstance: true };
    assert.equal(shouldNotifyBackgroundRunning(yes), true);
    assert.equal(shouldNotifyBackgroundRunning({ ...yes, hadForeground: false }), false, '本来就没在前台 → 不是「切走了」');
    assert.equal(shouldNotifyBackgroundRunning({ ...yes, hasForeground: true }), false, '人还在前台 → 不用提示');
    assert.equal(shouldNotifyBackgroundRunning({ ...yes, hasBusyInstance: false }), false, '没有在跑的任务 → 没什么可等');
    assert.equal(shouldNotifyBackgroundRunning({}), false, '空参数不得误判为该发');
  });

  test('真值但非布尔一律不算（=== 严格判定）', () => {
    assert.equal(shouldNotifyBackgroundRunning({ hadForeground: 1, hasForeground: 0, hasBusyInstance: 1 }), false);
  });

  test('文案不含会话内容，深链仅在有 instanceId 时给', () => {
    const withId = notificationForBackgroundRunning({ instanceId: 'i-1', sessionId: 's-1', cwd: '/home/u/proj' });
    assert.match(withId.title, /后台运行/);
    assert.match(withId.title, /proj/, '标题要带项目名，否则多项目下认不出是哪个');
    assert.equal(withId.body, '运行结束后会通知你');
    assert.deepEqual(withId.data, { instanceId: 'i-1', sessionId: 's-1', cwd: '/home/u/proj' });

    const noId = notificationForBackgroundRunning({ cwd: '/home/u/proj' });
    assert.equal(noId.data, undefined, '没有实例就不编一个点不开的深链');
  });
});

test.describe('终端会话（CLI hooks 桥）通知', () => {
  test('Stop 与 Notification 是两种语义，文案不得混用', () => {
    const stop = notificationForCliHook('Stop', { cwd: '/home/u/proj' });
    assert.match(stop.title, /完成/);
    assert.match(stop.body, /跑完了/);

    const notify = notificationForCliHook('Notification', { cwd: '/home/u/proj' });
    assert.match(notify.title, /需要你/);
    assert.match(notify.body, /等你回应/);
    assert.notEqual(stop.title, notify.title, '「跑完了」和「在等你」对用户是两件事');
  });

  test('未知 hook 事件 → null，不产出无意义通知', () => {
    for (const e of ['PreToolUse', 'SessionStart', '', null, undefined]) {
      assert.equal(notificationForCliHook(e, { cwd: '/x' }), null);
    }
  });

  test('纯外部终端会话没有 instanceId → 不带深链（点开落首页）', () => {
    assert.equal(notificationForCliHook('Stop', { cwd: '/x' }).data, undefined);
    assert.deepEqual(notificationForCliHook('Stop', { cwd: '/x', instanceId: 'i', sessionId: 's' }).data,
      { instanceId: 'i', sessionId: 's', cwd: '/x' });
  });
});

test.describe('新设备请求：SEC-04 在这里比别处更硬', () => {
  test('deviceId / ip / userAgent 结构上就取不到，不靠「记得别放」', () => {
    // 这三项恰恰是审批时要核对的，而推送是明文通道（ntfy 还经第三方）。
    // 实现只解构 count —— 传再多也漏不出去。
    const n = notificationForDeviceRequest({
      count: 1, deviceId: 'dev-SECRET-123', ip: '203.0.113.9', userAgent: 'Mozilla/5.0 SecretBrowser',
    });
    const text = JSON.stringify(n);
    assert.ok(!text.includes('dev-SECRET-123'), '设备 ID 不得进推送正文');
    assert.ok(!text.includes('203.0.113.9'), 'IP 不得进推送正文');
    assert.ok(!text.includes('SecretBrowser'), 'UA 不得进推送正文');
    assert.equal(n.data, undefined, '设备审批不属于任何会话，不给深链');
    assert.equal(n.previewBody, undefined, '预览开关是为会话正文设的，不该成为设备标识的旁路');
  });

  test('多台待审时给出数量，单台用单数文案', () => {
    assert.match(notificationForDeviceRequest({ count: 3 }).body, /3 台/);
    assert.match(notificationForDeviceRequest({ count: 1 }).body, /有新设备/);
    assert.match(notificationForDeviceRequest({}).body, /有新设备/, '缺省按 1 台');
  });

  test('非法 count 退化成单数，不产出「NaN 台设备」', () => {
    for (const bad of [NaN, Infinity, -5, 0, '3', null]) {
      assert.match(notificationForDeviceRequest({ count: bad }).body, /有新设备/, `count=${String(bad)} 应退化`);
    }
  });
});

test.describe('per-会话节流：不重复轰炸同一会话', () => {
  test('缺 sessionId 或 category 时保守不节流（宁可多推，不误伤）', () => {
    assert.equal(throttleNotify(null, 'approval', 0).throttled, false);
    assert.equal(throttleNotify('s', null, 0).throttled, false);
  });

  test('首次通知放行；最小间隔内的同类再来被抑制', () => {
    const r1 = throttleNotify('s-1', 'finished', 1000, new Map());
    assert.equal(r1.throttled, false);
    assert.equal(throttleNotify('s-1', 'finished', 1500, r1.next).throttled, true, '500ms < 60s，抑制');
    assert.equal(throttleNotify('s-1', 'finished', 1000 + 60_000, r1.next).throttled, false, '到点后放行');
  });

  test('approval / input 记未决，未被处理前一直抑制（哪怕过了最小间隔）', () => {
    const r1 = throttleNotify('s-1', 'approval', 0, new Map());
    assert.equal(throttleNotify('s-1', 'approval', 999_999, r1.next).throttled, true,
      '审批没被处理就一直算未决，不因时间流逝解除');
  });

  test('finished 是一次性终态，不记未决，只受最小间隔约束', () => {
    const r1 = throttleNotify('s-1', 'finished', 0, new Map());
    assert.equal(throttleNotify('s-1', 'finished', 60_000, r1.next).throttled, false);
  });

  test('clearNotifyPending 解除未决，但【不重置】计时', () => {
    // 不动 notifiedAt 是有意的：否则「批准后立刻又来一个新审批」会瞬间绕开间隔节流。
    const r1 = throttleNotify('s-1', 'approval', 1000, new Map());
    const cleared = clearNotifyPending('s-1', 'approval', r1.next);
    assert.equal(throttleNotify('s-1', 'approval', 1500, cleared).throttled, true, '未决解除了，但间隔还没到');
    assert.equal(throttleNotify('s-1', 'approval', 1000 + 60_000, cleared).throttled, false);
  });

  test('清除不存在的会话/类别 → 原样返回，不抛错', () => {
    const st = new Map();
    assert.equal(clearNotifyPending('nope', 'approval', st), st);
  });

  test('不同会话、不同类别互不干扰', () => {
    const r1 = throttleNotify('s-1', 'approval', 0, new Map());
    assert.equal(throttleNotify('s-2', 'approval', 0, r1.next).throttled, false);
    assert.equal(throttleNotify('s-1', 'finished', 0, r1.next).throttled, false);
  });

  test('会话数有界，超上限淘汰最旧（防无界增长）', () => {
    let state = new Map();
    for (let i = 0; i < NOTIFY_THROTTLE_CAP + 5; i++) state = throttleNotify(`s-${i}`, 'finished', i, state).next;
    assert.ok(state.size <= NOTIFY_THROTTLE_CAP, `会话数不得超过 ${NOTIFY_THROTTLE_CAP}`);
    assert.equal(state.has('s-0'), false, '最旧的会话应被淘汰');
  });
});

test.describe('投递错误归因与订阅校验', () => {
  test('HTTP 状态码优先，其次 code，再次消息', () => {
    assert.equal(describeDeliveryError({ statusCode: 410 }), 'HTTP 410');
    assert.equal(describeDeliveryError({ code: 'ECONNRESET' }), 'ECONNRESET');
    assert.equal(describeDeliveryError({ message: 'boom' }), 'boom');
  });

  test('含 URL 的消息归一成 network error（不把端点写进日志）', () => {
    assert.equal(describeDeliveryError({ message: 'failed to POST https://fcm.example.com/abc' }), 'network error');
  });

  test('超长消息截断；空/非对象归一为 unknown', () => {
    assert.equal(describeDeliveryError({ message: 'x'.repeat(100) }).length, 61);
    assert.equal(describeDeliveryError({ message: '   ' }), 'unknown');
    assert.equal(describeDeliveryError(null), 'unknown');
    assert.equal(describeDeliveryError('str'), 'unknown');
  });

  test('订阅校验：端点必须是 http(s) URL，拦 javascript: 等协议', () => {
    const ok = { endpoint: 'https://fcm.example.com/x', keys: { p256dh: 'k', auth: 'a' } };
    assert.equal(isValidPushSubscription(ok), true);
    assert.equal(isValidPushSubscription({ ...ok, endpoint: 'javascript:alert(1)' }), false);
    assert.equal(isValidPushSubscription({ ...ok, endpoint: 'ftp://x/y' }), false);
    assert.equal(isValidPushSubscription({ ...ok, endpoint: '' }), false);
  });

  test('订阅校验：keys 的两个字段缺一不可', () => {
    const base = { endpoint: 'https://x/y' };
    assert.equal(isValidPushSubscription({ ...base, keys: { p256dh: 'k' } }), false);
    assert.equal(isValidPushSubscription({ ...base, keys: { auth: 'a' } }), false);
    assert.equal(isValidPushSubscription({ ...base, keys: {} }), false);
    assert.equal(isValidPushSubscription(base), false);
  });

  test('订阅校验：数组与非对象一律拒绝', () => {
    assert.equal(isValidPushSubscription([]), false);
    assert.equal(isValidPushSubscription(null), false);
    assert.equal(isValidPushSubscription('x'), false);
    assert.equal(isValidPushSubscription({ endpoint: 'https://x/y', keys: [] }), false);
  });
});
