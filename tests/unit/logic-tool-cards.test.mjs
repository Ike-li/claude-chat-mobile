// tests/unit/logic-tool-cards.test.mjs —— tool-cards.js 纯函数单测（工具摘要、标题、文件变更与子 agent 判定）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatToolSummary,
  formatPermInputDisplay,
  shouldEmitModeChangeBar,
  formatToolCardTitle,
  formatTaskToolTitle,
  renderTaskToolResultText,
  toolPreviewLabel,
  isFileMutationTool,
  countContentLines,
  estimateMutationLineStats,
  accumulateTurnFileChange,
  summarizeTurnFileChanges,
  isSubagentPayload,
  isSpawnToolName,
  formatBgTaskRowLabel,
  formatSubagentCardTitle,
  formatSubagentLastToolLine,
  formatSpawnDescription,
  isToolSummaryTruncated,
} from '../../app/public/js/logic/tool-cards.js';
import { setLang, t } from '../../app/public/js/i18n.js';

// tool-cards 内部广泛调用 t()，而 setLang 是模块级全局状态，同进程内别的测试可能改它。
// 每个 test 前重置为 zh，保证断言确定性。
test.beforeEach(() => setLang('zh'));

test.describe('formatToolSummary —— 工具卡片摘要可读化', () => {
  test('典型输入：单行紧凑 JSON 对象与数组转为 2 空格缩进展示', () => {
    assert.equal(
      formatToolSummary('{"command":"git status","timeout":1000}'),
      '{\n  "command": "git status",\n  "timeout": 1000\n}'
    );
    assert.equal(
      formatToolSummary('["src/a.js","src/b.js"]'),
      '[\n  "src/a.js",\n  "src/b.js"\n]'
    );
  });

  test('边界输入：null、undefined、空串与纯空白字符', () => {
    assert.equal(formatToolSummary(null), '');
    assert.equal(formatToolSummary(undefined), '');
    assert.equal(formatToolSummary(''), '');
    assert.equal(formatToolSummary('   '), '   ');
  });

  test('边界输入：非 string 类型值转为 String', () => {
    assert.equal(formatToolSummary(123), '123');
    assert.equal(formatToolSummary(true), 'true');
    assert.equal(formatToolSummary({ a: 1 }), '[object Object]');
  });

  test('产品语义：普通非 JSON 文本与截断残缺 JSON 原样返回不抛错', () => {
    assert.equal(formatToolSummary('npm test -- --bail'), 'npm test -- --bail');
    assert.equal(formatToolSummary('{"file_path":"/foo/bar'), '{"file_path":"/foo/bar');
    assert.equal(formatToolSummary('[1, 2,'), '[1, 2,');
  });
});

test.describe('formatPermInputDisplay —— UX-001 审批 sheet 内容可读化', () => {
  test('典型输入：ExitPlanMode 计划书返回 markdown 模式，优先提取 plan 字段', () => {
    const res = formatPermInputDisplay('ExitPlanMode', { plan: '## 步骤 1\n完成重构' });
    assert.deepEqual(res, { mode: 'markdown', text: '## 步骤 1\n完成重构' });
  });

  test('典型输入：普通工具对象返回 text 模式与 pretty JSON', () => {
    const res = formatPermInputDisplay('Bash', { command: 'ls -la' });
    assert.deepEqual(res, { mode: 'text', text: '{\n  "command": "ls -la"\n}' });
  });

  test('产品语义：普通命令字符串去掉外层转义引号，保留纯文本', () => {
    const res = formatPermInputDisplay('Bash', 'rm -rf /tmp/test\necho done');
    assert.deepEqual(res, { mode: 'text', text: 'rm -rf /tmp/test\necho done' });
  });

  test('产品语义：ExitPlanMode 若 input 为字符串也走 markdown 模式', () => {
    const res = formatPermInputDisplay('ExitPlanMode', '# 纯文本计划');
    assert.deepEqual(res, { mode: 'markdown', text: '# 纯文本计划' });
  });

  test('边界输入：ExitPlanMode 但 input 为无 plan 字段的对象，回落 pretty JSON', () => {
    const res = formatPermInputDisplay('ExitPlanMode', { other: 123 });
    assert.deepEqual(res, { mode: 'markdown', text: '{\n  "other": 123\n}' });
  });

  test('边界输入：toolName 为空/null/undefined，input 为 null/undefined/数字', () => {
    assert.deepEqual(formatPermInputDisplay(null, null), { mode: 'text', text: '' });
    assert.deepEqual(formatPermInputDisplay(undefined, undefined), { mode: 'text', text: '' });
    assert.deepEqual(formatPermInputDisplay('', 42), { mode: 'text', text: '42' });
  });
});

