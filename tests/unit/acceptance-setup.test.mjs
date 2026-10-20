// tests/unit/acceptance-setup.test.mjs —— 验收套件的新电脑一键准备（tests/acceptance/setup.mjs）
// 覆盖：local.example/ → local/ 只补缺、绝不覆盖；secrets.json 每次都收回 600；
// .claude/skills/ccm-accept 建成指向 tests/acceptance/skill 的相对链接，已存在且指向别处时只警告不改；
// local/ 没被 git 忽略时要警告（里面是网关凭据）。
// 全部在 mkdtemp 夹具里跑：setup 写的是仓库树，测试绝不能落到真实仓库上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from '../../tests/acceptance/setup.mjs';

const TEMPLATE_CONFIG = '{ "gateway": { "baseUrl": "<填写>" } }\n';
const TEMPLATE_SECRETS = '{ "gatewayAuthToken": "<填写>" }\n';

async function makeRepo() {
  const repoRoot = await mkdtemp(join(tmpdir(), 'ccm-accept-setup-'));
  const acceptanceDir = join(repoRoot, 'tests', 'acceptance');
  await mkdir(join(acceptanceDir, 'local.example'), { recursive: true });
  await mkdir(join(acceptanceDir, 'skill'), { recursive: true });
  await writeFile(join(acceptanceDir, 'local.example', 'config.json'), TEMPLATE_CONFIG);
  await writeFile(join(acceptanceDir, 'local.example', 'secrets.json'), TEMPLATE_SECRETS);
  await writeFile(join(acceptanceDir, 'skill', 'SKILL.md'), '---\nname: ccm-accept\n---\n');
  return { repoRoot, acceptanceDir, linkPath: join(repoRoot, '.claude', 'skills', 'ccm-accept') };
}

const mode = async p => (await stat(p)).mode & 0o777;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

test('首跑：复制模板、secrets 设 600、建 runs/、skill 链接是相对路径且指到 tests/acceptance/skill', async t => {
  const repo = await makeRepo();
  t.after(() => rm(repo.repoRoot, { recursive: true, force: true }));

  setup(repo);

  const local = join(repo.acceptanceDir, 'local');
  assert.equal(await readFile(join(local, 'config.json'), 'utf8'), TEMPLATE_CONFIG);
  assert.equal(await readFile(join(local, 'secrets.json'), 'utf8'), TEMPLATE_SECRETS);
  assert.equal(await mode(join(local, 'secrets.json')), 0o600, 'secrets.json 必须是 600');
  assert.ok((await stat(join(local, 'runs'))).isDirectory());

  assert.ok((await lstat(repo.linkPath)).isSymbolicLink());
  assert.equal(await readlink(repo.linkPath), join('..', '..', 'tests', 'acceptance', 'skill'),
    '必须是相对链接：绝对路径换台电脑、换个 clone 位置就断了');
  assert.equal(await realpath(join(repo.linkPath, 'SKILL.md')), await realpath(join(repo.acceptanceDir, 'skill', 'SKILL.md')));
});

test('再跑：已有的 local 文件一个字节都不动，secrets 的权限被改宽了会收回 600', async t => {
  const repo = await makeRepo();
  t.after(() => rm(repo.repoRoot, { recursive: true, force: true }));
  setup(repo);

  const local = join(repo.acceptanceDir, 'local');
  await writeFile(join(local, 'config.json'), '{ "gateway": { "baseUrl": "已填的真实值" } }\n');
  await writeFile(join(local, 'secrets.json'), '{ "gatewayAuthToken": "已填的令牌" }\n');
  await chmod(join(local, 'secrets.json'), 0o644);

  const second = setup(repo);

  assert.equal(await readFile(join(local, 'config.json'), 'utf8'), '{ "gateway": { "baseUrl": "已填的真实值" } }\n');
  assert.equal(await readFile(join(local, 'secrets.json'), 'utf8'), '{ "gatewayAuthToken": "已填的令牌" }\n',
    '重跑 setup 覆盖掉已填的凭据，等于每次换电脑都要重填一遍');
  assert.equal(await mode(join(local, 'secrets.json')), 0o600);
  assert.ok((await lstat(repo.linkPath)).isSymbolicLink());
  assert.ok(!second.warnings.some(w => /ccm-accept/.test(w)), `链接已正确时不该警告：${second.warnings}`);
});

test('skill 链接已存在且指向别处（或是个真目录）→ 只警告，不改', async t => {
  const repo = await makeRepo();
  t.after(() => rm(repo.repoRoot, { recursive: true, force: true }));
  await mkdir(join(repo.repoRoot, '.claude', 'skills'), { recursive: true });
  await symlink('../../somewhere-else', repo.linkPath);

  const r1 = setup(repo);
  assert.equal(await readlink(repo.linkPath), '../../somewhere-else', '别人的链接不能被改写');
  assert.ok(r1.warnings.some(w => /ccm-accept/.test(w) && /somewhere-else/.test(w)), `应点名现有指向：${r1.warnings}`);

  await rm(repo.linkPath);
  await mkdir(repo.linkPath);
  await writeFile(join(repo.linkPath, 'SKILL.md'), '本机手写的 skill');
  const r2 = setup(repo);
  assert.equal(await readFile(join(repo.linkPath, 'SKILL.md'), 'utf8'), '本机手写的 skill');
  assert.ok(r2.warnings.some(w => /ccm-accept/.test(w)));
});

test('local/ 没被 git 忽略时警告；忽略了就不警告', async t => {
  const repo = await makeRepo();
  t.after(() => rm(repo.repoRoot, { recursive: true, force: true }));
  git(repo.repoRoot, 'init', '-q');

  const exposed = setup(repo);
  assert.ok(exposed.warnings.some(w => /git/.test(w) && /secrets\.json/.test(w)),
    `local/secrets.json 会被 git add 收进去却没警告：${exposed.warnings}`);

  await writeFile(join(repo.repoRoot, '.gitignore'), '/tests/acceptance/local/\n');
  const ignored = setup(repo);
  assert.ok(!ignored.warnings.some(w => /git/.test(w)), `已忽略仍警告：${ignored.warnings}`);
});
