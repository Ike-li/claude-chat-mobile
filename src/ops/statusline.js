// statusline.js —— web 自有状态栏（E16）：server 端用 web 会话自有的 SDK 数据 + 本机 git，
// 纯 JS 组装结构化状态，经 status_line 事件投前端、以 web 原生 UI 渲染。**不调 shell 脚本、不读 .quota-now
// 快照、不依赖 ~/.claude/settings.json**——自包含、开箱即用。
// 显示面目标对齐 CLI statusline 文案：model / effort / location / git 三分 / ctx%·left /
// uncached·response / cache write·read / 5h·7d / est$·total·api / lines +/− / sid / version。
// CLI 独有且 SDK 路径不产出或不接的（pid/transcript/session name/PR/wt/think on-off）不硬塞。
import { execFile } from 'node:child_process';
import path from 'node:path';
import * as diagLog from '../agent/diag-log.js';
import { createUsageSnapshotStore, rememberUsage, fallbackUsage } from './usage-snapshot.js';

// 状态栏 project 字段：从 cwd 取末段目录名。原 `cwd.split('/').pop()` 手写实现只认 `/`，
// server 跑在 Windows 上时 cwd 是 `C:\...`（无 `/`），会退化成整条路径。改用 path.win32/posix
// 的 basename——按实际宿主 OS 选规范（cwd 恒与运行该判断的 OS 同源，两者不会不一致）。
// platform 可注入供测试跨平台验证，默认 process.platform。
export function projectNameFromCwd(cwd, { platform = process.platform } = {}) {
  if (!cwd) return cwd;
  const impl = platform === 'win32' ? path.win32 : path.posix;
  return impl.basename(cwd) || cwd;
}

// ---- 本机 git 段（per-cwd 短 TTL 缓存，避免每次刷新都 spawn git）----
const GIT_TTL_MS = 5_000;
const gitCache = new Map(); // cwd -> { at, data|null }

function execGit(args, cwd) {
  return new Promise(resolve => {
    try {
      execFile('git', ['-C', cwd, ...args], { timeout: 2_000, maxBuffer: 1 << 20 },
        (err, stdout) => resolve(err ? null : String(stdout).trim()));
    } catch { resolve(null); } // cwd 无效 / git 不存在：优雅缺席
  });
}

// 解析 `git status --porcelain` → { staged, modified, untracked }（对齐 CLI statusline 的 +暂存 !改动 ?未跟踪 三分）。
// 每行前两字符是 XY 状态码：X=index(暂存)位、Y=worktree(工作区)位。复刻 CLI 脚本语义（三类独立计数、不互斥，
// 故 `MM`（既暂存又有新改动）同时计入 staged 与 modified）：staged=X∈MADRC · modified=Y∈MDT · untracked=`??`。
export function parsePorcelain(str) {
  let staged = 0, modified = 0, untracked = 0;
  for (const line of String(str || '').split('\n')) {
    if (!line) continue;
    if (line.slice(0, 2) === '??') { untracked++; continue; } // 未跟踪：?? 开头（X/Y 均不落入下方 charset）
    if ('MADRC'.includes(line[0])) staged++;   // index 位：修改/新增/删除/重命名/复制 → 已暂存
    if ('MDT'.includes(line[1])) modified++;    // worktree 位：修改/删除/类型变更 → 工作区未暂存改动
  }
  return { staged, modified, untracked };
}

// 从 git remote url 解析 owner/repo（https / git@scp 两种形式），失败回 null。
// https://github.com/Ike-li/claude-chat-mobile.git → "Ike-li/claude-chat-mobile"
// git@github.com:Ike-li/claude-chat-mobile.git    → "Ike-li/claude-chat-mobile"
export function parseRepo(url) {
  if (!url) return null;
  const parts = String(url).trim().replace(/\.git$/, '').replace(/\/$/, '').split(/[/:]/).filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : null;
}

