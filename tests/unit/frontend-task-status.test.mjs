// 后台任务横幅/列表/详情的行为单测（从 frontend-app-modules 拆出：这一组测试自成一个
// 行为域——横幅可见性、列表折叠、详情内联在任务卡片内）。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppContext } from '../../app/public/js/app/context.js';
import { createTaskStatusController } from '../../app/public/js/app/task-status.js';

test('task status controller ignores other instances and updates the current progress banner', () => {
  const hidden = new Set(['hidden']);
  const banner = {
    classList: {
      contains: name => hidden.has(name),
      add: name => hidden.add(name),
      remove: name => hidden.delete(name),
    },
  };
  const textNode = { textContent: '' };
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText: textNode },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, { autoBind: false });

  assert.equal(status.onProgress({ instanceId: 'inst-2', payload: { message: 'wrong' } }), false);
  assert.equal(status.onProgress({ instanceId: 'inst-1', payload: { taskId: 't1', message: 'running' } }), true);
  // b4716e7 起横幅只写数量/状态（固定标签在 HTML、明细在列表行），不再回显任务 message 原文
  assert.equal(textNode.textContent, '运行中');
  assert.equal(hidden.has('hidden'), false);
  assert.equal(status.onProgress({ instanceId: 'inst-1', payload: { taskId: 't2', message: 'another' } }), true);
  assert.equal(textNode.textContent, '2 个运行中');
});

test('task status onComplete：未知 taskId 不整清横幅（对齐服务端 bgTaskDone no-op）', () => {
  const hidden = new Set(['hidden']);
  const banner = {
    classList: {
      contains: name => hidden.has(name),
      add: name => hidden.add(name),
      remove: name => hidden.delete(name),
    },
  };
  const textNode = { textContent: '' };
  const bars = [];
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText: textNode },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, {
    autoBind: false,
    addBar: (msg) => bars.push(msg),
  });

  status.onProgress({
    instanceId: 'inst-1',
    payload: { tasks: [{ taskId: 'still-running', message: 'npm run test:e2e', taskType: 'local_bash' }] },
  });
  assert.equal(hidden.has('hidden'), false, '横幅应亮');

  // 快任务完成 id 从未进前端 map（或与心跳 id 不一致）——旧逻辑走 else hideProgress 误灭仍在跑者
  status.onComplete({
    instanceId: 'inst-1',
    payload: { taskId: 'orphan-fast-task', status: 'completed', summary: '快任务完成' },
  });
  assert.equal(hidden.has('hidden'), false, '未知 taskId 不得整清横幅');
  assert.equal(textNode.textContent, '运行中');
  assert.ok(bars.some(b => String(b).includes('后台任务完成') || String(b).includes('快任务')), '完成条仍应写入');

  // 匹配 id 精确删 → 表空才藏
  status.onComplete({
    instanceId: 'inst-1',
    payload: { taskId: 'still-running', status: 'completed', summary: 'e2e done' },
  });
  assert.equal(hidden.has('hidden'), true, '匹配完成且无剩余任务才撤横幅');
});

