// tests/invariants/folder-picker.test.mjs —— 手机上添加 / 新建文件夹的后端判据
// 守护：FOLDER-01（浏览只回目录名、以家目录为界；家目录 / 磁盘根 / 家目录外 / 禁区 / linked worktree 不能添加；
//        新建只收单段名字、非递归、建完 realpath 复核）
// 测什么：sessions/folders.js 在一次性「家目录」上的真 fs 行为——普通文件、FIFO、symlink、点目录、真 git worktree。
// 不测什么 + 为什么：① 把目录写进配置、热加载生效在 server 层（tests/invariants/server/folders.test.mjs）
//   ② 已连接之后的授权判据（子目录可达、禁区）在 folder-access.test.mjs（SCOPE-05）
// 槽位：S1（一次性目录上的真 fs）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  browseFolderNames, connectRefusalReason, validateFolderName, createSubfolder, MAX_BROWSE_ENTRIES,
} from '../../app/src/sessions/folders.js';

const ROOTS = [];
test.after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); }); // safe-rm: mkdtemp 一次性目录

// 一次性「家目录」：home/{code/{app,.hidden-dir},notes.txt,fifo,link-out → 家目录外,.claude/x}，外加家目录之外的 outside/
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-folder-picker-')));
  ROOTS.push(base);
  const home = join(base, 'home');
  const outside = join(base, 'outside');
  mkdirSync(join(home, 'code', 'app'), { recursive: true });
  mkdirSync(join(home, 'code', '.hidden-dir'));
  mkdirSync(join(home, '.claude', 'x'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(home, 'code', 'notes.txt'), 'x');
  execFileSync('mkfifo', [join(home, 'code', 'fifo')]);
  symlinkSync(outside, join(home, 'code', 'link-out'));
  const forbidden = [join(home, '.claude')];
  return { base, home, outside, forbidden, ctx: { home, forbidden, connected: [] } };
}

test('浏览只回真实目录的名字：文件、FIFO、symlink、点目录都不出现，也不回绝对路径', () => {
  const { ctx } = fixture();
  const res = browseFolderNames('code', ctx);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.entries.map(e => e.name), ['app'],
    '回文件名 = 把目录浏览变成文件浏览；跟 symlink = 一跳出家目录；点目录多是工具的内部状态');
  assert.equal(res.path, 'code');
  for (const e of res.entries) assert.deepEqual(Object.keys(e).sort(), ['name', 'reason']);
});

test('浏览以家目录为界：../、绝对路径、经 symlink 出界，一律拒绝', () => {
  const { ctx } = fixture();
  for (const p of ['..', '../outside', 'code/../../outside', '/etc', 'code/link-out']) {
    const res = browseFolderNames(p, ctx);
    assert.equal(res.ok, false, `${p} 被放行了：${JSON.stringify(res)}`);
    assert.equal(res.entries, undefined, `${p}：拒绝时不得带任何目录名`);
  }
  assert.equal(browseFolderNames('', ctx).ok, true, '空路径 = 家目录本身，可浏览');
  for (const bad of [42, {}, ['code']]) {
    assert.equal(browseFolderNames(bad, ctx).ok, false, `${JSON.stringify(bad)}：载荷来自客户端，非字符串要拒绝而不是抛错`);
  }
});

test('浏览有上限：超出时截断并如实标出', () => {
  const { home, ctx } = fixture();
  const many = join(home, 'many');
  for (let i = 0; i <= MAX_BROWSE_ENTRIES; i += 1) mkdirSync(join(many, `d${String(i).padStart(4, '0')}`), { recursive: true });
  const res = browseFolderNames('many', ctx);
  assert.equal(res.entries.length, MAX_BROWSE_ENTRIES);
  assert.equal(res.truncated, true);
});

test('每个条目带「能不能添加」：禁区置灰，当前目录自身也给判据', () => {
  const { ctx } = fixture();
  const root = browseFolderNames('', ctx);
  assert.equal(root.reason, 'home', '家目录本身不能添加（官方同）');
  // .claude 是点目录，不出现；它的判据由 connectRefusalReason 直接覆盖（下一条）
  assert.equal(root.entries.find(e => e.name === 'code')?.reason, null);
});

