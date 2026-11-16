#!/usr/bin/env node
// tests/fixtures/fake-claude.mjs —— 可驱动的假 CLI（由 fake-claude.sh 在 CCM_FAKE_CLAUDE_MODE
// 显式置位时 exec 进来；不置位时走不到这里，.sh 的默认分支行为逐字不变）。
//
// 【为什么需要它】原 stub 吞掉 stdin、不产出任何输出，于是 S2 层有两条硬约束：
//   ① a.sessionId 恒为 null —— SRV-003 的 `if (a.externalDirty && a.sessionId)` 整条分支不可达；
//   ② 首条消息后 pendingTurns 恒为 1，此后任何第二条有效消息都被 busy 闸挡下 ——
//      SRV-001 的单飞窗口需要「两个并发懒开」，造不出来。
// 2026-09-05 尝试把这两条不变量从源码文本断言搬到 S2 时，都撞在这里。
//
// 【协议不是猜的】把 stub 换成记录 argv+stdin 的版本、跑一次 S2 实测得到：
//   argv: --output-format stream-json --verbose --input-format stream-json
//         --permission-prompt-tool stdio --setting-sources=... --permission-mode default
//         --include-partial-messages
//   stdin（NDJSON）:
//     {"request_id":"…","type":"control_request","request":{"subtype":"initialize",…}}
//     {"type":"user","message":{…},"parent_tool_use_id":null,"session_id":"","uuid":"…"}
//
// 【模式】CCM_FAKE_CLAUDE_MODE：
//   未设置  → 走不到本文件（.sh 的默认分支：吞 stdin、不产出，与 2026-09-05 之前完全一致）
//   init    → 应答 initialize + 首条 user 时吐一条 system/init（带 session_id）。
//             turn 不收尾，实例保持 busy —— 需要「有 sessionId 但仍忙」的用例用这档。
//   turn    → 在 init 之上再吐 assistant 文本与 result，turn 正常收尾、pendingTurns 归零。
//             需要「发得出第二条消息」的用例用这档。
//   turn-bg → 同 turn，但收尾前先吐一条 background_tasks_changed（一个常驻后台 Bash），
//             回合结束后实例停在「pendingTurns=0 但有后台任务」——纯后台任务期（比如 dev server
//             挂着）。形状照 CLI 2.1.263 的 wire schema：task_id / task_type / description。
//   turn-screenshot → 同 turn，但回答前先吐一次截图工具调用：assistant tool_use 与一条带 png 图片块的
//             user tool_result（形态照真 CLI 落盘的 API 形态）。live 截图只存在实例内存里、本文件又不落
//             transcript，所以「图从内存取到了」可以被单独观察到。
//   turn-local-command → 同 turn，但不吐助手正文，改吐一条本地 slash 命令的输出（system/local_command_output，
//             content 带 <local-command-stdout> 包装，形态照 sdk.d.ts SDKLocalCommandOutputMessage）再收尾——
//             /context、/cost 这类命令在 CLI 本地算完、不经模型。
//   turn-elicitation → MCP 服务器要用户填表 / 去浏览器授权（#460）：init 之后先发一条 control_request
//             （subtype:'elicitation'，形状照 sdk.d.ts 的 SDKControlElicitationRequest），等 SDK 回 control_response，
//             再把收到的结果原样写进助手正文（`elicitation → {…}`）后收尾。SDK 没接 onElicitation 时它自己就回
//             {action:'decline'}，所以「回调接上了没有」从正文就能看出来。CCM_FAKE_CLAUDE_ELICIT=url 发 URL 模式，
//             accept 之后再吐一条 system/elicitation_complete。
//   turn-fg-task → 一条跑得久的前台 Bash 挡着本轮（#459）：吐 assistant tool_use 与
//             system/task_started{is_backgrounded:false}，然后不收尾，直到收到 background_tasks 控制请求
//             （SDK Query.backgroundTasks，终端 Ctrl+B）。收到后照 SDK d.ts 描述的次序吐：
//             task_updated{patch.is_backgrounded:true} → background_tasks_changed（它成了后台任务）→
//             「running in the background」的 tool_result → 回答与 result。给的 tool_use_id 对不上回 backgrounded:false。
//             CCM_FAKE_CLAUDE_BG_DISABLED=1 → 那条控制请求回 error，原文照 CLI 2.1.309。
//   turn-autoreport → 同 turn，收尾后再吐一条后台任务完成（system/task_notification）、下一轮的 system/init
//             与 message_start，且那一轮不收尾——实例停在「后台任务完成触发的自动汇报轮正在跑」。
//             没有用户输入的轮次，账面靠 agent 自己合成（maybeSynthesizeAutoTurn）。
//             真 CLI 每轮都先吐 init，且先于 API 请求（2.1.318 实测），这档 2026-11-06 前漏了这一条。
//   turn-autoreport-collide → 手动发送撞上汇报轮。前半段同 turn-autoreport，但汇报轮停在等首字节：吐了
//             task_notification 与 init、还没有 message_start，账面是 0，发送闸放行。下一条 user 进来时排在这一轮
//             后面，次序照真 CLI 2.1.318 实测：command_lifecycle:queued →（隔 CCM_FAKE_CLAUDE_AUTOREPORT_MS）
//             汇报轮的 message_start、正文与不带 user_message_uuid 的 result → command_lifecycle:started →
//             system/init →（隔 CCM_FAKE_CLAUDE_RESULT_DELAY_MS）这条自己的正文与 result。
//   turn-autoreport-tail → 通知落在回合最后一次 API 调用期间：task_notification 在 result 之前，result 之后
//             不报 idle，紧接着 init 起汇报轮，隔 CCM_FAKE_CLAUDE_AUTOREPORT_MS 吐完汇报轮的 result 才报 idle。
//             汇报轮的正文写 CCM_FAKE_CLAUDE_AUTOREPORT_FAIL=1 时改成 is_error + api_error。
//   turn-autoreport-fold → 通知并进当前回合：task_notification 在 result 之前，没有下一轮，result 后直接报 idle。
//   turn-bg-agent → 后台子 agent 占着 CLI：吐 task_started{is_backgrounded:true}，result 之后一直不报 idle，
//             但下一条 user 照常开跑。形态照 CLI 2.1.318 实测。
//   turn-send-now → 立即发送（2026-11-08，形态照 CLI 2.1.319 零 token 实测）。第一条一直不收尾，直到一条带
//             priority:'now' 的 user 进来：先报它 queued，隔 CCM_FAKE_CLAUDE_SEND_NOW_DELAY_MS（真 CLI 等 shell 登记成
//             后台任务约 3 秒）再让路。CCM_FAKE_CLAUDE_SEND_NOW_SHAPE 选形态：
//               yield（缺省）→ 第一轮 result{success, is_error:false, aborted_tools} → 它 cancelled → 这条 started、init、
//                     正文、自己的 result → completed；
//               absorb → 这条 started、completed（并进第一轮，没有自己的 result）→ 正文 → 第一轮 result{completed}。
//             让路之前收到 interrupt：带 cancel_queued 回 {cancelled:[这条]} 并报它 cancelled；不带回 {still_queued:[这条]}，
//             它照跑。然后第一轮出 error_during_execution + aborted_tools。没有排队的 priority:'now' 时 interrupt 照旧回 {}。
//             设了 CCM_FAKE_CLAUDE_RESULT_DELAY_MS 时，没等到 priority:'now' 的第一轮到点正常收尾。
//
// 【能力位】与模式正交：CCM_FAKE_CLAUDE_CAPABILITIES=<逗号分隔> → system/init 带 capabilities（真 CLI 2.1.319 报
//   interrupt_receipt_v1、interrupt_cancel_queued_v1、interrupt_send_now_v1、interrupt_requeue_taken_v1）。不置位时 init 逐字不变。
//
// 【会话状态帧】与模式正交：真 CLI 只在设了 CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1 时才吐
//   system/session_state_changed，这里同样按它开关。回合开始报 running，真正空闲才报 idle。
//   CCM_FAKE_CLAUDE_NO_STATE_FRAMES=1 → 一帧不吐，模拟没有这个帧的旧 CLI。
//
// 【回合晚一点收尾】与模式正交，默认关：
//   CCM_FAKE_CLAUDE_RESULT_DELAY_MS=<毫秒> → turn 系各档在 init 之后隔这么久才吐回答与 result。
//             不设时回合几乎瞬间收尾，「上一条刚开跑、下一条就到」这个窗口在 S2 里造不出来；
//             真模型的回合以秒计，离线队列逐条重放时第 2 条撞上第 1 条的在途轮才是常态。
//
// 【回合中途进程退出】与模式正交，默认关：
//   CCM_FAKE_CLAUDE_EXIT_MID_TURN=1 → 本该吐回答与 result 的那一刻直接 exit(1)，不收尾。模拟进程崩溃，
//             server 走 onExit。要配 CCM_FAKE_CLAUDE_RESULT_DELAY_MS，否则回合还没开就退了。
//
// 【退出前的收尾写入】与模式正交，默认关：
//   CCM_FAKE_CLAUDE_EXIT_APPEND=<transcript 路径> → 读到 stdin EOF 后隔 500ms 往该文件追加一行
//             收尾元数据再退；CCM_FAKE_CLAUDE_EXIT_MARKER=<路径> 在追加之后落一个标记文件，
//             供用例确认「收尾写入已经发生」（否则「文件不在」和「根本没写」分不开）。
//   模拟的是真 CLI 的形态：2026-09-23 实测 CLI 2.1.280，SDK 关 stdin 后 70–80ms 追加 last-prompt /
//   cost-state 等几行、0.6–2s 进程才退；文件已被删掉时这次追加会把它重新建出来。
//   隔 500ms（比真 CLI 慢）是为了把窗口撑开，但必须短于 SDK 关 stdin 后约 2s 的宽限——过了宽限
//   SDK 会 SIGTERM，写入就不会发生了。
//   CCM_FAKE_CLAUDE_EXIT_TITLE=<标题> → 收尾时先追加一条 custom-title。模拟真 CLI 把内存里的会话标题
//   当元数据再写一遍（CLI 2.1.312 源码：追加会话元数据时写 currentSessionTitle），网页刚改的名字就被盖回去（#458）。
//
// 【退出时报写丢】与模式正交，默认关：
//   CCM_FAKE_CLAUDE_EXIT_WRITES_LOST=<错误码，如 ENOSPC> → 读到 stdin EOF 后先吐一条 system/session_writes_lost
//   再退。形状照真 CLI 2.1.318 在写满的卷上实测的帧；真 CLI 同样是 EOF 后、进程退出前发这一条。
//
// 【它仍然不是真 CLI】不跑模型、不认工具、不落 transcript（上面那一行收尾写入除外）。
// 任何需要真回合语义的断言仍归 S5。

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const MODE = process.env.CCM_FAKE_CLAUDE_MODE || 'init';
const CAPABILITIES = process.env.CCM_FAKE_CLAUDE_CAPABILITIES ? process.env.CCM_FAKE_CLAUDE_CAPABILITIES.split(',') : null;
const SEND_NOW_SHAPE = process.env.CCM_FAKE_CLAUDE_SEND_NOW_SHAPE === 'absorb' ? 'absorb' : 'yield';
const SEND_NOW_DELAY_MS = Number(process.env.CCM_FAKE_CLAUDE_SEND_NOW_DELAY_MS) || 0;
const TURN_MODES = new Set([
  'turn', 'turn-bg', 'turn-bg-agent', 'turn-autoreport', 'turn-autoreport-collide', 'turn-autoreport-tail',
  'turn-autoreport-fold', 'turn-screenshot', 'turn-local-command',
]);
// 允许调用方钉死 session_id：镜像 / registry 类用例需要拿这个值去算 transcript 路径。
const SESSION_ID = process.env.CCM_FAKE_CLAUDE_SESSION_ID || randomUUID();
const REPLY = process.env.CCM_FAKE_CLAUDE_REPLY || '(fake-claude) 收到';
// 模型清单。SDK 的 supportedModels() 读的是 **initialize 控制请求响应里的 models 字段**
// （sdk.mjs: `supportedModels(){return(await this.initialization).models}`），不是独立的控制请求——
// 这正是「实例的模型清单在 spawn 那一刻就固化、此后不再向 CLI 问第二次」的物理原因。
// 用 ANTHROPIC_DEFAULT_OPUS_MODEL 造清单而不是新起一个 CCM_FAKE_* 名：agent.js 的
// filterSafeResolvedEnv 只放行 ANTHROPIC_/CLAUDE_CODE_ 前缀，别的名字根本进不到子进程。
// 不置位时 response 仍是 {}，既有 S2 与集成用例建在其上的前提逐字不变（同本文件「显式 opt-in」原则）。
const GATEWAY_MODEL = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || '';
// 真 CLI 在 stream-json 输入模式下每一轮都先吐一条 system/init，model 是这次 spawn 解析出的真实模型名。
// 显式 opt-in（CCM_FAKE_CLAUDE_INIT_EACH_TURN=1）才这样做：init 每轮都吐、model 回显 GATEWAY_MODEL；
// 不置位时仍只吐一次、model 恒为 'fake-claude'，既有用例的前提逐字不变。
const INIT_EACH_TURN = process.env.CCM_FAKE_CLAUDE_INIT_EACH_TURN === '1';
// 清单元素的 value 默认恒为 'opus'（只有 displayName 跟网关走），modelListSignature 按 value 比，换网关名看不出
// 清单变了。显式 opt-in（CCM_FAKE_CLAUDE_MODEL_VALUE_FROM_GATEWAY=1）才让 value 也取 GATEWAY_MODEL，
// 供需要「scout 发现清单变了」那条路径的用例使用；不置位时既有用例的前提逐字不变。
const MODEL_VALUE_FROM_GATEWAY = process.env.CCM_FAKE_CLAUDE_MODEL_VALUE_FROM_GATEWAY === '1';
// 网关侧改了清单（settings 一字未改）：显式 opt-in（CCM_FAKE_CLAUDE_MODEL_LIST_FILE=<路径>）时，清单里唯一那个模型
// 取 spawn 那一刻该文件的内容，不跟 settings 走——ccm 的 settings 快照看不出这种变化，只有 scout 比对清单能发现。
// 不置位时既有用例的前提逐字不变。
const LISTED_MODEL = process.env.CCM_FAKE_CLAUDE_MODEL_LIST_FILE
  ? readFileSync(process.env.CCM_FAKE_CLAUDE_MODEL_LIST_FILE, 'utf8').trim() : '';
