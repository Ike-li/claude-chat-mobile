// tests/integration/config-refresh.test.mjs —— config:refresh（CLI 配置刷新按钮）集成测试
// 背景：ensureCliDefaults(cwd) 的结果按 cwd 缓存进 cliDefaultsByCwd，只在启动预取 / session:new /
// session:home 才 force 重读；用户在 CLI 侧改了 ~/.claude/settings.json（或本例更易控的
// .claude/settings.local.json）后，web 端 compose 页默认档摘要不会自动感知。config:refresh 是手动
// 兜底入口：force 重读 + broadcastInstances。
// 验证：①ack {ok:true}；②instances 广播携带强制重读后的最新 defaultPermissionMode（证明真的重读了
// 磁盘，不是吐缓存里的旧值）；③显式传非法/越界 cwd 时拒绝（ok:false），不拿别的目录的配置冒充（SCOPE-05）。
// 零 token 成本（不起真 claude turn，只读本地 settings.local.json；sdkResolveSettings 不 spawn CLI）。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { reserveFreePort, spawnServer, killServer } from './_spawn-server.mjs';

const sleep = ms => new Promise(res => setTimeout(res, ms));
// 同 metrics-endpoint.test.mjs：显式设一个非空测试 token 而非删空——dotenv 默认不覆盖已存在的非空
// key（config.js 的预清空只针对空串），删空反而会被本机真实 .env 里的 AUTH_TOKEN/CF Access 回填
// （ccm-integration-tests-env-redness 记忆条目）。给真实非空值可绕开这整类既有环境红。
const TOKEN = 'config-refresh-test-token';
let port, dataDir, httpServer, io;

function writeLocalSettings(cwd, obj) {
  const dir = join(cwd, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.local.json'), JSON.stringify(obj), 'utf8');
}

// models 事件里是否出现了某个模型名。payload 形状 = agent emit 的 { models: [...] }
// （app.js pushModelsForCwd 原样透传 modelsCache 里的那份）。
function hasModel(event, name) {
  const list = event?.payload?.models;
  return Array.isArray(list) && list.some(m => (m?.displayName ?? m?.value ?? m) === name);
}

async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-config-refresh-test-'));
  writeLocalSettings(dataDir, { permissions: { defaultMode: 'plan' } });

  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR',
    'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(await reserveFreePort());
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = dataDir;
  process.env.AUTH_TOKEN = TOKEN;

  const serverModule = await import('../../app/server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  // 覆盖 dotenv 加载的 CF Access 配置（同 auth-token.test.mjs 套路）：连接走 127.0.0.1 本不会撞
  // isPublicHost，但显式关闭更稳妥、不依赖 host 匹配细节。
  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../app/src/auth/cf-access.js');
  cfAccess.initCfAccess();

  await sleep(500); // 等启动时 ensureCliDefaults(WORK_DIR) 首次读盘落缓存（非 force，见 app.js:2767）
}

// targetPort 缺省用同进程 server 的端口；下面「有活跃实例」那组用 spawnServer 起的独立子进程，
// 需要显式指定（它有自己的 CLAUDE_BIN / settings，同进程 server 的 env 已在 import 时定死）。
function createClient(targetPort = port) {
  const socket = ioClient(`http://127.0.0.1:${targetPort}`, { auth: { token: TOKEN }, transports: ['websocket'], reconnection: false });
  const events = [];
  socket.on('agent:event', e => events.push(e));

  return {
    socket,
    events,
    waitForConnect(timeout = 5000) {
      return new Promise((resolve, reject) => {
        if (socket.connected) return resolve();
        const timer = setTimeout(() => reject(new Error('connect timeout')), timeout);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
      });
    },
    waitForEvent(type, predicate, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const matches = e => e.type === type && (!predicate || predicate(e));
        const existing = events.find(matches);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
        const handler = e => {
          if (matches(e)) { clearTimeout(timer); socket.off('agent:event', handler); resolve(e); }
        };
        socket.on('agent:event', handler);
      });
    },
    emitAck(event, payload, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), timeout);
        socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
      });
    },
    clearEvents() { events.length = 0; },
    disconnect() { socket.disconnect(); },
  };
}

async function cleanup() {
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (io) { io.close(); io = null; }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } dataDir = null; }
}

