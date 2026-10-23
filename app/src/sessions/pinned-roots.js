// pinned-roots.js —— 抽屉文件夹「置顶」的存储（#305）：有序的根路径数组，最后置顶的在最前。
//
// 只是展示偏好，只影响 composeProjects 的输出顺序；授权用的 workDirs、主工作目录、各种回落一律不读它。
// 不存时间戳：数组顺序本身就是「最近置顶在前」，不依赖客户端时钟。断开的根不清记录，重连后回到原位。
//
// 为什么允许新增落盘（docs/hard-rules.md §1）：claude 侧没有「置顶文件夹」这个概念，也不能从 transcript 重建；
// 且它是缓存类——丢了只是顺序回到默认，所以读坏了当作没有、打一行警告，绝不挡启动。
// 写盘照 read-state.js：200ms 防抖、退出时同步 flush。ack 的含义是「内存已接受并已广播」，不保证已落盘。
import { readFileSync, mkdirSync } from 'node:fs';
import { writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeOwnerOnlyFile } from '../files/file-security.js';
import { createSerialWriter } from '../shared/serial-writer.js';
import { dataFile } from '../shared/data-dir.js';

export function createPinnedRootsStore({ file = dataFile('pinned-roots.json'), log = console, debounceMs = 200 } = {}) {
  let roots = load(file, log);
  let changed = false; // 从没改过就不在退出时写：没置顶过的安装不凭空多一个文件

  let saveSeq = 0;
  const writer = createSerialWriter(async (shouldCommit) => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${++saveSeq}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(roots), { mode: 0o600 });
      if (!shouldCommit()) { await unlink(tmp).catch(() => {}); return; }
      await rename(tmp, file);
    } catch (e) {
      try { await unlink(tmp); } catch { /* tmp 可能未生成 */ }
      throw e;
    }
  }, { onError: e => log.error(`[pinned-roots] 保存失败（置顶顺序本次照常生效，重启后可能回到默认）: ${e?.message || e}`) });

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; writer.request(); }, debounceMs);
  }

  // 置顶：先删再插到最前（重复置顶即「再移到最前」）；取消：删掉
  function set(root, pinned) {
    const rest = roots.filter(r => r !== root);
    roots = pinned ? [root, ...rest] : rest;
    changed = true;
    save();
  }

  function flushSaveSync() {
    clearTimeout(saveTimer);
    saveTimer = null;
    writer.fence();
    if (!changed) return;
    mkdirSync(dirname(file), { recursive: true });
    writeOwnerOnlyFile(file, JSON.stringify(roots));
  }

  return { list: () => [...roots], set, flushSaveSync };
}

function load(file, log) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return []; // 没有文件是新装的常态
  }
  try {
    const raw = JSON.parse(text);
    if (Array.isArray(raw) && raw.every(r => typeof r === 'string' && r)) return raw;
  } catch { /* 落到下面 */ }
  log.warn(`[pinned-roots] ${file} 读不懂（损坏或结构不对），按没有置顶启动`);
  return [];
}

// 默认实例：server 全局共用一份（同 read-state.js；n=1 单用户，置顶是所有设备共享的展示偏好）
const store = createPinnedRootsStore();

export const listPinnedRoots = store.list;
export const setRootPinned = store.set;
export const flushSaveSync = store.flushSaveSync;
