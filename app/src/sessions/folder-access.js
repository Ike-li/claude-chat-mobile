// folder-access.js —— 「已连接的文件夹」的授权判据（SCOPE-04 / SCOPE-05）
//
// 语义对齐官方 Claude 桌面端给手机开的那份文件夹清单（2026-09-23 从桌面端安装包实证）：
//   · 已连接文件夹的子文件夹直接可达（"It's already reachable as part of the folder it's inside"）；
//   · git linked worktree 跟随所属仓库（"Worktrees … can't be added on their own. Add the repository"）；
//   · 无文件夹会话跑在 app 自建的一次性 scratch 目录里。
//
// 【判定全程只读文件，不执行 git】.git/config 模型可写（core.fsmonitor 等能让 git 执行任意命令，
// 与 AUTH-06 剥控制面密钥同一理由）——在授权判据里跑 git，等于把判定交给被判定的对象。
// 由 tests/invariants/worktree-ownership.test.mjs 的源码守卫钉住：本文件不得 import child_process。
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

// mkdtempSync(prefix) 在前缀后追加 6 个 [A-Za-z0-9] 随机字符。只认这个形态：scratch 根下别的目录
// （手工建的、改过名的、多一层的）都不是 app 建的，不放行，删除护栏也只认它（SCRATCH-01）。
export const SCRATCH_DIR_RE = /^scratch-\d{4}-\d{2}-\d{2}-[A-Za-z0-9]{6}$/;

// 向上找 .git 的层数上限：防一条畸形路径（或挂载环）让判据空转。正常路径远到不了这个数。
const MAX_ANCESTOR_WALK = 64;

