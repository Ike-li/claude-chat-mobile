// tests/unit/socket-files.test.mjs —— socket 文件面 handler 的回执形状（不涉范围门）
// 范围门的接线与越界审计是 SCOPE-01，在 tests/invariants/server-file-handlers.test.mjs；这里放不碰红线的功能性回执。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerFileSocketHandlers } from '../../app/src/server/socket-files.js';

function register(extra = {}) {
  const handlers = new Map();
  registerFileSocketHandlers({
    socket: {},
    on: (_socket, event, handler) => handlers.set(event, handler),
    routeCwd: () => '/repo',
    getWorkDirs: () => ['/repo'],
    listDir: () => null,
    browseReadFile: () => null,
    writeFileInScope: () => ({ ok: true, contentHash: 'newhash', bytesWritten: 1 }),
    audit: { recordAudit: () => {} },
    actorFromSocket: () => ({ deviceId: 'd1', via: 'web' }),
    routeInstance: () => null,
    attributePath: () => null,
    rejectableSymlinkComponent: () => false,
    logger: { warn() {} },
    ...extra,
  });
  return { handlers };
}

// 验收 O50：FILE_EDIT=off 时组装根不注入 writeFileInScope（files:write 回「文件编辑未启用」），可 browse:read
// 照样下发 contentHash——前端拿它当「能不能点编辑」的唯一判据，于是给了编辑入口，改完点保存才报错。
test('browse:read：写回不可用（FILE_EDIT=off）时不下发 contentHash；可用时照常', async () => {
  const read = () => ({ content: 'x', truncated: false, totalSize: 1, binary: false, bytesRead: 1, contentHash: 'h' });
  const off = register({ writeFileInScope: undefined, browseReadFile: read });
  let response;
  await off.handlers.get('browse:read')({ cwd: '/repo', relPath: 'a.txt' }, value => { response = value; });
  assert.equal(response.ok, true);
  assert.equal(response.content, 'x');
  assert.equal('contentHash' in response, false, '编辑已关，却给了编辑基线：前端会亮出「编辑」');
  const on = register({ browseReadFile: read });
  await on.handlers.get('browse:read')({ cwd: '/repo', relPath: 'a.txt' }, value => { response = value; });
  assert.equal(response.contentHash, 'h');
});
