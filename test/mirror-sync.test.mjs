// test/mirror-sync.test.mjs —— 同步主线 code-review 发现的【红灯/待修】测试。
//
// ⚠️ 本文件里的 RED 用例【当前故意失败】，用来把两个 review 发现钉成可复现的红灯，作为"实现前 review 关口"。
//    确认修复方向后再最小实现让它们转绿；在此之前它们会让 test:unit 变红（预期内）。
//    每个 RED 用例都把"内置的设计假设"写在注释里——那正是需要你拍板的分叉点。
//
// 用 namespace import：mirrorReleaseStep 尚未导出，具名 import 会在 ESM 链接期整文件报错；
// namespace 下未导出成员是 undefined，调用即在【单个】用例里失败，不连累同文件其余用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../history.js';

// 与 history.test.mjs 同款消息构造器（那边是文件内局部、未导出，这里重定义）。
const M = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));

// ══════════════════════════════════════════════════════════════════════════════
// 发现 2：catchUpStep 的 busy→idle「吸收」会静默吞掉撞进本地 turn 窗口的外部写入。
// ──────────────────────────────────────────────────────────────────────────────
// 决策（见对话）：【记为已知边界，不修】。触发面窄（用户须停留不切走 + 恰好在自己 turn 运行期间终端并发写
//   同一会话），切走时前端 diskLen 重载（logic.js shouldReloadOnEnter）能兜住大部分；稳健修复（server 传
//   ownDelta 计数 / 内容比对）代价不划算、易 off-by-N 反造重复。已在 history.js catchUpStep 注释标注该边界。
// 下面这条 RED 用 skip 保留，作为「已知边界」的活文档：若将来有人想修，取消 skip 即得复现基线。
// 「整段吸收是有意契约」的正向护栏已由 history.test.mjs 的
//   'catchUpStep: busy→idle → 吸收己方 turn 写盘（重置 baseline、不推）' 覆盖（改坏即红）。

test.skip('发现2 已知边界（不修）：外部写入撞进本地 turn 的 busy→idle 吸收窗口 → 被吞、停留期间不回显', () => {
  // 复现基线（想修时取消 skip）：turn 前 baseline=2；本地 turn 自写 2 条(m2,m3)；同窗口终端外部写 1 条(m4)。
  // busy→idle 那一 tick，catchUpStep 走 wasBusy 分支整段吸收 → emit []、baseline=5；外部的 m4 停留期间不回显，
  // 须切走该会话经前端 diskLen 重载才追平。若未来实现区分己方/外部（ownDelta / 内容比对），此处应能追平 m4。
  const r = H.catchUpStep({ baseline: 2, wasBusy: true }, { messages: M(5), localBusy: false });
  assert.deepEqual(r.emit.map(m => m.content), ['m4'], '想修时的靶心：外部 m4 应追平（现状 emit [] = 已知边界）');
});

// ══════════════════════════════════════════════════════════════════════════════
// 发现 1：只读镜像锁没有任何自动释放路径 —— 一次外部写入把移动端输入锁死到手动切会话/接管为止。
// ──────────────────────────────────────────────────────────────────────────────
// 现状：setMirror(true)（server.js:763）只在观测到外部写入时上锁；setMirror(false) 仅在
//   "无查看会话"(740) 和"切了会话"(750) 触发。锁上后若无【新的】外部增长，catchUpTick 在
//   `if (!emit.length ...) return`（758）提前返回，永不解锁 → 终端静默 10 分钟锁仍在。
// 提议：抽纯函数 mirrorReleaseStep(state, {externalWrite, localBusy}) → {readonly, state}，
//   state 记 quietTicks；外部写入→上锁+清零；web idle 且连续 QUIET 个 tick 无外部写入→自动解锁。
// ❗ 待你拍板的分叉（安全权衡）：
//    · 要不要自动解锁？"终端静默 N tick"≠"终端 turn 已结束"（可能在跑长工具/思考、不落盘）——
//      过早解锁 → 用户与终端并发写同一 JSONL → 会话分叉（正是锁想防的）。
//    · 若自动解锁，阈值 QUIET 取多少 tick（下面暂定 5 tick≈12.5s）供 review；
//    · 或不自动解锁、只改 UX（如横幅显式提示"点此接管"更醒目）——那本发现就降级为设计取舍而非 bug。
//    下面按"自动解锁"方向把期望钉红；若你选"不自动解锁"，删掉本节即可。

