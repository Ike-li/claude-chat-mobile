// tests/unit/acceptance-cases.test.mjs —— 验收用例库的读取、校验与挑选（tests/acceptance/lib/cases.mjs）
// 覆盖：loadCases 只认 dNN-*.json 且按文件名排序；validateCases 的每条规则各有一条会红的反例；
// selectCases 缺省只选 A、--cases 与档位取交集；diffCaseIds 认字段变化、新增与重放脚本变化。
// 不读真实 tests/acceptance/cases/：用例是机主随时会改的数据，改用例不该让 CI 红。
// 真实数据的校验走 `node tests/acceptance/run.mjs --check`（机主本机跑，不进 CI）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SOURCE, diffCaseIds, loadCases, selectCases, validateCases,
} from '../../tests/acceptance/lib/cases.mjs';

const META = {
  envs: [{ code: 'E1' }, { code: 'E2' }, { code: 'T' }],
  domains: { 1: '装机', 2: '鉴权' },
};

function makeCase(id, extra = {}) {
  return {
    id, t: '测试点', pre: '', st: '步骤', ex: '通过标准', b: 'GS§3', env: ['E2'], p: 'P1',
    m: '场景', j: [], n: '', tier: null, check: null, ...extra,
  };
}

async function makeCasesDir(files, meta = META) {
  const dir = await mkdtemp(join(tmpdir(), 'ccm-accept-cases-'));
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

async function loadFixture(t, files, meta) {
  const dir = await makeCasesDir(files, meta);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return loadCases(dir);
}

const problemsOf = (issues, id) => issues.filter(i => i.id === id).map(i => i.message).join(' | ');

test('loadCases：只读 dNN-*.json，按文件名排序，每条带上来源文件与域号', async t => {
  const { meta, cases } = await loadFixture(t, {
    'd02-auth.json': { domain: 2, name: '鉴权', cases: [makeCase('AC-02-01')] },
    'd01-install.json': { domain: 1, name: '装机', cases: [makeCase('AC-01-01'), makeCase('AC-01-02')] },
    'README.md': '# 不是用例',
    'meta-backup.json': { cases: [makeCase('AC-09-09')] },
  });
  assert.deepEqual(meta.domains, META.domains);
  assert.deepEqual(cases.map(c => c.id), ['AC-01-01', 'AC-01-02', 'AC-02-01'],
    '必须按文件名顺序读，且不把非 dNN-*.json 的文件当用例');
  assert.deepEqual(cases[2][SOURCE], { file: 'd02-auth.json', domain: 2, declared: 2 });
  assert.equal(JSON.stringify(cases[0]).includes('d01-install'), false,
    '来源信息不得混进 JSON 序列化结果——否则写回用例文件时会把它一起写进去');
});

test('loadCases：cases 不是数组时直接报错，不当成「这个文件没有用例」', async t => {
  const dir = await makeCasesDir({ 'd01-install.json': { domain: 1, name: '装机', cases: {} } });
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.throws(() => loadCases(dir), /d01-install\.json/);
});

test('validateCases：合法夹具没有任何问题', async t => {
  const { meta, cases } = await loadFixture(t, {
    'd01-install.json': {
      domain: 1, name: '装机', cases: [
        makeCase('AC-01-01'),
        makeCase('AC-01-02', { tier: 'D', check: { kind: 'agent', how: '看令牌门是否出现' } }),
        makeCase('AC-01-03', { tier: 'A', check: { kind: 'replay', how: '读 DOM', spec: 'replay/d01-install.accept.ts' } }),
      ],
    },
  });
  assert.deepEqual(validateCases(cases, meta), []);
});

test('validateCases：一条用例都没读到算问题，不是「全部合规」', () => {
  const issues = validateCases([], META);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /一条用例都没有/);
});

test('validateCases：ID 格式必须是 AC-NN-NN，且 NN 与所在文件的域号一致', async t => {
  const { meta, cases } = await loadFixture(t, {
    'd01-install.json': {
      domain: 1, name: '装机', cases: [makeCase('AC-1-01'), makeCase('AC-01-1'), makeCase('AC-02-05')],
    },
  });
  const issues = validateCases(cases, meta);
  assert.match(problemsOf(issues, 'AC-1-01'), /格式/);
  assert.match(problemsOf(issues, 'AC-01-1'), /格式/);
  assert.match(problemsOf(issues, 'AC-02-05'), /d01-install\.json/, '放错文件的用例必须点名它所在的文件');
});

test('validateCases：文件头的 domain 与文件名域号不一致要报', async t => {
  const { meta, cases } = await loadFixture(t, {
    'd01-install.json': { domain: 2, name: '装机', cases: [makeCase('AC-01-01')] },
  });
  const issues = validateCases(cases, meta);
  assert.ok(issues.some(i => i.file === 'd01-install.json' && /domain/.test(i.message)),
    `文件头 domain:2 与文件名 d01 冲突却没报：${JSON.stringify(issues)}`);
});

test('validateCases：ID 跨文件重复要报', async t => {
  const { meta, cases } = await loadFixture(t, {
    'd01-install.json': { domain: 1, name: '装机', cases: [makeCase('AC-01-01')] },
    'd01-install-extra.json': { domain: 1, name: '装机', cases: [makeCase('AC-01-01')] },
  });
  assert.match(problemsOf(validateCases(cases, meta), 'AC-01-01'), /重复/);
});

