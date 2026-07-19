import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

export const AGENT_EVENT_TYPES = Object.freeze([
  'api_retry',
  'device_status',
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

const REAL_SOURCES = Object.freeze([
  { path: 'src/agent/agent.js', kind: 'agent-session' },
  { path: 'src/server/app.js', kind: 'agent-event-emit' },
]);

const MOCK_SOURCES = Object.freeze([
  { path: 'tests/e2e/mock/server.js', kind: 'agent-event-emit' },
  { path: 'tests/e2e/mock/scenarios/content.js', kind: 'agent-event-emit' },
  { path: 'tests/e2e/mock/scenarios/demo.js', kind: 'agent-event-emit' },
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
  const emitPattern = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?(?:\.to\([^)]*\))?\.emit\s*\(\s*(['"])agent:event\1\s*,/g;
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

export function checkAgentEventContract({
  rootDir = ROOT,
  contractTypes = new Set(AGENT_EVENT_TYPES),
  realSources = REAL_SOURCES,
  mockSources = MOCK_SOURCES,
} = {}) {
  const normalizedContractTypes = new Set(contractTypes);
  const real = collectTypes(rootDir, realSources);
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

export const INBOUND_SOCKET_EVENTS = Object.freeze([
  'browse:list',
  'browse:read',
  'conn:ping',
  'dev:restart',
  'doctor:run',
  'logs:clientError',
  'logs:get',
  'mirror:syncNow',
  'service:status',
  'session:close',
  'session:delete',
  'session:deletePermanent',
  'session:history',
  'session:home',
  'session:list',
  'session:new',
  'session:switch',
  'sync:since',
  'task:stop',
  'tool:full',
  'tool:preview',
  'user:answer',
  'user:approve',
  'user:approveDevice',
  'user:cancelQueued',
  'user:denyDevice',
  'user:interrupt',
  'user:message',
  'user:setEffort',
  'user:setPermissionMode',
  'user:setViewing',
]);

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

export function checkInboundSocketContract({
  rootDir = ROOT,
  contractEvents = new Set(INBOUND_SOCKET_EVENTS),
  serverDirs = ['src'],
  clientDirs = ['public/js'],
  mockDirs = ['tests/e2e/mock'],
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

  return {
    problems,
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

export function formatInboundContractProblems(result) {
  if (result.problems.length === 0) {
    return [
      `inbound socket contract OK`,
      `server events: ${result.serverEvents.size}`,
      `client emits: ${result.clientEvents.size}`,
      `mock handlers: ${result.mockEvents.size}`,
    ].join('\n');
  }

  return result.problems
    .map(problem => `[${problem.code}] ${problem.message}`)
    .join('\n');
}
