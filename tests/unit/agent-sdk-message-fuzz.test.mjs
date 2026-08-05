// tests/unit/agent-sdk-message-fuzz.test.mjs —— SDK 消息转译层的属性测试
//
// 【为什么是这里】2026-08-02 拿 npm run mutate 量了四个模块的杀死率：
//   logic.js 79%（存活弥散在格式化函数，健康）· history.js 71% · agent.js 62%（最弱）
// agent.js 的存活体几乎全压在 map() 这段 SDK 消息转译上（源文件 1666-2092 行）：
//   `msg.subtype === 'mirror_error'` 翻成 !== 没人管、`ev.delta?.type === 'text_delta' && ev.delta.text`
//   的 && 翻成 || 也没人管。原因很清楚——这层是【靠样例测的】（全仓 194 处手写 map() 夹具），
//   而样例只覆盖实际会出现的那几种形状。空 delta、错 subtype、字段类型不对，一个都没造过。
//
// 而这恰恰是最不该只靠样例测的地方：SDK 是会在我们脚下变的外部依赖（0.3.x 那次升级就是），
// 它的消息形状不是我们能定的契约。样例测的是「我见过的形状」，这里要测的是「没见过的形状不会把我搞坏」。
//
// 【断言的是不变量，不是具体输出】喂任意畸形消息，只要求：
//   1. map() 不抛 —— 抛了就是一条 SDK 消息掀翻整个会话循环
//   2. 只发契约内的事件类型 —— 前端 dispatcher 对未知 type 是【静默丢弃】，发错了没人知道。
//      注意运行时的 assertKnownEventType 只 console.error 不拦截（有意为之，见 agent.js 那段注释），
//      所以这条【必须】由测试来严，不能指望第 1 条兜住。
//   3. 信封可 JSON 序列化 —— 它要过 socket.io，带循环引用就是断线
//   4. sessionId 只能是 string|null —— 它是前端分流的路由键，成了对象就静默串台
//
// 【确定性】默认跑固定 seed 集，同样的输入每次都一样，CI 里不会飘。要扩大探索面就设
// CCM_FUZZ_SEEDS=200（本机跑，慢一点）。失败信息里带 seed + 原始消息，可直接复现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession } from '../helpers/agent-unit.mjs';
import { AGENT_EVENT_TYPES } from '../../src/shared/protocol.js';

const KNOWN_TYPES = new Set(AGENT_EVENT_TYPES);
const SEEDS = Number(process.env.CCM_FUZZ_SEEDS || 40);
const CASES_PER_SEED = 50;

// 确定性 PRNG（mulberry32）。不能用 Math.random：失败就没法复现，等于把 bug 变成灵异事件。
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 词汇表取自 map() 里真实分派的取值，外加同位置的"近似但不对"的东西。
// 纯随机垃圾大多落进 switch 的 default 什么也不做；有信息量的是【形状对、内容坏】的近似值。
const TYPES = ['system', 'stream_event', 'assistant', 'user', 'result', null, undefined, '', 123, {}, []];
const SUBTYPES = [
  'init', 'status', 'compact_boundary', 'task_notification', 'task_progress',
  'background_tasks_changed', 'task_started', 'task_updated', 'api_retry', 'informational',
  'mirror_error', 'notification', 'model_refusal_fallback', 'model_refusal_no_fallback',
  'thinking_tokens', 'local_command_output', null, undefined, '', 0, {}, [],
];
const NASTY = [
  null, undefined, '', 0, -1, NaN, Infinity, true, false, [], {},
  'x'.repeat(5000), { type: 'text' }, { type: 'text', text: '' }, [{ type: 'text' }],
  [null], { a: { b: { c: {} } } }, ' ', { length: -1 },
];
const FIELDS = [
  'session_id', 'task_id', 'tool_use_id', 'message', 'delta', 'event', 'model',
  'permissionMode', 'content', 'usage', 'modelUsage', 'compact_error', 'uuid',
  'parent_tool_use_id', 'subagent_type', 'status', 'tools', 'slash_commands',
];

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];

function junk(rand, depth = 0) {
  if (depth > 2) return pick(rand, NASTY);
  const roll = rand();
  if (roll < 0.55) return pick(rand, NASTY);
  if (roll < 0.8) return Array.from({ length: Math.floor(rand() * 3) }, () => junk(rand, depth + 1));
  const obj = {};
  for (const key of ['type', 'text', 'thinking', 'id', 'name', 'input', 'content', 'status', 'message']) {
    if (rand() < 0.5) obj[key] = junk(rand, depth + 1);
  }
  return obj;
}

function generateMessage(rand) {
  const msg = { type: pick(rand, TYPES) };
  if (rand() < 0.85) msg.subtype = pick(rand, SUBTYPES);
  for (const field of FIELDS) if (rand() < 0.45) msg[field] = junk(rand);
  return msg;
}

// 循环引用会让 JSON.stringify 抛，安全地截断打印
function describe(value) {
  try { return JSON.stringify(value)?.slice(0, 300) ?? String(value); }
  catch { return '(不可序列化)'; }
}

// 报错必须带【抛出位置】。第一版只报 message，结果拿到 "object is not iterable" 却不知道是哪一行，
// 只能靠手抄被截断的 msg 去复现——复现不出来。生成器是确定性的，但人不是；让失败信息自己说清楚。
function throwSite(err) {
  const frame = String(err?.stack || '').split('\n').find(line => line.includes('agent.js'));
  return frame ? frame.trim().replace(/^at\s+/, '') : '(无 agent.js 栈帧)';
}