test('validateCases：t / st / ex 为空（含纯空白）各自报出', () => {
  const issues = validateCases([
    makeCase('AC-01-01', { t: '' }),
    makeCase('AC-01-02', { st: '   ' }),
    makeCase('AC-01-03', { ex: undefined }),
  ], META);
  assert.match(problemsOf(issues, 'AC-01-01'), /\bt\b/);
  assert.match(problemsOf(issues, 'AC-01-02'), /\bst\b/);
  assert.match(problemsOf(issues, 'AC-01-03'), /\bex\b/);
});

test('validateCases：env 代码必须都在 meta.envs 里，空数组与非数组也算问题', () => {
  const issues = validateCases([
    makeCase('AC-01-01', { env: ['E2', 'E9'] }),
    makeCase('AC-01-02', { env: [] }),
    makeCase('AC-01-03', { env: 'E2' }),
  ], META);
  assert.match(problemsOf(issues, 'AC-01-01'), /E9/);
  assert.notEqual(problemsOf(issues, 'AC-01-02'), '');
  assert.notEqual(problemsOf(issues, 'AC-01-03'), '');
});

test('validateCases：p 只认 P0–P2', () => {
  const issues = validateCases([makeCase('AC-01-01', { p: 'P3' }), makeCase('AC-01-02', { p: 'p1' })], META);
  assert.match(problemsOf(issues, 'AC-01-01'), /P3/);
  assert.match(problemsOf(issues, 'AC-01-02'), /p1/);
});

test('validateCases：tier 只认 null 与大写 A–E，字段缺失也算问题', () => {
  const missing = makeCase('AC-01-03');
  delete missing.tier;
  const issues = validateCases([
    makeCase('AC-01-01', { tier: 'F' }),
    makeCase('AC-01-02', { tier: 'c' }),
    missing,
  ], META);
  assert.match(problemsOf(issues, 'AC-01-01'), /tier/);
  assert.match(problemsOf(issues, 'AC-01-02'), /tier/, '小写 c 不得当成 C：选不选中真模型档只认大写');
  assert.match(problemsOf(issues, 'AC-01-03'), /tier/);
});

test('validateCases：check 为 null 或带非空 kind 与 how 的对象', () => {
  const issues = validateCases([
    makeCase('AC-01-01', { check: { kind: 'agent' } }),
    makeCase('AC-01-02', { check: { how: '看 DOM' } }),
    makeCase('AC-01-03', { check: '看 DOM' }),
    makeCase('AC-01-04', { check: { kind: 'agent', how: '看 DOM', spec: 42 } }),
  ], META);
  assert.match(problemsOf(issues, 'AC-01-01'), /how/);
  assert.match(problemsOf(issues, 'AC-01-02'), /kind/);
  assert.notEqual(problemsOf(issues, 'AC-01-03'), '');
  assert.match(problemsOf(issues, 'AC-01-04'), /spec/);
});

test('validateCases：A 档必须指明重放脚本，否则重放时它会被静默漏掉', () => {
  const issues = validateCases([
    makeCase('AC-01-01', { tier: 'A', check: null }),
    makeCase('AC-01-02', { tier: 'A', check: { kind: 'replay', how: '读 DOM' } }),
  ], META);
  assert.match(problemsOf(issues, 'AC-01-01'), /spec/);
  assert.match(problemsOf(issues, 'AC-01-02'), /spec/);
});

test('selectCases：缺省只选 A；未定档（null）谁都不选', () => {
  const cases = [
    makeCase('AC-01-01', { tier: 'A' }), makeCase('AC-01-02', { tier: 'C' }),
    makeCase('AC-01-03', { tier: null }), makeCase('AC-01-04', { tier: 'A' }),
  ];
  assert.deepEqual(selectCases(cases).map(c => c.id), ['AC-01-01', 'AC-01-04']);
  assert.deepEqual(selectCases(cases, { tiers: ['C', 'D'] }).map(c => c.id), ['AC-01-02']);
});

test('selectCases：--cases 与档位取交集——点名 C 档用例但没写 --tier C 时不选', () => {
  const cases = [makeCase('AC-01-01', { tier: 'A' }), makeCase('AC-01-02', { tier: 'C' })];
  assert.deepEqual(selectCases(cases, { ids: ['AC-01-02'] }), [],
    '真模型档必须显式写出 --tier C 才能被选中');
  assert.deepEqual(selectCases(cases, { tiers: ['C'], ids: ['AC-01-02'] }).map(c => c.id), ['AC-01-02']);
  assert.equal(cases.length, 2, '不得改动传入的数组');
});

test('diffCaseIds：认字段变化与新增，忽略键序；重放脚本有改动时它名下的用例也算变化', () => {
  const prev = [
    makeCase('AC-01-01'),
    makeCase('AC-01-02'),
    makeCase('AC-01-03', { tier: 'A', check: { kind: 'replay', how: 'x', spec: 'replay/d01.accept.ts' } }),
  ];
  const reordered = Object.fromEntries(Object.entries(makeCase('AC-01-01')).reverse());
  const curr = [
    reordered,
    makeCase('AC-01-02', { ex: '改过的通过标准' }),
    makeCase('AC-01-03', { tier: 'A', check: { kind: 'replay', how: 'x', spec: 'replay/d01.accept.ts' } }),
    makeCase('AC-01-04'),
  ];
  assert.deepEqual(diffCaseIds(prev, curr), ['AC-01-02', 'AC-01-04']);
  assert.deepEqual(diffCaseIds(prev, curr, ['replay/d01.accept.ts']), ['AC-01-02', 'AC-01-03', 'AC-01-04']);
});
