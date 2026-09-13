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
// 真正的并发改由进程级隔离达成——tests/infra/e2e-parallel.js 并行起多个独立 server 各自处理一个
// --shard 切片，进程间零共享状态。CCM_PLAYWRIGHT_SHARD_SUFFIX 只在该编排脚本下设置，用于把每个
// 分片的报告/产物目录错开，防止并行进程写同一份文件冲突；单独跑 `npm run test:e2e` 时留空，
// 行为与未引入分片编排前完全一致。
const shardSuffix = process.env.CCM_PLAYWRIGHT_SHARD_SUFFIX || '';

export default defineConfig({
  testDir: '../e2e',
  testMatch: 'specs/**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  // CI 上重试一次。分片并行会把两类问题照出来：紧到极限的断言窗口，以及 spec 之间经由 mock
  // server 模块级全局态的隐藏耦合（分片改变了"哪些 spec 共用一个 server 进程、按什么顺序跑"）。
  // 实测两次、两条不同用例：run 34709034273 四分片红 task-progress P0-17i（toBeEnabled 超时）、
  // run 34709543333 两分片红 long-stream-interrupt P0-04（element(s) not found）；同期串行 10 次
  // 里 9 次全绿。降分片数解决不了——2 分片比 4 分片还慢（373s vs 269s）却照样红。
  //
  // retries 不掩盖稳定的真 bug：那种第二次照样红。它只把【偶发红】转成【标记为 flaky 的绿】，
  // 信息不丢反而更透明——串行时代偶尔红一次，重跑就过了，没人知道是哪条、为什么。
  // 顺带让 trace:'on-first-retry' 真正生效：retries=0 时那行配置从来不产出任何 trace。
  // 本机保持 0：开发时自动重试会掩盖刚写出来的问题，也拖慢反馈。
  retries: process.env.CI ? 1 : 0,
  expect: {
    timeout: 8_000
  },
  outputDir: `../../test-results${shardSuffix}`,
  reporter: [['list'], ['html', { outputFolder: `../../playwright-report${shardSuffix}`, open: 'never' }]],
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
    // cwd 必须显式指向仓库根：Playwright 默认用 config 文件所在目录（本文件移进 tests/infra/ 后
    // 就是那里），于是 `node tests/e2e/mock/server.js` 会被解析成 tests/infra/tests/e2e/…；
    // 而且 mock server 自身按仓库根的相对路径读 app/public/，cwd 错了即使找得到文件也跑不对。
    cwd: '../..',
    command: `CCM_BUILD_NONCE=${buildNonce} PORT=${port} node tests/e2e/mock/server.js`,
    url: `${baseURL}/__ready?nonce=${buildNonce}`, // 仅本轮 nonce 匹配才 200，拒绝端口上的陈旧/他者进程
    timeout: 30_000,
    reuseExistingServer: false                     // TC-008：不盲目复用端口上任意进程；始终自起、身份经 nonce 校验
  }
});
