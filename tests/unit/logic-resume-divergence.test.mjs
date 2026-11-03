// tests/unit/logic-resume-divergence.test.mjs —— 续接会丢掉一段对话时那块面板说什么（app/public/js/logic/resume-divergence.js）
// 数据来自发送被拒时 ack 带回的 divergence（server 端 sessions/resume-anchor.js 的 resumeDivergence）。
// 覆盖：两种形态各自照实说清每个选项保住什么、丢掉什么 · 未知来源不印出 undefined · 坏数据不出面板 · 英文有译文
// 不测：面板开合、分叉后把话放回新会话输入框（S3，tests/e2e/specs/resume-divergence.spec.ts）
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeResumeDivergence } from '../../app/public/js/logic/resume-divergence.js';
import { setLang } from '../../app/public/js/i18n.js';

// 真机 c78e8b47 的形态：终端只在旧叶子下写过 system 行后退出，手机那一问一答被丢；从手机末条分叉什么都不丢
const AWAY = Object.freeze({
  newestUuid: 'a-2', newestEntrypoint: 'sdk-ts', newestAt: '2026-09-03T12:34:01.953Z',
  droppedCount: 2, anchorOnlyCount: 0, anchorEntrypoint: 'cli', anchorAt: '2026-09-03T12:26:43.779Z',
});
// 反方向：旧终端在旧叶子下真打了一轮，规则 5 置换后接上手机那支——两支各有对方没有的
const FORKED = Object.freeze({
  newestUuid: 'a-3', newestEntrypoint: 'cli', newestAt: '2026-09-03T12:40:00.000Z',
  droppedCount: 2, anchorOnlyCount: 3, anchorEntrypoint: 'sdk-ts', anchorAt: '2026-09-03T12:34:01.953Z',
});

test('终端后重贴型：说清模型会从哪一端接上、哪一端最近几条不在上下文里，按钮是分叉 / 仍然发送', () => {
  const d = describeResumeDivergence(AWAY);
  assert.ok(d.title);
  assert.match(d.body, /终端/, '会接上的是终端那一轮');
  assert.match(d.body, /手机上最近 2 条/, '丢的是手机上那两条');
  assert.equal(d.okText, '分叉到新会话');
  assert.equal(d.altText, '仍然发送');
  assert.doesNotMatch(d.body, /另一支/, '另一支没有对话时不能吓唬人说分叉会少东西');
});

test('真分叉：两支各有对方没有的对话，分叉那一项必须说出会少掉另一支的几条', () => {
  const d = describeResumeDivergence(FORKED);
  assert.match(d.body, /手机那一轮/, '这次会接上手机那支');
  assert.match(d.body, /终端上最近 2 条/);
  assert.match(d.body, /另一支的 3 条不在/, '不说的话用户以为分叉零代价，点完才发现终端那轮没了');
});

test('不认识或缺失的来源：两个位置都给通用说法，不把原始值 / undefined / null 印给用户', () => {
  for (const [newestEntrypoint, anchorEntrypoint] of [['sdk-py', null], [undefined, 'remote-x']]) {
    const d = describeResumeDivergence({ ...AWAY, newestEntrypoint, anchorEntrypoint });
    assert.doesNotMatch(d.body, /undefined|null|sdk-py|remote-x/);
    assert.match(d.body, /从另一端那一轮接上，另一端上最近 2 条/);
  }
});

test('坏数据不出面板（调用方据此退回「把话还给输入框 + 报错条」）', () => {
  assert.equal(describeResumeDivergence(null), null);
  assert.equal(describeResumeDivergence({ ...AWAY, newestUuid: '' }), null, '没有 newestUuid 两个选项都做不了');
  assert.equal(describeResumeDivergence('a-2'), null);
});

test('英文界面：标题、正文、按钮都有译文（中文原文漏出来就是词典缺项）', () => {
  setLang('en');
  try {
    for (const div of [AWAY, FORKED, { ...AWAY, newestEntrypoint: 'x', anchorEntrypoint: 'y' }]) {
      const d = describeResumeDivergence(div);
      assert.doesNotMatch(d.title + d.body + d.okText + d.altText, /[一-鿿]/);
    }
  } finally {
    setLang('zh');
  }
});
