// tests/unit/check-destructive-deletes.test.mjs —— 破坏性删除门禁自身的测试
//
// 这条闸是为了防 2026-08-02 那次真实数据丢失（详见 scripts/check-destructive-deletes.js 头部）。
// 闸本身判错的代价是【假绿】——看着有防护，其实没有。所以这里正反两面都要测：
// 正向（安全写法不许误报）保证它不会被嫌吵而绕过；反向（危险写法必须报）保证它真的在工作。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFile } from '../../scripts/check-destructive-deletes.js';

const check = src => checkFile(src, 'x.test.mjs');

// ── 反向：危险写法必须被抓到 ────────────────────────────────────────────────
// ★ 这条是本闸的存在理由，形态与事故现场一模一样：删除目标由被测代码算出，
//   基目录是真实根，只是【提到】了一个安全变量。它一度真的漏过——`ids.some()` 看见
//   表达式里有 workDir 就放行了，可 join(PROJECTS_ROOT, ...) 的基目录压根不是 workDir。
test('事故形态: join(真实根, 被测代码算的名字) 必须报违规——哪怕表达式里提到了安全变量', () => {
  const v = check(`
    const workDir = mkdtempSync(join(tmpdir(), 'wd-'));
    const projectDir = join(PROJECTS_ROOT, getProjectDir(workDir));
    rmSync(projectDir, { recursive: true, force: true });
  `);
  assert.equal(v.length, 1, '基目录是 PROJECTS_ROOT 而非 workDir，必须报');
  assert.equal(v[0].arg, 'projectDir');
});

test('反向: 循环删除数组，只要有一项来路不明就必须报', () => {
  const v = check(`
    const dataDir = mkdtempSync(join(tmpdir(), 'd-'));
    const projectDir = join(REAL_ROOT, encode(cwd));
    for (const d of [dataDir, projectDir]) { rmSync(d, { recursive: true, force: true }); }
  `);
  assert.equal(v.length, 1, '数组里混入来路不明的项，整个循环变量都不能算安全');
});

test('反向: 裸常量路径必须报', () => {
  const v = check("rmSync(join(homedir(), '.claude'), { recursive: true, force: true });");
  assert.equal(v.length, 1);
});

// ── 正向：安全写法不许误报（误报会让闸被绕过，等于没有）────────────────────
test('正向: 内联 mkdtemp 不报', () => {
  assert.deepEqual(check("rmSync(mkdtempSync(join(tmpdir(), 'a-')), { recursive: true, force: true });"), []);
});

test('正向: 变量直接来自 mkdtemp 不报', () => {
  assert.deepEqual(check(`
    const dir = mkdtempSync(join(tmpdir(), 'a-'));
    rmSync(dir, { recursive: true, force: true });
  `), []);
});

// 本仓大量测试是这个写法（makeHome / tempDir / dirs），不追这一跳会一次误报 50 处。
test('正向: 变量来自本地工厂函数（函数体里才是 mkdtemp）不报', () => {
  assert.deepEqual(check(`
    function makeHome() { return mkdtempSync(join(tmpdir(), 'h-')); }
    const home = makeHome();
    rmSync(home, { recursive: true, force: true });
  `), []);
});

test('正向: 临时目录对象的字段 d.root 不报', () => {
  assert.deepEqual(check(`
    function dirs() { const root = mkdtempSync(join(tmpdir(), 'i-')); return { root }; }
    const d = dirs();
    rmSync(d.root, { recursive: true, force: true });
  `), []);
});

test('正向: 数组累积（ROOTS.push）后循环删除不报', () => {
  assert.deepEqual(check(`
    const ROOTS = [];
    const a = mkdtempSync(join(tmpdir(), 'a-'));
    ROOTS.push(a);
    for (const dir of ROOTS) { rmSync(dir, { recursive: true, force: true }); }
  `), []);
});

test('正向: 在临时目录之下 join 出的子路径不报（基目录仍是临时目录）', () => {
  assert.deepEqual(check(`
    const base = mkdtempSync(join(tmpdir(), 'b-'));
    const sub = join(base, 'nested');
    rmSync(sub, { recursive: true, force: true });
  `), []);
});

// ── 豁免机制 ────────────────────────────────────────────────────────────────
test('豁免: safe-rm 标记可放行，本行与上一行都认', () => {
  assert.deepEqual(check("rmSync(weird, { recursive: true, force: true }); // safe-rm: 有理由"), []);
  assert.deepEqual(check("// safe-rm: 有理由\nrmSync(weird, { recursive: true, force: true });"), []);
});

test('豁免: 必须写理由，光写 safe-rm 不给过', () => {
  assert.equal(check('rmSync(weird, { recursive: true, force: true }); // safe-rm:').length, 1);
});

