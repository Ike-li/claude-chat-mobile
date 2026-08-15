// tests/unit/env-schema.test.mjs —— 配置面板的 schema 与保存前校验
//
// 校验的立场是**全或无**：任何一项 error 就整体拒写。部分生效的配置比不写更糟 ——
// 用户以为改好了，server 却起不来，而且不知道是哪一半生效了。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENV_GROUPS,
  ENV_SCHEMA,
  READONLY_DIAGNOSTICS,
  WRITABLE_KEYS,
  buildEnvView,
  validateEnvChanges,
} from '../../src/ops/env-schema.js';

const deps = (over = {}) => ({
  fileExists: () => true,
  isWritable: () => true,
  isExecutable: () => true,
  probePort: () => false, // false = 端口空闲
  current: {},
  ...over,
});

const errorsOf = (r) => r.results.filter((x) => x.level === 'error').map((x) => x.key);

test.describe('schema 结构完整性', () => {
  test('每一项都有 group 与 label 的中英双语', () => {
    for (const [key, def] of Object.entries(ENV_SCHEMA)) {
      assert.ok(def.group, `${key} 缺 group`);
      assert.ok(def.label?.zh && def.label?.en, `${key} 的 label 缺中文或英文`);
    }
  });

  test('每个 group id 都在 ENV_GROUPS 里有定义（否则前端渲染不出来）', () => {
    const ids = new Set(ENV_GROUPS.map((g) => g.id));
    for (const [key, def] of Object.entries(ENV_SCHEMA)) {
      assert.ok(ids.has(def.group), `${key} 的 group=${def.group} 未在 ENV_GROUPS 中定义`);
    }
  });

  // 逐 key 声明真值字面量，绝不用统一 truthy —— log-terminal.js:32 的经典脚枪：
  // LOG_STDERR=false 在 truthy 判定下反而是「开」。
  test('每个 toggle 都显式声明了 on/off 的字面量', () => {
    for (const [key, def] of Object.entries(ENV_SCHEMA)) {
      if (def.kind !== 'toggle') continue;
      assert.ok(def.values && typeof def.values.on === 'string' && typeof def.values.off === 'string',
        `${key} 未声明 values.on / values.off`);
    }
  });

  test('三条硬边界不在可写清单里', () => {
    assert.ok(!WRITABLE_KEYS.includes('AUTH_TOKEN'), 'AUTH_TOKEN 必须只读');
    assert.ok(!WRITABLE_KEYS.includes('CCM_DATA_DIR'), 'CCM_DATA_DIR 不该出现在 schema');
    assert.ok(!Object.keys(ENV_SCHEMA).some((k) => k.startsWith('ANTHROPIC_')), 'ANTHROPIC_* 不该做成表单');
  });

  test('测试专用变量一个都不在里面', () => {
    for (const k of Object.keys(ENV_SCHEMA)) {
      assert.ok(!k.startsWith('CCM_TEST'), `${k} 是测试专用变量`);
    }
    assert.ok(!Object.hasOwn(ENV_SCHEMA, 'CCM_BUILD_NONCE'));
    assert.ok(!Object.hasOwn(ENV_SCHEMA, 'WORK_DIRS'), '遗留的逗号形式不给第二个入口');
  });

  test('只读诊断里点名了 ANTHROPIC_* 与 CCM_DATA_DIR', () => {
    const keys = READONLY_DIAGNOSTICS.map((d) => d.key);
    assert.ok(keys.some((k) => k.startsWith('ANTHROPIC')));
    assert.ok(keys.includes('CCM_DATA_DIR'));
  });
});

