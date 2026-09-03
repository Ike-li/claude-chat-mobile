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
            ctx: { tokens: 45_000, totalTokens: 45_000, in: 2_000, out: 1_500, w: 22_000, r: 21_000, usedPercent: 23, windowSize: 200_000 },
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
      // 额度快照回落（对应 refreshStatusLine 的 cli-unavailable 分支叠加 getFallbackUsageRate()）：
      // CLI 快照仍缺失/过期，但账号级额度快照温热未超 TTL → payload 额外带 rate + rateFromSnapshot:true。
      // 前端应在"CLI 状态暂不可用"提示之外，额外展示一行额度回落值并明确标注非实时（P0-10e）。
      command: 'test:cli-statusline-unavailable-rate',
      run: run(async ({ io, socket, activeEpoch, viewingInstanceId }) => {
        const now = Date.now();
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: now,
          type: 'status_line', payload: {
            cwd: '/Users/you/code/claude-chat-mobile',
            source: { kind: 'cli-unavailable', reason: 'stale', ageMs: 180_000 },
            rate: {
              fiveHour: { usedPercent: 42, resetsAt: new Date(now + 2 * 3600_000).toISOString() },
              sevenDay: { usedPercent: 11, resetsAt: new Date(now + 3 * 86400_000).toISOString() },
            },
            rateFromSnapshot: true,
          },
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { text: 'CLI statusline unavailable with rate fallback' },
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
            ctx: { tokens: 45000, totalTokens: 45000, cacheHitPct: 45, in: 2000, out: 1500, w: 22000, r: 21000, usedPercent: 23, windowSize: 200000 },
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
      // 网关映射场景（.claude/settings.local.json 的 ANTHROPIC_DEFAULT_OPUS_MODEL）：CLI 侧仍报档位
      // 别名 'opus'，但 SDK supportedModels() 在 resolvedModel 带出真实 wire id——UI 展示（pill/select/
      // 磁贴）都应优先显示 resolvedModel，不得停留在裸别名。
      command: 'test:gateway-model-alias',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, mockInstances, permissionMode, delay }) => {
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'init', payload: {
            model: 'opus',
            cwd: mockInstances[0].cwd,
            claudeVersion: '0.1.0-mock',
            mcpServers: [],
            skillsCount: 7,
            permissionMode,
            slashCommands: [{ name: 'model', description: 'Switch active model' }],
          },
        });
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'models', payload: {
            models: [
              { value: 'default', displayName: 'Default (recommended)' },
              { value: 'opus', displayName: 'Opus', resolvedModel: 'mimo-v2.5-pro-ultraspeed' },
              { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'mimo-v2.5-pro' },
            ],
          },
        });
        await delay(300);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_gateway_model_alias_1', durationMs: 100, costUsd: 0, isError: false, models: ['opus'] },
        });
      }),
    },
    {
      // 新会话（未选具体模型）+ 网关默认：CLI 报 cwd 默认为档位别名 opus（instances.defaultModel），SDK
      // supportedModels() 在 resolvedModel 带出真实 wire id。回归 bug：currentModel 空时底栏 pill 须解析出
      // 真实模型名，而不是停在裸别名 'opus'——原表现「选了 opus 才显具体名」。models 列表无 default 项，
      // 故 cliDefaultLabel 为空、pill 回落 cwd 默认名并经 resolveGatewayModelName 桥接。
      command: 'test:gateway-default-fresh',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, mockInstances, permissionMode, delay }) => {
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'init', payload: {
            model: '', // 新会话未选具体模型
            cwd: mockInstances[0].cwd,
            claudeVersion: '0.1.0-mock',
            mcpServers: [],
            skillsCount: 7,
            permissionMode,
            slashCommands: [{ name: 'model', description: 'Switch active model' }],
          },
        });
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'models', payload: {
            models: [
              { value: 'opus', displayName: 'Opus', resolvedModel: 'mimo-v2.5-pro-ultraspeed' },
              { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'mimo-v2.5-pro' },
            ],
          },
        });
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances,
            defaultModel: 'opus', // scout 探得的 cwd 默认（档位别名）
          },
        });
        await delay(300);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_gateway_default_fresh_1', durationMs: 100, costUsd: 0, isError: false, models: [] },
        });
      }),
    },
    {
      command: 'test:mirror',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, activeModel, delay }) => {
        const mirrorEvent = (readonly, stale) => ({
          seq: 0, epoch: 'server', sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          // cliSeen:true —— 这些场景模拟的就是「终端在驾驶」，如实带上 server 的负证据槽，
          // 否则前端会保守当成「没见过终端」而不敢把 stale 说成「终端疑似中断」。
          type: 'mirror_state', payload: { readonly, stale, cliSeen: true },
        });
        socket.emit('agent:event', mirrorEvent(true, false));
        await delay(1500);
        socket.emit('agent:event', mirrorEvent(true, true));
        // stale（疑似中断）阶段要足够长：P0-17i 在检查这一态之前还要点模型 tile、等「设置已冻结」，
        // 原先 1500ms 的窗口常在那些步骤跑完前就过去了，断言便永远等不到——是窗口太窄，不是产品坏了。
        await delay(5000);
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
          // cliSeen:true —— 这些场景模拟的就是「终端在驾驶」，如实带上 server 的负证据槽，
          // 否则前端会保守当成「没见过终端」而不敢把 stale 说成「终端疑似中断」。
          type: 'mirror_state', payload: { readonly, stale, cliSeen: true },
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
      command: 'test:mirror-armed-force',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, activeModel, delay }) => {
        // 本轮立即收尾，再挂终端驾驶锁且【不自动放行】——「强制立即续接」（P0-17j）必须由用户按钮
        // 触发才解锁；若像 test:mirror-armed 那样 3 秒自动放行，强制路径没被验证到测试也会绿。
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_mirror_force_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] },
        });
        await delay(200);
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'mirror_state', payload: { readonly: true, stale: false },
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
      // canRestart:false 注入：模拟「前台 npm start、不是 LaunchAgent 托管」。
      // 配置面板保存后不该给「立即重启」按钮，而要明说得到电脑上重启——那条路径此前零覆盖
      // （mock 74 处广播全硬编码 canRestart:true），删掉整个分支全套 E2E 照样绿。
      command: 'test:no-restart',
      run: run(async ({ io, socket, activeEpoch, viewingInstanceId, activeModel, setMockCanRestart, mockInstances, mockServicePayload }) => {
        setMockCanRestart(false);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_no_restart_1', durationMs: 50, costUsd: 0, isError: false, models: [activeModel] },
        });
        // 立刻推一帧带 canRestart:false 的 instances（同 test:server-restart 的做法）
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            canRestart: false,
            viewingInstanceId,
            viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances,
            service: mockServicePayload(),
          },
        });
      }),
    },
    {
      // 重启记录「频繁重启」注入：后续 service:status ack 带一个 flapping 的 unit，
      // 供 E2E 验证 alert → text-warning 这个映射真的接上了。默认夹具刻意不 flapping
      // （恒亮黄字会掩盖回归），所以不注入的话这条路径从来没被断言过。
      command: 'test:service-flapping',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, activeModel, setMockRestarts }) => {
        const now = Date.now();
        setMockRestarts({
          units: [{ label: 'com.ccm.server', lastHour: 4, last24h: 9, flapping: true, lastRestartAt: now - 5 * 60_000 }],
          recent: [
            { ts: now - 5 * 60_000, label: 'com.ccm.server', kind: 'restarted' },
            { ts: now - 12 * 60_000, label: 'com.ccm.server', kind: 'restarted' },
          ],
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_svc_flap_1', durationMs: 50, costUsd: 0, isError: false, models: [activeModel] },
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
    {
      // 修复回归（点停止顿一下直接跳主页）：模拟"中断失败 → agent.js settleForce() 强杀子进程 →
      // onExit → 该实例从 agents Map 删除、且无同 cwd 存活实例可回退 → viewingInstanceId 广播为 null"
      // 这条链路的终态广播——不需要真的走完整 SDK abort 链路（那是 app/src/agent/agent.js
      // interrupt()/settleForce() 的既有职责，已有单测覆盖），只需要构造出"正在查看的实例从
      // instances 列表消失 + viewingInstanceId 变 null"这个广播形态，供前端 wasViewingInstanceDestroyed
      // + resolveEmptySurface（app/public/js/logic.js）验证：不静默 showDashboard()，而是渲染
      // "会话已中断"提示。先 emit 一条「已中断」系统消息，对齐真实 settleForce() 的第一步。
      command: 'test:instance-destroyed',
      run: run(async ({ io, activeEpoch, viewingInstanceId, mockInstances, setViewingInstanceId }) => {
        const idx = mockInstances.findIndex(i => i.instanceId === viewingInstanceId);
        if (idx === -1) return;
        const destroyed = mockInstances[idx];
        const removedCwd = destroyed.cwd;
        io.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: destroyed.sessionId, instanceId: destroyed.instanceId, ts: Date.now(),
          type: 'system', payload: { message: '已中断', kind: 'interrupted' },
        });
        mockInstances.splice(idx, 1);
        setViewingInstanceId(null);
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId: null,
            viewingCwd: removedCwd,
            dirs: Array.from(new Set([...mockInstances.map(i => i.cwd), removedCwd])),
            instances: mockInstances,
          },
        });
      }),
    },
    {
      // 修「server 重启都会跳'会话已中断'页」误报：整机重启时 agents Map/viewingInstanceId 全部归零
      //（纯内存态），重连后首条 instances 广播形态（实例从列表消失 + viewing 变 null）与上面
      // test:instance-destroyed 完全同构——唯一区分信号是广播恒带的 service.startedAt（进程级常量，
      // 重启必变）。本场景构造这个终态：清空全部实例 + 拨 startedAt + 带 service 的 instances 广播，
      // 供前端 detectServerRestart（app/public/js/logic.js）验证：显示「服务已重启」提示 +「继续此会话」
      // 一键重开（走既有 session:switch 打开路径），而非误导性的「停止操作未能正常结束」。
      command: 'test:server-restart',
      run: run(async ({ io, viewingInstanceId, mockInstances, setViewingInstanceId, bumpServiceStartedAt, mockServicePayload }) => {
        const removedCwd = mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd
          ?? '/Users/you/code/claude-chat-mobile';
        const dirs = Array.from(new Set(mockInstances.map(i => i.cwd)));
        mockInstances.length = 0; // 重启 = 所有 live 实例消失（不只正在看的那个）
        setViewingInstanceId(null);
        bumpServiceStartedAt();
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId: null,
            viewingCwd: removedCwd,
            dirs,
            instances: mockInstances,
            service: mockServicePayload(),
          },
        });
      }),
    },
  ];
}
