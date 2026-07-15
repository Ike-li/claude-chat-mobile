// tests/unit/logic.test.mjs —— public/js/logic.js 纯逻辑单测（node 内置 test runner，零依赖）。
// 跑法：npm test （= node --test）。覆盖 model 桥接 / effort 档位 / 状态优先级 / ANSI 配平 / esc。
// 不覆盖 DOM 接线与 iOS/Safari 平台行为（归 npm run check + 真机），见 docs/design.md 验收纪律。
import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, formatToolSummary, pickPasteImageFiles, attachmentDataUrl, toolPreviewLabel, withUltracodeKeyword, withUltracodeTier, resolveEffortSelection, parseUsageForWeb } from '../../public/js/logic.js';

test.describe('parseUsageForWeb（③ 套餐额度窗后端：提取 rate_limits + 降级 + 剔除隐私）', () => {
  // 一份"订阅认证 max、额度可用"的典型 usage（结构照 SDKControlGetUsageResponse 运行时形态）
  const fullUsage = () => ({
    session: { total_cost_usd: 1.23, total_api_duration_ms: 100, total_duration_ms: 200, model_usage: {} },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 42, resets_at: '2026-07-14T20:00:00Z' },
      seven_day: { utilization: 15, resets_at: '2026-07-20T00:00:00Z' },
      seven_day_opus: { utilization: 8, resets_at: '2026-07-20T00:00:00Z' },
      seven_day_sonnet: { utilization: 3, resets_at: '2026-07-20T00:00:00Z' },
      model_scoped: [{ display_name: 'Fable', utilization: 10, resets_at: '2026-07-20T00:00:00Z' }],
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    },
    behaviors: { day: { request_count: 999, session_count: 7 }, skills: [{ name: 'secret-skill' }] },
  });

  test('null / undefined / 非对象 → { available:false }（降级，不给额度窗）', () => {
    assert.deepEqual(parseUsageForWeb(null), { available: false });
    assert.deepEqual(parseUsageForWeb(undefined), { available: false });
    assert.deepEqual(parseUsageForWeb('x'), { available: false });
  });

  test('rate_limits_available:false（第三方 provider）→ { available:false }，即便 rate_limits 有值也不外露', () => {
    const u = fullUsage(); u.rate_limits_available = false;
    assert.deepEqual(parseUsageForWeb(u), { available: false });
  });

  test('剔除 behaviors 隐私（本机使用画像绝不外露）', () => {
    const r = parseUsageForWeb(fullUsage());
    assert.equal('behaviors' in r, false, 'behaviors 不得出现在输出');
    const json = JSON.stringify(r);
    assert.equal(json.includes('behaviors'), false);
    assert.equal(json.includes('secret-skill'), false);
    assert.equal(json.includes('request_count'), false);
  });

  test('提取五类命名额度窗 + model_scoped 数组（utilization / resetsAt / displayName）', () => {
    const r = parseUsageForWeb(fullUsage());
    assert.equal(r.available, true);
    assert.equal(r.rateLimits.five_hour.utilization, 42);
    assert.equal(r.rateLimits.five_hour.resetsAt, '2026-07-14T20:00:00Z');
    assert.equal(r.rateLimits.seven_day.utilization, 15);
    assert.equal(r.rateLimits.seven_day_opus.utilization, 8);
    assert.equal(r.rateLimits.seven_day_sonnet.utilization, 3);
    assert.equal(Array.isArray(r.rateLimits.model_scoped), true);
    assert.equal(r.rateLimits.model_scoped[0].displayName, 'Fable');
    assert.equal(r.rateLimits.model_scoped[0].utilization, 10);
  });

  test('保留 subscriptionType + session.totalCostUsd（非隐私）', () => {
    const r = parseUsageForWeb(fullUsage());
    assert.equal(r.subscriptionType, 'max');
    assert.equal(r.session.totalCostUsd, 1.23);
  });

  test('utilization:0 是有效值（刚开始用）不被当 falsy 丢弃', () => {
    const u = fullUsage(); u.rate_limits.five_hour.utilization = 0;
    assert.equal(parseUsageForWeb(u).rateLimits.five_hour.utilization, 0);
  });

  test('防御性：rate_limits 为 null（available:true 但无窗）→ available:true、无 rateLimits 键、不崩', () => {
    const u = fullUsage(); u.rate_limits = null;
    const r = parseUsageForWeb(u);
    assert.equal(r.available, true);
    assert.equal('rateLimits' in r, false);
  });

  test('防御性：单窗字段缺失 / 非法（utilization 非数、resets_at 非串、窗为 null）→ 跳过该窗不崩', () => {
    const u = fullUsage();
    u.rate_limits.five_hour = { utilization: 'oops', resets_at: 123 };
    u.rate_limits.seven_day = null;
    const r = parseUsageForWeb(u);
    assert.equal('five_hour' in r.rateLimits, false, 'utilization 非数 + resets_at 非串 → 整窗省略');
    assert.equal('seven_day' in r.rateLimits, false, 'null 窗省略');
    assert.equal(r.rateLimits.seven_day_opus.utilization, 8, '其余窗不受影响');
  });
});

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
