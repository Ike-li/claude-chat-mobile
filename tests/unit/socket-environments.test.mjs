// tests/unit/socket-environments.test.mjs —— 保存的环境的 socket 面：设备闸、文件夹范围、effort 校验。
// 同 socket-folders.test.mjs：deviceApproved 为 undefined 那一支真 server 造不出来，所以在这一层用假 socket 测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocketEventRegistrar } from '../../app/src/server/socket.js';
import { registerEnvironmentSocketHandlers } from '../../app/src/server/socket-environments.js';

const ENV = { name: '日常', cwd: '/r/app', model: 'opus', effort: 'xhigh', worktree: true };

function setup(deviceApproved, { available = () => true, seed = [] } = {}) {
  const handlers = new Map();
  const socket = { deviceApproved, handshake: { auth: {} }, on: (e, h) => handlers.set(e, h), emit() {} };
  const calls = { create: [], update: [], remove: [], audit: [] };
  registerEnvironmentSocketHandlers({
    socket,
    on: createSocketEventRegistrar({ logger: { warn() {}, error() {} } }),
    store: {
      list: () => seed,
      create: input => { calls.create.push(input); return { ok: true, environment: { id: 'new', ...input } }; },
      update: (id, input) => { calls.update.push([id, input]); return { ok: true, environment: { id, ...input } }; },
      remove: id => { calls.remove.push(id); return { ok: true }; },
    },
    isFolderAvailable: available,
    audit: { recordAudit: entry => calls.audit.push(entry) },
    actorFromSocket: () => ({}),
  });
  const call = (event, payload) => new Promise(resolve => handlers.get(event)(payload, resolve));
  return { call, calls };
}

test('environments:list：每条标明文件夹现在还能不能用', async () => {
  const seed = [{ id: 'a', ...ENV }, { id: 'b', ...ENV, name: '断开的', cwd: '/gone' }];
  const { call } = setup(true, { seed, available: cwd => cwd === '/r/app' });
  const res = await call('environments:list');
  assert.equal(res.ok, true);
  assert.deepEqual(res.environments.map(e => [e.id, e.available]), [['a', true], ['b', false]]);
});

test('写操作：deviceApproved 为 false 或 undefined 都拒绝，存储一次都不碰', async () => {
  for (const approved of [false, undefined]) {
    const { call, calls } = setup(approved);
    for (const [event, payload] of [['environments:save', ENV], ['environments:delete', { id: 'a' }]]) {
      const res = await call(event, payload);
      assert.equal(res.ok, false, `${event} 在 deviceApproved=${approved} 时竟然放行了`);
      assert.equal(res.error, 'device_not_approved');
    }
    assert.deepEqual([calls.create, calls.update, calls.remove], [[], [], []]);
  }
});

test('environments:save：没带 id 是新建，带 id 是更新', async () => {
  const { call, calls } = setup(true, { seed: [{ id: 'a', ...ENV }] });
  assert.equal((await call('environments:save', ENV)).environment.id, 'new');
  assert.equal(calls.create.length, 1);
  assert.equal((await call('environments:save', { ...ENV, id: 'a', name: '改名' })).environment.id, 'a');
  assert.deepEqual(calls.update[0][0], 'a');
});

test('environments:save：范围外的文件夹拒绝并留审计，存不进去', async () => {
  const { call, calls } = setup(true, { available: () => false });
  assert.deepEqual(await call('environments:save', ENV), { ok: false, error: 'out_of_range' });
  assert.deepEqual(calls.create, []);
  assert.equal(calls.audit.length, 1);
  assert.equal(calls.audit[0].action, 'scope_violation');
  assert.equal(calls.audit[0].target, ENV.cwd);
});

test('environments:save：文件夹已断开时仍能改名——cwd 没变，没有扩大范围', async () => {
  const { call, calls } = setup(true, { available: () => false, seed: [{ id: 'a', ...ENV }] });
  assert.equal((await call('environments:save', { ...ENV, id: 'a', name: '改名' })).ok, true);
  assert.equal(calls.audit.length, 0);
  // 换成别的 cwd 就是另一回事
  const moved = await call('environments:save', { ...ENV, id: 'a', cwd: '/elsewhere' });
  assert.deepEqual(moved, { ok: false, error: 'out_of_range' });
});

test('environments:save：不认识的 effort 拒绝；null 是合法的「跟随默认」', async () => {
  const { call, calls } = setup(true);
  assert.deepEqual(await call('environments:save', { ...ENV, effort: '胡写' }), { ok: false, error: 'invalid_effort' });
  assert.equal(calls.create.length, 0);
  assert.equal((await call('environments:save', { ...ENV, effort: null })).ok, true);
});

test('environments:delete：id 原样交给存储，结果原样回', async () => {
  const { call, calls } = setup(true);
  assert.deepEqual(await call('environments:delete', { id: 'a' }), { ok: true });
  assert.deepEqual(calls.remove, ['a']);
});
