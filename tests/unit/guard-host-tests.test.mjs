// tests/unit/guard-host-tests.test.mjs —— 宿主机破坏性命令钩子的判据测试
//
// 这个钩子判错的两种代价不对称：漏放（该拦没拦）＝ 上次那种删库可能重演；
// 误拦（不该拦却拦）＝ 多按一次确认。所以判据可以偏保守，但【漏放必须逐条钉死】。
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../scripts/guard-host-tests.js';

const blocked = cmd => assert.ok(decide(cmd), `应拦下: ${cmd}`);
const allowed = cmd => assert.equal(decide(cmd), null, `不该拦: ${cmd}`);

// ── 必须拦（漏一个就是上次那种事故的入口）──────────────────────────────────
test('拦: 变异检查——上次删库的直接凶手', () => {
  blocked('npm run mutate -- src/sessions/history.js');
  blocked('npm run mutate -- src/x.js --limit=25');
  blocked('node scripts/mutate.js src/x.js');
});

test('拦: 集成测试（起真 server + spawn claude，且有用例按设计操作真实 ~/.claude）', () => {
  blocked('npm run test:integration');
  blocked('npm run test:integration 2>&1 | grep pass');
});

test('拦: npm test（它包含集成那一档）', () => {
  blocked('npm test');
  blocked('npm t');
  blocked('CI=true npm test');
});

test('拦: 真 turn 与冒烟（消耗真实额度）', () => {
  blocked('RUN_CLAUDE_INTEGRATION=1 npm test');
  blocked('npm run test:smoke -- --scenario core');
});

test('拦: 绕开 npm 脚本直接跑集成测试文件', () => {
  blocked('node --test tests/integration/session-delete.test.mjs');
  blocked('node --import ./tests/setup/preload-env.mjs --test tests/integration/foo.test.mjs');
});

// ── 不该拦（误拦多了就会被嫌烦而关掉，那等于没有）──────────────────────────
test('放行: CLAUDE.md 白名单里的三条', () => {
  allowed('npm run lint');
  allowed('npm run check');
  allowed('npm run test:unit');
  allowed('npm run test:unit 2>&1 | grep fail');
});

// ★ 命令里出现 docker = 已经在容器里跑，容器 HOME 是一次性目录，够不到宿主机家目录。
test('放行: 已经走容器的形态', () => {
  allowed('npm run test:docker');
  allowed('npm run test:docker:e2e');
  allowed('npm run mutate:docker -- src/sessions/history.js');
  allowed('docker compose -f docker-compose.test.yml run --rm test npm run test:integration');
});

test('放行: 与测试无关的日常命令', () => {
  allowed('git status');
  allowed('ls -la');
  allowed('node --test tests/unit/history-list.test.mjs');
  allowed('npm run inventory:update');
});

test('放行: 空命令 / 非字符串不误判', () => {
  allowed('');
  allowed('   ');
  assert.equal(decide(undefined), null);
  assert.equal(decide(null), null);
});

// test:unit 里含 "test:"，别被前缀匹配误伤——这条是 npm test 那个正则最容易写错的地方。
test('边界: test:unit / test:docker 不被 `npm test` 规则误伤', () => {
  allowed('npm run test:unit');
  allowed('npm run test:e2e');
  allowed('npm run test:visual');
});
