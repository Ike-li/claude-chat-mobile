function contextual(getContext, handler) {
  return async args => {
    const ctx = getContext();
    // demo:* 场景须能在空首页（viewingInstanceId=null → activeInst undefined）直接演示，
    // 不像其它 test:* 场景那样静默 return；回退到默认实例而非崩溃或不响应。
    const activeInst = args.activeInst || ctx.mockInstances[0];
    return handler(ctx, { ...args, activeInst });
  };
}

export function createDemoScenarios(getContext) {
  const run = handler => contextual(getContext, handler);

  return [
    {
      command: 'demo:stream',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, activeModel, emitInstancesSnapshot, streamZh, delay }, { activeInst }) => {
        activeInst.state = 'busy';
        emitInstancesSnapshot();
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'thinking_delta', payload: { messageId: 'msg_demo_stream', text: '<thinking>先读 README 和 server.js，理出模块边界和部署路径……</thinking>' },
        });
        await delay(900);
        const reply = [
          '这个仓库是**手机 ↔ 本机 claude CLI** 的桥：',
          '',
          '1. **server.js** — Express + Socket.IO，事件带单调 seq，断线重连按序补发',
          '2. **agent.js** — Agent SDK 会话编排，危险操作转手机审批',
          '3. **public/** — 零构建前端，PWA 可安装',
          '',
          '```bash',
          'npm start   # 默认 3000 端口，生产用常驻服务',
          '```',
          '',
          '部署一节已补进 README：LaunchAgent 常驻 + Cloudflare Access 两步。',
        ].join('\n');
        const seq = await streamZh('msg_demo_stream', reply, 2);
        activeInst.state = 'idle';
        emitInstancesSnapshot();
        socket.emit('agent:event', {
          seq, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_demo_stream', durationMs: 5200, costUsd: 0.0042, isError: false, models: [activeModel] },
        });
      }),
    },
    {
      command: 'demo:tool',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, activeModel, emitInstancesSnapshot, streamZh, delay }, { activeInst }) => {
        activeInst.state = 'busy';
        emitInstancesSnapshot();
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'thinking_delta', payload: { messageId: 'msg_demo_tool', text: '<thinking>键盘弹起时 visualViewport 变化没被监听，输入条被顶出视口……</thinking>' },
        });
        await delay(700);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_demo_read', name: 'read_file', inputSummary: 'public/js/app.js' },
        });
        await delay(1100);
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: 't_demo_read', ok: true, outputSummary: '读取 812 行' },
        });
        let seq = await streamZh('msg_demo_tool', '找到了：`visualViewport` 的 resize 事件没监听，键盘一弹起输入条就被遮住。补上监听，让输入条贴住键盘。', 4);
        socket.emit('agent:event', {
          seq: seq++, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_demo_edit', name: 'edit_file', inputSummary: 'public/js/app.js' },
        });
        await delay(1300);
        socket.emit('agent:event', {
          seq: seq++, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: 't_demo_edit', ok: true, outputSummary: '+18 −2，输入条跟随键盘高度' },
        });
        socket.emit('agent:event', {
          seq: seq++, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_demo_test', name: 'run_command', inputSummary: 'npm run test:unit' },
        });
        await delay(1200);
        socket.emit('agent:event', {
          seq: seq++, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: 't_demo_test', ok: true, outputSummary: '✓ 392 tests 通过 (0.6s)' },
        });
        seq = await streamZh('msg_demo_tool', '\n\n修好了。iOS 上键盘弹起时，输入条现在始终贴在键盘上方。', seq);
        activeInst.state = 'idle';
        emitInstancesSnapshot();
        socket.emit('agent:event', {
          seq, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_demo_tool', durationMs: 7800, costUsd: 0.0113, isError: false, models: [activeModel] },
        });
      }),
    },
    {
      command: 'demo:permission',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, emitInstancesSnapshot, setPendingPermission, delay }, { activeInst }) => {
        activeInst.state = 'busy';
        emitInstancesSnapshot();
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'thinking_delta', payload: { messageId: 'msg_demo_perm', text: '<thinking>先提交本地改动，push 需要机主批准……</thinking>' },
        });
        await delay(700);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_demo_commit', name: 'run_command', inputSummary: 'git commit -m "fix: iOS 键盘遮挡输入框"' },
        });
        await delay(1100);
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: 't_demo_commit', ok: true, outputSummary: '[dev 3f2a1c8] 2 files changed, +18 −2' },
        });
        await delay(400);
        socket.emit('agent:event', {
          seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_demo_push', name: 'run_command', inputSummary: 'git push origin dev' },
        });
        await delay(500);
        activeInst.state = 'permission';
        emitInstancesSnapshot();
        const permission = {
          requestId: 'req_demo_push',
          toolUseId: 't_demo_push',
          messageId: 'msg_demo_perm',
          name: 'run_command',
          input: 'git push origin dev',
          cwd: activeInst.cwd,
          approveOutput: '已推送 dev → origin/dev (3f2a1c8)',
          approveText: '\n\n✓ 已推送到 origin/dev。CI 结果出来我会推送通知到你手机。',
        };
        setPendingPermission(permission);
        socket.emit('agent:event', {
          seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'permission_request', payload: {
            requestId: permission.requestId,
            name: permission.name,
            input: permission.input,
            cwd: permission.cwd,
          },
        });
      }),
    },
    {
      command: 'demo:question',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, emitInstancesSnapshot, setPendingQuestion, delay }, { activeInst }) => {
        activeInst.state = 'busy';
        emitInstancesSnapshot();
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'thinking_delta', payload: { messageId: 'msg_demo_quest', text: '<thinking>发布口径需要机主拍板：先集成验证还是直接发稳定版……</thinking>' },
        });
        await delay(700);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_demo_ask', name: 'AskUserQuestion', inputSummary: '选择发布分支' },
        });
        await delay(500);
        activeInst.state = 'permission';
        emitInstancesSnapshot();
        const question = {
          requestId: 'req_demo_quest#0',
          toolUseId: 't_demo_ask',
          messageId: 'msg_demo_quest',
          options: ['dev — 先集成验证', 'master — 直接发稳定版', '暂不发版'],
          answerText: '\n\n好，目标 **{option}**。我先跑全量测试，绿了再打 tag。',
        };
        setPendingQuestion(question);
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'question', payload: {
            requestId: question.requestId,
            text: '这次修复要发到哪里？',
            options: question.options,
          },
        });
      }),
    },
    {
      command: 'demo:tab',
      run: run(async ({ socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, emitInstancesSnapshot, streamZh, delay }, { activeInst }) => {
        activeInst.state = 'busy';
        emitInstancesSnapshot();
        await delay(400);
        for (const instance of [
          { instanceId: 'inst_demo_pay', cwd: '/Users/you/code/payment-service', sessionId: 'mock-session-demo-pay', title: '重构支付回调', state: 'busy', permissionMode: 'default', effort: null, model: activeModel },
          { instanceId: 'inst_demo_blog', cwd: '/Users/you/code/blog-static', sessionId: 'mock-session-demo-blog', title: '部署博客', state: 'permission', permissionMode: 'default', effort: null, model: activeModel },
        ]) {
          if (!mockInstances.some(item => item.instanceId === instance.instanceId)) mockInstances.push(instance);
        }
        emitInstancesSnapshot();
        const reply = [
          '除了这里，这台 Mac 上还有两个仓库的任务：',
          '',
          '- **payment-service** — 重构支付回调，进行中',
          '- **blog-static** — 部署脚本在等你审批',
          '',
          '点左上角随时切过去。',
        ].join('\n');
        const seq = await streamZh('msg_demo_tab', reply, 1);
        activeInst.state = 'idle';
        emitInstancesSnapshot();
        socket.emit('agent:event', {
          seq, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_demo_tab', durationMs: 2600, costUsd: 0.0021, isError: false, models: [activeModel] },
        });
      }),
    },
    {
      command: 'demo:statusline',
      run: run(async ({ io, socket, activeEpoch, viewingInstanceId, activeModel, emitInstancesSnapshot, streamZh, delay }, { activeInst }) => {
        activeInst.state = 'busy';
        emitInstancesSnapshot();
        const now = Date.now();
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: now,
          type: 'status_line', payload: {
            ts: now,
            model: activeModel,
            project: 'claude-chat-mobile',
            cwd: '/Users/you/code/claude-chat-mobile',
            git: { branch: 'dev', changed: 3, staged: 2, modified: 1, untracked: 0, ahead: 1, behind: 0, repo: 'Ike-li/claude-chat-mobile' },
            ctx: { tokens: 45000, cacheHitPct: 45, in: 2000, out: 1500, w: 22000, r: 21000, usedPercent: 23, windowSize: 200000 },
            rate: { fiveHour: { usedPercent: 42 }, sevenDay: { usedPercent: 11 } },
            lines: { added: 12, removed: 4 },
            cost: 0.37,
            duration: { wallMs: 42500, apiMs: 18300 },
            version: '2.1.193',
          },
        });
        await delay(600);
        const seq = await streamZh('msg_demo_sl', '都在状态栏里：45k tokens（缓存命中 45%），本轮 $0.37，dev 分支还有 3 个文件没提交。', 1);
        activeInst.state = 'idle';
        emitInstancesSnapshot();
        socket.emit('agent:event', {
          seq, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_demo_sl', durationMs: 1900, costUsd: 0.0008, isError: false, models: [activeModel] },
        });
      }),
    },
  ];
}
