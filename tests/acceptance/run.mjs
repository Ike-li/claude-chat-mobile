#!/usr/bin/env node
// tests/acceptance/run.mjs —— 验收套件入口（只在机主本机跑，永不进 CI）
//
//   node tests/acceptance/run.mjs [--check] [--list] [--tier A|B|C|D|E[,…]] [--cases AC-01-01,…] [--changed <git-ref>]
//
//   --check            校验用例库，打印各档、各优先级计数；有问题以 1 退出
//   --list             只列出选中的用例，不执行
//   --tier             档位列表。不写时只选 A（脚本重放，零 token）；C（真模型）必须显式写出来
//   --cases            只选这些 ID（与 --tier 取交集：点名 C 档用例但没写 --tier C，照样不选）
//   --changed <ref>    只选相对 <ref> 有变化的用例：定义改了、新增的、以及重放脚本改了的
//
// 执行：选中的 A 档交给 Playwright 重放（replay/playwright.config.ts），产物写进 local/runs/<UTC 时间戳>/，
// 跑完对照 JSON 报告，选中了却没跑到的 AC 编号列出来并以 1 退出；
// B–E 档 run.mjs 只列出来，由 skill（.claude/skills/ccm-accept）里的 agent 执行。
//
// 【额度闸不在这里】C 档（真模型）run.mjs 只列清单、不执行。真正开始花额度的是起 E3 系环境
// （env/up.mjs --env E3… --yes：机主网关凭据复制进容器，此后每个回合都耗真额度），PreToolUse 钩子
// tests/gates/guard-host-tests.js 在那一步请机主确认。档位语法照样收窄（只认大写、只许写一次、没有 -t 简写）：
// 不认识的写法一律拒绝，不猜意图。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDockerEnv, resolveExecutionSlot } from '../setup/disposable-env.mjs';
import { PRIORITIES, TIERS, diffCaseIds, loadCases, selectCases, validateCases } from './lib/cases.mjs';

const ACCEPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(ACCEPT_DIR, '..', '..');
const CASES_DIR = join(ACCEPT_DIR, 'cases');
const REPLAY_DIR = join(ACCEPT_DIR, 'replay');
const REPLAY_CONFIG = join(ACCEPT_DIR, 'replay', 'playwright.config.ts');
// 与 replay/playwright.config.ts 里 json reporter 的 outputFile 同名（落在 CCM_ACCEPT_RUN_DIR 下）
const REPLAY_REPORT = 'replay.json';
const CASES_REL = 'tests/acceptance/cases';

export const USAGE = '用法: node tests/acceptance/run.mjs [--check] [--list] [--tier A|B|C|D|E[,…]] [--cases AC-01-01,…] [--changed <git-ref>]';

const CASE_ID = /^AC-\d{2}-\d{2}$/;

function listValue(flag, raw, valid, what) {
  if (raw === undefined || raw === '' || raw.startsWith('--')) throw new Error(`${flag} 后面要跟${what}`);
  const items = raw.split(',');
  const bad = items.filter(x => !valid(x));
  if (bad.length) throw new Error(`${flag} 里有非法值：${bad.map(x => JSON.stringify(x)).join(' ')}`);
  return items;
}

/** 按契约解析参数；不认识的写法一律抛错（由 main 以 2 退出），不猜意图。 */
export function parseArgs(argv) {
  const opts = { check: false, list: false, help: false, tiers: ['A'], ids: null, changed: null };
  let tierSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const [flag, inline] = arg.startsWith('--') && eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--check' && inline === undefined) opts.check = true;
    else if (flag === '--list' && inline === undefined) opts.list = true;
    else if ((flag === '--help' || flag === '-h') && inline === undefined) opts.help = true;
    else if (flag === '--tier') {
      if (tierSeen) throw new Error('--tier 只能写一次，多个档位用逗号：--tier A,C');
      tierSeen = true;
      opts.tiers = listValue('--tier', value(), x => TIERS.includes(x), `档位（大写 ${TIERS.join('/')}，逗号分隔）`);
    } else if (flag === '--cases') {
      opts.ids = listValue('--cases', value(), x => CASE_ID.test(x), '用例 ID（AC-NN-NN，逗号分隔）');
    } else if (flag === '--changed') {
      const ref = value();
      if (!ref || ref.startsWith('-')) throw new Error('--changed 后面要跟 git ref（如 origin/dev）');
      opts.changed = ref;
    } else {
      throw new Error(`不认识的参数 ${JSON.stringify(arg)}`);
    }
  }
  return opts;
}

const truthy = v => v !== undefined && v !== '' && v !== 'false' && v !== '0';

