// tests/unit/notifications.test.mjs —— notificationForEvent 纯映射单测（零副作用，不碰 web-push 传输）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { notificationForEvent, ntfyMetaFor, ntfyRequestInit, throttleNotify, clearNotifyPending, NOTIFY_CATEGORY, STALL_NOTIFY_INTERVAL_MS, isValidPushSubscription, hasForegroundApprovedClient, shouldNotifyBackgroundRunning, notificationForBackgroundRunning, notificationForDeviceRequest, notificationForCliHook, sanitizeNotifySessionTitle, formatNotifyIdentity, notifyHasClientsAtSend, describeDeliveryError } from '../../app/src/ops/notifications.js';

// ── BE-014：push 订阅结构校验（落盘前拦畸形，防 .slice() 抛 500 + 污染后续推送）──────────────
test.describe('isValidPushSubscription', () => {
  const validSub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BKp...', auth: 'a1b2' } };
  test('标准订阅（endpoint https + keys.p256dh/auth）→ true', () => {
    assert.equal(isValidPushSubscription(validSub), true);
    assert.equal(isValidPushSubscription({ ...validSub, expirationTime: null }), true); // 可选字段不影响
  });
  test('truthy 非字符串 endpoint（数字/对象/数组）→ false（正是旧 .slice() 崩+落盘的根因）', () => {
    assert.equal(isValidPushSubscription({ endpoint: 123, keys: validSub.keys }), false);
    assert.equal(isValidPushSubscription({ endpoint: { u: 'x' }, keys: validSub.keys }), false);
    assert.equal(isValidPushSubscription({ endpoint: ['https://x'], keys: validSub.keys }), false);
  });
  test('缺失/空 endpoint → false', () => {
    assert.equal(isValidPushSubscription({ keys: validSub.keys }), false);
    assert.equal(isValidPushSubscription({ endpoint: '', keys: validSub.keys }), false);
  });
  test('endpoint 非 http(s) URL → false', () => {
    assert.equal(isValidPushSubscription({ endpoint: 'javascript:alert(1)', keys: validSub.keys }), false);
    assert.equal(isValidPushSubscription({ endpoint: 'ftp://x/y', keys: validSub.keys }), false);
  });
  test('缺失/畸形 keys → false（web-push 加密必须 p256dh+auth）', () => {
    assert.equal(isValidPushSubscription({ endpoint: validSub.endpoint }), false);
    assert.equal(isValidPushSubscription({ endpoint: validSub.endpoint, keys: {} }), false);
    assert.equal(isValidPushSubscription({ endpoint: validSub.endpoint, keys: { p256dh: 'x' } }), false); // 缺 auth
    assert.equal(isValidPushSubscription({ endpoint: validSub.endpoint, keys: { p256dh: 1, auth: 2 } }), false); // 非字符串
  });
  test('非对象/null → false（不抛）', () => {
    assert.equal(isValidPushSubscription(null), false);
    assert.equal(isValidPushSubscription(undefined), false);
    assert.equal(isValidPushSubscription('string'), false);
    assert.equal(isValidPushSubscription([]), false);
  });
});


// ── result：仅在无客户端连接时推 ──────────────────────────────────────────────

test('result + 无客户端 → 推「任务完成」含耗时', () => {
  const n = notificationForEvent('result', { durationMs: 3210, isError: false }, { hasClients: false });
  assert.deepEqual(n, { title: '✅ 任务完成', body: '用时 3.2s' });
});

test('result + isError + 无客户端 → 推「任务出错」', () => {
  const n = notificationForEvent('result', { durationMs: 0, isError: true }, { hasClients: false });
  assert.equal(n.title, '⚠️ 任务出错');
});

// 对齐 CLI：用户主动中止后 SDK 仍可能带 is_error + ede_diagnostic；离线推送不得误报「任务出错」
test('result + interrupted（即使 isError）+ 无客户端 → 推「任务已中止」', () => {
  const n = notificationForEvent(
    'result',
    { durationMs: 249400, isError: true, interrupted: true, errors: ['[ede_diagnostic] stop_reason=tool_use'] },
    { hasClients: false },
  );
  assert.equal(n.title, '⏹ 任务已中止');
  assert.equal(n.body, '用时 249.4s');
});

test('result + 有客户端连接 → 不推（客户端自己看得到）', () => {
  assert.equal(notificationForEvent('result', { durationMs: 3210 }, { hasClients: true }), null);
});

// ── hasForegroundApprovedClient：PWA 后台推送修复——approved 房间"连着"升级为"前台可见" ──────
// 背景：hasClients 曾直接取"approved 房间是否有 socket"，但 PWA 切后台后 socket 常常还没断
// （要等 OS 冻结页面才真正断连），会把"背景里还连着"误判为"有人在看"而吞掉 result 完成通知。
// 客户端在 visibilitychange/pagehide 时上报 client:presence，服务端记 socket.data.hidden；
// 本函数判定这批 socket 里是否还有"前台"的——保守默认：未上报过 presence（data.hidden===undefined，
// 如刚连接尚未上报的连接）一律按前台算，最坏情况是退回现状（不解锁推送），不会因误判后台而重复轰炸。
test.describe('hasForegroundApprovedClient', () => {
  test('全部 socket 都 hidden:true（都在后台）→ false（无前台可见客户端）', () => {
    const sockets = [{ data: { hidden: true } }, { data: { hidden: true } }];
    assert.equal(hasForegroundApprovedClient(sockets), false);
  });

  test('至少一个不是 hidden:true（含 undefined/false）→ true', () => {
    assert.equal(hasForegroundApprovedClient([{ data: { hidden: true } }, { data: { hidden: false } }]), true);
    assert.equal(hasForegroundApprovedClient([{ data: { hidden: true } }, { data: {} }]), true, '未上报过 presence 的连接保守按前台算');
    assert.equal(hasForegroundApprovedClient([{ data: {} }]), true);
  });

  test('空数组（approved 房间无人）→ false', () => {
    assert.equal(hasForegroundApprovedClient([]), false);
  });

  test('缺省参数（未传 sockets）→ false，不抛', () => {
    assert.equal(hasForegroundApprovedClient(), false);
  });

  test('socket 缺 data 字段 → 视为未上报过 presence，按前台算，不抛', () => {
    assert.equal(hasForegroundApprovedClient([{}]), true);
  });
});

