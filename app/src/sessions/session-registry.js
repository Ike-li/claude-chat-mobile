// session-registry.js —— 读取 CLI 进程活体注册表 ~/.claude/sessions/<PID>.json
// 该文件由 claude CLI 自己写入（entrypoint/kind/status 等自报字段），是「这个会话此刻
// 是否有终端进程在驾驶」的权威声明——用于替代磁盘 transcript 尾部形态猜测（猜测的两个
// 已知盲区见 history.js:1008-1012）。7/26 实测：status+statusUpdatedAt 只出现在
// entrypoint=cli 的条目上（sdk-ts/sdk-cli/claude-desktop 无 status）；文件按 PID 命名、
// 非持久化，进程崩溃可能留陈尸文件，故消费前必须 pid 验活。
// 7/29 pty 实证补正两点（见 TERMINAL_BUSY_STATUSES / registryIndicatesTerminalBusy）：跑命令期间
// 自报 "shell" 而非 "busy"；statusUpdatedAt 只在取值变化时写一次、不是心跳。条目还带 ccm 目前
// 未消费的 tempo/state/detail/waitingFor/needs 字段（取值时机未实证，别凭猜接入）。
// 注册表缺失/损坏一律 fail-open 返回 null——调用方回落既有尾部形态判定，绝不因本模块锁死。
import { readdir, lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { claudeHome } from '../shared/claude-home.js';

const DEFAULT_SESSION_REGISTRY_DIR = join(claudeHome(), 'sessions');
// CLI 自报 status 的【完整】取值域，抄自 CLI 2.1.260 二进制里的枚举（下面两个集合合起来该覆盖它，
// 剩下的 idle 是明确的"不背书"档）：
//   var Ke = ["busy","shell","idle","waiting"];  function We(e){ return Ke.includes(e) ? e : void 0 }
// 写下全集是有代价换来的：前两次都是"发现一个补一个"（原本只认 busy，7/29 补 shell），每次都没去
// 把枚举读全，于是 waiting 一直漏着，直到 2026-09-04 才发现（详见 registryIndicatesTerminalWaiting）。
// 白名单判据在上游枚举扩张时是【静默】失效的——多出来的取值不报错，只让判定恒假。CLI 升级后若又
// 多出取值，先回二进制搜 `var Ke=[` 核对这一行，别再靠撞见症状去补。
//
// 「终端此刻在干活」。7/29 pty 实证（CLI 2.1.220，四轮）：跑 Bash 命令、等后台子代理期间自报的是
// "shell" 而不是 "busy"（CLI 侧 `eu==="idle" && 有 shell 活动 ? "shell" : eu`）。
// 原先只认 "busy" → 整段长命令/后台子代理窗口这条通道恒假，而那恰是主链零增长、尾部又已 settled
// 的窗口（四判据同时失效 → 手机侧误判可写）。收尾时 CLI 会主动写 idle，那才是解锁的正路。
const TERMINAL_BUSY_STATUSES = new Set(['busy', 'shell']);
// 「终端停下来等人」。与 busy 分开是刻意的：抽屉据 busy 显示"运行中"，把等审批说成运行中就是在
// 说错话；而镜像锁两者都要（都意味着终端进程持有这个会话）。CLI 自己也是这么分的——它的 fleet
// 视图把 busy/shell 归 "live"、waiting 归 "needs"。
const TERMINAL_WAITING_STATUSES = new Set(['waiting']);
// 两个 status 判定函数的默认 entrypoint 白名单。默认收窄到 cli 是刻意的，理由见函数处注释。
const CLI_ONLY_ENTRYPOINTS = new Set(['cli']);
// 实测条目 ~300 字节；16KB 已是量级余量，超出视为异常文件跳过。
const MAX_REGISTRY_FILE_BYTES = 16 * 1024;

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但无权限发信号（不同 uid）——仍算活着
    return error?.code === 'EPERM';
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// 扫描注册表目录，返回结构合法的条目数组（不判存活、不判归属）。任何 IO/解析失败按"该条目不存在"
// 跳过，整体 fail-open 返回已读到的部分——注册表是加分信号，绝不能因它读不动而影响主流程。
async function readAllEntries(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    let entry;
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_REGISTRY_FILE_BYTES) continue;
      entry = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (!Number.isInteger(entry.pid) || entry.pid <= 0) continue;
    if (!nonEmptyString(entry.sessionId) || !nonEmptyString(entry.cwd) || !nonEmptyString(entry.entrypoint)) continue;
    out.push(entry);
  }
  return out;
}

