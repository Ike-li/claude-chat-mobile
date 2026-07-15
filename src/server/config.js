import dotenv from 'dotenv';
import { join } from 'node:path';

const positiveNumber = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

const nonNegativeNumber = (value, fallback) => {
  if (value === '' || value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

// dotenv is loaded by the composition root. This pure normalization step keeps
// an empty .env value equivalent to "unset" and prevents .env from silently
// overriding provider credentials that were not already present in the shell.
export function normalizeLoadedEnvironment(env, shellAnthropicKeys) {
  for (const key of Object.keys(env)) {
    if (env[key] === '') delete env[key];
    else if (key.startsWith('ANTHROPIC_') && !shellAnthropicKeys.has(key)) delete env[key];
  }
  return env;
}

// Must run in the thin launcher before importing app.js. Several state modules
// resolve their file paths at module evaluation time, so loading .env inside
// app.js would be too late for CCM_DATA_DIR. Provider variables remain shell-only.
export function loadRuntimeEnvironment(env = process.env, { envFile, quiet = false } = {}) {
  const shellAnthropicKeys = new Set(Object.keys(env).filter(key => key.startsWith('ANTHROPIC_')));
  dotenv.config({
    ...(envFile ? { path: envFile } : {}),
    processEnv: env,
    quiet,
  });
  return normalizeLoadedEnvironment(env, shellAnthropicKeys);
}

export function parseServerConfig(env, {
  home,
  projectRoot,
} = {}) {
  return {
    port: positiveNumber(env.PORT, 3000),
    authToken: env.AUTH_TOKEN || '',
    idleTimeoutMs: positiveNumber(env.IDLE_TIMEOUT_MS, 600_000),
    // Zero explicitly disables fully-idle instance reclamation.
    instanceIdleReclaimMs: nonNegativeNumber(env.INSTANCE_IDLE_RECLAIM_MS, 1_800_000),
    approvalTtlMs: positiveNumber(env.APPROVAL_TTL_MS, 1_800_000),
    notifyThrottleMs: positiveNumber(env.NOTIFY_THROTTLE_MS, 60_000),
    sessionDeleteQuietMs: positiveNumber(env.SESSION_DELETE_QUIET_MS, 300_000),
    devMode: env.DEV_MODE === '1',
    workDir: env.WORK_DIR || home,
    dataDir: env.CCM_DATA_DIR || join(projectRoot, 'data'),
  };
}