test('task status controller collapses the multi-task list by default and expands via the banner header', () => {
  function fakeNode() {
    const classes = new Set();
    const attrs = {};
    const listeners = {};
    return {
      classList: {
        add: (...names) => names.forEach(n => classes.add(n)),
        remove: (...names) => names.forEach(n => classes.delete(n)),
        contains: name => classes.has(name),
        toggle: (name, force) => {
          const next = force === undefined ? !classes.has(name) : Boolean(force);
          if (next) classes.add(name); else classes.delete(name);
          return next;
        },
      },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: k => attrs[k],
      addEventListener: (type, handler) => { listeners[type] = handler; },
      click: () => listeners.click?.(),
      // role="button" 的键盘等价路径：直接喂 keydown handler（fakeNode 不模拟冒泡，
      // 「按钮上的 Enter 不冒泡到折叠热区」由 E2E P0-17n 守）
      press: key => { const ev = { key, prevented: false, preventDefault() { this.prevented = true; } }; listeners.keydown?.(ev); return ev; },
      append: () => {},
      appendChild: () => {},
      replaceChildren: () => {},
      textContent: '',
    };
  }

  const banner = fakeNode();
  const taskProgressText = { textContent: '' };
  const taskBannerToggle = fakeNode();
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText, taskBannerToggle },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, { createElement: fakeNode });

  const taskBannerChevron = { textContent: '▸' };
  context.dom.taskBannerChevron = taskBannerChevron;

  status.onProgress({ instanceId: 'inst-1', payload: { tasks: [{ taskId: 't1', message: 'one' }] } });
  assert.equal(taskProgressText.textContent, '运行中');
  assert.equal(context.dom.taskProgressList.classList.contains('hidden'), false, '单任务默认展开');
  assert.equal(taskBannerToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(taskBannerChevron.textContent, '▾');

  status.onProgress({
    instanceId: 'inst-1',
    payload: { tasks: [{ taskId: 't1', message: 'one' }, { taskId: 't2', message: 'two' }] },
  });
  assert.equal(taskProgressText.textContent, '2 个运行中');
  assert.equal(context.dom.taskProgressList.classList.contains('hidden'), true, '多任务默认收起');
  assert.equal(taskBannerToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(taskBannerChevron.textContent, '▸');

  taskBannerToggle.click();
  assert.equal(context.dom.taskProgressList.classList.contains('hidden'), false, '点击后展开');
  assert.equal(taskBannerToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(taskBannerChevron.textContent, '▾');

  taskBannerToggle.click();
  assert.equal(context.dom.taskProgressList.classList.contains('hidden'), true, '再次点击收起');

  // 折叠热区是 role="button" 的 div，没有原生键盘语义——Enter/Space 必须自己接，且要 preventDefault
  // 挡掉 Space 的滚动页面默认行为。其它键一律放行，不能吃掉。
  const enter = taskBannerToggle.press('Enter');
  assert.equal(context.dom.taskProgressList.classList.contains('hidden'), false, 'Enter 展开');
  assert.equal(taskBannerToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(enter.prevented, true, 'Enter 须 preventDefault');

  const space = taskBannerToggle.press(' ');
  assert.equal(context.dom.taskProgressList.classList.contains('hidden'), true, 'Space 收起');
  assert.equal(space.prevented, true, 'Space 须 preventDefault，否则会滚动页面');

  const tab = taskBannerToggle.press('Tab');
  assert.equal(context.dom.taskProgressList.classList.contains('hidden'), true, 'Tab 不得改变折叠态');
  assert.equal(tab.prevented, false, 'Tab 须放行，不能吃掉焦点移动');
});

// 记录型 fakeNode：把 createElement 收到的 HTML 串留在 .html 上，才能断言「详情块渲染在哪张卡片里」。
// 焦点替身：taskCardFakeNode 的 focus() 写这里，ownerDocument 指向它（#402 重绘还焦）
const fakeTaskDoc = { activeElement: null };
function taskCardFakeNode(html = '') {
  const classes = new Set();
  const attrs = {};
  const listeners = {};
  const children = [];
  const walk = function* (node) {
    for (const c of node.children || []) { yield c; yield* walk(c); }
  };
  return {
    html: String(html),
    ownerDocument: fakeTaskDoc,
    focus() { fakeTaskDoc.activeElement = this; },
    contains(n) { for (const c of walk(this)) if (c === n) return true; return n === this; },
    querySelectorAll(sel) {
      const m = /^\[([a-z-]+)\]$/.exec(sel);
      return m ? [...walk(this)].filter(c => c.getAttribute?.(m[1]) != null) : [];
    },
    classList: {
      add: (...names) => names.forEach(n => classes.add(n)),
      remove: (...names) => names.forEach(n => classes.delete(n)),
      contains: name => classes.has(name),
      toggle: (name, force) => {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: k => attrs[k],
    addEventListener: (type, handler) => { listeners[type] = handler; },
    click: () => listeners.click?.(),
    append: (...nodes) => children.push(...nodes),
    appendChild: (n) => { children.push(n); return n; },
    replaceChildren: () => { children.length = 0; },
    children,
    textContent: '',
    title: '',
  };
}

// 卡片结构：children[0] 恒为 bg-task-row 头行，展开时 children[1] 才是详情块。
// 头行内 top.children[0] 是左侧 expand 按钮（▸/▾ + 标题），「停」是其兄弟。
const cardHeaderRow = card => card.children[0];
const cardDetail = card => card.children.find(c => String(c.html).includes('task-detail-panel')) || null;
const rowExpandBtn = card => cardHeaderRow(card)?.children?.[0]?.children?.[0] || null;

test('task status 详情面板渲染在被点击任务的卡片内，而非整列表下方', () => {
  const banner = taskCardFakeNode();
  const taskProgressText = { textContent: '' };
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, { createElement: taskCardFakeNode });

  status.onProgress({
    instanceId: 'inst-1',
    payload: { tasks: [
      { taskId: 't1', message: 'one', description: 'doing one' },
      { taskId: 't2', message: 'two', description: 'doing two' },
    ] },
  });

  const cards = context.dom.taskProgressList.children;
  assert.equal(cards.length, 2);
  assert.equal(cardDetail(cards[0]), null, '未点击时不渲染详情');

  // 点 t1 的头行 → 详情必须落在 t1 自己的卡片里，t2 卡片不受影响。
  rowExpandBtn(cards[0]).click();
  const detail = cardDetail(context.dom.taskProgressList.children[0]);
  assert.ok(detail, 't1 卡片内应含详情块');
  assert.ok(detail.children.length > 0, '应渲染出历史条目');
  assert.equal(cardDetail(context.dom.taskProgressList.children[1]), null, 't2 卡片不应有详情');

  // 再点同一行 → 收起
  rowExpandBtn(context.dom.taskProgressList.children[0]).click();
  assert.equal(cardDetail(context.dom.taskProgressList.children[0]), null, '再次点击应收起详情');
});

test('task status 折叠整列表不遗留详情，展开后详情仍在原卡片内', () => {
  const banner = taskCardFakeNode();
  const taskProgressText = { textContent: '' };
  const taskBannerToggle = taskCardFakeNode();
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText, taskBannerToggle },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, { createElement: taskCardFakeNode });

  status.onProgress({
    instanceId: 'inst-1',
    payload: { tasks: [{ taskId: 't1', message: 'one', description: 'doing one' }] },
  });
  const list = context.dom.taskProgressList;
  rowExpandBtn(list.children[0]).click();
  assert.ok(cardDetail(list.children[0]), '详情已展开');

  // 折叠整列表：详情在 list 内部，必须随之隐藏——旧实现里详情面板挂在横幅外，
  // 折叠后仍显示且任务行已不可见，用户点不到任何东西去关掉它。
  taskBannerToggle.click();
  assert.equal(list.classList.contains('hidden'), true, '列表已折叠');
  assert.ok(cardDetail(list.children[0]), '详情随卡片一起被 hidden，状态不丢');

  taskBannerToggle.click();
  assert.equal(list.classList.contains('hidden'), false, '重新展开');
  assert.ok(cardDetail(list.children[0]), '展开后详情保持原展开态');
});

test('task status onComplete：清理已完成任务的 progressHistory，若详情面板正显示该任务则自动关闭', () => {
  const banner = taskCardFakeNode();
  const taskProgressText = { textContent: '' };
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, { createElement: taskCardFakeNode });

  status.onProgress({
    instanceId: 'inst-1',
    payload: { tasks: [
      { taskId: 't1', message: 'one', description: 'doing one' },
      { taskId: 't2', message: 'two', description: 'doing two' },
    ] },
  });

  // 点击 t1 所在卡片的头行 → 展开详情（renderTaskList 按 Map 插入序渲染，t1 是第一张卡）
  const cards = context.dom.taskProgressList.children;
  assert.equal(cards.length, 2);
  rowExpandBtn(cards[0]).click();
  assert.ok(cardDetail(context.dom.taskProgressList.children[0]), '详情应展开');

  // t1 完成、t2 仍在跑：不整清横幅，但正开着的 t1 详情必须随任务一起消失——否则面板停留在陈旧数据上。
  status.onComplete({ instanceId: 'inst-1', payload: { taskId: 't1', status: 'completed' } });

  const remaining = context.dom.taskProgressList.children;
  assert.equal(remaining.length, 1, 't1 卡片须移除');
  assert.equal(cardDetail(remaining[0]), null, '剩下的 t2 卡片不得残留详情');
});

