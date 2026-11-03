// tests/unit/elicitation.test.mjs —— MCP elicitation（#460）的请求归一与作答校验
// 规范只允许「扁平对象 + 原始类型属性」：string（format / 长度）、number / integer（范围）、boolean、单选枚举。
// 超出这个子集一律 unsupported：卡片只给拒绝 / 取消，绝不替用户瞎填。
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeElicitation, validateElicitationContent } from '../../app/src/agent/elicitation.js';

const form = (properties, required) => ({
  serverName: 'notes', message: '要一个名字', mode: 'form',
  requestedSchema: { type: 'object', properties, ...(required ? { required } : {}) },
});

test('表单：每种受支持的类型都归一成字段描述，顺序照 schema', () => {
  const view = describeElicitation(form({
    name: { type: 'string', title: '名字', description: '给新笔记起名', minLength: 1, maxLength: 20 },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    ratio: { type: 'number', minimum: 0.5 },
    agree: { type: 'boolean', title: '同意', default: true },
    color: { type: 'string', enum: ['r', 'g'], enumNames: ['红', '绿'] },
    size: { type: 'string', oneOf: [{ const: 's', title: '小' }, { const: 'l', title: '大' }] },
  }, ['name', 'agree']));
  assert.equal(view.mode, 'form');
  assert.equal(view.unsupported, undefined);
  assert.deepEqual(view.fields.map(f => [f.name, f.type, f.required]), [
    ['name', 'string', true], ['email', 'string', false], ['age', 'integer', false], ['ratio', 'number', false],
    ['agree', 'boolean', true], ['color', 'enum', false], ['size', 'enum', false],
  ]);
  const by = Object.fromEntries(view.fields.map(f => [f.name, f]));
  assert.equal(by.name.title, '名字');
  assert.equal(by.name.description, '给新笔记起名');
  assert.equal(by.name.minLength, 1);
  assert.equal(by.name.maxLength, 20);
  assert.equal(by.email.format, 'email');
  assert.equal(by.age.minimum, 0);
  assert.equal(by.age.maximum, 150);
  assert.equal(by.agree.default, true);
  assert.deepEqual(by.color.options, [{ value: 'r', label: '红' }, { value: 'g', label: '绿' }]);
  assert.deepEqual(by.size.options, [{ value: 's', label: '小' }, { value: 'l', label: '大' }]);
});

test('表单：超出子集（嵌套对象、数组 / 多选、不认的 format、顶层不是 object）→ unsupported，不带 fields', () => {
  const cases = [
    form({ addr: { type: 'object', properties: { city: { type: 'string' } } } }),
    form({ tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } }),
    form({ when: { type: 'string', format: 'time' } }),
    form({ n: { type: 'null' } }),
    { serverName: 's', message: 'm', mode: 'form', requestedSchema: { type: 'array' } },
    { serverName: 's', message: 'm', mode: 'form' },
  ];
  for (const req of cases) {
    const view = describeElicitation(req);
    assert.equal(view.unsupported, true, JSON.stringify(req.requestedSchema));
    assert.equal(view.fields, undefined);
    assert.equal(typeof view.unsupportedReason, 'string');
  }
});

test('mode 缺省按表单；第三方文本原样带上（转义交给前端 textContent），超长截断', () => {
  const view = describeElicitation({
    serverName: 'srv', message: '<b>x</b>'.repeat(2000), title: 'T', displayName: 'D', description: 'Desc',
    requestedSchema: { type: 'object', properties: {} },
  });
  assert.equal(view.mode, 'form');
  assert.equal(view.serverName, 'srv');
  assert.ok(view.message.startsWith('<b>x</b>'));
  assert.ok(view.message.length <= 4000);
  assert.deepEqual([view.title, view.displayName, view.description], ['T', 'D', 'Desc']);
  assert.deepEqual(view.fields, []);
});

