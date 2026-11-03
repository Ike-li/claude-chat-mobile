#!/usr/bin/env node
// tests/acceptance/env/down.mjs —— 收验收环境（缺省只打印命令，--yes 才执行）
//
//   node tests/acceptance/env/down.mjs [--env E1,E2,…|all] [--target <被测检出目录>] [--purge-volumes] [--yes]
//
// 以 compose 项目为单位停：E1 / E2 / E2反代 同属 ccm-accept，E3 / E3proxy / E3cf 同属 ccm-accept-nu，
// 点到其中一个就停整个项目。缺省不删卷（不带 -v）：卷里是设备信任表、装好的分发包、建过的测试会话；
// 要从零开始才加 --purge-volumes。停 E3 时顺手删掉运行目录里那份网关凭据副本（路径来自 local/state.json）。
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ENVS, formatPlan, parseEnvList, planDown, readState, runSteps } from './plan.mjs';

const ACCEPT_DIR = fileURLToPath(new URL('..', import.meta.url));
const USAGE = '用法: node tests/acceptance/env/down.mjs [--env E1,E2,…|all] [--target <被测检出目录>] [--purge-volumes] [--yes]';

function parse(argv) {
  const opts = { envs: DEFAULT_ENVS, target: resolve(ACCEPT_DIR, '..', '..'), purgeVolumes: false, yes: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => { const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`${a} 后面要跟值`); return v; };
    if (a === '--env') opts.envs = parseEnvList(need());
    else if (a === '--target') opts.target = resolve(need());
    else if (a === '--purge-volumes') opts.purgeVolumes = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`不认识的参数 ${a}`);
  }
  if (opts.yes && opts.dryRun) throw new Error('--yes 与 --dry-run 只能二选一');
  return opts;
}

function main(argv) {
  let opts;
  try { opts = parse(argv); } catch (err) { console.error(`${err.message}\n${USAGE}`); process.exit(2); }
  const statePath = join(ACCEPT_DIR, 'local', 'state.json');
  const plan = planDown({ acceptanceDir: ACCEPT_DIR, target: opts.target, envs: opts.envs, purgeVolumes: opts.purgeVolumes, state: readState(statePath), statePath });
  if (!opts.yes) {
    console.log(`# 只打印、未执行；确认后加 --yes。${opts.purgeVolumes ? '\n# ⚠ --purge-volumes：卷会被删掉，下一轮从零开始。' : ''}\n${formatPlan(plan)}`);
    return;
  }
  process.exit(runSteps(plan));
}

main(process.argv.slice(2));
