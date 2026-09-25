// tests/invariants/server-file-handlers.test.mjs —— socket 文件面 handler 的范围门接线侧
// 守护：SCOPE-01（任何用户可控路径经 realpath 后仍须落在授权工作区内——这一侧管的是「每条
//   进 handler 的路径有没有真的被送进那道门」，以及越界时 fail-closed 且【记审计】；审计的
//   target 记真实落点所属 workdir 而非请求声明的 cwd，R10，2026-08-06：记错归属会让事后追责
//   指向错误的项目）
// 覆盖：browse/read/write/search/git/tool:preview/attachment:read 各自的范围门 · 越界审计的
//   via 标注与归属 · 无 ack 时的静默路径
// 槽位：S1（全部依赖可注入的桩，零 I/O、不起 server、不 spawn claude）
// 不测什么 + 为什么：不测范围判据本身（realpath 后的前缀比较属纯函数侧，在
//   tests/invariants/workdir-scope-guard.test.mjs）；不测真组装根上的端到端（起真 server，
//   属 S2 的 tests/invariants/server/files-scope.test.mjs）。三份各守一层，缺哪层都补不上另一层。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUT_OF_SCOPE_ERROR, registerFileSocketHandlers } from '../../app/src/server/socket-files.js';
import { attributePath as realAttributePath } from '../../app/src/files/file-preview.js';
// R10 归属断言用真实 attributePath（纯函数、零 I/O）：手写 stub 曾把契约编错——它对 relPath 直接看
// 前缀，而真实实现先 resolve(cwd, relPath)，于是测试与实现互相印证、恒绿。

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

// 显式越界的 cwd（routeCwd 判 null，SCOPE-05 起不再回落查看目录）：每个走 routeCwd 的文件事件都要
// 明确拒绝、不碰盘、不跑 git。ok 必须是 false——前端按 ok 分支，ok:true 带 error 会被当成一次空结果画出来。
test('显式越界 cwd（routeCwd → null）：八个文件事件一律 ok:false 并说明原因，不读盘、不跑 git', async () => {
  const touched = [];
  const spy = name => () => { touched.push(name); return null; };
  const { handlers } = register({
    routeCwd: () => null,
    listDir: spy('listDir'),
    browseReadFile: spy('browseReadFile'),
    locateStoredAttachment: spy('locateStoredAttachment'),
    listGitChanges: spy('listGitChanges'),
    readGitDiff: spy('readGitDiff'),
    listGitBranches: spy('listGitBranches'),
    searchFiles: spy('searchFiles'),
    writeFileInScope: spy('writeFileInScope'),
  });
  const cases = [
    ['browse:list', { cwd: '/elsewhere', relPath: '.' }],
    ['browse:read', { cwd: '/elsewhere', relPath: 'a.txt' }],
    ['attachment:read', { cwd: '/elsewhere', storedName: '1700000000-abcd1234-a.png' }],
    ['git:status', { cwd: '/elsewhere' }],
    ['git:branches', { cwd: '/elsewhere' }],
    ['git:diff', { cwd: '/elsewhere', path: 'a.js' }],
    ['files:search', { cwd: '/elsewhere', query: 'a' }],
    ['files:write', { cwd: '/elsewhere', relPath: 'a.txt', content: 'x', baseHash: null }],
  ];
  for (const [event, payload] of cases) {
    let response;
    await handlers.get(event)(payload, value => { response = value; });
    assert.deepEqual(response, { ok: false, error: OUT_OF_SCOPE_ERROR }, event);
  }
  assert.deepEqual(touched, [], '判了越界还去读盘 / 跑 git');
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
      assert.equal(path, 'app/src/a.js');
      assert.equal(side, 'staged');
      return { ok: true, path, side, patch: '+hi', binary: false, truncated: false, empty: false };
    },
  });
  let response;
  await handlers.get('git:diff')({ path: 'app/src/a.js', side: 'staged' }, value => { response = value; });
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
      return ['app/src/app.js'];
    },
  });
  let response;
  await handlers.get('files:search')({ query: 'app', limit: 5 }, value => { response = value; });
  assert.equal(response.ok, true);
  assert.deepEqual(response.paths, ['app/src/app.js']);
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
      assert.equal(relPath, 'app/src/a.js');
      assert.equal(content, 'new content');
      assert.deepEqual(scopeDirs, ['/repo']);
      assert.equal(opts.baseHash, 'oldhash');
      return { ok: true, contentHash: 'newhash', bytesWritten: 11 };
    },
  });
  let response;
  await handlers.get('files:write')({ relPath: 'app/src/a.js', content: 'new content', baseHash: 'oldhash' }, value => { response = value; });
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

// R10（2026-08-06 BUG hunting review）：审计归属。
// scopeDirsFor 返回全量 workDirs（n=1 下用户即 root，跨 workdir 的 relPath 不构成越权，是有意的宽 scope），
// 但审计把 target 记成【请求声明的 cwd】——文件实际落在另一个 workdir 时，事后查「谁动过 B 项目的文件」
// 会显示 A。安全性不变，修的是审计准确性：target 必须是真实落点所属的 workdir。
test('R10：files:write 落到别的 workdir 时，审计 target 记真实落点而非声明的 cwd', async () => {
  const { handlers, audits } = register({
    getWorkDirs: () => ['/repo', '/other'],
    // 声明 cwd=/repo，relPath 指向 /other —— 宽 scope 下写入成功
    writeFileInScope: () => ({ ok: true, contentHash: 'h', bytesWritten: 3 }),
    attributePath: realAttributePath,
  });
  let response;
  await handlers.get('files:write')({ cwd: '/repo', relPath: '../other/x.txt', content: 'abc' }, v => { response = v; });

  assert.equal(response.ok, true, '宽 scope 是有意的，不改行为');
  const entry = audits.find(a => a.action === 'file_write');
  assert.ok(entry, '成功写入必须留审计');
  assert.equal(entry.target, '/other', '审计要指向真实落点所属工作区');
  assert.equal(entry.meta.declaredCwd, '/repo', '声明的 cwd 保留在 meta 里供对照');
});