// 返回 { branch, changed, staged, modified, untracked, ahead, behind, repo } 或 null
// （非 git 仓库 / git 不可用 = 优雅缺席）。changed=总变更条数（向后兼容旧渲染）；staged/modified/untracked=三分。
// 不再含 insertions/deletions（那是 web 独有 git 工作区 diff 口径；CLI 用会话工具累计 lines +/−，另走 usage）。
export async function gitStatus(cwd) {
  if (!cwd) return null;
  const hit = gitCache.get(cwd);
  if (hit && Date.now() - hit.at < GIT_TTL_MS) return hit.data;
  const branch = (await execGit(['symbolic-ref', '--short', 'HEAD'], cwd))
    || (await execGit(['rev-parse', '--short', 'HEAD'], cwd));
  let data = null;
  if (branch) {
    const status = await execGit(['status', '--porcelain'], cwd);
    const changed = status ? status.split('\n').filter(Boolean).length : 0;
    const { staged, modified, untracked } = parsePorcelain(status);
    let ahead = 0, behind = 0;
    // HEAD...@{u}：left=本地独有(ahead)、right=上游独有(behind)；无上游则 git 报错→保持 0
    const lr = await execGit(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], cwd);
    if (lr) { const [a, b] = lr.split(/\s+/).map(n => parseInt(n, 10)); ahead = a || 0; behind = b || 0; }
    const repo = parseRepo(await execGit(['config', '--get', 'remote.origin.url'], cwd));
    data = { branch, changed, staged, modified, untracked, ahead, behind, repo };
  }
  gitCache.set(cwd, { at: Date.now(), data });
  return data;
}

// ---- 账号级额度快照单例（OPS：消除 owner=sdk/cli 切换或 RPC 超时/bridge 快照过期造成的"时有时无"）----
// owner=sdk 走 agent.fetchUsage()（1.5s 超时）、owner=cli 走落盘 bridge 快照（非 fresh 即整段无额度）——
// 两条路径描述的是同一个 Anthropic 账号，短暂断档时用最近一次温热数据垫上远比整段消失更接近事实。
// 单例、进程重启清零、不持久化、不分账号（"每实例单用户"，见 CLAUDE.md）；buildWebStatusLine/
// buildCliStatusLine 都可通过 usageStore 形参覆盖它——仅供单测隔离，生产路径（app.js refreshStatusLine）
// 从不传入，恒用这份默认单例，故两条路径能互相垫底。详见 usage-snapshot.js。
const usageSnapshotStore = createUsageSnapshotStore();

// 供 app.js refreshStatusLine() 的 cli-unavailable 分支使用：owner=cli 但 bridge 快照缺失/过期时，
// selectStatusSource 判定 kind!=='cli'，buildCliStatusLine 整个不会被调用——上面两个写入点/回落点都摸
// 不到，此前这一分支组装的 payload 100% 没有 rate 字段。这里只开放"读一次回落值"这一个窄接口，
// 不直接导出 usageSnapshotStore 单例本身（保持封装，调用方不能绕过 fallbackUsage 的 TTL/空值判断
// 直接读写内部形状）。usageStore 形参默认这份模块单例，与 buildWebStatusLine/buildCliStatusLine
// 共用同一份数据——三处任一路径写入的温热值，都能被另外两处拿来垫底；单测可传独立 store 隔离。
export function getFallbackUsageRate(now, usageStore = usageSnapshotStore) {
  return fallbackUsage(usageStore, now);
}

// ---- 上下文窗口大小映射（model → tokens）----
// SDK 不回报 web 会话的真实窗口大小，只能按 model 名映射，按下列优先级判定：
// 1) 显式 1M 标记（[1m] / "1M context"）→ 1_000_000；
// 2) 官方已确认为 1M 窗口的当前代 Claude 模型（裸 model id，不靠 [1m] 后缀也能判定）：
//    opus-4-6/4-7/4-8、sonnet-4-6/5、fable-5、mythos-5（依据 Anthropic 官方 claude-api 参考资料，
//    核实于 2026-06-24）→ 1_000_000。新模型上线后需要在这里同步补充，别漏更新。
// 3) 其余认得出的 Claude 关键词（claude/opus/sonnet/haiku）→ 200_000。注意这不是"官方确认这些都是
//    200k"，而是查不到权威数据时的保守兜底——尤其是不在②名单里的更早期 opus/sonnet
//    （如 opus-4-5/4-1/4-0、sonnet-4-5/4-0），其真实窗口未核实，不要臆测成 1M；haiku 全系目前官方
//    确认就是 200k，属于确定值而非兜底猜测。
// 4) 认不出 → null（调用方退回只显绝对 token 数，不显百分比），第三方模型不误导显示 %。
// 已知边界（有意接受的取舍）：resume 会丢掉网关加的 [1m] 后缀。对②里已确认 1M 的当前代模型，
// 丢了后缀也无妨——裸 model id 本身就能命中②直接判 1M，不再依赖 [1m] 后缀。这条边界现在只残留在：
// a) 必须靠 [1m] 后缀才能识别为 1M 的第三方/网关模型；b) ③里保守按 200k 兜底、但未来官方确认其实
// 是 1M 却还没同步进本表的老模型。宁可让多数场景有正确（或至少不臆测）的百分比，也不为这类边界
// 砍掉整个功能。
export function contextWindowSize(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  if (/\[1m\]|\b1m\b|1m\s*context|1000000/.test(m)) return 1_000_000;
  if (/\b(?:opus-4-[678]|sonnet-4-6|sonnet-5|fable-5|mythos-5)\b/.test(m)) return 1_000_000;
  if (/claude|opus|sonnet|haiku/.test(m)) return 200_000;
  return null;
}

