// logic.js 镜像/接管域纯函数单测：只读锁三态文案、点输入区说明、同文案节流、
// mirror_state 归属守卫、切视图清锁、排队接管状态机。
// 自 logic-ui-state.test.mjs 拆出（monolith 行数门 800，见 source-layout.test.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { armedTakeoverStep, formatMirrorBannerText, formatMirrorComposerHint, shouldEmitThrottledHint, acceptMirrorState, shouldResetMirrorOnViewChange } from '../../public/js/logic.js';

// ── armedTakeoverStep：排队接管状态机（接管=等终端本轮完结再放行，纯 web 侧） ──
// armed 期间只有三个出口：本轮完结自动放行(unlock-focus) / 等待中疑似中断自动完成接管(unlock-stale)
// / 切会话撤销(disarm)；其余一律不动作。未 armed 时对任何信号零影响（不干扰现有 onMirrorState 路径）。
test('armedTakeoverStep: 未 armed → 任何信号均 none', () => {
  assert.deepEqual(armedTakeoverStep({ armed: false }, { kind: 'mirror', readonly: false }), { action: 'none' });
  assert.deepEqual(armedTakeoverStep({}, { kind: 'switch' }), { action: 'none' });
  assert.deepEqual(armedTakeoverStep(undefined, undefined), { action: 'none' });
});

test('armedTakeoverStep: armed + readonly=false（终端本轮完结）→ unlock-focus', () => {
  assert.deepEqual(
    armedTakeoverStep({ armed: true, armedSid: 's1' }, { kind: 'mirror', readonly: false }),
    { action: 'unlock-focus' }
  );
});

test('armedTakeoverStep: armed + 仍在驾驶（readonly=true, stale=false）→ none 继续等', () => {
  assert.deepEqual(
    armedTakeoverStep({ armed: true, armedSid: 's1' }, { kind: 'mirror', readonly: true, stale: false, sessionId: 's1' }),
    { action: 'none' }
  );
});

test('armedTakeoverStep: armed + 同会话转疑似中断（stale=true）→ unlock-stale', () => {
  assert.deepEqual(
    armedTakeoverStep({ armed: true, armedSid: 's1' }, { kind: 'mirror', readonly: true, stale: true, sessionId: 's1' }),
    { action: 'unlock-stale' }
  );
});

test('armedTakeoverStep: armed + 他会话 stale → none（不误放行）', () => {
  assert.deepEqual(
    armedTakeoverStep({ armed: true, armedSid: 's1' }, { kind: 'mirror', readonly: true, stale: true, sessionId: 's2' }),
    { action: 'none' }
  );
});

test('armedTakeoverStep: armed + 切会话 → disarm', () => {
  assert.deepEqual(armedTakeoverStep({ armed: true, armedSid: 's1' }, { kind: 'switch' }), { action: 'disarm' });
});

test.describe('formatMirrorBannerText（只读锁横幅三态）', () => {
  test('armed / stale 优先', () => {
    assert.match(formatMirrorBannerText({ armed: true }), /只读镜像.*(已请求续接|等待终端)/);
    assert.match(formatMirrorBannerText({ stale: true }), /只读镜像.*疑似中断/);
  });
  test('driving 默认句：状态短句，无秒数倒计时、无点接管指令', () => {
    const t = formatMirrorBannerText({});
    assert.equal(t, '只读镜像：终端会话运行中，移动端当前只读');
    assert.doesNotMatch(t, /接管|静默后|点/);
    assert.equal(/\d+\s*s/.test(t), false, '不应展示约 Ns 假精密倒计时');
  });
});

// 驾驶中点输入区时的可操作说明（disabled 吞点击 → 需主动 addBar；与 placeholder 短句互补）
// 主操作已迁到发送钮位「续接」，说明文案指向该按钮。
test.describe('formatMirrorComposerHint（点输入区说明三态）', () => {
  test('armed：等待自动切换 + 可取消', () => {
    const t = formatMirrorComposerHint({ armed: true });
    assert.match(t, /只读镜像.*(已请求续接|等待|自动可写)/);
    assert.match(t, /取消续接/);
  });
  test('stale：确认终端已停后续接', () => {
    const t = formatMirrorComposerHint({ stale: true });
    assert.match(t, /只读镜像.*疑似中断/);
    assert.match(t, /续接/);
    assert.match(t, /历史仍在/);
  });
  test('driving：能/不能/硬要怎么做；无假精密倒计时', () => {
    const t = formatMirrorComposerHint({});
    assert.match(t, /只读镜像/);
    assert.match(t, /终端会话运行中/);
    assert.match(t, /移动端当前只读/);
    assert.match(t, /不能/);
    assert.match(t, /能/);
    assert.match(t, /续接/);
    assert.equal(/\d+\s*s/.test(t), false);
  });
  test('armed 优先于 stale', () => {
    assert.match(formatMirrorComposerHint({ armed: true, stale: true }), /已请求续接|取消续接/);
  });
});