test.describe('config:refresh（CLI 配置刷新按钮）', () => {
  test.before(async () => { await startServer(); });
  test.after(async () => { await cleanup(); });

  test('emit config:refresh 后 ack ok，且 instances 广播携带强制重读后的最新 defaultPermissionMode', async () => {
    const client = createClient();
    try {
      await client.waitForConnect();
      const firstInstances = await client.waitForEvent('instances');
      assert.equal(firstInstances.payload.defaultPermissionMode, 'plan', '启动时应已从 settings.local.json 读到 plan');

      // 模拟用户在终端侧改了配置：plan → acceptEdits
      writeLocalSettings(dataDir, { permissions: { defaultMode: 'acceptEdits' } });

      client.clearEvents();
      const ack = await client.emitAck('config:refresh', {});
      assert.equal(ack.ok, true, 'ack 应为 { ok: true }');

      const refreshed = await client.waitForEvent('instances', e => e.payload?.defaultPermissionMode === 'acceptEdits');
      assert.equal(refreshed.payload.defaultPermissionMode, 'acceptEdits', 'force 重读后应反映磁盘最新值，不是缓存的旧值 plan');
    } finally {
      client.disconnect();
    }
  });

  // 2026-09-24（SCOPE-05）：此前回落当前 viewingCwd 且 ack ok——刷新的是另一个目录的配置，用户却以为刷了自己点的那个。
  test('显式传非法/越界 cwd 时拒绝，ack ok:false', async () => {
    const client = createClient();
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances');

      const ack = await client.emitAck('config:refresh', { cwd: '/definitely/not/whitelisted' });
      assert.equal(ack.ok, false, '越界 cwd 不得回落成别的目录去刷新');
    } finally {
      client.disconnect();
    }
  });

  // models 事件由 scout 真起 claude 拉模型清单产出，stub（tests/fixtures/fake-claude.sh）给不了 →
  // CI 上必然 10s 超时。同文件其余两个用例只测 settings 重读与 cwd 回落，不碰 CLI，照常在 CI 跑。
  test('config:refresh 后应触发模型缓存刷新（models 事件或 scout）', process.env.CI
    ? { skip: 'models 事件需真 claude scout 拉模型清单；CI 用的是 tests/fixtures/fake-claude.sh stub' }
    : {}, async () => {
    const client = createClient();
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances');
      client.clearEvents();

      const ack = await client.emitAck('config:refresh', {});
      assert.equal(ack.ok, true);

      // models 事件应在数秒内到达（由活跃 agent fetchModels 或 scout 触发）
      // 超时 10s 给 CLI 启动足够时间
      const modelsEvent = await client.waitForEvent('models', null, 10000);
      assert.ok(modelsEvent.payload, 'models 事件应携带 payload');
    } finally {
      client.disconnect();
    }
  });
});

