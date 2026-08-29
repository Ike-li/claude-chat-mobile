import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AGENT_EVENT_TYPES,
  INBOUND_SOCKET_EVENTS,
  checkAgentEventContract,
  checkInboundSocketContract,
  checkFrontendDispatchCoverage,
} from '../../scripts/agent-event-contract.js';

async function writeFixture(root, relativePath, source) {
  const fullPath = join(root, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, source);
}

test('agent event contract covers current real server and visual mock event types', () => {
  const result = checkAgentEventContract();

  assert.deepEqual(result.problems, []);
  assert.ok(result.realTypes.has('init'));
  assert.ok(result.realTypes.has('history_append'));
  assert.ok(result.realTypes.has('permission_request'));
  assert.ok(result.realTypes.has('task_progress'));
  assert.ok(result.mockTypes.has('permission_request'));
  assert.ok(result.mockTypes.has('task_progress'));
  assert.ok(
    result.mockLocations.some(location => location.file === 'tests/e2e/mock/scenarios/content.js'),
    'split business scenario files must remain inside the mock event contract scan',
  );
});

test('agent event contract reports mock event types that real paths do not emit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-agent-event-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'src/agent/agent.js', `
    class AgentSession {
      run() {
        this.emit('init', {});
      }
    }
  `);
  await writeFixture(root, 'src/server/app.js', `
    io.emit('agent:event', { type: 'init', payload: {} });
  `);
  await writeFixture(root, 'tests/e2e/mock/server.js', `
    io.emit('agent:event', { type: 'init', payload: {} });
    io.emit('agent:event', { type: 'mock_only', payload: {} });
  `);

  const result = checkAgentEventContract({
    rootDir: root,
    // 只声明夹具真正用到的 type（同入向夹具的写法）。传全量 AGENT_EVENT_TYPES 会让 contract ⊆ real
    // 把另外 20 多个真实契约 type 全报成「夹具没发」——夹具本就不该背真实契约表。
    contractTypes: new Set(['init', 'mock_only']),
    mockSources: [{ path: 'tests/e2e/mock/server.js', kind: 'agent-event-emit' }],
  });

  assert.deepEqual(result.problems.map(problem => problem.code), ['mock_type_not_real']);
  assert.equal(result.problems[0].type, 'mock_only');
});

// 出向扫描面此前是手写两文件清单（agent.js + server/app.js），而真实仓库里 src/auth/device-gate.js
// 与 src/server/socket.js 也在发 agent:event —— 它们完全在门禁视野外。对比：入向检查用 serverDirs=['src']
// 递归扫描，注释还写着「新增模块自动纳入扫描面，不靠手工登记文件清单」。出向没享受到同一待遇：
// 在 src/ 下新建模块发一个未登记 type，npm run check 全绿，前端 dispatcher 收到未知 type 静默丢弃。
test('出向扫描面递归覆盖 src/：手写清单外的模块发未登记 type 也要被拦', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-agent-event-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'src/agent/agent.js', `
    class AgentSession { run() { this.emit('init', {}); } }
  `);
  await writeFixture(root, 'src/server/app.js', `
    io.emit('agent:event', { type: 'init', payload: {} });
  `);
  // 既不是 agent.js 也不是 server/app.js —— 真实仓库里 device-gate.js 就是这种位置
  await writeFixture(root, 'src/auth/device-gate.js', `
    socket.emit('agent:event', { type: 'device_locked', payload: {} });
  `);

  const result = checkAgentEventContract({
    rootDir: root,
    contractTypes: new Set(['init']), // device_locked 不在契约里
    mockSources: [],
  });

  const codes = result.problems.map(p => p.code);
  assert.ok(codes.includes('real_type_not_contract'), `未登记 type 必须被拦，实际 problems=${JSON.stringify(result.problems)}`);
});

// SEC-01：server.js 用 io.to('approved').emit('agent:event', ...) 做下行隔离（房间过滤），
// 这是合法的链式广播调用、非动态类型——静态扫描须识别，否则会把仍在真实发出的类型误判为「real 不再发出」。
test('agent event contract 识别 io.to(room).emit("agent:event", ...) 链式调用', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-agent-event-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'src/agent/agent.js', `
    class AgentSession {
      run() {
        this.emit('init', {});
      }
    }
  `);
  await writeFixture(root, 'src/server/app.js', `
    io.to('approved').emit('agent:event', { type: 'session_log', payload: {} });
  `);
  await writeFixture(root, 'tests/e2e/mock/server.js', `
    io.emit('agent:event', { type: 'init', payload: {} });
    io.emit('agent:event', { type: 'session_log', payload: {} });
  `);

  const result = checkAgentEventContract({
    rootDir: root,
    contractTypes: new Set(['init', 'session_log']),
    mockSources: [{ path: 'tests/e2e/mock/server.js', kind: 'agent-event-emit' }],
  });

  assert.deepEqual(result.problems, [], 'io.to(room).emit 里的 session_log 应被识别为 real 已发出，不应报 mock_type_not_real');
  assert.ok(result.realTypes.has('session_log'));
});

// 出向此前有四个方向（real⊆contract、mock⊆contract、mock⊆real、real⊆mock），唯独缺 contract⊆real：
// 契约表里挂一个谁都不发的死 type 会永远静默全绿。入向侧早有对称的 contract_inbound_not_registered
// （见下方「inbound contract flags contract events no server registers」），出向没有——两侧不对称
// 是历史遗留而非有意取舍。type 下线/改名后残留在 AGENT_EVENT_TYPES 里，读表的人会以为它还活着。
test('出向契约里没人发的死 type 必须被拦（contract ⊆ real）', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-agent-event-dead-type-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'src/agent/agent.js', `
    class AgentSession { run() { this.emit('init', {}); } }
  `);
  await writeFixture(root, 'tests/e2e/mock/server.js', `
    io.emit('agent:event', { type: 'init', payload: {} });
  `);

  const result = checkAgentEventContract({
    rootDir: root,
    contractTypes: new Set(['init', 'ghost_type']), // ghost_type 谁都不发
    mockSources: [{ path: 'tests/e2e/mock/server.js', kind: 'agent-event-emit' }],
  });

  // 只报一条：real 都没发的 type，再要求 mock 去产出它没有意义（同入向 contract_inbound_not_mocked
  // 跳过未注册事件的理由——同一个根因不报两遍）。
  assert.deepEqual(result.problems.map(p => p.code), ['contract_type_not_real']);
  assert.equal(result.problems[0].type, 'ghost_type');
});

// ---- 入向 socket 事件契约（客户端 → 服务端）----

test('inbound socket contract covers real server registrations, client emits, and mock handlers', () => {
  const result = checkInboundSocketContract();

  assert.deepEqual(result.problems, []);
  // 三面抽样：server 注册、前端 emit、mock 注册
  assert.ok(result.serverEvents.has('user:message'));
  assert.ok(result.serverEvents.has('session:switch'));
  assert.ok(result.serverEvents.has('tool:preview')); // socket-files.js 单列注册面也须被扫到
  assert.ok(result.serverEvents.has('conn:ping'));    // 裸 socket.on（绕过 registrar）也须被扫到
  assert.ok(result.clientEvents.has('user:message'));
  assert.ok(result.mockEvents.has('user:message'));
  // socket.io 内建生命周期事件不属于业务契约
  assert.ok(!result.serverEvents.has('disconnect'));
  assert.ok(!result.mockEvents.has('disconnect'));
});

test('inbound contract flags server registrations missing from the contract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-inbound-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'src/server/app.js', `
    on(socket, 'user:message', () => {});
    on(socket, 'user:rogue', () => {});
    socket.on('disconnect', () => {});
  `);
  await writeFixture(root, 'public/js/app.js', `socket.emit('user:message', {});`);
  await writeFixture(root, 'tests/e2e/mock/server.js', `socket.on('user:message', () => {});`);

  const result = checkInboundSocketContract({
    rootDir: root,
    contractEvents: new Set(['user:message']),
    mockExemptEvents: {}, // 夹具契约只有一个事件，别让真实仓库的豁免清单漏进来
  });

  assert.deepEqual(result.problems.map(p => p.code), ['real_inbound_not_contract']);
  assert.equal(result.problems[0].event, 'user:rogue');
});

test('inbound contract flags stale contract entries no longer registered by the server', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-inbound-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'src/server/app.js', `on(socket, 'user:message', () => {});`);
  await writeFixture(root, 'public/js/app.js', `socket.emit('user:message', {});`);
  await writeFixture(root, 'tests/e2e/mock/server.js', `socket.on('user:message', () => {});`);

  const result = checkInboundSocketContract({
    rootDir: root,
    contractEvents: new Set(['user:message', 'user:ghost']),
    mockExemptEvents: {},
  });

  assert.deepEqual(result.problems.map(p => p.code), ['contract_inbound_not_registered']);
  assert.equal(result.problems[0].event, 'user:ghost');
});

test('inbound contract flags client emits and mock handlers outside the contract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-inbound-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'src/server/app.js', `on(socket, 'user:message', () => {});`);
  await writeFixture(root, 'public/js/app/extra.js', `sock.emit('user:unhandled', {});`);
  await writeFixture(root, 'tests/e2e/mock/server.js', `socket.on('user:message', () => {});
socket.on('mock:invented', () => {});`);

  const result = checkInboundSocketContract({
    rootDir: root,
    contractEvents: new Set(['user:message']),
    mockExemptEvents: {},
  });

  assert.deepEqual(result.problems.map(p => p.code).sort(), [
    'client_inbound_not_contract',
    'mock_inbound_not_contract',
  ]);
});

test('INBOUND_SOCKET_EVENTS 与 interfaces.md 的入向事件表同源（数量抽查）', () => {
  // 41 = user:*(11) + task:stop + session:*(8) + sync/mirror/conn/dev(4) + logs:*(2) + tool:*(2) + browse:*(2) + files:search + files:write + git:status + git:diff + doctor:run + service:status
  //      + config:refresh（CLI 配置刷新按钮：force 重读 ensureCliDefaults + 广播，手动兜底终端侧改了 settings.json 后 compose 摘要不自动感知）
  //      + client:presence（PWA 前台/后台上报：visibilitychange/pagehide/连接成功时 emit，服务端记 socket.data.hidden，
  //        供 result 完成通知的 hasClients 改按 hasForegroundApprovedClient 判定——修「PWA 切后台但 socket 未断时
  //        result 通知被误判『有人在看』而永久吞掉」）
  // （曾含 usage:get；抽屉额度窗已砍，额度只走 statusline。logs:clientError=前端全局 JS 错误上报落服务端日志；
  //   user:ackUnread=未读角标确认已读，点掉悬浮胶囊/翻到锚点时上报）
  // （曾含 user:cancelQueued：排队消息撤回，对齐 CLI ESC；2026-07-30 随消息排队功能一并移除——
  //   在途轮期间服务端直接拒收新消息，没有排队条也就无从撤回）
  //      + hooks:setup（服务状态面板的「终端会话推送」一键开关：server 唯一会写用户全局
  //        ~/.claude/settings.json 的路径，且只在已鉴权设备显式点击时 spawn 安装器；手机上跑不了
  //        npm 命令，只留 CLI 入口等于让移动端用户永远发现不了这个能力）
  //      + push:test（自证推送链路的「发一条测试推送」，对齐既有「试听提示音」；没有它就只能等
  //        真事件才知道通不通——本项目真实踩过"以为推送在工作、其实从未订阅成功"）
  // （曾含 worktree:sessions：git linked worktree 自动发现；已拆除——worktree 路径须显式写入 workdirs.json）
  //      + env:get / env:set（服务与配置面板：在手机上改 .env。同 hooks:setup 的理由——主界面在
  //        手机上而改配置只能上电脑，40 个配置项里绝大多数移动端用户永远碰不到。三条纪律见
  //        src/server/app.js 的 handler 头注：只写文件不动 process.env、key 白名单（env-schema）、
  //        日志与 ack 只记 key 名不记值。env:set 因为要真写 .env 而进 MOCK_INBOUND_EXEMPT）
  // （曾含 session:delete：L1 软隐藏；2026-08-26 移除——制造 CLI/web 不等价且无反隐藏入口；
  //   只留 session:deletePermanent 真删。session:* 由 9 变 8，入向总数 42→41）
  assert.equal(INBOUND_SOCKET_EVENTS.length, 41);
  assert.ok(INBOUND_SOCKET_EVENTS.includes('env:get'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('env:set'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('push:test'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('hooks:setup'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('client:presence'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('config:refresh'));
  assert.ok(!INBOUND_SOCKET_EVENTS.includes('worktree:sessions'));
  assert.ok(!INBOUND_SOCKET_EVENTS.includes('user:cancelQueued'), '排队撤回已移除，契约不得再列');
  assert.ok(!INBOUND_SOCKET_EVENTS.includes('session:delete'), 'L1 软隐藏已移除，契约不得再列');
  assert.ok(INBOUND_SOCKET_EVENTS.includes('user:ackUnread'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('session:deletePermanent'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('session:fork'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('files:search'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('files:write'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('doctor:run'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('service:status'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('git:status'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('git:diff'));
  assert.equal(INBOUND_SOCKET_EVENTS.includes('usage:get'), false);
});

// 出向侧对称的数量锚点。CLAUDE.md:11 对外宣称「type 分 26 种」，但此前全仓没有任何断言盯着
// AGENT_EVENT_TYPES 的长度——增删 type 时那句话会静默失真。入向早有上面那条断言守着，
// 出向没有纯属遗漏。数字变动时 doc-consistency 的 checkContractCounts 会把文档侧一并拦下。
test('AGENT_EVENT_TYPES 数量与 CLAUDE.md 宣称的 26 种一致', () => {
  assert.equal(AGENT_EVENT_TYPES.length, 26);
});

// ── 2026-08-02 补的两个反向闸 ───────────────────────────────────────────────
// 此前两侧都只查「不许多」（mock ⊆ real、mock ⊆ contract），不查「不许少」。于是真实侧新增一个
// 事件类型 / 入向事件时，mock 停在原地照样全绿——那类事件从此永远进不了 E2E 视野且无人知道，
// 而前端 dispatcher 对未知 type 是静默丢弃。下面三条钉住新增的方向。

test('出向：real 发得出而 mock 从不产出的 type 要被拦（real ⊆ mock 方向）', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-real-not-mock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFixture(root, 'src/agent/agent.js', "this.emit('init', {});\nthis.emit('brand_new_type', {});\n");
  await writeFixture(root, 'tests/e2e/mock/server.js', "io.emit('agent:event', { type: 'init' });\n");

  const result = checkAgentEventContract({
    rootDir: root,
    contractTypes: new Set(['init', 'brand_new_type']),
    realSources: [{ path: 'src/agent/agent.js', kind: 'agent-session' }],
    mockSources: [{ path: 'tests/e2e/mock/server.js', kind: 'agent-event-emit' }],
  });

  assert.deepEqual(
    result.problems.map(p => [p.code, p.type]),
    [['real_type_not_mock', 'brand_new_type']],
    'mock 没跟上新增 type 时必须报，否则 E2E 覆盖缺口静默扩大',
  );
});

test('出向：显式豁免的 type 不再报（豁免清单生效）', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-real-not-mock-exempt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFixture(root, 'src/agent/agent.js', "this.emit('init', {});\nthis.emit('brand_new_type', {});\n");
  await writeFixture(root, 'tests/e2e/mock/server.js', "io.emit('agent:event', { type: 'init' });\n");

  const result = checkAgentEventContract({
    rootDir: root,
    contractTypes: new Set(['init', 'brand_new_type']),
    realSources: [{ path: 'src/agent/agent.js', kind: 'agent-session' }],
    mockSources: [{ path: 'tests/e2e/mock/server.js', kind: 'agent-event-emit' }],
    mockExemptTypes: new Set(['brand_new_type']),
  });

  assert.deepEqual(result.problems, []);
});

test('入向：契约里有、mock 没 handler 又没登记豁免 → 报；豁免登记后放行', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-inbound-not-mocked-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFixture(root, 'src/server/socket.js', "socket.on('user:message', () => {});\nsocket.on('ops:only', () => {});\n");
  await writeFixture(root, 'public/js/app.js', "socket.emit('user:message', {});\nsocket.emit('ops:only', {});\n");
  await writeFixture(root, 'tests/e2e/mock/server.js', "socket.on('user:message', () => {});\n");
  const args = { rootDir: root, contractEvents: new Set(['user:message', 'ops:only']) };

  const flagged = checkInboundSocketContract({ ...args, mockExemptEvents: {} });
  assert.deepEqual(
    flagged.problems.map(p => [p.code, p.event]),
    [['contract_inbound_not_mocked', 'ops:only']],
  );

  const exempted = checkInboundSocketContract({ ...args, mockExemptEvents: { 'ops:only': '理由' } });
  assert.deepEqual(exempted.problems, []);
});

test('入向：豁免清单里残留已下线的事件名 → 报（防豁免变许愿池）', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-stale-exempt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFixture(root, 'src/server/socket.js', "socket.on('user:message', () => {});\n");
  await writeFixture(root, 'public/js/app.js', "socket.emit('user:message', {});\n");
  await writeFixture(root, 'tests/e2e/mock/server.js', "socket.on('user:message', () => {});\n");

  const result = checkInboundSocketContract({
    rootDir: root,
    contractEvents: new Set(['user:message']),
    mockExemptEvents: { 'session:renamed-away': '事件早已改名，豁免却留着' },
  });

  assert.deepEqual(
    result.problems.map(p => [p.code, p.event]),
    [['stale_mock_exempt', 'session:renamed-away']],
  );
});

test('真实仓库的入向豁免清单每条都写了理由，且都还在契约里', () => {
  const result = checkInboundSocketContract();
  assert.deepEqual(result.problems, []);
  for (const event of result.exemptEvents) {
    assert.ok(result.contractEvents.has(event), `豁免项 ${event} 应仍是契约事件`);
  }
  // 缺口必须可见：豁免数就是「E2E 没有往返验证的入向路径」条数
  assert.equal(result.mockEvents.size + result.exemptEvents.size, result.contractEvents.size,
    'mock handler 数 + 豁免数应恰好等于契约数——不等说明有事件既没实现也没登记');
});

// ── 前端接收面覆盖 ─────────────────────────────────────────────────
// 这道检查补的是出向契约缺的另一半：后端发得出 ≠ 前端接得住。缺 handler 的失败模式是
// **静默丢弃**（dispatcher 查表落空直接 return），所以它必须自己不能 fail-open——
// 下面四条负向用例锁的就是这一点。

test('前端接收面：真实仓库的 handle + outOfBand 并集恰好等于 AGENT_EVENT_TYPES', () => {
  const result = checkFrontendDispatchCoverage();
  assert.deepEqual(result.problems, []);
  // 并集相等是不变量本身；分表计数一起断言，是为了让「某个 type 从 handle 挪进 outOfBand」
  // 这类语义变更（进不进环形缓冲、占不占 lastSeq）无法悄悄发生。
  assert.equal(result.handled.size, AGENT_EVENT_TYPES.length);
  assert.equal(result.tables.handle + result.tables.outOfBand, AGENT_EVENT_TYPES.length);
});

test('前端接收面：契约里有而前端没接 → 报静默丢弃，不放行', () => {
  const result = checkFrontendDispatchCoverage({
    contractTypes: new Set([...AGENT_EVENT_TYPES, 'ghost_type']),
  });
  assert.deepEqual(
    result.problems.map(p => [p.code, p.type]),
    [['contract_type_not_handled', 'ghost_type']],
  );
});

test('前端接收面：前端接了契约里没有的 type → 报死键', () => {
  const shortened = new Set(AGENT_EVENT_TYPES);
  shortened.delete('mirror_state');
  const result = checkFrontendDispatchCoverage({ contractTypes: shortened });
  assert.deepEqual(
    result.problems.map(p => [p.code, p.type]),
    [['handler_not_contract', 'mirror_state']],
  );
});

test('前端接收面：锚点定位不到必须报错，不能静默通过（门禁不得 fail-open）', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-frontend-dispatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // 表被改名/挪走后的样子：文件在，两张表都不在
  await writeFixture(root, 'public/js/app.js', `
    const somethingElse = { alpha: 1 };
  `);

  const result = checkFrontendDispatchCoverage({ rootDir: root, contractTypes: new Set(['alpha']) });
  assert.deepEqual(
    result.problems.map(p => [p.code, p.table]),
    [['dispatch_table_not_found', 'handle'], ['dispatch_table_not_found', 'outOfBand']],
  );
  // 定位失败时不得再逐条报「未处理」——那会把真正的根因淹掉
  assert.ok(!result.problems.some(p => p.code === 'contract_type_not_handled'));
});

test('前端接收面：锚点命中多处 → 报歧义而不是随便取第一个', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-frontend-dispatch-ambiguous-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'public/js/app.js', `
    const handle = { alpha: 1 };
    function other() { const handle = { beta: 2 }; }
    const d = createAgentEventDispatcher({ outOfBand: { gamma: 3 } });
  `);

  const result = checkFrontendDispatchCoverage({ rootDir: root, contractTypes: new Set(['alpha', 'gamma']) });
  assert.deepEqual(result.problems.map(p => [p.code, p.table]), [['dispatch_table_ambiguous', 'handle']]);
});

test('前端接收面：键提取跳过嵌套对象、箭头函数参数、注释与字符串', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-frontend-dispatch-parse-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'public/js/app.js', `
    const handle = {
      alpha(payload) { const inner = { not_a_key: 1 }; },
      // commented_key: 注释里的不算
      beta: (ev) => { const s = 'string_key: also not'; return { nested: 2 }; },
      // 表达式体箭头函数：被调函数名后面也是 '('，靠「键必须紧跟 { 或 ,」的位置判据才不会被收进来
      epsilon: (ev) => onEpsilon(ev),
    };
    const d = createAgentEventDispatcher({
      outOfBand: {
        gamma: onGamma,
        delta: (ev) => { if (ev) return { deep: { deeper: 3 } }; },
      },
    });
  `);
  await writeFixture(root, 'public/js/app/event-dispatch.js',
    `const DEFAULT_REPLAY_OOB_TYPES = new Set(['gamma', 'delta']);`);

  const result = checkFrontendDispatchCoverage({
    rootDir: root,
    contractTypes: new Set(['alpha', 'beta', 'epsilon', 'gamma', 'delta']),
  });
  assert.deepEqual(result.problems, []);
  assert.deepEqual([...result.handled].sort(), ['alpha', 'beta', 'delta', 'epsilon', 'gamma']);
  assert.equal(result.tables.handle, 3);
  assert.equal(result.tables.outOfBand, 2);
});

test('前端接收面：引号键不被识别——已知局限，且失败方向是报错而非放行', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-frontend-dispatch-quoted-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'public/js/app.js', `
    const handle = { alpha: 1, 'quoted_key': 2 };
    const d = createAgentEventDispatcher({ outOfBand: { gamma: 3 } });
  `);
  await writeFixture(root, 'public/js/app/event-dispatch.js',
    `const DEFAULT_REPLAY_OOB_TYPES = new Set(['gamma']);`);

  const result = checkFrontendDispatchCoverage({
    rootDir: root,
    contractTypes: new Set(['alpha', 'quoted_key', 'gamma']),
  });
  // 若哪天真要用引号键，这条会红并指向 extractTopLevelKeys——比静默放行强
  assert.deepEqual(result.problems.map(p => [p.code, p.type]), [['contract_type_not_handled', 'quoted_key']]);
});

test('前端接收面：同一 type 落在两张表里 → 报重复，不靠并集大小掩盖', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-frontend-dispatch-dup-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'public/js/app.js', `
    const handle = { alpha: onAlpha, gamma: onGammaHandled };
    const d = createAgentEventDispatcher({ outOfBand: { gamma: onGammaOob } });
  `);
  await writeFixture(root, 'public/js/app/event-dispatch.js',
    `const DEFAULT_REPLAY_OOB_TYPES = new Set(['gamma']);`);

  // 并集恰好等于契约，光比并集是发现不了的——outOfBand 在派发时优先，handle 那条成了死代码
  const result = checkFrontendDispatchCoverage({ rootDir: root, contractTypes: new Set(['alpha', 'gamma']) });
  assert.deepEqual(result.problems.map(p => [p.code, p.type]), [['duplicate_handler', 'gamma']]);
});

// ── 第三份表：DEFAULT_REPLAY_OOB_TYPES ────────────────────────────
// 它是 outOfBand 的平行副本。只验 handle ∪ outOfBand == 契约够不着它：给 outOfBand 加类型并同步
// protocol.js，那道断言照样绿，而漏改这份副本会让新类型被 replay buffer 误入队、在 reload 时永久丢失。

test('replay OOB 镜像：outOfBand 有而副本漏了 → 报，指出会永久丢失', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-replay-oob-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'public/js/app.js', `
    const handle = { alpha: onAlpha };
    const d = createAgentEventDispatcher({ outOfBand: { gamma: onGamma, delta: onDelta } });
  `);
  // 副本漏了 delta —— 正是「加了第 6 个 OOB 类型忘了同步」的形状
  await writeFixture(root, 'public/js/app/event-dispatch.js',
    `const DEFAULT_REPLAY_OOB_TYPES = new Set(['gamma']);`);

  const result = checkFrontendDispatchCoverage({
    rootDir: root,
    contractTypes: new Set(['alpha', 'gamma', 'delta']),
  });
  assert.deepEqual(result.problems.map(p => [p.code, p.type]), [['replay_oob_missing', 'delta']]);
});

test('replay OOB 镜像：副本残留了已下线的类型 → 报陈旧', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-replay-oob-stale-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'public/js/app.js', `
    const handle = { alpha: onAlpha };
    const d = createAgentEventDispatcher({ outOfBand: { gamma: onGamma } });
  `);
  await writeFixture(root, 'public/js/app/event-dispatch.js',
    `const DEFAULT_REPLAY_OOB_TYPES = new Set(['gamma', 'removed_type']);`);

  const result = checkFrontendDispatchCoverage({ rootDir: root, contractTypes: new Set(['alpha', 'gamma']) });
  assert.deepEqual(result.problems.map(p => [p.code, p.type]), [['replay_oob_stale', 'removed_type']]);
});

test('replay OOB 镜像：副本定位不到也必须报错，不能静默跳过', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-replay-oob-anchor-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'public/js/app.js', `
    const handle = { alpha: onAlpha };
    const d = createAgentEventDispatcher({ outOfBand: { gamma: onGamma } });
  `);
  await writeFixture(root, 'public/js/app/event-dispatch.js', `const SOMETHING_ELSE = new Set(['gamma']);`);

  const result = checkFrontendDispatchCoverage({ rootDir: root, contractTypes: new Set(['alpha', 'gamma']) });
  assert.deepEqual(result.problems.map(p => p.code), ['replay_oob_table_not_found']);
});

test('replay OOB 镜像：真实仓库两份表逐字一致', () => {
  const result = checkFrontendDispatchCoverage();
  assert.deepEqual(result.problems, []);
  assert.equal(result.tables.replayOob, result.tables.outOfBand,
    'DEFAULT_REPLAY_OOB_TYPES 与 app.js 的 outOfBand 表条数必须相等');
});
