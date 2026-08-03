#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function checkDocConsistency({
  rootDir = ROOT,
  docGlobs = DEFAULT_DOC_GLOBS,
} = {}) {
  const packageJson = readJson(rootDir, 'package.json');
  const docFiles = expandDocGlobs(rootDir, docGlobs);
  const problems = [
    ...checkLinks({ rootDir, docFiles }),
    ...checkNpmScriptReferences({ rootDir, docFiles, packageJson }),
    ...checkDocumentedDependencyVersions({ rootDir, docFiles, packageJson }),
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
