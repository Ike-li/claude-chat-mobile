// tests/unit/history.test.mjs —— history.js 单测（tmpdir 注入，零网络/零真实 claude 目录）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir, getSessionHistory, HISTORY_MAX_MESSAGES } from '../../src/sessions/history.js';

const BASE = join(tmpdir(), `ccm-hist-${process.pid}`);
mkdirSync(BASE, { recursive: true });

function writeJSONL(dir, id, entries) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

test('getSessionHistory: 文件不存在返回 []', async () => {
  const result = await getSessionHistory('no-such-id', '/no/cwd', 50, { baseDir: BASE });
  assert.deepEqual(result, []);
});

test('getSessionHistory: 空文件返回 []', async () => {
  const cwd = '/test/empty-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'empty-sess', []);
  const result = await getSessionHistory('empty-sess', cwd, 50, { baseDir: BASE });
  assert.deepEqual(result, []);
});

test('getSessionHistory: 提取 user / assistant 消息', async () => {
  const cwd = '/test/basic-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'basic', [
    { type: 'user', message: { role: 'user', content: '你好' }, timestamp: '2024-01-01T00:00:00Z' },
    { type: 'assistant', message: { role: 'assistant', content: '你好！' }, timestamp: '2024-01-01T00:00:01Z' },
  ]);
  const msgs = await getSessionHistory('basic', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content, '你好');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content, '你好！');
});

test('getSessionHistory: isMeta 条目被过滤', async () => {
  const cwd = '/test/meta-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'metahist', [
    { type: 'user', isMeta: true, message: { role: 'user', content: '系统注入' } },
    { type: 'user', message: { role: 'user', content: '真实消息' } },
  ]);
  const msgs = await getSessionHistory('metahist', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, '真实消息');
});

test('getSessionHistory: type:mode 记录（claude --resume 写入）被过滤、不当消息', async () => {
  // 回归护栏：web 端 resume 会话时 claude --resume 会向 transcript 追加一条 {type:'mode'} 权限模式记录
  // 并刷新 mtime。该记录不得进入历史消息流——否则会改变消息长度、令只读追平 catchUpStep 把「己方 resume
  // 的写盘」误判成外部（终端）新消息而误锁只读。这是本轮「纯 web 打开会话被误锁」修复所依赖的不变式。
  const cwd = '/test/mode-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'modehist', [
    { type: 'user', message: { role: 'user', content: '真实消息' } },
    { type: 'mode', mode: 'default' },  // claude --resume 启动时写入
  ]);
  const msgs = await getSessionHistory('modehist', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, '真实消息');
});

test('getSessionHistory: 纯工具调用输出为 tool_use / tool_result 结构化条目（冷路径可重建卡片）', async () => {
  const cwd = '/test/tool-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'toolhist', [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }] }, timestamp: '2026-07-13T10:00:00.000Z' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok\n', is_error: false }] }, timestamp: '2026-07-13T10:00:01.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: '真实回复' }, timestamp: '2026-07-13T10:00:02.000Z' },
  ]);
  const msgs = await getSessionHistory('toolhist', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].kind, 'tool_use');
  assert.equal(msgs[0].name, 'Bash');
  assert.equal(msgs[0].toolUseId, 'x');
  assert.ok(String(msgs[0].inputSummary || '').includes('ls'));
  assert.equal(msgs[1].kind, 'tool_result');
  assert.equal(msgs[1].toolUseId, 'x');
  assert.equal(msgs[1].ok, true);
  assert.ok(String(msgs[1].outputSummary || '').includes('ok'));
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs[2].content, '真实回复');
  assert.equal(msgs[2].kind, undefined);
});

test('getSessionHistory: 同一 assistant 消息内 text + tool_use 按块序拆成多条', async () => {
  const cwd = '/test/tool-mixed';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'mixed', [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '先说明一下' },
          { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
          { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/tmp/b.ts' } },
        ],
      },
      timestamp: '2026-07-13T11:00:00.000Z',
    },
  ]);
  const msgs = await getSessionHistory('mixed', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].content, '先说明一下');
  assert.equal(msgs[1].kind, 'tool_use');
  assert.equal(msgs[1].toolUseId, 'r1');
  assert.equal(msgs[2].kind, 'tool_use');
  assert.equal(msgs[2].toolUseId, 'r2');
});

