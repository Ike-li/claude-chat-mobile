// tests/unit/logic.test.mjs —— public/js/logic.js 纯逻辑单测（node 内置 test runner，零依赖）。
// 跑法：npm test （= node --test）。覆盖 model 桥接 / effort 档位 / 状态优先级 / ANSI 配平 / esc。
// 不覆盖 DOM 接线与 iOS/Safari 平台行为（归 npm run check + 真机），见 docs/design.md 验收纪律。
import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, formatToolSummary, formatPermInputDisplay, formatToolCardTitle, shouldEmitModeChangeBar, pickPasteImageFiles, attachmentDataUrl, toolPreviewLabel, withUltracodeKeyword, withUltracodeTier, resolveEffortSelection } from '../../public/js/logic.js';

test('esc: 转义 HTML 元字符', () => {
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(5), '5');
});

// 工具卡片摘要可读化：agent 侧 stringify 是紧凑单行，手机展开一坨难读。
// formatToolSummary 只负责「能 parse 的 JSON → 缩进 pretty；非 JSON/空 → 原样」，不碰 DOM/hljs。
test('formatToolSummary: 紧凑 JSON 对象 → 2 空格缩进', () => {
  const raw = '{"file_path":"/a.js","old_string":"x"}';
  assert.equal(formatToolSummary(raw), '{\n  "file_path": "/a.js",\n  "old_string": "x"\n}');
});

test('formatToolSummary: JSON 数组同样 pretty', () => {
  assert.equal(formatToolSummary('[1,{"a":2}]'), '[\n  1,\n  {\n    "a": 2\n  }\n]');
});

test('formatToolSummary: 非 JSON 纯文本原样返回（Bash 命令、脱敏占位符、错误文案）', () => {
  assert.equal(formatToolSummary('ls -la /tmp'), 'ls -la /tmp');
  assert.equal(formatToolSummary('（base64 数据，约 48KB，已省略）'), '（base64 数据，约 48KB，已省略）');
  assert.equal(formatToolSummary('Error: permission denied'), 'Error: permission denied');
});

test('formatToolSummary: 截断后的残缺 JSON 不抛、原样返回（agent 的 TOOL_SUMMARY_CAP 会切尾）', () => {
  const truncated = '{"file_path":"/a.js","content":"hello wor'; // 缺闭合
  assert.equal(formatToolSummary(truncated), truncated);
});

test('formatToolSummary: 空/非字符串安全', () => {
  assert.equal(formatToolSummary(''), '');
  assert.equal(formatToolSummary(null), '');
  assert.equal(formatToolSummary(undefined), '');
  assert.equal(formatToolSummary(42), '42');
});

// UX-001：审批 sheet 展示——ExitPlanMode 走 markdown 源文；普通命令去掉 JSON 引号转义、保留纯文本。
// 只做数据→数据（mode + text），DOM/DOMPurify 由 app.js 接线。
test('formatPermInputDisplay: ExitPlanMode 字符串计划 → markdown 模式，保留换行', () => {
  const plan = '## 计划\n1. 实现 X\n2. 测试 Y';
  assert.deepEqual(formatPermInputDisplay('ExitPlanMode', plan), { mode: 'markdown', text: plan });
});

test('formatPermInputDisplay: ExitPlanMode 对象取 plan 字段', () => {
  const plan = '## 计划\n1. 实现 X';
  assert.deepEqual(formatPermInputDisplay('ExitPlanMode', { plan }), { mode: 'markdown', text: plan });
});

test('formatPermInputDisplay: 普通命令字符串不包 JSON 引号', () => {
  assert.deepEqual(
    formatPermInputDisplay('run_command', 'git push origin main'),
    { mode: 'text', text: 'git push origin main' },
  );
});

test('formatPermInputDisplay: 普通工具对象 → pretty JSON 文本', () => {
  assert.deepEqual(
    formatPermInputDisplay('Write', { file_path: '/a.js', content: 'x' }),
    { mode: 'text', text: '{\n  "file_path": "/a.js",\n  "content": "x"\n}' },
  );
});

test('formatPermInputDisplay: 空/缺省安全', () => {
  assert.deepEqual(formatPermInputDisplay('run_command', null), { mode: 'text', text: '' });
  assert.deepEqual(formatPermInputDisplay('ExitPlanMode', null), { mode: 'markdown', text: '' });
  assert.deepEqual(formatPermInputDisplay(null, 'x'), { mode: 'text', text: 'x' });
});

