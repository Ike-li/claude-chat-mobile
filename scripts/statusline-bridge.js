#!/usr/bin/env node

// Transparent statusline runner. Capture is deliberately best-effort: the
// configured renderer remains the user-visible contract and must keep working
// even when snapshot handling fails.

import { spawn } from 'node:child_process';

import {
  normalizeCliStatusInput,
  writeCliStatusSnapshot,
} from '../cli-statusline-bridge.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const renderer = separator === -1 ? [] : argv.slice(separator + 1);
  let snapshotDir;
  let refreshIntervalSec;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === '--snapshot-dir' && options[i + 1]) snapshotDir = options[++i];
    else if (options[i] === '--refresh-interval' && options[i + 1]) {
      refreshIntervalSec = Number(options[++i]);
    }
  }
  return { renderer, snapshotDir, refreshIntervalSec };
}

async function run() {
  const raw = await readStdin();
  const parsed = parseArgs(process.argv.slice(2));
  const { renderer, refreshIntervalSec } = parsed;
  const snapshotDir = parsed.snapshotDir || process.env.CLI_STATUSLINE_DIR || undefined;
  if (!renderer.length) {
    process.stderr.write('usage: statusline-bridge.js [options] -- <renderer> [args...]\n');
    process.exitCode = 64;
    return;
  }

  const child = spawn(renderer[0], renderer.slice(1), {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on('error', error => {
    // renderer 可在读取完/读取前主动退出；其退出码才是 statusline 契约，stdin EPIPE 不应把 wrapper 撞成 1。
    if (error?.code !== 'EPIPE' && process.env.CCM_STATUSLINE_DEBUG === '1') {
      process.stderr.write(`[ccm-statusline] renderer stdin failed: ${error?.message || error}\n`);
    }
  });
  child.stdin.end(raw);

  if (process.env.CCM_STATUSLINE_ORIGIN !== 'web-sdk') {
    try {
      const snapshot = normalizeCliStatusInput(raw.toString('utf8'), {
        capturedAt: Date.now(),
        refreshIntervalSec,
      });
      if (snapshot) writeCliStatusSnapshot(snapshot, snapshotDir ? { dir: snapshotDir } : undefined);
    } catch (error) {
      if (process.env.CCM_STATUSLINE_DEBUG === '1') {
        process.stderr.write(`[ccm-statusline] capture failed: ${error?.message || error}\n`);
      }
    }
  }

  const code = await new Promise(resolve => {
    child.once('error', () => resolve(127));
    child.once('close', exitCode => resolve(exitCode ?? 1));
  });
  process.exitCode = code;
}

await run();
