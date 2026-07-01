// statusline.js —— web 自有状态栏（E16）：server 端用 web 会话自有的 SDK 数据 + 本机 git，
// 纯 JS 组装结构化状态，经 status_line 事件投前端、以 web 原生 UI 渲染。**不调 shell 脚本、不读 .quota-now
// 快照、不依赖 ~/.claude/settings.json**——自包含、开箱即用。账号级配额段（5h/7d%）SDK 物理拿不到，故不含。
import { execFile } from 'node:child_process';

// ---- prompt cache 失效倒计时的 TTL（推算用，非权威）----
// 来源澄清（重要）：Anthropic ephemeral prompt cache 默认 TTL = 5 分钟，这是【官方文档约定值】，
// 不是 SDK/CLI 回报的运行时数据——claude-agent-sdk 的 usage 只含 token 计数，其类型定义(coreTypes.d.ts)
// 无任何 cache 过期/deadline/ttl 字段，上游真实 TTL 不可观测。故 statusline 的「缓存失效倒计时」是
// 【客户端推算】：deadline = agent.lastCacheHitAt（最后一次 cache_read>0 的墙钟时刻）+ 本常量，每次命中
// 滑动重置；前端按 deadline−now 本地递减并标 ~est。改本常量不改上游真实 TTL（上游设多少我们看不到）。
const CACHE_TTL_MS = 300_000;

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

// 解析 `git diff --shortstat` 输出 → { insertions, deletions }（无匹配则 0）。
// 输入形如 " 3 files changed, 12 insertions(+), 4 deletions(-)"（缺某项时该项省略）。
export function parseShortstat(str) {
  const ins = str && String(str).match(/(\d+) insertion/);
  const del = str && String(str).match(/(\d+) deletion/);
  return { insertions: ins ? parseInt(ins[1], 10) : 0, deletions: del ? parseInt(del[1], 10) : 0 };
}

// 从 git remote url 解析 owner/repo（https / git@scp 两种形式），失败回 null。
// https://github.com/Ike-li/claude-chat-mobile.git → "Ike-li/claude-chat-mobile"
// git@github.com:Ike-li/claude-chat-mobile.git    → "Ike-li/claude-chat-mobile"
export function parseRepo(url) {
  if (!url) return null;
  const parts = String(url).trim().replace(/\.git$/, '').replace(/\/$/, '').split(/[/:]/).filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : null;
}

// 返回 { branch, changed, ahead, behind, insertions, deletions, repo } 或 null（非 git 仓库 / git 不可用 = 优雅缺席）。
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
    let ahead = 0, behind = 0;
    // HEAD...@{u}：left=本地独有(ahead)、right=上游独有(behind)；无上游则 git 报错→保持 0
    const lr = await execGit(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], cwd);
    if (lr) { const [a, b] = lr.split(/\s+/).map(n => parseInt(n, 10)); ahead = a || 0; behind = b || 0; }
    // 工作区相对 HEAD 的未提交改动行数（未跟踪文件不计，符合 git diff 语义）+ repo 全名（owner/repo）
    const { insertions, deletions } = parseShortstat(await execGit(['diff', '--shortstat', 'HEAD'], cwd));
    const repo = parseRepo(await execGit(['config', '--get', 'remote.origin.url'], cwd));
    data = { branch, changed, ahead, behind, insertions, deletions, repo };
  }
  gitCache.set(cwd, { at: Date.now(), data });
  return data;
}

// web 会话自己的 ctx/cost（口径：assistant.message.usage，非 result.usage 轮内聚合避免高估）。
// ctx 只回 SDK 真值（token 绝对数），不算「百分比/窗口」——SDK / 会话 jsonl / 快照都不暴露 web 会话自己的
// 真实 context window 大小，从 model 名猜窗口会误判（官方 1M beta 无 [1m] 后缀 / resume 丢后缀）。
export function webContextCost({ agent }) {
  const r = {};
  const u = agent?.lastUsage;
  if (u) {
    r.context = {
      totalInputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      reused: agent.totalCacheReadTokens || 0, // 会话累计复用 token（reused 指标）——独立于下方 usage 的单轮口径
      usage: {
        input_tokens: u.input_tokens || 0,
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

// 组装 web 状态栏结构化 payload（全字段可选，缺则省；前端按存在性渲染原生 UI）。
// 权限档 / effort 不在此——前端已有独立 pill（pillPerm/pillEffort），避免重复显示。
export async function buildWebStatusLine({ agent, cwd, versions }) {
  const p = { ts: Date.now() };
  // 当前活跃子任务名（Agent/Task 工具 description），有则显示
  if (agent?.currentTask) p.task = agent.currentTask;
  // FRESH 会话 activeModel 为空（未显式指定 model）时回退 reportedModel（init 报告的真实运行模型）——
  // 只读显示，不碰 activeModel，不触发 F1（空发 setModel 重置网关模型）。见 agent.js reportedModel。
  const model = agent?.activeModel || agent?.reportedModel || '';
  if (model) p.model = model;
  if (cwd) { p.cwd = cwd; p.project = cwd.replace(/\/+$/, '').split('/').pop() || cwd; }
  const git = await gitStatus(cwd);
  if (git) p.git = git;
  const cc = webContextCost({ agent });
  if (cc.context && Number.isFinite(cc.context.totalInputTokens)) {
    const u = cc.context.usage;
    // in/w/r：input / cache 写(creation) / cache 读 明细（cli 口径 in:/w:/r:）；tokens=三者和=context 已用绝对数
    p.ctx = { tokens: cc.context.totalInputTokens, in: u.input_tokens, w: u.cache_creation_input_tokens, r: u.cache_read_input_tokens };
    const total = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
    if (total > 0) p.ctx.cacheHitPct = Math.round(u.cache_read_input_tokens / total * 100); // 瞬时：本轮命中率
    if (cc.context.reused > 0) p.ctx.reused = cc.context.reused;                            // 累计：本会话复用 token（reused）
    // 缓存失效倒计时 deadline（客户端推算，非权威——详见顶部 CACHE_TTL_MS 注释）：仅曾命中过缓存才给，前端本地递减
    if (agent?.lastCacheHitAt > 0) p.ctx.cacheExpiresAt = agent.lastCacheHitAt + CACHE_TTL_MS;
  }
  if (cc.cost) {
    if (cc.cost.usedUsd > 0) p.cost = cc.cost.usedUsd;
    if (cc.cost.durationMs > 0 || cc.cost.apiDurationMs > 0)
      p.duration = { wallMs: cc.cost.durationMs || 0, apiMs: cc.cost.apiDurationMs || 0 };
  }
  // claude CLI 版本（启动时采集，server.js 传入）：取首段裸版本号，去 "(Claude Code)" 等后缀；前端加 v 前缀
  const ver = versions?.cli && versions.cli !== 'unknown' ? String(versions.cli).split(/\s+/)[0] : '';
  if (ver) p.version = ver;
  return p;
}