test.describe('白名单：不是通用 .env 编辑器', () => {
  test('schema 之外的 key 一律拒绝', () => {
    const r = validateEnvChanges({ RANDOM_THING: 'x' }, deps());
    assert.equal(r.ok, false);
    assert.deepEqual(errorsOf(r), ['RANDOM_THING']);
  });

  test('只读项拒绝写入', () => {
    assert.equal(validateEnvChanges({ AUTH_TOKEN: 'new' }, deps()).ok, false);
  });

  // ★ ENV_SCHEMA 是普通对象字面量，原型是 Object.prototype ⇒ ENV_SCHEMA['toString'] 等恒 truthy。
  // 早前判据写的是 `const def = ENV_SCHEMA[key]; if (!def) 拒绝`，这些 key 全都畅通无阻地写进了 .env。
  // 下游还会污染 process.env 上的 Object.prototype 方法（toString 被字符串遮蔽后 String(env) 抛错）。
  test('原型链上的 key 一律拒绝（constructor / toString / __proto__ / hasOwnProperty）', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
      const r = validateEnvChanges({ [key]: 'pwned' }, deps());
      assert.equal(r.ok, false, `${key} 必须被拒绝`);
      assert.deepEqual(errorsOf(r), [key]);
    }
  });

  test('JSON.parse 出来的 __proto__（own property，socket 的真实形态）同样被拒', () => {
    const changes = JSON.parse('{"__proto__":"pwned","PORT":"8080"}');
    assert.equal(validateEnvChanges(changes, deps()).ok, false);
  });

  test('ANTHROPIC_* 拒绝写入（写了也会被启动期剥除，等于骗人）', () => {
    const r = validateEnvChanges({ ANTHROPIC_BASE_URL: 'https://x' }, deps());
    assert.equal(r.ok, false);
    assert.match(r.results[0].message, /shell|剥除|启动/);
  });
});

