// LaunchAgent 服务管理的纯逻辑层：unit 表、状态分类、语义漂移判定、manifest 形状校验。
//
// 为什么单独一层而不是全写进 scripts/service.js：doctor（D16）、web 面板、菜单栏 app 都要判
// 同一个「这个 unit 现在什么状态、归谁管、有没有漂移」，两处各写一份迟早分叉——同 cli-hooks-bridge.js
// 与其安装器的分工。本文件零 IO、零 spawn，全部输入由调用方读盘/exec 后喂进来，宿主机单测能全覆盖。
//
// **模块边界**：src/ 不得 import scripts/（check-import-boundaries.js 的 runtime-no-tooling），
// 所以这里只出「渲染需要哪些变量」（renderVarsFor），真正的 plist 渲染由 scripts/service.js
// 调 scripts/render-plist.js 完成。plutil 解析同理，留在 CLI 层。
//
// ## 漂移判定为什么不能用 sha256（2026-08-13 实测）
//
// 机主手写的 ~/Library/LaunchAgents/com.ccm.server.plist 与 deploy/server.plist.template 经
// render-plist.js 渲染的结果**字节必然不同**，两处差异：
//   ① 模板正文里 ProgramArguments 内的那条行内注释（stripLeadingComment 只剥首段，正文的保留）
//   ② 模板给路径加了双引号（TC-009 防 word-split），手写的没加
// 更要紧的是 `plutil -convert json` 归一化之后 ② 依然存在——它抹平 XML 注释与格式，抹不平
// shell 命令串**内部**的引号。所以判据必须再下一层：提取出 repo/node 的**路径值**再比。
//
// 字节 sha256 仍然有用，但只用于卸载 CAS（「这个文件还是不是我当初写下的那份」——那个问题字节
// 相等才是正确判据）。两个哈希两个用途，绝不混用。

export const MANIFEST_SCHEMA_VERSION = 1;

// 默认 label 前缀。**不是** docs/deployment.md 示例里的 com.you.ccm-：机主既有的四个 unit
// 用的就是 com.ccm.*，换前缀会一个都认不出来、adopt 直接失效。
export const DEFAULT_LABEL_PREFIX = 'com.ccm';

// 漂移原因的稳定顺序：展示与断言都依赖它，别按 Object.keys 的偶然顺序输出。
const DRIFT_ORDER = ['repo-path', 'node-path', 'log-path', 'keepalive'];

function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// 剥掉成对的外层引号——shell 语法，不是路径的一部分。这正是「手写 vs 模板渲染」的唯一实质差异。
function stripQuotes(value) {
  const t = String(value ?? '').trim();
  if (t.length >= 2) {
    const head = t[0];
    if ((head === '"' || head === "'") && t.at(-1) === head) return t.slice(1, -1);
  }
  return t;
}

// server 的 ProgramArguments 形如 ['/bin/zsh', '-lc', 'cd <repo> && exec <node> server.js']。
// 刻意按 ' && exec ' 切两半再各自剥引号，不用一个大正则：路径可能含空格，正则的非贪婪边界在
// 「无引号 + 含空格」时会切错，而这个分隔符本身是模板固定写死的，稳。
function parseServerCommand(argv) {
  if (!Array.isArray(argv) || argv.length < 3) return { repo: null, node: null };
  const cmd = str(argv[2]);
  if (!cmd) return { repo: null, node: null };
  const parts = cmd.split(' && exec ');
  if (parts.length !== 2) return { repo: null, node: null };
  const left = parts[0].trim();
  if (!left.startsWith('cd ')) return { repo: null, node: null };
  const right = parts[1].trim();
  if (!right.endsWith(' server.js')) return { repo: null, node: null };
  return {
    repo: str(stripQuotes(left.slice(3))),
    node: str(stripQuotes(right.slice(0, -' server.js'.length))),
  };
}

const ROTATE_SUFFIX = '/scripts/rotate-logs.sh';

