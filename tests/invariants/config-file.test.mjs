// tests/invariants/config-file.test.mjs —— 配置读取的源选择、优先级与 .env 可表达性
// 守护：CONFIG-01（读写同源、shell 压过文件、ANTHROPIC_* 只认真实 shell、未登记键读宽写严）、CONFIG-02（.env 的 dotenv 与 shell source 两个消费者必须同时安全）
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
import {
  loadConfigSources, resolveConfigValues, reloadKindOf, diffReloadKinds,
  applyConfigChanges, structuredToStringValues, projectToEnv, createConfigReloader,
} from '../../app/src/ops/config-file.js';
import {
  isSerializableEnvValue, serializeEnvValue, maskSecret, shellOverriddenKeys, applyEnvChanges,
} from '../../app/src/ops/env-file.js';
import { validateEnvChanges } from '../../app/src/ops/env-schema.js';

let base;
test.before(() => { base = mkdtempSync(join(tmpdir(), 'ccm-inv-config-')); });
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

// ── 热加载分类、写入侧归一与 .env 文本编辑 ─────────────────────────────────
// 本节补的是变异对比里本文件相对已退役旧测试【整块缺失】的覆盖面（约 37 个变异点）。
test.describe('热加载分类：漏报比误报危险得多', () => {
  test('只有 schema 标 reload:hot 的键能热加载，其余一律 restart', () => {
    // 缺省 restart 是刻意的保守方向：误报重启只是让用户多操作一次，
    // 漏报则是「改了没生效还以为生效了」。
    assert.equal(reloadKindOf('WORKDIRS'), 'hot', 'WORKDIRS 是当前唯一的热加载项');
    assert.equal(reloadKindOf('PORT'), 'restart');
    assert.equal(reloadKindOf('AUTH_TOKEN'), 'restart');
    assert.equal(reloadKindOf('COMPLETELY_UNKNOWN_KEY'), 'restart', '未登记键也按需重启处理');
  });

  test('diffReloadKinds 按类别分组并排序', () => {
    const d = diffReloadKinds({ PORT: 3000 }, { PORT: 4000, AUTH_TOKEN: 'x' });
    assert.deepEqual(d.restart, ['AUTH_TOKEN', 'PORT'], '结果要稳定排序，便于比对与日志');
    assert.deepEqual(d.hot, []);
  });

  test('值未变的键不进任何分组——数组/对象要深比较', () => {
    // 热加载每次都重读文件，数组必然是新引用。按引用比会把「没改」判成「改了」，
    // 于是每次文件事件都广播一轮，前端目录面板反复重建。
    const prev = { WORKDIRS: ['/a', '/b'] };
    const next = { WORKDIRS: ['/a', '/b'] };
    assert.deepEqual(diffReloadKinds(prev, next), { hot: [], restart: [] }, '同内容不同引用不算变更');

    const changed = diffReloadKinds(prev, { WORKDIRS: ['/a', '/c'] });
    assert.deepEqual(changed.hot, ['WORKDIRS']);
  });

  test('新增与删除都算变更', () => {
    assert.deepEqual(diffReloadKinds({}, { PORT: 1 }).restart, ['PORT']);
    assert.deepEqual(diffReloadKinds({ PORT: 1 }, {}).restart, ['PORT']);
  });
});

test.describe('applyConfigChanges：三种输入形态都要接', () => {
  test('字符串按 schema 归一（设置面板的表单只有字符串）', () => {
    const next = applyConfigChanges({}, { PORT: '4001' });
    assert.equal(next.PORT, 4001, '面板发来的字符串必须归一成数字，否则写进 json 是 "4001"');
  });

  test('原生类型直接采用（CLI 与 desktop 发结构化值）', () => {
    assert.equal(applyConfigChanges({}, { PORT: 4001 }).PORT, 4001);
    assert.deepEqual(applyConfigChanges({}, { WORKDIRS: ['/a'] }).WORKDIRS, ['/a']);
  });

  test('null / undefined / 空串一律【删除】而非写空值占位', () => {
    // 留一个 `KEY=` 既无意义，又会挡住从 shell export 同名变量。
    for (const del of [null, undefined, '']) {
      const next = applyConfigChanges({ AUTH_TOKEN: 'old' }, { AUTH_TOKEN: del });
      assert.equal('AUTH_TOKEN' in next, false, `${String(del)} 应删除键本身`);
    }
  });

  test('返回新对象，不就地改（调用方要能先 dry-run 比对）', () => {
    const current = { PORT: 3000 };
    const next = applyConfigChanges(current, { PORT: 4000 });
    assert.equal(current.PORT, 3000, '原对象不得被改动');
    assert.notEqual(next, current);
  });

  test('未提及的键原样保留，并盖上 schema 版本号', () => {
    const next = applyConfigChanges({ AUTH_TOKEN: 'keep' }, { PORT: 1 });
    assert.equal(next.AUTH_TOKEN, 'keep');
    assert.ok(Object.keys(next).some(k => /version/i.test(k)), '写入时要记录 schema 版本');
  });
});