// web 会话自己的 ctx/cost（口径：assistant.message.usage，非 result.usage 轮内聚合避免高估）。
// 本函数只回 SDK 真值（token 绝对数）；ctx 百分比在 buildWebStatusLine 里用 contextWindowSize(model)
// 事后推算——SDK / 会话 jsonl / 快照都不暴露 web 会话真实 context window 大小，只能按 model 名映射。
export function webContextCost({ agent }) {
  const r = {};
  const u = agent?.lastUsage;
  if (u) {
    r.context = {
      totalInputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      usage: {
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
        cache_read_input_tokens: u.cache_read_input_tokens || 0
      }
    };
  }
  if (agent && (agent.totalCostUsd > 0 || agent.historicalCostUsd > 0 || agent.totalDurationMs > 0)) {
    r.cost = { usedUsd: (agent.historicalCostUsd || 0) + (agent.totalCostUsd || 0), durationMs: agent.totalDurationMs, apiDurationMs: agent.totalApiDurationMs };
  }
  return r;
}

// Part2（§6）：安全取 Agent SDK 上下文用量。活跃会话（调用方已确认 agent.q 存在且未 dispose）调 q.getContextUsage()
// 取【运行时权威】maxTokens/percentage；RPC 超时（默认 1.5s，cold ~3.8s 但不阻塞——先发陈旧值/回来补发）
// 或抛错 → 返回 null 让调用方降级回 contextWindowSize(model) 静态映射。本函数只兜 RPC 层（延迟/异常），不判生命周期。
// 不再透传 categories（那是 CLI /context 分解，非 CLI statusline 字段；web statusline 对齐 CLI statusline 故不含）。
export async function getContextUsageSafe(q, timeoutMs = 1500) {
  if (!q?.getContextUsage) return null;
  try {
    return await Promise.race([
      q.getContextUsage(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('getContextUsage timeout')), timeoutMs)),
    ]);
  } catch { return null; }
}

// 从 agent.fetchUsage()（SDK usage_EXPERIMENTAL…）提取 statusline 需要对齐 CLI 的字段：
// 5h/7d 额度窗 + 会话工具改行 lines +/−。失败/不可用 → 空对象（字段省）。
// 防御性：不绑固定 schema；rate_limits_available===false 时不吐额度。

// refreshStatusLine 并发锁状态机（纯函数，供 server 接线 + 单测）：
// enter：busy 则只记 queued、不 proceed；否则 proceed 并 busy。
// leave：清 busy；若 queued 则 reschedule（补跑一次，避免 await getContextUsage 期间丢刷新）。
export function noteStatusRefreshBusy(state = {}, phase) {
  const busy = !!state.busy;
  const queued = !!state.queued;
  if (phase === 'enter') {
    if (busy) return { busy: true, queued: true, proceed: false };
    return { busy: true, queued: false, proceed: true };
  }
  if (phase === 'leave') {
    return { busy: false, queued: false, reschedule: queued };
  }
  return { busy, queued, proceed: false, reschedule: false };
}

