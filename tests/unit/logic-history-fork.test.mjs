// tests/unit/logic-history-fork.test.mjs —— 历史消息「从这里分叉」纯逻辑（零 token）
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveForkAnchorUuid } from '../../public/js/logic.js';

test.describe('resolveForkAnchorUuid（历史消息分叉锚点）', () => {
  test('长按 assistant 气泡 → 用它自己的 uuid', () => {
    assert.equal(resolveForkAnchorUuid({ role: 'assistant', ownUuid: 'a-1', precedingAssistantUuid: 'a-0' }), 'a-1');
  });
  test('长按 user 气泡 → 忽略自身 uuid，改用前一条 assistant 的 uuid（"从这里重新问"语义）', () => {
    assert.equal(resolveForkAnchorUuid({ role: 'user', ownUuid: 'u-1', precedingAssistantUuid: 'a-0' }), 'a-0');
  });
  test('assistant 气泡缺自身 uuid（异常态）→ null', () => {
    assert.equal(resolveForkAnchorUuid({ role: 'assistant', ownUuid: null, precedingAssistantUuid: 'a-0' }), null);
  });
  test('user 气泡前面没有任何 assistant 回复（会话首条）→ null，禁用分叉', () => {
    assert.equal(resolveForkAnchorUuid({ role: 'user', ownUuid: 'u-1', precedingAssistantUuid: null }), null);
  });
  test('空入参安全', () => {
    assert.equal(resolveForkAnchorUuid(), null);
    assert.equal(resolveForkAnchorUuid({}), null);
  });
});