const isGroupHeader = node => String(node?.html || '').includes('bg-task-group');

test('task status 横幅：单一种类改标题，状态文案沿用数量', () => {
  const banner = taskCardFakeNode();
  const taskProgressText = { textContent: '' };
  const taskBannerLabel = { textContent: '后台任务' };
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText, taskBannerLabel },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, { createElement: taskCardFakeNode });

  status.onProgress({
    instanceId: 'inst-1',
    payload: { tasks: [
      { taskId: 'a1', taskType: 'local_agent', message: 'Explore：a' },
      { taskId: 'a2', taskType: 'local_agent', message: 'Explore：b' },
    ] },
  });
  assert.equal(taskBannerLabel.textContent, '子代理');
  assert.equal(taskProgressText.textContent, '2 个运行中');
  assert.equal(context.dom.taskProgressList.children.some(isGroupHeader), false, '单一种类不渲染组头');
});

test('task status 横幅：混合改报构成，列表按种类分组', () => {
  const banner = taskCardFakeNode();
  const taskProgressText = { textContent: '' };
  const taskBannerLabel = { textContent: '后台任务' };
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText, taskBannerLabel },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, { createElement: taskCardFakeNode });

  status.onProgress({
    instanceId: 'inst-1',
    payload: { tasks: [
      { taskId: 'b1', taskType: 'local_bash', message: 'npm test' },
      { taskId: 'a1', taskType: 'local_agent', message: 'Explore：搜索' },
      { taskId: 'a2', taskType: 'local_agent', message: 'Plan：起草' },
    ] },
  });
  assert.equal(taskBannerLabel.textContent, '运行中');
  assert.equal(taskProgressText.textContent, '2 个子代理 · 1 条命令');

  const kids = context.dom.taskProgressList.children;
  const headers = kids.filter(isGroupHeader);
  assert.equal(headers.length, 2);
  assert.equal(headers[0].textContent, '子代理');
  assert.equal(headers[1].textContent, '后台命令');
  // 组顺序：两个 agent 卡在 bash 卡之前，即使快照里 bash 更靠前
  const rows = kids.filter(n => !isGroupHeader(n));
  assert.equal(rows.length, 3);
  const rowTitle = card => {
    const expand = rowExpandBtn(card);
    const label = expand?.children?.find(n => String(n.html || '').includes('truncate'));
    return String(label?.textContent || '');
  };
  assert.match(rowTitle(rows[0]), /Explore/);
  assert.match(rowTitle(rows[1]), /Plan/);
  assert.match(rowTitle(rows[2]), /npm test/);
});

