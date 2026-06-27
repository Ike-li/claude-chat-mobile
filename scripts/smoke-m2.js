// scripts/smoke-m2.js —— M2 安全与审批验收（docs/design.md A3/A7/A8）。
//
// 用法：
//   node scripts/smoke-m2.js --unit          # A8：checkIdle 单元验证（无需 server，零 token）
//   AUTH_TOKEN=m2token <启动 server> 后：
//   node scripts/smoke-m2.js --token m2token  # A7 鉴权 + A3 审批闸门（e2e）
import { io } from 'socket.io-client';

const URL = 'http://127.0.0.1:3100';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- A8：checkIdle 审批挂起不超时（单元）----------
async function unit() {
  const { AgentSession } = await import('../agent.js');
  const make = () => {
    const a = new AgentSession({
      resumeId: null, cwd: '/tmp', claudeBin: 'x', model: null,
      idleTimeoutMs: 1, onEvent: () => {}, onSessionId: () => {}, onExit: () => {}
    });
    a.abort = new AbortController();
    a.pendingTurns = 1;
    a.lastActivity = Date.now() - 999999; // 远超 idleTimeoutMs
    return a;
  };

  // 1) 审批挂起时：即便静默极久也不得 abort（4c：等用户不计时）
  const a1 = make();
  a1.pendingPermissions.set('p1', { resolve: () => {}, suggestions: [], input: {} });
  a1.checkIdle();
  check('A8-审批挂起不超时', !a1.abort.signal.aborted);

  // 2) 无审批 + 静默超时：kill 路径仍须生效（abort 触发，发 error）
  const a2 = make();
  let errored = false;
  a2.onEvent = ev => { if (ev.type === 'error') errored = true; };
  a2.checkIdle();
  check('A8-真挂死仍中断', a2.abort.signal.aborted && errored);

  // 3) 无在途轮：空闲等输入，不算挂死
  const a3 = make();
  a3.pendingTurns = 0;
  a3.checkIdle();
  check('A8-空闲不误杀', !a3.abort.signal.aborted);
}

// ---------- A7 鉴权 + A3 审批闸门（e2e，需 tokened server）----------
async function e2e(token) {
  // A7-1：错误 token 必须被拒
  await new Promise(res => {
    let done = false;
    const finish = (ok, detail) => { if (done) return; done = true; check('A7-错误token被拒', ok, detail); bad.close(); res(); };
    const bad = io(URL, { auth: { token: 'wrong-token' }, reconnection: false, timeout: 5000 });
    bad.on('connect', () => finish(false, '竟然连上了'));
    bad.on('connect_error', e => finish(e.message === 'unauthorized', e.message));
    setTimeout(() => finish(false, '超时无响应'), 6000);
  });

  // A7-2：正确 token 通过
  const s = io(URL, { auth: { token }, reconnection: false, timeout: 5000 });
  const events = [];
  s.on('agent:event', ev => {
    events.push(ev);
    const tag = ['text_delta', 'thinking_delta'].includes(ev.type) ? '' : `  [${ev.type}] ${JSON.stringify(ev.payload).slice(0, 110)}`;
    if (tag) console.log(tag);
  });
  const waitFor = (pred, ms, label) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`等待 ${label} 超时`)), ms);
    const iv = setInterval(() => {
      const hit = events.find(pred);
      if (hit) { clearTimeout(t); clearInterval(iv); res(hit); }
    }, 100);
  });
  const mark = () => events.length;

  try {
    await new Promise((res, rej) => {
      s.on('connect', res);
      s.on('connect_error', e => rej(new Error('connect_error: ' + e.message)));
      setTimeout(() => rej(new Error('connect 超时')), 6000);
    });
    check('A7-正确token通过', true);

    // A3-deny：白名单外且非只读的命令（touch 创建文件，不匹配 git/npm 前缀，也非只读）应触发审批
    const from1 = mark();
    s.emit('user:message', { text: '请用 shell 运行 `touch /tmp/ccm-test/approve-probe.txt` 创建一个空文件。' });
    const req = await waitFor(e => events.indexOf(e) >= from1 && e.type === 'permission_request', 120000, 'permission_request');
    check('A3-白名单外触发审批', req.payload.name === 'Bash', `tool=${req.payload.name}`);
    check('A3-审批含完整命令+cwd', !!req.payload.input && typeof req.payload.cwd === 'string',
      `cwd=${req.payload.cwd}, input=${JSON.stringify(req.payload.input).slice(0, 60)}`);
    s.emit('user:approve', { requestId: req.payload.requestId, decision: 'deny' });
    await waitFor(e => events.indexOf(e) >= from1 && e.type === 'result', 120000, 'deny 后 result');
    check('A3-拒绝后任务收尾', true);

    // A3-allow：再来一次，批准 → 工具真实执行
    const from2 = mark();
    s.emit('user:message', { text: '再运行一次 `touch /tmp/ccm-test/approve-probe2.txt`。' });
    const req2 = await waitFor(e => events.indexOf(e) >= from2 && e.type === 'permission_request', 120000, 'permission_request(2)');
    s.emit('user:approve', { requestId: req2.payload.requestId, decision: 'allow' });
    const tr = await waitFor(e => events.indexOf(e) >= from2 && e.type === 'tool_result', 120000, 'tool_result');
    check('A3-批准后工具执行', tr.payload.ok === true);
    await waitFor(e => events.indexOf(e) >= from2 && e.type === 'result', 120000, 'allow 后 result');
  } catch (err) {
    check('A3/A7 执行异常', false, err.message);
  } finally {
    s.close();
  }
}

const tokenArg = process.argv.indexOf('--token');
try {
  if (process.argv.includes('--unit')) await unit();
  else if (tokenArg > -1) await e2e(process.argv[tokenArg + 1]);
  else { console.error('用法见文件头'); process.exit(2); }
} finally {
  console.log(`\n=== M2 结果: ${results.filter(r => r.ok).length}/${results.length} 通过 ===`);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