// MCP（#457）：mcpServerStatus() 发 mcp_status 控制请求、读响应的 mcpServers；reconnect / toggle 失败时 CLI 回
// subtype:'error'，SDK 据此抛错。显式 opt-in 才这样应答：CCM_FAKE_CLAUDE_MCP_STATUS=<McpServerStatus[] 的 JSON>，
// CCM_FAKE_CLAUDE_MCP_RECONNECT_ERROR=<错误文本>；CCM_FAKE_CLAUDE_CONTROL_LOG=<路径> 把收到的每个控制请求按行记下，
// 供用例核对参数确实到了 CLI。不置位时一律照旧回 success + {}。
const MCP_STATUS = process.env.CCM_FAKE_CLAUDE_MCP_STATUS ? JSON.parse(process.env.CCM_FAKE_CLAUDE_MCP_STATUS) : null;
const MCP_RECONNECT_ERROR = process.env.CCM_FAKE_CLAUDE_MCP_RECONNECT_ERROR || '';
const CONTROL_LOG = process.env.CCM_FAKE_CLAUDE_CONTROL_LOG || '';
// 后台任务输出：getTaskOutput() 发 get_task_output 控制请求。显式 opt-in（CCM_FAKE_CLAUDE_TASK_OUTPUT=<{task_id: 回包} 的 JSON>）
// 才这样应答，回包形状和表外 id 的报错原文照 CLI 2.1.318 零 token 实测。不置位时照旧回 success + {}。
const TASK_OUTPUT = process.env.CCM_FAKE_CLAUDE_TASK_OUTPUT ? JSON.parse(process.env.CCM_FAKE_CLAUDE_TASK_OUTPUT) : null;
// 斜杠命令清单（#456）。SDK 的 supportedCommands() 同样读 initialize 响应（commands 字段），真 CLI 的 system/init
// 只带名字（slash_commands: string[]）。显式 opt-in（CCM_FAKE_CLAUDE_COMMANDS=<SlashCommand[] 的 JSON>）才两处都带；
// 不置位时 initialize 响应与 init 逐字不变。
const COMMANDS = process.env.CCM_FAKE_CLAUDE_COMMANDS ? JSON.parse(process.env.CCM_FAKE_CLAUDE_COMMANDS) : null;
const EXIT_APPEND = process.env.CCM_FAKE_CLAUDE_EXIT_APPEND || '';
// turn-screenshot 档的截图：固定 id 与 1×1 PNG，用例据此拼引用 t:<id>:0、比对取回的数据
const SCREENSHOT_TOOL_USE_ID = 'toolu_fake_screenshot';
const SCREENSHOT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X2Xb0AAAAASUVORK5CYII=';
const EXIT_MARKER = process.env.CCM_FAKE_CLAUDE_EXIT_MARKER || '';
const EXIT_WRITES_LOST = process.env.CCM_FAKE_CLAUDE_EXIT_WRITES_LOST || '';
const EXIT_TITLE = process.env.CCM_FAKE_CLAUDE_EXIT_TITLE || '';
const RESULT_DELAY_MS = Number(process.env.CCM_FAKE_CLAUDE_RESULT_DELAY_MS) || 0;
const EXIT_MID_TURN = process.env.CCM_FAKE_CLAUDE_EXIT_MID_TURN === '1';
const AUTOREPORT_MS = Number(process.env.CCM_FAKE_CLAUDE_AUTOREPORT_MS) || 0;
const BG_DISABLED = process.env.CCM_FAKE_CLAUDE_BG_DISABLED === '1';
const FG_TOOL_USE_ID = 'toolu_fake_fg';
const FG_TASK_ID = 'fake-fg-task';
let fgPendingMsg = null; // turn-fg-task：被前台任务挡着、还没收尾的那条 user 消息
let autoReportState = 'none'; // turn-autoreport-collide：none → waiting（汇报轮等首字节）→ done
let autoReportDone = false;   // turn-autoreport-tail：汇报轮只起一次

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const STATE_FRAMES = process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === '1' && process.env.CCM_FAKE_CLAUDE_NO_STATE_FRAMES !== '1';
const AUTOREPORT_FAIL = process.env.CCM_FAKE_CLAUDE_AUTOREPORT_FAIL === '1';
let cliState = 'idle';