const mixedSnapshot = {
  instanceId: 'inst-1',
  payload: { tasks: [
    { taskId: 'b1', taskType: 'local_bash', message: 'npm test', description: 'npm test' },
    { taskId: 'a1', taskType: 'local_agent', message: 'Explore：搜索', description: 'Explore：搜索' },
    { taskId: 'a2', taskType: 'local_agent', message: 'Plan：起草', description: 'Plan：起草' },
  ] },
};

const rowStopBtn = card => {
  const top = cardHeaderRow(card)?.children?.[0];
  return top?.children?.find(n => String(n.html).includes('bg-task-stop')) || null;
};

test('task status hideProgress 把标题复位成「后台任务」', () => {
  const banner = taskCardFakeNode();
  const taskProgressText = { textContent: '' };
  const taskBannerLabel = { textContent: '后台任务' };
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText, taskBannerLabel },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, { createElement: taskCardFakeNode, autoBind: false });

  status.onProgress({
    instanceId: 'inst-1',
    payload: { tasks: [{ taskId: 'a1', taskType: 'local_agent', message: 'Explore：a' }] },
  });
  assert.equal(taskBannerLabel.textContent, '子代理');
  assert.equal(banner.classList.contains('hidden'), false);

  status.hideProgress();
  assert.equal(taskBannerLabel.textContent, '后台任务');
  assert.equal(taskProgressText.textContent, '');
  assert.equal(banner.classList.contains('hidden'), true);
});

