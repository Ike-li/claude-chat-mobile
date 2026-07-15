#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRECTORIES = new Set([
  '.git',
  '.ccm-uploads',
  'data',
  'node_modules',
  'playwright-report',
  'test-results',
]);

export function collectSyntaxFiles(rootDir = ROOT) {
  const files = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
        files.push(relative(rootDir, absolute));
      }
    }
  }

  visit(rootDir);
  return files.sort();
}

export function checkSyntax(rootDir = ROOT) {
  const files = collectSyntaxFiles(rootDir);
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', join(rootDir, file)], {
      encoding: 'utf8',
    });
    if (result.status !== 0) failures.push({ file, stderr: result.stderr.trim() });
  }
  return { files, failures };
}

function main() {
  const result = checkSyntax(ROOT);
  if (result.failures.length > 0) {
    for (const failure of result.failures) {
      console.error(`${failure.file}\n${failure.stderr}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`syntax OK (${result.files.length} files)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
