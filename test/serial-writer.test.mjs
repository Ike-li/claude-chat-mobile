// test/serial-writer.test.mjs —— BE-012：单写者串行异步写原语（sessions/approval-store/audit 共用）。
// 覆盖：串行不并发 · 在飞期间多次请求合并成一个尾随写 · drain 排空 · fence 作废在飞写（shutdown 同步 flush 权威）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSerialWriter } from '../serial-writer.js';

const delay = (ms = 5) => new Promise(r => setTimeout(r, ms));
function deferred() { let resolve; const promise = new Promise(r => (resolve = r)); return { promise, resolve }; }

test.describe('createSerialWriter', () => {
  test('串行 + 合并：在飞期间多次 request 合并成一个尾随写，从不并发', async () => {
    let calls = 0, active = 0, maxActive = 0;
    const gates = [];
    const writer = createSerialWriter(async () => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      const g = deferred(); gates.push(g); await g.promise;
      active--;
    });
    writer.request();
    await delay();                 // loop 进入第一个 doWrite
    assert.equal(calls, 1);
    writer.request(); writer.request(); writer.request(); // 在飞期间三次
    gates[0].resolve();            // 第一个写完成 → loop 发现 pending → 启动【一个】合并尾随写
    await delay();
    assert.equal(calls, 2);        // 合并为 2（1 初始 + 1 尾随），而非 4
    gates[1].resolve();
    await writer.drain();
    assert.equal(calls, 2);
    assert.equal(maxActive, 1);    // 全程至多一个写在飞
  });

  test('drain：在飞与尾随写都完成后才 resolve', async () => {
    let done = 0;
    const writer = createSerialWriter(async () => { await delay(2); done++; });
    writer.request();
    await writer.drain();
    assert.equal(done, 1);
  });

  test('空闲时 drain 立即 resolve（无在飞写）', async () => {
    const writer = createSerialWriter(async () => {});
    await writer.drain(); // 不抛不挂
    assert.ok(true);
  });

  test('fence：作废在飞写（shouldCommit 转 false），让同步 flush 成为权威落地', async () => {
    let committedSeen = null;
    const g = deferred();
    const writer = createSerialWriter(async (shouldCommit) => {
      await g.promise;            // 写盘中……
      committedSeen = shouldCommit(); // rename 前校验
    });
    writer.request();
    await delay();                 // 进入 doWrite，卡在 g.promise
    writer.fence();                // 模拟 flushSaveSync：作废在飞写
    g.resolve();
    await writer.drain();
    assert.equal(committedSeen, false); // 被 fence → 不该提交（不覆盖同步权威写）
  });

  test('fence 不永久禁写：fence 后新的 request 仍能提交', async () => {
    const seen = [];
    const writer = createSerialWriter(async (shouldCommit) => { seen.push(shouldCommit()); });
    writer.fence();                // 先 fence
    writer.request();              // 之后的新写
    await writer.drain();
    assert.deepEqual(seen, [true]); // 新写未被旧 fence 波及
  });

  test('doWrite 抛错：onError 收到、循环不 wedge，后续写照常', async () => {
    const errors = [];
    let calls = 0;
    const writer = createSerialWriter(async () => { calls++; if (calls === 1) throw new Error('boom'); }, { onError: e => errors.push(e.message) });
    writer.request();
    await writer.drain();
    writer.request();              // 第一次抛错后仍能再写
    await writer.drain();
    assert.deepEqual(errors, ['boom']);
    assert.equal(calls, 2);
  });
});
