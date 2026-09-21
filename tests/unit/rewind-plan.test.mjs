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
import { planRewind, planFork, describeRewindBlocker, readSessionEntries, rewindLockDecision, rewindOutcomeVerdict, createRewindLocks, extractPromptText, listRewindCandidates, rewindStepsFor } from '../../app/src/sessions/rewind-plan.js';
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

// ── planFork：分叉锚点 ──
//
// 与 planRewind 同源但多回答一个问题。planRewind 只问「丢弃这一轮，要保留到哪条」；
// 长按 assistant 气泡的「从这里分叉」问的是反过来的「保留这一轮，要保留到哪条」。
//
// 【为什么不能用「最后一条 assistant 文本」当锚】SDK 的通用规则是
// "fork at the KEPT turn's last chain entry, whatever it is"（sdk.d.ts resumeDropsTurn 头注），
// 而 forkSession 的切片实现是纯 inclusive slice、零修正（Desktop 1.52386.6 内嵌的那份：
// `i = i.slice(0, idx + 1)`，既不补偿也不校验）。锚点给早了它照切，保留轮尾部的 tool_result
// 就被丢进弃置区间——本机 809 个 transcript / 5905 个可分叉 prompt 实测，其中 110 个（1%）
// 会因此留下 dangling tool_use（tool_use 在、配对的 tool_result 没了）。
test.describe('planFork —— 分叉锚点', () => {
  // 一轮的真实形态：human prompt → assistant(text+tool_use) → tool_result(type:'user') → …
  // tool_result 也是 type:'user'，靠 content 里没有 text block 与人打的字区分（同 extractPromptText）。
  const entries = [
    { uuid: 'u1', type: 'user', message: { content: 'do it' } },
    { uuid: 'a1', type: 'assistant', message: { content: [{ type: 'text', text: '好' }, { type: 'tool_use', id: 't1' }] } },
    { uuid: 'r1', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    { uuid: 'u2', type: 'user', message: { content: 'next' } },
    { uuid: 'a2', type: 'assistant', message: { content: [{ type: 'text', text: '完成' }] } },
  ];

  test('保留 anchor 所在轮：锚到该轮最后一条 chain entry，不是最后一条 assistant 文本', () => {
    // 长按 a1「从这里分叉」。a1 之后的 r1 是【这一轮自己的】tool_result，必须一起保留，
    // 否则 a1 里的 tool_use 就悬空了。锚在 a1 上正是 sdk.d.ts 点名会出事的那种做法。
    assert.deepEqual(planFork(entries, 'a1', { keepAnchorTurn: true }), { ok: true, keepUuid: 'r1' });
  });

  test('保留轮不越界到下一轮：下一条人类 prompt 之前就停', () => {
    // a2 是会话最后一条，其所在轮没有尾巴，锚点就是它自己。
    assert.deepEqual(planFork(entries, 'a2', { keepAnchorTurn: true }), { ok: true, keepUuid: 'a2' });
  });

  test('丢弃 anchor 所在轮：与 planRewind 给出同一个锚点', () => {
    // 长按 u2「丢弃这条及之后」——这正是 rewind 走的那条路，两者必须同源，
    // 否则同一个仓库里两条路径对同一个问题给出不同答案。
    const viaFork = planFork(entries, 'u2', { keepAnchorTurn: false });
    const viaRewind = planRewind(entries, 'u2');
    assert.deepEqual(viaFork, viaRewind);
    assert.deepEqual(viaFork, { ok: true, keepUuid: 'r1' });
  });

  test('丢弃会话首轮 → first-turn 拒绝（前面没有可保留的锚点）', () => {
    assert.deepEqual(planFork(entries, 'u1', { keepAnchorTurn: false }), { ok: false, reason: 'first-turn' });
  });

  test('锚点不在 transcript 里 / 入参非法 → 拒绝，不猜', () => {
    assert.equal(planFork(entries, 'nope', { keepAnchorTurn: true }).ok, false);
    assert.equal(planFork(null, 'a1', { keepAnchorTurn: true }).ok, false);
    assert.equal(planFork(entries, '', { keepAnchorTurn: true }).ok, false);
  });

  test('跳过没有 uuid 的行（queue-operation 等不可作锚点）', () => {
    const withNoise = [
      { uuid: 'u1', type: 'user', message: { content: 'go' } },
      { uuid: 'a1', type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'queue-operation' },                       // 无 uuid：不是 chain entry
      { uuid: 'u2', type: 'user', message: { content: 'next' } },
    ];
    assert.deepEqual(planFork(withNoise, 'a1', { keepAnchorTurn: true }), { ok: true, keepUuid: 'a1' });
    assert.deepEqual(planFork(withNoise, 'u2', { keepAnchorTurn: false }), { ok: true, keepUuid: 'a1' });
  });
});

// ── planFork / planRewind 的锚点资格：两条来自 PR #88 review ──
//
// 【P1】SDK 的 transcript 读取器只收五种 type（逆向 Desktop 1.52386.6 内嵌的那份：
// `(t==="user"||t==="assistant"||t==="progress"||t==="system"||t==="attachment") && typeof e.uuid=="string"`）。
// 而每次 fork 都会在末尾追加一条 `{type:"custom-title", uuid: randomUUID(), …}`——**带 uuid
// 但不在白名单里**。只判「有 uuid」就会锚到它上面，forkSession 的 findIndex 返回 -1，
// 抛 `Message … not found`。症状是「在一个已分叉的会话里再分叉」确定性失败。
//
// 【P2】isHumanPrompt 原来只认 string 与 text 块，而 SDKUserMessage 契约允许 image/document
// 内容。纯图片的那一轮会被判成「不是人类输入」而被跨过去，保留方向于是多吞了一整轮——
// 用户选的是 A，分出来的却含 A 之后那一轮。判据要反过来：主链 user 条目只要不是
// tool_result 承载行，就该终止被保留的这一轮。
test.describe('planFork / planRewind：锚点资格', () => {
  const customTitle = (uuid) => ({ type: 'custom-title', uuid, customTitle: 'X (fork)' });
  const imageOnlyPrompt = (uuid) => ({
    type: 'user', uuid, message: { content: [{ type: 'image', source: { type: 'base64' } }] },
  });

  test('P1：custom-title 带 uuid 也不能当锚点（forkSession 的 transcript 里根本没有它）', () => {
    const entries = [
      { uuid: 'u1', type: 'user', message: { content: 'go' } },
      { uuid: 'a1', type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      customTitle('ct-1'),   // fork 产物尾巴：带 uuid，但 forkSession 读不到它
    ];
    // 保留 a1 所在轮：尾巴不是合法锚点，锚点应停在 a1
    assert.deepEqual(planFork(entries, 'a1', { keepAnchorTurn: true }), { ok: true, keepUuid: 'a1' });
  });

  test('P1：丢弃方向同样不得锚到 custom-title（planRewind 与 planFork 同源）', () => {
    const entries = [
      { uuid: 'u1', type: 'user', message: { content: 'go' } },
      { uuid: 'a1', type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      customTitle('ct-1'),
      { uuid: 'u2', type: 'user', message: { content: 'next' } },
    ];
    assert.deepEqual(planRewind(entries, 'u2'), { ok: true, keepUuid: 'a1' });
    assert.deepEqual(planFork(entries, 'u2', { keepAnchorTurn: false }), { ok: true, keepUuid: 'a1' });
  });

  test('P2：纯图片的 user prompt 同样终止保留轮，不被跨过', () => {
    const entries = [
      { uuid: 'u1', type: 'user', message: { content: 'first' } },
      { uuid: 'a1', type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      imageOnlyPrompt('u2'),  // 没有 text 块，但确实是人打的那一轮
      { uuid: 'a2', type: 'assistant', message: { content: [{ type: 'text', text: 'later' }] } },
    ];
    // 保留 a1 那一轮：必须停在 a1，不能吞掉 u2/a2 这一整轮
    assert.deepEqual(planFork(entries, 'a1', { keepAnchorTurn: true }), { ok: true, keepUuid: 'a1' });
  });

  test('P2 的反面：tool_result 承载行不算人类输入，仍属于同一轮', () => {
    const entries = [
      { uuid: 'u1', type: 'user', message: { content: 'go' } },
      { uuid: 'a1', type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1' }] } },
      { uuid: 'r1', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
      { uuid: 'u2', type: 'user', message: { content: 'next' } },
    ];
    // r1 是保留轮自己的尾巴，锚点要走到它；u2 才是下一轮的开始
    assert.deepEqual(planFork(entries, 'a1', { keepAnchorTurn: true }), { ok: true, keepUuid: 'r1' });
  });
});

// ── rewindStepsFor：终端 /rewind 第二步那三个模式各自要做哪几步 ──────────────────
// 1. Restore code and conversation · 2. Restore conversation · 3. Restore code
// 缺省必须落在「两样都做」上：旧前端不带 mode 字段，按未知值退化成只做一半会静默改变行为。
test.describe('rewindStepsFor', () => {
  test('缺省（旧前端不传 mode）→ 文件与对话都回退', () => {
    assert.deepEqual(rewindStepsFor(undefined), { restoreCode: true, forkConversation: true });
  });
  test('code_and_conversation → 两样都做', () => {
    assert.deepEqual(rewindStepsFor('code_and_conversation'), { restoreCode: true, forkConversation: true });
  });
  test('conversation → 只分叉对话，不碰磁盘文件', () => {
    assert.deepEqual(rewindStepsFor('conversation'), { restoreCode: false, forkConversation: true });
  });
  test('code → 只回滚文件，不产生新会话', () => {
    assert.deepEqual(rewindStepsFor('code'), { restoreCode: true, forkConversation: false });
  });
  test('无法识别的 mode → 退化成缺省而不是两样都不做（空操作会让用户以为回退成功了）', () => {
    assert.deepEqual(rewindStepsFor('nonsense'), { restoreCode: true, forkConversation: true });
  });
});

// ── listRewindCandidates：/rewind 第一步那张「回到哪一轮之前」的清单 ──────────────
// 终端 /rewind 先列出每一轮人类 prompt，并在每条下面标出这一轮动过几个文件（没动就是
// "No code changes"）。数据来自 transcript 自带的 file-history-snapshot，不必逐条去问
// rewindFiles ——那是 N 次 SDK 控制请求，列个清单不该付这个代价。
//
// 夹具形态取自真实会话 cdb36ede 的实测（45 条 snapshot）：
//   · snapshot.messageId 【全部】指向人类 prompt 的 uuid（45/45，不是 assistant）
//   · snapshot.trackedFileBackups 是【累积】快照（实测 7→8→9 递增），不是本轮增量
// 所以「这一轮动了几个文件」只能靠与上一轮的快照相比，直接读 size 会把历史累计数报上去。
test.describe('listRewindCandidates', () => {
  const snap = (messageId, backups) => ({
    type: 'file-history-snapshot', messageId,
    snapshot: { messageId, trackedFileBackups: backups, timestamp: '2024-01-01T00:00:00Z' },
  });

  test('只列人类 prompt，tool_result 那种 user 条目不算一轮', () => {
    const entries = [
      { uuid: 'u1', type: 'user', timestamp: '2024-01-01T00:00:00Z', message: { content: '第一问' } },
      { uuid: 'a1', type: 'assistant', message: { content: '答' } },
      { uuid: 'r1', type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { uuid: 'u2', type: 'user', timestamp: '2024-01-01T00:01:00Z', message: { content: '第二问' } },
    ];
    const got = listRewindCandidates(entries);
    assert.deepEqual(got.map(c => c.promptUuid), ['u1', 'u2']);
    assert.deepEqual(got.map(c => c.text), ['第一问', '第二问']);
  });

  // 【2026-09-21 修正错位（PR #102 review）】snapshot 在 prompt 落盘那一刻拍摄，记的是
  // 「本轮开始前」的还原点，所以 snapshot(N) − snapshot(N-1) 反映的是 **turn N-1** 的改动。
  // 实证（真实会话 cdb36ede）：「我们为什么用到了 gunicorn」是纯提问，它的 snapshot 里却多出
  // 两个文件，backupTime 与该轮 prompt 同一毫秒级时刻，而那两个文件正是【上一轮】「写成一篇新
  // 文章、新开一个文件」创建的。原实现按「本轮 − 上一轮」归因，整体错位一行：改文件的那轮报 0、
  // 紧随其后的纯提问轮报 N。
  test('changedFiles 归给真正动过文件的那一轮，不是下一轮', () => {
    const entries = [
      { uuid: 'u1', type: 'user', timestamp: '2024-01-01T00:00:00Z', message: { content: '写个文件' } },
      snap('u1', {}),                                   // 第一轮【开始前】：什么都没追踪
      { uuid: 'u2', type: 'user', timestamp: '2024-01-01T00:01:00Z', message: { content: '纯提问' } },
      snap('u2', { 'a.py': { version: 1 } }),           // 第二轮开始前：a.py 已被第一轮碰过
      { uuid: 'u3', type: 'user', timestamp: '2024-01-01T00:02:00Z', message: { content: '再问' } },
      snap('u3', { 'a.py': { version: 1 } }),           // 第三轮开始前：与上一次相同 ⇒ 第二轮没动文件
    ];
    const got = listRewindCandidates(entries);
    assert.equal(got[0].changedFiles, 1, '写文件的是第一轮，它才该记 1');
    assert.equal(got[1].changedFiles, 0, '第二轮只提问；报 1 就是把上一轮的账算到它头上');
  });

  test('同一文件被改第二次：版本号提升算改动，归给动手的那一轮', () => {
    const entries = [
      { uuid: 'u1', type: 'user', timestamp: '2024-01-01T00:00:00Z', message: { content: '改第二次' } },
      snap('u1', { 'a.py': { version: 1 } }),
      { uuid: 'u2', type: 'user', timestamp: '2024-01-01T00:01:00Z', message: { content: '下一轮' } },
      snap('u2', { 'a.py': { version: 2 } }),
    ];
    assert.equal(listRewindCandidates(entries)[0].changedFiles, 1);
  });

  // 最后一轮的改动还没有「下一个 snapshot」来反映，从 transcript 上无从得知。
  // 报 0 是撒谎（它可能改了一堆），所以标 null＝未知，前端不显示文件数；
  // 准确值由第二步的 preview（rewindFiles dryRun）给。
  test('最后一轮的文件数未知（null），不得报成 0', () => {
    const entries = [
      { uuid: 'u1', type: 'user', timestamp: '2024-01-01T00:00:00Z', message: { content: '一' } },
      snap('u1', {}),
      { uuid: 'u2', type: 'user', timestamp: '2024-01-01T00:01:00Z', message: { content: '二' } },
      snap('u2', { 'a.py': { version: 1 } }),
    ];
    const got = listRewindCandidates(entries);
    assert.equal(got[0].changedFiles, 1);
    assert.equal(got[1].changedFiles, null, '报 0 会让「最后一轮改了文件」看起来像没改');
  });

  test('没有 snapshot 的轮次报 0（对应终端的 No code changes），不得漏掉这一轮', () => {
    const entries = [
      { uuid: 'u1', type: 'user', timestamp: '2024-01-01T00:00:00Z', message: { content: '只聊天' } },
      { uuid: 'u2', type: 'user', timestamp: '2024-01-01T00:01:00Z', message: { content: '也只聊天' } },
    ];
    const got = listRewindCandidates(entries);
    assert.equal(got.length, 2);
    assert.deepEqual(got.map(c => c.changedFiles), [0, null]);
  });

  // 【2026-09-21 拆分（PR #102 review）】canRewind 原先只来自 planRewind，那是【对话轴】的判据
  // （首轮之前没有可保留的锚点，fork 会退化成复制一个空会话）。但「只恢复代码」不 fork，
  // 首轮的文件快照照样能还原——把两个轴压成一个字段，等于让单轮会话完全用不了 Restore code，
  // 而终端能。
  test('首轮：不能分叉对话，但可以只恢复代码', () => {
    const entries = [
      { uuid: 'u1', type: 'user', timestamp: '2024-01-01T00:00:00Z', message: { content: '第一问' } },
      { uuid: 'a1', type: 'assistant', message: { content: '答' } },
      { uuid: 'u2', type: 'user', timestamp: '2024-01-01T00:01:00Z', message: { content: '第二问' } },
    ];
    const got = listRewindCandidates(entries);
    assert.equal(got[0].canForkConversation, false, '首轮之前没有可保留的锚点');
    assert.equal(got[0].canRestoreCode, true, '文件轴不受对话轴限制，否则单轮会话永远回退不了代码');
    assert.equal(got[1].canForkConversation, true);
    assert.equal(got[1].canRestoreCode, true);
  });
});