// ── shouldNotifyBackgroundRunning：presence"从有前台变无前台"跳变 + 有 busy 实例 → 后台运行中提示 ──
// 纯函数，输入是调用方（app.js on(socket,'client:presence',…)）在真正 mutate socket.data.hidden
// 前后各算一次 hasForegroundApprovedClient 得到的 hadForeground/hasForeground，外加是否有 busy 实例。
// 天然节流的关键：只有"之前有、现在没了"这个精确跳变才成立，重复上报/无关状态不触发。
test.describe('shouldNotifyBackgroundRunning', () => {
  test('之前有前台、现在没有前台、且有 busy 实例 → true（唯一应该推送的情形）', () => {
    assert.equal(shouldNotifyBackgroundRunning({ hadForeground: true, hasForeground: false, hasBusyInstance: true }), true);
  });

  test('之前有前台、现在没有前台，但无 busy 实例 → false（没什么在跑，没必要提醒）', () => {
    assert.equal(shouldNotifyBackgroundRunning({ hadForeground: true, hasForeground: false, hasBusyInstance: false }), false);
  });

  test('之前就已经没有前台（非跳变时刻，如同一 socket 重复上报 hidden:true）→ false，即使有 busy 实例', () => {
    assert.equal(shouldNotifyBackgroundRunning({ hadForeground: false, hasForeground: false, hasBusyInstance: true }), false);
  });

  test('之前有前台、现在仍有前台（如两个已批准连接，一个切后台但另一个还在前台）→ false', () => {
    assert.equal(shouldNotifyBackgroundRunning({ hadForeground: true, hasForeground: true, hasBusyInstance: true }), false);
  });

  test('之前无前台、现在反而变成有前台（不构成"变无"跳变，理论上不会发生但防御性验证）→ false', () => {
    assert.equal(shouldNotifyBackgroundRunning({ hadForeground: false, hasForeground: true, hasBusyInstance: true }), false);
  });

  test('缺省参数（未传任何字段）→ false，不抛', () => {
    assert.equal(shouldNotifyBackgroundRunning(), false);
  });
});

// ── notificationForBackgroundRunning：「后台运行中」提示文案（presence 跳变触发，非 agent:event）──
test.describe('notificationForBackgroundRunning', () => {
  test('无 cwd → 固定标题+低信息量 body，不含会话内容', () => {
    const n = notificationForBackgroundRunning({ instanceId: 'inst_1', sessionId: 's1' });
    assert.equal(n.title, '⏳ 任务仍在后台运行');
    assert.equal(n.body, '运行结束后会通知你');
    assert.deepEqual(n.data, { instanceId: 'inst_1', sessionId: 's1', cwd: undefined });
  });

  test('带 cwd → title 追加目录尾段（仅 basename，非完整路径），与 notificationForEvent 的 titleWithCwd 风格一致', () => {
    const n = notificationForBackgroundRunning({ instanceId: 'inst_1', sessionId: 's1', cwd: '/Users/x/code/proj' });
    assert.equal(n.title, '⏳ 任务仍在后台运行 · proj');
  });

  test('不带 instanceId → 无 data 字段（向后兼容 notificationForEvent 同款约定）', () => {
    const n = notificationForBackgroundRunning({});
    assert.equal(n.data, undefined);
  });

  test('缺省参数不抛', () => {
    const n = notificationForBackgroundRunning();
    assert.equal(n.title, '⏳ 任务仍在后台运行');
  });
});

// ── notificationForDeviceRequest：新设备请求接入（socket 握手触发，非 agent:event）──
// SEC-04 在这里比别处更硬：设备 ID / IP / User-Agent 恰恰是审批时要核对的三项，
// 而推送是明文通道（ntfy 还经第三方）。通知只负责「叫你回来看」，核对一律回 app 内做。
test.describe('notificationForDeviceRequest', () => {
  test('单台待审 → 固定标题，且 ID/IP/UA 一个都不进通知', () => {
    const n = notificationForDeviceRequest({ count: 1, deviceId: 'tok-abc123', ip: '192.168.1.5', userAgent: 'Mozilla/5.0 iPhone' });
    assert.equal(n.title, '🔐 新设备请求接入');
    assert.ok(n.body.length > 0, 'body 不应为空');
    const dumped = JSON.stringify(n);
    assert.ok(!/tok-abc123/.test(dumped), `通知不得含设备 ID，实际：${dumped}`);
    assert.ok(!/192\.168\.1\.5/.test(dumped), `通知不得含 IP，实际：${dumped}`);
    assert.ok(!/iPhone|Mozilla/.test(dumped), `通知不得含 User-Agent，实际：${dumped}`);
  });

  test('多台待审 → body 反映台数（仍不含任何设备标识）', () => {
    const n = notificationForDeviceRequest({ count: 3 });
    assert.match(n.body, /3/, 'body 应体现待审台数，便于判断是否遭遇 flood');
  });

  test('无 previewBody：预览开关不该让设备标识漏进明文通道', () => {
    const n = notificationForDeviceRequest({ count: 1, deviceId: 'tok-abc123' });
    assert.equal(n.previewBody, undefined);
  });

  test('缺省参数不抛，按 1 台处理', () => {
    const n = notificationForDeviceRequest();
    assert.equal(n.title, '🔐 新设备请求接入');
    assert.ok(n.body.length > 0);
  });
});

