export function createContentScenarios(getContext) {
  return [
    {
      prefix: 'test:message-edit',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay } = getContext();
        console.log('[mock] Emitting assistant reply for message edit regression');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        await delay(250);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: {
            messageId: 'msg_message_edit_1',
            text: 'message edit fixture: use the assistant Edit action to restore the previous prompt.'
          }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_message_edit_1', durationMs: 250, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:tool',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay } = getContext();
        console.log('[mock] Starting test:tool sequence');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'thinking_delta', payload: { messageId: 'msg_tool_1', text: '<thinking>Refactoring duplicate date helper utilities...</thinking>' }
        });
        await delay(500);

        // Tool 1: Read File
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_read', name: 'read_file', inputSummary: 'utils/date.js' }
        });
        await delay(1000);
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: 't_read', ok: true, outputSummary: 'Successfully read 124 lines from utils/date.js' }
        });

        // Text delta
        socket.emit('agent:event', {
          seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_tool_1', text: "I have read `utils/date.js` and identified duplicate formatting helpers. Let's merge them now." }
        });
        await delay(500);

        // Tool 2: Edit File
        socket.emit('agent:event', {
          seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_edit', name: 'edit_file', inputSummary: 'utils/date.js' }
        });
        await delay(1200);
        socket.emit('agent:event', {
          seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: 't_edit', ok: true, outputSummary: 'Successfully refactored duplicated blocks in utils/date.js' }
        });

        // Tool 3: Run Command（截断摘要 + truncated 标记，供「展开全文」）
        socket.emit('agent:event', {
          seq: 7, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_bash', name: 'run_command', inputSummary: 'npm test' }
        });
        await delay(1200);
        socket.emit('agent:event', {
          seq: 8, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: {
            toolUseId: 't_bash', ok: true,
            outputSummary: '✓ All 5 visual regression unit tests passed successfully! …（已截断）',
            truncated: true,
          }
        });

        socket.emit('agent:event', {
          seq: 9, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_tool_1', text: "\n\nAll tools executed cleanly. The test suite has confirmed the date merger was a 100% success!" }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        socket.emit('agent:event', {
          seq: 10, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_tool_1', durationMs: 4400, costUsd: 0.0035, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:tool-out-of-order',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay } = getContext();
        console.log('[mock] Starting test:tool-out-of-order sequence');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_order_read', name: 'read_file', inputSummary: 'config.json' }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_order_cmd', name: 'run_command', inputSummary: 'npm run check' }
        });
        await delay(500);
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: 't_order_cmd', ok: true, outputSummary: 'command result: npm run check syntax OK' }
        });
        await delay(250);
        socket.emit('agent:event', {
          seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: 't_order_read', ok: true, outputSummary: 'read_file result: config.json contains mock settings' }
        });
        socket.emit('agent:event', {
          seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_tool_ooo_1', text: 'Out-of-order tool results stayed attached to their original cards.' }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_tool_ooo_1', durationMs: 900, costUsd: 0.001, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:tool-error',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, mockInstances, delay } = getContext();
        console.log('[mock] Starting test:tool-error sequence');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_tool_error_cmd', name: 'run_command', inputSummary: 'npm run failing-script' }
        });
        await delay(400);

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'error', payload: { message: 'mock tool crashed while running npm run failing-script' }
        });
      },
    },
    {
      // turn-end 文件变更汇总：Write + Edit → result 后出现「已编辑 2 个文件」卡（Read 不计入）
      command: 'test:file-changes',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay } = getContext();
        console.log('[mock] Starting test:file-changes sequence');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_fc_1', text: 'Updating project docs…' }
        });
        await delay(150);

        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: {
            toolUseId: 't_fc_write',
            name: 'Write',
            inputSummary: JSON.stringify({ file_path: 'CLAUDE.md', content: 'line1\nline2\nline3' }),
            file: { path: 'CLAUDE.md', changeKind: 'write', added: 3, removed: 0 },
          }
        });
        await delay(200);
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: 't_fc_write', ok: true, outputSummary: 'Wrote CLAUDE.md' }
        });
        await delay(150);

        socket.emit('agent:event', {
          seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: {
            toolUseId: 't_fc_edit',
            name: 'Edit',
            inputSummary: JSON.stringify({ file_path: 'README.md', old_string: 'old', new_string: 'a\nb' }),
            file: { path: 'README.md', changeKind: 'edit', added: 2, removed: 1 },
          }
        });
        await delay(200);
        socket.emit('agent:event', {
          seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: 't_fc_edit', ok: true, outputSummary: 'Edited README.md' }
        });
        await delay(100);

        socket.emit('agent:event', {
          seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: {
            toolUseId: 't_fc_read',
            name: 'Read',
            inputSummary: JSON.stringify({ file_path: 'package.json' }),
            file: { path: 'package.json', changeKind: 'read' },
          }
        });
        await delay(100);
        socket.emit('agent:event', {
          seq: 7, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: 't_fc_read', ok: true, outputSummary: '{}' }
        });

        socket.emit('agent:event', {
          seq: 8, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_fc_1', text: '\nDocs updated.' }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 9, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_fc_1', durationMs: 1200, costUsd: 0.002, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:disconnect-now',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay } = getContext();
        console.log('[mock] Completing current turn, then forcing a socket disconnect');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        await delay(100);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_disconnect_now_1', text: '模拟断线前的最后一条回复。' }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_disconnect_now_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
        setTimeout(() => socket.disconnect(true), 50);
      },
    },
    {
      // TC-24：子 agent 可折叠卡——主 Agent tool_use 预建卡 + parentToolUseId 嵌套 text/thinking/tool
      // 默认收起；展开后可见子 agent 正文与内部工具。对齐 agent.js forwardSubagentText 分流字段。
      command: 'test:subagent',
      run: async ({ activeInst }) => {
        // 空首页兜底需重指 viewingInstanceId，故此处用 let（其余场景为 const）
        let { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, setViewingInstanceId } = getContext();
        console.log('[mock] Starting test:subagent sequence');
        // 空首页（session:new 后 viewing=null）时 activeInst 为 undefined——兜底到 inst_1
        if (!activeInst) {
          activeInst = mockInstances.find(i => i.instanceId === 'inst_1') || mockInstances[0];
          if (!activeInst) return;
          viewingInstanceId = activeInst.instanceId;
          setViewingInstanceId(viewingInstanceId);
        }
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        // 主会话：启动 Agent 工具（input 含 subagent_type + description）→ 前端预建可折叠卡
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: {
            toolUseId: 'agent-parent-1',
            name: 'Agent',
            inputSummary: JSON.stringify({ description: 'Review auth module', subagent_type: 'code-reviewer' }),
          }
        });
        await delay(200);

        // 子 agent thinking（带 parentToolUseId）→ 进卡内，不进主流 details.thinking
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'thinking_delta', payload: {
            messageId: 'msg_sa_1', text: 'Scanning auth handlers for CSRF gaps…',
            parentToolUseId: 'agent-parent-1', subagentType: 'code-reviewer',
          }
        });
        await delay(150);

        // 子 agent 内部工具
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: {
            toolUseId: 't_sa_read', name: 'Read',
            inputSummary: JSON.stringify({ file_path: 'src/auth.js' }),
            parentToolUseId: 'agent-parent-1', subagentType: 'code-reviewer',
          }
        });
        await delay(200);
        socket.emit('agent:event', {
          seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: {
            toolUseId: 't_sa_read', ok: true, outputSummary: 'export function login() { /* ... */ }',
            parentToolUseId: 'agent-parent-1', subagentType: 'code-reviewer',
          }
        });
        await delay(150);

        // 子 agent 正文
        socket.emit('agent:event', {
          seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: {
            messageId: 'msg_sa_1', text: 'Found 1 CSRF gap in login handler.',
            parentToolUseId: 'agent-parent-1', subagentType: 'code-reviewer',
          }
        });
        await delay(150);

        // 主 Agent tool 完成 → 卡标题改「已完成」
        socket.emit('agent:event', {
          seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: {
            toolUseId: 'agent-parent-1', ok: true,
            outputSummary: 'Subagent code-reviewer finished review.',
          }
        });
        await delay(100);

        // 主流收尾正文 + result
        socket.emit('agent:event', {
          seq: 7, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_main_sa', text: 'Review complete — see nested agent card for details.' }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 8, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_main_sa', durationMs: 1200, costUsd: 0.002, isError: false, models: [activeModel] }
        });
      },
    },
    {
      // Workflow：预建 workflow 卡 + parentToolUseId 子流 + 多后台任务列表（单任务也展开）
      command: 'test:workflow-subagents',
      run: async ({ activeInst }) => {
        let { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, setViewingInstanceId } = getContext();
        console.log('[mock] Starting test:workflow-subagents sequence');
        if (!activeInst) {
          activeInst = mockInstances.find(i => i.instanceId === 'inst_1') || mockInstances[0];
          if (!activeInst) return;
          viewingInstanceId = activeInst.instanceId;
          setViewingInstanceId(viewingInstanceId);
        }
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: {
            toolUseId: 'wf-parent-1',
            name: 'Workflow',
            inputSummary: JSON.stringify({ args: '调研 Python 后端', description: '深度调研工作流' }),
          }
        });
        await delay(150);

        // 并发后台任务心跳（Workflow Search 阶段常见）——附全量 tasks 快照（与真实后端 emitBgTasksSnapshot 对齐）
        const bgTasks = [
          { taskId: 'bg_search_1', taskType: 'local_agent', message: 'Explore：Searching docs…', lastToolName: 'WebSearch', subagentType: 'Explore' },
          { taskId: 'bg_search_2', taskType: 'local_agent', message: 'Explore：Searching github…', lastToolName: 'WebSearch', subagentType: 'Explore' },
        ];
        for (const t of bgTasks) {
          socket.emit('agent:event', {
            seq: 0, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'task_progress', transient: true,
            payload: {
              taskId: t.taskId, taskType: t.taskType, message: t.message,
              lastToolName: t.lastToolName, subagentType: t.subagentType,
              tasks: bgTasks,
            },
          });
        }
        await delay(150);

        // 子流挂到 Workflow parent
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: {
            messageId: 'msg_wf_sa', text: 'Scope done. Five search agents running.',
            parentToolUseId: 'wf-parent-1', subagentType: 'workflow',
          }
        });
        await delay(100);
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: {
            toolUseId: 't_wf_web', name: 'WebSearch',
            inputSummary: JSON.stringify({ query: 'python backend 2026' }),
            parentToolUseId: 'wf-parent-1', subagentType: 'workflow',
          }
        });
        await delay(100);

        socket.emit('agent:event', {
          seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: {
            toolUseId: 'wf-parent-1', ok: true, outputSummary: 'Workflow finished.',
          }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_wf_main', durationMs: 800, costUsd: 0.01, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:stream',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay } = getContext();
        console.log('[mock] Starting test:stream sequence');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        // Send thinking indicator
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'thinking_delta', payload: { messageId: 'msg_stream_1', text: '<thinking>Analyzing visual test parameters...\nEmitting mock response chunks...\n</thinking>' }
        });
        await delay(800);

        // CLI 式动态状态行：per-turn 秒表/输出 token 权威帧（status_line.turn，对齐真 server buildWebStatusLine）
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'status_line', payload: {
            ts: Date.now(), instanceId: viewingInstanceId, model: activeModel,
            turn: { startedAt: Date.now() - 1500, outTokens: 3300 },
          }
        });

        // Stream text chunks
        const responseText = "Hello! This is a **fully visual-oriented** mock response stream.\n\n" +
          "Here is what we can test:\n" +
          "1. **Markdown Formatting**: Bold, lists, code highlighting.\n" +
          "2. **Interactive Controls**: Click buttons and sliders.\n" +
          "3. **Animations**: Loading and transitions.\n\n" +
          "```javascript\n" +
          "// Code block rendering test\n" +
          "const tester = 'Antigravity';\n" +
          "console.log(`E2E Testing by ${tester}`);\n" +
          "```\n" +
          "Try running `test:tool` or `test:permission` next!";

        // Chunk and stream
        const words = responseText.split(' ');
        for (let i = 0; i < words.length; i++) {
          const chunk = words[i] + ' ';
          socket.emit('agent:event', {
            seq: 2 + i, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'text_delta', payload: { messageId: 'msg_stream_1', text: chunk }
          });
          await delay(60); // fast visual streaming
        }

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        socket.emit('agent:event', {
          seq: 100, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_stream_1', durationMs: 2500, costUsd: 0.0015, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:stream-long',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay } = getContext();
        console.log('[mock] Starting long streaming sequence for interrupt test');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'thinking_delta', payload: { messageId: 'msg_long_1', text: '<thinking>Starting a long-running analysis task...</thinking>' }
        });
        await delay(500);

        // Stream slowly: gives time for interrupt while keeping tests bounded.
        for (let i = 0; i < 20; i++) {
          // WS-008：每次 delay 后检查 abort 标志——interrupt 处理器会把 activeInst.aborted 置 true。旧实现不检查，
          // 中断后这个 16s(20×800ms) 循环仍继续每 800ms 发 text_delta + 末尾 result，污染后续 test case（TC-11
          // 之后的用例会收到本轮迟到事件）。检测到中断即停：不再发 delta、不发终态 result（interrupt 已发 system）。
          if (activeInst.aborted) { console.log('[mock] stream-long aborted by interrupt'); return; }
          socket.emit('agent:event', {
            seq: 2 + i, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'text_delta', payload: { messageId: 'msg_long_1', text: `Chunk ${i + 1} of analysis... ` }
          });
          await delay(800);
        }

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 100, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_long_1', durationMs: 16000, costUsd: 0.012, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:queued-hold',
      // 排队转正回归用：busy 保持 4s 后正常收 result——期间入队的第二条消息应在 result 后自动摘排队标记
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay } = getContext();
        console.log('[mock] Starting queued-hold sequence');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_qhold_1', text: 'Working on the first turn... ' }
        });
        await delay(4000);
        if (activeInst.aborted) { console.log('[mock] queued-hold aborted by interrupt'); return; }
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_qhold_1', durationMs: 4000, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:unsafe-markdown',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay } = getContext();
        console.log('[mock] Starting test:unsafe-markdown sequence');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        const responseText = [
          'This response keeps **safe bold markdown** and `safe_inline_code` visible.',
          '',
          '<script>window.__ccmUnsafeMarkdownScriptFired = true</script>',
          '<img src="/__unsafe-markdown-probe.png" onerror="window.__ccmUnsafeMarkdownImageFired = true" alt="unsafe image probe">',
          '<a href="javascript:window.__ccmUnsafeMarkdownClickFired = true">unsafe javascript link</a>',
          '<span onclick="window.__ccmUnsafeMarkdownClickFired = true">unsafe click probe</span>'
        ].join('\n');

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_unsafe_markdown_1', text: responseText }
        });
        await delay(150);

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: {
            messageId: 'msg_unsafe_markdown_1',
            text: responseText,
            durationMs: 150,
            costUsd: 0,
            isError: false,
            models: [activeModel]
          }
        });
      },
    },
    {
      // E18 附件预览：一次铺出三条点击路径的夹具——
      //  ① live user_message meta（thumb + storedName）→ 点缩略图按需拉原图；
      //  ② 历史 [附件] 解析形态（history_append 走 renderHistoryBubbles，无 thumb 只有 chip）→ 点 chip 拉原图；
      //  ③ 已删文件（storedName 不在 mock fixture 里）→ toast 降级、不开灯箱。
      command: 'test:attach-preview',
      run: async () => {
        const { socket, activeEpoch, viewingInstanceId, delay } = getContext();
        console.log('[mock] Emitting attachment preview fixtures');
        const thumb = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'user_message', payload: {
            text: '看看这张实时消息里的图',
            attachments: [{ name: 'photo.png', mimeType: 'image/png', size: MOCK_PNG_SIZE, thumb, storedName: '1700000000000-abcd1234-photo.png' }]
          }
        });
        await delay(100);
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'history_append', payload: {
            messages: [
              { role: 'user', content: '重启后回看的历史附件消息', attachments: [{ name: 'old.png', storedName: '1700000000001-deadbeef-old.png' }] },
              { role: 'user', content: '文件已被清理的历史附件', attachments: [{ name: 'gone.png', storedName: '1700000000002-99999999-gone.png' }] }
            ]
          }
        });
      },
    },
  ];
}

// 与 server.js MOCK_ATTACH_PNG 字节数一致（1×1 PNG fixture 的解码长度）；仅用于 meta.size 展示，无行为语义。
const MOCK_PNG_SIZE = 70;
