// tests/unit/single-source-of-truth.test.mjs —— 「这个事实只许有一处定义」的门禁集。
//
// 2026-08-27 全仓排查的产物。起因是一个具体症状：web 体检说 CLAUDE_BIN 正常、desktop 体检说
// 找不到 claude —— 同一个事实两套判据。顺着这个形状扫下去，找到六处同类问题，共同点是
// **值当前恰好一致，所以没人发现它们是两份**。这类缺陷不会在写下的那天暴露，只在某人改了
// 其中一处的那天暴露，而那时改的人根本不知道还有另一处。
//
// 每条断言下面都记着它对应的那次分叉的实测症状。删任何一条之前先想清楚：
// 那个症状是不是真的不会再来了。
//
// 与 cross-side-parity.test.mjs 的分工：那边管「前后端两份同名**函数**的行为等价」，
// 这边管「同一个**值/判据**不许有第二处定义」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// 只看真正会执行的行：块注释体（以 * 开头）和行注释都排除，否则「注释里解释为什么不要这么写」
// 本身会把闸弄红 —— 这些闸的注释恰恰全都在举反例。
function codeLines(src) {
  return src.split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => {
      const t = line.trim();
      return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
}

function walk(dir, exts = ['.js']) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel, exts));
    else if (exts.some(e => name.endsWith(e))) out.push(rel);
  }
  return out;
}

const SOURCE_FILES = [...walk('src'), ...walk('scripts')];

/** 在所有源码文件里找匹配 re 的代码行，返回 `文件:行号  内容` 列表（排除 allow 里的文件）。 */
function findInSources(re, allow = []) {
  const hits = [];
  for (const file of SOURCE_FILES) {
    if (allow.includes(file)) continue;
    for (const { line, no } of codeLines(read(file))) {
      if (re.test(line)) hits.push(`${file}:${no}  ${line.trim()}`);
    }
  }
  return hits;
}