// ── permission_request / question：无条件推 ──────────────────────────────────

test('permission_request → 无条件推，body 含工具名但【不含命令/参数正文】（SEC-04 最小化）', () => {
  const n = notificationForEvent('permission_request', { name: 'Bash', input: { command: 'rm -rf /tmp/x' } }, { hasClients: true });
  assert.equal(n.title, '⚠️ Claude 请求许可');
  assert.match(n.body, /Bash/, 'body 保留工具名（辨识度，泄露面小）');
  assert.ok(!n.body.includes('rm'), 'body 不得含命令正文');
  assert.ok(!n.body.includes('command'), 'body 不得含 input JSON');
});

test('question → 无条件推，body 【不含问题正文】（最小化，正文回 app 内经鉴权取）', () => {
  const n = notificationForEvent('question', { text: '要删除生产库吗?' }, { hasClients: true });
  assert.ok(!n.body.includes('生产库'), 'body 不得含问题正文');
  assert.equal(n.body, 'Claude 需要你的回答');
});

// ── task_notification：后台任务（Workflow/后台 Agent/Bash）完成 ──────

test('task_notification 成功 → 「后台任务完成」，body 【不含 summary 正文】', () => {
  const n = notificationForEvent('task_notification', { status: 'completed', summary: '改了 auth.js 的鉴权分支' }, { hasClients: true });
  assert.equal(n.title, '✅ 后台任务完成');
  assert.ok(!n.body.includes('auth.js'), 'body 不得含 summary 正文');
});

test('task_notification 失败（status=failed/error）→ 「后台任务失败」', () => {
  assert.equal(notificationForEvent('task_notification', { status: 'failed' }, {}).title, '⚠️ 后台任务失败');
  assert.equal(notificationForEvent('task_notification', { status: 'error' }, {}).title, '⚠️ 后台任务失败');
});

// ── previewBody：⑧ 推送内容预览开关（客户端订阅按偏好选 body/previewBody，见 notify-channels.js pushNotify）──
// body 本身维持最小化不变（上面几条断言已锁死不含正文）；previewBody 是【新增】可选字段，只有用户
// 主动开启预览的设备才会收到它，ntfy 通道永不用它（第三方明文红线，见 notify-channels.js 头注）。

test('permission_request → previewBody 含工具名 + input 摘要', () => {
  const n = notificationForEvent('permission_request', { name: 'Bash', input: { command: 'rm -rf /tmp/x' } }, { hasClients: true });
  assert.match(n.previewBody, /Bash/);
  assert.match(n.previewBody, /rm -rf/);
});

test('question → previewBody 是问题正文', () => {
  const n = notificationForEvent('question', { text: '要删除生产库吗?' }, { hasClients: true });
  assert.equal(n.previewBody, '要删除生产库吗?');
});

test('task_notification → previewBody 是 summary', () => {
  const n = notificationForEvent('task_notification', { status: 'completed', summary: '改了 auth.js 的鉴权分支' }, { hasClients: true });
  assert.equal(n.previewBody, '改了 auth.js 的鉴权分支');
});

test('result → 无 previewBody 字段（该事件本身没有正文内容可预览，非"缺省为空"）', () => {
  const n = notificationForEvent('result', { durationMs: 1000 }, { hasClients: false });
  assert.equal('previewBody' in n, false);
});

test('previewBody 超 120 字截断并加省略号', () => {
  const n = notificationForEvent('question', { text: 'x'.repeat(200) }, { hasClients: true });
  assert.equal(n.previewBody.length, 121); // 120 + '…'
  assert.ok(n.previewBody.endsWith('…'));
});

test('question 缺 text → previewBody 空串（该事件类型支持预览，只是本次没内容——非 result 那种"不适用"）', () => {
  const n = notificationForEvent('question', {}, { hasClients: true });
  assert.equal(n.previewBody, '');
});

test('task_notification 缺 summary → previewBody 空串', () => {
  const n = notificationForEvent('task_notification', { status: 'completed' }, { hasClients: true });
  assert.equal(n.previewBody, '');
});

test('permission_request 缺 input → previewBody 只有工具名', () => {
  const n = notificationForEvent('permission_request', { name: 'Bash' }, { hasClients: true });
  assert.equal(n.previewBody, 'Bash');
});

// ── cwdBase（docs/design.md/OQ-08 已决：默认显示，不设隐藏配置项）——多工作区场景分辨通知来自哪个项目 ──

test('permission_request 带 cwd → title 追加目录尾段（仅 basename，非完整路径）', () => {
  const n = notificationForEvent('permission_request', { name: 'Bash' }, { hasClients: true, cwd: '/Users/me/secret-proj' });
  assert.equal(n.title, '⚠️ Claude 请求许可 · secret-proj');
  assert.ok(!n.title.includes('/Users/me'), 'title 不得含完整路径前缀（SEC-04 同精神）');
  assert.ok(!n.body.includes('secret-proj'), 'cwdBase 只进 title，不重复进 body');
});

