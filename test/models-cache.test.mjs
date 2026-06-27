// test/models-cache.test.mjs —— 按 cwd 归键的模型清单缓存（零 token、纯逻辑）。
// 坐实核心不变量：cwd A 的模型清单【绝不】被 cwd B 的视图取到——这正是
// 「切工作区后新会话冒出上个工作区 deepseek 模型」bug 的正解。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelsCache } from '../models-cache.js';

const DS = { models: [{ value: 'opus', displayName: 'deepseek-v4-pro[1m]' }] };
const REAL = { models: [{ value: 'opus', displayName: 'Claude Opus 4.8' }] };

test.describe('models-cache：按 cwd 归键、不跨工作区泄漏', () => {
  test('未知 cwd → null（不是空对象、更不是别区清单）', () => {
    const c = createModelsCache();
    assert.equal(c.get('/ws/a'), null);
  });

  test('核心不变量：cwd A 的清单不会被 cwd B 的视图取到', () => {
    const c = createModelsCache();
    c.set('/ws/deepseek', DS);
    assert.equal(c.get('/ws/claude-chat-mobile'), null); // ← 截图 bug 的正解：别区视图取不到
    assert.deepEqual(c.get('/ws/deepseek'), DS);          // 本区视图照常取到
  });

  test('同 cwd 覆盖更新、不增长条目', () => {
    const c = createModelsCache();
    c.set('/ws/a', DS);
    c.set('/ws/a', REAL);
    assert.deepEqual(c.get('/ws/a'), REAL);
    assert.equal(c.size, 1);
  });

  test('cwd 落空被忽略（不进无键桶）', () => {
    const c = createModelsCache();
    c.set('', DS);
    c.set(null, DS);
    c.set(undefined, DS);
    assert.equal(c.size, 0);
    assert.equal(c.get(''), null);
  });

  test('有界：超上限淘汰最旧（防 cwd 异常漂移无界增长）', () => {
    const c = createModelsCache({ max: 3 });
    c.set('/a', DS); c.set('/b', DS); c.set('/c', DS); c.set('/d', DS);
    assert.equal(c.size, 3);
    assert.equal(c.get('/a'), null);       // 最旧被淘汰
    assert.deepEqual(c.get('/d'), DS);     // 最新保留
  });

  test('序列化往返：load(toJSON()) 保形（跨重启持久化）', () => {
    const c = createModelsCache();
    c.set('/ws/a', DS); c.set('/ws/b', REAL);
    const c2 = createModelsCache();
    c2.load(c.toJSON());
    assert.deepEqual(c2.get('/ws/a'), DS);
    assert.deepEqual(c2.get('/ws/b'), REAL);
  });

  test('load 容错：null/undefined/数组/字符串/旧单全局格式 都不抛、不污染', () => {
    const c = createModelsCache();
    c.load(null); c.load(undefined); c.load([1, 2, 3]); c.load('garbage');
    c.load({ models: [] }); // 旧 c.models 单全局格式（无 cwd 键）——values 是 payload 但 key 不是真 cwd
    assert.ok(c.get('/ws/a') === null); // 不会把旧格式误当某 cwd 的清单泄漏给真实 cwd
  });
});