// ── ① server 的绑定地址判据 ────────────────────────────────────────────────
// 症状（实测）：AUTH_TOKEN='   ' 时 server 绑 0.0.0.0，而 scripts/doctor.js 说
// 「已设置但为空 → 仅监听 127.0.0.1」—— 安全语义正好说反，用户以为没开公网。
// 根因是判据写成 app.js 里一行内联三元，两个 doctor 够不到、只能各自猜。
test('绑定地址只由 src/shared/bind-host.js 决定，不许再写内联三元', () => {
  const hits = findInSources(/['"]0\.0\.0\.0['"]\s*:\s*['"]127\.0\.0\.1['"]/, ['src/shared/bind-host.js']);
  assert.deepEqual(hits, [],
    '把判据换成 resolveBindHost(authToken)：两个 doctor 要回答「这台机器对外可达吗」，\n'
    + '  它们只能 import 函数，够不到你这一行三元。');
});

// ── ② 默认端口 ────────────────────────────────────────────────────────────
// 症状：env-schema 声明了 PORT.default='3000'，但 server 与 service.js 共 8 处各写各的 3000。
// 于是那个 default **压根没人消费** —— 改它只让配置面板和 doctor 显示新值（doctor 拿
// def.default 算「生效值」），server 照旧跑 3000。声明了却不被消费的事实源比没有更糟。
test('默认端口只在 env-schema.js 定义一次', () => {
  // 3000 在本仓还大量用作毫秒超时（execFileSync 的 timeout、setTimeout 兜底），那些与端口无关。
  // 所以只抓「同一行里出现 PORT」与「?? 3000」这两种真正的端口回落形态 ——
  // 初版多写了一条 `, 3000)`，当场把 `setTimeout(() => process.exit(0), 3000)` 抓成端口。
  const re = /(PORT[^\n]*\b3000\b|\b3000\b[^\n]*PORT|\?\?\s*3000\b)/;
  const hits = findInSources(re, ['src/ops/env-schema.js']);
  assert.deepEqual(hits, [], '用 env-schema.js 的 DEFAULT_PORT，别再写字面量 3000');
});

// ── ③′ 源文件必须是 grep 看得见的纯文本 ──────────────────────────────────
// 这条是上面所有闸的**前提条件**。src/sessions/session-registry.js 里曾有一个裸 NUL 字节
// （terminalStateKey 拿它当 Map key 分隔符，用意本身没错），后果是 file(1) 判定整个文件为
// `data`，BSD grep 随之把它当二进制静默跳过 —— 连 "Binary file matches" 都不打。
// 于是这个文件对所有 grep 类扫描一律隐形：本仓 check 里的 i18n 孤儿 key、禁止模式、
// 破坏性删除守卫，加上人工排查，全都看不见它。实测正是这样漏掉了它里面的一处 '.claude'。
// 修法是写成 backslash-u0000 转义：运行时值一模一样，源文件回到纯文本。
//
// ★ 扫描范围含 tests/，而且是**吃过亏才加的**：本文件初稿的上面这行注释里写了一个真的 NUL
//   字节（想举例说明「不要这么写」，结果自己就这么写了），于是 git 把这个新测试文件记成
//   `Bin 0 -> 11143 bytes` —— 一个专门检查 NUL 的闸，自己对 review 不可见，而它当时的
//   扫描范围恰好不含 tests/，抓不到自己。闸必须能扫到自己所在的那层，否则就是个盲的哨兵。
test('源文件不含裸 NUL 字节（否则整个文件对 grep 与 git diff 都隐形）', () => {
  const bad = [];
  const files = SOURCE_FILES
    .concat(walk('public/js'), walk('desktop', ['.swift']), walk('tests', ['.mjs', '.ts', '.js']));
  for (const file of files) {
    if (readFileSync(join(ROOT, file)).includes(0)) bad.push(file);
  }
  assert.deepEqual(bad, [],
    '把裸 0x00 写成 \\u0000 转义 —— 运行时值不变，但 grep 类门禁与 code review 不会再对整个文件失明');
});

// ── ③ CLI 的目录约定 ──────────────────────────────────────────────────────
// 症状：~/.claude 与 ~/.claude/projects 在仓里有近十处独立字面量。值当然一样，问题是没有
// 任何东西保证它们一起变；漏掉的那处会静默读到空目录 —— 历史为空、镜像态为空，都不报错。
test('~/.claude 的路径拼装只在 src/shared/claude-home.js', () => {
  const hits = findInSources(/['"]\.claude['"]/, ['src/shared/claude-home.js']);
  assert.deepEqual(hits, [],
    "用 claude-home.js 的 CLAUDE_PROJECTS_DIR / claudeHome() / claudeSettingsPath() / ccmUnderClaudeHome()");
});

// ── ④ 附件上限：前后端两份 ────────────────────────────────────────────────
// 边界闸禁止前后端互相 import，这三个上限只能各写各的。值必须相等，且必须由这道闸保证 ——
// 前端那份是「提前告知用户」，后端那份才是真正的闸（前端不可信）。
test('附件上限前后端一致（三项）', async () => {
  const be = await import(join(ROOT, 'src/files/uploads.js'));
  const feSrc = read('public/js/app/attachments.js');
  const num = (name) => {
    const m = new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`).exec(feSrc);
    assert.ok(m, `前端 attachments.js 里找不到 ${name} —— 改名了就同步改这条断言`);
    return Function(`"use strict"; return (${m[1]})`)();
  };
  assert.equal(num('MAX_COUNT'), be.MAX_FILES, '附件数量上限：前端 MAX_COUNT ⇔ 后端 MAX_FILES');
  assert.equal(num('MAX_FILE'), be.MAX_FILE_BYTES, '单文件上限：前端 MAX_FILE ⇔ 后端 MAX_FILE_BYTES');
  assert.equal(num('MAX_TOTAL'), be.MAX_TOTAL_BYTES, '总量上限：前端 MAX_TOTAL ⇔ 后端 MAX_TOTAL_BYTES');
});

// 症状：错误文案里硬写着「单文件上限 10MB」「上限 20MB」，是这些值的**第三份**来源。
// 改常量不改文案，用户会看到「11.0MB，单文件上限 10MB」而实际上限已经是 15MB。
test('上传错误文案不硬编码 MB 数（由常量算）', () => {
  const hits = codeLines(read('src/files/uploads.js'))
    .filter(({ line }) => /上限\s*\d+\s*MB|limit\s+\d+\s*MB/i.test(line))
    .map(({ line, no }) => `src/files/uploads.js:${no}  ${line.trim()}`);
  assert.deepEqual(hits, [], '用 mb(MAX_FILE_BYTES) 这类插值，别把数字写死在文案里');
});

// ── ⑤ 两个 doctor 的重叠项 ────────────────────────────────────────────────
// 症状：CLI doctor 与 web doctor 有 8 个重叠检查项，其中 AUTH_TOKEN 与 CLAUDE_BIN 曾各写一份
// （前者安全语义说反，后者只回放启动快照 —— 实测 CLI 已升到 2.1.247 而 web 仍显示 2.1.246 判 ok）。
// 判定逻辑必须都在 doctor-checks.js（纯函数层），两个宿主只负责采集输入与排版。
test('CLI doctor 不再自带 AUTH_TOKEN / CLAUDE_BIN 的判定', () => {
  const src = read('scripts/doctor.js');
  for (const [fn, own] of [['checkAuthToken', 'authTokenDiagnostic'], ['checkClaudeBin', 'claudeBinDiagnostic']]) {
    const body = new RegExp(`function ${fn}\\(\\)\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src);
    assert.ok(body, `scripts/doctor.js 里找不到 ${fn}`);
    assert.match(body[1], new RegExp(own), `${fn} 必须走共用判定 ${own}，不许自己判`);
    assert.doesNotMatch(body[1], /\blength\s*<\s*\d|\bexistsSync\b|--version/,
      `${fn} 里出现了自己的判据 —— 判定属于 doctor-checks.js，这里只该采集输入与排版`);
  }
});

// ── ⑥ 登记簿：新增孪生实现必须留下痕迹 ────────────────────────────────────
// 上面五条各盯一个具体的值。这条盯的是**下一个**：仓里写着「同语义 / 与 xxx 对齐 / 两侧」
// 这类注释的地方，就是孪生实现的自白书。它们必须有对照闸看着。
test('声称「与对方同语义」的实现都已进对照闸', () => {
  const parity = read('tests/unit/cross-side-parity.test.mjs');
  const claims = [];
  for (const file of SOURCE_FILES.concat(walk('public/js/logic'))) {
    for (const { line, no } of codeLines(read(file))) {
      if (/同语义[^\n]*不能互相 import|与 [\w./-]+ 同语义/.test(line)) claims.push(`${file}:${no}`);
    }
  }
  // 有这类声明的文件，其导出的函数名必须出现在对照闸的 PAIRS 里（至少一个）。
  const files = [...new Set(claims.map(c => c.split(':')[0]))];
  const uncovered = files.filter((f) => {
    const names = [...read(f).matchAll(/^export\s+function\s+([a-zA-Z_$][\w$]*)/gm)].map(m => m[1]);
    return names.length > 0 && !names.some(n => parity.includes(`${n}:`));
  });
  assert.deepEqual(uncovered.map(f => relative('.', f)), [],
    '这些文件声称与另一侧同语义，却没有一个导出进了 cross-side-parity 的 PAIRS —— \n'
    + '  「同语义」是意图，不是约束；只有对照断言才是约束。');
});
