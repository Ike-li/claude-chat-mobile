// T-proxy：同 netns 打 :8080，nginx 把 Host 改写成 playground.example.test → 仍须设备审批。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { io } from 'socket.io-client';

const TOKEN = 'playground-local-not-a-secret';
const DEVICE = 'playground-probe-device';

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

test('reverse-proxy public Host still requires device approval', async () => {
  const socket = io('http://127.0.0.1:8080', {
    auth: { token: TOKEN, deviceToken: DEVICE },
    transports: ['websocket'],
    reconnection: false,
  });
  let pendingTimer;
  const pending = new Promise((resolve, reject) => {
    pendingTimer = setTimeout(() => reject(new Error('未收到 device_status pending')), 5000);
    socket.on('agent:event', envelope => {
      if (envelope.type === 'device_status' && envelope.payload?.status === 'pending') {
        clearTimeout(pendingTimer);
        resolve(envelope);
      }
    });
  });
  try {
    await waitForConnect(socket);
    await pending;
    const list = await emitAck(socket, 'session:list', {});
    assert.equal(list?.error, 'device_not_approved');
    assert.equal(list?.permanent, true);
  } finally {
    clearTimeout(pendingTimer);
    socket.removeAllListeners();
    socket.disconnect();
  }
});
