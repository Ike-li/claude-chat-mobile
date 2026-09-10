// tests/unit/agent-event-contract.test.mjs —— PROTO-01 的扫描器自身（不是名单本身）
// 名单真相源是 app/src/shared/protocol.js，四方一致性由 tests/gates/contract-check.js 在 check 上执行；
// 本文件测的是【那个扫描器会不会看漏】：出向扫描面必须递归覆盖 app/src/（手写清单外的模块发未登记
// type 也要拦）、认得出 io.to(room).emit(、能抓住「契约里有但没人发」的死 type。
// 扫描器失明的后果是静默的——contract-check 照常打绿，而浏览器那边在丢事件。
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
} from '../../tests/gates/agent-event-contract.js';

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

  await writeFixture(root, 'app/src/agent/agent.js', `
    class AgentSession {
      run() {
        this.emit('init', {});
      }
    }
  `);
  await writeFixture(root, 'app/src/server/app.js', `
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

// 出向扫描面此前是手写两文件清单（agent.js + server/app.js），而真实仓库里 app/src/auth/device-gate.js
// 与 app/src/server/socket.js 也在发 agent:event —— 它们完全在门禁视野外。对比：入向检查用 serverDirs=['src']
// 递归扫描，注释还写着「新增模块自动纳入扫描面，不靠手工登记文件清单」。出向没享受到同一待遇：
// 在 app/src/ 下新建模块发一个未登记 type，npm run check 全绿，前端 dispatcher 收到未知 type 静默丢弃。
test('出向扫描面递归覆盖 app/src/：手写清单外的模块发未登记 type 也要被拦', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-agent-event-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'app/src/agent/agent.js', `
    class AgentSession { run() { this.emit('init', {}); } }
  `);
  await writeFixture(root, 'app/src/server/app.js', `
    io.emit('agent:event', { type: 'init', payload: {} });
  `);
  // 既不是 agent.js 也不是 server/app.js —— 真实仓库里 device-gate.js 就是这种位置
  await writeFixture(root, 'app/src/auth/device-gate.js', `
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

// SEC-01：app/server.js 用 io.to('approved').emit('agent:event', ...) 做下行隔离（房间过滤），
// 这是合法的链式广播调用、非动态类型——静态扫描须识别，否则会把仍在真实发出的类型误判为「real 不再发出」。
test('agent event contract 识别 io.to(room).emit("agent:event", ...) 链式调用', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-agent-event-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'app/src/agent/agent.js', `
    class AgentSession {
      run() {
        this.emit('init', {});
      }
    }
  `);
  await writeFixture(root, 'app/src/server/app.js', `
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

  await writeFixture(root, 'app/src/agent/agent.js', `
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

  await writeFixture(root, 'app/src/server/app.js', `
    on(socket, 'user:message', () => {});
    on(socket, 'user:rogue', () => {});
    socket.on('disconnect', () => {});
  `);
  await writeFixture(root, 'app/public/js/app.js', `socket.emit('user:message', {});`);
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

  await writeFixture(root, 'app/src/server/app.js', `on(socket, 'user:message', () => {});`);
  await writeFixture(root, 'app/public/js/app.js', `socket.emit('user:message', {});`);
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

  await writeFixture(root, 'app/src/server/app.js', `on(socket, 'user:message', () => {});`);
  await writeFixture(root, 'app/public/js/app/extra.js', `sock.emit('user:unhandled', {});`);
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
  //        app/src/server/app.js 的 handler 头注：只写文件不动 process.env、key 白名单（env-schema）、
  //        日志与 ack 只记 key 名不记值。env:set 因为要真写 .env 而进 MOCK_INBOUND_EXEMPT）
  // （曾含 session:delete：L1 软隐藏；2026-08-26 移除——制造 CLI/web 不等价且无反隐藏入口；
  //   只留 session:deletePermanent 真删。session:* 由 9 变 8，入向总数 42→41）
  //      + audit:get（2026-09-02，安全日志段：审计记录的唯一读取面。data/audit-records.json 自始
  //        只写不读——限速锁定的来源 IP、设备批准/拒绝、越界访问全记着但 web 一条也看不到，于是
  //        「⛔ 有人在暴力尝试你的入口」这类告警无从下钻。只读、过 deviceApproved 闸、不开 HTTP 端点。
  //        入向总数 41→42）
  //      + read:sync / read:mark（2026-09-03，跨设备共享已读位点：抽屉未读此前全存 localStorage，
  //        换设备后 seen 表为空、全部回落到「本设备首次打开时刻」这个很老的基线 → 在另一台读过的
  //        会话整屏复亮。位点搬进 data/read-state.json，本地降级为离线缓存。入向总数 42→44）
  //      + attachment:read（2026-09-06，附件从 <workDir>/.ccm-uploads/ 搬进 <dataDir>/uploads/<桶>/ 时新开：
  //        搬家后 browse:read 读不到附件了——那条通道的 scope 是 workDirs，附件根不在其中会 fail-closed。
  //        与其把附件根塞进通用文件通道的 scope，不如开这条专用的：入参只有裸文件名，目录由服务端算，
  //        客户端无从表达任意路径，比原先复用 browse:read 更窄。入向总数 44→45）
  //      + task:output（2026-09-07，后台任务完成后读 CLI 落盘的 stdout：路径由 task_notification
  //        的 output_file 给出，位于 CLI 自己的临时目录。理由同 attachment:read——不能复用
  //        browse:read，那条通道的 scope 是 workDirs，CLI 临时目录不在其中会 fail-closed；而把
  //        临时目录塞进通用文件通道的 scope 等于开一个更宽的洞。这条专用通道的入参只有 taskId，
  //        路径由服务端从自己记录的 CLI 上报值取，客户端连"选路径"都做不到。入向总数 45→46）
  //      + user:revokeTrustedDevice（2026-09-09，Web 侧吊销【已受信任】设备。刻意不复用
  //        user:denyDevice：那条处理待审设备（拒绝一台还进不来的设备是安全方向、免确认，
  //        且载荷里的 deviceId 本就已广播给可信端），这条处理已在用的设备（破坏性、要强确认），
  //        且载荷只有 shortId——DEVICE-03 不许把全量信任表下发到网络上。两个风险档共用一个
  //        handler 迟早写反。入向总数 46→47）
  //      + subagent:flow（2026-09-10，历史回放时按需读一个子代理的执行流水。刻意不并进
  //        session:history：主 transcript 里【没有】子代理的执行内容（全库实证 isSidechain 只出现在
  //        <sessionId>/subagents/agent-*.jsonl 内），那批文件实测中位 360KB、最大 1.2MB、总 69MB，
  //        随历史整批推等于把一轮历史放大一个数量级，而绝大多数卡用户根本不会展开。
  //        安全模型同 tool:preview / task:output：客户端只传 toolUseId，路径由服务端从
  //        sessionId+cwd 自己算，入口再过一道 isSafeSessionId（SS-003）。入向总数 47→48）
  //      + user:renameTrustedDevice（2026-09-10，给已受信任设备起别名。别名是唯一对所有平台
  //        都成立的分辨手段：iOS 拿不到机型，局域网 http:// 下 UA Client Hints 不可用（非安全
  //        上下文），而同一部手机的微信 webview 与 Chrome 本就是两条独立记录。寻址同吊销走
  //        shortId，但**没有自改守卫**——给自己这台起名不像吊销那样会把自己踢下线。入向 48→49）
  //      + session:rewind:preview（2026-09-10，文件轴 Rewind 的只读预览：回答「这一轮能不能回退、
  //        会动哪些文件」。刻意不并进 session:fork——两者虽然共用长按气泡入口，锚点语义却相反：
  //        fork 取【前一条 assistant】（保留到这条为止），rewind 要【被丢弃那轮 prompt 自身】的 uuid
  //        （SDK 的 rewindFiles 只认它，送 assistant uuid 会报「找不到检查点」）。共用一个 handler
  //        必然写反其中一条。分成 preview / confirm 两步则是因为回退【会改磁盘】：预览只读，
  //        且在动任何文件之前就把「CLI 会不会拒绝这次截断」算出来——那个拒绝确定性且不可重试，
  //        等到执行时才发现，文件已经回滚而对话没截断，撕裂态无法自动恢复。入向 49→50）
  //      + session:rewind:confirm（2026-09-10，回退的执行步。与 preview 分开是因为它【会改磁盘】：
  //        preview 只读、可随便点；confirm 要回滚文件并截断对话，两者的权限档、并发锁、失败处置
  //        全不同，合成一个 handler 靠 payload 里的 dryRun 开关分流迟早写反。入向 50→51）
  //      + statusline:setup（2026-09-10，statusline 桥的装/卸。此前两个 CLI 桥在 web 上待遇差一个
  //        量级：hooks 桥有安装态、有一键开关，statusline 桥在 service:status 里连字段都没有，
  //        只能回电脑敲 npm run statusline:status——而「人不在电脑前」正是这个产品的前提。
  //        刻意不并进 hooks:setup：两个桥改的是 settings.json 里完全不同的键（hooks[] vs
  //        statusLine.command），漂移判据也不同（statusline 还要比 refreshInterval），
  //        共用一个 handler 靠 payload 分流迟早写反。**只收 install/uninstall 不收 verify**——
  //        statusline 安装器没有 verify 子命令，收了只会在 spawn 那层报错。入向 51→52）
  //      + permissions:rules（2026-09-10，审批白名单的只读面。agent.js:269 明写「不注入
  //        options.allowedTools：放行白名单完全交给 settingSources 的 permissions.allow」——
  //        这份名单决定手机上哪些工具直接放行、哪些弹审批，而 web 端此前既读不到也写不了，
  //        用户批到烦时「为什么这个老弹 / 那个为什么不弹」无从回答。
  //        **刻意不塞进 instances 广播**：那条路每个轮次边界都触发，而名单只在设置面板打开时
  //        看一眼，放进去等于给每台连着的设备每轮白发一份（同 restarts 不进广播的理由）。
  //        入向 52→53）
  //      + connect:qr（2026-09-10，接入二维码。此前只有终端有这个能力（node scripts/qr.js），
  //        而「人不在电脑前」正是本产品的前提——想把第二台手机接进来得先回电脑。
  //        token 走 URL fragment（不进任何中间层访问日志），受 Access 保护的域名则**不带 token**
  //        （那条路只认 JWT、不回退 AUTH_TOKEN，带上去纯属泄漏）——判据复用
  //        shared/public-target.js 的 includeToken，不在 handler 里另算一套。
  //        前端那侧另有两步展开 + 定时自动隐藏，理由同 scripts/qr.js 必须手敲：
  //        二维码没有「安全的默认档」，而人不会去遮一个「看起来无害」的方块图案。入向 53→54）
  assert.equal(INBOUND_SOCKET_EVENTS.length, 54);
  assert.ok(INBOUND_SOCKET_EVENTS.includes('connect:qr'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('permissions:rules'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('statusline:setup'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('session:rewind:preview'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('session:rewind:confirm'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('user:renameTrustedDevice'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('subagent:flow'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('user:revokeTrustedDevice'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('task:output'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('attachment:read'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('read:sync'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('read:mark'));
  assert.ok(INBOUND_SOCKET_EVENTS.includes('audit:get'));
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

// 出向侧对称的数量锚点。CLAUDE.md 对外宣称的种数，此前全仓没有任何断言盯着
// AGENT_EVENT_TYPES 的长度——增删 type 时那句话会静默失真。入向早有上面那条断言守着，
// 出向没有纯属遗漏。数字变动时 doc-consistency 的 checkContractCounts 会把文档侧一并拦下。
test('AGENT_EVENT_TYPES 数量与 CLAUDE.md 宣称的 30 种一致', () => {
  //      + rewind_applied（2026-09-10，文件轴回退已生效的广播。刻意做成出向事件而不是只回 ack：
  //        回退同时改了【文件】和【对话树】，而这两者在别的设备上都缓存着——另一台手机若只靠 ack
  //        就永远不知道该重载，屏幕上会一直留着已被服务端截断的那几轮，且刷新前不自愈。
  //        它走 outOfBand（跨会话通知，不能触发 currentSessionId 切换），因此必须同时登记进
  //        DEFAULT_REPLAY_OOB_TYPES——否则回放缓冲会把它排队再整批丢弃。出向 30→31）
  assert.equal(AGENT_EVENT_TYPES.length, 31);
  assert.ok(AGENT_EVENT_TYPES.includes('rewind_applied'));
  // trusted_devices（2026-09-09）：已受信任设备列表的下发面。载荷里没有全量 token，
  // 只有 shortId + kind/ua/ip/approvedAt + isCurrent（DEVICE-03）。
  assert.ok(AGENT_EVENT_TYPES.includes('trusted_devices'));
  // 两个旁路提问（2026-09-10）：回来时的会话摘要 / 每轮收尾后的下一步建议。二者都不经 SDK 消息流，
  // 由 agent 主动 emit（askSideQuestion 的响应），故契约表是它们进入前端视野的唯一入口。
  assert.ok(AGENT_EVENT_TYPES.includes('session_recap'));
  assert.ok(AGENT_EVENT_TYPES.includes('prompt_suggestion'));
});

// ── 2026-08-02 补的两个反向闸 ───────────────────────────────────────────────
// 此前两侧都只查「不许多」（mock ⊆ real、mock ⊆ contract），不查「不许少」。于是真实侧新增一个
// 事件类型 / 入向事件时，mock 停在原地照样全绿——那类事件从此永远进不了 E2E 视野且无人知道，
// 而前端 dispatcher 对未知 type 是静默丢弃。下面三条钉住新增的方向。

test('出向：real 发得出而 mock 从不产出的 type 要被拦（real ⊆ mock 方向）', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-real-not-mock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFixture(root, 'app/src/agent/agent.js', "this.emit('init', {});\nthis.emit('brand_new_type', {});\n");
  await writeFixture(root, 'tests/e2e/mock/server.js', "io.emit('agent:event', { type: 'init' });\n");

  const result = checkAgentEventContract({
    rootDir: root,
    contractTypes: new Set(['init', 'brand_new_type']),
    realSources: [{ path: 'app/src/agent/agent.js', kind: 'agent-session' }],
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
  await writeFixture(root, 'app/src/agent/agent.js', "this.emit('init', {});\nthis.emit('brand_new_type', {});\n");
  await writeFixture(root, 'tests/e2e/mock/server.js', "io.emit('agent:event', { type: 'init' });\n");

  const result = checkAgentEventContract({
    rootDir: root,
    contractTypes: new Set(['init', 'brand_new_type']),
    realSources: [{ path: 'app/src/agent/agent.js', kind: 'agent-session' }],
    mockSources: [{ path: 'tests/e2e/mock/server.js', kind: 'agent-event-emit' }],
    mockExemptTypes: new Set(['brand_new_type']),
  });

  assert.deepEqual(result.problems, []);
});

test('入向：契约里有、mock 没 handler 又没登记豁免 → 报；豁免登记后放行', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-inbound-not-mocked-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFixture(root, 'app/src/server/socket.js', "socket.on('user:message', () => {});\nsocket.on('ops:only', () => {});\n");
  await writeFixture(root, 'app/public/js/app.js', "socket.emit('user:message', {});\nsocket.emit('ops:only', {});\n");
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
  await writeFixture(root, 'app/src/server/socket.js', "socket.on('user:message', () => {});\n");
  await writeFixture(root, 'app/public/js/app.js', "socket.emit('user:message', {});\n");
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
  await writeFixture(root, 'app/public/js/app.js', `
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

  await writeFixture(root, 'app/public/js/app.js', `
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

  await writeFixture(root, 'app/public/js/app.js', `
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
  await writeFixture(root, 'app/public/js/app/event-dispatch.js',
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

  await writeFixture(root, 'app/public/js/app.js', `
    const handle = { alpha: 1, 'quoted_key': 2 };
    const d = createAgentEventDispatcher({ outOfBand: { gamma: 3 } });
  `);
  await writeFixture(root, 'app/public/js/app/event-dispatch.js',
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

  await writeFixture(root, 'app/public/js/app.js', `
    const handle = { alpha: onAlpha, gamma: onGammaHandled };
    const d = createAgentEventDispatcher({ outOfBand: { gamma: onGammaOob } });
  `);
  await writeFixture(root, 'app/public/js/app/event-dispatch.js',
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

  await writeFixture(root, 'app/public/js/app.js', `
    const handle = { alpha: onAlpha };
    const d = createAgentEventDispatcher({ outOfBand: { gamma: onGamma, delta: onDelta } });
  `);
  // 副本漏了 delta —— 正是「加了第 6 个 OOB 类型忘了同步」的形状
  await writeFixture(root, 'app/public/js/app/event-dispatch.js',
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

  await writeFixture(root, 'app/public/js/app.js', `
    const handle = { alpha: onAlpha };
    const d = createAgentEventDispatcher({ outOfBand: { gamma: onGamma } });
  `);
  await writeFixture(root, 'app/public/js/app/event-dispatch.js',
    `const DEFAULT_REPLAY_OOB_TYPES = new Set(['gamma', 'removed_type']);`);

  const result = checkFrontendDispatchCoverage({ rootDir: root, contractTypes: new Set(['alpha', 'gamma']) });
  assert.deepEqual(result.problems.map(p => [p.code, p.type]), [['replay_oob_stale', 'removed_type']]);
});

test('replay OOB 镜像：副本定位不到也必须报错，不能静默跳过', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccm-replay-oob-anchor-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, 'app/public/js/app.js', `
    const handle = { alpha: onAlpha };
    const d = createAgentEventDispatcher({ outOfBand: { gamma: onGamma } });
  `);
  await writeFixture(root, 'app/public/js/app/event-dispatch.js', `const SOMETHING_ELSE = new Set(['gamma']);`);

  const result = checkFrontendDispatchCoverage({ rootDir: root, contractTypes: new Set(['alpha', 'gamma']) });
  assert.deepEqual(result.problems.map(p => p.code), ['replay_oob_table_not_found']);
});

test('replay OOB 镜像：真实仓库两份表逐字一致', () => {
  const result = checkFrontendDispatchCoverage();
  assert.deepEqual(result.problems, []);
  assert.equal(result.tables.replayOob, result.tables.outOfBand,
    'DEFAULT_REPLAY_OOB_TYPES 与 app.js 的 outOfBand 表条数必须相等');
});