function emitState(state) {
  if (!STATE_FRAMES || cliState === state) return;
  cliState = state;
  out({ type: 'system', subtype: 'session_state_changed', state, uuid: randomUUID(), session_id: SESSION_ID });
}

function emitInit() {
  out({
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
    uuid: randomUUID(),
    cwd: process.cwd(),
    tools: [],
    model: (INIT_EACH_TURN && GATEWAY_MODEL) || 'fake-claude',
    permissionMode: 'default',
    ...(COMMANDS ? { slash_commands: COMMANDS.map(c => c.name) } : {}),
    ...(CAPABILITIES ? { capabilities: CAPABILITIES } : {}),
  });
}

function emitLifecycle(state, msg) {
  out({ type: 'command_lifecycle', command_uuid: msg.uuid, state, uuid: randomUUID(), session_id: SESSION_ID });
}

function emitBgTaskDone() {
  out({
    type: 'system',
    subtype: 'task_notification',
    session_id: SESSION_ID,
    uuid: randomUUID(),
    task_id: 'fake-bg-task',
    status: 'completed',
    summary: '后台任务跑完了',
  });
}

function emitAutoReportTurn() {
  emitMessageStart();
  out({
    type: 'assistant', session_id: SESSION_ID, uuid: randomUUID(), parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: '(fake-claude) 汇报' }] },
  });
  out({
    type: 'result', subtype: 'success', session_id: SESSION_ID, uuid: randomUUID(), is_error: AUTOREPORT_FAIL,
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: '(fake-claude) 汇报', total_cost_usd: 0,
    terminal_reason: AUTOREPORT_FAIL ? 'api_error' : 'completed',
  });
}

