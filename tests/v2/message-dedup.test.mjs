// tests/v2/message-dedup.test.mjs —— 同一 clientMessageId 对 Claude send 至多一次
// 守护：MSG-01、REL-01（两阶段提交 + in-flight claim/release）、SRV-001（FRESH 分支同样需要单飞去重）
// 覆盖：REL-01 两阶段提交（查询/提交分离）+ 并发 in-flight claim/release + SRV-001 FRESH 单飞并发去重
// 槽位：S1（纯函数 + 状态机 + 源码契约）
// 不测什么 + 为什么：不测真 Claude agent turn 与 socket 传输（分别属于 S2 server-message 与 S5 真 CLI 槽）

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isProcessed,
  commitProcessed,
  checkAndRecord,
  DEDUP_CAP,
  isInFlight,
  claimInFlight,
  releaseInFlight,
} from '../../app/src/agent/message-dedup.js';

test.describe('MSG-01: 查询与提交分离（BE-002: 校验/入队失败不得提前 commit）', () => {
  test('isProcessed 仅查询，多次调用零副作用', () => {
    const state = new Map();
    assert.equal(isProcessed('msg-101', state), false);
    assert.equal(isProcessed('msg-101', state), false);
    assert.equal(state.size, 0, '查询不得对状态产生任何修改');
  });

  test('commitProcessed 提交后 isProcessed 方判为 true', () => {
    let state = new Map();
    assert.equal(isProcessed('msg-102', state), false);
    state = commitProcessed('msg-102', state);
    assert.equal(isProcessed('msg-102', state), true);
  });

  test('失败路径不 commit → 客户端重发不被误判为 duplicate（防假成功丢消息核心回归）', () => {
    let state = new Map();
    // 第一次：尝试发送，校验或目标实例判断失败，未入队，不调用 commitProcessed
    assert.equal(isProcessed('msg-failed', state), false);

    // 第二次：客户端用同一 clientMessageId 重试，服务端必须仍判为未处理
    assert.equal(isProcessed('msg-failed', state), false);

    // 第三次：终于入队成功，调用 commitProcessed
    state = commitProcessed('msg-failed', state);
    assert.equal(isProcessed('msg-failed', state), true);
  });

  test('无 clientMessageId 或空字符串（旧客户端兼容）→ 不去重，恒 false，commit 原样返回', () => {
    const state = new Map();
    assert.equal(isProcessed(undefined, state), false);
    assert.equal(isProcessed(null, state), false);
    assert.equal(isProcessed('', state), false);

    assert.equal(commitProcessed(undefined, state), state);
    assert.equal(commitProcessed(null, state), state);
    assert.equal(commitProcessed('', state), state);
    assert.equal(state.size, 0);
  });

  test('commitProcessed 幂等：重复提交相同 ID 原样返回同一引用', () => {
    const state = new Map();
    const s1 = commitProcessed('msg-idem', state);
    const s2 = commitProcessed('msg-idem', s1);
    assert.equal(s1, s2, '重复提交必须原样返回引用');
    assert.equal(s2.size, 1);
  });

  test('超出 DEDUP_CAP 容量有界驱逐最旧的一条（近似 LRU，防内存无限增长）', () => {
    let state = new Map();
    const cap = 3;
    state = commitProcessed('m-0', state, cap);
    state = commitProcessed('m-1', state, cap);
    state = commitProcessed('m-2', state, cap);
    assert.equal(state.size, 3);

    // 写入第 4 条，最旧的 m-0 应被剔除
    state = commitProcessed('m-3', state, cap);
    assert.equal(state.size, 3);
    assert.equal(isProcessed('m-0', state), false, '最旧一条应被驱逐');
    assert.equal(isProcessed('m-1', state), true);
    assert.equal(isProcessed('m-2', state), true);
    assert.equal(isProcessed('m-3', state), true);
  });

  test('DEDUP_CAP 默认上限导出为正整数', () => {
    assert.equal(typeof DEDUP_CAP, 'number');
    assert.ok(DEDUP_CAP >= 100);
  });

  test('checkAndRecord 兼容原语：首次返回 duplicate=false，二次返回 duplicate=true', () => {
    const r1 = checkAndRecord('legacy-1', new Map());
    assert.equal(r1.duplicate, false);
    assert.ok(r1.next.has('legacy-1'));

    const r2 = checkAndRecord('legacy-1', r1.next);
    assert.equal(r2.duplicate, true);
    assert.equal(r2.next, r1.next);
  });
});

