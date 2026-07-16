// statusline.js —— web 自有状态栏（E16）：server 端用 web 会话自有的 SDK 数据 + 本机 git，
// 纯 JS 组装结构化状态，经 status_line 事件投前端、以 web 原生 UI 渲染。**不调 shell 脚本、不读 .quota-now
// 快照、不依赖 ~/.claude/settings.json**——自包含、开箱即用。
// 显示面目标对齐 CLI statusline 文案：model / effort / location / git 三分 / ctx%·left /
// uncached·response / cache write·read / 5h·7d / est$·total·api / lines +/− / sid / version。
// CLI 独有且 SDK 路径不产出或不接的（pid/transcript/session name/PR/wt/think on-off）不硬塞。
import { execFile } from 'node:child_process';

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

// ---- 上下文窗口大小映射（model → tokens）----
// SDK 不回报 web 会话的真实窗口大小，只能按 model 名映射：显式 1M 标记（[1m] / "1M context"）→ 1_000_000；
// 认得出的 Claude 模型 → 200_000；认不出 → null（调用方退回只显绝对 token 数，不显百分比）。
// 已知边界（有意接受的取舍）：resume 会丢掉 [1m] 后缀，1M 会话被恢复后会被当 200k、ctx% 偏高；
// 宁可让多数场景有百分比，也不为这个极端边界砍掉整个功能。认不出的第三方模型直接不显 %，不误导。
export function contextWindowSize(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  if (/\[1m\]|\b1m\b|1m\s*context|1000000/.test(m)) return 1_000_000;
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

// 组装 web 状态栏结构化 payload（全字段可选，缺则省；前端按存在性渲染原生 UI）。
// 权限档不在此——前端已有独立 pill（pillPerm），避免重复显示；effort 进 statusline 对齐 CLI 文案
// （底栏 pill 仍保留作切换器）。
export async function buildWebStatusLine({ agent, cwd, versions }) {
  const p = { ts: Date.now() };
  // FRESH 会话 activeModel 为空（未显式指定 model）时回退 reportedModel（init 报告的真实运行模型）——
  // 只读显示，不碰 activeModel，不触发 F1（空发 setModel 重置网关模型）。见 agent.js reportedModel。
  const model = agent?.activeModel || agent?.reportedModel || '';
  if (model) p.model = model;
  // effort：实例 spawn 档（null=模型默认 → 不显，对齐 CLI 空 effort 时不打印）
  if (agent?.effort) p.effort = agent.effort;
  if (cwd) { p.cwd = cwd; p.project = cwd.replace(/\/+$/, '').split('/').pop() || cwd; }
  const git = await gitStatus(cwd);
  if (git) p.git = git;
  const cc = webContextCost({ agent });
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
    // ctx 百分比：优先 Agent SDK getContextUsage() 的【运行时权威】maxTokens/percentage（活跃会话）；
    // 无活 q（idle/历史/dispose）/ RPC 超时 / 抛错 → 降级回 contextWindowSize(model) 静态映射猜测。
    // 修真 bug：静态映射把 1M beta 会话当 200k、ctx% 偏高 5 倍；SDK 反映真实窗口。percentage 用官方口径
    //（对 compact buffer / skills 基线另有折算），勿自算 tokens/maxTokens，免与 CLI /context 显示分叉。
    const sdkCtx = (agent?.q && !agent.disposed) ? await getContextUsageSafe(agent.q) : null;
    if (sdkCtx && Number.isFinite(sdkCtx.maxTokens) && sdkCtx.maxTokens > 0) {
      p.ctx.windowSize = sdkCtx.maxTokens;
      p.ctx.usedPercent = Math.min(100, Math.max(0, Math.round(sdkCtx.percentage || 0)));
    } else {
      const win = contextWindowSize(model);
      if (win && p.ctx.tokens > 0) {
        p.ctx.windowSize = win;
        p.ctx.usedPercent = Math.min(100, Math.round(p.ctx.tokens / win * 100));
      }
    }
  }
  if (cc.cost) {
    if (cc.cost.usedUsd > 0) p.cost = cc.cost.usedUsd;
    if (cc.cost.durationMs > 0 || cc.cost.apiDurationMs > 0)
      p.duration = { wallMs: cc.cost.durationMs || 0, apiMs: cc.cost.apiDurationMs || 0 };
  }
  // 账号额度 5h/7d + 会话工具改行 lines：走 SDK usage_EXPERIMENTAL（与独立额度窗同源）。
  // 活跃 agent 才调；失败/第三方 provider → 字段省，不崩 statusline。
  if (agent && typeof agent.fetchUsage === 'function' && !agent.disposed) {
    try {
      const usage = await agent.fetchUsage();
      Object.assign(p, usageBitsForStatusLine(usage));
    } catch { /* 静默降级 */ }
  }
  // claude CLI 版本（启动时采集，server.js 传入）：取首段裸版本号，去 "(Claude Code)" 等后缀；前端加 v 前缀
  const ver = versions?.cli && versions.cli !== 'unknown' ? String(versions.cli).split(/\s+/)[0] : '';
  if (ver) p.version = ver;
  // 会话元数据：sid（ccm 自管 sessionId）。注：CLI statusline 的 "pid" 实为 Claude Code 的 prompt_id、
  // SDK 路径不产出；transcript basename 与 sid 冗余（= <sid>.jsonl），故都不含。
  if (agent?.sessionId) p.session = { id: agent.sessionId };
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
export async function buildCliStatusLine({ snapshot, cwd } = {}) {
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
    p.project = statusCwd.replace(/\/+$/, '').split('/').pop() || statusCwd;
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
  if (Object.keys(rate).length) p.rate = rate;

  if (typeof s.cliVersion === 'string' && s.cliVersion) p.version = s.cliVersion.split(/\s+/)[0];
  if (typeof s.sessionId === 'string' && s.sessionId) p.session = { id: s.sessionId };
  return p;
}
