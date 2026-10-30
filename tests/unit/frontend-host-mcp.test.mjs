// tests/unit/frontend-host-mcp.test.mjs —— 「宿主机」页 MCP 卡片的现查结果归属（#457）。
// 跑法：npm run test:unit。卡片的画法、按钮、确认 sheet 由 E2E settings-scope-split.spec.ts 覆盖；
// 这里钉住 E2E 难造的时序：查看的实例从 A 切到 B，两次现查都在途、回执乱序到达时，卡片画的必须是 B。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHostMcp } from '../../app/public/js/app/host-mcp.js';
import { setLang } from '../../app/public/js/i18n.js';

setLang('zh');

// 最小 DOM 替身：renderCard 只用到 createElement、className / textContent / dataset、append / appendChild、setAttribute
function fakeEl(tag) {
  return {
    tag, className: '', textContent: '', dataset: {}, children: [], type: '', disabled: false, onclick: null,
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { this.children.push(...cs); },
    setAttribute() {},
  };
}
globalThis.document = { createElement: fakeEl };

// emit 不自动回：每次调用挂起，由用例决定哪一次先回
function harness() {
  let viewing = 'inst_A';
  const pending = [];
  const mcp = createHostMcp({
    emit: (event, payload) => new Promise(resolve => pending.push({ event, payload, resolve })),
    appConfirm: async () => true,
    getInstanceId: () => viewing,
    getSnapshot: () => null,
    onChange: () => {},
  });
  return { mcp, pending, view: id => { viewing = id; } };
}

const liveRes = name => ({ ok: true, live: true, servers: [{ name, status: 'connected' }] });
// 卡片最后一个子节点是服务器列表，每行 dataset.mcpName
const rowNames = card => card.children.at(-1).children.map(row => row.dataset.mcpName);

test('切走前那个实例的现查回执晚到，不得覆盖新实例的结果：卡片仍画新实例、带按钮', async () => {
  const h = harness();
  const pa = h.mcp.refresh();          // A 的现查在途
  h.view('inst_B');
  const pb = h.mcp.refresh();          // 切到 B，又发一次
  assert.deepEqual(h.pending.map(p => p.payload.instanceId), ['inst_A', 'inst_B'], '前置：两次现查各发给自己的实例');

  h.pending[1].resolve(liveRes('b-server'));
  await pb;
  h.pending[0].resolve(liveRes('a-server')); // A 的回执比 B 晚到
  await pa;

  const card = h.mcp.renderCard();
  assert.ok(card, '旧回执把 B 的现查结果顶掉后，B 既没有现查结果也没有快照，整张卡就没了');
  assert.deepEqual(rowNames(card), ['b-server']);
  assert.ok(!card.children[0].textContent.includes('快照'), '画的应是现查结果，不是退回的快照');
  const actions = card.children.at(-1).children[0].children.map(c => c.dataset?.mcpAction).filter(Boolean);
  assert.deepEqual(actions, ['toggle'], '现查结果才有启停按钮');
});

test('回执按顺序到达时照常以最后一次为准', async () => {
  const h = harness();
  const pa = h.mcp.refresh();
  h.pending[0].resolve(liveRes('a-server'));
  await pa;
  h.view('inst_B');
  const pb = h.mcp.refresh();
  h.pending[1].resolve(liveRes('b-server'));
  await pb;
  assert.deepEqual(rowNames(h.mcp.renderCard()), ['b-server']);
});
