function withContext(getContext, handler) {
  return async args => handler(getContext(), args);
}

export function createStatusScenarios(getContext) {
  const run = handler => withContext(getContext, handler);

  return [
    {
      command: 'test:cli-statusline',
      run: run(async ({ io, socket, activeEpoch, viewingInstanceId }) => {
        const now = Date.now();
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: now,
          type: 'status_line', payload: {
            ts: now,
            model: 'Opus 4.8', effort: 'max', thinking: { enabled: true },
            project: 'claude-chat-mobile', cwd: '/Users/you/code/claude-chat-mobile',
            ctx: { tokens: 45_000, in: 2_000, out: 1_500, w: 22_000, r: 21_000, usedPercent: 23, windowSize: 200_000 },
            session: { id: '784e20b1-a550-45d1-874b-13b5f55eeb46' },
            version: '2.1.210',
            source: { kind: 'cli', capturedAt: now, ageMs: 25 },
          },
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { text: 'CLI statusline snapshot ready' },
        });
      }),
    },
    {
      command: 'test:cli-statusline-unavailable',
      run: run(async ({ io, socket, activeEpoch, viewingInstanceId }) => {
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'status_line', payload: {
            cwd: '/Users/you/code/claude-chat-mobile',
            source: { kind: 'cli-unavailable', reason: 'stale', ageMs: 180_000 },
          },
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { text: 'CLI statusline unavailable' },
        });
      }),
    },
    {
      command: 'test:statusline',
      run: run(async ({ io, socket, activeEpoch, viewingInstanceId, delay }) => {
        const now = Date.now();
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: now,
          type: 'status_line', payload: {
            ts: now,
            model: 'claude-3-5-sonnet',
            effort: 'high',
            project: 'claude-chat-mobile',
            cwd: '/Users/you/code/claude-chat-mobile',
            git: { branch: 'feature/visual-testing', changed: 3, staged: 2, modified: 1, untracked: 0, ahead: 2, behind: 0, repo: 'Ike-li/claude-chat-mobile' },
            ctx: { tokens: 45000, cacheHitPct: 45, in: 2000, out: 1500, w: 22000, r: 21000, usedPercent: 23, windowSize: 200000 },
            rate: {
              fiveHour: { usedPercent: 42, resetsAt: new Date(now + 2 * 3600_000).toISOString() },
              sevenDay: { usedPercent: 11, resetsAt: new Date(now + 3 * 86400_000).toISOString() },
            },
            lines: { added: 12, removed: 4 },
            session: { id: '784e20b1-a550-45d1-874b-13b5f55eeb46' },
            cost: 0.37,
            duration: { wallMs: 2500, apiMs: 1200 },
            version: '2.1.178',
          },
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Simulated Terminal StatusLine updated successfully above!' },
        });
        await delay(500);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { text: 'Simulated Terminal StatusLine updated successfully above!' },
        });
      }),
    },
    {
      command: 'test:longmodel',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, mockInstances, permissionMode, delay }) => {
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'init', payload: {
            model: 'mimo-v2.5-pro-ultraspeed',
            cwd: mockInstances[0].cwd,
            claudeVersion: '0.1.0-mock',
            mcpServers: [],
            skillsCount: 7,
            permissionMode,
            slashCommands: [{ name: 'model', description: 'Switch active model' }],
          },
        });
        await delay(300);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_longmodel_1', durationMs: 100, costUsd: 0, isError: false, models: ['mimo-v2.5-pro-ultraspeed'] },
        });
      }),
    },
    {
      command: 'test:mirror',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, activeModel, delay }) => {
        const mirrorEvent = (readonly, stale) => ({
          seq: 0, epoch: 'server', sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'mirror_state', payload: { readonly, stale },
        });
        socket.emit('agent:event', mirrorEvent(true, false));
        await delay(1500);
        socket.emit('agent:event', mirrorEvent(true, true));
        await delay(1500);
        socket.emit('agent:event', mirrorEvent(false, false));
        await delay(200);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_mirror_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] },
        });
      }),
    },
    {
      command: 'test:mirror-armed',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, activeModel, delay }) => {
        const mirrorEvent = (readonly, stale) => ({
          seq: 0, epoch: 'server', sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'mirror_state', payload: { readonly, stale },
        });
        socket.emit('agent:event', mirrorEvent(true, false));
        await delay(3000);
        socket.emit('agent:event', mirrorEvent(false, false));
        await delay(200);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_mirror_armed_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] },
        });
      }),
    },
    {
      command: 'test:console-log-after-clear',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, activeModel, addMockSessionLog, delay }) => {
        addMockSessionLog(viewingInstanceId, '[MOCK_LOG_AFTER_CLEAR] New trace after clear for test:console-log-after-clear');
        await delay(100);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_console_log_after_clear_1', text: 'Console log after clear completed.' },
        });
        await delay(100);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_console_log_after_clear_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] },
        });
      }),
    },
    {
      command: 'test:stale-statusline-replay',
      run: run(async ({ io, socket, activeEpoch, viewingInstanceId, delay }) => {
        const now = Date.now();
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: now,
          type: 'status_line', payload: {
            ts: now,
            model: 'claude-3-5-haiku',
            project: 'another-react-project',
            cwd: '/Users/you/code/another-react-project',
            git: { branch: 'feature/other-workspace', changed: 7, staged: 3, modified: 2, untracked: 2, ahead: 1, behind: 0, repo: 'Ike-li/another-react-project' },
            ctx: { tokens: 99000, cacheHitPct: 12, in: 6000, out: 4000, w: 12000, r: 3000 },
            cost: 0.99,
            duration: { wallMs: 9000, apiMs: 6400 },
            version: '9.9.999',
          },
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Stale cross-workspace StatusLine replay emitted.' },
        });
        await delay(300);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { text: 'Stale cross-workspace StatusLine replay emitted.' },
        });
      }),
    },
    {
      command: 'test:needsyou',
      run: run(async ({ io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay }) => {
        let background = mockInstances.find(instance => instance.instanceId === 'inst_needsyou');
        if (!background) {
          background = {
            instanceId: 'inst_needsyou',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-needsyou',
            title: 'Background Approval Demo',
            state: 'permission',
            permissionMode: 'default',
            effort: null,
            model: activeModel,
          };
          mockInstances.push(background);
        } else {
          background.state = 'permission';
        }
        const waitingSince = Date.now() - 3 * 60_000;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: mockInstances.find(instance => instance.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd,
            dirs: [...new Set(mockInstances.map(instance => instance.cwd))],
            instances: mockInstances,
            needsYou: [{
              sessionId: background.sessionId,
              cwd: background.cwd,
              title: background.title,
              reason: 'awaiting_approval',
              waitingSince,
              toolName: 'Bash',
              instanceId: background.instanceId,
            }],
          },
        });
        await delay(100);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_needsyou_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] },
        });
      }),
    },
    {
      // 服务状态面板告警注入：后续 service:status ack 将带 deliveryFailure（+pushFailure=3），
      // 供 E2E 验证面板告警段渲染（P0-22b）。18 分钟前 → 文案「推送最近失败于 18 分钟前」。
      command: 'test:service-delivery-failure',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, activeModel, setMockDeliveryFailure }) => {
        setMockDeliveryFailure({ channel: 'push', at: Date.now() - 18 * 60_000, count: 3 });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_svc_fail_1', durationMs: 50, costUsd: 0, isError: false, models: [activeModel] },
        });
      }),
    },
    {
      // 判定化告警注入：后续 service:status ack 带 rateLimitLockout（⛔ 红）+ clientError（🐞 黄），
      // 供 E2E 验证升格告警行渲染与判色（P0-22c）。42 分钟前锁定、3 分钟前前端错误。
      command: 'test:service-incidents',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, activeModel, setMockServiceIncidents }) => {
        setMockServiceIncidents({
          rateLimitLockout: { at: Date.now() - 42 * 60_000, count: 2 },
          clientError: { at: Date.now() - 3 * 60_000, count: 5 },
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_svc_incident_1', durationMs: 50, costUsd: 0, isError: false, models: [activeModel] },
        });
      }),
    },
  ];
}
