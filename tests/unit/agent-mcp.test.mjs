// MCP 服务器的实时状态与处置（#457）：mcpStatus / reconnectMcp / toggleMcp，对应终端 /mcp。
// init 的 mcp_servers 只是那一刻的快照：CLI 异步连 MCP，init 时很多服务器还是 pending，之后连上、断开、要授权了，
// 面板都不知道。mcpServerStatus() 每次现查；reconnect / toggle 失败时 SDK 抛错，错误要原样带回给手机。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession } from '../helpers/agent-unit.mjs';

const RAW = [
  {
    name: 'github', status: 'connected', scope: 'user', source: 'user',
    serverInfo: { name: 'gh', version: '1' }, config: { type: 'stdio', command: 'gh-mcp' },
    tools: [{ name: 'a' }, { name: 'b' }],
  },
  { name: 'postgres', status: 'failed', error: 'spawn ENOENT', scope: 'project', source: 'project' },
  { name: 'linear', status: 'pending' },
];

test.describe('mcpStatus()：现查 mcpServerStatus()，只回面板要的字段', () => {
  test('名字 / 状态 / 错误 / 范围 / 来源 / 工具个数；配置与工具清单不往外带', async () => {
    const { s } = makeSession();
    s.q = { mcpServerStatus: async () => RAW };
    assert.deepEqual(await s.mcpStatus(), [
      { name: 'github', status: 'connected', scope: 'user', source: 'user', toolCount: 2 },
      { name: 'postgres', status: 'failed', error: 'spawn ENOENT', scope: 'project', source: 'project' },
      { name: 'linear', status: 'pending' },
    ]);
    s.dispose();
  });

  // 限流重试期间控制请求可能永不回包：面板不能跟着挂住，回 null 让调用方退回 init 快照
  test('超时、调用失败、方法不存在、没有 query → null', async () => {
    const cases = [
      { mcpServerStatus: () => new Promise(() => {}) },
      { mcpServerStatus: async () => { throw new Error('boom'); } },
      {},
      null,
    ];
    for (const q of cases) {
      const { s } = makeSession();
      s.q = q;
      assert.equal(await s.mcpStatus(20), null);
      s.dispose();
    }
  });
});

test.describe('reconnectMcp() / toggleMcp()：失败把 SDK 的错误原样往上抛', () => {
  test('参数原样交给 SDK', async () => {
    const { s } = makeSession();
    const calls = [];
    s.q = {
      reconnectMcpServer: async name => { calls.push(['reconnect', name]); },
      toggleMcpServer: async (name, enabled) => { calls.push(['toggle', name, enabled]); },
    };
    await s.reconnectMcp('postgres');
    await s.toggleMcp('github', false);
    assert.deepEqual(calls, [['reconnect', 'postgres'], ['toggle', 'github', false]]);
    s.dispose();
  });

  test('SDK 抛错 → 同一条错误信息抛给调用方；没有 query 也抛', async () => {
    const { s } = makeSession();
    s.q = {
      reconnectMcpServer: async () => { throw new Error('Server postgres not found'); },
      toggleMcpServer: async () => { throw new Error('toggle denied'); },
    };
    await assert.rejects(s.reconnectMcp('postgres'), /Server postgres not found/);
    await assert.rejects(s.toggleMcp('github', true), /toggle denied/);
    s.q = null;
    await assert.rejects(s.reconnectMcp('postgres'));
    s.dispose();
  });
});
