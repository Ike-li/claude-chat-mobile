// tests/unit/interaction.test.mjs —— interaction-log.js 纯逻辑单测
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ilog from '../../src/agent/interaction-log.js';

test.describe('interaction-log', () => {
  // enabled 在模块加载时由 LOG_INTERACTIONS 求值（运行中不可改）。用动态 import + 受控 env 测两个方向，
  // 不硬断言 false——否则机主 shell 常驻的 LOG_INTERACTIONS=1 会让本地 npm test 挂（此前真实发生过）。
  test('enabled=true 当 LOG_INTERACTIONS=1', async () => {
    const saved = process.env.LOG_INTERACTIONS;
    process.env.LOG_INTERACTIONS = '1';
    try {
      const mod = await import('../../src/agent/interaction-log.js?enabled-on');
      assert.equal(mod.enabled, true);
    } finally {
      if (saved === undefined) delete process.env.LOG_INTERACTIONS;
      else process.env.LOG_INTERACTIONS = saved;
    }
  });

  test('enabled=false 当 LOG_INTERACTIONS 未设', async () => {
    const saved = process.env.LOG_INTERACTIONS;
    delete process.env.LOG_INTERACTIONS;
    try {
      const mod = await import('../../src/agent/interaction-log.js?enabled-off');
      assert.equal(mod.enabled, false);
    } finally {
      if (saved === undefined) delete process.env.LOG_INTERACTIONS;
      else process.env.LOG_INTERACTIONS = saved;
    }
  });

  test('getSessionLogs：null sessionId → []', () => {
    assert.deepEqual(ilog.getSessionLogs(null), []);
    assert.deepEqual(ilog.getSessionLogs(undefined), []);
    assert.deepEqual(ilog.getSessionLogs(''), []);
  });

  test('getSessionLogs：不存在的 sessionId → []', () => {
    assert.deepEqual(ilog.getSessionLogs('nonexistent'), []);
  });

  test('addSessionLog + getSessionLogs：正常读写', () => {
    ilog.addSessionLog('s1', 'user_in', 'hello');
    const logs = ilog.getSessionLogs('s1');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].type, 'user_in');
    assert.equal(logs[0].text, 'hello');
    assert.ok(typeof logs[0].ts === 'number');
  });

  test('addSessionLog：多条追加 + 不同 session 隔离', () => {
    ilog.addSessionLog('s1', 'a', '1');
    ilog.addSessionLog('s1', 'b', '2');
    ilog.addSessionLog('s2', 'x', '3');
    assert.equal(ilog.getSessionLogs('s1').length, 3); // 2 new + 1 from previous test
    assert.equal(ilog.getSessionLogs('s2').length, 1);
  });

  test('addSessionLog：null sessionId → 不写入', () => {
    ilog.addSessionLog(null, 'x', 'y');
    assert.deepEqual(ilog.getSessionLogs(null), []);
  });

  test('addSessionLog：环形缓冲上限 100 条', () => {
    for (let i = 0; i < 150; i++) ilog.addSessionLog('buf-test', 'x', String(i));
    const logs = ilog.getSessionLogs('buf-test');
    assert.ok(logs.length <= 100);
    // 最旧的被挤出，保留最近 100 条
    assert.equal(logs[0].text, '50');  // 0-49 被挤出
    assert.equal(logs[99].text, '149');
  });

  test('setCallback：log 触发回调', () => {
    let called = null;
    ilog.setCallback((sid, entry) => { called = { sid, type: entry.type, text: entry.text }; });
    ilog.addSessionLog('cb-test', 'user_out', 'callback test');
    assert.ok(called);
    assert.equal(called.sid, 'cb-test');
    assert.equal(called.type, 'user_out');
    assert.equal(called.text, 'callback test');
    // 恢复
    ilog.setCallback(null);
  });

  test('userMessageIn → addSessionLog("user_in")', () => {
    ilog.userMessageIn('j1', 'inbound text');
    const logs = ilog.getSessionLogs('j1');
    const entry = logs.find(l => l.type === 'user_in');
    assert.ok(entry);
    assert.ok(entry.text.includes('inbound text'));
  });

  test('userMessageOut → addSessionLog("user_out")', () => {
    ilog.userMessageOut('j2', 'outbound text');
    const logs = ilog.getSessionLogs('j2');
    const entry = logs.find(l => l.type === 'user_out');
    assert.ok(entry);
    assert.ok(entry.text.includes('outbound text'));
  });

  test('agentSend → addSessionLog("agent_send")：model 走独立字段、text 不再含 model 前缀', () => {
    ilog.agentSend('j3', 'prompt text', 'opus');
    const logs = ilog.getSessionLogs('j3');
    const entry = logs.find(l => l.type === 'agent_send');
    assert.ok(entry);
    assert.equal(entry.model, 'opus');
    assert.ok(entry.text.includes('prompt text'));
    assert.ok(!entry.text.includes('model='));  // 前缀已移到独立 badge 字段
  });

  test('agentSend：model 缺省 → 字段兜底 default', () => {
    ilog.agentSend('j3b', 'text', null);
    const logs = ilog.getSessionLogs('j3b');
    const entry = logs.find(l => l.type === 'agent_send');
    assert.equal(entry.model, 'default');
  });

  test('agentResult → addSessionLog("agent_result")', () => {
    ilog.agentResult('j4', 'result text');
    const logs = ilog.getSessionLogs('j4');
    const entry = logs.find(l => l.type === 'agent_result');
    assert.ok(entry);
    assert.ok(entry.text.includes('result text'));
  });

  test('fmt：空/空白 → "(empty)"', () => {
    // 通过 userMessageIn 间接测试 fmt
    ilog.userMessageIn('fmt1', '');
    const logs = ilog.getSessionLogs('fmt1');
    const entry = logs.find(l => l.type === 'user_in');
    assert.equal(entry.text, '(empty)');
  });

  test('fmt：长文本截断 1500 字符', () => {
    const long = 'x'.repeat(2000);
    ilog.userMessageIn('fmt2', long);
    const logs = ilog.getSessionLogs('fmt2');
    const entry = logs.find(l => l.type === 'user_in');
    assert.ok(entry.text.length <= 1550); // 1500 + 截断后缀
    assert.ok(entry.text.includes('…'));
  });

  test('fmt：换行符替换为 \\\\n', () => {
    ilog.userMessageIn('fmt3', 'line1\nline2');
    const logs = ilog.getSessionLogs('fmt3');
    const entry = logs.find(l => l.type === 'user_in');
    assert.ok(entry.text.includes('\\n'));
    assert.ok(!entry.text.includes('\n'));
  });

  test('fmt：sanitize 脱敏', () => {
    // API key 应在日志中脱敏（sk-ant-* → ***，完全替换）
    ilog.userMessageIn('fmt4', 'key: sk-ant-test1234567890abcdef');
    const logs = ilog.getSessionLogs('fmt4');
    const entry = logs.find(l => l.type === 'user_in');
    // sk-ant-* 被 sanitize 完全替换为 ***
    assert.ok(!entry.text.includes('sk-ant-test'));
    assert.ok(!entry.text.includes('test1234567890abcdef'));
  });

  test('textDelta：不启用时不记日志', () => {
    ilog.textDelta('td1', 'some delta');
    // textDelta 仅在 enabled 时 console.log，总是 no-op for session buffers
    const logs = ilog.getSessionLogs('td1');
    assert.deepEqual(logs, []);
  });

  // ---- 模型 ID 独立字段（Web 交互日志 chip badge 数据源）----
  test('addSessionLog：model 参数 → entry.model（非空才带字段）', () => {
    ilog.addSessionLog('m1', 'user_in', 'hi', 'claude-opus-4-8');
    ilog.addSessionLog('m1', 'user_in', 'no-model');
    const logs = ilog.getSessionLogs('m1');
    assert.equal(logs[0].model, 'claude-opus-4-8');
    assert.equal(logs[1].model, undefined);  // 无 model → 不带字段，前端据此不渲染 chip
  });

  test('userMessageIn / userMessageOut：透传 model 到字段', () => {
    ilog.userMessageIn('m2', 'in', 'claude-sonnet-4-6');
    ilog.userMessageOut('m2', 'out', 'claude-sonnet-4-6');
    const logs = ilog.getSessionLogs('m2');
    assert.equal(logs.find(l => l.type === 'user_in').model, 'claude-sonnet-4-6');
    assert.equal(logs.find(l => l.type === 'user_out').model, 'claude-sonnet-4-6');
  });

  test('agentResult：透传 model 到字段', () => {
    ilog.agentResult('m3', 'result text', 'claude-opus-4-8');
    const entry = ilog.getSessionLogs('m3').find(l => l.type === 'agent_result');
    assert.equal(entry.model, 'claude-opus-4-8');
    assert.ok(entry.text.includes('result text'));
  });

  // ---- effort / permissionMode 独立 chip 字段（显示「那一刻」的档位）----
  test('addSessionLog：对象 meta → model/effort/permissionMode 各入独立字段', () => {
    ilog.addSessionLog('meta1', 'agent_send', 'txt', { model: 'claude-opus-4-8', effort: 'high', permissionMode: 'plan' });
    const e = ilog.getSessionLogs('meta1')[0];
    assert.equal(e.model, 'claude-opus-4-8');
    assert.equal(e.effort, 'high');
    assert.equal(e.permissionMode, 'plan');
  });

  test('addSessionLog：字符串 meta 仍兼容（旧调用只带 model）', () => {
    ilog.addSessionLog('meta2', 'user_in', 'txt', 'claude-sonnet-4-6');
    const e = ilog.getSessionLogs('meta2')[0];
    assert.equal(e.model, 'claude-sonnet-4-6');
    assert.equal(e.effort, undefined);
    assert.equal(e.permissionMode, undefined);
  });

  test('agentSend：effort/permissionMode 透传到独立字段', () => {
    ilog.agentSend('meta3', 'prompt', 'claude-opus-4-8', 'medium', 'acceptEdits');
    const e = ilog.getSessionLogs('meta3').find(l => l.type === 'agent_send');
    assert.equal(e.model, 'claude-opus-4-8');
    assert.equal(e.effort, 'medium');
    assert.equal(e.permissionMode, 'acceptEdits');
    assert.ok(!e.text.includes('effort='));  // 不再内联进 text
  });

  // 实时 session_log 广播 payload 契约：抽屉开着时走 agent:event 流式追加，
  // 必须带上 model/effort/permissionMode，否则 chip 只在 logs:get 重载时出现、直播时丢失。
  // 修前 server setCallback 只透传 type/text/ts，把 chip 字段静默剥掉。
  test('sessionLogPayload：透传 type/text/ts + 非空 chip 字段（直播广播用）', () => {
    const p = ilog.sessionLogPayload({
      ts: 42,
      type: 'agent_send',
      text: 'hi',
      model: 'grok-4.5',
      effort: 'max',
      permissionMode: 'bypassPermissions',
    });
    assert.deepEqual(p, {
      ts: 42,
      type: 'agent_send',
      text: 'hi',
      model: 'grok-4.5',
      effort: 'max',
      permissionMode: 'bypassPermissions',
    });
  });

  test('sessionLogPayload：缺省/空 chip 不带字段；空 entry → null', () => {
    assert.deepEqual(
      ilog.sessionLogPayload({ ts: 1, type: 'sys_info', text: 'x' }),
      { ts: 1, type: 'sys_info', text: 'x' },
    );
    assert.equal(ilog.sessionLogPayload(null), null);
    assert.equal(ilog.sessionLogPayload(undefined), null);
  });

  // FRESH 首轮：sessionId 未到前用 provisionalKey 缓冲，init 后 rebind 并入真 sessionId
  test('provisionalKey / rebindSessionLogs：首轮日志不丢', () => {
    const pk = ilog.provisionalKey('inst_fresh');
    assert.equal(pk, 'inst:inst_fresh');
    assert.equal(ilog.provisionalKey(null), null);

    ilog.addSessionLog(pk, 'user_in', 'first msg');
    ilog.addSessionLog(pk, 'agent_send', 'prompt');
    assert.equal(ilog.getSessionLogs(pk).length, 2);
    assert.deepEqual(ilog.getSessionLogs('real-sid'), []);

    ilog.rebindSessionLogs(pk, 'real-sid');
    assert.deepEqual(ilog.getSessionLogs(pk), [], 'provisional 键清空');
    const logs = ilog.getSessionLogs('real-sid');
    assert.equal(logs.length, 2);
    assert.equal(logs[0].type, 'user_in');
    assert.equal(logs[1].type, 'agent_send');

    // rebind 后继续写真 session 追加在后
    ilog.addSessionLog('real-sid', 'sys_info', 'got id');
    assert.equal(ilog.getSessionLogs('real-sid').length, 3);
    assert.equal(ilog.getSessionLogs('real-sid')[2].type, 'sys_info');
  });

  test('rebindSessionLogs：空/同键/无 pending → no-op 不抛', () => {
    ilog.rebindSessionLogs(null, 's');
    ilog.rebindSessionLogs('inst:x', null);
    ilog.rebindSessionLogs('inst:x', 'inst:x');
    ilog.rebindSessionLogs('inst:never-written', 's-empty');
    assert.deepEqual(ilog.getSessionLogs('s-empty'), []);
  });

  // 防 sessionBuffers 无界增长：常驻 server 长跑下，历史会话的日志缓冲会按 sessionId 无限累积
  // （每会话上限 100 条、但会话数无上限）。须给会话数也设 FIFO 上限（与 history/sessions 缓存同精神）。
  // 放最后：本用例创建大量 session 触发淘汰，会清掉前面用例的缓冲，故须在它们跑完后执行。
  test('addSessionLog：会话数超上限 → 最旧会话缓冲被 FIFO 淘汰（防 sessionBuffers 无界泄漏）', () => {
    for (let i = 0; i < 400; i++) ilog.addSessionLog(`lk-${i}`, 'x', 'd'); // 远超会话数上限(200)
    assert.deepEqual(ilog.getSessionLogs('lk-0'), [], '最旧会话缓冲应被淘汰');
    assert.equal(ilog.getSessionLogs('lk-399').length, 1, '最新会话缓冲应保留');
  });
});