test('question 带 cwd → title 追加目录尾段', () => {
  const n = notificationForEvent('question', { text: 'x' }, { hasClients: true, cwd: '/repo/nested/dir' });
  assert.equal(n.title, '❓ Claude 有问题 · dir');
});

test('task_notification 带 cwd（成功/失败）→ title 均追加目录尾段', () => {
  assert.equal(notificationForEvent('task_notification', { status: 'completed' }, { cwd: '/a/b/proj' }).title, '✅ 后台任务完成 · proj');
  assert.equal(notificationForEvent('task_notification', { status: 'failed' }, { cwd: '/a/b/proj' }).title, '⚠️ 后台任务失败 · proj');
});

test('result 无客户端 + 带 cwd → title 追加目录尾段', () => {
  const n = notificationForEvent('result', { durationMs: 1000 }, { hasClients: false, cwd: '/a/b/proj' });
  assert.equal(n.title, '✅ 任务完成 · proj');
});

test('无 cwd（未绑定实例）→ title 不追加，向后兼容不破坏既有精确断言', () => {
  const n = notificationForEvent('permission_request', { name: 'Bash' }, { hasClients: true });
  assert.equal(n.title, '⚠️ Claude 请求许可');
});

test('cwd 带尾斜杠 → basename 正常取尾段（不留空段）', () => {
  const n = notificationForEvent('question', {}, { cwd: '/a/b/proj/' });
  assert.equal(n.title, '❓ Claude 有问题 · proj');
});

// ── sessionTitle：横幅要能看出是哪个会话（项目名不够，同一仓库常有多条会话）────────
// 进 title 不进 body：body 仍最小化（SEC-04）；会话标题是抽屉里已经展示的身份，不是命令/问题正文。

test('result 带 cwd + sessionTitle → title 为 事件 · 项目 · 会话，body 仍只含耗时', () => {
  const n = notificationForEvent('result', { durationMs: 1000 }, {
    hasClients: false, cwd: '/a/b/claude-chat-mobile', sessionTitle: '独立审查 count_tokens 缓存',
  });
  assert.equal(n.title, '✅ 任务完成 · claude-chat-mobile · 独立审查 count_tokens 缓存');
  assert.equal(n.body, '用时 1.0s');
  assert.ok(!n.body.includes('独立审查'), '会话标题只进 title，不重复进最小化 body');
});

test('permission_request / question / task_notification 同样把会话标题追加到 title', () => {
  assert.equal(
    notificationForEvent('permission_request', { name: 'Bash' }, { cwd: '/p/proj', sessionTitle: '修登录' }).title,
    '⚠️ Claude 请求许可 · proj · 修登录',
  );
  assert.equal(
    notificationForEvent('question', { text: '要删库吗' }, { cwd: '/p/proj', sessionTitle: '修登录' }).title,
    '❓ Claude 有问题 · proj · 修登录',
  );
  assert.ok(!notificationForEvent('question', { text: '要删库吗' }, { cwd: '/p/proj', sessionTitle: '修登录' }).body.includes('要删库'), '问题正文仍不进默认 body');
  assert.equal(
    notificationForEvent('task_notification', { status: 'completed' }, { cwd: '/p/proj', sessionTitle: '修登录' }).title,
    '✅ 后台任务完成 · proj · 修登录',
  );
});

test('sessionTitle 为占位「新会话」/「(无标题)」/空白 → 不加，避免横幅出现无信息尾巴', () => {
  assert.equal(
    notificationForEvent('result', { durationMs: 1000 }, { hasClients: false, cwd: '/a/proj', sessionTitle: '新会话' }).title,
    '✅ 任务完成 · proj',
  );
  assert.equal(
    notificationForEvent('result', { durationMs: 1000 }, { hasClients: false, cwd: '/a/proj', sessionTitle: '(无标题)' }).title,
    '✅ 任务完成 · proj',
  );
  assert.equal(
    notificationForEvent('result', { durationMs: 1000 }, { hasClients: false, cwd: '/a/proj', sessionTitle: '   ' }).title,
    '✅ 任务完成 · proj',
  );
});

test('无 cwd 但有 sessionTitle → title 仍带会话（单工作区也能分辨是哪条）', () => {
  const n = notificationForEvent('result', { durationMs: 1000 }, { hasClients: false, sessionTitle: '修登录' });
  assert.equal(n.title, '✅ 任务完成 · 修登录');
});

test('sanitizeNotifySessionTitle: 换行压成单行、超长截断、占位丢弃', () => {
  assert.equal(sanitizeNotifySessionTitle('hello\nworld'), 'hello world');
  assert.equal(sanitizeNotifySessionTitle('新会话'), '');
  assert.equal(sanitizeNotifySessionTitle('(无标题)'), '');
  assert.equal(sanitizeNotifySessionTitle(''), '');
  assert.equal(sanitizeNotifySessionTitle(null), '');
  const long = sanitizeNotifySessionTitle('x'.repeat(80));
  assert.equal(long.length, 41);
  assert.ok(long.endsWith('…'));
});

test('formatNotifyIdentity: 事件 · 项目 · 会话，缺项则跳过', () => {
  assert.equal(formatNotifyIdentity('✅ 任务完成', { cwd: '/a/proj', sessionTitle: '修登录' }), '✅ 任务完成 · proj · 修登录');
  assert.equal(formatNotifyIdentity('✅ 任务完成', { cwd: '/a/proj' }), '✅ 任务完成 · proj');
  assert.equal(formatNotifyIdentity('✅ 任务完成', { sessionTitle: '修登录' }), '✅ 任务完成 · 修登录');
  assert.equal(formatNotifyIdentity('✅ 任务完成', {}), '✅ 任务完成');
});

