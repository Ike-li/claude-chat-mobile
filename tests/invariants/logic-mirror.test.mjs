// tests/invariants/logic-mirror.test.mjs —— 只读镜像态的接受判定（前端侧）
// 守护：SESSION-01 的前端半边（CLI 在 A 会话驾驶时，只读锁不得挂到 B 会话上）
// 覆盖：acceptMirrorState 的四条判据（非只读放行 / 缺 instanceId 拒 / 空首页拒 / 指向别的 tab 拒）
// 槽位：S1（纯函数）
//
// 后端的镜像态判定在 tests/invariants/cli-mirror-state.test.mjs（app/src/agent/cli-mirror-state.js），
// 两回事：那边判「终端到底在不在驾驶」，这边判「这条广播该不该被当前视图采纳」。
//
// ⚠ 关于变异：本函数有两个存活变异体（`eventInstanceId == null || === ''` 与 viewing 那条的 ||→&&），
// 2026-09-05 穷举验证过是【等价变异】，不是缺口——最后那行 `eventInstanceId === viewingInstanceId`
// 已经隐含空值处理（空值不等于非空值），而两者同为空的情况被另一条检查兜住；
// 50 组输入下改与不改行为完全一致。那两个 if 是防御性冗余（写出来是为了让判据可读）。
//   源码注释「否则 CLI 在 A 驾驶会把 B 的新会话锁死」说的是**完全没有这些检查**时的风险，
//   不是单点变异后的风险——别拿它当"变异体存活 = 有缺口"的证据。
// 所以本文件钉的是整体契约（防止将来有人连最后那行 === 一起删掉），不宣称修了什么。
//
// 不测什么 + 为什么：
//  ① 横幅/输入框提示文案（formatMirrorBannerText / formatMirrorComposerHint）—— 过 i18n，
//     且已有 tests/unit/logic-mirror-sync.test.mjs 覆盖。
//  ② armedTakeoverStep 的接管状态机 —— 另一组判据，属同模块但不同关注点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptMirrorState } from '../../app/public/js/logic/mirror.js';

test.describe('acceptMirrorState', () => {
  test('非只读 → 一律接受，含 instanceId 为空的权威空闲快照', () => {
    // 解锁方向必须畅通：server 判定「终端不在驾驶了」时会发一条 readonly=false 的快照，
    // 那条可能不带 instanceId（不针对某个 tab）。挡掉它 = 锁永远解不开。
    for (const ids of [{}, { eventInstanceId: null }, { eventInstanceId: '', viewingInstanceId: '' },
      { eventInstanceId: 'a', viewingInstanceId: 'b' }]) {
      assert.equal(acceptMirrorState({ readonly: false, ...ids }), true,
        `解锁快照必须无条件接受：${JSON.stringify(ids)}`);
    }
  });

  test('只读 + 严格同一实例 → 接受', () => {
    assert.equal(acceptMirrorState({ readonly: true, eventInstanceId: 'inst_1', viewingInstanceId: 'inst_1' }), true);
  });

  test('只读 + 指向别的 tab → 拒绝（这是「A 驾驶不得锁 B」的正面判据）', () => {
    assert.equal(acceptMirrorState({ readonly: true, eventInstanceId: 'inst_1', viewingInstanceId: 'inst_2' }), false);
  });

  test('只读 + 任一侧 instanceId 缺失 → 拒绝', () => {
    // 上锁方向 fail-closed：判不出这条锁属于哪个 tab，就不上锁。
    // 空首页（viewingInstanceId 为 null）尤其不能被锁——用户还没选会话呢。
    for (const [e, v] of [
      [null, 'inst_1'], [undefined, 'inst_1'], ['', 'inst_1'],
      ['inst_1', null], ['inst_1', undefined], ['inst_1', ''],
      [null, null], ['', ''],
    ]) {
      assert.equal(acceptMirrorState({ readonly: true, eventInstanceId: e, viewingInstanceId: v }), false,
        `event=${String(e)} viewing=${String(v)} 判不出归属，不得上锁`);
    }
  });

  test('缺省参数 = 最保守的那一档（不给任何信息时不上锁）', () => {
    assert.equal(acceptMirrorState(), true, '默认 readonly=false ⇒ 放行（默认不是锁着的）');
    assert.equal(acceptMirrorState({ readonly: true }), false, '只说要上锁但没说锁哪个 ⇒ 拒绝');
  });
});
