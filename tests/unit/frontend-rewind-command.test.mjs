// tests/unit/frontend-rewind-command.test.mjs —— /rewind 面板确认失败后的模式按钮恢复
// 钉住：#404 —— confirm 失败/超时时 setModeButtons 必须带回 preview 的 canCode/canFork，
//       不得用默认 true 把原本禁用的「恢复代码*」/「只恢复对话」错误解锁。
// 槽位：S1（假 DOM + 假 socket，零 IO）

import assert from 'node:assert/strict';
import test from 'node:test';

import { createRewindCommandController } from '../../app/public/js/app/rewind-command.js';

function fakeEl(id = '') {
  const classes = new Set();
  const listeners = new Map();
  const el = {
    id,
    disabled: false,
    _textContent: '',
    _innerHTML: '',
    get textContent() { return el._textContent; },
    set textContent(v) { el._textContent = String(v); },
    get innerHTML() { return el._innerHTML; },
    set innerHTML(v) { el._innerHTML = String(v); },
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: c => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    // 测试触发用
    _emit(type, event) {
      for (const fn of listeners.get(type) || []) fn(event);
    },
  };
  return el;
}

function harness({
  candidates = {
    ok: true,
    items: [{
      promptUuid: 'u-1',
      text: 'first turn only code',
      changedFiles: 1,
      inheritedFromFork: false,
      canForkConversation: false,
      canRestoreCode: true,
    }],
  },
  preview = { ok: true, canRewind: true, canForkConversation: false, filesChanged: ['a.js'], dirtyOverlap: [] },
  confirmRes = { ok: false, error: 'boom' },
  sessionId = 's-1',
  cwd = '/w/a',
} = {}) {
  const dom = new Map();
  const byId = (id) => {
    if (!dom.has(id)) dom.set(id, fakeEl(id));
    return dom.get(id);
  };
  // 预先创建控制器会碰到的节点，避免 $ 懒建导致引用不一致
  for (const id of [
    'rewindModal', 'rewindList', 'rewindStep2', 'rewindTitle', 'rewindHint',
    'rewindPicked', 'rewindEffect', 'rewindFootnote', 'rewindBack', 'rewindCancel',
    'rewindModeBoth', 'rewindModeConversation', 'rewindModeCode',
  ]) byId(id);

  const replies = new Map([
    ['session:rewind:candidates', candidates],
    ['session:rewind:preview', preview],
    ['session:rewind:confirm', confirmRes],
  ]);
  const emitted = [];
  const socket = {
    emit: (event, payload, cb) => {
      emitted.push({ event, payload });
      queueMicrotask(() => cb?.(replies.get(event)));
    },
  };

  const ctl = createRewindCommandController({
    $: byId,
    socket,
    openSheet: () => {},
    closeSheet: () => {},
    getCurrentSession: () => ({ sessionId, cwd }),
    onRewound: () => {},
    emitTimeoutMs: 50,
  });

  return {
    ctl, byId, emitted,
    modeBoth: byId('rewindModeBoth'),
    modeConversation: byId('rewindModeConversation'),
    modeCode: byId('rewindModeCode'),
    listEl: byId('rewindList'),
  };
}

async function openAndPick(h, uuid = 'u-1') {
  await h.ctl.openPanel('s-1', '/w/a');
  // 等 candidates 回执把清单写好后，模拟点一行（控制器用 closest('[data-uuid]')）
  const row = {
    dataset: { uuid },
    closest: (sel) => (sel === '[data-uuid]' ? row : null),
  };
  h.listEl._emit('click', { target: row });
  // pick 里还有一次 preview await
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
}

test.describe('rewind confirm 失败：保留 preview 的 canCode/canFork', () => {
  test('canCode=true, canFork=false → 失败后「只恢复代码」仍可用，「对话」相关仍禁用', async () => {
    const h = harness({
      preview: { ok: true, canRewind: true, canForkConversation: false, filesChanged: ['a.js'], dirtyOverlap: [] },
      confirmRes: { ok: false, error: 'denied' },
    });
    await openAndPick(h);

    assert.equal(h.modeCode.disabled, false, 'preview 后应放开「只恢复代码」');
    assert.equal(h.modeConversation.disabled, true, '首轮不能分叉：只恢复对话应禁用');
    assert.equal(h.modeBoth.disabled, true, '首轮不能分叉：恢复代码和对话应禁用');

    h.modeCode._emit('click', {});
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    assert.equal(h.modeCode.disabled, false, '失败恢复后「只恢复代码」仍应可点');
    assert.equal(h.modeConversation.disabled, true,
      '失败恢复不得解锁「只恢复对话」——裸 setModeButtons(true) 的默认 forkEnabled=true 会犯这个错');
    assert.equal(h.modeBoth.disabled, true,
      '失败恢复不得解锁「恢复代码和对话」');
    assert.ok(h.byId('rewindEffect').innerHTML.includes('denied') || h.byId('rewindEffect').innerHTML.includes('text-danger'),
      '失败应留在面板里');
  });

  test('canCode=false, canFork=true → 失败后「只恢复对话」仍可用，代码相关仍禁用', async () => {
    const h = harness({
      candidates: {
        ok: true,
        items: [{
          promptUuid: 'u-2',
          text: 'no checkpoint',
          changedFiles: 0,
          inheritedFromFork: false,
          canForkConversation: true,
          canRestoreCode: false,
        }],
      },
      preview: { ok: true, canRewind: false, reason: 'no-checkpoint', canForkConversation: true, filesChanged: [], dirtyOverlap: [] },
      confirmRes: { ok: false, error: 'timeout-ish' },
    });
    await openAndPick(h, 'u-2');

    assert.equal(h.modeConversation.disabled, false);
    assert.equal(h.modeCode.disabled, true);
    assert.equal(h.modeBoth.disabled, true);

    h.modeConversation._emit('click', {});
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    assert.equal(h.modeConversation.disabled, false, '失败恢复后「只恢复对话」仍应可点');
    assert.equal(h.modeCode.disabled, true,
      '失败恢复不得解锁「只恢复代码」——裸 setModeButtons(true) 的默认 codeEnabled=true 会犯这个错');
    assert.equal(h.modeBoth.disabled, true);
  });
});

test.describe('#403 rewind 候选列表键盘可达', () => {
  test('可选项渲染为 button type=button，禁用项仍为 div', async () => {
    const h = harness({
      candidates: {
        ok: true,
        items: [
          {
            promptUuid: 'u-ok',
            text: 'reachable',
            changedFiles: 1,
            inheritedFromFork: false,
            canForkConversation: true,
            canRestoreCode: true,
          },
          {
            promptUuid: 'u-dead',
            text: 'disabled both axes',
            changedFiles: 0,
            inheritedFromFork: false,
            canForkConversation: false,
            canRestoreCode: false,
          },
        ],
      },
    });
    await h.ctl.openPanel('s-1', '/w/a');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const html = h.listEl.innerHTML;
    assert.match(html, /<button type="button"[^>]*data-uuid="u-ok"/,
      '可选轮次须是 button，才能进 sheets.js Tab 循环');
    assert.match(html, /<div class="[^"]*opacity-40/,
      '双轴都不可用的轮次仍用 div（不进 Tab）');
    assert.doesNotMatch(html, /<button[^>]*data-uuid="u-dead"/,
      '禁用轮次不得变成可聚焦 button');
  });
});
