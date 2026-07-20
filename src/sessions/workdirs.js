// workdirs.js —— 多工作区白名单配置：解析 / 校验 / 归一
// 单一事实源：server.js preflight + fs.watch 热加载、scripts/doctor.js D3 都用这里的函数，
// 避免 string|object 解析逻辑三处分叉。
// 条目形态：`string`（路径）或 `{ path: string, sessionLimit?: 正整数 }`（向后兼容纯字符串数组）。
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isAbsolute as isAbsolutePosix } from 'node:path/posix';
import { isAbsolute as isAbsoluteWin32 } from 'node:path/win32';

export const DEFAULT_SESSION_LIMIT = 6;   // 未指定时每工作区历史会话默认显示条数
export const MAX_SESSION_LIMIT = 50;      // 上限：单一事实源，history.js LIST_LIMIT 与 server.js history:list all 分支直接 import 本常量（= 前端「显示全部」的服务端硬顶）

// 校验 sessionLimit：必须是 [1, MAX] 的整数。非法（含缺省交由调用方判断）→ 返回 { value, warning }。
function validateSessionLimit(raw, path) {
  if (raw === undefined) return { value: DEFAULT_SESSION_LIMIT, warning: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return { value: DEFAULT_SESSION_LIMIT, warning: `工作区「${path}」sessionLimit 非法（${JSON.stringify(raw)}），回退默认 ${DEFAULT_SESSION_LIMIT}` };
  }
  if (raw > MAX_SESSION_LIMIT) {
    return { value: MAX_SESSION_LIMIT, warning: `工作区「${path}」sessionLimit=${raw} 超上限，夹到 ${MAX_SESSION_LIMIT}` };
  }
  return { value: raw, warning: null };
}

// 纯函数：把 JSON.parse 后的原始值规范化成 [{path, sessionLimit}]。
// 非数组 / 非法条目 / 非法 limit 均 warn-skip（不抛错、不挡启动）；按 path 首见去重。
export function normalizeWorkdirEntries(parsed) {
  const warnings = [];
  if (!Array.isArray(parsed)) {
    return { entries: [], warnings: ['workdirs 配置不是 JSON 数组，已忽略'] };
  }
  const entries = [];
  const seen = new Set();
  for (const raw of parsed) {
    let path, limitRaw;
    if (typeof raw === 'string') {
      path = raw.trim();
    } else if (raw && typeof raw === 'object' && typeof raw.path === 'string') {
      path = raw.path.trim();
      limitRaw = raw.sessionLimit;
    } else {
      warnings.push(`忽略非法工作区条目：${JSON.stringify(raw)}`);
      continue;
    }
    if (!path) { warnings.push('忽略空路径工作区条目'); continue; }
    if (seen.has(path)) continue; // 首见优先（含 sessionLimit）
    seen.add(path);
    const { value, warning } = validateSessionLimit(limitRaw, path);
    if (warning) warnings.push(warning);
    entries.push({ path, sessionLimit: value });
  }
  return { entries, warnings };
}

// WORK_DIRS_FILE 是否已是绝对路径：POSIX（/…）与 win32（C:\… / \\server\share\…）双规范都判一遍，
// 不看宿主 OS——`startsWith('/')` 旧写法在 server 跑在 Windows 上时会把 `C:\...` 误判成相对路径、
// 错误拼进安装目录。三处调用方（server.js preflight + fs.watch 热加载、doctor.js D3）共用本函数。
export function resolveWorkdirsFilePath(dirsFile, baseDir) {
  return (isAbsolutePosix(dirsFile) || isAbsoluteWin32(dirsFile)) ? dirsFile : join(baseDir, dirsFile);
}

// I/O 薄壳：读文件 + JSON.parse + normalize。读/解析失败 → null（调用方据此保留旧配置 = 整体非法回退语义）。
export function loadWorkdirsFile(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null; // 文件不存在/不可读
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // 坏 JSON：保留旧配置，不清空白名单
  }
  return normalizeWorkdirEntries(parsed);
}

