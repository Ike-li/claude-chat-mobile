// file-search.js —— @ 文件引用候选源：授权目录内按 query 模糊匹配文件相对路径（只读）。
// git 仓库优先 git ls-files（跟踪+未跟踪 --exclude-standard，天然遵守 .gitignore）；非 git 目录或 git
// 失败时回落栈式遍历（深度/条数硬顶，跳过 node_modules/.git/.worktrees/隐藏目录）。查询串只用来匹配、
// 不拼进任何路径——候选全部来自 cwd 内枚举，没有穿越面；cwd 本身的授权范围校验由调用方（socket-files.js）负责。
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

export const FILE_SEARCH_LIMIT = 20;
export const FILE_SEARCH_MAX_CANDIDATES = 5000;
export const FILE_SEARCH_MAX_DEPTH = 6;
export const FILE_SEARCH_CACHE_TTL_MS = 5_000;
export const FILE_SEARCH_TIMEOUT_MS = 3_000;

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.worktrees']);

const defaultExecFile = promisify(execFileCb);

// 测试注入：opts.execFile(cmd, args, options, cb)  node callback 风格（同 git-workspace.js runExecFile）。
function runExecFile(execFile, cmd, args, options) {
  if (typeof execFile !== 'function') {
    return defaultExecFile(cmd, args, options).then(
      r => ({ stdout: String(r.stdout ?? '') }),
      err => Promise.reject(err),
    );
  }
  return new Promise((resolveP, rejectP) => {
    try {
      execFile(cmd, args, options, (err, stdout) => {
        if (err) { rejectP(err); return; }
        resolveP({ stdout: String(stdout ?? '') });
      });
    } catch (e) { rejectP(e); }
  });
}

async function gitLsFiles(cwd, { execFile, timeoutMs = FILE_SEARCH_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await runExecFile(
      execFile, 'git', ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { timeout: timeoutMs, maxBuffer: 1 << 20 },
    );
    return stdout.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return null; // 非 git 目录 / git 不可用：回落遍历，不是错误态
  }
}

// 栈式遍历（非递归，避免深目录栈溢出）；深度/条数硬顶是确定性上限，不做成可无限调大的配置项。
// withFileTypes 的 Dirent 类型取自目录项本身（d_type），symlink 既非 isDirectory 也非 isFile → 天然不递归跟随、不收录。
function walkFiles(root) {
  const out = [];
  const stack = [{ dir: root, rel: '', depth: 0 }];
  while (stack.length && out.length < FILE_SEARCH_MAX_CANDIDATES) {
    const { dir, rel, depth } = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (out.length >= FILE_SEARCH_MAX_CANDIDATES) break;
      if (entry.name.startsWith('.') || SKIP_DIR_NAMES.has(entry.name)) continue;
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < FILE_SEARCH_MAX_DEPTH) stack.push({ dir: join(dir, entry.name), rel: entryRel, depth: depth + 1 });
      } else if (entry.isFile()) {
        out.push(entryRel);
      }
    }
  }
  return out;
}

const _candidateCache = new Map(); // cwd → { ts, paths }

async function listCandidatePaths(cwd, opts) {
  const cached = _candidateCache.get(cwd);
  if (cached && Date.now() - cached.ts < FILE_SEARCH_CACHE_TTL_MS) return cached.paths;
  const paths = (await gitLsFiles(cwd, opts)) ?? walkFiles(cwd);
  _candidateCache.set(cwd, { ts: Date.now(), paths });
  return paths;
}

// 仅测试用：候选缓存跨用例串扰会掩盖 fixture 差异，每个用例前清一次。生产不需要手动清（TTL 自然过期）。
export function clearFileSearchCache() { _candidateCache.clear(); }

function isSubsequence(needle, haystack) {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

// 纯匹配：子串命中优先于 subsequence（fzf 式）兜底；同档内 basename 命中排在路径其它段命中之前。
// 大小写不敏感。
// 空 query（刚打完 @）：对齐 CLI @ 补全，返回候选前 limit 条（路径字典序），不是 []——否则 Web 上「打 @ 无反应」。
// paths 空 → []。
export function matchFiles(paths, query, { limit = FILE_SEARCH_LIMIT } = {}) {
  if (!Array.isArray(paths) || !paths.length) return [];
  const q = String(query || '').trim().toLowerCase();
  const lim = Math.max(1, Number(limit) || FILE_SEARCH_LIMIT);
  // 空 query：浏览式列表（git ls-files / walk 顺序稳定后字典序截断）
  if (!q) {
    return paths.map(p => String(p)).filter(Boolean).sort((a, b) => a.localeCompare(b)).slice(0, lim);
  }
  const scored = [];
  for (const raw of paths) {
    const path = String(raw);
    const lower = path.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let tier;
    if (base.includes(q)) tier = 0;
    else if (lower.includes(q)) tier = 1;
    else if (isSubsequence(q, base)) tier = 2;
    else if (isSubsequence(q, lower)) tier = 3;
    else continue;
    scored.push({ path, tier, len: path.length });
  }
  scored.sort((a, b) => a.tier - b.tier || a.len - b.len || a.path.localeCompare(b.path));
  return scored.slice(0, lim).map(s => s.path);
}

export async function searchFiles(cwd, query, opts = {}) {
  if (!cwd || typeof cwd !== 'string') return [];
  const paths = await listCandidatePaths(cwd, opts);
  return matchFiles(paths, query, opts);
}
