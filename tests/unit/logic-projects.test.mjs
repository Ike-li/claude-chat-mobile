// tests/unit/logic-projects.test.mjs —— 抽屉的项目清单：服务端载荷 → 前端小节
//
// 服务端（2026-09-24 起）在 instances 广播里带 projects：已连接的文件夹、其下有会话的子文件夹、「无文件夹」。
// 载荷里没有它时（旧服务端、E2E mock 的旧载荷、在线演示站）回落到 dirs，每个目录一节——与改动前逐字相同。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjects, projectLabel, isPathWithin, relPathUnder } from '../../app/public/js/logic/projects.js';
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
  // 服务端（sessions/folders.js、app.js addConnectedFolder / removeConnectedFolder、socket-folders.js）会回的每一个码
  for (const code of ['home', 'root', 'outside_home', 'forbidden', 'worktree', 'already_connected', 'not_found', 'not_directory',
    'no_config_file', 'source_readonly', 'config_unreadable', 'write_failed', 'not_applied', 'invalid', 'not_connected',
    'exists', 'hidden', 'separator', 'control', 'too_long', 'empty', 'out_of_range', 'mkdir_failed', 'unreadable']) {
    assert.ok(FOLDER_REASON_CODES.includes(code), `${code} 没有文案：用户只会看到一个英文码`);
    assert.notEqual(folderReasonText(code), '操作失败', code);
  }
  assert.equal(folderReasonText('whatever'), '操作失败');
  assert.equal(folderReasonText('worktree'), '这是 Claude Code 建的 worktree，跟随所属仓库；请添加仓库本身');
  setLang('en');
  assert.equal(folderReasonText('home'), 'Your whole home folder can\'t be added');
  setLang('zh');
});

// 抽屉「⋯ → 断开这个文件夹」的确认框（2026-10-15）。断开只是不再显示、不能在里面新开：文件和会话记录都不动，
// 开着的会话照常跑。有会话开着时说出几个——不说，用户会以为点下去就全关了。
test('disconnectFolderConfirm：说清断开不动文件与会话；有会话开着时说出几个；名字原样带出', async () => {
  const { disconnectFolderConfirm } = await import('../../app/public/js/logic/projects.js');
  setLang('zh');
  const quiet = disconnectFolderConfirm({ name: 'demo', openSessions: 0 });
  assert.equal(quiet.title, '断开「demo」？');
  assert.equal(quiet.okText, '断开');
  assert.match(quiet.body, /文件.*会话记录都不动/);
  assert.doesNotMatch(quiet.body, /开着/, '没有会话开着时不该提');
  assert.match(disconnectFolderConfirm({ name: 'demo', openSessions: 2 }).body, /2 个会话开着，会照常继续/);
  // 文件夹名里的 $& 不能被当成替换模式（String.replace 的字符串参数会解释它）
  assert.equal(disconnectFolderConfirm({ name: 'a$&b', openSessions: 0 }).title, '断开「a$&b」？');
  setLang('en');
  const en = disconnectFolderConfirm({ name: 'demo', openSessions: 1 });
  assert.doesNotMatch(`${en.title}${en.body}${en.okText}`, /[一-鿿]/, '英文档没有中文残留');
  setLang('zh');
});

