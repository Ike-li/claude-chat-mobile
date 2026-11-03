// regular-file.js —— 打开 ~/.claude/projects 下的文件（transcript、子代理的 jsonl 与 meta）：只认普通文件
//
// 那棵树模型写得动。某个文件被换成 FIFO 的话阻塞式 open 永远不返回：异步的占死一个 libuv 线程（默认只有 4 个，
// 几个就让列表、历史、镜像态的读盘整体停摆），同步的直接卡死主线程（2026-10-11 review）。
// 所以一律 O_NONBLOCK 打开再 fstat，不是普通文件就关句柄并抛，交给调用点原有的失败分支：FIFO 与读不出、
// 写不进的文件同一个结果，不另起语义。普通文件上 O_NONBLOCK 不影响读写。
import { closeSync, constants, fstatSync, openSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';

export async function openRegularFile(file) {
  const fh = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  const st = await fh.stat().catch(() => null);
  if (st?.isFile()) return { fh, st };
  await fh.close().catch(() => {});
  throw new Error(`not a regular file: ${file}`);
}

export async function readRegularText(file) {
  const { fh } = await openRegularFile(file);
  try {
    return await fh.readFile('utf-8');
  } finally {
    await fh.close().catch(() => {});
  }
}

// 追加写（不存在就按 mode 建）。没有读端的 FIFO 上 O_NONBLOCK 的 open 直接 ENXIO；有读端的打得开，
// fstat 拦下、一个字节不写。
export function appendRegularFileSync(file, data, { mode } = {}) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK, mode);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`not a regular file: ${file}`);
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}
