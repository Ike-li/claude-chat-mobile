// tests/unit/frontend-env-config.test.mjs —— 配置面板的保存流程（接线层）单测。
//
// 这个模块 323 行全新，此前**只有 E2E 且只走 happy path**。没被覆盖的恰恰是几条决定
// 「用户会不会被误导」的分支：warn 的二次确认、失败时的解释、非常驻托管时不给重启入口。
// E2E 走真实浏览器代价高、每条 6~10 秒，而这些全是纯粹的控制流 —— 放单测里更合适。
//
// DOM 用最小桩（同 frontend-connection-banner.test.mjs 的做法）：只实现被真正调到的那几个 API。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createEnvConfigPanel } from '../../public/js/app/env-config.js';
// 夹具用**真实**的 buildEnvView 产出，不手编形状 —— 手编的外部契约一旦编错，
// 测试与实现会互相印证并恒绿（这个仓库在 git fixture 上栽过一次）。
// 前端源码不许 import src/，但测试不受模块边界约束（check-import-boundaries.js:13 明写）。
import { buildEnvView } from '../../src/ops/env-schema.js';

// sheets.js 的 CONFIRM_TONES 是工厂内部常量、不导出，只能在这里复述键集（public/js/app/sheets.js:97-101）。
// 复述的风险是「那边加了新 tone、这边没跟上」——但那只会让本断言把一个其实有效的 tone 判红，
// 是安全方向的失败，不会恒绿放过一个无效值（`tone: 'warn'` 正是被这条抓住的）。
const CONFIRM_TONES = new Set(['default', 'warning', 'danger']);

// env-config.js 的 el() 直接调 document.createElement —— 那是浏览器边界，按工程规则可以桩掉
// （本仓其它前端模块都靠注入拿节点，这个是唯一直接碰全局的）。桩在文件级装一次，测完还原。
const realDocument = globalThis.document;
test.before(() => { globalThis.document = { createElement: (tag) => node(tag) }; });
test.after(() => { globalThis.document = realDocument; });

// 极简 DOM 节点：append/replaceChildren/classList/textContent/querySelector 够用。
function node(tag = 'div') {
  const n = {
    tagName: tag.toUpperCase(),
    children: [],
    className: '',
    textContent: '',
    disabled: false,
    type: '',
    id: '',
    value: '',
    dataset: {},
    onclick: null,
    _attrs: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
    },
    placeholder: '',
    checked: false,
    _listeners: {},
    addEventListener(ev, fn) { (n._listeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) { n._listeners[ev] = (n._listeners[ev] || []).filter((f) => f !== fn); },
    dispatch(ev) { (n._listeners[ev] || []).forEach((f) => f({ target: n })); },
    focus() {},
    setAttribute(k, v) { n._attrs[k] = String(v); },
    getAttribute(k) { return n._attrs[k] ?? null; },
    removeAttribute(k) { delete n._attrs[k]; },
    scrollTop: 0,
    append(...kids) { n.children.push(...kids); },
    prepend(...kids) { n.children.unshift(...kids); },
    insertBefore(kid, ref) { const i = n.children.indexOf(ref); n.children.splice(i < 0 ? n.children.length : i, 0, kid); return kid; },
    appendChild(kid) { n.children.push(kid); return kid; },
    replaceChildren(...kids) { n.children = [...kids]; },
    remove() { n._removed = true; },
    querySelector(sel) {
      const id = sel.startsWith('#') ? sel.slice(1) : null;
      return id ? (n.children.find((c) => c.id === id) ?? null) : null;
    },
    querySelectorAll: () => [],
  };
  return n;
}

// 把整棵桩树的文本拼起来——断言「用户到底看到了什么」，而不是内部字段
function textOf(n) {
  if (!n) return '';
  return String(n.textContent || '') + (n.children || []).map(textOf).join(' ');
}

