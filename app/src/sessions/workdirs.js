// workdirs.js —— 多工作区白名单配置：解析 / 校验 / 归一
// 单一事实源：src/server/app.js 的 preflight + fs.watch 热加载、scripts/doctor.js D3 都用这里的函数，
// 避免 string|object 解析逻辑三处分叉。
// 条目形态：`string`（路径）或 `{ path: string, sessionLimit?: 正整数 }`（向后兼容纯字符串数组）。
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isAbsolute as isAbsolutePosix } from 'node:path/posix';
import { isAbsolute as isAbsoluteWin32 } from 'node:path/win32';
import { encodeProjectDir } from '../shared/project-dir.js';
import { CLAUDE_DIR_NAME } from '../shared/claude-home.js';

export const DEFAULT_SESSION_LIMIT = 6;   // 未指定时每工作区历史会话默认显示条数
export const MAX_SESSION_LIMIT = 50;      // 上限：单一事实源，history.js LIST_LIMIT 与 src/server/app.js 的 session:list all 分支直接 import 本常量（= 前端「显示全部」的服务端硬顶）
export const MAX_LIVE_SESSIONS = 20;      // 全局硬上限：live 会话实例数量，防止有意保留过多 CLI 子进程
// 会话标题搜索：SCAN 是扫盘匹配上限，必须高于 MAX_SESSION_LIMIT，否则搜不到「显示全部」窗外的旧会话。
// RESULT 是返回条数上限，与浏览硬顶同量级（结果列表也不该一次吐上百行）。
// 单一事实源：history.js 与 session:list handler 同 import。
export const SEARCH_SCAN_LIMIT = 500;
export const SEARCH_RESULT_LIMIT = 50;

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
// 错误拼进安装目录。三处调用方（src/server/app.js 的 preflight + fs.watch 热加载、doctor.js D3）共用本函数。
export function resolveWorkdirsFilePath(dirsFile, baseDir) {
  return (isAbsolutePosix(dirsFile) || isAbsoluteWin32(dirsFile)) ? dirsFile : join(baseDir, dirsFile);
}

// 工作区列表来源的优先级判定（纯函数；I/O 与 env 读取都留在调用方 src/server/app.js）。
//
// 【为什么是 env 优先】CLAUDE.md 立的通用规则是「环境变量始终压过文件」。此前 app.js 的
// readWorkdirSource 把配置文件里的内联 WORKDIRS 无条件排在最前，理由是「统一配置文件是新的事实源，
// 显式写了就该赢」——那条理由只在「文件 vs 更旧的文件」之间成立，一旦对手是 env 就与通用规则冲突：
// 显式 `export WORK_DIRS=...` 反而收窄不了白名单。2026-09-01 真机实测到的后果是 smoke 起的隔离
// 实例继承了真实 ccm.config.json 里的 7 个真实工作区，而它明明传了 WORK_DIRS=<临时目录>；任何
// 「临时用别的工作区跑一次」的场景都会撞上同一堵墙。
//
// 生产路径行为不变：两个 env 都没设时仍回落内联 WORKDIRS（既有部署正是这条路）。
// envList 为空数组视为「没设」而不是「设成空」——`WORK_DIRS=` 手滑不该把整份白名单清空。
export function pickWorkdirSource({ envList = [], envFile = '', inline = null } = {}) {
  if (Array.isArray(envList) && envList.length) return { kind: 'env-list', value: envList };
  if (envFile) return { kind: 'env-file', value: envFile };
  if (inline !== null && inline !== undefined) return { kind: 'inline', value: inline };
  return { kind: 'none', value: [] };
}

