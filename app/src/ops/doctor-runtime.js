// doctor-runtime.js —— UI 安全体检（④）的运行时编排：读合并白名单 + 6 项检查 + 脱敏聚合。
// server 的 doctor:run 事件调 runDoctor(ctx)，ctx 由 server 喂（env + 已在内存的 workDirs/版本/pushEnabled/设备数）。
// 脱敏原则：绝不回显明文 token / 绝对路径 / AUD / 密钥——只出布尔、计数、以及危险白名单规则串（用户须据此收紧）。
import { readFileSync, existsSync, accessSync, constants, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { isOwnerOnly, resolveExecutableViaPath } from '../files/file-security.js';
import { ALL_CONFIG_KEYS } from './config-file.js';
import { resolveBindPlan } from '../shared/bind-host.js';
import { ACCESS_PROFILES } from './env-schema.js';
import { parseProcNetTcpListeners, statuslineConfigDiagnostic, authTokenDiagnostic, claudeBinDiagnostic, summarizeDangerous, computeReadiness, classifyDeviceGateTopology, deviceApprovalScopeDiagnostic, modelSettingsConflictDiagnostic, envOverrideDiagnostic, fileEditExposureDiagnostic, accessProfileDiagnostic, bindDiagnostic, tailscaleDiagnostic, workdirBreadthDiagnostic } from './doctor-checks.js';
import { claudeHome, claudeSettingsPath } from '../shared/claude-home.js';
import { childEnv } from '../shared/child-env.js';
import { findWorktreeOwner, resolveAuthorizedCwd } from '../sessions/folder-access.js';

// 「已连接的文件夹」布局的取数（判定在 doctor-checks 的 connectedFoldersDiagnostic）。要读盘，所以住这里。
//   redundantWorktrees：WORKDIRS 里落在 git linked worktree 中、拿掉它之后仍被授权的条目。判据直接问
//     resolveAuthorizedCwd，不另写一套会漂移的规则——所属仓库没连时这一条是必需的，不能劝删。
//   scratch：scratch 根向上第一个带 .git 的祖先；可写性看它自己，还没建时看最近的已存在祖先（server 会 mkdir -p）。
export function probeConnectedFolders({ dirs = [], scratchRoot } = {}) {
  const real = (dirs || []).map(d => { try { return realpathSync.native(d); } catch { return null; } }).filter(Boolean);
  const redundantWorktrees = [];
  for (const dir of real) {
    if (!findWorktreeOwner(dir)) continue;
    const auth = resolveAuthorizedCwd(dir, { connected: real.filter(d => d !== dir), scratchRoot });
    if (auth) redundantWorktrees.push({ path: dir, repo: auth.projectKey });
  }
  let repoRoot = null;
  let existing = null;
  for (let dir = scratchRoot; dir;) {
    if (!existing && existsSync(dir)) existing = dir;
    if (existsSync(join(dir, '.git'))) { repoRoot = dir; break; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  let writable = false;
  try { if (existing) { accessSync(existing, constants.W_OK); writable = true; } } catch { /* 不可写 */ }
  return { redundantWorktrees, scratch: { root: scratchRoot, repoRoot, writable } };
}

// claude CLI 的实时探测。**有副作用**（which + 跑一次 --version），所以不在 doctor-checks.js 里
// —— 那一层是纯判定。判定用 claudeBinDiagnostic(probeClaudeBin())，CLI 与 web 两个 doctor 同一对。
//
// 住在 src/ops 而不是 scripts/doctor.js：server 也要调它，而运行时代码禁止 import scripts/（边界闸）。
//
// execFileSync 传 argv 数组，不拼 shell 字符串：路径含空格/引号/`$(...)` 时前者由系统保证边界，
// 后者要靠手写转义（本仓已经为这类拼装出过命令注入，见 service-units 的 plist 渲染注释）。
export function probeClaudeBin({ env = process.env } = {}) {
  const explicit = env.CLAUDE_BIN || '';
  const resolvedPath = explicit ? '' : resolveExecutableViaPath('claude'); // POSIX which / win32 where
  const path = explicit || resolvedPath;
  if (!path) return { explicit, resolvedPath };
  if (!existsSync(path)) return { explicit, resolvedPath, exists: false };
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return { explicit, resolvedPath, exists: true, executable: false };
  }
  try {
    // env 走 childEnv：与 SDK 会话是同一个二进制，同样拿不到 CCM 自己的控制面密钥（AUTH-06）。
    const version = String(execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 3000, env: childEnv(env) })).trim();
    return { explicit, resolvedPath, exists: true, executable: true, version };
  } catch (err) {
    return { explicit, resolvedPath, exists: true, executable: true, versionError: err.message };
  }
}