// UX-002：工具卡收起态标题「工具名 · inputSummary 截断」——扫读对象，不必逐张展开。
test('formatToolCardTitle: 有摘要 → 工具名 · 摘要', () => {
  assert.equal(formatToolCardTitle('read_file', 'public/js/app.js'), 'read_file · public/js/app.js');
  assert.equal(formatToolCardTitle('run_command', 'npm test'), 'run_command · npm test');
});

test('formatToolCardTitle: 无摘要 → 仅工具名', () => {
  assert.equal(formatToolCardTitle('read_file', ''), 'read_file');
  assert.equal(formatToolCardTitle('read_file', null), 'read_file');
  assert.equal(formatToolCardTitle('read_file', '   '), 'read_file');
});

test('formatToolCardTitle: 长摘要按 maxLen 截断加省略号', () => {
  const long = 'a'.repeat(80);
  const title = formatToolCardTitle('Write', long, 40);
  assert.ok(title.startsWith('Write · '));
  assert.ok(title.endsWith('…'));
  // 总长不超过 工具名 + 分隔 + maxLen 摘要（省略号占 1）
  assert.ok(title.length <= 'Write · '.length + 40);
});

test('formatToolCardTitle: JSON 摘要取首个可读短字段（path/command 等）', () => {
  assert.equal(
    formatToolCardTitle('Read', JSON.stringify({ file_path: 'src/a.js', offset: 1 })),
    'Read · src/a.js',
  );
  assert.equal(
    formatToolCardTitle('Bash', JSON.stringify({ command: 'ls -la' })),
    'Bash · ls -la',
  );
});

test('formatToolCardTitle: 缺省工具名安全', () => {
  assert.equal(formatToolCardTitle('', 'x'), 'tool · x');
  assert.equal(formatToolCardTitle(null, null), 'tool');
});

// UX-019：空态不打档位变更系统条；有消息后可留痕。审批留痕不走此函数。
test('shouldEmitModeChangeBar: empty-start 抑制；非空放行', () => {
  assert.equal(shouldEmitModeChangeBar({ emptyStart: true }), false);
  assert.equal(shouldEmitModeChangeBar({ emptyStart: false }), true);
  assert.equal(shouldEmitModeChangeBar({}), true);
});

// 剪贴板粘贴图片：桌面 Chrome 截图/复制图后 Ctrl/Cmd+V 应进附件托盘。
// pickPasteImageFiles 只从 DataTransfer 里挑 image/* 文件项；纯文本粘贴返回空，交给浏览器默认。
test('pickPasteImageFiles: 无 clipboardData / 空 items → 空数组', () => {
  assert.deepEqual(pickPasteImageFiles(null), []);
  assert.deepEqual(pickPasteImageFiles({}), []);
  assert.deepEqual(pickPasteImageFiles({ items: [] }), []);
});

test('pickPasteImageFiles: 纯文本粘贴 → 空（不拦截默认粘贴文字）', () => {
  const items = [{ kind: 'string', type: 'text/plain', getAsFile: () => null }];
  assert.deepEqual(pickPasteImageFiles({ items }), []);
});

test('pickPasteImageFiles: image/png file 项 → 取出 File', () => {
  const file = { name: 'clip.png', type: 'image/png', size: 12 };
  const items = [
    { kind: 'string', type: 'text/plain', getAsFile: () => null },
    { kind: 'file', type: 'image/png', getAsFile: () => file },
  ];
  assert.deepEqual(pickPasteImageFiles({ items }), [file]);
});

test('pickPasteImageFiles: 多张图按顺序收集；非图片 file 跳过；getAsFile 空跳过', () => {
  const a = { name: 'a.png', type: 'image/png', size: 1 };
  const b = { name: 'b.jpeg', type: 'image/jpeg', size: 2 };
  const items = [
    { kind: 'file', type: 'image/png', getAsFile: () => a },
    { kind: 'file', type: 'application/pdf', getAsFile: () => ({ name: 'x.pdf', type: 'application/pdf' }) },
    { kind: 'file', type: 'image/jpeg', getAsFile: () => null },
    { kind: 'file', type: 'image/jpeg', getAsFile: () => b },
  ];
  assert.deepEqual(pickPasteImageFiles({ items }), [a, b]);
});

test('pickPasteImageFiles: items 不是可迭代 → 空数组，不抛', () => {
  assert.deepEqual(pickPasteImageFiles({ items: null }), []);
  assert.deepEqual(pickPasteImageFiles({ items: 42 }), []);
});

// 发送前点托盘附件预览：用完整 base64 拼 data URI（比 thumb 清晰）；非图片/无 data → null。
test('attachmentDataUrl: 图片 + base64 → data URI', () => {
  assert.equal(
    attachmentDataUrl({ mimeType: 'image/png', data: 'abc123' }),
    'data:image/png;base64,abc123'
  );
});

