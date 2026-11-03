// tests/helpers/fifo-child.mjs —— 在子进程里逐个跑「可能卡在 FIFO 上」的调用，每个单独限时
//
// 阻塞式 open 碰上 FIFO 永远不返回。异步的占死一个 libuv 线程，测试进程自己退不出去（退出要等线程池收工）；
// 同步的直接卡死主线程。所以放进子进程：异步调用各自 race 一个计时器，卡住的记成 'HANG'，断言的 diff 直接
// 指出是哪个入口；同步调用卡住时整个子进程不动，计时器也不会触发，只能靠外层 childTimeoutMs 杀掉。
// 线程池调大，免得前面卡住的调用把后面的饿死、看起来像是一起卡的。
//
// mods：{ 变量名: 模块路径 }，在子进程里各自 import 成同名变量。calls：一段 JS 源码，求值为
// [名字, async () => 值] 的数组。env 里值为 undefined 的键从子进程环境删掉。
// 结果同步写出：有调用卡住时 process.exit 也退不出去，只能 SIGKILL 自己，异步的 stdout 会丢。
// 父进程先比对结果（HANG 落在哪个入口一眼可见），再看退出状态。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CALL_TIMEOUT_MS = 3000;

export function expectInChild(mods, calls, expected, { env = {}, childTimeoutMs = 60_000 } = {}) {
  const imports = Object.entries(mods)
    .map(([name, file]) => `const ${name} = await import(${JSON.stringify(pathToFileURL(file).href)});`)
    .join('\n');
  const script = `${imports}
    const out = {};
    for (const [name, fn] of ${calls}) {
      let timer;
      out[name] = await Promise.race([
        fn().then(v => v ?? null, e => 'THREW ' + (e && e.message)),
        new Promise(r => { timer = setTimeout(() => r('HANG'), ${CALL_TIMEOUT_MS}); }),
      ]);
      clearTimeout(timer);
    }
    (await import('node:fs')).writeSync(1, JSON.stringify(out));
    if (Object.values(out).includes('HANG')) process.kill(process.pid, 'SIGKILL');
    process.exit(0);`;
  const childEnv = { ...process.env, UV_THREADPOOL_SIZE: '64', ...env };
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: childTimeoutMs, env: childEnv });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* 下一行报 */ }
  assert.ok(out, `子进程没给出结果（signal=${r.signal}；超时被杀 = 有同步调用卡住了主线程）：${r.stderr}`);
  assert.deepEqual(out, expected, 'HANG = 这个入口打开 FIFO 时卡住了，在 server 里就是读盘线程被占死');
  assert.equal(r.status, 0, r.stderr);
}
