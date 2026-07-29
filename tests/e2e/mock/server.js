import { createVisualMockScenarioRegistry } from './registry.js';
import { createContentScenarios } from './scenarios/content.js';
import { createStatusScenarios } from './scenarios/status.js';
import { createMockTransport } from './transport.js';

const PORT = process.env.PORT || 3100;
const { app, httpServer, io } = createMockTransport();

// Mock Database States
let viewingInstanceId = 'inst_1';
let permissionMode = 'default';
let effortLevel = null;
let activeModel = 'claude-3-5-sonnet';
let pendingFreshPermissionMode;
let pendingFreshEffortLevel;
let pendingFreshCwd;

function createDefaultInstances() {
  return [{
    instanceId: 'inst_1',
    cwd: '/Users/you/code/claude-chat-mobile',
    sessionId: 'mock-session-visual-test',
    title: 'Visual Sandbox (Main)',
    state: 'idle',
    permissionMode: 'default',
    effort: null,
    model: 'claude-3-5-sonnet'
  }];
}

const mockInstances = createDefaultInstances();

let pendingPermission = null;
let pendingQuestion = null;
let questSeq = 0; // 每次 test:question* 递增，避免 TC-5 答过后 TC-5b 同 requestId 被 answeredQuestionIds 吞掉
let syncPendingSnapshot = null; // Bug2：模拟真 server sync:since 的 ack.pending 快照（切入时重建待审批卡片）
let syncPendingSnapshotInstanceId = null;
let mockUnreadOnEntry = 0; // 未读角标：模拟真 server sync:since 的 ack.unreadOnEntry（切入时展示未读胶囊）
let mockUnreadOnEntryInstanceId = null;
let lateClosedSessionEventsInstanceId = null;
let historyOverflowMode = false;
// P3 抽屉局部重建 + SWR 保鲜回归夹具（test:reconnect-drawer-quiet / test:reconnect-drawer-refresh）：
// reconnectDrawerTitleChanged 让 mainCwdSessions() 返回改过名的主工作区会话标题，模拟"断线期间被自主
// 续跑改名"；reconnectSettleMarkerArmed 让下一次 connection handler 在 emitHydration() 之后再追加一条
// system 哨兵消息——E2E 用它确定性地等到"这次重连的 instances 广播已处理完"，不必用禁用的 waitForTimeout。
let reconnectDrawerTitleChanged = false;
let reconnectSettleMarkerArmed = false;
// P0-11x（P1）：终端直跑徽标夹具。真 server 由 listTerminalSessionStates 读 CLI 进程注册表
// （~/.claude/sessions/<PID>.json）给 session:list 行标 terminal:'busy'|'alive'；mock 直接给两条
// 无 live 实例的会话打上这两态，验证抽屉能区分渲染。
let terminalBadgeArmed = false;
// 服务状态面板「终端会话推送」段：安装态夹具（test:hooks-installed 拨到已装）
let mockHooksState = 'not-installed';
// 真 server 的 instances 广播恒带 service 字段；mock 此前完全没带，导致依赖它的前端段落（如
// 配置面板「终端会话推送」）在 mock 下永远不渲染。这里补齐同形 payload。
const mockServicePayload = () => ({
  startedAt: mockServiceStartedAtOverride ?? MOCK_SERVICE_STARTED_AT,
  deliveryFailure: mockDeliveryFailure,
  rateLimitLockout: mockRateLimitLockout,
  clientError: mockClientError,
  hooksBridge: { state: mockHooksState, off: false },
});
let busySilentSwitchMode = false; // test:busy-silent-switch：inst_2 sync 只回放 user_message（触发 reload）、不发 result（模拟静默窗口）
const queuedEchoItems = new Map(); // busy 期回显为 queued 的消息 clientMessageId → {text}：user:cancelQueued 撤回 / interrupt 连带取消 都按它对账
let foregroundSyncReplayMode = false;
let foregroundFoundMissingMode = false;
let foregroundFoundMissingHistoryMode = false;
// P0-SCROLL-1：切走 inst_2 再切回时验证「补发内容后强制落底」——第一次 sync:since 回放固定内容
// （建 DOM 缓存），第二次（切回）才追加"离开期间产生的新内容"模拟离开期间后台继续产出。
let switchBackReplayArmed = false;
// P0-REPLAY-BUFFER：回放缓冲——inst_replay_flood/inst_replay_small 同 inst_scroll_replay 的两段式
// 门控，但 sync:since 的"第几次调用"与 session:history 的"第几次调用"是两次独立的 socket 往返
// （ack 回来后客户端才会另发 session:history），必须用各自独立的 armed 标记，不能共用一个——
// 否则 sync:since 那次调用早把标记翻成 true，session:history 的"第一次"就会误读成"第二次"。
let replayFloodSyncArmed = false;   // false=冷入场 ack(0)；true=切回时推 165 条积压事件（超阈值 → reload）
let replayFloodHistoryArmed = false; // false=返回基线 4 条；true=返回 reload 专属标记文案（证明真走了 session:history）
let replaySmallSyncArmed = false;   // false=冷入场 ack(0)；true=切回时推 21 条积压事件（低于阈值 → flush）
// P0-REPLAY-UNREAD-DISMISS：同 replaySmallSyncArmed 两段式门控，但第二次 ack 额外挂 unreadOnEntry——
// 验证回放缓冲程序性落底与未读胶囊自动确认已读的协同（不复用 mockUnreadOnEntry* 单例，见下方
// sync:since handler 内联的 extra.unreadOnEntry，自包含不受测试执行顺序影响）。
let replayUnreadSyncArmed = false;
let pendingDevices = [];
let alwaysAllowedPermissionNamesByInstance = new Map();
let activeEpoch = 'mock-epoch-init';
let deniedDeviceRetryPending = false;
let mockSessionLogsByInstance = new Map();
let mockDiagLogsByInstance = new Map(); // 镜像/排队/停止诊断时间线（test:diag-sample 注入）
// 服务状态面板：确定性 startedAt（mock 进程启动时刻）；deliveryFailure 由 test:service-delivery-failure 注入，
// rateLimitLockout/clientError（判定化告警）由 test:service-incidents 注入
const MOCK_SERVICE_STARTED_AT = Date.now();
// P0-DESTROY-6（server 重启误报「会话已中断」修复）：test:server-restart 用它把 service.startedAt
// 拨到另一个值，模拟「重连后是另一个 server 进程」——前端 detectServerRestart 据此把「实例全部
// 消失」判为整机重启而非单实例被摧毁。null = 未拨（正常返回进程级常量）。
let mockServiceStartedAtOverride = null;
let mockDeliveryFailure = null;
let mockRateLimitLockout = null;
let mockClientError = null;

function resetMockState() {
  mockServiceStartedAtOverride = null;
  mockDeliveryFailure = null;
  mockRateLimitLockout = null;
  mockClientError = null;
  viewingInstanceId = 'inst_1';
  permissionMode = 'default';
  effortLevel = null;
  activeModel = 'claude-3-5-sonnet';
  pendingFreshPermissionMode = undefined;
  pendingFreshEffortLevel = undefined;
  pendingFreshCwd = undefined;
  mockInstances.splice(0, mockInstances.length, ...createDefaultInstances());
  pendingPermission = null;
  pendingQuestion = null;
  syncPendingSnapshot = null;
  syncPendingSnapshotInstanceId = null;
  mockUnreadOnEntry = 0;
  mockUnreadOnEntryInstanceId = null;
  lateClosedSessionEventsInstanceId = null;
  historyOverflowMode = false;
  reconnectDrawerTitleChanged = false;
  reconnectSettleMarkerArmed = false;
  terminalBadgeArmed = false;
  mockHooksState = 'not-installed';
  busySilentSwitchMode = false;
  foregroundSyncReplayMode = false;
  foregroundFoundMissingMode = false;
  foregroundFoundMissingHistoryMode = false;
  switchBackReplayArmed = false;
  replayFloodSyncArmed = false;
  replayFloodHistoryArmed = false;
  replaySmallSyncArmed = false;
  replayUnreadSyncArmed = false;
  pendingDevices = [];
  alwaysAllowedPermissionNamesByInstance = new Map();
  activeEpoch = 'mock-epoch-init';
  deniedDeviceRetryPending = false;
  mockSessionLogsByInstance = new Map();
}

function pendingFreshPermissionOrDefault() {
  return pendingFreshPermissionMode === undefined ? 'default' : pendingFreshPermissionMode;
}

function pendingFreshEffortOrDefault() {
  return pendingFreshEffortLevel === undefined ? null : pendingFreshEffortLevel;
}

function consumeFreshPrefs() {
  const prefs = {
    permissionMode: pendingFreshPermissionOrDefault(),
    effort: pendingFreshEffortOrDefault()
  };
  pendingFreshPermissionMode = undefined;
  pendingFreshEffortLevel = undefined;
  return prefs;
}

function addMockSessionLog(instanceId, text, type = 'sys_info') {
  const inst = mockInstances.find(i => i.instanceId === instanceId);
  const entry = {
    ts: Date.now(),
    type,
    text,
    model: inst?.model || activeModel,
    effort: inst?.effort || 'model-default',
    permissionMode: inst?.permissionMode || permissionMode
  };
  const logs = mockSessionLogsByInstance.get(instanceId) || [];
  logs.push(entry);
  if (logs.length > 100) logs.shift();
  mockSessionLogsByInstance.set(instanceId, logs);
  io.emit('agent:event', {
    seq: 0,
    epoch: 'server',
    sessionId: inst?.sessionId || null,
    instanceId,
    cwd: inst?.cwd,
    ts: entry.ts,
    type: 'session_log',
    payload: entry
  });
  return entry;
}

// 镜像/排队/停止诊断时间线（真 server: src/agent/diag-log.js）的 mock 同款——同一 seq:0/epoch:'server'
// 旁路广播，供 test:diag-sample 场景注入合成事件，验证 console modal 三态过滤 + formatDiagLogEntry 渲染。
function addMockDiagLog(instanceId, subsystem, event, detail = {}) {
  const inst = mockInstances.find(i => i.instanceId === instanceId);
  const entry = { ts: Date.now(), subsystem, event, detail };
  const logs = mockDiagLogsByInstance.get(instanceId) || [];
  logs.push(entry);
  if (logs.length > 100) logs.shift();
  mockDiagLogsByInstance.set(instanceId, logs);
  io.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: inst?.sessionId || null, instanceId, cwd: inst?.cwd,
    ts: entry.ts, type: 'diag_log', payload: entry
  });
  return entry;
}

function openFreshMockInstance(requestedModel) {
  const freshId = 'inst_fresh';
  const freshPrefs = consumeFreshPrefs();
  const freshModel = requestedModel || activeModel;
  const freshCwd = pendingFreshCwd
    || mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd
    || mockInstances[0]?.cwd
    || '/Users/you/code/claude-chat-mobile';
  pendingFreshCwd = undefined;
  let freshInst = mockInstances.find(i => i.instanceId === freshId);
  if (!freshInst) {
    freshInst = {
      instanceId: freshId,
      cwd: freshCwd,
      sessionId: null,
      title: null,
      state: 'busy',
      permissionMode: freshPrefs.permissionMode,
      effort: freshPrefs.effort,
      model: freshModel
    };
    mockInstances.push(freshInst);
  } else {
    Object.assign(freshInst, {
      state: 'busy',
      cwd: freshCwd,
      permissionMode: freshPrefs.permissionMode,
      effort: freshPrefs.effort,
      model: freshModel
    });
  }
  viewingInstanceId = freshId;
  permissionMode = freshPrefs.permissionMode;
  effortLevel = freshPrefs.effort;
  activeModel = freshModel;
  return freshInst;
}

function createPendingDeviceRequests() {
  return [
    { deviceId: 'aa-bb-cc-dd-iphone-15-pro', ip: '192.168.1.100', userAgent: 'Mozilla/5.0 iPhone', ts: Date.now() - 30000 },
    { deviceId: 'ee-ff-00-11-ipad-air-m2', ip: '192.168.1.101', userAgent: 'Mozilla/5.0 iPad', ts: Date.now() - 60000 }
  ];
}

function emitPendingDevices() {
  io.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
    type: 'pending_devices', payload: { devices: pendingDevices }
  });
}

app.post('/__reset', (_req, res) => {
  resetMockState();
  res.json({ ok: true });
});

// Helper to delay executions to simulate streaming behavior
const delay = ms => new Promise(res => setTimeout(res, ms));

function emitLateClosedSessionEvents(closedInstanceId) {
  const staleSessionId = 'mock-session-closed-stale';
  const staleEpoch = 'mock-epoch-closed-stale';
  const staleCwd = '/Users/you/code/claude-chat-mobile';
  const ts = Date.now();

  io.emit('agent:event', {
    seq: 1, epoch: staleEpoch, sessionId: staleSessionId, instanceId: closedInstanceId, ts,
    type: 'tool_use', payload: { toolUseId: 't_closed_session_stale', name: 'run_command', inputSummary: 'rm -rf /tmp/closed-session-stale' }
  });
  io.emit('agent:event', {
    seq: 2, epoch: staleEpoch, sessionId: staleSessionId, instanceId: closedInstanceId, ts: ts + 1,
    type: 'text_delta', payload: { messageId: 'msg_closed_session_stale', text: 'STALE CLOSED SESSION TEXT MUST NOT RENDER' }
  });
  io.emit('agent:event', {
    seq: 3, epoch: staleEpoch, sessionId: staleSessionId, instanceId: closedInstanceId, ts: ts + 2,
    type: 'permission_request', payload: {
      requestId: 'req_closed_session_stale',
      name: 'run_command',
      input: 'rm -rf /tmp/closed-session-stale',
      cwd: staleCwd
    }
  });
  io.emit('agent:event', {
    seq: 4, epoch: staleEpoch, sessionId: staleSessionId, instanceId: closedInstanceId, ts: ts + 3,
    type: 'question', payload: {
      requestId: 'req_closed_session_stale_question#0',
      text: 'This closed session question must not appear',
      options: ['main', 'dev', 'release-v1.0']
    }
  });
  io.emit('agent:event', {
    seq: 5, epoch: staleEpoch, sessionId: staleSessionId, instanceId: closedInstanceId, ts: ts + 4,
    type: 'result', payload: { messageId: 'msg_closed_session_stale', durationMs: 250, costUsd: 0, isError: false, models: [activeModel] }
  });

  const current = mockInstances.find(i => i.instanceId === viewingInstanceId);
  if (!current) return;
  io.emit('agent:event', {
    seq: 1, epoch: 'mock-epoch-current-after-closed-stale', sessionId: current.sessionId, instanceId: current.instanceId, ts: Date.now(),
    type: 'system', payload: { message: '[MOCK_INFO] Closed-session stale replay finished for current view.' }
  });
}

function mainCwdSessions() {
  const sessions = [
    {
      id: 'mock-session-visual-test',
      // P3 抽屉局部重建回归：断线期间"自主续跑"改了标题，reconnect 后 session:list 应该带新标题——
      // 见 reconnectDrawerTitleChanged 顶部注释 + test:reconnect-drawer-refresh。
      title: reconnectDrawerTitleChanged ? 'Renamed After Reconnect' : 'Visual Sandbox (Main)',
      model: 'claude-3-5-sonnet',
      lastUsedAt: Date.now() - 10000,
      entrypoint: 'sdk-ts'
    },
    {
      id: 'mock-session-archived',
      title: 'Archived Planning Session',
      model: 'claude-3-5-sonnet',
      lastUsedAt: Date.now() - 600000,
      entrypoint: 'sdk-ts',
      ...(terminalBadgeArmed ? { terminal: 'busy' } : {}),
    },
    {
      id: 'mock-session-gap',
      title: 'Archived Gap Session',
      model: 'claude-3-5-sonnet',
      lastUsedAt: Date.now() - 750000,
      ...(terminalBadgeArmed ? { terminal: 'alive' } : {}),
      entrypoint: 'sdk-ts'
    },
    {
      id: 'mock-session-deleted',
      title: 'Deleted Remote Session',
      model: 'claude-3-5-sonnet',
      lastUsedAt: Date.now() - 900000,
      entrypoint: 'sdk-ts'
    },
    {
      id: 'mock-session-long-history',
      title: 'Long History Session',
      model: 'claude-3-5-sonnet',
      lastUsedAt: Date.now() - 1200000,
      entrypoint: 'sdk-ts'
    }
  ];
  if (historyOverflowMode) {
    sessions.push({
      id: 'mock-session-older-migration',
      title: 'Older Migration Session',
      model: 'claude-3-5-sonnet',
      lastUsedAt: Date.now() - 2400000,
      entrypoint: 'sdk-ts'
    });
  }
  return sessions;
}

