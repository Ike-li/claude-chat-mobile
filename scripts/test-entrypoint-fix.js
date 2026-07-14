#!/usr/bin/env node
// 测试 Web UI 创建的会话在 CLI /resume 中的可见性修复
// 验收：Web UI 新建会话 → 会话文件包含 entrypoint:"cli" → history.js 能读取 → CLI /resume 可见

import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { listSessions, getProjectDir } from '../history.js';

const PORT = process.env.PORT || 3100;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const WORK_DIR = process.env.WORK_DIR || '/tmp/ccm-test';

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

      if (session.entrypoint !== 'cli') {
        throw new Error(`readHeadMeta 读取的 entrypoint 是 "${session.entrypoint}"，期望 "cli"`);
      }

      console.log(`  ✓ history.js 正确读取 entrypoint:"cli"`);
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