// ——— 有活跃实例时的模型清单刷新 ———
//
// 2026-09-15 真机形态：工作区 .claude/settings.local.json 里配了第三方网关（ANTHROPIC_BASE_URL +
// ANTHROPIC_DEFAULT_*_MODEL），用户改回官方后在 web 端点「刷新配置」，模型列表仍显示网关的模型名。
//
// 根因是两件事叠加，**都与「缓存过期」无关，靠加刷新次数解决不了**：
//   ① 子进程 env 是 spawn 那一刻注入的一次性快照（agent.js 的 `env: {...sdkChildEnv, ...resolvedEnv}`），
//      POSIX 下父进程改不了已运行子进程的 env；
//   ② SDK 的 supportedModels() 读的是 **spawn 时 initialize 响应里缓存的 models 字段**
//      （sdk.mjs: `supportedModels(){return(await this.initialization).models}`），压根不发第二次 IPC。
// 于是 config:refresh 只要走 `a.fetchModels()` 这条路，拿回来的必然是旧配置下的清单。而「该工作区有
// 活跃会话」恰恰是用户最常点刷新的时候——这个按钮在最需要它的场景下结构上刷不出任何新东西。
//
// 原先那道 5s 兜底（`if (!modelsCache.get(cwd))` 才起 scout）也堵不住：fetchModels 读的是一个已经
// resolve 的 Promise，必然「成功」，于是缓存非空、只是陈旧，判据永远不成立。
//
// 唯一能反映新配置的通道是 scout：它在 ensureCliDefaults(force) 之后用**重读后的** cliDefaultsByCwd.env
// 新 spawn 一个 CLI（app.js openScoutInstance 的 resolvedEnv）。
//
// 本用例钉的是外部可观察契约：**刷新后推送的清单必须来自重读后的 settings**，不是任何实例 spawn 时的快照。
// 它靠 fake-claude 把 ANTHROPIC_DEFAULT_OPUS_MODEL 回显进 initialize 响应的 models 来区分两者——
// 换言之，清单里出现的是哪个名字，直接说明这份清单是哪一次 spawn 的产物。
test.describe('config:refresh 在有活跃实例时（2026-09-15 真机 bug）', () => {
  let proc, refreshPort, workdir, refreshDataDir;

  const settingsWithGateway = model => ({
    permissions: { defaultMode: 'default' },
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: model },
  });

  test.before(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'ccm-refresh-models-wd-'));
    refreshDataDir = mkdtempSync(join(tmpdir(), 'ccm-refresh-models-data-'));
    writeLocalSettings(workdir, settingsWithGateway('gw-old-model'));
    const started = await spawnServer({
      AUTH_TOKEN: TOKEN,
      WORK_DIR: workdir,
      CCM_DATA_DIR: refreshDataDir,
      CLAUDE_BIN: join(process.cwd(), 'tests/fixtures/fake-claude.sh'),
      CCM_FAKE_CLAUDE_MODE: 'init', // 应答 initialize（模型清单就藏在这条响应里）+ 吐 system/init
      IDLE_TIMEOUT_MS: '120000',    // 别让实例在用例跑完前被空闲回收——没有活跃实例这条用例就失去意义
    });
    proc = started.proc;
    refreshPort = started.port;
  });

  test.after(async () => {
    if (proc) { await killServer(proc); proc = null; }
    for (const d of [workdir, refreshDataDir]) {
      if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  });

  test('刷新后的清单来自重读后的 settings，而不是活跃实例 spawn 时的快照', async () => {
    const client = createClient(refreshPort);
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances');

      // ① 造出一个**活跃实例**：这是整条用例的前提。没有它，config:refresh 会走 `!usedAgent`
      //    那条本来就正确的 scout 分支，用例便会在修复前也绿——一个永远不红的测试。
      //    fake-claude 的 init 档不吐 result，实例会停在 busy，正好是持续存在的观察对象。
      client.socket.emit('user:message', { text: 'hello', clientMessageId: 'refresh-models-1' });
      const withInstance = await client.waitForEvent(
        'instances', e => (e.payload?.instances?.length ?? 0) > 0, 20000);
      assert.ok(withInstance.payload.instances.length > 0, '前置条件：必须已有活跃实例');

      // ② 基线：这个实例 spawn 时读到的是 gw-old-model，清单里回显的就该是它。
      //    基线不成立说明 env 根本没注入到 stub，后面的断言也就证明不了任何事。
      const before = await client.waitForEvent(
        'models', e => hasModel(e, 'gw-old-model'), 20000);
      assert.ok(hasModel(before, 'gw-old-model'), '基线：活跃实例的清单应回显 spawn 时的 gw-old-model');

      // ③ 模拟用户在终端侧把网关改掉（真机里是整块删掉；这里换个名字，能更精确地区分
      //    「读到了新配置」与「读了个空、什么都没拿到」两种结果）。
      writeLocalSettings(workdir, settingsWithGateway('gw-new-model'));

      client.clearEvents();
      const ack = await client.emitAck('config:refresh', { cwd: workdir }, 10000);
      assert.equal(ack.ok, true);

      // ④ 修复前：活跃实例的 fetchModels 只会把 gw-old-model 再推一遍，这里必然超时。
      //    修复后：scout 用重读后的 env 新 spawn，清单里是 gw-new-model。
      const after = await client.waitForEvent(
        'models', e => hasModel(e, 'gw-new-model'), 25000);
      assert.ok(hasModel(after, 'gw-new-model'),
        '刷新后的清单必须反映重读后的 settings（不是任何实例 spawn 时的旧快照）');
    } finally {
      client.disconnect();
    }
  });

  // 验收 O85（AC-05-09）：改名后点 ↻ 能读进新名；可把 settings 还原回去再点 ↻（甚至刷新整页），清单仍停在
  // 改过的那个名字，只有重启 server 才恢复。接着上一条：此刻清单是 gw-new-model，把配置改回 gw-old-model。
  test('改回原值再刷新，清单也跟着改回（不只认新出现的名字）', async () => {
    const client = createClient(refreshPort);
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances');
      writeLocalSettings(workdir, settingsWithGateway('gw-old-model'));
      client.clearEvents();
      const ack = await client.emitAck('config:refresh', { cwd: workdir }, 10000);
      assert.equal(ack.ok, true);
      const reverted = await client.waitForEvent('models', e => hasModel(e, 'gw-old-model'), 25000);
      assert.ok(hasModel(reverted, 'gw-old-model'));
    } finally {
      client.disconnect();
    }
  });
});

