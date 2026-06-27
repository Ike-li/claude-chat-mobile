// scripts/smoke-permmode-e2e.js —— ADR-012 真实行为验收（真 token，约 $0.02–0.05）：
// 证明 SDK 真实切换、非契约假象（E8/E7 假功能教训）——
//   ① default 档：非白名单 Bash 触发 permission_request（拦截）；
//   ② 切 bypass：走真实 q.setPermissionMode（agent 已存在）；
//   ③ bypass 档：同操作无 permission_request、Bash 真实执行（放行）。
// 轮①审批后 deny 省执行 token；轮②真实跑一条 echo。
//
// 用法（⚠️ 真实调 claude 消耗 token）：
//   cp data/sessions.json data/sessions.json.bak && rm data/sessions.json   # CLAUDE.md 冒烟须知
//   AUTH_TOKEN='' PORT=3100 WORK_DIR=/tmp/ccm-test node server.js           # 终端1
//   node scripts/smoke-permmode-e2e.js [model]                              # 终端2（网关环境传 model）
//   mv data/sessions.json.bak data/sessions.json                           # 测完还原
import { io } from 'socket.io-client';

const URL = 'http://127.0.0.1:3100';
const MODEL = process.argv[2] || process.env.ANTHROPIC_MODEL || undefined;
// 非白名单 + 有副作用（创建文件）→ default 档触发审批；只读"安全命令"（echo/ls/pwd）CLI 默认放行测不出拦截，
// 故用 touch（同 smoke-m2 A3）。两轮用不同文件名：轮① allow 创建后，轮② 若同名 claude 可能判"已存在"而不调 Bash。
const PROBE = n => `touch /tmp/ccm-test/ccm-probe-${n}.txt`;
const promptFor = n => `请用 shell（Bash 工具）运行 \`${PROBE(n)}\` 创建一个空文件。只执行这一条，不要解释、不要做别的。`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// epoch 感知去重，与 app.js 一致
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
    if (!col.accept(ev)) return;
    if (!['text_delta', 'thinking_delta'].includes(ev.type)) {
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
  const col = collector();
  const s = await connect(col);
  await sleep(500);

  // ---- 轮①：default 档 → 非白名单 Bash 应触发审批；allow 放行让 claude 正常完成（不留"被拒"记忆扰轮②）----
  console.log('\n— 轮① default 档（期待拦截）—');
  await setMode(s, col, 'default');
  const mark1 = col.events.length;
  s.emit('user:message', { text: promptFor('a'), model: MODEL });
  const perm = await waitFor(col, e => col.events.indexOf(e) >= mark1 && e.type === 'permission_request', 90000, 'default 审批弹窗');
  check('default 档：非白名单 Bash 触发 permission_request', perm.payload.name === 'Bash', `工具=${perm.payload.name}`);
  s.emit('user:approve', { requestId: perm.payload.requestId, decision: 'allow' });
  await waitFor(col, e => col.events.indexOf(e) >= mark1 && e.type === 'result', 90000, 'default 轮结束');

  // ---- 切 bypass：agent 已存在 → 走真实 q.setPermissionMode（核心：非假功能验证）----
  console.log('\n— 切 bypassPermissions（真实 SDK 调用）—');
  const errBefore = col.events.filter(e => e.type === 'error').length;
  await setMode(s, col, 'bypassPermissions');
  check('setPermissionMode 真实调用成功（permission_mode 广播到达、未触发 error）',
    col.events.filter(e => e.type === 'error').length === errBefore);

  // ---- 轮②：bypass 档 → 同操作应无审批、直接执行 ----
  console.log('\n— 轮② bypass 档（期待放行）—');
  const mark = col.events.length;
  s.emit('user:message', { text: promptFor('b'), model: MODEL });
  await waitFor(col, e => col.events.indexOf(e) >= mark && e.type === 'result', 90000, 'bypass 轮结束');
  const after = col.events.slice(mark);
  const hadPerm = after.some(e => e.type === 'permission_request');
  const ranBash = after.some(e => e.type === 'tool_use' && e.payload.name === 'Bash');
  const okResult = after.some(e => e.type === 'tool_result' && e.payload.ok);
  check('bypass 档：无 permission_request（免审批）', !hadPerm);
  check('bypass 档：Bash 工具真实执行且成功', ranBash && okResult, `tool_use=${ranBash} ok=${okResult}`);

  s.close();
  const passed = results.filter(r => r.ok).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
};

run().catch(e => { console.error('❌ 测试异常:', e.message); process.exit(1); });
