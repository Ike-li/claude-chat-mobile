// git-workspace.js —— 工作区 git status / diff 只读能力（Web「看改了什么」）
// 与 statusline 的三分「计数」分工：本模块产出路径列表 + unified patch。
// 安全：仅相对 path；spawn 用 execFile 固定 argv（禁止 shell）；无 stage/commit 写操作。
import { execFile as execFileCb } from 'node:child_process';
import { resolve, relative, isAbsolute, sep, join } from 'node:path';
import { promisify } from 'node:util';

export const MAX_GIT_ENTRIES = 500;
export const MAX_GIT_DIFF_BYTES = 256 * 1024;
const GIT_STATUS_TIMEOUT_MS = 2_000;
const GIT_DIFF_TIMEOUT_MS = 3_000;
const GIT_MAX_BUFFER = 1 << 20; // 1MB status

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

// 导出供同域的 git-worktree.js 复用：两个模块都要 spawn git，各写一份 execFile 封装迟早漂
// （本仓吃过「注释写着同规则、实际各存一份」的亏，见 SS-004）。
export function gitExec(cwd, gitArgs, { timeoutMs, maxBuffer, execFile } = {}) {
  return runExecFile(
    execFile,
    'git',
    ['-C', cwd, ...gitArgs],
    { timeout: timeoutMs ?? GIT_STATUS_TIMEOUT_MS, maxBuffer: maxBuffer ?? GIT_MAX_BUFFER },
  );
}

// 解析 `git status --porcelain=v1 -z`。
// 普通条目：XY + space + path + \0
// rename/copy：XY + space + 【新】path + \0 + 【原】path + \0
//   ——即 `XY PATH\0ORIG_PATH\0`，与非 -z 的 `XY ORIG -> PATH` 顺序【相反】（git 文档明写
//   "the field order is reversed"）。别照非 -z 的直觉写，也别为「一致性」去对齐 parseNameStatusZ
//   （那个读的是 diff --name-status，old 在前）——两处顺序天生相反，见该函数注释。
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
      // rename/copy：rest 是【新】路径，紧跟的下一段才是原路径。-z 格式的顺序与非 -z 的
      // `XY ORIG -> PATH` 恰好相反（git 文档：`XY PATH\0ORIG_PATH\0`），别照非 -z 的直觉写。
      // 截断输出（缺第二段）时 oldPath 为空串，classifyGitEntries 按 falsy 略去该字段。
      const newPath = rest;
      const oldPath = parts[i + 1] || '';
      if (oldPath) i += 1;
      out.push({ xy, path: newPath, oldPath });
    } else {
      out.push({ xy, path: rest });
    }
  }
  return out;
}

// staged = X ∈ MADRC；unstaged = Y ∈ MDT；untracked = ??
// MM 可同时进入 staged 与 unstaged（与 statusline parsePorcelain 语义一致）。
// 冲突（unmerged）用独立的 XY 组合表示，不落在 MADRC/MDT 分类规则内，须先于其判定单独摘出。
const CONFLICT_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
export function classifyGitEntries(entries) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const conflicted = [];
  for (const e of entries || []) {
    const xy = e.xy || '';
    if (xy === '??') {
      untracked.push({ path: e.path, xy });
      continue;
    }
    if (CONFLICT_XY.has(xy)) {
      conflicted.push({ path: e.path, xy, ...(e.oldPath ? { oldPath: e.oldPath } : {}) });
      continue;
    }
    const X = xy[0] || ' ';
    const Y = xy[1] || ' ';
    if ('MADRC'.includes(X)) staged.push({ path: e.path, xy, ...(e.oldPath ? { oldPath: e.oldPath } : {}) });
    if ('MDT'.includes(Y)) unstaged.push({ path: e.path, xy, ...(e.oldPath ? { oldPath: e.oldPath } : {}) });
  }
  return { staged, unstaged, untracked, conflicted };
}

// 相对 path 安全闸：拒绝空/绝对/含 .. 后越出 cwd 的路径。返回 join 后的绝对路径或 null。
// 注意：此处不做 realpath（文件可能已删、未跟踪尚未存在）；socket 层另用 isInScope/scopeDirs 复核 cwd。
export function assertSafeRelPath(cwd, relPath) {
  if (typeof relPath !== 'string' || !relPath || !cwd) return null;
  if (isAbsolute(relPath)) return null;
  // 拒绝 git pathspec magic / 空字节：否则 git:diff pathspec 可读出 cwd 外同仓文件（I1）。
  // 正常工具/编辑器路径是普通相对路径，不含 : * ? [ ] \ NUL。
  if (/[\0*?[\]\\:]/.test(relPath)) return null;
  // 规范化后相对路径仍含 .. 或指到 cwd 外 → 拒绝
  const resolved = resolve(cwd, relPath);
  const rel = relative(cwd, resolved);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  // Windows 盘符穿越防御：resolved 必须以 cwd+sep 或 cwd 本身为前缀
  if (resolved !== cwd && !resolved.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep)) return null;
  return resolved;
}

