// tests/unit/saved-environments.test.mjs —— 保存的环境：存储层
// 跑真文件（docs/testing.md §2：配置的实际读写目标属于 mock 掉等于没测）。夹具是 mkdtemp 出来的一次性目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSavedEnvironmentsStore } from '../../app/src/sessions/saved-environments.js';

const ROOTS = [];
test.after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-saved-env-'));
  ROOTS.push(dir);
  return join(dir, 'environments.json');
}
const quietLog = () => ({ warn() {}, error() {} });
const ENV = { name: '日常', cwd: '/r/app', model: 'opus', effort: 'xhigh', worktree: true };

test('保存后列得出来，重启后还在，字段一个不丢', () => {
  const file = fixture();
  const store = createSavedEnvironmentsStore({ file, log: quietLog() });
  const res = store.create(ENV);
  assert.equal(res.ok, true);
  assert.ok(res.environment.id, '要有 id：改名后靠它认环境');
  store.flushSaveSync();

  const reopened = createSavedEnvironmentsStore({ file, log: quietLog() });
  assert.deepEqual(reopened.list(), [{ id: res.environment.id, ...ENV }]);
});

test('没存过就不落盘：没用这个功能的安装不凭空多一个文件', () => {
  const file = fixture();
  const store = createSavedEnvironmentsStore({ file, log: quietLog() });
  store.flushSaveSync();
  assert.equal(existsSync(file), false);
});

test('名字：去掉首尾空白；空的、过长的拒绝', () => {
  const store = createSavedEnvironmentsStore({ file: fixture(), log: quietLog() });
  assert.equal(store.create({ ...ENV, name: '  前后有空格  ' }).environment.name, '前后有空格');
  assert.deepEqual(store.create({ ...ENV, name: '   ' }), { ok: false, error: 'invalid_name' });
  assert.deepEqual(store.create({ ...ENV, name: '长'.repeat(61) }), { ok: false, error: 'invalid_name' });
  assert.equal(store.create({ ...ENV, name: '长'.repeat(60) }).ok, true, '60 个字符是上限本身，要放行');
});

test('重名拒绝：选择列表里两个同名的环境分不清', () => {
  const store = createSavedEnvironmentsStore({ file: fixture(), log: quietLog() });
  store.create(ENV);
  assert.deepEqual(store.create({ ...ENV, name: ' 日常 ' }), { ok: false, error: 'duplicate_name' });
  assert.equal(store.list().length, 1);
});

test('没有 cwd 的环境存不进去', () => {
  const store = createSavedEnvironmentsStore({ file: fixture(), log: quietLog() });
  assert.deepEqual(store.create({ ...ENV, cwd: '' }), { ok: false, error: 'invalid_cwd' });
});

test('缺省设置归一成 null / false：null 表示跟随默认，不是空串', () => {
  const store = createSavedEnvironmentsStore({ file: fixture(), log: quietLog() });
  const { environment } = store.create({ name: '默认', cwd: '/r/app', model: '', effort: undefined });
  assert.equal(environment.model, null);
  assert.equal(environment.effort, null);
  assert.equal(environment.worktree, false);
});

test('更新：id 不变；保留自己的名字不算重名，撞别人的算', () => {
  const store = createSavedEnvironmentsStore({ file: fixture(), log: quietLog() });
  const a = store.create(ENV).environment;
  const b = store.create({ ...ENV, name: '另一个' }).environment;

  const same = store.update(a.id, { ...ENV, model: 'sonnet' });
  assert.equal(same.ok, true);
  assert.equal(same.environment.id, a.id);
  assert.equal(same.environment.model, 'sonnet');

  assert.deepEqual(store.update(b.id, { ...ENV }), { ok: false, error: 'duplicate_name' });
  assert.deepEqual(store.update('不存在', ENV), { ok: false, error: 'not_found' });
});

test('删除：删掉就没了，重启也不回来；删不存在的如实说', () => {
  const file = fixture();
  const store = createSavedEnvironmentsStore({ file, log: quietLog() });
  const { environment } = store.create(ENV);
  assert.deepEqual(store.remove(environment.id), { ok: true });
  assert.deepEqual(store.remove(environment.id), { ok: false, error: 'not_found' });
  store.flushSaveSync();
  assert.deepEqual(createSavedEnvironmentsStore({ file, log: quietLog() }).list(), []);
});

test('文件损坏不挡启动：当作没有并打警告，同时把原文件留下来', () => {
  const file = fixture();
  writeFileSync(file, '{坏了');
  const warnings = [];
  const store = createSavedEnvironmentsStore({ file, log: { warn: m => warnings.push(m), error() {} } });
  assert.deepEqual(store.list(), []);
  assert.equal(warnings.length, 1);

  // 这是用户亲手存的数据，不是缓存：后面再保存不能把它悄悄盖掉
  store.create(ENV);
  store.flushSaveSync();
  assert.equal(readFileSync(`${file}.corrupt`, 'utf8'), '{坏了');
});

test('结构不对的条目丢弃，好的留下', () => {
  const file = fixture();
  const good = { id: 'a', ...ENV };
  writeFileSync(file, JSON.stringify([good, { id: 'b' }, 'x']));
  const store = createSavedEnvironmentsStore({ file, log: quietLog() });
  assert.deepEqual(store.list(), [good]);
});
