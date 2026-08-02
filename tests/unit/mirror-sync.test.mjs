// tests/unit/mirror-sync.test.mjs —— 同步主线 code-review 发现的【红灯/待修】测试。
//
// ⚠️ 本文件里的 RED 用例【当前故意失败】，用来把两个 review 发现钉成可复现的红灯，作为"实现前 review 关口"。
//    确认修复方向后再最小实现让它们转绿；在此之前它们会让 test:unit 变红（预期内）。
//    每个 RED 用例都把"内置的设计假设"写在注释里——那正是需要你拍板的分叉点。
//
// 用 namespace import：mirrorReleaseStep 尚未导出，具名 import 会在 ESM 链接期整文件报错；
// namespace 下未导出成员是 undefined，调用即在【单个】用例里失败，不连累同文件其余用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../../src/sessions/history.js';

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

// ══════════════════════════════════════════════════════════════════════════════
// 尾部形态 tailPending（2026-07-12 单驾驶员模型）：keepAlive 罩不住的场景——终端在跑一个【长时间零写盘】
// 的工具调用（深度搜索/长编译，一条 bash 跑几分钟），期间文件完全不增长（keepAlive=false）、更无 text
// （externalWrite=false）→ 原实现 12.5s 静默窗误判解锁、横幅熄灭，用户体感「感觉没东西在跑」（真实报障）。
// classifyTranscriptTail 从磁盘尾部形态读出「轮次未完结」（tool_use 落了结果没落 / user 落了回复没落）→
// tailPending=true 与 keepAlive 同权重：已锁维持、quietTicks 清零；未锁不上锁（形态判定万一失误也不锁死
// 输入，上锁仍只靠 externalWrite 强判据 + catchUpTick 切入预判）。两判据互补：keepAlive 罩 settled 误判窗
// （assistant 中途 text 落盘紧跟 tool_use 的落盘间隙），tailPending 罩长工具零写入窗。

test('tailPending：已锁 + 长工具调用零写入（文件不长、无 text）→ 维持锁、绝不因静默累计误解锁', () => {
  assert.equal(typeof H.mirrorReleaseStep, 'function', '待实现：mirrorReleaseStep');
  let s = { readonly: false, quietTicks: 0 };
  let r = H.mirrorReleaseStep(s, { externalWrite: true, localBusy: false }); s = r.state; // text 写入上锁
  // 此后 12 tick(30s)：终端卡在一条长 bash 上，磁盘零写入——keepAlive=false、externalWrite=false，
  // 但尾部形态=tool_use 未见结果 → tailPending=true。原实现第 5 tick 就误解锁（用户报的 bug）。
  for (let i = 0; i < 12; i++) { r = H.mirrorReleaseStep(s, { externalWrite: false, keepAlive: false, tailPending: true, localBusy: false }); s = r.state; }
  assert.equal(r.readonly, true, '尾部形态=轮次未完结 → 不管磁盘静默多久都维持锁');
  assert.equal(s.quietTicks, 0, 'tailPending 每 tick 把 quietTicks 清零');
});

test('tailPending：未上锁时不凭空造锁（上锁只靠 externalWrite / 切入预判，形态误判不锁死输入）', () => {
  assert.equal(typeof H.mirrorReleaseStep, 'function', '待实现：mirrorReleaseStep');
  let s = { readonly: false, quietTicks: 0 };
  for (let i = 0; i < 8; i++) { const r = H.mirrorReleaseStep(s, { externalWrite: false, keepAlive: false, tailPending: true, localBusy: false }); s = r.state; }
  assert.equal(s.readonly, false, '未锁 + tailPending → 保持未锁');
});

