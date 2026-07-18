// tests/unit/client-log.test.mjs —— createClientLogger 持久化接线单测。
// localStorage/时钟是外部边界，注入 fake：验证恢复/节流写/flush/clear/异常兜底，不碰真 storage。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientLogger } from '../../public/js/app/client-log.js';
import { serializeClientLogs } from '../../public/js/logic.js';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    _map: map,
    throwOnSet: false,
    throwOnGet: false,
    getItem(k) { if (this.throwOnGet) throw new Error('blocked'); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { if (this.throwOnSet) throw new Error('quota'); map.set(k, v); },
  };
}
function fakeContext(now, { viewingInstanceId = null, currentModel = null } = {}) {
  return { dependencies: { now }, state: { viewingInstanceId, currentModel } };
}

test.describe('createClientLogger 持久化', () => {
  test('启动从 storage 恢复上次日志、打 restored 标记', () => {
    const prior = serializeClientLogs([{ ts: 1, type: 'client_conn', text: '上次连接', instanceId: null }]);
    const storage = fakeStorage({ ccm_client_logs: prior });
    const logger = createClientLogger(fakeContext(() => 5000), { storage });
    const e = logger.entries();
    assert.equal(e.length, 1);
    assert.equal(e[0].text, '上次连接');
    assert.equal(e[0].restored, true);
  });

  test('log 触发节流写：窗口内只写一次，间隔到再写，flush 强制写', () => {
    let t = 1000;
    const storage = fakeStorage();
    const logger = createClientLogger(fakeContext(() => t), { storage, persistIntervalMs: 2000 });
    let writes = 0;
    const orig = storage.setItem.bind(storage);
    storage.setItem = (k, v) => { writes++; orig(k, v); };

    logger.log('conn', 'a');          // lastPersist=null → 写
    assert.equal(writes, 1);
    logger.log('conn', 'b');          // t 未动、间隔未到 → 不写
    assert.equal(writes, 1);
    t = 3000;                          // 距上次 2000 到
    logger.log('conn', 'c');          // → 写
    assert.equal(writes, 2);
    logger.flush();                    // 强制
    assert.equal(writes, 3);
    // 落盘内容含全部三条
    const persisted = JSON.parse(storage._map.get('ccm_client_logs'));
    assert.deepEqual(persisted.entries.map(x => x.text), ['a', 'b', 'c']);
  });

  test('clear 清空并强制落盘：重建 logger 不再恢复旧条目', () => {
    const storage = fakeStorage();
    const l1 = createClientLogger(fakeContext(() => 1000), { storage });
    l1.log('conn', 'x');
    l1.flush();
    l1.clear();
    const l2 = createClientLogger(fakeContext(() => 2000), { storage });
    assert.equal(l2.entries().length, 0);
  });

  test('storage 抛异常（隐私模式/配额满）不影响日志功能', () => {
    const storage = fakeStorage();
    storage.throwOnGet = true;
    const logger = createClientLogger(fakeContext(() => 1000), { storage }); // 构造不崩
    storage.throwOnSet = true;
    assert.doesNotThrow(() => { logger.log('conn', 'x'); logger.flush(); });
    assert.equal(logger.entries().length, 1); // 内存仍在
  });

  test('无 storage（未注入）：退化为纯内存、不崩', () => {
    const logger = createClientLogger(fakeContext(() => 1000), {});
    assert.doesNotThrow(() => { logger.log('conn', 'x'); logger.flush(); logger.clear(); });
    assert.equal(logger.size(), 0);
  });

  test('send/recv 带 currentModel，其它类型不带', () => {
    const logger = createClientLogger(fakeContext(() => 1, { currentModel: 'opus', viewingInstanceId: 'inst_1' }), {});
    assert.equal(logger.log('send', 'hi').model, 'opus');
    assert.equal(logger.log('recv', 'yo').model, 'opus');
    assert.equal(logger.log('conn', 'c').model, undefined);
    assert.equal(logger.log('send', 'hi').instanceId, 'inst_1');
  });
});
