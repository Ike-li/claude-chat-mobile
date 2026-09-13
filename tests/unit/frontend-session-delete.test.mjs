// tests/unit/frontend-session-delete.test.mjs —— 彻底删除会话的前端控制器
// 钉住：破坏性操作的四条可见性契约 —— 必须先确认、取消即不发、失败不得谎报成功、
//       失败提示必须落在【发起操作的那一层】而不是被它盖住的消息流
// 覆盖：appConfirm 取消/确认两侧 · emit 载荷 · ok/失败/无响应三种回执 · onDeleted 只在成功时调
//       · 失败走 showDrawerNotice 而非 addBar · title 缺失时的 label 回落
//       · 确认框的 danger 语气与按钮文案 · 挂进 context.state
// 槽位：S1（纯逻辑 + 假 socket，零 IO）
//
// 【第四条契约是 2026-09-12 真机报障补的】原实现失败走 addBar，而 addBar 写的是聊天消息流
// `#messages`；🗑 只在抽屉里存在，抽屉打开时 #sidebarScrim（fixed inset-0 z-30）盖住整个视口。
// 于是「关闭会话→立刻删」这条必然撞上后端 5 分钟静默期保护的路径，用户得到的是零反馈——
// 点了、会话还在、没有任何提示。后端按设计拒绝了，前端把拒绝理由说给了一块看不见的地方。
//
// 【为什么这个文件此前不存在】createSessionDeleteController 是全仓两个「零测试引用」的前端工厂
// 之一（另一个是 createDrawerController），2026-09-05 做源码→测试机械映射时查出来的。
// 它驱动的是 `session:deletePermanent` —— 主机上 transcript 真被抹除、不可恢复，
// 是本产品前端能发起的最具破坏性的一条命令，却一条断言都没有。
//
// 断言尽量不依赖 i18n 语言态：查 label 是否出现在文案里、查 class 与 tone 这些语言无关的量，
// 不逐字比对中文（i18n 的 key 就是中文原文，改文案＝改 key，逐字断言会在改文案时无故变红）。

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppContext } from '../../app/public/js/app/context.js';
import { createSessionDeleteController } from '../../app/public/js/app/session-delete.js';

// ★ res 用 `'res' in opts` 取而不是解构默认值：本文件有一条用例要构造「回执为 undefined」
// （连接断了/超时无响应），而 `{ res = {ok:true} }` 的默认值对「显式传 undefined」和「没传」
// 一视同仁 —— 那条用例想验的场景会被夹具悄悄吃掉，变成在测成功分支。
function harness(opts = {}) {
  const confirm = opts.confirm ?? true;
  const res = 'res' in opts ? opts.res : { ok: true };
  const emitted = [];
  const bars = [];
  const notices = [];
  const deleted = [];
  const confirms = [];

  const socket = {
    emit: (event, payload, cb) => {
      emitted.push({ event, payload });
      cb?.(res);
    },
  };

  const context = createAppContext();
  const ctl = createSessionDeleteController(context, {
    socket,
    addBar: (text, cls) => bars.push({ text, cls }),
    showDrawerNotice: (text) => notices.push(text),
    appConfirm: async (opts) => { confirms.push(opts); return confirm; },
    onDeleted: (x) => deleted.push(x),
  });

  return { ctl, emitted, bars, notices, deleted, confirms, context };
}

test.describe('确认门：不确认就不删', () => {
  test('appConfirm 返回 false → 一条 emit 都不发', async () => {
    const h = harness({ confirm: false });
    await h.ctl.openDeleteSession('s-1', '/w/a', '重构分支');
    assert.deepEqual(h.emitted, [], '取消后仍发 emit 等于确认框形同虚设');
    assert.deepEqual(h.bars, []);
    assert.deepEqual(h.deleted, []);
  });

  test('确认框用 danger 语气，且正文点名到具体会话', async () => {
    const h = harness();
    await h.ctl.openDeleteSession('s-1', '/w/a', '重构分支');
    assert.equal(h.confirms.length, 1);
    const opts = h.confirms[0];
    assert.equal(opts.tone, 'danger', '不可恢复的操作必须用 danger 语气');
    assert.ok(opts.body.includes('重构分支'), '正文必须点名会话，否则用户不知道在删哪一个');
    assert.ok(opts.okText && opts.okText.length > 0, '确认按钮不得留空文案');
  });

  test('title 为空时 label 回落 sessionId（不能出现空引号）', async () => {
    const h = harness();
    await h.ctl.openDeleteSession('s-42', '/w/a', '');
    assert.ok(h.confirms[0].body.includes('s-42'));
  });
});