// Tailscale 的实时探测（2026-09-06）。与 probeClaudeBin 同一形态：有副作用（which + 跑一次
// `tailscale status --json`），所以不在 doctor-checks.js；判定用 tailscaleDiagnostic(probeTailscale())，
// CLI 与 web 两个 doctor 同一对。产品对 Tailscale 只探测、指路——不装、不起、不保活（hard-rules §1）。
// macOS 上官方 .app 版的 CLI 不在 PATH（藏在 bundle 里），launchd 拉起的 server 又只有最小 PATH，
// which 找不到再试几个固定路径。任何异常都吞成事实对象，不抛：体检不能因为一个可选工具而整体失败。
// D4 取数：谁在 listen 这个端口（pid + 命令行 + cwd），判定在 doctor-checks.identifySelfServer。
// Linux 走 /proc（零外部工具：slim 容器里连 ps 都没有）；macOS 走 lsof / ps，但只按 PATH 查找——
// 此前 scripts/doctor.js 写死 /usr/sbin/lsof 与 /bin/ps，Linux 一步都走不到，server 跑着时 D4 恒报
// 「被不明进程占用」（2026-09-06 容器演练）。任何一步失败都返回空数组：认不出来只会退回 fail 分支，不会误认自己人。
export function probeListeningProcesses(port, { platform: plat = platform(), procRoot = '/proc', execFile = execFileSync } = {}) {
  try {
    return plat === 'linux' ? listenersViaProc(port, procRoot) : listenersViaLsof(port, execFile);
  } catch {
    return [];
  }
}

function listenersViaProc(port, procRoot) {
  const readOr = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
  const inodes = new Set([
    ...parseProcNetTcpListeners(readOr(join(procRoot, 'net', 'tcp')), port),
    ...parseProcNetTcpListeners(readOr(join(procRoot, 'net', 'tcp6')), port),
  ]);
  if (!inodes.size) return [];
  const out = [];
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    let fds;
    try { fds = readdirSync(join(procRoot, entry, 'fd')); } catch { continue; } // 别人的进程读不到 fd，跳过
    const holds = fds.some((fd) => {
      try {
        const m = readlinkSync(join(procRoot, entry, 'fd', fd)).match(/^socket:\[(\d+)\]$/);
        return !!m && inodes.has(m[1]);
      } catch { return false; }
    });
    if (!holds) continue;
    const command = readOr(join(procRoot, entry, 'cmdline')).split('\0').filter(Boolean).join(' ');
    let cwd = null;
    try { cwd = readlinkSync(join(procRoot, entry, 'cwd')); } catch { /* 无权限读别人的 cwd：留 null，identifySelfServer 不会认领 */ }
    out.push({ pid: Number(entry), command, cwd });
  }
  return out;
}

function listenersViaLsof(port, execFile) {
  const run = (cmd, args) => execFile(cmd, args, { encoding: 'utf8', timeout: 3000 });
  const pids = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).split('\n').map((s) => s.trim()).filter(Boolean);
  return pids.map((pid) => {
    const command = run('ps', ['-o', 'command=', '-p', pid]).trim();
    // lsof -F 输出：`p<pid>` 行后跟 `n<路径>` 行，n 是字段标记
    const cwd = run('lsof', ['-a', '-d', 'cwd', '-p', pid, '-Fn']).split('\n').find((l) => l.startsWith('n'))?.slice(1) || null;
    return { pid: Number(pid), command, cwd };
  });
}

