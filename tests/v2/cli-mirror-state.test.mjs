// tests/v2/cli-mirror-state.test.mjs —— 单驾驶员仲裁与终端只读镜像态
// 守护：SESSION-01（终端驾驶时 Web 不得写入）、SRV-003（externalDirty 该置换时置换 / 忙碌时禁置换，两侧都钉）
// 覆盖：CLI 观察态提取/只读限制 + 安全路径门 + SRV-003 两侧（忙碌禁置换 / 空闲吸收终端轮次）+ 镜像锁收敛
// 槽位：S1（纯函数 + 一次性目录真 fs 读写 + 源码契约）
// 不测什么 + 为什么：不测真实 Claude CLI 进程 spawn 与真 Socket.io 广播（属于 S2 server-sync / S5 真 CLI 槽）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { extractCliObservedState, readCliObservedState } from '../../app/src/agent/cli-mirror-state.js';
import { externalDirtyBusyNack } from '../../app/src/server/instance-routing.js';
import {
  mirrorEntryLock,
  mirrorReleaseStep,
  mirrorStaleFlag,
  MIRROR_STALE_PENDING_MS,
  getProjectDir,
} from '../../app/src/sessions/history.js';

let TMP_BASE;
test.before(() => {
  TMP_BASE = mkdtempSync(join(tmpdir(), 'ccm-v2-cli-mirror-'));
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

  test('SRV-003 侧二: 源码契约验证 —— externalDirty 为真且空闲时，必须置换实例吸收外部轮次', () => {
    const src = readFileSync(new URL('../../app/src/server/app.js', import.meta.url), 'utf8');

    // 检查 app.js 中外部脏标记守卫
    const dirtyGuardIdx = src.indexOf('if (a.externalDirty && a.sessionId) {');
    assert.ok(dirtyGuardIdx > 0, 'app.js 必须包含 externalDirty 上下文守卫');

    const busyCheckIdx = src.indexOf('if (a.isBusy()) {', dirtyGuardIdx);
    assert.ok(busyCheckIdx > dirtyGuardIdx, '必须首先检查 a.isBusy() 并拒绝置换');

    const replaceIdx = src.indexOf('await dedupedResume(cwd, sid', busyCheckIdx);
    assert.ok(replaceIdx > busyCheckIdx, '在 a.isBusy() 检查之后，必须调用 dedupedResume 吸收外部轮次');
  });
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
// 本节补的是变异对比里「旧测试独占咬住、v2 原先漏掉」的三个点（21:16 / 21:37 / 29:19）。
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