test('task status onComplete：混合收成单一种类后标题改回种类名、组头消失', () => {
  const banner = taskCardFakeNode();
  const taskProgressText = { textContent: '' };
  const taskBannerLabel = { textContent: '后台任务' };
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText, taskBannerLabel },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, { createElement: taskCardFakeNode, autoBind: false });

  status.onProgress(mixedSnapshot);
  assert.equal(taskBannerLabel.textContent, '运行中');
  assert.equal(context.dom.taskProgressList.children.filter(isGroupHeader).length, 2);

  status.onComplete({ instanceId: 'inst-1', payload: { taskId: 'b1', status: 'completed' } });
  assert.equal(taskBannerLabel.textContent, '子代理');
  assert.equal(taskProgressText.textContent, '2 个运行中');
  assert.equal(context.dom.taskProgressList.children.some(isGroupHeader), false, '单一种类不得残留组头');
  assert.equal(context.dom.taskProgressList.children.length, 2);
});

test('task status 混合列表：组头不抢点击，第一张卡是被提前的子代理，停钮绑的是该行 id', () => {
  const banner = taskCardFakeNode();
  const taskProgressText = { textContent: '' };
  const taskBannerLabel = { textContent: '后台任务' };
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText, taskBannerLabel },
    state: { viewingInstanceId: 'inst-1' },
  });
  const emitted = [];
  context.setSocket({ emit: (ev, payload) => { emitted.push({ ev, payload }); } });
  const status = createTaskStatusController(context, { createElement: taskCardFakeNode, autoBind: false });

  status.onProgress(mixedSnapshot);
  const kids = context.dom.taskProgressList.children;
  const headers = kids.filter(isGroupHeader);
  const rows = kids.filter(n => !isGroupHeader(n));
  assert.equal(headers.length, 2);
  assert.equal(rows.length, 3);

  headers[0].click();
  const afterHeaderClick = context.dom.taskProgressList.children.filter(n => !isGroupHeader(n));
  assert.equal(afterHeaderClick.every(card => cardDetail(card) == null), true, '点组头不得展开任何详情');

  rowExpandBtn(rows[0]).click();
  const rowsAfter = context.dom.taskProgressList.children.filter(n => !isGroupHeader(n));
  assert.ok(cardDetail(rowsAfter[0]), '第一张卡（Explore，被从 bash 后面提前）应展开详情');
  assert.equal(cardDetail(rowsAfter[1]), null);
  assert.equal(cardDetail(rowsAfter[2]), null);

  const stop = rowStopBtn(rowsAfter[0]);
  assert.ok(stop, '真实 taskId 的行应有停钮');
  assert.equal(rowStopBtn(headers[0]), null, '组头上不得挂停钮');
  stop.onclick?.({ stopPropagation() {} });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].ev, 'task:stop');
  assert.equal(emitted[0].payload.taskId, 'a1', '停的是提前到第一行的 Explore，不是快照里排在最前的 bash');
});



// B4（2026-09-07）：CLI 的 skip_transcript = housekeeping 任务。
// 原话："Ambient/housekeeping task. Consumers should hide this from the inline transcript;
// it may still appear in a tasks panel."ccm 此前零消费——live-update watcher 之类跑完
// 照样往消息流打一条「🔔 后台任务完成」并弹通知。
function completeHarness() {
  const hidden = new Set(['hidden']);
  const banner = {
    classList: {
      contains: name => hidden.has(name),
      add: name => hidden.add(name),
      remove: name => hidden.delete(name),
    },
  };
  const bars = [];
  const notes = [];
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText: { textContent: '' } },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, {
    autoBind: false,
    addBar: (text, cls) => { bars.push({ text, cls }); return null; },
    notify: (title, body) => notes.push({ title, body }),
  });
  return { status, bars, notes, hidden };
}

test('B4：skip_transcript 的任务不写消息流、不弹通知', () => {
  const { status, bars, notes } = completeHarness();
  status.onComplete({
    instanceId: 'inst-1',
    payload: { taskId: 'amb1', status: 'completed', summary: 'watcher 收工', skipTranscript: true },
  });
  assert.equal(bars.length, 0, 'housekeeping 任务不得写进消息流');
  assert.equal(notes.length, 0, '消息流里查无此事却弹通知是自相矛盾的');
});

