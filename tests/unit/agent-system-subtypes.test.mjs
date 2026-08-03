// SDK system 子类型的自由文本打通（从 agent-events.test.mjs 拆出：事件映射与 system 子类型是两个行为域）。
//
// 背景：这批子类型全带用户可见正文（informational.content / mirror_error.error / notification.text /
// model_refusal_*.content / status.compact_error），此前一律撞 map() 的 else 兜底，只在交互日志里留
// 一行「未映射 system 子类型: X」——正文蒸发，手机端完全看不到 CLI 终端里能看到的信息。
//
// 为什么统一走 system/notice 而不是 error：前端 error(p) 会 finalizeStreams + failPendingToolCards +
// setBusy(false)，把非终态的提示当成回合终点，会错杀正在跑的轮次。notice 只落一条带级别的条。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession } from '../helpers/agent-unit.mjs';

const notices = events => events.filter(e => e.type === 'system' && e.payload?.kind === 'notice');

test.describe('map() — system 子类型的自由文本打通', () => {
  test('informational：content 上屏，level 沿用 SDK', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'informational', content: '当前模型已弃用，请切换', level: 'warning' });

    const [n] = notices(events);
    assert.ok(n, '应发出 notice');
    assert.equal(n.payload.message, '当前模型已弃用，请切换');
    assert.equal(n.payload.level, 'warning');
    s.dispose();
  });

  test('informational：缺 level → info；空 content 不发（不产空条）', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'informational', content: '提示正文' });
    assert.equal(notices(events)[0].payload.level, 'info');

    const before = notices(events).length;
    s.map({ type: 'system', subtype: 'informational', content: '   ' });
    assert.equal(notices(events).length, before, '空白正文不应产生 notice');
    s.dispose();
  });

  test('mirror_error：error 字段上屏，级别 warning', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'mirror_error', error: 'transcript 落盘失败：EACCES' });

    const [n] = notices(events);
    assert.ok(n.payload.message.includes('EACCES'));
    assert.equal(n.payload.level, 'warning');
    s.dispose();
  });

  // 严重度只认 color，不认 priority。实测 CLI bundle：priority 与 color 正交——
  // immediate 出现 53 次仅 5 次带 color，high 出现 26 次一次都不带，medium 反而有带 warning 的。
  // sdk.d.ts 也写明 priority 是「REPL notification queue (key/priority/timeout)」的队列语义。
  test('notification：严重度取自 color', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'notification', text: '安装失败', priority: 'immediate', color: 'error' });
    assert.equal(notices(events)[0].payload.message, '安装失败');
    assert.equal(notices(events)[0].payload.level, 'error');

    s.map({ type: 'system', subtype: 'notification', text: '额度将用尽', priority: 'medium', color: 'warning' });
    assert.equal(notices(events)[1].payload.level, 'warning', 'medium 也能是 warning——严重度不由 priority 决定');
    s.dispose();
  });

  test('notification：高 priority 但无 color → 仍是中性 info（immediate 多为普通公告）', () => {
    const { s, events } = makeSession();
    // 实测 CLI 里 priority:"immediate" 大量用于「Fast mode is now available」这类普通公告
    s.map({ type: 'system', subtype: 'notification', text: 'Fast mode 已可用', priority: 'immediate' });
    assert.equal(notices(events)[0].payload.level, 'info', 'immediate 是队列优先级，不是严重度');

    s.map({ type: 'system', subtype: 'notification', text: '后台索引完成', priority: 'high' });
    assert.equal(notices(events)[1].payload.level, 'info');
    s.dispose();
  });

  test('notification：未知 color 不误判成警告', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'notification', text: '任务成功', color: 'success' });
    assert.equal(notices(events)[0].payload.level, 'info');
    s.dispose();
  });

  test('model_refusal_fallback：content + api_refusal_explanation 都保留', () => {
    const { s, events } = makeSession();
    s.map({
      type: 'system',
      subtype: 'model_refusal_fallback',
      content: '已回落到备用模型',
      api_refusal_explanation: '原模型拒绝了该请求',
    });

    const [n] = notices(events);
    assert.ok(n.payload.message.includes('已回落到备用模型'));
    assert.ok(n.payload.message.includes('原模型拒绝了该请求'), '拒绝原因是关键诊断信息，不能丢');
    assert.equal(n.payload.level, 'warning');
    s.dispose();
  });

  test('model_refusal_no_fallback：只有 explanation 也能上屏', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'model_refusal_no_fallback', api_refusal_explanation: '无可用备用模型' });
    assert.ok(notices(events)[0].payload.message.includes('无可用备用模型'));
    s.dispose();
  });

  test('status/compact_error：压缩失败正文上屏（旧判据只认 compacting，会漏掉）', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'status', status: 'compacting' });
    // 既有行为不回归：compacting 仍走普通 system（无 kind）
    assert.equal(notices(events).length, 0);
    assert.ok(events.some(e => e.type === 'system' && !e.payload?.kind));

    s.map({ type: 'system', subtype: 'status', compact_result: 'failed', compact_error: '上下文过长，压缩失败' });
    const [n] = notices(events);
    assert.ok(n, 'compact_error 应发 notice');
    assert.ok(n.payload.message.includes('上下文过长'));
    assert.equal(n.payload.level, 'warning');
    s.dispose();
  });

  test('status：同时带 compacting 与 compact_error 时，失败不被「正在压缩…」截胡', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'status', status: 'compacting', compact_error: '压缩超时' });
    const [n] = notices(events);
    assert.ok(n, '带 compact_error 就该走失败分支');
    assert.ok(n.payload.message.includes('压缩超时'));
    assert.equal(events.filter(e => e.payload?.message === '正在压缩会话上下文…').length, 0);
    s.dispose();
  });

  test('已打通的子类型不再落「未映射」交互日志', () => {
    const { s, events } = makeSession();
    for (const msg of [
      { type: 'system', subtype: 'informational', content: 'a' },
      { type: 'system', subtype: 'mirror_error', error: 'b' },
      { type: 'system', subtype: 'notification', text: 'c' },
      { type: 'system', subtype: 'model_refusal_fallback', content: 'd' },
    ]) s.map(msg);

    const logged = events.filter(e => e.type === 'session_log'
      && String(e.payload?.text || '').includes('未映射'));
    assert.equal(logged.length, 0, `不应再有未映射日志：${JSON.stringify(logged)}`);
    s.dispose();
  });

  test('真正未知的子类型仍走兜底，不被新分支吞掉', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'brand_new_thing_2027' });
    assert.equal(notices(events).length, 0);
    s.dispose();
  });

  test('notice 是常规事件：进 buffer、占 seq（重连要能回放）', () => {
    const { s, events } = makeSession();
    const bufBefore = s.buffer.length;
    s.map({ type: 'system', subtype: 'informational', content: '值得回放的提示' });

    assert.equal(s.buffer.length, bufBefore + 1, 'notice 应进 replay buffer');
    assert.equal(notices(events)[0].transient, undefined, 'notice 不是 transient');
    s.dispose();
  });
});