// ——— 验收 O85（AC-05-09）：刷新之前就开着的会话，不得在刷新之后把旧默认模型写回去 ———
//
// 真机：把 opus 模型名改成 grok-4.7-acc0509 点 ↻，摘要更新；再改回 grok-4.7 点 ↻、甚至刷新整页，摘要仍停在
// grok-4.7-acc0509，只有重启 server 才恢复。服务端清单两个方向都推对了（上面那条用例），停住的是新会话页的
// 「默认模型」（instances.defaultModel ← defaultModelByCwd）：↻ 把它清空之后，改名期间开的那个会话还活着，
// 它下一轮的 system/init 报的仍是它 spawn 时的模型名——CLI 每轮都吐 init，server 每次都当成「本目录的默认模型」
// 记回去。整页刷新救不了（状态在 server），只有重启把那个实例杀掉才恢复。
// 活跃会话照旧用它 spawn 时那套配置（终端等价性），这没错；错的是把它的报告当成「现在新开会话会用什么」。
test.describe('config:refresh 之后，旧配置下开的会话不再改写默认模型', () => {
  let proc, port2, workdir, dataDir2;
  const settingsWith = model => ({ permissions: { defaultMode: 'default' }, env: { ANTHROPIC_DEFAULT_OPUS_MODEL: model } });

  test.before(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'ccm-refresh-default-wd-'));
    dataDir2 = mkdtempSync(join(tmpdir(), 'ccm-refresh-default-data-'));
    writeLocalSettings(workdir, settingsWith('gw-renamed'));
    const started = await spawnServer({
      AUTH_TOKEN: TOKEN,
      WORK_DIR: workdir,
      CCM_DATA_DIR: dataDir2,
      CLAUDE_BIN: join(process.cwd(), 'tests/fixtures/fake-claude.sh'),
      CCM_FAKE_CLAUDE_MODE: 'turn',
      CCM_FAKE_CLAUDE_INIT_EACH_TURN: '1',
      IDLE_TIMEOUT_MS: '120000',
    });
    proc = started.proc;
    port2 = started.port;
  });

  test.after(async () => {
    if (proc) { await killServer(proc); proc = null; }
    for (const d of [workdir, dataDir2]) {
      if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  });

  test('改回配置并 ↻ 后，旧会话的下一轮不会把旧模型名写回「默认模型」', async () => {
    const client = createClient(port2);
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances');

      // ① 改名期间开的新会话：首轮 init 报 gw-renamed，记成本目录默认模型——此刻是对的
      client.socket.emit('user:message', { text: 'first', clientMessageId: 'o85-1' });
      await client.waitForEvent('result', null, 20000);
      await client.waitForEvent('instances', e => e.payload?.defaultModel === 'gw-renamed', 10000);

      // ② 改回配置、点 ↻：默认模型应被清掉
      writeLocalSettings(workdir, settingsWith('gw-original'));
      client.clearEvents();
      const ack = await client.emitAck('config:refresh', { cwd: workdir }, 10000);
      assert.equal(ack.ok, true);
      await client.waitForEvent('instances', e => e.payload?.defaultModel == null, 10000);

      // ③ 旧会话再跑一轮：它的 init 仍报 gw-renamed（spawn 时的配置），这不该再写回默认模型
      client.clearEvents();
      client.socket.emit('user:message', { text: 'second', clientMessageId: 'o85-2' });
      await client.waitForEvent('result', null, 20000);
      await sleep(300);
      const stale = client.events.filter(e => e.type === 'instances' && e.payload?.defaultModel === 'gw-renamed');
      assert.equal(stale.length, 0, '旧配置下开的会话不能把 ↻ 清掉的默认模型写回去');
    } finally {
      client.disconnect();
    }
  });
});

