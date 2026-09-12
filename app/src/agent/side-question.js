// side-question.js —— 两个「旁路提问」功能的纯判据与提示词：回来时的会话摘要（recap）与下一步建议。
//
// 【为什么自建而不用 SDK 的 promptSuggestions】SDK 内建的那条路在 CLI 里有一道写死的 cache_cold 判据：
// 取上一条 assistant 的 `input_tokens + cache_creation + output`（**不含 cache_read**）> 10000 就放弃生成。
// 它是「prompt cache 没命中」的探针——不返回 cache 字段的网关下，整个上下文都压进 input_tokens，
// 一万的门槛一次就爆。2026-09-10 实测：本机某转译网关对带 cache_control 的请求返回
// `{"input_tokens": 9, "output_tokens": 103}`，两个 cache 字段都不存在。那种工作区下 SDK 内建的建议
// **永不出现且不报错**。自建走 query.askSideQuestion() 就完全不受那道判据约束。
//
// 【askSideQuestion 的性质】2026-09-10 实测：带完整会话上下文（答案能准确复述刚发生的事）、
// 返回 `{ response, synthetic }`、**不写 transcript**（会话 jsonl 里查无痕迹）、自动跟随会话语言。
// ⚠️ 它在 SDK 的 .d.ts 里没有类型声明（运行时存在、类型未公开），升级 SDK 后要确认它还在。
//
// 本模块只做数据→数据：不碰 SDK、不碰 socket、不读时钟（now 一律由调用方传入，否则用例得靠 sleep 才能测）。

// 提示词用英文写指令、不指定输出语言：模型会跟随会话本身的语言作答（实测中文会话得到中文回复）。
// 都明确要求「不确定就沉默」——这两个功能的失败方向是刻意选的：**宁可不出现，也不要出现得不合时宜**。
// 空回复由调用方丢弃，不渲染空行。

export const RECAP_PROMPT = [
  'The user stepped away and just came back to this session.',
  'In 1-2 plain sentences (no markdown, no lists, under 40 words), remind them where things stand:',
  'what the goal is, what state the work is in right now, and the single next action.',
  'Skip root-cause narration, skip anything already obvious from the last message on screen.',
  'If the session has no meaningful progress to recap, reply with nothing at all.',
].join(' ');

export const SUGGEST_PROMPT = [
  'Predict the single next message THIS USER would most likely type into this session.',
  'Not what you think they should do — what they would actually write.',
  'The test: would they think "that is exactly what I was about to type"?',
  'Be concrete and short (2-12 words), match the way they have been writing.',
  'Never suggest: evaluative filler, questions back at them, assistant-voice phrasing, or ideas they never raised.',
  'If the next step is not obvious from what the user themselves said, or if a suggestion could be unsafe',
  'or inappropriate in context, reply with nothing at all.',
].join(' ');

// —— recap 抑制判据 ——
// 与 CLI 那套【刻意不同】的一条：CLI 在「输入框有草稿」时跳过，本产品不看草稿。
// 移动端放下手机时输入框常留半截草稿，抄过来会让这个功能几乎永不出现——而「放下手机又回来」
// 恰恰是它唯一的使用场景。
export const RECAP_MIN_AWAY_MS = 5 * 60_000;     // 离开不足 5 分钟不值得打扰
export const RECAP_MIN_INTERVAL_MS = 30 * 60_000; // 反复进出只给一次
export const RECAP_MIN_ASSISTANT_TURNS = 2;       // 没有实质进展就没什么可摘要的

export function shouldRecap({
  awayMs = 0,
  assistantTurns = 0,
  lastRecapAt = 0,
  now = 0,
  isBusy = false,
  enabled = true,
  hasPriorHistory = false,
} = {}) {
  if (!enabled) return false;
  // 正在跑时不给：用户回来看到的是实时进度，摘要只会和进度条打架。
  if (isBusy) return false;
  if (!(awayMs >= RECAP_MIN_AWAY_MS)) return false;
  if (assistantTurns < RECAP_MIN_ASSISTANT_TURNS && !hasPriorHistory) return false;
  // lastRecapAt=0 表示本会话还没给过——首次不受间隔约束。
  if (lastRecapAt && now - lastRecapAt < RECAP_MIN_INTERVAL_MS) return false;
  return true;
}

// —— suggestion 抑制判据 ——
// 触发点是每轮 result 结算之后，所以频率比 recap 高一个数量级（每轮一次 vs 每次回来一次）。
// 出错/被中断的那一轮不猜：那时用户要做的是判断刚才发生了什么，猜下一步是打扰。
export function shouldSuggest({
  assistantTurns = 0,
  isError = false,
  interrupted = false,
  enabled = true,
  hasPriorHistory = false,
} = {}) {
  if (!enabled) return false;
  if (isError || interrupted) return false;
  // 首轮不猜：只有一次往返时，「下一步」几乎总是猜不准的（CLI 内建那条同样要求 ≥2）。
  return assistantTurns >= 2 || hasPriorHistory;
}

// 模型回复归一：空/纯空白 → null（调用方据此不发事件，不渲染空行）。
// 去掉可能的包裹引号：提示词要的是裸文本，但模型偶尔会加引号，带着引号填进输入框很碍事。
// 超长截断——这两个功能的契约都是「一句话」，模型跑题时不该让它占满屏幕。
export const SIDE_ANSWER_MAX_CHARS = 400;

export function normalizeSideAnswer(raw, { maxChars = SIDE_ANSWER_MAX_CHARS } = {}) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === '「' && s.at(-1) === '」'))) {
    s = s.slice(1, -1).trim();
  }
  if (!s) return null;
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}
