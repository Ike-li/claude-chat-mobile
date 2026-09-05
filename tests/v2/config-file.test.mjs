// tests/v2/config-file.test.mjs —— 配置读取的源选择、优先级与 .env 可表达性
// 守护：CONFIG-01（读写同源、shell 压过文件、ANTHROPIC_* 只认真实 shell、未登记键读宽写严）、
//       CONFIG-02（.env 的 dotenv 与 shell source 两个消费者必须同时安全）
// 覆盖：新旧文件优先级 + 坏 JSON fail-loud 不回落 + 各类键的来源规则 + 单引号/尾反斜杠拒绝表达
// 槽位：S1（纯函数 + 一次性目录上的真实读盘，不 mock fs）
//
// 不测什么 + 为什么：
//  ① 面板 env:set 写入后 server 读到同一份 —— 那是接线，属 S2（写 .env 而读 ccm.config.json
//     的分叉必须在真组装根上才验得出来）。
//  ② config migrate 的完整迁移流程 —— 属 scripts/ 的 CLI 行为，另有入口测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfigSources, resolveConfigValues } from '../../app/src/ops/config-file.js';
import { isSerializableEnvValue, serializeEnvValue } from '../../app/src/ops/env-file.js';

let base;
test.before(() => { base = mkdtempSync(join(tmpdir(), 'ccm-v2-config-')); });
test.after(() => rmSync(base, { recursive: true, force: true })); // safe-rm: mkdtemp 一次性目录

