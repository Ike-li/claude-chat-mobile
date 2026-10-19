// tests/unit/acceptance-report.test.mjs —— 每轮验收的汇总与落盘（tests/acceptance/lib/report.mjs）
// 覆盖：summarize 的计数；writeRunReport 落盘前对每条结果过一遍证据规则——
// 结论写进 results.json 之前就降档，而不是指望 agent 每次都记得先调 capVerdict。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATUSES, summarize, writeRunReport } from '../../tests/acceptance/lib/report.mjs';

async function makeRunRoot() {
  return mkdtemp(join(tmpdir(), 'ccm-accept-report-'));
}

test('summarize：已知状态全部列出（含 0），不认识的状态单独计数而不是丢掉', () => {
  const s = summarize([
    { id: 'AC-01-01', status: 'pass' }, { id: 'AC-01-02', status: 'pass' },
    { id: 'AC-01-03', status: 'fail' }, { id: 'AC-01-04', status: 'weird' },
  ]);
  assert.equal(s.total, 4);
  for (const k of STATUSES) assert.ok(k in s.byStatus, `${k} 必须出现在计数里，哪怕是 0`);
  assert.equal(s.byStatus.pass, 2);
  assert.equal(s.byStatus.fail, 1);
  assert.equal(s.byStatus.partial, 0);
  assert.equal(s.byStatus.weird, 1);
});

test('writeRunReport：写 results.json 与 report.md，弱证据的 pass 落盘时已降为 partial', async t => {
  const root = await makeRunRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDir = join(root, 'runs', '2026-10-18T120000Z');

  writeRunReport(runDir, [
    { id: 'AC-09-01', status: 'pass', evidence: ['dom', 'screenshot'] },
    { id: 'AC-09-02', status: 'pass', evidence: ['pure-function'], note: '界面上走不通' },
    { id: 'AC-09-03', status: 'fail', evidence: ['ui'] },
  ]);

  const saved = JSON.parse(await readFile(join(runDir, 'results.json'), 'utf8'));
  const byId = Object.fromEntries(saved.results.map(r => [r.id, r]));
  assert.equal(byId['AC-09-01'].status, 'pass');
  assert.equal(byId['AC-09-02'].status, 'partial', '只凭纯函数的 pass 不得以 pass 落盘');
  assert.match(byId['AC-09-02'].reason, /partial/);
  assert.equal(byId['AC-09-03'].status, 'fail');
  assert.deepEqual(saved.summary.byStatus.pass, 1);
  assert.deepEqual(saved.summary.byStatus.partial, 1);

  const md = await readFile(join(runDir, 'report.md'), 'utf8');
  // 按表格的状态列判，不按整行文本判：降档理由里本来就写着「要 pass 须补……」
  assert.match(md, /^\| AC-09-02 \| partial \|/m, 'report.md 里也必须是降档后的结论');
  assert.match(md, /^\| AC-09-01 \| pass \|/m);
});
