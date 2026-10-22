// tests/unit/notify-channels.test.mjs —— 推送订阅的存储与双通道分发
// 订阅文件是长期演进的用户数据，读入侧必须兼容旧格式且能滤掉坏条目——读不动就等于所有推送静默丢失。
// 覆盖：旧版单对象格式向后兼容读成数组 · 无 endpoint 的坏条目滤除 · 按 endpoint 去重覆盖落盘
//       · 通道开关与失败上报（OPS-3：notify_failed 必须覆盖 push 与 ntfy 两条，只计 push 会让
//         纯 ntfy 用户的失败永不翻状态）· pushNotify 按订阅 prefs 选择收件人
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNotifyChannels } from '../../app/src/ops/notify-channels.js';

function tempDataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-notify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ENV_OFF = {}; // 未配置 VAPID/ntfy → 两通道均优雅缺席
const ENV_PUSH_ON = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:a@b.com' };

// 假 webpushImpl：只记参数，不真发网络请求（同 fetchImpl 注入手法）。
function fakeWebpush() {
  const sent = [];
  return {
    sent,
    setVapidDetails: () => {},
    sendNotification: async (sub, payloadJson) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payloadJson) }); },
  };
}

test.describe('createNotifyChannels · 订阅存储', () => {
  test('旧版单对象订阅文件向后兼容读入为数组', t => {
    const dir = tempDataDir(t);
    writeFileSync(join(dir, 'push-subscription.json'), JSON.stringify({ endpoint: 'https://e/1', keys: {} }));
    const n = createNotifyChannels({ dataDir: dir, env: ENV_OFF });
    assert.equal(n.subscriptionCount(), 1);
  });

  test('数组格式读入并滤掉无 endpoint 的坏条目', t => {
    const dir = tempDataDir(t);
    writeFileSync(join(dir, 'push-subscription.json'), JSON.stringify([
      { endpoint: 'https://e/1' }, { broken: true }, { endpoint: 'https://e/2' },
    ]));
    const n = createNotifyChannels({ dataDir: dir, env: ENV_OFF });
    assert.equal(n.subscriptionCount(), 2);
  });

  test('savePushSubscription 按 endpoint 去重覆盖并落盘', t => {
    const dir = tempDataDir(t);
    const n = createNotifyChannels({ dataDir: dir, env: ENV_OFF });
    n.savePushSubscription({ endpoint: 'https://e/1', keys: { a: 1 } });
    n.savePushSubscription({ endpoint: 'https://e/1', keys: { a: 2 } }); // 同设备重订 → 覆盖非追加
    n.savePushSubscription({ endpoint: 'https://e/2', keys: {} });
    assert.equal(n.subscriptionCount(), 2);
    const onDisk = JSON.parse(readFileSync(join(dir, 'push-subscription.json'), 'utf8'));
    assert.equal(onDisk.find(s => s.endpoint === 'https://e/1').keys.a, 2);
  });

  test('无 endpoint 的订阅被拒收', t => {
    const dir = tempDataDir(t);
    const n = createNotifyChannels({ dataDir: dir, env: ENV_OFF });
    n.savePushSubscription({ keys: {} });
    n.savePushSubscription(null);
    assert.equal(n.subscriptionCount(), 0);
  });

  test('removePushSubscription 只摘点名那条，别的设备照留并落盘', t => {
    const dir = tempDataDir(t);
    const n = createNotifyChannels({ dataDir: dir, env: ENV_OFF });
    n.savePushSubscription({ endpoint: 'https://e/phone', keys: {} });
    n.savePushSubscription({ endpoint: 'https://e/ipad', keys: {} });
    assert.equal(n.removePushSubscription('https://e/phone'), true);
    assert.equal(n.subscriptionCount(), 1, '手机退订不该顺手掐掉 iPad 的订阅');
    const onDisk = JSON.parse(readFileSync(join(dir, 'push-subscription.json'), 'utf8'));
    assert.deepEqual(onDisk.map(s => s.endpoint), ['https://e/ipad'], '删除必须落盘，重启后不能复活');
  });

  test('退订是幂等的：重复退 / 退一条不存在的，都只是 false，不误伤别人', t => {
    const dir = tempDataDir(t);
    const n = createNotifyChannels({ dataDir: dir, env: ENV_OFF });
    n.savePushSubscription({ endpoint: 'https://e/ipad', keys: {} });
    assert.equal(n.removePushSubscription('https://e/phone'), false);
    assert.equal(n.removePushSubscription(''), false);
    assert.equal(n.subscriptionCount(), 1);
  });
});