test('发现1 RED：终端静默 + web idle 后，只读锁应自动释放（当前实现永不释放）', () => {
  assert.equal(typeof H.mirrorReleaseStep, 'function',
    '待实现：history.js 尚未导出 mirrorReleaseStep（当前只读锁的释放逻辑内联在 catchUpTick、无纯函数、无自动释放）');
  let s = { readonly: false, quietTicks: 0 };
  // 观测到外部写入 → 上锁
  let r = H.mirrorReleaseStep(s, { externalWrite: true, localBusy: false });
  assert.equal(r.readonly, true, '外部写入应上只读锁'); s = r.state;
  // 此后终端静默、web idle：连续若干 tick 后应自动解锁
  for (let i = 0; i < 5; i++) { r = H.mirrorReleaseStep(s, { externalWrite: false, localBusy: false }); s = r.state; }
  assert.equal(r.readonly, false, '终端静默 5 tick 后应自动解锁；现状无任何释放路径 → 永远 true');
});

test('阈值边界钉点（code-review P2）：恰好 QUIET_TICKS-1 个静默 tick 仍应保持只读，不早不晚', () => {
  // 此前只测了 tick=1（远未到阈值）和 tick=5（达阈值），漏了阈值前一步这个最容易被 < / <= 改错的边界。
  assert.equal(typeof H.MIRROR_RELEASE_QUIET_TICKS, 'number');
  let s = { readonly: false, quietTicks: 0 };
  let r = H.mirrorReleaseStep(s, { externalWrite: true, localBusy: false }); s = r.state; // 上锁
  for (let i = 0; i < H.MIRROR_RELEASE_QUIET_TICKS - 1; i++) {
    r = H.mirrorReleaseStep(s, { externalWrite: false, localBusy: false }); s = r.state;
  }
  assert.equal(r.readonly, true, `恰好 ${H.MIRROR_RELEASE_QUIET_TICKS - 1} 个静默 tick（阈值前一步）仍应保持只读`);
});

test('发现1 RED：静默未达阈值前不得提前解锁（防并发写分叉）', () => {
  assert.equal(typeof H.mirrorReleaseStep, 'function', '待实现：mirrorReleaseStep');
  let s = { readonly: false, quietTicks: 0 };
  let r = H.mirrorReleaseStep(s, { externalWrite: true, localBusy: false }); s = r.state; // 上锁
  // 仅 1 个静默 tick：远未到阈值，必须仍锁（保守，避免终端只是 turn 内短暂停顿就解锁）
  r = H.mirrorReleaseStep(s, { externalWrite: false, localBusy: false });
  assert.equal(r.readonly, true, '单个静默 tick 不足以判定终端已停 → 仍应保持只读');
});

test('发现1 RED：静默期间又见外部写入 → 重新计时（不得因之前攒的静默而马上解锁）', () => {
  assert.equal(typeof H.mirrorReleaseStep, 'function', '待实现：mirrorReleaseStep');
  let s = { readonly: false, quietTicks: 0 };
  let r = H.mirrorReleaseStep(s, { externalWrite: true, localBusy: false }); s = r.state;
  for (let i = 0; i < 4; i++) { r = H.mirrorReleaseStep(s, { externalWrite: false, localBusy: false }); s = r.state; } // 攒 4 个静默
  r = H.mirrorReleaseStep(s, { externalWrite: true, localBusy: false }); s = r.state; // 又来外部写入 → 应清零重计
  assert.equal(r.readonly, true, '仍锁');
  r = H.mirrorReleaseStep(s, { externalWrite: false, localBusy: false });
  assert.equal(r.readonly, true, 'quietTicks 应已被新外部写入清零，不能凭旧的 4 个静默立刻解锁');
});

test('发现1：web 自己在跑 turn(localBusy) → 保持当前锁态、不借己方忙碌攒静默', () => {
  assert.equal(typeof H.mirrorReleaseStep, 'function', '待实现：mirrorReleaseStep');
  let s = { readonly: false, quietTicks: 0 };
  let r = H.mirrorReleaseStep(s, { externalWrite: true, localBusy: false }); s = r.state; // 上锁
  // web 自己忙：终端静默无从判断 → 锁态不变、quietTicks 清零（不能靠己方 turn 把静默攒够而误解锁）
  for (let i = 0; i < 9; i++) { r = H.mirrorReleaseStep(s, { externalWrite: false, localBusy: true }); s = r.state; }
  assert.equal(r.readonly, true, '整段 localBusy 期间应保持只读，不因己方忙碌累计静默而解锁');
  assert.equal(s.quietTicks, 0, 'localBusy 每 tick 清零 quietTicks');
});

