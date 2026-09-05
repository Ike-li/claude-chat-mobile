// tests/v2/attention.test.mjs —— 「需要你」跨会话聚合的读模型投影
// 守护：ALERT-01（待办轴只收「点一下就能处理」的事）在本层的可测部分
// 覆盖：审批/输入两维度的字段映射 + SS-005 跨维度去重 + 非法 awaitingSince 降级不丢会话
//       + needsYou 按等待时长升序（risk 不参与）+ others 的 cwd/lastActiveAt 二级排序 + 入参不可变
// 槽位：S1（纯函数，零 IO，不需要临时目录）
//
// 不测什么 + 为什么（两条边界，都是产品有意为之，非缺口）：
//  ① 终端会话「卡在审批框上」不进 needsYou —— 本层测不到。deriveAttention 的入参 sessionViews 由
//     app.js#computeNeedsYou 从【运行时 live agents】投影，纯终端会话根本不流经这个函数
//     （app.js:861 已如实登记该盲区）。ALERT-01 的这一半活在 session-registry 的
//     registryIndicatesTerminalWaiting / hasWaitingTerminalSessionForCwd，属另一个测点。
//     本文件能钉住的是它的结构性前提：status 非 'awaiting_input' 的会话一律落 others，不进待办轴。
//  ② TTL 过期过滤 —— 契约要求调用方先过滤（保持纯函数不依赖 Date.now()），不在本函数职责内。
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAttention } from '../../app/src/sessions/attention.js';

// 夹具字段照 app.js#computeNeedsYou 的真实投影形状写：审批项带 createdAt/risk/toolName，
// 会话项带 status/awaitingSince/lastActiveAt。字段名写错会让断言测到空气（fixture 编错契约恒绿）。
const approval = (over = {}) => ({
  sessionId: 's-ap', cwd: '/repo/a', title: 'Approval', createdAt: 1000,
  risk: undefined, toolName: 'Bash', ...over,
});
const session = (over = {}) => ({
  sessionId: 's-in', cwd: '/repo/a', title: 'Session', status: 'awaiting_input',
  awaitingSince: 2000, lastActiveAt: 500, ...over,
});

test.describe('审批维度：每项 pendingApproval 投影成一条待办', () => {
  test('字段映射：reason 固定 awaiting_approval，waitingSince 取 createdAt', () => {
    const { needsYou } = deriveAttention([], [approval({ createdAt: 1234 })]);
    assert.equal(needsYou.length, 1);
    assert.equal(needsYou[0].reason, 'awaiting_approval');
    assert.equal(needsYou[0].waitingSince, 1234, 'waitingSince 必须来自 createdAt，不是别的时间字段');
    assert.equal(needsYou[0].sessionId, 's-ap');
    assert.equal(needsYou[0].cwd, '/repo/a');
  });

  test('title / toolName 缺失归一为 null，不是 undefined（前端按 null 判空）', () => {
    const { needsYou } = deriveAttention([], [approval({ title: undefined, toolName: undefined })]);
    assert.equal(needsYou[0].title, null);
    assert.equal(needsYou[0].toolName, null);
    const fromNull = deriveAttention([], [approval({ title: null, toolName: null })]).needsYou[0];
    assert.equal(fromNull.title, null);
    assert.equal(fromNull.toolName, null);
  });

  test('空字符串 title / toolName 原样保留，不塌成 null（?? 与 || 在此不等价）', () => {
    // 归一只针对 null/undefined。写成 `||` 会把 '' 一并吞成 null，让「标题就是空串」和
    // 「没有标题」两种状态无法区分——本条即为钉住这个差异（变异 ??→|| 存活时发现的缺口）。
    const { needsYou } = deriveAttention([], [approval({ title: '', toolName: '' })]);
    assert.equal(needsYou[0].title, '', 'title 为空串时保留空串');
    assert.equal(needsYou[0].toolName, '', 'toolName 为空串时保留空串');
  });

  test('risk 原样透传，不自造分类（判定权归上游 SDK）', () => {
    const { needsYou } = deriveAttention([], [approval({ risk: 'high' })]);
    assert.equal(needsYou[0].risk, 'high');
    const plain = deriveAttention([], [approval({ risk: undefined })]).needsYou[0];
    assert.equal(plain.risk, undefined, '无上游分级来源时保持 undefined，不臆造默认值');
  });
});

