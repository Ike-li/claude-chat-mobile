// #370 / #366：纯函数侧 aria 文案
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveComposerDiscoverAriaDescription,
  formatTopContextPillAriaLabel,
} from '../../app/public/js/logic.js';

test('#370 resolveComposerDiscoverAriaDescription：仅 show 时给描述', () => {
  assert.equal(resolveComposerDiscoverAriaDescription({ show: false }), '');
  assert.equal(resolveComposerDiscoverAriaDescription({}), '');
  const desc = resolveComposerDiscoverAriaDescription({ show: true });
  assert.match(desc, /\/|@/);
  assert.ok(desc.length > 0);
});

test('#366 formatTopContextPillAriaLabel：无改动只报工作区名', () => {
  assert.equal(formatTopContextPillAriaLabel({ project: 'foo' }), '工作区 foo');
  assert.equal(formatTopContextPillAriaLabel({ project: '' }), '工作区 …');
  assert.equal(formatTopContextPillAriaLabel({}), '工作区 …');
});

test('#366 formatTopContextPillAriaLabel：有改动带数量', () => {
  assert.equal(
    formatTopContextPillAriaLabel({ project: 'foo', changesText: '3' }),
    '工作区 foo，3 处改动',
  );
  assert.equal(
    formatTopContextPillAriaLabel({ project: 'bar', changesText: '99+' }),
    '工作区 bar，99+ 处改动',
  );
  assert.equal(
    formatTopContextPillAriaLabel({ project: 'foo', changesText: '  ' }),
    '工作区 foo',
  );
});