test('tailPending：轮次收尾（pending→settled）后走原静默解锁——连续 5 静默 tick 才解', () => {
  assert.equal(typeof H.mirrorReleaseStep, 'function', '待实现：mirrorReleaseStep');
  let s = { readonly: false, quietTicks: 0 };
  let r = H.mirrorReleaseStep(s, { externalWrite: true, localBusy: false }); s = r.state;      // 上锁
  for (let i = 0; i < 8; i++) { r = H.mirrorReleaseStep(s, { externalWrite: false, tailPending: true, localBusy: false }); s = r.state; } // 长工具中
  assert.equal(r.readonly, true);
  for (let i = 0; i < 4; i++) { r = H.mirrorReleaseStep(s, { externalWrite: false, tailPending: false, localBusy: false }); s = r.state; } // 收尾且真静默
  assert.equal(r.readonly, true, 'settled 后静默 4 tick 未达阈值 → 仍锁');
  r = H.mirrorReleaseStep(s, { externalWrite: false, tailPending: false, localBusy: false });
  assert.equal(r.readonly, false, 'settled 后真静默满 5 tick → 解锁');
});

// ══════════════════════════════════════════════════════════════════════════════
// 切入预锁 + stale 判定（catchUpTick 接线用的两个决策纯函数）：
// · mirrorEntryLock——切入会话瞬间按尾部形态预判：PENDING=有人正驱动 → 立即预锁，堵「切走再切回、
//   终端还在跑但要等下一条 text 落盘才锁」的空窗。旧行为「切入不预锁」是因为 mtime 判活不可信；
//   尾部形态是语义判据、可信。localBusy（web 自己在跑，尾部 PENDING 是己方 turn 的形态）豁免。
// · mirrorStaleFlag——锁着 + 尾部 PENDING + 最后链条目距今超阈值（零写入）→ 疑似终端被强杀/断电、
//   轮次没写完就死了：前端从「终端驾驶中」转「疑似中断、可接管」文案。仅在锁态下才有意义。

test('mirrorEntryLock：切入时尾部 pending 且 web 空闲 → 预锁；settled / 己方在跑 → 不锁', () => {
  assert.equal(typeof H.mirrorEntryLock, 'function', '待实现：mirrorEntryLock');
  assert.equal(H.mirrorEntryLock({ tailVerdict: 'pending', localBusy: false }), true, '外部驱动中 → 预锁');
  assert.equal(H.mirrorEntryLock({ tailVerdict: 'settled', localBusy: false }), false, '已收尾 → 不锁');
  assert.equal(H.mirrorEntryLock({ tailVerdict: 'pending', localBusy: true }), false, '己方 turn 的 pending 形态 → 不误锁');
});

test('mirrorEntryLock：陈旧 pending（lastChainTs 超 5 分钟）→ 切入不预锁（修每次重启/打开都弹接管横幅）', () => {
  // 真机：Official 工作区尾部是用户发完就走的骂人消息（~16h 前），形态 pending 但无活终端。
  // 旧实现预锁 + stale → 每次 server 重启 / 切入都弹「疑似中断、可接管」。
  const now = 1_800_000_000_000;
  const over = now - H.MIRROR_STALE_PENDING_MS - 1;
  const under = now - H.MIRROR_STALE_PENDING_MS + 1000;
  assert.equal(H.mirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: over, now }), false, '陈旧 pending → 不预锁');
  assert.equal(H.mirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: under, now }), true, '新鲜 pending → 仍预锁（可能是长工具）');
  assert.equal(H.mirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: null, now }), true, '无时间戳 → 保守预锁（形态仍 pending）');
});

