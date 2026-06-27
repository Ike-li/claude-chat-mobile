// 手动测试：模拟 onSessionId 调用
import { appendFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getProjectDir, listSessions } from '../history.js';

const WORK_DIR = '/tmp/ccm-test';
const testSessionId = 'test-manual-' + Date.now();

console.log('测试 writeSessionEntrypoint 函数...\n');

// 模拟 writeSessionEntrypoint 的逻辑
const projectDir = getProjectDir(WORK_DIR);
const claudeDir = join(homedir(), '.claude', 'projects', projectDir);
mkdirSync(claudeDir, { recursive: true });
const sessionFile = join(claudeDir, `${testSessionId}.jsonl`);

console.log(`1. 写入 entrypoint 元数据到: ${sessionFile}`);
const meta = {
  type: 'entrypoint-marker',
  entrypoint: 'cli',
  sessionId: testSessionId,
  timestamp: new Date().toISOString()
};
appendFileSync(sessionFile, JSON.stringify(meta) + '\n', { mode: 0o600 });
console.log('✓ 写入完成\n');

// 模拟 SDK 随后写入的其他事件
console.log('2. 模拟 SDK 写入后续事件...');
const sdkEvent = {
  type: 'user',
  entrypoint: 'sdk-cli',
  message: { role: 'user', content: 'test' },
  sessionId: testSessionId,
  timestamp: new Date().toISOString()
};
appendFileSync(sessionFile, JSON.stringify(sdkEvent) + '\n');
console.log('✓ SDK 事件写入完成\n');

// 读取文件验证
console.log('3. 验证文件内容...');
const content = readFileSync(sessionFile, 'utf8');
const lines = content.trim().split('\n');
console.log(`✓ 文件有 ${lines.length} 行\n`);

console.log('前两行内容:');
for (let i = 0; i < 2; i++) {
  const obj = JSON.parse(lines[i]);
  console.log(`  第 ${i+1} 行: type="${obj.type}", entrypoint="${obj.entrypoint}"`);
}
console.log('');

// 验证 history.js 读取
console.log('4. 验证 history.js 的 readHeadMeta...');
const sessions = await listSessions(WORK_DIR, { limit: 100 });
const session = sessions.find(s => s.id === testSessionId);

if (!session) {
  console.error('❌ listSessions 未返回该会话');
  process.exit(1);
}

console.log(`✓ 找到会话: ${session.id.slice(0, 20)}...`);
console.log(`  title: "${session.title}"`);
console.log(`  entrypoint: "${session.entrypoint}"`);
console.log(`  model: ${session.model}\n`);

if (session.entrypoint !== 'cli') {
  console.error(`❌ 失败: 期望 entrypoint="cli"，实际 "${session.entrypoint}"`);
  process.exit(1);
}

console.log('✅ 验证成功: readHeadMeta 优先读取到我们写入的 entrypoint:"cli"');
console.log('   （而非 SDK 后续写入的 "sdk-cli"）\n');

// 清理
unlinkSync(sessionFile);
console.log('🧹 测试文件已清理');
