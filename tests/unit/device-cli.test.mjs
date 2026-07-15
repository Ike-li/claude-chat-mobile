import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('device CLI reads trusted devices from CCM_DATA_DIR', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccm-device-cli-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, 'trusted-devices.json'), JSON.stringify(['trusted-from-external-data-dir']));

  const result = spawnSync(process.execPath, ['scripts/device.js', 'list'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: { ...process.env, CCM_DATA_DIR: dataDir },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /trusted-from-external-data-dir/);
});
