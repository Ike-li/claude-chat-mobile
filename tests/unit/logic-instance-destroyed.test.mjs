// tests/unit/logic-instance-destroyed.test.mjs —— 点停止顿一下直接跳主页（回归修复）的纯逻辑单测。
// 覆盖 wasViewingInstanceDestroyed / resolveEmptySurface 的 instanceDestroyed 接线（见 app/public/js/logic.js
// 对应函数注释）。同域拆分惯例：新行为域另起文件，不往 logic-session.test.mjs 里塞。
//
// 背景：中断失败（不限时超时——任何原因 SDK interrupt() reject 都会走 agent.js settleForce 强杀子进程）
// → 子进程退出 → onExit → 该 instanceId 从 agents Map 删除、且无同 cwd 存活实例可回退
// （app/src/server/instance-routing.js reselectViewingTarget 默认 allowCrossWorkspace=false）→
// viewingInstanceId 广播为 null。前端旧逻辑把"viewingInstanceId 变 null"一律当"该显示空表面
// (home/compose)"处理，导致用户刚点停止就被静默弹回主页。
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectServerRestart, resolveEmptySurface, wasViewingInstanceDestroyed } from '../../app/public/js/logic.js';

test('wasViewingInstanceDestroyed: 实例真的被摧毁（曾在列表、现从列表消失、newViewing 变 null）→ 命中', () => {
  const prevIds = new Set(['inst_1']);
  const currIds = new Set(); // inst_1 已从列表消失（onExit 强杀后无同 cwd 存活实例可回退）
  assert.equal(wasViewingInstanceDestroyed({
    prevViewingInstanceId: 'inst_1', newViewingInstanceId: null, prevIds, currIds,
  }), true);
});

// 反向场景（最容易误伤的地方）：用户主动返回主页 / 新建会话——原实例仍在 instances 列表里
// （只是不再被查看，未被摧毁），即使 newViewing 同样变 null，也不该命中。
test('wasViewingInstanceDestroyed: 用户主动返回主页/新建会话——旧实例仍在列表里 → 不命中', () => {
  const prevIds = new Set(['inst_1']);
  const currIds = new Set(['inst_1']); // 该实例仍然存活，只是 viewingInstanceId 被清空
  assert.equal(wasViewingInstanceDestroyed({
    prevViewingInstanceId: 'inst_1', newViewingInstanceId: null, prevIds, currIds,
  }), false);
});

// 反向场景：用户主动切到其他存活会话——newViewing 是另一个非 null 的 id，不应命中
// （哪怕旧实例恰好同时也从列表消失，例如 externalDirty/setEffort 触发的同会话置换）。
test('wasViewingInstanceDestroyed: 用户主动切到其他存活会话（newViewing 非 null）→ 不命中', () => {
  const prevIds = new Set(['inst_1']);
  assert.equal(wasViewingInstanceDestroyed({
    prevViewingInstanceId: 'inst_1', newViewingInstanceId: 'inst_2', prevIds, currIds: new Set(['inst_1', 'inst_2']),
  }), false);
  assert.equal(wasViewingInstanceDestroyed({
    prevViewingInstanceId: 'inst_1', newViewingInstanceId: 'inst_2', prevIds, currIds: new Set(['inst_2']),
  }), false);
});

// 本来就没有正在查看的实例（真空首页）：没什么好判的，恒不命中。
test('wasViewingInstanceDestroyed: 本来就没有正在查看的实例 → 不命中', () => {
  assert.equal(wasViewingInstanceDestroyed({
    prevViewingInstanceId: null, newViewingInstanceId: null, prevIds: new Set(), currIds: new Set(),
  }), false);
  assert.equal(wasViewingInstanceDestroyed({}), false);
});

// 防御性分支：prevViewingInstanceId 声称"之前在看"但压根不在 prevIds 快照里（不应该发生，但
// 输入不一致时须安全回落 false，不能凭空报"被摧毁"）。
test('wasViewingInstanceDestroyed: prevViewingInstanceId 不在 prevIds 快照里（防御性）→ 不命中', () => {
  assert.equal(wasViewingInstanceDestroyed({
    prevViewingInstanceId: 'inst_ghost', newViewingInstanceId: null, prevIds: new Set(['inst_1']), currIds: new Set(['inst_1']),
  }), false);
});

// 用户显式关闭当前正在查看的唯一会话（抽屉「关闭」/侧滑 ✕）：无其它存活实例可回退时，服务端
// disposeInstance 同样会让 viewingInstanceId 变 null 且该实例从列表消失——广播形态与「被摧毁」
// 完全相同，但这是用户自己确认过的主动操作，不该被误判成"意外中断"。调用方在关闭动作发生时
// 记录 explicitCloseInstanceId，供本函数排除；不匹配（关的是别的实例）时不受影响。
test('wasViewingInstanceDestroyed: explicitCloseInstanceId 命中同一实例——用户主动关闭正在看的会话 → 不命中', () => {
  const prevIds = new Set(['inst_1']);
  const currIds = new Set();
  assert.equal(wasViewingInstanceDestroyed({
    prevViewingInstanceId: 'inst_1', newViewingInstanceId: null, prevIds, currIds,
    explicitCloseInstanceId: 'inst_1',
  }), false);
  assert.equal(wasViewingInstanceDestroyed({
    prevViewingInstanceId: 'inst_1', newViewingInstanceId: null, prevIds, currIds,
    explicitCloseInstanceId: 'inst_other',
  }), true);
});

