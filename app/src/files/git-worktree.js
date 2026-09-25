// git-worktree.js —— 会话 worktree 的建 / 列分支 / 删前干净检查
//
// 与同域 git-workspace.js 的分工：那边是**只读**的 status/diff（"看改了什么"），本模块会
// `git worktree add`（建一棵新工作树），所以单独成文件、单独声明，不把写操作混进那份只读声明里。
//
// 【落点固定】worktree 恒建在 `<repo>/.claude/worktrees/<name>`。这不是审美选择：那条路径正是
// sessions/workdirs.js 的 resolveManagedWorktree 唯一放行的形态，也是 history.js 枚举会话时唯一
// 会扫的目录。建在别处 = 建完既打不开也看不见。该目录已被本仓 .gitignore 的 `/.claude/*` 覆盖，
// 不污染父仓 git status。
//
// 【删除极度保守】本模块只提供"证明干净"的检查，**不提供删除**。判据取交集：工作树无改动
// （含未跟踪文件）**且**没有只存在于本分支的提交。任何一项拿不到（路径不在、不是 worktree、
// git 失败）一律 fail-closed 报不干净——查不到状态时报 clean 等于给删除放行。
// 对照 Claude Desktop：它有定时 reaper 自动清扫过期的脏 worktree，靠的是它能查 PR 合并状态
// （branchLanded）。本仓没有那条信息，判"已合并"会判错，所以不做自动回收。
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { gitExec } from './git-workspace.js';
import { CLAUDE_DIR_NAME } from '../shared/claude-home.js';

const BRANCH_TIMEOUT_MS = 3_000;
const STATUS_TIMEOUT_MS = 5_000;
// worktree add 要 checkout 整棵树，比 status/diff 慢一个量级；大仓库上 3s 会误判成失败。
const ADD_TIMEOUT_MS = 60_000;
const MAX_BRANCHES = 500;

// CLI 的 EnterWorktree 对 name 的约束：每个 "/" 分段只允许字母/数字/点/下划线/连字符，总长 ≤64。
// 我们自己建的名字必须落在同一集合里——否则 agent 之后想用 EnterWorktree 的 `path` 重进都进不去。
const NAME_MAX = 64;
const ALLOWED = /[^A-Za-z0-9._-]+/g;

/**
 * 把任意串收敛成合法 worktree 名。压平路径分隔符（`feature/x` → `feature-x`）而不是保留分段：
 * 我们只用单层目录，留着 "/" 会让落点跳出 `.claude/worktrees/<name>` 这一层，派生放行判据当场不成立。
 * @returns {string|null} 合法名；收敛后为空或只剩分隔符 → null（调用方回落 generateWorktreeName）
 */
export function sanitizeWorktreeName(raw) {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.replace(ALLOWED, '-').replace(/^[-.]+|[-.]+$/g, '');
  const cut = collapsed.slice(0, NAME_MAX);
  // 只剩点/连字符的（'..'、'.'、'---'）必须判空：那类名字落到路径上就是穿越或当前目录
  if (!cut || !/[A-Za-z0-9_]/.test(cut)) return null;
  return cut;
}

// 防重名后缀：4 位 base-36（约 168 万种，与原来 Math.random 那版同量级；worktreeNameFromMessage 的名字里
// 没有时间戳，撞名时只靠它区分，十六进制只有 65536 种）。用 crypto 不是因为它要保密（猜中一个 worktree 目录名拿不到任何东西），而是
// CodeQL 的 js/insecure-randomness 会把 Math.random 顺着「worktree 路径 → 实例 cwd → 会话指针」追进
// 会话判断里，链路上任何一处签名变化都会重报同一个误报（#21–#28、#31–#33 全部驳回过）。换掉源头一次了结。
const randomSuffix = () => randomInt(36 ** 4).toString(36).padStart(4, '0');

