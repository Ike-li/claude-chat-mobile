// smoke runner `statusline` —— E16 web 状态栏真实验收（自包含、不调脚本/快照）。
// 用法：npm run test:smoke -- --scenario statusline；零 token 逻辑由 tests/unit/statusline.test.mjs 覆盖。
import { io } from 'socket.io-client';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const finish = () => {
  console.log(`\n=== statusline 结果: ${results.filter(r => r.ok).length}/${results.length} 通过 ===`);
  process.exit(results.every(r => r.ok) ? 0 : 1);
};

// ───────────────────────────── --unit ─────────────────────────────
if (process.argv.includes('--unit')) {
  const { buildWebStatusLine, gitStatus } = await import('../../../src/ops/statusline.js');

  // U1 组装：model/ctx/cost/duration + cache 命中率（无 cwd → 无 git 段）
  const fakeAgent = {
    activeModel: 'test-model[1m]',
    lastUsage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 147000 },
    totalCostUsd: 1.23, totalDurationMs: 60000, totalApiDurationMs: 45000
  };
  const p = await buildWebStatusLine({ agent: fakeAgent, cwd: undefined });
  check('U1-model 含网关后缀', p.model === 'test-model[1m]', p.model);
  check('U1-ctx token 绝对数', p.ctx?.tokens === 150000, `tokens=${p.ctx?.tokens}`);
  check('U1-cache 命中率', p.ctx?.cacheHitPct === 98, `hit=${p.ctx?.cacheHitPct}%`); // 147k/150k≈98%
  check('U1-cost', p.cost === 1.23);
  check('U1-duration', p.duration?.wallMs === 60000 && p.duration?.apiMs === 45000);
  check('U1-无 cwd 则无 git 段', p.git === undefined);

  // U2 真实 git 段：在项目根（git 仓库）跑，断言 branch 存在——补单测（假 cwd）覆盖不到的真实 git
  const git = await gitStatus(ROOT);
  check('U2-真实 git 段', !!git && typeof git.branch === 'string' && git.branch.length > 0,
    git ? `branch=${git.branch} changed=${git.changed} ↑${git.ahead} ↓${git.behind}` : 'null（HERE 非 git 仓库？）');

  // U3 agent=null 退化：无 model/ctx/cost
  const bare = await buildWebStatusLine({ agent: null, cwd: undefined });
  check('U3-agent=null 退化', !bare.model && !bare.ctx && !bare.cost, JSON.stringify(bare));
  finish();
}

// ───────────────────────────── e2e ─────────────────────────────
const URL = process.env.CCM_SMOKE_URL || `http://127.0.0.1:${process.env.PORT || 3100}`;
const OFF = process.argv.includes('--off');
const events = [];
const sock = io(URL, { auth: { token: '' }, reconnection: false, timeout: 5000 });
sock.on('agent:event', ev => { if (ev.type === 'status_line') events.push(ev); });
await new Promise((res, rej) => {
  sock.on('connect', res);
  sock.on('connect_error', e => rej(new Error('connect_error: ' + e.message)));
  setTimeout(() => rej(new Error('connect 超时')), 6000);
}).catch(err => { check('e2e 连接', false, err.message); finish(); });

if (OFF) {
  // WEB_STATUSLINE=off 启动的 server——5s 内零 status_line 事件、零 UI 痕迹
  await sleep(5000);
  check('OFF-禁用零事件', events.length === 0, `收到 ${events.length} 条`);
  sock.close();
  finish();
}

// E1：连接触发——≤3s 收到结构化 payload（恒 epoch:server，非 ANSI lines）
await sleep(3000);
const first = events[0]?.payload;
check('E1-连接触发收到结构化', !!first && typeof first === 'object' && first.lines === undefined,
  first ? `keys=${Object.keys(first).join(',')}` : '3s 内未收到');
if (first) {
  check('E1-恒 epoch:server', events.every(e => e.epoch === 'server' && e.seq === 0));
  check('E1-非 ANSI（无 lines/summary）', first.lines === undefined && first.summary === undefined);
}

// E2：发一条消息等 result → 后续 status_line 含 model/ctx/cost（agent 属性管线全通）
const before = events.length;
let done = false;
sock.on('agent:event', ev => { if (ev.type === 'result' || ev.type === 'error') done = true; });
sock.emit('user:message', { text: '只回复 ok' });
for (let i = 0; i < 120 && !done; i++) await sleep(1000);
await sleep(1500); // result 触发 300ms 防抖余量
const after = events.slice(before).map(e => e.payload);
check('E2-result 后刷新', after.length >= 1, `新增 ${after.length} 条`);
const rich = after.find(pl => pl.model && pl.ctx && Number.isFinite(pl.ctx.tokens));
check('E2-含 model+ctx（cost 视计费模式可选）', !!rich,
  rich ? `model=${rich.model} tokens=${rich.ctx.tokens} cost=${Number.isFinite(rich.cost) ? '$' + rich.cost.toFixed(4) : 'N/A(订阅?)'}` : '无');

// E3：第二个零消息连接 → ≤2s 收到缓存重放（快照类事件通用断言）
const sock2 = io(URL, { auth: { token: '' }, reconnection: false });
const got2 = await new Promise(res => {
  const t = setTimeout(() => res(null), 2000);
  sock2.on('agent:event', ev => {
    if (ev.type === 'status_line') { clearTimeout(t); res(ev); }
  });
});
check('E3-零消息新连接重放', !!got2 && got2.epoch === 'server');
sock2.close();
sock.close();
finish();
