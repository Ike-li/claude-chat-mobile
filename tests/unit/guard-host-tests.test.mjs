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
import { decide, decideRoute } from '../../tests/gates/guard-host-tests.js';

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
  // 用一个【不存在的脚本名】而不是某条具体脚本：白名单的语义就是「名单外一律拦」，
  // 拿具体脚本当例子的话，那条脚本哪天进了名单，这个用例就跟着失效
  // （2026-09-11 就是这么红的：test:coverage 被认定与 test:unit 同档、进了白名单）。
  blocked('npm run test:whatever');
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

// 白名单靠精确相等匹配，而这三个脚本名只差一个后缀。脚本名捕获的字符类一旦漏掉 `:`
// 就会把 test:invariants:env 截成 test:invariants 命中白名单 —— 洞开在「看起来更严格」的方向上，不会有人察觉。
test('边界: test:invariants 放行，但 test:invariants:env / test:invariants:server 必须拦下（只差后缀）', () => {
  allowed('npm run test:invariants');
  blocked('npm run test:invariants:server');   // 起真 app/server.js 子进程
  blocked('npm run test:invariants:env');      // 跑卸载器：隔离依赖被测代码认注入的 home/root/appPath
});

// ★ 第七个洞：SCRIPT_TEST_SCOPE['test:invariants'] 的允许前缀是 'tests/invariants/'，
// 而 env/、server/ 子目录同样以这个前缀开头——`test:invariants:env`/`:server` 脚本名会被拦，
// 但借道裸 `test:invariants` 脚本 + `-- tests/invariants/env/...` 参数就能绕过，
// 落进和上面那条一模一样的洞：卸载器 / 真 server 子进程在宿主机上被跑起来。
test('拦: 借 test:invariants 脚本名 + -- 参数点名 env/server 子目录', () => {
  blocked('npm run test:invariants -- tests/invariants/env/uninstall-symmetry.test.mjs');
  blocked('npm run test:invariants -- tests/invariants/server/auth-gate.test.mjs');
  allowed('npm run test:invariants -- tests/invariants/mirror-engine.test.mjs'); // 顶层用例仍放行
});

// ★ 第八个洞：切段正则拿字面换行符当分隔符，而 shell 的反斜杠续行（`\` 紧跟换行）会被真实
// shell 整体拼接成同一逻辑行。不折叠就先切段，会把 `-- ` 之后的测试目标切进独立的下一段——
// 第一段找不到测试路径、附加参数为空直接放行；第二段命令头是裸路径，不是解释器，也放行。
test('拦: 反斜杠续行拼出的命令不能靠字面换行绕开 scope 检查', () => {
  blocked('npm run test:unit -- \\\ntests/integration/session-delete.test.mjs');
  blocked('npm run test:invariants -- \\\ntests/invariants/server/auth-gate.test.mjs');
  // 真正的两条独立命令（行尾没有反斜杠）必须继续被切开、各自判定，不能因为折叠而被误合并放行。
  blocked('npm run test:unit\nnpm run mutate -- app/src/x.js');
});