export function usageBitsForStatusLine(usage) {
  const out = {};
  if (!usage || typeof usage !== 'object') return out;
  if (usage.rate_limits_available !== false) {
    const rl = usage.rate_limits;
    if (rl && typeof rl === 'object') {
      const five = rl.five_hour, seven = rl.seven_day;
      const rate = {};
      // OPS-2：utilization 必须夹在 [0,100]——CLI 路径 buildCliStatusLine 会丢弃越界值，
      // SDK 路径此前原样拷贝 150/-5，statusline 文案与颜色阈值失真。
      if (five && typeof five === 'object' && Number.isFinite(five.utilization)
          && five.utilization >= 0 && five.utilization <= 100) {
        rate.fiveHour = { usedPercent: five.utilization };
        if (typeof five.resets_at === 'string' && five.resets_at) rate.fiveHour.resetsAt = five.resets_at;
      }
      if (seven && typeof seven === 'object' && Number.isFinite(seven.utilization)
          && seven.utilization >= 0 && seven.utilization <= 100) {
        rate.sevenDay = { usedPercent: seven.utilization };
        if (typeof seven.resets_at === 'string' && seven.resets_at) rate.sevenDay.resetsAt = seven.resets_at;
      }
      if (Object.keys(rate).length) out.rate = rate;
    }
  }
  const sess = usage.session;
  if (sess && typeof sess === 'object') {
    const added = sess.total_lines_added, removed = sess.total_lines_removed;
    if ((Number.isFinite(added) && added > 0) || (Number.isFinite(removed) && removed > 0)) {
      out.lines = { added: Number.isFinite(added) ? added : 0, removed: Number.isFinite(removed) ? removed : 0 };
    }
  }
  return out;
}

// usage=null（RPC 层失败）已由 agent.fetchUsage()/_recordRateUnavailable 自行判定+记录，这里不重复；
// 只接力处理拿到 usage 对象之后的三态：第三方鉴权(third_party_auth) / 数据异常(no_valid_window，越界或缺失)
// / 恢复正常(reason=null)。与 fetchUsage() 共用同一个 agent.lastRateUnavailableReason 字段做变化去重
// （高频刷新——300ms 防抖/10s 兜底轮询——下同一原因不重复写，防刷屏）。
function recordRateReasonIfChanged(agent, usage, bits) {
  if (!usage || typeof usage !== 'object') return;
  const reason = usage.rate_limits_available === false ? 'third_party_auth' : (bits.rate ? null : 'no_valid_window');
  if (reason === agent.lastRateUnavailableReason) return;
  // agent.logKey?.() 降级读法：既有测试 mock 多是裸对象、无 logKey 方法；缺 sessionId 时
  // diagLog.record 内部 `if (!sessionKey) return;` 会安全吞掉，不影响调用方。
  const key = typeof agent.logKey === 'function' ? agent.logKey() : agent.sessionId;
  diagLog.record(key, 'statusline', 'rate_reason_change', { reason, previousReason: agent.lastRateUnavailableReason });
  agent.lastRateUnavailableReason = reason;
}

