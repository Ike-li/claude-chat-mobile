// tests/unit/frontend-message-timeline.test.mjs —— 消息流时间戳的 DOM 插入行为域单测。
// 判定与文案归 logic-message-timeline.test.mjs，这里只测「插不插、插哪、打不打戳」。
// 按行为域拆分是硬门禁（见 source-layout.test.mjs）。
//
// 用手写假节点而非 jsdom：本模块只碰 lastElementChild / previousElementSibling / dataset /
// appendChild / textContent 五个原语，假件比 jsdom 更能钉死「到底用了哪些 DOM 能力」。

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMessageTimeline } from '../../public/js/app/message-timeline.js';

// —— 极简假 DOM ——
function fakeNode(attrs = {}) {
  const node = {
    dataset: { ...attrs },
    children: [],
    textContent: '',
    _html: null,
    get lastElementChild() { return this.children[this.children.length - 1] ?? null; },
    get previousElementSibling() {
      const i = this.parent ? this.parent.children.indexOf(this) : -1;
      return i > 0 ? this.parent.children[i - 1] : null;
    },
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    get parentNode() { return this.parent ?? null; },
    insertBefore(child, ref) {
      child.parent = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(child); else this.children.splice(i, 0, child);
      return child;
    },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
  };
  return node;
}

function harness({ gapMs } = {}) {
  const messagesEl = fakeNode();
  const created = [];
  const timeline = createMessageTimeline({
    createElement: html => { const n = fakeNode(); n._tpl = html; created.push(n); return n; },
    appendMessage: node => messagesEl.appendChild(node),
    messagesEl,
    ...(gapMs ? { gapMs } : {}),
  });
  return { timeline, messagesEl, created };
}

const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();
const markers = el => el.children.filter(n => n.dataset.markerKind);
const bubble = () => fakeNode({ topLevel: '1' });

test('ts 缺失/非法：只 append 气泡，不打 data-ts、不插行', () => {
  const { timeline, messagesEl } = harness();
  timeline.appendWithTime(bubble(), null, 'user');
  timeline.appendWithTime(bubble(), 'not-a-date', 'user');
  assert.equal(messagesEl.children.length, 2);
  assert.equal(markers(messagesEl).length, 0);
  assert.equal(messagesEl.children[0].dataset.ts, undefined);
});

test('会话首条：先插 day 行再 append 气泡，气泡带 data-ts', () => {
  const { timeline, messagesEl } = harness();
  const ts = at(2026, 8, 4, 9, 0);
  timeline.appendWithTime(bubble(), ts, 'user');
  assert.equal(messagesEl.children.length, 2);
  assert.equal(messagesEl.children[0].dataset.markerKind, 'day');
  assert.equal(messagesEl.children[1].dataset.ts, String(ts));
});

test('assistant 超阈值：不插行但仍打 data-ts（同轮抑制）', () => {
  const { timeline, messagesEl } = harness();
  timeline.appendWithTime(bubble(), at(2026, 8, 4, 9, 0), 'user');       // day
  timeline.appendWithTime(bubble(), at(2026, 8, 4, 9, 20), 'assistant'); // 抑制
  assert.equal(markers(messagesEl).length, 1);
  assert.equal(messagesEl.children.at(-1).dataset.ts, String(at(2026, 8, 4, 9, 20)));
});

test('user 超阈值：插 time 行', () => {
  const { timeline, messagesEl } = harness();
  timeline.appendWithTime(bubble(), at(2026, 8, 4, 9, 0), 'user');
  timeline.appendWithTime(bubble(), at(2026, 8, 4, 9, 30), 'user');
  const ms = markers(messagesEl);
  assert.deepEqual(ms.map(n => n.dataset.markerKind), ['day', 'time']);
});

test('跨天：插 day 而非 time', () => {
  const { timeline, messagesEl } = harness();
  timeline.appendWithTime(bubble(), at(2026, 8, 3, 23, 59), 'user');
  timeline.appendWithTime(bubble(), at(2026, 8, 4, 0, 1), 'user');
  assert.deepEqual(markers(messagesEl).map(n => n.dataset.markerKind), ['day', 'day']);
});