// ★ 第九个洞（上面第七个洞的 deny 前缀被 glob 直接绕过）：testTargets 的字符类 [\w./-] 不含
// glob 元字符，所以 `tests/invariants/e*/uninstall-symmetry.test.mjs` 在正则那里就被截断成
// `tests/invariants/e`——它满足 allow 前缀、又不以任何 deny 前缀开头，于是整条放行，
// 而真实 shell 展开出来的恰恰是 tests/invariants/env/uninstall-symmetry.test.mjs：那条跑的是
// 卸载器，隔离依赖被测代码认注入的 home/root/appPath，回落就打在真实家目录上（8/2 同形态）。
// 被 glob 截断的目标拿到的只是【前缀】，它的展开面是「所有以它开头的路径」，与 deny 前缀
// 互为前缀就可能命中，两个方向都要判。
test('拦: glob 截断出的前缀不能绕过 deny 子目录（e*/ 展开成 env/、s*/ 展开成 server/）', () => {
  blocked('npm run test:invariants -- tests/invariants/e*/uninstall-symmetry.test.mjs');
  blocked('npm run test:invariants -- tests/invariants/s*/*.test.mjs');
  blocked('npm run test:invariants -- tests/invariants/{env,server}/x.test.mjs');
  // 目录整体 glob（`tests/unit/*.test.mjs`）本就被拦，且与本次修法无关：normalizeRel 会剥掉
  // 尾斜杠，`tests/unit` 不满足 startsWith('tests/unit/')。等价写法 `npm run test:unit`（不带
  // -- 参数）照常放行，所以这条既不碍事也是 fail-closed 方向，一并钉住防止被当成误报"修"开。
  blocked('npm run test:unit -- tests/unit/*.test.mjs');
  blocked('npm run test:invariants -- tests/invariants/*/*.test.mjs');
  // 合法的 glob 跑法不能被误伤：展开面整体落在 allow 前缀内、与 deny 前缀无交集。
  // 误拦会让这道闸被嫌吵而绕开，那等于没有闸。
  allowed('npm run test:unit -- tests/unit/logic-*.test.mjs');
  allowed('npm run test:invariants -- tests/invariants/mirror-*.test.mjs');
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
  allowed('npm run inventory:check');
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

// ── deny / ask 分档 ────────────────────────────────────────────────────────
//
// 【这组测试守的是什么】ask 会把会话停在那里等人点确认。对「跑一段长任务、人不在跟前」的用法，
// 那等于任务卡死。而这些命令本来就有等价的容器跑法——agent 收到拒绝理由后自己换一条继续即可。
// 所以分档判据是「有没有容器替代」，不是「危不危险」：危险的照样 deny，只要换个地方能跑。
import { readFileSync as _rf } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const PKG = JSON.parse(_rf(new URL('../../package.json', import.meta.url), 'utf8'));

test.describe('决策分档', () => {
  const DENY = [
    ['npm test', 'test:docker'],
    ['npm run test:integration', 'test:docker:integration'],
    ['npm run test:invariants:server', 'test:docker:invariants'],
    ['npm run test:invariants:env', 'test:docker:invariants'],
    ['npm run mutate -- app/src/x.js', 'mutate:docker'],
    ['node --test tests/integration/server.test.mjs', 'test:docker'],
  ];

  for (const [cmd, expectScript] of DENY) {
    test(`deny + 指路: ${cmd}`, () => {
      const r = decideRoute(cmd);
      assert.equal(r?.decision, 'deny', `应 deny（agent 自己换命令，不找人）：${cmd}`);
      assert.ok(r.alternative?.includes(expectScript),
        `替代命令应指向 ${expectScript}，实际：${r.alternative}`);
    });
  }

  // ★ 最容易悄悄失效的一条：改了脚本名或删了脚本，钩子照样给出那条命令，
  //   agent 照着敲 → "Missing script" → 它不知道该怎么办，只能回头找人。
  test('每条替代命令指向的 npm 脚本都真实存在', () => {
    for (const [cmd] of DENY) {
      const alt = decideRoute(cmd).alternative;
      const script = /npm run ([\w:.-]+)/.exec(alt)?.[1];
      assert.ok(script, `替代命令里没有可识别的 npm 脚本：${alt}`);
      assert.ok(PKG.scripts[script], `package.json 里没有 ${script}（钩子在指一条不存在的路）`);
    }
  });

  test('要人决定的三档仍然 ask——真 turn 与 smoke 要真凭据，验收起 E3 花机主额度，只有人能决定要不要花', () => {
    for (const cmd of ['npm run test:smoke', 'RUN_CLAUDE_INTEGRATION=1 npm test', 'node tests/acceptance/env/up.mjs --env E3 --yes']) {
      assert.equal(decideRoute(cmd)?.decision, 'ask', cmd);
    }
  });

  test('放行的命令 decideRoute 返回 null', () => {
    for (const cmd of ['npm run test:unit', 'npm run check', 'npm run test:docker', 'git status']) {
      assert.equal(decideRoute(cmd), null, cmd);
    }
  });
});

// 验收套件真正开始花额度的是起 E3 系环境：那是真 claude CLI 容器，机主网关凭据会复制进去，
// 此后在里面跑的每个回合都消耗真实额度。run.mjs 选中 C 档只列清单、不执行，所以闸在 up.mjs 上。
// up.mjs 缺省 --env 是 E1,E2、不带 --yes 只打印——这两条是每次改完都会跑的，钩子必须静默。
test.describe('验收套件：起 E3 系环境 ask，其余不命中', () => {
  const UP = 'node tests/acceptance/env/up.mjs';

  test('--env 含 E3 / E3proxy / E3cf / all 且带 --yes → ask，理由点名到额度', () => {
    for (const args of [
      '--env E3 --yes',
      '--env E3proxy --yes',
      '--env E3cf --yes',
      '--env all --yes',
      '--env E1,E2,E3 --yes',
      '--yes --env E2反代,E3cf',
      '--env E3 --target ../ccm-under-test --ref worktree --build --yes',
      // 多次 --env：up.mjs 取最后一次，钩子不替它算，任何一次含 E3 系就按选中处理
      '--env E3 --env E1 --yes',
      // up.mjs 现在不认 --env= 与小写（报错退出），钩子不替它担保，按选中处理——误判只多一次确认
      '--env=E3 --yes',
      '--env e3 --yes',
    ]) {
      const r = decideRoute(`${UP} ${args}`);
      assert.equal(r?.decision, 'ask', `起 E3 系环境必须问人：${UP} ${args}`);
      assert.match(r.why, /额度/, `理由要说出代价：${UP} ${args}`);
    }
    assert.equal(decideRoute(`CI=1 node ./tests/acceptance/env/up.mjs --env E3 --yes`)?.decision, 'ask');
  });

  test('缺省 --env、只起 E1/E2、不带 --yes（只打印）→ null', () => {
    for (const args of ['', '--yes', '--env E1,E2 --yes', '--env E1 --yes', '--env E2反代 --yes',
      '--env E3', '--env all', '--env E3proxy --dry-run', '--env E1,E2 --target ../E3 --yes']) {
      assert.equal(decideRoute(`${UP} ${args}`.trim()), null, `不该拦：${UP} ${args}`);
    }
    // 收环境不花额度：SKILL 每轮末尾都让 agent 跑这一条，误拦就是每轮一次人工往返
    assert.equal(decideRoute('node tests/acceptance/env/down.mjs --env all --yes'), null, '收环境被当成了起环境');
    // 只读命令提到 up.mjs 与那几个参数，命令头不是解释器 → 不归钩子管
    assert.equal(decideRoute('grep -n -- "--env E3 --yes" tests/acceptance/env/up.mjs'), null, '只读命令不归钩子管');
    assert.equal(decideRoute('cat tests/acceptance/env/up.mjs'), null, '只读命令不归钩子管');
  });

  // shell 在执行前就剥掉引号与反斜杠、/./ 与 // 不改变路径——这些写法跑的都是同一条命令，
  // 钩子按字面匹配的话每种都要单独想到，那又回到了「每种写法都要正确归类」的老路。
  test('引号、反斜杠、./ 与 // 路径、先 cd 再跑 → 照样 ask', () => {
    for (const cmd of [
      `${UP} --env "E3" --yes`,
      `${UP} --env 'E1,E3proxy' --yes`,
      '"node" "tests/acceptance/env/up.mjs" "--env" "E3" "--yes"',
      `${UP} --env E3 --y\\es`,
      `${UP} --env \\E3cf --yes`,
      'node ./tests/./acceptance/./env/up.mjs --env E3 --yes',
      'node tests//acceptance//env//up.mjs --env all --yes',
      'cd tests/acceptance/env && node up.mjs --env E3 --yes',
      'cd tests/acceptance/env; CI=1 node ./up.mjs --env all --yes',
      `cd "tests/acceptance/./env" && node 'up.mjs' --env E3 --yes`,
      'cd tests/acceptance && node env/up.mjs --env E3 --yes',
      'node tests/acceptance/lib/../env/up.mjs --env E3 --yes',
    ]) {
      assert.equal(decideRoute(cmd)?.decision, 'ask', `换个写法也是起 E3：${cmd}`);
    }
  });

  test('规整不只给 E3 用：拿引号、反斜杠拆开的测试命令照样 deny', () => {
    for (const cmd of [
      'npm run "mutate" -- app/src/x.js',
      "npm run 'test:integration'",
      'n\\pm test',
      "'node' --test tests/unit/x.test.mjs",
    ]) {
      assert.equal(decideRoute(cmd)?.decision, 'deny', `换个写法也该拦：${cmd}`);
    }
  });

  test('run.mjs 选中 C 档只列清单、不执行 → null', () => {
    const RUN = 'node tests/acceptance/run.mjs';
    for (const args of ['--tier C', '--tier=A,C', '--list --tier C', '--cases AC-01-01 --tier C']) {
      assert.equal(decideRoute(`${RUN} ${args}`), null, `不该拦：${RUN} ${args}`);
    }
  });
});

// 一条命令里几段各有各的去向：deny 段有容器跑法、agent 自己换；ask 段要人花钱。旧实现拿整条命令
// 去比 NEEDS_HUMAN，只要任何位置出现一处就整条 ask——于是 mutate 拼在 smoke 后面也去找人点确认，
// 人点了「允许」，mutate 就在宿主机上跑了。现在按段判：有一段该 deny 整条就 deny，全是 ask 段才 ask。
test.describe('按段判定：任何一段该 deny 整条就 deny，全部触发段都要人才 ask', () => {
  const UP_E3 = 'node tests/acceptance/env/up.mjs --env E3 --yes';
  const scriptOf = alt => /npm run ([\w:.-]+)/.exec(alt ?? '')?.[1];

  test('mutate / npm test 与要人的段拼在同一条 → deny，替代命令按 deny 那一段给', () => {
    for (const [cmd, script] of [
      [`npm run mutate -- app/src/x.js && ${UP_E3}`, 'mutate:docker'],
      [`${UP_E3} && npm run mutate -- app/src/x.js`, 'mutate:docker'],
      [`${UP_E3}; npm test`, 'test:docker'],
      [`npm test & ${UP_E3}`, 'test:docker'],
      ['RUN_CLAUDE_INTEGRATION=1 npm test && npm run mutate -- app/src/x.js', 'mutate:docker'],
      ['npm run test:smoke; npm run test:integration', 'test:docker:integration'],
      // 替代命令看的是 deny 那一段：旧实现拿整条命令去比，前面一段的 e2e 字样把它带到了 test:docker:e2e
      ['npm run test:e2e && npm test', 'test:docker'],
    ]) {
      const r = decideRoute(cmd);
      assert.equal(r?.decision, 'deny', `有一段能换容器跑，整条就该 deny 让 agent 自己换：${cmd}`);
      assert.equal(scriptOf(r.alternative), script, `替代命令应指向 deny 那一段的容器跑法：${cmd} → ${r.alternative}`);
    }
  });

  test('同一段里 NEEDS_HUMAN 优先：RUN_CLAUDE_INTEGRATION=1 npm test 仍是 ask', () => {
    assert.equal(decideRoute('RUN_CLAUDE_INTEGRATION=1 npm test')?.decision, 'ask');
    assert.equal(decideRoute('npm run check && RUN_CLAUDE_INTEGRATION=1 npm test 2>&1 | tail')?.decision, 'ask');
  });

  test('几段都要人 → ask，每一段的理由都列给人看', () => {
    const r = decideRoute(`npm run test:smoke && ${UP_E3}`);
    assert.equal(r?.decision, 'ask');
    assert.match(r.why, /冒烟/, '漏了 smoke 那一段的代价');
    assert.match(r.why, /up\.mjs/, '漏了起 E3 那一段的代价');
  });
});

// ask 的提示文案是人做决定时看到的全部依据，代价说错了人就没法判断：真 turn 与 smoke 是「要真凭据、
// 容器里跑不了」；验收起 E3 本来就在容器里跑，代价是机主的真实额度。两种说成同一句，总有一种是错的。
// 走真实 stdin 路径（与 .claude/settings.json 里的调用同形），验的是钩子实际写给 Claude Code 的输出。
test.describe('钩子输出：ask 的提示按代价分开写', () => {
  const HOOK = fileURLToPath(new URL('../../tests/gates/guard-host-tests.js', import.meta.url));
  const runHook = command => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8',
    });
    assert.equal(r.status, 0, `钩子自己不该失败：${r.stderr}`);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };

  test('真 turn 与 smoke：要真凭据、容器替代不了', () => {
    for (const cmd of ['npm run test:smoke', 'RUN_CLAUDE_INTEGRATION=1 npm test']) {
      const out = runHook(cmd);
      assert.equal(out?.permissionDecision, 'ask', cmd);
      assert.match(out.permissionDecisionReason, /容器替代不了/, `没说出换容器也不行：${cmd}`);
      assert.match(out.permissionDecisionReason, /真凭据/, `没说出要真凭据：${cmd}`);
      assert.doesNotMatch(out.permissionDecisionReason, /机主/, `这一档不是在容器里花机主额度：${cmd}`);
    }
  });

  test('验收起 E3：在容器里跑、花的是机主的真实额度，不说成「容器里跑不了」', () => {
    const out = runHook('node tests/acceptance/env/up.mjs --env E3 --yes');
    assert.equal(out?.permissionDecision, 'ask');
    assert.match(out.permissionDecisionReason, /在容器里跑/);
    assert.match(out.permissionDecisionReason, /机主的真实额度/);
    assert.doesNotMatch(out.permissionDecisionReason, /容器替代不了|容器里跑不了/, '它本来就在容器里跑');
  });

  test('两种代价拼在一条里，两句都要出现', () => {
    const r = runHook('npm run test:smoke && node tests/acceptance/env/up.mjs --env E3 --yes').permissionDecisionReason;
    assert.match(r, /真凭据/);
    assert.match(r, /机主的真实额度/);
  });

  test('放行的命令不写任何输出', () => {
    assert.equal(runHook('npm run test:unit'), null);
    assert.equal(runHook('node tests/acceptance/env/up.mjs --env E1,E2 --yes'), null);
  });
});