test('URL 模式：只认 http / https，带上完整 origin；别的协议或解析不了 → unsupported 且不下发链接', () => {
  const ok = describeElicitation({ serverName: 'gh', message: '去授权', mode: 'url', url: 'https://auth.example.com:8443/cb?x=1', elicitationId: 'el-1' });
  assert.equal(ok.unsupported, undefined);
  assert.equal(ok.url, 'https://auth.example.com:8443/cb?x=1');
  assert.equal(ok.urlOrigin, 'https://auth.example.com:8443');
  assert.equal(ok.elicitationId, 'el-1');
  assert.equal(describeElicitation({ serverName: 'l', message: 'm', mode: 'url', url: 'http://localhost:3000/x' }).urlOrigin, 'http://localhost:3000');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'not a url', undefined]) {
    const view = describeElicitation({ serverName: 's', message: 'm', mode: 'url', url });
    assert.equal(view.unsupported, true, String(url));
    assert.equal(view.url, undefined, String(url));
    assert.equal(view.urlOrigin, undefined, String(url));
  }
});

const fieldsOf = (properties, required) => describeElicitation(form(properties, required)).fields;

test('校验：合法作答原样通过；可选项没填就不出现在 content 里', () => {
  const fields = fieldsOf({
    name: { type: 'string', minLength: 2, maxLength: 4 },
    email: { type: 'string', format: 'email' },
    site: { type: 'string', format: 'uri' },
    day: { type: 'string', format: 'date' },
    at: { type: 'string', format: 'date-time' },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    ratio: { type: 'number', maximum: 1 },
    agree: { type: 'boolean' },
    color: { type: 'string', enum: ['r', 'g'] },
  }, ['name']);
  const content = { name: '小明同学', email: 'a@b.co', site: 'https://x.dev/p', day: '2026-10-29', at: '2026-10-29T08:00:00Z', age: 30, ratio: 0.5, agree: false, color: 'g' };
  assert.deepEqual(validateElicitationContent(fields, content), { ok: true, content });
  assert.deepEqual(validateElicitationContent(fields, { name: 'ab' }), { ok: true, content: { name: 'ab' } });
});

test('校验：缺必填、类型不对、越界、format 不符、枚举外、多余字段、不是对象 → 拒收并指明哪一项', () => {
  const fields = fieldsOf({
    name: { type: 'string', title: '名字', minLength: 2, maxLength: 4 },
    email: { type: 'string', format: 'email' },
    day: { type: 'string', format: 'date' },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    agree: { type: 'boolean' },
    color: { type: 'string', enum: ['r', 'g'] },
  }, ['name']);
  const bad = [
    [{}, 'name'],
    [{ name: '' }, 'name'],
    [{ name: 'a' }, 'name'],
    [{ name: '五个字太长' }, 'name'],
    [{ name: 42 }, 'name'],
    [{ name: 'ab', email: 'no-at' }, 'email'],
    [{ name: 'ab', day: '2026-02-30' }, 'day'],
    [{ name: 'ab', age: 1.5 }, 'age'],
    [{ name: 'ab', age: -1 }, 'age'],
    [{ name: 'ab', age: '3' }, 'age'],
    [{ name: 'ab', agree: 'yes' }, 'agree'],
    [{ name: 'ab', color: 'b' }, 'color'],
    [{ name: 'ab', extra: 1 }, 'extra'],
  ];
  for (const [content, field] of bad) {
    const r = validateElicitationContent(fields, content);
    assert.equal(r.ok, false, JSON.stringify(content));
    assert.equal(r.field, field, JSON.stringify(content));
    assert.equal(typeof r.error, 'string');
  }
  for (const content of [null, 'x', [], undefined]) {
    assert.equal(validateElicitationContent(fields, content).ok, false, String(content));
  }
});

test('校验：字符串长度按字符算（emoji 不按两个 UTF-16 单元）', () => {
  const fields = fieldsOf({ s: { type: 'string', maxLength: 2 } });
  assert.equal(validateElicitationContent(fields, { s: '😀😀' }).ok, true);
  assert.equal(validateElicitationContent(fields, { s: '😀😀😀' }).ok, false);
});