test.describe('shouldEmitModeChangeBar —— UX-019 档位变更系统条触发判定', () => {
  test('典型输入：默认或非 emptyStart 返回 true（允许留痕）', () => {
    assert.equal(shouldEmitModeChangeBar(), true);
    assert.equal(shouldEmitModeChangeBar({}), true);
    assert.equal(shouldEmitModeChangeBar({ emptyStart: false }), true);
  });

  test('产品语义：emptyStart 为 true 时返回 false（空态不打扰）', () => {
    assert.equal(shouldEmitModeChangeBar({ emptyStart: true }), false);
  });

  test('边界输入：各种 falsy 与 truthy 的 emptyStart 传值', () => {
    assert.equal(shouldEmitModeChangeBar({ emptyStart: 0 }), true);
    assert.equal(shouldEmitModeChangeBar({ emptyStart: null }), true);
    assert.equal(shouldEmitModeChangeBar({ emptyStart: '' }), true);
    assert.equal(shouldEmitModeChangeBar({ emptyStart: 1 }), false);
    assert.equal(shouldEmitModeChangeBar({ emptyStart: 'yes' }), false);
  });
});

test.describe('formatToolCardTitle —— UX-002 工具卡收起态标题与截断', () => {
  test('典型输入：未超长摘要格式化为「工具名 · 摘要」', () => {
    assert.equal(
      formatToolCardTitle('Grep', JSON.stringify({ pattern: 'TODO' })),
      'Grep · TODO'
    );
  });

  test('产品语义（A1）：Bash/Task/Agent 优先取模型的 description 语义描述，而非 command/prompt', () => {
    const bashInput = JSON.stringify({
      description: '查找过滤辅助函数',
      command: 'grep -rn "filterSafeResolve" src/',
    });
    assert.equal(formatToolCardTitle('Bash', bashInput), 'Bash · 查找过滤辅助函数');

    const agentInput = JSON.stringify({
      description: '审查前端变更',
      prompt: '请帮我 review 当前 diff',
    });
    assert.equal(formatToolCardTitle('Agent', agentInput), 'Agent · 审查前端变更');
  });

  test('产品语义：文件工具（Read/Edit/Write）优先取 file_path', () => {
    const readInput = JSON.stringify({ file_path: 'app/server.js' });
    assert.equal(formatToolCardTitle('Read', readInput), 'Read · app/server.js');
  });

  test('产品语义：未登记的自定义工具回落 TOOL_SUMMARY_KEYS 优先短字段', () => {
    const customInput = JSON.stringify({ path: 'src/index.ts', other: 'val' });
    assert.equal(formatToolCardTitle('CustomTool', customInput), 'CustomTool · src/index.ts');
  });

  test('产品语义：路径从尾部截断（留文件名），命令行从头部截断', () => {
    // looksLikePath 判据：含 / 且无空格。
    const pathStr = 'app/public/js/logic/tool-cards.js';
    // maxLen = 20: cap = 20, 尾部保留 19 字符 + '…'（'logic/tool-cards.js' 恰好 19 字符）
    const pathTitle = formatToolCardTitle('Read', pathStr, 20);
    assert.equal(pathTitle, 'Read · …logic/tool-cards.js');

    // 命令行带空格，不是路径，从头部截断
    const cmdStr = 'grep -rn "pattern" src/components/';
    const cmdTitle = formatToolCardTitle('Bash', cmdStr, 20);
    assert.equal(cmdTitle, 'Bash · grep -rn "pattern" …');
  });

  test('阈值测试：恰好在 maxLen 上与刚过 maxLen（+1）两侧', () => {
    const exactStr = '12345678901234567890'; // 20 字符
    const overStr = '123456789012345678901'; // 21 字符

    // 恰好 20 字符：不截断
    assert.equal(formatToolCardTitle('Custom', exactStr, 20), 'Custom · 12345678901234567890');
    // 刚过 20 字符：截断为 19 字符 + '…'（总长度 20）
    assert.equal(formatToolCardTitle('Custom', overStr, 20), 'Custom · 1234567890123456789…');
  });

  test('边界输入：maxLen 小于 8 时夹到下限 8，NaN 回落 48', () => {
    assert.equal(formatToolCardTitle('Custom', 'abcdefghijklmn', 0), 'Custom · abcdefg…');
    assert.equal(formatToolCardTitle('Custom', 'abcdefghijklmn', -5), 'Custom · abcdefg…');
    assert.equal(formatToolCardTitle('Custom', 'short', NaN), 'Custom · short');
  });

  test('边界输入：空输入、{}、空对象或 null/undefined 工具名', () => {
    assert.equal(formatToolCardTitle('Bash', null), 'Bash');
    assert.equal(formatToolCardTitle('Bash', ''), 'Bash');
    assert.equal(formatToolCardTitle('Bash', '{}'), 'Bash');
    assert.equal(formatToolCardTitle('Bash', '   {}   '), 'Bash');
    assert.equal(formatToolCardTitle('', 'ls'), 'tool · ls');
    assert.equal(formatToolCardTitle(null, null), 'tool');
  });
});