// porcelain 条目（路径相对仓库根）→ 相对 cwd。prefix 是 cwd 相对仓库根的前缀（带尾斜杠，仓库根时为空串）。
// `-- .` 之下只剩改名的原路径可能落在 cwd 外：那一端只摘掉 oldPath，不把兄弟目录的名字带出去。
// 恰好等于 cwd 本身的条目（整个工作区都未跟踪时 status 会折叠成这一行）没有相对路径可言，丢掉。
function relativeToCwd(entry, prefix) {
  if (!prefix) return entry;
  if (!entry.path.startsWith(prefix)) return null;
  const path = entry.path.slice(prefix.length);
  if (!path) return null;
  const { oldPath, ...rest } = entry;
  return oldPath && oldPath.startsWith(prefix) ? { ...rest, path, oldPath: oldPath.slice(prefix.length) } : { ...rest, path };
}

function isNotGitError(err) {
  // 退出码 128 也会用于权限不足、索引损坏等其它致命错误，不能单凭 code 判定；只认错误文案。
  const msg = `${err?.message || ''} ${err?.stderr || ''} ${err?.stdout || ''}`.toLowerCase();
  return /not a git repository|outside repository|致命错误|not a git repo/.test(msg);
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

  // porcelain 的路径【恒相对仓库根】（不认 status.relativePaths），不带 pathspec 时列的是整仓改动。工作区是
  // 仓库子目录（monorepo 的一个包）时两样都不对：面板会列出范围外兄弟目录的文件名；列表路径拿去当 diff 的
  // pathspec 又是按 cwd 解析的，指到 <cwd>/<仓库相对路径>，diff 一律为空（2026-09-22 review P2，真 git 实测）。
  // 所以用 `-- .` 把范围收到 cwd 子树，再按 --show-prefix 把路径换成相对 cwd。
  let prefix = '';
  try {
    const p = await gitExec(cwd, ['rev-parse', '--show-prefix'], { timeoutMs, maxBuffer, execFile });
    prefix = String(p.stdout || '').trim();
  } catch { /* 取不到前缀就按仓库根处理；真不是仓库时下面的 status 会报 not_git */ }

  let statusOut;
  try {
    const st = await gitExec(cwd, ['status', '--porcelain=v1', '-z', '--', '.'], { timeoutMs, maxBuffer, execFile });
    statusOut = st.stdout;
  } catch (err) {
    if (isNotGitError(err)) {
      return { ok: false, code: 'not_git', error: '当前目录不是 git 仓库' };
    }
    return { ok: false, code: 'git_error', error: err.message || 'git status 失败' };
  }

  let entries = parsePorcelainZ(statusOut);
  // 工作区目录本身整个未跟踪（仓库里刚新建的包）：普通模式只给一条折叠的 `?? <前缀>`，换算成相对工作区是空串，
  // 面板会显示「没有改动」。只在这种情况下再要一次展开到文件的列表——常态不加 -uall：未忽略的大目录会让
  // status 慢到超时（2026-09-23 #151 review）。展开失败就维持折叠结果，不把整次查询判失败。
  if (prefix && entries.some(e => e.xy === '??' && e.path === prefix)) {
    try {
      const st = await gitExec(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], { timeoutMs, maxBuffer, execFile });
      entries = parsePorcelainZ(st.stdout);
    } catch { /* 见上 */ }
  }
  const all = entries.map(e => relativeToCwd(e, prefix)).filter(Boolean);
  const truncated = all.length > maxEntries;
  const sliced = truncated ? all.slice(0, maxEntries) : all;
  const classified = classifyGitEntries(sliced);
  return {
    ok: true,
    branch,
    staged: classified.staged,
    unstaged: classified.unstaged,
    untracked: classified.untracked,
    conflicted: classified.conflicted,
    truncated,
  };
}