// 把已退役的「主工作目录」（WORK_DIR）折进工作区列表首位。
//
// 【为什么是折叠而不是直接不认】WORK_DIR 曾是独立配置项：恒占白名单首位、决定手机端默认打开哪个
// 目录。它与 WORKDIRS 在装机向导里必然重复第一项（setup 写的就是 `{workDir: dirs[0], workDirs: dirs}`），
// 用户打开配置文件只看到「同一个路径写了两遍」。现已取消，主工作目录 = 列表首项。
//
// 但直接不认会**静默改行为**：谁的 WORK_DIR 不是 WORKDIRS 的第一项（甚至根本不在列表里），
// 升级后手机端默认打开的目录就换了一个，而且一行日志都没有。所以这里折叠 + 由调用方告警，
// 与 WORK_DIRS / WORK_DIRS_FILE 两条旧路径的退役方式同一形状（见 config-file.js 的 foldWorkdirs）。
//
// 提到首位而不是追加末尾：旧语义里 WORK_DIR 恒首位，提首位才是「行为不变」。
// 已在列表里时保留它原有的 sessionLimit —— 用户显式配过的数字不该因为换了个位置就丢。
export function foldPrimaryWorkdir(entries = [], primary = '') {
  const path = String(primary ?? '').trim();
  if (!path) return { entries: [...entries], warnings: [] };

  const idx = entries.findIndex(e => e.path === path);
  const warnings = [
    idx === 0
      ? 'WORK_DIR 已退役：它就是工作区列表的第一项，可以从配置里删掉这一行'
      : `WORK_DIR 已退役：已把「${path}」提到工作区列表首位（主工作目录 = 列表首项）；请把它写进 WORKDIRS 后删掉 WORK_DIR`,
  ];
  if (idx === -1) return { entries: [{ path, sessionLimit: DEFAULT_SESSION_LIMIT }, ...entries], warnings };
  return { entries: [entries[idx], ...entries.filter((_, i) => i !== idx)], warnings };
}

// 选出该折叠哪一个「主工作目录」——**按来源分档，不是无条件取配置文件里那个**。
//
// 【这是 2026-09-01 那条教训的漏网分支】当时把「内联 WORKDIRS 压过 env」改成 env 优先，理由是
// 显式 `export WORK_DIRS=...` 必须能收窄白名单（smoke 起的隔离实例曾继承到 7 个真实工作区）。
// 但 app.js 的 applyWorkdirs 里还有一句无条件的 `nextDirs = [WORK_DIR]`，配置文件里的 WORK_DIR
// 照样被塞进首位 —— 于是「显式 WORK_DIRS 收窄不了白名单」这件事在**首位**上一直还成立。
// 2026-09-08 容器里实测确认：设了 WORK_DIRS=<临时目录> 之后，preflight 仍在校验配置文件的 WORK_DIR。
//
// 分档规则与「环境变量始终压过文件」同一条：
//   · shell 里的 WORK_DIR 与 env 列表同级，任何来源下都折叠；
//   · 配置文件里的 WORK_DIR 只在**列表也来自配置文件**（inline）时才折叠，env 来源生效时一并让位。
export function pickPrimaryWorkdir({ kind, envPrimary = '', inlinePrimary = '' } = {}) {
  const fromEnv = String(envPrimary ?? '').trim();
  if (fromEnv) return fromEnv;
  return kind === 'inline' ? String(inlinePrimary ?? '').trim() : '';
}

// 把 pickWorkdirSource 的选择兑现成 { result, from, filePath?, warnings }。
// doctor D3 必须走这里，不能自己 `if (Array.isArray(inline)) return`——那会把 WORK_DIRS env 吃掉。
//
// 退役中的 WORK_DIR 在这一层折进列表首位（见 foldPrimaryWorkdir），于是三个消费者
//（server preflight、server 热加载、CLI doctor）自动同步，不会各留一份「主目录从哪来」的判据。
export function resolveWorkdirSource({
  envList = [], envFile = '', inline = null, here = '', envPrimary = '', inlinePrimary = '',
} = {}) {
  const picked = pickWorkdirSource({ envList, envFile, inline });
  const primary = pickPrimaryWorkdir({ kind: picked.kind, envPrimary, inlinePrimary });

  // result === null 表示外部文件读不出来（整体非法回退语义）：原样透传，不在这里替调用方决定，
  // 也不折叠 —— 往一份「读失败」的结果里塞进一个目录会让调用方的「保留旧白名单」判据失真。
  const fold = (result) => {
    if (result === null) return { result, warnings: [] };
    const folded = foldPrimaryWorkdir(result.entries, primary);
    return {
      result: { entries: folded.entries, warnings: result.warnings },
      warnings: folded.warnings,
    };
  };

  if (picked.kind === 'env-file') {
    const filePath = resolveWorkdirsFilePath(picked.value, here);
    return { ...fold(loadWorkdirsFile(filePath)), from: 'WORK_DIRS_FILE', filePath };
  }
  if (picked.kind === 'inline') {
    return { ...fold(normalizeWorkdirEntries(picked.value)), from: 'WORKDIRS' };
  }
  return {
    ...fold(normalizeWorkdirEntries(picked.kind === 'env-list' ? picked.value : [])),
    from: 'WORK_DIRS',
  };
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
  if (dirs.includes(cwd)) return cwd;
  // 托管 worktree 与白名单目录同权：它不是"被热移除的目录"，归位到 dirs[0] 就把 routeCwd 刚
  // 放行的 cwd 当场作废。两道闸在 8 个 handler 里成对出现（`ensureWhitelisted(routeCwd(x), dirs)`），
  // 只改一道等于没改，且症状与完全没改一模一样——不会有任何报错。
  const managed = resolveManagedWorktree(cwd, dirs);
  if (managed) return managed.path;
  return dirs[0];
}

