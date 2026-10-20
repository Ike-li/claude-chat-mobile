#!/usr/bin/env node
// tests/acceptance/setup.mjs —— 新电脑一键准备验收套件（幂等，可反复跑）
//
//   node tests/acceptance/setup.mjs
//
// 做三件事：
//   1. local.example/ 里的模板复制成 local/（只补缺，已存在的绝不覆盖——那里是填好的真实值）
//   2. local/secrets.json 收回 600（每次都收：编辑器另存、cp 都可能把权限放宽）
//   3. 建 .claude/skills/ccm-accept → tests/acceptance/skill 的相对符号链接。Claude Code 只认
//      仓库根 .claude/skills/ 下的 skill；正文进仓，链接被 /.claude/* 忽略，所以每台电脑建一次。
//      链接已存在且指向别处、或那里是个真目录时只警告不改：那可能是机主自己放的东西。
// 最后核对 local/ 有没有被 git 忽略——没忽略的话，下一次 git add -A 就把网关凭据收进公开仓库了。
import { execFileSync } from 'node:child_process';
import {
  chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function setup({ acceptanceDir, repoRoot }) {
  const actions = [];
  const warnings = [];
  const rel = p => relative(repoRoot, p) || '.';

  const exampleDir = join(acceptanceDir, 'local.example');
  const localDir = join(acceptanceDir, 'local');
  mkdirSync(join(localDir, 'runs'), { recursive: true });
  for (const name of readdirSync(exampleDir)) {
    const dest = join(localDir, name);
    try {
      // COPYFILE_EXCL：目标已存在就失败。比「先 exists 再 copy」少一个竞态窗口，也不可能覆盖
      copyFileSync(join(exampleDir, name), dest, constants.COPYFILE_EXCL);
      actions.push(`已从模板生成 ${rel(dest)}（待填写）`);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      actions.push(`已存在，未改动 ${rel(dest)}`);
    }
  }
  const secrets = join(localDir, 'secrets.json');
  if (existsSync(secrets)) {
    chmodSync(secrets, 0o600);
    actions.push(`${rel(secrets)} 权限设为 600`);
  }

  const linkPath = join(repoRoot, '.claude', 'skills', 'ccm-accept');
  const skillDir = join(acceptanceDir, 'skill');
  const want = relative(dirname(linkPath), skillDir);
  mkdirSync(dirname(linkPath), { recursive: true });
  let st = null;
  try { st = lstatSync(linkPath); } catch {}
  if (!st) {
    symlinkSync(want, linkPath, 'dir');
    actions.push(`已建链接 ${rel(linkPath)} → ${want}`);
  } else if (st.isSymbolicLink()) {
    const current = readlinkSync(linkPath);
    if (resolve(dirname(linkPath), current) === resolve(skillDir)) {
      actions.push(`链接已就绪 ${rel(linkPath)} → ${current}`);
    } else {
      warnings.push(`${rel(linkPath)} 已存在，指向 ${current}（应为 ${want}）。没有改动它；确认无用后自己删掉再跑一次 setup。`);
    }
  } else {
    warnings.push(`${rel(linkPath)} 已存在且不是符号链接（是机主自己放的 skill？）。没有改动它；要用仓库里的 skill 就先挪走它再跑一次 setup。`);
  }

  // git check-ignore：0 = 被忽略，1 = 没被忽略，其它 = 判断不了（不在 git 仓库里等）
  const probe = relative(repoRoot, secrets);
  try {
    execFileSync('git', ['check-ignore', '-q', probe], { cwd: repoRoot, stdio: 'ignore' });
  } catch (err) {
    warnings.push(err.status === 1
      ? `${probe} 没有被 git 忽略：git add -A 会把凭据收进仓库。检查根 .gitignore 里的 /tests/acceptance/local/。`
      : `无法确认 ${probe} 是否被 git 忽略（git check-ignore 退出码 ${err.status ?? '未知'}）。提交前自己核一下。`);
  }

  return { actions, warnings };
}

function main() {
  const acceptanceDir = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = resolve(acceptanceDir, '..', '..');
  const { actions, warnings } = setup({ acceptanceDir, repoRoot });
  for (const a of actions) console.log(`✓ ${a}`);
  for (const w of warnings) console.log(`⚠ ${w}`);
  console.log([
    '',
    '下一步：',
    '  1. 填 tests/acceptance/local/config.json 与 local/secrets.json（字段说明见 tests/acceptance/README.md）',
    '  2. node tests/acceptance/preflight.mjs',
  ].join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