test('fragment 路径：行与气泡都进 fragment，不写 messagesEl', () => {
  const { timeline, messagesEl } = harness();
  const frag = fakeNode();
  timeline.beginFragment(frag)(bubble(), at(2026, 8, 4, 9, 0), 'user');
  assert.equal(frag.children.length, 2);
  assert.equal(messagesEl.children.length, 0);
});

// history_append 增量：frag 是新的、空的，但 #messages 里已有前面的气泡
test('增量模式：seed 自 messagesEl 末尾的 data-ts，接上前一批', () => {
  const { timeline, messagesEl: harnessMessagesEl } = harness();
  timeline.appendWithTime(bubble(), at(2026, 8, 4, 9, 0), 'user'); // messagesEl 有戳了

  const seed = () => timeline.lastTimestampIn(harnessMessagesEl);
  const frag = fakeNode();
  timeline.beginFragment(frag, { seedPrevTs: seed() })(bubble(), at(2026, 8, 4, 9, 1), 'user');
  assert.equal(markers(frag).length, 0, '同日 1 分钟：seed 自 messagesEl 尾巴，故不插行');

  const frag2 = fakeNode();
  timeline.beginFragment(frag2, { seedPrevTs: seed() })(bubble(), at(2026, 8, 4, 9, 30), 'user');
  assert.deepEqual(markers(frag2).map(n => n.dataset.markerKind), ['time']);
});

// 三态哨兵不能在传参处被压平。scanTsBackFrom 的约定：number=找到 / null=确实没有（会话首条）/
// undefined=扫满 SCAN_LIMIT 前一条在视野外。stamp() 用 `prevTs !== undefined` 守着，
// appendWithTime 与 settleAt 都按位置传参、哨兵完好；beginFragment 走的是选项对象，
// 而解构默认值 `{ seedPrevTs = null }` 恰恰在值为 undefined 时触发 —— 把「看不见」压成了「没有」，
// 于是一个堆了几百张工具卡的 agentic 回合之后，增量追平会凭空插一条整宽日期分隔行。
test('增量模式：seed 为 undefined（扫满上限）时不得退化成「会话首条」而插日期行', () => {
  const { timeline, messagesEl: harnessMessagesEl } = harness();
  timeline.appendWithTime(bubble(), at(2026, 8, 4, 9, 0), 'user'); // 确实存在前一条主链气泡
  for (let i = 0; i < 600; i++) harnessMessagesEl.appendChild(fakeNode()); // 600 张无戳工具卡，顶过 SCAN_LIMIT=500

  const seed = timeline.lastTimestampIn(harnessMessagesEl);
  assert.equal(seed, undefined, '前置条件：扫满上限应返回 undefined 哨兵');

  const frag = fakeNode();
  timeline.beginFragment(frag, { seedPrevTs: seed })(bubble(), at(2026, 8, 4, 9, 5), 'user');
  assert.deepEqual(markers(frag).map(n => n.dataset.markerKind), [],
    '★ 看不见前一条 ≠ 没有前一条：宁可不插行，也不能凭空冒出一条日期分隔行');
});

test('lastTimestampIn：反向扫描跳过工具卡与 ephemeral live 行', () => {
  const { timeline, messagesEl } = harness();
  timeline.appendWithTime(bubble(), at(2026, 8, 4, 9, 0), 'user');
  messagesEl.appendChild(fakeNode());                       // 工具卡（无 data-ts）
  messagesEl.appendChild(fakeNode());                       // thinking
  messagesEl.appendChild(fakeNode({ ephemeral: '1' }));      // #streamLiveStatus
  assert.equal(timeline.lastTimestampIn(messagesEl), at(2026, 8, 4, 9, 0));
});

test('marker 文案用 textContent 写入，不经 innerHTML', () => {
  const { timeline, messagesEl } = harness();
  timeline.appendWithTime(bubble(), at(2026, 8, 4, 9, 0), 'user');
  const marker = markers(messagesEl)[0];
  assert.ok(marker.textContent.includes('09:00'), `文案应含时刻，实得 ${marker.textContent}`);
  assert.equal(marker.innerHTML, null, 'marker 不得走 innerHTML');
});