test('notifyHasClientsAtSend: result/system 发出前用现场值；其余保持节流那一刻的快照', () => {
  assert.equal(notifyHasClientsAtSend('result', false, true), true, 'peek 期间人回到前台 → 现场 true，result 不再推');
  assert.equal(notifyHasClientsAtSend('system', false, true), true);
  assert.equal(notifyHasClientsAtSend('result', false, false), false);
  assert.equal(notifyHasClientsAtSend('permission_request', false, true), false, '无条件推的类型不改快照');
  assert.equal(notifyHasClientsAtSend('task_notification', false, true), false);
});

test('app.js 标题 peek 的 catch 也必须走 notifyHasClientsAtSend（then 已有；catch 漏了会在人回前台后仍推）', () => {
  const src = readFileSync(new URL('../../app/src/server/app.js', import.meta.url), 'utf8');
  const start = src.indexOf('sessionTitleForNotify(notifyOpts.cwd, notifyOpts.sessionId)');
  assert.ok(start >= 0, '找不到 onEvent 里的 sessionTitleForNotify');
  const chunk = src.slice(start, start + 1600);
  const catchIdx = chunk.indexOf('.catch(');
  assert.ok(catchIdx >= 0, '找不到标题 peek 的 catch');
  assert.match(chunk.slice(catchIdx), /notifyHasClientsAtSend/,
    'catch 把节流时的 notifyOpts 原样发出去，peek 失败且人已回会话仍会推 result');
});

test('notificationForBackgroundRunning 带 sessionTitle → title 追加会话', () => {
  const n = notificationForBackgroundRunning({ instanceId: 'i', sessionId: 's', cwd: '/a/proj', sessionTitle: '修登录' });
  assert.equal(n.title, '⏳ 任务仍在后台运行 · proj · 修登录');
});

test('notificationForCliHook 带 sessionTitle → title 追加会话', () => {
  const n = notificationForCliHook('Stop', { cwd: '/a/demo', sessionId: 's1', instanceId: 'i1', sessionTitle: '修登录' });
  assert.match(n.title, /demo/);
  assert.match(n.title, /修登录/);
});

// ── 其余 STATE_BOUNDARY 事件不推 ─────────────────────────────────────────────

test('init / tool_use / error / request_resolved → 一律不推', () => {
  for (const t of ['init', 'tool_use', 'error', 'request_resolved']) {
    assert.equal(notificationForEvent(t, {}, { hasClients: false }), null, `${t} 不该推`);
  }
});

test('缺省 payload/opts 不抛', () => {
  assert.equal(notificationForEvent('init'), null);
  assert.doesNotThrow(() => notificationForEvent('task_notification'));
});

// ── ②2c：notificationForEvent 带 instanceId 时附 data（供 push/ntfy 深链回会话）───────
test('带 instanceId → 返回附 data{instanceId,sessionId,cwd}', () => {
  const n = notificationForEvent('permission_request', { name: 'Bash' },
    { hasClients: true, instanceId: 'inst_2', sessionId: 'sess_9', cwd: '/repo' });
  assert.deepEqual(n.data, { instanceId: 'inst_2', sessionId: 'sess_9', cwd: '/repo' });
});

test('不带 instanceId → 无 data 字段（向后兼容，现有 deepEqual 不破）', () => {
  const n = notificationForEvent('question', { text: 'x' }, { hasClients: true });
  assert.equal('data' in n, false);
});

test('result 无客户端 + instanceId → 附 data', () => {
  const n = notificationForEvent('result', { durationMs: 1000 }, { hasClients: false, instanceId: 'inst_1' });
  assert.equal(n.data.instanceId, 'inst_1');
});

// ── ②2b：ntfyMetaFor（渠道元数据：优先级 / 标签 / 深链 click）──────────────────────
test('ntfyMetaFor: permission_request → 高优先级 5 + warning 标签', () => {
  const m = ntfyMetaFor('permission_request', {}, '');
  assert.equal(m.priority, 5);
  assert.deepEqual(m.tags, ['warning']);
});

test('ntfyMetaFor: result → 默认优先级 3', () => {
  assert.equal(ntfyMetaFor('result', {}, '').priority, 3);
});

// background 类别：presence 跳变触发的"仍在运行"提示。pending:false（一次性），只受最小间隔约束——
// 与 finished 同款，防止重连/新 socket 再次跳变时 ntfy 堆多条（web-push 有 tag 覆盖，ntfy 没有）。
test('throttleNotify: background 类别受最小间隔约束（跨 socket 重连去重）', () => {
  const r1 = throttleNotify('s1', 'background', 1000, new Map(), 60000);
  assert.equal(r1.throttled, false);
  const r2 = throttleNotify('s1', 'background', 2000, r1.next, 60000); // 1s < 60s
  assert.equal(r2.throttled, true);
  const r3 = throttleNotify('s1', 'background', 62000, r1.next, 60000); // 61s > 60s
  assert.equal(r3.throttled, false);
});

test('ntfyMetaFor: background_running（presence 跳变触发的后台运行中提示）→ 默认优先级 3 + 专属标签', () => {
  const m = ntfyMetaFor('background_running', {}, '');
  assert.equal(m.priority, 3, '低优先级：不需要用户即时响应');
  assert.deepEqual(m.tags, ['hourglass_flowing_sand']);
});