// SDK 的 SDKLocalCommandOutputMessage（sdk.d.ts）契约原话：「Output from a local slash command
// (e.g. /voice, /usage). Displayed as assistant-style text in the transcript.」
//
// 真机病灶（2026-08-03）：手机上发 /code-review，命令实际跑满 13 分钟、结果完整落盘（46 commits /
// 110 文件），web 端却全程零显示——这条子类型撞了 map() 的 else 兜底，只留一行「未映射」交互日志，
// 于是被判成「slash 命令不能用」。同一条路上还有 /usage、/context、/insights 等一大批本地命令。
//
// 为什么不走 system/notice：emitNotice 会 truncate 到 TOOL_SUMMARY_CAP(600)，前端 system(p) 又渲染成
// 单行系统横条——而这里的正文可达数 KB 的 markdown + JSON。走 text_delta 才有气泡 + markdown 渲染 +
// 复制按钮，正合 SDK 那句 "assistant-style text"。
test.describe('map() — local_command_output（本地 slash 命令输出）', () => {
  const bubbles = events => events.filter(e => e.type === 'text_delta');

  test('stdout 包装被剥掉，正文进气泡流（主链，不落子 agent 卡）', () => {
    const { s, events } = makeSession();
    s.map({
      type: 'system', subtype: 'local_command_output', uuid: 'u1',
      content: '<local-command-stdout>命令输出正文</local-command-stdout>',
    });

    const [b] = bubbles(events);
    assert.ok(b, '应发出 text_delta');
    assert.equal(b.payload.text, '命令输出正文');
    assert.ok(!b.payload.parentToolUseId, '属主链，不能被 isSubagentPayload 收进折叠卡');
    s.dispose();
  });

  test('两条输出落两个独立气泡，不串成一条', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'local_command_output', uuid: 'u1', content: '<local-command-stdout>第一条</local-command-stdout>' });
    s.map({ type: 'system', subtype: 'local_command_output', uuid: 'u2', content: '<local-command-stdout>第二条</local-command-stdout>' });

    const [a, b] = bubbles(events);
    assert.notEqual(a.payload.messageId, b.payload.messageId, '不同命令输出须是不同气泡');
    s.dispose();
  });

  // 这条守着「不能改回 emitNotice」：600 是 TOOL_SUMMARY_CAP，code-review 的结果远超它。
  test('长正文完整送达，不被 TOOL_SUMMARY_CAP 截断', () => {
    const { s, events } = makeSession();
    const long = 'x'.repeat(5000);
    s.map({ type: 'system', subtype: 'local_command_output', uuid: 'u1', content: `<local-command-stdout>${long}</local-command-stdout>` });

    assert.equal(bubbles(events)[0].payload.text.length, 5000, 'review 结果是数 KB 的，截断等于没修');
    s.dispose();
  });

  test('stderr：正文照样上屏，另叠一条 warning 让失败可见', () => {
    const { s, events } = makeSession();
    s.map({
      type: 'system', subtype: 'local_command_output', uuid: 'u1',
      content: '<local-command-stderr>命令失败：EACCES</local-command-stderr>',
    });

    assert.ok(bubbles(events)[0].payload.text.includes('EACCES'), '失败正文也要能看到全文');
    const [n] = notices(events);
    assert.ok(n, 'stderr 应额外标一条 warning');
    assert.equal(n.payload.level, 'warning');
    s.dispose();
  });

  // sdk.d.ts 只保证 content 是 string，没保证一定带包装标签
  test('无包装标签的裸正文原样上屏，且不当成失败', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'local_command_output', uuid: 'u1', content: '裸正文' });
    assert.equal(bubbles(events)[0].payload.text, '裸正文');
    // 无包装 ≠ 失败。判错了每条这样的输出都会多挂一条「执行失败」警告条（变异检查抓到的空过点）。
    assert.equal(notices(events).length, 0);
    s.dispose();
  });

  test('空正文 / 只有空包装 → 不产空气泡', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'local_command_output', uuid: 'u1', content: '<local-command-stdout>   </local-command-stdout>' });
    s.map({ type: 'system', subtype: 'local_command_output', uuid: 'u2', content: '' });
    s.map({ type: 'system', subtype: 'local_command_output', uuid: 'u3' });
    assert.equal(bubbles(events).length, 0);
    s.dispose();
  });

  test('不再落「未映射」交互日志', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'local_command_output', uuid: 'u1', content: '<local-command-stdout>x</local-command-stdout>' });
    assert.equal(
      events.filter(e => e.type === 'session_log' && String(e.payload?.text || '').includes('未映射')).length,
      0,
    );
    s.dispose();
  });
});

