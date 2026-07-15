// 模拟移动端发送斜杠命令测试
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execSync } from 'node:child_process';

// 获取 claude 路径
let claudeBin = process.env.CLAUDE_BIN || '';
if (!claudeBin) {
  try {
    claudeBin = execSync('which claude', { encoding: 'utf8' }).trim();
  } catch {
    console.error('未找到 claude 命令');
    process.exit(1);
  }
}

console.log('=== 模拟移动端斜杠命令流程 ===\n');
const workDir = process.env.WORK_DIR || process.cwd();

// 测试场景 1：技能命令（应该可用）
console.log('📱 场景 1：用户输入 /cag 实现一个 hello 函数\n');

async function* input1() {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '/cag 实现一个 hello 函数' }]
    }
  };
}

const q1 = query({
  prompt: input1(),
  options: {
    cwd: workDir,
    pathToClaudeCodeExecutable: claudeBin,
    permissionMode: 'default',
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' }
  }
});

let count1 = 0;
for await (const msg of q1) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    console.log('✅ init 事件收到');
    console.log(`   - 可用技能数: ${msg.slash_commands?.length ?? 0}`);
    console.log(`   - 前 5 个: ${msg.slash_commands?.slice(0, 5).join(', ')}`);
  } else if (msg.type === 'assistant') {
    console.log('\n✅ 助手响应:');
    const text = msg.message?.content?.[0]?.text || '';
    console.log(`   ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);
  } else if (msg.type === 'result') {
    console.log(`\n✅ 完成 (耗时: ${msg.duration_ms}ms)`);
    break;
  }
  if (++count1 > 20) break;
}

// 测试场景 2：元命令（预期不可用）
console.log('\n\n📱 场景 2：用户输入 /model\n');

async function* input2() {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '/model' }]
    }
  };
}

const q2 = query({
  prompt: input2(),
  options: {
    cwd: workDir,
    pathToClaudeCodeExecutable: claudeBin,
    permissionMode: 'default',
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' }
  }
});

for await (const msg of q2) {
  if (msg.type === 'assistant') {
    console.log('✅ 助手响应:');
    console.log(`   ${msg.message?.content?.[0]?.text || ''}`);
  } else if (msg.type === 'result') {
    console.log(`✅ 完成 (预期返回 "isn't available")`);
    break;
  }
}

console.log('\n=== 测试完成 ===');