test.describe('structuredToStringValues：投影回环境变量', () => {
  test('空串折叠成「不设这个键」', () => {
    const out = structuredToStringValues({ AUTH_TOKEN: '' });
    assert.equal('AUTH_TOKEN' in out, false);
  });

  test('未登记键原样带上（server 起来后子进程要靠它）', () => {
    const out = structuredToStringValues({ HTTPS_PROXY: 'http://127.0.0.1:1' });
    assert.equal(out.HTTPS_PROXY, 'http://127.0.0.1:1');
  });

  test('未登记键的空值同样丢弃，不留空占位', () => {
    assert.equal('X_EMPTY' in structuredToStringValues({ X_EMPTY: '' }), false);
    assert.equal('X_NULL' in structuredToStringValues({ X_NULL: null }), false);
  });

  test('数字与布尔投影成字符串', () => {
    const out = structuredToStringValues({ PORT: 4001 });
    assert.equal(typeof out.PORT, 'string');
    assert.equal(out.PORT, '4001');
  });
});

test.describe('maskSecret：敏感项只报「设了没 + 多长」', () => {
  test('绝不回显明文', () => {
    const r = maskSecret('super-secret-token-value');
    assert.deepEqual(r, { set: true, length: 24 });
    assert.ok(!JSON.stringify(r).includes('secret'), '返回结构里不得含明文片段');
  });

  test('空串与非字符串一律视为未设置', () => {
    assert.deepEqual(maskSecret(''), { set: false, length: 0 });
    for (const bad of [null, undefined, 42, {}]) {
      assert.deepEqual(maskSecret(bad), { set: false, length: 0 });
    }
  });
});

test.describe('shellOverriddenKeys：两个消费者共用的唯一实现', () => {
  // doctor 的整体诊断与配置面板的逐行标注问的是同一个问题。各写一份的话，分叉之后
  // 两边都不会报错——面板说「没被覆盖」、doctor 说「被覆盖了」，只有用户被误导。
  test('只报真正被 shell 设过的键', () => {
    assert.deepEqual(shellOverriddenKeys({ PORT: '5000' }, ['PORT', 'AUTH_TOKEN']), ['PORT']);
  });

  test('空串按未设置口径（与启动期删空串 key 的行为一致）', () => {
    assert.deepEqual(shellOverriddenKeys({ PORT: '' }, ['PORT']), []);
  });

  test('原型链上的键不得被误报（typeof 判串而非真值判断）', () => {
    // 裸 shellEnv[k] 对 'constructor' / 'toString' 恒 truthy，会把它们报成「被覆盖」。
    assert.deepEqual(shellOverriddenKeys({}, ['constructor', 'toString', 'valueOf']), []);
  });

  test('非对象 shellEnv 与空键表 → 空结果，不抛错', () => {
    assert.deepEqual(shellOverriddenKeys(null, ['PORT']), []);
    assert.deepEqual(shellOverriddenKeys({ PORT: '1' }, []), []);
  });

  // 内联 WORKDIRS 被两个不同名的 shell 键压着（优先级 WORK_DIRS > WORK_DIRS_FILE > 内联）。只按同名判，
  // 面板那一行与正常行一模一样，改完「已保存」、运行时仍是 shell 那份（2026-09-22 review P2）。
  test('WORKDIRS 被 shell 的 WORK_DIRS / WORK_DIRS_FILE 压着也算被覆盖；空串照旧不算', () => {
    assert.deepEqual(shellOverriddenKeys({ WORK_DIRS: '/srv/b' }, ['WORKDIRS', 'PORT']), ['WORKDIRS']);
    assert.deepEqual(shellOverriddenKeys({ WORK_DIRS_FILE: '/srv/w.json' }, ['WORKDIRS', 'WORK_DIRS_FILE']), ['WORKDIRS', 'WORK_DIRS_FILE']);
    assert.deepEqual(shellOverriddenKeys({ WORK_DIRS: '' }, ['WORKDIRS']), []);
  });
});

