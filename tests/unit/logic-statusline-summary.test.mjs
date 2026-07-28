// statusline 折叠摘要 / 复制文案纯函数
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatStatuslineGitBrief,
  formatStatuslineCtxBrief,
  formatStatuslineCollapsedSummary,
  formatStatuslineCopyText,
} from '../../public/js/logic.js';

test('formatStatuslineGitBrief：分支 + 三分 + ahead', () => {
  assert.equal(
    formatStatuslineGitBrief({ branch: 'dev', staged: 2, modified: 1, untracked: 0, ahead: 54 }),
    'dev +2 !1 ↑54',
  );
  assert.equal(formatStatuslineGitBrief({ branch: 'main', changed: 3 }), 'main ✱3');
  assert.equal(formatStatuslineGitBrief(null), '');
});

test('formatStatuslineCtxBrief：优先百分比', () => {
  assert.equal(formatStatuslineCtxBrief({ usedPercent: 23.4, tokens: 45000 }), 'ctx 23%');
  assert.equal(formatStatuslineCtxBrief({ tokens: 12500 }), 'ctx 13k');
  assert.equal(formatStatuslineCtxBrief(null), '');
});

test('formatStatuslineCollapsedSummary：git · ctx；皆无 → statusline', () => {
  assert.equal(
    formatStatuslineCollapsedSummary({
      git: { branch: 'dev', ahead: 54 },
      ctx: { usedPercent: 42 },
      model: 'grok-4.5', // 故意有 model：折叠不吃
    }),
    'dev ↑54 · ctx 42%',
  );
  assert.equal(formatStatuslineCollapsedSummary({}), 'statusline');
  assert.equal(formatStatuslineCollapsedSummary({ model: 'x' }), 'statusline');
});

test('formatStatuslineCopyText：多行含 sid', () => {
  const text = formatStatuslineCopyText({
    git: { branch: 'dev', ahead: 1, repo: 'ike-li/claude-chat-mobile' },
    ctx: { usedPercent: 10 },
    model: 'grok-4.5',
    cost: 20.78,
    session: { id: '1eb0ef19-full-uuid' },
    source: { kind: 'sdk' },
  });
  assert.match(text, /dev ↑1 · ctx 10%/);
  assert.match(text, /model grok-4\.5/);
  assert.match(text, /sid 1eb0ef19-full-uuid/);
  assert.match(text, /source Web SDK/);
  assert.match(text, /est \$20\.78/);
});
