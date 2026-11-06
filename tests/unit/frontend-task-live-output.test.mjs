// 运行中后台命令的输出轮询：什么时候拉、什么时候停（task-live-output.js）。
// 假 socket + 假定时器。真 DOM、真滚动、输出不被当 HTML 在 E2E 的 P0-17v。
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { createTaskLiveOutput } from '../../app/public/js/app/task-live-output.js';

const POLL_MS = 3000;

function setup({ visibilityState = 'visible' } = {}) {
  const sent = [];
  const paints = [];
  const listeners = new Map();
  const documentRef = {
    visibilityState,
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  const context = {
    state: { viewingInstanceId: 'inst-1' },
    socket: { timeout: () => ({ emit: (event, payload, ack) => sent.push({ event, payload, ack }) }) },
  };
  const live = createTaskLiveOutput(context, { documentRef, onChange: () => paints.push(live.display()) });
  const setVisibility = (state) => {
    documentRef.visibilityState = state;
    listeners.get('visibilitychange')();
  };
  const answer = (res, err = null) => sent.at(-1).ack(err, res);
  return { context, live, sent, paints, setVisibility, answer };
}

const okText = (text) => ({ ok: true, text, truncated: false, size: text.length });

describe('运行中任务的输出轮询', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('开始盯一个任务就问一次，只传 instanceId 和 taskId', () => {
    const { live, sent, answer, paints } = setup();
    live.watch('b1');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].event, 'task:output');
    assert.deepEqual(sent[0].payload, { instanceId: 'inst-1', taskId: 'b1' });
    assert.equal(live.display(), null, '回执到之前没有内容可显示');
    answer(okText('hello'));
    assert.equal(live.display(), 'hello');
    assert.deepEqual(paints, ['hello']);
  });

  it('隔一拍再问，第二次、第三次都照常', () => {
    const { live, sent, answer } = setup();
    live.watch('b1');
    answer(okText('1'));
    mock.timers.tick(POLL_MS - 1);
    assert.equal(sent.length, 1, '不到一拍不问');
    mock.timers.tick(1);
    assert.equal(sent.length, 2);
    answer(okText('2'));
    mock.timers.tick(POLL_MS);
    assert.equal(sent.length, 3);
    answer(okText('3'));
    assert.equal(live.display(), '3');
  });

  it('上一次没回来不发下一次：服务端卡住时不叠请求', () => {
    const { live, sent } = setup();
    live.watch('b1');
    mock.timers.tick(POLL_MS * 10);
    assert.equal(sent.length, 1);
  });

  it('收起后不再问，迟到的回执也不画', () => {
    const { live, sent, answer, paints } = setup();
    live.watch('b1');
    answer(okText('1'));
    mock.timers.tick(POLL_MS);
    assert.equal(sent.length, 2);
    live.watch(null);
    answer(okText('late'));
    mock.timers.tick(POLL_MS * 5);
    assert.equal(sent.length, 2);
    assert.deepEqual(paints, ['1']);
    assert.equal(live.display(), null);
  });

  it('换任务：旧任务的迟到回执不串到新任务上', () => {
    const { live, sent, paints } = setup();
    live.watch('b1');
    const stale = sent[0];
    live.watch('b2');
    assert.equal(sent.length, 2);
    assert.equal(sent[1].payload.taskId, 'b2');
    stale.ack(null, okText('from b1'));
    assert.equal(live.display(), null);
    assert.deepEqual(paints, []);
    sent[1].ack(null, okText('from b2'));
    assert.equal(live.display(), 'from b2');
  });

  it('同一个任务重复 watch 不多发：renderTaskList 每拍都会调', () => {
    const { live, sent } = setup();
    live.watch('b1');
    live.watch('b1');
    live.watch('b1');
    assert.equal(sent.length, 1);
    assert.equal(live.isWatching('b1'), true);
    assert.equal(live.isWatching('b2'), false);
  });

  it('实例在开始盯的时候定住：切视图后不把这个 taskId 发到别的实例', () => {
    const { context, live, sent, answer } = setup();
    live.watch('b1');
    answer(okText('1'));
    context.state.viewingInstanceId = 'inst-2';
    mock.timers.tick(POLL_MS);
    assert.equal(sent[1].payload.instanceId, 'inst-1');
  });

  it('页面不可见时不问，回到前台立刻补一次', () => {
    const { live, sent, answer, setVisibility } = setup();
    live.watch('b1');
    answer(okText('1'));
    setVisibility('hidden');
    mock.timers.tick(POLL_MS * 10);
    assert.equal(sent.length, 1, '切后台后不许再问');
    setVisibility('visible');
    assert.equal(sent.length, 2, '回到前台不用等下一拍');
    answer(okText('2'));
    mock.timers.tick(POLL_MS);
    assert.equal(sent.length, 3, '之后继续按拍轮询');
  });

  it('隐藏期间回执才到：不再排下一拍，回前台只补一次', () => {
    const { live, sent, answer, setVisibility } = setup();
    live.watch('b1');
    setVisibility('hidden');
    answer(okText('1'));
    mock.timers.tick(POLL_MS * 5);
    assert.equal(sent.length, 1);
    setVisibility('visible');
    assert.equal(sent.length, 2);
  });

  it('在途时回到前台不叠请求', () => {
    const { live, sent, setVisibility } = setup();
    live.watch('b1');
    setVisibility('hidden');
    setVisibility('visible');
    assert.equal(sent.length, 1);
  });

  it('一打开页面就不可见：等回到前台才开始', () => {
    const { live, sent, setVisibility } = setup({ visibilityState: 'hidden' });
    live.watch('b1');
    assert.equal(sent.length, 0);
    setVisibility('visible');
    assert.equal(sent.length, 1);
  });

  it('内容没变不重画：否则每拍都打断长按选字和滚动', () => {
    const { live, answer, paints } = setup();
    live.watch('b1');
    answer(okText('same'));
    mock.timers.tick(POLL_MS);
    answer(okText('same'));
    assert.deepEqual(paints, ['same']);
  });

  it('看得好好的时候一次失败不清屏，下一拍接着问', () => {
    const { live, sent, answer } = setup();
    live.watch('b1');
    answer(okText('good'));
    mock.timers.tick(POLL_MS);
    answer({ ok: false, error: '读取失败：get_task_output_timeout' });
    assert.equal(live.display(), 'good');
    mock.timers.tick(POLL_MS);
    answer(null, new Error('operation has timed out'));
    assert.equal(live.display(), 'good', '断线超时同样不清屏');
    mock.timers.tick(POLL_MS);
    assert.equal(sent.length, 4, '失败后还要继续问，不然恢复了也看不到');
  });

  it('第一次就失败：显示原因，不是一直转圈', () => {
    const { live, answer } = setup();
    live.watch('b1');
    answer({ ok: false, error: '子代理、工作流这类任务运行中看不了输出，只有后台命令和 Monitor 可以' });
    assert.match(live.display(), /子代理/);
  });

  it('第一次就断线：显示不可用，下一拍继续问', () => {
    const { live, sent, answer } = setup();
    live.watch('b1');
    answer(null, new Error('operation has timed out'));
    assert.equal(live.display(), '输出不可用');
    mock.timers.tick(POLL_MS);
    assert.equal(sent.length, 2);
  });
});
