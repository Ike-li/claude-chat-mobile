// tests/v2/server/approval-restart.test.mjs —— 重启后遗留审批的 fail-closed 处置
// 守护：APPROVAL-02（进程启动时磁盘上残留的 pending 一律 expired、decidedBy=system:restart，
//       不可再批准执行；台账写失败不得阻塞启动——台账不是执行门槛）
// 覆盖：真重启后 pending → expired + 终态记录不被改写 + 台账损坏/缺失不阻塞启动
// 槽位：S2（真组装根 app/server.js 子进程 + 一次性 CCM_DATA_DIR，模型回合是假的）
//
// ⚠ 本文件必须真 spawn 子进程，不能用 import() 模拟重启：
//   ESM 按 URL 缓存模块，cleanup() 后再 import('app/server.js') 拿到的是同一个已 close 的实例，
//   模块顶层读的 env 也不会重新求值 —— 那样这里的每一条断言都在测空气，且会稳定通过。
//   「进程真的重启过」正是 APPROVAL-02 唯一要证明的事。
//
// 不测什么 + 为什么：
//  ① 审批的批准/拒绝流程本身 —— 属 approval-store 的 S1 测点，已在 tests/v2/approval-store.test.mjs。
//  ② canUseTool 回调真的不再被兑现 —— 需要真 Claude 挂起一个工具调用，属 S5。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';

const TOKEN = 'v2-approval-restart-token';

let base;
test.before(() => { base = mkdtempSync(join(tmpdir(), 'ccm-v2-approval-')); });
test.after(() => rmSync(base, { recursive: true, force: true })); // safe-rm: mkdtemp 一次性目录

let seq = 0;
function caseDir() {
  const dir = join(base, `c${++seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 起一台隔离的 server，跑完必定收尸。CCM_APPROVAL_STORE_FILE 指到一次性目录，
// 绝不碰生产 data/approval-requests.json。
async function withServer(dir, storeFile, fn) {
  const started = await spawnServer({
    AUTH_TOKEN: TOKEN,
    WORK_DIR: dir,
    CCM_DATA_DIR: dir,
    CCM_APPROVAL_STORE_FILE: storeFile,
  });
  try {
    return await fn(started);
  } finally {
    await killServer(started.proc);
  }
}

const readStore = f => JSON.parse(readFileSync(f, 'utf8'));
const byId = (store, id) => store.requests.find(r => r.reqId === id);

test('APPROVAL-02：重启后遗留的 pending 全部 expired，决策者标 system:restart', async () => {
  const dir = caseDir();
  const storeFile = join(dir, 'approval-requests.json');
  writeFileSync(storeFile, JSON.stringify({
    requests: [
      { reqId: 'p1', status: 'pending', toolName: 'Bash', createdAt: 1000 },
      { reqId: 'p2', status: 'pending', toolName: 'Write', createdAt: 2000 },
    ],
  }));

  await withServer(dir, storeFile, () => {});

  const after = readStore(storeFile);
  for (const id of ['p1', 'p2']) {
    const r = byId(after, id);
    assert.equal(r.status, 'expired', `${id} 的 canUseTool 回调随上一进程消失了，绝不能仍显示可批准`);
    assert.equal(r.decidedBy, 'system:restart', '决策者必须可追溯到重启，不能留空或伪装成用户操作');
    assert.equal(typeof r.decidedAt, 'number', '终态必须带决策时间，否则留存治理清不掉');
  }
});

test('已终态的记录不被重启改写（只处置 pending，不是全表刷一遍）', async () => {
  const dir = caseDir();
  const storeFile = join(dir, 'approval-requests.json');
  // decidedAt 必须取「近期」：启动时还会跑一次留存治理，早于保留期的终态记录会被清掉，
  // 用远古时间戳会让这条用例测到「记录不存在」而不是「记录没被改写」。
  const recent = Date.now();
  writeFileSync(storeFile, JSON.stringify({
    requests: [
      { reqId: 'allowed', status: 'allow', decidedBy: 'user', decidedAt: recent },
      { reqId: 'denied', status: 'deny', decidedBy: 'user', decidedAt: recent },
      { reqId: 'pend', status: 'pending', createdAt: recent },
    ],
  }));

  await withServer(dir, storeFile, () => {});

  const after = readStore(storeFile);
  assert.equal(byId(after, 'allowed').decidedBy, 'user', '用户批过的记录不得被重启改成 system:restart');
  assert.equal(byId(after, 'allowed').decidedAt, recent, '决策时间是审计事实，不能被刷新');
  assert.equal(byId(after, 'denied').status, 'deny');
  assert.equal(byId(after, 'pend').status, 'expired');
});

test('留存治理与重启处置的边界：老终态被清，老 pending 仍留下并转 expired', async () => {
  // 两条平行逻辑在同一次启动里都会跑。pending 记录【永不】因保留期被清——无论悬置多久，
  // 都要走正常的终态化路径，否则一条超期未决的危险审批会静默消失、连审计痕迹都不留。
  const dir = caseDir();
  const storeFile = join(dir, 'approval-requests.json');
  writeFileSync(storeFile, JSON.stringify({
    requests: [
      { reqId: 'ancient-terminal', status: 'allow', decidedBy: 'user', decidedAt: 1 },
      { reqId: 'ancient-pending', status: 'pending', createdAt: 1 },
    ],
  }));

  await withServer(dir, storeFile, () => {});

  const after = readStore(storeFile);
  assert.equal(byId(after, 'ancient-terminal'), undefined, '超过保留期的终态记录由留存治理清掉');
  const pend = byId(after, 'ancient-pending');
  assert.ok(pend, '再老的 pending 也不得被留存治理收走');
  assert.equal(pend.status, 'expired', '它必须走重启处置转成终态，而不是消失');
  assert.equal(pend.decidedBy, 'system:restart');
});

test('重启两次幂等：第二次不再改动已 expired 的记录', async () => {
  const dir = caseDir();
  const storeFile = join(dir, 'approval-requests.json');
  writeFileSync(storeFile, JSON.stringify({ requests: [{ reqId: 'p', status: 'pending', createdAt: 1 }] }));

  await withServer(dir, storeFile, () => {});
  const firstAt = byId(readStore(storeFile), 'p').decidedAt;

  await withServer(dir, storeFile, () => {});
  const secondAt = byId(readStore(storeFile), 'p').decidedAt;

  assert.equal(secondAt, firstAt, '已终态的记录在后续重启中不得被重新盖上新时间戳');
});

test('台账损坏或缺失不阻塞启动（台账不是执行门槛，fail-soft）', async () => {
  // 与配置文件的 fail-loud 方向【相反】，这是刻意的：配置坏了会让服务以错误姿态运行，
  // 而台账坏了只是丢了审计历史——为它拒绝启动，等于把整个服务押在一个附属文件上。
  for (const [label, content] of [['损坏 JSON', '{ not json'], ['数组顶层', '[]']]) {
    const dir = caseDir();
    const storeFile = join(dir, 'approval-requests.json');
    writeFileSync(storeFile, content);
    const started = await withServer(dir, storeFile, s => s);
    assert.ok(started.port > 0, `${label} 时 server 仍应正常起来`);
  }

  const dir = caseDir();
  const missing = join(dir, 'approval-requests.json');
  const started = await withServer(dir, missing, s => s);
  assert.ok(started.port > 0, '台账文件不存在是全新安装的正常状态');
});