test.describe('createNotifyChannels · 通道开关与失败上报', () => {
  test('未配置 → pushEnabled/ntfyEnabled=false，通知调用为无害 no-op', async t => {
    const n = createNotifyChannels({ dataDir: tempDataDir(t), env: ENV_OFF });
    assert.equal(n.pushEnabled, false);
    assert.equal(n.ntfyEnabled, false);
    await n.pushNotify('t', 'b');
    await n.ntfyNotify('t', 'b');
  });

  test('publicUrl：PUBLIC_URL 优先，回退 CF_ACCESS_HOSTNAME 拼 https，均无则空串', t => {
    const dir = tempDataDir(t);
    assert.equal(createNotifyChannels({ dataDir: dir, env: { PUBLIC_URL: 'https://x.example' } }).publicUrl, 'https://x.example');
    assert.equal(createNotifyChannels({ dataDir: dir, env: { CF_ACCESS_HOSTNAME: 'y.example' } }).publicUrl, 'https://y.example');
    assert.equal(createNotifyChannels({ dataDir: dir, env: {} }).publicUrl, '');
  });

  test('ntfy HTTP 非 2xx → 计失败并触发 onDeliveryFailure（BE-015 对称性）', async t => {
    let failures = 0;
    const n = createNotifyChannels({
      dataDir: tempDataDir(t),
      env: { NTFY_URL: 'https://ntfy.example', NTFY_TOPIC: 'top' },
      fetchImpl: async () => ({ ok: false, status: 401 }),
      onDeliveryFailure: () => { failures++; },
    });
    await n.ntfyNotify('title', 'body');
    assert.equal(failures, 1);
  });

  test('ntfy fetch 抛异常 → 同样触发 onDeliveryFailure、不向上抛', async t => {
    let failures = 0;
    const n = createNotifyChannels({
      dataDir: tempDataDir(t),
      env: { NTFY_URL: 'https://ntfy.example', NTFY_TOPIC: 'top' },
      fetchImpl: async () => { throw new Error('boom'); },
      onDeliveryFailure: () => { failures++; },
    });
    await n.ntfyNotify('title', 'body');
    assert.equal(failures, 1);
  });

  // 验收 O110：ntfy 失败的日志只记 e.message——DNS 失败、拒连、断连在日志里都是同一句「fetch failed」，原因码只进了
  // 告警面板。日志要带上与告警同一个原因码，排查时从日志就看得出是哪一类。
  test('ntfy fetch 抛异常 → 日志带上原因码（底层 cause.code），不只一句 fetch failed', async t => {
    const lines = [];
    t.mock.method(console, 'error', (...args) => { lines.push(args.join(' ')); });
    const n = createNotifyChannels({
      dataDir: tempDataDir(t),
      env: { NTFY_URL: 'https://ntfy.example', NTFY_TOPIC: 'top' },
      fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); },
    });
    await n.ntfyNotify('title', 'body');
    const ntfyLines = lines.filter(l => l.includes('[ntfy]'));
    assert.equal(ntfyLines.length, 1);
    assert.match(ntfyLines[0], /ENOTFOUND/);
  });

  // 2026-08-03 review：ntfy 请求此前无显式超时，靠 undici 默认（headers 300s）兜底——挂死的
  // ntfy 网关会把每次通知的 pending promise 吊住数分钟。对齐 cf-access.js 的显式超时纪律。
  test('ntfy 请求带显式超时 signal（挂死网关不再靠 undici 默认 300s 兜底）', async t => {
    let seenSignal = null;
    const n = createNotifyChannels({
      dataDir: tempDataDir(t),
      env: { NTFY_URL: 'https://ntfy.example', NTFY_TOPIC: 'top' },
      fetchImpl: async (_url, init) => { seenSignal = init?.signal; return { ok: true, status: 200 }; },
    });
    await n.ntfyNotify('title', 'body');
    assert.ok(seenSignal instanceof AbortSignal, 'fetch init 必须带 AbortSignal 超时信号');
  });

  // 验收 AC-16-06 / O1：「发一条测试推送」只看 Web Push 的计数，ntfy 明明投递成功，界面只说「还没订阅」。
  // 测试推送要能如实回报 ntfy 这条通道，ntfyNotify 就得把投递结果交回来（其余调用点照旧不 await、不看）。
  test('ntfyNotify 交回投递结果：没配 disabled、2xx sent、非 2xx 与抛错都是 failed', async t => {
    const dir = tempDataDir(t);
    const env = { NTFY_URL: 'https://ntfy.example', NTFY_TOPIC: 'top' };
    assert.equal(await createNotifyChannels({ dataDir: dir, env: ENV_OFF }).ntfyNotify('t', 'b'), 'disabled');
    assert.equal(await createNotifyChannels({ dataDir: dir, env, fetchImpl: async () => ({ ok: true, status: 200 }) }).ntfyNotify('t', 'b'), 'sent');
    assert.equal(await createNotifyChannels({ dataDir: dir, env, fetchImpl: async () => ({ ok: false, status: 404 }) }).ntfyNotify('t', 'b'), 'failed');
    assert.equal(await createNotifyChannels({ dataDir: dir, env, fetchImpl: async () => { throw new Error('boom'); } }).ntfyNotify('t', 'b'), 'failed');
  });

  test('ntfy 2xx → 不触发 onDeliveryFailure', async t => {
    let failures = 0;
    const n = createNotifyChannels({
      dataDir: tempDataDir(t),
      env: { NTFY_URL: 'https://ntfy.example', NTFY_TOPIC: 'top' },
      fetchImpl: async () => ({ ok: true, status: 200 }),
      onDeliveryFailure: () => { failures++; },
    });
    await n.ntfyNotify('title', 'body');
    assert.equal(failures, 0);
  });
});

