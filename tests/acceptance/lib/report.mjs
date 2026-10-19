// tests/acceptance/lib/report.mjs —— 每轮验收的汇总与落盘：local/runs/<UTC 时间戳>/{results.json,report.md}
//
//   node tests/acceptance/lib/report.mjs <运行目录> <结果草稿.json>
//
// 结果对象的形状：{ id, status, evidence: [种类…], note?, reason? }，status 取 STATUSES 之一。
// 落盘前每条都过一遍 capVerdict：证据规则在写入点执行，不靠调用方记得先调。
// 命令行形态给 skill 里的 agent 用：它把这一轮的结论攒成一份 JSON 数组，交给这里定档、落盘。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capVerdict } from './evidence.mjs';

/** 通过 / 部分 / 失败 / 受阻（环境或额度挡住，不是产品缺陷）/ 未执行 */
export const STATUSES = ['pass', 'partial', 'fail', 'blocked', 'not-run'];

/** 按状态计数。已知状态全部列出（含 0）；不认识的状态单独计数，不悄悄丢掉。 */
export function summarize(results) {
  const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return { total: results.length, byStatus };
}

const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function writeRunReport(runDir, results) {
  const capped = results.map(capVerdict);
  const summary = summarize(capped);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'results.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), summary, results: capped }, null, 2) + '\n');

  const lines = [
    '# 验收结果',
    '',
    `共 ${summary.total} 条：${Object.entries(summary.byStatus).map(([k, n]) => `${k} ${n}`).join(' · ')}`,
    '',
    '| 用例 | 结论 | 证据 | 说明 |',
    '|---|---|---|---|',
    ...capped.map(r => `| ${cell(r.id)} | ${cell(r.status)} | ${cell((r.evidence ?? []).join(', '))} | ${cell([r.note, r.reason].filter(Boolean).join('；'))} |`),
    '',
  ];
  writeFileSync(join(runDir, 'report.md'), lines.join('\n'));
  return { summary, results: capped };
}

function main([runDir, draftPath]) {
  if (!runDir || !draftPath) {
    console.error('用法: node tests/acceptance/lib/report.mjs <运行目录> <结果草稿.json>');
    process.exit(2);
  }
  const { summary, results } = writeRunReport(resolve(runDir), JSON.parse(readFileSync(draftPath, 'utf8')));
  console.log(`共 ${summary.total} 条：${Object.entries(summary.byStatus).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  for (const r of results.filter(x => x.reason)) console.log(`  降档 ${r.id}：${r.reason}`);
  console.log(`已写 ${join(resolve(runDir), 'results.json')} 与 report.md`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
