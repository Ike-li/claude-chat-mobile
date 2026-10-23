// tests/unit/local-reset.test.mjs —— 设置页底部两档「重新加载 / 重置本机数据」的执行（#302）
// 测什么：app/local-reset.js 对浏览器的副作用：清哪些 Cache、注销哪些 SW、删哪些键、什么时候拒绝、重置的先后顺序。
//   用假的 caches / serviceWorker / storage / location，因为这些是浏览器边界：E2E 的 Chromium 里推送订阅建不起来，
//   「合法 SW 的注销与退订一次都没被调用」只能在这里数调用次数（只查「注册还在」不够：setup() 会再注册一个）。
// 不测什么：确认框文案（logic-local-reset.test.mjs）；app.js 里 pagehide 回写的闸（E2E settings-local-reset.spec.ts）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalReset } from '../../app/public/js/app/local-reset.js';

function fakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
    clear: () => { map.clear(); },
    keys: () => [...map.keys()].sort(),
  };
}

function fakeBrowser({ local = {}, session = {}, scripts = ['https://h.test/sw.js'], cacheNames = ['v1-shell', 'v1-assets'], withSw = true } = {}) {
  const log = [];
  const registrations = scripts.map(scriptURL => {
    const reg = {
      scriptURL,
      unregistered: false,
      pushUnsubscribed: false,
      active: { scriptURL },
      pushManager: { getSubscription: async () => ({ endpoint: `push:${scriptURL}`, unsubscribe: async () => { reg.pushUnsubscribed = true; return true; } }) },
      unregister: async () => { reg.unregistered = true; log.push(`unregister:${scriptURL}`); return true; },
    };
    return reg;
  });
  const names = new Set(cacheNames);
  const win = {
    localStorage: fakeStorage(local),
    sessionStorage: fakeStorage(session),
    caches: {
      keys: async () => [...names],
      delete: async n => { log.push(`cache:${n}`); return names.delete(n); },
    },
    navigator: withSw ? { serviceWorker: { getRegistrations: async () => registrations } } : {},
    location: { reload: () => { log.push('reload'); } },
  };
  if (!withSw) delete win.caches;
  return { win, log, registrations, cacheNames: names };
}

const KEEP = {
  auth_token: 't', device_token: 'd', 'ccm-outbox-v1': '[{"text":"离线那条"}]', 'ccm-outbox-dead-letters-v1': '[{"text":"拒收那条"}]',
  'ccm-unread-v1': '{}', ccm_lang: 'en', ccm_push_preview: '1', ccm_push_opt_out: '0', ccm_client_logs: '[]',
};
const CLEARABLE = { slash_commands: '[]', slash_commands_terminal: '[]', ccm_expanded_dirs: '[]', current_session: 'abc' };

test('重新加载：清全部 Cache、只注销 /sw.js 以外的 SW、只删可再生的键，其余原样，最后 reload', async () => {
  const b = fakeBrowser({
    local: { ...KEEP, ...CLEARABLE },
    session: { s: '1' },
    scripts: ['https://h.test/sw.js?v=2', 'https://h.test/js/sw.js', 'https://h.test/old-sw.js'],
  });
  const reset = createLocalReset({ win: b.win, isSending: () => false });
  assert.deepEqual(await reset.reloadApp(), { ok: true });

  assert.deepEqual([...b.cacheNames], [], 'Cache Storage 没清干净');
  const push = b.registrations[0];
  assert.equal(push.unregistered, false, '合法的推送 SW 被注销了');
  assert.equal(push.pushUnsubscribed, false, '推送订阅被退订了');
  assert.deepEqual(b.registrations.slice(1).map(r => r.unregistered), [true, true], '遗留 SW 没注销');
  assert.deepEqual(b.win.localStorage.keys(), Object.keys(KEEP).sort(), '删了不可再生的键，或可再生的没删');
  assert.equal(b.win.localStorage.getItem('ccm-outbox-v1'), KEEP['ccm-outbox-v1']);
  assert.deepEqual(b.win.sessionStorage.keys(), ['s']);
  assert.equal(b.log.at(-1), 'reload', 'reload 必须是最后一步');
  assert.equal(b.log.filter(x => x === 'reload').length, 1);
});