test('getSessionHistory: tool_result is_error=true → ok:false；thinking 块折叠回显', async () => {
  const cwd = '/test/tool-err';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'toolerr', [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '很长的思考……' },
          { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/x' } },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'Error: denied', is_error: true }],
      },
    },
  ]);
  const msgs = await getSessionHistory('toolerr', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].kind, 'thinking');
  assert.ok(String(msgs[0].content).includes('很长的思考'));
  assert.equal(msgs[1].kind, 'tool_use');
  assert.equal(msgs[1].name, 'Edit');
  assert.equal(msgs[2].kind, 'tool_result');
  assert.equal(msgs[2].ok, false);
});

test('getSessionHistory: <task-notification> 注入条目被过滤（不回显成 XML 气泡）', async () => {
  const cwd = '/test/tasknotif-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'tasknotif', [
    { type: 'user', message: { role: 'user', content: '跑个后台任务' } },
    { type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>w60</task-id>\n</task-notification>' } },
    { type: 'assistant', message: { role: 'assistant', content: '后台任务结果汇报如下' } },
  ]);
  const msgs = await getSessionHistory('tasknotif', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].content, '跑个后台任务');
  assert.equal(msgs[1].content, '后台任务结果汇报如下');
});

test('getSessionHistory: 以 <task-notification> 开头但无闭合标签的普通消息不被过滤（收紧误伤）', async () => {
  const cwd = '/test/tasknotif-bare';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'bare', [
    { type: 'user', message: { role: 'user', content: '<task-notification> 这个标签是什么意思？帮我看看' } }, // 无 </task-notification>
  ]);
  const msgs = await getSessionHistory('bare', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 1, '无闭合标签=真实用户消息，应保留');
  assert.ok(msgs[0].content.includes('这个标签是什么意思'));
});

test('getSessionHistory: CLI 系统行（isMeta=false 的 interrupt / 空 turn / 命令输出）被过滤', async () => {
  // 回归护栏：<local-command-stdout>（本地命令的执行输出，非用户输入）、[Request interrupted by user]
  // （打断标记）、assistant 的 'No response requested.'（Continue/继续 触发的 resume 空 turn）均
  // isMeta=false，会漏过上面的 isMeta 闸、被当成 user/assistant 气泡回显。这些都不是对话内容，必须过滤。
  // 注：<command-name>/<command-message>/<command-args>（slash 命令本身的调用块）不在此列——见下方
  // 「slash 命令块重建」测试：那才是用户实际打出的那一行，磁盘上唯一留存处，不该被当噪音丢弃。
  // fixture 全部不带 isMeta，复刻 CLI 真实形态——否则测试会像旧版一样自带 isMeta=true 而测不出该 bug。
  const cwd = '/test/cli-noise-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'clinoise', [
    { type: 'user', message: { role: 'user', content: '真实提问' } },
    { type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model to Opus 4.8 (default)</local-command-stdout>' } },
    { type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } },
    { type: 'user', message: { role: 'user', content: '[Request interrupted by user for tool use]' } },
    { type: 'assistant', message: { role: 'assistant', content: 'No response requested.' } },
    { type: 'assistant', message: { role: 'assistant', content: '真实回答' } },
  ]);
  const msgs = await getSessionHistory('clinoise', cwd, 50, { baseDir: BASE });
  assert.deepEqual(msgs.map(m => m.content), ['真实提问', '真实回答'], 'CLI 系统噪音行不得回显成气泡');
});

