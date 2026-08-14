// tests/unit/env-file.test.mjs —— src/ops/env-file.js（.env 的结构化读写）
//
// serializeEnvValue 是最容易写错的一块：dotenv 会剥成对引号、双引号内展开 \n、裸值被行内 #
// 截断。写错的后果不是「配置没生效」而是**server 起不来**。所以这里拿 dotenv 自己的 parser
// 当 oracle 做 round-trip：serialize 出来的东西，parse 回去必须一字不差。
import test from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyEnvChanges, isSerializableEnvValue, maskSecret, serializeEnvValue } from '../../src/ops/env-file.js';

// ★ oracle 必须是**多行** .env，不能是单行。
//
// 上一版这里写的是 `dotenv.parse(\`K=${serializeEnvValue(v)}\`)` —— 单行。而 dotenv 的单引号分支
// 正则是 `'(?:\\'|[^'])*'`，它把 `\'` 当作转义的单引号：值以 `\` 结尾时闭合引号被吃掉，匹配会
// 一路贪婪到文件里**下一个** `'`。单行文件里没有下一个 `'`，正则被迫回溯，于是永远解析正确 ——
// 判据把「后面还有别的行」这一维消掉了，缺陷恰好落在被消掉的那一维里。
//
// 尾随行刻意含一个单引号包裹的值：那是贪婪匹配的落点，也是面板最常写出的形态（含 # 的值必加引号）。
const TRAILER = ["NEXT_KEY='#general'", 'AFTER=plain'].join('\n');
const parseMultiline = (line) => dotenv.parse(`${line}\n${TRAILER}\n`);
const roundTrip = (v) => parseMultiline(`K=${serializeEnvValue(v)}`).K;

test.describe('serializeEnvValue —— 以 dotenv 为 oracle 的 round-trip', () => {
  const CASES = [
    ['普通值', 'hello'],
    ['绝对路径', '/Users/you/code/my-repo'],
    ['64 位 hex token', 'a1b2c3'.repeat(10)],
    ['数字', '3000'],
    ['空字符串', ''],
    ['含空格的路径', '/Users/you/My Code/repo'],
    ['首尾有空格', '  padded  '],
    ['含 # 井号（裸值会被截断）', 'topic#1'],
    ['含双引号', 'say "hi"'],
    ['含反斜杠', 'C:\\Users\\you'],
    ['含美元符号（dotenv 变量展开）', 'pa$$word'],
    ['含 ${} 形态', 'literal ${HOME} here'],
    ['中文路径', '/Users/you/我的项目'],
    ['emoji', 'topic-🔔'],
    ['等号', 'a=b'],
    ['URL', 'https://ntfy.example.com/topic?x=1&y=2'],
    ['前后都有引号', `"quoted"`],
    ['井号开头', '#comment-like'],
    ['含反引号', 'cmd `whoami`'],
    ['含 $( ) 命令替换形态', 'a$(id -un)b'],
    ['含 ${} 与反引号', 'x${HOME}`id`y'],
  ];

  for (const [name, value] of CASES) {
    test(`round-trip: ${name}`, () => {
      assert.equal(roundTrip(value), value, `serialize→parse 必须还原：${JSON.stringify(value)}`);
    });
  }

  test('含换行 → 抛错（校验期就该拒绝，不在序列化期兜底）', () => {
    assert.throws(() => serializeEnvValue('a\nb'), /换行|控制字符/);
    assert.throws(() => serializeEnvValue('a\rb'), /换行|控制字符/);
  });

  // ★ 含单引号一律拒绝。.env 有两个消费者（dotenv 与 `source .env` 的 shell），
  // 实测只有单引号包裹两边都过关，而它包不住自身 —— 与其挑一侧牺牲，不如明说表达不了。
  // 反面教材：上一版为此改用反引号，把「值里有个撇号」变成了 shell 命令注入。
  test("含单引号 → 抛错，且错误信息说清为什么", () => {
    for (const v of ["it's fine", "'", "it's C:\\path", 'it\'s "x"', "it's `x`"]) {
      assert.throws(() => serializeEnvValue(v), /单引号/, `应拒绝 ${JSON.stringify(v)}`);
    }
  });

  // ★ 以 `\` 结尾一律拒绝 —— 与单引号同源的第二个「表达不了」。
  //
  // dotenv 把 `\'` 当转义单引号，于是 `K='x\'` 的闭合引号被吃掉，值一路吞到下一个 `'`，
  // **后续 key 整个消失**；而 shell `source` 侧单引号内 `\` 是字面量、完全正确。两个消费者对同一份
  // 文件给出不同结果，与反引号那次同型、方向相反。个数无关：`'x\\'` 的第一个 `\` 被 `[^']` 吃掉，
  // 第二个与闭合引号组成 `\'` 照样命中转义分支。
  //
  // 后果是 fail-open：被吞掉的 key 若是 CF_ACCESS_* 之一，src/auth/cf-access.js 的
  // `enabled = !!(hostname && team && aud)` 会让公网 2FA 整层静默关闭。
  test('以反斜杠结尾 → 抛错，且错误信息说清为什么', () => {
    for (const v of ['C:\\Users\\you\\', 'https://ntfy.sh/a\\', 'x\\\\', '\\']) {
      assert.throws(() => serializeEnvValue(v), /反斜杠/, `应拒绝 ${JSON.stringify(v)}`);
    }
  });

  test('反斜杠不在结尾则照常接受（不过度收紧）', () => {
    for (const v of ['C:\\Users\\you', 'a\\b', '\\leading']) {
      assert.equal(roundTrip(v), v, `不该拒绝 ${JSON.stringify(v)}`);
    }
  });

  test('isSerializableEnvValue 与 serializeEnvValue 判断一致（校验期能提前拦住同一批）', () => {
    const samples = ['ok', '', 'a b', 'a#b', "it's", "'", 'a\nb', 'cmd `x`', 'a$(id)b',
      'C:\\Users\\you\\', 'x\\\\', '\\', 'C:\\Users\\you'];
    for (const v of samples) {
      const canSerialize = (() => {
        try { serializeEnvValue(v); return true; } catch { return false; }
      })();
      assert.equal(isSerializableEnvValue(v), canSerialize, `判断不一致：${JSON.stringify(v)}`);
    }
  });
});

