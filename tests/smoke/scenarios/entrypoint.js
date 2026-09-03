#!/usr/bin/env node
// 测试 Web UI 创建的会话在 CLI /resume 中的可见性修复
// 验收：Web UI 新建会话 → 会话文件含 entrypoint-marker 假行（entrypoint:"cli"）→ CLI /resume 可见。
// 真机对照实验已证实 CLI /resume 只认 marker 行是否存在，不看真实行的 entrypoint 值（见 7/24 复现记录）；
// history.js 的 readHeadMeta 已改为跳过 marker 假行、只读真实行——listSessions() 返回的 entrypoint
// 现在是会话真实来源（sdk-ts），不再是 marker 冒充的 "cli"（那是历史遗留的误判，已修）。

import { readFileSync, unlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { listSessions, getProjectDir } from '../../../app/src/sessions/history.js';

const PORT = process.env.PORT || 3100;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
// realpathSync 与 app/server.js preflight 对 WORK_DIR 的归一化对齐。runner 用 mkdtemp(tmpdir())
// 给出的是 /var/folders/…，而 macOS 上 /var 是指向 /private/var 的符号链接：server 归一化后
// CLI 按 /private/var/… 落盘，getProjectDir(未归一化路径) 却算出 `-var-folders-…`，于是
// readFileSync 恒 ENOENT——报出来像「transcript 没写」，实际是**在错误的目录名下找**。
// 同型说明见 tests/integration/session-delete.test.mjs 的 startServer()。
const WORK_DIR = process.env.WORK_DIR && realpathSync(process.env.WORK_DIR);
if (!WORK_DIR) throw new Error('WORK_DIR is required; use tests/smoke/runner.js');

// 测试用例
const tests = [
  {
    name: '新会话应写入 entrypoint:cli 元数据',
    async run() {
      const socket = ioClient(`http://127.0.0.1:${PORT}`, {
        auth: { token: AUTH_TOKEN },
        transports: ['websocket']
      });

      await new Promise((resolve, reject) => {
        socket.on('connect', resolve);
        socket.on('connect_error', reject);
        setTimeout(() => reject(new Error('连接超时')), 5000);
      });

      // 发送消息创建新会话
      const testMessage = `测试消息 ${Date.now()}`;
      socket.emit('user:message', { text: testMessage });

      // 等待 init 事件获取 session ID
      const sessionId = await new Promise((resolve, reject) => {
        // WS-014：sessionId 在信封【顶层】（envelope.sessionId），旧 guard 查 envelope.payload?.sessionId 恒
        // falsy → if 永不成立 → 永不 resolve → 必 10s 超时挂。改查顶层字段；resolve/reject 时清 timeout + off
        // 监听器（否则 agent:event 监听器泄漏、进程句柄不释放）。
        let timeout;
        const onEvent = (envelope) => {
          if (envelope.type === 'init' && envelope.sessionId) { finish(); resolve(envelope.sessionId); }
        };
        const finish = () => { clearTimeout(timeout); socket.off('agent:event', onEvent); };
        timeout = setTimeout(() => { finish(); reject(new Error('未收到 init 事件')); }, 10000);
        socket.on('agent:event', onEvent);
      });

      socket.disconnect();

      // 验证会话文件包含 entrypoint:"cli"
      const projectDir = getProjectDir(WORK_DIR);
      const sessionFile = join(homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
      const content = readFileSync(sessionFile, 'utf8');
      const lines = content.trim().split('\n');

      // 检查前几行是否有 entrypoint:"cli"
      let foundCliEntrypoint = false;
      for (let i = 0; i < Math.min(10, lines.length); i++) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.entrypoint === 'cli') {
            foundCliEntrypoint = true;
            console.log(`  ✓ 第 ${i + 1} 行找到 entrypoint:"cli"`);
            break;
          }
        } catch {}
      }

      if (!foundCliEntrypoint) {
        throw new Error('会话文件前 10 行未找到 entrypoint:"cli"');
      }

      // 验证 history.js 能正确读取
      const sessions = await listSessions(WORK_DIR, { limit: 100 });
      const session = sessions.find(s => s.id === sessionId);

      if (!session) {
        throw new Error('listSessions 未返回该会话');
      }

      // web 会话绝不能被 marker 假行冒充成 "cli"。这条守卫两条取数路径都要成立。
      if (session.entrypoint === 'cli') {
        throw new Error('listSessions 报出 entrypoint="cli"——被 entrypoint-marker 假行抢先（回归）');
      }

      // 【不】要求 entrypoint 非空：生产走 SDK listSessions 快路径，那条路上 entrypoint 是**死字段**
      // （history.js 的 listSessionsPage 头注：前端 sessionRow 显式传 null，来源角标读 session-registry
      // 的 terminal 而非 entrypoint）。旧断言写于 SDK 迁移之前，之后一直没跑到——它要的字段是被
      // 刻意去掉的。注意 tests/unit/history-list.test.mjs 那条同名守卫**注入了 baseDir**，因而回落
      // 到自造扫盘路径、readHeadMeta 会填 entrypoint：它绿不代表生产这条路被验证过，两条路要分开看。
      const src = session.entrypoint ?? '(SDK 快路径不带此字段，符合设计)';
      console.log(`  ✓ listSessions 未被 marker 冒充；entrypoint=${src}`);
      console.log(`  ✓ 会话 ID: ${sessionId.slice(0, 8)}...`);

      // 清理测试会话文件
      try {
        unlinkSync(sessionFile);
        console.log(`  ✓ 已清理测试文件`);
      } catch {}

      return true;
    }
  }
];

// 运行测试
async function main() {
  console.log('开始测试 entrypoint 修复...\n');

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      console.log(`运行: ${test.name}`);
      await test.run();
      passed++;
      console.log(`✓ ${test.name}\n`);
    } catch (err) {
      failed++;
      console.error(`✗ ${test.name}`);
      console.error(`  错误: ${err.message}\n`);
    }
  }

  console.log(`测试完成: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('测试脚本错误:', err);
  process.exit(1);
});
