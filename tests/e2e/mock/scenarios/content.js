export function createContentScenarios(getContext) {
  // 先把这条命令开的那一轮收尾（idle 广播 + result），再做后续动作。前端发出消息后一直停在运行态直到收到 result，
  // 不收尾的话下一条命令会被 sendChatMessage 卡在「等停止键消失」上。
  const finishTurnThen = (activeInst, messageId, after) => {
    const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, mockServicePayload, getMockCanRestart } = getContext();
    if (activeInst) activeInst.state = 'idle';
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst?.cwd, ...getContext().mockDirFields(), instances: mockInstances }
    });
    socket.emit('agent:event', {
      seq: 1, epoch: activeEpoch, sessionId: activeInst?.sessionId ?? null, instanceId: viewingInstanceId, ts: Date.now(),
      type: 'result', payload: { messageId, durationMs: 1, costUsd: 0, isError: false, models: [activeModel] }
    });
    after();
  };
  return [
    {
      // 验收 O59：本地 slash 命令（/context、/cost）的输出。真 server 里它是 agent 合成 messageId 的一条 text_delta，
      // 紧跟着就是 result（不经模型，没有持续几秒的流）；两者都经 io.to('approved') 广播给所有已批准的端。
      // 这里同样用 io.emit——mock 的通用回显走 socket.emit 只给发送端，那样观察端什么都收不到，测不出东西。
      command: 'test:local-command-output',
      run: async ({ activeInst }) => {
        const { io, activeEpoch, viewingInstanceId, activeModel, mockInstances, mockServicePayload, getMockCanRestart } = getContext();
        const base = { epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId };
        io.emit('agent:event', {
          ...base, seq: 1, ts: Date.now(), type: 'text_delta',
          payload: { messageId: 'local-cmd-mock-1', text: '## Context Usage\n\n| Category | Tokens |\n|---|---|\n| System prompt | 3.1k |' },
        });
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances },
        });
        io.emit('agent:event', {
          ...base, seq: 2, ts: Date.now(), type: 'result', payload: { durationMs: 10, costUsd: 0, isError: false, models: [activeModel] },
        });
      },
    },
    {
      // 验收 O25 / O90：用户气泡按纯文本显示，和终端里看到的原样输入一致。用户气泡有三个建出点：
      // 乐观气泡转正（发出去的这条，由通用回显走到）、在线新建（不带 clientMessageId 的 user_message，
      // 另一台设备发的形态）、历史渲染（history_append 走 renderHistoryBubbles）。这里把后两条也各推一条。
      prefix: 'test:raw-user',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, mockServicePayload, getMockCanRestart } = getContext();
        const raw = label => `${label} <Header> keep <div className="wrap">w</div> <b>${label}-b</b> **${label}-star**\n  two  spaces`;
        const base = { epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId };
        socket.emit('agent:event', {
          ...base, seq: 1, ts: Date.now(), type: 'user_message', payload: { text: raw('LIVE'), uuid: 'u-raw-live' },
        });
        socket.emit('agent:event', {
          ...base, seq: 0, ts: Date.now(), type: 'history_append',
          payload: { external: true, messages: [{ role: 'user', content: raw('HIST'), uuid: 'u-raw-hist', timestamp: new Date().toISOString() }] },
        });
        socket.emit('agent:event', {
          ...base, seq: 2, ts: Date.now(), type: 'text_delta', payload: { messageId: 'msg_raw_user_1', text: 'raw user fixture' },
        });
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances },
        });
        socket.emit('agent:event', {
          ...base, seq: 3, ts: Date.now(), type: 'result', payload: { messageId: 'msg_raw_user_1', durationMs: 10, costUsd: 0, isError: false, models: [activeModel] },
        });
      },
    },
    {
      prefix: 'test:message-edit',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, mockServicePayload, getMockCanRestart } = getContext();
        console.log('[mock] Emitting assistant reply for message edit regression');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
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
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_message_edit_1', durationMs: 250, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      // 验收 O45：回复里有一张 12 列的宽表格。375 宽下它把整个消息列表撑出横向滚动、每格被压到一字一行。
      command: 'test:wide-table',
      run: async () => {
        const { socket, activeEpoch, viewingInstanceId, activeModel, delay } = getContext();
        const cols = Array.from({ length: 12 }, (_, i) => `column-${i + 1}`);
        const table = [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, `| ${cols.map((_, i) => `value-${i + 1}`).join(' | ')} |`].join('\n');
        // 再来一张全中文的（O45 残留）：英文格宽落在最长单词上，中文每个字之间都能断行，只修英文那张会漏掉它。
        // 必须整列都是中文——和英文同列时列宽被英文撑开，看不出来
        const zhCols = Array.from({ length: 12 }, (_, i) => `第${i + 1}列`);
        const zhTable = [`| ${zhCols.join(' | ')} |`, `| ${zhCols.map(() => '---').join(' | ')} |`, `| ${zhCols.map((_, i) => `第${i + 1}项的说明`).join(' | ')} |`].join('\n');
        await delay(50);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_wide_table', text: `wide table fixture\n\n${table}\n\n${zhTable}\n` },
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_wide_table', durationMs: 50, costUsd: 0, isError: false, models: [activeModel] },
        });
      },
    },
    {
      // API 重试态：CLI 会把整条 spinner 行顶替成 "✻ API error · Retrying in 4s · attempt 2/10"。
      // 【必须是独立命令，绝不并进 test:stream / test:question / test:exitplan】——那三条的 spec 用
      // /^✻ .+… \(\d+s/ 锚定普通 spinner 形态，而重试行不含 "… ("，混进去会把它们一起打红。
      command: 'test:api-retry',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, mockServicePayload, getMockCanRestart } = getContext();
        console.log('[mock] Starting test:api-retry sequence');
        const instancesPayload = () => ({
          viewingInstanceId,
          viewingCwd: activeInst.cwd,
          ...getContext().mockDirFields(),
          instances: mockInstances,
          canRestart: getMockCanRestart(),
          service: mockServicePayload(),
        });
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: instancesPayload(),
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'thinking_delta', payload: { messageId: 'msg_retry_1', text: 'Requesting the model...' },
        });
        await delay(400);

        // 网关 503 → 进入重试。复刻 emitTransient 语义：复用当前 seq 不递增、带 transient 标志。
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'api_retry', transient: true,
          payload: { attempt: 2, maxRetries: 10, delayMs: 4000, errorStatus: 503, error: 'overloaded' },
        });
        await delay(2500);

        // 重试成功：正文开流 → 状态行从重试态回落普通 spinner
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_retry_1', text: 'Retry succeeded, continuing.' },
        });
        await delay(600);

        // SDK 自由文本 notice（informational / mirror_error / … 经 agent.emitNotice 归一后的形态）。
        // 放在 result【之前】：stream 用例靠 .last() 断言收尾行，落在 result 之后会顶掉那个选择器语义。
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: 'transcript write failed: EACCES', kind: 'notice', level: 'warning' },
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: instancesPayload(),
        });
        socket.emit('agent:event', {
          seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_retry_1', durationMs: 3000, costUsd: 0, isError: false, models: [activeModel] },
        });
      },
    },
    {
      // P0-ORDER：武装「loadHistory 在途时镜像追平插队」的顺序竞态，下一次切入 Timeline Session 生效。
      command: 'test:arm-history-order-race',
      run: async () => { getContext().armHistoryOrderRace(); },
    },
    {
      // P0-PICK-8：武装「下一个懒开的实例一开出来就有一轮在跑」，离线连发的第二条因此撞上在途轮。
      command: 'test:arm-fresh-turn-running',
      run: async () => { getContext().armFreshTurnRunning(); },
    },
    {
      // P0-ACK-TIMEOUT：武装「session:history 的 ack 永不返回、但连接没断」，下一次切入 Timeline Session 生效。
      command: 'test:arm-history-ack-timeout',
      run: async () => { getContext().armHistoryAckTimeout(); },
    },
    {
      // P0-SYNC-ACK-TIMEOUT：武装「bindView 的 sync:since ack 永不返回、但连接没断」，下一次切入 Timeline Session 生效。
      command: 'test:arm-sync-ack-timeout',
      run: async () => { getContext().armSyncAckTimeout(); },
    },
    {
      // P0-05-HIST-FULL：武装「Timeline Session 的历史里多一对被截断的 Bash 工具卡」，下一次拉历史生效。
      command: 'test:arm-history-long-tool',
      run: async () => { getContext().armHistoryLongTool(); },
    },
    {
      // P0-40c：武装「下一条 user:message 回一个可重试的负 ack」，前端会把它转进 outbox 自动重发。
      command: 'test:arm-send-transient-fail',
      run: async () => { getContext().armSendTransientFail(); },
    },
    {
      // P0-02d7：武装「下一条离线重放回永久拒绝」（验收 O31）。
      command: 'test:arm-outbox-permanent',
      run: async () => { getContext().armOutboxPermanent(); },
    },
    {
      // P0-02d14：武装「下一次连入时 server 已重启」——所有实例消失，离线重放指向的实例按真 server 落 stale（验收 O31）。
      command: 'test:arm-outbox-restart-stale',
      run: async () => { getContext().armOutboxRestartStale(); },
    },
    {
      // P0-RESUME-DIV：武装「Archived Planning Session 续接会丢掉最近那段对话」，之后在那个会话里发消息被发送闸拒收。
      command: 'test:arm-resume-divergence',
      run: async () => { getContext().armResumeDivergence(); },
    },
    {
      // P0-RESUME-DIVe：同上，但挂在 worktree 会话上，且拒收前先模拟规则 5 置换（同一会话换成新实例并广播）。
      command: 'test:arm-resume-divergence-worktree-swap',
      run: async () => { getContext().armResumeDivergenceWorktreeSwap(); },
    },
    {
      // P0-RESUME-DIVf：挂在 Archived Planning Session 上，拒收前先模拟规则 5 置换——离线重放的那条撞闸时，
      // 入队时的句柄就此作废，「重发」要靠服务端按会话改投（MSG-02）。
      command: 'test:arm-resume-divergence-swap',
      run: async () => { getContext().armResumeDivergenceSwap(); },
    },
    {
      // P0-02d4：Archived Planning Session 的下一条离线重放触发规则 5 置换（同一会话换成新实例），新实例的 sync:since
      // 报磁盘 ahead 逼出清屏重载。同一批后面各条拿着旧号撞上第 1 条开跑的那轮。
      command: 'test:arm-outbox-replay-swap',
      run: async () => { getContext().armOutboxReplaySwap(); },
    },
    {
      // P0-02d6：同上，但同一批后面那条的在途轮拒收压到这个会话的历史回包之后才发；放出之后那一轮跑完，「重发」照常收下。
      command: 'test:arm-outbox-replay-swap-history-first',
      run: async () => { getContext().armOutboxReplaySwapHistoryFirst(); },
    },
    {
      // 验收 O29：同上，但第 1 条的 user_message 回显先于重载的历史回包到达（见 mock 的 outboxReplaySwapEchoFirst）。
      command: 'test:arm-outbox-replay-swap-echo-first',
      run: async () => { getContext().armOutboxReplaySwapEchoFirst(); },
    },
    {
      // P0-02d9（验收 O66）：之后的离线重放条目每条开一轮、挂到 /__outbox-turn-end 才收尾；本条自身立即收尾。
      command: 'test:arm-outbox-turns',
      run: async () => {
        const { socket, activeEpoch, viewingInstanceId, activeModel } = getContext();
        getContext().armOutboxTurns();
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_arm_outbox_turns', durationMs: 10, costUsd: 0, isError: false, models: [activeModel] },
        });
      },
    },
    {
      // P0-TS6：只读镜像的增量追平（终端里跑、server 轮询 transcript 检出新落定消息 → history_append）。
      // 每批 messages 都进一个【新的空 fragment】再一次性插入 #messages，所以判定基准必须能从 frag
      // 回落读 #messages 的尾巴——回落一旦失效，每批都会被当成「会话首条」而各插一条日期行。
      // 这条路径此前只有 fake-DOM 单测覆盖过，这里补真实 DOM 的端到端。
      command: 'test:history-append-ts',
      run: async () => {
        const { socket, activeEpoch, viewingInstanceId, delay } = getContext();
        const today = (hh, mm) => { const d = new Date(); d.setHours(hh, mm, 0, 0); return d.toISOString(); };
        const yday = (hh, mm) => { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(hh, mm, 0, 0); return d.toISOString(); };
        // 三批分别验：首批建基准 / 同日短间隔靠回落判定不插行 / 跨天补日期行
        const batches = [
          [{ role: 'user', content: 'Mirror batch one', uuid: 'u-ha-1', timestamp: yday(21, 0) }],
          [{ role: 'assistant', content: 'Mirror batch two', uuid: 'a-ha-2', timestamp: yday(21, 1) }],
          [{ role: 'user', content: 'Mirror batch three', uuid: 'u-ha-3', timestamp: today(8, 0) }],
        ];
        for (let i = 0; i < batches.length; i++) {
          socket.emit('agent:event', {
            seq: i + 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test',
            instanceId: viewingInstanceId, ts: Date.now(),
            type: 'history_append', payload: { external: true, messages: batches[i] },
          });
          await delay(120); // 逐批到达，逼出「每批一个新 frag」的真实时序
        }
        // 收尾 result：与同期的 test:stale-ts 同一条规则——客户端发消息即 setBusy(true)，没有终态
        // 事件就一直悬在 busy。本场景只验时间戳，但仍要把回合收干净，否则同页面后续任何一次
        // sendChatMessage 都会在 helper 的「等 data-mode 不再是 stop」上白等 20s，还报在误导的位置。
        socket.emit('agent:event', {
          seq: batches.length + 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test',
          instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_history_append_ts', durationMs: 10, costUsd: 0, isError: false, models: ['claude-3-5-sonnet'] },
        });
      },
    },
    {
      // 会话里的图片 · live 工具截图。形态复刻 app/src/agent/agent.js：tool_result 只带 images 引用
      // （一张可取、一张超单张上限 tooLarge），摘要只剩文字。图由前端经 image:get 按需取（server.js 的 mock）。
      command: 'test:tool-screenshot',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, mockServicePayload, getMockCanRestart } = getContext();
        console.log('[mock] Starting test:tool-screenshot sequence');
        const instancesPayload = () => ({ canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances });
        activeInst.state = 'busy';
        io.emit('agent:event', { seq: 0, epoch: 'server', sessionId: null, ts: Date.now(), type: 'instances', payload: instancesPayload() });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_shot', name: 'mcp__claude-in-chrome__computer', inputSummary: '{"action":"screenshot"}' }
        });
        await delay(200);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: {
            toolUseId: 't_shot', ok: true, outputSummary: 'Successfully captured screenshot',
            images: [
              { ref: 't:t_shot:0', mediaType: 'image/png', bytes: 159 },
              { ref: 't:t_shot:1', mediaType: 'image/png', bytes: 3355443, tooLarge: true },
            ],
          }
        });
        activeInst.state = 'idle';
        io.emit('agent:event', { seq: 0, epoch: 'server', sessionId: null, ts: Date.now(), type: 'instances', payload: instancesPayload() });
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_tool_screenshot', durationMs: 200, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      // 会话里的图片 · 用户贴图（终端 / 桌面端粘贴）。走 history_append（与刷新后 loadHistory 同一渲染器），
      // 形态复刻 app/src/sessions/history.js：images 挂在用户文本条上；纯图消息 content 为空串。
      // 第二张的引用 mock 不认 → 取图失败，必须显示「图片无法加载」而不是让整条消息出错。
      command: 'test:history-images',
      run: async () => {
        const { socket, activeEpoch, viewingInstanceId } = getContext();
        console.log('[mock] Starting test:history-images sequence');
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'history_append',
          payload: {
            external: true,
            messages: [
              { role: 'user', content: '[Image #1] 这个按钮的位置不对', uuid: 'u-img-paste', images: [{ ref: 'u:u-img-paste:0', mediaType: 'image/png', bytes: 159 }] },
              { role: 'user', content: '', uuid: 'u-img-gone', images: [{ ref: 'u:u-img-gone:0', mediaType: 'image/jpeg', bytes: 2048 }] },
              { role: 'assistant', content: '看到了，按钮偏右了。', uuid: 'a-img-1' },
            ],
          },
        });
        // 收尾 result：客户端发这条命令即 setBusy(true)，不收尾的话同页面后续 sendChatMessage 会白等（同 test:history-append-ts）
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_history_images', durationMs: 10, costUsd: 0, isError: false, models: ['claude-3-5-sonnet'] },
        });
      },
    },
    {
      // 历史里的 API Error 差异化渲染。走 history_append（前端 onHistoryAppend → renderHistoryBubbles，
      // 与刷新后 loadHistory 同一渲染器），字段形态复刻 app/src/sessions/history.js 真实产出：
      // isApiErrorMessage/apiErrorStatus/apiError 只挂文本条。apiErrorStatus 有 null 的真形态
      // （连接错误无 HTTP 响应），这里两种都给。
      command: 'test:history-apierror',
      run: async () => {
        const { socket, activeEpoch, viewingInstanceId } = getContext();
        console.log('[mock] Starting test:history-apierror sequence');
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'history_append',
          payload: {
            external: true,
            messages: [
              { role: 'user', content: '继续', uuid: 'u-apierr-1' },
              {
                role: 'assistant',
                content: 'API Error: 503 Gateway Error: 没有可用的内网节点',
                uuid: 'a-apierr-1',
                isApiErrorMessage: true,
                apiErrorStatus: 503,
                apiError: 'server_error',
              },
              {
                role: 'assistant',
                content: 'API Error: Gateway Error: 流式连接异常中断',
                uuid: 'a-apierr-2',
                isApiErrorMessage: true,
                apiErrorStatus: null,
                apiError: 'unknown',
              },
              { role: 'assistant', content: '普通回复不受影响', uuid: 'a-apierr-3' },
            ],
          },
        });
      },
    },
    {
      // 桌面端 visualize 工具（show_widget）画的图。字段形态复刻 app/src/shared/tool-summary.js 的 widgetPayload：
      // SVG 带完整 code；超限的后端根本不带 widget（与普通工具卡无异，这里不再造）。
      // 四张卡各验一条：① 完整 SVG → 图片 ② HTML 组件 → 只显示提示，带了 code 也不执行
      // ③ 半截 SVG → 退回一行工具调用 ④ XML 不合法（裸 &）→ 图片解码失败，撤掉图、留工具卡。
      // ①② 的源码里埋了脚本与事件处理器：任何一条路径把它们放进页面 DOM，window.__widgetRan 就会被写上。
      command: 'test:widget',
      run: async () => {
        const { socket, activeEpoch, viewingInstanceId, activeModel, delay } = getContext();
        const base = seq => ({ seq, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now() });
        const widgets = [
          { id: 't_widget_svg', widget: { title: 'mock_architecture', kind: 'svg', code: MOCK_WIDGET_SVG } },
          { id: 't_widget_html', widget: { title: 'mock_calculator', kind: 'html', code: '<div>calc</div><img src="x" onerror="window.__widgetRan=\'html\'"><script>window.__widgetRan=\'html-script\'</script>' } },
          { id: 't_widget_half', widget: { title: 'mock_half', kind: 'svg', code: '<svg viewBox="0 0 100 40"><rect width="10" height="10"/>' } },
          { id: 't_widget_badxml', widget: { title: 'mock_bad_xml', kind: 'svg', code: '<svg viewBox="0 0 100 40"><text class="t" x="4" y="20">R&D</text></svg>' } },
          // ⑤ 孤立代理字符（合法 JSON 转义就能进来）：encodeURIComponent 会抛，抛了工具卡都插不进去
          { id: 't_widget_surrogate', widget: { title: 'mock_surrogate', kind: 'svg', code: MOCK_WIDGET_SURROGATE } },
        ];
        let seq = 1;
        for (const w of widgets) {
          socket.emit('agent:event', {
            ...base(seq++), type: 'tool_use', payload: {
              toolUseId: w.id, name: 'mcp__visualize__show_widget',
              inputSummary: JSON.stringify({ title: w.widget.title, loading_messages: ['drawing'], widget_code: w.widget.code }).slice(0, 600),
              widget: w.widget,
            },
          });
          await delay(60);
          socket.emit('agent:event', {
            ...base(seq++), type: 'tool_result',
            payload: { toolUseId: w.id, ok: true, outputSummary: '[{"type":"text","text":"Content rendered and shown to the user."}]' },
          });
        }
        socket.emit('agent:event', { ...base(seq++), type: 'text_delta', payload: { messageId: 'msg_widget_1', text: 'Widget fixture done.' } });
        socket.emit('agent:event', {
          ...base(seq), type: 'result', payload: { messageId: 'msg_widget_1', durationMs: 120, costUsd: 0, isError: false, models: [activeModel] },
        });
      },
    },
    {
      // 同一张图走历史追平（history_append → renderHistoryBubbles，与刷新后 loadHistory 同一个渲染器）。
      // 桌面端会话在 CCM 里就是这么显示的：server 轮询 transcript，history.js 展开出带 widget 的 tool_use 条目。
      command: 'test:widget-history',
      run: async () => {
        const { socket, activeEpoch, viewingInstanceId, activeModel } = getContext();
        const ts = new Date().toISOString();
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'history_append', payload: {
            external: true,
            messages: [
              { role: 'user', content: 'Draw the architecture', uuid: 'u-widget-h1', timestamp: ts, entrypoint: 'claude-desktop' },
              // 坏数据在前：抛错会中断整块历史渲染，后面的图和文字都出不来
              {
                kind: 'tool_use', role: 'assistant', toolUseId: 'h_widget_surrogate', name: 'mcp__visualize__show_widget',
                inputSummary: '{"title":"mock_surrogate"}',
                widget: { title: 'mock_surrogate', kind: 'svg', code: MOCK_WIDGET_SURROGATE }, timestamp: ts, entrypoint: 'claude-desktop',
              },
              {
                kind: 'tool_use', role: 'assistant', toolUseId: 'h_widget_svg', name: 'mcp__visualize__show_widget',
                inputSummary: JSON.stringify({ title: 'mock_architecture', widget_code: MOCK_WIDGET_SVG }).slice(0, 600) + ' …（已截断）',
                widget: { title: 'mock_architecture', kind: 'svg', code: MOCK_WIDGET_SVG }, timestamp: ts, entrypoint: 'claude-desktop',
              },
              { kind: 'tool_result', role: 'user', toolUseId: 'h_widget_svg', ok: true, outputSummary: 'Content rendered and shown to the user.', timestamp: ts },
            ],
          },
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_widget_history', durationMs: 10, costUsd: 0, isError: false, models: [activeModel] },
        });
      },
    },
    {
      command: 'test:tool',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, mockServicePayload, getMockCanRestart } = getContext();
        console.log('[mock] Starting test:tool sequence');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
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
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
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
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, mockServicePayload, getMockCanRestart } = getContext();
        console.log('[mock] Starting test:tool-out-of-order sequence');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
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
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
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
        const { io, socket, activeEpoch, viewingInstanceId, mockInstances, delay, mockServicePayload, getMockCanRestart } = getContext();
        console.log('[mock] Starting test:tool-error sequence');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_tool_error_cmd', name: 'run_command', inputSummary: 'npm run failing-script' }
        });
        await delay(400);

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'error', payload: { message: 'mock tool crashed while running npm run failing-script' }
        });
      },
    },
    {
      // 可恢复错误：轮次【没有】结束。AgentSession.map() 对 assistant API 错误发 recoverable:true 并
      // 故意保持 pendingTurns 非零直到随后的 result（模型/权限切档失败同理）。所以这里实例保持
      // state:'busy' + turnRunning:true，只推一条 error——前端不得据此解锁发送闸。
      command: 'test:recoverable-error',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, mockInstances, mockServicePayload, getMockCanRestart } = getContext();
        activeInst.state = 'busy';
        activeInst.turnRunning = true;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'error', payload: { message: 'API Error 529 · overloaded_error（可恢复，轮次继续）', recoverable: true }
        });
      },
    },
    {
      // turn-end 文件变更汇总：Write + Edit → result 后出现「已编辑 2 个文件」卡（Read 不计入）
      command: 'test:file-changes',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, mockServicePayload, getMockCanRestart } = getContext();
        console.log('[mock] Starting test:file-changes sequence');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
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
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 9, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_fc_1', durationMs: 1200, costUsd: 0.002, isError: false, models: [activeModel] }
        });
      },
    },
    {
      // P0-02j：先断一次传输层，客户端重连后发的 sync:since 被扣住、随即再断一次（见 server.js syncHoldThenDropArmed）。
      // 与 test:disconnect-now 的区别：这里关的是 engine 传输层（客户端 reason=transport close，走自动重连），
      // 那边是 socket.disconnect(true)（io server disconnect，客户端不自动重连）。
      command: 'test:sync-inflight-drop',
      run: async ({ activeInst }) => {
        const { socket, armSyncHoldThenDrop } = getContext();
        finishTurnThen(activeInst, 'msg_sync_inflight_drop', () => {
          armSyncHoldThenDrop();
          setTimeout(() => socket.conn.close(), 50);
        });
      },
    },
    {
      // 单纯断一次传输层（客户端走自动重连）。P0-02j 用它验「之前那次竞态之后，再断线还能自己连回来」。
      command: 'test:transport-drop',
      run: async ({ activeInst }) => {
        const { socket } = getContext();
        finishTurnThen(activeInst, 'msg_transport_drop', () => setTimeout(() => socket.conn.close(), 50));
      },
    },
    {
      command: 'test:disconnect-now',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, mockServicePayload, getMockCanRestart } = getContext();
        console.log('[mock] Completing current turn, then forcing a socket disconnect');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });

        await delay(100);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_disconnect_now_1', text: '模拟断线前的最后一条回复。' }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_disconnect_now_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
        setTimeout(() => socket.disconnect(true), 50);
      },
    },
    {
      // 单行动作槽「运行中可见」这一档：它是个瞬态，在 test:subagent 里靠事件间隔去断言必然脆。
      // 故单独一个【停在运行中】的场景——不发 tool_result、不发 result，卡定格在运行态，
      // 断言无需任何等待技巧。跑完撤下那一档由 test:subagent 的终态覆盖。
      command: 'test:subagent-running',
      run: async ({ activeInst }) => {
        let { io, socket, activeEpoch, viewingInstanceId, mockInstances, delay, setViewingInstanceId, mockServicePayload, getMockCanRestart } = getContext();
        if (!activeInst) {
          activeInst = mockInstances.find(i => i.instanceId === 'inst_1') || mockInstances[0];
          if (!activeInst) return;
          viewingInstanceId = activeInst.instanceId;
          setViewingInstanceId(viewingInstanceId);
        }
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: {
            toolUseId: 'agent-run-1', name: 'Agent',
            inputSummary: JSON.stringify({ description: 'Audit import boundaries', subagent_type: 'Explore' }),
          }
        });
        await delay(150);
        // 子代理内部一次【真错误】（ok:false 且无 denyKind）→ 聚合卡标题累 ❌ 计数。
        // 放在 task_progress 之前发：心跳会覆盖单行动作槽，计数必须扛得住覆盖才算数。
        socket.emit('agent:event', {
          seq: 1.5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: {
            toolUseId: 't_run_fail', name: 'Read',
            inputSummary: JSON.stringify({ file_path: 'css/style.css' }),
            parentToolUseId: 'agent-run-1', subagentType: 'Explore',
          }
        });
        await delay(80);
        socket.emit('agent:event', {
          seq: 1.6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: {
            toolUseId: 't_run_fail', ok: false, outputSummary: 'ENOENT: no such file or directory',
            parentToolUseId: 'agent-run-1', subagentType: 'Explore',
          }
        });
        await delay(80);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'task_progress', transient: true,
          payload: {
            taskId: 'task-run-1', taskType: 'local_agent', message: 'Explore：扫描导入边界',
            lastToolName: 'Grep', subagentType: 'Explore',
            tasks: [{
              taskId: 'task-run-1', taskType: 'local_agent', message: 'Explore：扫描导入边界',
              lastSeenAt: Date.now(), lastToolName: 'Grep', description: 'Explore：扫描导入边界',
              subagentType: 'Explore', truncated: false, status: null, error: null,
              durationMs: 8000, totalTokens: 1200,
              toolUseId: 'agent-run-1', toolUses: 3,
            }],
            finished: [],
          },
        });
      },
    },
    {
      // TC-24：子 agent 可折叠卡——主 Agent tool_use 预建卡 + parentToolUseId 嵌套 text/thinking/tool
      // 默认收起；展开后可见子 agent 正文与内部工具。对齐 agent.js forwardSubagentText 分流字段。
      command: 'test:subagent',
      run: async ({ activeInst }) => {
        // 空首页兜底需重指 viewingInstanceId，故此处用 let（其余场景为 const）
        let { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, setViewingInstanceId, mockServicePayload, getMockCanRestart } = getContext();
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
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
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
            inputSummary: JSON.stringify({ file_path: 'app/src/auth.js' }),
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

        // 后台任务快照：带 toolUseId 把用量挂到上面那张聚合卡（真 server 的 tool_use_id 来自
        // SDK task_progress，形状对齐 emitBgTasksSnapshot 的 tasks 行）。
        socket.emit('agent:event', {
          seq: 5.5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'task_progress', transient: true,
          payload: {
            taskId: 'task-sa-1', taskType: 'local_agent', message: 'code-reviewer：Reading auth.js',
            lastToolName: 'Bash', subagentType: 'code-reviewer',
            tasks: [{
              taskId: 'task-sa-1', taskType: 'local_agent', message: 'code-reviewer：Reading auth.js',
              lastSeenAt: Date.now(), lastToolName: 'Bash', description: 'code-reviewer：Reading auth.js',
              subagentType: 'code-reviewer', truncated: false, status: null, error: null,
              durationMs: 505000, totalTokens: 65400,
              toolUseId: 'agent-parent-1', toolUses: 15,
            }],
            finished: [],
          },
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
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
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
        let { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, setViewingInstanceId, mockServicePayload, getMockCanRestart } = getContext();
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
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
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
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_wf_main', durationMs: 800, costUsd: 0.01, isError: false, models: [activeModel] }
        });
      },
    },
    {
      // P0-TS5：信封 ts 保真。事件带的是 26 小时前的时刻（模拟 sync:since 从环形缓冲补发离开期间
      // 攒下的事件——app/src/server/app.js 是 { ...envelope, replay:true } 原样转发，ts 是事件真实发生
      // 时刻而非补发时刻）。客户端若拿 Date.now() 顶替信封 ts，日期行会显示「今天」；正确实现显示
      // 「昨天」。没有这条，「传信封 ts」这个决策在 E2E 层结构性无法失败——mock 其余 replay 事件的
      // ts 就是 Date.now()，两种实现渲染结果完全相同。
      command: 'test:stale-ts',
      run: async () => {
        const { socket, activeEpoch, viewingInstanceId } = getContext();
        // 按【日历日】构造，不用「Date.now() 减 N 小时」——后者在本地 0/1 点会把「26 小时前」
        // 算成前天，让下面断言「昨天」的 P0-TS5 每天定时红两小时（DST 日窗口还会更宽）。
        // 与 mock-session-timeline fixture 同一套写法。
        const atDaysAgo = (n, hh, mm) => {
          const d = new Date();
          d.setDate(d.getDate() - n);
          d.setHours(hh, mm, 0, 0);
          return d.getTime();
        };
        // 两条：先落一条前天的把判定基准推到过去（触发本场景的那条消息 ts 是当下，直接跟一条
        // 昨天的会被「时间倒流不插行」的规则吃掉），再落一条昨天的——它相对前天是跨天且时间前进，
        // 必出 day 行「昨天」。客户端若用 Date.now() 顶替，两条都成了「今天」→ 一行也不会多出来。
        for (const [seq, daysAgo, text] of [[1, 2, 'Stale envelope prompt from two days ago'],
          [2, 1, 'Stale envelope prompt from yesterday']]) {
          socket.emit('agent:event', {
            seq, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId,
            ts: atDaysAgo(daysAgo, 9, 0), replay: true,
            type: 'user_message', payload: { text }
          });
        }
        // 收尾 result：客户端发消息即 setBusy(true)，没有终态事件就一直悬在 busy。
        // 本场景只验时间戳，但仍要把回合收干净，别给同进程的后续 spec 留下半开状态。
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId,
          ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_stale_ts', durationMs: 10, costUsd: 0, isError: false, models: ['claude-3-5-sonnet'] }
        });
      },
    },
    {
      command: 'test:stream',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, mockServicePayload, getMockCanRestart } = getContext();
        console.log('[mock] Starting test:stream sequence');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
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
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
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
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, mockServicePayload, getMockCanRestart } = getContext();
        console.log('[mock] Starting long streaming sequence for interrupt test');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'thinking_delta', payload: { messageId: 'msg_long_1', text: '<thinking>Starting a long-running analysis task...</thinking>' }
        });
        // ★ 回合号必须在【进入本轮时】快照，不能等 delay 之后再取：新的 test: 命令会在拦截处把
        // turnSeq 自增并把 aborted 清回 false（见 app/server.js），若那条命令恰好落在下面这段 delay 里，
        // 醒来读到的就是【新】回合号，于是 `turnSeq !== myTurn` 恒为 false、aborted 也刚被清掉——
        // 两条退出路径同时失效，本循环跑满 16s 并把迟到事件泼进后续 spec。
        const myTurn = activeInst.turnSeq;
        await delay(500);

        // Stream slowly: gives time for interrupt while keeping tests bounded.
        for (let i = 0; i < 20; i++) {
          // WS-008：每次 delay 后检查 abort 标志——interrupt 处理器会把 activeInst.aborted 置 true。旧实现不检查，
          // 中断后这个 16s(20×800ms) 循环仍继续每 800ms 发 text_delta + 末尾 result，污染后续 test case（TC-11
          // 之后的用例会收到本轮迟到事件）。检测到中断即停：不再发 delta、不发终态 result（interrupt 已发 system）。
          if (activeInst.aborted) { console.log('[mock] stream-long aborted by interrupt'); return; }
          // WS-008b：单靠 aborted 会被「中断后立刻发下一条」漏过——新命令进来时会把 aborted 清回 false
          // （见 app/server.js 的 test: 拦截处），而本循环那时还睡在 delay 里，醒来就当作没被中断过继续跑满。
          // 回合号是自己那一轮的身份证：换了轮次就说明这个循环已经过气，必须立刻收摊。
          if (activeInst.turnSeq !== myTurn) { console.log('[mock] stream-long 已被新回合取代，停止续发'); return; }
          socket.emit('agent:event', {
            seq: 2 + i, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'text_delta', payload: { messageId: 'msg_long_1', text: `Chunk ${i + 1} of analysis... ` }
          });
          await delay(800);
        }

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 100, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_long_1', durationMs: 16000, costUsd: 0.012, isError: false, models: [activeModel] }
        });
      },
    },
    {
      // 极简回显 + 正常收尾：给「只关心正文原样发出、不关心回复内容」的用例用（如 P0-02e 验 ultracode
      // 档不改写正文）。registry 里没有的 test: 命令会静默不发 result，让 waitForIdle 一直等到超时——
      // 这个场景就是补那个洞，别再让用例引用不存在的命令名。
      command: 'test:workflow-echo',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, mockServicePayload, getMockCanRestart } = getContext();
        console.log('[mock] Starting test:workflow-echo sequence');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });
        await delay(80);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_workflow_echo', text: 'echoed.' }
        });
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_workflow_echo', durationMs: 80, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:unsafe-markdown',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, mockServicePayload, getMockCanRestart } = getContext();
        console.log('[mock] Starting test:unsafe-markdown sequence');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });

        const responseText = [
          'This response keeps **safe bold markdown** and `safe_inline_code` visible.',
          '',
          '```js',
          'const fenced = 1;',
          '```',
          '',
          '<script>window.__ccmUnsafeMarkdownScriptFired = true</script>',
          '<img src="/__unsafe-markdown-probe.png" onerror="window.__ccmUnsafeMarkdownImageFired = true" alt="unsafe image probe">',
          '<a href="javascript:window.__ccmUnsafeMarkdownClickFired = true">unsafe javascript link</a>',
          '<span onclick="window.__ccmUnsafeMarkdownClickFired = true">unsafe click probe</span>',
          '',
          // Tailwind 运行时会把 class 现编成 CSS：不剥的话这就是一个盖住审批按钮的全屏遮罩
          '<div class="fixed inset-0 z-[2147483647] pointer-events-none" data-probe="class-overlay">class overlay probe</div>',
          '',
          // <style> 元素整页生效、按 id 就能改写审批按钮：不剥的话「允许」成了铺满视口的透明层，点哪都是批准。
          // <svg> 里的 <style> 走 DOMPurify 的 SVG 表，单独放一条
          '<style>#permAllow{position:fixed;inset:0;z-index:2147483647;opacity:.002}</style>',
          '',
          '<svg><style>#permDeny{position:fixed}</style></svg>'
        ].join('\n');

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_unsafe_markdown_1', text: responseText }
        });
        await delay(150);

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
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
    {
      // 服务端 result 事件恒带 text 字段（agent.js 的 assistantResponseBuffer，供前端断网恢复后
      // 用权威全文覆盖可能因遗漏 text_delta 而截断的 s.raw，见 app.js 的 result(p) 处理）。
      // mock 此前从未下发这个字段——app.js 那段"用权威全文覆盖"的分支代码在 E2E 全绿的情况下
      // 从未被真正触达过：改错字段名、判断条件写反，测试都不会红。这里故意只发一小段 delta
      // （模拟断网期间漏掉了后续内容），result.text 带着更长/不同的权威全文，断言最终渲染必须
      // 是全文而不是 delta 累积的截断版本。
      command: 'test:result-text-recovery',
      run: async ({ activeInst }) => {
        const { io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, mockServicePayload, getMockCanRestart } = getContext();
        console.log('[mock] Emitting truncated text_delta + authoritative result.text');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });

        await delay(150);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_result_text_recovery', text: 'TRUNCATED-PREFIX-ONLY' }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: getMockCanRestart(), service: mockServicePayload(), viewingInstanceId, viewingCwd: activeInst.cwd, ...getContext().mockDirFields(), instances: mockInstances }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: {
            messageId: 'msg_result_text_recovery', durationMs: 150, costUsd: 0, isError: false, models: [activeModel],
            text: 'TRUNCATED-PREFIX-ONLY-plus-the-rest-that-only-arrives-via-result-text-AUTHORITATIVE-FULL-TEXT',
          }
        });
      },
    },
  ];
}