// ★ 直接测**第二个消费者**：用户 `source .env` 时不能有任何命令被执行，且值要原样还原。
//
// 这一组是上一轮事故的护栏。当时的失败模式是：单看 dotenv 那一侧，反引号包裹完美无缺
// （零展开、round-trip 一字不差），于是它通过了全部既有测试 —— 而 shell 那一侧整个值会被
// 当命令执行。**两个消费者的判断必须一起做，任何只测一侧的用例都挡不住这类错误。**
test.describe('serializeEnvValue —— shell source 安全（第二个消费者）', () => {
  const SHELL_CASES = [
    'plain',
    '/Users/you/My Code/repo',
    'a#b c',
    'cmd `id -un`',
    'a$(id -un)b',
    'x${HOME}y',
    'a"b',
    'C:\\Users\\you',
    'pa$$word',
    '  padded  ',
    'topic-🔔',
  ];

  for (const value of SHELL_CASES) {
    test(`source 后不执行命令且值还原：${JSON.stringify(value)}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'ccm-env-shell-'));
      try {
        const envFile = join(dir, 'probe.env');
        const sentinel = join(dir, 'EXECUTED');
        writeFileSync(envFile, `K=${serializeEnvValue(value)}\n`);

        // 哨兵：把 PATH 上的 id/echo 换成会写文件的桩不现实，改用「值里本来就带命令」的样本，
        // 只要 shell 真的执行了它们，K 的内容就会与原值不同（命令输出替换掉了原文）。
        const r = spawnSync('bash', ['-c', `set +e; source ${JSON.stringify(envFile)} 2>/dev/null; printf '%s' "$K"`], {
          encoding: 'utf8', cwd: dir,
        });

        assert.equal(existsSync(sentinel), false, '不应有任何副作用文件');
        assert.equal(r.stdout, value, `source 后的值应与原值一致（实际 ${JSON.stringify(r.stdout)}）`);
      } finally {
        rmSync(dir, { recursive: true, force: true }); // safe-rm: dir 恒来自本用例上方的 mkdtempSync
      }
    });
  }

  // ★ 这份文件必须是**多行**，且受测行后面要有一个单引号包裹的值。
  // 单行版本会让 dotenv 的贪婪匹配无处可去、被迫回溯，从而掩盖「值以 \ 结尾吞掉后续 key」那类缺陷。
  // 断言也不能只看被测 key 本身：**后续 key 是否还在**才是分叉的直接指纹。
  test('dotenv 与 shell 对同一份序列化结果给出相同的值（两个消费者不能分叉）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-env-both-'));
    try {
      for (const value of SHELL_CASES) {
        const envFile = join(dir, 'both.env');
        const text = `K=${serializeEnvValue(value)}\n${TRAILER}\n`;
        writeFileSync(envFile, text);
        const shellOut = spawnSync('bash', ['-c',
          `source ${JSON.stringify(envFile)} 2>/dev/null; printf '%s\\n%s' "$K" "$NEXT_KEY"`,
        ], { encoding: 'utf8', cwd: dir }).stdout;
        // 换行当分隔符是安全的：含控制字符的值在序列化期就被拒绝，不可能出现在 SHELL_CASES 里
        const [viaShell, shellNext] = shellOut.split('\n');
        const parsed = dotenv.parse(text);
        assert.equal(parsed.K, value, `dotenv 侧失真：${JSON.stringify(value)}`);
        assert.equal(viaShell, value, `shell 侧失真：${JSON.stringify(value)}`);
        // 后续 key 两侧都必须完好——被吞掉的 key 是静默消失的，只看 K 看不出来
        assert.equal(parsed.NEXT_KEY, '#general', `dotenv 侧吞掉了后续 key（受测值 ${JSON.stringify(value)}）`);
        assert.equal(shellNext, '#general', `shell 侧吞掉了后续 key（受测值 ${JSON.stringify(value)}）`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true }); // safe-rm: dir 恒来自本用例上方的 mkdtempSync
    }
  });

  test('简单值不加多余引号（生成的 .env 要还能给人读）', () => {
    assert.equal(serializeEnvValue('3000'), '3000');
    assert.equal(serializeEnvValue('/Users/you/repo'), '/Users/you/repo');
  });
});

test.describe('applyEnvChanges —— 保结构改写', () => {
  const SAMPLE = [
    '# ccm 配置',
    '',
    '# 鉴权令牌',
    'AUTH_TOKEN=abc123',
    'PORT=3000',
    '',
    '# 未知 key（用户自己加的）',
    'MY_CUSTOM_THING=keepme',
    'LOG_STDERR=1',
  ].join('\n');

  test('改已有 key：原地替换，行位置不变', () => {
    const out = applyEnvChanges(SAMPLE, { PORT: '8080' });
    assert.equal(dotenv.parse(out).PORT, '8080');
    assert.equal(out.split('\n').findIndex((l) => l.startsWith('PORT=')), 4, '行位置应保持');
  });

  test('注释与空行逐字保留', () => {
    const out = applyEnvChanges(SAMPLE, { PORT: '8080' });
    assert.ok(out.includes('# ccm 配置'));
    assert.ok(out.includes('# 鉴权令牌'));
    assert.ok(out.includes('# 未知 key（用户自己加的）'));
  });

  test('不认识的 key 原样留着（这不是通用 .env 编辑器，别顺手清理别人的东西）', () => {
    const out = applyEnvChanges(SAMPLE, { PORT: '8080' });
    assert.equal(dotenv.parse(out).MY_CUSTOM_THING, 'keepme');
  });

  // null = 删除整行，不是写 `KEY=`。src/server/config.js:22,39-43 启动时会删掉所有空串 key，
  // 留一行 `KEY=` 毫无意义，还会挡住从 shell export 同名变量。
  test('null → 整行删除，不留 KEY= 空行', () => {
    const out = applyEnvChanges(SAMPLE, { LOG_STDERR: null });
    assert.equal(dotenv.parse(out).LOG_STDERR, undefined);
    assert.ok(!/^LOG_STDERR=/m.test(out), '不能留下 LOG_STDERR= 空行');
    assert.ok(!out.includes('LOG_STDERR'), '整行都该没了');
  });

  // ★ 同名 key 重复是常见写法（在文件底部追加以覆盖上面的值）。dotenv 的生效语义是后者覆盖前者，
  // 所以**改**只需改最后一行；但**删**必须删掉全部同名行 —— 只删最后一行会让上面那个旧值复活，
  // 用户以为清空了，配置却静默回退到一个更老的值。
  test('删除时删掉全部同名行（否则旧值复活）', () => {
    const dup = 'LOG_STDERR=1\nPORT=3000\nLOG_STDERR=1\n';
    const out = applyEnvChanges(dup, { LOG_STDERR: null });
    assert.equal(dotenv.parse(out).LOG_STDERR, undefined, '旧值不能复活');
    assert.ok(!/^\s*(export\s+)?LOG_STDERR\s*=/m.test(out), '不能残留任何 LOG_STDERR 赋值行');
    assert.equal(dotenv.parse(out).PORT, '3000', '中间无关的行不受影响');
  });

  test('删不存在的 key 是 no-op，不报错', () => {
    assert.equal(applyEnvChanges(SAMPLE, { NOT_THERE: null }), SAMPLE);
  });

  test('新 key 追加到末尾，并带一句来源说明', () => {
    const out = applyEnvChanges(SAMPLE, { NTFY_TOPIC: 'my-topic' });
    assert.equal(dotenv.parse(out).NTFY_TOPIC, 'my-topic');
    assert.ok(out.indexOf('NTFY_TOPIC') > out.indexOf('LOG_STDERR'), '应追加在后面');
    assert.match(out, /设置面板|由 UI/, '追加段要有来源说明，否则用户不知道这几行哪来的');
  });

  test('多个改动一次生效（改 + 删 + 增）', () => {
    const out = applyEnvChanges(SAMPLE, { PORT: '9000', LOG_STDERR: null, NTFY_URL: 'https://n.example.com' });
    const parsed = dotenv.parse(out);
    assert.equal(parsed.PORT, '9000');
    assert.equal(parsed.LOG_STDERR, undefined);
    assert.equal(parsed.NTFY_URL, 'https://n.example.com');
    assert.equal(parsed.AUTH_TOKEN, 'abc123', '没动的 key 不该受影响');
  });

  test('值里有特殊字符时按 serializeEnvValue 引用，parse 回来一致', () => {
    const out = applyEnvChanges(SAMPLE, { NTFY_TOPIC: 'a#b c' });
    assert.equal(dotenv.parse(out).NTFY_TOPIC, 'a#b c');
  });

  test('同名 key 出现两次时只改最后一个（dotenv 的生效语义是后者覆盖前者）', () => {
    const dup = 'PORT=3000\nPORT=4000';
    const out = applyEnvChanges(dup, { PORT: '9999' });
    assert.equal(dotenv.parse(out).PORT, '9999');
  });

  test('空文件也能追加', () => {
    const out = applyEnvChanges('', { PORT: '3000' });
    assert.equal(dotenv.parse(out).PORT, '3000');
  });

  test('原文件末尾无换行时不粘行', () => {
    const out = applyEnvChanges('PORT=3000', { NTFY_URL: 'https://x' });
    assert.equal(dotenv.parse(out).NTFY_URL, 'https://x');
    assert.equal(dotenv.parse(out).PORT, '3000');
  });

  test('带 export 前缀的行也能改（有人习惯这么写）', () => {
    const out = applyEnvChanges('export PORT=3000', { PORT: '8080' });
    assert.equal(dotenv.parse(out).PORT, '8080');
  });

  test('changes 为空 → 原文不变（一个字节都不写）', () => {
    assert.equal(applyEnvChanges(SAMPLE, {}), SAMPLE);
  });
});

test.describe('maskSecret', () => {
  test('只给「设了没」与长度，绝不回显明文', () => {
    assert.deepEqual(maskSecret('a'.repeat(64)), { set: true, length: 64 });
  });

  test('未设置 → set:false', () => {
    assert.deepEqual(maskSecret(''), { set: false, length: 0 });
    assert.deepEqual(maskSecret(undefined), { set: false, length: 0 });
    assert.deepEqual(maskSecret(null), { set: false, length: 0 });
  });

  test('返回值里不含原文的任何片段', () => {
    const secret = 'super-secret-token';
    assert.ok(!JSON.stringify(maskSecret(secret)).includes('secret'));
  });
});