test.describe('输入维度：只认 awaiting_input', () => {
  test('status === awaiting_input 且 awaitingSince 是数字 → 进待办轴', () => {
    const { needsYou, others } = deriveAttention([session({ awaitingSince: 300 })], []);
    assert.equal(needsYou.length, 1);
    assert.equal(needsYou[0].reason, 'awaiting_input');
    assert.equal(needsYou[0].waitingSince, 300);
    assert.equal(others.length, 0, '已进待办轴的会话不重复出现在 others');
  });

  test('ALERT-01 结构前提：非 awaiting_input 的会话一律落 others，绝不进待办轴', () => {
    // 待办轴只收「点一下就能处理」的事。终端 waiting、busy、idle 这类状态即便将来出现在
    // sessionViews 里，也必须走 others——顶栏 chip 上一条点开什么也做不了的待办比没有更坏。
    const sessions = [
      session({ sessionId: 'a', status: 'idle' }),
      session({ sessionId: 'b', status: 'busy' }),
      session({ sessionId: 'c', status: 'waiting' }),   // CLI registry 自报的终端等待
      session({ sessionId: 'd', status: 'shell' }),
    ];
    const { needsYou, others } = deriveAttention(sessions, []);
    assert.equal(needsYou.length, 0, '非 awaiting_input 的状态一个都不许进待办轴');
    assert.deepEqual(others.map(o => o.sessionId).sort(), ['a', 'b', 'c', 'd'], '但它们必须仍在 others 里可见');
  });

  test('awaitingSince 非数字 → 退出待办轴，但会话【仍留在 others】不得凭空消失', () => {
    // 数据不完整时若直接丢弃，用户会看到会话从列表里消失——比排序错更难排查。
    const sessions = [session({ sessionId: 'bad', awaitingSince: undefined })];
    const { needsYou, others } = deriveAttention(sessions, []);
    assert.equal(needsYou.length, 0, '无有效等待起点无法参与排序，不进待办轴');
    assert.deepEqual(others.map(o => o.sessionId), ['bad'], '降级不等于丢弃');
  });

  test('awaitingSince 是数字字符串也算非法（严格 typeof，不做隐式转换）', () => {
    const { needsYou, others } = deriveAttention([session({ awaitingSince: '2000' })], []);
    assert.equal(needsYou.length, 0);
    assert.equal(others.length, 1);
  });

  test('输入维度的空串 title 同样保留，与审批维度一致', () => {
    const { needsYou } = deriveAttention([session({ title: '' })], []);
    assert.equal(needsYou[0].title, '');
    const nullTitle = deriveAttention([session({ title: null })], []).needsYou[0];
    assert.equal(nullTitle.title, null);
  });
});

test.describe('SS-005：同一会话不得在两个维度各出现一次', () => {
  test('审批维度已占位的 sessionId，输入维度不再追加', () => {
    // 若去重失效，用户会看到同一会话两条待办，点掉一条另一条还在。
    const sid = 'dup';
    const { needsYou } = deriveAttention(
      [session({ sessionId: sid, awaitingSince: 5000 })],
      [approval({ sessionId: sid, createdAt: 1000 })],
    );
    assert.equal(needsYou.length, 1, '同一 sessionId 只能有一条待办');
    assert.equal(needsYou[0].reason, 'awaiting_approval', '保留审批维度那条（审批优先于输入）');
    assert.equal(needsYou[0].waitingSince, 1000);
  });

  test('被去重的会话也不会漏进 others（不重复不遗漏）', () => {
    const sid = 'dup';
    const { needsYou, others } = deriveAttention(
      [session({ sessionId: sid })],
      [approval({ sessionId: sid })],
    );
    assert.equal(needsYou.length, 1);
    assert.equal(others.length, 0, '已在待办轴的会话不得同时出现在 others');
  });
});