// 反向档：没有这条，实现写成「一律不打」也能让上面那条过。
test('B4 反向：普通后台任务照常写消息流并通知（防修过头）', () => {
  const { status, bars, notes } = completeHarness();
  status.onComplete({
    instanceId: 'inst-1',
    payload: { taskId: 'normal1', status: 'completed', summary: '跑完了' },
  });
  assert.equal(bars.length, 1, '普通任务必须照常留痕');
  assert.match(bars[0].text, /后台任务完成/);
  assert.equal(notes.length, 1);

  // skipTranscript 显式 false 同样照常
  status.onComplete({
    instanceId: 'inst-1',
    payload: { taskId: 'normal2', status: 'completed', skipTranscript: false },
  });
  assert.equal(bars.length, 2);
});

test('B4：skip_transcript 任务仍从活任务表摘掉，横幅不会挂着一条永不消失的任务', () => {
  const { status, hidden } = completeHarness();
  status.onProgress({ instanceId: 'inst-1', payload: { taskId: 'amb2', message: 'watching…' } });
  assert.equal(hidden.has('hidden'), false, '横幅此时可见');
  status.onComplete({
    instanceId: 'inst-1',
    payload: { taskId: 'amb2', status: 'completed', skipTranscript: true },
  });
  assert.equal(hidden.has('hidden'), true, '摘掉最后一条后横幅须收起');
});

// 验收 O82（AC-11-07）：同一条「后台任务完成」在一个标签页里显示了两遍（fake-claude 只发一次；验收与本轮都没复现出
// 来源）。同一来源、同一 taskId 的完成通知是同一件事：当前消息流里已经画过就不再画、不再响。
// 以 DOM 为准——清屏重载后那一行没了，重放来的这一条要照常画回来（但不再弹一次通知）。
function dedupeHarness() {
  const bars = [];
  const notes = [];
  const context = createAppContext({
    dom: { taskProgressBanner: { classList: { contains: () => true, add() {}, remove() {} } }, taskProgressText: { textContent: '' } },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, {
    autoBind: false,
    addBar: (text, cls) => { const bar = { text, cls, isConnected: true }; bars.push(bar); return bar; },
    notify: (title, body) => notes.push({ title, body }),
  });
  return { status, bars, notes };
}

test('O82：同一来源同一 taskId 的完成通知只画一行、只响一次', () => {
  const { status, bars, notes } = dedupeHarness();
  const done = { instanceId: 'inst-1', sessionId: 's1', payload: { source: 'system', taskId: 'bg1', status: 'completed', summary: '后台任务跑完了' } };
  status.onComplete(done);
  status.onComplete(structuredClone(done));
  assert.equal(bars.length, 1, '同一件事画了两行');
  assert.equal(notes.length, 1, '同一件事响了两次');
});

test('O82：清屏后那一行不在了，重放来的同一条照常画回来，但不再弹通知', () => {
  const { status, bars, notes } = dedupeHarness();
  const done = { instanceId: 'inst-1', sessionId: 's1', payload: { source: 'system', taskId: 'bg2', status: 'completed' } };
  status.onComplete(done);
  bars[0].isConnected = false; // clearView 摘掉了它
  status.onComplete(done);
  assert.equal(bars.length, 2);
  assert.equal(notes.length, 1);
});

test('O82 反向：不同 taskId、不同来源、没有 taskId 都照常各画各的（防修过头）', () => {
  const { status, bars } = dedupeHarness();
  status.onComplete({ instanceId: 'inst-1', sessionId: 's1', payload: { source: 'system', taskId: 'a', status: 'completed' } });
  status.onComplete({ instanceId: 'inst-1', sessionId: 's1', payload: { source: 'system', taskId: 'b', status: 'completed' } });
  status.onComplete({ instanceId: 'inst-1', sessionId: 's1', payload: { source: 'user_injection', taskId: 'a', status: 'completed' } });
  status.onComplete({ instanceId: 'inst-1', sessionId: 's1', payload: { source: 'system', status: 'completed' } });
  status.onComplete({ instanceId: 'inst-1', sessionId: 's1', payload: { source: 'system', status: 'completed' } });
  assert.equal(bars.length, 5);
});

// PR #274 review：长开着的 PWA 标签页里，去重记录不能只增不减（每一条完成都留着它那一行的 DOM 子树和键）。
// 有界：完成过足够多条之后，最早那条被淘汰——它再重放会再响一次；最近的仍记得。
test('O82：去重记录有界——很久以前的那条被淘汰，最近的仍去重', () => {
  const { status, bars, notes } = dedupeHarness();
  const done = id => ({ instanceId: 'inst-1', sessionId: 's1', payload: { source: 'system', taskId: id, status: 'completed' } });
  for (let i = 0; i < 1000; i++) {
    status.onComplete(done(`t${i}`));
    bars[bars.length - 1].isConnected = false; // 清屏摘掉
  }
  assert.equal(notes.length, 1000);
  status.onComplete(done('t999'));
  assert.equal(notes.length, 1000, '最近那条重放不该再响');
  status.onComplete(done('t0'));
  assert.equal(notes.length, 1001, '最早那条应已被淘汰（记录有界）');
});


test('#402 bg-task-row expand button exposes aria-expanded and ▸/▾', () => {
  const banner = taskCardFakeNode();
  const taskProgressText = { textContent: '' };
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, { createElement: taskCardFakeNode });

  status.onProgress({
    instanceId: 'inst-1',
    payload: { tasks: [{ taskId: 't1', message: 'one', description: 'doing one' }] },
  });
  const expand = rowExpandBtn(context.dom.taskProgressList.children[0]);
  assert.ok(expand, 'row must have expand button');
  assert.match(String(expand.html || ''), /type="button"/);
  assert.match(String(expand.html || ''), /data-testid="bg-task-expand"/);
  assert.equal(expand.getAttribute('aria-expanded'), 'false');
  assert.equal(expand.children[0]?.textContent, '▸');

  expand.click();
  const expandOpen = rowExpandBtn(context.dom.taskProgressList.children[0]);
  assert.equal(expandOpen.getAttribute('aria-expanded'), 'true');
  assert.equal(expandOpen.children[0]?.textContent, '▾');
  assert.ok(cardDetail(context.dom.taskProgressList.children[0]), 'detail opens');
});