test('getSessionHistory: slash 命令块（<command-name>/<command-args>）重建成 "/命令名 参数" 文本，不再整体丢弃', async () => {
  // 7/12 真实事故：自定义项目命令（如 /deep-research <query>）落盘时用的是和内置命令（/model /effort）
  // 完全相同的 <command-message>/<command-name>/<command-args> 标签块——此前 isCliSystemLine 把这整块
  // 当"CLI 噪音"一律丢弃，而对自定义命令，这个标签块是磁盘上唯一留存用户原话的地方，一丢就是把用户
  // 那一整个回合连根拔掉（切会话再切回/刷新页面走磁盘回放路径时整体消失，只剩 assistant 气泡）。
  // 终端等价性要求：无论内置命令还是自定义命令，都该像终端里那样显示成一行 "/command-name args"，
  // 而非被当噪音丢弃、也非原样吐出裸 XML 标签。
  // 配对的 isMeta=true 展开条目（完整 prompt 模板）依然应被 isMeta 闸过滤——那条是合成内容，不是用户输入，
  // 显示出来只会是更多噪音（一大坨 workflow 模板），不在本次修复范围内。
  const cwd = '/test/slash-command-rebuild';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'slashcmd', [
    // 真实磁盘样本的标签顺序（<command-message> 在前）——自定义项目命令，带参数
    { type: 'user', message: { role: 'user', content: '<command-message>deep-research</command-message>\n<command-name>/deep-research</command-name>\n<command-args>判定一个软件是否在提审服泄露所需要数据都有哪些</command-args>' } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'Run the "deep-research" workflow...\n\nInvoke: Workflow({...})' } },
    { type: 'assistant', message: { role: 'assistant', content: '深度研究工作流已启动' } },
    // 旧测试 fixture 的标签顺序（<command-name> 在前）——内置命令，空参数：验证重建不依赖标签顺序、空参数不留多余空格
    { type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>' } },
    { type: 'assistant', message: { role: 'assistant', content: '真实回答' } },
  ]);
  const msgs = await getSessionHistory('slashcmd', cwd, 50, { baseDir: BASE });
  assert.deepEqual(msgs.map(m => m.content), [
    '/deep-research 判定一个软件是否在提审服泄露所需要数据都有哪些',
    '深度研究工作流已启动',
    '/model',
    '真实回答',
  ], 'slash 命令块应重建为可读文本并保留；配对的 isMeta 展开条目仍应被过滤');
});

test('getSessionHistory: 形似系统行的真实消息不被误伤；API Error 作为运行事件保留', async () => {
  // 收紧误伤：只有「以标签开头且闭合」/「整条精确等于标记」才算系统行。用户以这些词开头的真实讨论、
  // 或随口提到，必须保留。API Error（上游/网络错误）是真实运行事件、有诊断价值、性质不同于命令噪音，
  // 明确保留——如需过滤是独立的产品决策，别顺手滤掉。
  const cwd = '/test/cli-noise-safe';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'safe', [
    { type: 'user', message: { role: 'user', content: '帮我解释下 <command-name> 这个标签是干嘛的' } }, // 不以标签开头
    { type: 'assistant', message: { role: 'assistant', content: 'No response requested. 这句在 resume 时代表空 turn' } }, // 非精确整条
    { type: 'assistant', message: { role: 'assistant', content: 'API Error: Unable to connect to API (ECONNRESET)' } }, // 运行事件，保留
  ]);
  const msgs = await getSessionHistory('safe', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 3, '两条真实对话 + 一条 API Error 运行事件，都应保留');
  assert.ok(msgs[0].content.includes('这个标签是干嘛的'));
  assert.ok(msgs[2].content.startsWith('API Error:'));
});

test('getSessionHistory: IDE 集成 / bash 模式注入行（isMeta 缺失）被过滤（实证 code-review #4 漏网）', async () => {
  // 实证：真实 transcript（234 会话）里 CLI 的 IDE 集成注入 <ide_opened_file>/<ide_selection> 与 `!` bash
  // 模式注入 <bash-input>/<bash-stdout>(常内嵌 <bash-stderr>) 共漏 21 条——均 role=user、isMeta 缺失(undefined)、
  // 闭合成对、内容是注入原文（"The user opened the file…" / "sudo bash -c…"），漏过 isMeta 闸当 user 气泡回显。
  // 与 7/10 的 <command-*>/<local-command-*> 同类，当初未覆盖此两族。fixture 复刻真实形态（不带 isMeta）。
  const cwd = '/test/ide-bash-noise';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'idebash', [
    { type: 'user', message: { role: 'user', content: '真实提问' } },
    { type: 'user', message: { role: 'user', content: '<ide_opened_file>The user opened the file /a/b.md</ide_opened_file>' } },
    { type: 'user', message: { role: 'user', content: '<ide_selection>The user selected the lines 1 to 1 from /a/b.md</ide_selection>' } },
    { type: 'user', message: { role: 'user', content: "<bash-input>sudo bash -c 'x'</bash-input>" } },
    { type: 'user', message: { role: 'user', content: '<bash-stdout></bash-stdout><bash-stderr>sudo: a terminal is required</bash-stderr>' } },
    { type: 'assistant', message: { role: 'assistant', content: '真实回答' } },
  ]);
  const msgs = await getSessionHistory('idebash', cwd, 50, { baseDir: BASE });
  assert.deepEqual(msgs.map(m => m.content), ['真实提问', '真实回答'], 'IDE/bash 注入不得回显成气泡');
});