// 2026-07-29：陈旧 pending 豁免撞上「重连必重评」= 长回合期间一次网络抖动就永久丢锁。
// 链路：手机息屏/断网/刷新 → socket 重连 → server 置 catchUpRebaselineRequested → 下一 tick
// catchUpKey=null → 复用【切入分支】重评 mirrorEntryLock。终端此刻正卡在一条超过 5 分钟的长工具上
// （形态 pending、主链零写入，本来靠 mirrorReleaseStep 的 tailPending 维持锁），重评撞上陈旧豁免
// 返回 false，切入分支又是 force 强推 → 锁被清掉；而 mirrorReleaseStep 里 tailPending 只能【维持】
// 锁造不出锁（`if (!prevReadonly) return false` 排在它前面）→ 锁再也回不来，直到终端落下一条 text。
// 豁免的本意是「隔天打开一个早就没人管的会话别误锁」；prevReadonly=true 说明是同一会话的连续观察、
// 上一刻还锁着，那就不是"隔天打开"，应当维持。stale 文案照旧由 mirrorStaleFlag 给（锁着但提示可接管）。
test('mirrorEntryLock：同会话重连重评时 prevReadonly 维持已有锁，不被陈旧 pending 豁免清掉', () => {
  const now = 1_800_000_000_000;
  const over = now - H.MIRROR_STALE_PENDING_MS - 1;
  assert.equal(
    H.mirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: over, now, prevReadonly: true }),
    true, '上一刻锁着 + 形态仍 pending → 维持锁（长工具跨过 5 分钟不该丢锁）');
  assert.equal(
    H.mirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: over, now, prevReadonly: false }),
    false, '真会话切换（无前序锁）→ 陈旧豁免照旧生效，不误锁');
  assert.equal(
    H.mirrorEntryLock({ tailVerdict: 'settled', localBusy: false, lastChainTs: over, now, prevReadonly: true }),
    false, '形态已收尾 → 即便上一刻锁着也不维持（终端真收工了，交回写权）');
  assert.equal(
    H.mirrorEntryLock({ tailVerdict: 'pending', localBusy: true, lastChainTs: over, now, prevReadonly: true }),
    false, 'localBusy 豁免优先级不变：己方 turn 的 pending 形态不算外部驾驶');
});

test('mirrorStaleFlag：锁定 + pending + 零写入超 5 分钟 → stale；未超/未锁/已收尾/无时间戳 → 非 stale', () => {
  assert.equal(typeof H.mirrorStaleFlag, 'function', '待实现：mirrorStaleFlag');
  assert.equal(typeof H.MIRROR_STALE_PENDING_MS, 'number');
  const now = 1_800_000_000_000;
  const over = now - H.MIRROR_STALE_PENDING_MS - 1, under = now - H.MIRROR_STALE_PENDING_MS + 1000;
  assert.equal(H.mirrorStaleFlag({ readonly: true, tailPending: true, lastChainTs: over, now }), true, '超阈值 → 疑似中断');
  assert.equal(H.mirrorStaleFlag({ readonly: true, tailPending: true, lastChainTs: under, now }), false, '未超阈值 → 仍算驾驶中');
  assert.equal(H.mirrorStaleFlag({ readonly: false, tailPending: true, lastChainTs: over, now }), false, '未锁 → stale 无意义');
  assert.equal(H.mirrorStaleFlag({ readonly: true, tailPending: false, lastChainTs: over, now }), false, '已收尾 → 非中断');
  assert.equal(H.mirrorStaleFlag({ readonly: true, tailPending: true, lastChainTs: null, now }), false, '无时间戳 → 保守非 stale');
});

test('mirrorStaleFlag：cli 注册表负证据（曾在→消失）→ 立即 stale 不等 5 分钟；registryBusy 仍压制', () => {
  // 2026-07-28 真机 b06fb05d：用户杀掉 CLI 后 web 点续接，排队卡在「等终端当前操作完成」——
  // 尾部 pending 与「长工具零写盘」形态相同，唯一能提前区分的是注册表负证据（条目曾在→消失）。
  const now = 1_800_000_000_000;
  const under = now - 60_000; // 仅 1 分钟前，远未到 5 分钟阈值
  assert.equal(H.mirrorStaleFlag({ readonly: true, tailPending: true, lastChainTs: under, now, cliRegistryVanished: true }), true, '负证据 → 立即 stale');
  assert.equal(H.mirrorStaleFlag({ readonly: true, tailPending: true, lastChainTs: under, now, cliRegistryVanished: false }), false, '无负证据 → 维持 5 分钟保守窗');
  // 终端关了又开新进程（busy 新鲜自报）→ 活驾驶员优先于历史负证据
  assert.equal(H.mirrorStaleFlag({ readonly: true, tailPending: true, lastChainTs: under, now, cliRegistryVanished: true, registryBusy: true }), false, '新活终端压制');
  assert.equal(H.mirrorStaleFlag({ readonly: false, tailPending: true, lastChainTs: under, now, cliRegistryVanished: true }), false, '未锁 → 无意义');
  assert.equal(H.mirrorStaleFlag({ readonly: true, tailPending: false, lastChainTs: under, now, cliRegistryVanished: true }), false, '已收尾 → 非中断');
});