function harness({ ackQueue = [], canRestart = () => true, confirmAnswer = true } = {}) {
  const dom = {
    envConfigModal: node(), envConfigBody: node(), envConfigFooter: node(),
    envConfigHint: node(), envConfigSave: node('button'),
    btnEnvConfig: node('button'), envConfigClose: node('button'),
  };
  const emitted = [];
  const confirms = [];
  const saved = [];
  const socket = {
    emit(event, payload, ack) {
      emitted.push({ event, payload });
      const next = ackQueue.shift();
      // ack 是异步的（真实 socket 也是），用微任务模拟，别让流程假装同步跑完
      Promise.resolve().then(() => ack?.(typeof next === 'function' ? next(payload) : next));
    },
    timeout: () => socket,
  };
  const panel = createEnvConfigPanel({
    $: (id) => dom[id],
    socket,
    openSheet: () => {}, closeSheet: () => {},
    // 桩必须与真实 appConfirm（public/js/app/sheets.js:102）同构地解构对象。
    // 此前它写成 `async (msg) => ...` 收字符串，于是「传字符串进去」这个 bug 在测试里
    // 恒绿：解构字符串原始值不报错，只是每个字段都得 undefined，而 textContent = undefined
    // 会落成空串（DOMString? 的可空转换先把 undefined 变成 null），确认框全空一个字都没有。
    appConfirm: async ({ title, body, okText, tone } = {}) => {
      confirms.push({ title, body, okText, tone });
      return confirmAnswer;
    },
    pickText: (pair) => (pair && typeof pair === 'object' ? (pair.zh ?? pair.en ?? '') : String(pair ?? '')),
    onSaved: (r) => saved.push(r),
    canRestart,
    beforeOpen: () => {},
  });
  panel.bind();   // save 挂在按钮的 onclick 上，不是导出的方法
  return {
    panel, dom, emitted, confirms, saved,
    save: () => dom.envConfigSave.onclick?.(),
  };
}

// env:get 的 ack 就是 { ok, ...buildEnvView(current), envFileExists }（src/server/app.js:2837）
const VIEW_ACK = { ok: true, ...buildEnvView({ PORT: '3000' }), envFileExists: true };

// ack 走微任务，open() 返回时表单还没渲染出来 —— 让出几轮再断言
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

async function openAndEdit({ ackQueue, canRestart, confirmAnswer }, edits) {
  const h = harness({ ackQueue: [VIEW_ACK, ...ackQueue], canRestart, confirmAnswer });
  h.panel.open();
  await settle();
  // 模拟用户输入：改 value 再触发 oninput（真实路径就是这两步）
  for (const [key, value] of Object.entries(edits)) {
    const input = findInput(h.dom.envConfigBody, key);
    assert.ok(input, `表单里应该有 ${key} 这一项`);
    input.value = value;
    input.dispatch('input');   // watch() 挂的是 addEventListener('input')，不是 oninput
  }
  h.save();
  await settle();
  return h;
}

function findInput(root, key) {
  if (root?.dataset?.key === key) return root;
  for (const kid of root?.children || []) {
    const hit = findInput(kid, key);
    if (hit) return hit;
  }
  return null;
}

test.describe('env-config 保存流程 —— 只改动过的项才提交', () => {
  test('一项都没改 → 根本不发 env:set', async () => {
    const h = harness({ ackQueue: [VIEW_ACK] });
    h.panel.open();
    await settle();
    h.save();
    await settle();
    assert.equal(h.emitted.filter((e) => e.event === 'env:set').length, 0);
  });

  test('只提交改动过的那一项（全量提交会把敏感项的遮罩写回去）', async () => {
    const h = await openAndEdit({ ackQueue: [{ ok: true, written: ['PORT'], results: [] }] }, { PORT: '8080' });
    const set = h.emitted.find((e) => e.event === 'env:set');
    assert.deepEqual(Object.keys(set.payload.changes), ['PORT']);
    assert.equal(set.payload.changes.PORT, '8080');
  });
});

test.describe('env-config 保存流程 —— warn 的二次确认', () => {
  const needsConfirm = { ok: false, needsConfirm: true, results: [{ key: 'CF_ACCESS_AUD', level: 'warn', message: '会关闭公网 2FA' }] };

  test('needsConfirm → 弹确认，确认后带 acceptWarnings 重发', async () => {
    const h = await openAndEdit(
      { ackQueue: [needsConfirm, { ok: true, written: ['PORT'], results: [] }] },
      { PORT: '8080' }
    );
    assert.equal(h.confirms.length, 1, '必须问一次');
    const ask = h.confirms[0];
    assert.ok(ask.title, '标题不能为空——一个字都没有的确认框，用户只会直接点确定');
    assert.match(`${ask.title} ${ask.body ?? ''}`, /会关闭公网 2FA/, '确认框要把 warn 原文摆出来，不能只说「有警告」');
    assert.ok(CONFIRM_TONES.has(ask.tone), `tone 必须是 sheets.js 认得的值之一，收到 ${JSON.stringify(ask.tone)}`);
    const sets = h.emitted.filter((e) => e.event === 'env:set');
    assert.equal(sets.length, 2, '确认后重发');
    assert.equal(sets[0].payload.acceptWarnings, false);
    assert.equal(sets[1].payload.acceptWarnings, true);
  });

  test('用户点「取消」→ 不重发，且保存按钮解禁（否则面板卡死）', async () => {
    const h = await openAndEdit({ ackQueue: [needsConfirm], confirmAnswer: false }, { PORT: '8080' });
    assert.equal(h.emitted.filter((e) => e.event === 'env:set').length, 1, '不该重发');
    assert.equal(h.dom.envConfigSave.disabled, false, '按钮必须能再点');
    assert.equal(h.saved.length, 0, '没保存就不该触发 onSaved');
  });
});