test('getSessionHistory: 形似 ide/bash 标签的真实消息不被误伤（非开头 / 未闭合）', async () => {
  const cwd = '/test/ide-bash-safe';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'idebashsafe', [
    { type: 'user', message: { role: 'user', content: '帮我解释 <ide_opened_file> 这个标签是什么' } }, // 非以标签开头
    { type: 'user', message: { role: 'user', content: '<bash-input> 但我故意不闭合它，这是我随口打的一句话' } }, // 无闭合标签
  ]);
  const msgs = await getSessionHistory('idebashsafe', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 2, '非开头 / 未闭合 = 真实消息，应保留');
});

test('getSessionHistory: 同 uuid 重复落盘去重（interrupt+queue 竞态重复写 → 不显重复气泡）', async () => {
  // 实证 code-review：真实 transcript（234 会话）扫出 1 个会话有 8 条同 uuid 重复落盘（interrupt+queue 竞态），
  // getSessionHistory 无 uuid 去重 → 渲染成重复气泡。uuid 是每条唯一标识：同 uuid = 同一逻辑消息写了两次
  // （非合法重复），按 uuid 去重安全——合法重复内容（如两次「继续」）是不同 uuid、不误删。
  const cwd = '/test/dup-uuid';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'dupuuid', [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: '第一句' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: '回答' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: '回答' } }, // 同 uuid 重复落盘
    { type: 'user', uuid: 'u2', message: { role: 'user', content: '继续' } },
    { type: 'user', uuid: 'u3', message: { role: 'user', content: '继续' } }, // 合法重复内容、不同 uuid → 保留
  ]);
  const msgs = await getSessionHistory('dupuuid', cwd, 50, { baseDir: BASE });
  assert.deepEqual(msgs.map(m => m.content), ['第一句', '回答', '继续', '继续'],
    '同 uuid 去重（「回答」只一次）；不同 uuid 的合法重复保留（「继续」两次）');
});

test('getSessionHistory: 无 uuid 的条目不因 undefined 相撞而互相去重', async () => {
  // 防御：部分旧条目可能无 uuid；不得把它们全当「同 undefined」去重掉。
  const cwd = '/test/no-uuid';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'nouuid', [
    { type: 'user', message: { role: 'user', content: 'A' } },
    { type: 'assistant', message: { role: 'assistant', content: 'B' } },
    { type: 'user', message: { role: 'user', content: 'C' } },
  ]);
  const msgs = await getSessionHistory('nouuid', cwd, 50, { baseDir: BASE });
  assert.deepEqual(msgs.map(m => m.content), ['A', 'B', 'C'], '无 uuid 条目全保留');
});

test('getSessionHistory: 子 agent（isSidechain）回显并挂靠最近主链 Agent toolUseId', async () => {
  const cwd = '/test/sidechain-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'sidehist', [
    { type: 'user', message: { role: 'user', content: '主线问题' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'agent-main-1', name: 'Agent', input: { description: ' dig', subagent_type: 'Explore' } },
    ] } },
    // 子 agent 内部：磁盘 isSidechain；无 parent_tool_use_id 时挂靠上一主链 Agent
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: '子 agent 内部输出' }] } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sa-read', content: 'ok', is_error: false }] } },
    { type: 'assistant', message: { role: 'assistant', content: '主线回答' } },
  ]);
  const msgs = await getSessionHistory('sidehist', cwd, 50, { baseDir: BASE });
  assert.equal(msgs[0].content, '主线问题');
  assert.equal(msgs[1].kind, 'tool_use');
  assert.equal(msgs[1].name, 'Agent');
  const sideText = msgs.find(m => m.content === '子 agent 内部输出');
  assert.ok(sideText, 'sidechain 正文应回显');
  assert.equal(sideText.isSidechain, true);
  assert.equal(sideText.parentToolUseId, 'agent-main-1');
  const sideTr = msgs.find(m => m.kind === 'tool_result' && m.toolUseId === 'sa-read');
  assert.ok(sideTr);
  assert.equal(sideTr.parentToolUseId, 'agent-main-1');
  assert.equal(msgs[msgs.length - 1].content, '主线回答');
});

test('getSessionHistory: content 为数组时拼接 text 块', async () => {
  const cwd = '/test/arr-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'arrhist', [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] } },
  ]);
  const msgs = await getSessionHistory('arrhist', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, '第一段\n第二段');
});