test.describe('类型校验', () => {
  test('PORT 越界 → error', () => {
    assert.equal(validateEnvChanges({ PORT: '0' }, deps()).ok, false);
    assert.equal(validateEnvChanges({ PORT: '70000' }, deps()).ok, false);
    assert.equal(validateEnvChanges({ PORT: 'abc' }, deps()).ok, false);
  });

  test('PORT 合法 → ok', () => {
    assert.equal(validateEnvChanges({ PORT: '8080' }, deps()).ok, true);
  });

  // 当前 server 正绑在旧 PORT 上，无条件探测会恒报占用 —— 这正是 doctor D4 的既有 bug，别复制过来。
  test('PORT 没变时不探测端口占用', () => {
    let probed = false;
    const r = validateEnvChanges({ PORT: '3000' }, deps({
      current: { PORT: '3000' },
      probePort: () => { probed = true; return true; },
    }));
    assert.equal(probed, false, '值没变就别探测，否则恒报「被自己占用」');
    assert.equal(r.ok, true);
  });

  // ★ .env 里没有 PORT 行时 server 跑在默认 3000（config.js:57）。把面板里的 PORT 显式填成 3000
  // 不是「改端口」，可早前判据只看 .env 里写没写 ⇒ 判定为变了 ⇒ 探到自己 ⇒ 报占用。
  // 而且是全或无，这一条会把同批次其他改动一起挡掉。与刚修的 doctor D4 恒红是同一类判据错误。
  test('.env 无 PORT 行、面板填的正是当前生效的默认端口 → 不探测、不报占用', () => {
    let probed = false;
    const r = validateEnvChanges({ PORT: '3000' }, deps({
      current: {},
      probePort: () => { probed = true; return true; },
    }));
    assert.equal(probed, false, '生效值没变就不该探测');
    assert.equal(r.ok, true);
  });

  test('.env 无 PORT 行、面板改成别的端口 → 照常探测', () => {
    let probed = null;
    const r = validateEnvChanges({ PORT: '8080' }, deps({
      current: {},
      probePort: (p) => { probed = p; return true; },
    }));
    assert.equal(probed, 8080);
    assert.equal(r.ok, false);
  });

  test('PORT 变了且新端口被占 → error', () => {
    const r = validateEnvChanges({ PORT: '8080' }, deps({ current: { PORT: '3000' }, probePort: () => true }));
    assert.equal(r.ok, false);
    assert.match(r.results[0].message, /占用/);
  });

  test('路径不存在 → error', () => {
    assert.equal(validateEnvChanges({ WORK_DIR: '/nope' }, deps({ fileExists: () => false })).ok, false);
  });

  test('路径不可写 → error', () => {
    assert.equal(validateEnvChanges({ WORK_DIR: '/ro' }, deps({ isWritable: () => false })).ok, false);
  });

  test('CLAUDE_BIN 不可执行 → error', () => {
    assert.equal(validateEnvChanges({ CLAUDE_BIN: '/x' }, deps({ isExecutable: () => false })).ok, false);
  });

  test('相对路径 → error（启动后 cwd 未必是仓库根）', () => {
    assert.equal(validateEnvChanges({ WORK_DIR: './rel' }, deps()).ok, false);
  });

  test('toggle 只接受声明过的字面量', () => {
    assert.equal(validateEnvChanges({ DEV_MODE: '1' }, deps()).ok, true);
    assert.equal(validateEnvChanges({ DEV_MODE: '' }, deps()).ok, true);
    // 'true' / 'false' / 'yes' 都不是 DEV_MODE 认的值，写进去是静默失效
    assert.equal(validateEnvChanges({ DEV_MODE: 'true' }, deps()).ok, false);
    assert.equal(validateEnvChanges({ LOG_TERMINAL: '1' }, deps()).ok, false, 'LOG_TERMINAL 认的是 on 不是 1');
    assert.equal(validateEnvChanges({ WEB_STATUSLINE: '0' }, deps()).ok, false, 'WEB_STATUSLINE 认的是 off');
  });

  // 用 PUBLIC_URL 测格式：NTFY_URL 带 together 成对约束，单独填一项本来就该被拒，
  // 拿它测格式会把两条规则搅在一起。
  test('URL 必须是 http/https', () => {
    assert.equal(validateEnvChanges({ PUBLIC_URL: 'https://x.example.com' }, deps()).ok, true);
    assert.equal(validateEnvChanges({ PUBLIC_URL: 'ftp://x' }, deps()).ok, false);
    assert.equal(validateEnvChanges({ PUBLIC_URL: '不是URL' }, deps()).ok, false);
  });

  test('VAPID_SUBJECT 额外允许 mailto:（三项一起给，绕开成对约束）', () => {
    const r = validateEnvChanges(
      { VAPID_PUBLIC_KEY: 'pk', VAPID_PRIVATE_KEY: 'sk', VAPID_SUBJECT: 'mailto:you@example.com' },
      deps()
    );
    assert.equal(r.ok, true);
  });

  test('VAPID_SUBJECT 是 ftp: 仍拒（mailto 是额外放行不是放弃校验）', () => {
    const r = validateEnvChanges(
      { VAPID_PUBLIC_KEY: 'pk', VAPID_PRIVATE_KEY: 'sk', VAPID_SUBJECT: 'ftp://x' },
      deps()
    );
    assert.equal(r.ok, false);
  });

  test('值含换行 → error（.env 是行格式，塞进去就是语法错误）', () => {
    assert.equal(validateEnvChanges({ NTFY_TOKEN: 'a\nb' }, deps()).ok, false);
  });

  test('null（删除）跳过类型校验', () => {
    assert.equal(validateEnvChanges({ PORT: null, WORK_DIR: null }, deps()).ok, true);
  });
});