// ——— #260 review：采纳改过的配置时当场推进代数，scout 晚到的「清单变了」不再作废当前这一代 ———
//
// session:new 会强制重读 settings，然后起 scout 去拿新清单；与此同时用户已经可以发首条消息，fresh 实例与 scout
// 都按新配置 spawn。此前代数只在 scout 报「清单变了」时才加一：
//   · 采纳了新快照的那一刻，旧配置记下的默认模型还挂着（新会话页预显一个已经不对的模型名）；
//   · scout 晚于 fresh 实例 spawn 时，它那一下加一把同一代的 fresh 实例当成旧配置——它报的默认模型被拒，
//     或者已经记下的被 scout 删掉，要等下一个 fresh 实例才恢复。
test.describe('session:new 采纳改过的配置：当场作废旧默认模型，scout 不再作废当前这一代', () => {
  let proc, port3, workdir, dataDir3;
  const settingsWith = (model, mode) => ({ permissions: { defaultMode: mode }, env: { ANTHROPIC_DEFAULT_OPUS_MODEL: model } });

  test.before(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'ccm-adopt-gen-wd-'));
    dataDir3 = mkdtempSync(join(tmpdir(), 'ccm-adopt-gen-data-'));
    writeLocalSettings(workdir, settingsWith('gw-a', 'default'));
    const started = await spawnServer({
      AUTH_TOKEN: TOKEN,
      WORK_DIR: workdir,
      CCM_DATA_DIR: dataDir3,
      CLAUDE_BIN: join(process.cwd(), 'tests/fixtures/fake-claude.sh'),
      CCM_FAKE_CLAUDE_MODE: 'turn',
      CCM_FAKE_CLAUDE_INIT_EACH_TURN: '1',
      CCM_FAKE_CLAUDE_MODEL_VALUE_FROM_GATEWAY: '1',
      IDLE_TIMEOUT_MS: '120000',
    });
    proc = started.proc;
    port3 = started.port;
  });

  test.after(async () => {
    if (proc) { await killServer(proc); proc = null; }
    for (const d of [workdir, dataDir3]) {
      if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  });

  test('改配置后 session:new：补广播里旧默认模型已作废；之后 fresh 实例报的新默认模型留得住', async () => {
    const client = createClient(port3);
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances');

      // ① 旧配置下开一个新会话：默认模型记成 gw-a，清单缓存也是 gw-a（scout 之后拿它比「变没变」）
      client.socket.emit('user:message', { text: 'first', clientMessageId: 'gen-1' });
      await client.waitForEvent('result', null, 20000);
      await client.waitForEvent('instances', e => e.payload?.defaultModel === 'gw-a', 10000);

      // ② 终端侧改配置（模型别名 + 默认权限档；后者只用来认出强制重读之后的那次补广播）
      writeLocalSettings(workdir, settingsWith('gw-b', 'acceptEdits'));
      client.clearEvents();
      const ack = await client.emitAck('session:new', { cwd: workdir }, 10000);
      assert.equal(ack.ok, true);
      // 用户随即发首条消息：fresh 实例与 scout 都按新配置 spawn
      client.socket.emit('user:message', { text: 'fresh', clientMessageId: 'gen-2' });

      // ③ 强制重读之后的补广播：与 scout 的 spawn 在同一段同步代码里，scout 还来不及回报。
      //    采纳了新快照就该当场作废 gw-a——它描述的是已经不在了的那套配置。
      const adopted = await client.waitForEvent('instances', e => e.payload?.defaultPermissionMode === 'acceptEdits', 10000);
      assert.notEqual(adopted.payload.defaultModel, 'gw-a', '采纳新配置后，旧配置记下的默认模型不能还挂在新会话页上');

      // ④ scout 报新清单（gw-b）之后，fresh 实例报的 gw-b 必须留得住
      await client.waitForEvent('models', e => hasModel(e, 'gw-b'), 20000);
      await client.waitForEvent('result', null, 20000);
      await client.waitForEvent('instances', e => e.payload?.defaultModel === 'gw-b', 10000);
      client.clearEvents();
      client.socket.emit('user:message', { text: 'again', clientMessageId: 'gen-3' });
      await client.waitForEvent('result', null, 20000);
      await sleep(300);
      const cleared = client.events.filter(e => e.type === 'instances' && e.payload?.defaultModel !== 'gw-b');
      assert.equal(cleared.length, 0, 'scout 晚到的「清单变了」不能把当前这一代记下的默认模型作废');
    } finally {
      client.disconnect();
    }
  });
});

