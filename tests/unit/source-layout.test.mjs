import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

// 行数上限已移除：拆分判据是行为域的归属，不是文件尺寸。按尺寸强制拆分会把一个内聚的
// 行为域劈成两半（读一个行为要跨文件），而放任一个多职责文件长到 799 行却一路绿灯——
// 尺寸既不充分也不必要。这里只保留三个曾经的单体不得复活的正向断言。
test('unit tests stay split by behavior domain instead of regrowing monoliths', () => {
  for (const obsolete of ['agent.test.mjs', 'history.test.mjs', 'logic.test.mjs']) {
    assert.equal(existsSync(`tests/unit/${obsolete}`), false, `${obsolete} must remain split`);
  }
});