// 返回匹配 sessionId+cwd 且 pid 存活的最佳条目；无命中/任何 IO 失败 → null。
// 同一 sessionId 可能挂多个 PID（7/26 实测 sdk-ts 与 cli 并存）——优先 entrypoint=cli
// （只有它带 status 自报），同级取 statusUpdatedAt/startedAt 较新者。
export async function readSessionRegistry(sessionId, cwd, {
  dir = DEFAULT_SESSION_REGISTRY_DIR,
  isAlive = defaultIsAlive,
} = {}) {
  if (!nonEmptyString(sessionId) || !nonEmptyString(cwd)) return null;
  const wantCwd = resolve(cwd);
  let best = null;
  for (const entry of await readAllEntries(dir)) {
    if (entry.sessionId !== sessionId) continue;
    if (resolve(entry.cwd) !== wantCwd) continue;
    if (!isAlive(entry.pid)) continue;
    const candidate = {
      pid: entry.pid,
      entrypoint: entry.entrypoint,
      kind: nonEmptyString(entry.kind) ?? undefined,
      status: nonEmptyString(entry.status) ?? undefined,
      statusUpdatedAt: Number.isFinite(entry.statusUpdatedAt) ? entry.statusUpdatedAt : undefined,
      version: nonEmptyString(entry.version) ?? undefined,
    };
    if (!best) { best = { candidate, startedAt: entry.startedAt }; continue; }
    const bestIsCli = best.candidate.entrypoint === 'cli';
    const candIsCli = candidate.entrypoint === 'cli';
    if (candIsCli !== bestIsCli) {
      if (candIsCli) best = { candidate, startedAt: entry.startedAt };
      continue;
    }
    const bestTs = best.candidate.statusUpdatedAt ?? best.startedAt ?? 0;
    const candTs = candidate.statusUpdatedAt ?? entry.startedAt ?? 0;
    if (candTs > bestTs) best = { candidate, startedAt: entry.startedAt };
  }
  return best ? best.candidate : null;
}

// 找出会让 CLI 拒绝 `--resume <sessionId>` 的活占用者；无则 null。
//
// 判据逐条对齐 CLI 2.1.220 内部的 resume 前置检查（`_Pe`，实测自二进制）：
//   listAllLiveSessions() 中 sessionId 相同 && pid 非自己 && kind 存在 && kind !== 'interactive'
// 命中时 CLI 直接报错退出：
//   Error: Session <id> is currently running as a background agent (<kind>).
//   Use `claude agents` to find and attach to it, or add --fork-session to branch off a copy.
//
// 三个判据细节都是有意为之，别"顺手优化"：
//   · 不按 cwd 过滤——CLI 侧扫的是全量注册表，sessionId 本就是全局唯一 uuid；这里筛 cwd 会漏判，
//     放行后 spawn 出的进程照样被 CLI 拒，白付一次启动开销还拿不到结构化原因。
//   · kind !== 'interactive' 而非 kind === 'background'——同一个进程在 `claude agents --json` 里
//     报 'background'、在本注册表里报 'bg'，只认 'background' 会漏掉真正的占用者。
//   · 返回首个命中即可：调用方只需要"是否被占用 + 谁占的"来生成引导文案，不做仲裁。
export async function findBlockingLiveAgent(sessionId, {
  dir = DEFAULT_SESSION_REGISTRY_DIR,
  isAlive = defaultIsAlive,
} = {}) {
  if (!nonEmptyString(sessionId)) return null;
  for (const entry of await readAllEntries(dir)) {
    if (entry.sessionId !== sessionId) continue;
    const kind = nonEmptyString(entry.kind);
    if (!kind || kind === 'interactive') continue;
    if (!isAlive(entry.pid)) continue;
    return {
      pid: entry.pid,
      kind,
      jobId: nonEmptyString(entry.jobId) ?? undefined,
      name: nonEmptyString(entry.name) ?? undefined,
    };
  }
  return null;
}