// server 重启检测（「server 重启都会跳'会话已中断'页」误判修复）：整机重启时 agents Map/viewingInstanceId
// 全部归零，重连后首条 instances 广播的形态（正在看的实例从列表消失 + viewing 变 null）与「实例被单独
// 摧毁」完全同构，wasViewingInstanceDestroyed 无法自辨。区分信号 = 广播恒带的 service.startedAt
// （app/src/server/app.js SERVICE_STARTED_AT，进程级常量，重启必变）：前后两条广播的 startedAt 不同 → 重启。
test('detectServerRestart: 前后两条广播 startedAt 都在且不同 → 命中重启', () => {
  assert.equal(detectServerRestart({ prevStartedAt: 1000, newStartedAt: 2000 }), true);
});

test('detectServerRestart: startedAt 相同（同一 server 进程存活）→ 不命中', () => {
  assert.equal(detectServerRestart({ prevStartedAt: 1000, newStartedAt: 1000 }), false);
});

// 首条广播（刚开页无基线）不可判重启——否则冷启动第一条广播就误报。
test('detectServerRestart: 无 prev 基线（首条广播）→ 不命中', () => {
  assert.equal(detectServerRestart({ prevStartedAt: null, newStartedAt: 2000 }), false);
  assert.equal(detectServerRestart({ newStartedAt: 2000 }), false);
});

// 广播缺 service.startedAt（旧服务端 / mock 场景手工构造的 payload 不带 service）→ 保守不判，
// 回落既有 destroyed 行为，不能把缺字段当"变了"。
test('detectServerRestart: 新广播缺 startedAt → 不命中', () => {
  assert.equal(detectServerRestart({ prevStartedAt: 1000, newStartedAt: null }), false);
  assert.equal(detectServerRestart({ prevStartedAt: 1000 }), false);
  assert.equal(detectServerRestart({}), false);
  assert.equal(detectServerRestart(), false);
});

// resolveEmptySurface 接线：instanceDestroyed=true 时应优先于 home/compose/none 判断，返回 'destroyed'。
test("resolveEmptySurface: instanceDestroyed=true → 'destroyed'（优先于 home/compose/none）", () => {
  assert.equal(resolveEmptySurface({ viewingInstanceId: null, sessionId: null, instanceDestroyed: true }), 'destroyed');
  assert.equal(resolveEmptySurface({ viewingInstanceId: null, sessionId: null, composeReady: true, instanceDestroyed: true }), 'destroyed');
  assert.equal(resolveEmptySurface({ viewingInstanceId: 'inst_1', sessionId: 'abc', instanceDestroyed: true }), 'destroyed');
  // 默认值 / false：既有行为不变
  assert.equal(resolveEmptySurface({ viewingInstanceId: null, sessionId: null, instanceDestroyed: false }), 'home');
  assert.equal(resolveEmptySurface({ viewingInstanceId: null, sessionId: null }), 'home');
});

// live 豁免（2026-07-30 真机 bc29ccc2）：web 发起 /code-review max，CLI 因第三方网关故障 31 分钟没吐
// system/init——实例活着、轮次在跑、事件在实时流，但还没有 sessionId。旧判据 `!sessionId → 空首页`
// 把它判成「没有会话可显示」，bindView 当场 showDashboard() 就 return，压根走不到 sync:since，
// 于是服务端环形缓冲里那 31 分钟的内容一条都到不了屏幕上（用户看到的是空首页叠着实时告警条）。
// 「实例在跑」是比「有没有 sessionId」更贴近用户认知的判据：正在跑就说明有东西可看。
test("resolveEmptySurface: 无 sessionId 但实例在跑(live) → 'none'（不落空首页，让 bindView 继续走会话流）", () => {
  assert.equal(resolveEmptySurface({ viewingInstanceId: 'inst_1', sessionId: null, live: true }), 'none');
  // composeReady 也不得把它拽回 compose——正在跑的实例优先于「点了 ＋ 想新建」的意图
  assert.equal(resolveEmptySurface({ viewingInstanceId: 'inst_1', sessionId: null, composeReady: true, live: true }), 'none');
});
test("resolveEmptySurface: live 需要 viewingInstanceId 兜底（没有实例可看时仍落 home）", () => {
  assert.equal(resolveEmptySurface({ viewingInstanceId: null, sessionId: null, live: true }), 'home');
});
test("resolveEmptySurface: instanceDestroyed 仍优先于 live（被摧毁要用户确认，不能被当成在跑）", () => {
  assert.equal(resolveEmptySurface({ viewingInstanceId: 'inst_1', sessionId: null, live: true, instanceDestroyed: true }), 'destroyed');
});
test("resolveEmptySurface: live 缺省 false → 无 sessionId 仍落 home（不连坐既有行为）", () => {
  assert.equal(resolveEmptySurface({ viewingInstanceId: 'inst_1', sessionId: null }), 'home');
  assert.equal(resolveEmptySurface({ viewingInstanceId: 'inst_1', sessionId: null, composeReady: true }), 'compose');
});