test('attachmentDataUrl: 非图片 / 缺 data → null（托盘不弹灯箱）', () => {
  assert.equal(attachmentDataUrl({ mimeType: 'application/pdf', data: 'abc' }), null);
  assert.equal(attachmentDataUrl({ mimeType: 'image/jpeg', data: '' }), null);
  assert.equal(attachmentDataUrl({ mimeType: 'image/jpeg' }), null);
  assert.equal(attachmentDataUrl(null), null);
});

test('attachmentDataUrl: mime 缺省但 data 在 → 不猜成图片，返回 null', () => {
  // 没有 image/* 类型就不当图片预览，避免把任意 base64 当图打开
  assert.equal(attachmentDataUrl({ data: 'abc' }), null);
  assert.equal(attachmentDataUrl({ mimeType: 'application/octet-stream', data: 'abc' }), null);
});

// 工具卡片预览入口：Read 只读文件、Edit/Write 才是变更——文案不能写死「预览变更」
test('toolPreviewLabel: Read / changeKind=read → 预览文件', () => {
  assert.match(toolPreviewLabel({ name: 'Read' }), /预览文件/);
  assert.match(toolPreviewLabel({ changeKind: 'read' }), /预览文件/);
  assert.ok(!toolPreviewLabel({ name: 'Read' }).includes('变更'));
});

test('toolPreviewLabel: Edit/Write/MultiEdit/NotebookEdit → 预览变更', () => {
  assert.match(toolPreviewLabel({ name: 'Edit', changeKind: 'edit' }), /预览变更/);
  assert.match(toolPreviewLabel({ name: 'Write', changeKind: 'write' }), /预览变更/);
  assert.match(toolPreviewLabel({ name: 'MultiEdit', changeKind: 'multiedit' }), /预览变更/);
  assert.match(toolPreviewLabel({ name: 'NotebookEdit', changeKind: 'notebook' }), /预览变更/);
});

test('toolPreviewLabel: changeKind 优先于 name（防前端只传一种字段）', () => {
  assert.match(toolPreviewLabel({ name: 'Edit', changeKind: 'read' }), /预览文件/);
  assert.match(toolPreviewLabel({ name: 'Read', changeKind: 'edit' }), /预览变更/);
});

test('toolPreviewLabel: 缺省安全，不抛', () => {
  assert.match(toolPreviewLabel(), /预览/);
  assert.match(toolPreviewLabel(null), /预览/);
});

test('withUltracodeKeyword: 单轮 ultracode 关键词前缀且不重复', () => {
  assert.equal(withUltracodeKeyword('重构日期工具'), 'ultracode 重构日期工具');
  assert.equal(withUltracodeKeyword('  重构日期工具  '), 'ultracode 重构日期工具');
  assert.equal(withUltracodeKeyword('ultracode 重构日期工具'), 'ultracode 重构日期工具');
  assert.equal(withUltracodeKeyword('UltraCode 重构日期工具'), 'UltraCode 重构日期工具');
  assert.equal(withUltracodeKeyword(''), 'ultracode');
});

// ultracode 是 CLI /effort 菜单 xhigh 之上的最高档（= xhigh effort + workflow 编排），
// 仅在支持 xhigh 的模型上出现。这两个纯函数把「档位列表拼装」与「选中后的行为解析」抽出可测。
test('withUltracodeTier: 含 xhigh 才追加 ultracode 最高档（镜像 CLI /effort），幂等', () => {
  assert.deepEqual(withUltracodeTier(['low', 'medium', 'high', 'xhigh']), ['low', 'medium', 'high', 'xhigh', 'ultracode']);
  assert.deepEqual(withUltracodeTier(['low', 'medium']), ['low', 'medium']); // 无 xhigh → 该模型不够格，不加
  assert.deepEqual(withUltracodeTier([]), []);
  assert.deepEqual(withUltracodeTier(['low', 'xhigh', 'ultracode']), ['low', 'xhigh', 'ultracode']); // 已含 → 不重复
  assert.deepEqual(withUltracodeTier(null), []);
});

test('resolveEffortSelection: ultracode 档借道 xhigh + 武装关键词，其余档不武装', () => {
  assert.deepEqual(resolveEffortSelection('ultracode'), { effort: 'xhigh', ultracode: true });
  assert.deepEqual(resolveEffortSelection('xhigh'), { effort: 'xhigh', ultracode: false });
  assert.deepEqual(resolveEffortSelection('low'), { effort: 'low', ultracode: false });
  assert.deepEqual(resolveEffortSelection(''), { effort: null, ultracode: false });
  assert.deepEqual(resolveEffortSelection(null), { effort: null, ultracode: false });
});