// 会话列表标注用的归键（cwd 归一化 + sessionId）——列表侧一次扫盘拿全量，避免每行一次 readdir。
// 
// 分隔符用 NUL：路径与 uuid 里都不可能出现它，拼 key 不会撞。**但必须写成 \u0000 转义**，
// 不能把裸 0x00 字节留在源文件里 —— 那会让 file(1) 判定整个文件为 `data`，BSD grep 随之
// 把它当二进制**静默跳过**（连 "Binary file matches" 都不打）。后果是这个文件对所有基于
// grep 的扫描一律隐形：check 里的 i18n 孤儿 key、禁止模式、破坏性删除守卫全都扫不到它。
// 2026-08-27 实测：手工 grep `'.claude'` 全仓返回「只剩 claude-home.js」，而这个文件里明明
// 还有一处 —— 是 tests/unit/single-source-of-truth.test.mjs 用 readFileSync 扫出来的。
// 转义写法的运行时值与裸字节完全相同，纯粹是把源文件变回 grep 看得见的纯文本。
export function terminalStateKey(cwd, sessionId) {
  return `${resolve(String(cwd ?? ''))}\u0000${String(sessionId ?? '')}`;
}

// 会话行上 terminal / terminalSource 字段的取值域。**这是 Map → 会话行的最后一米**：只加
// listTerminalSessionStates 的新状态而漏了这里，新状态会在注入面被静默丢掉（2026-09-04 加
// 'waiting' 时的现成陷阱）。来源同理——漏登记会让桌面端会话退回"终端"文案，且没有任何报错。
const TERMINAL_ROW_STATES = new Set(['busy', 'waiting', 'alive']);
const TERMINAL_ROW_SOURCES = new Set(['cli', 'claude-desktop']);

// 给 session:list 行附加当前终端状态与来源。listSessionsPage 可能返回缓存对象，禁止原地写：
// 每行浅拷贝并先清旧值，再按本次 registry 快照注入，确保状态消失后不会残留。
export function applyTerminalStatesToSessions(cwd, sessions, states = new Map()) {
  const rows = Array.isArray(sessions) ? sessions : [];
  const stateMap = states instanceof Map ? states : new Map();
  return rows.map(session => {
    if (!session || typeof session !== 'object') return session;
    const copy = { ...session };
    delete copy.terminal;
    delete copy.terminalSource;
    if (copy.id) {
      const info = stateMap.get(terminalStateKey(cwd, copy.id));
      if (info && TERMINAL_ROW_STATES.has(info.state)) {
        copy.terminal = info.state;
        // 来源缺失/未登记时只留状态：前端回落"终端"文案（与本改动之前完全同形），不塌成无状态。
        if (TERMINAL_ROW_SOURCES.has(info.source)) copy.terminalSource = info.source;
      }
    }
    return copy;
  });
}

// session:list 可能分页，只看返回行会漏掉页外的 busy CLI；目录/顶部汇总改从完整 registry Map 判 cwd。
function hasTerminalStateForCwd(cwd, states, want) {
  if (!(states instanceof Map)) return false;
  const prefix = terminalStateKey(cwd, '');
  for (const [key, info] of states) {
    if (info?.state === want && key.startsWith(prefix)) return true;
  }
  return false;
}

export function hasBusyTerminalSessionForCwd(cwd, states) {
  return hasTerminalStateForCwd(cwd, states, 'busy');
}

// 目录级的 waiting 汇总（2026-09-04）。抽屉折叠时用户只看得到目录行，会话行的 chip 再准也看不见。
// 与 busy 并列成两个判据而不是合成一个三态：同一 cwd 下完全可能一个会话在跑、另一个卡在审批上。
export function hasWaitingTerminalSessionForCwd(cwd, states) {
  return hasTerminalStateForCwd(cwd, states, 'waiting');
}

// 参与会话列表「外部驾驶员在驾驶」标注的 entrypoint，以及各自的状态取数方式：
//   cli            —— 自报 status（busy/shell/idle/waiting），权威且与回合长度无关。
//   claude-desktop —— 桌面端 Code 模式。Claude.app 拉起【同一份 claude 二进制】（自带副本
//                     ~/Library/Application Support/Claude/claude-code/<ver>/），用
//                     --input-format stream-json headless 驱动、自己画 UI 与权限框；transcript
//                     每行自报 entrypoint='claude-desktop'。2026-09-06 实测（2.1.260）：它写活体
//                     条目、进程退出照样删文件，但【从不写 status】——所以"在不在跑"拿不到自报，
//                     只能回落磁盘尾部形态（classifyTail）。此前它和 sdk 系一起被排除，后果是
//                     桌面端会话在列表里【没有任何运行标识】，只剩一个未读点（未读走 transcript
//                     增长那条轴，与 entrypoint 无关，所以照常工作）。
// 仍然排除 sdk-ts/sdk-cli：那是 ccm 自己或别的 SDK 工具驱动的，列表里已有 live 实例徽标，标了会双份。
const TERMINAL_ENTRYPOINTS = new Set(['cli', 'claude-desktop']);