function emitMessageStart() {
  out({
    type: 'stream_event',
    session_id: SESSION_ID,
    uuid: randomUUID(),
    parent_tool_use_id: null,
    event: { type: 'message_start', message: { id: `msg_${randomUUID()}` } },
  });
}

// 手动消息排在等首字节的汇报轮后面：汇报轮先跑完，这条才开跑，见文件头 turn-autoreport-collide
function queueBehindAutoReport(msg) {
  autoReportState = 'done';
  emitLifecycle('queued', msg);
  setTimeout(() => {
    emitAutoReportTurn();
    emitLifecycle('started', msg);
    emitInit();
    setTimeout(() => {
      finishTurn(msg);
      emitLifecycle('completed', msg);
    }, RESULT_DELAY_MS);
  }, AUTOREPORT_MS);
}

let announcedInit = false;
const ELICIT_REQUEST_ID = 'fake-elicit-1';
const ELICIT_URL_MODE = process.env.CCM_FAKE_CLAUDE_ELICIT === 'url';
let elicitTurn = null;

function sendElicitation(msg) {
  elicitTurn = msg;
  out({
    type: 'control_request',
    request_id: ELICIT_REQUEST_ID,
    request: ELICIT_URL_MODE
      ? { subtype: 'elicitation', mcp_server_name: 'fake-notes', message: '去浏览器授权', mode: 'url', url: 'https://auth.example.com/authorize?state=1', elicitation_id: 'fake-el-1' }
      : {
        subtype: 'elicitation', mcp_server_name: 'fake-notes', message: '新笔记叫什么？', mode: 'form',
        requested_schema: { type: 'object', properties: { name: { type: 'string', minLength: 2 }, pin: { type: 'boolean' } }, required: ['name'] },
      },
  });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }   // 非 JSON 行忽略，不炸

  // 任何 control_request 一律回 success。不认的子类型也要应答——SDK 在
  // pendingControlResponses 里等着，不回它会把调用方挂死（比产出错内容更难查）。
  if (msg.type === 'control_response' && msg.response?.request_id === ELICIT_REQUEST_ID && elicitTurn) {
    const result = msg.response.subtype === 'success' ? msg.response.response : { error: msg.response.error };
    if (ELICIT_URL_MODE && result?.action === 'accept') {
      out({ type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'fake-notes', elicitation_id: 'fake-el-1', uuid: randomUUID(), session_id: SESSION_ID });
    }
    const turn = elicitTurn;
    elicitTurn = null;
    finishTurn(turn, `elicitation → ${JSON.stringify(result)}`);
    return;
  }

  if (msg.type === 'control_request' && msg.request?.subtype === 'background_tasks') {
    answerBackgroundTasks(msg);
    return;
  }
  if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt' && sendNow.queued) {
    if (CONTROL_LOG) appendFileSync(CONTROL_LOG, `${JSON.stringify(msg.request)}\n`);
    stopBeforeYield(msg);
    return;
  }
  if (msg.type === 'control_request') {
    if (CONTROL_LOG) appendFileSync(CONTROL_LOG, `${JSON.stringify(msg.request)}\n`);
    if (MCP_RECONNECT_ERROR && msg.request?.subtype === 'mcp_reconnect') {
      out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: MCP_RECONNECT_ERROR } });
      return;
    }
    if (TASK_OUTPUT && msg.request?.subtype === 'get_task_output') {
      const answer = TASK_OUTPUT[msg.request.task_id];
      out({
        type: 'control_response',
        response: answer
          ? { subtype: 'success', request_id: msg.request_id, response: answer }
          : { subtype: 'error', request_id: msg.request_id, error: 'get_task_output: no shell or Monitor task with that task_id in this session' },
      });
      return;
    }
    if (MCP_STATUS && msg.request?.subtype === 'mcp_status') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mcpServers: MCP_STATUS } } });
      return;
    }
    const models = msg.request?.subtype !== 'initialize' ? {}
      : LISTED_MODEL ? { models: [{ value: LISTED_MODEL, displayName: LISTED_MODEL, resolvedModel: LISTED_MODEL }] }
        : GATEWAY_MODEL ? { models: [{ value: MODEL_VALUE_FROM_GATEWAY ? GATEWAY_MODEL : 'opus', displayName: GATEWAY_MODEL, resolvedModel: GATEWAY_MODEL }] }
          : {};
    const payload = msg.request?.subtype === 'initialize' && COMMANDS ? { ...models, commands: COMMANDS } : models;
    out({
      type: 'control_response',
      response: { subtype: 'success', request_id: msg.request_id, response: payload },
    });
    return;
  }

  if (msg.type !== 'user') return;

  if (autoReportState === 'waiting') { queueBehindAutoReport(msg); return; }
  if (MODE === 'turn-send-now' && sendNow.running && msg.priority === 'now') { queueSendNow(msg); return; }

  emitState('running');
  if (!announcedInit || INIT_EACH_TURN) {
    announcedInit = true;
    emitInit();
  }

  if (MODE === 'turn-elicitation') { sendElicitation(msg); return; }
  if (MODE === 'turn-fg-task') {
    startForegroundTask(msg);
    return;
  }
  if (MODE === 'turn-send-now' && !sendNow.running) {
    sendNow.running = msg;
    emitLifecycle('queued', msg);
    emitLifecycle('started', msg);
    // 设了 RESULT_DELAY_MS 时到点照常收尾（没有立即发送进来的话）：给「不支持立即发送、照旧排队」的用例用
    if (RESULT_DELAY_MS > 0) {
      setTimeout(() => {
        if (sendNow.running !== msg || sendNow.queued) return;
        sendNow.running = null;
        finishTurn(msg);
        emitLifecycle('completed', msg);
      }, RESULT_DELAY_MS);
    }
    return;
  }

  if (!TURN_MODES.has(MODE)) return;

  if (RESULT_DELAY_MS > 0) setTimeout(() => (EXIT_MID_TURN ? process.exit(1) : finishTurn(msg)), RESULT_DELAY_MS);
  else finishTurn(msg);
});

