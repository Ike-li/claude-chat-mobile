// tests/unit/logic-model-grid-empty.test.mjs —— 会话设置「✨ 模型」块拿不到候选时的空态。
//
// 可达性（查过链路，不是假想）：前端 modelsList 初值是 []，且 localStorage 里并没有模型缓存
// （只存了 auth_token / current_session / slash_commands 等，models 不在其中——app/src/server/app.js:556
// 那句「前端保留 localStorage 缓存」对 models 并不成立）。服务端 pushModelsForCwd 在无缓存时刻意
// 不推（推空会摧毁网格），改由 openScoutInstance 起一个 scout 进程去取。于是首次连接 / 新工作区
// 到 scout 返回之间，网格确实是空的；scout 失败时则持续空着。
//
// 而「✨ 模型」标题恒显（settings-block-head 没有 hidden），空网格＝又一个孤儿标题。
// 文案刻意不写「正在读取…」：scout 可能已经失败了，那句话会永远停在那里说一件不再为真的事。
// 只陈述事实 + 给出路（面板右上角那个 ⟳ 恒可见，data-testid="settings-config-refresh"）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelGridEmptyHint } from '../../app/public/js/logic.js';

test('modelGridEmptyHint: 网格里有磁贴就不出说明', () => {
  assert.equal(modelGridEmptyHint({ tileCount: 5 }), null);
});

// 判据是「网格最终有没有东西」而不是「models 列表空不空」：ensureModelOption（app.js:156）会在
// rebuildCustomModelGrid 之外、之后单独追加一张「当前加载模型」磁贴。E2E 实测发现，若只看 models
// 列表，冷启动下会同时出现「还没拿到清单」和一张卡片——自相矛盾，比原来的空白更糟。
test('modelGridEmptyHint: 只有真的一张都没有才说话（防与兜底磁贴自相矛盾）', () => {
  assert.equal(modelGridEmptyHint({ tileCount: 1 }), null, '兜底磁贴也是磁贴，有它就不能说没有');
  assert.ok(modelGridEmptyHint({ tileCount: 0 }));
});

test('modelGridEmptyHint: 缺参/脏参一律当作空，不静默吞掉说明', () => {
  for (const bad of [undefined, {}, { tileCount: null }, { tileCount: 'x' }, { tileCount: -1 }]) {
    assert.ok(modelGridEmptyHint(bad), `${JSON.stringify(bad)} 应视作无磁贴`);
  }
});

// 不承诺进度：scout 起不来时「正在读取」会永远停在那儿说一件不再为真的事，
// 与本轮另两处（会话标识、hooks 桥）守的是同一条——宁可少说，不可说错。
test('modelGridEmptyHint: 不说「正在读取」，只说事实与出路', () => {
  const hint = modelGridEmptyHint({ tileCount: 0 });
  assert.doesNotMatch(hint, /正在读取|加载中|请稍候/);
  assert.match(hint, /⟳|刷新/, '要指得出用户能按的那个东西');
});
