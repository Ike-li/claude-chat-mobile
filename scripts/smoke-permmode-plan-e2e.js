// scripts/smoke-permmode-plan-e2e.js —— ADR-012 plan 档真实行为（真 token，约 $0.05）：
// plan 档"只规划、不执行"——发"创建文件"，plan 档下探针文件不应被真实创建
// （对照 default/bypass 都会创建，见 smoke-permmode-e2e）。plan 模式 claude 常走 ExitPlanMode 请求退出去执行；
// 脚本 allow 所有 permission_request（plan 本质 = 即便放行 SDK 也不执行修改；deny 会假阳性），断言"allow 后仍未创建" = plan 真生效。
//
// 用法（⚠️ 真 token）：
//   cp data/sessions.json data/sessions.json.bak && rm data/sessions.json
//   AUTH_TOKEN='' PORT=3100 WORK_DIR=/tmp/ccm-test node server.js     # 终端1
//   node scripts/smoke-permmode-plan-e2e.js [model]                   # 终端2
//   mv data/sessions.json.bak data/sessions.json
import { io } from 'socket.io-client';
import { existsSync, rmSync } from 'node:fs';

const URL = 'http://127.0.0.1:3100';
const MODEL = process.argv[2] || process.env.ANTHROPIC_MODEL || undefined;
const PROBE = '/tmp/ccm-test/plan-probe.txt';
const PROMPT = `请用 Bash 工具运行 \`touch ${PROBE}\` 创建一个文件。只执行这一条，不要解释。`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function collector() {
  const events = [];
  let lastSeq = 0, curEpoch = null;
  return {
    events,
    accept(ev) {
      if (ev.epoch && ev.epoch !== 'server') {
        if (ev.epoch !== curEpoch) { curEpoch = ev.epoch; lastSeq = 0; }
        if (ev.seq <= lastSeq) return false;
        lastSeq = ev.seq;
      }
      events.push(ev);
      return true;
    }
  };
}

function connect(col) {
  const s = io(URL, { auth: { token: '' }, reconnection: false, timeout: 5000 });
  s.on('agent:event', ev => {
    if (col.accept(ev) && !['text_delta', 'thinking_delta'].includes(ev.type)) {
      console.log(`  [${ev.type}] ${JSON.stringify(ev.payload).slice(0, 90)}`);
    }
  });
  return new Promise((res, rej) => {
    s.on('connect', () => res(s));
    s.on('connect_error', e => rej(new Error('connect_error: ' + e.message)));
    setTimeout(() => rej(new Error('connect 超时')), 6000);
  });
}

const waitFor = (col, pred, ms, label) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`等待 ${label} 超时 ${ms}ms`)), ms);
  const iv = setInterval(() => {
    const hit = col.events.find(pred);
    if (hit) { clearTimeout(t); clearInterval(iv); res(hit); }
  }, 100);
});

async function setMode(s, col, mode) {
  s.emit('user:setPermissionMode', { mode });
  await waitFor(col, e => e.type === 'permission_mode' && e.payload.mode === mode, 8000, `切档→${mode}`);
}

const run = async () => {
  if (existsSync(PROBE)) rmSync(PROBE);           // 清旧探针，确保"未创建"是真结论
  const col = collector();
  const s = await connect(col);
  await sleep(500);

  console.log('\n— plan 档（期待只规划、不执行）—');
  await setMode(s, col, 'plan');
  const mark = col.events.length;
  s.emit('user:message', { text: PROMPT, model: MODEL });

  // 关键：allow 所有审批！plan 档本质 = 即便放行，SDK 也不实际执行修改。deny 会假阳性
  // （deny 本身就阻止创建，分不清是 plan 拦截还是 deny）。allow 后：文件仍未创建 = plan 真生效；
  // 被创建 = plan 档在此 CLI/网关退化为 default（假档，重要负面发现）。
  const acted = new Set();
  const allowAll = setInterval(() => {
    for (const e of col.events.slice(mark)) {
      if (e.type === 'permission_request' && !acted.has(e.payload.requestId)) {
        acted.add(e.payload.requestId);
        console.log(`  ↪ allow permission_request name=${e.payload.name}`);
        s.emit('user:approve', { requestId: e.payload.requestId, decision: 'allow' });
      }
    }
  }, 150);

  await waitFor(col, e => col.events.indexOf(e) >= mark && e.type === 'result', 90000, 'plan 轮结束');
  clearInterval(allowAll);
  await sleep(300);

  const after = col.events.slice(mark);
  const fileCreated = existsSync(PROBE);
  const sawExitPlan = after.some(e => e.type === 'permission_request' && e.payload.name === 'ExitPlanMode');
  const okToolResult = after.some(e => e.type === 'tool_result' && e.payload.ok);

  // allow 后仍未创建 = SDK 真拦截执行（plan 生效）；创建了 = 退化为 default（plan 假档）
  check('plan 档：allow 后探针文件仍未创建（SDK 真拦截 = plan 生效）', !fileCreated,
    fileCreated ? '⚠️ 文件被创建 → plan 档在此环境退化为 default（mimo 网关不强制 plan？）' : '未创建 ✓ plan 真拦截');
  console.log(`  观察：${sawExitPlan ? '走了 ExitPlanMode' : '未走 ExitPlanMode（模型直接调修改工具）'}；本轮成功 tool_result(ok)=${okToolResult}`);

  if (existsSync(PROBE)) rmSync(PROBE);
  s.close();
  const passed = results.filter(r => r.ok).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
};

run().catch(e => { console.error('❌ 测试异常:', e.message); process.exit(1); });