// 组装 web 状态栏结构化 payload（全字段可选，缺则省；前端按存在性渲染原生 UI）。
// 权限档不在此——前端已有独立 pill（pillPerm），避免重复显示；effort 进 statusline 对齐 CLI 文案
// （底栏 pill 仍保留作切换器）。
export async function buildWebStatusLine({ agent, cwd, versions, usageStore = usageSnapshotStore }) {
  const p = { ts: Date.now() };
  // FRESH 会话 activeModel 为空（未显式指定 model）时回退 reportedModel（init 报告的真实运行模型）——
  // 只读显示，不碰 activeModel，不触发 F1（空发 setModel 重置网关模型）。见 agent.js reportedModel。
  const model = agent?.activeModel || agent?.reportedModel || '';
  if (model) p.model = model;
  // effort：实例 spawn 档（null=模型默认 → 不显，对齐 CLI 空 effort 时不打印）
  if (agent?.effort) p.effort = agent.effort;
  // per-turn 秒表/输出 token（前端 CLI 式动态状态行 ✻ Verb… (Ns · ↓ tokens) 的权威数据；空闲不带）
  if (agent?.turnStartedAt) p.turn = { startedAt: agent.turnStartedAt, outTokens: agent.turnOutputTokens || 0 };
  if (cwd) { p.cwd = cwd; p.project = projectNameFromCwd(cwd); }
  const git = await gitStatus(cwd);
  if (git) p.git = git;
  const cc = webContextCost({ agent });
  // lastUsage 单轮明细（可缺）；getContextUsage 全量权威可在无 lastUsage 时独立出 ctx%。
  if (cc.context && Number.isFinite(cc.context.totalInputTokens)) {
    const u = cc.context.usage;
    // in/out/w/r：input / output / cache 写(creation) / cache 读（cli 口径 uncached/response/write/read）
    p.ctx = {
      tokens: cc.context.totalInputTokens,
      in: u.input_tokens,
      out: u.output_tokens || 0,
      w: u.cache_creation_input_tokens,
      r: u.cache_read_input_tokens
    };
    const total = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
    if (total > 0) p.ctx.cacheHitPct = Math.round(u.cache_read_input_tokens / total * 100); // 瞬时：本轮命中率
  }
  // ctx 百分比：优先 Agent SDK getContextUsage() 的【运行时权威】maxTokens/percentage（活跃会话）；
  // 无活 q（idle/历史/dispose）/ RPC 超时 / 抛错 → 降级回 contextWindowSize(model) 静态映射猜测。
  // 无 lastUsage 时仍可只出 window/percent/totalTokens（修首包/清零后 ctx 整段缺席）。
  const sdkCtx = (agent?.q && !agent.disposed) ? await getContextUsageSafe(agent.q) : null;
  if (sdkCtx && Number.isFinite(sdkCtx.maxTokens) && sdkCtx.maxTokens > 0) {
    p.ctx = p.ctx || {};
    p.ctx.windowSize = sdkCtx.maxTokens;
    p.ctx.usedPercent = Math.min(100, Math.max(0, Math.round(sdkCtx.percentage || 0)));
    // totalTokens 与 percentage 同源（全量上下文占用）；p.ctx.tokens 仍是 lastUsage 单轮口径。
    if (Number.isFinite(sdkCtx.totalTokens) && sdkCtx.totalTokens >= 0) {
      p.ctx.totalTokens = sdkCtx.totalTokens;
    }
  } else if (p.ctx && Number.isFinite(p.ctx.tokens) && p.ctx.tokens > 0) {
    const win = contextWindowSize(model);
    if (win) {
      p.ctx.windowSize = win;
      p.ctx.usedPercent = Math.min(100, Math.round(p.ctx.tokens / win * 100));
    }
  }
  if (cc.cost) {
    if (cc.cost.usedUsd > 0) p.cost = cc.cost.usedUsd;
    if (cc.cost.durationMs > 0 || cc.cost.apiDurationMs > 0)
      p.duration = { wallMs: cc.cost.durationMs || 0, apiMs: cc.cost.apiDurationMs || 0 };
  }
  // 账号额度 5h/7d + 会话工具改行 lines：走 SDK usage_EXPERIMENTAL（与独立额度窗同源）。
  // 活跃 agent 才调；失败/第三方 provider → 字段省，不崩 statusline。
  // allowRateFallback：仅"短暂断档"（RPC 超时/抛错/agent 不可用/disposed）才允许垫快照。
  // 若本轮 RPC 成功解出 usage 但 bits.rate 为空（第三方鉴权 rate_limits_available:false /
  // utilization 越界 no_valid_window）——那是"明确无额度"，绝不能垫上一份 Anthropic 温热快照
  // 冒充还活着（code review：跨鉴权/空窗误垫）。
  let allowRateFallback = true;
  if (agent && typeof agent.fetchUsage === 'function' && !agent.disposed) {
    try {
      const usage = await agent.fetchUsage();
      // fetchUsage 超时/不可用常回 null：属短暂断档，应允许账号级快照垫上（F1）。
      // 只有拿到 usage 对象且 bits.rate 为空（第三方/越界）才是「明确无额度」。
      if (usage == null) {
        // 保持 allowRateFallback=true；不写 reason 变化（无对象可判）
      } else {
        const bits = usageBitsForStatusLine(usage);
        Object.assign(p, bits);
        recordRateReasonIfChanged(agent, usage, bits);
        // 写入点 A：本轮成功拿到额度 → 记进账号级快照，供下次断档时垫上（见 usage-snapshot.js）。
        if (bits.rate) {
          rememberUsage(usageStore, bits.rate, Date.now());
        } else {
          allowRateFallback = false; // 明确无额度：禁止垫旧值
        }
      }
    } catch { /* 静默降级：允许回落 */ }
  }
  // claude CLI 版本（启动时采集，server.js 传入）：取首段裸版本号，去 "(Claude Code)" 等后缀；前端加 v 前缀
  const ver = versions?.cli && versions.cli !== 'unknown' ? String(versions.cli).split(/\s+/)[0] : '';
  if (ver) p.version = ver;
  // 会话元数据：sid（ccm 自管 sessionId）。注：CLI statusline 的 "pid" 实为 Claude Code 的 prompt_id、
  // SDK 路径不产出；transcript basename 与 sid 冗余（= <sid>.jsonl），故都不含。
  if (agent?.sessionId) p.session = { id: agent.sessionId };
  // 回落点：本轮短暂断档（fetchUsage 失败/超时/agent 不可用/disposed）→ 用最近一次温热快照垫上，
  // 消除"时有时无"的闪断。明确无额度（见上 allowRateFallback=false）不垫。
  // 从未写入过 / 已超 TTL → fallbackUsage 返回 null，本行为空操作。
  if (!p.rate && allowRateFallback) {
    const fallback = fallbackUsage(usageStore, Date.now());
    if (fallback) { p.rate = fallback; p.rateFromSnapshot = true; }
  }
  return p;
}