// unit 定义表。requiredFacts 决定「形态认不认识」：全为 null ⇒ 用户整个换掉了启动方式，
// 报 shape 漂移而不是逐字段比对出一堆噪音。
const UNITS = {
  server: {
    template: 'deploy/server.plist.template',
    vars: ['LABEL', 'REPO', 'NODE', 'LOG'],
    logName: 'ccm-server.log',
    requiredFacts: ['repo', 'node'],
    runAtLoad: true,
    keepAlive: true,
    driftFields: { 'repo-path': 'repo', 'node-path': 'node', 'log-path': 'log', keepalive: 'keepAlive' },
    parse(plist) {
      return parseServerCommand(plist.ProgramArguments);
    },
  },
  tunnel: {
    template: 'deploy/tunnel.plist.template',
    vars: ['LABEL', 'CLOUDFLARED', 'TUNNEL', 'LOG'],
    logName: 'ccm-tunnel.log',
    requiredFacts: ['cloudflared', 'tunnel'],
    runAtLoad: true,
    keepAlive: true,
    // cloudflared 路径与隧道名是用户特有的，我们无从预期 ⇒ 不作为漂移维度（只用于 shape 判定）。
    driftFields: { 'log-path': 'log', keepalive: 'keepAlive' },
    parse(plist) {
      const argv = plist.ProgramArguments;
      if (!Array.isArray(argv) || argv.length < 4) return { cloudflared: null, tunnel: null };
      if (argv[1] !== 'tunnel' || argv[2] !== 'run') return { cloudflared: null, tunnel: null };
      return { cloudflared: str(argv[0]), tunnel: str(argv[3]) };
    },
  },
  logrotate: {
    template: 'deploy/log-rotate.plist.template',
    vars: ['LABEL', 'REPO', 'LOG'],
    logName: 'ccm-logrotate.log',
    requiredFacts: ['repo'],
    runAtLoad: false, // 定时器：只在 StartCalendarInterval 触发，加载时不跑
    keepAlive: false,
    driftFields: { 'repo-path': 'repo', 'log-path': 'log' },
    parse(plist) {
      const argv = plist.ProgramArguments;
      if (!Array.isArray(argv) || argv.length < 2) return { repo: null };
      const script = str(argv[1]);
      if (!script || !script.endsWith(ROTATE_SUFFIX)) return { repo: null };
      return { repo: str(stripQuotes(script.slice(0, -ROTATE_SUFFIX.length))) };
    },
  },
  menubar: {
    template: 'deploy/menubar.plist.template',
    vars: ['LABEL', 'APP', 'LOG'],
    logName: 'ccm-menubar.log',
    requiredFacts: ['app'],
    runAtLoad: true,
    // 菜单栏 app 刻意不设 KeepAlive（用户点「退出」会被 launchd 立刻拉起，是脚枪），
    // 所以它的漂移维度里也没有 keepalive。
    keepAlive: false,
    driftFields: { 'log-path': 'log' },
    parse(plist) {
      const argv = plist.ProgramArguments;
      if (!Array.isArray(argv) || argv.length < 2 || argv[0] !== '/usr/bin/open') return { app: null };
      return { app: str(stripQuotes(argv[1])) };
    },
  },
};

export const SERVICE_UNIT_NAMES = Object.freeze(Object.keys(UNITS));

export function labelFor(unit, prefix = DEFAULT_LABEL_PREFIX) {
  return `${prefix}.${unit}`;
}

// 「本进程是不是被进程管理器托管的」——即：优雅退出之后有没有东西会把它拉起来。
// 用途是给 web 端的重启按钮把关：误判成「受管」的后果是用户能停掉一个没人会拉起的前台进程。
//
// 判据是**结构性**的：launchd 托管时 plist 用 `exec node server.js`（zsh 被替换掉），
// 所以 node 的父进程直接是 launchd(1)。实测本机 server 进程 ppid 确为 1。
//
// ★ 为什么不用 XPC_SERVICE_NAME（早前那版判「非空且 !== '0'」是错的）：
// 实测扫全机 82 个进程，GUI app（LaunchServices 启动）的子进程继承的是
// `application.<bundleid>.<n>.<n>` 并原样往下传，**不会**被改写成 "0"（Chrome / 网易云 /
// codex 三个独立样本）。也就是说从 Terminal.app 手动 npm start，node 会拿到
// `application.com.apple.Terminal.*` → 被判成受管。当初那次「实测」只在 ccm server 自己
// spawn 的 shell 上取过样，而那条链恰好会被重写成 "0" —— 单点采样得出的分布结论。
// 环境变量天然可继承，本就不适合回答「我的父进程是谁」这个问题。
//
// systemd 侧只能退回环境变量：docs/deployment.md:30 推荐的是 `systemctl --user`，
// 那种形态下 ppid 是 `systemd --user` 而非 1，结构判据不适用。代价是 Linux 上若有人在
// 继承了 INVOCATION_ID 的终端里前台启动，仍会被判成受管——已知残余风险，macOS 侧不受影响。
export function isSupervised({
  ppid = typeof process !== 'undefined' ? process.ppid : 0,
  env = typeof process !== 'undefined' ? process.env : {},
  platform = typeof process !== 'undefined' ? process.platform : '',
} = {}) {
  if (ppid === 1) return true; // launchd / systemd system unit
  if (platform === 'darwin') return false; // macOS 上没有第二个可信信号，宁可拒绝
  const e = env || {};
  return ['INVOCATION_ID', 'JOURNAL_STREAM']
    .some((k) => typeof e[k] === 'string' && e[k].trim().length > 0);
}