test('R10b：落点就在声明 cwd 内时，审计 target 不变（不制造无谓差异）', async () => {
  const { handlers, audits } = register({
    getWorkDirs: () => ['/repo', '/other'],
    attributePath: realAttributePath,
  });
  await handlers.get('files:write')({ cwd: '/repo', relPath: 'a.txt', content: 'abc' }, () => {});

  const entry = audits.find(a => a.action === 'file_write');
  assert.equal(entry.target, '/repo');
  assert.equal(entry.meta.declaredCwd, undefined, '同区时不加冗余字段');
});

// tool:preview 此前只有「实例不存在」这个形状分支有断言（不属于安全闸，只是找不到目标）。
// 真正的安全闸——inWhitelist:false 的两条拒绝路径（白名单外 / 可疑符号链接分量）——零测试覆盖，
// 也就是说这道闸此刻是不是真的在拦、还是被谁手滑改坏了，除了读代码没有第二种办法知道。
test.describe('tool:preview 安全闸', () => {
  function fakeAgent(overrides = {}) {
    return {
      cwd: '/repo',
      getToolInput: () => ({ name: 'Edit', input: { file_path: '/repo/a.js' } }),
      ...overrides,
    };
  }

  test('路径不在白名单工作目录内 → inWhitelist:false，不落 attribution', async () => {
    const { handlers } = register({
      routeInstance: () => fakeAgent(),
      attributePath: () => null, // 与 register() 默认值一致，这里显式写出以强调这条正是被测分支
    });
    let response;
    await handlers.get('tool:preview')({ instanceId: 'i1', toolUseId: 't1' }, v => { response = v; });
    assert.equal(response.ok, false);
    assert.equal(response.inWhitelist, false);
    assert.match(response.error, /白名单/);
  });

  test('路径含可疑符号链接分量 → inWhitelist:false，即使 attributePath 本身放行', async () => {
    const { handlers } = register({
      routeInstance: () => fakeAgent(),
      attributePath: () => ({ resolved: '/repo/a.js', workDir: '/repo', relPath: 'a.js' }),
      rejectableSymlinkComponent: () => true,
    });
    let response;
    await handlers.get('tool:preview')({ instanceId: 'i1', toolUseId: 't1' }, v => { response = v; });
    assert.equal(response.ok, false);
    assert.equal(response.inWhitelist, false);
    assert.match(response.error, /符号链接/);
  });

  test('正对照：白名单内且无符号链接 → 正常返回预览', async () => {
    const { handlers } = register({
      routeInstance: () => fakeAgent(),
      attributePath: () => ({ resolved: '/repo/a.js', workDir: '/repo', relPath: 'a.js' }),
      rejectableSymlinkComponent: () => false,
      buildDiff: () => 'diff-text',
    });
    let response;
    await handlers.get('tool:preview')({ instanceId: 'i1', toolUseId: 't1' }, v => { response = v; });
    assert.equal(response.ok, true);
    assert.equal(response.inWhitelist, true);
    assert.equal(response.diff, 'diff-text');
  });
});

// attachment:read 同样只测过「预览不可用」（功能未注入）这个形状分支。
// isBareStoredName 是这里唯一的第一道闸（拒绝带路径分隔符/以 . 开头的输入），第二道闸是
// browseReadFile 返回 null（scope 内定位到了文件，但实际读取时发现真实落点越界，例如符号链接）。
test.describe('attachment:read 安全闸', () => {
  test('storedName 不是裸文件名（含路径分隔符）→ 拒绝且记 scope_violation 审计', async () => {
    // 真实 locateStoredAttachment 对这类输入本就定位不到（裸名校验在它内部，这里桩出同样的
    // "找不到"结果）——handler 自己另外再用 isBareStoredName 判断这次落空要不要记审计。
    const { handlers, audits } = register({
      locateStoredAttachment: () => null,
      browseReadFile: () => { throw new Error('不该被调用：locateStoredAttachment 已经落空'); },
    });
    let response;
    await handlers.get('attachment:read')({ storedName: '../evil.png' }, v => { response = v; });
    assert.equal(response.ok, false);
    assert.match(response.error, /不存在或已被删除/);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'scope_violation');
    assert.equal(audits[0].meta.via, 'attachment:read');
  });

  test('定位到文件，但实际读取时判定越界（如符号链接）→ 拒绝，不当作"文件不存在"以外的信息泄露', async () => {
    const { handlers } = register({
      locateStoredAttachment: () => ({ baseDir: '/data/uploads', storedName: 'x.png', scopeDirs: ['/data/uploads'] }),
      browseReadFile: () => null, // 定位成功但读取阶段判越界
    });
    let response;
    await handlers.get('attachment:read')({ storedName: 'x.png' }, v => { response = v; });
    assert.equal(response.ok, false);
    assert.match(response.error, /不存在或已被删除/);
  });

  test('正对照：裸文件名且定位/读取都成功 → 正常返回内容', async () => {
    const { handlers } = register({
      locateStoredAttachment: () => ({ baseDir: '/data/uploads', storedName: 'x.png', scopeDirs: ['/data/uploads'] }),
      browseReadFile: () => ({ content: 'base64==', binary: true }),
    });
    let response;
    await handlers.get('attachment:read')({ storedName: 'x.png' }, v => { response = v; });
    assert.equal(response.ok, true);
    assert.equal(response.content, 'base64==');
  });
});
