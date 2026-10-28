// #392：composer / 与 @ 候选浮层键盘导航纯逻辑
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composerHintOptionId,
  moveComposerHintIndex,
  resolveComposerHintKeydown,
} from '../../app/public/js/logic.js';

test.describe('composerHintOptionId', () => {
  test('稳定 id，供 aria-activedescendant 引用', () => {
    assert.equal(composerHintOptionId('cmd', 0), 'ccm-hint-cmd-0');
    assert.equal(composerHintOptionId('at', 3), 'ccm-hint-at-3');
  });
});

test.describe('moveComposerHintIndex', () => {
  test('空列表 → -1', () => {
    assert.equal(moveComposerHintIndex(0, -1, 1), -1);
    assert.equal(moveComposerHintIndex(0, 0, -1), -1);
  });

  test('无当前选中：↓ → 0，↑ → 末项', () => {
    assert.equal(moveComposerHintIndex(3, -1, 1), 0);
    assert.equal(moveComposerHintIndex(3, -1, -1), 2);
    assert.equal(moveComposerHintIndex(3, 99, 1), 0);
  });

  test('两端环绕', () => {
    assert.equal(moveComposerHintIndex(3, 0, -1), 2);
    assert.equal(moveComposerHintIndex(3, 2, 1), 0);
    assert.equal(moveComposerHintIndex(3, 1, 1), 2);
  });
});

test.describe('resolveComposerHintKeydown', () => {
  test('关闭 / 空 / 组字中 → none', () => {
    assert.deepEqual(resolveComposerHintKeydown({ key: 'ArrowDown', open: false, optionCount: 3 }), { action: 'none' });
    assert.deepEqual(resolveComposerHintKeydown({ key: 'ArrowDown', open: true, optionCount: 0 }), { action: 'none' });
    assert.deepEqual(resolveComposerHintKeydown({ key: 'ArrowDown', open: true, optionCount: 3, composing: true }), { action: 'none' });
  });

  test('方向键移动', () => {
    assert.deepEqual(
      resolveComposerHintKeydown({ key: 'ArrowDown', open: true, optionCount: 3, activeIndex: -1 }),
      { action: 'move', nextIndex: 0 },
    );
    assert.deepEqual(
      resolveComposerHintKeydown({ key: 'ArrowUp', open: true, optionCount: 3, activeIndex: 0 }),
      { action: 'move', nextIndex: 2 },
    );
  });

  test('Enter：有高亮则 select，无高亮则 none（放行走发送）', () => {
    assert.deepEqual(
      resolveComposerHintKeydown({ key: 'Enter', open: true, optionCount: 2, activeIndex: 1 }),
      { action: 'select', nextIndex: 1 },
    );
    assert.deepEqual(
      resolveComposerHintKeydown({ key: 'Enter', open: true, optionCount: 2, activeIndex: -1 }),
      { action: 'none' },
    );
  });

  test('Escape → dismiss', () => {
    assert.deepEqual(
      resolveComposerHintKeydown({ key: 'Escape', open: true, optionCount: 1, activeIndex: 0 }),
      { action: 'dismiss' },
    );
  });

  test('其它键 → none', () => {
    assert.deepEqual(
      resolveComposerHintKeydown({ key: 'a', open: true, optionCount: 2, activeIndex: 0 }),
      { action: 'none' },
    );
  });
});