// 单 pathspec 的 diff 若判给 relPath 一方的全量新增/删除，可能是重命名的另一端被 pathspec 排除、配不上对；
// 用不带 pathspec 的 name-status 复核是否命中一条 rename/copy 记录，命中则回传双路径供重新 diff。
// --relative：name-status 的路径默认相对仓库根，而 relPath 相对 cwd（见 listGitChanges）——工作区是仓库子目录时
// 两边对不上，改名永远配不成对。加上它路径改为相对 cwd，且只列 cwd 子树里的改动。
async function findRenamePair(cwd, side, relPath, execOpts) {
  const args = side === 'staged'
    ? ['diff', '--cached', '--name-status', '-M', '-z', '--relative']
    : ['diff', '--name-status', '-M', '-z', '--relative'];
  let out;
  try {
    const r = await gitExec(cwd, args, execOpts);
    out = r.stdout || '';
  } catch {
    return null;
  }
  const parts = out.split('\0').filter(p => p.length > 0);
  // `--name-status -z` 是状态码与路径交替的定长记录：普通条目占 2 段（`M\0path\0`），
  // rename/copy 占 3 段（`R100\0old\0new\0`）。必须【按条目长度】整条推进——只 `continue`
  // 会让下一轮把【路径段】当状态码读，而 README.md / CHANGELOG.md 这类首字母是 R/C 的
  // 常见文件名会因此被误判成 rename 状态码，连吃两段、把真正的 rename 记录整条跳过。
  // 注：本函数读的是 diff 的 name-status，old 在前 new 在后；与 parsePorcelainZ 读的
  // status --porcelain（新在前）顺序相反，两处别互相"对齐"。
  for (let i = 0; i < parts.length;) {
    const status = parts[i];
    if (status[0] === 'R' || status[0] === 'C') {
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      if (oldPath === relPath || newPath === relPath) return { oldPath, newPath };
      i += 3;
    } else {
      i += 2; // 状态码 + 路径
    }
  }
  return null;
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

  // 疑似整体新增/删除：可能是重命名一端配不上对，复核后带双路径 + -M 重新 diff 还原真实改动。
  if (/^(new file mode|deleted file mode) /m.test(stdout)) {
    const pair = await findRenamePair(cwd, side, relPath, { timeoutMs, maxBuffer, execFile });
    if (pair) {
      const rediffArgs = side === 'staged'
        ? ['diff', '--cached', '-M', '--', pair.oldPath, pair.newPath]
        : ['diff', '-M', '--', pair.oldPath, pair.newPath];
      try {
        const r2 = await gitExec(cwd, rediffArgs, { timeoutMs, maxBuffer, execFile });
        stdout = r2.stdout || '';
      } catch {
        // 复核 diff 失败，保留原始 stdout
      }
    }
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

// ── Rewind 的 G5：回退会覆盖工作区，哪些未提交改动【找不回来】 ──
//
// 【判据为什么不是「工作区 dirty 就警告」】开发中 dirty 是常态。每次回退都弹一句
// 「工作区有未提交修改」，用户三次之后就学会了无视它——警告一旦变成背景噪音就等于没有。
// 只报真正有风险的那部分，它才值得被读。
//
// 【什么叫有风险】内容【只存在于工作区、git 对象库里没有】：
//   · unstaged  —— 改了没 add。回退覆盖后 git 里只有旧版本，改动没了
//   · untracked —— 从没进过 git。回退若删掉它（回到该文件尚未创建的那一刻）就是永久丢失
//   · conflicted —— 工作区内容是手工合并的中间结果，覆盖了很难重建
// 纯 staged【不算】：内容已经进了 index，覆盖后仍能从 git 取回（git checkout-index / stash）。
// MM 这种「add 过又改了」的要算——unstaged 那半没进 index。
export function riskyUncommittedPaths(changes) {
  if (!changes || changes.ok !== true) return []; // 非 git 仓库 / 读失败：静默放行，不拿失败当风险
  const out = [];
  const seen = new Set();
  for (const list of [changes.unstaged, changes.untracked, changes.conflicted]) {
    for (const e of list || []) {
      const p = e?.path;
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

// 取「回退会碰的文件」与「改动没进 git 的文件」的交集——只有这批才会真丢东西。
//
// 【路径基准】filesChanged 来自 CLI，是绝对路径；porcelain 的 path 恒相对【仓库根】
// （实测：在任何子目录下跑 `git status --porcelain=v1` 输出的都是相对根的路径，不随 cwd 变）。
// 所以以 repoRoot 为基准拼成绝对路径再比。
// 【为什么不用后缀匹配】`abs.endsWith('/' + rel)` 会把 /repo/x/b/c.txt 误判成 dirty 的 b/c.txt。
// 返回相对路径：给用户看的是 `src/a.js`，不是一长串绝对路径。
export function overlapRiskyFiles(filesChanged, riskyRelPaths, repoRoot) {
  if (!Array.isArray(filesChanged) || !Array.isArray(riskyRelPaths) || !repoRoot) return [];
  const changed = new Set(filesChanged);
  return riskyRelPaths.filter(rel => changed.has(join(repoRoot, rel)));
}

// G5 的完整判定：回退会碰的文件里，哪些有没进 git 的改动。非 git 仓库 / 读失败返回 []（静默放行）。
// 对【仓库根】取改动而不是对 cwd：回退写回的是会话碰过的所有文件，不限于工作区子树——面板那种收窄
// 在这里会漏掉兄弟包里没提交的活。
export async function rewindDirtyOverlap(cwd, filesChanged, opts = {}) {
  const repoRoot = await gitRepoRoot(cwd, opts);
  if (!repoRoot) return [];
  const changes = await listGitChanges(repoRoot, opts);
  return overlapRiskyFiles(filesChanged, riskyUncommittedPaths(changes), repoRoot);
}

// 仓库根（porcelain 路径的基准）。非 git 仓库返回 null——调用方据此跳过整个 G5。
export async function gitRepoRoot(cwd, opts = {}) {
  if (!cwd || typeof cwd !== 'string') return null;
  try {
    const r = await gitExec(cwd, ['rev-parse', '--show-toplevel'], {
      timeoutMs: opts.timeoutMs, maxBuffer: opts.maxBuffer, execFile: opts.execFile,
    });
    return String(r.stdout || '').trim() || null;
  } catch {
    return null;
  }
}
