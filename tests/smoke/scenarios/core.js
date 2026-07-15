// smoke runner `core` —— M1 冒烟验收（docs/design.md）：
//   phase1: A6 中断不毁会话 → A2 干活能力 → A1 会话连续（运行中多轮）→ A4 工具事件
//   phase2（server 重启后）: A1 重启 resume
// 用法：npm run test:smoke -- --scenario core（runner 自动执行 phase2）
import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';

const URL = process.env.CCM_SMOKE_URL || `http://127.0.0.1:${process.env.PORT || 3100}`;
const WORK = process.env.WORK_DIR;
if (!WORK) throw new Error('WORK_DIR is required; use tests/smoke/runner.js');
const phase2 = process.argv.includes('--phase2');
const results = [];
const check = (name, ok, detail = '') =>
  results.push({ name, ok }) && console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);

const socket = io(URL, { auth: { token: '' } });
const events = [];
let textBuf = '';
socket.on('agent:event', ev => {
  events.push(ev);
  if (ev.type === 'text_delta') textBuf += ev.payload.text;
  const tag = ev.type === 'text_delta' || ev.type === 'thinking_delta' ? '' : `  [${ev.type}] ${JSON.stringify(ev.payload).slice(0, 120)}`;
  if (tag) console.log(tag);
});

const waitEvent = (pred, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`等待事件超时 ${ms}ms`)), ms);
  const iv = setInterval(() => {
    const hit = events.find(pred);
    if (hit) { clearTimeout(t); clearInterval(iv); resolve(hit); }
  }, 100);
});
const mark = () => events.length;
const since = i => events.slice(i);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ask(text, timeout = 180000) {
  const from = mark();
  textBuf = '';
  socket.emit('user:message', { text });
  await waitEvent(e => events.indexOf(e) >= from && e.type === 'result', timeout);
  return textBuf;
}

try {
  await new Promise((res, rej) => { socket.on('connect', res); socket.on('connect_error', rej); });
  console.log('已连接\n');

  if (!phase2) {
    // --- A6: 等任务真正开始生成后中断，会话不毁 ---
    const from = mark();
    socket.emit('user:message', { text: '请从 1 慢慢数到 50，每个数字单独一行。' });
    await waitEvent(e => events.indexOf(e) >= from && (e.type === 'text_delta' || e.type === 'thinking_delta'), 120000);
    socket.emit('user:interrupt');
    await waitEvent(e => events.indexOf(e) >= from && e.type === 'system' && e.payload.message === '已中断', 30000);
    check('A6-中断生效', true);
    // 中断轮可能仍 emit 一个 result，等它落地（或 15s 兜底）再开下一轮，避免轮次错位
    await waitEvent(e => events.indexOf(e) >= from && e.type === 'result', 15000).catch(() => {});

    // --- A2: 干活能力（Write 在白名单，应自动放行不弹审批）---
    const beforeA2 = mark();
    const reply1 = await ask(`在当前工作目录创建文件 demo.md，内容为一行字 "hello from mobile"。完成后只回复"已创建"。`);
    let fileOk = false, fileContent = '';
    try { fileContent = readFileSync(`${WORK}/demo.md`, 'utf8'); fileOk = fileContent.includes('hello from mobile'); } catch {}
    check('A2-文件真实落盘', fileOk, fileContent.trim());
    check('A2-白名单静默放行', !since(beforeA2).some(e => e.type === 'permission_request'));

    // --- A4: 工具事件数据流 ---
    check('A4-init事件', events.some(e => e.type === 'init'), JSON.stringify(events.find(e => e.type === 'init')?.payload ?? {}).slice(0, 100));
    check('A4-tool_use事件', since(beforeA2).some(e => e.type === 'tool_use' && e.payload.name === 'Write'));
    check('A4-tool_result事件', since(beforeA2).some(e => e.type === 'tool_result'));
    check('E4-流式text_delta', since(beforeA2).filter(e => e.type === 'text_delta').length > 0, `回复: ${reply1.trim().slice(0, 50)}`);

    // --- A1: 会话连续（同 query 多轮）---
    const reply2 = await ask('我们刚才创建的文件叫什么名字？只回答文件名。');
    check('A1-多轮上下文连续', reply2.includes('demo.md'), reply2.trim().slice(0, 60));

    // --- envelope 契约：所有【业务流式事件】带 epoch（#2 客户端去重依赖）---
    // WS-015：旧写法 events.filter(有epoch).every(是字符串)——若所有业务事件都【丢了】epoch（正是要防的回归
    // 形态），filter 结果为空数组、[].every()===true 假绿。改为先按类型独立选出「本轮必产且应带 epoch」的
    // 业务事件（Write 轮次的 tool_use/tool_result/text_delta），断言非空，再要求每条都有合法非 'server' epoch。
    const EPOCH_EVENT_TYPES = ['tool_use', 'tool_result', 'text_delta'];
    const bizEvents = since(beforeA2).filter(e => EPOCH_EVENT_TYPES.includes(e.type));
    check('契约-业务事件存在（epoch 断言前提）', bizEvents.length > 0, `${bizEvents.length} 条`);
    check('契约-envelope带epoch', bizEvents.length > 0 && bizEvents.every(e => typeof e.epoch === 'string' && e.epoch !== 'server'));

    // --- 会话切换：不崩（覆盖 #1 sessionExists 崩溃路径）+ 切回后 resume 连续 ---
    const emitAck = (event, payload) => new Promise(res => {
      if (payload === undefined) socket.emit(event, res); else socket.emit(event, payload, res);
    });
    const firstId = (await emitAck('session:list')).currentSessionId;
    const created = await emitAck('session:new');
    check('切换-新建会话', created?.ok === true);
    await ask('回复 OK', 60000); // 新会话里随便建立一轮，拿到独立 sessionId
    const sw = await emitAck('session:switch', { sessionId: firstId });
    check('切换-切回不崩进程', sw?.ok === true && sw.sessionId === firstId);
    const reply4 = await ask('我们创建过的文件叫什么名字？只回答文件名。');
    check('切换-切回后resume连续', reply4.includes('demo.md'), reply4.trim().slice(0, 60));
  } else {
    // --- A1-phase2: server 已重启，靠 sessions.json resume ---
    const reply3 = await ask('本次对话里我们创建过的文件叫什么名字？只回答文件名。');
    check('A1-重启后resume连续', reply3.includes('demo.md'), reply3.trim().slice(0, 60));
  }
} catch (err) {
  check('执行异常', false, err.message);
} finally {
  console.log(`\n=== ${phase2 ? 'phase2' : 'phase1'} 结果: ${results.filter(r => r.ok).length}/${results.length} 通过 ===`);
  socket.close();
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
