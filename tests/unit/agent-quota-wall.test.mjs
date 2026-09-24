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

// 自动续跑的输入面（app/src/agent/quota-auto-continue.js 的 planQuotaWall 吃的就是这份上报）。
// 判定本身在那边单测；这里只管 agent 有没有把判定需要的事实如实交出去。
test.describe('onQuotaWall：主循环撞墙上报给自动续跑', () => {
  const collect = () => {
    const walls = [];
    const { s, events } = makeSession({ onQuotaWall: w => walls.push(w) });
    s.q = { setModel() { return Promise.resolve(); } };
    return { s, events, walls };
  };
  const modelReply = text => ({
    type: 'assistant', uuid: `a-${text}`,
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] },
  });

  test('主循环 rate_limit 墙 → 上报一次：uuid + 原样 quotaLimits + 本轮是谁发起的', async () => {
    const { s, walls } = collect();
    await s.send('跑一个长任务');
    s.map(wallMessage(REAL_QUOTA, { uuid: 'wall-1' }));
    assert.equal(walls.length, 1);
    assert.equal(walls[0].uuid, 'wall-1', '到点前按它确认墙仍是 transcript 尾部');
    assert.deepEqual(walls[0].quota, REAL_QUOTA);
    assert.equal(walls[0].fallback, null);
    assert.equal(walls[0].turnOrigin, 'human');
    assert.equal(walls[0].turnHadOutput, false);
    s.dispose();
  });

  test('撞墙前本轮已有真模型输出 → turnHadOutput=true（空转熔断只数没产出的那种）', async () => {
    const { s, walls } = collect();
    await s.send('跑一个长任务');
    s.map(modelReply('先看一下目录'));
    s.map(wallMessage(REAL_QUOTA));
    assert.equal(walls[0].turnHadOutput, true);
    s.dispose();
  });

  test('<synthetic> 的非错误 assistant（「No response requested.」）不算产出', async () => {
    const { s, walls } = collect();
    await s.send('继续');
    s.map({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } });
    s.map(wallMessage(REAL_QUOTA));
    assert.equal(walls[0].turnHadOutput, false, '那是 CLI resume 时补的合成回复，零 token，算产出会让空转永不熔断');
    s.dispose();
  });

  test('产出标记不跨轮：上一轮干过活，这一轮一上来就撞墙 → false', async () => {
    const { s, walls } = collect();
    await s.send('第一轮');
    s.map(modelReply('第一轮的回复'));
    s.map({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1, num_turns: 1, total_cost_usd: 0 });
    await s.send('第二轮');
    s.map(wallMessage(REAL_QUOTA));
    assert.equal(walls[0].turnHadOutput, false);
    s.dispose();
  });

  test('续跑发出去的那一轮撞墙 → turnOrigin=auto-continuation', async () => {
    const { s, walls } = collect();
    await s.send('Your usage limit has reset. Continue …', undefined, { origin: 'auto-continuation' });
    s.map(wallMessage(REAL_QUOTA));
    assert.equal(walls[0].turnOrigin, 'auto-continuation');
    s.dispose();
  });

  test('墙没带 quotaLimits 时附上同一轮收到的 rejected rate_limit_event（老 CLI 形态）', async () => {
    const { s, walls } = collect();
    await s.send('x');
    const info = { status: 'rejected', resetsAt: todayAt(10), rateLimitType: 'five_hour' };
    s.map({ type: 'rate_limit_event', rate_limit_info: info });
    s.map(wallMessage(undefined));
    assert.equal(walls[0].quota, null);
    assert.deepEqual(walls[0].fallback, info);
    s.dispose();
  });

  test('上一轮收到的 rate_limit_event 不串到下一轮', async () => {
    const { s, walls } = collect();
    s.map({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: todayAt(10), rateLimitType: 'five_hour' } });
    await s.send('新的一轮');
    s.map(wallMessage(undefined));
    assert.equal(walls[0].fallback, null, '陈旧的重置时刻会让续跑在错误的时刻发出去');
    s.dispose();
  });

  test('子 agent 撞墙不上报：主循环可能还在跑，到点续跑会重做一件没停下来的事', async () => {
    const { s, walls } = collect();
    await s.send('x');
    s.map(wallMessage(REAL_QUOTA, { parent_tool_use_id: 'toolu_1', subagent_type: 'general-purpose' }));
    assert.equal(walls.length, 0);
    s.dispose();
  });

  test('非额度类 API 错误不上报', async () => {
    const { s, walls } = collect();
    await s.send('x');
    s.map({
      type: 'assistant', error: 'invalid_request', isApiErrorMessage: true, apiErrorStatus: 400,
      message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: bad request' }] },
    });
    assert.equal(walls.length, 0);
    s.dispose();
  });

  test('网关裸 429（rate_limit 但没有任何额度信息）照样上报，由判定层说明「无法自动继续」', async () => {
    const { s, walls } = collect();
    await s.send('x');
    s.map({
      type: 'assistant', error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 429 {"error":"quota exhausted"}' }] },
    });
    assert.equal(walls.length, 1);
    assert.equal(walls[0].quota, null);
    assert.equal(walls[0].fallback, null);
    s.dispose();
  });

  test('接收方抛异常不得从 map() 冒出去：消息泵会把它当流错误、中断整个会话', async () => {
    const { s, events } = makeSession({ onQuotaWall: () => { throw new Error('boom'); } });
    s.q = { setModel() { return Promise.resolve(); } };
    await s.send('x');
    const origError = console.error;
    console.error = () => {}; // 该条日志是预期内的，别污染测试输出
    try {
      assert.doesNotThrow(() => s.map(wallMessage(REAL_QUOTA)));
    } finally {
      console.error = origError;
    }
    assert.equal(errors(events).length, 1, '撞墙的 error 事件照发');
    s.dispose();
  });
});