test('发现1：未上锁时 idle 不产生锁、quietTicks 恒 0（无终端活动不误锁）', () => {
  assert.equal(typeof H.mirrorReleaseStep, 'function', '待实现：mirrorReleaseStep');
  let s = { readonly: false, quietTicks: 0 };
  for (let i = 0; i < 3; i++) { const r = H.mirrorReleaseStep(s, { externalWrite: false, localBusy: false }); s = r.state; }
  assert.equal(s.readonly, false, '从未观测外部写入 → 不应凭空上锁');
  assert.equal(s.quietTicks, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// 治本：文件增长 keep-alive —— CLI 跑工具/思考期间 transcript 只落 tool_use/tool_result（被
// getSessionHistory 的 text-only 过滤挡掉、不进 len），catchUpStep 判「无外部写入」→ 原实现会误累计静默、
// 12.5s 熄横幅（即便终端明明在密集干活）。keepAlive（transcript 文件仍在增长=终端在写盘）在【已锁】时维持锁、
// 不累计静默；但【不上锁】——上锁仍只靠 externalWrite（text 新消息）强判据，故未锁时文件增长不凭空造锁
// （避免把 web 自己 resume 进程的写盘误判成终端锁，这是本项目刻意规避 mtime 判活的老坑，风险降一档：只延缓解锁）。
// 优先级：externalWrite（上锁）> localBusy（保持）> 未锁（不上锁）> keepAlive（已锁则维持）> 静默累计。

test('keepAlive：已锁 + 文件持续增长（终端跑工具、无 text 新消息）→ 维持锁、不累计静默、绝不误解锁', () => {
  assert.equal(typeof H.mirrorReleaseStep, 'function', '待实现：mirrorReleaseStep');
  let s = { readonly: false, quietTicks: 0 };
  let r = H.mirrorReleaseStep(s, { externalWrite: true, localBusy: false }); s = r.state; // text 写入上锁
  // 此后 12 tick 均无 text 新消息(externalWrite=false)，但文件在长(keepAlive=true)=终端在跑工具/思考
  for (let i = 0; i < 12; i++) { r = H.mirrorReleaseStep(s, { externalWrite: false, keepAlive: true, localBusy: false }); s = r.state; }
  assert.equal(r.readonly, true, 'keepAlive 期间终端仍在写盘 → 横幅应维持，绝不因静默累计而熄');
  assert.equal(s.quietTicks, 0, 'keepAlive 每 tick 把 quietTicks 清零');
});

test('keepAlive：未上锁时文件增长不上锁（上锁只靠 text externalWrite，不误判 web 自身写盘）', () => {
  assert.equal(typeof H.mirrorReleaseStep, 'function', '待实现：mirrorReleaseStep');
  let s = { readonly: false, quietTicks: 0 };
  for (let i = 0; i < 8; i++) { const r = H.mirrorReleaseStep(s, { externalWrite: false, keepAlive: true, localBusy: false }); s = r.state; }
  assert.equal(s.readonly, false, '从未 text 写入 → 即便文件在长也不上锁');
});

test('keepAlive：终端「跑工具」转「真静默」→ keepAlive 停止后连续 5 静默 tick 才自动解锁', () => {
  assert.equal(typeof H.mirrorReleaseStep, 'function', '待实现：mirrorReleaseStep');
  let s = { readonly: false, quietTicks: 0 };
  let r = H.mirrorReleaseStep(s, { externalWrite: true, localBusy: false }); s = r.state; // 上锁
  for (let i = 0; i < 6; i++) { r = H.mirrorReleaseStep(s, { externalWrite: false, keepAlive: true, localBusy: false }); s = r.state; } // 跑工具中
  assert.equal(r.readonly, true, '跑工具期间(文件在长)仍锁');
  for (let i = 0; i < 4; i++) { r = H.mirrorReleaseStep(s, { externalWrite: false, keepAlive: false, localBusy: false }); s = r.state; } // 终端真停、文件不再长
  assert.equal(r.readonly, true, '真静默 4 tick 未达阈值 → 仍锁');
  r = H.mirrorReleaseStep(s, { externalWrite: false, keepAlive: false, localBusy: false });
  assert.equal(r.readonly, false, '真静默满 5 tick → 自动解锁');
});
