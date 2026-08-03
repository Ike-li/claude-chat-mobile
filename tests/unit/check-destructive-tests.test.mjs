// tests/unit/check-destructive-tests.test.mjs —— 破坏性删除门禁自身的测试
//
// 这条闸是为了防 2026-08-02 那次真实数据丢失（详见 scripts/check-destructive-tests.js 头部）。
// 闸本身判错的代价是【假绿】——看着有防护，其实没有。所以这里正反两面都要测：
// 正向（安全写法不许误报）保证它不会被嫌吵而绕过；反向（危险写法必须报）保证它真的在工作。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFile } from '../../scripts/check-destructive-tests.js';

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
