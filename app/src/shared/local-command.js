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
// 【解析只有一种行为，取舍留给调用点】早先这里有个 requireWrapper 布尔档，两个消费方各传各的，
// 于是同一段 content 在两边能得出相反结论——正是本模块要消灭的分叉，却由它自己引入。现在统一
// 返回 `wrapped`（是否整段就是完整包装），策略回到各自调用点：
//   · src/agent/agent.js      —— SDK 的 local_command_output 本身就是「输出」语义，裸文本也是正文
//     （sdk.d.ts 只保证 content 是 string，没保证带包装）→ 不看 wrapped，一律上屏。
//   · src/sessions/history.js —— transcript 的 local_command 是个大杂烩，同 subtype 下还落别的条目
//     → 只收 wrapped 的那种。
// 两行 if 摆在各自的文件里，比一个藏在共享解析器里的布尔标志更容易看出「这里为什么和那边不一样」。

// 命令名回显：<command-name>/status</command-name> 是命令【开始】的记录，不是它的输出。
// 只看 subtype 会把回显当成结果——history.js 那边曾因此把进行中的终端回合判成 settled、
// 解锁后双写分叉（2026-07-30 子代理在真盘 f0483015… 会话 idx 879 上抓到）。统一挡在解析口。
const COMMAND_ECHO_RE = /^<command-(?:name|message|args)>/;
// 反向引用 \1 保证开闭标签同类：<local-command-stdout>…</local-command-stderr> 这种半截形态不认。
// 逐段扫描而非整段锚定：一个 content 里可以先后落 stdout 段和 stderr 段，旧的单段锚定正则
// （/^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>$/）对这种形态【整体不匹配】，
// 于是 history 侧整条丢弃、live 侧把四个标签当正文原样上屏且 isError 误判 false —— 同一条消息
// 刷新前后两个样（2026-08-04 实测）。非贪婪 *? 让每段就近闭合；段与段之间不允许有游离文本，
// 整段被包装完全覆盖才算 wrapped，所以正文里出现形似标签的子串仍不会把内容截断在中间。
const WRAPPED_SEG_RE = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g;

// 整段是否由「一个或多个首尾相接的完整包装」构成。是则返回各段，否则 null。
function wrappedSegments(raw) {
  const segs = [];
  let cursor = 0;
  for (const m of raw.matchAll(WRAPPED_SEG_RE)) {
    if (m.index !== cursor) return null;        // 段之间/段之前有游离文本 → 不是纯包装形态
    cursor = m.index + m[0].length;
    segs.push({ kind: m[1], body: m[2] });
  }
  return segs.length && cursor === raw.length ? segs : null;
}

// web 侧 slash 的裸文本形态：SDK 把用户输入原样落盘/原样送进 CLI，没有终端那套 <command-name> 包装
// （真机 5ed3eb8c 落的就是 "/code-review max 整个分支代码库，最多同时 3 个子代理"）。要求命令名后紧跟
// 空白或行尾，才不会把 "/Users/you/code" 这类以斜杠开头的普通文本误当命令（首段后面是 /，不是空白）。
// 两个消费方：history.js 的 classifyChainTail（尾部形态判定）与 agent.js 的长跑静默提示。
export const WEB_BARE_SLASH_RE = /^\/[a-zA-Z][\w:-]*(\s|$)/;

// 返回 { text, isError, wrapped } 或 null（null = 这条不是本地命令输出 / 正文为空，
// 调用方据此不产空气泡）。wrapped=false 表示没识别出完整包装，正文是原文——由调用方决定
// 是丢弃（history）还是原样上屏（live）。
export function parseLocalCommandOutput(content) {
  const raw = typeof content === 'string' ? content.trim() : '';
  if (!raw || COMMAND_ECHO_RE.test(raw)) return null;

  const segs = wrappedSegments(raw);
  if (!segs) return { text: raw, isError: false, wrapped: false };

  const text = segs.map(s => s.body.trim()).filter(Boolean).join('\n').trim();
  if (!text) return null;
  return { text, isError: segs.some(s => s.kind === 'stderr'), wrapped: true };
}
