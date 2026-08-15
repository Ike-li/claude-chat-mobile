#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_EVENT_TYPES, INBOUND_SOCKET_EVENTS } from '../src/shared/protocol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_DOC_GLOBS = Object.freeze([
  'README.md',
  'README.en.md',
  'CLAUDE.md',
  'SECURITY.md',
  '.github/copilot-instructions.md',
  '.env.example',
  'docs/*.md',
]);

// 文档里会写出版本号的依赖。只列 CLAUDE.md 技术栈行对外宣称的那几个——升 major 时最容易
// 忘了改文档，而读者会按文档里的版本去查 API。其余依赖文档从不提版本，列进来只会空转。
const DOCUMENTED_DEPENDENCIES = Object.freeze([
  '@anthropic-ai/claude-agent-sdk',
  'express',
  'socket.io',
  'jose',
]);

function fileExists(rootDir, relPath) {
  return existsSync(join(rootDir, relPath));
}

function expandDocGlobs(rootDir, globs) {
  const files = [];
  for (const glob of globs) {
    if (glob.endsWith('/*.md')) {
      const dir = glob.slice(0, -'/*.md'.length);
      const absDir = join(rootDir, dir);
      if (!existsSync(absDir)) continue;
      for (const entry of readdirSync(absDir)) {
        if (entry.endsWith('.md')) files.push(join(dir, entry));
      }
      continue;
    }
    if (fileExists(rootDir, glob)) files.push(glob);
  }
  return [...new Set(files)].sort();
}

function readJson(rootDir, relPath) {
  return JSON.parse(readFileSync(join(rootDir, relPath), 'utf8'));
}

function readText(rootDir, relPath) {
  return readFileSync(join(rootDir, relPath), 'utf8');
}

export function extractDocumentedNpmScripts(text) {
  const scripts = new Set();
  const runRe = /\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g;
  const shorthandRe = /\bnpm\s+(start|test)\b/g;
  let match;

  while ((match = runRe.exec(text))) scripts.add(match[1]);
  while ((match = shorthandRe.exec(text))) scripts.add(match[1]);

  return scripts;
}

function checkLinks({ rootDir, docFiles }) {
  const problems = [];
  const markdownLinkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  const bareDocRe = /docs\/[\w-]+\.md/g;

  for (const rel of docFiles) {
    const file = join(rootDir, rel);
    const text = readText(rootDir, rel);
    let match;

    while ((match = markdownLinkRe.exec(text))) {
      const rawTarget = match[1].trim();
      const target = rawTarget.split('#')[0];
      if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
      if (!existsSync(resolve(dirname(file), target))) {
        problems.push({
          code: 'dead_link',
          file: rel,
          target: rawTarget,
          message: `${rel} links to missing ${rawTarget}`,
        });
      }
    }

    while ((match = bareDocRe.exec(text))) {
      const target = match[0];
      if (!existsSync(join(rootDir, target))) {
        problems.push({
          code: 'dead_link',
          file: rel,
          target,
          message: `${rel} references missing ${target}`,
        });
      }
    }
  }

  return problems;
}

function checkNpmScriptReferences({ rootDir, docFiles, packageJson }) {
  const problems = [];
  const packageScripts = new Set(Object.keys(packageJson.scripts || {}));

  for (const rel of docFiles) {
    const scripts = extractDocumentedNpmScripts(readText(rootDir, rel));
    for (const script of scripts) {
      if (packageScripts.has(script)) continue;
      problems.push({
        code: 'unknown_npm_script',
        file: rel,
        script,
        message: `${rel} documents npm script "${script}", but package.json has no matching script`,
      });
    }
  }

  return problems;
}

function checkDocumentedDependencyVersions({ rootDir, docFiles, packageJson }) {
  const problems = [];
  const deps = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
  };
  for (const rel of docFiles) {
    const text = readText(rootDir, rel);
    for (const name of DOCUMENTED_DEPENDENCIES) {
      const actual = deps[name];
      if (!actual) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 'i' flag：文档写的是 `Express 5` / `Socket.io 4`，package 名是全小写。
      // 版本段允许只写 major（`Express 5`），不再强制两段——CLAUDE.md 技术栈行就是这么写的。
      const versionRe = new RegExp(`${escaped}\\\`?\\s*(?:v)?(\\d+(?:\\.\\d+){0,2}(?:\\+)?)(?=\\b|[^\\d.])`, 'gi');
      let match;
      while ((match = versionRe.exec(text))) {
        const documented = match[1].replace(/\+$/, '');
        if (documented === actual) continue;
        // 文档写几段就比几段：`Express 5` 只校验 major，`SDK 0.3.201` 校验到 patch。
        // package.json 侧先剥掉 ^ / ~ / >= 这类 range 前缀，否则 '5' 永远不等于 '^5.0.0'。
        const actualSegments = actual.replace(/^[^\d]*/, '').split('.');
        const actualPrefix = actualSegments.slice(0, documented.split('.').length).join('.');
        if (documented === actualPrefix) continue;
        problems.push({
          code: 'dependency_version_drift',
          file: rel,
          dependency: name,
          documented: match[1],
          actual,
          message: `${rel} documents ${name} ${match[1]}, but package.json uses ${actual}`,
        });
      }
    }
  }

  return problems;
}