test.describe('MSG-01: 并发在途占用（in-flight claim / release）', () => {
  test('未占用时 isInFlight 为 false', () => {
    assert.equal(isInFlight('inflight-1', new Set()), false);
  });

  test('claimInFlight 后 isInFlight 变为 true', () => {
    let inflight = new Set();
    inflight = claimInFlight('inflight-1', inflight);
    assert.equal(isInFlight('inflight-1', inflight), true);
  });

  test('releaseInFlight 释放后恢复 false（无论处理成败都可安全释放）', () => {
    let inflight = new Set();
    inflight = claimInFlight('inflight-1', inflight);
    inflight = releaseInFlight('inflight-1', inflight);
    assert.equal(isInFlight('inflight-1', inflight), false);
  });

  test('claimInFlight 与 releaseInFlight 幂等性', () => {
    let inflight = new Set();
    const s1 = claimInFlight('inflight-1', inflight);
    const s2 = claimInFlight('inflight-1', s1);
    assert.equal(s1, s2, '重复 claim 应原样返回引用');

    const s3 = releaseInFlight('inflight-not-exist', s2);
    assert.equal(s3, s2, 'release 不存在的 ID 应原样返回引用');
  });

  test('不同 clientMessageId 的在途占用互不干扰', () => {
    let inflight = new Set();
    inflight = claimInFlight('id-a', inflight);
    inflight = claimInFlight('id-b', inflight);
    assert.equal(isInFlight('id-a', inflight), true);
    assert.equal(isInFlight('id-b', inflight), true);

    inflight = releaseInFlight('id-a', inflight);
    assert.equal(isInFlight('id-a', inflight), false);
    assert.equal(isInFlight('id-b', inflight), true, '释放 id-a 不得影响 id-b');
  });

  test('缺失或空 ID 时 in-flight 纯函数全部分支保持 no-op', () => {
    const s = new Set();
    assert.equal(isInFlight(undefined, s), false);
    assert.equal(isInFlight('', s), false);
    assert.equal(claimInFlight(undefined, s), s);
    assert.equal(claimInFlight('', s), s);
    assert.equal(releaseInFlight(undefined, s), s);
    assert.equal(releaseInFlight('', s), s);
  });
});

test.describe('MSG-01 & SRV-001: 生产代码关键顺序与并发懒开单飞收敛', () => {
  test('user:message 处理器中 commitProcessed 必须排在 send 成功后、且在所有副作用之前', () => {
    const src = readFileSync(new URL('../../app/src/server/app.js', import.meta.url), 'utf8');

    const sendFailedIdx = src.indexOf('if (!sent) {');
    assert.ok(sendFailedIdx > 0, '必须包含 send 失败判断分支');
    const finallyIdx = src.indexOf('} finally {', sendFailedIdx);
    assert.ok(finallyIdx > sendFailedIdx, '必须包含 finally 释放 in-flight 分支');

    const segment = src.slice(sendFailedIdx, finallyIdx);
    const commitIdx = segment.indexOf('commitProcessed(');
    assert.ok(commitIdx > 0, 'send 成功后必须调用 commitProcessed');

    const diagIdx = segment.indexOf('diagLog.record(');
    const takeOverIdx = segment.indexOf('mirrorEngine.takeOver(');
    const broadcastIdx = segment.indexOf('broadcastInstances(');

    assert.ok(commitIdx < diagIdx, 'commitProcessed 必须在 diagLog.record 之前');
    assert.ok(commitIdx < takeOverIdx, 'commitProcessed 必须在 mirrorEngine.takeOver 之前');
    assert.ok(commitIdx < broadcastIdx, 'commitProcessed 必须在 broadcastInstances 之前');
  });

  // SRV-001（FRESH 单飞键按 cwd 独立）2026-09-05 搬去 S2：
  //   tests/v2/server/message-ack.test.mjs 的「两个不同 cwd 的并发首发必须开出两个独立实例」。
  //
  // 原来这里是 readFileSync(app.js) + 正则匹配 `const key = resumeId || \`fresh:${cwd}\``。
  // 那种断言钉的是源码长什么样：改个变量名无故变红，保持文本不变而改坏行为照样绿。
  // 当时没有第二条路（组装根单测加载不了），S2 层起真 server 之后有了。
  //
  // 搬迁时的实测记录（两条都做过才算验收）：注入 `const key = resumeId;` 后 S2 用例变红、
  // 正常代码下绿。而第一版 S2 用例测的是「同一 cwd 并发只开一个」——注入后【照样绿】，
  // 因为两条 FRESH 请求的 resumeId 都是 undefined，撞在同一个键上单飞恰好仍生效。
  // fresh:${cwd} 防的是跨 cwd 塌陷，不是同 cwd 重复开。
});