test.describe('成套配置：全设或全空', () => {
  test('VAPID 只填一项 → error', () => {
    const r = validateEnvChanges({ VAPID_PUBLIC_KEY: 'pk' }, deps());
    assert.equal(r.ok, false);
    assert.match(r.results.find((x) => x.level === 'error').message, /三项|一起|同时/);
  });

  test('VAPID 三项齐全 → ok', () => {
    const r = validateEnvChanges(
      { VAPID_PUBLIC_KEY: 'pk', VAPID_PRIVATE_KEY: 'sk', VAPID_SUBJECT: 'mailto:a@b.c' },
      deps()
    );
    assert.equal(r.ok, true);
  });

  test('已有两项、这次补上第三项 → ok（要看合并后的最终状态，不是只看本次改动）', () => {
    const r = validateEnvChanges(
      { VAPID_SUBJECT: 'mailto:a@b.c' },
      deps({ current: { VAPID_PUBLIC_KEY: 'pk', VAPID_PRIVATE_KEY: 'sk' } })
    );
    assert.equal(r.ok, true);
  });

  test('删掉三项中的一项 → error（剩两项等于半开状态）', () => {
    const r = validateEnvChanges(
      { VAPID_SUBJECT: null },
      deps({ current: { VAPID_PUBLIC_KEY: 'pk', VAPID_PRIVATE_KEY: 'sk', VAPID_SUBJECT: 'mailto:a@b.c' } })
    );
    assert.equal(r.ok, false);
  });

  test('三项一起删 → ok（整组关掉是合法操作）', () => {
    const r = validateEnvChanges(
      { VAPID_PUBLIC_KEY: null, VAPID_PRIVATE_KEY: null, VAPID_SUBJECT: null },
      deps({ current: { VAPID_PUBLIC_KEY: 'pk', VAPID_PRIVATE_KEY: 'sk', VAPID_SUBJECT: 'mailto:a@b.c' } })
    );
    assert.equal(r.ok, true);
  });

  test('NTFY_URL 与 TOPIC 成对（TOKEN 可选）', () => {
    assert.equal(validateEnvChanges({ NTFY_URL: 'https://n.x' }, deps()).ok, false);
    assert.equal(validateEnvChanges({ NTFY_URL: 'https://n.x', NTFY_TOPIC: 'tp' }, deps()).ok, true);
    assert.equal(validateEnvChanges({ NTFY_TOKEN: 'tk' }, deps()).ok, true, 'TOKEN 独立可选');
  });
});

test.describe('全或无', () => {
  test('一项 error 就整体拒写，即使其它项都合法', () => {
    const r = validateEnvChanges({ PORT: '8080', WORK_DIR: '/nope' }, deps({ fileExists: (p) => p !== '/nope' }));
    assert.equal(r.ok, false);
    assert.deepEqual(errorsOf(r), ['WORK_DIR']);
  });

  test('warn 不阻断（但要报出来让 UI 弹确认）', () => {
    const r = validateEnvChanges({ DEBUG_SDK_MESSAGES: '1' }, deps());
    assert.equal(r.ok, true);
    assert.ok(r.results.some((x) => x.level === 'warn'), '长开 SDK 调试日志该提醒');
  });

  test('空改动 → ok 且无结果', () => {
    const r = validateEnvChanges({}, deps());
    assert.equal(r.ok, true);
    assert.deepEqual(r.results, []);
  });
});

test.describe('buildEnvView —— 下发给前端的视图', () => {
  const values = {
    PORT: '3000',
    AUTH_TOKEN: 'a'.repeat(64),
    VAPID_PRIVATE_KEY: 'secret-key-here',
    DEV_MODE: '1',
  };

  test('敏感项只给 set + length，绝不回显明文', () => {
    const view = buildEnvView(values);
    const json = JSON.stringify(view);
    assert.ok(!json.includes('a'.repeat(64)), 'AUTH_TOKEN 明文不能下发');
    assert.ok(!json.includes('secret-key-here'), 'VAPID 私钥明文不能下发');
  });

  test('敏感项带 set/length 供 UI 显示「已设置（N 字符）」', () => {
    const item = buildEnvView(values).groups
      .flatMap((g) => g.items).find((i) => i.key === 'AUTH_TOKEN');
    assert.deepEqual(item.masked, { set: true, length: 64 });
    assert.equal(item.value, undefined, '敏感项不该有 value 字段');
  });

  test('非敏感项给出当前值', () => {
    const item = buildEnvView(values).groups.flatMap((g) => g.items).find((i) => i.key === 'PORT');
    assert.equal(item.value, '3000');
  });

  test('只读项标记 readonly，UI 据此禁用输入', () => {
    const item = buildEnvView(values).groups.flatMap((g) => g.items).find((i) => i.key === 'AUTH_TOKEN');
    assert.equal(item.readonly, true);
  });

  test('分组顺序与 ENV_GROUPS 一致', () => {
    assert.deepEqual(buildEnvView(values).groups.map((g) => g.id), ENV_GROUPS.map((g) => g.id));
  });

  test('未设置的项给空值而不是缺席（UI 要能渲染出空输入框）', () => {
    const item = buildEnvView({}).groups.flatMap((g) => g.items).find((i) => i.key === 'NTFY_TOPIC');
    assert.equal(item.value, '');
  });

  test('带上只读诊断段', () => {
    assert.ok(buildEnvView(values).readonlyDiagnostics.length >= 2);
  });
});

