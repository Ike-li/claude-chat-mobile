import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createVisualMockScenarioRegistry } from './visual-mock-scenarios.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3100;
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});
const REJECTED_AUTH_TOKENS = new Set(['bad-token', 'invalid-token', 'expired-token']);

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (REJECTED_AUTH_TOKENS.has(token)) {
    next(new Error('unauthorized'));
    return;
  }
  next();
});

// Calculate asset version finger-print to bypass caching (matching server.js)
const SELF_JS_DIR = join(HERE, '../public', 'js');
const SELF_JS_FILES = ['app.js', 'logic.js', 'tw-config.js', 'sw-cleanup.js'];
function computeAssetVersion() {
  const h = createHash('sha256');
  for (const f of SELF_JS_FILES) {
    try {
      h.update(readFileSync(join(SELF_JS_DIR, f)));
    } catch {
      // ignore
    }
  }
  return h.digest('hex').slice(0, 8);
}
const ASSET_VERSION = computeAssetVersion();

// Custom Express Routes
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get(['/', '/index.html'], (_req, res) => {
  try {
    const html = readFileSync(join(HERE, '../public/index.html'), 'utf8')
      .replace(/(\/js\/[\w-]+\.js)(?!\?)/g, `$1?v=${ASSET_VERSION}`)
      .replace('</head>', `<script>window.SERVER_CF_ACCESS_ENABLED = false;</script></head>`);
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(html);
  } catch (err) {
    res.status(500).send('index load error: ' + err.message);
  }
});