test.describe('formatTaskToolTitle —— Task 清单工具特化收起态标题', () => {
  test('典型输入：TaskCreate 提取 subject；TaskUpdate 提取 taskId 与 status；TaskGet 提取 taskId', () => {
    assert.equal(
      formatTaskToolTitle('TaskCreate', JSON.stringify({ subject: '编写单测' })),
      'TaskCreate · 编写单测'
    );
    assert.equal(
      formatTaskToolTitle('TaskUpdate', JSON.stringify({ taskId: '10', status: 'completed' })),
      'TaskUpdate · #10 → completed'
    );
    assert.equal(
      formatTaskToolTitle('TaskGet', JSON.stringify({ taskId: '10' })),
      'TaskGet · #10'
    );
    assert.equal(formatTaskToolTitle('TaskList', '{}'), 'TaskList');
  });

  test('产品语义：非 Task 清单工具返回 null 供上层回落', () => {
    assert.equal(formatTaskToolTitle('Bash', '{"command":"ls"}'), null);
    assert.equal(formatTaskToolTitle('Read', '{"file_path":"a.js"}'), null);
    assert.equal(formatTaskToolTitle('', '{}'), null);
  });

  test('边界输入：TaskUpdate 只有 taskId 无 status，或 taskId 为数字', () => {
    assert.equal(
      formatTaskToolTitle('TaskUpdate', JSON.stringify({ taskId: 42 })),
      'TaskUpdate · #42'
    );
    assert.equal(
      formatTaskToolTitle('TaskUpdate', JSON.stringify({ status: 'in_progress' })),
      'TaskUpdate'
    );
  });

  test('边界输入：TaskCreate 缺 subject 或非对象/残缺 JSON', () => {
    assert.equal(formatTaskToolTitle('TaskCreate', '{}'), 'TaskCreate');
    assert.equal(formatTaskToolTitle('TaskCreate', 'not-a-json'), 'TaskCreate');
    assert.equal(formatTaskToolTitle('TaskCreate', null), 'TaskCreate');
  });
});

test.describe('renderTaskToolResultText —— Task 清单与更新结果特化文本渲染', () => {
  test('典型输入：TaskList 结构化 tasks 数组渲染为图标清单与阻塞项', () => {
    const payload = JSON.stringify({
      tasks: [
        { id: 1, status: 'pending', subject: '任务一' },
        { id: 2, status: 'in_progress', subject: '任务二', blockedBy: [1] },
        { id: 3, status: 'completed', subject: '任务三' },
      ],
    });
    const result = renderTaskToolResultText('TaskList', payload);
    assert.equal(
      result,
      '☐ #1 任务一\n◐ #2 任务二（被 #1 阻塞）\n☒ #3 任务三'
    );
  });

  test('产品语义：TaskList 空任务列表在 zh 语言下渲染为「（无任务）」', () => {
    assert.equal(renderTaskToolResultText('TaskList', JSON.stringify({ tasks: [] })), '（无任务）');
    assert.equal(renderTaskToolResultText('TaskList', 'No tasks found'), '（无任务）');
  });

  test('产品语义：TaskList 兼容历史文本回显格式转换', () => {
    const historyText = '#1 [pending] 编写测试\n#2 [completed] 运行门禁';
    assert.equal(
      renderTaskToolResultText('TaskList', historyText),
      '☐ #1 编写测试\n☒ #2 运行门禁'
    );
    // 某一行不匹配时交还通用路径（返回 null）
    assert.equal(renderTaskToolResultText('TaskList', '#1 [pending] OK\n随机行'), null);
  });

  test('典型输入：TaskCreate 成功建任务渲染', () => {
    const payload = JSON.stringify({ task: { id: 5, subject: '搭建容器' } });
    assert.equal(renderTaskToolResultText('TaskCreate', payload), '☐ 已建任务 #5：搭建容器');

    const noSubject = JSON.stringify({ task: { id: 6 } });
    assert.equal(renderTaskToolResultText('TaskCreate', noSubject), '☐ 已建任务 #6');
  });

  test('典型输入：TaskUpdate 状态变化、更新字段与失败分支', () => {
    // 状态流转
    const statusPayload = JSON.stringify({
      taskId: 8,
      statusChange: { from: 'pending', to: 'completed' },
    });
    assert.equal(renderTaskToolResultText('TaskUpdate', statusPayload), '☒ #8 pending → completed');

    // 字段更新
    const fieldsPayload = JSON.stringify({
      taskId: 8,
      updatedFields: ['subject', 'priority'],
    });
    assert.equal(renderTaskToolResultText('TaskUpdate', fieldsPayload), '#8 已更新（subject, priority）');

    // 显式失败
    const failPayload = JSON.stringify({ success: false, error: '权限不足' });
    assert.equal(renderTaskToolResultText('TaskUpdate', failPayload), '更新失败：权限不足');

    const failNoMsg = JSON.stringify({ success: false });
    assert.equal(renderTaskToolResultText('TaskUpdate', failNoMsg), '更新失败：未知原因');
  });

  test('产品语义：TaskGet 详情保留通用展示（恒返回 null）', () => {
    assert.equal(renderTaskToolResultText('TaskGet', '{"id":1}'), null);
  });

  test('边界输入：非 Task 工具、非 string 输出、残缺输出、缺少必需字段', () => {
    assert.equal(renderTaskToolResultText('Bash', '{}'), null);
    assert.equal(renderTaskToolResultText('TaskList', null), null);
    assert.equal(renderTaskToolResultText('TaskList', 123), null);
    assert.equal(renderTaskToolResultText('TaskList', '{"tasks":"not-array"}'), null);
    assert.equal(renderTaskToolResultText('TaskCreate', '{"task":{}}'), null);
    assert.equal(renderTaskToolResultText('TaskUpdate', '{"updatedFields":[]}'), null);
  });
});

