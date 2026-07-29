// tests/unit/logic-recents.test.mjs —— 空首页「最近活跃」列表的纯逻辑：跨工作区合并/排序/截断、
// 以及随行透传给行渲染的元信息（entrypoint / terminal 直跑态）。
// 从 logic-session.test.mjs 拆出（source-layout 闸门：单测文件按行为域拆分，不重新长成巨石）。
// worktree 不再自动分组：每个路径须是显式 workdir，recents 只合并各 workdir 的 session:list。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecentSessionsAcrossWorkspaces } from '../../public/js/logic.js';

// 空首页「最近活跃」：跨全部 workdir 的 session:list 结果合并后按 lastUsedAt 降序取 topN，
// 每条带 cwd + workspaceName，方便一键 session:switch 到任意工作区会话（不必先展开侧栏目录树）。
test('mergeRecentSessionsAcrossWorkspaces: 跨 cwd 合并、按 lastUsedAt 降序截断、补 workspaceName', () => {
  const merged = mergeRecentSessionsAcrossWorkspaces([
    {
      cwd: '/Users/you/code/claude-chat-mobile',
      sessions: [
        { id: 'a1', title: '旧会话 A', lastUsedAt: 1000 },
        { id: 'a2', title: '新会话 A', lastUsedAt: 3000 },
      ],
    },
    {
      cwd: '/Users/you/code/ai_video',
      sessions: [
        { id: 'b1', title: '中会话 B', lastUsedAt: 2000 },
      ],
    },
    {
      cwd: '/Users/you/code/empty',
      sessions: [],
    },
  ], { limit: 2 });
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(s => s.id), ['a2', 'b1']);
  assert.equal(merged[0].cwd, '/Users/you/code/claude-chat-mobile');
  assert.equal(merged[0].workspaceName, 'claude-chat-mobile');
  assert.equal(merged[1].workspaceName, 'ai_video');
  assert.equal(merged[0].title, '新会话 A');
});

// P1（7/26）：终端直跑态随行透传——服务端从 CLI 进程注册表标注，前端据此渲染 ⌨️ 徽标。
// 缺字段的旧数据/mock 必须得到 null 而非 undefined，渲染侧统一走 falsy 分支。
test('mergeRecentSessionsAcrossWorkspaces: 透传 terminal 状态，缺省为 null', () => {
  const merged = mergeRecentSessionsAcrossWorkspaces([
    {
      cwd: '/x/foo',
      sessions: [
        { id: 'busy-one', title: '终端在跑', lastUsedAt: 300, terminal: 'busy' },
        { id: 'alive-one', title: '终端开着', lastUsedAt: 200, terminal: 'alive' },
        { id: 'plain', title: '无终端', lastUsedAt: 100 },
      ],
    },
  ], { limit: 10 });
  assert.deepEqual(merged.map(s => s.terminal), ['busy', 'alive', null]);
});

test('mergeRecentSessionsAcrossWorkspaces: 缺 lastUsedAt 排后；无 id 跳过；空入参安全', () => {
  const merged = mergeRecentSessionsAcrossWorkspaces([
    {
      cwd: '/x/foo',
      sessions: [
        { id: 'with-time', title: '有时间', lastUsedAt: 50 },
        { id: 'no-time', title: '无时间' },
        { title: '无 id', lastUsedAt: 9999 },
        null,
      ],
    },
  ], { limit: 10 });
  assert.deepEqual(merged.map(s => s.id), ['with-time', 'no-time']);
  assert.equal(merged[1].workspaceName, 'foo');
  assert.deepEqual(mergeRecentSessionsAcrossWorkspaces(null), []);
  assert.deepEqual(mergeRecentSessionsAcrossWorkspaces([]), []);
  assert.deepEqual(mergeRecentSessionsAcrossWorkspaces([{ cwd: '/x', sessions: null }]), []);
});

test('mergeRecentSessionsAcrossWorkspaces: limit 默认 8，非法 limit 回落', () => {
  const many = {
    cwd: '/x/p',
    sessions: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: `t${i}`, lastUsedAt: i + 1 })),
  };
  assert.equal(mergeRecentSessionsAcrossWorkspaces([many]).length, 8);
  assert.equal(mergeRecentSessionsAcrossWorkspaces([many], { limit: 0 }).length, 8);
  assert.equal(mergeRecentSessionsAcrossWorkspaces([many], { limit: -1 }).length, 8);
  assert.equal(mergeRecentSessionsAcrossWorkspaces([many], { limit: 3 }).length, 3);
  // 最新应是 lastUsedAt 最大
  assert.equal(mergeRecentSessionsAcrossWorkspaces([many], { limit: 1 })[0].id, 's11');
});

// 显式 workdir（含把 git worktree 路径手写进 workdirs.json 的情况）走同一合并通道；
// workspaceName 可 override；无 kind 区分（一律 workspace，UI 用 📁 + 名）。
test('mergeRecentSessionsAcrossWorkspaces: workspaceName override 优先于 basename', () => {
  const merged = mergeRecentSessionsAcrossWorkspaces([
    {
      cwd: '/Users/you/code/claude-chat-mobile-promo',
      workspaceName: 'promo',
      sessions: [{ id: 'wt1', title: '在 promo workdir 里', lastUsedAt: 5000 }],
    },
    {
      cwd: '/Users/you/code/claude-chat-mobile',
      sessions: [{ id: 'm1', title: '主仓', lastUsedAt: 4000 }],
    },
  ], { limit: 5 });
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'wt1');
  assert.equal(merged[0].cwd, '/Users/you/code/claude-chat-mobile-promo');
  assert.equal(merged[0].workspaceName, 'promo');
  assert.equal(merged[1].workspaceName, 'claude-chat-mobile');
  // 空/空白 override 回落 basename
  const fallback = mergeRecentSessionsAcrossWorkspaces([
    { cwd: '/x/foo', workspaceName: '  ', sessions: [{ id: 'a', title: 't', lastUsedAt: 1 }] },
    { cwd: '/x/bar', workspaceName: '', sessions: [{ id: 'b', title: 't', lastUsedAt: 2 }] },
  ]);
  assert.equal(fallback.find(s => s.id === 'a').workspaceName, 'foo');
  assert.equal(fallback.find(s => s.id === 'b').workspaceName, 'bar');
});