app.get('/js/app.js', (_req, res) => {
  try {
    const js = readFileSync(join(SELF_JS_DIR, 'app.js'), 'utf8')
      .replace(/from\s+['"]\.\/logic\.js['"]/g, `from './logic.js?v=${ASSET_VERSION}'`);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/javascript').send(js);
  } catch (err) {
    res.status(500).send('app.js load error: ' + err.message);
  }
});

app.use(express.static(join(HERE, '../public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    else if (filePath.startsWith(SELF_JS_DIR) && filePath.endsWith('.js')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

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
let syncPendingSnapshot = null; // Bug2：模拟真 server sync:since 的 ack.pending 快照（切入时重建待审批卡片）
let syncPendingSnapshotInstanceId = null;
let lateClosedSessionEventsInstanceId = null;
let historyOverflowMode = false;
let foregroundSyncReplayMode = false;
let foregroundFoundMissingMode = false;
let foregroundFoundMissingHistoryMode = false;
let pendingDevices = [];
let alwaysAllowedPermissionNamesByInstance = new Map();
let activeEpoch = 'mock-epoch-init';
let deniedDeviceRetryPending = false;
let mockSessionLogsByInstance = new Map();

function resetMockState() {
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
    } else {
      callback({ messages: [] });
    }
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
    {
      command: 'test:statusline',
      run: async () => {
        console.log('[mock] Updating status_line');
        const slNow = Date.now(); // ts 与 cacheExpiresAt 同基准：前端 ttlRemainMs = cacheExpiresAt − ts = 290s（稳定 ~4:50）
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: slNow,
          type: 'status_line', payload: {
            ts: slNow,
            model: 'claude-3-5-sonnet',
            project: 'claude-chat-mobile',
            cwd: '/Users/you/code/claude-chat-mobile',
            git: { branch: 'feature/visual-testing', changed: 3, ahead: 2, behind: 0, insertions: 120, deletions: 45, repo: 'Ike-li/claude-chat-mobile' },
            ctx: { tokens: 45000, cacheHitPct: 45, in: 2000, w: 22000, r: 21000, reused: 1200000, cacheExpiresAt: slNow + 290000 },
            cost: 0.37,
            duration: { wallMs: 2500, apiMs: 1200 },
            version: '2.1.178'
          }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Simulated Terminal StatusLine updated successfully above!' }
        });

        await delay(500);

        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { text: 'Simulated Terminal StatusLine updated successfully above!' }
        });
      },
    },
    {
      command: 'test:console-log-after-clear',
      run: async () => {
        console.log('[mock] Emitting console log after clear');
        addMockSessionLog(viewingInstanceId, '[MOCK_LOG_AFTER_CLEAR] New trace after clear for test:console-log-after-clear');

        await delay(100);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_console_log_after_clear_1', text: 'Console log after clear completed.' }
        });

        await delay(100);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_console_log_after_clear_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:stale-statusline-replay',
      run: async () => {
        console.log('[mock] Replaying stale cross-workspace status_line without instanceId');
        const slNow = Date.now();
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: slNow,
          type: 'status_line', payload: {
            ts: slNow,
            model: 'claude-3-5-haiku',
            project: 'another-react-project',
            cwd: '/Users/you/code/another-react-project',
            git: { branch: 'feature/other-workspace', changed: 7, ahead: 1, behind: 0, insertions: 88, deletions: 13, repo: 'Ike-li/another-react-project' },
            ctx: { tokens: 99000, cacheHitPct: 12, in: 6000, w: 12000, r: 3000, reused: 750000, cacheExpiresAt: slNow + 180000 },
            cost: 0.99,
            duration: { wallMs: 9000, apiMs: 6400 },
            version: '9.9.999'
          }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Stale cross-workspace StatusLine replay emitted.' }
        });

        await delay(300);

        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { text: 'Stale cross-workspace StatusLine replay emitted.' }
        });
      },
    },
    {
      prefix: 'test:message-edit',
      run: async ({ activeInst }) => {
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

        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_ask_choice', name: 'AskUserQuestion', inputSummary: 'Choose a publish channel' }
        });
        await delay(500);

        activeInst.state = 'permission';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
        });

        pendingQuestion = {
          requestId: 'req_quest_choice#0',
          toolUseId: 't_ask_choice',
          messageId: 'msg_quest_1',
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
      },
    },
    {
      commands: ['test:taskprogress', 'test:taskprogress-failed'],
      run: async ({ cmd, activeInst }) => {
        // Mirrors transient SDK background task heartbeats without adding buffered events.
        console.log(`[mock] ${cmd} — 推送后台任务进度心跳序列 + 完成/失败通知`);
        activeInst.state = 'busy';
        const failedTask = cmd === 'test:taskprogress-failed';
        const progressSteps = failedTask
          ? ['步骤 1/3：读取源文件…', '步骤 2/3：运行测试失败…']
          : ['步骤 1/3：读取源文件…', '步骤 2/3：合并重复逻辑…', '步骤 3/3：运行测试验证…'];
        for (const message of progressSteps) {
          await delay(600);
          io.emit('agent:event', {
            seq: 50, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'task_progress', transient: true, payload: { taskId: 'bg_task_1', taskType: 'local_agent', message }
          });
        }
        await delay(600);
        io.emit('agent:event', {
          seq: 51, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
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
          seq: 100, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
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
      command: 'test:unsafe-markdown',
      run: async ({ activeInst }) => {
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
  ]);

  // Handle custom trigger command inputs
  socket.on('user:message', async payload => {
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
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
      type: 'user_message', payload: { text: cmd, attachments }
    });

    if (cmd.startsWith('ultracode ')) {
      activeEpoch = 'mock-epoch-ultracode-' + Date.now();
      const activeInst = mockInstances.find(i => i.instanceId === viewingInstanceId);
      if (!activeInst) return;
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

      if (await scenarioRegistry.run(cmd, { activeInst, requestedModel })) return;

      if (cmd === 'test:stream') {
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
        let currentText = '';
        for (let i = 0; i < words.length; i++) {
          const chunk = words[i] + ' ';
          currentText += chunk;
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

      } else if (cmd === 'test:tool') {
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

        // Tool 3: Run Command
        socket.emit('agent:event', {
          seq: 7, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_bash', name: 'run_command', inputSummary: 'npm test' }
        });
        await delay(1200);
        socket.emit('agent:event', {
          seq: 8, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: 't_bash', ok: true, outputSummary: '✓ All 5 visual regression unit tests passed successfully!' }
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

      } else if (cmd === 'test:tool-out-of-order') {
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

      } else if (cmd === 'test:tool-error') {
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

      } else if (cmd === 'test:disconnect-now') {
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

      } else if (cmd === 'test:background-taskprogress') {
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

      } else if (cmd === 'test:history-overflow') {
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

      } else if (cmd === 'test:tab') {
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

      } else if (cmd === 'test:tab-model-effort') {
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

      } else if (cmd === 'test:close-current-pending') {
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

      } else if (cmd === 'test:late-closed-current-events') {
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

      } else if (cmd === 'test:permCrossTab') {
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

      } else if (cmd === 'test:questionCrossTab') {
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

      } else if (cmd === 'test:close-background-question-pending') {
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

      } else if (cmd === 'test:late-closed-session-events') {
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

      } else if (cmd === 'test:tofu-delayed') {
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

      } else if (cmd === 'test:tofu-denied-delayed') {
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
        return;

      } else if (cmd === 'test:tofu' || cmd === 'test:tofu-denied') {
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

      } else if (cmd === 'test:empty') {
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

      } else if (cmd === 'test:devicerequests') {
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

      } else if (cmd === 'test:stream-long') {
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

        // Stream slowly — gives time for interrupt
        for (let i = 0; i < 20; i++) {
          socket.emit('agent:event', {
            seq: 2 + i, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'text_delta', payload: { messageId: 'msg_long_1', text: `Chunk ${i + 1} of analysis... ` }
          });
          await delay(800); // slow enough for human to see, fast enough for test
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

      } else if (cmd === 'test:restore') {
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
      }
    }
  });

  // Handle user permission decision
  socket.on('user:approve', async payload => {
    const { requestId, decision, alwaysThisSession, instanceId } = payload || {};
    console.log(`[mock] User approve received: requestId=${requestId}, decision=${decision}, always=${alwaysThisSession}`);

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
        // 修复后的后端行为：批准 ExitPlanMode 等含 setMode 的请求 → 切权限档并广播 permission_mode，
        // 使手机端权限档图标跟随（TC-15 回归的核心断言点）。
        if (pendingPermission.setMode) {
          const inst = mockInstances.find(i => i.instanceId === viewingInstanceId);
          if (inst) inst.permissionMode = pendingPermission.setMode;
          io.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, instanceId: viewingInstanceId, ts: Date.now(),
            type: 'permission_mode', payload: { mode: pendingPermission.setMode }
          });
        }
        socket.emit('agent:event', {
          seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: pendingPermission.toolUseId, ok: true, outputSummary: 'git push success: branch main -> origin' }
        });
        socket.emit('agent:event', {
          seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: pendingPermission.messageId, text: '\n\n✓ Successfully pushed latest codebase additions!' }
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

  // Handle user question choice selection
  socket.on('user:answer', async payload => {
    const { requestId, optionIndex, instanceId } = payload || {};
    console.log(`[mock] User answer received: requestId=${requestId}, choice=${optionIndex}`);

    if (pendingQuestion && pendingQuestion.requestId === requestId) {
      const activeInst = mockInstances.find(i => i.instanceId === (instanceId || viewingInstanceId));
      activeInst.state = 'busy';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
      });

      // Broadcast resolved
      io.emit('agent:event', {
        seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'request_resolved', payload: { requestId, kind: 'question', outcome: `option ${optionIndex}` }
      });

      const selectedOption = pendingQuestion.options[optionIndex];

      socket.emit('agent:event', {
        seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'tool_result', payload: { toolUseId: pendingQuestion.toolUseId, ok: true, outputSummary: `User selected: ${selectedOption}`, denyKind: 'answered' }
      });

      socket.emit('agent:event', {
        seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'text_delta', payload: { messageId: pendingQuestion.messageId, text: `\n\nUnderstood. We will target the **${selectedOption}** branch. Beginning compilation...` }
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

  // Handle user interrupt (stop button)
  socket.on('user:interrupt', payload => {
    const { instanceId } = payload || {};
    console.log(`[mock] User interrupt received for instance ${instanceId || viewingInstanceId}`);
    const activeInst = mockInstances.find(i => i.instanceId === (instanceId || viewingInstanceId));
    if (activeInst) {
      activeInst.state = 'idle';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances }
      });
    }
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, instanceId: instanceId || viewingInstanceId, ts: Date.now(),
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