const TAILSCALE_FALLBACK_PATHS = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
];
export function probeTailscale({ platform: plat = platform(), execFile = execFileSync } = {}) {
  let bin = resolveExecutableViaPath('tailscale', { execFile });
  if (!bin && plat === 'darwin') bin = TAILSCALE_FALLBACK_PATHS.find((p) => existsSync(p)) || '';
  if (!bin) return { found: false };
  // status --json 在 Stopped / NeedsLogin 下也会把 JSON 打到 stdout，但退出码可能非零——
  // 抛出来的 err.stdout 里仍是完整 JSON，先试着解析它再放弃。
  const parse = (raw) => {
    const st = JSON.parse(String(raw || ''));
    return {
      found: true,
      backendState: String(st?.BackendState || ''),
      dnsName: String(st?.Self?.DNSName || '').replace(/\.$/, ''),
    };
  };
  try {
    return parse(execFile(bin, ['status', '--json'], { encoding: 'utf8', timeout: 3000 }));
  } catch (err) {
    try {
      return parse(err?.stdout);
    } catch {
      // 2026-09-06 本机实测：CLI 在、守护进程没跑时 stdout 空、stderr「failed to connect to local
      // Tailscale service; is Tailscale running?」。这不是 Tailscale 的 BackendState 枚举值，给它一个
      // CCM 侧的名字——用户该做的是「启动 Tailscale」，不是「tailscale up」（up 同样连不上守护进程）。
      if (/failed to connect to local tailscale/i.test(String(err?.stderr || ''))) {
        return { found: true, backendState: 'DaemonNotRunning', dnsName: '' };
      }
      return { found: true, backendState: '', dnsName: '', error: String(err?.message || err) };
    }
  }
}

// 敏感配置文件清单（相对项目根）——CLI doctor（scripts/doctor.js）与本运行时 doctor 共用同一事实源，
// 防两处各自维护再漏同步。列表新增项须同时被 CLI 检查/自动修复与 UI 体检覆盖。
export const CONFIG_FILE_NAMES = [
  // 统一配置文件（P1a 起的默认格式）。它和 .env 一样装着 AUTH_TOKEN / VAPID 私钥 / ntfy token，
  // 不进这张清单的话 CLI doctor 查不到、--fix 也修不了 —— 而 setup.js 现在默认生成的就是它。
  'ccm.config.json',
  '.env',
  join('data', 'sessions.json'),
  join('data', 'init-cache.json'),
  join('data', 'trusted-devices.json'),
  join('data', 'pending-devices.json'),
  join('data', 'cf-access-certs.json'),
  join('data', 'approval-requests.json'),
  join('data', 'audit-records.json'),
  // 含 p256dh/auth 推送密钥材料（notify-channels.js 自己写着「绝不能裸 writeFileSync」），
  // 却一直不在权限清单里 —— CLI doctor 查不到、--fix 也修不了。
  join('data', 'push-subscription.json'),
  // 跨设备已读位点（2026-09-03）：内容是会话 id 清单 + 阅读时刻，与 sessions.json 同档。
  join('data', 'read-state.json'),
];

