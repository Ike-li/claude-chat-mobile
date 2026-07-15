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
