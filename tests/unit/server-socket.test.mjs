import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSocketEventRegistrar } from '../../src/server/socket.js';

function fakeSocket({ approved = true } = {}) {
  const handlers = new Map();
  const emitted = [];
  return {
    deviceApproved: approved,
    handshake: { auth: { deviceToken: 'device-1' } },
    on: (event, handler) => handlers.set(event, handler),
    emit: (...args) => emitted.push(args),
    handlers,
    emitted,
  };
}

test('socket event registrar rejects business events from unapproved devices', async () => {
  const socket = fakeSocket({ approved: false });
  const on = createSocketEventRegistrar({ logger: { warn() {}, error() {} } });
  let called = false;
  on(socket, 'user:message', () => { called = true; });

  await socket.handlers.get('user:message')({ text: 'nope' });

  assert.equal(called, false);
  assert.deepEqual(socket.emitted, []);
});

test('socket event registrar converts handler failures into one recoverable error event', async () => {
  const socket = fakeSocket();
  const on = createSocketEventRegistrar({ logger: { warn() {}, error() {} } });
  on(socket, 'browse:read', () => { throw new Error('boom'); });

  await socket.handlers.get('browse:read')({});

  assert.equal(socket.emitted.length, 1);
  assert.equal(socket.emitted[0][0], 'agent:event');
  assert.equal(socket.emitted[0][1].type, 'error');
  assert.equal(socket.emitted[0][1].payload.recoverable, true);
  assert.match(socket.emitted[0][1].payload.message, /browse:read.*boom/);
});

// SRV-NEW-005：handler 抛错时 trailing ack 必须收到负回执，否则离线队列/UI 永久 in-flight
test('socket event registrar nacks trailing ack when handler throws', async () => {
  const socket = fakeSocket();
  const on = createSocketEventRegistrar({ logger: { warn() {}, error() {} } });
  on(socket, 'user:message', () => { throw new Error('disk full'); });
  let ackPayload = null;
  await socket.handlers.get('user:message')({ text: 'hi' }, (p) => { ackPayload = p; });
  assert.equal(socket.emitted[0][1].type, 'error');
  assert.deepEqual(ackPayload, { ok: false, error: 'disk full', retryable: true });
});

test('socket event registrar nacks unapproved device when ack present', async () => {
  const socket = fakeSocket({ approved: false });
  const on = createSocketEventRegistrar({ logger: { warn() {}, error() {} } });
  let called = false;
  on(socket, 'user:message', () => { called = true; });
  let ackPayload = null;
  await socket.handlers.get('user:message')({ text: 'x' }, (p) => { ackPayload = p; });
  assert.equal(called, false);
  assert.deepEqual(ackPayload, { ok: false, error: 'device_not_approved', permanent: true });
});