// BE-013：统计权限过宽（非 0600）的配置文件数，供 UI doctor 传入 runDoctor。
// 返回 number（已检查，0=全干净）或 null（平台无 POSIX 权限位、无法检查）。
// 关键：Windows 下 isOwnerOnly 恒 true 会把「无法检查」伪装成「0 处过宽」→ 假绿；故此处先按平台短路返回 null，
// 让 runDoctor 显 warn/未知而非 ok。rootDir 缺省项目根（server 侧传 import.meta.dirname）。
export function countConfigPermProblems(rootDir, { platform = process.platform, dataDir = null } = {}) {
  if (platform === 'win32') return null; // 无法真正检查 → 不可假报 0
  // 清单项以【项目根】为基准（'data/sessions.json'），但长期跑着的实例普遍用 CCM_DATA_DIR 把数据目录移出仓库。
  // 必须剥掉 data/ 前缀再挂到真实数据目录上——此前 server 侧直接把 CCM_DATA_DIR 当 rootDir 传入，拼出
  // <CCM_DATA_DIR>/data/sessions.json 这个永不存在的路径，一个文件都扫不到 → 恒 0 → 体检恒报绿（BE-013 假绿）。
  // CLI doctor（scripts/doctor.js effectiveConfigFiles）一直用同一套剥前缀逻辑，这里与它对齐。
  const dataRoot = dataDir || join(rootDir, 'data');
  let problems = 0;
  for (const name of CONFIG_FILE_NAMES) {
    // 判据从「是不是 .env」换成「在不在 data/ 下」：清单里现在有两个项目根文件
    // （ccm.config.json 与 .env），按名字逐个列举迟早漏掉新加的那个。
    // 必须判「data/ 前缀」而不是「data 开头」——否则将来加一个仓库根文件、名字恰好以
    // data 开头（如 data-export.json，不在 data/ 目录下），会被错误挂到 dataRoot 而非
    // rootDir，替换正则匹配不上、名字原样拼接，解析到一个永不存在的路径，静默不计入体检。
    const dataPrefixMatch = /^data[/\\](.+)$/.exec(name);
    const p = dataPrefixMatch
      ? join(dataRoot, dataPrefixMatch[1])
      : join(rootDir, name);
    if (!existsSync(p)) continue;      // 文件不存在不算问题
    if (!isOwnerOnly(p)) problems++;   // 存在但非 0600 → 过宽
  }
  return problems;
}

// CLI 的 settings 三层链：user(global) → 各 workDir 的 project → 同目录的 local（后者覆盖前者）。
// 权限合并与模型体检【共用这一份】：两处各写一套遍历时，链一变化（CLI 新增作用域、要支持
// managed-settings）只会有一个被更新，另一个继续基于陈旧视图出报告——而 doctor 的职责恰恰是
// 告诉用户配置是否自洽。本次「模型体检丢了用户级 env」正是重复遍历的直接产物。
// 容错：读/解析失败的源 json 为 null（比照 workdirs.js 的「坏配置不清空」），坏 JSON 不让体检崩。
function readSettingsChain({ home, workDirs = [] } = {}) {
  const parse = (file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;                       // 缺文件 / 坏 JSON → skip
    }
  };
  const out = [];
  if (home) {
    const file = claudeSettingsPath(home);
    out.push({ scope: 'global', dir: null, file, json: parse(file) });
  }
  for (const dir of workDirs || []) {
    for (const [scope, name] of [['project', 'settings.json'], ['local', 'settings.local.json']]) {
      const file = join(claudeHome(dir), name);
      out.push({ scope, dir, file, json: parse(file) });
    }
  }
  return out;
}

// 读并合并 permissions.allow（~/.claude/settings.json + 各 workDir 的 .claude/settings.json[.local]），标注 scope。
export function readMergedPermissions({ home, workDirs = [] } = {}) {
  const sources = [];
  for (const { scope, file, json } of readSettingsChain({ home, workDirs })) {
    const rules = json?.permissions?.allow;
    if (Array.isArray(rules)) sources.push({ scope, file, rules });
  }
  const allow = [];
  for (const s of sources) for (const rule of s.rules) allow.push({ rule, scope: s.scope, file: s.file });
  return { allow, sources };
}

