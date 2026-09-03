// tests/unit/mirror-lock-evidence.test.mjs —— 镜像只读锁「建立」与「释放」必须看同一组证据。
//
// 2026-09-02 真机症状：一个 100% 由 web 驱动的会话（18b2b5c1），在用户回答完 AskUserQuestion
// 之后突然显示「只读镜像：终端会话运行中，移动端当前只读」，而终端从没参与过这个会话。
// 现场实测：SDK 子进程活着（--permission-mode plan）、卡在等一条 ExitPlanMode 审批；
// transcript 尾部是那条没有 tool_result 的 tool_use，链尾自报 entrypoint='sdk-ts'。
//
// 根因不是判据算错，是**两个判定函数看的证据集不一样**：
//   入口 mirrorEntryLock   收 tailEntrypoint → 认出 'sdk-ts' 是己方残留 → 不建立锁 ✅
//   出口 mirrorReleaseStep 不收 tailEntrypoint → 只看 tailPending → 无条件维持锁 ❌
// 于是形成自锁闭环：等审批 ⇒ 尾部恒 pending ⇒ 锁恒维持 ⇒ UI 只读 ⇒ 点不到「批准」
// ⇒ 审批永远 pending。实测连续 30 个 tick（localBusy 两种取值）都不释放。
//
// 这与 2026-08-27 那轮「同一个事实两份来源」收敛（b941dfa）是同一族，但形状不同：那边是
// 同一事实有两份**实现**，这边是同一事实有两个**消费者、各看一个证据子集**。共同点仍然是
// 「当前恰好不出事，所以没人发现它们不对称」——直到某天走到只有一边能判断的那个分支。
//
// 本文件两部分：① 行为回归（钉住上面这个症状）；② 自动闸（防下一个证据又只加一边）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mirrorReleaseStep, mirrorEntryLock, MIRROR_RELEASE_QUIET_TICKS } from '../../app/src/sessions/history.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** 跑 n 个 tick，返回最后一次的 readonly。默认 tick 数取「足够释放」的量。 */
function runTicks(opts, { from = { readonly: true, quietTicks: 0 }, ticks = MIRROR_RELEASE_QUIET_TICKS + 3 } = {}) {
  let state = from;
  let readonly = true;
  for (let i = 0; i < ticks; i++) {
    const r = mirrorReleaseStep(state, { externalWrite: false, keepAlive: false, localBusy: false, ...opts });
    state = r.state;
    readonly = r.readonly;
  }
  return readonly;
}

// ══════════════════════════════════════════════════════════════════════════════
// ① 行为回归
// ══════════════════════════════════════════════════════════════════════════════

// 这一条就是上面那个真机症状。修复前：30 个 tick 也不释放。
test('web 自己写的 pending 尾部（sdk-ts）不得单独维持镜像锁', () => {
  assert.equal(runTicks({ tailPending: true, tailEntrypoint: 'sdk-ts' }), false,
    '尾部这条未完结轮次是 web 自己写的（entrypoint=sdk-ts），终端从没参与过这个会话。\n'
    + '  让它撑住锁 ⇒ 等审批期间尾部恒 pending ⇒ 锁永不释放 ⇒ 用户点不到「批准」⇒ 审批永远 pending。\n'
    + '  入口 mirrorEntryLock 早就认这条豁免了，出口必须看同一份证据。');
});

// 反向：防分叉那条线一寸都不许松。真终端写的 pending 仍然维持锁。
test('真终端写的 pending 尾部（cli）仍然维持镜像锁', () => {
  assert.equal(runTicks({ tailPending: true, tailEntrypoint: 'cli' }, { ticks: 30 }), true,
    'cli 尾部 = 终端可能正卡在一条几分钟的长工具上（零写盘）。这正是 tailPending 判据存在的理由，不得放松。');
});

// 白名单只认 sdk-ts：未知/新增取值一律回落既有判定（最坏维持今天的行为）。
// 误锁可由用户点「续接」化解；误放行造成的 transcript 分叉不可逆——两种错的代价不对称。
for (const entrypoint of [null, undefined, '', 'cli-headless', 'sdk-py', 'SDK-TS']) {
  test(`未知 entrypoint（${JSON.stringify(entrypoint)}）回落既有判定：仍维持锁`, () => {
    assert.equal(runTicks({ tailPending: true, tailEntrypoint: entrypoint }, { ticks: 30 }), true,
      '白名单只认精确的 sdk-ts。认错来源而误放行 → 两端并发写同一 JSONL → transcript 分叉不可逆。');
  });
}