/**
 * 不该在这里跑就返回原因，否则 null。方向与 disposable-env 相反：那边只许一次性环境，这边只许机主本机。
 * CI 判两种：resolveExecutionSlot 认的 GITHUB_ACTIONS，加上任何 CI=…——那份判据刻意不认 CI
 * （本机 `CI=true npm test` 不该打开破坏性测试），而这里拦错的代价只是机主换个写法，所以从宽认定。
 * CI 先于容器判：resolveExecutionSlot 有 /.dockerenv 就只报 container，CI 里跑在容器中的那一份会被说成「检测到容器」。
 */
export function refusalReason({ env = process.env, hasDockerEnv = false } = {}) {
  const slot = resolveExecutionSlot({ env, hasDockerEnv });
  if (slot.slot === 'ci' || env.GITHUB_ACTIONS === 'true' || truthy(env.CI)) {
    return '⛔ 验收套件永不进 CI：检测到 CI 环境（GITHUB_ACTIONS / CI）。它要机主本机的浏览器、网关、真机与 local/ 里的凭据，CI 上只会全部受阻，或者白白耗掉额度。';
  }
  if (slot.slot === 'container') {
    return '⛔ 验收套件只在机主本机跑：检测到容器（/.dockerenv）。被测环境才进容器（env/up.mjs 起），run.mjs 本身在宿主机上调度。';
  }
  return null;
}

/**
 * 选中了却没在 Playwright 的 JSON 报告里跑到的 AC 编号。--grep 有一条匹配上 Playwright 就报绿，
 * 其余没写脚本、标题打错的编号会被静默漏掉——这里补上那一步对账。
 * 编号取整条标题路径（describe 与 test 标题）；只被 skip 的不算跑到。报告读不出来时一条都证明不了，全部算漏。
 */
