// 上下文面板的数据：context:usage。形状取自真 CLI 探针（2026-11-07，假 Messages API + 隔离 HOME）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextUsageView, registerContextSocketHandlers } from '../../app/src/server/socket-context.js';

const SDK_USAGE = {
  categories: [
    { id: 'system_tools', name: 'System tools', tokens: 9866, color: 'inactive', kind: 'used' },
    { id: 'system_tools_deferred', name: 'System tools (deferred)', tokens: 4373, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { id: 'memory_files', name: 'Memory files', tokens: 0, color: 'x', kind: 'used' },
    { id: 'messages', name: 'Messages', tokens: 1500, color: 'x', kind: 'used' },
    { id: 'free_space', name: 'Free space', tokens: 188609, color: 'x', kind: 'free' },
  ],
  totalTokens: 11391, maxTokens: 200000, rawMaxTokens: 200000, percentage: 6,
  autoCompactThreshold: 167000, isAutoCompactEnabled: true,
  gridRows: [[{ color: 'x' }]], model: 'claude-haiku-4-5', memoryFiles: [{ path: '/secret/CLAUDE.md' }],
};

function register(agent) {
  const handlers = new Map();
  registerContextSocketHandlers({ socket: {}, on: (_s, event, fn) => handlers.set(event, fn), routeInstance: id => (id === 'i1' ? agent : null) });
  return (payload = { instanceId: 'i1', detail: 'full' }) => new Promise(resolve => handlers.get('context:usage')(payload, resolve));
}
const agentWith = getContextUsage => ({ q: { getContextUsage } });

test('只回面板要的字段：不占窗口的和 0 token 的行不显示，gridRows 和文件路径不下发', () => {
  assert.deepEqual(contextUsageView(SDK_USAGE), {
    totalTokens: 11391, maxTokens: 200000, percentage: 6, autoCompactThreshold: 167000, isAutoCompactEnabled: true,
    categories: [
      { id: 'system_tools', name: 'System tools', tokens: 9866, kind: 'used' },
      { id: 'messages', name: 'Messages', tokens: 1500, kind: 'used' },
      { id: 'free_space', name: 'Free space', tokens: 188609, kind: 'free' },
    ],
  });
});

test('按要求的档位向 CLI 取，回包带上档位', async () => {
  const asked = [];
  const ask = register(agentWith(async opts => { asked.push(opts); return SDK_USAGE; }));
  const full = await ask({ instanceId: 'i1', detail: 'full' });
  assert.equal(full.ok, true);
  assert.equal(full.detail, 'full');
  assert.equal(full.totalTokens, 11391);
  assert.equal((await ask({ instanceId: 'i1', detail: 'summary' })).detail, 'summary');
  assert.deepEqual(asked, [{ detail: 'full' }, { detail: 'summary' }]);
});

test('档位不认识时按 summary：full 要走 count_tokens，不能由客户端写错一个字段就触发', async () => {
  const asked = [];
  const ask = register(agentWith(async opts => { asked.push(opts); return SDK_USAGE; }));
  assert.equal((await ask({ instanceId: 'i1', detail: 'huge' })).detail, 'summary');
  assert.deepEqual(asked, [{ detail: 'summary' }]);
});

test('实例不存在、已销毁、没有活进程：说明拿不到，不抛错', async () => {
  assert.deepEqual(await register(null)(), { ok: false, code: 'unavailable' });
  assert.deepEqual(await register({ q: null })(), { ok: false, code: 'unavailable' });
  assert.deepEqual(await register({ disposed: true, ...agentWith(async () => SDK_USAGE) })(), { ok: false, code: 'unavailable' });
  assert.equal((await register(agentWith(async () => SDK_USAGE))()).ok, true, '对照：活进程取得到');
});

test('RPC 抛错：回失败，前端留着上一份数据', async () => {
  const ask = register(agentWith(async () => { throw new Error('ProcessTransport is not ready'); }));
  assert.deepEqual(await ask(), { ok: false, code: 'failed' });
});

test('没有 ack：什么也不做', async () => {
  const handlers = new Map();
  let called = 0;
  registerContextSocketHandlers({ socket: {}, on: (_s, event, fn) => handlers.set(event, fn), routeInstance: () => agentWith(async () => { called += 1; return SDK_USAGE; }) });
  await handlers.get('context:usage')({ instanceId: 'i1', detail: 'full' });
  assert.equal(called, 0);
});
