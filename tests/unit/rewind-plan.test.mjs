// tests/unit/rewind-plan.test.mjs —— 文件轴 Rewind 的分叉计划（planRewind）
// 它回答一件事：回退到某一轮之前时，新会话该保留到哪条 entry 为止（forkSession 的 upToMessageId）。
//
// 【2026-09-10 取舍变更】原实现走「原地截断」（resumeSessionAt + resumeDropsTurn），需要在动磁盘
// 之前复算一遍 CLI 的拒绝判据（G10：丢弃区间是否混进了别的轮）。改为 fork 后原会话一个字节不动，
// 那道安全带连同它守的三条用例一并退役——不是「测试删了」，是「被测的东西不存在了」。
// 判据与佐证见 app/src/sessions/rewind-plan.js 头注。
//
// 夹具形态取自 2026-09-10 对 25 个真实会话的实测，不是照着实现编的：
//   · assistant / attachment 行【没有 promptId 字段】，且都带 uuid（可作分叉锚点）
//   · queue-operation 行【没有 uuid】——求锚点时必须跳过它
// 夹具偏离真实契约会让两边自洽地一起错（testing.md §3「fixture 编错外部契约时恒绿」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRewind, describeRewindBlocker, readSessionEntries, rewindLockDecision, rewindOutcomeVerdict, createRewindLocks, extractPromptText } from '../../app/src/sessions/rewind-plan.js';
import { getProjectDir } from '../../app/src/sessions/history.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// —— 真实形态的最小夹具 ——
const humanPrompt = (uuid, promptId) => ({ type: 'user', uuid, promptId, promptSource: 'sdk' });
const sameTurnUser = (uuid, promptId) => ({ type: 'user', uuid, promptId });          // 同轮后续 user 行
const assistant = (uuid) => ({ type: 'assistant', uuid });                            // 【无 promptId】
const attachment = (uuid) => ({ type: 'attachment', uuid });                          // 【无 promptId】
const toolResult = (uuid) => ({ type: 'user', uuid, promptId: undefined });           // tool_result 承载行
const queueOperation = () => ({ type: 'queue-operation' });                           // 【无 uuid】

test.describe('planRewind：正常路径', () => {
  test('两轮会话回退第二轮 → K 锚在第一轮的最后一条 chain entry', () => {
    const entries = [
      humanPrompt('u1', 'p1'), assistant('a1'), attachment('at1'),
      humanPrompt('u2', 'p2'), assistant('a2'),
    ];
    const plan = planRewind(entries, 'u2');
    assert.equal(plan.ok, true, 'P 存在、有 promptId、丢弃区间无外来轮，本该放行；拒绝说明判据过严，用户会遇到「能回退的轮次却回不了」');
    assert.equal(plan.keepUuid, 'at1', 'K 必须是保留轮的【最后一条 chain entry】而非最后一条 assistant——锚错会被 CLI 确定性拒绝');
  });

  test('被中断的轮次尾部是 tool_result → K 取它，不是前面的 assistant', () => {
    // SDK 契约点名的场景：Esc 打断前完成过工具，尾部 tool_result 是保留轮自己的 payload，
    // 锚在 assistant uuid 上会被【故意】拒绝。CCM 有停止按钮，这是常见路径不是边角。
    const entries = [
      humanPrompt('u1', 'p1'), assistant('a1'), toolResult('tr1'),
      humanPrompt('u2', 'p2'), assistant('a2'),
    ];
    const plan = planRewind(entries, 'u2');
    assert.equal(plan.ok, true);
    assert.equal(plan.keepUuid, 'tr1', '锚点回退成 a1 会让 CLI 拒绝这次 resume；此断言红了说明 K 的取法退化成了「最后一条 assistant」');
  });

  test('queue-operation 没有 uuid，求 K 时跳过它继续向前找', () => {
    const entries = [
      humanPrompt('u1', 'p1'), assistant('a1'),
      queueOperation(),
      humanPrompt('u2', 'p2'),
    ];
    const plan = planRewind(entries, 'u2');
    assert.equal(plan.ok, true);
    assert.equal(plan.keepUuid, 'a1', '把无 uuid 的行当成锚点会产出 undefined 锚点，resume 必失败');
  });
});

