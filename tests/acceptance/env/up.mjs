#!/usr/bin/env node
// tests/acceptance/env/up.mjs —— 起验收环境（缺省只打印命令，--yes 才执行）
//
//   node tests/acceptance/env/up.mjs [--env E1,E2,…|all] [--target <被测检出目录>] [--ref <git ref|worktree>]
//                                    [--build] [--fake-mode turn|turn-bg|turn-screenshot|turn-autoreport] [--yes]
//
//   --env        要起的环境，代码同 cases/meta.json：E1 E2 E2反代 E3 E3proxy E3cf，缺省 E1,E2
//   --target     被测的检出（通常是一个专门的 worktree），缺省本仓库根。不动生产所在的主工作区
//   --ref        E3 分发包打哪个提交，缺省 HEAD；worktree = 连同未提交的改动（见 prepare.mjs）
//   --build      E2 重建 claude-chat-mobile-test:local 镜像（它全机共享，缺省不重建）
//   --fake-mode  E2 的 fake-claude 档位，缺省 turn
//
// E3 的运行目录每次在 os.tmpdir() 下新建（含网关凭据副本，prepare.mjs 拒绝仓库内的目录），
// 路径记进 local/state.json，down.mjs 据此删掉凭据副本。state 里还记着上一轮 E3 时拒绝再起，先 down。
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ENVS, ENV_TARGETS, formatPlan, parseEnvList, planUp, readState, runSteps } from './plan.mjs';

const ACCEPT_DIR = fileURLToPath(new URL('..', import.meta.url));
const USAGE = '用法: node tests/acceptance/env/up.mjs [--env E1,E2,…|all] [--target <被测检出目录>] [--ref <git ref|worktree>] [--build] [--fake-mode <档位>] [--yes]';
const FAKE_MODES = ['turn', 'turn-bg', 'turn-screenshot', 'turn-autoreport'];

function readLocal(name, warnings) {
  try { return JSON.parse(readFileSync(join(ACCEPT_DIR, 'local', name), 'utf8')); } catch (err) {
    warnings.push(`读不到 local/${name}（${err.code ?? err.message}）：先跑 node tests/acceptance/setup.mjs 再填写`);
    return {};
  }
}

function parse(argv) {
  const opts = { envs: DEFAULT_ENVS, target: resolve(ACCEPT_DIR, '..', '..'), ref: 'HEAD', build: false, fakeMode: 'turn', yes: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => { const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`${a} 后面要跟值`); return v; };
    if (a === '--env') opts.envs = parseEnvList(need());
    else if (a === '--target') opts.target = resolve(need());
    else if (a === '--ref') opts.ref = need();
    else if (a === '--fake-mode') {
      opts.fakeMode = need();
      if (!FAKE_MODES.includes(opts.fakeMode)) throw new Error(`--fake-mode 只认 ${FAKE_MODES.join(' / ')}`);
    } else if (a === '--build') opts.build = true;
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

  const warnings = [];
  const config = readLocal('config.json', warnings);
  const secrets = readLocal('secrets.json', warnings);
  const wantsE3 = opts.envs.some(c => ENV_TARGETS[c].project === 'e3');
  const statePath = join(ACCEPT_DIR, 'local', 'state.json');

  const base = { acceptanceDir: ACCEPT_DIR, target: opts.target, envs: opts.envs, config, secrets, ref: opts.ref, build: opts.build, fakeMode: opts.fakeMode, statePath, state: readState(statePath) };
  // 只打印时不建目录：给一个占位路径，真执行才 mkdtemp
  const preview = planUp(base);
  for (const w of [...warnings, ...preview.warnings]) console.log(`⚠ ${w}`);
  for (const e of preview.errors) console.log(`✗ ${e}`);

  if (!opts.yes) {
    console.log(`\n# 环境 ${opts.envs.join(',')}，被测检出 ${opts.target}。只打印、未执行；确认后加 --yes。\n${formatPlan(preview)}`);
    process.exit(preview.errors.length ? 1 : 0);
  }
  if (preview.errors.length) { console.error('\n有 ✗ 项，未执行。'); process.exit(1); }

  const runDir = wantsE3 ? mkdtempSync(join(tmpdir(), 'ccm-accept-nu-')) : null;
  if (runDir) console.log(`E3 运行目录：${runDir}`);
  process.exit(runSteps(planUp({ ...base, runDir })));
}

main(process.argv.slice(2));
