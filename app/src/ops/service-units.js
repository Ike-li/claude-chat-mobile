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
// 机主手写的 ~/Library/LaunchAgents/com.ccm.server.plist 与 desktop/launchd/server.plist.template 经
// render-plist.js 渲染的结果**字节必然不同**，两处差异：
//   ① 模板正文里 ProgramArguments 内的那条行内注释（stripLeadingComment 只剥首段，正文的保留）
//   ② 模板给路径加了双引号（TC-009 防 word-split），手写的没加
// 更要紧的是 `plutil -convert json` 归一化之后 ② 依然存在——它抹平 XML 注释与格式，抹不平
// shell 命令串**内部**的引号。所以判据必须再下一层：提取出 repo/node 的**路径值**再比。
//
// 字节 sha256 仍然有用，但只用于卸载 CAS（「这个文件还是不是我当初写下的那份」——那个问题字节
// 相等才是正确判据）。两个哈希两个用途，绝不混用。

const MANIFEST_SCHEMA_VERSION = 1;

// 默认 label 前缀。机主既有的四个手工装 unit 用的就是 com.ccm.*，换前缀会一个都认不出来、
// adopt 直接失效。
//
// 2026-08-16 前各 plist 模板（时称 deploy/，今 desktop/launchd/）与 docs/deployment.md 的示例写的是 com.you.ccm-，
// 照抄的人会装出一个**工具完全看不见**的 unit（前缀不命中连 unknown 都算不上），
// 两条路都装就是两个 LaunchAgent 抢同一个端口。现已统一到本前缀。
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

// server 的 ProgramArguments 形如 ['/bin/zsh', '-lc', 'cd <repo> && exec <node> app/server.js']。
// 后缀必须与 desktop/launchd/server.plist.template 逐字一致——运行时入口移进 app/ 后两边一起改，
// 漏改这里会让 repo/node 恒解析成 null（服务面板显示不出归属，且无任何报错）。
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
  if (!right.endsWith(' app/server.js')) return { repo: null, node: null };
  return {
    repo: str(unescapeShellDq(stripQuotes(left.slice(3)))),
    node: str(unescapeShellDq(stripQuotes(right.slice(0, -' app/server.js'.length)))),
  };
}