/** 缺省 worktree 名：`ccm-<日期>-<时分>-<随机>`。可读（列表里认得出）+ 唯一。 */
export function generateWorktreeName(now = new Date(), rand = randomSuffix) {
  const p = n => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
    + `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  return `ccm-${stamp}-${rand()}`;
}

// 从第一条消息取的 slug 最多占这么长，剩下的留给 `-<4位随机>`（总长必须 ≤ NAME_MAX）。
const SLUG_MAX = NAME_MAX - 5;
const SLUG_WORDS = 3;       // 取前几个词：够认出这棵树在干什么，又不至于把整句话搬进分支名
const SLUG_SCAN_CHARS = 200; // 只看消息开头这么多字符——长 prompt 的后半段与主题基本无关

/**
 * 从第一条消息生成 worktree 名：`<slug>-<随机>`，如 `fix-login-redirect-a3f2`。
 * 对照 Claude Desktop 的 `generateWorktreeName(branchHint)`——名字跟任务相关，
 * 在 `git worktree list` 与分支名里一眼认得出这棵树在干什么，时间戳做不到。
 *
 * 【中文必须回落】CLI 的名字字符集不含中文，而本产品的用户多半整句中文。不回落的话 slug 会塌成
 * 空串，拼上后缀就成了 `-a3f2` 这种以连字符开头的名字（sanitize 会把它整个判空）。
 * 【随机后缀不能省】同一条消息发两次（比如换个源分支重开）必须得到不同的名字，
 * 否则第二次 createSessionWorktree 直接 exists 失败，用户看到的是"新会话开不出来"。
 */
export function worktreeNameFromMessage(text, { now = new Date(), rand = randomSuffix } = {}) {
  const suffix = rand();
  const raw = typeof text === 'string' ? text.slice(0, SLUG_SCAN_CHARS) : '';
  const words = raw.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, SLUG_WORDS);
  const slug = sanitizeWorktreeName(words.join('-').toLowerCase());
  if (!slug) return generateWorktreeName(now, () => suffix);
  return `${slug.slice(0, SLUG_MAX)}-${suffix}`;
}

/** 该工作区下的托管 worktree 根。与 sessions/workdirs.js 的 managedWorktreeRoot 同一条路径约定。 */
export const worktreeRootFor = repo => join(repo, CLAUDE_DIR_NAME, 'worktrees');

/** 本地分支列表 + 当前分支（源分支选择器的数据源）。非 git 目录 → `{ok:false, code:'not_git'}`。 */
export async function listBranches(repo, opts = {}) {
  const o = { timeoutMs: opts.timeoutMs ?? BRANCH_TIMEOUT_MS, execFile: opts.execFile };
  let current;
  try {
    const head = await gitExec(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], o);
    current = String(head.stdout || '').trim() || null;
  } catch {
    // rev-parse 失败 = 不是 git 工作区（或损坏）。与"列分支失败"分开报：UI 对这两种的文案不同。
    return { ok: false, code: 'not_git', branches: [], current: null };
  }
  try {
    const r = await gitExec(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], o);
    const branches = String(r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, MAX_BRANCHES);
    return { ok: true, code: null, branches, current };
  } catch (err) {
    return { ok: false, code: 'git_failed', error: err?.message || String(err), branches: [], current };
  }
}

/**
 * 建一棵会话 worktree：`<repo>/.claude/worktrees/<name>`，并从 sourceBranch 切出同名新分支。
 *
 * 失败一律不留痕：源分支不存在时**提前**验一次再动手（而不是让 git worktree add 半路失败），
 * 因为「回落到当前分支」是最坏的失败模式——用户以为从 A 切、实际从 B 切，要到合并时才发现。
 *
 * @returns {{ok:true, path:string, branch:string}|{ok:false, code:string, error?:string}}
 *   code: bad_name | bad_source | exists | not_git | git_failed
 */
export async function createSessionWorktree(repo, { name, sourceBranch } = {}, opts = {}) {
  const safe = sanitizeWorktreeName(name);
  if (!safe) return { ok: false, code: 'bad_name', error: '名称只能含字母、数字、点、下划线和连字符' };
  const branch = safe;
  const path = join(worktreeRootFor(repo), safe);
  const o = { timeoutMs: opts.timeoutMs ?? BRANCH_TIMEOUT_MS, execFile: opts.execFile };

  const src = typeof sourceBranch === 'string' && sourceBranch.trim() ? sourceBranch.trim() : null;
  if (!src) return { ok: false, code: 'bad_source', error: '未指定源分支' };
  try {
    // `<branch>^{commit}` 强制解析成提交对象：只写分支名时 tag/远程同名 ref 也会命中，
    // 而那两种切出来的树和用户在 UI 上选的"分支"不是一回事。
    // 这里【不能】加 `--`：对 rev-parse 来说 `--` 之后的参数按路径而非版本号解析，加了会让
    // 合法分支名也验证失败（实测：加上后连 'main'/'dev' 都会报 bad_source）。防线保持现状——
    // `^{commit}` 强制按提交对象解析，且 git 本身拒绝以 `-` 开头的 ref 名，已实测穷举确认安全。
    await gitExec(repo, ['rev-parse', '--verify', '--quiet', `${src}^{commit}`], o);
  } catch {
    return { ok: false, code: 'bad_source', error: `源分支不存在：${src}` };
  }

  try {
    await gitExec(repo, ['worktree', 'add', path, '-b', branch, '--', src], {
      timeoutMs: opts.timeoutMs ?? ADD_TIMEOUT_MS,
      execFile: opts.execFile,
    });
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err);
    // 同名 worktree/分支已在 → 绝不复用：两个会话写同一棵树会直接分叉，且没有任何报错
    if (/already exists|already used by worktree|already checked out/i.test(msg)) {
      return { ok: false, code: 'exists', error: `已存在同名 worktree 或分支：${safe}` };
    }
    if (/not a git repository/i.test(msg)) return { ok: false, code: 'not_git', error: msg };
    return { ok: false, code: 'git_failed', error: msg };
  }
  return { ok: true, code: null, path, branch };
}

/**
 * 删除前的干净检查。**这是唯一允许放行删除的依据**，所以每一条不确定都必须落在"不干净"那侧。
 *
 * clean = 工作树无改动（含未跟踪）**且** 没有只存在于本分支的提交。
 * 后者用 `rev-list HEAD --not --exclude=<自己> --branches --remotes` 数：
 * 「HEAD 可达、而其他任何分支/远程都不可达」的提交，正好就是"删了就再也找不回来"的那批。
 *
 * @returns {{ok:boolean, clean:boolean, entries:string[], unmergedCommits:number, code?:string}}
 */
export async function inspectWorktreeCleanliness(worktreePath, opts = {}) {
  const o = { timeoutMs: opts.timeoutMs ?? STATUS_TIMEOUT_MS, execFile: opts.execFile };
  const fail = (code, error) => ({ ok: false, clean: false, entries: [], unmergedCommits: 0, code, error });

  let branch;
  try {
    const r = await gitExec(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'], o);
    branch = String(r.stdout || '').trim() || null;
  } catch (err) {
    // 路径不在、不是 git、权限不足……全部走这里。报 clean 等于给删除放行，必须 fail-closed。
    return fail('not_worktree', err?.message || String(err));
  }

  let entries;
  try {
    const r = await gitExec(worktreePath, ['status', '--porcelain'], o);
    entries = String(r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  } catch (err) {
    return fail('git_failed', err?.message || String(err));
  }

  let unmergedCommits;
  try {
    const args = ['rev-list', '--count', 'HEAD', '--not'];
    if (branch && branch !== 'HEAD') args.push(`--exclude=${branch}`);
    args.push('--branches', '--remotes');
    const r = await gitExec(worktreePath, args, o);
    unmergedCommits = Number.parseInt(String(r.stdout || '').trim(), 10);
    if (!Number.isFinite(unmergedCommits)) return fail('git_failed', '无法统计未合并提交');
  } catch (err) {
    return fail('git_failed', err?.message || String(err));
  }

  return { ok: true, clean: entries.length === 0 && unmergedCommits === 0, entries, unmergedCommits, code: null };
}