// 设备审批与 permission_request 同级：用户不处理，那台新设备就一直用不了——属于"需即时响应"。
test('ntfyMetaFor: device_request → 高优先级 5 + 专属标签', () => {
  const m = ntfyMetaFor('device_request', {}, '');
  assert.equal(m.priority, 5);
  assert.deepEqual(m.tags, ['closed_lock_with_key']);
});

// 设备审批不属于任何会话，深链无处可去——即便配了 publicUrl 也不该编一个点不开的链接。
test('ntfyMetaFor: device_request 无 click 深链（无 instanceId）', () => {
  assert.equal(ntfyMetaFor('device_request', {}, 'https://ccm.example.com').click, undefined);
});

// device 类别刻意【不】走 approval 的"未决"语义：CLI 审批路径（trusted-devices.json 文件监听，
// 在 device-gate.js 里）够不到 app.js 持有的节流状态，无法清 pending——一旦用 pending 语义，
// 从 CLI 批准后这条状态永远解不开，之后真有新设备也不再推。改用纯最小间隔，代价是同一批待审
// 设备每隔一个窗口会再提醒一次，而那反倒是想要的（用户可能错过第一条）。
test('throttleNotify: device 类别只受最小间隔约束，不留未决标记', () => {
  const r1 = throttleNotify('__devices__', 'device', 1000, new Map(), 300000);
  assert.equal(r1.throttled, false);
  const r2 = throttleNotify('__devices__', 'device', 60000, r1.next, 300000); // 59s < 5min
  assert.equal(r2.throttled, true, '窗口内重复入列不重复推');
  const r3 = throttleNotify('__devices__', 'device', 400000, r1.next, 300000); // 6.6min > 5min
  assert.equal(r3.throttled, false, '过了窗口应能再提醒一次（无需任何 clearNotifyPending）');
});

