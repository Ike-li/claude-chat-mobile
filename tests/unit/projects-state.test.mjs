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