test.describe('env-config 保存流程 —— 失败时要有解释', () => {
  test('服务端只给 error 不给 results → 仍要显示原因，不能是空白框', async () => {
    // socket.js 的 catch-all 与「设备未批准」两条路径就是这个形状
    const h = await openAndEdit({ ackQueue: [{ ok: false, error: '设备未批准' }] }, { PORT: '8080' });
    // showResults 把结果框插在 body 里，断言只看那个框（整表文本会淹没它）
    const box = h.dom.envConfigBody.children.find((c) => textOf(c).includes('保存失败'));
    assert.ok(box, '应插入一个失败框');
    assert.match(textOf(box), /设备未批准/, `失败框不能只有标题，实际：${textOf(box)}`);
    assert.equal(h.dom.envConfigSave.disabled, false, '失败后可以重试');
  });

  test('有 results 时逐条列出', async () => {
    const h = await openAndEdit(
      { ackQueue: [{ ok: false, results: [{ key: 'PORT', level: 'error', message: '端口已被占用' }] }] },
      { PORT: '8080' }
    );
    const box = h.dom.envConfigBody.children.find((c) => textOf(c).includes('保存失败'));
    assert.ok(box, '应插入一个失败框');
    assert.match(textOf(box), /端口已被占用/);
  });
});

test.describe('env-config 保存流程 —— 重启入口取决于是否常驻托管', () => {
  const okAck = { ok: true, written: ['PORT'], results: [] };

  test('常驻托管 → 给「立即重启」按钮', async () => {
    const h = await openAndEdit({ ackQueue: [okAck], canRestart: () => true }, { PORT: '8080' });
    const btn = h.dom.envConfigFooter.children.find((c) => c.id === 'envConfigRestart');
    assert.ok(btn, '应插入重启按钮');
    assert.match(textOf(h.dom.envConfigHint), /重启后生效/);
  });

  test('★ 非常驻托管 → 不给按钮，且明说要到电脑上重启', async () => {
    const h = await openAndEdit({ ackQueue: [okAck], canRestart: () => false }, { PORT: '8080' });
    const btn = h.dom.envConfigFooter.children.find((c) => c.id === 'envConfigRestart');
    assert.equal(btn, undefined, '停掉一个没人会拉起的进程等于让用户自断退路');
    assert.match(textOf(h.dom.envConfigHint), /本进程不是常驻托管/);
  });

  // 重启会中断所有在跑的会话与后台任务。此前只测到「按钮在不在」，点下去弹的那个框没人看过——
  // 而它恰恰是把字符串当对象传、渲染出一个一个字都没有的确认框的地方。
  test('★ 点「立即重启」弹的确认框必须有字：破坏性操作配空白框，等于诱导用户直接点确定', async () => {
    const h = await openAndEdit({ ackQueue: [okAck], canRestart: () => true }, { PORT: '8080' });
    const btn = h.dom.envConfigFooter.children.find((c) => c.id === 'envConfigRestart');
    await btn.onclick();
    await settle();
    assert.equal(h.confirms.length, 1, '重启前必须问一次');
    const ask = h.confirms[0];
    assert.ok(ask.title, '标题不能为空');
    assert.match(`${ask.title} ${ask.body ?? ''}`, /会中断|interrupt/i, '要把后果说出来：所有正在跑的会话会被中断');
    assert.ok(CONFIRM_TONES.has(ask.tone), `tone 必须是 sheets.js 认得的值之一，收到 ${JSON.stringify(ask.tone)}`);
    assert.equal(h.emitted.filter((e) => e.event === 'dev:restart').length, 1, '确认后才真发');
  });

  test('重启确认点「取消」→ 一个 dev:restart 都不发', async () => {
    const h = await openAndEdit({ ackQueue: [okAck], canRestart: () => true, confirmAnswer: false }, { PORT: '8080' });
    const btn = h.dom.envConfigFooter.children.find((c) => c.id === 'envConfigRestart');
    await btn.onclick();
    await settle();
    assert.equal(h.emitted.filter((e) => e.event === 'dev:restart').length, 0);
  });

  test('保存成功会通知外部（onSaved），失败不会', async () => {
    const okH = await openAndEdit({ ackQueue: [okAck] }, { PORT: '8080' });
    assert.equal(okH.saved.length, 1);
    const badH = await openAndEdit({ ackQueue: [{ ok: false, error: 'x' }] }, { PORT: '8080' });
    assert.equal(badH.saved.length, 0);
  });
});
