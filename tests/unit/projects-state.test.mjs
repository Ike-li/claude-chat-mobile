// tests/unit/projects-state.test.mjs —— 任一 cwd 在界面上叫什么（顶栏、「需要你」条目、首页最近会话）
//
// 抽屉小节的标题来自服务端的项目清单；但顶栏与「需要你」拿到的常是某个会话的真实 cwd——scratch 目录、
// worktree——它们不是任何一节的键。scratch 目录的末段是 `scratch-2026-09-24-xxxxxx`，照末段显示用户
// 认不出这是哪；「无文件夹」那一节此刻也未必已经下发（刚开的会话、还没进扫盘结果）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectsState } from '../../app/public/js/app/projects-state.js';
import { setLang } from '../../app/public/js/i18n.js';

const SCRATCH = '/Users/you/Library/Application Support/claude-chat-mobile/scratch-workspaces';

test('一节的键用那一节的标题；scratch 根及其下的目录叫「无文件夹」；其余取末段', () => {
  setLang('zh');
  const state = createProjectsState();
  state.set({
    dirs: ['/c/app'],
    projects: [
      { key: '/c/app', root: '/c/app', label: 'app', kind: 'connected' },
      { key: '/c/app/pkg', root: '/c/app', label: 'app › pkg', kind: 'subfolder' },
    ],
    scratchRoot: SCRATCH,
  });
  assert.deepEqual(state.keys(), ['/c/app', '/c/app/pkg']);
  assert.equal(state.labelFor('/c/app/pkg'), 'app › pkg');
  assert.equal(state.labelFor(`${SCRATCH}/scratch-2026-09-24-abcdef`), '无文件夹', '「无文件夹」那一节还没下发时也不能显示成 scratch 目录名');
  assert.equal(state.labelFor(SCRATCH), '无文件夹');
  assert.equal(state.labelFor(`${SCRATCH}-other/x`), 'x', '前缀相邻的目录不算');
  assert.equal(state.labelFor('/c/app-feat'), 'app-feat');
});

test('旧载荷（没有 projects / scratchRoot）：每个目录一节、取末段，与改动前相同', () => {
  const state = createProjectsState();
  state.set({ dirs: ['/c/a', '/c/b'] });
  assert.deepEqual(state.keys(), ['/c/a', '/c/b']);
  assert.equal(state.labelFor('/c/b'), 'b');
  assert.equal(state.scratchRoot(), null);
});

// 原生 Windows（实验路径）上 scratch 目录是 \ 分隔的。认不出来的话，删除确认框不会提醒「临时目录连同里面的
// 文件一并删除」，而后端照样递归删（2026-10-10 review P2）。
test('Windows 路径：scratch 根下的目录照样认作「无文件夹」，相邻前缀不算', () => {
  setLang('zh');
  const W = 'C:\\Users\\you\\AppData\\Local\\claude-chat-mobile\\scratch-workspaces';
  const state = createProjectsState();
  state.set({ dirs: ['C:\\c\\app'], projects: [{ key: 'C:\\c\\app', root: 'C:\\c\\app', label: 'app', kind: 'connected' }], scratchRoot: W });
  assert.equal(state.isNoFolder(`${W}\\scratch-2026-10-10-abcdef`), true, 'Windows 上的 scratch 会话没被认作「无文件夹」');
  assert.equal(state.labelFor(`${W}\\scratch-2026-10-10-abcdef`), '无文件夹');
  assert.equal(state.isNoFolder(`${W}-other\\x`), false, '前缀相邻的目录不算');
});

// #305：长按连接根时显示「置顶」还是「取消置顶」只看服务端清单里的 pinned，前端不存任何置顶状态。
test('置顶：只认服务端清单里连接根上的 pinned；子文件夹带了也不算；新清单整份替换', () => {
  const state = createProjectsState();
  state.set({
    dirs: ['/c/a', '/c/b'],
    projects: [
      { key: '/c/b', root: '/c/b', label: 'b', kind: 'connected', pinned: true },
      { key: '/c/b/x', root: '/c/b', label: 'b › x', kind: 'subfolder', pinned: true },
      { key: '/c/a', root: '/c/a', label: 'a', kind: 'connected' },
    ],
  });
  assert.equal(state.isPinned('/c/b'), true);
  assert.equal(state.isPinned('/c/a'), false);
  assert.equal(state.isPinned('/c/b/x'), false, '子文件夹没有置顶这回事');
  state.set({ dirs: ['/c/a', '/c/b'], projects: [{ key: '/c/a', kind: 'connected' }, { key: '/c/b', kind: 'connected' }] });
  assert.equal(state.isPinned('/c/b'), false, '取消置顶的广播到了还显示「取消置顶」');
});
