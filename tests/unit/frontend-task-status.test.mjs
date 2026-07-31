// 后台任务横幅/列表/详情的行为单测（从 frontend-app-modules 拆出：那个文件已顶到 800 行上限，
// 而这一组测试自成一个行为域——横幅可见性、列表折叠、详情内联在任务卡片内）。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppContext } from '../../public/js/app/context.js';
import { createTaskStatusController } from '../../public/js/app/task-status.js';

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

  status.onProgress({ instanceId: 'inst-1', payload: { tasks: [{ taskId: 't1', message: 'one' }] } });
  assert.equal(taskProgressText.textContent, '运行中');
  assert.equal(context.dom.taskProgressList.classList.contains('hidden'), false, '单任务默认展开');
  assert.equal(taskBannerToggle.getAttribute('aria-expanded'), 'true');

  status.onProgress({
    instanceId: 'inst-1',
    payload: { tasks: [{ taskId: 't1', message: 'one' }, { taskId: 't2', message: 'two' }] },
  });
  assert.equal(taskProgressText.textContent, '2 个运行中');
  assert.equal(context.dom.taskProgressList.classList.contains('hidden'), true, '多任务默认收起');
  assert.equal(taskBannerToggle.getAttribute('aria-expanded'), 'false');

  taskBannerToggle.click();
  assert.equal(context.dom.taskProgressList.classList.contains('hidden'), false, '点击后展开');
  assert.equal(taskBannerToggle.getAttribute('aria-expanded'), 'true');

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
function taskCardFakeNode(html = '') {
  const classes = new Set();
  const attrs = {};
  const listeners = {};
  const children = [];
  return {
    html: String(html),
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
const cardHeaderRow = card => card.children[0];
const cardDetail = card => card.children.find(c => String(c.html).includes('task-detail-panel')) || null;

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
  cardHeaderRow(cards[0]).click();
  const detail = cardDetail(context.dom.taskProgressList.children[0]);
  assert.ok(detail, 't1 卡片内应含详情块');
  assert.ok(detail.children.length > 0, '应渲染出历史条目');
  assert.equal(cardDetail(context.dom.taskProgressList.children[1]), null, 't2 卡片不应有详情');

  // 再点同一行 → 收起
  cardHeaderRow(context.dom.taskProgressList.children[0]).click();
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
  cardHeaderRow(list.children[0]).click();
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
  cardHeaderRow(cards[0]).click();
  assert.ok(cardDetail(context.dom.taskProgressList.children[0]), '详情应展开');

  // t1 完成、t2 仍在跑：不整清横幅，但正开着的 t1 详情必须随任务一起消失——否则面板停留在陈旧数据上。
  status.onComplete({ instanceId: 'inst-1', payload: { taskId: 't1', status: 'completed' } });

  const remaining = context.dom.taskProgressList.children;
  assert.equal(remaining.length, 1, 't1 卡片须移除');
  assert.equal(cardDetail(remaining[0]), null, '剩下的 t2 卡片不得残留详情');
});
