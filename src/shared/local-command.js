// local-command.js —— 本地 slash 命令输出（<local-command-stdout|stderr> 包装）的解析口径，
// live 与历史回显共用。
//
// 两个消费方分处两域，故放 src/shared（同 tool-summary.js 的理由）：
//   · src/agent/agent.js      —— SDK 流里的 system/local_command_output
//                                （sdk.d.ts SDKLocalCommandOutputMessage，注释原话 "Displayed as
//                                 assistant-style text in the transcript"）
//   · src/sessions/history.js —— transcript 落盘的 system/local_command
// 同一段正文、同一套包装标签，两边形态必须一致——否则同一条 /usage 输出，live 一个样、刷新后另一个样。
//
// 【为什么有 requireWrapper 两档】两条通道的邻居不同：
//   · SDK 的 local_command_output 这条消息本身就是「输出」语义，裸文本也是正文（sdk.d.ts 只保证
//     content 是 string，没保证一定带包装）→ 宽松档。
//   · transcript 的 local_command 是个大杂烩，同一个 subtype 下还落命令名回显等非输出条目
//     → 严格档，只认整段就是一个完整包装的形态。

// 命令名回显：<command-name>/status</command-name> 是命令【开始】的记录，不是它的输出。
// 只看 subtype 会把回显当成结果——history.js 那边曾因此把进行中的终端回合判成 settled、
// 解锁后双写分叉（2026-07-30 子代理在真盘 f0483015… 会话 idx 879 上抓到）。统一挡在解析口。
const COMMAND_ECHO_RE = /^<command-(?:name|message|args)>/;
// 反向引用 \1 保证开闭标签同类：<local-command-stdout>…</local-command-stderr> 这种半截形态不认。
// 锚在 ^…$：正文里出现形似闭合标签的子串不会把内容截断在中间。
//
// 【匹配不上时的取舍】宽松档（live）会把原文连标签一起当正文上屏，而不是丢弃。刻意如此：
// 匹配不上只可能是 SDK 投了畸形/未知形态，此时「原样显示、多几个尖括号」远好过「静默吞掉一整段输出」
// ——本次要修的病灶恰恰就是内容被静默吞掉。同理，两段包装被拼进一个 content 时内层标签会留在正文里，
// 也接受：真实语料里没见过这种形态（216 条 system/local_command 样本中 0 例），不为它把解析复杂化。
const WRAPPED_RE = /^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>$/;

// web 侧 slash 的裸文本形态：SDK 把用户输入原样落盘/原样送进 CLI，没有终端那套 <command-name> 包装
// （真机 5ed3eb8c 落的就是 "/code-review max 整个分支代码库，最多同时 3 个子代理"）。要求命令名后紧跟
// 空白或行尾，才不会把 "/Users/you/code" 这类以斜杠开头的普通文本误当命令（首段后面是 /，不是空白）。
// 两个消费方：history.js 的 classifyChainTail（尾部形态判定）与 agent.js 的长跑静默提示。
export const WEB_BARE_SLASH_RE = /^\/[a-zA-Z][\w:-]*(\s|$)/;

// 返回 { text, isError } 或 null（null = 这条不是本地命令输出 / 正文为空，调用方据此不产空气泡）。
export function parseLocalCommandOutput(content, { requireWrapper = false } = {}) {
  const raw = typeof content === 'string' ? content.trim() : '';
  if (!raw || COMMAND_ECHO_RE.test(raw)) return null;

  const m = WRAPPED_RE.exec(raw);
  if (!m) return requireWrapper ? null : { text: raw, isError: false };

  const text = m[2].trim();
  return text ? { text, isError: m[1] === 'stderr' } : null;
}