test('ntfyMetaFor: click 深链含 instance/session，但【不含完整 cwd】（ntfy 明文第三方，SEC-04）', () => {
  const m = ntfyMetaFor('permission_request', { instanceId: 'i1', sessionId: 's1', cwd: '/Users/me/secret-proj' }, 'https://x.example.com');
  assert.match(m.click, /^https:\/\/x\.example\.com\/#/);
  assert.match(m.click, /instance=i1/);
  assert.match(m.click, /session=s1/);
  assert.ok(!/cwd=/.test(m.click), 'ntfy click 深链不得含完整 cwd 路径');
  assert.ok(!m.click.includes('secret'), '不得经第三方明文泄露工作目录路径');
});

test('ntfyMetaFor: 无 publicUrl 或无 instanceId → 无 click', () => {
  assert.equal(ntfyMetaFor('result', { instanceId: 'i1' }, '').click, undefined);
  assert.equal(ntfyMetaFor('result', {}, 'https://x.example.com').click, undefined);
});

test('ntfyMetaFor: publicUrl 尾斜杠不产生双斜杠', () => {
  assert.match(ntfyMetaFor('question', { instanceId: 'i1' }, 'https://x.example.com/').click, /^https:\/\/x\.example\.com\/#/);
});

// ── ②2b：ntfyRequestInit（构造 fetch 参数，纯函数不发网络；中文走 JSON body 避开 header 编码）──
test('ntfyRequestInit: JSON body 含 topic/title/message，POST', () => {
  const { url, init } = ntfyRequestInit({ url: 'https://ntfy.local', topic: 'ccm' }, '标题', '正文', {});
  assert.equal(url, 'https://ntfy.local');
  assert.equal(init.method, 'POST');
  const b = JSON.parse(init.body);
  assert.equal(b.topic, 'ccm');
  assert.equal(b.title, '标题');
  assert.equal(b.message, '正文');
});

test('ntfyRequestInit: token → Authorization Bearer；无 token → 无该头', () => {
  const withTok = ntfyRequestInit({ url: 'u', topic: 't', token: 'secret' }, 'a', 'b', {});
  assert.equal(withTok.init.headers.Authorization, 'Bearer secret');
  const noTok = ntfyRequestInit({ url: 'u', topic: 't' }, 'a', 'b', {});
  assert.equal('Authorization' in noTok.init.headers, false);
});

test('ntfyRequestInit: meta 的 tags/priority/click 进 body', () => {
  const { init } = ntfyRequestInit({ url: 'u', topic: 't' }, 'a', 'b',
    { tags: ['warning'], priority: 5, click: 'https://x/#instance=i1' });
  const b = JSON.parse(init.body);
  assert.deepEqual(b.tags, ['warning']);
  assert.equal(b.priority, 5);
  assert.equal(b.click, 'https://x/#instance=i1');
});

// ── throttleNotify / clearNotifyPending：per-会话推送节流（docs/design.md TriggerPolicy，承接 FR-14 另一半）──
// 两层规则：①同一会话同一类别已有未决通知（未被 request_resolved 清除）不重复推；
// ②即便已清除，同类事件最小间隔内仍抑制。纯函数、状态外置（EP-2）。
test.describe('throttleNotify', () => {
  test('首次推送：不节流，记为该类别未决', () => {
    const r = throttleNotify('s1', 'approval', 1000, new Map(), 60000);
    assert.equal(r.throttled, false);
  });

  test('同会话同类别已有未决通知（如上一个 approval 还没被处理）→ 第二次节流', () => {
    const r1 = throttleNotify('s1', 'approval', 1000, new Map(), 60000);
    const r2 = throttleNotify('s1', 'approval', 2000, r1.next, 60000); // 未 clearNotifyPending，仍未决
    assert.equal(r2.throttled, true, '未决时第二次同类别通知应被节流');
  });

  test('未决被清除（request_resolved）后、仍在最小间隔内 → 仍节流（间隔层兜底）', () => {
    const r1 = throttleNotify('s1', 'approval', 1000, new Map(), 60000);
    const cleared = clearNotifyPending('s1', 'approval', r1.next);
    const r2 = throttleNotify('s1', 'approval', 30000, cleared, 60000); // 30s < 60s 最小间隔
    assert.equal(r2.throttled, true, '已清未决但未过最小间隔仍应节流');
  });

  test('未决被清除且已过最小间隔 → 放行', () => {
    const r1 = throttleNotify('s1', 'approval', 1000, new Map(), 60000);
    const cleared = clearNotifyPending('s1', 'approval', r1.next);
    const r2 = throttleNotify('s1', 'approval', 62000, cleared, 60000); // 61s > 60s
    assert.equal(r2.throttled, false);
  });

  test('不同会话互不影响', () => {
    const r1 = throttleNotify('s1', 'approval', 1000, new Map(), 60000);
    const r2 = throttleNotify('s2', 'approval', 1001, r1.next, 60000);
    assert.equal(r2.throttled, false, '不同会话的节流态应独立');
  });

  test('不同类别（approval vs finished）互不影响', () => {
    const r1 = throttleNotify('s1', 'approval', 1000, new Map(), 60000);
    const r2 = throttleNotify('s1', 'finished', 1001, r1.next, 60000);
    assert.equal(r2.throttled, false, '同会话不同类别应独立节流');
  });

  test('finished 类别（result/task_notification）无"未决"语义，只受最小间隔节流', () => {
    const r1 = throttleNotify('s1', 'finished', 1000, new Map(), 60000);
    const r2 = throttleNotify('s1', 'finished', 2000, r1.next, 60000); // 未调用 clearNotifyPending
    assert.equal(r2.throttled, true, 'finished 类别短时间内连续两次也应节流（无需 clear 才能受最小间隔约束）');
    const r3 = throttleNotify('s1', 'finished', 62000, r1.next, 60000);
    assert.equal(r3.throttled, false, '过了最小间隔应放行');
  });

  test('未知/空 sessionId → 不节流（保守，不误伤）', () => {
    assert.equal(throttleNotify(null, 'approval', 1000, new Map()).throttled, false);
    assert.equal(throttleNotify('', 'approval', 1000, new Map()).throttled, false);
  });

  test('NOTIFY_CATEGORY 映射：permission_request→approval, question→input, result/task_notification→finished', () => {
    assert.equal(NOTIFY_CATEGORY.permission_request, 'approval');
    assert.equal(NOTIFY_CATEGORY.question, 'input');
    assert.equal(NOTIFY_CATEGORY.result, 'finished');
    assert.equal(NOTIFY_CATEGORY.task_notification, 'finished');
  });
});

test.describe('clearNotifyPending', () => {
  test('清除不存在的会话/类别 → 原样返回，不抛错', () => {
    const state = new Map();
    const next = clearNotifyPending('nope', 'approval', state);
    assert.equal(next, state);
  });

  test('清除后，notifiedAt 不受影响（只清 pending，最小间隔仍生效）', () => {
    const r1 = throttleNotify('s1', 'approval', 1000, new Map(), 60000);
    const cleared = clearNotifyPending('s1', 'approval', r1.next);
    const r2 = throttleNotify('s1', 'approval', 1500, cleared, 60000); // 500ms < 60s
    assert.equal(r2.throttled, true, 'clear 只清未决标记，不重置最小间隔计时');
  });
});


test('ntfyMetaFor: CLI Notification hook → priority 5 + warning（J3，非 result checkmark）', () => {
  const m = ntfyMetaFor('cli_hook_notification', {}, 'https://ex.example');
  assert.equal(m.priority, 5);
  assert.ok(m.tags.includes('warning'));
  assert.equal(m.tags.includes('white_check_mark'), false);
});

test('ntfyMetaFor: CLI Stop hook → priority 3 + checkmark', () => {
  const m = ntfyMetaFor('cli_hook_stop', {});
  assert.equal(m.priority, 3);
  assert.ok(m.tags.includes('white_check_mark'));
});

// ── 网关静默告警（system + kind:'notice' + notice:'gateway_stall'）→ 锁屏可见 ──────────────
// 背景（2026-08-18 排查）：「模型已 N 秒无响应」此前只落消息流，锁屏/离开时全程不可见，用户只见
// spinner 干转不知何故。识别锚是结构化 notice 字段而非文案（文案会随措辞/i18n 变，同 D1 教训）。
// 它不走 error 信封：前端 error(p) 会 finalizeStreams + failPendingToolCards + setBusy(false)
// 把在途轮当终点误杀（agent.js emitNotice 注释明文禁忌）——emit 形态由 agent-lifecycle R2c 锁住。
test.describe('gateway_stall 静默告警推送', () => {
  const stallPayload = {
    message: '模型已 116 秒无响应（本轮已进行 206 秒，继续等待；10 分钟仍零消息将自动中断）——可点「停止」后重发，或换模型再试',
    kind: 'notice', level: 'warning', notice: 'gateway_stall', seconds: 116, turnSeconds: 206,
  };

  test('无前台可见客户端 → 推送：title 带 cwd 尾段，body 含静默秒数与自动中断预告，不给 previewBody', () => {
    const n = notificationForEvent('system', stallPayload, { hasClients: false, instanceId: 'i1', sessionId: 's1', cwd: '/Users/you/proj' });
    assert.equal(n.title, '⏳ 模型长时间无响应 · proj');
    assert.match(n.body, /116 秒/);
    assert.match(n.body, /自动中断/);
    assert.deepEqual(n.data, { instanceId: 'i1', sessionId: 's1', cwd: '/Users/you/proj' });
    assert.equal('previewBody' in n, false, '告警无会话正文可预览，预览开关不该有旁路');
  });

  test('前台正看着本会话 → 不推（消息流里的告警条已可见）', () => {
    assert.equal(notificationForEvent('system', stallPayload, { hasClients: true }), null);
  });

  test('seconds 缺失/畸形 → body 退化为通用文案，不显 NaN/undefined', () => {
    const n = notificationForEvent('system', { ...stallPayload, seconds: undefined }, { hasClients: false });
    assert.ok(n, '秒数缺失不该整条不推');
    assert.doesNotMatch(n.body, /NaN|undefined/);
    assert.match(n.body, /自动中断/);
  });

  test('其余 system 事件（普通 notice / 已中断回执）→ 不推', () => {
    assert.equal(notificationForEvent('system', { message: 'x', kind: 'notice', level: 'info' }, { hasClients: false }), null);
    assert.equal(notificationForEvent('system', { message: '已中断', kind: 'interrupted' }, { hasClients: false }), null);
  });

  test('stall 类别：interval-only 节流（不置 pending），窗口远宽于告警源的 90–120s 节拍', () => {
    assert.equal(NOTIFY_CATEGORY.system, 'stall');
    assert.ok(STALL_NOTIFY_INTERVAL_MS >= 300_000, '2026-08-17 实测坏天气下告警每 90–120s 一条，套 60s 通用窗≈每条都推');
    const t0 = 1_000_000;
    const r1 = throttleNotify('sid', 'stall', t0, new Map(), STALL_NOTIFY_INTERVAL_MS);
    assert.equal(r1.throttled, false);
    assert.equal(r1.next.get('sid').stall.pending, false, 'stall 无「被处理」动作，走未决语义会永远解不开（同 DEVICE 教训）');
    const r2 = throttleNotify('sid', 'stall', t0 + STALL_NOTIFY_INTERVAL_MS - 1, r1.next, STALL_NOTIFY_INTERVAL_MS);
    assert.equal(r2.throttled, true, '窗口内重复告警不再推');
    const r3 = throttleNotify('sid', 'stall', t0 + STALL_NOTIFY_INTERVAL_MS + 1, r1.next, STALL_NOTIFY_INTERVAL_MS);
    assert.equal(r3.throttled, false, '跨窗口再提醒一次是好事——还卡着这个事实本身有信息量');
  });

  test('ntfy 元数据：非紧急（priority 3）+ hourglass 标签', () => {
    const meta = ntfyMetaFor('system', {}, '');
    assert.equal(meta.priority, 3, '告警无需即时响应（10 分钟自动中断兜底在），不得抬 urgent');
    assert.deepEqual(meta.tags, ['hourglass_flowing_sand']);
  });
});

// ── describeDeliveryError：投递失败原因 → 一行短语（2026-09-02）──────────────────────
// 起因：push/ntfy 失败此前只 console.error，statusCode 与 message 进 stdout 就没了。面板拿到的
// 只有 {channel, at, count}，于是「🔔 推送失败」这条告警在 UI 上永远无从下钻——分不清是网络不通
// 还是 VAPID 配错。这个函数把原因压成一行、且**保证不带 endpoint URL**（那是推送凭证）。
test.describe('describeDeliveryError', () => {
  test('有 HTTP 状态码 → 优先用它（最能定位问题的一维）', () => {
    assert.equal(describeDeliveryError({ statusCode: 502, message: 'Bad Gateway' }), 'HTTP 502');
    assert.equal(describeDeliveryError({ statusCode: 401 }), 'HTTP 401');
  });
  test('无状态码但有 Node 错误码 → 用错误码（ETIMEDOUT 这类短且无敏感信息）', () => {
    assert.equal(describeDeliveryError({ code: 'ETIMEDOUT' }), 'ETIMEDOUT');
    assert.equal(describeDeliveryError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND fcm.googleapis.com' }), 'ENOTFOUND');
  });
  test('message 内嵌 URL → 整条丢弃，绝不把订阅 endpoint 泄进 UI', () => {
    const e = { message: 'request to https://fcm.googleapis.com/fcm/send/cKq9_SECRET_TOKEN failed, reason: connect ETIMEDOUT' };
    const r = describeDeliveryError(e);
    assert.equal(r, 'network error');
    assert.ok(!r.includes('SECRET_TOKEN'));
    assert.ok(!r.includes('fcm.googleapis.com'));
  });
  test('纯文本 message → 原样（超 60 字截断）', () => {
    assert.equal(describeDeliveryError({ message: 'socket hang up' }), 'socket hang up');
    const long = 'x'.repeat(80);
    assert.equal(describeDeliveryError({ message: long }), `${'x'.repeat(60)}…`);
  });
  test('空/畸形入参 → unknown（绝不抛，投递失败路径上再抛一次就吞掉原始错误了）', () => {
    for (const v of [null, undefined, {}, { message: '   ' }]) {
      assert.equal(describeDeliveryError(v), 'unknown', String(v));
    }
  });
});