// 精确白名单判定（单一事实源）：cwd 是否为白名单内目录。供 routeCwd 做越界检测 + 审计信号。
// 与 ensureWhitelisted 的区别：本函数只回答“在不在范围内”（不做归位），让调用方决定越界时如何处理（回退 + 记审计）。
// 仓库外的 git linked worktree（`../repo-<分支>` 这类）若要用，须把其绝对路径显式写入 workdirs.json，
// 与其它工作区同级——无自动探测、无隐式放行。**例外只有一种**，见下方 resolveWorktreeParent。
export function isWhitelisted(cwd, dirs) {
  return typeof cwd === 'string' && cwd !== '' && dirs.includes(cwd);
}

// CLI 托管 worktree 的容器目录（相对 workdir 根）：`EnterWorktree`、`--worktree`、agent isolation
// 三者的默认落点都是这里。枚举侧（history.js）与放行侧（下方）共用这一份，不各写一遍——
// SS-004 那次「注释写着同规则、实际各存一份」就是这么漂的。
export const managedWorktreeRoot = dir => join(dir, CLAUDE_DIR_NAME, 'worktrees');

// 托管 worktree 的派生放行（2026-09-11）。
//
// 【为什么这不是给 SCOPE-01 开例外】放行集恒为 `<白名单目录>/.claude/worktrees/<单段>`，
// 始终落在白名单目录**子树内**——「候选路径 realpath 后须落在授权工作区内」这条原样成立。
// 真正新增的自由度只有一个：深度固定为 1 的那一层目录名。跳出子树的形态（仓库外的平级兄弟
// worktree）不在此列，仍须显式写进 WORKDIRS。
//
// 【为什么必须 realpath】dirs 恒为已 realpath 的白名单（normalizeWorkdirEntries 出参契约），
// 候选也要解析后再比：`.claude/worktrees/x -> /somewhere/else` 这种 symlink 若拿未解析路径比前缀，
// 在 macOS 上就是静默永远放行。
//
// 【为什么不递归】允许再深一层，等于从一个已放行的 worktree 里能无限派生出新的授权路径。
//
// 【为什么返回解析后的 path 而不只是父仓】调用方拿这个 cwd 去算 transcript 的 project 目录
// （getProjectDir(cwd)），而 CLI 落盘时用的是它自己解析过的路径——macOS 上 /var 与 /private/var
// 算出来是两个不同的目录名，传未解析的那个会静默查空。让判据把解析结果一并交出去，
// 调用方就没有"记得再 realpath 一次"这一步可漏；两次各自 realpath 也会多出一个 TOCTOU 窗口。
//
// @returns {{ parent: string, path: string }|null}
//   parent = 归属的父 workdir（已 realpath，供归组展示）；path = 候选自身 realpath 后的绝对路径
export function resolveManagedWorktree(cwd, dirs) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  if (!Array.isArray(dirs) || dirs.length === 0) return null;
  let real;
  try {
    real = realpathSync(cwd);
  } catch {
    return null; // fail-closed：真实落点无法确认（不存在/不可达）一律不放行
  }
  for (const d of dirs) {
    const prefix = managedWorktreeRoot(d) + sep;
    if (!real.startsWith(prefix)) continue;
    const rest = real.slice(prefix.length);
    if (rest === '' || rest.includes(sep)) continue;
    return { parent: d, path: real };
  }
  return null;
}

// SS-004：与 history.getProjectDir / CLI 同规则。两边共用 src/shared/project-dir.js 的单一实现——
// 此处曾是一份逐字复制品，注释写着「同规则」却和 history 那份一起漏了 200 截断与 NFC 归一。
// 从 shared 取而不是从 history 取，仍是为了避免 workdirs↔history 循环耦合。
const projectDirKey = encodeProjectDir;

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