test('#402 键盘按「展开」后焦点留在重绘出来的同一颗钮上，心跳重绘也不甩焦点', () => {
  const banner = taskCardFakeNode();
  const taskProgressText = { textContent: '' };
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, { createElement: taskCardFakeNode });
  const progress = () => status.onProgress({
    instanceId: 'inst-1',
    payload: { tasks: [{ taskId: 't1', message: 'one', description: 'doing one' }, { taskId: 't2', message: 'two' }] },
  });
  progress();
  const list = context.dom.taskProgressList;
  const expand = rowExpandBtn(list.children[1]);
  expand.focus();
  expand.click(); // 键盘回车在 <button> 上等价 click
  const after = rowExpandBtn(list.children[1]);
  assert.notEqual(after, expand, '前提：重绘换了新节点');
  assert.equal(fakeTaskDoc.activeElement, after, '展开后焦点没回到这一行的展开钮');
  assert.equal(after.getAttribute('aria-expanded'), 'true');

  progress(); // 心跳
  assert.equal(fakeTaskDoc.activeElement, rowExpandBtn(list.children[1]), '心跳重绘把焦点甩掉了');
  fakeTaskDoc.activeElement = null;
});

test('#402 bg-task-row click (not only expand btn) opens detail panel', () => {
  const banner = taskCardFakeNode();
  const taskProgressText = { textContent: '' };
  const context = createAppContext({
    dom: { taskProgressBanner: banner, taskProgressText },
    state: { viewingInstanceId: 'inst-1' },
  });
  const status = createTaskStatusController(context, { createElement: taskCardFakeNode });

  status.onProgress({
    instanceId: 'inst-1',
    payload: { tasks: [{ taskId: 't1', message: 'one', description: 'doing one' }] },
  });
  const row = cardHeaderRow(context.dom.taskProgressList.children[0]);
  assert.ok(row, 'bg-task-row header present');
  row.click();
  assert.ok(cardDetail(context.dom.taskProgressList.children[0]), 'row click opens detail');
  // 再点同行收起（回归：整行热区，不只 expand 按钮）
  cardHeaderRow(context.dom.taskProgressList.children[0]).click();
  assert.equal(cardDetail(context.dom.taskProgressList.children[0]), null, 'row click again collapses');
});