// 「静默长跑」提示：CLI 内置 skill 的 getContext() 在非交互会话恒返回 "fork"，整条命令跑在独立上下文里、
// 主链一条消息都不投。真机上 /code-review 静默跑了 13 分钟，用户两次以为卡死点了停止（2026-08-03）。
test.describe('slash 命令静默长跑提示', () => {
  const quiet = events => notices(events).filter(n => n.payload.message.includes('独立上下文'));
  const tick = ms => new Promise(r => setTimeout(r, ms));

  test('slash 命令整轮零事件 → 到点提示一次', async () => {
    const { s, events } = makeSession({ slashQuietNoticeMs: 20 });
    await s.send('/code-review 看看这个分支');
    await tick(60);

    assert.equal(quiet(events).length, 1, '静默轮该提示');
    assert.equal(quiet(events)[0].payload.level, 'info', '这不是错误，别用告警色吓人');
    s.dispose();
  });

  test('普通消息不提示（长思考是正常形态）', async () => {
    const { s, events } = makeSession({ slashQuietNoticeMs: 20 });
    await s.send('帮我看看这段代码');
    await tick(60);
    assert.equal(quiet(events).length, 0);
    s.dispose();
  });

  test('本轮有内容事件到达 → 撤表，不提示（秒回的 /context 等看不到它）', async () => {
    const { s, events } = makeSession({ slashQuietNoticeMs: 40 });
    await s.send('/context');
    s.map({ type: 'system', subtype: 'local_command_output', uuid: 'u1', content: '<local-command-stdout>上下文用量…</local-command-stdout>' });
    await tick(90);
    assert.equal(quiet(events).length, 0);
    s.dispose();
  });

  // task_progress / api_retry 走 emitTransient（瞬时旁路，不进 buffer、不占 seq），压根不经过 emit()。
  // 撤表检查只挂在 emit() 上的话，它们在 SLASH_QUIET_BREAKERS 里就是死条目——注释说算「有动静」、
  // 代码从不生效。api_retry 尤其要紧：上游限流重试期间本来就久无别的事件，那是在动不是卡死。
  test('瞬时旁路事件（api_retry / task_progress）同样撤表', async () => {
    const { s, events } = makeSession({ slashQuietNoticeMs: 40 });
    await s.send('/code-review');
    s.emitTransient('api_retry', { attempt: 1 });
    await tick(90);
    assert.equal(quiet(events).length, 0, '上游在重试 ≠ 卡死，不该提示');
    s.dispose();
  });

  test('瞬时旁路的 task_progress 也撤表（后台任务在动）', async () => {
    const { s, events } = makeSession({ slashQuietNoticeMs: 40 });
    await s.send('/code-review');
    s.emitTransient('task_progress', { taskId: 't1' });
    await tick(90);
    assert.equal(quiet(events).length, 0);
    s.dispose();
  });

  // status_line 在整轮静默期间照样每拍都来；拿它撤表这条提示就永远发不出去
  test('status_line 这类纯状态事件不算「有动静」，不撤表', async () => {
    const { s, events } = makeSession({ slashQuietNoticeMs: 30 });
    await s.send('/code-review');
    s.emit('status_line', { turn: { startedAt: Date.now() } });
    await tick(80);
    assert.equal(quiet(events).length, 1);
    s.dispose();
  });

  test('dispose 后不再发提示（实例没了别往它身上发）', async () => {
    const { s, events } = makeSession({ slashQuietNoticeMs: 20 });
    await s.send('/code-review');
    s.dispose();
    await tick(60);
    assert.equal(quiet(events).length, 0);
  });

  // "/Users/you/code 这个目录" 首段后面是 /，不是空白 —— 不该被当命令
  test('以斜杠开头的普通文本（路径）不误判成命令', async () => {
    const { s, events } = makeSession({ slashQuietNoticeMs: 20 });
    await s.send('/Users/you/code 这个目录里有什么');
    await tick(60);
    assert.equal(quiet(events).length, 0);
    s.dispose();
  });
});

