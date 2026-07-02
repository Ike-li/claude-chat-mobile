// scripts/smoke-background-task.js —— 后台任务完成通知冒烟（批次 1b）
// 验证：web 端跑后台任务（run_in_background bash）→ 回合先结束 → 后台完成后收到 task_notification
//       + 后续自动汇报轮的 result + 该窗口内 /health busy=true（状态机合成生效）。
// ⚠️ 真实调用 claude、消耗一轮 token，非确定性（依赖模型自愿用 run_in_background），故不进 npm test。
// 用法（先按 CLAUDE.md 备份 sessions.json，另起测试 server）：
//   AUTH_TOKEN='' PORT=3100 WORK_DIR=/tmp/ccm-test DEBUG_SDK_MESSAGES=1 node server.js
//   node scripts/smoke-background-task.js
import { io } from 'socket.io-client';

const URL = 'http://127.0.0.1:3100';
const results = [];
const check = (name, ok, detail = '') =>
  results.push({ name, ok }) && console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);

const socket = io(URL, { auth: { token: '' } });
const events = [];
socket.on('agent:event', ev => {
  events.push(ev);
  const tag = ev.type === 'text_delta' || ev.type === 'thinking_delta' ? '' : `  [${ev.type}] ${JSON.stringify(ev.payload).slice(0, 140)}`;
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const health = async () => { try { return await (await fetch(`${URL}/health`)).json(); } catch { return {}; } };

try {
  await new Promise((res, rej) => { socket.on('connect', res); socket.on('connect_error', rej); });
  console.log('已连接\n');

  const from = mark();
  // 明确要求：起后台 Bash（sleep 20）后立即结束本回合，不等它完成。
  socket.emit('user:message', { text:
    '请用 Bash 工具以 run_in_background:true 运行命令 `sleep 20`（后台运行），启动后立刻结束这个回合、不要等它完成，只回复"后台任务已启动"。' });

  // 第一轮结束（模型说"已启动"）
  await waitEvent(e => events.indexOf(e) >= from && e.type === 'result', 120000);
  check('第一轮 result 落地（回合先结束）', true);

  // 后台任务约 20s 后完成 → CLI 注入 task-notification → 我们应收到 task_notification 事件
  const notif = await waitEvent(e => e.type === 'task_notification', 40000);
  check('收到 task_notification 事件', !!notif, `source=${notif.payload?.source}`);

  // 合成 pendingTurns 后，自动汇报轮开始 → 该窗口内 /health busy 应为 true
  await sleep(300);
  const h = await health();
  check('自动汇报轮期间 /health busy=true（状态机合成生效）', h.busy === true, `busy=${h.busy}`);

  // 自动汇报轮 result 落地 → busy 回落
  await waitEvent(e => events.indexOf(e) > events.indexOf(notif) && e.type === 'result', 60000);
  check('自动汇报轮 result 落地', true);
  await sleep(300);
  const h2 = await health();
  check('汇报结束后 /health busy 回落', h2.busy === false, `busy=${h2.busy}`);
} catch (err) {
  check('执行异常', false, err.message);
} finally {
  console.log(`\n=== 后台任务通知冒烟结果: ${results.filter(r => r.ok).length}/${results.length} 通过 ===`);
  socket.close();
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