// turn-send-now：第一轮挂着，等一条 priority:'now'，见文件头
const sendNow = { running: null, queued: null, timer: null };
const sendNowResult = (msg, over = {}) => ({
  type: 'result', subtype: 'success', session_id: SESSION_ID, uuid: randomUUID(), user_message_uuid: msg.uuid ?? null,
  is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: '', total_cost_usd: 0, terminal_reason: 'completed', ...over,
});
const sendNowReply = () => out({
  type: 'assistant', session_id: SESSION_ID, uuid: randomUUID(), parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text: REPLY }] },
});

function queueSendNow(msg) {
  sendNow.queued = msg;
  emitLifecycle('queued', msg);
  sendNow.timer = setTimeout(yieldToSendNow, SEND_NOW_DELAY_MS);
}

function yieldToSendNow() {
  const { running: a, queued: b } = sendNow;
  sendNow.queued = null;
  sendNow.timer = null;
  if (SEND_NOW_SHAPE === 'absorb') {
    emitLifecycle('started', b);
    emitLifecycle('completed', b);
    sendNowReply();
    out(sendNowResult(a));
    emitLifecycle('completed', a);
  } else {
    out(sendNowResult(a, { terminal_reason: 'aborted_tools' }));
    emitLifecycle('cancelled', a);
    emitLifecycle('started', b);
    emitInit();
    sendNowReply();
    out(sendNowResult(b));
    emitLifecycle('completed', b);
  }
  sendNow.running = null;
  emitState('idle');
}