test.describe('map() — rate_limit_event 顶层类型', () => {
  test('status=rejected → notice，额度类型用 CLI 同源标签', () => {
    const { s, events } = makeSession();
    s.map({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });

    const [n] = notices(events);
    assert.ok(n, 'rejected 应发 notice');
    assert.equal(n.payload.level, 'warning');
    assert.ok(n.payload.message.includes('会话额度'), `CLI 的 five_hour="session limit"：${n.payload.message}`);
    s.dispose();
  });

  test('未知 rateLimitType → 泛化标签，不显示裸枚举名', () => {
    const { s, events } = makeSession();
    s.map({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'brand_new_tier' } });
    const msg = notices(events)[0].payload.message;
    assert.ok(!msg.includes('brand_new_tier'), `不该把枚举名直接给用户看：${msg}`);
    assert.ok(msg.includes('上限'));
    s.dispose();
  });

  test('status=allowed / allowed_warning 保持静默（额度信息已有 status_line.rate 通道）', () => {
    const { s, events } = makeSession();
    s.map({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
    s.map({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } });
    assert.equal(notices(events).length, 0);
    s.dispose();
  });

  test('不再落「未映射 SDK 消息 type」日志', () => {
    const { s, events } = makeSession();
    s.map({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
    assert.equal(
      events.filter(e => e.type === 'session_log' && String(e.payload?.text || '').includes('未映射')).length,
      0,
    );
    s.dispose();
  });
});

test.describe('map() — 子 agent 的 API 报错', () => {
  // 此前是 `if (msg.error) break;` 全吞。改 notice 而非 error：那行 break 本就是防子 agent 报错
  // 触发前端 setBusy(false) 杀掉主轮次的 P0 守卫，改成 notice 既能看见又不误杀。
  test('子 agent assistant.error → notice 上屏，且不发 error 事件', () => {
    const { s, events } = makeSession();
    s.map({
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      subagent_type: 'Explore',
      error: 'rate_limit',
      message: { content: [{ type: 'text', text: 'API Error: 429 Too Many Requests' }] },
    });

    assert.equal(events.filter(e => e.type === 'error').length, 0, '绝不能发 error（会杀主轮次）');
    const [n] = notices(events);
    assert.ok(n, '应发 notice');
    assert.ok(n.payload.message.includes('429'), '透传上游原文');
    s.dispose();
  });

  test('主 agent 的 API 报错仍走 error 原路（不回归）', () => {
    const { s, events } = makeSession();
    s.map({
      type: 'assistant',
      error: 'server_error',
      message: { content: [{ type: 'text', text: 'API Error: 503 upstream' }] },
    });

    const err = events.find(e => e.type === 'error');
    assert.ok(err, '主线报错仍是 error 事件');
    assert.ok(err.payload.message.includes('503'));
    assert.equal(err.payload.recoverable, true);
    s.dispose();
  });
});