// 该 unit 的模板相对路径。渲染在 scripts/service.js（src/ 不得 import scripts/，见头注）。
export function templateFor(unit) {
  const def = UNITS[unit];
  if (!def) throw new Error(`未知 unit: ${unit}`);
  return def.template;
}

// label → unit 名。前缀命中但不是已知 unit（机主自建的 com.ccm.tunnel-watch）返回 null——
// 调用方据此判 ownership='unknown'：可以看、可以启停，但永不 install/uninstall。
export function unitFromLabel(label, prefix = DEFAULT_LABEL_PREFIX) {
  const name = str(label);
  if (!name || !name.startsWith(`${prefix}.`)) return null;
  const rest = name.slice(prefix.length + 1);
  return Object.hasOwn(UNITS, rest) ? rest : null;
}

// `launchctl list` 的 TSV：PID \t LastExitStatus \t Label，首行表头，未运行的 PID 是 '-'。
export function parseLaunchctlList(tsv) {
  const out = new Map();
  for (const line of String(tsv ?? '').split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const label = cols[2].trim();
    if (!label || label === 'Label') continue;
    const pid = cols[0].trim();
    const exit = cols[1].trim();
    out.set(label, {
      pid: pid === '-' ? null : Number.parseInt(pid, 10),
      lastExit: exit === '-' ? null : Number.parseInt(exit, 10),
    });
  }
  return out;
}

// 生命周期状态。flapping 是**独立维度**不是第五种状态：机主的 com.ccm.tunnel 正是「有 PID
// （KeepAlive 拉起来了）+ LastExitStatus=-9（被 SIGKILL 过）」——只看 PID 会一直显绿灯，
// 而它其实在反复崩溃重启。漏掉这档，隧道挂了只能等公网报 1033 才发现。
export function classifyState({ pid = null, lastExit = null, plistExists = true } = {}) {
  if (!plistExists) return { state: 'not-installed', flapping: false };
  const crashed = typeof lastExit === 'number' && Number.isFinite(lastExit) && lastExit !== 0;
  if (pid !== null && Number.isFinite(pid)) return { state: 'running', flapping: crashed };
  return { state: crashed ? 'crashed' : 'stopped', flapping: false };
}

// plutil 解析出的 plist 对象 → 语义事实。形态对不上时相关字段为 null 而非抛错：
// 用户完全可能把启动方式换成 pm2/别的 wrapper，那属于 foreign，要能平静地报出来。
export function extractUnitFacts(unit, plist) {
  const def = UNITS[unit];
  if (!def) throw new Error(`未知 unit: ${unit}`);
  const obj = plist && typeof plist === 'object' ? plist : {};
  const log = str(obj.StandardOutPath) ?? str(obj.StandardErrorPath);
  return {
    ...def.parse(obj),
    label: str(obj.Label),
    runAtLoad: obj.RunAtLoad === true,
    keepAlive: obj.KeepAlive === true,
    log,
  };
}