test.describe('planRewind：正对照——证明它不是恒拒绝', () => {
  // testing.md §3「正对照：仪器要先证明自己看得见」。一个恒返回 {ok:false} 的实现能让所有
  // 「拒绝」用例全绿，所以必须有一组场景【本该放行且确实放行】，否则整份测试是假绿。
  test('目标轮之后有大量从属条目也照常放行（fork 不关心丢弃区间里有什么）', () => {
    const entries = [
      humanPrompt('u1', 'p1'), assistant('a1'),
      humanPrompt('u2', 'p2'),
      assistant('a2'), attachment('at2'), toolResult('tr2'), assistant('a3'),
    ];
    const plan = planRewind(entries, 'u2');
    assert.equal(plan.ok, true,
      'fork 语义下丢弃区间的内容与判定无关——原会话完整保留，新会话只是不复制那部分。'
      + '这里若拒绝，说明实现里还残留着原地截断时代的校验');
  });

  test('同轮的多条 user 行也不影响锚点计算', () => {
    const entries = [
      humanPrompt('u1', 'p1'), assistant('a1'),
      humanPrompt('u2', 'p2'), sameTurnUser('u2b', 'p2'), assistant('a2'),
    ];
    assert.equal(planRewind(entries, 'u2').ok, true);
  });
});

test.describe('planRewind：拒绝路径（失败方向必须是拒绝）', () => {


  test('目标轮是会话第一轮 → 拒绝（前面没有可保留的锚点）', () => {
    const entries = [humanPrompt('u1', 'p1'), assistant('a1')];
    const plan = planRewind(entries, 'u1');
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'first-turn', '放行等于把整个会话删掉——那不是回退语义');
  });


  test('找不到目标 uuid → 拒绝', () => {
    const entries = [humanPrompt('u1', 'p1'), assistant('a1')];
    assert.equal(planRewind(entries, 'nope').reason, 'prompt-not-found');
  });

  test('非法输入 → 拒绝而不是抛错', () => {
    assert.equal(planRewind(null, 'u1').ok, false);
    assert.equal(planRewind([], '').ok, false);
    assert.equal(planRewind([{ uuid: 'u1', promptId: 'p1' }], null).ok, false);
  });
});

test.describe('describeRewindBlocker：分档说明是什么挡住的', () => {
  test('first-turn 与「无法确定位置」分开表述', () => {
    assert.match(describeRewindBlocker({ ok: false, reason: 'first-turn' }), /第一轮/);
    assert.match(describeRewindBlocker({ ok: false, reason: 'no-prompt-id' }), /无法确定/);
  });
  test('成功的计划没有 blocker 文案', () => {
    assert.equal(describeRewindBlocker({ ok: true, keepUuid: 'a1', dropPromptId: 'p2' }), null);
  });
});

