// scratch-workspaces.js —— 「无文件夹」会话的一次性目录（SCRATCH-01）
//
// 官方桌面端的 No folder 会话跑在 app 自建的 scratch 目录里。这里只管建与删；它能不能当 cwd 由
// folder-access.js 判（只认根下 mkdtemp 形态的单段目录），根的位置由 shared/scratch-root.js 定。
//
// 【删除是 app/src 唯一一处递归删除】护栏逐条都要成立才删；任一条不成立就留着——留下一个空目录
// 只是垃圾，删错是数据丢失。scratch 目录里可能有用户让模型写的东西，删会话时一并删是官方的行为，
// 但只删得到「确实是 app 建的、确实没人在用的」那一个。
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, parse } from 'node:path';
import { SCRATCH_DIR_RE, isWithin } from './folder-access.js';
import { encodeProjectDir } from '../shared/project-dir.js';

const realOrNull = p => { try { return realpathSync.native(p); } catch { return null; } }; // 同 folder-access.js
const pad = n => String(n).padStart(2, '0');

// 在 scratch 根下建一个新目录（根不存在时一并建出）。日期取本地时间：用户看到的是自己那一天。
export function createScratchWorkspace(root, { now = new Date() } = {}) {
  mkdirSync(root, { recursive: true });
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return mkdtempSync(join(realpathSync.native(root), `scratch-${day}-`));
}

// 删会话之后调用：满足全部护栏才连同内容删掉这个 scratch 目录。返回 { removed, reason }。
// ctx：root scratch 根 · home 家目录 · baseDir ~/.claude/projects（查还有没有别的会话）· liveCwds 所有活实例的 cwd
//
// 「在用」按整棵子树算，不只看目录本身：会话 cwd 可以落进子目录（模型 git init 后 EnterWorktree、Bash cd），
// 那时活实例的 cwd 与 transcript 的 project 目录都不等于这个目录——只比「恰好相等」会把正在用的子树一起删掉。
// 子目录的 project 目录名是「本目录的编码 + '-' + …」；别的 scratch 目录名定长，不会撞上这个前缀。
export function removeScratchWorkspace(dir, { root, home, baseDir, liveCwds }) {
  const rootReal = realOrNull(root);
  if (!rootReal || rootReal === realOrNull(home) || parse(rootReal).root === rootReal) return { removed: false, reason: 'unsafe_root' };
  let st;
  try { st = lstatSync(dir); } catch { return { removed: false, reason: 'missing' }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { removed: false, reason: 'not_scratch' };
  const real = realOrNull(dir);
  if (!real || dirname(real) !== rootReal || !SCRATCH_DIR_RE.test(basename(real))) return { removed: false, reason: 'not_scratch' };
  const encoded = encodeProjectDir(real);
  let projectDirs = [];
  try { projectDirs = readdirSync(baseDir).filter(n => n === encoded || n.startsWith(`${encoded}-`)); } catch { /* 没有 projects 目录 = 没有会话 */ }
  const hasTranscript = projectDirs.some(n => {
    try { return readdirSync(join(baseDir, n)).some(f => f.endsWith('.jsonl')); } catch { return false; }
  });
  const live = [...(liveCwds?.() ?? [])].some(c => isWithin(c, real));
  if (hasTranscript || live) return { removed: false, reason: 'in_use' };
  rmSync(real, { recursive: true, force: true }); // safe-rm: SCRATCH-01 护栏逐条通过——父目录恰为 scratch 根、mkdtemp 形态、非 symlink、根非家目录/磁盘根、无别的会话、无活实例
  return { removed: true, reason: null };
}

// 「无文件夹」首条消息的目录分配。懒开是「建目录 → 查当前会话 → 开实例」，中间有 await：两条并发的
// 首条消息若各建一个目录，下游按 cwd 的单飞（dedupedResume）就合不掉，会各开一个会话。
// 在途期间（从建目录到实例开好）来的请求拿到同一个目录；全部释放之后，下一条才建新的。
export function createScratchAllocator(root, { create = createScratchWorkspace } = {}) {
  let current = null;
  let holders = 0;
  return {
    acquire() {
      if (!current) current = create(root);
      holders += 1;
      const cwd = current;
      let released = false;
      return {
        cwd,
        release() {
          if (released) return;
          released = true;
          holders -= 1;
          if (holders === 0) current = null;
        },
      };
    },
  };
}