// 批量：返回 Map<terminalStateKey, { state, source }>，只收 TERMINAL_ENTRYPOINTS 且 pid 存活的条目。
//   'busy'    = 在跑。cli 看自报 busy/shell；桌面端无自报 → 看尾部形态 pending
//   'waiting' = 自报 waiting（终端卡在对话框上等人，含权限审批框）—— 2026-09-04 新增，此前被折进
//               alive，于是抽屉里「CLI 正等你批准」与「终端开着但闲着」完全同形。
//               桌面端拿不到这一档（无 status），它的等审批状态在列表上与 alive 同形。
//   'alive'   = 进程活着但不在跑（cli 自报 idle / 无自报；桌面端尾部 settled）
// source = 该状态的来源 entrypoint，只用于选文案（把桌面端说成"终端"是在说错话）。
// 状态轴与来源轴刻意保持正交：合成一个枚举（desktop_busy…）会让取值域随来源×状态爆炸，
// 且 hasBusyTerminalSessionForCwd 这类汇总判据每加一个来源都要改一次。
const TERMINAL_STATE_RANK = { busy: 3, waiting: 2, alive: 1 };
export async function listTerminalSessionStates({
  dir = DEFAULT_SESSION_REGISTRY_DIR,
  isAlive = defaultIsAlive,
  classifyTail = null,
} = {}) {
  const map = new Map();
  // 同会话多 PID：按信息量取高者（busy > waiting > alive），与扫盘顺序无关。
  // 原实现是 `if (busy) set; else if (!has) set('alive')`——两态时等价，加了第三态就会漏
  // （先扫到 waiting 后扫到 alive 时，has 已为真，waiting 侥幸留住；反过来则 alive 永远压不掉，
  //  但 waiting 也永远盖不住先到的 alive）。改成显式排名，把顺序依赖彻底去掉。
  const merge = (key, state, source) => {
    const prev = map.get(key);
    if (prev === undefined || TERMINAL_STATE_RANK[state] > TERMINAL_STATE_RANK[prev.state]) {
      map.set(key, { state, source });
    }
  };
  const pendingTail = [];
  for (const entry of await readAllEntries(dir)) {
    if (!TERMINAL_ENTRYPOINTS.has(entry.entrypoint)) continue;
    if (!isAlive(entry.pid)) continue;
    const key = terminalStateKey(entry.cwd, entry.sessionId);
    const opts = { entrypoints: TERMINAL_ENTRYPOINTS };
    const state = registryIndicatesTerminalBusy(entry, opts) ? 'busy'
      : registryIndicatesTerminalWaiting(entry, opts) ? 'waiting'
        : 'alive';
    // 注册表不背书（无 status 自报）且调用方给了磁盘判据 → 回落尾部形态补判 busy。
    // 条件写成 `!entry.status` 而不是 `entrypoint === 'claude-desktop'`：上游哪天给桌面端补上
    // status，自报立刻【压过】磁盘推断（自报更权威，也更省一次读盘），无需再改这里。
    if (state === 'alive' && !nonEmptyString(entry.status) && typeof classifyTail === 'function') {
      pendingTail.push({ key, entry });
      continue;
    }
    merge(key, state, entry.entrypoint);
  }
  // 并发补判。fail-open 到 'alive'：读不动磁盘时只说"进程开着"，绝不谎报"在跑"——
  // 误报运行中会让列表长期挂着假状态（陈尸尾部实测就有，见 tests/unit/session-registry.test.mjs）。
  await Promise.all(pendingTail.map(async ({ key, entry }) => {
    let pending = false;
    try {
      const tail = await classifyTail(entry.sessionId, entry.cwd);
      pending = tail?.verdict === 'pending';
    } catch { /* fail-open */ }
    merge(key, pending ? 'busy' : 'alive', entry.entrypoint);
  }));
  return map;
}

