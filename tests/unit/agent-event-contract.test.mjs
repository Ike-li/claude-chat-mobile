import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AGENT_EVENT_TYPES,
  INBOUND_SOCKET_EVENTS,
  checkAgentEventContract,
  checkInboundSocketContract,
} from '../../scripts/agent-event-contract.js';

async function writeFixture(root, relativePath, source) {
  const fullPath = join(root, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, source);
}

test('agent event contract covers current real server and visual mock event types', () => {
  const result = checkAgentEventContract();

  assert.deepEqual(result.problems, []);
  assert.ok(result.realTypes.has('init'));
  assert.ok(result.realTypes.has('history_append'));
  assert.ok(result.realTypes.has('permission_request'));
  assert.ok(result.realTypes.has('task_progress'));
  assert.ok(result.mockTypes.has('permission_request'));
  assert.ok(result.mockTypes.has('task_progress'));
  assert.ok(
    result.mockLocations.some(location => location.file === 'tests/e2e/mock/scenarios/content.js'),
    'split business scenario files must remain inside the mock event contract scan',
  );
});

test('agent event contract reports mock event types that real paths do not emit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-agent-event-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'src/agent/agent.js', `
    class AgentSession {
      run() {
        this.emit('init', {});
      }
    }
  `);
  await writeFixture(root, 'src/server/app.js', `
    io.emit('agent:event', { type: 'init', payload: {} });
  `);
  await writeFixture(root, 'tests/e2e/mock/server.js', `
    io.emit('agent:event', { type: 'init', payload: {} });
    io.emit('agent:event', { type: 'mock_only', payload: {} });
  `);

  const result = checkAgentEventContract({
    rootDir: root,
    contractTypes: new Set([...AGENT_EVENT_TYPES, 'mock_only']),
    mockSources: [{ path: 'tests/e2e/mock/server.js', kind: 'agent-event-emit' }],
  });

  assert.deepEqual(result.problems.map(problem => problem.code), ['mock_type_not_real']);
  assert.equal(result.problems[0].type, 'mock_only');
});

// SEC-01：server.js 用 io.to('approved').emit('agent:event', ...) 做下行隔离（房间过滤），
// 这是合法的链式广播调用、非动态类型——静态扫描须识别，否则会把仍在真实发出的类型误判为「real 不再发出」。
test('agent event contract 识别 io.to(room).emit("agent:event", ...) 链式调用', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-agent-event-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'src/agent/agent.js', `
    class AgentSession {
      run() {
        this.emit('init', {});
      }
    }
  `);
  await writeFixture(root, 'src/server/app.js', `
    io.to('approved').emit('agent:event', { type: 'session_log', payload: {} });
  `);
  await writeFixture(root, 'tests/e2e/mock/server.js', `
    io.emit('agent:event', { type: 'session_log', payload: {} });
  `);

  const result = checkAgentEventContract({
    rootDir: root,
    contractTypes: new Set([...AGENT_EVENT_TYPES, 'session_log']),
    mockSources: [{ path: 'tests/e2e/mock/server.js', kind: 'agent-event-emit' }],
  });

  assert.deepEqual(result.problems, [], 'io.to(room).emit 里的 session_log 应被识别为 real 已发出，不应报 mock_type_not_real');
  assert.ok(result.realTypes.has('session_log'));
});

// ---- 入向 socket 事件契约（客户端 → 服务端）----

test('inbound socket contract covers real server registrations, client emits, and mock handlers', () => {
  const result = checkInboundSocketContract();

  assert.deepEqual(result.problems, []);
  // 三面抽样：server 注册、前端 emit、mock 注册
  assert.ok(result.serverEvents.has('user:message'));
  assert.ok(result.serverEvents.has('session:switch'));
  assert.ok(result.serverEvents.has('tool:preview')); // socket-files.js 单列注册面也须被扫到
  assert.ok(result.serverEvents.has('conn:ping'));    // 裸 socket.on（绕过 registrar）也须被扫到
  assert.ok(result.clientEvents.has('user:message'));
  assert.ok(result.mockEvents.has('user:message'));
  // socket.io 内建生命周期事件不属于业务契约
  assert.ok(!result.serverEvents.has('disconnect'));
  assert.ok(!result.mockEvents.has('disconnect'));
});

test('inbound contract flags server registrations missing from the contract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-inbound-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'src/server/app.js', `
    on(socket, 'user:message', () => {});
    on(socket, 'user:rogue', () => {});
    socket.on('disconnect', () => {});
  `);
  await writeFixture(root, 'public/js/app.js', `socket.emit('user:message', {});`);
  await writeFixture(root, 'tests/e2e/mock/server.js', `socket.on('user:message', () => {});`);

  const result = checkInboundSocketContract({
    rootDir: root,
    contractEvents: new Set(['user:message']),
  });

  assert.deepEqual(result.problems.map(p => p.code), ['real_inbound_not_contract']);
  assert.equal(result.problems[0].event, 'user:rogue');
});

test('inbound contract flags stale contract entries no longer registered by the server', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-inbound-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'src/server/app.js', `on(socket, 'user:message', () => {});`);
  await writeFixture(root, 'public/js/app.js', `socket.emit('user:message', {});`);
  await writeFixture(root, 'tests/e2e/mock/server.js', `socket.on('user:message', () => {});`);

  const result = checkInboundSocketContract({
    rootDir: root,
    contractEvents: new Set(['user:message', 'user:ghost']),
  });

  assert.deepEqual(result.problems.map(p => p.code), ['contract_inbound_not_registered']);
  assert.equal(result.problems[0].event, 'user:ghost');
});

test('inbound contract flags client emits and mock handlers outside the contract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-inbound-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'src/server/app.js', `on(socket, 'user:message', () => {});`);
  await writeFixture(root, 'public/js/app/extra.js', `sock.emit('user:unhandled', {});`);
  await writeFixture(root, 'tests/e2e/mock/server.js', `socket.on('mock:invented', () => {});`);

  const result = checkInboundSocketContract({
    rootDir: root,
    contractEvents: new Set(['user:message']),
  });

  assert.deepEqual(result.problems.map(p => p.code).sort(), [
    'client_inbound_not_contract',
    'mock_inbound_not_contract',
  ]);
});

test('INBOUND_SOCKET_EVENTS 与 interfaces.md 的入向事件表同源（数量抽查）', () => {
  // 31 = user:*(10) + task:stop + session:*(8) + sync/mirror/conn/dev(4) + logs:*(2) + tool:*(2) + browse:*(2) + doctor:run + service:status
  // （曾含 usage:get；抽屉额度窗已砍，额度只走 statusline。logs:clientError=前端全局 JS 错误上报落服务端日志；
  //   user:cancelQueued=排队消息撤回，对齐 CLI ESC）
  assert.equal(INBOUND_SOCKET_EVENTS.length, 31);
  assert.ok(INBOUND_SOCKET_EVENTS.includes('user:cancelQueued'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('session:deletePermanent'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('doctor:run'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('service:status'));
  assert.equal(INBOUND_SOCKET_EVENTS.includes('usage:get'), false);
});