export function missingReplays(selectedIds, reportPath) {
  let report;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch (err) {
    return { missing: [...selectedIds], error: `读不出 Playwright 报告 ${relative(REPO_ROOT, reportPath)}（${err.code ?? err.message}）` };
  }
  const ran = new Set();
  const walk = (suite, titles) => {
    const path = [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      if (!(spec.tests ?? []).some(t => t.status !== 'skipped')) continue;
      for (const id of [...path, spec.title].join(' ').match(/\bAC-\d{2}-\d{2}\b/g) ?? []) ran.add(id);
    }
    for (const child of suite.suites ?? []) walk(child, path);
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  return { missing: selectedIds.filter(id => !ran.has(id)), error: null };
}

/** 2026-10-18T17:05:09.123Z → 2026-10-18T170509Z */
export function runTimestamp(date = new Date()) {
  return date.toISOString().replace(/:/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// 相对 ref 有变化的用例：拿 ref 里的 cases/*.json 与当前比，再加上重放脚本有改动（含未跟踪）的
function changedCaseIds(ref, cases) {
  git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const changedFiles = [
    ...git(['diff', '--name-only', ref, '--', 'tests/acceptance']).split('\n'),
    ...git(['ls-files', '--others', '--exclude-standard', '--', 'tests/acceptance']).split('\n'),
  ].filter(Boolean);
  const specs = changedFiles.filter(f => f.startsWith('tests/acceptance/replay/')).map(f => f.slice('tests/acceptance/'.length));
  let prevFiles = [];
  try { prevFiles = git(['ls-tree', '--name-only', `${ref}:${CASES_REL}`]).split('\n').filter(f => /^d\d{2}-.+\.json$/.test(f)); } catch {}
  const prev = prevFiles.flatMap(f => JSON.parse(git(['show', `${ref}:${CASES_REL}/${f}`])).cases ?? []);
  return diffCaseIds(prev, cases, specs);
}

function replayScripts() {
  if (!existsSync(REPLAY_DIR)) return [];
  return readdirSync(REPLAY_DIR, { recursive: true }).filter(f => String(f).endsWith('.accept.ts'));
}

function countBy(cases, key, order) {
  const counts = new Map(order.map(k => [k, 0]));
  for (const c of cases) counts.set(c[key], (counts.get(c[key]) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k ?? '未定档'} ${n}`).join(' · ');
}

const line = c => `${c.id}  [${c.tier ?? '—'}] ${c.p}  ${c.env.join(' ')}  ${c.t}`;

/** 选中的 B–E 档交给 skill 时的说明；没有就返回空串。C 档另起一行指明前提：先起它要的 E3 系环境。 */
export function handoffNotice(selected) {
  const others = selected.filter(c => c.tier !== 'A');
  if (!others.length) return '';
  const lines = [`B–E 档 ${others.length} 条由 skill（.claude/skills/ccm-accept）里的 agent 执行，run.mjs 不执行：`, ...others.map(c => `  ${line(c)}`)];
  const real = others.filter(c => c.tier === 'C');
  if (real.length) {
    const e3 = [...new Set(real.flatMap(c => c.env).filter(e => /^E3/.test(e)))];
    lines.push(`C 档 ${real.length} 条由 skill 里的 agent 执行，前提是先用 env/up.mjs 起 E3（钩子会请机主确认）：`
      + `node tests/acceptance/env/up.mjs --env ${(e3.length ? e3 : ['E3']).join(',')} --yes`);
  }
  return lines.join('\n');
}

function main(argv) {
  const reason = refusalReason({ env: process.env, hasDockerEnv: detectDockerEnv() });
  if (reason) { console.error(reason); process.exit(1); }

  let opts;
  try { opts = parseArgs(argv); } catch (err) { console.error(`${err.message}\n${USAGE}`); process.exit(2); }
  if (opts.help) { console.log(USAGE); return; }

  const { meta, cases } = loadCases(CASES_DIR);
  const issues = validateCases(cases, meta);
  // A 档的重放脚本必须真的存在：validateCases 是纯函数不碰盘，这一步补在入口里
  for (const c of cases) {
    if (c.tier === 'A' && c.check?.spec && !existsSync(join(ACCEPT_DIR, c.check.spec))) {
      issues.push({ id: c.id, file: null, message: `check.spec 指向的 ${c.check.spec} 不存在` });
    }
  }

  if (opts.check) {
    for (const i of issues) console.log(`✗ ${[i.file, i.id].filter(Boolean).join(' ')}：${i.message}`);
    console.log(`用例 ${cases.length} 条，问题 ${issues.length} 处`);
    console.log(`按档位：${countBy(cases, 'tier', [null, ...TIERS])}`);
    console.log(`按优先级：${countBy(cases, 'p', PRIORITIES)}`);
    process.exit(issues.length ? 1 : 0);
  }

  let ids = opts.ids;
  if (ids) {
    const known = new Set(cases.map(c => c.id));
    const unknown = ids.filter(id => !known.has(id));
    if (unknown.length) { console.error(`没有这些用例：${unknown.join(' ')}`); process.exit(2); }
  }
  if (opts.changed) {
    let changed;
    try { changed = changedCaseIds(opts.changed, cases); } catch (err) {
      console.error(`--changed ${opts.changed} 失败：${String(err.stderr || err.message).trim()}`);
      process.exit(2);
    }
    ids = ids ? ids.filter(id => changed.includes(id)) : changed;
  }

  const selected = selectCases(cases, { tiers: opts.tiers, ids });
  if (opts.ids) {
    const picked = new Set(selected.map(c => c.id));
    const dropped = opts.ids.filter(id => !picked.has(id));
    if (dropped.length) console.log(`⚠ 点名了但档位不在 --tier ${opts.tiers.join(',')} 内（或不在 --changed 范围内），未选：${dropped.join(' ')}`);
  }
  console.log(`选中 ${selected.length} 条（--tier ${opts.tiers.join(',')}${opts.changed ? `，--changed ${opts.changed}` : ''}）`);

  if (opts.list) {
    for (const c of selected) console.log(`  ${line(c)}`);
    return;
  }
  if (issues.length) {
    console.error(`用例库有 ${issues.length} 处问题，先跑 node tests/acceptance/run.mjs --check 修好再执行`);
    process.exit(1);
  }

  const notice = handoffNotice(selected);
  if (notice) console.log(`\n${notice}`);

  const replay = selected.filter(c => c.tier === 'A');
  if (!replay.length) return;
  const scripts = replayScripts();
  if (!scripts.length) {
    console.log(`\nA 档 ${replay.length} 条，但 replay/ 下还没有任何 *.accept.ts 重放脚本，没有可跑的。`);
    return;
  }

  const runDir = join(ACCEPT_DIR, 'local', 'runs', runTimestamp());
  mkdirSync(runDir, { recursive: true });
  console.log(`\nA 档 ${replay.length} 条交给 Playwright 重放，产物：${relative(REPO_ROOT, runDir)}`);
  const grep = `\\b(?:${replay.map(c => c.id).join('|')})\\b`;
  const r = spawnSync('npx', ['playwright', 'test', '-c', relative(REPO_ROOT, REPLAY_CONFIG), '--grep', grep], {
    cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, CCM_ACCEPT_RUN_DIR: runDir },
  });
  const { missing, error } = missingReplays(replay.map(c => c.id), join(runDir, REPLAY_REPORT));
  if (error) console.error(`\n✗ ${error}`);
  if (missing.length) console.error(`\n✗ 选中了却没有跑到 ${missing.length} 条（没有标题含该编号的 test，或被 skip）：${missing.join(' ')}`);
  process.exit(r.status !== 0 ? (r.status ?? 1) : (missing.length ? 1 : 0));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