test.describe('toolPreviewLabel —— 文件类工具卡片预览入口文案', () => {
  test('典型输入：Read 工具或 changeKind=read 返回「📄 预览文件」', () => {
    assert.equal(toolPreviewLabel({ name: 'Read' }), '📄 预览文件');
    assert.equal(toolPreviewLabel({ changeKind: 'read' }), '📄 预览文件');
    assert.equal(toolPreviewLabel({ name: 'Edit', changeKind: 'read' }), '📄 预览文件');
  });

  test('典型输入：变更工具（Edit/Write 等）或 changeKind 变更返回「📄 预览变更」', () => {
    assert.equal(toolPreviewLabel({ name: 'Edit' }), '📄 预览变更');
    assert.equal(toolPreviewLabel({ name: 'Write' }), '📄 预览变更');
    assert.equal(toolPreviewLabel({ changeKind: 'edit' }), '📄 预览变更');
    assert.equal(toolPreviewLabel({ changeKind: 'write' }), '📄 预览变更');
  });

  test('边界输入：meta 为 null、undefined 或空对象', () => {
    assert.equal(toolPreviewLabel(null), '📄 预览变更');
    assert.equal(toolPreviewLabel(undefined), '📄 预览变更');
    assert.equal(toolPreviewLabel({}), '📄 预览变更');
  });
});

test.describe('isFileMutationTool —— 盘变更文件工具判定', () => {
  test('典型输入：改盘工具根据 name 或 changeKind 判定为 true', () => {
    assert.equal(isFileMutationTool({ name: 'Edit' }), true);
    assert.equal(isFileMutationTool({ name: 'Write' }), true);
    assert.equal(isFileMutationTool({ name: 'MultiEdit' }), true);
    assert.equal(isFileMutationTool({ name: 'NotebookEdit' }), true);
    assert.equal(isFileMutationTool({ changeKind: 'edit' }), true);
    assert.equal(isFileMutationTool({ changeKind: 'write' }), true);
    assert.equal(isFileMutationTool({ changeKind: 'multiedit' }), true);
    assert.equal(isFileMutationTool({ changeKind: 'notebook' }), true);
  });

  test('产品语义：changeKind 为 read 时恒为 false（优先级高于 name）', () => {
    assert.equal(isFileMutationTool({ name: 'Edit', changeKind: 'read' }), false);
    assert.equal(isFileMutationTool({ name: 'Read' }), false);
  });

  test('边界输入：非文件工具、空对象或 undefined 参数', () => {
    assert.equal(isFileMutationTool({ name: 'Bash' }), false);
    assert.equal(isFileMutationTool({ name: 'Glob' }), false);
    assert.equal(isFileMutationTool({}), false);
    assert.equal(isFileMutationTool(), false);
  });
});