// unread-pill.spec.ts:81 用 [data-testid="assistant-message"]:last-of-type 定位锚点，
// 而 :last-of-type 按同级同 tag（都是 div）判定 —— marker 一旦落在尾部，该 spec 会报 expect(null)，
// 错误信息完全指不到时间戳功能。这条钉死插入顺序。
test('marker 必须先于气泡插入，append 后最后一个元素恒为气泡', () => {
  const { timeline, messagesEl } = harness();
  timeline.appendWithTime(bubble(), at(2026, 8, 4, 9, 0), 'user');
  timeline.appendWithTime(bubble(), at(2026, 8, 5, 9, 0), 'user');
  timeline.appendWithTime(bubble(), at(2026, 8, 5, 10, 0), 'user');
  assert.equal(messagesEl.children.at(-1).dataset.markerKind, undefined);
  assert.equal(messagesEl.children.at(-1).dataset.topLevel, '1');
});

// 一个 agentic 回合可以连着堆几百张工具卡，反向扫描不能无界。
// ★「扫满没找到」必须与「容器里确实没有」分开：前者只说明前一条在视野之外，绝不是会话首条。
// 混同两者会让对话中间凭空冒出一条整宽日期分隔行，看起来像会话在这里重新开始了。
test('lastTimestampIn：扫满上限返回 undefined，与「确实没有」的 null 区分开', () => {
  const { timeline, messagesEl } = harness();
  assert.equal(timeline.lastTimestampIn(messagesEl), null, '空容器 = 确实没有');

  timeline.appendWithTime(bubble(), at(2026, 8, 4, 9, 0), 'user');
  for (let i = 0; i < 600; i++) messagesEl.appendChild(fakeNode());
  assert.equal(timeline.lastTimestampIn(messagesEl), undefined, '扫满未命中');
});

test('扫满上限：只打 data-ts 不插行，不得误判成会话首条而插日期行', () => {
  const { timeline, messagesEl } = harness();
  timeline.appendWithTime(bubble(), at(2026, 8, 4, 9, 0), 'user');
  const before = messagesEl.children.filter(n => n.dataset.markerKind).length;
  for (let i = 0; i < 600; i++) messagesEl.appendChild(fakeNode());

  timeline.appendWithTime(bubble(), at(2026, 8, 4, 9, 1), 'user');
  assert.equal(messagesEl.children.filter(n => n.dataset.markerKind).length, before, '不得新增 marker');
  assert.equal(messagesEl.children.at(-1).dataset.ts, String(at(2026, 8, 4, 9, 1)), '气泡仍要打戳');
});

// 离线占位转正：占位创建时刻意不打 data-ts（客户端时钟不可信），等 user_message 带回服务端权威
// 时刻才补。但补戳之外还得补时间行——否则「离线发出、隔了很久甚至跨天才重连」的那条消息，实时
// 视图里一行时间都没有，下拉刷新从磁盘历史重渲染时却冒出来，同一条消息两种样子。
test('settleAt：给已在 DOM 里的占位气泡补戳，并在它【之前】插时间行', () => {
  const { timeline, messagesEl } = harness();
  timeline.appendWithTime(bubble(), at(2026, 8, 4, 9, 0), 'user');   // 已有一条，带戳

  const placeholder = bubble();                                      // 离线占位：无 data-ts
  timeline.appendWithTime(placeholder, null, 'user');
  assert.equal(placeholder.dataset.ts, undefined);
  const beforeCount = messagesEl.children.filter(n => n.dataset.markerKind).length;

  timeline.settleAt(placeholder, at(2026, 8, 5, 10, 0), 'user');      // 跨天转正
  assert.equal(placeholder.dataset.ts, String(at(2026, 8, 5, 10, 0)));
  const ms = messagesEl.children.filter(n => n.dataset.markerKind);
  assert.equal(ms.length, beforeCount + 1, '跨天必须补一条 day 行');
  assert.equal(messagesEl.children[messagesEl.children.indexOf(placeholder) - 1], ms.at(-1),
    'marker 必须紧挨在占位气泡之前，而不是追加到容器尾部');
});

