// folders.js —— 手机上「添加文件夹」「新建文件夹」的后端判据（FOLDER-01）
//
// 官方桌面端给手机开的是一份文件夹清单，手机上能直接加（2026-09-23 从桌面端安装包实证）。这里收口
// 「能看到什么、能加什么、能在哪建」：浏览只回目录名、以家目录为界；家目录本身、磁盘根、家目录以外、
// 禁区、linked worktree 不能加。加进去之后怎么授权在 folder-access.js（子目录可达、worktree 随仓库）。
//
// 协议里的位置一律是「家目录相对路径」（'' = 家目录）：客户端不必、也不该拼服务端的绝对路径。
import { mkdirSync, readdirSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { findWorktreeOwner, isWithin } from './folder-access.js';

export const MAX_BROWSE_ENTRIES = 500;
const MAX_NAME_BYTES = 255; // 文件系统单段名字上限（字节，不是字符）
const CONTROL_RE = /\p{Cc}/u; // 控制字符整类（C0、DEL、C1），同 auth/devices.js 的别名归一

const realOrNull = p => { try { return realpathSync(p); } catch { return null; } };
const inForbidden = (real, forbidden = []) => forbidden.map(realOrNull).some(f => f && isWithin(real, f));

// 家目录相对路径 → 家目录内的真实路径。出界（../、绝对路径、经 symlink 指出去）一律 null。
function resolveInHome(rel, home) {
  if (typeof rel !== 'string' || isAbsolute(rel)) return null;
  const homeReal = realOrNull(home);
  if (!homeReal) return null;
  const real = realOrNull(resolve(homeReal, rel));
  return real && isWithin(real, homeReal) ? { real, homeReal } : null;
}

// 这个目录能不能加成已连接的文件夹。null = 能；否则是拒绝原因（前端据此置灰并说明）。
// ctx：home 家目录 · forbidden 禁区（~/.claude、CCM 数据目录、scratch 根）· connected 已连接的文件夹
export function connectRefusalReason(candidate, { home, forbidden = [], connected = [] } = {}) {
  const real = typeof candidate === 'string' && candidate ? realOrNull(candidate) : null;
  if (!real) return 'not_found';
  let st;
  try { st = statSync(real); } catch { return 'not_found'; }
  if (!st.isDirectory()) return 'not_directory';
  if (parse(real).root === real) return 'root';
  const homeReal = realOrNull(home);
  if (real === homeReal) return 'home';
  if (!homeReal || !isWithin(real, homeReal)) return 'outside_home';
  if (inForbidden(real, forbidden)) return 'forbidden';
  // 官方：「Worktrees … can't be added on their own. Add the repository」
  if (findWorktreeOwner(real)) return 'worktree';
  if (connected.some(c => realOrNull(c) === real)) return 'already_connected';
  return null;
}

// 「添加文件夹」的目标：家目录相对路径 → 能加时给真实路径，否则给原因（同 connectRefusalReason）。
export function resolveFolderToAdd(rel, ctx = {}) {
  const homeReal = typeof rel === 'string' ? realOrNull(ctx.home) : null;
  if (!homeReal) return { ok: false, error: 'not_found' };
  if (isAbsolute(rel)) return { ok: false, error: 'outside_home' };
  const candidate = resolve(homeReal, rel);
  const reason = connectRefusalReason(candidate, ctx);
  return reason ? { ok: false, error: reason } : { ok: true, path: realpathSync(candidate) };
}

// 列出一个目录下的子目录名（只有名字）。Dirent.isDirectory 不跟随 symlink，于是文件、FIFO、symlink
// 天然不在其列；点目录多是工具的内部状态，不列。每条带能不能加，当前目录自身也带。
export function browseFolderNames(rel, ctx = {}) {
  const at = resolveInHome(rel ?? '', ctx.home);
  if (!at || inForbidden(at.real, ctx.forbidden)) return { ok: false, error: 'out_of_range' };
  let dirents;
  try { dirents = readdirSync(at.real, { withFileTypes: true }); } catch { return { ok: false, error: 'unreadable' }; }
  const names = dirents.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort((a, b) => a.localeCompare(b));
  const shown = names.slice(0, MAX_BROWSE_ENTRIES);
  return {
    ok: true,
    home: at.homeReal, // 客户端据此把相对位置换成会话 cwd
    path: relative(at.homeReal, at.real),
    reason: connectRefusalReason(at.real, ctx),
    entries: shown.map(name => ({ name, reason: connectRefusalReason(join(at.real, name), ctx) })),
    truncated: names.length > shown.length,
  };
}

// 新建文件夹的名字：单段、不以点开头（含 . 与 ..）、无控制字符、不超单段字节上限。null = 合法。
export function validateFolderName(name) {
  if (typeof name !== 'string' || !name) return 'empty';
  if (name.startsWith('.')) return 'hidden';
  if (name.includes('/') || name.includes('\\')) return 'separator';
  if (CONTROL_RE.test(name)) return 'control';
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return 'too_long';
  return null;
}

// 在家目录内某个目录下新建一层子目录（非递归：父目录必须已存在）。
// 建完复核（FILES-2 同款）：判定与 mkdir 之间父目录可能被换成 symlink，mkdir 会跟着它建到别处——
// 真实路径不是预期的那一个，就撤掉这个刚建的空目录再拒。
export function createSubfolder(parentRel, name, ctx = {}) {
  const bad = validateFolderName(name);
  if (bad) return { ok: false, error: bad };
  const at = resolveInHome(parentRel ?? '', ctx.home);
  if (!at || inForbidden(at.real, ctx.forbidden)) return { ok: false, error: 'out_of_range' };
  const target = join(at.real, name);
  try {
    mkdirSync(target);
  } catch (err) {
    return { ok: false, error: err?.code === 'EEXIST' ? 'exists' : 'mkdir_failed' };
  }
  const real = realOrNull(target);
  if (real !== target) {
    if (real) { try { rmdirSync(real); } catch { /* 非空或已不在：不再动它 */ } }
    return { ok: false, error: 'out_of_range' };
  }
  return { ok: true, path: real };
}
