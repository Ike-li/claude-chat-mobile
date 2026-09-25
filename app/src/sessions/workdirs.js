// workdirs.js —— 多工作区白名单配置：解析 / 校验 / 归一
// 单一事实源：src/server/app.js 的 preflight + fs.watch 热加载、scripts/doctor.js D3 都用这里的函数，
// 避免 string|object 解析逻辑三处分叉。
// 条目形态：`string`（路径）或 `{ path: string, sessionLimit?: 正整数 }`（向后兼容纯字符串数组）。
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
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

// 算出该喂给 pickPrimaryWorkdir 的 `envPrimary`——**上面那段分档规则只有在这个参数真的只装
// 「shell 里的 WORK_DIR」时才成立，而裸读 process.env 拿不到这个保证**。
//
// 【缺陷形态】loadRuntimeEnvironment 会把配置文件的值投影进 process.env（config.js 的
// 「只填 env 里还没有的 key」那段）。投影之后 `process.env.WORK_DIR` 可能是文件给的，调用方却把它
// 当 shell 值传进来，于是 pickPrimaryWorkdir 第一行就无条件让它赢。后果是**授权面收不窄**：
// 配置文件里留着退役的 WORK_DIR 时，`export WORK_DIRS=...` 永远挤不掉它，那个 legacy 目录
// 仍然对外可达。2026-09-12 实测复现（doctor 输出「已把 legacy 提到工作区列表首位」）。
// 同一处缺陷在 server 的 readWorkdirSource 与 doctor 的 resolveWorkdirSource 各有一份。
//
// 【为什么要 projectedPrimary，而不是只认 shellEnv.WORK_DIR】老式 `.env` 安装把 WORK_DIR 与
// WORK_DIRS **都**写在文件里，两者一起被投影。只认快照的话它们会双双落空，那种安装的主目录
// 会突然失效（授权面塌陷，可能一个工作区都不剩）。所以判据是「**文件给的主目录不得压过
// shell 给的列表**」，而不是「文件给的主目录一律不算」——只有来源真的分叉时才让位。
//
// 【彻底解法】让 `.env` 的 WORK_DIRS/WORK_DIR 整体走 inline 档，来源就不再需要这样反推。
// 那要改 readInlineWorkdirConfig 的读取面，牵动三个消费者，不在这次修复范围内。
export function resolveEnvPrimaryWorkdir({ shellEnv = {}, projectedPrimary = '' } = {}) {
  const fromShell = String(shellEnv.WORK_DIR ?? '').trim();
  if (fromShell) return fromShell; // shell 显式给了主目录：与 env 列表同级，照常折叠
  const listFromShell = Boolean(
    String(shellEnv.WORK_DIRS ?? '').trim() || String(shellEnv.WORK_DIRS_FILE ?? '').trim(),
  );
  // shell 拿出了列表而主目录只存在于文件里 —— 来源分叉，文件那个让位。
  return listFromShell ? '' : String(projectedPrimary ?? '').trim();
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

// CLI 托管 worktree 的容器目录（相对 workdir 根）：`EnterWorktree`、`--worktree`、agent isolation
// 三者的默认落点都是这里。枚举侧（history.js）与「树已删」的推导（下方）共用这一份，不各写一遍——
// SS-004 那次「注释写着同规则、实际各存一份」就是这么漂的。
//
// cwd 授权（子目录可达、worktree 随所属仓库）不在本文件：见 folder-access.js 的 resolveAuthorizedCwd。
// 这里原有的 ensureWhitelisted / isWhitelisted / resolveManagedWorktree / resolveDrivingCwd /
// instanceAuthorizedDirs 于 2026-09-24 随「已连接的文件夹」一起退役（server 各闸门统一改经 authorize）。
export const managedWorktreeRoot = dir => join(dir, CLAUDE_DIR_NAME, 'worktrees');

// worktree 目录被删之后的父仓推导（2026-09-13，真机会话 5a8793ca）。
//
// 【这个状态怎么来的】CLI 的 ExitWorktree 只认「本会话 EnterWorktree 建的」worktree，对 CCM 自己
// `git worktree add` 建的那批一律 no-op（原文：there is no active EnterWorktree session to exit）。
// 模型于是改用 Bash `git worktree remove` 把树删掉——目录没了，而 Bash 里的 cd 改不了会话 cwd
//（CLI 每条命令后都打一行 `Shell cwd was reset to <会话 cwd>`），CwdChanged 一次都不会触发。
// 结果是实例的驾驶轴停在一条指向已删目录的路径上，且没有任何报错。
//
// 【为什么授权判据答不了】resolveAuthorizedCwd 先 realpath 再判，悬空路径必然 fail-closed 返回 null。
// 那个 null 在四个消费点各自回落成互不相干的坏结果：文件面板报「路径不在授权范围内」、
// git 报 fatal、statusline 的 git 段整个缺席、workspaceCwdOf 回落成悬空路径自身（该实例连父仓的
// 归属都没了，抽屉里那个工作区下再也看不到它）。同一个根因，四条症状。
//
// 【为什么不 realpath，以及为什么这不违反 SCOPE-01】目标已经不存在，realpath 必然抛错——这条判据
// 存在的前提就是它解析不了。安全性不靠 realpath 兜：**返回值恒取自 dirs**（已 realpath 的白名单
// 本身），候选路径一个字节都不进返回值，没有 symlink 逃逸面。代价是前缀比较要求候选与 dirs 同规范；
// 生产路径上这条成立（instance.cwd 恒来自 createSessionWorktree 或授权判据，两者给的
// 都是 realpath 后的串），万一不成立也只是判不出、退回没有本函数时的行为——失败方向是「不自愈」
// 而不是「错放行」。只认托管形态（`<workdir>/.claude/worktrees/<单段>`）：仓库外的平级 worktree 删掉后
// 回链也跟着没了，推不出它属于哪个仓库。
//
// 路径还在时返回 null 让位给授权判据：对活着的 worktree 也回落父仓，等于让文件/改动面板永远看不到
// worktree 里的改动。
export function resolveGoneWorktreeParent(cwd, dirs) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  if (!Array.isArray(dirs) || dirs.length === 0) return null;
  for (const d of dirs) {
    const prefix = managedWorktreeRoot(d) + sep;
    if (!cwd.startsWith(prefix)) continue;
    const rest = cwd.slice(prefix.length);
    if (rest === '' || rest.includes(sep)) continue; // 深度恒为 1：只认托管 worktree 的形态
    return existsSync(cwd) ? null : d;
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
      real = realpathSync.native(path); // 与 folder-access.js 同一种 realpath：连接根与候选路径的写法必须一致
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