test('settleAt：同日短间隔转正不插行，但仍补戳', () => {
  const { timeline, messagesEl } = harness();
  timeline.appendWithTime(bubble(), at(2026, 8, 4, 9, 0), 'user');
  const placeholder = bubble();
  timeline.appendWithTime(placeholder, null, 'user');
  const before = messagesEl.children.filter(n => n.dataset.markerKind).length;

  timeline.settleAt(placeholder, at(2026, 8, 4, 9, 1), 'user');
  assert.equal(messagesEl.children.filter(n => n.dataset.markerKind).length, before);
  assert.equal(placeholder.dataset.ts, String(at(2026, 8, 4, 9, 1)));
});

test('settleAt：ts 非法或节点不在 DOM 里时安全退化，不抛错不插行', () => {
  const { timeline, messagesEl } = harness();
  timeline.appendWithTime(bubble(), at(2026, 8, 4, 9, 0), 'user');
  const before = messagesEl.children.filter(n => n.dataset.markerKind).length;

  timeline.settleAt(bubble(), at(2026, 8, 4, 9, 30), 'user');   // 游离节点，无 parent
  timeline.settleAt(null, at(2026, 8, 4, 9, 30), 'user');
  const orphan = bubble();
  messagesEl.appendChild(orphan);
  timeline.settleAt(orphan, 'not-a-date', 'user');

  assert.equal(messagesEl.children.filter(n => n.dataset.markerKind).length, before);
  assert.equal(orphan.dataset.ts, undefined);
});

// 全量历史加载与增量追平对「基准从哪来」的要求是相反的：
//  · 增量追平（history_append）：新 frag 是空的，必须回落读 #messages 尾巴接上前面的批次
//  · 全量加载（loadHistory）：这批就是整个会话的开头，frag 首条【就是】会话首条
// 后者若也回落，会撞上一个真实竞态——renderHistoryBubbles 分块渲染期间 frag 还没插入 #messages，
// 此时若有实时事件落进 #messages（切入一个正在跑的会话时完全可能），frag 首条就会回落读到那条
// live 气泡的【当下】时刻，而历史更早 → 规则3 判成时间倒流 → 整段历史一个日期头都不出。
test('全量加载模式（seedPrevTs=null）：frag 首条不看 messagesEl，即使 messagesEl 里已有更晚的 live 气泡也照出日期头', () => {
  const { timeline } = harness();
  timeline.appendWithTime(bubble(), at(2026, 8, 4, 15, 0), 'user'); // 竞态：live 气泡先落地

  const frag = fakeNode();
  timeline.beginFragment(frag, { seedPrevTs: null })(bubble(), at(2026, 8, 4, 9, 0), 'user');
  assert.deepEqual(markers(frag).map(n => n.dataset.markerKind), ['day'],
    '全量加载的首条必须给日期头，不受 messagesEl 里更晚的 live 气泡影响');
});

test('全量加载模式：frag 内部仍按顺序判定，第二条不会重复日期头', () => {
  const { timeline } = harness();
  const frag = fakeNode();
  const add = timeline.beginFragment(frag, { seedPrevTs: null });
  add(bubble(), at(2026, 8, 4, 9, 0), 'user');
  add(bubble(), at(2026, 8, 4, 9, 1), 'user');
  assert.deepEqual(markers(frag).map(n => n.dataset.markerKind), ['day']);
});

test('同一 fragment 内基准顺着往下带，不必每条反向扫', () => {
  const { timeline } = harness();
  const frag = fakeNode();
  const add = timeline.beginFragment(frag, { seedPrevTs: null });
  add(bubble(), at(2026, 8, 4, 9, 0), 'user');    // day
  add(bubble(), at(2026, 8, 4, 9, 2), 'user');    // 同日 2 分钟 → 无
  add(bubble(), at(2026, 8, 4, 9, 40), 'user');   // 超阈值 → time
  assert.deepEqual(markers(frag).map(n => n.dataset.markerKind), ['day', 'time']);
});
