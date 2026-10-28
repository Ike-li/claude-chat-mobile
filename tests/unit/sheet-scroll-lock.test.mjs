// sheet-scroll-lock.js —— 设置面板与 sheets.js 共用的背景滚动锁引用计数。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireSheetScrollLock, releaseSheetScrollLock } from '../../app/public/js/app/sheet-scroll-lock.js';

function mkClassList() {
  const s = new Set();
  return {
    add(...c) { c.forEach(x => s.add(x)); },
    remove(...c) { c.forEach(x => s.delete(x)); },
    contains(c) { return s.has(c); },
    has(c) { return s.has(c); },
  };
}

function fakeDoc() {
  return {
    documentElement: { classList: mkClassList(), dataset: {} },
    body: { classList: mkClassList() },
  };
}

test('acquire/release：嵌套持有，最后一层才摘掉 ccm-sheet-open', () => {
  const doc = fakeDoc();
  acquireSheetScrollLock(doc);
  acquireSheetScrollLock(doc);
  assert.equal(doc.documentElement.dataset.ccmSheetLocks, '2');
  assert.ok(doc.body.classList.contains('ccm-sheet-open'));

  releaseSheetScrollLock(doc);
  assert.equal(doc.documentElement.dataset.ccmSheetLocks, '1');
  assert.ok(doc.body.classList.contains('ccm-sheet-open'), '还有一层持有时保持锁');

  releaseSheetScrollLock(doc);
  assert.equal(doc.documentElement.dataset.ccmSheetLocks, undefined);
  assert.equal(doc.body.classList.contains('ccm-sheet-open'), false);
  assert.equal(doc.documentElement.classList.contains('ccm-sheet-open'), false);
});

test('release 在计数已为 0 时是空操作（不抛、不负计数）', () => {
  const doc = fakeDoc();
  releaseSheetScrollLock(doc);
  releaseSheetScrollLock(doc);
  assert.equal(doc.documentElement.dataset.ccmSheetLocks, undefined);
  assert.equal(doc.body.classList.contains('ccm-sheet-open'), false);
});
