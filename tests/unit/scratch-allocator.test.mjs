// tests/unit/scratch-allocator.test.mjs —— 「无文件夹」首条消息的 scratch 目录分配：并发的共用一个
//
// 懒开是「建目录 → 查当前会话 → 开实例」，中间有 await。两条并发的首条消息（连点发送、离线队列一口气
// 重发）若各建一个目录，下游按 cwd 的单飞就合不掉——各开一个会话，其中一个是用户没想要的空会话。
// 分配器让在途期间来的请求拿到同一个目录；全部释放之后，下一条才建新的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScratchAllocator } from '../../app/src/sessions/scratch-workspaces.js';

const counter = () => {
  let n = 0;
  return () => `/scratch/scratch-2026-09-24-00000${(n += 1)}`;
};

test('在途期间来的请求拿到同一个目录，只建一次', () => {
  let made = 0;
  const alloc = createScratchAllocator('/scratch', { create: () => { made += 1; return '/scratch/scratch-2026-09-24-AAAAAA'; } });
  const first = alloc.acquire();
  const second = alloc.acquire();
  assert.equal(second.cwd, first.cwd);
  assert.equal(made, 1);
});

test('全部释放之后，下一条消息建新目录（不把上一个会话的目录拿来复用）', () => {
  const alloc = createScratchAllocator('/scratch', { create: counter() });
  const a = alloc.acquire();
  const b = alloc.acquire();
  a.release();
  assert.equal(alloc.acquire().cwd, a.cwd, '还有一个在途：仍共用');
  b.release();
});

test('重复 release 不会把别人的租约一起放掉', () => {
  const alloc = createScratchAllocator('/scratch', { create: counter() });
  const a = alloc.acquire();
  const b = alloc.acquire();
  a.release();
  a.release();
  assert.equal(alloc.acquire().cwd, b.cwd, 'a 重复释放把计数扣到 0，b 还在途时下一条就会另建目录');
});

test('建目录抛错：不留下半个租约，下一次照常重试', () => {
  let fail = true;
  const alloc = createScratchAllocator('/scratch', {
    create: () => { if (fail) throw new Error('EACCES'); return '/scratch/scratch-2026-09-24-BBBBBB'; },
  });
  assert.throws(() => alloc.acquire(), /EACCES/);
  fail = false;
  assert.equal(alloc.acquire().cwd, '/scratch/scratch-2026-09-24-BBBBBB');
});

test('全部释放后再来：建的是新目录', () => {
  const alloc = createScratchAllocator('/scratch', { create: counter() });
  const a = alloc.acquire();
  a.release();
  assert.notEqual(alloc.acquire().cwd, a.cwd);
});