test.describe('countContentLines —— 文本行数统计', () => {
  test('典型输入：单行与多行文本自然行数统计', () => {
    assert.equal(countContentLines('alpha'), 1);
    assert.equal(countContentLines('alpha\nbeta\ngamma'), 3);
  });

  test('产品语义：末尾换行按 split 自然计数', () => {
    assert.equal(countContentLines('alpha\n'), 2);
    assert.equal(countContentLines('alpha\nbeta\n'), 3);
    assert.equal(countContentLines('\n'), 2);
  });

  test('边界输入：null、undefined、空串与非 string 类型', () => {
    assert.equal(countContentLines(null), 0);
    assert.equal(countContentLines(undefined), 0);
    assert.equal(countContentLines(''), 0);
    assert.equal(countContentLines(12345), 1);
    assert.equal(countContentLines(true), 1);
  });
});

test.describe('estimateMutationLineStats —— 工具 input 行数增删估算', () => {
  test('典型输入：Edit 估算 new_string 与 old_string 的行数', () => {
    const stats = estimateMutationLineStats('Edit', {
      old_string: 'const a = 1;\nconst b = 2;',
      new_string: 'const a = 1;\nconst b = 3;\nconst c = 4;',
    });
    assert.deepEqual(stats, { added: 3, removed: 2 });
  });

  test('典型输入：MultiEdit 累加全部 edits 数组中的行数', () => {
    const stats = estimateMutationLineStats('MultiEdit', {
      edits: [
        { old_string: 'one\ntwo', new_string: 'one' },
        { old_string: 'three', new_string: 'three\nfour\nfive' },
      ],
    });
    assert.deepEqual(stats, { added: 4, removed: 3 });
  });

  test('典型输入：Write 和 NotebookEdit 只计 added，removed 恒为 0', () => {
    const writeStats = estimateMutationLineStats('Write', { content: 'line1\nline2' });
    assert.deepEqual(writeStats, { added: 2, removed: 0 });

    const nbStats = estimateMutationLineStats('NotebookEdit', { new_source: 'cell code' });
    assert.deepEqual(nbStats, { added: 1, removed: 0 });
  });

  test('产品语义：非文件变更工具（Read/Bash/Grep 等）返回全 0', () => {
    assert.deepEqual(estimateMutationLineStats('Read', { file_path: 'a.js' }), { added: 0, removed: 0 });
    assert.deepEqual(estimateMutationLineStats('Bash', { command: 'echo 1' }), { added: 0, removed: 0 });
  });

  test('边界输入：name 与 input 为 null、undefined 或空对象', () => {
    assert.deepEqual(estimateMutationLineStats(null, null), { added: 0, removed: 0 });
    assert.deepEqual(estimateMutationLineStats('Edit', {}), { added: 0, removed: 0 });
    assert.deepEqual(estimateMutationLineStats('MultiEdit', {}), { added: 0, removed: 0 });
  });
});