test.describe('排序：needsYou 按等得最久优先', () => {
  test('waitingSince 升序——值越小等得越久，排越前', () => {
    const { needsYou } = deriveAttention([], [
      approval({ sessionId: 'late', createdAt: 3000 }),
      approval({ sessionId: 'oldest', createdAt: 1000 }),
      approval({ sessionId: 'mid', createdAt: 2000 }),
    ]);
    assert.deepEqual(needsYou.map(n => n.sessionId), ['oldest', 'mid', 'late']);
  });

  test('risk 不参与排序：高风险但来得晚，仍排在等得久的后面', () => {
    // 已决：risk 只是展示标签。若误当排序键，等最久的那条会被挤到后面。
    const { needsYou } = deriveAttention([], [
      approval({ sessionId: 'risky-late', createdAt: 9000, risk: 'high' }),
      approval({ sessionId: 'safe-early', createdAt: 1000, risk: undefined }),
    ]);
    assert.deepEqual(needsYou.map(n => n.sessionId), ['safe-early', 'risky-late']);
  });

  test('两个维度混合时按同一把尺子排，不按维度分组', () => {
    const { needsYou } = deriveAttention(
      [session({ sessionId: 'input-early', awaitingSince: 500 })],
      [approval({ sessionId: 'ap-late', createdAt: 4000 })],
    );
    assert.deepEqual(needsYou.map(n => n.sessionId), ['input-early', 'ap-late'],
      '输入维度虽后追加，但因等得更久必须排前');
  });
});

test.describe('排序：others 按 cwd 字典序，同 cwd 内最近活跃优先', () => {
  test('先按 cwd 升序分组', () => {
    const { others } = deriveAttention([
      session({ sessionId: 'z', cwd: '/repo/z', status: 'idle' }),
      session({ sessionId: 'a', cwd: '/repo/a', status: 'idle' }),
      session({ sessionId: 'm', cwd: '/repo/m', status: 'idle' }),
    ], []);
    assert.deepEqual(others.map(o => o.cwd), ['/repo/a', '/repo/m', '/repo/z']);
  });

  test('同 cwd 内 lastActiveAt 降序（最近活跃在前）', () => {
    const { others } = deriveAttention([
      session({ sessionId: 'old', cwd: '/repo/a', status: 'idle', lastActiveAt: 100 }),
      session({ sessionId: 'new', cwd: '/repo/a', status: 'idle', lastActiveAt: 900 }),
    ], []);
    assert.deepEqual(others.map(o => o.sessionId), ['new', 'old']);
  });

  test('lastActiveAt 缺失按 0 处理，排在有值的之后而不是让排序崩掉', () => {
    const { others } = deriveAttention([
      session({ sessionId: 'nolast', cwd: '/repo/a', status: 'idle', lastActiveAt: undefined }),
      session({ sessionId: 'haslast', cwd: '/repo/a', status: 'idle', lastActiveAt: 1 }),
    ], []);
    assert.deepEqual(others.map(o => o.sessionId), ['haslast', 'nolast']);
  });
});

test.describe('纯函数性', () => {
  test('空输入返回两个空数组，不返回 undefined', () => {
    const r = deriveAttention([], []);
    assert.deepEqual(r, { needsYou: [], others: [] });
  });

  test('不修改入参数组（读模型投影，不得就地排序调用方的数组）', () => {
    const sessions = [
      session({ sessionId: 'b', cwd: '/repo/b', status: 'idle' }),
      session({ sessionId: 'a', cwd: '/repo/a', status: 'idle' }),
    ];
    const order = sessions.map(s => s.sessionId);
    deriveAttention(sessions, []);
    assert.deepEqual(sessions.map(s => s.sessionId), order, '入参顺序必须原样保留');
  });
});