test('重新加载：有消息正在发送时拒绝，一点副作用都没有', async () => {
  const b = fakeBrowser({ local: { ...KEEP, ...CLEARABLE }, scripts: ['https://h.test/sw.js', 'https://h.test/old-sw.js'] });
  const reset = createLocalReset({ win: b.win, isSending: () => true });
  assert.deepEqual(await reset.reloadApp(), { ok: false, reason: 'sending' });
  assert.deepEqual(b.log, [], '拒绝了还动了 Cache / SW / reload');
  assert.deepEqual(b.win.localStorage.keys(), Object.keys({ ...KEEP, ...CLEARABLE }).sort());
  assert.equal(reset.isResetting(), false);
});

test('重置本机数据：先进重置态再断连，带着凭据退订推送，然后清 Cache、注销全部 SW、清两份 Storage，最后 reload', async () => {
  const b = fakeBrowser({ local: { ...KEEP, ...CLEARABLE }, session: { s: '1' }, scripts: ['https://h.test/sw.js', 'https://h.test/old-sw.js'] });
  const steps = [];
  let reset;
  reset = createLocalReset({
    win: b.win,
    isSending: () => true, // 重置不看发送中：丢消息正是确认框里写明的后果
    beforeReset: () => steps.push(`beforeReset:resetting=${reset.isResetting()}`),
    unsubscribePush: async () => { steps.push(`unsubscribe:token=${b.win.localStorage.getItem('auth_token')}`); return true; },
  });
  await reset.resetLocalData();

  assert.deepEqual(steps, ['beforeReset:resetting=true', 'unsubscribe:token=t'], '断连前没进重置态，或退订时凭据已经没了');
  assert.deepEqual(b.registrations.map(r => r.unregistered), [true, true], '重置要注销全部 SW，包括 /sw.js');
  assert.deepEqual([...b.cacheNames], []);
  assert.deepEqual(b.win.localStorage.keys(), []);
  assert.deepEqual(b.win.sessionStorage.keys(), []);
  assert.equal(b.log.at(-1), 'reload');
  assert.equal(reset.isResetting(), true, 'reload 之前重置态不能撤掉：pagehide 还要靠它挡回写');
});

test('重置本机数据：退订推送挂住或失败也照样清完、reload（网络问题不该把人卡在半重置的页面上）', async () => {
  for (const unsubscribePush of [() => new Promise(() => {}), async () => { throw new Error('offline'); }]) {
    const b = fakeBrowser({ local: { ...KEEP } });
    const reset = createLocalReset({ win: b.win, unsubscribePush, unsubscribeTimeoutMs: 20 });
    await reset.resetLocalData();
    assert.deepEqual(b.win.localStorage.keys(), []);
    assert.equal(b.log.at(-1), 'reload');
  }
});

test('非安全上下文（没有 serviceWorker、没有 caches）：两档都照常清 Storage 并 reload', async () => {
  const one = fakeBrowser({ local: { ...KEEP, ...CLEARABLE }, withSw: false });
  assert.deepEqual(await createLocalReset({ win: one.win, isSending: () => false }).reloadApp(), { ok: true });
  assert.deepEqual(one.win.localStorage.keys(), Object.keys(KEEP).sort());
  assert.deepEqual(one.log, ['reload']);

  const two = fakeBrowser({ local: { ...KEEP }, withSw: false });
  await createLocalReset({ win: two.win }).resetLocalData();
  assert.deepEqual(two.win.localStorage.keys(), []);
  assert.deepEqual(two.log, ['reload']);
});