// 白名单兜底：routeCwd 类回退逻辑（无显式 cwd 时改用当前查看实例/查看目录）可能落到一个已被热移除、
// 但因仍有 live 实例挂着而未被 reloadWorkdirs 归位的目录——这种目录不在 dirs 里，不能直接信任继续新开会话。
// 归位到 dirs 首位（同 session:new 的既有归位语义），只挡"新开"，不影响该目录上已有会话的继续查看/读取。
export function ensureWhitelisted(cwd, dirs) {
  return dirs.includes(cwd) ? cwd : dirs[0];
}

// 精确白名单判定（单一事实源）：cwd 是否为白名单内目录。供 routeCwd 做越界检测 + 审计信号（FR-23）。
// 与 ensureWhitelisted 的区别：本函数只回答“在不在范围内”（不做归位），让调用方决定越界时如何处理（回退 + 记审计）。
export function isWhitelisted(cwd, dirs) {
  return typeof cwd === 'string' && cwd !== '' && dirs.includes(cwd);
}

// worktree 会话触达（对齐 CLI「cd 进 worktree 即可 /resume」）：合法 cwd = 白名单目录本身，
// 或已注册的 linked worktree 且其所属 repo 仍在白名单（repo 热移除 → worktree 立即随之失效）。
// knownWorktrees（worktreePath → repo）只能由服务端以 `git worktree list` 权威输出写入——
// 客户端伪造任意路径不会入表，故本函数不构成白名单绕过面。
export function isAllowedWorkdir(cwd, dirs, knownWorktrees) {
  if (isWhitelisted(cwd, dirs)) return true;
  const repo = knownWorktrees instanceof Map ? knownWorktrees.get(cwd) : undefined;
  return typeof repo === 'string' && isWhitelisted(repo, dirs);
}

// SS-004：与 history.getProjectDir / CLI 同规则（非字母数字 → '-'）。
// 放在本模块避免 workdirs↔history 循环耦合；history 仍是路径编码的 SoT 实现。
function projectDirKey(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

// SS-004：在一组已 realpath 的工作区路径上检测 project 目录名碰撞。
export function findProjectDirCollisions(dirs = []) {
  const byEnc = new Map();
  for (const d of dirs) {
    if (typeof d !== 'string' || !d) continue;
    const enc = projectDirKey(d);
    if (!byEnc.has(enc)) byEnc.set(enc, []);
    byEnc.get(enc).push(d);
  }
  const collisions = [];
  for (const [encoded, paths] of byEnc) {
    if (paths.length >= 2) collisions.push({ encoded, paths: [...paths] });
  }
  return collisions;
}

// realpathSync（解符号链接/相对段，与 CLI 命名一致）+ isDirectory 校验，warn-skip 无效项；realpath 后二次去重。
// 返回 { dirs: [规范化路径], limits: Map<路径, sessionLimit>, warnings }。
export function resolveWorkdirs(entries) {
  const dirs = [];
  const limits = new Map();
  const warnings = [];
  for (const { path, sessionLimit } of entries) {
    let real;
    try {
      real = realpathSync(path);
      if (!statSync(real).isDirectory()) { warnings.push(`工作区忽略（不是目录）：${path}`); continue; }
    } catch {
      warnings.push(`工作区忽略（不存在/不可达）：${path}`);
      continue;
    }
    if (limits.has(real)) continue; // realpath 后去重（首见 sessionLimit 优先）
    dirs.push(real);
    limits.set(real, sessionLimit);
  }
  // SS-004：CLI 同款 getProjectDir 编码碰撞 → warn（不挡启动；会话列表/历史可能串目录）
  for (const c of findProjectDirCollisions(dirs)) {
    warnings.push(
      `工作区 project 目录名碰撞（CLI 编码「${c.encoded}」）：${c.paths.join(' ↔ ')}——会话列表/历史可能混用，请避免仅分隔符不同的路径`,
    );
  }
  return { dirs, limits, warnings };
}