test('不能添加的：家目录、磁盘根、家目录以外、禁区内、不存在、文件', () => {
  const { home, outside, ctx } = fixture();
  assert.equal(connectRefusalReason(home, ctx), 'home');
  assert.equal(connectRefusalReason('/', ctx), 'root');
  assert.equal(connectRefusalReason(outside, ctx), 'outside_home');
  assert.equal(connectRefusalReason(join(home, '.claude'), ctx), 'forbidden');
  assert.equal(connectRefusalReason(join(home, '.claude', 'x'), ctx), 'forbidden');
  assert.equal(connectRefusalReason(join(home, 'nope'), ctx), 'not_found');
  assert.equal(connectRefusalReason(join(home, 'code', 'notes.txt'), ctx), 'not_directory');
  assert.equal(connectRefusalReason(join(home, 'code', 'link-out'), ctx), 'outside_home', '经 symlink 指到家目录外，按真实路径判');
  // 正对照
  assert.equal(connectRefusalReason(join(home, 'code'), ctx), null);
});

test('已连接的不重复加；已连接文件夹的子目录可以单独加（官方同）', () => {
  const { home, ctx } = fixture();
  const code = join(home, 'code');
  const withCode = { ...ctx, connected: [code] };
  assert.equal(connectRefusalReason(code, withCode), 'already_connected');
  assert.equal(connectRefusalReason(join(code, 'app'), withCode), null);
});

test('git linked worktree（及其子目录）不能单独加：它跟随所属仓库', () => {
  const { home, ctx } = fixture();
  const repo = join(home, 'code', 'app');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'init');
  const wt = join(home, 'code', 'app-feat');
  git('worktree', 'add', '-b', 'feat', wt);
  mkdirSync(join(wt, 'sub'));
  assert.equal(connectRefusalReason(wt, ctx), 'worktree');
  assert.equal(connectRefusalReason(join(wt, 'sub'), ctx), 'worktree');
  assert.equal(connectRefusalReason(repo, ctx), null, '仓库本身可以加');
});

test('文件夹名：只收单段、非点开头、无控制字符、不超 255 字节', () => {
  for (const bad of ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'a\0b', 'a\nb', 'x'.repeat(256), '中'.repeat(86)]) {
    assert.notEqual(validateFolderName(bad), null, `${JSON.stringify(bad).slice(0, 40)} 被放行了`);
  }
  for (const good of ['app', 'my project', '项目-2026', 'x'.repeat(255)]) {
    assert.equal(validateFolderName(good), null, `${good.slice(0, 20)} 被拒了`);
  }
  assert.notEqual(validateFolderName(42), null);
});

test('新建：在范围内建出单层目录，返回真实路径', () => {
  const { home, ctx } = fixture();
  const res = createSubfolder('code', 'new-proj', ctx);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.path, join(home, 'code', 'new-proj'));
  assert.ok(existsSync(res.path));
});

test('新建：已存在、名字不合法、父目录出界或在禁区里，一律拒绝且什么都没建出来', () => {
  const { home, outside, ctx } = fixture();
  assert.deepEqual(createSubfolder('code', 'app', ctx), { ok: false, error: 'exists' },
    '已存在：不能当成功（用户以为建了个新的空目录），也要和「建失败」分得开——前端提示不同');
  const before = readdirSync(join(home, 'code')).sort();
  assert.equal(createSubfolder('code', 'a/b', ctx).ok, false);
  assert.equal(createSubfolder('code', '..', ctx).ok, false);
  assert.equal(createSubfolder('code', '.hidden-new', ctx).ok, false, '点开头的名字 mkdir 本身建得出来，只有名字校验挡得住');
  assert.deepEqual(readdirSync(join(home, 'code')).sort(), before);
  assert.equal(createSubfolder('code/link-out', 'escaped', ctx).ok, false, '经 symlink 把目录建到家目录外');
  assert.equal(existsSync(join(outside, 'escaped')), false);
  assert.equal(createSubfolder('.claude', 'x2', ctx).ok, false);
  assert.equal(existsSync(join(home, '.claude', 'x2')), false);
  assert.equal(createSubfolder('../outside', 'y', ctx).ok, false);
  assert.equal(existsSync(join(outside, 'y')), false);
  assert.equal(createSubfolder('nope', 'z', ctx).ok, false, '父目录不存在时不能顺手递归建出来');
  assert.equal(existsSync(join(home, 'nope')), false);
});
