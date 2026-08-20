// 额度墙的第二条投递形态：assistant{error:'rate_limit', quotaLimits:{…}}。
//
// 背景（2026-08-20 真机）：一轮跑了 683 秒的活撞上 5 小时窗额度墙作废，但手机端把它渲染成「回合正常
// 完成」，正文还是 9 分钟前那条无关的旧回复——用户既不知道撞了墙，也不知道何时能继续，白等一场。
//
// 根因是 CLI 有两条投递路径而 ccm 只接了一条：
//   ① `rate_limit_event` 消息 → case 'rate_limit_event' 已处理，中文标签 + notice；
//   ② assistant 消息顶层的 `quotaLimits` → 主循环与子 agent 撞墙走这条，此前只落进泛化的
//      `if (msg.error)`，透传一句英文原文，结构化字段（额度类型/重置时刻/超额可用性）整个丢弃。
// 且 ② 之后 CLI 仍发 result{subtype:'success'}，前端据此收成功尾——这才是「显示成功」的由来。
//
// 下面的 quotaLimits 夹具逐字取自真机 transcript（CLI 2.1.235/2.1.236），不是构造的形状。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession } from '../helpers/agent-unit.mjs';

const notices = events => events.filter(e => e.type === 'system' && e.payload?.kind === 'notice');
const errors = events => events.filter(e => e.type === 'error');

// 时刻按「相对今天」构造：写死 unix 秒会让同日/跨日断言依赖测试的运行时刻（23:30 跑就翻车）。
const todayAt = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return Math.floor(d.getTime() / 1000); };
const daysLater = (n, h = 10) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(h, 0, 0, 0); return Math.floor(d.getTime() / 1000); };

// 真机形态：8/20 05:24 那条，除 resetsAt 外逐字照抄。
const REAL_QUOTA = Object.freeze({
  status: 'rejected',
  resetsAt: todayAt(10),
  unifiedRateLimitFallbackAvailable: false,
  rateLimitType: 'five_hour',
  overageStatus: 'rejected',
  overageDisabledReason: 'org_level_disabled',
  upgradePaths: ['upgrade_plan'],
  isUsingOverage: false,
});

const wallMessage = (quota, extra = {}) => ({
  type: 'assistant',
  error: 'rate_limit',
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  quotaLimits: quota,
  message: {
    role: 'assistant',
    model: '<synthetic>', // CLI 合成消息，不是真模型输出
    content: [{ type: 'text', text: "You've hit your session limit · resets 10am (America/Chicago)" }],
  },
  ...extra,
});

test.describe('主循环额度墙 — assistant{error:rate_limit} 带 quotaLimits', () => {
  test('发中文摘要：额度类型 + 重置时刻 + 超额不可用', () => {
    const { s, events } = makeSession();
    s.map(wallMessage(REAL_QUOTA));

    const [n] = notices(events);
    assert.ok(n, '应发出一条 notice（此前完全没有，这正是缺陷本身）');
    assert.equal(n.payload.level, 'warning');
    assert.match(n.payload.message, /已达会话额度上限/, 'five_hour 走 RATE_LIMIT_LABELS，与 rate_limit_event 口径一致');
    assert.match(n.payload.message, /10:00重置/, '英文原文的 "resets 10am" 要变成本地时钟');
    assert.match(n.payload.message, /超额用量不可用/, 'overage 被拒时「等重置」是唯一出路，必须说出来');
    s.dispose();
  });

  test('英文原文仍照旧透传给 error 事件（终端等价性不被摘要取代）', () => {
    const { s, events } = makeSession();
    s.map(wallMessage(REAL_QUOTA));

    const [e] = errors(events);
    assert.ok(e, 'error 事件不能因为加了摘要就消失');
    assert.match(e.payload.message, /hit your session limit/, '上游原文一字不动');
    assert.equal(e.payload.recoverable, true);
    s.dispose();
  });

  test('摘要排在 error 之前：error(p) 会 setBusy(false) 收束本轮', () => {
    const { s, events } = makeSession();
    s.map(wallMessage(REAL_QUOTA));

    const iNotice = events.findIndex(e => e.type === 'system' && e.payload?.kind === 'notice');
    const iError = events.findIndex(e => e.type === 'error');
    assert.ok(iNotice >= 0 && iError >= 0);
    assert.ok(iNotice < iError, '顺序颠倒会让摘要落在「已结束」的回合尾部，读起来像结束后又冒出新内容');
    s.dispose();
  });

  test('七天窗跨日重置补日期：只印 hh:mm 会被读成今天', () => {
    const { s, events } = makeSession();
    const at = daysLater(3, 10);
    s.map(wallMessage({ ...REAL_QUOTA, rateLimitType: 'seven_day', resetsAt: at }));

    const msg = notices(events)[0].payload.message;
    assert.match(msg, /已达周额度上限/);
    const d = new Date(at * 1000);
    assert.match(msg, new RegExp(`${d.getMonth() + 1}/${d.getDate()} 10:00重置`));
    s.dispose();
  });

  test('resetsAt 缺失/非法 → 降级成不带时刻，不崩也不印 1970', () => {
    for (const bad of [undefined, null, 0, -1, 'soon', NaN]) {
      const { s, events } = makeSession();
      s.map(wallMessage({ ...REAL_QUOTA, resetsAt: bad }));
      const msg = notices(events)[0]?.payload.message ?? '';
      assert.match(msg, /已达会话额度上限/, `resetsAt=${String(bad)} 仍要给出额度类型`);
      assert.doesNotMatch(msg, /1970|NaN|Invalid/, `resetsAt=${String(bad)} 不得漏出坏时间`);
      s.dispose();
    }
  });

  test('毫秒口径的 resetsAt 也归一（判错数量级比不显示更糟）', () => {
    const { s, events } = makeSession();
    s.map(wallMessage({ ...REAL_QUOTA, resetsAt: todayAt(10) * 1000 }));
    assert.match(notices(events)[0].payload.message, /10:00重置/);
    s.dispose();
  });

  test('未知 rateLimitType 回落「用量」，不把裸枚举名甩给用户', () => {
    const { s, events } = makeSession();
    s.map(wallMessage({ ...REAL_QUOTA, rateLimitType: 'some_future_window' }));
    const msg = notices(events)[0].payload.message;
    assert.match(msg, /已达用量上限/);
    assert.doesNotMatch(msg, /some_future_window/);
    s.dispose();
  });
});