// ── 范围 ────────────────────────────────────────────────────────────────────
// 不带 recursive 的 rmSync 对目录会抛错，删不动整棵树，不是本闸要防的形态。
test('范围: 不带 recursive 的删除不在管辖内', () => {
  assert.deepEqual(check('rmSync(someFile);'), []);
  assert.deepEqual(check('unlinkSync(someFile);'), []);
});

// ── 闸自身踩过的坑（回归）──────────────────────────────────────────────────
// 判据分析要屏蔽注释（否则注释里的示例代码会被当成调用），但豁免标记【本身就是注释】——
// 一度在屏蔽后的文本里找 safe-rm，永远找不到，豁免机制整个失效，三处正当豁免全被报违规。
test('豁免标记要在原文里找：屏蔽注释不能把豁免机制一起屏蔽掉', () => {
  assert.deepEqual(check(`
    // safe-rm: 理由写在上一行
    rmSync(weird, { recursive: true, force: true });
  `), []);
});

// 理由常常要写好几行才说得清，标记不一定落在紧邻的那一行。
test('豁免标记可落在多行注释块里的任意一行', () => {
  assert.deepEqual(check(`
    // safe-rm: 第一行写了标记
    // 第二行继续解释为什么安全
    // 第三行还在解释
    rmSync(weird, { recursive: true, force: true });
  `), []);
  assert.deepEqual(check(`
    // 先铺垫背景
    // safe-rm: 标记在注释块中间
    // 后面还有补充
    rmSync(weird, { recursive: true, force: true });
  `), []);
});

test('豁免回看不许无限上溯：隔着代码行的 safe-rm 不算数', () => {
  const v = check(`
    // safe-rm: 这个标记是给别处用的
    const unrelated = 1;
    rmSync(weird, { recursive: true, force: true });
  `);
  assert.equal(v.length, 1, '中间隔了代码行，上面那个标记不该被借用');
});

// 屏蔽的另一面：闸自己的测试文件里存了一堆故意写坏的样例当字符串夹具，
// 不屏蔽字符串就会把自己的夹具报成违规。
test('字符串/模板串里的 rmSync 是文案不是调用，不报', () => {
  assert.deepEqual(check('const sample = "rmSync(evil, { recursive: true, force: true })";'), []);
  assert.deepEqual(check('const sample = `rmSync(evil, { recursive: true, force: true })`;'), []);
});

// ── 生产代码规则（src/ + scripts/）────────────────────────────────────────────
// 测试的判据是「追得到 mkdtemp」，生产代码没这回事——它删的本来就是真实文件。
// 生产侧盯的是另一个形态：真实数据根下，某一段【目录】由代码算出来。那一段算成空串，
// 删除就打到另一个目录上去了——2026-08-02 的事故正是它的递归版本。
import { checkSourceFile } from '../../scripts/check-destructive-deletes.js';

const checkSrc = src => checkSourceFile(src, 'x.js');

test('生产: 目录段由代码算出 → 必须要求 safe-path 说明', () => {
  const v = checkSrc(`
    const projectDir = getProjectDir(cwd);
    const file = join(homedir(), '.claude', 'projects', projectDir, \`\${sid}.jsonl\`);
    unlinkSync(file);
  `);
  assert.equal(v.length, 1, 'projectDir 是算出来的目录段，塌了就打到根目录下');
  assert.equal(v[0].kind, 'computed-under-real-root');
});

// ★ 这个区分是规则的全部价值：不做区分会一次报 10 处（全是删自己刚建的临时文件），
// 规则一吵，标记就会被反射性地加上，从此不再有意义。
test('生产: 只有文件名是算出来的 → 不报（代价有界，同目录换个名字而已）', () => {
  assert.deepEqual(checkSrc(`
    const p = join(WORKTREE_SETTINGS_DIR, \`\${keyFor(cwd)}.json\`);
    unlinkSync(p);
  `), []);
});

test('生产: 临时目录下的删除不报（追得到 mkdtemp 就不是真实数据）', () => {
  assert.deepEqual(checkSrc(`
    const tmp = mkdtempSync(join(tmpdir(), 'x-'));
    const f = join(tmp, encode(name), 'a.json');
    unlinkSync(f);
  `), []);
});

test('生产: safe-path 标记可豁免', () => {
  assert.deepEqual(checkSrc(`
    const projectDir = getProjectDir(cwd);
    const file = join(homedir(), '.claude', 'projects', projectDir, \`\${sid}.jsonl\`);
    // safe-path: 单文件删除，代价有界
    unlinkSync(file);
  `), []);
});