// 日志两条通道此前互不相通：对话主干（user_in/user_out/agent_send/agent_result）由四个包装函数
// 各自 console.log 落进 ccm-server.log，而直接调 addSessionLog 的 17 处埋点（16 处 sys_info）
// **只进内存缓冲、重启即失**。后果是排障永远只拿半边：手机上看得到状态转换但重启就没了，
// 文件里翻得到对话却没有「会话何时启动/连接/拿到 ID」这些关键时间点。
test.describe('addSessionLog 落文件（A 通道补齐）', () => {
  function capture(fn) {
    const orig = console.log;
    const lines = [];
    console.log = (...a) => lines.push(a.map(String).join(' '));
    try { fn(); } finally { console.log = orig; }
    return lines;
  }

  test('sys_info 必须落文件（此前永不落盘）', () => {
    const lines = capture(() => {
      ilog.addSessionLog('sess-persist-1', 'sys_info', '[SYS] 启动/连接会话: instanceId=i1, cwd=/w');
    });
    assert.equal(lines.length, 1, 'sys_info 只进内存 → 重启即失，必须同时落文件');
    assert.match(lines[0], /sess-persist-1/, '要带 sessionId，否则文件里无法归属');
    assert.match(lines[0], /启动\/连接会话/);
  });

  test('四个包装函数已覆盖的类型不得在此重复打印', () => {
    for (const type of ['user_in', 'user_out', 'agent_send', 'agent_result']) {
      const lines = capture(() => ilog.addSessionLog('sess-persist-2', type, 'hi'));
      assert.equal(lines.length, 0, `${type} 由对应包装函数自己 console（带方向标记），这里再打就是双份`);
    }
  });
});