// ⑧ 推送内容预览：pushNotify 按每条订阅自己的 prefs.preview 独立选 body/previewBody——
// 同一次 notify 调用，一台订阅了预览、另一台没订阅，两台应收到不同 payload。
test.describe('createNotifyChannels · pushNotify 按订阅 prefs 选 body/previewBody', () => {
  test('无 previewBody 参数（如 result 事件）→ 所有订阅一律收 body，不管 prefs', async t => {
    const webpush = fakeWebpush();
    const n = createNotifyChannels({ dataDir: tempDataDir(t), env: ENV_PUSH_ON, webpushImpl: webpush });
    n.savePushSubscription({ endpoint: 'https://e/preview-on', keys: { p256dh: 'a', auth: 'b' }, prefs: { preview: true } });
    n.savePushSubscription({ endpoint: 'https://e/preview-off', keys: { p256dh: 'a', auth: 'b' } });
    await n.pushNotify('标题', '最小化正文');
    assert.equal(webpush.sent.length, 2);
    for (const s of webpush.sent) assert.equal(s.payload.body, '最小化正文');
  });

  test('订阅 prefs.preview=true 且提供 previewBody → 该订阅收 previewBody，未订阅的仍收 body', async t => {
    const webpush = fakeWebpush();
    const n = createNotifyChannels({ dataDir: tempDataDir(t), env: ENV_PUSH_ON, webpushImpl: webpush });
    n.savePushSubscription({ endpoint: 'https://e/preview-on', keys: { p256dh: 'a', auth: 'b' }, prefs: { preview: true } });
    n.savePushSubscription({ endpoint: 'https://e/preview-off', keys: { p256dh: 'a', auth: 'b' }, prefs: { preview: false } });
    n.savePushSubscription({ endpoint: 'https://e/no-prefs', keys: { p256dh: 'a', auth: 'b' } });
    await n.pushNotify('标题', '最小化正文', undefined, '完整问题正文预览');
    const byEndpoint = Object.fromEntries(webpush.sent.map(s => [s.endpoint, s.payload]));
    assert.equal(byEndpoint['https://e/preview-on'].body, '完整问题正文预览');
    assert.equal(byEndpoint['https://e/preview-off'].body, '最小化正文');
    assert.equal(byEndpoint['https://e/no-prefs'].body, '最小化正文');
  });

  test('previewBody 为空串（事件类型支持预览但本次无内容）→ 即便订阅了预览也回落 body（空预览没意义）', async t => {
    const webpush = fakeWebpush();
    const n = createNotifyChannels({ dataDir: tempDataDir(t), env: ENV_PUSH_ON, webpushImpl: webpush });
    n.savePushSubscription({ endpoint: 'https://e/preview-on', keys: { p256dh: 'a', auth: 'b' }, prefs: { preview: true } });
    await n.pushNotify('标题', '最小化正文', undefined, '');
    assert.equal(webpush.sent[0].payload.body, '最小化正文');
  });

  test('data 透传不受 preview 选择影响', async t => {
    const webpush = fakeWebpush();
    const n = createNotifyChannels({ dataDir: tempDataDir(t), env: ENV_PUSH_ON, webpushImpl: webpush });
    n.savePushSubscription({ endpoint: 'https://e/preview-on', keys: { p256dh: 'a', auth: 'b' }, prefs: { preview: true } });
    await n.pushNotify('标题', '正文', { instanceId: 'inst_1' }, '预览');
    assert.deepEqual(webpush.sent[0].payload.data, { instanceId: 'inst_1' });
  });
});