// ★★ 负向验证抓到过的真漏洞：两条规则一度共用 safe-rm 一种标记，于是为「单文件删除」写的
// 豁免，把同一行改成 rmSync(recursive) 之后【照样放行】——那张纸条成了永久通行证。
// 豁免必须绑定到"当初批准的是哪件事"：批的是有界的单文件删除，就不该覆盖无界的递归删除。
test('生产: safe-path 不得放行递归删除——豁免要绑定到被批准的那件事上', () => {
  const v = checkSrc(`
    const projectDir = getProjectDir(cwd);
    const file = join(homedir(), '.claude', 'projects', projectDir, \`\${sid}.jsonl\`);
    // safe-path: 当初批的是单文件删除
    rmSync(file, { recursive: true, force: true });
  `);
  assert.equal(v.length, 1, 'safe-path 只豁免目录段规则，递归删除要它自己的 safe-rm');
  assert.notEqual(v[0].kind, 'computed-under-real-root');
});

test('生产: 递归删除给了 safe-rm 才放行', () => {
  assert.deepEqual(checkSrc(`
    const dir = join(SOME_ROOT, compute(x));
    // safe-rm: 有正当理由
    rmSync(dir, { recursive: true, force: true });
  `), []);
});

// ── 2026-08-03 review：扫描面缺口 ─────────────────────────────────────────────
// findDestructiveCalls 的正则只认 rmSync|rm——`rmdirSync(p, {recursive:true})` 与它删除力完全
// 等价（deprecated 但可用），谁用它就整条绕过门禁。shell 删除同理（execSync('rm -rf …')），
// 且参数是字符串、会被 stripNonCode 抹掉，必须在原文上单独扫。
test('反向: rmdirSync(recursive:true) 与 rmSync 同等管辖，来路不明必须报', () => {
  const v = check(`
    const p = join(REAL_ROOT, encode(cwd));
    rmdirSync(p, { recursive: true });
  `);
  assert.equal(v.length, 1, 'rmdirSync 递归删除不在扫描面 = 门禁可被整条绕过');
});

test('正向: rmdirSync 目标来自 mkdtemp 不报', () => {
  assert.deepEqual(check(`
    const d = mkdtempSync(join(tmpdir(), 'a-'));
    rmdirSync(d, { recursive: true });
  `), []);
});

test('反向: execSync 里的 shell rm -rf 必须报（字符串参数不被 stripNonCode 豁免）', () => {
  const v = check("execSync('rm -rf ' + target);");
  assert.equal(v.length, 1, 'shell 删除完全绕过 fs 层扫描，必须单独抓');
});

test('豁免: shell rm 可用 safe-rm 放行', () => {
  assert.deepEqual(check(`
    // safe-rm: 容器内一次性环境，路径为常量
    execSync('rm -rf /tmp/fixed-ci-dir');
  `), []);
});

// ── 2026-08-04 code review：shell 删除扫描面的三个洞（实测逐条确认）────────────
// findShellDeletes 把 execFileSync/execFile/spawnSync/spawn 列进了扫描名单，但判据
// `/\brm\s+-[A-Za-z]*r/` 只匹配 shell 字符串形态——而这四个 API 恰恰【只收 argv 数组】，
// 于是它们是名单里的死条目。本仓库自己的调用约定就是 argv 数组（git-workspace.js:45）。
test('反向: argv 数组形态的递归 rm 必须报（execFileSync/spawnSync 一族只收这种形态）', () => {
  assert.equal(check("spawnSync('rm', ['-rf', target]);").length, 1, 'spawnSync argv 形态漏过 = 门禁对这一族恒绿');
  assert.equal(check("execFileSync('rm', ['-rf', target]);").length, 1);
  assert.equal(check("execFile('rm', ['-r', dir], cb);").length, 1);
  assert.equal(check("spawn('/bin/rm', ['-rf', dir]);").length, 1, '带路径的 rm 同样要认');
});

// -R 是 macOS rm(1) 首先文档化的递归开关；--recursive 是 GNU 长形式。
// 旧判据 `-[A-Za-z]*r` 大小写敏感、且 [A-Za-z]* 吃不掉第二个 `-`，两者全漏。
test('反向: rm -R 与 rm --recursive 与 -rf 同等对待', () => {
  assert.equal(check("execSync('rm -Rf ' + target);").length, 1, '-R 是 macOS rm 文档里的首选写法');
  assert.equal(check("execSync('rm --recursive ' + target);").length, 1);
  assert.equal(check("spawnSync('rm', ['--recursive', dir]);").length, 1);
});

// 非递归删除仍归单文件规则管，不该被这条判据抓——否则整个仓库的正当 rm 调用全变违规。
test('正向: 非递归 rm 不被递归判据误抓', () => {
  assert.deepEqual(check("execSync('rm -f ' + target);"), []);
  assert.deepEqual(check("spawnSync('rm', ['-f', target]);"), []);
});

test('豁免: argv 形态同样可用 safe-rm 放行', () => {
  assert.deepEqual(check(`
    // safe-rm: 容器内一次性环境
    spawnSync('rm', ['-rf', '/tmp/fixed-ci-dir']);
  `), []);
});