// 与 scripts/render-plist.js 的 escapeShellDq 互为逆。
//
// ★ 必须成对：渲染侧给 `$` / 反引号 / `\` / `"` 加了反斜杠（否则 zsh 会在双引号里展开它们，
// 路径含 `$` 时会静默 cd 到别处、KeepAlive 把 node 起不来变成无限重启循环），而这里只
// stripQuotes 不反转义的话，解析出来的 repo 比期望值多几个反斜杠 → diffUnitSemantics 判
// repo-path 漂移 → doctor D16 恒亮 warn。恰恰是这个改动要服务的那批用户换来一个新毛病。
//
// 对不含反斜杠的普通路径（含机主手写的那些 plist）是恒等的，所以既有安装不受影响。
function unescapeShellDq(value) {
  return String(value ?? '').replace(/\\([\\$`"])/g, '$1');
}

const ROTATE_SUFFIX = '/scripts/rotate-logs.sh';

// unit 定义表。requiredFacts 决定「形态认不认识」：全为 null ⇒ 用户整个换掉了启动方式，
// 报 shape 漂移而不是逐字段比对出一堆噪音。
const UNITS = {
  server: {
    template: 'desktop/launchd/server.plist.template',
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
    template: 'desktop/launchd/tunnel.plist.template',
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
    template: 'desktop/launchd/log-rotate.plist.template',
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
    template: 'desktop/launchd/menubar.plist.template',
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

// unit → 默认日志文件名。给卸载器的 --purge 用：日志路径必须从这张代码内字面量表派生，
// 不能信 manifest 里存的 LOG（磁盘 JSON 可被改指向任意文件，同 service.js 卸载不信 plistPath 的理由）。
export const SERVICE_UNIT_LOG_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(UNITS).map(([unit, def]) => [unit, def.logName]))
);

export function labelFor(unit, prefix = DEFAULT_LABEL_PREFIX) {
  return `${prefix}.${unit}`;
}

// 「本进程是不是被进程管理器托管的」——即：优雅退出之后有没有东西会把它拉起来。
// 用途是给 web 端的重启按钮把关：误判成「受管」的后果是用户能停掉一个没人会拉起的前台进程。
//
// ## macOS：结构 + 形态，两个条件都要
//
// 这两条单独用都被实测推翻过：
//   ① 只看 `XPC_SERVICE_NAME` 非空 —— GUI app（LaunchServices 启动）的子进程继承的是
//      `application.<bundleid>.<n>.<n>` 并原样往下传（Chrome / 网易云 / codex 三个独立样本），
//      于是从 Terminal.app 手动 npm start 会被判成受管。
//   ② 只看 `ppid === 1` —— 孤儿进程（`nohup` / `disown` / 关掉启动它的终端）被 init 收养后
//      ppid 同样是 1，实测确认，而它根本没人拉起。
//
// 合起来才成立：launchd 托管时 plist 用 `exec node server.js`（zsh 被替换掉）⇒ 父进程直接是
// launchd(1)，**且** XPC 标签是一个真实的 service 名（`com.ccm.server`）；孤儿进程虽然 ppid 也
// 是 1，但 XPC 继承自当初那个终端（`application.*` 或 `0`），形态对不上。
//
// ## Linux：完全不看 ppid
//
// 容器里 ppid 常常是 1（入口是 shell wrapper 时 node 的父进程就是 PID 1），实测
// `docker run --entrypoint sh -c 'node …'` → ppid=1。所以 Linux 侧只认 systemd 自己注入的
// 信号 —— 本仓不提供 systemd unit（headless 就是终端里 npm start），但**用户自建的保活**
// 要认得出来：认不出就会对一台真会被拉起的实例拒绝 web 端重启。
// 残余风险：由 systemd user unit 拉起的桌面终端会继承 INVOCATION_ID，那种环境下前台启动仍会误判。
export function isSupervised({
  ppid = typeof process !== 'undefined' ? process.ppid : 0,
  env = typeof process !== 'undefined' ? process.env : {},
  platform = typeof process !== 'undefined' ? process.platform : '',
} = {}) {
  const e = env || {};
  if (platform === 'darwin') {
    if (ppid !== 1) return false;
    const xpc = typeof e.XPC_SERVICE_NAME === 'string' ? e.XPC_SERVICE_NAME.trim() : '';
    return !!xpc && xpc !== '0' && !xpc.startsWith('application.');
  }
  return ['INVOCATION_ID', 'JOURNAL_STREAM']
    .some((k) => typeof e[k] === 'string' && e[k].trim().length > 0);
}

// 「dev:restart 退出后，有人会把进程拉起来吗」——重启入口的放行判据必须对准这个事实本身，
// 而不是「操作者是不是开发者」（DEV_MODE）。2026-08-19 真机实测过反例：DEV_MODE=1 +
// 前台 npm start 时从手机点「立即重启」，进程退出后无人拉起、前端已乐观提示成功——假成功真死亡。
// 拉起者只有两种：进程管理器托管（isSupervised），或 npm run dev 的 node --watch。
// watch 无法从子进程自证（--watch 被 node 消费掉、execArgv 是空数组，见 src/server/http.js
// 的实测注），所以认 npm 的 lifecycle 事件名；绕过 npm 直接 `node --watch server.js` 的场景
// 识别不了，代价是那种用法下按钮不出现——宁可少给入口，不给会死的入口。
export function willBeRespawned({
  supervised = isSupervised(),
  npmLifecycleEvent = typeof process !== 'undefined' ? process.env.npm_lifecycle_event : '',
} = {}) {
  return supervised || npmLifecycleEvent === 'dev';
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

// 生命周期状态。
//
// ★ 这里**不再产出 flapping**。早前的版本用「最后一次退出码 ≠ 0」判它，而那是个瞬时值：
// 机主的 com.ccm.tunnel 恒为 -9，因为自建看门狗 com.ccm.tunnel-watch 每 30s 检测 en0 的
// DHCP 漂移、发现变了就 `launchctl kickstart -k`（-k 先 SIGKILL）。路由器每天换一次 IP，
// 于是这个「异常退出」每天都在 —— 用瞬时值判 flapping 等于每天误报一次。
// 恒亮的告警比没有告警更糟：它会训练用户忽略图标，真出事那天也不会多看一眼
// （与 doctor D4 那个「端口被自家服务占用判 fail」的恒红是同一类错误）。
// flapping 现在由 src/ops/service-events.js 按**重启频率**判定（1 小时内 ≥3 次）。
//
// lastExitAbnormal 仍然保留：那是「上次是不是非正常退出」这个事实本身，UI 可以展示，
// 只是不再单独拿它下告警结论。
// loaded：launchd 域里还有没有这个 job（launchctl list 是否列出该 label）。null = 调用方没给。
// 它与 plistExists 是**两件独立的事**：plist 躺在磁盘上、但已被 bootout，定时器就永远不会再触发。
// plistExists     ：plist **能不能解析**（readPlistFile 返回了对象）
// plistFileExists ：plist **文件在不在**（fileExists）。null = 调用方没给，回落旧行为。
//
// ★★ 这两个必须分开。readPlistFile 在「文件不存在」「plutil 非零退出」「plutil 5s 超时」
// 三种情况下**都返回 null**，而它们的正确结论完全不同：
//   · 文件真没了（git clean / 手滑）：开机自启已经死了。进程还在只是上次启动的残留，重启后
//     就没了 —— 必须现在就报出来。曾经有一版让 pid 压过一切，于是 doctor D16 从 warn 变 ok，
//     菜单栏还把「在终端里安装…」换成三个点了必然报错的按钮（guardControllable 仍要求
//     plist 在盘上）。那正是 1158e7a 修的那类「三条自查路径全看不见」的盲区。
//   · 文件在、只是 plutil 抽风：那是读取故障。有 pid 就是在跑，不能说成「未安装」——
//     否则 doctor D4 会因 resolveServicePortOwner 要求 state==='running' 而把自家端口
//     报成被外来进程占用。
export function classifyState({ pid = null, lastExit = null, plistExists = true, plistFileExists = null, loaded = null } = {}) {
  const abnormal = typeof lastExit === 'number' && Number.isFinite(lastExit) && lastExit !== 0;
  // 没给 plistFileExists 时按旧语义走：解析不出来就当没装。不静默改判老调用方。
  const fileGone = plistFileExists === null ? !plistExists : !plistFileExists;
  if (fileGone) return { state: 'not-installed', lastExitAbnormal: false, loaded };
  if (pid !== null && Number.isFinite(pid)) return { state: 'running', lastExitAbnormal: abnormal, loaded };
  return { state: abnormal ? 'crashed' : 'stopped', lastExitAbnormal: abnormal, loaded };
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

// 调度形态：这个 unit **期望常驻吗**。判据全在 plist 里，不查 UNITS 表 ——
// 最需要这个判断的恰恰是表里没有的 unit（机主自建的 com.ccm.tunnel-watch 每 30s 救一次隧道，
// 面板却照 launchd 的说法标「已停止」，机主本人因此来问过「这个要启用吗」）。
//
// launchd 的 stopped 只说「此刻没有进程」，而那对三类 unit 含义相反：
//   resident  KeepAlive → stopped 是**故障**
//   periodic  StartInterval / StartCalendarInterval → stopped 是**健康待机**（99% 的时间都该如此）
//   on-demand RunAtLoad 打火即退 → 同上
// 拿名字表去分这三类必然漏掉自建 unit；plist 里本来就写着，读它就行。
export function extractSchedule(plist) {
  const obj = plist && typeof plist === 'object' ? plist : {};
  // KeepAlive 可以是 true，也可以是 {SuccessfulExit:false} 这类字典——两种都是「保持它活着」。
  // **必须优先于 StartInterval**：两者同写时 launchd 按 KeepAlive 保活，把真故障说成待机最危险。
  if (obj.KeepAlive === true || (obj.KeepAlive && typeof obj.KeepAlive === 'object')) return { kind: 'resident' };
  if (Number.isFinite(obj.StartInterval) && obj.StartInterval > 0) {
    return { kind: 'periodic', everySeconds: obj.StartInterval };
  }
  if (obj.StartCalendarInterval && typeof obj.StartCalendarInterval === 'object') {
    return { kind: 'periodic', calendar: obj.StartCalendarInterval };
  }
  if (obj.RunAtLoad === true) return { kind: 'on-demand' };
  return { kind: 'unknown' };
}

// 待机说明。**从事实算，不写死时刻**：硬编码「每天 03:47」在模板改了之后不会跟着变，
// 而这类文案的读者恰恰拿它当真相。resident / unknown 返回 null —— 它们的 stopped 没有
// 「待机」这个说法，硬给一个等于把故障粉饰成正常。
export function describeSchedule(schedule) {
  const s = schedule && typeof schedule === 'object' ? schedule : {};
  if (s.kind === 'on-demand') return '随登录自启';
  if (s.kind !== 'periodic') return null;
  if (Number.isFinite(s.everySeconds)) {
    return s.everySeconds >= 60
      ? `待机 · 每 ${Math.round(s.everySeconds / 60)} 分钟触发`
      : `待机 · 每 ${s.everySeconds} 秒触发`;
  }
  const cal = s.calendar || {};
  const pad = (n) => String(n).padStart(2, '0');
  // 只给 Minute 不给 Hour 是 launchd 的「每小时第 N 分」，别补一个没写的小时进去。
  if (Number.isFinite(cal.Hour)) return `待机 · 每天 ${pad(cal.Hour)}:${pad(cal.Minute ?? 0)}`;
  if (Number.isFinite(cal.Minute)) return `待机 · 每小时第 ${cal.Minute} 分`;
  return '待机 · 定时触发';
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