test.describe('自动续跑发出的消息：归属如实标注', () => {
  test('以 auto-continuation 归属送进 SDK，不冒充人类键盘输入', async () => {
    const { s } = makeSession();
    s.q = { setModel() { return Promise.resolve(); } };
    assert.equal(await s.send('Your usage limit has reset. …', undefined, { origin: 'auto-continuation' }), true);
    const it = s.inputStream();
    const { value } = await it.next();
    assert.deepEqual(value.origin, { kind: 'auto-continuation' },
      'SDK 的 isHuman() 信任门据此放行关键词触发等；机器发的话标成 human 是伪造来源');
    await it.return();
    s.dispose();
  });

  test('user_message 事件带 origin，前端据此把这条气泡标成「自动继续」', async () => {
    const { s, events } = makeSession();
    s.q = { setModel() { return Promise.resolve(); } };
    await s.send('Your usage limit has reset. …', undefined, { origin: 'auto-continuation' });
    const um = events.find(e => e.type === 'user_message');
    assert.equal(um.payload.origin, 'auto-continuation');
    s.dispose();
  });

  test('普通发送：SDK 归属仍是 human，user_message 载荷不多出 origin 键', async () => {
    const { s, events } = makeSession();
    s.q = { setModel() { return Promise.resolve(); } };
    await s.send('hello');
    const it = s.inputStream();
    const { value } = await it.next();
    assert.deepEqual(value.origin, { kind: 'human' });
    await it.return();
    assert.equal('origin' in events.find(e => e.type === 'user_message').payload, false);
    s.dispose();
  });

  test('未知 origin 值不透传给 SDK：只认 auto-continuation，其余一律按 human', async () => {
    const { s } = makeSession();
    s.q = { setModel() { return Promise.resolve(); } };
    await s.send('hello', undefined, { origin: 'peer' });
    const it = s.inputStream();
    const { value } = await it.next();
    assert.deepEqual(value.origin, { kind: 'human' }, 'send() 的调用方只有两个，不给第三种来源开口子');
    await it.return();
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
