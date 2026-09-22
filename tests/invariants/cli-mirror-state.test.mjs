// tests/invariants/cli-mirror-state.test.mjs —— 单驾驶员仲裁与终端只读镜像态
// 守护：SESSION-01（终端驾驶时 Web 不得写入）、SRV-003（externalDirty 该置换时置换 / 忙碌时禁置换，两侧都钉）
// 覆盖：CLI 观察态提取/只读限制 + 安全路径门 + SRV-003 两侧（忙碌禁置换 / 空闲吸收终端轮次）+ 镜像锁收敛
// 槽位：S1（纯函数 + 一次性目录真 fs 读写 + 源码契约）
// 不测什么 + 为什么：不测真实 Claude CLI 进程 spawn 与真 Socket.io 广播（属于 S2 server-sync / S5 真 CLI 槽）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { extractCliObservedState, readCliObservedState } from '../../app/src/agent/cli-mirror-state.js';
import { externalDirtyBusyNack } from '../../app/src/server/instance-routing.js';
import { createInstanceManager } from '../../app/src/server/instance-manager.js';
import {
  mirrorEntryLock,
  mirrorReleaseStep,
  mirrorStaleFlag,
  MIRROR_STALE_PENDING_MS,
  getProjectDir,
} from '../../app/src/sessions/history.js';