function cliResetIso(value) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  if (!Number.isFinite(value) || value < 0) return null;
  try {
    // Claude CLI statusline 当前给 Unix 秒；兼容未来直接给毫秒，避免 1970 年倒计时。
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  } catch { return null; }
}

function copyFinite(source, keys) {
  const out = {};
  for (const key of keys) if (Number.isFinite(source?.[key]) && source[key] >= 0) out[key] = source[key];
  return out;
}

// CLI owner 时只消费 bridge 的白名单快照；与 SDK payload 分开构建，禁止按字段回退/混拼陈旧 Web 数据。
// git 是当前 cwd 的本机事实，仍即时读取；其余模型、effort、上下文、成本、额度均来自同一份 CLI 快照。
export async function buildCliStatusLine({ snapshot, cwd, usageStore = usageSnapshotStore } = {}) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const p = { ts: Number.isFinite(s.capturedAt) ? s.capturedAt : Date.now() };
  const model = typeof s.model?.displayName === 'string' && s.model.displayName
    ? s.model.displayName
    : (typeof s.model?.id === 'string' ? s.model.id : '');
  if (model) p.model = model;
  if (typeof s.effort === 'string' && s.effort) p.effort = s.effort;
  if (typeof s.thinking?.enabled === 'boolean') p.thinking = { enabled: s.thinking.enabled };

  const statusCwd = typeof cwd === 'string' && cwd ? cwd : (typeof s.cwd === 'string' ? s.cwd : '');
  if (statusCwd) {
    p.cwd = statusCwd;
    p.project = projectNameFromCwd(statusCwd);
    const git = await gitStatus(statusCwd);
    if (git) p.git = git;
  }

  const ctx = copyFinite(s.ctx, ['tokens', 'in', 'out', 'w', 'r', 'currentTotal', 'cacheHitPct', 'windowSize', 'usedPercent']);
  if (Object.keys(ctx).length) p.ctx = ctx;
  if (Number.isFinite(s.cost) && s.cost >= 0) p.cost = s.cost;
  const duration = copyFinite(s.duration, ['wallMs', 'apiMs']);
  if (Object.keys(duration).length) p.duration = duration;
  const lines = copyFinite(s.lines, ['added', 'removed']);
  if (Object.keys(lines).length) p.lines = lines;

  const rate = {};
  for (const [sourceKey, targetKey] of [['fiveHour', 'fiveHour'], ['sevenDay', 'sevenDay']]) {
    const source = s.rate?.[sourceKey];
    if (!source || !Number.isFinite(source.usedPercent) || source.usedPercent < 0 || source.usedPercent > 100) continue;
    const window = { usedPercent: source.usedPercent };
    const resetsAt = cliResetIso(source.resetsAt);
    if (resetsAt) window.resetsAt = resetsAt;
    rate[targetKey] = window;
  }
  // 写入点 B：本次 fresh bridge 快照解出有效额度 → 记进账号级快照——与 SDK 路径共享同一份单例
  // （两条路径描述的是同一个 Anthropic 账号，谁刚拿到新数据都值得给对方垫底）。
  if (Object.keys(rate).length) {
    p.rate = rate;
    rememberUsage(usageStore, rate, Date.now());
  }

  if (typeof s.cliVersion === 'string' && s.cliVersion) p.version = s.cliVersion.split(/\s+/)[0];
  if (typeof s.sessionId === 'string' && s.sessionId) p.session = { id: s.sessionId };
  // 回落点：这一拍 fresh 快照本身没带可用额度字段 → 用最近一次温热快照垫上（与 buildWebStatusLine
  // 同款语义，见其注释）。
  if (!p.rate) {
    const fallback = fallbackUsage(usageStore, Date.now());
    if (fallback) { p.rate = fallback; p.rateFromSnapshot = true; }
  }
  return p;
}
