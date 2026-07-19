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
let lateClosedSessionEventsInstanceId = null;
let historyOverflowMode = false;
let busySilentSwitchMode = false; // test:busy-silent-switch：inst_2 sync 只回放 user_message（触发 reload）、不发 result（模拟静默窗口）
const queuedEchoItems = new Map(); // busy 期回显为 queued 的消息 clientMessageId → {text}：user:cancelQueued 撤回 / interrupt 连带取消 都按它对账
let foregroundSyncReplayMode = false;
let foregroundFoundMissingMode = false;
let foregroundFoundMissingHistoryMode = false;
let pendingDevices = [];
let alwaysAllowedPermissionNamesByInstance = new Map();
let activeEpoch = 'mock-epoch-init';
let deniedDeviceRetryPending = false;
let mockSessionLogsByInstance = new Map();
// 服务状态面板：确定性 startedAt（mock 进程启动时刻）；deliveryFailure 由 test:service-delivery-failure 注入，
// rateLimitLockout/clientError（判定化告警）由 test:service-incidents 注入
const MOCK_SERVICE_STARTED_AT = Date.now();
let mockDeliveryFailure = null;
let mockRateLimitLockout = null;
let mockClientError = null;

function resetMockState() {
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
  lateClosedSessionEventsInstanceId = null;
  historyOverflowMode = false;
  busySilentSwitchMode = false;
  foregroundSyncReplayMode = false;
  foregroundFoundMissingMode = false;
  foregroundFoundMissingHistoryMode = false;
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
      title: 'Visual Sandbox (Main)',
      model: 'claude-3-5-sonnet',
      lastUsedAt: Date.now() - 10000,
      entrypoint: 'sdk-ts'
    },
    {
      id: 'mock-session-archived',
      title: 'Archived Planning Session',
      model: 'claude-3-5-sonnet',
      lastUsedAt: Date.now() - 600000,
      entrypoint: 'sdk-ts'
    },
    {
      id: 'mock-session-gap',
      title: 'Archived Gap Session',
      model: 'claude-3-5-sonnet',
      lastUsedAt: Date.now() - 750000,
      entrypoint: 'sdk-ts'
    },
    {
      id: 'mock-session-deleted',
      title: 'Deleted Remote Session',
      model: 'claude-3-5-sonnet',
      lastUsedAt: Date.now() - 900000,
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
        instances: mockInstances
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
          instances: mockInstances,
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
        instances: mockInstances,
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
          instances: mockInstances
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
          instances: mockInstances,
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
        instances: mockInstances,
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
        instances: mockInstances,
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
        instances: mockInstances
      }
    });
    if (typeof callback === 'function') callback({ ok: true, instanceId: archivedInst.instanceId, sessionId: archivedInst.sessionId });
  });

  socket.on('session:history', (payload, callback) => {
    const { sessionId, cwd } = payload || {};
    console.log(`[mock] session:history sessionId=${sessionId}, cwd=${cwd}`);
    if (typeof callback !== 'function') return;
    if (cwd === '/Users/you/code/claude-chat-mobile' && sessionId === 'mock-session-archived') {
      callback({
        messages: [
          { role: 'user', content: 'Summarize archived plan' },
          { role: 'assistant', content: 'Archived plan replay from session history.' }
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

  // E18 附件预览：browse:read（契约内事件；仅实现 base64 分片路径——文本浏览走真实 server 的集成面）。
  // 固定 fixture：.ccm-uploads/<storedName> 命中 MOCK_UPLOAD_FILES 才回内容，其余 ok:false（文件已删场景）。
  socket.on('browse:read', (payload, callback) => {
    if (typeof callback !== 'function') return;
    const { relPath, offset = 0, maxBytes = 256 * 1024, encoding } = payload || {};
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
      }, ...(mockSessionLogsByInstance.get(instanceId) || [])]
    });
  });

  // 连接 RTT 探活（与真 server 对齐）：立即 ack，不改业务状态
  socket.on('conn:ping', (_payload, ack) => {
    if (typeof ack === 'function') ack({ ok: true, t: Date.now() });
  });

  // 服务状态面板（与真 server service:status 契约对齐，判定化：不带裸计数器）：确定性 payload 供 E2E 断言；
  // deliveryFailure 由 test:service-delivery-failure 注入，rateLimitLockout/clientError 由 test:service-incidents 注入
  socket.on('service:status', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({
      ok: true,
      startedAt: MOCK_SERVICE_STARTED_AT,
      versions: { server: '1.2.1-mock', cli: '0.1.0-mock', sdk: '0.3.201-mock' },
      deliveryFailure: mockDeliveryFailure,
      rateLimitLockout: mockRateLimitLockout,
      clientError: mockClientError,
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
        callback({ ok: true, replayed, pending, ...extra });
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
            type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
            type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
            type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
            type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
            type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: freshInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: freshInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: mockInstances.find(i => i.instanceId === 'inst_2')?.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
            instances: mockInstances
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: inst?.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
            instances: mockInstances
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
            type: 'task_progress', transient: true, payload: { taskId: 'bg_task_1', taskType: 'local_agent', message }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: mockInstances[0].cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: mockInstances[0].cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        await delay(100);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_foreground_sync_1', text: 'Foreground sync baseline response.' }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        await delay(100);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_foreground_found_missing_1', text: 'Stale foreground instance response.' }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
            instances: mockInstances
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
            instances: mockInstances
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
            instances: mockInstances
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
            instances: mockInstances
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
            instances: mockInstances
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
            instances: mockInstances
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
            instances: mockInstances
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
            instances: mockInstances
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
            instances: mockInstances
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: inst1ct.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: inst2ct.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: inst1ct.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: inst2ct.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
            instances: mockInstances
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
            instances: mockInstances
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
      });

      await delay(150);
      socket.emit('agent:event', {
        seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'text_delta', payload: { messageId: 'msg_ultracode_1', text: `ultracode mock response for: ${cmd}` }
      });

      activeInst.state = 'idle';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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

  // Handle user question choice selection (optionIndex / optionIndexes / freeText)
  socket.on('user:answer', async payload => {
    const { requestId, optionIndex, optionIndexes, freeText, instanceId } = payload || {};
    console.log(`[mock] User answer received: requestId=${requestId}, choice=${optionIndex}, multi=${Array.isArray(optionIndexes) ? optionIndexes.join(',') : ''}, freeText=${freeText ? '[set]' : ''}`);

    if (pendingQuestion && pendingQuestion.requestId === requestId) {
      const activeInst = mockInstances.find(i => i.instanceId === (instanceId || viewingInstanceId));
      activeInst.state = 'busy';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
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