// 读 user 的 model + 各 workDir 的 project/local 里 model 与 ANTHROPIC_DEFAULT_<档位>_MODEL（只抽字段，不回显 token）。
// 按目录分组返回：多网关并存时（本机 9 个目录各配各的），混成一个扁平数组比对会让归属随机、
// 建议指向错误的目录。档位名从 env key 提取，值只用于判「该档位是否已映射」。
export function readModelSettingsSnapshot({ home, workDirs = [] } = {}) {
  const collectTiers = (j, into) => {
    const env = j?.env && typeof j.env === 'object' ? j.env : null;
    if (!env) return into;
    for (const [k, v] of Object.entries(env)) {
      const m = /^ANTHROPIC_DEFAULT_(.+)_MODEL$/i.exec(k);
      if (!m) continue;
      const t = v != null ? String(v).trim() : '';
      if (t) into[m[1].toLowerCase()] = t;
    }
    return into;
  };
  const modelOf = (j) => (j?.model != null ? String(j.model).trim() : '');

  const chain = readSettingsChain({ home, workDirs });
  const global = chain.find(s => s.scope === 'global');
  const userModel = modelOf(global?.json);
  // 用户级 env 是【每个目录的基底】：CLI 把 ~/.claude/settings.json 的 env 合并进所有目录，
  // 所以「全局配一个网关、各项目不单独配」这个最常见布局下，每个 dir 都带着这份映射。
  // 漏掉它是双向错的——全局配网关时整条检查恒绿假 OK，全局+目录混合时反过来误报 warn。
  const userTiers = collectTiers(global?.json, {});

  const byDir = new Map();
  for (const { scope, dir, json } of chain) {
    if (!dir) continue;
    if (!byDir.has(dir)) byDir.set(dir, { dir, projectModel: '', localModel: '', tierTargets: { ...userTiers } });
    const entry = byDir.get(dir);
    collectTiers(json, entry.tierTargets);               // project 覆盖 global，local 再覆盖 project
    if (scope === 'project') entry.projectModel = modelOf(json);
    if (scope === 'local') entry.localModel = modelOf(json);
  }
  return { userModel, dirs: [...byDir.values()] };
}

