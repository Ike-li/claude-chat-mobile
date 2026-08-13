// tests/unit/env-file.test.mjs —— src/ops/env-file.js（.env 的结构化读写）
//
// serializeEnvValue 是最容易写错的一块：dotenv 会剥成对引号、双引号内展开 \n、裸值被行内 #
// 截断。写错的后果不是「配置没生效」而是**server 起不来**。所以这里拿 dotenv 自己的 parser
// 当 oracle 做 round-trip：serialize 出来的东西，parse 回去必须一字不差。
import test from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

import { applyEnvChanges, maskSecret, serializeEnvValue } from '../../src/ops/env-file.js';

const roundTrip = (v) => dotenv.parse(`K=${serializeEnvValue(v)}`).K;

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
    ['含单引号', "it's fine"],
    ['含双引号', 'say "hi"'],
    ['含反斜杠', 'C:\\Users\\you'],
    ['含美元符号（dotenv 变量展开）', 'pa$$word'],
    ['含 ${} 形态', 'literal ${HOME} here'],
    ['中文路径', '/Users/you/我的项目'],
    ['emoji', 'topic-🔔'],
    ['等号', 'a=b'],
    ['URL', 'https://ntfy.example.com/topic?x=1&y=2'],
    ['前后都有引号', `"quoted"`],
    ['只有单引号', "'"],
    ['井号开头', '#comment-like'],
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
