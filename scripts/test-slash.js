// 测试 SDK streaming input 模式对斜杠命令的支持
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execSync } from 'node:child_process';

async function* input() {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '/model' }]
    }
  };
}

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

console.log('=== 测试 /model 命令 ===');
console.log(`使用 claude: ${claudeBin}`);
console.log(`工作目录: ${process.cwd()}\n`);

const q = query({
  prompt: input(),
  options: {
    cwd: process.cwd(),
    pathToClaudeCodeExecutable: claudeBin,
    permissionMode: 'default',
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' }
  }
});

let messageCount = 0;
for await (const msg of q) {
  console.log(`\n[消息 ${++messageCount}] ${msg.type}:`);
  console.log(JSON.stringify(msg, null, 2));

  // 收集几条消息后退出
  if (msg.type === 'result' || messageCount >= 10) {
    console.log('\n=== 测试结束 ===');
    break;
  }
}