// 校验期与序列化期必须用同一判据 —— 否则「校验说 ok、写盘时抛错」，
// 用户填完点保存才收到一句看不懂的异常。
test.describe('校验期与序列化期对齐', () => {
  test('含单引号的值在校验期就被拒（不是等到写盘抛错）', () => {
    const r = validateEnvChanges({ NTFY_TOKEN: "it's mine" }, deps());
    assert.equal(r.ok, false);
    assert.match(r.results[0].message, /单引号/);
  });

  test('含换行同样在校验期拒', () => {
    assert.equal(validateEnvChanges({ NTFY_TOPIC: 'a\nb' }, deps()).ok, false);
  });

  // 用 NTFY_TOKEN：它没有 together 成对约束，不会把两条规则搅在一起。
  test('shell 元字符（$ ` 等）合法 —— 它们会被单引号安全包住，不该误伤', () => {
    assert.equal(validateEnvChanges({ NTFY_TOKEN: 'a$(id)b' }, deps()).ok, true);
    assert.equal(validateEnvChanges({ NTFY_TOKEN: 'x${HOME}y' }, deps()).ok, true);
    assert.equal(validateEnvChanges({ NTFY_TOKEN: 'cmd `id`' }, deps()).ok, true);
  });
});

// 第三轮审查 #1 的校验期一侧：三个否定条件各给各的理由。
// 合并成一句会让「路径末尾多打了个反斜杠」收到一句关于单引号的提示，用户照着改也改不对。
test.describe('validateEnvChanges —— 以反斜杠结尾的值在校验期就被拒绝', () => {
  test('拒绝，且理由说的是反斜杠不是单引号', () => {
    // 两项同时给：NTFY_URL / NTFY_TOPIC 有 together 约束，只填一项会被另一条规则先拦下
    const r = validateEnvChanges({ NTFY_URL: 'https://ntfy.sh/a', NTFY_TOPIC: 'my-topic\\' });
    assert.equal(r.ok, false, '必须拒绝');
    const msg = r.results.map((x) => x.message).join(' ');
    assert.match(msg, /反斜杠/, `理由应指向反斜杠，实际：${msg}`);
    assert.doesNotMatch(msg, /单引号/, `不该提单引号，实际：${msg}`);
  });

  test('反斜杠不在结尾则放行（不过度收紧）', () => {
    assert.equal(validateEnvChanges({ NTFY_URL: 'https://ntfy.sh/a', NTFY_TOPIC: 'my\\topic' }).ok, true);
  });
});