test.describe('shouldEmitThrottledHint（同文案节流）', () => {
  test('首次必发', () => {
    assert.equal(shouldEmitThrottledHint({ lastText: '', lastAt: 0, nextText: 'hello', now: 1000, throttleMs: 2500 }), true);
  });
  test('同文案在节流窗内不发', () => {
    assert.equal(shouldEmitThrottledHint({
      lastText: 'hello', lastAt: 1000, nextText: 'hello', now: 2000, throttleMs: 2500,
    }), false);
  });
  test('同文案过节流窗再发', () => {
    assert.equal(shouldEmitThrottledHint({
      lastText: 'hello', lastAt: 1000, nextText: 'hello', now: 4000, throttleMs: 2500,
    }), true);
  });
  test('换文案立即发（armed/stale 切换）', () => {
    assert.equal(shouldEmitThrottledHint({
      lastText: 'a', lastAt: 1000, nextText: 'b', now: 1100, throttleMs: 2500,
    }), true);
  });
  test('空文案不发', () => {
    assert.equal(shouldEmitThrottledHint({ lastText: '', lastAt: 0, nextText: '', now: 1, throttleMs: 2500 }), false);
  });
});

// 跨工作区/跨会话误锁守卫：CLI 在 A 驾驶时，切到 B 新会话不得接纳 A 的 readonly=true。
test.describe('acceptMirrorState（mirror_state 归属）', () => {
  test('readonly=false 一律接受（权威解锁，含空 idle 快照）', () => {
    assert.equal(acceptMirrorState({ readonly: false, eventInstanceId: null, viewingInstanceId: null }), true);
    assert.equal(acceptMirrorState({ readonly: false, eventInstanceId: 'inst_A', viewingInstanceId: 'inst_B' }), true);
    assert.equal(acceptMirrorState({ readonly: false }), true);
  });
  test('readonly=true 且 instanceId 匹配当前 viewing → 接受', () => {
    assert.equal(acceptMirrorState({
      readonly: true, eventInstanceId: 'inst_A', viewingInstanceId: 'inst_A',
    }), true);
  });
  test('readonly=true 但指向别的 tab → 拒绝（防跨会话误锁）', () => {
    assert.equal(acceptMirrorState({
      readonly: true, eventInstanceId: 'inst_A', viewingInstanceId: 'inst_B',
    }), false);
  });
  test('readonly=true 但 viewing 为空首页/新会话 → 拒绝', () => {
    assert.equal(acceptMirrorState({
      readonly: true, eventInstanceId: 'inst_A', viewingInstanceId: null,
    }), false);
  });
  test('readonly=true 但事件缺 instanceId → 拒绝（无主不上锁）', () => {
    assert.equal(acceptMirrorState({
      readonly: true, eventInstanceId: null, viewingInstanceId: 'inst_A',
    }), false);
    assert.equal(acceptMirrorState({
      readonly: true, eventInstanceId: '', viewingInstanceId: 'inst_A',
    }), false);
  });
});

test.describe('shouldResetMirrorOnViewChange（切视图/工作区先本地清锁）', () => {
  test('viewing 变了 → 清', () => {
    assert.equal(shouldResetMirrorOnViewChange({
      prevViewing: 'inst_A', nextViewing: 'inst_B',
    }), true);
    assert.equal(shouldResetMirrorOnViewChange({
      prevViewing: 'inst_A', nextViewing: null,
    }), true);
  });
  // 回归：同会话静默换实例（externalDirty/effort 触发的 dispose+resume，非用户主动切换/切会话）
  // sessionId 不变——不该把用户刚做出的本地接管选择（mirrorOverriddenSid）冲掉，否则终端只读锁
  // 会在用户自己这一轮忙碌时被重新广播锁上。sessionId 未知（null，如懒开会话前）保守仍按老规则清。
  test('同会话静默换实例（sessionId 相同，instanceId 变）→ 不清', () => {
    assert.equal(shouldResetMirrorOnViewChange({
      prevViewing: 'inst_A', nextViewing: 'inst_B',
      prevSessionId: 'sess_1', nextSessionId: 'sess_1',
    }), false);
  });
  test('instanceId 变 + sessionId 也真变（真切换会话）→ 清', () => {
    assert.equal(shouldResetMirrorOnViewChange({
      prevViewing: 'inst_A', nextViewing: 'inst_B',
      prevSessionId: 'sess_1', nextSessionId: 'sess_2',
    }), true);
  });
  test('instanceId 变但 sessionId 未知（null，如新会话懒开前）→ 保守仍清', () => {
    assert.equal(shouldResetMirrorOnViewChange({
      prevViewing: 'inst_A', nextViewing: 'inst_B',
      prevSessionId: null, nextSessionId: null,
    }), true);
  });
  test('viewing 不变且 cwd 不变 → 不清', () => {
    assert.equal(shouldResetMirrorOnViewChange({
      prevViewing: 'inst_A', nextViewing: 'inst_A',
      prevCwd: '/a', nextCwd: '/a', cwdSeen: true,
    }), false);
    assert.equal(shouldResetMirrorOnViewChange({
      prevViewing: null, nextViewing: null,
    }), false);
  });
  test('空首页内换工作区（viewing 恒 null、cwd 变）→ 清', () => {
    assert.equal(shouldResetMirrorOnViewChange({
      prevViewing: null, nextViewing: null,
      prevCwd: '/a', nextCwd: '/b', cwdSeen: true,
    }), true);
  });
  test('首帧（cwdSeen=false）不因 cwd 冒充切换而清', () => {
    assert.equal(shouldResetMirrorOnViewChange({
      prevViewing: null, nextViewing: null,
      prevCwd: null, nextCwd: '/a', cwdSeen: false,
    }), false);
  });
});