// 语义漂移。**不比字节、不比 plutil 输出字符串**，只比提取出来的值——理由见文件头注。
// 返回稳定顺序的原因数组；空数组 = 语义等价（手写的与模板渲染的会走到这里）。
export function diffUnitSemantics(unit, expected, actual) {
  const def = UNITS[unit];
  if (!def) throw new Error(`未知 unit: ${unit}`);
  const exp = expected || {};
  const act = actual || {};

  // 关键事实一个都提取不出来 ⇒ 形态整个换掉了。只报 shape，不再逐字段吐一堆 null≠值 的噪音。
  if (def.requiredFacts.every((k) => act[k] == null)) return ['shape'];

  const reasons = [];
  for (const reason of DRIFT_ORDER) {
    const field = def.driftFields[reason];
    if (!field) continue;
    if (exp[field] !== act[field]) reasons.push(reason);
  }
  return reasons;
}

// 「这个 unit 装成什么样才算对」——漂移比对的左侧。刻意不去真渲染一份 plist 再 plutil 解析
// （那要两次 spawn 才拿到几个已知的值），直接按 ctx 构造。未知项（用户特有的 cloudflared 路径、
// 隧道名）留 null 并且不在 driftFields 里，不会造成假漂移。
export function expectedFactsFor(unit, ctx = {}) {
  const def = UNITS[unit];
  if (!def) throw new Error(`未知 unit: ${unit}`);
  return {
    label: labelFor(unit, ctx.labelPrefix || DEFAULT_LABEL_PREFIX),
    repo: ctx.repo ?? null,
    node: ctx.node ?? null,
    cloudflared: ctx.cloudflared ?? null,
    tunnel: ctx.tunnel ?? null,
    app: ctx.app ?? null,
    log: ctx.log || `${ctx.home}/Library/Logs/${def.logName}`,
    runAtLoad: def.runAtLoad,
    keepAlive: def.keepAlive,
  };
}

// 该 unit 渲染 plist 需要的占位符变量。真正的渲染在 scripts/service.js（边界所限，见头注）。
export function renderVarsFor(unit, ctx = {}) {
  const def = UNITS[unit];
  if (!def) throw new Error(`未知 unit: ${unit}`);
  const prefix = ctx.labelPrefix || DEFAULT_LABEL_PREFIX;
  const all = {
    LABEL: labelFor(unit, prefix),
    REPO: ctx.repo,
    NODE: ctx.node,
    CLOUDFLARED: ctx.cloudflared,
    TUNNEL: ctx.tunnel,
    APP: ctx.app,
    LOG: ctx.log || `${ctx.home}/Library/Logs/${def.logName}`,
  };
  return Object.fromEntries(def.vars.map((k) => [k, all[k]]));
}

// 归属。**这是安全护栏的核心**：只有 managed 能被 install/uninstall 写，其余最多允许 start/stop/logs。
// drift 是正交维度，不改归属——「managed 且漂移了」是常见状态（仓库移动过），要能修不能拒。
export function classifyOwnership({ knownUnit = false, inManifest = false, drift = [] } = {}) {
  if (!knownUnit) return 'unknown'; // 前缀命中但模板里没这个 unit（如 com.ccm.tunnel-watch）
  if (inManifest) return 'managed';
  // 没 manifest 记录：语义等价才敢接管。不等价 = 用户自己改过配置，只读。
  // （未安装的已知 unit 也走到这里且 drift 为空 → managed，install 才有得装。）
  return drift.length === 0 ? 'adoptable' : 'foreign';
}

function emptyManifest() {
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, labelPrefix: DEFAULT_LABEL_PREFIX, units: {} };
}

function validEntry(entry) {
  return !!entry
    && typeof entry === 'object'
    && str(entry.label)
    && str(entry.plistPath)
    && str(entry.sha256)
    && str(entry.template);
}

// manifest 读入校验。读不懂一律退化成空 manifest 而非抛错：那只会让已管理的 unit 退回
// adoptable（adopt 一下就回来），而抛错会让整个 status 挂掉——后者严重得多。
export function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyManifest();
  const prefix = str(raw.labelPrefix) || DEFAULT_LABEL_PREFIX;
  if (raw.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, labelPrefix: prefix, units: {} };
  }
  const units = {};
  const src = raw.units && typeof raw.units === 'object' ? raw.units : {};
  for (const [name, entry] of Object.entries(src)) {
    if (Object.hasOwn(UNITS, name) && validEntry(entry)) units[name] = entry;
  }
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, labelPrefix: prefix, units };
}
