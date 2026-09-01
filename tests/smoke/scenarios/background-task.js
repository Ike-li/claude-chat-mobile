// smoke runner `background` —— 后台任务完成通知冒烟
// 验证：web 端跑后台任务（run_in_background bash）→ 回合先结束 → 后台完成后收到 task_notification
//       + 后续自动汇报轮的 result + 该窗口内 /health busy=true（状态机合成生效）。
// ⚠️ 真实调用 claude、消耗一轮 token，非确定性（依赖模型自愿用 run_in_background），故不进 npm test。
// 用法：npm run test:smoke -- --scenario background
import { io } from 'socket.io-client';

const URL = process.env.CCM_SMOKE_URL || `http://127.0.0.1:${process.env.PORT || 3100}`;
const results = [];
const check = (name, ok, detail = '') =>
  results.push({ name, ok }) && console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);

const socket = io(URL, { auth: { token: process.env.AUTH_TOKEN || '' } });
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
const HEALTH_URL = `${URL}/health?token=${encodeURIComponent(process.env.AUTH_TOKEN || '')}`;   // §1.9：/health 要鉴权
const health = async () => { try { return await (await fetch(HEALTH_URL)).json(); } catch { return {}; } };

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

  // 合成 pendingTurns 后，自动汇报轮开始 → 该窗口内 /health busy 应为 true。
  // 旧写法 `sleep(300)` 后只采样一次，是在赌"这一瞬间恰好落在汇报轮的起止窗口里"——实测两次运行都
  // 采到 busy=false，而同一轮的「收到 task_notification」「汇报轮 result 落地」「汇报结束后 busy 回落」
  // 三条全绿，说明轮确实跑过、只是采样点错位。改成从 notification 落地起持续轮询：
  //   命中 busy=true 即通过；「汇报轮 result 已落地」是停止条件（result 之后 busy 不可能再为 true，
  //   继续等只会白等到超时）。窗口内一次都没采到 true 才判红，此时是真的没合成出 busy。
  const notifAt = events.indexOf(notif);
  const reportSettled = () => events.slice(notifAt + 1).some(e => e.type === 'result');
  let busySeen = false, samples = 0, lastBusy;
  const busyDeadline = Date.now() + 90000;
  while (Date.now() < busyDeadline) {
    lastBusy = (await health()).busy;
    samples++;
    if (lastBusy === true) { busySeen = true; break; }
    if (reportSettled()) break; // 汇报轮已收尾，busy 窗口已经过去
    await sleep(100);
  }
  check('自动汇报轮期间 /health busy=true（状态机合成生效）', busySeen,
    `采样 ${samples} 次，末次 busy=${lastBusy}`);

  // 自动汇报轮 result 落地 → busy 回落
  await waitEvent(e => events.indexOf(e) > events.indexOf(notif) && e.type === 'result', 60000);
  check('自动汇报轮 result 落地', true);
  // 同样不用固定 sleep 赌"300ms 内一定已回落"：result 到达与 /health 侧状态收敛之间有传播窗口。
  // 轮询到 busy=false 即通过；一直不回落才判红（那才是真的状态机泄漏）。
  let settledBusy;
  const settleDeadline = Date.now() + 30000;
  while (Date.now() < settleDeadline) {
    settledBusy = (await health()).busy;
    if (settledBusy === false) break;
    await sleep(100);
  }
  check('汇报结束后 /health busy 回落', settledBusy === false, `busy=${settledBusy}`);
} catch (err) {
  check('执行异常', false, err.message);
} finally {
  console.log(`\n=== 后台任务通知冒烟结果: ${results.filter(r => r.ok).length}/${results.length} 通过 ===`);
  socket.close();
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