function checkInvariants(msg, events, violations, where) {
  for (const envelope of events) {
    if (!KNOWN_TYPES.has(envelope.type)) {
      violations.push(`${where} 发出未登记的事件类型「${envelope.type}」`);
    }
    try { JSON.stringify(envelope); }
    catch (err) { violations.push(`${where} 信封无法 JSON 序列化（过不了 socket.io）：${err.message}`); }
    if (envelope.sessionId != null && typeof envelope.sessionId !== 'string') {
      violations.push(`${where} sessionId 不是 string|null，成了 ${describe(envelope.sessionId)}——它是前端分流的路由键`);
    }
  }
}

test('SDK 消息转译：任意畸形消息都不得让 map() 抛异常 / 发出未登记事件 / 造出不可序列化信封', () => {
  const violations = [];
  let cases = 0;

  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const rand = mulberry32(seed);
    for (let i = 0; i < CASES_PER_SEED; i += 1) {
      const msg = generateMessage(rand);
      const where = `[seed=${seed} case=${i}] msg=${describe(msg)}`;
      const { s, events, dispose } = makeSession();
      cases += 1;
      try {
        s.map(msg);
        checkInvariants(msg, events, violations, where);
      } catch (err) {
        violations.push(`${where}\n    map() 抛异常：${err.message}\n    抛出位置：${throwSite(err)}`);
      } finally {
        try { dispose(); } catch { /* dispose 失败不掩盖上面的违规 */ }
      }
      if (violations.length >= 5) break; // 前 5 条足够定位，不刷屏
    }
    if (violations.length >= 5) break;
  }

  assert.ok(cases > 0, '生成器必须真的产出用例');
  assert.deepEqual(violations, [], `\n${violations.join('\n')}\n`);
});

// 同一条消息连喂两次不得让第二次炸——SDK 重放/重连时会出现重复消息。
test('SDK 消息转译：重复投递同一条畸形消息，第二次同样不得抛', () => {
  const violations = [];
  for (let seed = 101; seed <= 110; seed += 1) {
    const rand = mulberry32(seed);
    for (let i = 0; i < 30; i += 1) {
      const msg = generateMessage(rand);
      const where = `[seed=${seed} case=${i}] msg=${describe(msg)}`;
      const { s, events, dispose } = makeSession();
      try {
        s.map(msg);
        s.map(msg);
        checkInvariants(msg, events, violations, where);
      } catch (err) {
        violations.push(`${where}\n    第二次投递抛异常：${err.message}\n    抛出位置：${throwSite(err)}`);
      } finally {
        try { dispose(); } catch { /* 同上 */ }
      }
      if (violations.length >= 5) break;
    }
    if (violations.length >= 5) break;
  }
  assert.deepEqual(violations, [], `\n${violations.join('\n')}\n`);
});

// F4（2026-08-03 review）：init 的 session_id 非法时，1719 行的守卫只护住 this.sessionId，
// onSessionId 却仍透传原始非法值——下游 app.js 会拿它 writeSessionEntrypoint（写出
// `undefined.jsonl` 垃圾文件）+ upsertSession（sessions.json 垃圾条目）。防御必须贯彻到回调。
test('SDK 消息转译：init 的 session_id 非法时不得调用 onSessionId', () => {
  for (const bad of [undefined, null, '', 123, {}, [], ['a']]) {
    const calls = [];
    const { s, dispose } = makeSession({ onSessionId: (...a) => calls.push(a) });
    try {
      s.map({ type: 'system', subtype: 'init', session_id: bad, model: 'm1' });
      assert.equal(calls.length, 0,
        `session_id=${JSON.stringify(bad)} 时 onSessionId 不应被调用（收到 ${JSON.stringify(calls)}）`);
    } finally {
      try { dispose(); } catch { /* noop */ }
    }
  }
});

// 防修过头：合法 session_id 照常触发（含参数原样透传）。
// 【为什么是两次】map() 入口的 _claimSessionIdEarly 先认领一次（本地 slash 命令下 init 可能晚到
// 100s+，见该方法注释），init 分支随后再触发一次——两次互补而非重复：第一次让前端立刻拿到
// sessionId（否则会话设置无 id、标题恒「新会话」），第二次补上早到消息不带的 model。
// 下游对重复调用免疫：writeSessionEntrypoint 有 getSession 守卫、upsertSession 的 model 走
// `if (model)` 才覆盖、recordCwdDefaultModel 判据含 `!!reportedModel`。
test('SDK 消息转译：init 的 session_id 合法时 onSessionId 照常触发', () => {
  const calls = [];
  const { s, dispose } = makeSession({ onSessionId: (...a) => calls.push(a) });
  try {
    s.map({ type: 'system', subtype: 'init', session_id: 'sid-legit-1', model: 'm1' });
    assert.equal(calls.length, 2, '早期认领 + init 补齐，两次都该在');
    assert.equal(calls[0][0], 'sid-legit-1');
    assert.equal(calls[0][2], undefined, '早期认领那次不带 model（早到消息没有模型名）');
    assert.equal(calls[1][0], 'sid-legit-1');
    assert.equal(calls[1][2], 'm1', 'init 那次必须带真实 model，否则 sessions.json 的模型名永远补不上');
  } finally {
    try { dispose(); } catch { /* noop */ }
  }
});
