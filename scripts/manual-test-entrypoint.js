// 手动测试：模拟 onSessionId 调用（验证 writeSessionEntrypoint 写入的 entrypoint:"cli" 被 readHeadMeta 优先读到）。
// WS-013：完全隔离到【临时 Claude home】，绝不写真实 ~/.claude/projects。旧实现向真实 home 写假 session、
// 清理只在成功路径末尾（unlinkSync），两处 process.exit(1) 提前退出 + 无 try/finally / signal handler → 失败
// 或 Ctrl-C 永久留下历史污染。现整个流程包在 try/finally + SIGINT/SIGTERM handler 里，任何退出都删临时 home。
import { appendFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// history.js 在【import 时】即以 homedir()（POSIX 下取 $HOME）固定 CLAUDE_DIR，故必须在改完 HOME【之后】
// 才 import 它——ESM 静态 import 会早于本文件任何赋值执行，只能用动态 await import()。
const TMP_HOME = mkdtempSync(join(tmpdir(), 'ccm-manual-entry-'));
process.env.HOME = TMP_HOME;
const { getProjectDir, listSessions } = await import('../history.js');

const WORK_DIR = '/tmp/ccm-test';
const testSessionId = 'test-manual-' + Date.now();

// 任何退出（成功 / 失败 / 中断）都删整个临时 home——唯一 fixture 精确清理，绝无残留。
let cleaned = false;
const cleanup = () => { if (cleaned) return; cleaned = true; try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* 已删/不存在 */ } };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

console.log('测试 writeSessionEntrypoint 函数...\n');

let exitCode = 0;
try {
  // 模拟 writeSessionEntrypoint 的逻辑
  const projectDir = getProjectDir(WORK_DIR);
  const claudeDir = join(TMP_HOME, '.claude', 'projects', projectDir);
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
    console.log(`  第 ${i + 1} 行: type="${obj.type}", entrypoint="${obj.entrypoint}"`);
  }
  console.log('');

  // 验证 history.js 读取
  console.log('4. 验证 history.js 的 readHeadMeta...');
  const sessions = await listSessions(WORK_DIR, { limit: 100 });
  const session = sessions.find(s => s.id === testSessionId);

  if (!session) {
    throw new Error('listSessions 未返回该会话');
  }

  console.log(`✓ 找到会话: ${session.id.slice(0, 20)}...`);
  console.log(`  title: "${session.title}"`);
  console.log(`  entrypoint: "${session.entrypoint}"`);
  console.log(`  model: ${session.model}\n`);

  if (session.entrypoint !== 'cli') {
    throw new Error(`期望 entrypoint="cli"，实际 "${session.entrypoint}"`);
  }

  console.log('✅ 验证成功: readHeadMeta 优先读取到我们写入的 entrypoint:"cli"');
  console.log('   （而非 SDK 后续写入的 "sdk-cli"）\n');
} catch (e) {
  console.error(`❌ 失败: ${e.message}`);
  exitCode = 1;
} finally {
  cleanup();
  console.log('🧹 临时 Claude home 已清理');
}
process.exit(exitCode);