test.describe('accumulateTurnFileChange 与 summarizeTurnFileChanges —— 本轮文件变更账本累加与汇总', () => {
  test('典型输入：多次累加同一文件与其他文件，正确汇总总行数与 files 清单', () => {
    const map = new Map();

    // 第一次修改 fileA.js
    accumulateTurnFileChange(map, {
      path: 'src/fileA.js',
      name: 'Edit',
      changeKind: 'edit',
      toolUseId: 'tool-1',
      added: 5,
      removed: 2,
    });

    // 第一次修改 fileB.js
    accumulateTurnFileChange(map, {
      path: 'src/fileB.js',
      name: 'Write',
      changeKind: 'write',
      toolUseId: 'tool-2',
      added: 20,
      removed: 0,
    });

    // 第二次修改 fileA.js（累加行数，刷新 toolUseId）
    accumulateTurnFileChange(map, {
      path: 'src/fileA.js',
      name: 'Edit',
      changeKind: 'edit',
      toolUseId: 'tool-3',
      added: 3,
      removed: 1,
    });

    assert.equal(map.size, 2);
    const entryA = map.get('src/fileA.js');
    assert.equal(entryA.added, 8);
    assert.equal(entryA.removed, 3);
    assert.equal(entryA.toolUseId, 'tool-3');

    // 汇总验证
    const summary = summarizeTurnFileChanges(map);
    assert.ok(summary);
    assert.equal(summary.fileCount, 2);
    assert.equal(summary.added, 28);
    assert.equal(summary.removed, 3);
    assert.equal(summary.title, '已编辑 2 个文件');
    assert.equal(summary.statsLabel, '+28 -3');
    assert.equal(summary.files.length, 2);
    assert.equal(summary.files[0].path, 'src/fileA.js');
    assert.equal(summary.files[0].baseName, 'fileA.js');
    assert.equal(summary.files[1].path, 'src/fileB.js');
  });

  test('产品语义：非修改工具（如 Read）不计入变更账本', () => {
    const map = new Map();
    accumulateTurnFileChange(map, {
      path: 'src/read.js',
      name: 'Read',
      changeKind: 'read',
      added: 10,
      removed: 0,
    });
    assert.equal(map.size, 0);
    assert.equal(summarizeTurnFileChanges(map), null);
  });

  test('产品语义：汇总结果按 path 字母升序排序，支持 Windows 路径反斜杠 baseName 解析', () => {
    const map = new Map();
    accumulateTurnFileChange(map, { path: 'z/last.js', name: 'Write', added: 1 });
    accumulateTurnFileChange(map, { path: 'a\\win\\first.js', name: 'Write', added: 1 });

    const summary = summarizeTurnFileChanges(map);
    assert.equal(summary.files[0].path, 'a\\win\\first.js');
    assert.equal(summary.files[0].baseName, 'first.js');
    assert.equal(summary.files[1].path, 'z/last.js');
    assert.equal(summary.files[1].baseName, 'last.js');
  });

  test('边界输入：accumulateTurnFileChange 处理非 Map、空 path、负数/非法数字', () => {
    assert.equal(accumulateTurnFileChange(null, {}), null);
    const map = new Map();
    accumulateTurnFileChange(map, { path: '', name: 'Edit', added: 5 });
    accumulateTurnFileChange(map, { path: '   ', name: 'Edit', added: 5 });
    assert.equal(map.size, 0);

    // 负数与非法值下限归 0
    accumulateTurnFileChange(map, {
      path: 'src/test.js',
      name: 'Edit',
      added: -10,
      removed: NaN,
    });
    const entry = map.get('src/test.js');
    assert.equal(entry.added, 0);
    assert.equal(entry.removed, 0);
  });

  test('边界输入：summarizeTurnFileChanges 处理 null/undefined、空 Map、无效 entry', () => {
    assert.equal(summarizeTurnFileChanges(null), null);
    assert.equal(summarizeTurnFileChanges(undefined), null);
    assert.equal(summarizeTurnFileChanges(new Map()), null);

    const mapWithEmpty = new Map([['invalid', { path: '' }]]);
    assert.equal(summarizeTurnFileChanges(mapWithEmpty), null);
  });
});

test.describe('isSubagentPayload —— 子 agent 事件载荷判定', () => {
  test('典型输入：包含非空字符串 parentToolUseId 时返回 true', () => {
    assert.equal(isSubagentPayload({ parentToolUseId: 'tool-parent-123' }), true);
  });

  test('产品语义：数字、空串、null 都不算子 agent，防止脏字段误收进卡', () => {
    assert.equal(isSubagentPayload({ parentToolUseId: '' }), false);
    assert.equal(isSubagentPayload({ parentToolUseId: 12345 }), false);
    assert.equal(isSubagentPayload({ parentToolUseId: null }), false);
  });

  test('边界输入：null、undefined、非对象或缺失该字段的对象', () => {
    assert.equal(isSubagentPayload(null), false);
    assert.equal(isSubagentPayload(undefined), false);
    assert.equal(isSubagentPayload('parentToolUseId'), false);
    assert.equal(isSubagentPayload({}), false);
  });
});

test.describe('isSpawnToolName —— 生成子代理/后台的主工具判定', () => {
  test('典型输入与产品语义：认定 Agent、Task、Workflow 三种主工具', () => {
    assert.equal(isSpawnToolName('Agent'), true);
    assert.equal(isSpawnToolName('Task'), true);
    assert.equal(isSpawnToolName('Workflow'), true);
  });

  test('产品语义：常规工具或其他名称均为 false', () => {
    assert.equal(isSpawnToolName('Bash'), false);
    assert.equal(isSpawnToolName('Read'), false);
    assert.equal(isSpawnToolName('agent'), false); // 大小写敏感
    assert.equal(isSpawnToolName('task'), false);
  });

  test('边界输入：null、undefined、空串、数字', () => {
    assert.equal(isSpawnToolName(null), false);
    assert.equal(isSpawnToolName(undefined), false);
    assert.equal(isSpawnToolName(''), false);
    assert.equal(isSpawnToolName(123), false);
  });
});