const realOrNull = (p) => { try { return realpathSync(p); } catch { return null; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
// 仓库侧的 gitdir 只读普通文件：.git 对模型可写，换成 FIFO 的话 readFileSync 会阻塞整个进程直到出现写端。
const readRegularFile = (p) => { try { return statSync(p).isFile() ? readFileSync(p, 'utf8') : null; } catch { return null; } };

// child 是否在 parent 之下（含相等）。必须带分隔符边界：/code/app-x 不在 /code/app 之下。
export function isWithin(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string' || !child || !parent) return false;
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

// 覆盖 real 的最长那个根（嵌套连接时归最深的那个，与配置顺序无关）。
function longestRoot(real, roots) {
  let best = null;
  for (const r of roots) {
    if (typeof r === 'string' && r && isWithin(real, r) && (!best || r.length > best.length)) best = r;
  }
  return best;
}

// dir 是不是一棵 linked worktree 的根，且归属可以双向回验（SCOPE-04）：
//   ① `<dir>/.git` 是普通文件（不是 symlink、不是目录），内容 `gitdir: <R>/.git/worktrees/<名>`；
//   ② 那个管理目录真实存在，且确实位于某个仓库的 `.git/worktrees/` 下；
//   ③ 仓库侧 `<管理目录>/gitdir` 回链到的正是 `<dir>/.git`。
// ①是 worktree 侧的一面之词——模型在任何可写目录里写一行就能伪造；③在仓库那一侧，才是证据。
// 管理目录名不一定等于 worktree 目录名（本机实测 .git/worktrees/agent → …-third-party），只能沿指针走。
function verifyWorktreeAt(dir) {
  const dotGit = join(dir, '.git');
  let st;
  try { st = lstatSync(dotGit); } catch { return null; }
  if (!st.isFile()) return null;
  let content;
  try { content = readFileSync(dotGit, 'utf8'); } catch { return null; }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!m) return null;
  const metaDir = realOrNull(isAbsolute(m[1]) ? m[1] : resolve(dir, m[1]));
  if (!metaDir || !isDir(metaDir)) return null;
  const worktreesDir = dirname(metaDir);
  const gitDir = dirname(worktreesDir);
  if (basename(worktreesDir) !== 'worktrees' || basename(gitDir) !== '.git') return null;
  let back;
  back = readRegularFile(join(metaDir, 'gitdir'))?.trim();
  if (!back) return null;
  if (realOrNull(isAbsolute(back) ? back : resolve(metaDir, back)) !== realOrNull(dotGit)) return null;
  return { worktreeRoot: dir, repo: dirname(gitDir) };
}

// 从 real 向上找第一个 `.git`，交给 verifyWorktreeAt 判：是目录（普通仓库 / 主仓）或 symlink 都会在
// 那里被「必须是普通文件」挡掉——判据只留一处，不在这里重复。返回 { worktreeRoot, repo } 或 null。
// 导出给 folders.js：「worktree 不能单独添加」要用同一份双向回验，不另判一套。
export function findWorktreeOwner(real) {
  let dir = real;
  for (let i = 0; i < MAX_ANCESTOR_WALK; i += 1) {
    let found = false;
    try { lstatSync(join(dir, '.git')); found = true; } catch { /* 这一层没有，继续往上 */ }
    if (found) return verifyWorktreeAt(dir);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// 授权判据（唯一一份）。ctx：
//   connected   已连接文件夹（已 realpath 的 WORKDIRS）
//   extraRoots  额外放行的根（热移除保护：实例创建时所属、之后被移出清单的那个工作区）
//   scratchRoot 无文件夹会话的 scratch 根（可不存在 = 不认任何 scratch）
//   forbidden   禁区（~/.claude、CCM 数据目录）：其子树永远不是合法 cwd
// 返回 null（不放行）或：
//   kind       connected（连接范围内）| worktree（范围外、但属于已连接仓库）| scratch | scratch-root
//   path       realpath 后的 cwd（下游拿它算 project 目录，未解析的路径在 macOS 上会静默查空）
//   root       归属的连接根（scratch 类为 scratch 根）
//   projectKey 抽屉里归到哪个项目：worktree（含托管的）归所属仓库，scratch 归 scratch 根，其余是它自己
//   scopeRoot  文件面板的范围：连接根 / worktree 根 / 这一个 scratch 目录
//   worktreeRoot / repo  落在一棵已双向回验的 linked worktree 里时：那棵树的根与所属仓库（否则 null）。
//              与授权无关的两个事实——懒建 worktree 要据此避免「worktree 里再套 worktree」，
//              网关隔离要据此找到 CLI 会误读 settings.local.json 的那个主仓。
export function resolveAuthorizedCwd(candidate, ctx = {}) {
  if (typeof candidate !== 'string' || !candidate) return null;
  const real = realOrNull(candidate);
  if (!real || !isDir(real)) return null;

  const scratchRoot = typeof ctx.scratchRoot === 'string' && ctx.scratchRoot ? realOrNull(ctx.scratchRoot) : null;
  if (scratchRoot && isWithin(real, scratchRoot)) {
    const base = { root: scratchRoot, projectKey: scratchRoot, worktreeRoot: null, repo: null };
    if (real === scratchRoot) return { kind: 'scratch-root', path: real, scopeRoot: scratchRoot, ...base };
    const seg = real.slice(scratchRoot.length).split(sep).find(Boolean);
    if (!SCRATCH_DIR_RE.test(seg || '')) return null;
    return { kind: 'scratch', path: real, scopeRoot: join(scratchRoot, seg), ...base };
  }

  const roots = [...(Array.isArray(ctx.connected) ? ctx.connected : []), ...(Array.isArray(ctx.extraRoots) ? ctx.extraRoots : [])];
  const root = longestRoot(real, roots);

  // 禁区挡的是「连了个祖先（如 CCM 仓库）就顺带把数据目录开成会话目录」。覆盖它的连接根若本身就开在
  // 禁区里面，那是用户显式写进配置的选择——显式优先，与 worktree 的显式连接同一条规则。
  const forbidden = (Array.isArray(ctx.forbidden) ? ctx.forbidden : []).map(realOrNull).filter(Boolean);
  const blockedBy = (p, byRoot) => forbidden.some(f => isWithin(p, f) && !(byRoot && isWithin(byRoot, f)));
  if (blockedBy(real, root)) return null;

  const wt = findWorktreeOwner(real);
  const repoRoot = wt ? longestRoot(wt.repo, roots) : null;
  const repoAuthorized = Boolean(repoRoot) && !blockedBy(wt.repo, repoRoot);

  const worktreeFacts = { worktreeRoot: wt?.worktreeRoot ?? null, repo: wt?.repo ?? null };
  if (root) {
    // 连接范围内。若它属于某个已授权仓库的 worktree（托管的，或父目录整个连上后的平级那种），项目归仓库；
    // 但覆盖它的连接根若开在 worktree 内部（用户把这棵 worktree 显式连上了）——显式优先，自成项目。
    const explicitInsideWorktree = Boolean(wt) && isWithin(root, wt.worktreeRoot);
    const projectKey = repoAuthorized && !explicitInsideWorktree ? wt.repo : real;
    return { kind: 'connected', path: real, root, projectKey, scopeRoot: root, ...worktreeFacts };
  }
  if (repoAuthorized) {
    return { kind: 'worktree', path: real, root: repoRoot, projectKey: wt.repo, scopeRoot: wt.worktreeRoot, ...worktreeFacts };
  }
  return null;
}

// 从仓库一侧列出它的 linked worktree（每条都过 verifyWorktreeAt 的双向回验）。
// 读 `<repo>/.git/worktrees/*/gitdir`，不跑 `git worktree list`（理由同文件头）。
// 目录已被删掉的（gitdir 指向的路径不存在）不在这里列——那是「已删 worktree」，由调用方另行处理。
export function listLinkedWorktrees(repo) {
  const repoReal = realOrNull(repo);
  if (!repoReal) return [];
  const metaRoot = join(repoReal, '.git', 'worktrees');
  let names;
  try { names = readdirSync(metaRoot); } catch { return []; }
  const out = [];
  for (const name of names) {
    let back;
    back = readRegularFile(join(metaRoot, name, 'gitdir'))?.trim();
    if (!back) continue;
    const wtReal = realOrNull(dirname(isAbsolute(back) ? back : resolve(metaRoot, name, back)));
    if (!wtReal) continue;
    const v = verifyWorktreeAt(wtReal);
    if (v && v.repo === repoReal) out.push({ path: wtReal, name });
  }
  return out;
}
