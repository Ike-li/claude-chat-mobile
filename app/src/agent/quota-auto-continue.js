// quota-auto-continue.js —— 额度墙「到点自动继续」的纯判定（无 IO、无时钟、无随机源，全部由调用方注入）。
//
// 【为什么 CCM 要自己做】CLI 2.1.280 自带同名能力（设置项 autoContinueAtUsageLimit + /rate-limit-options），
// 但它的总闸是 `ld() && !bg && !remote && 灰度开关`，其中 ld() = launchOptions.isInteractive()，而
// `-p / --print / --sdk-url / stdout 非 TTY` 任一成立就是非交互——SDK 拉起的 CLI（本项目、桌面端 Code 标签）
// 恒进不去。桌面端的「到点续跑」是它前端自己发一句固定文案实现的（2026-09-21 真机：重置后 97s 发出）。
// 所以终端等价只能在这一层补：CLI 有什么，web 就有什么。
//
// 判据逐条抄 CLI（二进制实测，变量名是混淆后的）：
//   fj()      墙可用 = status==='rejected' && resetsAt 有限 && !isUsingOverage && !overageInUse
//   rgt       自动布防视界 24h：重置点更远（多半是周额度）只提供选项、不自动等
//   oe()      到点抖动 30–90s（jitterMin/Max 缺省值）
//   q8n()     两拍间隔 > 30min 且已过点 = 机器睡过了重置点 → stale，不自动发、改为询问
//   x / j     续跑后又撞墙：重布防最少间隔 [60s, 300s]，上限 2 次
// 与 CLI 的一处有意差异见 planQuotaWall 的「空转」判据。
//
// 【官方订阅与第三方网关怎么兼容】一律数据驱动，不做任何上游判断（hard-rules §1「对模型通路零假设」）：
// 只要 CLI 报出了带重置时刻的结构化墙（assistant 墙的 quotaLimits，或同一轮收到的 rejected
// rate_limit_event），就能布防——官方订阅恒有；网关若透传了 unified 限额头也会有。网关只回裸 429 时
// CLI 报不出重置时刻，这里就判 no_reset、不布防，绝不拿「多久以后再试」去猜。

// 续跑提示词：CLI 原文（`Your claude.ai usage limit has reset. …`）去掉 claude.ai 字样——第三方网关与
// API key 用户撞的不是 claude.ai 的墙，照抄就是在说错话。后半句一字不改：它是在告诉模型别重做已完成的部分。
export const AUTO_CONTINUE_PROMPT = 'Your usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.';

export const AUTO_CONTINUE_JITTER_MIN_MS = 30_000;
export const AUTO_CONTINUE_JITTER_MAX_MS = 90_000;
export const AUTO_CONTINUE_HORIZON_MS = 24 * 60 * 60 * 1000;
export const AUTO_CONTINUE_SLEEP_GRACE_MS = 30 * 60 * 1000;
export const AUTO_CONTINUE_REARM_MIN_DELAYS_MS = Object.freeze([60_000, 300_000]);
export const AUTO_CONTINUE_REARM_CAP = 2;

// resetsAt → 毫秒。CLI 2.1.235+ 实测为秒级 unix 时间戳；同族字段在 SDK 其他消息里有毫秒口径的先例，
// 按量级归一。判错一个数量级会把重置时刻算成 1970 年，比不认更糟，所以非法一律 null。
export function resetsAtToMs(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
}

function rejectedInfo(info) {
  return info && typeof info === 'object' && !Array.isArray(info) && info.status === 'rejected' ? info : null;
}

function jitter(random) {
  return AUTO_CONTINUE_JITTER_MIN_MS + Math.floor(random() * (AUTO_CONTINUE_JITTER_MAX_MS - AUTO_CONTINUE_JITTER_MIN_MS));
}

// 布防时刻：重置点 + 抖动，且至少等一个抖动下限——重置点已过（时钟偏差 / 迟到的墙）时不当场连发。
// futile ≥ 1（续跑后又空转撞墙）时再叠 CLI 的最少间隔，给上游的重置生效留时间。
export function computeFireAt({ resetsAtMs, now, futile = 0, random }) {
  let fireAt = Math.max(resetsAtMs + jitter(random), now + AUTO_CONTINUE_JITTER_MIN_MS);
  if (futile >= 1) {
    const delays = AUTO_CONTINUE_REARM_MIN_DELAYS_MS;
    fireAt = Math.max(fireAt, now + (delays[futile - 1] ?? delays[delays.length - 1]));
  }
  return fireAt;
}