// 契约计数的锚点符号 → 真相源里的哪一份清单。文档写「当前 N 种/个」时必须在同一行点出符号名。
const CONTRACT_ANCHORS = Object.freeze([
  ['AGENT_EVENT_TYPES', 'outbound', '出向 agent:event type'],
  ['INBOUND_SOCKET_EVENTS', 'inbound', '入向 socket 事件'],
]);

// 文档里的契约计数必须与 src/shared/protocol.js 一致。
//
// 【为什么加这条】两份清单的长度此前只活在散文里，靠 hard-rules 一句「散文数字若漂移以代码为准」
// 兜底——而给数字写免责声明等于承认这条信息不可信。2026-08-15 实测：文档写「入向当前 40 个」，
// protocol.js 实际 42 个，doc consistency 全绿也发现不了。数字交给机器保证后，免责声明才能删掉。
//
// 【为什么用行内锚点而不是裸 /当前 (\d+)/】文档里有大量与契约无关的计数（「共 7 个文件」
// 「70 个项目 / 291 memory」），裸匹配会把它们全部误伤。判据收窄成「同一行出现契约符号名」：
// 写这个数字的人本来就该在同一行点明它属于哪份清单，否则读者也无从核对。
// 同行出现两个符号名 = 归属有歧义，报错要求拆行——静默跳过等于漏检，与本门禁的目的相反。
function checkContractCounts({ rootDir, docFiles, contractCounts }) {
  const problems = [];
  // 中英两种量词都要认：architecture.md / architecture.en.md 是孪生体，只守中文会造成
  // 【守卫不对称】——改 AGENT_EVENT_TYPES 时中文红、英文静默失真而 npm run check 全绿
  // （2026-08-15 独立审查发现 architecture.en.md 的「All 26 types」正是这样漏网的）。
  // 英文侧不要求「currently」之类的前缀词：英文写法太多（all / currently has / today there are），
  // 锚点已经把范围收窄到「同行点了符号名」的那几行，量词本身足够判别。
  const countRe = /当前\s*`?(\d+)`?\s*[种个型条]|(?<![\w.])(\d+)\s+(?:types?|events?)\b/gi;

  for (const rel of docFiles) {
    readText(rootDir, rel).split('\n').forEach((line, index) => {
      const anchors = CONTRACT_ANCHORS.filter(([symbol]) => line.includes(symbol));
      if (anchors.length === 0) return;
      const counts = [...line.matchAll(countRe)];
      if (counts.length === 0) return;

      if (anchors.length > 1) {
        problems.push({
          code: 'contract_count_ambiguous',
          file: rel,
          line: index + 1,
          message: `${rel}:${index + 1} 同行出现多个契约符号，计数归属有歧义——拆到不同行再写数字`,
        });
        return;
      }

      const [, kind, label] = anchors[0];
      const actual = contractCounts[kind];
      for (const match of counts) {
        const documented = Number(match[1] ?? match[2]);   // 组 1=中文量词，组 2=英文量词
        if (documented === actual) continue;
        problems.push({
          code: 'contract_count_drift',
          file: rel,
          line: index + 1,
          kind,
          documented,
          actual,
          message: `${rel}:${index + 1} 写 ${label} 当前 ${documented} 项，实际 ${actual} 项（真相源 src/shared/protocol.js）`,
        });
      }
    });
  }

  return problems;
}

export function checkDocConsistency({
  rootDir = ROOT,
  docGlobs = DEFAULT_DOC_GLOBS,
  // 注入口仅供单测喂假计数；生产恒读 protocol.js 真值。
  contractCounts = { outbound: AGENT_EVENT_TYPES.length, inbound: INBOUND_SOCKET_EVENTS.length },
} = {}) {
  const packageJson = readJson(rootDir, 'package.json');
  const docFiles = expandDocGlobs(rootDir, docGlobs);
  const problems = [
    ...checkLinks({ rootDir, docFiles }),
    ...checkNpmScriptReferences({ rootDir, docFiles, packageJson }),
    ...checkDocumentedDependencyVersions({ rootDir, docFiles, packageJson }),
    ...checkContractCounts({ rootDir, docFiles, contractCounts }),
  ];

  return { rootDir, docFiles, problems };
}

export function formatDocConsistency(result) {
  if (result.problems.length === 0) {
    return [
      'doc consistency OK',
      `docs: ${result.docFiles.length}`,
      `root: ${relative(process.cwd(), result.rootDir) || '.'}`,
    ].join('\n');
  }

  return result.problems
    .map(problem => `[${problem.code}] ${problem.message}`)
    .join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = checkDocConsistency();
  const output = formatDocConsistency(result);
  if (result.problems.length > 0) {
    console.error(output);
    process.exit(1);
  }
  console.log(output);
}
