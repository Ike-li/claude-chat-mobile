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
  '.agents/*.md',
  '.github/copilot-instructions.md',
  '.env.example',
  'docs/*.md',
  'specs/*.md',
]);

const RENAMED = Object.freeze([
  '需求文档-v2.md',
  '斜杠命令普查-2026-06-12.md',
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

function checkRenamedReferences({ rootDir, docFiles }) {
  const problems = [];
  for (const rel of docFiles) {
    if (rel.endsWith('CHANGELOG.md')) continue;
    const text = readText(rootDir, rel);
    for (const oldName of RENAMED) {
      if (!text.includes(oldName)) continue;
      problems.push({
        code: 'stale_filename',
        file: rel,
        target: oldName,
        message: `${rel} still references old filename ${oldName}`,
      });
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
  const dependencyNames = ['@anthropic-ai/claude-agent-sdk'];

  for (const rel of docFiles) {
    const text = readText(rootDir, rel);
    for (const name of dependencyNames) {
      const actual = deps[name];
      if (!actual) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const versionRe = new RegExp(`${escaped}\\\`?\\s*(?:v)?(\\d+\\.\\d+(?:\\.\\d+)?(?:\\+)?)(?=\\b|[^\\d.])`, 'g');
      let match;
      while ((match = versionRe.exec(text))) {
        const documented = match[1].replace(/\+$/, '');
        if (documented === actual) continue;
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
    ...checkRenamedReferences({ rootDir, docFiles }),
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
