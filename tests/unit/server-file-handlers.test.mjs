import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerFileSocketHandlers } from '../../src/server/socket-files.js';

function register(extra = {}) {
  const handlers = new Map();
  const audits = [];
  registerFileSocketHandlers({
    socket: {},
    on: (_socket, event, handler) => handlers.set(event, handler),
    routeCwd: () => '/repo',
    getWorkDirs: () => ['/repo'],
    listDir: () => null,
    browseReadFile: () => null,
    listGitChanges: async () => ({ ok: true, branch: 'main', staged: [], unstaged: [], untracked: [], truncated: false }),
    readGitDiff: async () => ({ ok: true, path: 'a.js', side: 'unstaged', patch: '+x', binary: false, truncated: false, empty: false }),
    audit: { recordAudit: entry => audits.push(entry) },
    actorFromSocket: () => ({ deviceId: 'd1', via: 'web' }),
    routeInstance: () => null,
    attributePath: () => null,
    rejectableSymlinkComponent: () => false,
    buildDiff: () => null,
    readPreview: () => null,
    logger: { warn() {} },
    ...extra,
  });
  return { handlers, audits };
}

test('file socket handlers fail closed and audit out-of-scope browse requests', async () => {
  const { handlers, audits } = register();
  let response;
  await handlers.get('browse:list')({ cwd: '/repo', relPath: '../outside' }, value => { response = value; });

  assert.deepEqual(response, { ok: false, error: '路径不在授权范围内，或不是目录' });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'scope_violation');
  assert.equal(audits[0].meta.via, 'browse:list');
});

test('git:status 成功透传 listGitChanges', async () => {
  const { handlers } = register({
    listGitChanges: async cwd => {
      assert.equal(cwd, '/repo');
      return {
        ok: true,
        branch: 'dev',
        staged: [{ path: 'a.js', xy: 'M ' }],
        unstaged: [{ path: 'b.js', xy: ' M' }],
        untracked: [{ path: 'c.js' }],
        truncated: false,
      };
    },
  });
  let response;
  await handlers.get('git:status')({}, value => { response = value; });
  assert.equal(response.ok, true);
  assert.equal(response.branch, 'dev');
  assert.equal(response.staged[0].path, 'a.js');
  assert.equal(response.untracked[0].path, 'c.js');
});

test('git:status 无 ack 时忽略', async () => {
  const { handlers } = register();
  await handlers.get('git:status')({}); // 不抛
});

test('git:status 越界 cwd 审计 via=git:status', async () => {
  const { handlers, audits } = register({
    routeCwd: () => '/outside',
    getWorkDirs: () => ['/repo'],
  });
  let response;
  await handlers.get('git:status')({}, value => { response = value; });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'scope');
  assert.equal(audits[0].meta.via, 'git:status');
});

test('git:diff 越界 path 审计 via=git:diff', async () => {
  let spawned = false;
  const { handlers, audits } = register({
    readGitDiff: async () => { spawned = true; return { ok: true, path: 'x', side: 'unstaged', patch: '' }; },
  });
  let response;
  await handlers.get('git:diff')({ path: '../etc/passwd', side: 'unstaged' }, value => { response = value; });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'bad_path');
  assert.equal(spawned, false);
  assert.equal(audits[0].meta.via, 'git:diff');
});

test('git:diff 合法 path 透传', async () => {
  const { handlers } = register({
    readGitDiff: async (cwd, path, side) => {
      assert.equal(cwd, '/repo');
      assert.equal(path, 'src/a.js');
      assert.equal(side, 'staged');
      return { ok: true, path, side, patch: '+hi', binary: false, truncated: false, empty: false };
    },
  });
  let response;
  await handlers.get('git:diff')({ path: 'src/a.js', side: 'staged' }, value => { response = value; });
  assert.equal(response.ok, true);
  assert.equal(response.patch, '+hi');
  assert.equal(response.side, 'staged');
});