// —— readSessionEntries：给 planRewind 喂原始条目的薄读取 ——
// 隔离用 mkdtemp 一次性目录（TEST-01），绝不碰真实 ~/.claude。
test.describe('readSessionEntries', () => {
  const mkFixture = (lines) => {
    const base = mkdtempSync(join(tmpdir(), 'ccm-rewind-read-'));
    const proj = join(base, getProjectDir('/w/proj'));
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'sid-1.jsonl'), lines.join('\n'), 'utf8');
    return base;
  };

  test('读回全量原始条目，保序', async () => {
    const base = mkFixture([
      JSON.stringify({ type: 'user', uuid: 'u1', promptId: 'p1' }),
      JSON.stringify({ type: 'assistant', uuid: 'a1' }),
    ]);
    try {
      const entries = await readSessionEntries('/w/proj', 'sid-1', { baseDir: base });
      assert.equal(entries.length, 2, '少读一条就可能把「外来轮」漏在丢弃区间外 → G10 误放行');
      assert.equal(entries[0].uuid, 'u1');
      assert.equal(entries[1].uuid, 'a1', '乱序会让「P 之前最后一条」算错，K 锚到错误位置');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('坏行跳过而不是整份读失败', async () => {
    const base = mkFixture([
      JSON.stringify({ type: 'user', uuid: 'u1', promptId: 'p1' }),
      '{ 半行截断',
      JSON.stringify({ type: 'assistant', uuid: 'a1' }),
    ]);
    try {
      const entries = await readSessionEntries('/w/proj', 'sid-1', { baseDir: base });
      assert.equal(entries.length, 2, 'transcript 正被写入时尾行可能是半行；整份读失败会让回退在会话活跃时完全不可用');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('非法 sessionId → 空数组，不拼进路径（SS-003）', async () => {
    const base = mkFixture([JSON.stringify({ type: 'user', uuid: 'u1' })]);
    try {
      assert.deepEqual(await readSessionEntries('/w/proj', '../../etc/passwd', { baseDir: base }), []);
      assert.deepEqual(await readSessionEntries('/w/proj', 'a/b', { baseDir: base }), []);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('文件不存在 → 空数组（不抛）', async () => {
    const base = mkFixture([JSON.stringify({ type: 'user', uuid: 'u1' })]);
    try {
      assert.deepEqual(await readSessionEntries('/w/proj', 'no-such-sid', { baseDir: base }), []);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

test.describe('rewindLockDecision（G3）：键是 sessionId，不是实例', () => {
  // confirm 第 3 步要 dispose 实例再重新 resume，实例对象会被置换——锁挂在 inst 上的话，
  // 解锁时 inst 已不是加锁时那个对象，锁既失效又泄漏。
  test('无锁 → 取得', () => {
    assert.equal(rewindLockDecision({ existing: null, now: 1000 }), 'acquire');
  });
  test('锁在有效期内 → 拒绝（防连击与网络重发）', () => {
    assert.equal(rewindLockDecision({ existing: { startedAt: 1000 }, now: 5000, ttlMs: 30_000 }), 'reject',
      '不拒绝就会两次回滚并发写同一批文件');
  });
  test('锁过期 → 夺取（TTL 自愈）', () => {
    assert.equal(rewindLockDecision({ existing: { startedAt: 1000 }, now: 40_000, ttlMs: 30_000 }), 'acquire-stale',
      '没有自愈的话，回退中途崩一次就把该会话的回退功能永久钉死');
  });
  test('恰好到期 → 夺取（边界取「不小于即可夺」）', () => {
    assert.equal(rewindLockDecision({ existing: { startedAt: 0 }, now: 30_000, ttlMs: 30_000 }), 'acquire-stale');
  });
  test('时间戳损坏（NaN）→ 夺取而不是永久锁死', () => {
    assert.equal(rewindLockDecision({ existing: { startedAt: NaN }, now: 5000 }), 'acquire-stale',
      'NaN 比较恒 false，若判据写成 (now-t >= ttl) 会恒不成立 → 锁永远解不开');
  });
});

test.describe('rewindOutcomeVerdict（G6）：不信 canRewind', () => {
  // SDK 契约：非软链接的 per-file 失败既不计入 skippedLinks 也不抛错，
  // 只有「全部失败」才 canRewind:false。所以「回退了一半」这一档接口是【成功】返回的。
  test('回滚后再 dryRun 无事可做 → 判成功', () => {
    assert.deepEqual(rewindOutcomeVerdict({ canRewind: true, filesChanged: [] }), { ok: true, unrestored: [] });
  });
  test('回滚后再 dryRun 仍报有文件要改 → 判失败并列出是哪些', () => {
    const v = rewindOutcomeVerdict({ canRewind: true, filesChanged: ['/w/a.js', '/w/b.js'] });
    assert.equal(v.ok, false, '这一档接口返回的是成功——不自己核就会给用户一个绿色的假 Toast');
    assert.deepEqual(v.unrestored, ['/w/a.js', '/w/b.js']);
  });
  test('复核本身失败（null）→ 保守判失败', () => {
    assert.equal(rewindOutcomeVerdict(null).ok, false,
      '没核过就报「已全部恢复」，等于把「不知道」说成「没问题」');
  });
});

test.describe('createRewindLocks：锁跨越实例置换仍然有效', () => {
  test('同一会话第二次 tryAcquire 被拒；release 后可再取', () => {
    let clock = 1000;
    const locks = createRewindLocks({ ttlMs: 30_000, now: () => clock });
    assert.equal(locks.tryAcquire('s1'), true);
    assert.equal(locks.tryAcquire('s1'), false, '连击/网络重发会让两次回滚并发写同一批文件');
    locks.release('s1');
    assert.equal(locks.tryAcquire('s1'), true);
  });

  test('不同会话互不阻塞', () => {
    const locks = createRewindLocks();
    assert.equal(locks.tryAcquire('s1'), true);
    assert.equal(locks.tryAcquire('s2'), true, '锁的粒度是会话，不是全局——否则一个会话回退会挡住所有会话');
  });

  test('TTL 到期后可夺取（回退中途崩溃不会把功能永久钉死）', () => {
    let clock = 1000;
    const locks = createRewindLocks({ ttlMs: 30_000, now: () => clock });
    assert.equal(locks.tryAcquire('s1'), true);
    clock = 40_000;
    assert.equal(locks.tryAcquire('s1'), true);
  });
});

test.describe('extractPromptText：把那一轮的原话取回来（prefill）', () => {
  // 回退的语义是「回到我说这句话之前」，那么下一步多半就是把这句话改一改重说——
  // Claude Desktop 的 rewindSession 也返回 prefill，SDK 的 d.ts 同样点名了这个用途
  // （"the rewind target and composer prefill for edit-and-retry"）。
  //
  // 夹具形态取自 30 个真实会话实测：list[text] ×139、str ×114、list[image+text] ×7、
  // list[tool_result] ×4306。四种都要有明确行为，尤其最后一种——它也是 type:'user'，
  // 但不是人打的字，回填进输入框会很荒谬。
  test('字符串形态原样取回', () => {
    assert.equal(extractPromptText({ message: { content: ' server启动不了了' } }), ' server启动不了了');
  });

  test('text 块形态拼接取回（最常见）', () => {
    assert.equal(extractPromptText({ message: { content: [{ type: 'text', text: '为什么抽屉还显示运行中' }] } }),
      '为什么抽屉还显示运行中');
  });

  test('图文混排只取文字，跳过 image 块', () => {
    const entry = { message: { content: [
      { type: 'image', source: { type: 'base64', data: 'xxx' } },
      { type: 'text', text: '这张图里的报错是什么意思' },
    ] } };
    assert.equal(extractPromptText(entry), '这张图里的报错是什么意思',
      'image 块的 base64 若被拼进去，输入框会被灌进几十 KB 的乱码');
  });

  test('tool_result 承载行 → 空串（它是 type:user 但不是人打的字）', () => {
    const entry = { message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '命令输出' }] } };
    assert.equal(extractPromptText(entry), '',
      '把工具输出回填进输入框会让用户莫名其妙地"重发"一段命令结果');
  });

  test('剥掉 CCM 自己追加的附件块，只留用户原话', () => {
    // 附件块的真实格式（取自真实 transcript，不是编的）：头行有固定措辞，
    // 随后是绝对路径。第一版夹具我按印象写成「[附件]\n- 文件名」，与 ATTACH_BLOCK_HEADER_RE
    // 对不上 → 用例红。夹具偏离真实契约时两边会自洽地一起错，所以照真实样本抄。
    const entry = { message: { content:
      '这里面有两个重启，一个重启服务是 server 的\n\n'
      + '[附件] 已上传到工作目录，可用 FileRead / Read 读取：\n'
      + '/Users/you/code/proj/.ccm-uploads/1787035067864-f8fba05a-image.png' } };
    assert.equal(extractPromptText(entry), '这里面有两个重启，一个重启服务是 server 的',
      '附件清单是发送时拼进去的、不是用户打的；回填它等于让用户手动删一遍');
  });

  test('缺字段 / 非法输入 → 空串而不是抛错', () => {
    assert.equal(extractPromptText(null), '');
    assert.equal(extractPromptText({}), '');
    assert.equal(extractPromptText({ message: {} }), '');
    assert.equal(extractPromptText({ message: { content: 42 } }), '');
  });
});
