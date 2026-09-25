// tests/unit/logic-projects.test.mjs —— 抽屉的项目清单：服务端载荷 → 前端小节
//
// 服务端（2026-09-24 起）在 instances 广播里带 projects：已连接的文件夹、其下有会话的子文件夹、「无文件夹」。
// 载荷里没有它时（旧服务端、E2E mock 的旧载荷、在线演示站）回落到 dirs，每个目录一节——与改动前逐字相同。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjects, projectLabel } from '../../app/public/js/logic/projects.js';
import { setLang } from '../../app/public/js/i18n.js';

test('没有 projects：回落到 dirs，每个目录一节', () => {
  assert.deepEqual(normalizeProjects({ dirs: ['/c/a', '/c/b'] }), [
    { key: '/c/a', root: '/c/a', label: null, kind: 'connected' },
    { key: '/c/b', root: '/c/b', label: null, kind: 'connected' },
  ]);
  assert.deepEqual(normalizeProjects({}), []);
  assert.deepEqual(normalizeProjects(null), []);
});

test('有 projects：按服务端顺序；坏条目丢掉、重复的只留第一个、未知 kind 当连接根', () => {
  const out = normalizeProjects({
    dirs: ['/c/a'],
    projects: [
      { key: '/c/a', root: '/c/a', label: 'a', kind: 'connected' },
      { key: '/c/a/pkg', root: '/c/a', label: 'a › pkg', kind: 'subfolder' },
      { key: '/c/a', root: '/c/a', label: 'dup', kind: 'connected' },
      null, { key: '' }, { key: 42 },
      { key: '/s', root: '/s', label: null, kind: 'scratch' },
      { key: '/c/x', kind: 'mystery' },
    ],
  });
  assert.deepEqual(out.map(p => [p.key, p.kind]), [
    ['/c/a', 'connected'], ['/c/a/pkg', 'subfolder'], ['/s', 'scratch'], ['/c/x', 'connected'],
  ]);
  assert.equal(out.find(p => p.key === '/c/x').root, '/c/x', '缺 root 时取 key');
});

test('projectLabel：无文件夹走 i18n；有 label 用 label；没有就取末段', () => {
  setLang('zh');
  assert.equal(projectLabel({ key: '/s', kind: 'scratch', label: null }), '无文件夹');
  assert.equal(projectLabel({ key: '/c/a/pkg', kind: 'subfolder', label: 'a › pkg' }), 'a › pkg');
  assert.equal(projectLabel({ key: '/c/a', kind: 'connected', label: null }), 'a');
  setLang('en');
  assert.equal(projectLabel({ key: '/s', kind: 'scratch', label: null }), 'No folder');
  setLang('zh');
});

test('folderReasonText：服务端的原因码都有人话，未知码回落「操作失败」', async () => {
  const { folderReasonText, FOLDER_REASON_CODES } = await import('../../app/public/js/logic/projects.js');
  setLang('zh');
  // 服务端（sessions/folders.js、app.js addConnectedFolder、socket-folders.js）会回的每一个码
  for (const code of ['home', 'root', 'outside_home', 'forbidden', 'worktree', 'already_connected', 'not_found', 'not_directory',
    'no_config_file', 'source_readonly', 'config_unreadable', 'write_failed', 'not_applied', 'invalid',
    'exists', 'hidden', 'separator', 'control', 'too_long', 'empty', 'out_of_range', 'mkdir_failed', 'unreadable']) {
    assert.ok(FOLDER_REASON_CODES.includes(code), `${code} 没有文案：用户只会看到一个英文码`);
    assert.notEqual(folderReasonText(code), '操作失败', code);
  }
  assert.equal(folderReasonText('whatever'), '操作失败');
  assert.equal(folderReasonText('worktree'), '这是 git worktree，跟随所属仓库；请添加仓库本身');
  setLang('en');
  assert.equal(folderReasonText('home'), 'Your whole home folder can\'t be added');
  setLang('zh');
});