// 编排运行时安全检查 + 危险白名单审查，产出【已脱敏】报告。
// 项数以下方 checks.push 为准，并由 tests/unit/doctor-runtime.test.mjs 的
// `assert.equal(rep.checks.length, N)` 硬锁——增删项会让那条断言红，据它更新即可。
// （这里刻意不写具体数字：此前写死的「6 项」「12 项」都在陆续加项后失真过，注释计数没有闸门盯着。）
export function runDoctor(ctx = {}) {
  const checks = [];

  // 分类与措辞都走共用的 authTokenDiagnostic —— 与 scripts/doctor.js 同一份判定。
  // 此前这里是内联三元拼文案，纯空白 token 只说「已设置（长度 3）」，看不出它绑着公网。
  // bindPlan 由 server 侧算好传入（它拿得到实际生效的 BIND_MODE/BIND_HOST）；
  // 没传时 authTokenDiagnostic 内部按 token 推导 = 改造前的行为。
  const tok = authTokenDiagnostic({ token: ctx.authToken, lang: ctx.lang });
  checks.push({ id: 'AUTH_TOKEN', status: tok.status, detail: tok.detail, safe: tok.safe });

  // 监听面（D22 的手机端出口）：BIND_MODE 配错会让 server 拒绝启动，而这台正在跑的实例
  // 用的是旧配置——面板上看到 fail 就是「下次重启会起不来」的预警。
  // 缺省必须带上 ctx.authToken：否则 resolveBindPlan({}) 会因为「没 token」判 refuse，
  // 把一个明明有 token 的实例报成「起不来」。server 侧总是传真实 bindPlan，
  // 这条缺省只服务于不关心绑定的调用方（多为测试）。
  const bindChk = bindDiagnostic({
    bindPlan: ctx.bindPlan || resolveBindPlan({ authToken: ctx.authToken }),
    lang: ctx.lang,
  });
  checks.push({ id: 'BIND', status: bindChk.status, detail: bindChk.detail, safe: bindChk.safe });

  // 实时探测 + 与启动快照对比。此前这里只回放 ctx.claudeVersion（server 启动那一刻的字符串），
  // 于是 claude 被升级/卸载/移走之后，web 体检照样绿到下次重启为止。
  // ctx.probeClaudeBin 由 server 注入（可被测试替换），缺省时自己探。
  const probe = (ctx.probeClaudeBin || probeClaudeBin)();
  const cb = claudeBinDiagnostic({ ...probe, startupVersion: ctx.claudeVersion || '', lang: ctx.lang });
  checks.push({ id: 'CLAUDE_BIN', status: cb.status, detail: cb.detail, safe: cb.safe });

  const wc = (ctx.workDirs || []).length;
  // 过宽根只报不拦（判定见 workdirBreadthDiagnostic）；这里只出个数，路径不进报告。
  const wb = workdirBreadthDiagnostic({ dirs: ctx.workDirs || [], home: ctx.home, lang: ctx.lang });
  checks.push({
    id: 'WORK_DIRS',
    status: wc && wb.status === 'ok' ? 'ok' : 'warn',
    detail: wb.broad.length ? `${wc} 个工作目录；${wb.detail}` : `${wc} 个工作目录`,
    safe: { count: wc, tooBroad: wb.broad.length },
  }); // 不回显路径

  const sl = statuslineConfigDiagnostic(ctx.webStatuslineOff, ctx.lang);
  checks.push({ id: 'WEB_STATUSLINE', status: sl.status, detail: sl.detail });

  // BE-013：区分「未检查」（undefined/null）与「已检查、0 处过宽」（0）。旧实现把缺省 undefined 当 0 → 恒显
  // 「配置文件权限 0600」ok 假绿（server 生产调用从不传此字段）。未检查必须显 warn/未知，绝不显 ok。
  const cpp = ctx.configPermsProblems;                       // number=已检查 · null=平台不可查 · undefined=未传
  const cppChecked = typeof cpp === 'number';
  checks.push({
    id: 'CONFIG_PERMS',
    status: cppChecked ? (cpp ? 'warn' : 'ok') : 'warn',      // 未检查 → warn（不假绿）
    detail: cppChecked ? (cpp ? `${cpp} 处权限过宽（应 0600）` : '配置文件权限 0600') : '配置文件权限未检查（未知）',
    safe: { problemCount: cppChecked ? cpp : null, checked: cppChecked },
  });

  // Cloudflare Access 是**可选加层**，不是就绪条件：公网基线 = AUTH_TOKEN + 逐设备审批，对所有拓扑相同。
  // 此前未启用恒 warn，而 computeReadiness 把任一 warn 算成 caution —— LAN / Tailscale / 反代 / 直连的
  // 部署永远到不了 ready，体检在对不用 Cloudflare 的用户说「你还差一样」，可基线他们一样不少（2026-09-06）。
  // 各拓扑真正该查的东西（token、PUBLIC_URL、绑定面…）在下面 ACCESS_PROFILE 那格按声明分别查。
  checks.push({
    id: 'CF_ACCESS',
    status: 'ok',
    detail: ctx.cfEnabled
      ? '已启用：公网 Host 强制 Cloudflare Access JWT（可选加层：这条路上替代 AUTH_TOKEN，缺省也替代设备审批；局域网 / 本机照旧认 AUTH_TOKEN）'
      : '未启用；公网基线 = AUTH_TOKEN + 设备审批，按拓扑的针对性检查见 ACCESS_PROFILE 项',
    safe: { enabled: !!ctx.cfEnabled, audSet: !!ctx.cfAudSet }, // AUD 仅布尔
  });

  // D21 的手机端出口：方案声明（ACCESS_PROFILE）就住在 web 配置面板里，切换后的自洽核对
  // 也该在手机上看得到。判定与 scripts/doctor.js D21 共用 accessProfileDiagnostic；
  // cfConfigured 用 ctx.cfEnabled（auth 层权威判定，比 CLI 侧「三键齐设」更准）。
  // safe 只出布尔/枚举字面量：publicUrl 的值绝不进报告（会被贴进 issue/聊天）。
  const apProfile = String(ctx.accessProfile || '').trim();
  const ap = accessProfileDiagnostic({
    profile: apProfile,
    cfConfigured: !!ctx.cfEnabled,
    publicUrl: ctx.publicUrl || '',
    authTokenSet: tok.safe.isSet && tok.status !== 'fail',
    notifyConfigured: !!ctx.notifyConfigured,
    // 复用上面 D22 已经算好的那份，不再自己 resolveBindPlan 一次——同一次体检里两条检查
    // 用两个各自算的 plan，是「同一事实两套判据」的经典形状（见 single-source-of-truth.test.mjs）。
    publiclyReachable: bindChk.safe.publiclyReachable,
    // 采信 XFF 的开关（server 从 parseServerConfig 拿归一后的值传入；缺省 = 未开）。
    trustedProxy: ctx.trustedProxy || '',
    lang: ctx.lang,
  });
  checks.push({
    id: 'ACCESS_PROFILE', status: ap.status, detail: ap.detail,
    safe: {
      declared: apProfile !== '',
      trustedProxy: ctx.trustedProxy === 'loopback' ? 'loopback' : '',
      // 未知值归一成 'unknown'：safe 只出枚举字面量，用户手写的任意串不进结构化字段（detail 里已点名）。
      profile: !apProfile || ACCESS_PROFILES.includes(apProfile) ? apProfile : 'unknown',
      cfConfigured: !!ctx.cfEnabled,
      publicUrlSet: !!String(ctx.publicUrl || '').trim(),
      notifyConfigured: !!ctx.notifyConfigured,
    },
  });

  // TAILSCALE（D23 的手机端出口，2026-09-06）：不经 Cloudflare 的推荐路径，只探测 + 指路。
  // 探测可注入（测试 / 不想 spawn 的调用方），缺省真探；port 由 server 传（serve 提示要带实际端口）。
  const ts = (ctx.probeTailscale || probeTailscale)();
  const tsd = tailscaleDiagnostic({ ...ts, accessProfile: apProfile, port: ctx.port, lang: ctx.lang });
  checks.push({ id: 'TAILSCALE', status: tsd.status, detail: tsd.detail, safe: tsd.safe });

  // token 公网 + 无 CF Access 时，localhost 反代/隧道会跳过设备指纹门——显式 warn，不改运行时默认。
  // 纯空白 token 现在判 fail（绑了公网却不设防），于是这里也正确地不再把它当成一道认证门 ——
  // 此前它是 warn/isSet=true，DEVICE_GATE 会以为公网侧有 AUTH_TOKEN 保护着。
  // DEVICE_APPROVAL_SCOPE 并进这一行而不另起一行：设成 all 时「Access 已验的连接跳过设备审批」就不成立了，
  // 两行各说各的会自相矛盾。写错的值运行时按较松的默认档跑，必须说出来（2026-09-22 review P2）。
  // ctx 传归一前的原值——归一后只剩 '' / 'all'，写错的痕迹已经没了。
  const scope = deviceApprovalScopeDiagnostic({ scope: ctx.deviceApprovalScopeRaw, lang: ctx.lang });
  const gate = classifyDeviceGateTopology({
    authTokenSet: tok.safe.isSet && tok.status !== 'fail',
    cfEnabled: !!ctx.cfEnabled,
    deviceApprovalScope: scope.scope === 'all' ? 'all' : '',
  });
  checks.push({
    id: 'DEVICE_GATE',
    status: scope.status === 'warn' ? 'warn' : gate.status,
    detail: scope.status === 'warn' ? `${scope.detail}。${gate.detail}` : gate.detail,
    safe: { ...gate.safe, scope: scope.scope },
  });

  // D20 的手机端出口（R45，2026-08-30）：FILE_EDIT 是唯一绕过 Agent 审批链的写入通道，而它的
  // 开关就住在这个配置面板里——web 体检的受众与该提示的受众重合度比装机时跑一次的 CLI doctor 高。
  // 判定与 scripts/doctor.js D20 同一份纯函数；公网信号 = CF Access 实际启用（ctx.cfEnabled，
  // auth 层权威判定，比 CLI 侧「三键齐设」更准）或 PUBLIC_URL 已声明。safe 不回显 URL 值，只出布尔。
  const fe = fileEditExposureDiagnostic({ fileEditOff: !!ctx.fileEditOff, cfConfigured: !!ctx.cfEnabled, publicUrl: ctx.publicUrl || '', accessProfile: ctx.accessProfile || '', lang: ctx.lang });
  checks.push({
    id: 'FILE_EDIT', status: fe.status, detail: fe.detail,
    safe: { off: !!ctx.fileEditOff, publicSignal: !!ctx.cfEnabled || !!String(ctx.publicUrl || '').trim() },
  });

  checks.push({ id: 'PUSH_VAPID', status: ctx.pushEnabled ? 'ok' : 'warn', detail: ctx.pushEnabled ? '已配置' : '未配置（推送优雅缺席）', safe: { enabled: !!ctx.pushEnabled } }); // 密钥仅布尔

  checks.push({ id: 'DEVICES', status: (ctx.pendingDevices || 0) > 0 ? 'warn' : 'ok', detail: `信任 ${ctx.trustedDevices || 0} 台 / 待批 ${ctx.pendingDevices || 0} 台`, safe: { trusted: ctx.trustedDevices || 0, pending: ctx.pendingDevices || 0 } });

  // 模型设置冲突：全局 model vs local ANTHROPIC_DEFAULT_*（不回显 env 密钥，只报 model 名与映射目标）
  const modelSnap = readModelSettingsSnapshot({ home: ctx.home, workDirs: ctx.workDirs || [] });
  const modelDiag = modelSettingsConflictDiagnostic(modelSnap);
  checks.push({
    id: 'MODEL_SETTINGS',
    status: modelDiag.status,
    detail: modelDiag.detail,
    safe: {
      userModel: modelSnap.userModel || null,
      // 不回显路径/映射目标值：只出「配了网关的目录数」与「目录内是否 pin 了 model」的计数。
      gatewayDirCount: modelSnap.dirs.filter(d => Object.keys(d.tierTargets).length > 0).length,
      pinnedDirCount: modelSnap.dirs.filter(d => d.localModel || d.projectModel).length,
    },
  });

  // D18 的手机端出口。「env 恒压过配置文件而被压侧无症状」这句话写在 scripts/doctor.js:23 ——
  // 产品自己承认它危险，可此前唯一的消费者是维护者 CLI，而 ccm 的主场景恰恰在手机上。
  // ctx.shellEnv 必须是 loadRuntimeEnvironment **之前**的快照（src/ops/config.js
  // getShellEnvSnapshot），加载后文件值也进了 process.env、来源就分不开了。
  // 缺省不假绿：调用方没传快照 = 这项没查过，与 BE-013 的 CONFIG_PERMS 同一条纪律。
  const envOvChecked = !!ctx.shellEnv && typeof ctx.shellEnv === 'object';
  const envOv = envOverrideDiagnostic({ shellEnv: ctx.shellEnv || {}, keys: ALL_CONFIG_KEYS, lang: ctx.lang });
  checks.push({
    id: 'ENV_OVERRIDE',
    status: envOvChecked ? envOv.status : 'warn',
    detail: envOvChecked ? envOv.detail : '环境变量覆盖未检查（未知）',
    // 只出键名 —— 值可能是 AUTH_TOKEN / VAPID 私钥，而体检报告会被贴进 issue / 聊天。
    safe: { checked: envOvChecked, keys: envOvChecked ? envOv.keys : [] },
  });

  // 危险白名单：读合并 permissions.allow，危险条附 scope（让用户知道改哪个文件），非危险不列。
  const merged = readMergedPermissions({ home: ctx.home, workDirs: ctx.workDirs || [] });
  const sum = summarizeDangerous(merged.allow.map(a => a.rule));
  // SONNET-BUG-1：旧实现 `merged.allow.find(a => a.rule === d.rule)?.scope` 只取首个匹配——同一危险规则若同时
  // 出现在 global 与 project，恒被标成 global（首命中），项目级重复规则误标；且 summarizeDangerous 逐条 map，
  // 重复规则会产生多条相同 dangerous。此处按 rule 去重 + 聚合【所有】出现过的 scope。
  const dangerous = [];
  const seenRules = new Set();
  for (const d of sum.dangerous) {
    if (seenRules.has(d.rule)) continue;               // 去重：同一条不重复列
    seenRules.add(d.rule);
    const scopes = [...new Set(merged.allow.filter(a => a.rule === d.rule).map(a => a.scope))];
    dangerous.push({ rule: d.rule, reason: d.reason, scope: scopes.join(', ') }); // scope 聚合成串（前端直接展示）
  }
  checks.push({ id: 'WHITELIST', status: dangerous.length ? 'warn' : 'ok', detail: dangerous.length ? `${dangerous.length} 条危险规则（共 ${sum.ruleCount} 条）` : `${sum.ruleCount} 条规则，无危险项`, safe: { ruleCount: sum.ruleCount, dangerous } });

  return { checks, readiness: computeReadiness(checks) };
}