// #231 review：发一条测试推送时两条通道各发一条。串行发的话 Web Push 慢、ntfy 又接近 8s 超时，加起来超过前端 12s 的
// emit 时限，界面报成断网；而且 Web Push 的计数要等 ntfy 回来才取，这段时间别的通知的成功 / 失败会被算进这次测试。
test.describe('pushTest · 测试推送回执', () => {
  const ENV_BOTH = { ...ENV_PUSH_ON, NTFY_URL: 'https://ntfy.example', NTFY_TOPIC: 'top' };

  // 双向屏障：两条通道各自在开始发时报到，都等对方也开始了才返回。先 Web Push 后 ntfy、先 ntfy 后 Web Push
  // 两种串行顺序都会在这里互等卡死、超时变红；只等一个方向的话，另一种顺序的串行照样绿。
  test('两条通道并发发：两边都等对方开始了才返回（任一种串行顺序都会在这里互等卡死）', { timeout: 3000 }, async t => {
    let webPushStarted, ntfyStarted;
    const webPushStartedP = new Promise(resolve => { webPushStarted = resolve; });
    const ntfyStartedP = new Promise(resolve => { ntfyStarted = resolve; });
    const n = createNotifyChannels({
      dataDir: tempDataDir(t),
      env: ENV_BOTH,
      webpushImpl: { setVapidDetails: () => {}, sendNotification: async () => { webPushStarted(); await ntfyStartedP; } },
      fetchImpl: async () => { ntfyStarted(); await webPushStartedP; return { ok: true, status: 200 }; },
    });
    n.savePushSubscription({ endpoint: 'https://e/1', keys: {} });
    assert.deepEqual(await n.pushTest('t', 'b', {}), { sent: 1, failed: 0, ntfy: 'sent' });
  });

  test('Web Push 的条数在它发完时就取：ntfy 还挂着时别的通知发成功，不算进这次测试', async t => {
    let releaseNtfy;
    const ntfyGate = new Promise(resolve => { releaseNtfy = resolve; });
    const n = createNotifyChannels({
      dataDir: tempDataDir(t),
      env: ENV_BOTH,
      webpushImpl: fakeWebpush(),
      fetchImpl: async () => { await ntfyGate; return { ok: true, status: 200 }; },
    });
    n.savePushSubscription({ endpoint: 'https://e/1', keys: {} });
    const pending = n.pushTest('t', 'b', {});
    await new Promise(resolve => setImmediate(resolve)); // 测试推送的 Web Push 已发完，ntfy 还没回来
    await n.pushNotify('别的通知', '同一时刻发生的一条'); // 也经 Web Push 发成功
    releaseNtfy();
    assert.deepEqual(await pending, { sent: 1, failed: 0, ntfy: 'sent' });
  });
});
