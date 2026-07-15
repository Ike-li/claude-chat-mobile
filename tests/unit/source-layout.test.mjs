import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const layout = {
  agent: [
    'agent.js',
    'approval-store.js',
    'cli-mirror-state.js',
    'cli-settings-defaults.js',
    'interaction-log.js',
    'message-dedup.js',
    'models-cache.js',
  ],
  auth: ['cf-access.js', 'devices.js', 'fingerprint.js', 'rate-limiter.js'],
  files: [
    'file-browse.js',
    'file-preview.js',
    'file-security.js',
    'uploads.js',
    'workdir-scope-guard.js',
  ],
  sessions: ['attention.js', 'history.js', 'sessions.js', 'workdirs.js'],
  ops: [
    'audit.js',
    'cli-statusline-bridge.js',
    'doctor-runtime.js',
    'metrics.js',
    'notifications.js',
    'statusline.js',
  ],
  server: [
    'app.js',
    'config.js',
    'http.js',
    'instance-latches.js',
    'instance-manager.js',
    'instance-routing.js',
    'socket-files.js',
    'socket.js',
  ],
  shared: ['sanitizer.js', 'serial-writer.js'],
};

test('backend domain modules live under src and not in the repository root', () => {
  for (const [domain, files] of Object.entries(layout)) {
    for (const file of files) {
      assert.equal(existsSync(file), false, `${file} must leave the repository root`);
      assert.equal(existsSync(`src/${domain}/${file}`), true, `${file} must live in src/${domain}`);
    }
  }
});

test('root server.js is only a compatibility launcher for src/server/app.js', () => {
  const source = readFileSync('server.js', 'utf8');
  const lines = source.split('\n').filter(line => line.trim() !== '');

  assert.ok(lines.length <= 12, `server.js must stay thin; found ${lines.length} non-empty lines`);
  assert.match(source, /\.\/src\/server\/app\.js/);
  assert.match(source, /loadRuntimeEnvironment\(\)/);
  assert.match(source, /await import\(['"]\.\/src\/server\/app\.js['"]\)/);
  assert.ok(
    source.indexOf('loadRuntimeEnvironment()') < source.indexOf("await import('./src/server/app.js')"),
    '.env must load before the runtime import fixes state-file paths',
  );
  assert.doesNotMatch(source, /export\s*\{[^}]+\}\s*from\s*['"]\.\/src\/server\/app\.js/);
});

test('unit tests stay split by behavior domain instead of regrowing monoliths', () => {
  for (const obsolete of ['agent.test.mjs', 'history.test.mjs', 'logic.test.mjs']) {
    assert.equal(existsSync(`tests/unit/${obsolete}`), false, `${obsolete} must remain split`);
  }

  for (const entry of readdirSync('tests/unit')) {
    if (!entry.endsWith('.test.mjs')) continue;
    const lines = readFileSync(`tests/unit/${entry}`, 'utf8').split('\n').length;
    assert.ok(lines <= 800, `${entry} has ${lines} lines; split it by behavior domain`);
  }
});
