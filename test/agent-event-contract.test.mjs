import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AGENT_EVENT_TYPES,
  checkAgentEventContract,
} from '../scripts/agent-event-contract.js';

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
});

test('agent event contract reports mock event types that real paths do not emit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-agent-event-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'agent.js', `
    class AgentSession {
      run() {
        this.emit('init', {});
      }
    }
  `);
  await writeFixture(root, 'server.js', `
    io.emit('agent:event', { type: 'init', payload: {} });
  `);
  await writeFixture(root, 'scripts/visual-mock-server.js', `
    io.emit('agent:event', { type: 'init', payload: {} });
    io.emit('agent:event', { type: 'mock_only', payload: {} });
  `);

  const result = checkAgentEventContract({
    rootDir: root,
    contractTypes: new Set([...AGENT_EVENT_TYPES, 'mock_only']),
  });

  assert.deepEqual(result.problems.map(problem => problem.code), ['mock_type_not_real']);
  assert.equal(result.problems[0].type, 'mock_only');
});
