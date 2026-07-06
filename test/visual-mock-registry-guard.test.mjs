import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('visual mock registry guard rejects test command fallbacks after registry dispatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-visual-mock-guard-'));
  const fixture = join(dir, 'visual-mock-server.js');
  writeFileSync(fixture, `
    if (cmd.startsWith('test:')) {
      if (await scenarioRegistry.run(cmd, { activeInst, requestedModel })) return;
      if (cmd === 'test:new-fallback') {
        socket.emit('agent:event', { type: 'system', payload: {} });
      }
    }
  `);

  try {
    assert.throws(
      () => execFileSync(process.execPath, ['scripts/check-visual-mock-registry.js', fixture], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      }),
      error => {
        assert.equal(error.status, 1);
        assert.match(error.stderr, /test:new-fallback/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
