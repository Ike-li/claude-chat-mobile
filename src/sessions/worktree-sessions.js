// worktree-sessions.js —— 发现「在 git worktree 里创建的、可续接的会话」。
//
// 用户决策（2026-07-18）：只列【有 worktree 的分支】——即当前还活着的 linked worktree。
// 故发现主轴 = `git worktree list --porcelain`（权威、直接给出 path↔branch），而非扫会话内的
// worktree-state。worktree 已删的孤儿会话留待 Phase 2（届时改以会话内 `worktree-state` 记录
// 反查归属——那才是 git worktree list 失明、必须靠会话自记 originalCwd 的场景）。
//
// 机制考据（2026-07-17 会话 d7a185a3 实测）：CLI 调 EnterWorktree 后把 transcript relocate 到
// worktree 的 project 目录（history.getProjectDir(worktreePath)），故每个 linked worktree 的会话
// 直接躺在 encode(worktreePath) 目录里，用现有 listSessionsPage(worktreePath) 即可列出。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { listSessionsPage } from './history.js';

const execFileAsync = promisify(execFile);

// 纯函数：解析 `git worktree list --porcelain` → [{ path, head, branch, detached, bare }]。
// porcelain 格式：每个 worktree 一段、段间空行分隔；段内逐行 "key value"：
//   worktree <abs-path>              （必有，段首）
//   HEAD <sha>                        （非 bare 时有）
//   branch refs/heads/<b> | detached | bare
// 其余键（locked/prunable 等）忽略。
export function parseWorktreeList(stdout) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur && cur.path) out.push(cur); cur = null; };
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') { flush(); continue; }
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    }
  }
  flush();
  return out;
}

// 跑 git 拿某 repo 的 linked worktrees（排除主 worktree）。主 worktree 是 porcelain 列表首项、
// 其 path === repo（git 保证）——它对应现有 session:list 已覆盖的「主树当前分支」，不重复列。
// runner 可注入便于测试；生产用真 git。git 缺失 / 非 repo / 超时 → []（不抛，调用方拿空列表照常）。
export async function listRepoWorktrees(repo, { runner } = {}) {
  let stdout;
  try {
    if (runner) stdout = await runner(repo);
    else ({ stdout } = await execFileAsync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { timeout: 10000 }));
  } catch {
    return [];
  }
  const all = parseWorktreeList(stdout);
  return all.filter((w, i) => i !== 0 && w.path && w.path !== repo);
}

// 发现某 repo 下所有【有 worktree 的分支】及其会话。
// 返回 [{ branch, worktreePath, worktreeExists, sessions:[{id,title,lastUsedAt}] }]，按 branch 名排序。
// listSessions 可注入便于单测；生产用 history.listSessionsPage（含 SDK 快路径 + 缓存）。
export async function discoverWorktreeSessions(repo, { baseDir, runner, listSessions = listSessionsPage } = {}) {
  const worktrees = await listRepoWorktrees(repo, { runner });
  const groups = [];
  for (const w of worktrees) {
    const page = await listSessions(w.path, baseDir ? { baseDir } : {});
    groups.push({
      branch: w.branch || (w.detached ? '(detached)' : '(unknown)'),
      worktreePath: w.path,
      worktreeExists: existsSync(w.path),
      sessions: page.sessions,
    });
  }
  groups.sort((a, b) => String(a.branch).localeCompare(String(b.branch)));
  return groups;
}