function stopBeforeYield(msg) {
  const { running: a, queued: b } = sendNow;
  clearTimeout(sendNow.timer);
  sendNow.queued = null;
  sendNow.timer = null;
  const cancel = msg.request.cancel_queued === true;
  out({
    type: 'control_response',
    response: { subtype: 'success', request_id: msg.request_id, response: cancel ? { still_queued: [], cancelled: [b.uuid] } : { still_queued: [b.uuid] } },
  });
  if (cancel) emitLifecycle('cancelled', b);
  // errors 必须带：SDK 读 error_during_execution 时对它 .map，缺了直接抛（真 CLI 带一条 ede_diagnostic）
  out(sendNowResult(a, {
    subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools',
    errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'],
  }));
  emitLifecycle('cancelled', a);
  sendNow.running = null;
  if (cancel) { emitState('idle'); return; }
  emitLifecycle('started', b);
  emitInit();
  sendNowReply();
  out(sendNowResult(b));
  emitLifecycle('completed', b);
  emitState('idle');
}

function startForegroundTask(msg) {
  fgPendingMsg = msg;
  out({
    type: 'assistant', session_id: SESSION_ID, uuid: randomUUID(), parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: FG_TOOL_USE_ID, name: 'Bash', input: { command: 'sleep 120 && echo done' } }] },
  });
  out({
    type: 'system', subtype: 'task_started', session_id: SESSION_ID, uuid: randomUUID(),
    task_id: FG_TASK_ID, tool_use_id: FG_TOOL_USE_ID, description: 'sleep 120 && echo done',
    task_type: 'local_bash', is_backgrounded: false,
  });
}