test.describe('test:coverage 与 test:unit 同档', () => {
  test('放行', () => {
    assert.equal(decide('npm run test:coverage'), null);
  });

  // scope 与白名单必须成对：只加白名单不加 scope，就能借道跑集成用例。
  test('但 -- 点名 tests/unit 之外的文件仍被拦', () => {
    assert.ok(decide('npm run test:coverage -- tests/integration/session-delete.test.mjs'));
  });
});

// 2026-10-19 补的四个缺口：前三个是漏放（该拦没拦 / 该问没问），第四个是误拦。
test.describe('补缺口：直接跑测试文件、smoke runner、export 写法、--test-only', () => {
  // 不带 --test 也会执行：node:test 的用例文件被直接 node 起来照样跑完，同样绕过 preload-env
  test('不带 --test 直接 node 测试文件 → deny；带 preload-env 的单测、--check 语法检查 → 放行', () => {
    for (const cmd of [
      'node tests/integration/session-delete.test.mjs',
      'node tests/unit/history-list.test.mjs',
      'node --test-name-pattern=x tests/unit/history-list.test.mjs',
      // 写在脚本之后的 --check 是传给脚本的参数，node 照样执行这个文件
      'node tests/unit/history-list.test.mjs --check',
      'node tests/integration/session-delete.test.mjs --check',
    ]) assert.equal(decideRoute(cmd)?.decision, 'deny', `该拦：${cmd}`);
    allowed('node --import ./tests/setup/preload-env.mjs tests/unit/history-list.test.mjs');
    allowed('node --check tests/unit/history-list.test.mjs');
  });

  // smoke 的 ask 原先只认 npm 脚本名，直接跑 runner 照样花额度却一声不吭
  test('直接跑 smoke runner 的 --all / --scenario → ask；只 --list → 放行', () => {
    for (const cmd of [
      'node tests/smoke/runner.js --all',
      'node tests/smoke/runner.js --scenario core',
      'cd tests/smoke && node runner.js --scenario upload',
    ]) {
      const r = decideRoute(cmd);
      assert.equal(r?.decision, 'ask', `该问：${cmd}`);
      assert.deepEqual(r.costs, ['credentials']);
    }
    assert.equal(decideRoute('node tests/smoke/runner.js --list'), null);
  });

  // 按段判定后，变量在前一段 export、npm test 在后一段，原先判成 deny 并指去 test:docker——
  // 容器里没有真凭据，那条替代命令跑不了真 turn
  test('export RUN_CLAUDE_INTEGRATION=1 再跑 npm test → ask；没 export 的提及 → 仍 deny', () => {
    assert.equal(decideRoute('export RUN_CLAUDE_INTEGRATION=1 && npm test')?.decision, 'ask');
    assert.equal(decideRoute('export CI=true RUN_CLAUDE_INTEGRATION=1; npm run test:integration')?.decision, 'ask');
    assert.equal(decideRoute('echo RUN_CLAUDE_INTEGRATION && npm test')?.decision, 'deny');
    assert.equal(decideRoute('export RUN_CLAUDE_INTEGRATION=0 && npm test')?.decision, 'deny');
  });

  test('--test-only 这类以 --test 开头的别的参数不算在跑测试', () => {
    allowed('node scripts/app-build.js --test-only');
    blocked('node --test tests/unit/history-list.test.mjs');
  });
});