test.describe('formatBgTaskRowLabel —— 后台任务行主标题格式化', () => {
  test('典型输入：local_agent/agent 前缀 🤖，local_bash/bash 前缀 🖥', () => {
    assert.equal(
      formatBgTaskRowLabel({ taskType: 'local_agent', message: '规划中' }),
      '🤖 规划中'
    );
    assert.equal(
      formatBgTaskRowLabel({ taskType: 'agent', message: '审查中' }),
      '🤖 审查中'
    );
    assert.equal(
      formatBgTaskRowLabel({ taskType: 'local_bash', message: 'npm test' }),
      '🖥 npm test'
    );
    assert.equal(
      formatBgTaskRowLabel({ taskType: 'bash', message: 'cargo check' }),
      '🖥 cargo check'
    );
  });

  test('产品语义：避免重复图标前缀', () => {
    assert.equal(
      formatBgTaskRowLabel({ taskType: 'local_agent', message: '🤖 已经在跑' }),
      '🤖 已经在跑'
    );
    assert.equal(
      formatBgTaskRowLabel({ taskType: 'bash', message: '🖥 make' }),
      '🖥 make'
    );
  });

  test('产品语义：清洗重复阶段词（如 Search: search: 结果）', () => {
    assert.equal(
      formatBgTaskRowLabel({ taskType: 'other', message: 'Search: search: 查询相关代码' }),
      'Search：查询相关代码'
    );
    assert.equal(
      formatBgTaskRowLabel({ taskType: 'other', message: '审查：审查：已通过' }),
      '审查：已通过'
    );
  });

  test('产品语义：消息为空时回落 subagentType 或真实 taskId，排斥合成 taskId', () => {
    // 回落 subagentType
    assert.equal(
      formatBgTaskRowLabel({ taskType: 'agent', subagentType: 'Reviewer' }),
      '🤖 Reviewer'
    );

    // 回落真实 taskId（截取前 12 字符）
    assert.equal(
      formatBgTaskRowLabel({ taskType: 'bash', taskId: 'task-real-123456789' }),
      '🖥 task-real-12'
    );

    // 合成 taskId（__notask_* 或 localcmd:*）不得泄漏，应回落到「后台任务」
    assert.equal(
      formatBgTaskRowLabel({ taskType: 'bash', taskId: '__notask_local_bash' }),
      '🖥 后台任务'
    );
    assert.equal(
      formatBgTaskRowLabel({ taskType: 'bash', taskId: 'localcmd:12345' }),
      '🖥 后台任务'
    );
  });

  test('边界输入：全空参数、非 string taskType、其它未加图标种类', () => {
    assert.equal(formatBgTaskRowLabel(), '后台任务');
    assert.equal(formatBgTaskRowLabel({}), '后台任务');
    assert.equal(formatBgTaskRowLabel({ taskType: 'workflow', message: '流水线' }), '流水线');
  });
});

test.describe('formatSubagentCardTitle —— 子 agent 折叠卡标题', () => {
  test('典型输入：运行中与已完成状态，带用量、工具调用与失败次数', () => {
    const runningTitle = formatSubagentCardTitle({
      subagentType: 'Coder',
      running: true,
      failures: 1,
      toolUses: 5,
      durationMs: 70000,
      totalTokens: 2500,
    });
    // 失败在最前，其次 tools，其次 usage (1m 10s · 2.5k tok)
    assert.equal(
      runningTitle,
      '🤖 Coder 运行中 · ❌ 1 · 5 tools · 1m 10s · 2.5k tok'
    );

    const completedTitle = formatSubagentCardTitle({
      subagentType: 'Reviewer',
      running: false,
    });
    assert.equal(completedTitle, '🤖 Reviewer 已完成');
  });

  test('产品语义：历史回放数据缺席时诚实降级，不添加 0 tools 或 0s 等伪占位符', () => {
    const title = formatSubagentCardTitle({
      subagentType: 'Tester',
      running: true,
      failures: 0,
      toolUses: 0,
      durationMs: null,
      totalTokens: null,
    });
    assert.equal(title, '🤖 Tester 运行中');
  });

  test('边界输入：默认值与缺省 subagentType 兜底', () => {
    assert.equal(formatSubagentCardTitle(), '🤖 子 agent 运行中');
    assert.equal(formatSubagentCardTitle({ subagentType: '' }), '🤖 子 agent 运行中');
    assert.equal(formatSubagentCardTitle({ subagentType: '   ' }), '🤖 子 agent 运行中');
    assert.equal(formatSubagentCardTitle({ running: false }), '🤖 子 agent 已完成');
  });
});