let TMP_BASE;
test.before(() => {
  TMP_BASE = mkdtempSync(join(tmpdir(), 'ccm-inv-cli-mirror-'));
});
test.after(() => {
  if (TMP_BASE) rmSync(TMP_BASE, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

test.describe('SESSION-01: extractCliObservedState 纯函数提取主链状态', () => {
  test('提取最新主链真实 assistant 模型，排除 sidechain、parent_tool_use_id 与 <synthetic>', () => {
    const observed = extractCliObservedState([
      { type: 'assistant', message: { role: 'assistant', model: 'claude-3-opus' } },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', model: 'claude-3-5-sonnet' } },
      { type: 'assistant', parent_tool_use_id: 'tool_123', message: { role: 'assistant', model: 'claude-3-haiku' } },
      { type: 'assistant', message: { role: 'assistant', model: '<synthetic>' } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-3-7-sonnet' } },
    ]);
    assert.deepEqual(observed, { model: 'claude-3-7-sonnet', permissionMode: null });
  });

  test('提取主链 permission-mode，支持合法档位，sidechain 不污染主链', () => {
    const observed = extractCliObservedState([
      { type: 'permission-mode', permissionMode: 'default' },
      { type: 'permission-mode', isSidechain: true, permissionMode: 'bypassPermissions' },
      { type: 'permission-mode', parent_tool_use_id: 'tool_xyz', permissionMode: 'auto' },
      { type: 'permission-mode', permissionMode: 'plan' },
    ]);
    assert.deepEqual(observed, { model: null, permissionMode: 'plan' });
  });

  test('末条 permission-mode 非法时返回 null，绝不向旧合法值倒退', () => {
    const observed = extractCliObservedState([
      { type: 'permission-mode', permissionMode: 'default' },
      { type: 'permission-mode', permissionMode: 'unrecognized_mode_xxx' },
    ]);
    assert.deepEqual(observed, { model: null, permissionMode: null });
  });

  test('非数组或空输入防御：返回空观察态，不崩溃', () => {
    assert.deepEqual(extractCliObservedState(null), { model: null, permissionMode: null });
    assert.deepEqual(extractCliObservedState(undefined), { model: null, permissionMode: null });
    assert.deepEqual(extractCliObservedState([]), { model: null, permissionMode: null });
  });
});

test.describe('SESSION-01: readCliObservedState 磁盘读取与安全路径门', () => {
  test('sessionId 格式校验：非法/包含路径穿越字符直接拒绝并返回空态，绝不读盘', async () => {
    const cwd = '/workspace/test-repo';
    const invalidIds = ['../escape', 'session/evil', 'sess$ion', '', '   ', null, undefined];
    for (const sid of invalidIds) {
      const res = await readCliObservedState(sid, cwd, { baseDir: TMP_BASE });
      assert.deepEqual(res, { model: null, permissionMode: null });
    }
  });

  test('从真实 transcript 尾部读取最新状态', async () => {
    const cwd = '/workspace/project-alpha';
    const sid = 'sess-valid-001';
    const projDir = join(TMP_BASE, getProjectDir(cwd));
    mkdirSync(projDir, { recursive: true });
    const file = join(projDir, `${sid}.jsonl`);

    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'plan' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-3-7-sonnet' } }),
    ];
    writeFileSync(file, lines.join('\n') + '\n');

    const res = await readCliObservedState(sid, cwd, { baseDir: TMP_BASE });
    assert.deepEqual(res, { model: 'claude-3-7-sonnet', permissionMode: 'plan' });
  });

  test('文件不存在或空文件时静默返回空观察态，不抛出异常', async () => {
    const res = await readCliObservedState('non-existent-session', '/tmp/repo', { baseDir: TMP_BASE });
    assert.deepEqual(res, { model: null, permissionMode: null });
  });
});

test.describe('SESSION-01 & SRV-003: externalDirty 吸收终端写入与忙碌置换互斥', () => {
  test('SRV-003 侧一: pendingTurns > 0 时禁止置换，负 ACK 提示吸收终端写入 + 上一轮', () => {
    const r = externalDirtyBusyNack({ pendingTurns: 1 });
    assert.equal(r.retryable, true);
    assert.equal(r.busy, true);
    assert.equal(r.reason, 'turn');
    assert.match(r.error, /吸收终端写入/);
    assert.match(r.error, /上一轮|仍在处理/);
    assert.match(r.detail, /pendingTurns=1/);
  });

  test('SRV-003 侧一: 待审审批或提问挂起时禁止置换，负 ACK 提示审批/提问', () => {
    const r = externalDirtyBusyNack({ pendingPermissionCount: 1 });
    assert.equal(r.retryable, true);
    assert.equal(r.busy, true);
    assert.equal(r.reason, 'permission');
    assert.match(r.error, /待处理的审批或提问/);
  });

  test('SRV-003 侧一: 后台任务挂起时禁止置换，负 ACK 提示后台任务仍在运行', () => {
    const r = externalDirtyBusyNack({ bgTaskCount: 2 });
    assert.equal(r.retryable, true);
    assert.equal(r.busy, true);
    assert.equal(r.reason, 'bg_tasks');
    assert.match(r.error, /后台任务仍在运行/);
    assert.match(r.detail, /bgTasks=2/);
  });

  test('SRV-003 侧一: 优先级严格遵循 turn > permission > bg_tasks > busy', () => {
    const r = externalDirtyBusyNack({
      pendingTurns: 2,
      pendingPermissionCount: 1,
      bgTaskCount: 3,
    });
    assert.equal(r.reason, 'turn');
    assert.match(r.detail, /pendingTurns=2/);
    assert.match(r.detail, /bgTasks=3/);
    assert.match(r.detail, /permissions=1/);
  });

  // SRV-003「空闲时必须置换」2026-09-05 搬去 S2：
  //   tests/invariants/server/external-dirty.test.mjs —— 真 transcript 外部增长 → catchUpTick 观察到
  //   → 下一条 web 消息落在【新实例】上，且新实例仍绑同一会话。
  //
  // 原来这里是 readFileSync(app.js) + indexOf 比三个源码字符串的先后。那种断言钉的是源码
  // 长什么样：改个变量名无故变红，保持文本不变而改坏行为照样绿。
  // 以前写不了行为版是因为 fake-claude.sh 不产出输出 ⇒ a.sessionId 恒 null ⇒ 守卫整条不可达；
  // 可驱动档（CCM_FAKE_CLAUDE_MODE=turn）解除了这个前提。
  //
  // 另一侧「忙碌时不得置换」不在 S2 —— mirror-engine 的 localBusy 分支有意把忙碌期间的磁盘
  // 增长归因为己方写入、不标 externalDirty（2026-07-18 修的就是这条），所以那个前置态在 S2
  // 造不干净。它的判定纯函数 externalDirtyBusyNack 已在 tests/unit/instance-routing.test.mjs
  // 逐维覆盖（11 处断言）。
});

test.describe('SESSION-01: 镜像锁判定规则纯函数收敛（history.js）', () => {
  test('mirrorEntryLock: 终端自报忙碌或尾部 pending 触发预锁，localBusy 豁免', () => {
    // 终端权威自报 registryBusy=true -> 直接上锁
    assert.equal(mirrorEntryLock({ registryBusy: true }), true);

    // 尾部为 pending 且新鲜 -> 上锁
    assert.equal(mirrorEntryLock({ tailVerdict: 'pending', now: 10000, lastChainTs: 9000 }), true);

    // 尾部为 settled -> 不上锁
    assert.equal(mirrorEntryLock({ tailVerdict: 'settled' }), false);

    // 本地己方在忙（localBusy） -> 绝不上锁（防自锁）
    assert.equal(mirrorEntryLock({ tailVerdict: 'pending', localBusy: true }), false);
  });

  test('mirrorReleaseStep: 外部写入维持锁，连续静默达到 releaseTicks 后自动释放', () => {
    // 外部新写入 -> 重置 quietTicks 并维持锁
    const r1 = mirrorReleaseStep({ readonly: false }, { externalWrite: true });
    assert.equal(r1.readonly, true);
    assert.equal(r1.state.quietTicks, 0);

    // 连续 4 轮静默 -> 仍处于 5 轮保护期内，保持只读
    const r2 = mirrorReleaseStep({ readonly: true, quietTicks: 3 });
    assert.equal(r2.readonly, true);
    assert.equal(r2.state.quietTicks, 4);

    // 第 5 轮静默 -> 达到阈值，释放只读锁
    const r3 = mirrorReleaseStep({ readonly: true, quietTicks: 4 });
    assert.equal(r3.readonly, false);
  });

  test('mirrorStaleFlag: 终端挂起超窗判定为 stale（可接管），活进程自报压制 stale', () => {
    const now = Date.now();
    // 尾部处于 pending 且长时间没有新写入 -> stale
    const stale = mirrorStaleFlag({
      readonly: true,
      tailPending: true,
      lastChainTs: now - MIRROR_STALE_PENDING_MS - 1000,
      now,
    });
    assert.equal(stale, true);

    // 终端注册表自报活着 -> 压制 stale 警告
    const suppressed = mirrorStaleFlag({
      readonly: true,
      tailPending: true,
      lastChainTs: now - MIRROR_STALE_PENDING_MS - 1000,
      now,
      registryBusy: true,
    });
    assert.equal(suppressed, false);
  });
});

// ── transcript 条目过滤的三个独立守卫 ────────────────────────────────────────
// 本节补的是变异对比里「已退役的旧测试独占咬住、本文件原先漏掉」的三个点（21:16 / 21:37 / 29:19）。
// 三者都是【任一成立就跳过】的或条件，写成 && 不会让任何既有用例变红。
test.describe('extractCliObservedState：三道跳过条件互相独立', () => {
  const assistant = (model, over = {}) => ({ type: 'assistant', message: { model }, ...over });

  test('空洞条目（null / undefined）被跳过，不因取属性而抛错', () => {
    // `!entry || isSidechain || parent_tool_use_id` 写成 && 时，null 条目会走到
    // entry.isSidechain 上直接 TypeError——整个镜像态提取跟着炸。
    const r = extractCliObservedState([null, undefined, assistant('claude-opus-4')]);
    assert.equal(r.model, 'claude-opus-4', '空洞条目应被静默跳过，后续条目照常生效');
  });

  test('子代理（isSidechain）的模型不得污染主会话镜像态', () => {
    // 子代理可能跑在另一个模型上，把它的 model 当成主会话的会让状态栏显示错的档位。
    const r = extractCliObservedState([
      assistant('claude-opus-4'),
      assistant('claude-haiku-4-5', { isSidechain: true }),
    ]);
    assert.equal(r.model, 'claude-opus-4', 'sidechain 条目必须被跳过');
  });

  test('工具子调用（parent_tool_use_id）同样被跳过', () => {
    const r = extractCliObservedState([
      assistant('claude-opus-4'),
      assistant('claude-haiku-4-5', { parent_tool_use_id: 'toolu_x' }),
    ]);
    assert.equal(r.model, 'claude-opus-4');
  });

  test('空字符串 model 不得被采纳（`candidate && ...` 两个条件缺一不可）', () => {
    // 写成 || 时，空串会满足 `'' !== "<synthetic>"` 而被当成有效模型名，
    // 状态栏 pill 会渲染出一个空白档位。
    const r = extractCliObservedState([assistant('claude-opus-4'), assistant('   ')]);
    assert.equal(r.model, 'claude-opus-4', '空白模型名应被忽略，保留上一个有效值');
  });

  test('<synthetic> 占位模型不得被采纳', () => {
    const r = extractCliObservedState([assistant('claude-opus-4'), assistant('<synthetic>')]);
    assert.equal(r.model, 'claude-opus-4');
  });
});

// ── 单驾驶员判定用的实例状态：「己方在写盘」只认在途轮（2026-09-22 review P0）──────────────
// stateOf 把 hasBgTasks() 折进 'busy'，那是给抽屉/运行条的粗粒度口径。镜像引擎若沿用它，
// 纯后台任务期（dev server 挂几小时、pendingTurns=0）会一直走 localBusy 分支：终端在同一会话
// 写的内容既不追平也不标 externalDirty，而发送闸只拦在途轮——手机消息送进 SDK 内存停在旧位置
// 的实例，从旧 parentUuid 分叉出第二条链。纯后台任务期 SDK 不写主链 transcript；它注入的
// <task-notification> 与随后的自动汇报自报 sdk-ts，由 catchUpStep 的 entrypoint 判据吸收。
// 接线侧（app.js 把它注入镜像引擎）由 invariants/server/external-dirty.test.mjs 的 S2 用例行为性钉住。
test('driverStateOf：纯后台任务期不算「己方在写盘」，在途轮与等审批照旧', () => {
  const manager = createInstanceManager();
  const id = manager.nextId();
  const agent = {
    instanceId: id,
    sessionId: 's-bg',
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    pendingTurns: 0,
    hasBgTasks: () => true,
    dispose() {},
  };
  manager.agents.set(id, agent);

  assert.equal(manager.stateOf(id), 'busy', '前置：抽屉口径把后台任务算运行中（这一侧不该变）');
  assert.equal(manager.driverStateOf(id), 'idle',
    '纯后台任务期被当成己方在写盘 = 终端写入既不追平也不标脏，手机消息送进陈旧实例、分叉');

  agent.pendingTurns = 1;
  assert.equal(manager.driverStateOf(id), 'busy', '在途轮仍是己方在写盘（与后台任务并存也一样）');
  agent.pendingTurns = 0;
  agent.pendingPermissions.set('req-1', {});
  assert.equal(manager.driverStateOf(id), 'permission', '等审批的判定不受影响（externalGrowthWhilePaused 靠它标脏）');
  agent.pendingPermissions.clear();
  agent.hasBgTasks = () => false;
  assert.equal(manager.driverStateOf(id), 'idle');
  assert.equal(manager.driverStateOf('inst_nope'), 'idle', '查不到实例按空闲处理，与 stateOf 同口径');
});