// F1（2026-08-10 子代理审查，已逐字节复现）：落盘前必须与四个包装函数同口径处理。
// 病灶：直接调 addSessionLog 的调用点传的是**未经处理的原始拼接串**，而 app.js:1498 把
// `firstMessage`（= 用户第一条消息全文，agent.js:615）拼了进去。于是新增的 console 会把
// 明文密钥、数千字正文、真实换行一起写进**长期留存并轮转归档**的 ccm-server.log——
// 而同一份内容经 userMessageOut 落盘的那一份是脱敏且截断的。
// 实测对比：新增行 3184 字节 + 明文 sk-ant-… ；既有行 1604 字节 + `***`。
test.describe('addSessionLog 落盘前的脱敏与截断', () => {
  function capture(fn) {
    const orig = console.log;
    const lines = [];
    console.log = (...a) => lines.push(a.map(String).join(' '));
    try { fn(); } finally { console.log = orig; }
    return lines;
  }

  test('明文密钥不得落进持久日志', () => {
    const payload = '把 ANTHROPIC_API_KEY=sk-ant-api03-AAAABBBBCCCCDDDD 写进 .env';
    const lines = capture(() => ilog.addSessionLog('sid-redact', 'sys_info', `[SYS] 标题="${payload}"`));
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /sk-ant-api03-AAAABBBB/, '公网部署，日志长期留存并归档，密钥绝不能明文落盘');
  });

  test('超长正文必须截断（首条消息可能是几百 KB 粘贴内容）', () => {
    const huge = 'X'.repeat(20000);
    const lines = capture(() => ilog.addSessionLog('sid-huge', 'sys_info', `[SYS] 标题="${huge}"`));
    assert.ok(Buffer.byteLength(lines[0]) < 3000, `单行 ${Buffer.byteLength(lines[0])} 字节：包装函数有 1500 硬顶正是为防这个`);
  });

  test('多行文本必须折行，否则破坏「一条记录一行 + 每行带时间戳」', () => {
    const multi = '第一行\n第二行\n第三行';
    const lines = capture(() => ilog.addSessionLog('sid-multi', 'sys_info', `[SYS] 标题="${multi}"`));
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes('\n'), 'installLogTimestamps 是按 console 调用加前缀，真实换行会摊出无时间戳的裸行');
  });
});

// F5（同批审查）：原有两条测试留了一整片无断言区间——测试 1 只喂 sys_info、测试 2 只喂那四个
// 包装类型，中间的其他类型无人断言。实测变异「把 !CONSOLE_BY_WRAPPER.has(type) 窄化成
// type === 'sys_info'」以及「格式串去掉 [type] 标记」都能全绿存活。
test.describe('落盘判据是「有无专属包装函数」而非「是不是 sys_info」', () => {
  function capture(fn) {
    const orig = console.log;
    const lines = [];
    console.log = (...a) => lines.push(a.map(String).join(' '));
    try { fn(); } finally { console.log = orig; }
    return lines;
  }

  test('任何没有专属 console 的类型都要落盘，并带 type 标记', () => {
    for (const type of ['sys_info', 'sys_warn', 'diag_note', 'x']) {
      const lines = capture(() => ilog.addSessionLog('sid-anytype', type, 'hello'));
      assert.equal(lines.length, 1, `${type} 同样只进内存、重启即失，判据不是类型名而是有没有包装函数`);
      assert.ok(lines[0].includes(`[${type}]`), `要带 [${type}] 标记，否则文件里分不清这行是什么事件`);
    }
  });
});
