import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
// 契约真相源在 src/shared/protocol.js（运行时也 import 同一份，出向 emit 据此自检）。这里 import 后
// 原样再导出：既有 import 面不变（tests/unit/agent-event-contract.test.mjs 直接从本模块取用），
// 本文件内部两个 check 的默认参数也仍拿得到本地绑定。
import { AGENT_EVENT_TYPES, INBOUND_SOCKET_EVENTS } from '../src/shared/protocol.js';

export { AGENT_EVENT_TYPES, INBOUND_SOCKET_EVENTS };

const ROOT = join(import.meta.dirname, '..');


// 出向真实发射面。agent.js 走 agent-session 提取器（AgentSession 的 this.emit(...)）；其余一律按
// `xxx.emit('agent:event', {...})` 提取。**目录递归而非手写文件清单**——与入向 serverDirs=['src'] 同口径。
// 手写清单的代价是实测出来的：src/auth/device-gate.js（device_status/pending_devices）与
// src/server/socket.js（error）一直在发 agent:event，却完全在门禁视野外；在 src/ 下新建模块发一个未登记
// type，npm run check 照样全绿，而前端 dispatcher 对未知 type 是静默丢弃——正是这道门禁存在的理由。
const REAL_SESSION_SOURCE = Object.freeze({ path: 'src/agent/agent.js', kind: 'agent-session' });
const REAL_EMIT_DIRS = Object.freeze(['src']);

function defaultRealSources(rootDir) {
  const emitFiles = REAL_EMIT_DIRS.flatMap(dir => listJsFiles(rootDir, dir));
  return [REAL_SESSION_SOURCE, ...emitFiles.map(path => ({ path, kind: 'agent-event-emit' }))];
}

const MOCK_SOURCES = Object.freeze([
  { path: 'tests/e2e/mock/server.js', kind: 'agent-event-emit' },
  { path: 'tests/e2e/mock/scenarios/content.js', kind: 'agent-event-emit' },
  { path: 'tests/e2e/mock/scenarios/status.js', kind: 'agent-event-emit' },
]);

function lineColumn(source, index) {
  const prefix = source.slice(0, index);
  const lines = prefix.split('\n');
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

function skipQuoted(source, index, quote) {
  let i = index + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return source.length;
}

function skipLineComment(source, index) {
  const end = source.indexOf('\n', index + 2);
  return end === -1 ? source.length : end + 1;
}

function skipBlockComment(source, index) {
  const end = source.indexOf('*/', index + 2);
  return end === -1 ? source.length : end + 2;
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(source, i, ch) - 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i = skipLineComment(source, i) - 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i = skipBlockComment(source, i) - 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readIdentifier(source, index) {
  const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(index));
  return match ? match[0] : null;
}

function skipWhitespace(source, index) {
  let i = index;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  return i;
}

function findTopLevelTypeExpressions(source, objectStart, objectEnd) {
  const expressions = [];
  let depth = 0;

  for (let i = objectStart; i <= objectEnd; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(source, i, ch) - 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i = skipLineComment(source, i) - 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i = skipBlockComment(source, i) - 1;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      continue;
    }

    if (depth !== 1) continue;
    if (readIdentifier(source, i) !== 'type') continue;

    let cursor = skipWhitespace(source, i + 'type'.length);
    if (source[cursor] !== ':') continue;
    const expressionStart = cursor + 1;
    cursor = expressionStart;

    let exprDepth = 0;
    while (cursor <= objectEnd) {
      const cur = source[cursor];
      const after = source[cursor + 1];
      if (cur === '"' || cur === "'" || cur === '`') {
        cursor = skipQuoted(source, cursor, cur);
        continue;
      }
      if (cur === '/' && after === '/') {
        cursor = skipLineComment(source, cursor);
        continue;
      }
      if (cur === '/' && after === '*') {
        cursor = skipBlockComment(source, cursor);
        continue;
      }
      if (cur === '{' || cur === '[' || cur === '(') exprDepth += 1;
      else if (cur === '}' || cur === ']' || cur === ')') {
        if (exprDepth === 0 && cur === '}') break;
        exprDepth -= 1;
      } else if (cur === ',' && exprDepth === 0) {
        break;
      }
      cursor += 1;
    }

    expressions.push({
      expression: source.slice(expressionStart, cursor).trim(),
      index: expressionStart,
    });
    i = cursor;
  }

  return expressions;
}

