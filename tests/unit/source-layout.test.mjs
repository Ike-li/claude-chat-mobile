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
    // config.js 曾在 src/server/ 下，但它是叶子（只 import ops/config-file.js、ops/env-schema.js、
    // shared/data-dir.js），放在 server/ 纯属历史，ops/ 才是叶子运维模块的归属地。
    // 附带效果：scripts/device.js 与 scripts/doctor.js 不再指向 src/server/。注意那条边**本来就是
    // 合法的**——check-import-boundaries.js:13「tests/scripts 不设边界（工具与测试可跨域引用）」、
    // protocol.js:6「工具引用运行时是合法方向」都写着。所以这次搬迁不是在修违规，只是让
    // server-is-sink 的实际引用图变干净了。
    'config.js',
    'doctor-runtime.js',
    'metrics.js',
    'notifications.js',
    'statusline.js',
  ],
  server: [
    'app.js',
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

// VC-D4-02 的接线闸。buildEnvView 少传 shellEnv 时不会报错，只会把每一项都算成「没被覆盖」——
// 与「面板压根没这个功能」在屏幕上完全同形。这类接线洞在本仓只有源码断言抓得到
// （app.js 起真 server，没法在单测里 import 进来问它）。
test('配置面板与安全体检都必须拿到 shell env 快照（少接一根线 = 静默假绿）', () => {
  const source = readFileSync('src/server/app.js', 'utf8');
  assert.match(source, /getShellEnvSnapshot/, 'app.js 必须引入投影前的 shell env 快照');
  assert.match(source, /buildEnvView\([\s\S]{0,80}?shellEnv/,
    'env:get 必须把快照喂给 buildEnvView，否则面板永远显示「没被覆盖」');
  assert.match(source, /runDoctor\(\{[\s\S]{0,800}?shellEnv:/,
    'doctor:run 必须带上快照，否则手机端安全体检看不到 D18（此前它唯一的消费者是维护者 CLI）');
});

// 行数上限已移除：拆分判据是行为域的归属，不是文件尺寸。按尺寸强制拆分会把一个内聚的
// 行为域劈成两半（读一个行为要跨文件），而放任一个多职责文件长到 799 行却一路绿灯——
// 尺寸既不充分也不必要。这里只保留三个曾经的单体不得复活的正向断言。
test('unit tests stay split by behavior domain instead of regrowing monoliths', () => {
  for (const obsolete of ['agent.test.mjs', 'history.test.mjs', 'logic.test.mjs']) {
    assert.equal(existsSync(`tests/unit/${obsolete}`), false, `${obsolete} must remain split`);
  }
});