test.describe('formatSubagentLastToolLine —— 聚合卡单行动作槽（最近工具）', () => {
  test('典型输入：仅工具名 vs 工具名 + 描述', () => {
    assert.equal(
      formatSubagentLastToolLine({ lastToolName: 'Bash' }),
      '↳ Bash'
    );
    assert.equal(
      formatSubagentLastToolLine({ lastToolName: 'Grep', description: '搜索配置项' }),
      '↳ Grep: 搜索配置项'
    );
  });

  test('产品语义：剥除 description 开头与 subagentType 重复的前缀（冒号中英文双形态）', () => {
    assert.equal(
      formatSubagentLastToolLine({
        lastToolName: 'Edit',
        subagentType: 'Writer',
        description: 'Writer: 修改文档说明',
      }),
      '↳ Edit: 修改文档说明'
    );
    assert.equal(
      formatSubagentLastToolLine({
        lastToolName: 'Edit',
        subagentType: 'Writer',
        description: 'Writer：修改文档说明',
      }),
      '↳ Edit: 修改文档说明'
    );
  });

  test('产品语义：前缀用 ↳ 而非终端制表符 ⎿', () => {
    const res = formatSubagentLastToolLine({ lastToolName: 'Read' });
    assert.ok(res.startsWith('↳ '));
    assert.ok(!res.includes('⎿'));
  });

  test('阈值测试：description 超过 60 字符截断，恰好 60 字符不截断', () => {
    const exactDesc = 'A'.repeat(60);
    const overDesc = 'A'.repeat(61);

    assert.equal(
      formatSubagentLastToolLine({ lastToolName: 'Read', description: exactDesc }),
      `↳ Read: ${exactDesc}`
    );
    assert.equal(
      formatSubagentLastToolLine({ lastToolName: 'Read', description: overDesc }),
      `↳ Read: ${'A'.repeat(60)}…`
    );
  });

  test('边界输入：缺少 lastToolName、input 为 null 或 undefined 返回 null', () => {
    assert.equal(formatSubagentLastToolLine(null), null);
    assert.equal(formatSubagentLastToolLine(undefined), null);
    assert.equal(formatSubagentLastToolLine({}), null);
    assert.equal(formatSubagentLastToolLine({ lastToolName: '' }), null);
    assert.equal(formatSubagentLastToolLine({ description: '仅有描述' }), null);
  });
});

test.describe('formatSpawnDescription —— 聚合卡派发任务描述提取', () => {
  test('典型输入：JSON 对象中按顺序优先提取 description / prompt / args / name', () => {
    const withDesc = JSON.stringify({ description: '任务说明', prompt: '原始 prompt' });
    assert.equal(formatSpawnDescription(withDesc), '任务说明');

    const withPrompt = JSON.stringify({ prompt: '原始提示词' });
    assert.equal(formatSpawnDescription(withPrompt), '原始提示词');

    const withArgs = JSON.stringify({ args: '--verbose' });
    assert.equal(formatSpawnDescription(withArgs), '--verbose');

    const withName = JSON.stringify({ name: 'build-step' });
    assert.equal(formatSpawnDescription(withName), 'build-step');
  });

  test('典型输入：非 JSON 字符串直接清洗后返回', () => {
    assert.equal(formatSpawnDescription('执行数据迁移脚本'), '执行数据迁移脚本');
  });

  test('阈值测试：超过 maxLen 截断（默认 120），恰好 120 字符不截断', () => {
    const exactStr = 'x'.repeat(120);
    const overStr = 'x'.repeat(121);

    assert.equal(formatSpawnDescription(exactStr), exactStr);
    assert.equal(formatSpawnDescription(overStr), `${'x'.repeat(120)}…`);

    // 自定义 maxLen
    assert.equal(formatSpawnDescription('12345678901', 10), '1234567890…');
  });

  test('边界输入：null、undefined、空串、{} 或无目标字段的对象返回 null', () => {
    assert.equal(formatSpawnDescription(null), null);
    assert.equal(formatSpawnDescription(undefined), null);
    assert.equal(formatSpawnDescription(''), null);
    assert.equal(formatSpawnDescription('{}'), null);
    assert.equal(formatSpawnDescription(JSON.stringify({ irrelevant: 123 })), null);
  });
});

test.describe('isToolSummaryTruncated —— 工具摘要截断嗅探判定', () => {
  test('典型输入：嗅探 summary 中的截断文本标记', () => {
    assert.equal(isToolSummaryTruncated(`output data ${t('…（已截断）')}`), true);
    assert.equal(isToolSummaryTruncated('output data without marker'), false);
  });

  test('产品语义：options.truncated 具有最高优先权，显式布尔值压过文本嗅探', () => {
    // 文本有标记但 truncated 为 false
    assert.equal(
      isToolSummaryTruncated(`output ${t('…（已截断）')}`, { truncated: false }),
      false
    );
    // 文本无标记但 truncated 为 true
    assert.equal(
      isToolSummaryTruncated('normal text', { truncated: true }),
      true
    );
  });

  test('边界输入：summary 为 null、undefined、非 string 类型', () => {
    assert.equal(isToolSummaryTruncated(null), false);
    assert.equal(isToolSummaryTruncated(undefined), false);
    assert.equal(isToolSummaryTruncated(12345), false);
    assert.equal(isToolSummaryTruncated({}), false);
  });
});
