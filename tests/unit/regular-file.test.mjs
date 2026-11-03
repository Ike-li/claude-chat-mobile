// tests/unit/regular-file.test.mjs —— history.js 以外读写 ~/.claude/projects 下 transcript 的点：文件被换成 FIFO 时不得卡住
//
// 姊妹篇是 history-fifo.test.mjs（history.js 内部的读取点）。剩下三处都经 app/src/shared/regular-file.js：
//   · cli-mirror-state 的 readCliObservedState 读尾窗：读失败 = 空观察态
//   · rewind-plan 的 readSessionEntries 读全量：读失败 = []（下游必然 prompt-not-found ⇒ 拒绝回退）
//   · app.js 的 writeSessionEntrypoint 追加 entrypoint-marker：同步 open 卡在 FIFO 上卡的是主线程，整个 server
//     不动、/health 也不应。它是组装根的私有函数，这里测它调用的 appendRegularFileSync
// 判据：每个入口照常返回，FIFO 按各自原有的失败语义处理；正常文件照常读写（正对照，免得「什么都不碰」也绿）。
// 不测什么：writeSessionEntrypoint 确实调的是 appendRegularFileSync——组装根不进单测（testing.md §9），靠 review。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeProjectDir } from '../../app/src/shared/project-dir.js';
import { appendRegularFileSync } from '../../app/src/shared/regular-file.js';
import { expectInChild } from '../helpers/fifo-child.mjs';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-regular-file-')));
test.after(() => rmSync(ROOT, { recursive: true, force: true })); // safe-rm: mkdtemp 一次性目录

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../app/src');
const skip = process.platform === 'win32'; // 没有 mkfifo
const q = v => JSON.stringify(v);

test('镜像态与回退的 transcript 读取：FIFO 按读不出处理，正常会话照常读', { skip }, () => {
  const cwd = join(ROOT, 'cwd');
  const baseDir = join(ROOT, 'projects');
  const dir = join(baseDir, encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mine-1.jsonl'), [
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'user', uuid: 'u1', promptId: 'p1', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'hi' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  execFileSync('mkfifo', [join(dir, 'fifo-1.jsonl')]);
  const o = `{ baseDir: ${q(baseDir)} }`;
  const empty = { model: null, permissionMode: null };
  expectInChild({ mirror: join(SRC, 'agent/cli-mirror-state.js'), rewind: join(SRC, 'sessions/rewind-plan.js') }, `[
    ['mirrorFifo', () => mirror.readCliObservedState('fifo-1', ${q(cwd)}, ${o})],
    // mirror-engine 会把自己 stat 到的 size 传进来，那条路不 stat 但同样要 open
    ['mirrorFifoSized', () => mirror.readCliObservedState('fifo-1', ${q(cwd)}, { baseDir: ${q(baseDir)}, size: 100 })],
    ['rewindFifo', () => rewind.readSessionEntries(${q(cwd)}, 'fifo-1', ${o})],
    ['mirrorMine', () => mirror.readCliObservedState('mine-1', ${q(cwd)}, ${o})],
    ['rewindMine', async () => (await rewind.readSessionEntries(${q(cwd)}, 'mine-1', ${o})).map(e => e.type)],
  ]`, {
    mirrorFifo: empty, mirrorFifoSized: empty, rewindFifo: [],
    mirrorMine: { model: 'claude-x', permissionMode: 'plan' },
    rewindMine: ['permission-mode', 'user', 'assistant'],
  });
});

test('appendRegularFileSync：不存在就按给定 mode 建出来，存在就追加在末尾', () => {
  const file = join(ROOT, 'append', 's.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  appendRegularFileSync(file, 'a\n', { mode: 0o600 });
  assert.equal(statSync(file).mode & 0o777, 0o600, 'transcript 是 owner-only 的，新建出来的不能更宽');
  appendRegularFileSync(file, 'b\n', { mode: 0o600 });
  assert.equal(readFileSync(file, 'utf8'), 'a\nb\n', '已有内容必须保留、新行接在末尾——SDK 可能已经先写了几行');
});

// 没有读端：阻塞式 open 等读端等到天荒地老，同步调用卡的是整个主线程——子进程不动，靠外层超时杀掉。
// 有读端：open 打得开，但它不是 transcript，一个字节都不该写进去。
test('appendRegularFileSync：FIFO 不卡主线程、抛给调用方，有读端时也一个字节不写', { skip }, () => {
  const noReader = join(ROOT, 'fifo-no-reader.jsonl');
  const withReader = join(ROOT, 'fifo-with-reader.jsonl');
  execFileSync('mkfifo', [noReader]);
  execFileSync('mkfifo', [withReader]);
  expectInChild({ rf: join(SRC, 'shared/regular-file.js') }, `[
    ['noReader', async () => {
      try { rf.appendRegularFileSync(${q(noReader)}, 'x', { mode: 0o600 }); return 'wrote'; } catch { return 'threw'; }
    }],
    ['withReader', async () => {
      const fs = await import('node:fs');
      const rd = fs.openSync(${q(withReader)}, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      let r;
      try { rf.appendRegularFileSync(${q(withReader)}, 'x', { mode: 0o600 }); r = 'wrote'; } catch { r = 'threw'; }
      let got;
      try { got = fs.readSync(rd, Buffer.alloc(16)); } catch (e) { got = e.code; }
      fs.closeSync(rd);
      return [r, got];
    }],
  ]`, { noReader: 'threw', withReader: ['threw', 0] }, { childTimeoutMs: 15_000 });
});