test.describe('下发与回执', () => {
  test('确认后按 session:deletePermanent 发出，载荷只带 sessionId 与 cwd', async () => {
    const h = harness();
    await h.ctl.openDeleteSession('s-1', '/w/a', '重构分支');
    assert.equal(h.emitted.length, 1);
    assert.equal(h.emitted[0].event, 'session:deletePermanent');
    assert.deepEqual(h.emitted[0].payload, { sessionId: 's-1', cwd: '/w/a' });
  });

  test('ok:true → 提示成功且 onDeleted 带回同一对标识', async () => {
    const h = harness({ res: { ok: true } });
    await h.ctl.openDeleteSession('s-1', '/w/a', '重构分支');
    assert.equal(h.bars.length, 1);
    assert.ok(h.bars[0].text.includes('重构分支'));
    assert.equal(h.bars[0].cls, 'text-ink-faint');
    assert.deepEqual(h.deleted, [{ sessionId: 's-1', cwd: '/w/a' }]);
  });

  // 失败路径的三条必须一起钉：
  // ① 只钉「提示了错误」的话，把 onDeleted 挪出 else 分支不会红——那正是「后端拒绝了，
  //    前端却把这一条从列表里抹掉」的形态。
  // ② 只钉「提示了错误」也抓不到「提示到了看不见的地方」：addBar 写的是被抽屉盖住的 #messages，
  //    断言"发出了一条提示"对两种去处一视同仁。所以失败侧必须**同时**断言 bars 为空。
  test('ok:false → 在抽屉内原样透传后端错因，且【不】调 onDeleted', async () => {
    const h = harness({ res: { ok: false, error: '会话正在被驱动，拒绝删除' } });
    await h.ctl.openDeleteSession('s-1', '/w/a', '重构分支');
    assert.deepEqual(h.notices, ['会话正在被驱动，拒绝删除'], '后端错因必须原样透传，不得吞成通用文案');
    assert.deepEqual(h.bars, [], '失败提示写进消息流＝写进抽屉盖住的那一层，用户看不到');
    assert.deepEqual(h.deleted, [], '删除失败却回调 onDeleted＝前端谎报成功');
  });

  test('回执为 undefined（连接断了/超时无响应）→ 走失败分支的兜底文案', async () => {
    const h = harness({ res: undefined });
    await h.ctl.openDeleteSession('s-1', '/w/a', '重构分支');
    assert.equal(h.notices.length, 1);
    assert.ok(h.notices[0].length > 0, '没有 error 字段时也得给一句话，不能显示 undefined');
    assert.deepEqual(h.bars, []);
    assert.deepEqual(h.deleted, []);
  });

  test('ok:false 且无 error 字段 → 同样落兜底文案', async () => {
    const h = harness({ res: { ok: false } });
    await h.ctl.openDeleteSession('s-1', '/w/a', 't');
    assert.equal(h.notices.length, 1);
    assert.notEqual(h.notices[0], 'undefined', '错误文案不得把 undefined 直接渲染出去');
    assert.deepEqual(h.bars, []);
    assert.deepEqual(h.deleted, []);
  });
});

test('控制器挂进 context.state.sessionDelete', () => {
  const h = harness();
  assert.equal(h.context.state.sessionDelete, h.ctl);
  assert.equal(typeof h.context.state.sessionDelete.openDeleteSession, 'function');
});
