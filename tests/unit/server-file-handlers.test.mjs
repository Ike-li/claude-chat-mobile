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
    searchFiles: async () => [],
    writeFileInScope: () => ({ ok: true, contentHash: 'newhash', bytesWritten: 1 }),
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

test('files:search 越界 cwd 审计 via=files:search', async () => {
  let spawned = false;
  const { handlers, audits } = register({
    routeCwd: () => '/outside',
    getWorkDirs: () => ['/repo'],
    searchFiles: async () => { spawned = true; return []; },
  });
  let response;
  await handlers.get('files:search')({ query: 'app' }, value => { response = value; });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'scope');
  assert.equal(spawned, false);
  assert.equal(audits[0].meta.via, 'files:search');
});

test('files:search 合法透传 cwd/query/limit', async () => {
  const { handlers } = register({
    searchFiles: async (cwd, query, opts) => {
      assert.equal(cwd, '/repo');
      assert.equal(query, 'app');
      assert.equal(opts.limit, 5);
      return ['src/app.js'];
    },
  });
  let response;
  await handlers.get('files:search')({ query: 'app', limit: 5 }, value => { response = value; });
  assert.equal(response.ok, true);
  assert.deepEqual(response.paths, ['src/app.js']);
});

test('files:search 无 ack 时忽略', async () => {
  const { handlers } = register();
  await handlers.get('files:search')({ query: 'app' }); // 不抛
});

test('files:write 未注入 writeFileInScope（FILE_EDIT=off）→ unavailable', async () => {
  const { handlers } = register({ writeFileInScope: undefined });
  let response;
  await handlers.get('files:write')({ relPath: 'a.js', content: 'x', baseHash: 'h' }, value => { response = value; });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'unavailable');
});

test('files:write 越界（scope）→ 记 scope_violation 审计、ack 原样透传', async () => {
  const { handlers, audits } = register({
    writeFileInScope: () => ({ ok: false, code: 'scope', error: '路径不在授权范围内，或不是文件' }),
  });
  let response;
  await handlers.get('files:write')({ relPath: '../etc/passwd', content: 'x', baseHash: 'h' }, value => { response = value; });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'scope');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'scope_violation');
  assert.equal(audits[0].meta.via, 'files:write');
  assert.equal(audits[0].meta.relPath, '../etc/passwd');
});

test('files:write 合法透传 cwd/relPath/content/baseHash，成功记 file_write 审计', async () => {
  const { handlers, audits } = register({
    writeFileInScope: (cwd, relPath, content, scopeDirs, opts) => {
      assert.equal(cwd, '/repo');
      assert.equal(relPath, 'src/a.js');
      assert.equal(content, 'new content');
      assert.deepEqual(scopeDirs, ['/repo']);
      assert.equal(opts.baseHash, 'oldhash');
      return { ok: true, contentHash: 'newhash', bytesWritten: 11 };
    },
  });
  let response;
  await handlers.get('files:write')({ relPath: 'src/a.js', content: 'new content', baseHash: 'oldhash' }, value => { response = value; });
  assert.equal(response.ok, true);
  assert.equal(response.contentHash, 'newhash');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'file_write');
  assert.equal(audits[0].outcome, 'success');
});

test('files:write 冲突（非 scope 的失败）→ 记 file_write 审计 outcome=denied，ack 透传 conflict', async () => {
  const { handlers, audits } = register({
    writeFileInScope: () => ({ ok: false, code: 'conflict', error: '文件已被修改，请刷新后重试' }),
  });
  let response;
  await handlers.get('files:write')({ relPath: 'a.js', content: 'x', baseHash: 'stale' }, value => { response = value; });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'conflict');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'file_write');
  assert.equal(audits[0].outcome, 'denied');
  assert.equal(audits[0].meta.code, 'conflict');
});

test('files:write 无 ack 时忽略', async () => {
  const { handlers } = register();
  await handlers.get('files:write')({ relPath: 'a.js', content: 'x', baseHash: 'h' }); // 不抛
});
