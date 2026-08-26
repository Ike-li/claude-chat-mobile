// protocol.js —— web↔server 事件契约的唯一机器可读定义（出向 type 白名单 + 入向事件名白名单）。
//
// 【为什么在 src/shared 而不是 scripts/】这两份清单原先只活在门禁脚本 scripts/agent-event-contract.js 里，
// 运行时零引用——契约的真相源在检查工具里、被检查的代码却看不见它。而边界规则 runtime-no-tooling 又禁止
// src/ 反向 import scripts/，结构上堵死了运行时引用契约的路。上移到叶子层后方向理顺：运行时正向 import，
// 门禁脚本也 import 同一份（scripts/ 不在边界扫描面内，工具引用运行时是合法方向）。
//
// 【改这里的注意事项】入向清单的提取器是裸正则、不跳注释，本文件又在它的扫描面（src/）内——
// 所以本文件的注释里不要出现「注册入向监听」或「广播出向信封」那两种调用形状的字面写法，
// 否则注释会被算进 server 注册面，而入向规则要求注册面与契约双向相等，立刻误报。
//
// 两份清单都逐字保序：入向那份不是严格字典序（hooks/push 两项插在中间），排序只会制造 diff 噪声，
// 且 tests/unit/agent-event-contract.test.mjs 对成员与数量都有断言。

// 出向 agent:event 的 type 白名单。注意其中只有 17 型经 AgentSession 发出，
// 其余走 src/server/* 与 src/auth/device-gate.js 的服务端广播路径。
export const AGENT_EVENT_TYPES = Object.freeze([
  'api_retry',
  'device_status',
  'diag_log',
  'effort_mode',
  'error',
  'history_append',
  'init',
  'instances',
  'mirror_state',
  'models',
  'pending_devices',
  'permission_mode',
  'permission_request',
  'question',
  'request_resolved',
  'result',
  'session_log',
  'status_line',
  'system',
  'task_notification',
  'task_progress',
  'text_delta',
  'thinking_delta',
  'tool_result',
  'tool_use',
  'user_message',
]);

// 入向事件名（客户端 → 服务端）白名单。
export const INBOUND_SOCKET_EVENTS = Object.freeze([
  'browse:list',
  'browse:read',
  'client:presence',
  'config:refresh',
  'conn:ping',
  'dev:restart',
  'doctor:run',
  'env:get',
  'env:set',
  'files:search',
  'files:write',
  'git:diff',
  'git:status',
  'hooks:setup',
  'push:test',
  'logs:clientError',
  'logs:get',
  'mirror:syncNow',
  'service:status',
  'session:close',
  'session:deletePermanent',
  'session:fork',
  'session:history',
  'session:home',
  'session:list',
  'session:new',
  'session:switch',
  'sync:since',
  'task:stop',
  'tool:full',
  'tool:preview',
  'user:ackUnread',
  'user:answer',
  'user:approve',
  'user:approveDevice',
  'user:denyDevice',
  'user:interrupt',
  'user:message',
  'user:setEffort',
  'user:setPermissionMode',
  'user:setViewing',
]);