// 负证据状态机（2026-07-28 真机 b06fb05d：杀 CLI 后 web 排队续接干等 5 分钟）：被杀的进程留不下
// 遗言，但它的注册表条目会消失（正常退出删文件；强杀留陈尸但 pid 验活过不了）——「曾观测到
// entrypoint=cli 的活条目 → 现在没有了」因此是终端已死/已退的强信号，比 5 分钟零写入阈值快得多。
// 调用方按 (cwd, sessionId) 持 seen 槽、逐 tick 喂 readSessionRegistry 结果；vanished 交给
// mirrorStaleFlag 立即判 stale。只看 entrypoint=cli：sdk 系条目是 ccm 自己的实例，生灭无关终端。
export function cliPresenceStep(prevSeen, entry) {
  const nowCli = !!entry && entry.entrypoint === 'cli';
  return { seen: prevSeen === true || nowCli, vanished: prevSeen === true && !nowCli };
}

// 纯判定：注册表条目是否构成「终端正在驾驶」的权威信号。
// 仅 entrypoint=cli 且 status ∈ TERMINAL_BUSY_STATUSES 时为 true；其余（含条目缺失、sdk 系
// 条目、idle）一律 false——false 不代表"没在跑"，只代表"注册表不背书，回落尾部判定"。
// 【为什么不再校验 statusUpdatedAt 新鲜度】7/29 实证推翻了原假设「busy 时 CLI 以秒级节奏刷新
// statusUpdatedAt」：CLI 只在 status【值变化】时写一次（源码 useEffect 依赖数组仅 [status,
// waitingFor]），跑 sleep 75 期间 age 从 0.7s 单调涨到 72s 从不复位。原 30s 窗因此把任何超过
// 30 秒的回合判成"自报过期"，让这条本该最权威的通道对长回合恒假。现依赖「pid 存活（调用方
// readSessionRegistry / listTerminalSessionStates 已验）+ 白名单取值」：CLI 收尾一定写 idle，
// 所以陈旧的 busy/shell 可信；进程崩溃留下的陈尸条目由 pid 验活挡掉。代价是 CLI 进程真挂起
// （活着但状态机停摆）时会持续锁住手机侧——那种情况下锁着本就更安全（防两端并发写分叉），且
// mirrorStaleFlag 的「超 5 分钟无写入 → 可立即接管」文案 + 手动接管仍是出口。
// entrypoints（2026-09-06）：默认只认 cli，**镜像锁侧一律用默认值**——那条路上的 registryBusy
// 有"无视尾部形态直接上锁"的特权（见 mirrorEntryLock），放宽它等于改动 SESSION-01 的判据面，
// 得单独论证，不能顺着列表标注的需要一起放。列表侧显式传 TERMINAL_ENTRYPOINTS 拿放宽语义。
// 判据本体（status 白名单）仍然只有这一份，不因来源分叉。
export function registryIndicatesTerminalBusy(entry, { entrypoints = CLI_ONLY_ENTRYPOINTS } = {}) {
  if (!entry || !entrypoints.has(entry.entrypoint)) return false;
  return TERMINAL_BUSY_STATUSES.has(entry.status);
}

// 纯判定：注册表条目是否构成「终端停下来等人」。仅 entrypoint=cli 且 status==='waiting'。
//
// 【waiting 是什么】CLI 侧任何对话框打开都会写它（二进制 zHe/dRo：`topDialogWaitingFor !== undefined
// → {status:"waiting", waitingFor:H}`），其中就包括**权限审批框**——审批框在 CLI 的 dialog 注册表里
// 没有登记显式 waitingFor，走的是兜底字面量 `ib[kind]?.waitingFor ?? "permission prompt"`。
// pty 实证（CLI 2.1.260）：打开 /model 对话框后条目变成 status:"waiting" + waitingFor:"dialog open"。
//
// 【为什么不并进 registryIndicatesTerminalBusy】两件事，两个词：
//   · busy/shell = 终端在跑 ⇒ 可以无中生有地上锁（堵"开跑但首条 text 未落盘"的空窗）；
//   · waiting    = 终端在等人 ⇒ 只做三件事：豁免陈旧检查、维持已有的锁、压制"疑似中断"文案。
// 给 waiting 同等的造锁权会把「电脑上开着 /model 对话框忘了关」变成手机永久只读——那不是防分叉，
// 是自伤。三项作用都限定在"轮次确实卡在中间"（尾部 pending）这个前提上，见 history.js 的三个判定。
export function registryIndicatesTerminalWaiting(entry, { entrypoints = CLI_ONLY_ENTRYPOINTS } = {}) {
  if (!entry || !entrypoints.has(entry.entrypoint)) return false;
  return TERMINAL_WAITING_STATUSES.has(entry.status);
}