// 与 app/server.js MOCK_ATTACH_PNG 字节数一致（1×1 PNG fixture 的解码长度）；仅用于 meta.size 展示，无行为语义。
const MOCK_PNG_SIZE = 70;

// show_widget 夹具：形态照桌面端真实产出（无 xmlns、width="100%"、viewBox 680 宽、c-* 色板 class、
// var(--b) 变量、onclick 里的 sendPrompt），另埋脚本与 onload 验证图片里不执行。
const MOCK_WIDGET_SVG = '<svg width="100%" viewBox="0 0 680 200" role="img" onload="window.__widgetRan=\'svg-onload\'">'
  + '<title>Mock architecture</title><desc>Two boxes and an arrow.</desc>'
  + '<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
  + '<path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5"/></marker></defs>'
  + '<script>window.__widgetRan=\'svg-script\'</script>'
  + '<rect x="20" y="10" width="640" height="180" rx="20" fill="none" stroke="var(--b)" stroke-width="0.5" stroke-dasharray="4 4"/>'
  + '<g class="node c-purple" onclick="sendPrompt(\'phone\')"><rect x="60" y="60" width="220" height="56" rx="8" stroke-width="0.5"/>'
  + '<text class="th" x="170" y="78" text-anchor="middle" dominant-baseline="central">手机 / PWA</text>'
  + '<text class="ts" x="170" y="96" text-anchor="middle" dominant-baseline="central">单页应用</text></g>'
  + '<line x1="280" y1="88" x2="398" y2="88" class="arr" marker-end="url(#arrow)"/>'
  + '<g class="c-gray"><rect x="400" y="60" width="220" height="56" rx="8" stroke-width="0.5"/>'
  + '<text class="th" x="510" y="78" text-anchor="middle" dominant-baseline="central">本机 claude</text>'
  + '<text class="ts" x="510" y="96" text-anchor="middle" dominant-baseline="central">transcript</text></g>'
  + '</svg>';

// 孤立代理字符的 SVG：\ud800 经 JSON 转义原样到前端，单独一个高位代理没有配对。
const MOCK_WIDGET_SURROGATE = '<svg viewBox="0 0 100 40"><text class="t" x="4" y="20">\ud800</text></svg>';
