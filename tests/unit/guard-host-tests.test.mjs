// tests/unit/guard-host-tests.test.mjs —— 宿主机破坏性命令钩子的判据测试
//
// 这个钩子判错的两种代价不对称：漏放（该拦没拦）＝ 上次那种删库可能重演；
// 误拦（不该拦却拦）＝ 多按一次确认。所以判据可以偏保守，但【漏放必须逐条钉死】。
//
// 2026-08-03 判据反转：从「列出危险模式」改成「测试域内只放行白名单」。
// 黑名单要求每遇到一个新命令都正确归类，而 8/2 那次事故的失败点正是归类那一步——
// 用黑名单去防归类失败，判据和它自己宣称的原则是反的（CLAUDE.md 讲的一直是白名单）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../tests/gates/guard-host-tests.js';

const blocked = cmd => assert.ok(decide(cmd), `应拦下: ${cmd}`);
const allowed = cmd => assert.equal(decide(cmd), null, `不该拦: ${cmd}`);

// ── 必须拦（漏一个就是上次那种事故的入口）──────────────────────────────────
test('拦: 变异检查——上次删库的直接凶手', () => {
  blocked('npm run mutate -- app/src/sessions/history.js');
  blocked('npm run mutate -- app/src/x.js --limit=25');
  blocked('node tests/gates/mutate.js app/src/x.js');
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

// ★ 白名单反转补上的第一个洞。记忆里明确踩过：直接 `node --test 单文件` 绕过 preload-env，
// 会把 approval-store / audit / devices 的落盘打到【真实 data/】上——那几个模块的路径是
// 模块级常量、在 import 求值那一刻就锁定了，只有 --import 预加载能改。
// 旧黑名单只认 tests/integration，对这条形态恒放行。
test('拦: 裸 node --test 跑单测（没有 preload-env，会写真实 data/）', () => {
  blocked('node --test tests/unit/history-list.test.mjs');
  blocked('node --test tests/unit/agent-core.test.mjs tests/unit/mutate.test.mjs');
});

// ★ 第二个洞：旧实现只要命令里【任何位置】出现 docker 就整条放行，
// 文件头自己都写了 `echo docker && npm run mutate` 能绕过。改成按段判定后不再成立。
test('拦: 借 docker 字样蒙混过关（判定按段做，不看整条命令）', () => {
  blocked('echo docker && npm run mutate -- app/src/x.js');
  blocked('docker ps && npm test');
  blocked('npm run check && npm test');
});

// 域内没见过的形态一律要确认——这正是白名单相对黑名单的全部价值：
// 不需要预先想到它，也不会漏放。
test('拦: 测试域内、但不在白名单上的形态', () => {
  blocked('npm run test:coverage');
  blocked('npm run test:integration -- --only foo');
});

// ★ 第三个洞（2026-08-04 code review 实测）：分段正则 /\|\||&&|[|;\n]/ 里没有【单个 &】，
// 于是 `npm run test:unit & npm run mutate` 整条只有一段；而白名单又只取段内【第一个】
// npm run 脚本名，命中 test:unit 就 return null——8/2 删库那条命令原样放行。
test('拦: 单个 & 背景符不能让后半段蒙混过关', () => {
  blocked('npm run test:unit & npm run mutate -- app/src/sessions/history.js');
  blocked('npm run lint & npm run mutate -- app/src/x.js');
  blocked('npm run check & npm test');
});

// ★ 第四个洞：白名单只认脚本名，完全不看 `--` 之后的参数。npm 会把它们原样追加到
// 命令行，于是白名单脚本可以承载任意非白名单测试文件——而 preload-env.mjs 自己的
// 头注释写明「transcript 目录（~/.claude/projects）不在此隔离」。
test('拦: 借白名单脚本承载非白名单测试路径', () => {
  blocked('npm run test:unit -- tests/integration/session-delete.test.mjs');
  blocked('npm run test:e2e -- tests/integration/foo.test.mjs');
});

// ★ 第五个洞：容器豁免判的是「段内任何位置出现 docker」，于是参数里提一句就整段放行。
test('拦: docker 只在命令头/脚本名里才算进了容器', () => {
  blocked('npm run mutate -- scripts/docker-check.js');
  blocked('npm test -- --test-name-pattern docker');
});

// ★ 第六个洞：isIsolatedUnitRun 只做 startsWith('tests/unit/')，不消解 ..
test('拦: tests/unit/../integration 路径穿越', () => {
  blocked('node --import ./tests/setup/preload-env.mjs --test tests/unit/../integration/session-delete.test.mjs');
});

// ★ 反向代价：域判据在【整段文本】上匹配，不区分命令头与参数，于是只读命令仅仅因为
// 提到某个脚本路径或变量名就被拦。钩子挂在每一次 Bash 上，误拦一次就是一轮人工确认。
test('放行: 只读命令仅仅提到测试脚本名 / 变量名', () => {
  allowed('grep -rn RUN_CLAUDE_INTEGRATION app/src/');
  allowed('git diff -- tests/gates/mutate.js');
  allowed('cat tests/gates/mutate.js');
  allowed('wc -l tests/integration/session-delete.test.mjs');
});

// ── 不该拦（误拦多了就会被嫌烦而关掉，那等于没有）──────────────────────────
test('放行: CLAUDE.md 白名单里的四条', () => {
  allowed('npm run lint');
  allowed('npm run check');
  allowed('npm run test:unit');
  allowed('npm run test:e2e');
  allowed('npm run test:unit 2>&1 | grep fail');
  allowed('npm run check && npm run test:unit');
});

// ★ 命令里出现 docker = 那一段在容器里跑，容器 HOME 是一次性目录，够不到宿主机家目录。
test('放行: 已经走容器的形态', () => {
  allowed('npm run test:docker');
  allowed('npm run test:docker:e2e');
  allowed('npm run test:docker:playground');
  allowed('npm run mutate:docker -- app/src/sessions/history.js');
  allowed('docker compose -f docker-compose.test.yml run --rm test npm run test:integration');
  allowed('docker compose -f docker-compose.playground.yml run --rm probe');
});

test('拦: 宿主机原生 test:playground（必须走 test:docker:playground）', () => {
  blocked('npm run test:playground');
});

// TDD 单文件循环必须留出来，否则「写一个失败测试→最小实现」这一步会被钩子逐次打断，
// 而它带着 preload-env、只碰 tests/unit，隔离与 npm run test:unit 完全同款。
test('放行: 带 preload-env 的单测单文件跑法（TDD 循环）', () => {
  allowed('node --import ./tests/setup/preload-env.mjs --test tests/unit/mutate.test.mjs');
  allowed('node --import ./tests/setup/preload-env.mjs --test tests/unit/a.test.mjs tests/unit/b.test.mjs');
  allowed('node --import ./tests/setup/preload-env.mjs --experimental-test-coverage --test tests/unit/x.test.mjs');
});

test('放行: 与测试无关的日常命令', () => {
  allowed('git status');
  allowed('ls -la');
  allowed('npm run inventory:update');
  allowed('npm run doctor');
  allowed('grep -rn "test" app/src/');
});

test('放行: 空命令 / 非字符串不误判', () => {
  allowed('');
  allowed('   ');
  assert.equal(decide(undefined), null);
  assert.equal(decide(null), null);
});

// test:unit 里含 "test:"，别被前缀匹配误伤——这条是 `npm test` 那个正则最容易写错的地方。
test('边界: test:unit / test:docker 不被 `npm test` 规则误伤', () => {
  allowed('npm run test:unit');
  allowed('npm run test:e2e');
  allowed('npm run test:visual');
});

// 拦下时给的理由要点名到文件和形态：8/2 的根因是归类判断失败，而"包含集成测试那一档"
// 这种抽象说法帮不上归类——看的人还是得自己去查它到底碰什么。
test('理由必须具体到可判断，不是一句「有风险」', () => {
  assert.match(decide('npm test'), /session-delete|~\/\.claude/);
  assert.match(decide('node --test tests/unit/x.test.mjs'), /preload-env/);
  assert.match(decide('npm run mutate -- app/src/x.js'), /改坏/);
});
