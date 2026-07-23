// git-workspace.js —— 工作区 git status / diff 只读能力（Web「看改了什么」）
// 与 statusline 的三分「计数」分工：本模块产出路径列表 + unified patch。
// 安全：仅相对 path；spawn 用 execFile 固定 argv（禁止 shell）；无 stage/commit 写操作。
import { execFile as execFileCb } from 'node:child_process';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { promisify } from 'node:util';

export const MAX_GIT_ENTRIES = 500;
export const MAX_GIT_DIFF_BYTES = 256 * 1024;
export const GIT_STATUS_TIMEOUT_MS = 2_000;
export const GIT_DIFF_TIMEOUT_MS = 3_000;
export const GIT_MAX_BUFFER = 1 << 20; // 1MB status

const defaultExecFile = promisify(execFileCb);

// 测试注入：opts.execFile(cmd, args, options, cb)  node callback 风格；
// 内部统一包成 Promise。
function runExecFile(execFile, cmd, args, options) {
  if (typeof execFile !== 'function') {
    return defaultExecFile(cmd, args, options).then(
      r => ({ stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }),
      err => Promise.reject(err),
    );
  }
  return new Promise((resolveP, rejectP) => {
    try {
      execFile(cmd, args, options, (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          rejectP(err);
          return;
        }
        resolveP({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    } catch (e) {
      rejectP(e);
    }
  });
}

function gitExec(cwd, gitArgs, { timeoutMs, maxBuffer, execFile } = {}) {
  return runExecFile(
    execFile,
    'git',
    ['-C', cwd, ...gitArgs],
    { timeout: timeoutMs ?? GIT_STATUS_TIMEOUT_MS, maxBuffer: maxBuffer ?? GIT_MAX_BUFFER },
  );
}

// 解析 `git status --porcelain=v1 -z`。
// 普通条目：XY + space + path + \0
// rename/copy：XY + space + oldPath + \0 + newPath + \0
export function parsePorcelainZ(str) {
  if (str == null || str === '') return [];
  const raw = String(str);
  const parts = raw.split('\0').filter(p => p.length > 0);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 3) continue;
    const xy = rec.slice(0, 2);
    const rest = rec.slice(3); // skip XY + space
    if (xy[0] === 'R' || xy[0] === 'C') {
      // rename/copy：当前 rest 是 oldPath，下一段是 newPath
      const oldPath = rest;
      const newPath = parts[i + 1] || '';
      if (newPath) i += 1;
      out.push({ xy, path: newPath || oldPath, oldPath });
    } else {
      out.push({ xy, path: rest });
    }
  }
  return out;
}

// staged = X ∈ MADRC；unstaged = Y ∈ MDT；untracked = ??
// MM 可同时进入 staged 与 unstaged（与 statusline parsePorcelain 语义一致）。
export function classifyGitEntries(entries) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const e of entries || []) {
    const xy = e.xy || '';
    if (xy === '??') {
      untracked.push({ path: e.path, xy });
      continue;
    }
    const X = xy[0] || ' ';
    const Y = xy[1] || ' ';
    if ('MADRC'.includes(X)) staged.push({ path: e.path, xy, ...(e.oldPath ? { oldPath: e.oldPath } : {}) });
    if ('MDT'.includes(Y)) unstaged.push({ path: e.path, xy, ...(e.oldPath ? { oldPath: e.oldPath } : {}) });
  }
  return { staged, unstaged, untracked };
}

// 相对 path 安全闸：拒绝空/绝对/含 .. 后越出 cwd 的路径。返回 join 后的绝对路径或 null。
// 注意：此处不做 realpath（文件可能已删、未跟踪尚未存在）；socket 层另用 isInScope/scopeDirs 复核 cwd。
export function assertSafeRelPath(cwd, relPath) {
  if (typeof relPath !== 'string' || !relPath || !cwd) return null;
  if (isAbsolute(relPath)) return null;
  // 规范化后相对路径仍含 .. 或指到 cwd 外 → 拒绝
  const resolved = resolve(cwd, relPath);
  const rel = relative(cwd, resolved);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  // Windows 盘符穿越防御：resolved 必须以 cwd+sep 或 cwd 本身为前缀
  if (resolved !== cwd && !resolved.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep)) return null;
  return resolved;
}

function isNotGitError(err) {
  const msg = `${err?.message || ''} ${err?.stderr || ''} ${err?.stdout || ''}`.toLowerCase();
  return /not a git repository|outside repository|致命错误|not a git repo/.test(msg)
    || err?.code === 128;
}

/**
 * @returns {Promise<{ok:true,branch,staged,unstaged,untracked,truncated}|{ok:false,code,error}>}
 */
