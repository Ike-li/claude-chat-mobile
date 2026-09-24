// tests/invariants/logic-drawer-live.test.mjs —— 抽屉里活着的实例永远有一行
// 守护：SESSION-02（活实例必须有一行：不依赖 session:list 是否返回它、有没有 sessionId、cwd 还属不属于某个工作区）
// 测什么：抽屉按小节分配活实例的纯函数——哪些贴到列表行上、哪些要补画、哪些不属于任何小节。
// 不测什么 + 为什么：DOM 渲染与点击行为属 S3（tests/e2e/specs/drawer-live-rows.spec.ts）；
//   小节键怎么算（现在 = availableDirs，之后 = 项目键）不在这里。
// 槽位：S1（纯函数）

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  liveRowsForSection,
  orphanLiveRows,
  unownedLiveInstances,
} from '../../app/public/js/logic/panel-state.js';

const MAIN = '/Users/you/code/app';
const OTHER = '/Users/you/code/other';
const DIRS = [MAIN, OTHER];
const inst = (instanceId, cwd, sessionId = null, extra = {}) => ({ instanceId, cwd, sessionId, title: instanceId, state: 'busy', ...extra });

// 抽屉的完整分配：每个小节的「列表行上贴的 + 补画的 + 新会话 tab」，加上不属于任何小节的。
// 断言它覆盖了全部活实例——这是 SESSION-02 本身，而不是某个函数的细节。
function everyLiveInstanceHasARow(instances, dirs, listedBySection) {
  const shown = new Set();
  for (const d of dirs) {
    const { liveMap, freshTabs } = liveRowsForSection(instances, d, dirs);
    const listed = listedBySection[d] || [];
    for (const id of listed) if (liveMap.has(id)) shown.add(liveMap.get(id).instanceId);
    for (const i of orphanLiveRows(liveMap, listed)) shown.add(i.instanceId);
    for (const i of freshTabs) shown.add(i.instanceId);
  }
  for (const i of unownedLiveInstances(instances, dirs)) shown.add(i.instanceId);
  return instances.filter(i => i.instanceId && !shown.has(i.instanceId)).map(i => i.instanceId);
}

test('列表里没有它的活实例照样补画——被分页挤出本页，或 transcript 被迁到别的 project 目录', () => {
  const instances = [inst('i1', MAIN, 'sid-listed'), inst('i2', MAIN, 'sid-moved-away')];
  const { liveMap } = liveRowsForSection(instances, MAIN, DIRS);
  const orphans = orphanLiveRows(liveMap, ['sid-listed', 'sid-other']);
  assert.deepEqual(orphans.map(i => i.instanceId), ['i2'], '不在列表里的活实例不补画 = 抽屉里整行消失，用户以为它没了');
});

test('列表里已有的不重复补画', () => {
  const instances = [inst('i1', MAIN, 'sid-a')];
  const { liveMap } = liveRowsForSection(instances, MAIN, DIRS);
  assert.deepEqual(orphanLiveRows(liveMap, new Set(['sid-a'])), []);
});

test('还没 sessionId 的实例进 freshTabs——包括懒开到托管 worktree 里的那种', () => {
  const wt = `${MAIN}/.claude/worktrees/feat`;
  const instances = [inst('fresh-main', MAIN), inst('fresh-wt', wt)];
  const { freshTabs } = liveRowsForSection(instances, MAIN, DIRS);
  assert.deepEqual(freshTabs.map(i => i.instanceId).sort(), ['fresh-main', 'fresh-wt'],
    '只收 cwd === 工作区本身的话，懒开到 worktree、还没拿到 sessionId 的实例哪一节都不画');
});

test('cwd 不在任何工作区之下的活实例单独列出——例如刚进了仓库外的平级 worktree', () => {
  const instances = [inst('i1', MAIN, 'sid-a'), inst('sib', '/Users/you/code/app-feat-x', 'sid-sib')];
  assert.deepEqual(unownedLiveInstances(instances, DIRS).map(i => i.instanceId), ['sib']);
  for (const d of DIRS) {
    const { liveMap, freshTabs } = liveRowsForSection(instances, d, DIRS);
    assert.ok(![...liveMap.values(), ...freshTabs].some(i => i.instanceId === 'sib'), '不属于的小节不该认领它');
  }
});

test('前缀相邻的目录不误认：/code/app-x 不属于 /code/app', () => {
  const instances = [inst('x', '/Users/you/code/app-x', 'sid-x')];
  assert.equal(liveRowsForSection(instances, MAIN, DIRS).liveMap.size, 0);
  assert.deepEqual(unownedLiveInstances(instances, DIRS).map(i => i.instanceId), ['x']);
});

test('SESSION-02 整体：各种形态混在一起时，每个活实例都有且只有一个去处', () => {
  const instances = [
    inst('listed', MAIN, 'sid-listed'),
    inst('paged-out', MAIN, 'sid-paged-out'),
    inst('fresh', MAIN),
    inst('fresh-wt', `${MAIN}/.claude/worktrees/x`),
    inst('other-listed', OTHER, 'sid-o'),
    inst('sibling', '/Users/you/code/app-feat', 'sid-sib'),
    inst('sibling-fresh', '/tmp/elsewhere'),
    { instanceId: null, cwd: MAIN, sessionId: 'ghost' }, // 没有 instanceId 的不是活实例，不计
  ];
  const missing = everyLiveInstanceHasARow(instances, DIRS, { [MAIN]: ['sid-listed'], [OTHER]: ['sid-o'] });
  assert.deepEqual(missing, [], `这些活实例在抽屉里一行都没有：${missing.join(', ')}`);
});