// describeMirrorEntryLock：诊断时间线用——只打包 catchUpTickOnce 已经算出的 mirrorEntryLock 判定
// 供诊断记录展示，不重复判定逻辑本身（locked 由调用方传入，这里只加一个 agedOutStale 派生字段）。
test('describeMirrorEntryLock：打包判定详情 + agedOutStale 派生字段（不重复判定逻辑）', () => {
  assert.equal(typeof H.describeMirrorEntryLock, 'function', '待实现：describeMirrorEntryLock');
  const now = 1_800_000_000_000;
  const over = now - H.MIRROR_STALE_PENDING_MS - 1;
  const under = now - H.MIRROR_STALE_PENDING_MS + 1000;

  assert.deepEqual(
    H.describeMirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: under, now, locked: true }),
    { tailVerdict: 'pending', localBusy: false, lastChainTs: under, agedOutStale: false, staleThresholdMs: H.MIRROR_STALE_PENDING_MS, locked: true, autonomous: false, registryBusy: false, prevReadonly: false, tailEntrypoint: null },
    '新鲜 pending 且已锁 → agedOutStale=false',
  );

  assert.deepEqual(
    H.describeMirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: over, now, locked: false }),
    { tailVerdict: 'pending', localBusy: false, lastChainTs: over, agedOutStale: true, staleThresholdMs: H.MIRROR_STALE_PENDING_MS, locked: false, autonomous: false, registryBusy: false, prevReadonly: false, tailEntrypoint: null },
    '陈旧 pending 且未锁 → agedOutStale=true，与 mirrorEntryLock 的不锁判定一致',
  );

  // 同会话重连维持锁的那条路径：agedOutStale=true 却 locked=true，若不记 prevReadonly，
  // 事后读诊断时间线会觉得两个字段自相矛盾、看不出锁是被谁维持的。
  assert.deepEqual(
    H.describeMirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: over, now, locked: true, prevReadonly: true }),
    { tailVerdict: 'pending', localBusy: false, lastChainTs: over, agedOutStale: true, staleThresholdMs: H.MIRROR_STALE_PENDING_MS, locked: true, autonomous: false, registryBusy: false, prevReadonly: true, tailEntrypoint: null },
    '陈旧 pending 但同会话重连维持锁 → prevReadonly=true 解释了 locked 与 agedOutStale 并存',
  );

  assert.equal(
    H.describeMirrorEntryLock({ tailVerdict: 'settled', localBusy: false, lastChainTs: null, now, locked: false }).agedOutStale,
    false,
    '无时间戳 → agedOutStale 保守为 false（无法判断"多陈旧"）',
  );
});

// autonomous：单纯透传 classifyTranscriptTail 算出的「尾窗内是否有自主循环 marker」，不重新判定——
// 诊断时间线要能看出"这次锁是自主循环还是真不知道来源"，之前查一次真实卡死花了大量取证时间正因为看不到这个。
test('describeMirrorEntryLock：透传 autonomous（不重新判定，只回显调用方传入值）', () => {
  assert.equal(
    H.describeMirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: null, now: 1_800_000_000_000, locked: true, autonomous: true }).autonomous,
    true,
  );
  assert.equal(
    H.describeMirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: null, now: 1_800_000_000_000, locked: true }).autonomous,
    false,
    '未传 autonomous → 默认 false，不影响既有调用方',
  );
});

// localBusy（web 自己 busy）时 catchUpTick 仍须重算 mirrorStaleFlag，禁止写死 stale=false——
// 否则多子代理长期 localBusy 会掩盖「主链 5 分钟无写入」的疑似中断。此处锁纯函数契约。
test('localBusy 路径仍须能标 stale（readonly+pending+超 5 分钟）', () => {
  const now = 1_000_000;
  const over = now - H.MIRROR_STALE_PENDING_MS - 1;
  assert.equal(
    H.mirrorStaleFlag({ readonly: true, tailPending: true, lastChainTs: over, now }),
    true,
    'web busy 期间若只读锁仍挂着且主链陈旧 pending → 必须 stale=true',
  );
});


