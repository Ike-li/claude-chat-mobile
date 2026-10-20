// tests/acceptance/replay/fixtures.ts —— 重放脚本共用的夹具：各环境地址与测试令牌
//
// 重放脚本这样写（文件名 dNN-<域>.accept.ts，test 标题以 AC 编号开头，run.mjs 按编号 --grep）：
//   import { test, expect } from './fixtures';
//   test('AC-09-07 长内容的截断阈值', async ({ page, accept }) => {
//     await page.goto(accept.url('E1', '/'));
//     …
//   });
// 地址只连 127.0.0.1：环境由 env/up.mjs 起在容器里、端口只绑本机回环。端口来自 local/config.json 的
// ports（缺省同 env/plan.mjs）；令牌来自 local/secrets.json 的 authTokens，缺了就在用到时报错，不猜。
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORTS } from '../env/plan.mjs';

// playground compose 里写死的测试令牌（tests/infra/docker-compose.playground.yml，健康检查也用它），不是凭据
const PLAYGROUND_TOKEN = 'playground-local-not-a-secret';
// E2辅助 / E2反代 打的是同一个 E2 server：令牌相同；E2辅助连的也是 E2 的端口
const SAME_SERVER: Record<string, string> = { 'E2辅助': 'E2', 'E2反代': 'E2' };

function readLocal(name: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL(`../local/${name}`, import.meta.url)), 'utf8'));
  } catch {
    return {};
  }
}

const config = readLocal('config.json');
const secrets = readLocal('secrets.json');
const filled = (v: unknown): v is string => typeof v === 'string' && v !== '' && !v.startsWith('<填写');

export function envURL(code: string, path = '/'): string {
  const ports: Record<string, number> = { ...DEFAULT_PORTS, ...(config.ports ?? {}) };
  const port = ports[code] ?? ports[SAME_SERVER[code] ?? ''];
  if (!port) throw new Error(`没有环境 ${code} 的端口：可用的是 ${Object.keys(ports).join(' ')}`);
  return `http://127.0.0.1:${port}${path.startsWith('/') ? path : `/${path}`}`;
}

export function envToken(code: string): string {
  const key = SAME_SERVER[code] ?? code;
  const token = secrets.authTokens?.[key];
  if (filled(token)) return token;
  if (key === 'E2') return PLAYGROUND_TOKEN;
  throw new Error(`local/secrets.json 的 authTokens.${key} 还没填（E3 系的令牌在容器里由 setup 生成，取法见 tests/acceptance/README.md）`);
}

export const test = base.extend<{ accept: { url: typeof envURL; token: typeof envToken } }>({
  accept: async ({}, use) => {
    await use({ url: envURL, token: envToken });
  },
});

export { expect };