// E18 附件预览：browse:read base64 分片的上传文件夹 fixture——1×1 PNG，覆盖 live meta（storedName）
// 与历史 [附件] 解析两条点击路径；不在 Map 里的 storedName 走 ok:false（文件已删降级路径）。
const MOCK_ATTACH_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const MOCK_UPLOAD_FILES = new Map([
  ['1700000000000-abcd1234-photo.png', MOCK_ATTACH_PNG],
  ['1700000000001-deadbeef-old.png', MOCK_ATTACH_PNG],
]);


io.on('connection', socket => {
  console.log(`[mock-conn] Socket connected: ${socket.id}`);

  if (deniedDeviceRetryPending) {
    deniedDeviceRetryPending = false;
    socket.deviceApproved = false;
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'device_status', payload: { status: 'pending', deviceId: 'unauthorized-fingerprint-999' }
    });
    return;
  }

  // Auto-approve socket for standard testing (simulates local trust)
  socket.deviceApproved = true;

  // Replay initial hydration events
  const emitHydration = () => {
    // 1. init
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'init', payload: {
        model: activeModel,
        cwd: mockInstances[0].cwd,
        claudeVersion: '0.1.0-mock',
        mcpServers: [],
        skillsCount: 7,
        permissionMode: permissionMode,
        slashCommands: [
          { name: 'help', description: 'Show help guide' },
          { name: 'model', description: 'Switch active model' },
          { name: 'effort', description: 'Adjust Claude thinking effort' }
        ]
      }
    });

    // 2. models
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'models', payload: {
        models: [
          { value: 'default', displayName: 'Default (recommended)' }, // CLI /model 列表首项（不 pin，由 CLI 自选）；空首页高亮它代替旧 data-model="" 伪默认磁贴
          { value: 'claude-3-5-sonnet', displayName: 'Claude 3.5 Sonnet', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'] }, // xhigh：暴露 ultracode 最高档供视觉 E2E（真实档位由网关/CLI 报）
          { value: 'claude-3-5-haiku', displayName: 'Claude 3.5 Haiku' },
          { value: 'claude-3-opus', displayName: 'Claude 3 Opus' },
          { value: 'claude-3-opus[1m]', displayName: 'Claude 3 Opus (1m Context)', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'] } // xhigh：真实 opus 支持，暴露 ultracode 档
        ]
      }
    });

    // 3. permission_mode
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, instanceId: viewingInstanceId, ts: Date.now(),
      type: 'permission_mode', payload: { mode: permissionMode }
    });

    // 4. effort_mode
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, instanceId: viewingInstanceId, ts: Date.now(),
      type: 'effort_mode', payload: { level: effortLevel }
    });

    // 5. instances
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'instances', payload: {
        viewingInstanceId,
        viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd,
        dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
        instances: mockInstances, service: mockServicePayload()
      }
    });

    // 6. status_line initial (structured format)
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'status_line', payload: {
        model: 'claude-3-5-sonnet',
        project: 'claude-chat-mobile',
        cwd: '/Users/you/code/claude-chat-mobile',
        git: { branch: 'main', changed: 0, ahead: 0, behind: 0 },
        ctx: { tokens: 12500, cacheHitPct: 5 },
        cost: 0.00
      }
    });
  };

  emitHydration();

  // P3 抽屉局部重建回归夹具：本次（re）连接是断线重连测试武装的，emitHydration() 的 instances 广播
  // 已经在上面同步发出去了——socket.io 单连接内消息严格按发送顺序送达，客户端必然先处理完 instances
  // 广播才会收到并渲染这条哨兵 system 消息。E2E 等它出现，即可确定性地知道"这次重连触发的面板判定
  // 已经跑完"，不需要引入被 npm run check 禁掉的 waitForTimeout。一次性：消费后立即回落，避免后续
  // 普通重连也带上它。seq 必须大于武装它的那条 test:reconnect-drawer-* 命令已用过的最高 seq（该命令
  // 的 result 事件用了 seq:2，同 epoch 未变）——event-dispatch.js 的去重逻辑按 (epoch, seq) 判定，
  // seq 不严格递增会被判成"重复/陈旧事件"直接丢弃、客户端根本看不到（曾在此踩坑：用 seq:1 被吞）。
  if (reconnectSettleMarkerArmed) {
    reconnectSettleMarkerArmed = false;
    socket.emit('agent:event', {
      seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
      type: 'system', payload: { message: '[MOCK_INFO] Reconnect drawer settle marker.' }
    });
  }

  // Handle setting permission mode
  socket.on('user:setPermissionMode', payload => {
    const { mode, instanceId } = payload || {};
    console.log(`[mock] Set permission mode: ${mode} for ${instanceId}`);
    if (mode) {
      permissionMode = mode;
      if (!instanceId && viewingInstanceId === null) pendingFreshPermissionMode = mode;
      const targetInstanceId = instanceId || viewingInstanceId;
      const inst = mockInstances.find(i => i.instanceId === targetInstanceId);
      if (inst) inst.permissionMode = mode;
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, instanceId: targetInstanceId, ts: Date.now(),
        type: 'permission_mode', payload: { mode }
      });
      // Broadcast instances update
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: {
          viewingInstanceId,
          viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd,
          dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
          instances: mockInstances, service: mockServicePayload(),
          defaultPermissionMode: viewingInstanceId === null ? pendingFreshPermissionOrDefault() : undefined,
          defaultEffort: viewingInstanceId === null ? pendingFreshEffortOrDefault() : undefined
        }
      });
    }
  });

  // Handle setting thinking effort
  socket.on('user:setEffort', payload => {
    const { level, instanceId } = payload || {};
    console.log(`[mock] Set thinking effort: ${level} for ${instanceId}`);
    effortLevel = level;
    if (!instanceId && viewingInstanceId === null) pendingFreshEffortLevel = level ?? null;
    const targetInstanceId = instanceId || viewingInstanceId;
    const inst = mockInstances.find(i => i.instanceId === targetInstanceId);
    if (inst) inst.effort = level;
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, instanceId: targetInstanceId, ts: Date.now(),
      type: 'effort_mode', payload: { level }
    });
    // Broadcast instances update
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'instances', payload: {
        viewingInstanceId,
        viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd,
        dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
        instances: mockInstances, service: mockServicePayload(),
        defaultPermissionMode: viewingInstanceId === null ? pendingFreshPermissionOrDefault() : undefined,
        defaultEffort: viewingInstanceId === null ? pendingFreshEffortOrDefault() : undefined
      }
    });
  });

  // Handle active viewing tab switch
  socket.on('user:setViewing', payload => {
    const { instanceId } = payload || {};
    console.log(`[mock] Switch viewing tab to: ${instanceId}`);
    if (instanceId && mockInstances.some(i => i.instanceId === instanceId)) {
      viewingInstanceId = instanceId;
      const inst = mockInstances.find(i => i.instanceId === instanceId);
      if (inst) {
        permissionMode = inst.permissionMode;
        effortLevel = inst.effort;
        activeModel = inst.model;
      }
      // Re-broadcast instances to all
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: {
          viewingInstanceId,
          viewingCwd: inst?.cwd || mockInstances[0].cwd,
          dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
          instances: mockInstances, service: mockServicePayload()
        }
      });
    }
  });

  // Handle Tab close
  socket.on('session:close', payload => {
    const { instanceId } = payload || {};
    console.log(`[mock] Close Tab: ${instanceId}`);
    const idx = mockInstances.findIndex(i => i.instanceId === instanceId);
    if (idx !== -1) {
      const closedCwd = mockInstances[idx].cwd;
      const shouldEmitLateClosedSessionEvents = lateClosedSessionEventsInstanceId === instanceId;
      if (pendingPermission?.instanceId === instanceId) pendingPermission = null;
      if (pendingQuestion?.instanceId === instanceId) pendingQuestion = null;
      if (syncPendingSnapshotInstanceId === instanceId) {
        syncPendingSnapshot = null;
        syncPendingSnapshotInstanceId = null;
      }
      if (shouldEmitLateClosedSessionEvents) lateClosedSessionEventsInstanceId = null;
      mockInstances.splice(idx, 1);
      if (viewingInstanceId === instanceId) {
        viewingInstanceId = mockInstances[0]?.instanceId ?? null;
        if (!viewingInstanceId) {
          permissionMode = 'default';
          effortLevel = null;
          pendingFreshPermissionMode = undefined;
          pendingFreshEffortLevel = undefined;
          pendingFreshCwd = closedCwd;
        }
      }
      const viewingCwd = mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || closedCwd;
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: {
          viewingInstanceId,
          viewingCwd,
          dirs: Array.from(new Set([...mockInstances.map(i => i.cwd), viewingCwd])),
          instances: mockInstances, service: mockServicePayload(),
          defaultPermissionMode: viewingInstanceId === null ? pendingFreshPermissionOrDefault() : undefined,
          defaultEffort: viewingInstanceId === null ? pendingFreshEffortOrDefault() : undefined
        }
      });
      if (shouldEmitLateClosedSessionEvents) {
        setTimeout(() => emitLateClosedSessionEvents(instanceId), 80);
      }
    }
  });

  // 新会话：清查看 tab（viewingInstanceId=null）→ 前端进空首页。模拟服务端 session:new（不 dispose 后台实例）。
  // 配合 test:freshbusy 复现「新会话首发乐观 busy 被懒开广播冲掉」的回归场景。
  socket.on('session:new', payload => {
    const requestedCwd = payload && typeof payload === 'object' && typeof payload.cwd === 'string'
      ? payload.cwd
      : null;
    const viewingCwd = requestedCwd
      || mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd
      || mockInstances[0]?.cwd
      || '/Users/you/code/claude-chat-mobile';
    console.log(`[mock] session:new → 进空首页（viewingInstanceId=null, cwd=${viewingCwd})`);
    viewingInstanceId = null;
    permissionMode = 'default';
    effortLevel = null;
    pendingFreshPermissionMode = undefined;
    pendingFreshEffortLevel = undefined;
    pendingFreshCwd = viewingCwd;
    const dirs = Array.from(new Set([...mockInstances.map(i => i.cwd), viewingCwd]));
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'instances', payload: {
        viewingInstanceId: null,
        viewingCwd,
        dirs,
        instances: mockInstances, service: mockServicePayload(),
        defaultPermissionMode: pendingFreshPermissionOrDefault(),
        defaultEffort: pendingFreshEffortOrDefault()
      }
    });
  });

  // 回空首页枢纽：清 viewing、保留 live 实例与 pending 档（与 session:new 分工，对齐真 server session:home）。
  // 前端 leaveComposeReady → 底部输入条隐藏，直到再点 ＋ 或进入会话。
  socket.on('session:home', (payload, maybeAck) => {
    const ack = typeof payload === 'function' ? payload : maybeAck;
    const obj = payload && typeof payload === 'object' ? payload : {};
    const requestedCwd = typeof obj.cwd === 'string' && obj.cwd ? obj.cwd : null;
    const viewingCwd = requestedCwd
      || mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd
      || pendingFreshCwd
      || mockInstances[0]?.cwd
      || '/Users/you/code/claude-chat-mobile';
    console.log(`[mock] session:home → 空首页枢纽（viewingInstanceId=null, cwd=${viewingCwd})`);
    viewingInstanceId = null;
    // 不重置 permissionMode/effort/pendingFresh*（与 session:new 区分）
    pendingFreshCwd = viewingCwd;
    const dirs = Array.from(new Set([...mockInstances.map(i => i.cwd), viewingCwd]));
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'instances', payload: {
        viewingInstanceId: null,
        viewingCwd,
        dirs,
        instances: mockInstances, service: mockServicePayload(),
        defaultPermissionMode: pendingFreshPermissionOrDefault(),
        defaultEffort: pendingFreshEffortOrDefault()
      }
    });
    if (typeof ack === 'function') ack({ ok: true, instanceId: null, sessionId: null });
  });

  // Handle session list request for sidebar directory browsing
  socket.on('session:list', (payload, callback) => {
    const { cwd, all } = payload || {};
    console.log(`[mock] session:list for cwd: ${cwd}`);
    if (cwd === '/Users/you/code/claude-chat-mobile') {
      if (typeof callback === 'function') {
        const sessions = mainCwdSessions();
        const visibleSessions = historyOverflowMode && !all ? sessions.slice(0, 3) : sessions;
        callback({
          currentSessionId: 'mock-session-visual-test',
          sessions: visibleSessions,
          hasMore: historyOverflowMode && !all
        });
      }
    } else if (cwd === '/Users/you/code/another-react-project') {
      if (typeof callback === 'function') {
        callback({
          currentSessionId: 'mock-session-another',
          sessions: [
            {
              id: 'mock-session-another',
              title: 'Another App Concurrency',
              model: 'claude-3-5-haiku',
              lastUsedAt: Date.now(),
              entrypoint: 'sdk-ts'
            },
            {
              id: 'mock-session-another-done',
              title: 'Background Done Result',
              model: 'claude-3-5-haiku',
              lastUsedAt: Date.now() - 1500,
              entrypoint: 'sdk-ts'
            },
            {
              id: 'mock-session-another-running',
              title: 'Background Task Running',
              model: 'claude-3-5-haiku',
              lastUsedAt: Date.now() - 1000,
              entrypoint: 'sdk-ts'
            },
            {
              id: 'mock-session-another-permission',
              title: 'Background Needs Approval',
              model: 'claude-3-5-haiku',
              lastUsedAt: Date.now() - 500,
              entrypoint: 'sdk-ts'
            },
            {
              id: 'mock-session-scroll-replay',
              title: 'Scroll Replay Session',
              model: 'claude-3-5-sonnet',
              lastUsedAt: Date.now() - 300,
              entrypoint: 'sdk-ts'
            },
            {
              // P0-REPLAY-BUFFER：会话面板行由 session:list 驱动（liveInst 只是叠加角标/已打开态，
              // 见 app.js populateSubtree renderRows——不在这份列表里的 live-only 实例不会出现一行），
              // 这两条必须与 mockInstances 里 test:replay-buffer-*-setup 注册的 sessionId 对上，
              // 否则侧栏点不到、测试会卡在 openSessionByTitle 超时（同 mock-session-scroll-replay 的模式）。
              id: 'mock-session-replay-flood',
              title: 'Replay Flood Session',
              model: 'claude-3-5-sonnet',
              lastUsedAt: Date.now() - 200,
              entrypoint: 'sdk-ts'
            },
            {
              id: 'mock-session-replay-small',
              title: 'Replay Small Session',
              model: 'claude-3-5-sonnet',
              lastUsedAt: Date.now() - 100,
              entrypoint: 'sdk-ts'
            },
            {
              // P0-REPLAY-UNREAD-DISMISS：回放缓冲程序性落底 × 未读胶囊自动确认已读协同场景专用。
              id: 'mock-session-replay-unread',
              title: 'Replay Unread Session',
              model: 'claude-3-5-sonnet',
              lastUsedAt: Date.now() - 50,
              entrypoint: 'sdk-ts'
            }
          ]
        });
      }
    } else {
      if (typeof callback === 'function') {
        callback({ sessions: [] });
      }
    }
  });

  socket.on('session:switch', (payload, callback) => {
    const { sessionId, cwd } = payload || {};
    console.log(`[mock] session:switch sessionId=${sessionId}, cwd=${cwd}`);
    const knownArchived = {
      // P0-DESTROY-6b：server 重启摧毁 inst_1 后，「继续此会话」按钮走 session:switch 重开原会话
      // （真 server 语义 = 从磁盘 transcript 懒 resume，得到新实例；mock 复用同 id 够验前端链路）。
      'mock-session-visual-test': {
        instanceId: 'inst_1',
        title: 'Visual Sandbox (Main)'
      },
      'mock-session-archived': {
        instanceId: 'inst_archived',
        title: 'Archived Planning Session'
      },
      'mock-session-gap': {
        instanceId: 'inst_gap',
        title: 'Archived Gap Session'
      },
      'mock-session-older-migration': {
        instanceId: 'inst_older_migration',
        title: 'Older Migration Session'
      },
      'mock-session-long-history': {
        instanceId: 'inst_long_history',
        title: 'Long History Session'
      }
    };
    const meta = knownArchived[sessionId];
    if (!meta || cwd !== '/Users/you/code/claude-chat-mobile') {
      if (typeof callback === 'function') callback({ ok: false, error: 'mock session not found' });
      return;
    }

    let archivedInst = mockInstances.find(i => i.instanceId === meta.instanceId);
    if (!archivedInst) {
      archivedInst = {
        instanceId: meta.instanceId,
        cwd: '/Users/you/code/claude-chat-mobile',
        sessionId,
        title: meta.title,
        state: 'idle',
        permissionMode: 'default',
        effort: null,
        model: 'claude-3-5-sonnet'
      };
      mockInstances.push(archivedInst);
    }
    viewingInstanceId = archivedInst.instanceId;
    permissionMode = archivedInst.permissionMode;
    effortLevel = archivedInst.effort;
    activeModel = archivedInst.model;
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'instances', payload: {
        viewingInstanceId,
        viewingCwd: archivedInst.cwd,
        dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
        instances: mockInstances, service: mockServicePayload()
      }
    });
    if (typeof callback === 'function') callback({ ok: true, instanceId: archivedInst.instanceId, sessionId: archivedInst.sessionId });
  });

  // P0-FORK：镜像真实 session:fork handler 的收尾（src/server/app.js）——建/聚焦新实例、广播 instances、ack。
  // 只认 mock-session-archived → mock-session-forked 这一条固定映射，够验前端长按→confirm→切视图链路。
  // uuid 白名单只收 assistant 侧（a-archived-*）：user 气泡长按理应解析出前一条 assistant 的 uuid、不是
  // 自己的（u-archived-*）——若前端解析回归成送自己的 uuid，这里会拒绝，P0-FORKc 能抓到。
  socket.on('session:fork', (payload, callback) => {
    const { sessionId, cwd, uuid } = payload || {};
    console.log(`[mock] session:fork sessionId=${sessionId}, cwd=${cwd}, uuid=${uuid}`);
    if (typeof callback !== 'function') return;
    const validUuids = new Set(['a-archived-1', 'a-archived-2']);
    if (cwd !== '/Users/you/code/claude-chat-mobile' || sessionId !== 'mock-session-archived' || !validUuids.has(uuid)) {
      callback({ ok: false, error: 'mock fork source not found' });
      return;
    }
    const forkedId = 'inst_forked';
    let forkedInst = mockInstances.find(i => i.instanceId === forkedId);
    if (!forkedInst) {
      forkedInst = {
        instanceId: forkedId,
        cwd: '/Users/you/code/claude-chat-mobile',
        sessionId: 'mock-session-forked',
        title: 'Archived Planning Session (fork)',
        state: 'idle',
        permissionMode: 'default',
        effort: null,
        model: 'claude-3-5-sonnet'
      };
      mockInstances.push(forkedInst);
    }
    viewingInstanceId = forkedInst.instanceId;
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'instances', payload: {
        viewingInstanceId,
        viewingCwd: forkedInst.cwd,
        dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
        instances: mockInstances, service: mockServicePayload()
      }
    });
    callback({ ok: true, instanceId: forkedInst.instanceId, sessionId: forkedInst.sessionId });
  });

  socket.on('session:history', (payload, callback) => {
    const { sessionId, cwd } = payload || {};
    console.log(`[mock] session:history sessionId=${sessionId}, cwd=${cwd}`);
    if (typeof callback !== 'function') return;
    if (cwd === '/Users/you/code/claude-chat-mobile' && sessionId === 'mock-session-archived') {
      callback({
        messages: [
          // uuid：P0-FORK 长按分叉锚点定位用（expandHistoryEntry 透出，见 src/sessions/history.js）。
          // 两轮对话：验证长按第二条 user 气泡时前端解析出的是前一条 assistant 的 uuid（a-archived-1），
          // 不是它自己的 uuid（u-archived-2）——见下方 session:fork handler 只认 assistant uuid。
          { role: 'user', content: 'Summarize archived plan', uuid: 'u-archived-1' },
          { role: 'assistant', content: 'Archived plan replay from session history.', uuid: 'a-archived-1' },
          { role: 'user', content: 'Any follow-up questions?', uuid: 'u-archived-2' },
          { role: 'assistant', content: 'No further questions needed.', uuid: 'a-archived-2' }
        ]
      });
    } else if (cwd === '/Users/you/code/claude-chat-mobile' && sessionId === 'mock-session-forked') {
      // P0-FORK：session:fork 成功后前端切视图会拉这条会话历史；文案与源会话不同，便于断言真切换了。
      callback({
        messages: [
          { role: 'user', content: 'Summarize archived plan', uuid: 'u-archived-1' },
          { role: 'assistant', content: 'Forked session ready.', uuid: 'a-forked-1' }
        ]
      });
    } else if (cwd === '/Users/you/code/claude-chat-mobile' && sessionId === 'mock-session-visual-test' && foregroundFoundMissingHistoryMode) {
      foregroundFoundMissingHistoryMode = false;
      callback({
        messages: [
          { role: 'user', content: 'Recovered foreground prompt' },
          { role: 'assistant', content: 'Authoritative history after foreground reload.' }
        ]
      });
    } else if (cwd === '/Users/you/code/claude-chat-mobile' && sessionId === 'mock-session-gap') {
      callback({
        messages: [
          { role: 'user', content: 'Gap recovery prompt' },
          { role: 'assistant', content: 'History fallback after sync gap.' }
        ]
      });
    } else if (cwd === '/Users/you/code/claude-chat-mobile' && sessionId === 'mock-session-older-migration') {
      callback({
        messages: [
          { role: 'user', content: 'Review older migration notes' },
          { role: 'assistant', content: 'Older migration history loaded from session:list overflow.' }
        ]
      });
    } else if (cwd === '/Users/you/code/claude-chat-mobile' && sessionId === 'mock-session-long-history') {
      // Part B：长会话切入分块渲染压测——2000 条触达 HISTORY_MAX_MESSAGES 上限（src/sessions/history.js）
      const messages = [];
      for (let i = 0; i < 2000; i++) {
        messages.push({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: i === 1999 ? 'Long history final message marker' : `Long history stress message #${i}`
        });
      }
      callback({ messages });
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-gap-pending') {
      callback({
        messages: [
          { role: 'user', content: 'Gap pending fallback prompt' },
          { role: 'assistant', content: 'Gap pending history after buffer trim.' }
        ]
      });
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-gap-question') {
      callback({
        messages: [
          { role: 'user', content: 'Gap question fallback prompt' },
          { role: 'assistant', content: 'Gap question history after buffer trim.' }
        ]
      });
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-scroll-replay') {
      // P0-SCROLL-1：首次冷切入内容（30 条，撑满一屏）——不含后续"离开期间产出"的新消息，
      // 那条只在第二次 sync:since（真正切回）时作为 replay 事件补发，见下方 sync:since handler。
      const messages = [];
      for (let i = 0; i < 30; i++) {
        messages.push({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Scroll replay baseline message #${i}`
        });
      }
      callback({ messages });
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-replay-flood') {
      // P0-REPLAY-BUFFER（大量积压→reload）：第一次冷切入返回一小段基线（建 DOM 缓存）；第二次
      // （bufferAction='reload' 后 loadHistory 重新拉取）返回"磁盘权威真相"，文案与 sync:since 那 165
      // 条 live 回放事件（"Flood live reply #N"）完全不同——断言只应看到这里的文案，看不到那边的，
      // 才能证明真的走了清屏 + session:history 批量渲染，而不是把缓冲事件逐条渲染出来。
      if (!replayFloodHistoryArmed) {
        replayFloodHistoryArmed = true;
        const messages = [];
        for (let i = 0; i < 4; i++) {
          messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Flood baseline message #${i}` });
        }
        callback({ messages });
      } else {
        callback({
          messages: [
            { role: 'user', content: 'Flood baseline message #0' },
            { role: 'assistant', content: 'Flood reload marker: disk history now reflects everything that piled up while away.' }
          ]
        });
      }
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-replay-small') {
      // P0-REPLAY-BUFFER（少量积压→flush）：flush 路径不清屏、不重拉 session:history，这里恒定返回
      // 基线内容——若因回归错误地被第二次调用，仍只会重渲染这份基线（不含"Small live reply #N"），
      // 断言据此能抓到误判成 reload 的回归。
      const messages = [];
      for (let i = 0; i < 4; i++) {
        messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Small baseline message #${i}` });
      }
      callback({ messages });
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-replay-unread') {
      // P0-REPLAY-UNREAD-DISMISS：首次冷切入基线（同 mock-session-replay-small 套路，建 DOM 缓存）；
      // 第二次切回走 flush（不重拉 session:history），这里恒定返回同一份基线。
      const messages = [];
      for (let i = 0; i < 4; i++) {
        messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Unread replay baseline message #${i}` });
      }
      callback({ messages });
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-another') {
      // TC-7 并发 tab：冷切入 inst_2 时 shouldReloadOnEnter(!hasCache && replayed>0)→reload，
      // 会 clearView 掉 sync:since 活缓冲回放，必须以磁盘 history 为真相源回填（否则 hydrated=0）。
      callback({
        messages: [
          { role: 'user', content: 'Show me status please' },
          { role: 'assistant', content: 'This is the concurrent session "Another App Concurrency" historical message!' }
        ]
      });
    } else {
      callback({ messages: [] });
    }
  });

  // 工作区 git 变更（只读）：确定性 fixture 供 P0 git-changes E2E
  socket.on('git:status', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({
      ok: true,
      branch: 'dev',
      staged: [{ path: 'staged.js', xy: 'M ' }],
      unstaged: [{ path: 'work.js', xy: ' M' }],
      untracked: [{ path: 'new-file.js' }],
      truncated: false,
    });
  });
  socket.on('git:diff', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const path = payload?.path || 'file.js';
    const side = payload?.side === 'staged' ? 'staged' : 'unstaged';
    ack({
      ok: true,
      path,
      side,
      patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old line\n+new line\n`,
      binary: false,
      truncated: false,
      empty: false,
    });
  });
  // 文件浏览列表：P0-21 选「浏览项目文件」后需可渲染；另两条供 P0-21b 覆盖 CM 查看器命中/回退两路。
  socket.on('browse:list', (_payload, callback) => {
    if (typeof callback !== 'function') return;
    callback({
      ok: true,
      entries: [
        { name: 'README.md', kind: 'file', size: 12, mtime: Date.now() },
        { name: 'demo.js', kind: 'file', size: 48, mtime: Date.now() },
        { name: 'huge.log', kind: 'file', size: 500_000, mtime: Date.now() },
        { name: 'conflict.js', kind: 'file', size: 20, mtime: Date.now() },
      ],
      truncated: false,
      totalCount: 4,
    });
  });

  // P0-EDIT：demo.js 可变内容 + mock "hash"（就用内容本身当哈希——不用跟真 sha256 位对位，
  // 只要「变了就不同、没变就相同」这个契约成立即可）。per-connection 状态，each gotoMock 一份新的。
  let mockDemoJsContent = 'function greet(name) {\n  return `Hello, ${name}!`;\n}\n';
  const mockHashOf = text => `mockhash:${text}`;

  // E18 附件预览：browse:read（契约内事件；仅实现 base64 分片路径——文本浏览走真实 server 的集成面）。
  // 固定 fixture：.ccm-uploads/<storedName> 命中 MOCK_UPLOAD_FILES 才回内容，其余 ok:false（文件已删场景）。
  socket.on('browse:read', (payload, callback) => {
    if (typeof callback !== 'function') return;
    const { relPath, offset = 0, maxBytes = 256 * 1024, encoding } = payload || {};
    // 文本路径：工作区 untracked 预览 fixture
    if (encoding !== 'base64' && String(relPath || '') === 'new-file.js') {
      const text = 'console.log("untracked");\n';
      return callback({ ok: true, content: text, totalSize: text.length, bytesRead: text.length, truncated: false, binary: false });
    }
    // P0-21b/P0-EDIT：一次性读全的小 .js → 前端应切 CM 查看器；带 contentHash → 可编辑（files:write 基线）。
    if (encoding !== 'base64' && String(relPath || '') === 'demo.js') {
      const text = mockDemoJsContent;
      return callback({ ok: true, content: text, totalSize: text.length, bytesRead: text.length, truncated: false, binary: false, contentHash: mockHashOf(text) });
    }
    // P0-21b：首页即 truncated（模拟 >256KB）→ 前端须留在 pre 纯文本，不切 CM。
    if (encoding !== 'base64' && String(relPath || '') === 'huge.log') {
      const text = 'x'.repeat(1000);
      return callback({ ok: true, content: text, totalSize: 500_000, bytesRead: text.length, truncated: true, binary: false });
    }
    // P0-EDIT：可编辑但保存必冲突的固定 fixture（模拟"编辑期间文件被 Claude 并发改过"，不用真并发编排）。
    if (encoding !== 'base64' && String(relPath || '') === 'conflict.js') {
      const text = 'const x = 1;\n';
      return callback({ ok: true, content: text, totalSize: text.length, bytesRead: text.length, truncated: false, binary: false, contentHash: 'conflict-fixture-hash' });
    }
    const m = /^\.ccm-uploads\/(.+)$/.exec(String(relPath || ''));
    const bytes = m && encoding === 'base64' ? MOCK_UPLOAD_FILES.get(m[1]) : null;
    console.log(`[mock] browse:read relPath=${relPath} offset=${offset} hit=${Boolean(bytes)}`);
    if (!bytes) return callback({ ok: false, error: '路径不在授权范围内，或不是文件' });
    const slice = bytes.subarray(offset, offset + maxBytes);
    callback({
      ok: true,
      content: slice.toString('base64'),
      totalSize: bytes.length,
      bytesRead: slice.length,
      truncated: offset + slice.length < bytes.length,
      binary: true
    });
  });

  // P0-EDIT：编辑器保存。只认 demo.js，镜像真实 writeFileInScope 的 baseHash 冲突语义——
  // baseHash 不等于当前 mockHashOf(mockDemoJsContent) 即 conflict，不静默覆盖。
  socket.on('files:write', (payload, callback) => {
    if (typeof callback !== 'function') return;
    const { relPath, content, baseHash } = payload || {};
    console.log(`[mock] files:write relPath=${relPath}`);
    if (String(relPath || '') === 'conflict.js') {
      return callback({ ok: false, code: 'conflict', error: '文件已被修改（可能是 Claude 正在改），请刷新后重试' });
    }
    if (String(relPath || '') !== 'demo.js') {
      return callback({ ok: false, code: 'not_found', error: 'mock 只支持写 demo.js' });
    }
    if (baseHash !== mockHashOf(mockDemoJsContent)) {
      return callback({ ok: false, code: 'conflict', error: '文件已被修改（可能是 Claude 正在改），请刷新后重试' });
    }
    mockDemoJsContent = String(content || '');
    callback({ ok: true, contentHash: mockHashOf(mockDemoJsContent), bytesWritten: mockDemoJsContent.length });
  });

  // P0-MENTION：composer @ 文件引用候选源。固定小候选池 + 简单子串过滤（够验前端触发→防抖→
  // 渲染 chips→点选回填链路，不用照抄服务端 matchFiles 的完整分档排序算法）。
  const MOCK_MENTION_FILES = ['src/app.js', 'src/agent/agent.js', 'README.md', 'package.json'];
  socket.on('files:search', (payload, callback) => {
    if (typeof callback !== 'function') return;
    const q = String(payload?.query || '').toLowerCase().trim();
    console.log(`[mock] files:search query=${q}`);
    // 空 query：对齐真服务 / CLI @ 补全，返回全部候选（不筛）
    const paths = q
      ? MOCK_MENTION_FILES.filter(p => p.toLowerCase().includes(q))
      : MOCK_MENTION_FILES.slice();
    callback({ ok: true, paths });
  });

  // Console modal trace fetch. Production serves persisted per-session interaction logs;
  // the visual lane returns a stable mock row so Clear can be tested without real Claude.
  socket.on('logs:get', (payload, callback) => {
    if (typeof callback !== 'function') return;
    const instanceId = payload?.instanceId || viewingInstanceId;
    const inst = mockInstances.find(i => i.instanceId === instanceId);
    callback({
      logs: [{
        ts: Date.now() - 1000,
        type: 'sys_info',
        text: `[MOCK_LOG] Session trace for ${inst?.title || instanceId || 'new chat'}`,
        model: inst?.model || activeModel,
        effort: inst?.effort || 'model-default',
        permissionMode: inst?.permissionMode || permissionMode
      }, ...(mockSessionLogsByInstance.get(instanceId) || [])],
      diagLogs: mockDiagLogsByInstance.get(instanceId) || [],
    });
  });

  // 连接 RTT 探活（与真 server 对齐）：立即 ack，不改业务状态
  socket.on('conn:ping', (_payload, ack) => {
    if (typeof ack === 'function') ack({ ok: true, t: Date.now() });
  });

  // client:presence（PWA 前台/后台上报，与真 server 对齐）：无 ack，mock 无推送判定逻辑可影响，
  // no-op 接收即可（仅需满足入向事件契约扫描，见 scripts/agent-event-contract.js）。
  socket.on('client:presence', () => {});

  // config:refresh（CLI 配置刷新按钮，与真 server 对齐）：mock 无真实 CLI settings 可重读，ack ok 即可；
  // 小延迟让 E2E 能稳定抓到按钮的禁用→转圈→恢复这段瞬态（真 server 那边 sdkResolveSettings 本身也非零耗时）。
  socket.on('config:refresh', async (_payload, ack) => {
    await delay(150);
    if (typeof ack === 'function') ack({ ok: true });
  });

  // 服务状态面板（与真 server service:status 契约对齐，判定化：不带裸计数器）：确定性 payload 供 E2E 断言；
  // deliveryFailure 由 test:service-delivery-failure 注入，rateLimitLockout/clientError 由 test:service-incidents 注入
  // 一键开关（真 server 会 spawn 安装器写 ~/.claude/settings.json；mock 只翻状态位并回同款报告）
  socket.on('hooks:setup', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const action = payload?.action;
    if (!['install', 'uninstall', 'verify'].includes(action)) return ack({ ok: false, error: '未知操作' });
    if (action === 'install') mockHooksState = 'installed';
    if (action === 'uninstall') mockHooksState = 'not-installed';
    ack({ ok: true, state: mockHooksState, report: action === 'install' ? '✅ 安装成功，端到端验证通过。' : '已移除。' });
    // 与真 server 一致：装/卸后广播新的安装态（前端另有 ack 回填兜底，两条都要保真）
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'instances', payload: {
        viewingInstanceId,
        viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd,
        dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
        instances: mockInstances, service: mockServicePayload(),
      },
    });
  });

  // 测试推送：mock 默认无订阅（与真机初见形态一致，也是最需要被说清的那一态）
  socket.on('push:test', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({ ok: true, sent: 0, failed: 0, subscribed: false });
  });

  socket.on('service:status', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({
      ok: true,
      startedAt: MOCK_SERVICE_STARTED_AT,
      versions: { server: '1.2.1-mock', cli: '0.1.0-mock', sdk: '0.3.201-mock' },
      deliveryFailure: mockDeliveryFailure,
      rateLimitLockout: mockRateLimitLockout,
      clientError: mockClientError,
      // 「终端会话推送」段夹具：默认未安装（新用户初见的形态，也是最需要被引导的那一态）
      hooksBridge: { state: mockHooksState, off: false },
      logging: { interactions: true, sdkDebug: false, stderr: true },
      timestamp: Date.now(),
    });
  });

  // Handle sync:since for switching workspace viewing instances and historical message hydration
  socket.on('sync:since', (payload, callback) => {
    const { instanceId, sessionId } = payload || {};
    console.log(`[mock] sync:since received for instanceId=${instanceId}, sessionId=${sessionId}`);
    // Bug2 状态对账：mock 侧有未决审批/提问快照时随 ack 带回（模拟真 server 的 pendingRequestsSnapshot）——
    // 前端 applyPendingSnapshot 在视图稳定后据此重建卡片，即使原始 permission_request 事件从未回放。
    const ack = (replayed, extra = {}) => {
      if (typeof callback === 'function') {
        const pending = (!syncPendingSnapshotInstanceId || syncPendingSnapshotInstanceId === instanceId) ? syncPendingSnapshot : null;
        const unreadOnEntry = mockUnreadOnEntryInstanceId === instanceId ? mockUnreadOnEntry : 0;
        callback({ ok: true, replayed, pending, unreadOnEntry, ...extra });
      }
    };
    if (instanceId === 'inst_2') {
      if (busySilentSwitchMode) {
        // 静默窗口：只回放 user_message（replayed=1 → !hasCache 触发 reload 分支），
        // 故意不发 text_delta/tool_use/result——这些会各自 setBusy，掩盖「reload 后运行条被抹掉」的缺陷。
        // 运行态真相靠 instances 广播的 inst_2.state='busy'（bindView 入场 seed + reload 后 reseed）。
        socket.emit('agent:event', {
          seq: 1, epoch: 'mock-epoch-another', sessionId: 'mock-session-another', instanceId: 'inst_2', ts: Date.now(),
          type: 'user_message', payload: { text: 'Run the long P0 suite in background' }
        });
        ack(1);
        return;
      }
      // Replay some historical message events for inst_2
      socket.emit('agent:event', {
        seq: 1, epoch: 'mock-epoch-another', sessionId: 'mock-session-another', instanceId: 'inst_2', ts: Date.now(),
        type: 'user_message', payload: { text: 'Show me status please' }
      });
      socket.emit('agent:event', {
        seq: 2, epoch: 'mock-epoch-another', sessionId: 'mock-session-another', instanceId: 'inst_2', ts: Date.now(),
        type: 'text_delta', payload: { messageId: 'msg_another_1', text: 'This is the concurrent session "Another App Concurrency" historical message!' }
      });
      socket.emit('agent:event', {
        seq: 3, epoch: 'mock-epoch-another', sessionId: 'mock-session-another', instanceId: 'inst_2', ts: Date.now(),
        type: 'result', payload: { messageId: 'msg_another_1', durationMs: 1000, costUsd: 0.0005, isError: false, models: ['claude-3-5-haiku'] }
      });
      ack(3);
    } else if (instanceId === 'inst_scroll_replay') {
      // P0-SCROLL-1：第一次切入（!hasCache）→ shouldReloadOnEnter 走 'reload'，走 loadHistory 拉
      // session:history 的 30 条基线、不靠这里的回放（同 inst_2 的 TC-7 注释）；这里只 ack(0)。
      // 第二次切回（hasCache=true）→ 'keep' 分支，推一条"离开期间产生的新内容"验证强制落底。
      if (!switchBackReplayArmed) {
        switchBackReplayArmed = true;
        ack(0);
      } else {
        // 补发内容必须实际撑出可观高度（>120px scrollBottom() 的 near 阈值），否则旧代码「侥幸」
        // 落在 near 判定内也会通过，测不出「不强制补一次落底就停在旧位置」这个真实 bug——单行短
        // 文本不够，用多行长文本模拟真实的一段长回复。
        socket.emit('agent:event', {
          seq: 1, epoch: 'mock-epoch-scroll-replay', sessionId: 'mock-session-scroll-replay', instanceId: 'inst_scroll_replay', ts: Date.now(),
          type: 'user_message', payload: { text: 'What happened while I was away? Please give me the full detailed status report.' }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: 'mock-epoch-scroll-replay', sessionId: 'mock-session-scroll-replay', instanceId: 'inst_scroll_replay', ts: Date.now(),
          type: 'text_delta', payload: {
            messageId: 'msg_scroll_replay_1',
            text: 'This new message arrived while you were on another tab.\n\n' +
              Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: a fairly long status update produced while you were away, so this reply spans many lines.`).join('\n\n')
          }
        });
        socket.emit('agent:event', {
          seq: 3, epoch: 'mock-epoch-scroll-replay', sessionId: 'mock-session-scroll-replay', instanceId: 'inst_scroll_replay', ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_scroll_replay_1', durationMs: 500, costUsd: 0.0002, isError: false, models: ['claude-3-5-sonnet'] }
        });
        ack(3);
      }
    } else if (instanceId === 'inst_replay_flood') {
      // P0-REPLAY-BUFFER（大量积压→reload）：第一次冷入场同 inst_scroll_replay，只 ack(0) 走
      // loadHistory 建 DOM 缓存。第二次（切回）一口气推 55 轮×3 事件=165 条（user_message+text_delta+
      // result），远超 REPLAY_BUFFER_RELOAD_THRESHOLD（logic.js，100）——客户端应判定 'reload'：
      // 丢弃这批缓冲事件、改走上面 session:history 的第二段"权威真相"，故这里的 "Flood live reply #N"
      // 文案绝不应该出现在最终渲染结果里。
      if (!replayFloodSyncArmed) {
        replayFloodSyncArmed = true;
        ack(0);
      } else {
        const epoch = 'mock-epoch-replay-flood';
        const sid = 'mock-session-replay-flood';
        for (let i = 0; i < 55; i++) {
          const mid = `flood_msg_${i}`;
          const ts = Date.now();
          socket.emit('agent:event', {
            seq: i * 3 + 1, epoch, sessionId: sid, instanceId: 'inst_replay_flood', ts,
            type: 'user_message', payload: { text: `Flood live turn #${i}` }, replay: true
          });
          socket.emit('agent:event', {
            seq: i * 3 + 2, epoch, sessionId: sid, instanceId: 'inst_replay_flood', ts,
            type: 'text_delta', payload: { messageId: mid, text: `Flood live reply #${i} should never render (reload should discard it)` }, replay: true
          });
          socket.emit('agent:event', {
            seq: i * 3 + 3, epoch, sessionId: sid, instanceId: 'inst_replay_flood', ts,
            type: 'result', payload: { messageId: mid, durationMs: 10, costUsd: 0, isError: false, models: ['claude-3-5-sonnet'] }, replay: true
          });
        }
        ack(165);
      }
    } else if (instanceId === 'inst_replay_small') {
      // P0-REPLAY-BUFFER（少量积压→flush）：第二次（切回）推 7 轮×3 事件=21 条，低于阈值——客户端
      // 应判定 'flush'：按序正常派发（走原 handler），只是抑制中间各自的滚动、派发完一次性强制落底。
      // 与基线（session:history 建立的 4 条）一起，最终应同时看到基线 + 这 21 条对应的内容。
      if (!replaySmallSyncArmed) {
        replaySmallSyncArmed = true;
        ack(0);
      } else {
        const epoch = 'mock-epoch-replay-small';
        const sid = 'mock-session-replay-small';
        for (let i = 0; i < 7; i++) {
          const mid = `small_msg_${i}`;
          const ts = Date.now();
          socket.emit('agent:event', {
            seq: i * 3 + 1, epoch, sessionId: sid, instanceId: 'inst_replay_small', ts,
            type: 'user_message', payload: { text: `Small live turn #${i}` }, replay: true
          });
          socket.emit('agent:event', {
            seq: i * 3 + 2, epoch, sessionId: sid, instanceId: 'inst_replay_small', ts,
            type: 'text_delta', payload: { messageId: mid, text: `Small live reply #${i} rendered via flush` }, replay: true
          });
          socket.emit('agent:event', {
            seq: i * 3 + 3, epoch, sessionId: sid, instanceId: 'inst_replay_small', ts,
            type: 'result', payload: { messageId: mid, durationMs: 10, costUsd: 0, isError: false, models: ['claude-3-5-sonnet'] }, replay: true
          });
        }
        ack(21);
      }
    } else if (instanceId === 'inst_replay_unread') {
      // P0-REPLAY-UNREAD-DISMISS（回放缓冲程序性落底 × 未读胶囊自动确认已读协同）：同 inst_replay_small
      // 的两段式门控（第二次切回推 21 条低于阈值的积压事件 → flush + scrollBottom(true) 程序性落底），
      // 但第二次 ack 额外挂 unreadOnEntry=3——验证"切入积压未读会话时程序性落底不应误清胶囊，只有用户
      // 后续真实滚动到底部才应该"（app.js shouldAckUnreadOnScroll + scrollBottom 的 programmaticScrollUntil
      // 窗口）。ack() 默认按 mockUnreadOnEntry/mockUnreadOnEntryInstanceId 单例算出的值恒为 0（本场景不
      // 设置那对全局字段）——用 extra.unreadOnEntry 直接覆盖，自包含，不与 test:unread-pill（inst_2）
      // 等其它场景共享可变状态，不受测试执行顺序影响。
      if (!replayUnreadSyncArmed) {
        replayUnreadSyncArmed = true;
        ack(0);
      } else {
        const epoch = 'mock-epoch-replay-unread';
        const sid = 'mock-session-replay-unread';
        for (let i = 0; i < 7; i++) {
          const mid = `unread_replay_msg_${i}`;
          const ts = Date.now();
          socket.emit('agent:event', {
            seq: i * 3 + 1, epoch, sessionId: sid, instanceId: 'inst_replay_unread', ts,
            type: 'user_message', payload: { text: `Unread replay live turn #${i}` }, replay: true
          });
          socket.emit('agent:event', {
            seq: i * 3 + 2, epoch, sessionId: sid, instanceId: 'inst_replay_unread', ts,
            type: 'text_delta', payload: { messageId: mid, text: `Unread replay live reply #${i} rendered via flush` }, replay: true
          });
          socket.emit('agent:event', {
            seq: i * 3 + 3, epoch, sessionId: sid, instanceId: 'inst_replay_unread', ts,
            type: 'result', payload: { messageId: mid, durationMs: 10, costUsd: 0, isError: false, models: ['claude-3-5-sonnet'] }, replay: true
          });
        }
        ack(21, { unreadOnEntry: 3 });
      }
    } else if (instanceId === 'inst_gap') {
      socket.emit('agent:event', {
        seq: 1, epoch: 'mock-epoch-gap-partial', sessionId: 'mock-session-gap', instanceId: 'inst_gap', ts: Date.now(),
        type: 'text_delta', payload: { messageId: 'msg_gap_partial', text: 'Partial gap buffer that must be discarded' }
      });
      ack(1, { gap: true });
    } else if (instanceId === 'inst_gap_pending') {
      socket.emit('agent:event', {
        seq: 1, epoch: 'mock-epoch-gap-pending-partial', sessionId: 'mock-session-gap-pending', instanceId: 'inst_gap_pending', ts: Date.now(),
        type: 'text_delta', payload: { messageId: 'msg_gap_pending_partial', text: 'Partial pending gap buffer that must be discarded' }
      });
      ack(1, { gap: true });
    } else if (instanceId === 'inst_gap_question') {
      socket.emit('agent:event', {
        seq: 1, epoch: 'mock-epoch-gap-question-partial', sessionId: 'mock-session-gap-question', instanceId: 'inst_gap_question', ts: Date.now(),
        type: 'text_delta', payload: { messageId: 'msg_gap_question_partial', text: 'Partial question gap buffer that must be discarded' }
      });
      ack(1, { gap: true });
    } else if (instanceId === 'inst_1') {
      if (foregroundFoundMissingMode) {
        foregroundFoundMissingMode = false;
        ack(0, { found: false });
        return;
      }
      if (foregroundSyncReplayMode) {
        foregroundSyncReplayMode = false;
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_foreground_sync_1', text: 'Foreground sync baseline response.' }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_foreground_sync_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Foreground sync replay completed.' }
        });
        ack(3);
        return;
      }
      ack(0); // Fallback to history or empty
    } else {
      ack(0);
    }
  });

  const scenarioRegistry = createVisualMockScenarioRegistry([
    ...createStatusScenarios(() => ({
      io, socket, activeEpoch, viewingInstanceId, activeModel, permissionMode, mockInstances, delay, addMockSessionLog,
      setMockDeliveryFailure: value => { mockDeliveryFailure = value; },
      setMockServiceIncidents: ({ rateLimitLockout = null, clientError = null } = {}) => {
        mockRateLimitLockout = rateLimitLockout; mockClientError = clientError;
      },
      setViewingInstanceId: value => { viewingInstanceId = value; },
      // test:server-restart：把 service.startedAt 拨到另一个值（模拟重连到重启后的新 server 进程）
      // + 广播时带上同形 service payload（真 server 的 instances 广播恒带 service 字段）。
      bumpServiceStartedAt: () => { mockServiceStartedAtOverride = (mockServiceStartedAtOverride ?? MOCK_SERVICE_STARTED_AT) + 60_000; },
      mockServicePayload,
    })),
    ...createContentScenarios(() => ({
      io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay,
      setViewingInstanceId: value => { viewingInstanceId = value; },
    })),
    {
      commands: ['test:question', 'test:question-duplicate', 'test:question-remote-resolved', 'test:question-result-error'],
      run: async ({ cmd, activeInst }) => {
        console.log(`[mock] Starting ${cmd} sequence`);
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'thinking_delta', payload: { messageId: 'msg_quest_1', text: '<thinking>Claude needs clarifying requirements before proceeding...</thinking>' }
        });
        await delay(500);

        questSeq += 1;
        const questToolId = `t_ask_choice_${questSeq}`;
        const questMsgId = `msg_quest_${questSeq}`;
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: questToolId, name: 'AskUserQuestion', inputSummary: 'Choose a publish channel' }
        });
        await delay(500);

        activeInst.state = 'permission';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        pendingQuestion = {
          requestId: `${questToolId}#0`,
          toolUseId: questToolId,
          messageId: questMsgId,
          options: ['main (Stable Production)', 'dev (Bleeding-Edge Integration)', 'release-v1.0 (LTS)']
        };

        const questionEvent = {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'question', payload: {
            requestId: pendingQuestion.requestId,
            text: 'We are ready to tag and deploy this mobile dashboard app. Which branch should be our target publish destination?',
            options: pendingQuestion.options
          }
        };

        // Emit multi-choice question
        socket.emit('agent:event', questionEvent);
        if (cmd === 'test:question-duplicate') {
          socket.emit('agent:event', { ...questionEvent, seq: 4, ts: Date.now(), type: 'question' });
        }
        if (cmd === 'test:question-result-error') {
          await delay(600);
          activeInst.state = 'idle';
          io.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
          });
          socket.emit('agent:event', {
            seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'result', payload: { messageId: pendingQuestion.messageId, durationMs: 900, costUsd: 0.001, isError: true, errors: ['mock question turn failed'], models: [activeModel] }
          });
          pendingQuestion = null;
        }
        if (cmd === 'test:question-remote-resolved') {
          await delay(600);
          const selectedOption = pendingQuestion.options[0];
          io.emit('agent:event', {
            seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'request_resolved', payload: { requestId: pendingQuestion.requestId, kind: 'question', outcome: 'option 0' }
          });
          socket.emit('agent:event', {
            seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'tool_result', payload: { toolUseId: pendingQuestion.toolUseId, ok: true, outputSummary: `answered on another trusted device: ${selectedOption}`, denyKind: 'answered' }
          });
          socket.emit('agent:event', {
            seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'text_delta', payload: { messageId: pendingQuestion.messageId, text: `\n\nQuestion was answered on another trusted device: **${selectedOption}**.` }
          });
          await delay(250);
          activeInst.state = 'idle';
          io.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
          });
          socket.emit('agent:event', {
            seq: 7, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'result', payload: { messageId: pendingQuestion.messageId, durationMs: 900, costUsd: 0.001, isError: false, models: [activeModel] }
          });
          pendingQuestion = null;
        }
      },
    },
    {
      commands: ['test:permission', 'test:permission-remote-resolved', 'test:permission-result-error'],
      run: async ({ cmd, activeInst }) => {
        console.log(`[mock] Starting ${cmd} sequence`);
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'thinking_delta', payload: { messageId: 'msg_perm_1', text: '<thinking>Preparing to push local test commits to the remote origin server...</thinking>' }
        });
        await delay(500);

        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_git_push', name: 'run_command', inputSummary: 'git push origin main' }
        });
        await delay(500);

        if (alwaysAllowedPermissionNamesByInstance.get(viewingInstanceId)?.has('run_command')) {
          socket.emit('agent:event', {
            seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'tool_result', payload: { toolUseId: 't_git_push', ok: true, outputSummary: 'git push success: branch main -> origin' }
          });
          socket.emit('agent:event', {
            seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'text_delta', payload: { messageId: 'msg_perm_1', text: '\n\n✓ Successfully pushed latest codebase additions!' }
          });
          await delay(250);
          activeInst.state = 'idle';
          io.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
          });
          socket.emit('agent:event', {
            seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'result', payload: { messageId: 'msg_perm_1', durationMs: 900, costUsd: 0.001, isError: false, models: [activeModel] }
          });
          return;
        }

        activeInst.state = 'permission';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        pendingPermission = {
          requestId: 'req_perm_git_push',
          toolUseId: 't_git_push',
          messageId: 'msg_perm_1',
          name: 'run_command',
          input: 'git push origin main',
          cwd: activeInst.cwd
        };

        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'permission_request', payload: {
            requestId: pendingPermission.requestId,
            name: pendingPermission.name,
            input: pendingPermission.input,
            cwd: pendingPermission.cwd
          }
        });

        if (cmd === 'test:permission-result-error') {
          await delay(600);
          activeInst.state = 'idle';
          io.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
          });
          socket.emit('agent:event', {
            seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'result', payload: { messageId: pendingPermission.messageId, durationMs: 900, costUsd: 0.001, isError: true, errors: ['mock permission turn failed'], models: [activeModel] }
          });
          pendingPermission = null;
        }

        if (cmd === 'test:permission-remote-resolved') {
          await delay(600);
          io.emit('agent:event', {
            seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'request_resolved', payload: { requestId: pendingPermission.requestId, kind: 'permission', outcome: 'allow' }
          });
          socket.emit('agent:event', {
            seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'tool_result', payload: { toolUseId: pendingPermission.toolUseId, ok: true, outputSummary: 'approved on another trusted device: git push success' }
          });
          socket.emit('agent:event', {
            seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'text_delta', payload: { messageId: pendingPermission.messageId, text: '\n\nPermission was approved on another trusted device.' }
          });
          await delay(250);
          activeInst.state = 'idle';
          io.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
          });
          socket.emit('agent:event', {
            seq: 7, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'result', payload: { messageId: pendingPermission.messageId, durationMs: 900, costUsd: 0.001, isError: false, models: [activeModel] }
          });
          pendingPermission = null;
        }
      },
    },
    {
      command: 'test:fresh-settings-echo',
      run: async ({ requestedModel }) => {
        console.log('[mock] test:fresh-settings-echo — 回显新会话首发设置');
        await delay(150);
        const freshInst = openFreshMockInstance(requestedModel);
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: freshInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        const effectiveModel = requestedModel || '未指定(沿用)';
        const effectiveEffort = freshInst.effort || 'model-default';
        await delay(250);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: null, instanceId: freshInst.instanceId, ts: Date.now(),
          type: 'text_delta', payload: {
            messageId: 'msg_fresh_settings_echo_1',
            text: `新会话设置回显：model=${effectiveModel}; permission=${freshInst.permissionMode}; effort=${effectiveEffort}`
          }
        });

        freshInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: freshInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: null, instanceId: freshInst.instanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_fresh_settings_echo_1', durationMs: 250, costUsd: 0, isError: false, models: [requestedModel || activeModel] }
        });
      },
    },
    {
      command: 'test:settings-echo',
      run: async ({ activeInst, requestedModel }) => {
        console.log('[mock] Echoing selected model / permission / effort for settings regression');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        const effectiveModel = requestedModel || '未指定(沿用)';
        const effectivePermission = activeInst.permissionMode || permissionMode || 'default';
        const effectiveEffort = activeInst.effort || effortLevel || 'model-default';
        await delay(250);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: {
            messageId: 'msg_settings_echo_1',
            text: `设置回显：model=${effectiveModel}; permission=${effectivePermission}; effort=${effectiveEffort}`
          }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_settings_echo_1', durationMs: 250, costUsd: 0, isError: false, models: [requestedModel || activeModel] }
        });
      },
    },
    {
      commands: ['test:pendingsnapshot', 'test:pendingsnapshot-duplicate'],
      run: async ({ cmd }) => {
        // Bug2 regression: sync:since ack.pending must rebuild cards when the original event is gone.
        console.log(`[mock] ${cmd} — 设快照但不发 permission_request，切 viewing 到 inst_2 触发 sync:since`);
        const permissionSnapshot = { requestId: 'req_snapshot', name: 'run_command', input: 'rm -rf /tmp/stale', cwd: mockInstances.find(i => i.instanceId === 'inst_2')?.cwd };
        syncPendingSnapshot = {
          permissions: cmd === 'test:pendingsnapshot-duplicate' ? [permissionSnapshot, permissionSnapshot] : [permissionSnapshot],
          questions: []
        };
        syncPendingSnapshotInstanceId = 'inst_2';
        viewingInstanceId = 'inst_2';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: mockInstances.find(i => i.instanceId === 'inst_2')?.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      // 未读角标：切到 inst_2 时 sync:since ack 带 unreadOnEntry=1，模拟离开期间攒了 1 条未读顶层消息。
      // inst_2 的默认 sync:since 回放固定是 2 条顶层气泡（user_message + text_delta 各一），
      // unreadOnEntry=1 应定位到最后一条（resolveUnreadAnchorIndex(2,1)=1）。
      // P0-11x：给两条无 live 实例的主工作区会话标上终端直跑态，验证抽屉 ⌨️ 徽标 busy/alive 两态可区分。
      command: 'test:hooks-installed',
      run: async () => {
        console.log('[mock] test:hooks-installed — 配置面板「终端会话推送」显示已启用');
        mockHooksState = 'installed';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload(),
          },
        });
      },
    },
    {
      command: 'test:terminal-badge',
      run: async () => {
        console.log('[mock] test:terminal-badge — archived=busy / gap=alive，下次 session:list 带 terminal 字段');
        terminalBadgeArmed = true;
      },
    },
    {
      command: 'test:unread-pill',
      run: async () => {
        console.log('[mock] test:unread-pill — inst_2 有 1 条未读，切 viewing 触发 sync:since 展示胶囊');
        mockUnreadOnEntry = 1;
        mockUnreadOnEntryInstanceId = 'inst_2';
        viewingInstanceId = 'inst_2';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: mockInstances.find(i => i.instanceId === 'inst_2')?.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      // P0-SCROLL-1：验证「切走再切回、离开期间后台产出新内容」时强制落底到真正的底部，而非停在
      // 缓存的旧内容底部。inst_scroll_replay 首次冷切入走 loadHistory（session:history 30 条撑满
      // 一屏，建立 DOM 缓存）；切回主会话后（模拟"离开"）；第二次切回该实例时 sync:since 命中
      // hasCache=true 分支，推送一条新的补发消息（switchBackReplayArmed 门控，只在第二次触发）。
      command: 'test:scroll-replay-setup',
      run: async () => {
        console.log('[mock] test:scroll-replay-setup — 注册 inst_scroll_replay（长历史，供切走再切回验证强制落底）');
        if (!mockInstances.some(i => i.instanceId === 'inst_scroll_replay')) {
          mockInstances.push({
            instanceId: 'inst_scroll_replay',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-scroll-replay',
            title: 'Scroll Replay Session',
            state: 'idle',
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-sonnet'
          });
        }
        switchBackReplayArmed = false;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      // P0-REPLAY-BUFFER（大量积压→reload）：同 test:scroll-replay-setup 两段式门控，但第二次切回时
      // sync:since 推 165 条积压事件（远超阈值）——客户端应判定 reload，清屏改走 session:history。
      command: 'test:replay-buffer-flood-setup',
      run: async () => {
        console.log('[mock] test:replay-buffer-flood-setup — 注册 inst_replay_flood（供验证大量积压走 reload 批量渲染）');
        if (!mockInstances.some(i => i.instanceId === 'inst_replay_flood')) {
          mockInstances.push({
            instanceId: 'inst_replay_flood',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-replay-flood',
            title: 'Replay Flood Session',
            state: 'idle',
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-sonnet'
          });
        }
        replayFloodSyncArmed = false;
        replayFloodHistoryArmed = false;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      // P0-REPLAY-BUFFER（少量积压→flush）：第二次切回时 sync:since 只推 21 条积压事件（低于阈值）——
      // 客户端应判定 flush，正常增量派发但抑制中间滚动，不清屏、不重拉 session:history。
      command: 'test:replay-buffer-small-setup',
      run: async () => {
        console.log('[mock] test:replay-buffer-small-setup — 注册 inst_replay_small（供验证少量积压走 flush 增量渲染）');
        if (!mockInstances.some(i => i.instanceId === 'inst_replay_small')) {
          mockInstances.push({
            instanceId: 'inst_replay_small',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-replay-small',
            title: 'Replay Small Session',
            state: 'idle',
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-sonnet'
          });
        }
        replaySmallSyncArmed = false;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      // P0-REPLAY-UNREAD-DISMISS：同 test:replay-buffer-small-setup 套路（第二次切回走 flush），但那次
      // ack 额外带 unreadOnEntry=3——验证回放缓冲程序性落底与未读胶囊自动确认已读的协同（不应被程序性
      // 落底误清，只应被用户后续真实滚动到底部清除）。
      command: 'test:replay-buffer-unread-setup',
      run: async () => {
        console.log('[mock] test:replay-buffer-unread-setup — 注册 inst_replay_unread（供验证程序性落底不误清未读胶囊）');
        if (!mockInstances.some(i => i.instanceId === 'inst_replay_unread')) {
          mockInstances.push({
            instanceId: 'inst_replay_unread',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-replay-unread',
            title: 'Replay Unread Session',
            state: 'idle',
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-sonnet'
          });
        }
        replayUnreadSyncArmed = false;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      command: 'test:gap-pending-snapshot',
      run: async () => {
        console.log('[mock] test:gap-pending-snapshot — gap ack 后仍带回 pending snapshot');
        let inst = mockInstances.find(i => i.instanceId === 'inst_gap_pending');
        if (!inst) {
          inst = {
            instanceId: 'inst_gap_pending',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-gap-pending',
            title: 'Gap Pending Recovery',
            state: 'permission',
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-haiku',
            activeTool: 'Bash'
          };
          mockInstances.push(inst);
        } else {
          inst.state = 'permission';
          inst.activeTool = 'Bash';
        }
        pendingPermission = {
          instanceId: 'inst_gap_pending',
          requestId: 'req_gap_pending_snapshot',
          toolUseId: 't_gap_pending_snapshot',
          messageId: 'msg_gap_pending_snapshot_1',
          name: 'run_command',
          input: 'rm -rf /tmp/gap-stale',
          cwd: inst.cwd
        };
        syncPendingSnapshot = {
          permissions: [{
            requestId: pendingPermission.requestId,
            name: pendingPermission.name,
            input: pendingPermission.input,
            cwd: pendingPermission.cwd
          }],
          questions: []
        };
        syncPendingSnapshotInstanceId = 'inst_gap_pending';
        viewingInstanceId = 'inst_gap_pending';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: inst.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
      },
    },
    {
      command: 'test:questionsnapshot',
      run: async () => {
        console.log('[mock] test:questionsnapshot — 设 question 快照但不发原始 question 事件，切 viewing 到 inst_2 触发 sync:since');
        pendingQuestion = {
          requestId: 'req_question_snapshot#0',
          toolUseId: 't_question_snapshot',
          messageId: 'msg_question_snapshot_1',
          options: ['main', 'dev', 'release-v1.0']
        };
        syncPendingSnapshot = {
          permissions: [],
          questions: [{
            requestId: pendingQuestion.requestId,
            text: 'Which release branch should receive the restored pending answer?',
            options: pendingQuestion.options
          }]
        };
        syncPendingSnapshotInstanceId = 'inst_2';
        viewingInstanceId = 'inst_2';
        const inst = mockInstances.find(i => i.instanceId === 'inst_2');
        if (inst) inst.state = 'permission';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: inst?.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      command: 'test:gap-question-snapshot',
      run: async () => {
        console.log('[mock] test:gap-question-snapshot — gap ack 后仍带回 AskUserQuestion pending snapshot');
        let inst = mockInstances.find(i => i.instanceId === 'inst_gap_question');
        if (!inst) {
          inst = {
            instanceId: 'inst_gap_question',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-gap-question',
            title: 'Gap Question Recovery',
            state: 'permission',
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-haiku',
            activeTool: 'AskUserQuestion'
          };
          mockInstances.push(inst);
        } else {
          inst.state = 'permission';
          inst.activeTool = 'AskUserQuestion';
        }
        pendingQuestion = {
          instanceId: 'inst_gap_question',
          requestId: 'req_gap_question_snapshot#0',
          toolUseId: 't_gap_question_snapshot',
          messageId: 'msg_gap_question_snapshot_1',
          options: ['main', 'dev', 'release-v1.0']
        };
        syncPendingSnapshot = {
          permissions: [],
          questions: [{
            requestId: pendingQuestion.requestId,
            text: 'Which release branch should receive the gap-restored pending answer?',
            options: pendingQuestion.options
          }]
        };
        syncPendingSnapshotInstanceId = 'inst_gap_question';
        viewingInstanceId = 'inst_gap_question';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: inst.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
      },
    },
    {
      commands: ['test:mirror-observed-settings', 'ultracode test:mirror-observed-settings'],
      run: async ({ activeInst }) => {
        const mirrorInstanceId = viewingInstanceId;
        const mirrorSessionId = activeInst.sessionId || 'mock-session-visual-test';
        console.log('[mock] test:mirror-observed-settings — 模拟 CLI 设置观察态');
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: mirrorSessionId, instanceId: mirrorInstanceId, cwd: activeInst.cwd, ts: Date.now(),
          type: 'mirror_state',
          payload: {
            readonly: true,
            stale: true,
            observedCli: { model: 'claude-opus-4-8[1m]', permissionMode: 'auto', effort: 'max' },
          }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: null, instanceId: mirrorInstanceId, ts: Date.now(),
          type: 'models', payload: { models: [
            { value: 'default', displayName: 'Default (recommended)' },
            { value: 'claude-3-5-sonnet', displayName: 'Claude 3.5 Sonnet', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'] },
            { value: 'claude-3-opus[1m]', displayName: 'Claude 3 Opus (1m Context)', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'] },
          ] }
        });
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: mirrorSessionId, instanceId: mirrorInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_mirror_observed_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:diag-sample',
      run: async ({ cmd, activeInst }) => {
        // 注入覆盖 mirror/queue/interrupt 三个子系统的合成诊断事件，供 P0-16h 断言 console modal
        // 三态过滤 + formatDiagLogEntry 渲染出人话而非裸 JSON。末尾照常 emit 一条 result 结束本轮，
        // 否则前端一直停在 busy（#streamLiveStatus 常驻），waitForIdle 永久超时。
        console.log(`[mock] ${cmd} — 注入诊断时间线合成事件`);
        addMockDiagLog(activeInst.instanceId, 'mirror', 'state_change', { reason: 'entry_lock', readonly: true, prevReadonly: false, stale: false });
        addMockDiagLog(activeInst.instanceId, 'interrupt', 'settled', { outcome: 'success', ms: 12, droppedCount: 0, timedOut: false });
        addMockDiagLog(activeInst.instanceId, 'queue', 'turn_settled', { wasInterrupted: true, durationMs: 340, isError: false });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: activeInst.sessionId, instanceId: activeInst.instanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_diag_sample_1', durationMs: 340, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      commands: ['test:mirror-readonly', 'test:mirror-readonly-delayed'],
      run: async ({ cmd, activeInst }) => {
        const delayedMirror = cmd === 'test:mirror-readonly-delayed';
        const mirrorInstanceId = viewingInstanceId;
        const mirrorSessionId = activeInst.sessionId || 'mock-session-visual-test';
        const mirrorCwd = activeInst.cwd;
        console.log(`[mock] ${cmd} — 模拟终端会话正在运行，只读追平锁`);
        if (delayedMirror) await delay(650);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: mirrorSessionId, instanceId: mirrorInstanceId, cwd: mirrorCwd, ts: Date.now(),
          type: 'mirror_state', payload: { readonly: true }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: mirrorSessionId, instanceId: mirrorInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_mirror_readonly_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
        // TC-003 附带修复：2026-07-13「排队接管」上线后，非 stale 会话点「接管 CLI 会话」只 armed（见 app.js
        // armedTakeoverStep），不再像旧的两态模型那样立即解锁——需要终端本轮完结（readonly:false 到达）才自动
        // 放行。此前本场景从不发这个后续事件，P0-17c/17f 的「点接管 → 断言解锁」断言因此永久等不到，被
        // task-progress.spec.ts:55/100 的旧横幅文案断言抢先失败掩盖，两个问题叠在一起。同 test:mirror-armed
        // 场景的手法，补一次延迟后的 readonly:false，模拟终端本轮完结——不管此刻是否已点接管，效果都正确
        // （armed 则 unlock-focus 自动放行；未 armed 则直接照常解锁），零改动测试断言本身。
        await delay(1200);
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: mirrorSessionId, instanceId: mirrorInstanceId, ts: Date.now(),
          type: 'mirror_state', payload: { readonly: false }
        });
      },
    },
    {
      commands: ['test:taskprogress', 'test:taskprogress-failed'],
      run: async ({ cmd, activeInst }) => {
        // Mirrors transient SDK background task heartbeats without adding buffered events.
        console.log(`[mock] ${cmd} — 推送后台任务进度心跳序列 + 完成/失败通知`);
        // WS-009：本场景每步都 await delay 后再 emit——期间用户可能切 tab 令全局 viewingInstanceId 变。冻结 dispatch
        // 时的目标实例 id，全场景事件都用它（对齐相邻 mirror handler 用 mirrorInstanceId 的正确写法），否则切走后
        // 这些 task_progress/notification/result 会被标成【当前查看的另一实例】。
        const targetInstanceId = activeInst.instanceId;
        activeInst.state = 'busy';
        const failedTask = cmd === 'test:taskprogress-failed';
        const progressSteps = failedTask
          ? ['步骤 1/3：读取源文件…', '步骤 2/3：运行测试失败…']
          : ['步骤 1/3：读取源文件…', '步骤 2/3：合并重复逻辑…', '步骤 3/3：运行测试验证…'];
        for (const message of progressSteps) {
          await delay(600);
          io.emit('agent:event', {
            seq: 50, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetInstanceId, ts: Date.now(),
            type: 'task_progress', transient: true, payload: { taskId: 'bg_task_1', taskType: 'local_agent', message, description: message, lastToolName: 'Bash' }
          });
        }
        await delay(600);
        io.emit('agent:event', {
          seq: 51, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetInstanceId, ts: Date.now(),
          type: 'task_notification', payload: {
            source: 'system',
            taskId: 'bg_task_1',
            status: failedTask ? 'failed' : 'completed',
            summary: failedTask ? 'mock background task failed' : '后台任务已完成'
          }
        });
        await delay(150);
        activeInst.state = 'idle';
        socket.emit('agent:event', {
          seq: 100, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_bgtask', durationMs: 2000, costUsd: 0.001, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:taskprogress-multi',
      run: async ({ activeInst }) => {
        // 多任务全量快照（emitBgTasksSnapshot 形态）：验证横幅默认折叠列表 + 折叠按钮展开/收起。
        console.log('[mock] test:taskprogress-multi — 推送多任务全量快照');
        const targetInstanceId = activeInst.instanceId;
        activeInst.state = 'busy';
        const tasks = [
          { taskId: 'bg_task_a', taskType: 'local_agent', message: 'Explore：搜索用例' },
          { taskId: 'bg_task_b', taskType: 'local_bash', message: 'npm test' },
          { taskId: 'bg_task_c', taskType: 'local_agent', message: 'Synthesize：汇总结果' },
        ];
        io.emit('agent:event', {
          seq: 50, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetInstanceId, ts: Date.now(),
          type: 'task_progress', transient: true,
          payload: { taskId: tasks[0].taskId, taskType: tasks[0].taskType, message: tasks[0].message, tasks }
        });
        await delay(2000);
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 51, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetInstanceId, ts: Date.now(),
          type: 'task_notification', payload: { source: 'system', status: 'completed', summary: '全部后台任务完成', tasks: [] }
        });
        socket.emit('agent:event', {
          seq: 100, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_bgtask_multi', durationMs: 2000, costUsd: 0.001, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:exitplan',
      run: async ({ activeInst }) => {
        // Regression TC-15: approving ExitPlanMode should fall permission mode back to default.
        console.log('[mock] test:exitplan — plan 模式 + ExitPlanMode 审批');
        activeInst.permissionMode = 'plan';
        activeInst.state = 'permission';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, instanceId: viewingInstanceId, ts: Date.now(),
          type: 'permission_mode', payload: { mode: 'plan' }
        });
        pendingPermission = {
          requestId: 'req_exit_plan', toolUseId: 't_exit_plan', messageId: 'msg_exitplan_1',
          name: 'ExitPlanMode', input: '## 计划\n1. 实现 X\n2. 测试 Y', cwd: activeInst.cwd,
          setMode: 'default'
        };
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: pendingPermission.toolUseId, name: pendingPermission.name, inputSummary: pendingPermission.input }
        });
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'permission_request', payload: { requestId: pendingPermission.requestId, name: pendingPermission.name, input: pendingPermission.input, cwd: pendingPermission.cwd }
        });
      },
    },
    {
      command: 'test:freshbusy',
      run: async ({ requestedModel }) => {
        // 回归（shouldRestoreOptimisticBusy）：新会话首发的乐观 busy 不应被「懒开 → 广播 instances →
        // 前端 bindView→clearView(setBusy(false))」冲掉。前置 session:new 已使前端 viewingInstanceId=null
        // （空首页），故 send() 这条消息时置了 _pendingFirstSend。
        console.log('[mock] test:freshbusy — 模拟新会话首发懒开');
        await delay(150);
        // 懒开：新建 FRESH 实例（sessionId=null，区别于 resume），切 viewing 并广播 instances
        // —— 这一步触发前端 bindView→clearView 的 setBusy(false)，是 bug 现场。
        const freshInst = openFreshMockInstance(requestedModel);
        const freshId = freshInst.instanceId;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: mockInstances[0].cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        // 关键窗口：模拟 SDK 启动慢，此后约 1.1s 不发任何 delta。E2E 在此窗口断言 pill 仍可见
        // （修复前已被 clearView 冲掉 → fail；修复后由 setInstances 补回 → pass）。
        await delay(1100);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: null, instanceId: freshId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_fresh_1', text: '新会话首发回复。' }
        });
        await delay(100);
        const fInst = mockInstances.find(i => i.instanceId === freshId);
        if (fInst) fInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: mockInstances[0].cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        socket.emit('agent:event', {
          seq: 100, epoch: activeEpoch, sessionId: null, instanceId: freshId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_fresh_1', durationMs: 1300, costUsd: 0.001, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:queuefull',
      run: async ({ activeInst }) => {
        console.log('[mock] Simulating full foreground turn queue');
        activeInst.state = 'busy';
        activeInst.queueFull = true;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Foreground turn queue is full; hold the draft until the active task drains.' }
        });

        await delay(1200);
        activeInst.queueFull = false;
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_queue_full_1', durationMs: 1200, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:foreground-sync-replay',
      run: async ({ activeInst }) => {
        console.log('[mock] Completing current turn, then arming duplicate foreground sync replay');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        await delay(100);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_foreground_sync_1', text: 'Foreground sync baseline response.' }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_foreground_sync_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
        foregroundSyncReplayMode = true;
      },
    },
    {
      command: 'test:foreground-found-missing',
      run: async ({ activeInst }) => {
        console.log('[mock] Completing current turn, then arming foreground sync found=false history reload');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        await delay(100);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_foreground_found_missing_1', text: 'Stale foreground instance response.' }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_foreground_found_missing_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
        await delay(350);
        foregroundFoundMissingMode = true;
        foregroundFoundMissingHistoryMode = true;
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Foreground found=false fixture armed.' }
        });
      },
    },
    {
      command: 'test:background-done',
      run: async ({ activeInst }) => {
        console.log('[mock] Marking background workspace as done');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'done',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        const bgInst = mockInstances.find(i => i.instanceId === 'inst_2');
        if (bgInst) bgInst.state = 'done';
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: activeInst.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Background workspace finished and is ready to review.' }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_background_done_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:background-error',
      run: async ({ activeInst }) => {
        console.log('[mock] Marking background workspace as error');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'error',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        const bgInst = mockInstances.find(i => i.instanceId === 'inst_2');
        if (bgInst) bgInst.state = 'error';
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: activeInst.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_background_error_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:background-priority',
      run: async ({ activeInst }) => {
        console.log('[mock] Marking one background workspace with mixed states');
        const backgroundCwd = '/Users/you/code/another-react-project';
        const ensureInstance = ({ instanceId, sessionId, title, state, activeTool }) => {
          let inst = mockInstances.find(i => i.instanceId === instanceId);
          if (!inst) {
            inst = {
              instanceId,
              cwd: backgroundCwd,
              sessionId,
              title,
              state,
              activeTool,
              permissionMode: 'plan',
              effort: 'medium',
              model: 'claude-3-5-haiku'
            };
            mockInstances.push(inst);
          }
          Object.assign(inst, { cwd: backgroundCwd, sessionId, title, state, activeTool });
        };
        ensureInstance({
          instanceId: 'inst_2',
          sessionId: 'mock-session-another-done',
          title: 'Background Done Result',
          state: 'done',
          activeTool: null
        });
        ensureInstance({
          instanceId: 'inst_3',
          sessionId: 'mock-session-another-running',
          title: 'Background Task Running',
          state: 'busy',
          activeTool: 'Task'
        });
        ensureInstance({
          instanceId: 'inst_4',
          sessionId: 'mock-session-another-permission',
          title: 'Background Needs Approval',
          state: 'permission',
          activeTool: 'Bash'
        });
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: activeInst.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_background_priority_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:background-taskprogress',
      run: async ({ activeInst }) => {
        console.log('[mock] Emitting background task_progress without changing current view');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'busy',
            activeTool: 'Task',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        const bgInst = mockInstances.find(i => i.instanceId === 'inst_2');
        if (bgInst) {
          bgInst.state = 'busy';
          bgInst.activeTool = 'Task';
        }
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: activeInst.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        await delay(200);
        io.emit('agent:event', {
          seq: 50, epoch: activeEpoch, sessionId: 'mock-session-another', instanceId: 'inst_2', ts: Date.now(),
          type: 'task_progress',
          transient: true,
          payload: {
            taskId: 'bg_foreign_task_1',
            taskType: 'local_agent',
            message: '另一个工作区正在运行后台任务：步骤 1/2'
          }
        });
        await delay(150);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_background_taskprogress_1', durationMs: 350, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:history-overflow',
      run: async () => {
        console.log('[mock] test:history-overflow — session:list 默认截断，显示全部后返回较早历史');
        historyOverflowMode = true;
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Session history overflow fixture enabled.' }
        });
        await delay(100);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_history_overflow_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      // P3 抽屉局部重建 + SWR 保鲜回归夹具①：断线重连但数据"零变化"——验证 sessionsCache 不被清空、
      // openSessionPanel/rebuildDirSections 不做无意义的整段重建：抽屉已展开的目录 DOM 节点应原样
      // 保留（不出现骨架屏闪现）。先同 test:tab 补一个第二工作区，覆盖"多目录场景下都不受扰动"。
      command: 'test:reconnect-drawer-quiet',
      run: async () => {
        console.log('[mock] test:reconnect-drawer-quiet — 断线重连但数据零变化，验证抽屉 DOM 不被无谓重建');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'idle',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        // 尽快结束这一轮（result），不留悬空 busy 态干扰后续断线重连观测。
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_reconnect_quiet_1', durationMs: 50, costUsd: 0, isError: false, models: [activeModel] }
        });
        // 给 E2E 测试留足时间在断线前展开两个目录、等 session:list 落地、给行元素打标记——这个窗口
        // 必须显著大于"展开目录→发 session:list→收到 ack"这段路径可能耗费的真实时间，否则断线可能
        // 卡在某个目录的 session:list 请求已发出但 ack 还没收到的节点上：那次 ack 永远丢失（socket.io
        // 断线中的 ack 不会重投），该目录就会一直卡在骨架屏，直到用户手动折叠再展开——2.5s 留足冗余。
        await delay(2500);
        reconnectSettleMarkerArmed = true;
        setTimeout(() => socket.disconnect(true), 50);
      },
    },
    {
      // P3 抽屉局部重建 + SWR 保鲜回归夹具②：断线期间主工作区会话"真的"被改名（模拟自主续跑产出新
      // 标题），reconnect 后验证：① 抽屉确实显示新标题（不是缓存钝化的旧内容）；② 未涉及的其它工作区
      // 目录 DOM 不被连坐重建（按目录分键 diff 只重建真正变化的那一个目录）。
      command: 'test:reconnect-drawer-refresh',
      run: async () => {
        console.log('[mock] test:reconnect-drawer-refresh — 断线期间改主工作区标题，reconnect 后核对局部刷新');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'idle',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        // 尽快结束这一轮（result），不留悬空 busy 态干扰后续断线重连观测。
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_reconnect_refresh_1', durationMs: 50, costUsd: 0, isError: false, models: [activeModel] }
        });
        // 同 test:reconnect-drawer-quiet：2.5s 冗余窗口，避免断线卡在某个目录的 session:list 请求
        // 已发出但 ack 还没收到的节点上。
        await delay(2500);
        reconnectDrawerTitleChanged = true;
        const mainInst = mockInstances.find(i => i.instanceId === 'inst_1');
        if (mainInst) mainInst.title = 'Renamed After Reconnect';
        reconnectSettleMarkerArmed = true;
        setTimeout(() => socket.disconnect(true), 50);
      },
    },
    {
      command: 'test:tab',
      run: async () => {
        console.log('[mock] Simulating multiple tab concurrency');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'idle',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }

        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Concurrency Mode Triggered! A second workspace tab "Another App Concurrency" is now live. Try clicking the tabs at the top!' }
        });

        await delay(500);

        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { text: 'Concurrency Mode Triggered! A second workspace tab is now live.' }
        });
      },
    },
    {
      command: 'test:tab-model-effort',
      run: async () => {
        console.log('[mock] Simulating tab switch with model and effort state');
        const existingInst2 = mockInstances.find(i => i.instanceId === 'inst_2');
        const modelEffortInst = {
          instanceId: 'inst_2',
          cwd: '/Users/you/code/another-react-project',
          sessionId: 'mock-session-another',
          title: 'Another App Concurrency',
          state: 'idle',
          permissionMode: 'plan',
          effort: 'high',
          model: 'claude-3-opus[1m]'
        };
        if (existingInst2) Object.assign(existingInst2, modelEffortInst);
        else mockInstances.push(modelEffortInst);

        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Model and effort switch fixture ready.' }
        });
        await delay(100);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_tab_model_effort_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      // 回归：切走再切回一个「后端在跑但正处静默窗口（无 delta/result）」的会话，运行条应重新出现。
      // inst_2 置 state='busy'，其 sync:since 走 busySilentSwitchMode 只回放 user_message（触发 reload、不发 result）。
      command: 'test:busy-silent-switch',
      run: async () => {
        console.log('[mock] test:busy-silent-switch — inst_2 busy 静默窗口，验证切回后运行条重种');
        busySilentSwitchMode = true;
        const busyInst = {
          instanceId: 'inst_2',
          cwd: '/Users/you/code/another-react-project',
          sessionId: 'mock-session-another',
          title: 'Another App Concurrency',
          state: 'busy',
          bgActive: false,
          permissionMode: 'default',
          effort: null,
          model: 'claude-3-5-haiku'
        };
        const existing = mockInstances.find(i => i.instanceId === 'inst_2');
        if (existing) Object.assign(existing, busyInst); else mockInstances.push(busyInst);

        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        // 当前视图（inst_1）收尾 → waitForIdle 可用；inst_2 的 busy 只体现在 instances.state。
        await delay(100);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_busy_silent_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:close-current-pending',
      run: async () => {
        console.log('[mock] test:close-current-pending — 当前 inst_1 待审批，同时保留 inst_2 作为关闭后的回退会话');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'idle',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        viewingInstanceId = 'inst_1';
        const inst1 = mockInstances.find(i => i.instanceId === 'inst_1');
        inst1.state = 'permission';
        inst1.activeTool = 'Bash';
        pendingPermission = {
          instanceId: 'inst_1',
          requestId: 'req_close_current_pending',
          toolUseId: 't_close_current_pending',
          messageId: 'msg_close_current_pending_1',
          name: 'run_command',
          input: 'git push origin main',
          cwd: inst1.cwd
        };
        syncPendingSnapshot = {
          permissions: [{
            requestId: pendingPermission.requestId,
            name: pendingPermission.name,
            input: pendingPermission.input,
            cwd: pendingPermission.cwd
          }],
          questions: []
        };
        syncPendingSnapshotInstanceId = 'inst_1';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: inst1.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Close current pending source session before approving anything.' }
        });
      },
    },
    {
      command: 'test:late-closed-current-events',
      run: async () => {
        console.log('[mock] test:late-closed-current-events — 关闭当前 inst_1 后继续发旧实例迟到事件');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'idle',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        viewingInstanceId = 'inst_1';
        const inst1 = mockInstances.find(i => i.instanceId === 'inst_1');
        inst1.state = 'permission';
        inst1.activeTool = 'Bash';
        pendingPermission = {
          instanceId: 'inst_1',
          requestId: 'req_close_current_late',
          toolUseId: 't_close_current_late',
          messageId: 'msg_close_current_late_1',
          name: 'run_command',
          input: 'git push origin main',
          cwd: inst1.cwd
        };
        syncPendingSnapshot = {
          permissions: [{
            requestId: pendingPermission.requestId,
            name: pendingPermission.name,
            input: pendingPermission.input,
            cwd: pendingPermission.cwd
          }],
          questions: []
        };
        syncPendingSnapshotInstanceId = 'inst_1';
        lateClosedSessionEventsInstanceId = 'inst_1';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: inst1.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Close current stale source session before late events arrive.' }
        });
      },
    },
    {
      command: 'test:permCrossTab',
      run: async () => {
        // 跨 tab 审批清弹窗回归（坐实诊断「安全」结论的前端支柱）：viewing=inst_1 弹审批，
        // 同时备好后台 inst_2（不切）。配 test:switchAway 切走 → 前端 bindView→clearView 应清弹窗。
        console.log('[mock] test:permCrossTab — inst_1 弹审批 + 备好后台 inst_2');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2', cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another', title: 'Another App Concurrency',
            state: 'busy', permissionMode: 'plan', effort: 'medium', model: 'claude-3-5-haiku'
          });
        }
        viewingInstanceId = 'inst_1';
        const inst1ct = mockInstances.find(i => i.instanceId === 'inst_1');
        inst1ct.state = 'permission';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: inst1ct.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        pendingPermission = { requestId: 'req_perm_cross_tab', toolUseId: 't_cross', messageId: 'msg_cross_1', name: 'run_command', input: 'git push origin main', cwd: inst1ct.cwd };
        syncPendingSnapshot = {
          permissions: [{ requestId: pendingPermission.requestId, name: pendingPermission.name, input: pendingPermission.input, cwd: pendingPermission.cwd }],
          questions: []
        };
        syncPendingSnapshotInstanceId = 'inst_1';
        // 独立 epoch：前端见新 epoch 即重置 seq 去重基线，避免被前序 TC 累积的 lastSeq 误吞
        socket.emit('agent:event', {
          seq: 1, epoch: 'mock-epoch-crosstab', sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'permission_request', payload: { requestId: pendingPermission.requestId, name: pendingPermission.name, input: pendingPermission.input, cwd: pendingPermission.cwd }
        });

        // 弹窗渲染后自动「切到 inst_2」（viewing 变化）→ 前端 bindView → clearView 应清掉 inst_1 的审批弹窗。
        // 内部自动切，避免 runner 在弹窗打开时再走 input+btnSend——那样点击坐标会穿透到 sheet 上的审批按钮、误发回答。
        await delay(1500);
        viewingInstanceId = 'inst_2';
        const inst2ct = mockInstances.find(i => i.instanceId === 'inst_2');
        console.log('[mock] test:permCrossTab — 自动切 viewing → inst_2（应触发前端 clearView 清弹窗）');
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: inst2ct.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      command: 'test:questionCrossTab',
      run: async () => {
        console.log('[mock] test:questionCrossTab — inst_1 弹 AskUserQuestion + 自动切 viewing → inst_2');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2', cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another', title: 'Another App Concurrency',
            state: 'busy', permissionMode: 'plan', effort: 'medium', model: 'claude-3-5-haiku'
          });
        }
        viewingInstanceId = 'inst_1';
        const inst1ct = mockInstances.find(i => i.instanceId === 'inst_1');
        inst1ct.state = 'permission';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: inst1ct.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        pendingQuestion = {
          requestId: 'req_question_cross_tab#0',
          toolUseId: 't_question_cross_tab',
          messageId: 'msg_question_cross_tab_1',
          options: ['main (Stable Production)', 'dev (Bleeding-Edge Integration)', 'release-v1.0 (LTS)']
        };
        const questionText = 'We are ready to tag and deploy this mobile dashboard app. Which branch should be our target publish destination?';
        syncPendingSnapshot = {
          permissions: [],
          questions: [{
            requestId: pendingQuestion.requestId,
            text: questionText,
            options: pendingQuestion.options
          }]
        };
        syncPendingSnapshotInstanceId = 'inst_1';
        socket.emit('agent:event', {
          seq: 1, epoch: 'mock-epoch-question-crosstab', sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: pendingQuestion.toolUseId, name: 'AskUserQuestion', inputSummary: 'Choose a publish channel' }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: 'mock-epoch-question-crosstab', sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'question', payload: {
            requestId: pendingQuestion.requestId,
            text: questionText,
            options: pendingQuestion.options
          }
        });
        await delay(1500);
        viewingInstanceId = 'inst_2';
        const inst2ct = mockInstances.find(i => i.instanceId === 'inst_2');
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: inst2ct.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      command: 'test:close-background-question-pending',
      run: async () => {
        console.log('[mock] test:close-background-question-pending — 后台 inst_1 保留待答问题，当前查看 inst_2');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'idle',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        const inst1 = mockInstances.find(i => i.instanceId === 'inst_1');
        inst1.state = 'permission';
        inst1.activeTool = 'AskUserQuestion';
        pendingQuestion = {
          instanceId: 'inst_1',
          requestId: 'req_close_background_question#0',
          toolUseId: 't_close_background_question',
          messageId: 'msg_close_background_question_1',
          options: ['main (Stable Production)', 'dev (Bleeding-Edge Integration)', 'release-v1.0 (LTS)']
        };
        const backgroundQuestionText = 'Which branch should be our target publish destination?';
        syncPendingSnapshot = {
          permissions: [],
          questions: [{
            requestId: pendingQuestion.requestId,
            text: backgroundQuestionText,
            options: pendingQuestion.options
          }]
        };
        syncPendingSnapshotInstanceId = 'inst_1';
        viewingInstanceId = 'inst_2';
        const inst2 = mockInstances.find(i => i.instanceId === 'inst_2');
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: inst2.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
      },
    },
    {
      command: 'test:late-closed-session-events',
      run: async () => {
        console.log('[mock] test:late-closed-session-events — 关闭后台 inst_1 后继续发旧实例迟到事件');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'idle',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        const inst1 = mockInstances.find(i => i.instanceId === 'inst_1');
        inst1.state = 'permission';
        inst1.activeTool = 'Bash';
        pendingPermission = {
          instanceId: 'inst_1',
          requestId: 'req_close_background_late',
          toolUseId: 't_close_background_late',
          messageId: 'msg_close_background_late_1',
          name: 'run_command',
          input: 'git push origin main',
          cwd: inst1.cwd
        };
        syncPendingSnapshot = {
          permissions: [{
            requestId: pendingPermission.requestId,
            name: pendingPermission.name,
            input: pendingPermission.input,
            cwd: pendingPermission.cwd
          }],
          questions: []
        };
        syncPendingSnapshotInstanceId = 'inst_1';
        lateClosedSessionEventsInstanceId = 'inst_1';
        viewingInstanceId = 'inst_2';
        const inst2 = mockInstances.find(i => i.instanceId === 'inst_2');
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId,
            viewingCwd: inst2.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
      },
    },
    {
      command: 'test:empty',
      run: async () => {
        console.log('[mock] Reset to empty start screen state');
        // Clear instances and set viewingInstanceId to null
        mockInstances.length = 0;
        viewingInstanceId = null;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: {
            viewingInstanceId: null,
            viewingCwd: '/Users/you/code/claude-chat-mobile',
            dirs: ['/Users/you/code/claude-chat-mobile'],
            instances: [],
            defaultPermissionMode: 'default',
            defaultEffort: null
          }
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: null, instanceId: null, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Empty start screen activated' }
        });
        await delay(300);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: null, ts: Date.now(),
          type: 'result', payload: { text: 'Empty start screen activated' }
        });
      },
    },
    {
      command: 'test:restore',
      run: async () => {
        console.log('[mock] Restoring normal chat state from empty');
        if (mockInstances.length === 0) {
          mockInstances.push({
            instanceId: 'inst_1',
            cwd: '/Users/you/code/claude-chat-mobile',
            sessionId: 'mock-session-visual-test',
            title: 'Visual Sandbox (Main)',
            state: 'idle',
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-sonnet'
          });
          viewingInstanceId = 'inst_1';
        }
        emitHydration();
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Chat state restored' }
        });
        await delay(300);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { text: 'Chat state restored' }
        });
      },
    },
    {
      command: 'test:devicerequests',
      run: async ({ activeInst }) => {
        console.log('[mock] Emitting pending device requests with busy cycle');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        await delay(200);

        pendingDevices = createPendingDeviceRequests();
        emitPendingDevices();
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] 2 pending devices emitted for visual testing' }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        await delay(300);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { text: 'Device requests emitted' }
        });
      },
    },
    {
      commands: ['test:tofu', 'test:tofu-denied'],
      run: async ({ cmd }) => {
        console.log('[mock] Forcing unapproved TOFU status');
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'device_status', payload: { status: 'pending', deviceId: 'unauthorized-fingerprint-999' }
        });

        if (cmd === 'test:tofu-denied') {
          await delay(500);
          deniedDeviceRetryPending = true;
          socket.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'device_status', payload: { status: 'denied', deviceId: 'unauthorized-fingerprint-999' }
          });
          setTimeout(() => socket.disconnect(true), 50);
          return;
        }

        // Set timeout to auto-approve and restore state after 8 seconds
        setTimeout(() => {
          console.log('[mock] Auto-approving TOFU screen to return to chat state');
          socket.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'device_status', payload: { status: 'approved', deviceId: 'unauthorized-fingerprint-999' }
          });
          emitHydration();
        }, 8000);
      },
    },
    {
      command: 'test:tofu-delayed',
      run: async () => {
        console.log('[mock] Delaying unapproved TOFU status so the UI can hold a draft');
        await delay(600);
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'device_status', payload: { status: 'pending', deviceId: 'unauthorized-fingerprint-999' }
        });

        setTimeout(() => {
          console.log('[mock] Auto-approving delayed TOFU screen to return to chat state');
          socket.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'device_status', payload: { status: 'approved', deviceId: 'unauthorized-fingerprint-999' }
          });
          emitHydration();
          socket.emit('agent:event', {
            seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'result', payload: { messageId: 'msg_tofu_delayed_1', durationMs: 1200, costUsd: 0, isError: false, models: [activeModel] }
          });
        }, 1200);
      },
    },
    {
      command: 'test:tofu-denied-delayed',
      run: async () => {
        console.log('[mock] Delaying TOFU denial so the UI can hold a draft through pending and denied states');
        await delay(600);
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'device_status', payload: { status: 'pending', deviceId: 'unauthorized-fingerprint-999' }
        });

        await delay(900);
        deniedDeviceRetryPending = true;
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'device_status', payload: { status: 'denied', deviceId: 'unauthorized-fingerprint-999' }
        });
        setTimeout(() => socket.disconnect(true), 50);
      },
    },
  ]);

  // Handle custom trigger command inputs
  socket.on('user:message', async (payload, ack) => {
    // REL-01：真实 server.js 现支持 ack（离线重发路径用 socket.timeout().emit(...,ack)）；
    // mock 本就是"总是成功"语义，无需等分支处理完才 ack，此处立即回，避免离线重发场景在 mock 下永远超时。
    if (typeof ack === 'function') ack({ ok: true });
    const messagePayload = payload && typeof payload === 'object' ? payload : {};
    const text = typeof payload === 'string' ? payload : messagePayload.text;
    const requestedModel = typeof messagePayload.model === 'string' ? messagePayload.model : '';
    const attachments = Array.isArray(messagePayload.attachments)
      ? messagePayload.attachments.map(a => ({
        name: a?.name,
        mimeType: a?.mimeType,
        size: a?.size,
        thumb: a?.thumb
      }))
      : undefined;
    if (typeof text !== 'string') return;
    const cmd = text.trim();

    console.log(`[mock] User message received: "${cmd}"`);

    // 回归（全新会话首轮点停止后不跳回主页）：test:fresh-interrupt 需要在【回显用户消息之前】就已
    // 存在懒开的 FRESH 实例（sessionId=null，对齐真实 server 未见 SDK init 的窗口）——否则本函数下方
    // "Always echo"会先用 viewingInstanceId=null 广播 user_message，随后才广播的 instances 触发前端
    // bindView→clearView 会把刚回显的气泡一并清空。真实 server 的时序是反过来的：懒开先 broadcastInstances()
    // 后才 a.send()（才 emit user_message）——此处提前创建，让回显自然带上正确的 instanceId，对齐真实时序。
    if (cmd === 'test:fresh-interrupt' && viewingInstanceId === null) {
      console.log('[mock] test:fresh-interrupt — 模拟新会话首发、sessionId 未到即可能被点停止');
      openFreshMockInstance(requestedModel);
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { viewingInstanceId, viewingCwd: mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });
    }

    // Always echo user message back
    // 排队语义镜像真实 server：busy 期间发的消息 queued:true + 透传 clientMessageId（撤回按它定位）
    const echoInst = mockInstances.find(i => i.instanceId === viewingInstanceId);
    const echoQueued = echoInst?.state === 'busy';
    const echoClientMessageId = typeof messagePayload.clientMessageId === 'string' ? messagePayload.clientMessageId : undefined;
    if (echoQueued && echoClientMessageId) queuedEchoItems.set(echoClientMessageId, { text: cmd });
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
      type: 'user_message', payload: {
        text: cmd, attachments, queued: echoQueued,
        ...(echoClientMessageId ? { clientMessageId: echoClientMessageId } : {})
      }
    });

    if (cmd.startsWith('ultracode ')) {
      activeEpoch = 'mock-epoch-ultracode-' + Date.now();
      const activeInst = mockInstances.find(i => i.instanceId === viewingInstanceId);
      if (!activeInst) return;
      // 部分回归场景刻意在已武装 ultracode 时验证其它状态；先让显式 registry 命令接管，
      // 普通 ultracode prompt 再走下方通用 mock 回复。
      if (await scenarioRegistry.run(cmd, { activeInst, requestedModel })) return;
      activeInst.state = 'busy';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });

      await delay(150);
      socket.emit('agent:event', {
        seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'text_delta', payload: { messageId: 'msg_ultracode_1', text: `ultracode mock response for: ${cmd}` }
      });

      activeInst.state = 'idle';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });
      socket.emit('agent:event', {
        seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'result', payload: { messageId: 'msg_ultracode_1', durationMs: 150, costUsd: 0, isError: false, models: [activeModel] }
      });
      return;
    }

    // Intercept test commands
    if (cmd.startsWith('test:')) {
      activeEpoch = 'mock-epoch-' + cmd.replace(/[^a-zA-Z0-9]/g, '_') + '-' + Date.now();
      const activeInst = mockInstances.find(i => i.instanceId === viewingInstanceId);
      if (activeInst) activeInst.aborted = false; // WS-008：新场景开始，清 abort 标志（interrupt 会置 true 令流式循环提前退出）

      if (await scenarioRegistry.run(cmd, { activeInst, requestedModel })) return;
    }
  });

  // Handle user permission decision
  socket.on('user:approve', async payload => {
    const { requestId, decision, alwaysThisSession, instanceId, exitMode } = payload || {};
    console.log(`[mock] User approve received: requestId=${requestId}, decision=${decision}, always=${alwaysThisSession}${exitMode ? `, exitMode=${exitMode}` : ''}`);

    if (pendingPermission && pendingPermission.requestId === requestId) {
      const activeInst = mockInstances.find(i => i.instanceId === (instanceId || viewingInstanceId));
      activeInst.state = 'busy';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });

      // Broadcast resolved
      io.emit('agent:event', {
        seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'request_resolved', payload: { requestId, kind: 'permission', outcome: decision }
      });

      if (decision === 'allow') {
        if (alwaysThisSession && pendingPermission.name) {
          const targetInstanceId = activeInst.instanceId;
          if (!alwaysAllowedPermissionNamesByInstance.has(targetInstanceId)) {
            alwaysAllowedPermissionNamesByInstance.set(targetInstanceId, new Set());
          }
          alwaysAllowedPermissionNamesByInstance.get(targetInstanceId).add(pendingPermission.name);
        }
        // 对齐 CLI plan-exit：ExitPlanMode 批准时优先用客户端 exitMode，否则用场景预设 setMode
        const EXIT_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions']);
        const resolvedMode = (pendingPermission.name === 'ExitPlanMode' && EXIT_MODES.has(exitMode))
          ? exitMode
          : pendingPermission.setMode;
        if (resolvedMode) {
          const inst = mockInstances.find(i => i.instanceId === viewingInstanceId);
          if (inst) inst.permissionMode = resolvedMode;
          io.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, instanceId: viewingInstanceId, ts: Date.now(),
            type: 'permission_mode', payload: { mode: resolvedMode }
          });
        }
        socket.emit('agent:event', {
          seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: pendingPermission.toolUseId, ok: true, outputSummary: pendingPermission.approveOutput || 'git push success: branch main -> origin' }
        });
        socket.emit('agent:event', {
          seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: pendingPermission.messageId, text: pendingPermission.approveText || '\n\n✓ Successfully pushed latest codebase additions!' }
        });
      } else {
        socket.emit('agent:event', {
          seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: pendingPermission.toolUseId, ok: false, outputSummary: 'user denied command execution', denyKind: 'denied' }
        });
        socket.emit('agent:event', {
          seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: pendingPermission.messageId, text: '\n\n🚫 Git push command was rejected by user. Aborted.' }
        });
      }

      await delay(500);
      activeInst.state = 'idle';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });

      socket.emit('agent:event', {
        seq: 7, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'result', payload: { messageId: pendingPermission.messageId, durationMs: 1200, costUsd: 0.001, isError: false, models: [activeModel] }
      });

      pendingPermission = null;
      syncPendingSnapshot = null;
      syncPendingSnapshotInstanceId = null;
    }
  });

  // 工具全文展开（对齐 server tool:full）：mock 对已知 toolUseId 返回全文
  socket.on('tool:full', ({ toolUseId } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (toolUseId === 't_bash') {
      return ack({ ok: true, text: '✓ All 5 visual regression unit tests passed successfully!\n(extra full lines from tool:full mock)' });
    }
    if (toolUseId === 't_trunc') {
      return ack({ ok: true, text: 'FULL_TOOL_OUTPUT_LINE\n'.repeat(40).trim() });
    }
    ack({ ok: false, error: '全文不可用（mock 未缓存）' });
  });

  // P0-DIFF：工具卡「预览变更」（对齐 server tool:preview）。t_fc_edit/t_fc_write 复用
  // test:file-changes 场景（scenarios/content.js）建的工具卡——点其「预览变更」按钮即可触发。
  socket.on('tool:preview', ({ toolUseId } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (toolUseId === 't_fc_edit') {
      // 三行片段只中间一行变：验证前后保留上下文行、只中间 -/+ 各一行（行级 diff，非整块红绿）。
      return ack({
        ok: true,
        name: 'Edit',
        inWhitelist: true,
        attribution: { workdirLabel: 'claude-chat-mobile', relPath: 'README.md' },
        diff: { hunks: [{ old: 'line one\nold middle\nline three', new: 'line one\nnew middle\nline three' }] },
      });
    }
    if (toolUseId === 't_fc_write') {
      // Write 无 old：维持既有整块绿（不走行级 diff）。
      return ack({
        ok: true,
        name: 'Write',
        inWhitelist: true,
        attribution: { workdirLabel: 'claude-chat-mobile', relPath: 'CLAUDE.md' },
        diff: { added: 'line1\nline2\nline3' },
      });
    }
    ack({ ok: false, error: '预览不可用（mock 未缓存）' });
  });

  // Handle user question choice selection (optionIndex / optionIndexes / freeText)
  socket.on('user:answer', async payload => {
    const { requestId, optionIndex, optionIndexes, freeText, instanceId } = payload || {};
    console.log(`[mock] User answer received: requestId=${requestId}, choice=${optionIndex}, multi=${Array.isArray(optionIndexes) ? optionIndexes.join(',') : ''}, freeText=${freeText ? '[set]' : ''}`);

    if (pendingQuestion && pendingQuestion.requestId === requestId) {
      const activeInst = mockInstances.find(i => i.instanceId === (instanceId || viewingInstanceId));
      activeInst.state = 'busy';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });

      const free = typeof freeText === 'string' ? freeText.trim() : '';
      let selectedOption;
      let outcome;
      if (free) {
        selectedOption = free;
        outcome = `other: ${free}`;
      } else if (Array.isArray(optionIndexes) && optionIndexes.length) {
        const labels = optionIndexes.map(i => {
          const o = pendingQuestion.options[i];
          return (o && typeof o === 'object') ? (o.label || '') : o;
        }).filter(Boolean);
        selectedOption = labels.join('、');
        outcome = `options ${optionIndexes.join(',')}`;
      } else {
        const o = pendingQuestion.options[optionIndex];
        selectedOption = (o && typeof o === 'object') ? (o.label || o) : o;
        outcome = `option ${optionIndex}`;
      }

      // Broadcast resolved
      io.emit('agent:event', {
        seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'request_resolved', payload: { requestId, kind: 'question', outcome }
      });

      socket.emit('agent:event', {
        seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'tool_result', payload: { toolUseId: pendingQuestion.toolUseId, ok: true, outputSummary: `User selected: ${selectedOption}`, denyKind: 'answered' }
      });

      socket.emit('agent:event', {
        seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'text_delta', payload: {
          messageId: pendingQuestion.messageId,
          text: pendingQuestion.answerText
            ? pendingQuestion.answerText.replace('{option}', selectedOption)
            : `\n\nUnderstood. We will target the **${selectedOption}** branch. Beginning compilation...`
        }
      });

      await delay(800);
      activeInst.state = 'idle';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });

      socket.emit('agent:event', {
        seq: 7, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'result', payload: { messageId: pendingQuestion.messageId, durationMs: 1800, costUsd: 0.0018, isError: false, models: [activeModel] }
      });

      pendingQuestion = null;
    }
  });

  socket.on('user:approveDevice', payload => {
    const { deviceId } = payload || {};
    pendingDevices = pendingDevices.filter(d => d.deviceId !== deviceId);
    emitPendingDevices();
  });

  socket.on('user:denyDevice', payload => {
    const { deviceId } = payload || {};
    pendingDevices = pendingDevices.filter(d => d.deviceId !== deviceId);
    emitPendingDevices();
  });

  // 后台任务停止（对齐 server task:stop → agent.stopTask）：mock 仅记日志，幂等
  socket.on('task:stop', payload => {
    console.log(`[mock] task:stop taskId=${payload?.taskId || ''} instanceId=${payload?.instanceId || viewingInstanceId}`);
  });

  // Handle user interrupt (stop button / question skip)
  // 真实 agent 里 interrupt → AbortSignal → handleQuestion abortHandler →
  // request_resolved(aborted) + denyKinds(cancelled) + 轮次收尾。mock 对齐这条链，
  // 否则「跳过此问题」只能发出 interrupt 却关不掉弹窗（前端故意不乐观关窗）。
  // 注意：agent:event 带 activeEpoch 时 seq 必须单调递增——前端 `ev.seq <= lastSeq` 会丢弃回退 seq，
  // 所以这里绝不能发 seq:0（question 已是 seq:3 时会把 resolved 整条滤掉）。
  // 撤回排队中的消息（镜像真 server user:cancelQueued：命中→ok+text+system queue_cancelled；未命中→负 ack）
  socket.on('user:cancelQueued', (payload, ack) => {
    const id = typeof payload?.clientMessageId === 'string' ? payload.clientMessageId : '';
    const item = queuedEchoItems.get(id);
    console.log(`[mock] User cancelQueued received: clientMessageId=${id}, hit=${Boolean(item)}`);
    if (!item) {
      if (typeof ack === 'function') ack({ ok: false, error: '该消息已开始处理，无法撤回' });
      return;
    }
    queuedEchoItems.delete(id);
    if (typeof ack === 'function') ack({ ok: true, text: item.text });
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
      type: 'system', payload: { message: '已撤回排队中的消息', kind: 'queue_cancelled', clientMessageId: id }
    });
  });

  socket.on('user:interrupt', payload => {
    const { instanceId } = payload || {};
    const targetId = instanceId || viewingInstanceId;
    console.log(`[mock] User interrupt received for instance ${targetId}`);
    const activeInst = mockInstances.find(i => i.instanceId === targetId);
    if (activeInst) {
      activeInst.aborted = true; // WS-008：令仍在跑的流式场景（如 test:stream-long）下个 delay 后提前退出，不再后台续发事件
      activeInst.state = 'idle';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });
    }
    // 镜像真 server：interrupt 连带丢弃 CLI 队列里的排队条 → queue_dropped（前端据此把气泡标「已随停止取消」）
    if (queuedEchoItems.size > 0) {
      const droppedIds = [...queuedEchoItems.keys()];
      queuedEchoItems.clear();
      socket.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: 'mock-session-visual-test', instanceId: targetId, ts: Date.now(),
        type: 'system', payload: { message: '排队中的消息已随停止取消', kind: 'queue_dropped', clientMessageIds: droppedIds }
      });
    }

    // 挂起的 AskUserQuestion：按真实 abort 路径关闭
    // 真实 agent 对每道题 emit request_resolved({ requestId: `${toolUseID}#${i}`, outcome:'aborted' })
    // ——requestId 用带 #i 的完整 id，前端 matchQ 直接相等命中；seq 接在 question(seq:3) 之后。
    if (pendingQuestion) {
      const q = pendingQuestion;
      const toolUseId = q.toolUseId || (typeof q.requestId === 'string' ? q.requestId.split('#')[0] : null);
      io.emit('agent:event', {
        seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetId, ts: Date.now(),
        type: 'request_resolved', payload: { requestId: q.requestId, kind: 'question', outcome: 'aborted' }
      });
      if (toolUseId) {
        socket.emit('agent:event', {
          seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId, ok: false, outputSummary: '问题已取消', denyKind: 'cancelled' }
        });
      }
      if (q.messageId) {
        socket.emit('agent:event', {
          seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetId, ts: Date.now(),
          type: 'result', payload: { messageId: q.messageId, durationMs: 200, costUsd: 0, isError: false, models: [activeModel] }
        });
      }
      pendingQuestion = null;
      syncPendingSnapshot = null;
      syncPendingSnapshotInstanceId = null;
    }

    // 挂起的权限审批：interrupt 同样应清掉（真实 agent dispose/interrupt 路径会 deny）
    if (pendingPermission) {
      io.emit('agent:event', {
        seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetId, ts: Date.now(),
        type: 'request_resolved', payload: { requestId: pendingPermission.requestId, kind: 'permission', outcome: 'denied' }
      });
      pendingPermission = null;
      syncPendingSnapshot = null;
      syncPendingSnapshotInstanceId = null;
    }

    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, instanceId: targetId, ts: Date.now(),
      type: 'system', payload: { message: '已中断', kind: 'interrupted' }
    });
  });

  socket.on('disconnect', () => {
    console.log(`[mock-conn] Socket disconnected: ${socket.id}`);
  });
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Antigravity Visual Mock Server is running on port ${PORT}`);
  console.log(`📍 Web UI URL: http://127.0.0.1:${PORT}`);
  console.log(`🛠️ To execute visual tests, open this URL in your browser!`);
  console.log(`======================================================\n`);
});