// ——— #290 review：旧代数的实例回报的清单不再覆盖缓存 ———
//
// ↻ 之后旧实例照旧活着，它之后每轮 init 都会 fetchModels，回报的是 spawn 时固化的旧清单（见上面 config:refresh 的
// 注释）。此前它照样写进清单缓存（新连接重放的就是这份），而且把清单出处的代数往回改——之后 scout 遇到 ↻ 探测
// 不到的变化（CLI 升级、网关侧改了清单）时，会误以为变化已被解释过，默认模型不作废。
test.describe('↻ 之后旧代数的实例回报的清单不覆盖缓存', () => {
  let proc, port4, workdir, dataDir4;
  const settingsWith = model => ({ permissions: { defaultMode: 'default' }, env: { ANTHROPIC_DEFAULT_OPUS_MODEL: model } });

  test.before(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'ccm-stale-list-wd-'));
    dataDir4 = mkdtempSync(join(tmpdir(), 'ccm-stale-list-data-'));
    writeLocalSettings(workdir, settingsWith('gw-old'));
    const started = await spawnServer({
      AUTH_TOKEN: TOKEN,
      WORK_DIR: workdir,
      CCM_DATA_DIR: dataDir4,
      CLAUDE_BIN: join(process.cwd(), 'tests/fixtures/fake-claude.sh'),
      CCM_FAKE_CLAUDE_MODE: 'turn',
      CCM_FAKE_CLAUDE_INIT_EACH_TURN: '1',
      IDLE_TIMEOUT_MS: '120000',
    });
    proc = started.proc;
    port4 = started.port;
  });

  test.after(async () => {
    if (proc) { await killServer(proc); proc = null; }
    for (const d of [workdir, dataDir4]) {
      if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  });

  test('旧实例 ↻ 之后再跑一轮：新连接重放的仍是新清单', async () => {
    const client = createClient(port4);
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances');

      // ① 旧配置下开的实例
      client.socket.emit('user:message', { text: 'first', clientMessageId: 'stale-1' });
      await client.waitForEvent('result', null, 20000);
      await client.waitForEvent('models', e => hasModel(e, 'gw-old'), 20000);

      // ② 改配置、↻：scout 按新配置报回 gw-new
      writeLocalSettings(workdir, settingsWith('gw-new'));
      client.clearEvents();
      const ack = await client.emitAck('config:refresh', { cwd: workdir }, 10000);
      assert.equal(ack.ok, true);
      await client.waitForEvent('models', e => hasModel(e, 'gw-new'), 25000);

      // ③ 旧实例再跑一轮：它的 init 触发 fetchModels，回报 spawn 时的 gw-old
      client.clearEvents();
      client.socket.emit('user:message', { text: 'second', clientMessageId: 'stale-2' });
      await client.waitForEvent('result', null, 20000);
      await client.waitForEvent('models', e => hasModel(e, 'gw-old'), 10000);
      await sleep(300);
    } finally {
      client.disconnect();
    }

    // ④ 新连接：重放的清单来自缓存，必须仍是新配置的
    const fresh = createClient(port4);
    try {
      await fresh.waitForConnect();
      const replay = await fresh.waitForEvent('models', null, 10000);
      assert.ok(hasModel(replay, 'gw-new') && !hasModel(replay, 'gw-old'), '旧代数的实例把旧清单写回了缓存');
    } finally {
      fresh.disconnect();
    }
  });
});
