import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.CCM_PLAYWRIGHT_PORT || 33341);
const baseURL = process.env.CCM_PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;
// TC-008：本轮启动身份 nonce（默认随机、每次跑都不同）。webServer.command 注入 CCM_BUILD_NONCE，url 探针带同一
// nonce → mock 的 /__ready 仅在【本轮 spawn 的 server】（nonce 匹配）才回 200；端口上残留的旧 checkout / 其它
// 进程回 409。配合 reuseExistingServer:false（不再盲目复用端口上的任意进程），杜绝对错误进程跑 P0 契约、假绿/
// 假红。需复用自起 server 时可固定 CCM_PLAYWRIGHT_NONCE。
const buildNonce = process.env.CCM_PLAYWRIGHT_NONCE || `pw-${randomUUID()}`;
// TC-010：mock server（tests/e2e/mock/server.js）用模块级全局变量当状态存储，多个 worker 共打
// 同一进程会互相踩踏（实测 workers>1 直接让 server 抛未捕获异常崩溃）。故单进程内维持 workers:1；
// 真正的并发改由进程级隔离达成——scripts/test-e2e-parallel.js 并行起多个独立 server 各自处理一个
// --shard 切片，进程间零共享状态。CCM_PLAYWRIGHT_SHARD_SUFFIX 只在该编排脚本下设置，用于把每个
// 分片的报告/产物目录错开，防止并行进程写同一份文件冲突；单独跑 `npm run test:e2e` 时留空，
// 行为与未引入分片编排前完全一致。
const shardSuffix = process.env.CCM_PLAYWRIGHT_SHARD_SUFFIX || '';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'p0/**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 8_000
  },
  outputDir: `test-results${shardSuffix}`,
  reporter: [['list'], ['html', { outputFolder: `playwright-report${shardSuffix}`, open: 'never' }]],
  use: {
    baseURL,
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true
  },
  webServer: {
    command: `CCM_BUILD_NONCE=${buildNonce} PORT=${port} node tests/e2e/mock/server.js`,
    url: `${baseURL}/__ready?nonce=${buildNonce}`, // 仅本轮 nonce 匹配才 200，拒绝端口上的陈旧/他者进程
    timeout: 30_000,
    reuseExistingServer: false                     // TC-008：不盲目复用端口上任意进程；始终自起、身份经 nonce 校验
  }
});
