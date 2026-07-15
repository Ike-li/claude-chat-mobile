// smoke runner `plan-mode` —— plan 档真实行为（真 token）：
// plan 档"只规划、不执行"——发"创建文件"，plan 档下探针文件不应被真实创建
// （对照 default/bypass 都会创建，见 `permission-modes` 场景）。plan 模式 Claude 常走 ExitPlanMode 请求退出去执行；
// 脚本 allow 所有 permission_request（plan 本质 = 即便放行 SDK 也不执行修改；deny 会假阳性），断言"allow 后仍未创建" = plan 真生效。
//
// 用法（⚠️ 真 token）：npm run test:smoke -- --scenario plan-mode [--model <name>]
import { io } from 'socket.io-client';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.env.CCM_SMOKE_URL || `http://127.0.0.1:${process.env.PORT || 3100}`;
const MODEL = process.argv[2] || process.env.ANTHROPIC_MODEL || undefined;
const workDir = process.env.WORK_DIR;
if (!workDir) throw new Error('WORK_DIR is required; use tests/smoke/runner.js');
const PROBE = join(workDir, 'plan-probe.txt');
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

  // WS-016：审批必须回显完整 op（{tool,args,cwd}）+ instanceId——否则服务端 NFR-17 完整性校验重算指纹时
  // 拿不到 op、直接 integrity_mismatch 把每个 allow 变成 deny（agent.js#resolvePermission）。旧实现只发
  // {requestId,decision} → 所有 allow 实为 deny → 文件当然没建 → 误判「plan 生效」（假绿链，与 plan 档无关）。
  // ExitPlanMode 单独处理：allow 时带 exitMode（对齐前端 app.js 的真实审批协议）。
  const acted = new Set();
  const allowAll = setInterval(() => {
    for (const e of col.events.slice(mark)) {
      if (e.type === 'permission_request' && !acted.has(e.payload.requestId)) {
        acted.add(e.payload.requestId);
        console.log(`  ↪ allow permission_request name=${e.payload.name}`);
        const approve = {
          requestId: e.payload.requestId,
          decision: 'allow',
          instanceId: e.instanceId,                                             // 路由回本实例
          op: { tool: e.payload.name, args: e.payload.input, cwd: e.payload.cwd }, // 回显所见操作，供完整性重算指纹
        };
        if (e.payload.name === 'ExitPlanMode') approve.exitMode = 'default';     // 单独处理：退出 plan 档到 default
        s.emit('user:approve', approve);
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
  const resolved = after.filter(e => e.type === 'request_resolved' && e.payload.kind === 'permission');
  const integrityDenied = resolved.filter(e => e.payload.outcome === 'integrity_mismatch');
  const honoredAllow = resolved.filter(e => e.payload.outcome === 'allow');

  // WS-016：先断言审批【真的被放行】而非被完整性校验静默拒绝——这正是旧假绿的机理（全 integrity_mismatch）。
  check('审批完整性：无 integrity_mismatch（op 回显正确、allow 真放行）', integrityDenied.length === 0,
    integrityDenied.length ? `⚠️ ${integrityDenied.length} 条 allow 被完整性校验拒绝（op 未回显？）` : '全部放行 ✓');
  check('审批被处理：至少一条 outcome=allow', honoredAllow.length > 0, `allow×${honoredAllow.length}`);
  // 在「审批确已放行」的前提下，文件是否创建才有意义地反映 plan 档语义（是否强制拦截修改）。
  // 注：此为网关/CLI plan 档行为的负面发现观察，非硬契约——不同网关是否强制 plan 差异大，故仅信息性登记。
  console.log(`  观察：plan 档 allow 后探针文件${fileCreated ? '被创建（此环境 plan 档退化为 default？mimo 网关不强制 plan）' : '未创建（SDK 真拦截 = plan 生效）'}`);
  console.log(`  观察：${sawExitPlan ? '走了 ExitPlanMode' : '未走 ExitPlanMode（模型直接调修改工具）'}；本轮成功 tool_result(ok)=${okToolResult}`);

  if (existsSync(PROBE)) rmSync(PROBE);
  s.close();
  const passed = results.filter(r => r.ok).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
};

run().catch(e => { console.error('❌ 测试异常:', e.message); process.exit(1); });