export async function listGitChanges(cwd, opts = {}) {
  if (!cwd || typeof cwd !== 'string') {
    return { ok: false, code: 'bad_cwd', error: '缺少工作目录' };
  }
  const maxEntries = Math.min(
    opts.maxEntries > 0 ? opts.maxEntries : MAX_GIT_ENTRIES,
    MAX_GIT_ENTRIES,
  );
  const execFile = opts.execFile;
  const timeoutMs = opts.timeoutMs ?? GIT_STATUS_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? GIT_MAX_BUFFER;

  let branch = null;
  try {
    const br = await gitExec(cwd, ['symbolic-ref', '--short', 'HEAD'], { timeoutMs, maxBuffer, execFile });
    branch = String(br.stdout || '').trim() || null;
  } catch {
    try {
      const rev = await gitExec(cwd, ['rev-parse', '--short', 'HEAD'], { timeoutMs, maxBuffer, execFile });
      branch = String(rev.stdout || '').trim() || null;
    } catch (err) {
      if (isNotGitError(err)) {
        return { ok: false, code: 'not_git', error: '当前目录不是 git 仓库' };
      }
      // 无 HEAD 的空仓仍可能 status 成功；继续
    }
  }

  let statusOut;
  try {
    const st = await gitExec(cwd, ['status', '--porcelain=v1', '-z'], { timeoutMs, maxBuffer, execFile });
    statusOut = st.stdout;
  } catch (err) {
    if (isNotGitError(err)) {
      return { ok: false, code: 'not_git', error: '当前目录不是 git 仓库' };
    }
    return { ok: false, code: 'git_error', error: err.message || 'git status 失败' };
  }

  const all = parsePorcelainZ(statusOut);
  const truncated = all.length > maxEntries;
  const sliced = truncated ? all.slice(0, maxEntries) : all;
  const classified = classifyGitEntries(sliced);
  return {
    ok: true,
    branch,
    staged: classified.staged,
    unstaged: classified.unstaged,
    untracked: classified.untracked,
    truncated,
  };
}

/**
 * @param {'staged'|'unstaged'} side
 */
export async function readGitDiff(cwd, relPath, side, opts = {}) {
  if (!cwd || typeof cwd !== 'string') {
    return { ok: false, code: 'bad_cwd', error: '缺少工作目录' };
  }
  if (side !== 'staged' && side !== 'unstaged') {
    return { ok: false, code: 'bad_side', error: 'side 须为 staged 或 unstaged' };
  }
  if (!assertSafeRelPath(cwd, relPath)) {
    return { ok: false, code: 'bad_path', error: '路径不合法或不在工作目录内' };
  }

  const maxBytes = Math.min(
    opts.maxBytes > 0 ? opts.maxBytes : MAX_GIT_DIFF_BYTES,
    MAX_GIT_DIFF_BYTES,
  );
  const timeoutMs = opts.timeoutMs ?? GIT_DIFF_TIMEOUT_MS;
  // diff 允许略大 buffer，再按 maxBytes 截断
  const maxBuffer = opts.maxBuffer ?? Math.max(GIT_MAX_BUFFER, maxBytes + 4096);
  const execFile = opts.execFile;

  const gitArgs = side === 'staged'
    ? ['diff', '--cached', '--', relPath]
    : ['diff', '--', relPath];

  let stdout;
  try {
    const r = await gitExec(cwd, gitArgs, { timeoutMs, maxBuffer, execFile });
    stdout = r.stdout || '';
  } catch (err) {
    if (isNotGitError(err)) {
      return { ok: false, code: 'not_git', error: '当前目录不是 git 仓库' };
    }
    // git diff 对「无差异」通常 exit 0；其它错误
    return { ok: false, code: 'git_error', error: err.message || 'git diff 失败' };
  }

  const binary = /Binary files .* differ/i.test(stdout) || stdout.includes('\0');
  let patch = binary && /Binary files .* differ/i.test(stdout)
    ? stdout.trim()
    : stdout;
  if (patch.includes('\0')) {
    // 含 NUL 的当二进制，不回传原始
    return {
      ok: true,
      path: relPath,
      side,
      patch: '（二进制内容，略）',
      binary: true,
      truncated: false,
      empty: false,
    };
  }

  let truncated = false;
  if (patch.length > maxBytes) {
    patch = patch.slice(0, maxBytes);
    truncated = true;
  }
  const empty = patch.length === 0;
  return {
    ok: true,
    path: relPath,
    side,
    patch,
    binary: !!binary,
    truncated,
    empty,
  };
}
