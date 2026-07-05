import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

export const AGENT_EVENT_TYPES = Object.freeze([
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
  { path: 'agent.js', kind: 'agent-session' },
  { path: 'server.js', kind: 'agent-event-emit' },
]);

const MOCK_SOURCES = Object.freeze([
  { path: 'scripts/visual-mock-server.js', kind: 'agent-event-emit' },
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
  const emitPattern = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\.emit\s*\(\s*(['"])agent:event\1\s*,/g;
  let match;

  while ((match = emitPattern.exec(source))) {
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