// ── P1（7/26 CCD 调研吸收）：注册表自报 registryBusy 并入三个锁判定 ─────────────────
// ~/.claude/sessions/<PID>.json 的 status:"busy"/"shell" 是 CLI 权威自报（见 session-registry.js），
// 比尾部形态猜测强一档：可直接上锁/维持锁/压制 stale。默认 false → 既有调用方零行为变化。

test('mirrorEntryLock：registryBusy=true 时无视尾部形态与陈旧豁免直接预锁（localBusy 仍豁免）', () => {
  const now = 1_800_000_000_000;
  // 尾部 settled（长工具首刻常见形态）也锁——注册表说终端在跑
  assert.equal(H.mirrorEntryLock({ tailVerdict: 'settled', localBusy: false, lastChainTs: null, now, registryBusy: true }), true);
  // 陈旧 pending 豁免被覆盖：注册表自报 + pid 验活已证实终端活着
  const over = now - H.MIRROR_STALE_PENDING_MS - 1;
  assert.equal(H.mirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: over, now, registryBusy: true }), true);
  // web 自己在跑：己方 turn 不因注册表误锁
  assert.equal(H.mirrorEntryLock({ tailVerdict: 'settled', localBusy: true, lastChainTs: null, now, registryBusy: true }), false);
  // 不传 registryBusy → 既有行为不变
  assert.equal(H.mirrorEntryLock({ tailVerdict: 'settled', localBusy: false, lastChainTs: null, now }), false);
});

test('mirrorReleaseStep：registryBusy 可上锁也可维持锁（比 keepAlive/tailPending 强一档）', () => {
  // 未锁 + 注册表 busy → 直接上锁（堵「终端开跑但首条 text 未落盘」窗）
  let r = H.mirrorReleaseStep({ readonly: false, quietTicks: 0 }, { registryBusy: true });
  assert.deepEqual(r, { readonly: true, state: { readonly: true, quietTicks: 0 } });
  // 已锁 + 注册表 busy → 维持锁、静默清零
  r = H.mirrorReleaseStep({ readonly: true, quietTicks: 3 }, { registryBusy: true });
  assert.deepEqual(r, { readonly: true, state: { readonly: true, quietTicks: 0 } });
  // localBusy 优先：己方在跑保持现态，不因注册表上锁
  r = H.mirrorReleaseStep({ readonly: false, quietTicks: 0 }, { registryBusy: true, localBusy: true });
  assert.equal(r.readonly, false);
  // 不传 → 既有行为不变（未锁不造锁）
  r = H.mirrorReleaseStep({ readonly: false, quietTicks: 0 }, { keepAlive: true });
  assert.equal(r.readonly, false);
});

test('mirrorStaleFlag：registryBusy=true 压制"疑似中断"（新鲜自报=终端活着）', () => {
  const now = 1_000_000;
  const over = now - H.MIRROR_STALE_PENDING_MS - 1;
  assert.equal(H.mirrorStaleFlag({ readonly: true, tailPending: true, lastChainTs: over, now, registryBusy: true }), false);
  assert.equal(H.mirrorStaleFlag({ readonly: true, tailPending: true, lastChainTs: over, now }), true, '不传 → 既有 stale 行为不变');
});

