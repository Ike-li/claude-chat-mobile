// T-loopback：probe 与 app 同 netns，127.0.0.1 + 本机 Host → 设备审批 bypass。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { io } from 'socket.io-client';

const TOKEN = 'playground-local-not-a-secret';

function connect(url) {
  return io(url, {
    auth: { token: TOKEN },
    transports: ['websocket'],
    reconnection: false,
  });
}

function waitForConnect(socket, timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (socket.connected) return resolve();
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), timeout);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function emitAck(socket, event, payload = {}, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), timeout);
    socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
  });
}

test('loopback Host bypasses device approval and can session:list', async () => {
  const socket = connect('http://127.0.0.1:3000');
  const events = [];
  socket.on('agent:event', envelope => events.push(envelope));
  try {
    await waitForConnect(socket);
    const list = await emitAck(socket, 'session:list', {});
    assert.notEqual(list?.error, 'device_not_approved');
    assert.ok(Array.isArray(list?.sessions), `session:list 应返回 sessions，实际：${JSON.stringify(list)}`);
    assert.equal(
      events.some(e => e.type === 'device_status' && e.payload?.status === 'pending'),
      false,
      'loopback bypass 不应出现 pending 设备',
    );
  } finally {
    socket.disconnect();
  }
});