function answerBackgroundTasks(msg) {
  if (BG_DISABLED) {
    out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'Background tasks are disabled in this session.' } });
    return;
  }
  const target = msg.request?.tool_use_id;
  const hit = fgPendingMsg && (target == null || target === FG_TOOL_USE_ID);
  out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { backgrounded: Boolean(hit) } } });
  if (!hit) return;
  const pending = fgPendingMsg;
  fgPendingMsg = null;
  out({ type: 'system', subtype: 'task_updated', session_id: SESSION_ID, uuid: randomUUID(), task_id: FG_TASK_ID, patch: { is_backgrounded: true } });
  out({
    type: 'system', subtype: 'background_tasks_changed', session_id: SESSION_ID, uuid: randomUUID(),
    tasks: [{ task_id: FG_TASK_ID, task_type: 'local_bash', description: 'sleep 120 && echo done' }],
  });
  out({
    type: 'user', session_id: SESSION_ID, uuid: randomUUID(), parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: FG_TOOL_USE_ID, content: `Command running in background with ID: ${FG_TASK_ID}` }] },
  });
  finishTurn(pending);
}

function finishTurn(msg, reply = REPLY) {
  if (MODE === 'turn-screenshot') {
    out({
      type: 'assistant',
      session_id: SESSION_ID,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: SCREENSHOT_TOOL_USE_ID, name: 'mcp__claude-in-chrome__computer', input: { action: 'screenshot' } }] },
    });
    out({
      type: 'user',
      session_id: SESSION_ID,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: SCREENSHOT_TOOL_USE_ID, content: [
        { type: 'text', text: 'Took screenshot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SCREENSHOT_PNG } },
      ] }] },
    });
  }

  if (MODE === 'turn-local-command') {
    out({
      type: 'system',
      subtype: 'local_command_output',
      session_id: SESSION_ID,
      uuid: randomUUID(),
      content: `<local-command-stdout>${reply}</local-command-stdout>`,
    });
  } else {
    out({
      type: 'assistant',
      session_id: SESSION_ID,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: reply }] },
    });
  }
  if (MODE === 'turn-bg') {
    out({
      type: 'system',
      subtype: 'background_tasks_changed',
      session_id: SESSION_ID,
      uuid: randomUUID(),
      tasks: [{ task_id: 'fake-bg-dev-server', task_type: 'local_bash', description: 'npm run dev' }],
    });
  }
  if (MODE === 'turn-bg-agent') {
    out({
      type: 'system', subtype: 'task_started', session_id: SESSION_ID, uuid: randomUUID(),
      task_id: 'fake-bg-agent', task_type: 'local_agent', is_backgrounded: true, description: '后台子 agent',
    });
  }
  if ((MODE === 'turn-autoreport-tail' && !autoReportDone) || MODE === 'turn-autoreport-fold') emitBgTaskDone();
  // user_message_uuid 原样回传：agent.js 的 _settleOneResultTurn 优先按 uuid 精确出槽，
  // 回传得对就不必依赖 FIFO 回落。
  out({
    type: 'result',
    subtype: 'success',
    session_id: SESSION_ID,
    uuid: randomUUID(),
    user_message_uuid: msg.uuid ?? null,
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: reply,
    total_cost_usd: 0,
  });
  if (MODE === 'turn-autoreport') {
    emitBgTaskDone();
    emitInit();
    // 模型被通知唤起、自动开讲：只有流式的 message_start，这一轮不吐 result
    emitMessageStart();
  }
  if (MODE === 'turn-autoreport-collide' && autoReportState === 'none') {
    emitBgTaskDone();
    emitInit();
    autoReportState = 'waiting';
  }
  if (MODE === 'turn-autoreport-tail' && !autoReportDone) {
    autoReportDone = true;
    emitInit();
    setTimeout(() => {
      emitAutoReportTurn();
      emitState('idle');
    }, AUTOREPORT_MS);
    return;
  }
  // 汇报轮紧跟、后台子 agent 占着：CLI 没闲下来，不报 idle
  if (MODE !== 'turn-autoreport' && MODE !== 'turn-autoreport-collide' && MODE !== 'turn-bg-agent') emitState('idle');
  else if (MODE === 'turn-autoreport-collide' && autoReportState === 'done') emitState('idle');
}

// 读到 EOF 才退。提前退出会让 SDK 那次 write 抛 EPIPE，而它在 sdk.mjs 内部不被 catch，
// 直接冒成 uncaughtException 打死整个测试进程（原 .sh 的头注记录过这次事故）。
rl.on('close', () => {
  if (EXIT_WRITES_LOST) {
    out({
      type: 'system', subtype: 'session_writes_lost', error_code: EXIT_WRITES_LOST, lost: ['transcript'],
      transcript_session_ids: [SESSION_ID], uuid: randomUUID(), session_id: SESSION_ID,
    });
  }
  if (!EXIT_APPEND) process.exit(0);
  setTimeout(() => {
    if (EXIT_TITLE) appendFileSync(EXIT_APPEND, `${JSON.stringify({ type: 'custom-title', customTitle: EXIT_TITLE, sessionId: SESSION_ID })}\n`);
    appendFileSync(EXIT_APPEND, `${JSON.stringify({ type: 'cost-state', sessionId: SESSION_ID })}\n`);
    if (EXIT_MARKER) writeFileSync(EXIT_MARKER, '');
    process.exit(0);
  }, 500);
});