// 断开连接根时一起消失的小节里开着几个会话（2026-10-15 Codex review #205）。会话按最具体的那一节归属，
// 只数根那一节会漏掉它下面自成一节的子文件夹里在跑的会话——确认框恰好在要说清「会照常继续」的时候说少了。
test('openSessionsUnderRoot：连接根连同它下面的子文件夹小节一起数，别的根不算', async () => {
  const { openSessionsUnderRoot } = await import('../../app/public/js/logic/projects.js');
  const projects = [
    { key: '/repo', root: '/repo', kind: 'connected' },
    { key: '/repo/sub', root: '/repo', kind: 'subfolder' },
    { key: '/other', root: '/other', kind: 'connected' },
  ];
  const sectionKeys = projects.map(p => p.key);
  const instances = [
    { instanceId: 'a', sessionId: 's-a', cwd: '/repo' },
    { instanceId: 'b', sessionId: 's-b', cwd: '/repo/sub/pkg' },
    { instanceId: 'c', cwd: '/repo/sub' }, // 还没拿到 sessionId 的新会话也算
    { instanceId: 'd', sessionId: 's-d', cwd: '/other' },
  ];
  assert.equal(openSessionsUnderRoot({ projects, instances, root: '/repo', sectionKeys }), 3, '子文件夹小节里在跑的会话没算进去');
  assert.equal(openSessionsUnderRoot({ projects, instances, root: '/other', sectionKeys }), 1);
  assert.equal(openSessionsUnderRoot({ projects, instances: [], root: '/repo', sectionKeys }), 0);
});

// 首页「最近活跃会话」去哪些目录拉（2026-10-15）。断开最后一个文件夹时查看目录可能还停在它上面（里面有会话开着，
// 服务端只在没有实例时才把查看目录归位）；显式拿它去拉列表，服务端会当成越界尝试记一条红色审计。
test('dashboardDirs：只列服务端给的项目；明说一个都没连时不拿查看目录去拉；载荷没带清单才回落查看目录', async () => {
  const { dashboardDirs } = await import('../../app/public/js/logic/projects.js');
  assert.deepEqual(dashboardDirs({ keys: ['/a', '/b'], connectedCount: 2, currentCwd: '/a' }), ['/a', '/b']);
  assert.deepEqual(dashboardDirs({ keys: [], connectedCount: 0, currentCwd: '/gone' }), [],
    '刚断开的文件夹被拿去拉会话列表：服务端会记一条「越界访问被拒」');
  assert.deepEqual(dashboardDirs({ keys: ['/scratch'], connectedCount: 0, currentCwd: '/gone' }), ['/scratch']);
  assert.deepEqual(dashboardDirs({ keys: [], connectedCount: null, currentCwd: '/a' }), ['/a'], '旧服务端的载荷没带清单：照旧看查看目录');
  assert.deepEqual(dashboardDirs({ keys: [], connectedCount: null, currentCwd: null }), []);
});

// headless server 可能跑在原生 Windows（实验路径）：家目录、项目键、scratch 目录里的分隔符是 \。
// 前端判「在不在某目录下」只按 / 拼前缀，Windows 上一律判成不在（2026-10-10 review P2）。
test('isPathWithin：两种分隔符都认，相邻前缀不算', () => {
  assert.equal(isPathWithin('/Users/you/code/app', '/Users/you'), true);
  assert.equal(isPathWithin('/Users/you', '/Users/you'), true);
  assert.equal(isPathWithin('C:\\Users\\you\\code\\app', 'C:\\Users\\you'), true, 'Windows 路径被判成不在家目录下');
  assert.equal(isPathWithin('C:\\Users\\you2\\x', 'C:\\Users\\you'), false, '相邻前缀 you2 不在 you 下');
  assert.equal(isPathWithin('/Users/you2/x', '/Users/you'), false);
  assert.equal(isPathWithin('/Users/you/code', '/Users/you/'), true, '根带尾随分隔符也认');
  assert.equal(isPathWithin('', '/Users/you'), false);
  assert.equal(isPathWithin('/Users/you', ''), false);
});

test('relPathUnder：相对路径一律用 / 分隔（协议里的位置是 / 分隔的），不在其下返回 null', () => {
  assert.equal(relPathUnder('/Users/you/code/app', '/Users/you'), 'code/app');
  assert.equal(relPathUnder('/Users/you', '/Users/you'), '');
  assert.equal(relPathUnder('C:\\Users\\you\\code\\app', 'C:\\Users\\you'), 'code/app',
    'Windows 上点进已连接的文件夹会报「不在家目录里」');
  assert.equal(relPathUnder('C:\\Users\\you2\\x', 'C:\\Users\\you'), null);
});