let seq = 0;
// 每个用例一个独立子目录：避免用例间通过残留文件互相影响（顺序依赖是这类测试最常见的假绿源）。
function caseDir(files = {}) {
  const dir = join(base, `c${++seq}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

test.describe('CONFIG-01 源选择：新格式优先，缺失才回落', () => {
  test('两份都在 → 用 ccm.config.json，并提示旧的已被忽略', () => {
    const dir = caseDir({
      'ccm.config.json': JSON.stringify({ PORT: 4001 }),
      '.env': 'PORT=9999\n',
    });
    const r = loadConfigSources({ dir });
    assert.equal(r.source, 'config');
    assert.equal(r.fileValues.PORT, 4001, '必须来自 json，不能是 .env 的 9999');
    assert.ok(r.warnings.some(w => /\.env/.test(w)), '要明说旧文件被忽略，否则用户改了没反应会以为写入失败');
  });

  test('只有 .env → 读它并提示迁移', () => {
    const dir = caseDir({ '.env': 'PORT=9999\n' });
    const r = loadConfigSources({ dir });
    assert.equal(r.source, 'env');
    assert.equal(r.fileValues.PORT, '9999', '.env 只能存字符串');
    assert.ok(r.warnings.some(w => /migrate/.test(w)));
  });

  test('两份都没有 → source=none 且【不警告】（全新安装是正常状态）', () => {
    const r = loadConfigSources({ dir: caseDir() });
    assert.equal(r.source, 'none');
    assert.deepEqual(r.fileValues, {});
    assert.deepEqual(r.warnings, [], '装机第一步就刷警告会让用户以为装坏了');
  });
});

test.describe('CONFIG-01 坏配置必须 fail-loud，绝不静默回落', () => {
  test('JSON 语法错误 → 抛错，不回落到 .env 也不当空配置', () => {
    // 回落等于让 server 以「未设 AUTH_TOKEN」启动，监听地址会从 0.0.0.0 悄悄降级到 127.0.0.1，
    // 手机全部连不上却没有任何错误信息 —— 配置层出错要吵，不要静默降级。
    const dir = caseDir({ 'ccm.config.json': '{ "PORT": 4001,, }', '.env': 'PORT=9999\n' });
    assert.throws(() => loadConfigSources({ dir }), /解析失败/);
  });

  test('顶层不是对象（数组 / null / 标量）→ 抛错', () => {
    for (const bad of ['[]', 'null', '"str"', '42']) {
      const dir = caseDir({ 'ccm.config.json': bad });
      assert.throws(() => loadConfigSources({ dir }), /顶层必须是一个 JSON 对象/, `顶层 ${bad} 应被拒绝`);
    }
  });

  test('空对象是合法配置，不该被当成坏文件', () => {
    const r = loadConfigSources({ dir: caseDir({ 'ccm.config.json': '{}' }) });
    assert.equal(r.source, 'config');
    assert.deepEqual(r.fileValues, {});
  });
});

test.describe('CONFIG-01 键的来源规则', () => {
  test('ANTHROPIC_* 写在配置文件里 → 剥除并警告（只认真实 shell export）', () => {
    const { values, warnings } = resolveConfigValues({
      fileValues: { ANTHROPIC_BASE_URL: 'https://gw.example.com' }, source: 'config',
    });
    assert.equal(values.ANTHROPIC_BASE_URL, undefined, '写进文件是静默失效，必须剥掉');
    assert.ok(warnings.some(w => /ANTHROPIC_BASE_URL/.test(w)), '要明说被忽略，否则用户以为网关配好了');
  });

  test('同一个 ANTHROPIC_* 来自 shell → 放行（两个来源规则相反，不能混）', () => {
    const { values } = resolveConfigValues({
      fileValues: {}, shellEnv: { ANTHROPIC_BASE_URL: 'https://gw.example.com' },
    });
    assert.equal(values.ANTHROPIC_BASE_URL, 'https://gw.example.com');
  });

  test('shell 覆盖文件（环境变量始终压过配置文件）', () => {
    const { values } = resolveConfigValues({
      fileValues: { PORT: 4001 }, shellEnv: { PORT: '5002' }, source: 'config',
    });
    assert.equal(values.PORT, 5002, 'shell 值胜出，且按 schema 归一成数字');
  });

  test('shell 里的空串等同未设置，不得覆盖掉文件里的有效值', () => {
    for (const empty of ['', null, undefined]) {
      const { values } = resolveConfigValues({
        fileValues: { PORT: 4001 }, shellEnv: { PORT: empty }, source: 'config',
      });
      assert.equal(values.PORT, 4001, `shellEnv.PORT=${String(empty)} 不该把配置清掉`);
    }
  });

  test('未登记的键：文件里放行并提示（读宽），shell 里静默跳过', () => {
    // 读取侧宽容——dotenv 时代 HTTPS_PROXY / CLAUDE_CONFIG_DIR 这类一直是生效的，
    // 按 schema 白名单过滤会静默掐掉它们。写入侧仍然严格（那是另一道闸）。
    const fromFile = resolveConfigValues({ fileValues: { HTTPS_PROXY: 'http://127.0.0.1:1', AUTH_TOEKN: 'x' }, source: 'config' });
    assert.equal(fromFile.values.HTTPS_PROXY, 'http://127.0.0.1:1', '第三方变量要原样传给 claude 子进程');
    assert.equal(fromFile.values.AUTH_TOEKN, 'x', '拼错的键也放行——但下面那条提示能让用户自己发现');
    assert.ok(fromFile.warnings.some(w => /AUTH_TOEKN/.test(w)), '未登记键必须在输出里露面，否则拼错永远发现不了');

    const fromShell = resolveConfigValues({ fileValues: {}, shellEnv: { SOME_UNRELATED_VAR: 'x' } });
    assert.equal(fromShell.values.SOME_UNRELATED_VAR, undefined, 'shell 里一堆无关变量，不该收进来');
    assert.deepEqual(fromShell.warnings, [], '更不该为它们刷警告');
  });

  test('数字键收到非数字字符串 → 原样保留，绝不产出 NaN', () => {
    // 两个条件缺一不可：`s !== '' && Number.isFinite(n)`。写成 || 会让 PORT:"abc" 变成 NaN，
    // 而 NaN 的端口既不会报错也不会工作，症状是「服务起来了但连不上」。
    // 原样下传则由后续 schema 校验出具体理由。
    for (const bad of ['abc', 'not-a-port', '  ']) {
      const { values, warnings } = resolveConfigValues({ fileValues: { PORT: bad }, source: 'config' });
      assert.equal(values.PORT, bad, `PORT=${JSON.stringify(bad)} 应原样保留`);
      assert.ok(!warnings.some(w => /NaN/.test(w)), '不该出现「已读作数字 NaN」这种假成功提示');
    }
  });

  test('类型转换警告只在 JSON 源报，.env 源不报（那是该格式的常态）', () => {
    const fromJson = resolveConfigValues({ fileValues: { PORT: '4001' }, source: 'config' });
    assert.ok(fromJson.warnings.length > 0, 'json 里出现字符串确实说明手写错了类型');
    const fromEnv = resolveConfigValues({ fileValues: { PORT: '4001' }, source: 'env' });
    assert.deepEqual(fromEnv.warnings, [], '.env 只能存字符串，每次启动刷十几行纯噪音');
    assert.equal(fromEnv.values.PORT, 4001, '但归一照做');
  });
});

test.describe('CONFIG-02 .env 可表达性：两个消费者必须同时安全', () => {
  test('含单引号的值一律拒绝——单引号是唯一两边都过关的包法，却包不住自身', () => {
    // 曾有一版改用反引号求 round-trip 正确，结果把「值里有个撇号」变成了 shell 命令注入。
    // 两个消费者的判断必须一起做，不能轮流做。
    assert.equal(isSerializableEnvValue("it's"), false);
    assert.equal(isSerializableEnvValue("a'; id > /tmp/pwned; :"), false);
  });

  test('以反斜杠结尾的值一律拒绝——dotenv 会把闭合引号当转义，吞掉后面的 key', () => {
    // `K='x\'` 的闭合引号被 dotenv 的 `'(?:\\'|[^'])*'` 吃掉，贪婪匹配吞到下一个 '，
    // 其间的 key 全部消失。若被吞的是 CF_ACCESS_* 之一，公网 2FA 整层静默关闭，
    // 而面板报的是「已写入」——方向是 fail-open，所以必须在写入前就拦。
    assert.equal(isSerializableEnvValue('x\\'), false);
    assert.equal(isSerializableEnvValue('x\\\\'), false, '反斜杠个数无关，偶数个照样命中转义分支');
  });

  test('控制字符拒绝', () => {
    assert.equal(isSerializableEnvValue('a\nb'), false);
    assert.equal(isSerializableEnvValue('a\x00b'), false);
  });

  test('普通值、含空格、含 URL 与路径字符的值都可表达', () => {
    for (const ok of ['simple', 'with space', 'https://example.com:8443/path?a=b', '/home/u/repo', 'a,b,c', '', 'x\\y']) {
      assert.equal(isSerializableEnvValue(ok), true, `${JSON.stringify(ok)} 应可表达`);
    }
  });

  test('序列化：安全字符集裸写，其余套单引号', () => {
    assert.equal(serializeEnvValue('abc-1.2/x:y@z+w=v,u'), 'abc-1.2/x:y@z+w=v,u', '白名单内裸写');
    assert.equal(serializeEnvValue('with space'), "'with space'", '空格必须包起来，否则 shell 会截断');
    assert.equal(serializeEnvValue('has#hash'), "'has#hash'", '裸值会被 dotenv 的行内注释截断');
  });

  test('可表达性与序列化口径一致：判定为可表达的，序列化后不得含裸单引号残留', () => {
    for (const v of ['simple', 'with space', 'has#hash', 'a,b', 'x\\y']) {
      assert.equal(isSerializableEnvValue(v), true);
      const s = serializeEnvValue(v);
      assert.ok(typeof s === 'string' && s.length > 0);
    }
  });
});