test('getSessionHistory: limit 参数截取尾部 N 条', async () => {
  const cwd = '/test/limit-hist';
  const dir = join(BASE, getProjectDir(cwd));
  const entries = Array.from({ length: 10 }, (_, i) => ({
    type: 'user', message: { role: 'user', content: `消息 ${i}` }
  }));
  writeJSONL(dir, 'limithist', entries);
  const msgs = await getSessionHistory('limithist', cwd, 3, { baseDir: BASE });
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].content, '消息 7');
  assert.equal(msgs[2].content, '消息 9');
});

// ── 完整加载（回归：曾因 1MB 尾部读 + 默认 50 双截断，导致大会话 Web 端只显示尾部，
//    与 CLI /resume 的全量历史不同步）─────────────────────────────────────────

test('getSessionHistory: 文件超 1MB 仍读到最开头的消息（头部不被截断）', async () => {
  const cwd = '/test/big-head-hist';
  const dir = join(BASE, getProjectDir(cwd));
  // 首条放可识别标记，随后用 ~50KB/条填充把文件撑过 1MB——旧实现只读尾部 1MB，会丢掉首条
  const filler = 'x'.repeat(50 * 1024);
  const entries = [{ type: 'user', message: { role: 'user', content: '最开头的消息' } }];
  for (let i = 0; i < 30; i++) {
    entries.push({ type: 'assistant', message: { role: 'assistant', content: `${filler}${i}` } });
  }
  writeJSONL(dir, 'bighead', entries);
  const msgs = await getSessionHistory('bighead', cwd, undefined, { baseDir: BASE });
  assert.equal(msgs.length, 31);
  assert.equal(msgs[0].content, '最开头的消息'); // 头部未被 1MB 截断
});

test('getSessionHistory: 默认 limit 下 >50 条消息全部返回（不砍到 50）', async () => {
  const cwd = '/test/many-hist';
  const dir = join(BASE, getProjectDir(cwd));
  const entries = Array.from({ length: 120 }, (_, i) => ({
    type: 'user', message: { role: 'user', content: `消息 ${i}` }
  }));
  writeJSONL(dir, 'manyhist', entries);
  const msgs = await getSessionHistory('manyhist', cwd, undefined, { baseDir: BASE });
  assert.equal(msgs.length, 120);
  assert.equal(msgs[0].content, '消息 0');
  assert.equal(msgs[119].content, '消息 119');
});

// 超 HISTORY_MAX_MESSAGES 条时削顶到上限——流式阶段封顶（返回上限=内存上限），防超大会话
// 全量常驻 always-on 进程（P2 review）。锁住「削头留尾」的契约：未来若有人改回累积全量或削错方向即红。
test('getSessionHistory: 超上限会话削顶到 HISTORY_MAX_MESSAGES，保留尾部', async () => {
  const cwd = '/test/cap-hist';
  const dir = join(BASE, getProjectDir(cwd));
  const total = HISTORY_MAX_MESSAGES * 2 + 5; // 跨过 2× 批量裁剪阈值，覆盖循环内 + 循环后两段裁剪
  const entries = Array.from({ length: total }, (_, i) => ({
    type: 'user', message: { role: 'user', content: `消息 ${i}` }
  }));
  writeJSONL(dir, 'caphist', entries);
  const msgs = await getSessionHistory('caphist', cwd, undefined, { baseDir: BASE });
  assert.equal(msgs.length, HISTORY_MAX_MESSAGES);                       // 削顶到上限
  assert.equal(msgs[0].content, `消息 ${total - HISTORY_MAX_MESSAGES}`); // 头部被削，首条=倒数第 N 条
  assert.equal(msgs[msgs.length - 1].content, `消息 ${total - 1}`);      // 尾部（最新）保留
});

// ── classifyTranscriptTail：尾部形态判定（单驾驶员模型的核心判据，2026-07-12 实验实证）──────────
// 依据：CLI 每个动作即时落盘——assistant 发起 tool_use 先落、tool_result 回来再落、最终文本收尾落。
// 于是消息链最后一条的形态可直接读出「轮次是否完结」，不依赖磁盘静默时间窗猜测（修「长工具调用
// 期间零写入 >12.5s 被误判成终端停了」）。实测双样本：正在跑的会话判 pending、已结束的判 settled。
