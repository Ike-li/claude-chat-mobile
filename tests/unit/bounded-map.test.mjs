// tests/unit/bounded-map.test.mjs —— Map 容量上限惯用法。
// 这个不变量是安全承诺（常驻进程的内存有界），不是风格问题：2026-08-03 抓到过 rlStates 的 cap
// 只做在一条写入路径上、另一条握手路径裸 set 绕过上限。收敛成函数后，测试也只需写一份。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setCapped, setLru } from '../../src/shared/bounded-map.js';

const keys = m => [...m.keys()];

test.describe('setCapped（FIFO）', () => {
  test('未满时只是写入', () => {
    const m = new Map();
    setCapped(m, 'a', 1, 3);
    setCapped(m, 'b', 2, 3);
    assert.deepEqual(keys(m), ['a', 'b']);
    assert.equal(m.get('b'), 2);
  });

  test('满了插新键 → 淘汰插入序最旧那条，size 稳定在 cap', () => {
    const m = new Map();
    for (const k of ['a', 'b', 'c']) setCapped(m, k, k, 3);
    setCapped(m, 'd', 'd', 3);
    assert.deepEqual(keys(m), ['b', 'c', 'd']);
    assert.equal(m.size, 3);
    setCapped(m, 'e', 'e', 3);
    assert.deepEqual(keys(m), ['c', 'd', 'e']);
  });

  test('重写已存在的键：不淘汰、不改位置、size 不变', () => {
    const m = new Map();
    for (const k of ['a', 'b', 'c']) setCapped(m, k, k, 3);
    setCapped(m, 'a', 'A', 3);
    assert.deepEqual(keys(m), ['a', 'b', 'c'], 'FIFO 下重写不该把 a 移到尾部');
    assert.equal(m.get('a'), 'A');
    assert.equal(m.size, 3);
  });

  // history.js 写路径契约（2026-08-04 review P1）：旧写法是「size>=cap 就先踢最旧再 set」，
  // 满表时对【已有】historyFile 做 mtime 失效重填也会误踢邻居、size 掉到 cap-1。
  // setCapped 只在「新键且已满」时淘汰——满表重写已有键必须保留全体邻居。
  test('满表重写已有键不踢邻居（history 写路径）', () => {
    const m = new Map();
    for (const k of ['a', 'b', 'c']) setCapped(m, k, `${k}-v1`, 3);
    setCapped(m, 'b', 'b-v2', 3); // mtime 失效回填
    assert.equal(m.size, 3, '满表重写不得把 size 打到 cap-1');
    assert.deepEqual(keys(m), ['a', 'b', 'c'], '邻居 a/c 必须还在；顺序也不因重写 b 而动');
    assert.equal(m.get('b'), 'b-v2');
    assert.equal(m.get('a'), 'a-v1');
    assert.equal(m.get('c'), 'c-v1');
  });

  test('返回同一引用（原地改，热路径不 clone）', () => {
    const m = new Map();
    assert.equal(setCapped(m, 'a', 1, 2), m);
  });
});

test.describe('setLru', () => {
  test('写入把键刷到尾部，淘汰最久未写的', () => {
    const m = new Map();
    for (const k of ['a', 'b', 'c']) setLru(m, k, k, 3);
    setLru(m, 'a', 'A', 3);                       // a 刷到尾部
    assert.deepEqual(keys(m), ['b', 'c', 'a']);
    setLru(m, 'd', 'd', 3);                       // 淘汰 b（现在最旧）而不是 a
    assert.deepEqual(keys(m), ['c', 'a', 'd']);
  });

  test('cap<=0 不空转（防御：while 循环必须能退出）', () => {
    const m = new Map();
    setLru(m, 'a', 1, 0);
    assert.equal(m.size, 0);
  });
});

// 两者的差别只在「重复写是否刷新位置」——这正是选哪个函数的唯一判据。
test('setCapped 与 setLru 的分野：重写已有键后谁先被淘汰', () => {
  const fifo = new Map();
  const lru = new Map();
  for (const k of ['a', 'b', 'c']) { setCapped(fifo, k, k, 3); setLru(lru, k, k, 3); }
  setCapped(fifo, 'a', 'A', 3);
  setLru(lru, 'a', 'A', 3);
  setCapped(fifo, 'd', 'd', 3);
  setLru(lru, 'd', 'd', 3);
  assert.deepEqual(keys(fifo), ['b', 'c', 'd'], 'FIFO：a 虽刚被写过仍最先淘汰');
  assert.deepEqual(keys(lru), ['c', 'a', 'd'], 'LRU：a 因刚写过而留下，b 被淘汰');
});