test.describe('不该发摘要的情形 — 不制造噪音', () => {
  test('status 非 rejected（allowed/allowed_warning）不上屏：已有 status_line.rate 专用通道', () => {
    for (const status of ['allowed', 'allowed_warning']) {
      const { s, events } = makeSession();
      s.map(wallMessage({ ...REAL_QUOTA, status }));
      assert.equal(notices(events).length, 0, `status=${status} 重复上屏是噪音`);
      assert.equal(errors(events).length, 1, 'error 分支本身不受影响');
      s.dispose();
    }
  });

  test('非额度类 API 错误（无 quotaLimits）只发 error，不多一条 notice', () => {
    const { s, events } = makeSession();
    s.map({
      type: 'assistant', error: 'invalid_request', isApiErrorMessage: true, apiErrorStatus: 400,
      message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: bad request' }] },
    });
    assert.equal(notices(events).length, 0);
    assert.equal(errors(events).length, 1);
    s.dispose();
  });

  test('quotaLimits 是垃圾值不崩（字符串/数组/空对象）', () => {
    for (const junk of ['rejected', [], {}, 0, true]) {
      const { s, events } = makeSession();
      s.map(wallMessage(junk));
      assert.equal(notices(events).length, 0, `quotaLimits=${JSON.stringify(junk)} 不该产条`);
      assert.equal(errors(events).length, 1);
      s.dispose();
    }
  });
});

test.describe('子 agent 额度墙 — P0 守卫回归锚点', () => {
  const subWall = () => wallMessage(REAL_QUOTA, {
    parent_tool_use_id: 'toolu_011kJ2Br3CF74cyuSp7C6Ams',
    subagent_type: 'general-purpose',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Agent terminated early due to an API error: You\'ve hit your session limit · resets 10am (America/Chicago)' }],
    },
  });

  test('摘要拼在长段落之前：重置时刻不再淹没在 CLI 的英文长句里', () => {
    const { s, events } = makeSession();
    s.map(subWall());

    const [n] = notices(events);
    assert.ok(n);
    assert.match(n.payload.message, /子 agent general-purpose/);
    assert.match(n.payload.message, /已达会话额度上限，10:00重置/);
    assert.ok(
      n.payload.message.indexOf('已达会话额度上限') < n.payload.message.indexOf('terminated early'),
      '摘要必须在原文之前，否则一眼看不到「什么额度、几点恢复」',
    );
    s.dispose();
  });

  test('子 agent 撞墙绝不发 error 事件 —— 会把主轮次一起杀掉（code-review P0）', () => {
    const { s, events } = makeSession();
    s.map(subWall());
    assert.equal(errors(events).length, 0, '这道守卫一破，子 agent 的限流就会误杀整个主轮');
    s.dispose();
  });
});

test.describe('rate_limit_event 原通道不受影响', () => {
  test('rejected 仍走原措辞，两条路径口径一致', () => {
    const { s, events } = makeSession();
    s.map({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
    assert.match(notices(events)[0].payload.message, /已达会话额度上限/);
    s.dispose();
  });

  test('allowed 仍不上屏', () => {
    const { s, events } = makeSession();
    s.map({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } });
    assert.equal(notices(events).length, 0);
    s.dispose();
  });
});