// 第三轮审查 #10：CF_ACCESS_* 是**另一条鉴权轴**（公网 2FA），而 AUTH_TOKEN 因「极易把自己锁在
// 门外」被钉成 readonly。现状是持有 LAN 层凭据 + 设备批准就能把公网层整个删掉，且零告警零确认 ——
// 第二因子可以被第一因子静默删除。配合本批把 dev:restart 放宽到 isSupervised()（生产恒 true），
// 这成了手机上一次会话内可完成的闭环。
//
// 不改成 readonly（那会让手机上配不了 CF Access），改成**必须显式确认**：前端对 warn 会弹
// appConfirm 再重发，用户至少被告知自己在关掉什么。
test.describe('validateEnvChanges —— 清空 CF_ACCESS_* 必须先警告', () => {
  const current = { CF_ACCESS_HOSTNAME: 'x.example.com', CF_ACCESS_TEAM: 'myteam', CF_ACCESS_AUD: 'aud123' };

  test('三项一起清空 → warn 且说清后果', () => {
    const r = validateEnvChanges(
      { CF_ACCESS_HOSTNAME: null, CF_ACCESS_TEAM: null, CF_ACCESS_AUD: null },
      { current }
    );
    const warns = r.results.filter((x) => x.level === 'warn');
    assert.ok(warns.length > 0, '清空公网 2FA 不能零告警');
    assert.match(warns.map((w) => w.message).join(' '), /2FA|公网|关闭/, '要说清关掉的是什么');
  });

  test('本来就没配 → 不告警（没有东西被关掉）', () => {
    const r = validateEnvChanges({ CF_ACCESS_HOSTNAME: null }, { current: {} });
    assert.equal(r.results.filter((x) => x.level === 'warn').length, 0);
  });

  test('设置（而非清空）不告警', () => {
    const r = validateEnvChanges(
      { CF_ACCESS_HOSTNAME: 'x.example.com', CF_ACCESS_TEAM: 't', CF_ACCESS_AUD: 'a' },
      { current: {} }
    );
    assert.equal(r.results.filter((x) => x.level === 'warn').length, 0);
  });
});

// ── P1b：list 类型（WORKDIRS）的校验 ────────────────────────────────────────
//
// 缺陷路径（实测确认）：前端 env-config.js 只分派 number / toggle，其余一律渲染成 text input。
// 于是 list 项在手机面板里会变成一个可输入的文本框，用户敲进去的字符串被当作 WORKDIRS 提交 ——
// 而 app.js 的 readInlineWorkdirs 判的是 `Array.isArray(parsed?.WORKDIRS)`，非数组直接回落到
// 旧路径。结果是**工作区配置静默失效、面板却报保存成功**，与 CF_ACCESS_* 被吞那次同型。
//
// 两道防线：① buildEnvView 把 list 标成只读，前端不给编辑；② 这里的校验拒收任何非数组，
// 保护所有写入路径（含将来的 CLI 与 desktop）。② 比 ① 重要 —— 前端是可绕过的。
test('validateEnvChanges: WORKDIRS 必须是数组，字符串一律拒收', () => {
  const d = { current: {}, fileExists: () => true, isWritable: () => true, isExecutable: () => true, probePort: () => false };
  const r = validateEnvChanges({ WORKDIRS: '/a,/b' }, d);
  assert.equal(r.ok, false);
  assert.match(r.results[0].message, /数组/);
});

test('validateEnvChanges: WORKDIRS 接受路径字符串与 {path,sessionLimit} 混用', () => {
  const d = { current: {}, fileExists: () => true, isWritable: () => true, isExecutable: () => true, probePort: () => false };
  assert.equal(validateEnvChanges({ WORKDIRS: ['/a', { path: '/b', sessionLimit: 3 }] }, d).ok, true);
});

test('validateEnvChanges: WORKDIRS 空数组合法（= 只保留 WORK_DIR 一个工作区）', () => {
  const d = { current: {}, fileExists: () => true, isWritable: () => true, isExecutable: () => true, probePort: () => false };
  assert.equal(validateEnvChanges({ WORKDIRS: [] }, d).ok, true);
});

test('validateEnvChanges: WORKDIRS 条目形状不对时拒收，不静默丢条目', () => {
  const d = { current: {}, fileExists: () => true, isWritable: () => true, isExecutable: () => true, probePort: () => false };
  assert.equal(validateEnvChanges({ WORKDIRS: [{ dir: '/a' }] }, d).ok, false);
  assert.equal(validateEnvChanges({ WORKDIRS: [123] }, d).ok, false);
});

test('buildEnvView: list 项标成只读 —— 前端没有数组编辑器，给个 text input 只会写坏它', () => {
  const view = buildEnvView({});
  const runtime = view.groups.find(g => g.id === 'runtime');
  const workdirs = runtime.items.find(i => i.key === 'WORKDIRS');
  assert.equal(workdirs.kind, 'list');
  assert.equal(workdirs.readonly, true);
});