// 服务重启腰斩（2026-07-28 真机 b06fb05d）：web 自己的回合跑到一半，server 被重启，SDK 子进程随之
// 被杀——transcript 永远停在 tool_result（形态 pending），但没有任何驾驶员还活着。重启后几十秒内打开
// 该会话时：陈旧豁免（5 分钟）还没生效 → mirrorEntryLock 预锁；registryBusy 只认 entrypoint=cli 的
// status 自报，web 自己的 sdk-ts 条目不背书 → 回落尾部形态 → 横幅说「终端会话运行中」（说谎，终端从没
// 参与过），且 mirrorReleaseStep 的 tailPending 分支使锁永不自动释放。
// 判据：pending 尾部落盘于本 server 进程启动【之前】 + 注册表不背书 ⇒ 这条 pending 不可能是本进程
// 期间的活动产生的 → 直接判 stale，让前端出「可续接」文案与入口，不必干等 5 分钟。
// 锁态刻意不改（仍 readonly）：真终端跑旧版 CLI（不写注册表）时误判的代价只是提前显示接管引导。
test('mirrorStaleFlag：pending 尾部早于本次 server 启动 + 注册表不背书 → 立即 stale（服务重启腰斩）', () => {
  const now = 1_800_000_000_000;
  const serverStartedAt = now - 40_000;           // server 40 秒前启动
  const beforeRestart = serverStartedAt - 14_000; // 末条落盘比启动早 14 秒（真机实测差值）
  const afterRestart = serverStartedAt + 5_000;   // 启动之后才落盘 = 真有人在驾驶
  assert.equal(
    H.mirrorStaleFlag({ readonly: true, tailPending: true, lastChainTs: beforeRestart, now, serverStartedAt }),
    true, '腰斩残留：未超 5 分钟也应判 stale');
  assert.equal(
    H.mirrorStaleFlag({ readonly: true, tailPending: true, lastChainTs: afterRestart, now, serverStartedAt }),
    false, '本进程启动后仍在写 → 真驾驶中，不得误标中断');
  assert.equal(
    H.mirrorStaleFlag({ readonly: true, tailPending: true, lastChainTs: beforeRestart, now, serverStartedAt, registryBusy: true }),
    false, 'registryBusy 权威自报优先：终端确实活着（长工具卡住）→ 压制');
  assert.equal(
    H.mirrorStaleFlag({ readonly: false, tailPending: true, lastChainTs: beforeRestart, now, serverStartedAt }),
    false, '未锁 → stale 无意义（与既有语义一致）');
  assert.equal(
    H.mirrorStaleFlag({ readonly: true, tailPending: true, lastChainTs: beforeRestart, now }),
    false, '不传 serverStartedAt → 既有行为不变（未超阈值不 stale）');
});

test('describeMirrorEntryLock：透传 registryBusy 供诊断时间线回放', () => {
  assert.equal(
    H.describeMirrorEntryLock({ tailVerdict: 'settled', locked: true, registryBusy: true }).registryBusy,
    true,
  );
  assert.equal(H.describeMirrorEntryLock({ tailVerdict: 'pending', locked: true }).registryBusy, false);
});

// ── web 回合失败后「续接」永久卡死（2026-07-30 真机 5ed3eb8c）───────────────────────────────
// 100% web 发起的会话，一条 slash 回合被上游 503 打断：assistant 一条都没落盘，transcript 主链停在
// 光秃秃的 user 文本，错误正文以 { type:'system', subtype:'local_command' } 落盘。于是：
//   · classifyChainTail 只把 type∈{user,assistant} 当链条目 → system 行跳过 → 落到 user 兜底 pending；
//   · 本该救场的两道「本地命令已收尾」豁免都只认 CLI 的落盘形态，对不上 web 的：
//       reconstructSlashCommand 只认 <command-name> 包装，web 发的是裸文本 "/code-review …" → null；
//       hasLocalCommandStdoutAfter 只扫 type==='user' 的条目，这次 stdout 在 type==='system' → false；
//   · pending 恒真 → 切入 mirrorEntryLock 预锁，之后 mirrorReleaseStep 的 tailPending 分支永久维持，
//     没有任何自动解锁路径 → 输入框永远「只读镜像：终端会话运行中」+「续接」（终端从没碰过这个会话）。
// 判据修正：链尾 user 之后若已落 local_command 输出（user 形态或 system 形态皆可）⇒ 该回合已终结
// （正常 slash 输出、或以错误告终），不是「等 assistant 回复」。刻意不再要求文本是 slash——普通消息
// 被 503 打断是完全同构的形态，只认 slash 会漏掉它。settled 的已知误判窗（判 settled 后终端马上又
// 开跑）仍由 keepAlive / registryBusy 两条判据互补罩住，与本函数既有取舍同档。
const LOCAL_CMD_STDOUT = '<local-command-stdout>API Error: 503 Gateway Error: 没有可用的内网节点.</local-command-stdout>';
const webEntry = (over) => ({ isSidechain: false, entrypoint: 'sdk-ts', timestamp: '2026-07-31T03:25:10.930Z', ...over });

