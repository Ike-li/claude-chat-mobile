// tests/unit/agent-rewind.test.mjs —— 文件轴 Rewind 在 query 选项装配层的接线
// 覆盖两件事：① 文件快照开关；② user_message 随消息下发的 Rewind 锚点 uuid。
// 两者都是「传错了不会报错、只会静默失效」的那类参数，且都没有静态门禁看着。
//
// 【2026-09-10 退役】原本还覆盖「截断式 resume 的一对选项透传」（resumeSessionAt +
// resumeDropsTurn）。改用 fork 语义后 buildAgentQueryOptions 不再下发这对选项，
// 那 3 条用例连同被测代码一并移除——不是删测试，是被测的东西不存在了。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentQueryOptions } from '../../app/src/agent/agent.js';
import { makeSession } from '../helpers/agent-unit.mjs';

test.describe('buildAgentQueryOptions — 文件快照开关（L0）', () => {
  test('默认开启 enableFileCheckpointing', () => {
    const { s, dispose } = makeSession();
    s.abort = new AbortController();
    const opts = buildAgentQueryOptions(s, { ...process.env });
    assert.equal(opts.enableFileCheckpointing, true,
      '漏传这一项时 CLI 不落文件快照，rewindFiles 会对每一轮都报「找不到检查点」——'
      + '而且 CLI 本身照常工作，缺陷要到有人真的点回退时才暴露');
    dispose();
  });
});

test.describe('user_message 事件必须带 Rewind 锚点 uuid（A 方案）', () => {
  // 【为什么要专门守】这个字段【没有任何静态门禁看着】：PROTO-01 只校验 type 名单的四处一致，
  // 不看载荷字段。删掉它，check 全链、E2E 全都不会红——本仓 2026-09-07 已经栽过一次同型的
  // （删真 server 的 ack 字段，11 道门禁无一变红）。
  // 缺了它的后果：live 气泡拿不到 dataset.uuid → 用户最想回退的「刚才那一轮」长按无反应，
  // 必须刷新页面把它变成历史气泡，而这个限制没法向用户解释。
  test('send() 广播的 user_message 载荷含 uuid，且与开槽用的是同一个', async () => {
    const { s, events, dispose } = makeSession();
    s.abort = new AbortController();
    await s.send('hello', undefined, {});
    const um = events.find(e => e.type === 'user_message');
    assert.ok(um, 'send() 必须广播 user_message（气泡上屏靠它）');
    assert.equal(typeof um.payload.uuid, 'string', 'uuid 缺席 → live 气泡无锚点，长按恒无效');
    assert.match(um.payload.uuid, /^[0-9a-f-]{36}$/, '锚点必须是 uuid 形态：rewindFiles 拿它去找检查点');
    dispose();
  });

  test('uuid 与推入 CLI 输入流的是同一个值', async () => {
    // 分叉了就前功尽弃：前端拿到 A、CLI 记录的是 B，回退时报「找不到检查点」。
    const { s, events, dispose } = makeSession();
    s.abort = new AbortController();
    await s.send('hello', undefined, {});
    const um = events.find(e => e.type === 'user_message');
    assert.equal(s.queue[0]?.uuid, um.payload.uuid,
      '广播用一个 uuid、入队用另一个 = 前端锚点与 CLI 检查点对不上，回退必然失败');
    dispose();
  });
});