// 一次主循环撞墙 → 怎么处置。
//   quota        assistant 墙顶层的 quotaLimits（CLI 2.1.235 起恒带）
//   fallback     同一轮里收到的 rejected rate_limit_event.rate_limit_info（老 CLI 的墙不带 quotaLimits）
//   autoEnabled  CCM 开关开着 && CLI 的 autoContinueAtUsageLimit 没被显式关掉
//   turnOrigin   撞墙这一轮是谁发起的（'auto-continuation' = 我们上次续跑发出去的那一轮）
//   turnHadOutput 这一轮撞墙前有没有真模型输出
//   prevFutile   此前连续空转次数
// 返回 kind：
//   arm         布防，fireAt 到点续跑
//   offer       不自动布防，但给用户一个「到点继续」的选项（reason: horizon | disabled）
//   ineligible  没法续（reason: no_reset | overage）
//   stop        连续空转超过上限，熔断（reason: rearm_cap）
export function planQuotaWall({ quota, fallback, now, autoEnabled, turnOrigin, turnHadOutput, prevFutile = 0, random }) {
  const info = rejectedInfo(quota) || rejectedInfo(fallback);
  const base = { resetsAtMs: null, rateLimitType: null, fireAt: null, futile: 0 };
  if (!info) return { ...base, kind: 'ineligible', reason: 'no_reset' };
  if (info.isUsingOverage === true || info.overageInUse === true) return { ...base, kind: 'ineligible', reason: 'overage' };
  const resetsAtMs = resetsAtToMs(info.resetsAt);
  if (resetsAtMs === null) return { ...base, kind: 'ineligible', reason: 'no_reset' };
  const rateLimitType = typeof info.rateLimitType === 'string' ? info.rateLimitType : null;
  // 【与 CLI 的有意差异】CLI 把「续跑那一轮里撞墙」一律记一次重布防，两次后熔断——于是一个跨多个
  // 5 小时窗口的长任务会在第三个窗口被截停，而那恰是本功能的主用例（人不在电脑前、让它一直干）。
  // 熔断要防的是「上游其实没放行、续一次撞一次」的空转，所以这里只数「续跑那一轮一个字没产出就撞墙」；
  // 干了活再撞墙是下一个窗口用完了，计数清零。人发起的轮次撞墙同样清零。
  const futile = turnOrigin === 'auto-continuation' && !turnHadOutput ? prevFutile + 1 : 0;
  const fact = { resetsAtMs, rateLimitType, futile };
  if (futile > AUTO_CONTINUE_REARM_CAP) return { ...base, ...fact, kind: 'stop', reason: 'rearm_cap' };
  if (resetsAtMs - now > AUTO_CONTINUE_HORIZON_MS) return { ...base, ...fact, kind: 'offer', reason: 'horizon' };
  if (!autoEnabled) return { ...base, ...fact, kind: 'offer', reason: 'disabled' };
  return { ...fact, kind: 'arm', reason: null, fireAt: computeFireAt({ resetsAtMs, now, futile, random }) };
}

// 每一拍：到点没有、是不是睡过头了。lastTickAt 是上一拍的时刻（null = 刚布防、还没走过一拍）。
// 为什么要靠拍间隔判睡眠而不是一个长 setTimeout：libuv 的定时器在 macOS 上走 mach_absolute_time，
// 系统睡眠期间不计时——布防后睡两小时，一个 5 小时的 setTimeout 会晚两小时才响。
export function decideDue({ fireAt, now, lastTickAt, graceMs = AUTO_CONTINUE_SLEEP_GRACE_MS }) {
  if (now < fireAt) return 'wait';
  if (lastTickAt != null && now - lastTickAt > graceMs) return 'stale';
  return 'fire';
}

const isSyntheticAssistant = e => e?.message?.model === '<synthetic>';
const isRateLimitWall = e => e?.type === 'assistant' && e.isApiErrorMessage === true
  && (e.error === 'rate_limit' || e.apiErrorStatus === 429);

// 到点前的最后一道确认：墙之后没有任何人动过这个会话。读的是磁盘 transcript（终端写的也在里面）。
// 不算「动过」的：非对话条目（system / last-prompt / queue-operation …）、子 agent 链、isMeta 的 user、
// 以及 <synthetic> 的非错误 assistant——后两者是 CLI resume 被打断回合时自己补的那一对
// （「Continue from where you left off.」+「No response requested.」，2026-09-11 真机同毫秒落盘、零 token）。
// 认墙用 uuid，对不上时退回 resetsAt：SDK 流里的 uuid 若与落盘不一致，只认 uuid 会让功能静默失效。
// 老 CLI 的墙条目不带 quotaLimits，那就只能按「是一条 rate_limit 错误」认。
export function wallStillTail(entries, { wallUuid, resetsAtMs }) {
  if (!Array.isArray(entries)) return false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || (e.type !== 'user' && e.type !== 'assistant')) continue;
    if (e.isSidechain === true) continue;
    if (e.type === 'user' && e.isMeta === true) continue;
    if (e.type === 'assistant' && isSyntheticAssistant(e) && e.isApiErrorMessage !== true) continue;
    if (!isRateLimitWall(e)) return false;
    if (wallUuid && e.uuid === wallUuid) return true;
    const q = rejectedInfo(e.quotaLimits);
    if (!q) return true;
    return resetsAtToMs(q.resetsAt) === resetsAtMs;
  }
  return false;
}