test.describe('applyEnvChanges：改值不得弄丢 export 前缀', () => {
  test('保留 `export ` 与缩进原文', () => {
    // 上一版只拼 `${key}=…`，于是改一次值就把 export 弄丢了。后果不在 dotenv 侧
    // （它本来就不管 export），而在第二个消费者：用户 source .env 之后那个变量
    // 不再被导出、子进程读不到，而 .env 看上去一切正常。
    const out = applyEnvChanges('export PORT=3000\n', { PORT: '4000' });
    assert.match(out, /export PORT=4000/, 'export 前缀必须原样拼回去');
  });

  test('null 表示整行删除，不是写成 KEY=', () => {
    const out = applyEnvChanges('PORT=3000\nAUTH_TOKEN=x\n', { PORT: null });
    assert.doesNotMatch(out, /PORT/, '留一行 PORT= 会挡住从 shell export 同名变量');
    assert.match(out, /AUTH_TOKEN=x/, '其它行不受影响');
  });

  test('缺席的键完全不动', () => {
    const src = 'PORT=3000\n# 注释\nAUTH_TOKEN=x\n';
    assert.equal(applyEnvChanges(src, {}), src);
  });

  test('新键追加到文件末尾', () => {
    const out = applyEnvChanges('PORT=3000\n', { AUTH_TOKEN: 'new' });
    assert.match(out, /PORT=3000/);
    assert.match(out, /AUTH_TOKEN=new/);
  });

  test('注释与空行保留（用户手写的说明不该被工具吃掉）', () => {
    const out = applyEnvChanges('# 我的说明\n\nPORT=3000\n', { PORT: '4000' });
    assert.match(out, /# 我的说明/);
  });
});

test.describe('projectToEnv：list 明确放弃投影，不是遗漏', () => {
  test('list 类型返回 null —— 投成字符串会把 "[object Object]" 塞进工作区白名单', () => {
    // app.js 的 `(process.env.WORK_DIRS || '').split(',')` 会把投影结果当目录名，
    // 而 realpath 校验失败只 warn-skip，用户看不到任何异常。消费方必须直接读结构化配置。
    assert.equal(projectToEnv('WORKDIRS', ['/a', '/b']), null);
  });

  test('toggle 按 on/off 字面量投影', () => {
    const on = projectToEnv('DEV_MODE', true);
    const off = projectToEnv('DEV_MODE', false);
    assert.notEqual(on, off, '两个方向必须投影成不同的值');
  });

  test('number 投影成字符串，null 折叠成不设', () => {
    assert.equal(projectToEnv('PORT', 4001), '4001');
    assert.equal(projectToEnv('PORT', null), null);
  });

  test('未登记键按字符串原样投影——放行必须三处一起改', () => {
    // 只放行 resolveConfigValues 而这里仍返回 null，结果是「配置文件里看得见、
    // process.env 里没有」，claude 子进程照样拿不到。
    assert.equal(projectToEnv('HTTPS_PROXY', 'http://127.0.0.1:1'), 'http://127.0.0.1:1');
    assert.equal(projectToEnv('HTTPS_PROXY', ''), null, '空串仍折叠成不设');
  });
});

test.describe('structuredToStringValues：必须先 coerce 再投影', () => {
  test('手写的字符串 "off" 不得被当成 truthy 而翻转方向', () => {
    // projectToEnv 的 toggle 分支假定输入已是 boolean，而非空字符串全是 truthy。
    // 少了 coerce 这一步，方向整个翻过来：面板显示「已开启」而运行时读作关闭，
    // config check 还会跟着报「配置检查通过」。
    const fromBool = structuredToStringValues({ DEV_MODE: false });
    const fromStr = structuredToStringValues({ DEV_MODE: 'off' });
    assert.deepEqual(fromStr, fromBool, '手写字符串 "off" 必须与布尔 false 投影一致');
  });

  test('"false" 同样按关处理', () => {
    const fromBool = structuredToStringValues({ DEV_MODE: false });
    assert.deepEqual(structuredToStringValues({ DEV_MODE: 'false' }), fromBool);
  });
});

test.describe('createConfigReloader：读失败保留旧快照', () => {
  const reloader = (reads) => {
    const hot = [], restart = [];
    let i = 0;
    const r = createConfigReloader({
      readConfig: () => reads[i++],
      onHot: keys => hot.push(...keys),
      onRestart: keys => restart.push(...keys),
    });
    return { r, hot, restart };
  };

  test('读到 null 时不动快照——把 null 当空配置会把整个白名单判成「全部删除」', () => {
    // 与 reloadWorkdirs 的「读取失败保留旧白名单」同一立场：一次编辑器写到一半的读取
    // 不该触发一轮「所有目录都没了」的广播。
    const { r, hot, restart } = reloader([{ WORKDIRS: ['/a'] }, null]);
    r.prime();
    r.handleChange();
    assert.deepEqual(hot, [], '读失败不得产生任何变更回调');
    assert.deepEqual(restart, []);
  });

  test('正常变更按类别分派', () => {
    const { r, hot, restart } = reloader([{ WORKDIRS: ['/a'], PORT: 3000 }, { WORKDIRS: ['/b'], PORT: 4000 }]);
    r.prime();
    r.handleChange();
    assert.deepEqual(hot, ['WORKDIRS']);
    assert.deepEqual(restart, ['PORT']);
  });

  test('未 prime 时首次变更把所有项算作新增，不炸', () => {
    const { r, restart } = reloader([{ PORT: 3000 }]);
    assert.doesNotThrow(() => r.handleChange());
    assert.deepEqual(restart, ['PORT']);
  });

  test('prime 读失败时快照留空，后续变更仍能正常分派', () => {
    const { r, restart } = reloader([null, { PORT: 3000 }]);
    r.prime();
    r.handleChange();
    assert.deepEqual(restart, ['PORT']);
  });

  test('回调缺席不抛错（onHot/onRestart 都是可选的）', () => {
    const r = createConfigReloader({ readConfig: () => ({ PORT: 1 }) });
    assert.doesNotThrow(() => { r.prime(); r.handleChange(); });
  });
});

// 写入目标 ≠ 启动读取目标 = 假成功（docs/testing.md 失败方向表）。WORKDIRS 的读取优先级是
// shell WORK_DIRS > WORK_DIRS_FILE > 内联 WORKDIRS，而配置文件里的 WORK_DIRS_FILE 会被投影进 process.env、
// 与 shell 的同权——它挂着的时候面板改 WORKDIRS 报「已保存」，重启后工作区纹丝不动（2026-09-22 review P2）。
test.describe('CONFIG-01 写了等于没写的，写入侧当场拒', () => {
  const home = '/home/tester';

  test('配置里挂着 WORK_DIRS_FILE 时改 WORKDIRS → 拒绝，并说清先清空它', () => {
    const r = validateEnvChanges({ WORKDIRS: ['/srv/project-a'] }, { current: { WORK_DIRS_FILE: '/srv/workdirs.json' }, home });
    assert.equal(r.ok, false, '它压着 WORKDIRS：放行就是一次「保存成功、重启后毫无变化」');
    const msg = r.results.find(x => x.key === 'WORKDIRS').message;
    assert.match(msg, /WORK_DIRS_FILE/);
    assert.doesNotMatch(msg, /migrate/, 'JSON 配置下 config migrate 走不通（配置文件已存在就拒绝），不能指这条路');
  });

  test('同一批里把 WORK_DIRS_FILE 清掉（null）→ 放行（这正是出路）', () => {
    const r = validateEnvChanges({ WORKDIRS: ['/srv/project-a'], WORK_DIRS_FILE: null },
      { current: { WORK_DIRS_FILE: '/srv/workdirs.json' }, home });
    assert.equal(r.ok, true, '清空之后 WORKDIRS 就是生效的那一份');
  });

  test('没挂 WORK_DIRS_FILE → 照常放行（正对照：这道闸不是恒拒）', () => {
    assert.equal(validateEnvChanges({ WORKDIRS: ['/srv/project-a'] }, { current: {}, home }).ok, true);
  });
});