function extractStringLiterals(expression) {
  const values = [];
  const literalPattern = /(['"])((?:\\.|(?!\1).)*)\1/g;
  let match;
  while ((match = literalPattern.exec(expression))) {
    values.push(match[2]);
  }
  return values;
}

function addType(result, type, source, file, index) {
  result.types.add(type);
  result.locations.push({
    type,
    file,
    ...lineColumn(source, index),
  });
}

function extractAgentSessionEmitTypes(source, file) {
  const result = { types: new Set(), locations: [], dynamic: [] };
  const emitPattern = /\bthis\.emit(?:Transient)?\s*\(\s*(['"])([A-Za-z0-9_:-]+)\1/g;
  let match;
  while ((match = emitPattern.exec(source))) {
    addType(result, match[2], source, file, match.index);
  }
  return result;
}

function extractAgentEventObjectTypes(source, file) {
  const result = { types: new Set(), locations: [], dynamic: [] };
  // (?:\.to\([^)]*\))? 容许中间插入一次 .to(room)（SEC-01：io.to('approved').emit(...) 房间过滤广播，
  // 与 io.emit(...) 同为真实广播路径，静态扫描须一视同仁，否则会把仍在发出的类型误判为"real 不再发出"。
  // .in(room) 是 socket.io 里 .to(room) 的精确别名，同为真实广播路径；接收者允许多段（this.io.sockets）
  // 与可选链（socket?.emit）——这几种写法此前都会静默不匹配，等于把该文件的全部 type 从 real 集合里抹掉。
  const emitPattern = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\.(?:to|in)\([^)]*\))?\??\.emit\s*\(\s*(['"])agent:event\1\s*,/g;
  while (emitPattern.exec(source)) {
    const cursor = skipWhitespace(source, emitPattern.lastIndex);
    if (source[cursor] !== '{') continue;

    const end = findMatchingBrace(source, cursor);
    if (end === -1) {
      result.dynamic.push({
        file,
        ...lineColumn(source, cursor),
        reason: 'unmatched agent:event object literal',
      });
      continue;
    }

    const expressions = findTopLevelTypeExpressions(source, cursor, end);
    if (expressions.length === 0) {
      result.dynamic.push({
        file,
        ...lineColumn(source, cursor),
        reason: 'agent:event object literal has no top-level type field',
      });
      continue;
    }

    for (const { expression, index } of expressions) {
      const literals = extractStringLiterals(expression);
      if (literals.length === 0) {
        result.dynamic.push({
          file,
          ...lineColumn(source, index),
          reason: `agent:event type is dynamic: ${expression}`,
        });
        continue;
      }
      for (const type of literals) addType(result, type, source, file, index);
    }
  }

  return result;
}

export function extractAgentEventTypes(source, { kind = 'agent-event-emit', file = '<source>' } = {}) {
  if (kind === 'agent-session') return extractAgentSessionEmitTypes(source, file);
  if (kind === 'agent-event-emit') return extractAgentEventObjectTypes(source, file);
  throw new Error(`Unknown agent event source kind: ${kind}`);
}

function collectTypes(rootDir, sources) {
  const types = new Set();
  const locations = [];
  const dynamic = [];

  for (const source of sources) {
    const file = source.path;
    const fullPath = join(rootDir, file);
    const text = readFileSync(fullPath, 'utf8');
    const extracted = extractAgentEventTypes(text, { kind: source.kind, file });

    for (const type of extracted.types) types.add(type);
    locations.push(...extracted.locations);
    dynamic.push(...extracted.dynamic);
  }

  return { types, locations, dynamic };
}

function addUnknownTypeProblems(problems, side, observedTypes, contractTypes) {
  for (const type of [...observedTypes].sort()) {
    if (contractTypes.has(type)) continue;
    problems.push({
      code: `${side}_type_not_contract`,
      type,
      message: `${side} emits uncontracted agent:event type "${type}"`,
    });
  }
}

// 真实侧发得出、但 visual mock 有意不产出的 type。清单为空即"两侧必须完全对齐"；
// 每加一条都要写清为什么 E2E 覆盖不了它，否则这道闸就退化成许愿池。
const MOCK_EXEMPT_TYPES = Object.freeze(new Set([]));

export function checkAgentEventContract({
  rootDir = ROOT,
  contractTypes = new Set(AGENT_EVENT_TYPES),
  realSources = null,
  mockSources = MOCK_SOURCES,
  mockExemptTypes = MOCK_EXEMPT_TYPES,
} = {}) {
  const normalizedContractTypes = new Set(contractTypes);
  const real = collectTypes(rootDir, realSources || defaultRealSources(rootDir));
  const mock = collectTypes(rootDir, mockSources);
  const problems = [];

  addUnknownTypeProblems(problems, 'real', real.types, normalizedContractTypes);
  addUnknownTypeProblems(problems, 'mock', mock.types, normalizedContractTypes);

  for (const type of [...mock.types].sort()) {
    if (real.types.has(type)) continue;
    problems.push({
      code: 'mock_type_not_real',
      type,
      message: `visual mock emits agent:event type "${type}" that real server/agent paths do not emit`,
    });
  }

  // 反向同样要查。此前只有 mock ⊆ real 一个方向：real 新增第 N+1 个 type 时 mock 停在 N 条，
  // npm run check 照样全绿，于是那类事件【永远进不了 E2E 视野】且无人知道——而前端 dispatcher
  // 对未知 type 是静默丢弃，正是这道门禁存在的理由。2026-08-02 补：两侧当时恰好都是 26，
  // 对齐纯属巧合，没有任何机制守着。
  // 确实不该由 mock 覆盖的 type 放进 MOCK_EXEMPT_TYPES 并写清理由，别改判据。
  for (const type of [...real.types].sort()) {
    if (mock.types.has(type) || mockExemptTypes.has(type)) continue;
    problems.push({
      code: 'real_type_not_mock',
      type,
      message: `real server/agent emits agent:event type "${type}" that the visual mock never produces — E2E can't cover it`,
    });
  }

  // 第五个方向：契约 ⊆ real。前四个方向合起来仍漏一种情况——契约表里挂着一个【谁都不发】的 type：
  // real 不发它，所以 real ⊆ contract 过；mock 不发它，所以 mock ⊆ contract 与 mock ⊆ real 都过；
  // real ⊆ mock 只遍历 real，压根看不见它。于是 type 下线或改名后残留的死名字永远静默全绿，而
  // AGENT_EVENT_TYPES 是给人读的权威清单，读表的人会以为它还活着。入向侧早有对称的
  // contract_inbound_not_registered，出向缺这一条是历史遗留，不是有意取舍。
  for (const type of [...normalizedContractTypes].sort()) {
    if (real.types.has(type)) continue;
    // mock 还在发的 type 已由 mock_type_not_real 报过——那是"mock 发明了 real 没有的事件"，
    // 与这里的"契约挂着死名字"是同一个根因（real 不发它）、同一个修复动作。同入向
    // contract_inbound_not_mocked 跳过未注册事件的理由：一个根因不报两条。
    if (mock.types.has(type)) continue;
    problems.push({
      code: 'contract_type_not_real',
      type,
      message: `contract lists agent:event type "${type}" that no real server/agent path emits — remove it from AGENT_EVENT_TYPES, or wire the emitter`,
    });
  }

  for (const dynamic of [...real.dynamic, ...mock.dynamic]) {
    problems.push({
      code: 'dynamic_type',
      type: null,
      message: `${dynamic.file}:${dynamic.line}:${dynamic.column} ${dynamic.reason}`,
    });
  }

  return {
    problems,
    contractTypes: normalizedContractTypes,
    realTypes: real.types,
    mockTypes: mock.types,
    realLocations: real.locations,
    mockLocations: mock.locations,
    rootDir,
  };
}

export function formatContractProblems(result) {
  if (result.problems.length === 0) {
    return [
      `agent:event contract OK`,
      `real types: ${result.realTypes.size}`,
      `mock types: ${result.mockTypes.size}`,
      `root: ${relative(process.cwd(), result.rootDir) || '.'}`,
    ].join('\n');
  }

  return result.problems
    .map(problem => `[${problem.code}] ${problem.message}`)
    .join('\n');
}

// ---- 入向 socket 事件契约（客户端 → 服务端）----
// 出向 agent:event 的 type 有上方 allowlist 机器校验；入向事件名此前只活在
// docs/interfaces.md 的手写表格里，漂移无人拦——本节把它升级为同等保真：
// server 注册面 = 契约（双向相等）、前端 emit 面 ⊆ 契约、visual mock 注册面 ⊆ 契约。
// 清单本身已上移至 src/shared/protocol.js（见文件头）。

// socket.io 内建连接生命周期事件：属传输层而非业务契约
const BUILTIN_SOCKET_EVENTS = new Set([
  'connect',
  'connection',
  'connect_error',
  'disconnect',
  'disconnecting',
  'error',
  'reconnect',
]);

// 目录递归收集 .js/.mjs（新增模块自动纳入扫描面，不靠手工登记文件清单）
function listJsFiles(rootDir, dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(join(rootDir, dir), { withFileTypes: true });
  } catch {
    return files; // 扫描根缺失（如测试夹具只建了一侧）→ 空面
  }
  for (const entry of entries) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJsFiles(rootDir, rel));
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(rel);
  }
  return files.sort();
}

// kind 'socket-server'：registrar 形 on(socket, 'x', …) + 裸 socket.on('x', …) 都算注册面
// kind 'socket-client-emit'：任意接收者的 .emit('x', …) 字面量（前端只应 emit 契约内事件）
export function extractInboundSocketEvents(source, { kind, file = '<source>' } = {}) {
  const result = { events: new Set(), locations: [] };
  const patterns =
    kind === 'socket-server'
      ? [/\bon\(\s*socket\s*,\s*(['"])([^'"]+)\1/g, /\bsocket\.on\(\s*(['"])([^'"]+)\1/g]
      : kind === 'socket-client-emit'
        ? [/\.emit\(\s*(['"])([^'"]+)\1/g]
        : null;
  if (!patterns) throw new Error(`Unknown inbound socket source kind: ${kind}`);

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const event = match[2];
      if (BUILTIN_SOCKET_EVENTS.has(event)) continue;
      result.events.add(event);
      result.locations.push({ event, file, ...lineColumn(source, match.index) });
    }
  }
  return result;
}

function collectInboundEvents(rootDir, dirs, kind) {
  const events = new Set();
  const locations = [];
  for (const dir of dirs) {
    for (const file of listJsFiles(rootDir, dir)) {
      const text = readFileSync(join(rootDir, file), 'utf8');
      const extracted = extractInboundSocketEvents(text, { kind, file });
      for (const event of extracted.events) events.add(event);
      locations.push(...extracted.locations);
    }
  }
  return { events, locations };
}

// 契约内、但 visual mock 有意不实现 handler 的入向事件 → 为什么。
// 加进来就等于声明「这条入向路径在 E2E 里没有往返验证」，所以必须写明它被什么别的东西覆盖着。
// 清单之外的任何契约事件缺 handler 一律报错——这是 2026-08-02 补的：此前入向只查
// mock ⊆ contract（mock 不许发明事件），不查 contract ⊆ mock，于是"少实现"永远静默。
const MOCK_INBOUND_EXEMPT = Object.freeze({
  'dev:restart': '真重启进程，mock server 无法在自己身上模拟；拒绝路径由 server.test.mjs「DEV_MODE 关闭时拒绝」覆盖',
  'mirror:syncNow': '手动催一次 catchUp 追平，依赖真实 transcript 轮询；mock 无磁盘镜像，判定链由 mirror-engine 单测覆盖',
  'logs:clientError': '前端错误上报是 fire-and-forget，无回执可断言；E2E 侧改用 expectNoBrowserErrors 直接断言"没有前端错误"',
  'user:ackUnread': '已读确认无回执；unread-pill.spec.ts 直接嗅 socket.io 出向 WS 帧断言前端确实发了这条（往返未验，见该文件注释）',
});

export function checkInboundSocketContract({
  rootDir = ROOT,
  contractEvents = new Set(INBOUND_SOCKET_EVENTS),
  serverDirs = ['src'],
  clientDirs = ['public/js'],
  mockDirs = ['tests/e2e/mock'],
  mockExemptEvents = MOCK_INBOUND_EXEMPT,
} = {}) {
  const contract = new Set(contractEvents);
  const server = collectInboundEvents(rootDir, serverDirs, 'socket-server');
  const client = collectInboundEvents(rootDir, clientDirs, 'socket-client-emit');
  const mock = collectInboundEvents(rootDir, mockDirs, 'socket-server');
  const problems = [];

  for (const event of [...server.events].sort()) {
    if (contract.has(event)) continue;
    problems.push({
      code: 'real_inbound_not_contract',
      event,
      message: `server registers uncontracted inbound socket event "${event}"`,
    });
  }
  for (const event of [...contract].sort()) {
    if (server.events.has(event)) continue;
    problems.push({
      code: 'contract_inbound_not_registered',
      event,
      message: `contract lists inbound socket event "${event}" that no server path registers`,
    });
  }
  for (const event of [...client.events].sort()) {
    if (contract.has(event)) continue;
    problems.push({
      code: 'client_inbound_not_contract',
      event,
      message: `frontend emits uncontracted socket event "${event}"`,
    });
  }
  for (const event of [...mock.events].sort()) {
    if (contract.has(event)) continue;
    problems.push({
      code: 'mock_inbound_not_contract',
      event,
      message: `visual mock registers uncontracted inbound socket event "${event}"`,
    });
  }
  for (const event of [...contract].sort()) {
    if (mock.events.has(event) || Object.hasOwn(mockExemptEvents, event)) continue;
    // 服务端根本没注册的契约事件已由 contract_inbound_not_registered 报过——那是"契约里有个
    // 没人实现的死名字"，要求 mock 去接它没有意义，只会为同一个根因报两条。
    if (!server.events.has(event)) continue;
    problems.push({
      code: 'contract_inbound_not_mocked',
      event,
      message: `contract lists inbound socket event "${event}" that the visual mock never handles — add a mock handler, or list it in MOCK_INBOUND_EXEMPT with the reason it can't be E2E-covered`,
    });
  }
  // 豁免清单本身也要跟着契约走：事件改名/下线后残留的豁免会静默放行一个不存在的名字。
  for (const event of Object.keys(mockExemptEvents).sort()) {
    if (contract.has(event)) continue;
    problems.push({
      code: 'stale_mock_exempt',
      event,
      message: `MOCK_INBOUND_EXEMPT lists "${event}" which is no longer an inbound contract event — remove it`,
    });
  }

  return {
    problems,
    exemptEvents: new Set(Object.keys(mockExemptEvents)),
    contractEvents: contract,
    serverEvents: server.events,
    clientEvents: client.events,
    mockEvents: mock.events,
    serverLocations: server.locations,
    clientLocations: client.locations,
    mockLocations: mock.locations,
    rootDir,
  };
}

// ── 前端接收面覆盖：出向契约缺的那一半 ────────────────────────────────
// checkAgentEventContract 只验「后端 emit 的 type 都在契约里」。反向那半——**前端有没有对应的
// 接收 handler**——此前没有任何一条规则守着（docs/architecture.md 也记着这个缺口）。缺 handler 的
// 后果是静默丢弃：事件到了浏览器、dispatcher 查表落空、直接 return。没有异常、没有日志、
// 没有失败的测试，check 全绿而功能没了。
//
// 前端接收面分两张表，都在 app.js 的 createAgentEventDispatcher 调用点：
//   handle    —— 常规事件：进环形缓冲、占 lastSeq、走 handled 分支
//   outOfBand —— 不进缓冲、不占 lastSeq。resolve('reload') 会整批丢弃队列，OOB 若被误入队
//                就永久丢失且无法从 session:history 恢复（只读锁不亮、CLI 追平气泡不出现）
// 两张表的键并集必须精确等于 AGENT_EVENT_TYPES：少一个＝静默丢弃，多一个＝死键。
// 同一个 type 同时出现在两表里也要拦：createReplayBuffer 里 outOfBand 优先，handle 那条会变成
// 死代码，该 type 悄悄不再进环形缓冲、不再占 lastSeq——是语义变更而非重复登记。
//
// 【第三份表】event-dispatch.js 的 DEFAULT_REPLAY_OOB_TYPES 是 outOfBand 的平行副本，靠一句
// 「与 createAgentEventDispatcher 的 outOfBand 表同口径」的注释绑定。只验 handle ∪ outOfBand
// 等于契约是够不着它的：给 outOfBand 加第 6 个类型并同步 protocol.js，那道断言照样绿，而漏改
// 这份副本就会让新类型被 replay buffer 误入队——正是上面这段注释描述的永久丢失。故一并锁死。
const FRONTEND_DISPATCH_FILE = 'public/js/app.js';
const DISPATCH_TABLE_ANCHORS = Object.freeze([
  { name: 'handle', pattern: /\bconst\s+handle\s*=\s*\{/ },
  { name: 'outOfBand', pattern: /\boutOfBand\s*:\s*\{/ },
]);
const REPLAY_OOB_FILE = 'public/js/app/event-dispatch.js';
const REPLAY_OOB_ANCHOR = /\bconst\s+DEFAULT_REPLAY_OOB_TYPES\s*=\s*new\s+Set\s*\(\s*\[/;

// 对象字面量的顶层键名。两种形态都认：`key: value` 与方法简写 `key(args) {}`。
// 嵌套对象与函数体（depth > 1）、字符串、注释一律跳过。
// 已知局限（两条都 fail-closed，失败方向是红不是放行）：
//   1. 引号键 `'foo': v` 不被识别 —— 见测试「引号键不被识别」
//   2. 正则字面量里的裸 `{` / 引号会扰乱 depth —— 与 findMatchingBrace 共用同一组 skip 工具，
//      属继承的局限；当前两张表里没有正则，真出现时会漏键并报 contract_type_not_handled
function extractTopLevelKeys(source, openIndex) {
  const keys = [];
  let depth = 0;
  // 最近一个非空白、非注释字符。键位判据要用它：只有紧跟 `{` 或 `,` 的标识符才可能是键。
  // 少了这道位置判据，`alpha: (ev) => onAlpha(ev)` 里的 onAlpha 会因为后面也是 `(`
  // 而被当成方法简写键，报出一条指向完全错误位置的 handler_not_contract。
  let lastMeaningful = '';

  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '"' || ch === "'" || ch === '`') { i = skipQuoted(source, i, ch) - 1; lastMeaningful = 'x'; continue; }
    if (ch === '/' && next === '/') { i = skipLineComment(source, i) - 1; continue; }
    if (ch === '/' && next === '*') { i = skipBlockComment(source, i) - 1; continue; }
    if (ch === '{') { depth += 1; lastMeaningful = '{'; continue; }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return keys;
      lastMeaningful = '}';
      continue;
    }
    if (depth !== 1) continue;     // 嵌套层内部一律不参与键位判定
    if (/\s/.test(ch)) continue;   // 空白不改变 lastMeaningful

    const identifier = readIdentifier(source, i);
    if (identifier) {
      const after = skipWhitespace(source, i + identifier.length);
      const atKeyPosition = lastMeaningful === '{' || lastMeaningful === ',';
      if (atKeyPosition && (source[after] === ':' || source[after] === '(')) keys.push(identifier);
      i += identifier.length - 1;
      lastMeaningful = 'x';        // 标识符结尾——只要不是 `{` / `,` 即可
      continue;
    }

    lastMeaningful = ch;
  }

  return keys;
}

// `new Set([...])` 里的字符串成员。用于 DEFAULT_REPLAY_OOB_TYPES 那份平行表。
// 注：范围内若出现含引号的注释会被一并提取，导致比对失败——方向是红（fail-closed），
// 与 extractTopLevelKeys 的引号键局限同一性质。
function findMatchingBracket(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipQuoted(source, i, ch) - 1; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function checkFrontendDispatchCoverage({
  rootDir = ROOT,
  contractTypes = new Set(AGENT_EVENT_TYPES),
  file = FRONTEND_DISPATCH_FILE,
  replayOobFile = REPLAY_OOB_FILE,
} = {}) {
  const problems = [];
  const handled = new Set();
  const tables = {};
  const keysByTable = new Map();
  const normalizedContractTypes = new Set(contractTypes);
  const source = readFileSync(join(rootDir, file), 'utf8');

  for (const anchor of DISPATCH_TABLE_ANCHORS) {
    // 锚点必须恰好命中一次。零命中＝表被改名/挪走，多命中＝取错了表——两种都只能报错不能跳过：
    // 静默跳过等于门禁 fail-open，而它要防的正是「静默」这件事本身。
    const matches = [...source.matchAll(new RegExp(anchor.pattern.source, 'g'))];
    if (matches.length !== 1) {
      problems.push({
        code: matches.length === 0 ? 'dispatch_table_not_found' : 'dispatch_table_ambiguous',
        table: anchor.name,
        message: matches.length === 0
          ? `cannot locate the "${anchor.name}" dispatch table in ${file} — the anchor no longer matches; fix DISPATCH_TABLE_ANCHORS instead of deleting this check`
          : `the "${anchor.name}" anchor matches ${matches.length} places in ${file} — cannot tell which is the dispatch table; tighten the anchor pattern`,
      });
      continue;
    }
    const openIndex = source.indexOf('{', matches[0].index);
    const keys = extractTopLevelKeys(source, openIndex);
    tables[anchor.name] = keys.length;
    keysByTable.set(anchor.name, keys);
    for (const key of keys) handled.add(key);
  }

  // 锚点没定位到就不比对：那时 handled 是残缺的，逐条报「未处理」会淹没真正的根因。
  if (problems.length > 0) {
    return { problems, handled, tables, contractTypes: normalizedContractTypes, file, rootDir };
  }

  // 同一 type 落在两张表里：handled 是 Set，光看并集看不出来，必须按表比。
  const handleKeys = new Set(keysByTable.get('handle') || []);
  for (const key of keysByTable.get('outOfBand') || []) {
    if (!handleKeys.has(key)) continue;
    problems.push({
      code: 'duplicate_handler',
      type: key,
      message: `"${key}" appears in both the handle and outOfBand tables in ${file} — outOfBand wins at dispatch time, so the handle entry is dead code and this type silently stops entering the replay ring buffer; keep exactly one`,
    });
  }

  // 第三份表：event-dispatch.js 的 DEFAULT_REPLAY_OOB_TYPES 必须与 outOfBand 表逐字相等。
  const oobKeys = new Set(keysByTable.get('outOfBand') || []);
  const replaySource = readFileSync(join(rootDir, replayOobFile), 'utf8');
  const replayMatches = [...replaySource.matchAll(new RegExp(REPLAY_OOB_ANCHOR.source, 'g'))];
  if (replayMatches.length !== 1) {
    problems.push({
      code: replayMatches.length === 0 ? 'replay_oob_table_not_found' : 'replay_oob_table_ambiguous',
      table: 'DEFAULT_REPLAY_OOB_TYPES',
      message: `expected exactly one DEFAULT_REPLAY_OOB_TYPES declaration in ${replayOobFile}, found ${replayMatches.length} — fix REPLAY_OOB_ANCHOR instead of dropping this check`,
    });
  } else {
    const bracketStart = replaySource.indexOf('[', replayMatches[0].index);
    const bracketEnd = findMatchingBracket(replaySource, bracketStart);
    const replayTypes = new Set(extractStringLiterals(replaySource.slice(bracketStart, bracketEnd + 1)));
    tables.replayOob = replayTypes.size;
    for (const type of [...oobKeys].sort()) {
      if (replayTypes.has(type)) continue;
      problems.push({
        code: 'replay_oob_missing',
        type,
        message: `"${type}" is in the outOfBand table but missing from DEFAULT_REPLAY_OOB_TYPES in ${replayOobFile} — the replay buffer will queue it, and resolve('reload') discards the queue, so this event is lost permanently and cannot be recovered from session:history`,
      });
    }
    for (const type of [...replayTypes].sort()) {
      if (oobKeys.has(type)) continue;
      problems.push({
        code: 'replay_oob_stale',
        type,
        message: `"${type}" is listed in DEFAULT_REPLAY_OOB_TYPES in ${replayOobFile} but is no longer in the outOfBand table — stale entry; remove it`,
      });
    }
  }

  for (const type of [...normalizedContractTypes].sort()) {
    if (handled.has(type)) continue;
    problems.push({
      code: 'contract_type_not_handled',
      type,
      message: `agent:event type "${type}" has no frontend handler in ${file} — events of this type are silently discarded on arrival; add it to the handle or outOfBand table`,
    });
  }

  for (const key of [...handled].sort()) {
    if (normalizedContractTypes.has(key)) continue;
    problems.push({
      code: 'handler_not_contract',
      type: key,
      message: `${file} handles "${key}" which is not in AGENT_EVENT_TYPES — dead key left behind by a removed type, or a handler wired ahead of its contract entry`,
    });
  }

  return { problems, handled, tables, contractTypes: normalizedContractTypes, file, rootDir };
}

export function formatFrontendDispatchProblems(result) {
  if (result.problems.length === 0) {
    // 分表计数不求和显示：handle + outOfBand 才等于 handled，replayOob 是 outOfBand 的镜像、
    // 不参与并集。三个数字排成一行相加会读成 31/26。
    return [
      'frontend dispatch coverage OK',
      `handled: ${result.handled.size}/${result.contractTypes.size}（handle ${result.tables.handle} + outOfBand ${result.tables.outOfBand}）`,
      `replay OOB mirror: ${result.tables.replayOob} 条，与 outOfBand 表逐字一致`,
    ].join('\n');
  }

  return result.problems.map(problem => `[${problem.code}] ${problem.message}`).join('\n');
}

export function formatInboundContractProblems(result) {
  if (result.problems.length === 0) {
    return [
      `inbound socket contract OK`,
      `server events: ${result.serverEvents.size}`,
      `client emits: ${result.clientEvents.size}`,
      // 带上分母与豁免数：裸的 "mock handlers: 33" 读起来像"覆盖了 33 个"，
      // 实际是"40 个里少 7 个"——数字必须自己说清楚缺口，别让人误读成安全。
      `mock handlers: ${result.mockEvents.size}/${result.contractEvents.size}`
        + `（${result.exemptEvents?.size ?? 0} 项显式豁免，见 MOCK_INBOUND_EXEMPT）`,
    ].join('\n');
  }

  return result.problems
    .map(problem => `[${problem.code}] ${problem.message}`)
    .join('\n');
}