// 修复只摘掉「tailPending 单独撑锁」这一条，其余兜底全部原样保留:
// 只要有任何一条真证据说明外部在动，sdk-ts 尾部照样锁。
test('sdk-ts 尾部下，其余上锁兜底一条不少', () => {
  const base = { tailPending: true, tailEntrypoint: 'sdk-ts' };
  assert.equal(runTicks({ ...base, externalWrite: true }, { ticks: 30 }), true,
    'externalWrite=观测到外部落定新文本消息，比尾部形态硬得多，必须照锁。');
  assert.equal(runTicks({ ...base, keepAlive: true }, { ticks: 30 }), true,
    'keepAlive=transcript 仍在长大，说明真有人在写盘。');
  assert.equal(runTicks({ ...base, registryBusy: true }, { ticks: 30 }), true,
    'registryBusy=CLI 进程注册表权威自报在跑（pid 已验活），压过一切磁盘推断。');
  // localBusy 是「己方在跑」：保持锁不变、不攒静默，与 sdk-ts 判据正交（见 mirrorReleaseStep 第二条早退）
  assert.equal(runTicks({ ...base, localBusy: true }, { ticks: 30 }), true,
    'localBusy 期间镜像锁保持不变，不该被 sdk-ts 豁免顺手解开。');
});

// ── 已知边界（2026-09-02 实测，有意不修）────────────────────────────────────────
// mirrorReleaseStep 的 localBusy 早退语义是「己方在跑时锁态保持不变」，它不看尾部形态。
// 于是留下一个窄窗：锁建立后不足 MIRROR_RELEASE_QUIET_TICKS 个 idle tick 就进入 busy/permission，
// 这把锁会被原样带进去冻结，直到 web 回到 idle 才继续攒静默。
//
// 2026-09-02 那次真机【不】落在这个窗里：上锁与等审批之间有 59 秒空窗（约 24–59 个 idle tick），
// 修复后第 5 个 tick 就释放了。实测见对话。
//
// 不一并修的理由：localBusy 分支刻意不计算 externalWrite/keepAlive（己方在跑时抑制追平、免读大文件），
// 在那里解锁等于在「看不见任何外部证据」的状态下放行，与防分叉的取舍方向相反——误锁可由用户点
// 「续接」化解，误放行造成的 transcript 分叉不可逆。真要收掉这个窗，正确的下手处是「锁为什么会被
// 错误建立」，而那一环至今复现不出来（三条造锁路径已实测排除，剩 catchUpStep 的 emit 路径存疑）。
test('已知边界：锁在攒够静默前进入 busy，会被带进 busy 态冻结', () => {
  let state = { readonly: true, quietTicks: 0 };
  const opts = { externalWrite: false, keepAlive: false, tailPending: true, tailEntrypoint: 'sdk-ts' };
  for (let i = 0; i < MIRROR_RELEASE_QUIET_TICKS - 3; i++) state = mirrorReleaseStep(state, { ...opts, localBusy: false }).state;
  let readonly = true;
  for (let i = 0; i < 30; i++) ({ readonly, state } = mirrorReleaseStep(state, { ...opts, localBusy: true }));
  assert.equal(readonly, true,
    '这条钉的是【当前行为】而非理想行为。哪天决定收掉这个窗，改的是 mirrorReleaseStep 的 localBusy\n'
    + '  早退分支，届时本用例应当随之改写——别直接删掉了事，先确认分叉风险怎么兜。');
});

// 直击根因：同一组事实喂给两个函数，结论必须一致。
// 这条用例的价值不在于两个断言本身，而在于它把「入口放行、出口拦住」这个不对称本身钉成红灯。
test('同一组事实下，入口与出口的判定必须一致', () => {
  const facts = { tailEntrypoint: 'sdk-ts', lastChainTs: Date.now(), now: Date.now() };
  const entryLocks = mirrorEntryLock({ ...facts, tailVerdict: 'pending', localBusy: false });
  const releaseKeeps = runTicks({ ...facts, tailPending: true }, { ticks: 30 });
  assert.equal(entryLocks, false, '入口：sdk-ts 的 pending 不建立锁');
  assert.equal(releaseKeeps, false,
    `入口判「不该锁」(${entryLocks})，出口却判「继续锁」——同一个事实两个结论，正是本文件要防的那一类。`);
});

// ══════════════════════════════════════════════════════════════════════════════
// ② 自动闸：防下一个证据又只加一边
// ══════════════════════════════════════════════════════════════════════════════
//
// 【为什么带自动发现】只钉住 tailEntrypoint 这一个键，防不住下一个。下面第二条断言扫出两个
// 函数的全部参数名，任何没登记的新键都会红——强制作者当场回答「这算不算驾驶方证据、
// 要不要两边都加」，而不是等某天走到只有一边能判断的分支时才由用户在手机上撞出来。

