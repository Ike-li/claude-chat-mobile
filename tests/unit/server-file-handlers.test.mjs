import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerFileSocketHandlers } from '../../src/server/socket-files.js';

test('file socket handlers fail closed and audit out-of-scope browse requests', async () => {
  const handlers = new Map();
  const audits = [];
  registerFileSocketHandlers({
    socket: {},
    on: (_socket, event, handler) => handlers.set(event, handler),
    routeCwd: () => '/repo',
    getWorkDirs: () => ['/repo'],
    listDir: () => null,
    browseReadFile: () => null,
    audit: { recordAudit: entry => audits.push(entry) },
    actorFromSocket: () => ({ deviceId: 'd1', via: 'web' }),
    routeInstance: () => null,
    attributePath: () => null,
    rejectableSymlinkComponent: () => false,
    buildDiff: () => null,
    readPreview: () => null,
    logger: { warn() {} },
  });

  let response;
  await handlers.get('browse:list')({ cwd: '/repo', relPath: '../outside' }, value => { response = value; });

  assert.deepEqual(response, { ok: false, error: '路径不在授权范围内，或不是目录' });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'scope_violation');
  assert.equal(audits[0].meta.via, 'browse:list');
});
