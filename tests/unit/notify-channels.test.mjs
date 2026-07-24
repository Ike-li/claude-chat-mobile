import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNotifyChannels } from '../../src/ops/notify-channels.js';

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