/** 从源码里抠出某个 export function 的解构参数名集合。 */
function evidenceKeysOf(fnName) {
  const src = readFileSync(join(ROOT, 'app/src/sessions/history.js'), 'utf8');
  const start = src.indexOf(`export function ${fnName}(`);
  assert.notEqual(start, -1, `history.js 里找不到 export function ${fnName}——函数改名了就同步改这里`);
  const sig = src.slice(start, src.indexOf('{\n', src.indexOf(') {', start)) + 1);
  const keys = new Set();
  for (const m of sig.matchAll(/([A-Za-z_$][\w$]*)\s*(?:=[^,}]*)?[,}]/g)) keys.add(m[1]);
  return keys;
}

// 「谁在驾驶」类证据：凡是能回答这个问题的信号，锁的建立与释放两侧都必须看得到。
// 少一边 ⇒ 一侧能认出「这不是终端」而另一侧认不出 ⇒ 锁建立不了但也释放不掉（或反之）。
const DRIVER_EVIDENCE = {
  tailEntrypoint: '链尾那条记录自报的写入方（cli / sdk-ts）——2026-09-02 死锁就是出口缺了它',
  registryBusy: 'CLI 进程注册表权威自报在跑（pid 已验活）',
};

test('「谁在驾驶」类证据，锁的建立与释放两侧都必须看得到', () => {
  const entry = evidenceKeysOf('mirrorEntryLock');
  const release = evidenceKeysOf('mirrorReleaseStep');
  const missing = [];
  for (const [key, why] of Object.entries(DRIVER_EVIDENCE)) {
    if (!entry.has(key)) missing.push(`mirrorEntryLock 缺 ${key}（${why}）`);
    if (!release.has(key)) missing.push(`mirrorReleaseStep 缺 ${key}（${why}）`);
  }
  assert.deepEqual(missing, [],
    '驾驶方证据必须对称。一侧认得出「这不是终端」而另一侧认不出，就会出现\n'
    + '  「入口不建立锁、出口不释放锁」这种自锁闭环（2026-09-02 真机症状）。');
});

// 已登记的参数：新增一个就必须在这里补一行，顺带回答它算不算驾驶方证据。
// 值 = 这个键为什么只在一侧 / 或两侧都有的说明。
const KNOWN_KEYS = {
  // 两侧都有
  localBusy: '两侧都有：己方在跑，不能把己方 turn 的形态当外部驱动',
  registryBusy: '两侧都有：注册表权威自报（DRIVER_EVIDENCE）',
  tailEntrypoint: '两侧都有：链尾自报写入方（DRIVER_EVIDENCE）',
  // 仅入口——都是「切入这一刻」才有意义的量
  tailVerdict: '仅入口：与出口的 tailPending 同源，只是入口拿到的是三态 verdict 字符串',
  lastChainTs: '仅入口：陈旧 pending 豁免的时间戳；出口侧由 quietTicks 累计承担同样职责',
  now: '仅入口：配合 lastChainTs 算陈旧度，非独立证据',
  prevReadonly: '仅入口：出口的「上一刻是否锁着」直接读 state.readonly，不需要参数',
  // 仅出口——都是「持续观察」才产生的量，切入那一刻不存在
  tailPending: '仅出口：与入口的 tailVerdict 同源',
  externalWrite: '仅出口：本 tick 观测到外部落定新文本消息，需要与上一 tick 对比才有',
  keepAlive: '仅出口：transcript 比上 tick 大，同样需要两个 tick 才比得出来',
  releaseTicks: '仅出口：机制参数（静默阈值），不是证据',
  state: '仅出口：位置参数，承载 readonly/quietTicks',
};

test('两个判定函数的参数全部已登记（新增证据必须当场表态）', () => {
  const all = new Set([...evidenceKeysOf('mirrorEntryLock'), ...evidenceKeysOf('mirrorReleaseStep')]);
  const unregistered = [...all].filter(k => !(k in KNOWN_KEYS)).sort();
  assert.deepEqual(unregistered, [],
    '在本文件 KNOWN_KEYS 里给每个新参数写一行：它算不算「谁在驾驶」类证据？\n'
    + '  算 ⇒ 同时加进 DRIVER_EVIDENCE，并确保两个函数都收它；\n'
    + '  不算 ⇒ 写明它为什么只在一侧有意义。');

  // 反向：登记了却已不存在的键 = 过期的闸，删掉免得给人虚假安全感（同 cross-side-parity 的做法）
  const stale = Object.keys(KNOWN_KEYS).filter(k => !all.has(k)).sort();
  assert.deepEqual(stale, [], `KNOWN_KEYS 登记了但两个函数都不再收的参数：${stale.join(', ')}`);
});
