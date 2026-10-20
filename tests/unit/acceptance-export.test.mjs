// tests/unit/acceptance-export.test.mjs —— cases/*.json → 清单页面数据文件（tests/acceptance/lib/export-artifact.mjs）
// 往返：导出的 data/*.js 按页面的方式（浏览器脚本、共用一个 window）求值后，
// 必须还原出与 cases/ 逐字段相同的用例与元数据；按 6 个域一份切到 cases-1..4.js。
// run-meta 只补 build / readiness / observations 三项——用例定义以 cases/ 为准，不许被一轮的记录盖掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { loadCases } from '../../tests/acceptance/lib/cases.mjs';
import { exportArtifact } from '../../tests/acceptance/lib/export-artifact.mjs';

const META = {
  envs: [{ code: 'E2', name: 'E2 playground' }],
  probes: [{ k: '移动视口仿真', r: 'ok', d: '375×812' }],
  decisions: [], journeys: { J1: '首次接入' },
  domains: { 1: '装机', 7: '会话控制', 13: '连接', 24: '健壮性' },
  basis: [['GS§n', 'docs/getting-started.md 第 n 节']],
  stopRule: '拆到叶子就停',
};

const makeCase = (id, extra = {}) => ({
  id, t: `测试点 ${id}`, pre: '', st: '步骤「带引号」\n第二行', ex: '通过标准 </script>', b: 'GS§3', env: ['E2'],
  p: 'P1', m: '场景', j: ['J1'], n: '', tier: null, check: null, ...extra,
});

async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'ccm-accept-export-'));
  const casesDir = join(root, 'cases');
  await mkdir(casesDir);
  await writeFile(join(casesDir, 'meta.json'), JSON.stringify(META));
  const files = {
    'd01-install.json': [makeCase('AC-01-01'), makeCase('AC-01-02', { tier: 'D', check: { kind: 'agent', how: '看界面' } })],
    'd07-session-control.json': [makeCase('AC-07-01')],
    'd13-connectivity.json': [makeCase('AC-13-01')],
    'd24-robustness.json': [makeCase('AC-24-01')],
  };
  for (const [name, cases] of Object.entries(files)) {
    await writeFile(join(casesDir, name), JSON.stringify({ domain: Number(name.slice(1, 3)), name: 'x', cases }));
  }
  return { root, casesDir, outDir: join(root, 'out', 'data') };
}

async function evaluatePage(outDir) {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  for (const f of ['meta.js', 'cases-1.js', 'cases-2.js', 'cases-3.js', 'cases-4.js']) {
    vm.runInContext(await readFile(join(outDir, f), 'utf8'), sandbox, { filename: f });
  }
  return JSON.parse(JSON.stringify(sandbox.window));
}

test('往返：导出的 data/*.js 求值后与 cases/ 逐字段一致', async t => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));

  exportArtifact({ casesDir: ws.casesDir, outDir: ws.outDir });

  assert.deepEqual((await readdir(ws.outDir)).sort(), ['cases-1.js', 'cases-2.js', 'cases-3.js', 'cases-4.js', 'meta.js']);
  const page = await evaluatePage(ws.outDir);
  const { meta, cases } = loadCases(ws.casesDir);
  assert.deepEqual(page.CASES, JSON.parse(JSON.stringify(cases)), '用例必须逐字段还原（含换行、引号、</script>）');
  assert.deepEqual(page.META, meta);
});

test('按 6 个域一份切文件：D01–D06 → cases-1.js … D19–D24 → cases-4.js', async t => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  exportArtifact({ casesDir: ws.casesDir, outDir: ws.outDir });

  const idsIn = async f => {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(await readFile(join(ws.outDir, f), 'utf8'), sandbox);
    return Array.from(sandbox.window.CASES, c => c.id);   // 跨 realm 的数组 deepEqual 比不过，搬回本 realm
  };
  assert.deepEqual(await idsIn('cases-1.js'), ['AC-01-01', 'AC-01-02']);
  assert.deepEqual(await idsIn('cases-2.js'), ['AC-07-01']);
  assert.deepEqual(await idsIn('cases-3.js'), ['AC-13-01']);
  assert.deepEqual(await idsIn('cases-4.js'), ['AC-24-01']);
});

test('run-meta 只补 build / readiness / observations，不覆盖用例定义里的 envs 等', async t => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const runMetaPath = join(ws.root, 'run-meta.json');
  await writeFile(runMetaPath, JSON.stringify({
    build: { ref: 'origin/dev @ 0000000' },
    readiness: [{ item: '隔离基线', status: 'ok' }],
    observations: [{ id: 'O1', text: '观察' }],
    envs: [{ code: 'BOGUS' }],
  }));

  exportArtifact({ casesDir: ws.casesDir, outDir: ws.outDir, runMetaPath });
  const page = await evaluatePage(ws.outDir);
  assert.deepEqual(page.META.build, { ref: 'origin/dev @ 0000000' });
  assert.equal(page.META.readiness.length, 1);
  assert.equal(page.META.observations[0].id, 'O1');
  assert.deepEqual(page.META.envs, META.envs, 'envs 必须来自 cases/meta.json，不能被 run-meta 盖掉');
});
