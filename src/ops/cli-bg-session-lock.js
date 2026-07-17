// CLI background-agent session lock helpers.
//
// Claude CLI refuses `resume <sessionId>` while that id is registered as a
// background agent (`claude agents --json`). CCM web open/resume hits the same
// wall → "无法恢复会话" + empty home. Interactive CLI drivers are left alone
// (single-driver model); only kind=background entries are candidates for
// auto-release before web resume.

import { spawn } from 'node:child_process';

/** @typedef {{ id?: string, sessionId?: string, kind?: string, status?: string, state?: string, pid?: number, name?: string, cwd?: string }} CliAgentEntry */

/**
 * Match agents that claim exclusive resume rights over `sessionId`.
 * Agents list uses sessionId for the locked conversation (may differ from job id).
 */
export function findBgLocksForSession(agents, sessionId) {
  if (!sessionId || !Array.isArray(agents)) return [];
  const id = String(sessionId);
  return agents.filter((a) => {
    if (!a || typeof a !== 'object') return false;
    const sid = a.sessionId != null ? String(a.sessionId) : '';
    if (sid !== id) return false;
    // Only background agents auto-release; interactive is a real foreground driver.
    return String(a.kind || '') === 'background';
  });
}

/**
 * Whether web resume should SIGTERM this bg entry to reclaim the session.
 * Always true for matched background locks (including "done" job + live pid zombies).
 */
export function shouldReleaseBgLock(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (String(entry.kind || '') !== 'background') return false;
  const pid = Number(entry.pid);
  return Number.isInteger(pid) && pid > 0;
}

/**
 * User-facing reason when resume still fails after release attempt / if interactive holds it.
 */
export function formatSessionLockError({ kind, name, pid, rawMessage } = {}) {
  const who = name ? `「${name}」` : '';
  if (kind === 'background') {
    return `会话被后台 agent${who}占用（pid ${pid || '?'}）。web 已尝试释放仍失败，请在本机执行 claude agents 结束后再开，或稍后重试`;
  }
  if (kind === 'interactive') {
    return `会话正被终端 CLI${who}驾驶中（pid ${pid || '?'}）。请先在该终端退出/结束会话，或等空闲回收后再从 web 打开`;
  }
  const raw = typeof rawMessage === 'string' ? rawMessage.trim() : '';
  if (/background agent/i.test(raw)) {
    return '会话被 CLI 后台 agent 占用。web 将自动尝试释放后重试；若仍失败请在本机 claude agents 结束对应任务';
  }
  return raw || '无法恢复会话（CLI 未完成初始化），请新建会话或从列表选择其他会话';
}

/**
 * Parse `claude agents --json` stdout into an array (tolerates trailing noise).
 */
export function parseAgentsJson(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return [];
  const text = stdout.trim();
  try {
    const j = JSON.parse(text);
    return Array.isArray(j) ? j : [];
  } catch {
    // Sometimes wrappers print warnings before JSON array — take first [...] block.
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const j = JSON.parse(text.slice(start, end + 1));
        return Array.isArray(j) ? j : [];
      } catch { /* fall through */ }
    }
    return [];
  }
}

/**
 * List CLI agents via `claude agents --json`.
 * @param {{ claudeBin?: string, cwd?: string, run?: Function, timeoutMs?: number }} opts
 * @returns {Promise<CliAgentEntry[]>}
 */
export async function listCliAgents(opts = {}) {
  const claudeBin = opts.claudeBin || 'claude';
  const timeoutMs = opts.timeoutMs ?? 4000;
  const run = opts.run || defaultRun;
  const args = ['agents', '--json'];
  if (opts.cwd) args.push('--cwd', opts.cwd);
  try {
    const { stdout, code } = await run(claudeBin, args, { timeoutMs, cwd: opts.cwd });
    if (code !== 0 && !stdout) return [];
    return parseAgentsJson(stdout);
  } catch {
    return [];
  }
}

/**
 * SIGTERM (then optional SIGKILL) background agent pids that lock sessionId.
 * Never touches interactive agents.
 *
 * @returns {Promise<{ locks: CliAgentEntry[], released: number[], failed: number[], skipped: CliAgentEntry[] }>}
 */
export async function releaseBgLocksForSession(sessionId, opts = {}) {
  const agents = opts.agents ?? await listCliAgents(opts);
  const locks = findBgLocksForSession(agents, sessionId);
  const released = [];
  const failed = [];
  const skipped = [];
  const kill = opts.kill || defaultKill;
  const waitMs = opts.waitMs ?? 400;

  for (const entry of locks) {
    if (!shouldReleaseBgLock(entry)) {
      skipped.push(entry);
      continue;
    }
    const pid = Number(entry.pid);
    try {
      kill(pid, 'SIGTERM');
      if (waitMs > 0) await sleep(waitMs);
      // If still alive, escalate once.
      if (opts.isAlive ? opts.isAlive(pid) : defaultIsAlive(pid)) {
        try { kill(pid, 'SIGKILL'); } catch { /* ignore */ }
        if (waitMs > 0) await sleep(Math.min(200, waitMs));
      }
      if (opts.isAlive ? opts.isAlive(pid) : defaultIsAlive(pid)) failed.push(pid);
      else released.push(pid);
    } catch {
      failed.push(pid);
    }
  }
  return { locks, released, failed, skipped };
}

/**
 * Convenience: release bg locks then return a short log line for interaction log.
 */
export async function prepareSessionForWebResume(sessionId, opts = {}) {
  if (!sessionId) return { attempted: false, log: '', result: null };
  const result = await releaseBgLocksForSession(sessionId, opts);
  if (!result.locks.length) {
    return { attempted: false, log: '', result };
  }
  const names = result.locks.map((l) => l.name || l.id || l.pid).join(', ');
  const log = `[SYS] web resume 前释放 CLI 后台锁 session=${sessionId} locks=[${names}] released=${result.released.join(',') || '-'} failed=${result.failed.join(',') || '-'}`;
  return { attempted: true, log, result };
}

// ── internals ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKill(pid, signal) {
  process.kill(pid, signal);
}

function defaultRun(bin, args, { timeoutMs = 4000, cwd } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(bin, args, {
      cwd: cwd || process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ stdout, stderr, code: -1, timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', (c) => { stdout += c; });
    child.stderr?.on('data', (c) => { stderr += c; });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: -1 });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}