test('classifyTailEntries：web 回合被 503 打断（user 裸 slash + system/local_command 输出）→ settled，不当终端驾驶', () => {
  const entries = [
    webEntry({ type: 'user', message: { role: 'user', content: '/code-review max 整个分支代码库，最多同时 3 个子代理' } }),
    webEntry({ type: 'system', subtype: 'local_command', isMeta: false, content: LOCAL_CMD_STDOUT, timestamp: '2026-07-31T03:28:17.905Z' }),
  ];
  assert.equal(H.classifyTailEntries(entries).verdict, 'settled', '回合已以错误告终 → 不得判成「终端轮次未完结」');
});

// 分叉红线（2026-07-30 子代理审查在真实盘上抓到）：本地命令输出只能给【它自己那条 slash】收尾，绝不能
// 给任意一条 user 消息收尾。真实反例 ~/.claude/projects/<另一仓>/f0483015…jsonl idx 877-880：
// 终端用户发了真实请求（"把 CF 优选相关的都去掉…"，entrypoint=cli），assistant 还没回，90 秒后用户又敲了
// 个 /status——于是 idx 879/880 落下 command-name 回显与 stdout。若把「链尾 user 之后有 local_command
// 输出」一律当收尾，这条【正在进行的终端回合】就被判 settled → 镜像不锁 → 手机可写 → 双写分叉。
// 这里 tailEntrypoint 完全救不了：verdict 一旦是 settled，mirrorEntryLock 第三行就短路返回 false，
// 白名单判据根本不参与。故收尾判据必须要求链尾 user 文本【自己就是】那条 slash。
test('classifyTailEntries：终端真实请求未回复 + 期间敲了别的本地命令 → 仍 pending（分叉红线）', () => {
  const cliEntry = (over) => ({ isSidechain: false, entrypoint: 'cli', timestamp: '2026-07-16T00:42:14.086Z', ...over });
  const entries = [
    cliEntry({ type: 'user', message: { role: 'user', content: '把 CF 优选相关的都去掉，只保留项目记忆和历史文档' } }),
    cliEntry({ type: 'system', subtype: 'local_command', content: '<command-name>/status</command-name>', timestamp: '2026-07-16T00:43:40.565Z' }),
    cliEntry({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>Settings dialog dismissed</local-command-stdout>', timestamp: '2026-07-16T00:43:40.565Z' }),
  ];
  assert.equal(H.classifyTailEntries(entries).verdict, 'pending', '终端回合仍在进行 → 必须维持锁，否则双写分叉');
});

test('classifyTailEntries：本地命令的 command-name 回显不算收尾（只有 stdout/stderr 才是输出）', () => {
  const entries = [
    webEntry({ type: 'user', message: { role: 'user', content: '/status' } }),
    webEntry({ type: 'system', subtype: 'local_command', content: '<command-name>/status</command-name>' }),
  ];
  assert.equal(H.classifyTailEntries(entries).verdict, 'pending', '只回显了命令名、输出还没落 → 轮次未完结');
});

// 普通消息（非 slash）被 503 打断：形态与上面的分叉红线【无法区分】，故这里刻意【不】判 settled——
// 该场景由切口 2（tailEntrypoint=sdk-ts 不预锁）兜底，两个判据分工明确，不拿分叉风险换它。
test('classifyTailEntries：普通消息被打断仍 pending（与终端场景无法区分），交给 tailEntrypoint 兜底', () => {
  const entries = [
    webEntry({ type: 'user', message: { role: 'user', content: '你好' } }),
    webEntry({ type: 'system', subtype: 'local_command', isMeta: false, content: LOCAL_CMD_STDOUT }),
  ];
  const r = H.classifyTailEntries(entries);
  assert.equal(r.verdict, 'pending', '不得靠放宽形态判据来修它——那会打穿单驾驶员模型');
  assert.equal(
    H.mirrorEntryLock({ tailVerdict: r.verdict, localBusy: false, lastChainTs: Date.now(), now: Date.now(), tailEntrypoint: r.lastChainEntrypoint }),
    false, '己方 SDK 写下的 pending → 由切口 2 拦住，不预锁');
});

test('classifyTailEntries：user 文本之后【没有】本地命令输出 → 仍 pending（不得放宽成「user 尾一律收尾」）', () => {
  const entries = [webEntry({ type: 'user', message: { role: 'user', content: '你好' } })];
  assert.equal(H.classifyTailEntries(entries).verdict, 'pending', '等 assistant 回复中：这是真 pending，必须保留');
});

test('classifyTailEntries：回传链尾条目自报的 entrypoint（谁写下这条 pending）', () => {
  const cliTail = [webEntry({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: '继续' } })];
  assert.equal(H.classifyTailEntries(cliTail).lastChainEntrypoint, 'cli');
  const sdkTail = [webEntry({ type: 'user', message: { role: 'user', content: '继续' } })];
  assert.equal(H.classifyTailEntries(sdkTail).lastChainEntrypoint, 'sdk-ts');
  assert.equal(H.classifyTailEntries([]).lastChainEntrypoint, null, '无链条目 → null（回落既有判定）');
});

// 纵深防御（切口 2）：即便将来又冒出一种「web 自己写出 pending 尾部」的新形态（切口 1 的形态判据
// 覆盖不到），也不该把它当成「终端在驾驶」而锁死手机输入。判据取磁盘上的硬证据——写下链尾那条
// 记录的进程【自报】的 entrypoint：CLI 写 'cli'，本项目 SDK 写 'sdk-ts'。用白名单只认 sdk-ts：
// 未知/新取值静默退化回既有判定（最坏回到今天的行为，绝不因认错而误放行造成两端并发写分叉）。
// registryBusy 仍然优先（活着的 CLI 自报在跑，压过一切磁盘推断）；localBusy 豁免不变。
test('mirrorEntryLock：pending 尾部由本项目 SDK 自己写下（entrypoint=sdk-ts）→ 不预锁（终端从没参与）', () => {
  const now = 1_800_000_000_000;
  const fresh = now - 10_000; // 新鲜 pending：陈旧豁免够不着，只有本判据能拦
  assert.equal(
    H.mirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: fresh, now, tailEntrypoint: 'sdk-ts' }),
    false, 'sdk-ts 写的 pending = 己方残留，不是终端驾驶');
  assert.equal(
    H.mirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: fresh, now, tailEntrypoint: 'cli' }),
    true, 'CLI 写的 pending → 照旧预锁');
  assert.equal(
    H.mirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: fresh, now }),
    true, '不传 → 既有行为不变');
  assert.equal(
    H.mirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: fresh, now, tailEntrypoint: 'claude-desktop' }),
    true, '白名单外的未知来源 → 保守预锁（宁可误锁不可误放行）');
  assert.equal(
    H.mirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: fresh, now, tailEntrypoint: 'sdk-ts', registryBusy: true }),
    true, 'registryBusy：活着的 CLI 自报在跑 → 压过磁盘推断');
  assert.equal(
    H.mirrorEntryLock({ tailVerdict: 'pending', localBusy: false, lastChainTs: fresh, now, tailEntrypoint: 'sdk-ts', prevReadonly: true }),
    false, '压过 prevReadonly：锁本就不该存在，同会话重连不得把它续下去');
});

test('describeMirrorEntryLock：透传 tailEntrypoint（事后回放能看出「这次没锁是因为尾部是己方写的」）', () => {
  assert.equal(
    H.describeMirrorEntryLock({ tailVerdict: 'pending', locked: false, tailEntrypoint: 'sdk-ts' }).tailEntrypoint,
    'sdk-ts',
  );
  assert.equal(H.describeMirrorEntryLock({ tailVerdict: 'pending', locked: true }).tailEntrypoint, null);
});
