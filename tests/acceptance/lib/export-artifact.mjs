#!/usr/bin/env node
// tests/acceptance/lib/export-artifact.mjs —— 从 cases/*.json 生成清单页面要的 data/meta.js 与 data/cases-1..4.js
//
//   node tests/acceptance/lib/export-artifact.mjs [--run-meta <run-meta.json>] [--out <目录>]
//
// 清单页面（私有 artifact）只是用例库的一个视图：页面按 <script src> 依次加载这五个文件，
// 共用一个 window。格式与迁移前页面自带的数据文件兼容（window.META = …；window.CASES.push(…)）。
// 输出缺省落在 local/export/data/（gitignore），由 skill 里的 agent 发布到清单链接。
//
// run-meta.json 是某一轮的运行记录，只补 build / readiness / observations 三项：
// 那些不是用例定义，所以不进 cases/meta.json；也不许借这条路盖掉 cases/ 里的定义。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASE_FIELDS, SOURCE, loadCases } from './cases.mjs';

const RUN_META_KEYS = ['build', 'readiness', 'observations'];
const DOMAINS_PER_FILE = 6;
const FILE_COUNT = 4;

const pick = c => Object.fromEntries(CASE_FIELDS.map(k => [k, c[k]]));

export function buildArtifactData({ meta, cases }, runMeta = null) {
  const pageMeta = { ...meta };
  for (const k of RUN_META_KEYS) if (runMeta && k in runMeta) pageMeta[k] = runMeta[k];

  const header = '// 由 tests/acceptance/lib/export-artifact.mjs 从 cases/ 生成，改用例请改 cases/*.json，不要改这里。\n';
  const out = { 'meta.js': `${header}window.META = ${JSON.stringify(pageMeta, null, 2)};\n` };
  for (let k = 1; k <= FILE_COUNT; k++) {
    const lo = (k - 1) * DOMAINS_PER_FILE + 1;
    const hi = k * DOMAINS_PER_FILE;
    const part = cases.filter(c => {
      const d = c[SOURCE]?.domain ?? Number(String(c.id).slice(3, 5));
      return d >= lo && d <= hi;
    });
    const body = part.map(c => `  ${JSON.stringify(pick(c))}`).join(',\n');
    out[`cases-${k}.js`] = `${header}// D${String(lo).padStart(2, '0')}–D${String(hi).padStart(2, '0')}\n`
      + 'window.CASES = window.CASES || [];\n'
      + `window.CASES.push(\n${body}\n);\n`;
  }
  return out;
}

export function exportArtifact({ casesDir, outDir, runMetaPath = null }) {
  const data = loadCases(casesDir);
  const runMeta = runMetaPath ? JSON.parse(readFileSync(runMetaPath, 'utf8')) : null;
  const files = buildArtifactData(data, runMeta);
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [name, text] of Object.entries(files)) {
    const p = join(outDir, name);
    writeFileSync(p, text);
    written.push(p);
  }
  return { written, count: data.cases.length };
}

function main(argv) {
  const here = fileURLToPath(new URL('.', import.meta.url));
  let outDir = resolve(here, '..', 'local', 'export', 'data');
  let runMetaPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') outDir = resolve(argv[++i] ?? '');
    else if (a === '--run-meta') runMetaPath = resolve(argv[++i] ?? '');
    else {
      console.error(`未知参数 ${a}\n用法: node tests/acceptance/lib/export-artifact.mjs [--run-meta <run-meta.json>] [--out <目录>]`);
      process.exit(2);
    }
  }
  const { written, count } = exportArtifact({ casesDir: resolve(here, '..', 'cases'), outDir, runMetaPath });
  console.log(`导出 ${count} 条用例：\n${written.map(p => `  ${p}`).join('\n')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
