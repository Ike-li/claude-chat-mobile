import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AGENT_EVENT_TYPES,
  checkAgentEventContract,
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
