/**
 * demo-socket.js —— 把真前端接到一个纯浏览器内的假后端。
 *
 * 【为什么是这个形状】
 * 演示站跑的是 app/public/ 原样拷贝的**真前端**，一行业务代码都没改。产品里
 * `/socket.io/socket.io.js` 这个 script 由 Socket.io server 自动提供，静态站没有它——
 * 构建脚本把那一行换成本文件，暴露同名的全局 `io()`，于是前端 47 处 socket 调用
 * 全部落到这里，而它自己不知道后端是假的。
 *
 * 这样做的代价是清楚的：本文件是一份**平行实现**，真 server 的协议改了它不会自己跟上。
 * 所以它刻意只兜住「能点起来」需要的那几条路径，不试图复刻完整协议——覆盖面越小，
 * 漂移的面就越小。信封形状抄 tests/e2e/mock/server.js（那份有双向事件契约门禁和
 * E2E 用例守着），不是从 app/src 里猜的。
 *
 * 【两个必须守住的协议细节，改错了症状都是「事件凭空消失」——两条都做过反向注入】
 * 1. (epoch, seq) 去重：event-dispatch.js 按这两项判重复/陈旧，对话流的 seq 必须严格递增。
 *    把 `_seq += 1` 改成固定值，流式回复与审批两条验收立刻红；首屏水合仍绿，因为它走
 *    _ctrl（seq:0 / epoch:'server'）不参与去重。
 * 2. instanceId 过滤：判据是 logic/composer.js 的 shouldDropAgentEvent，注意方向——
 *      !ev.instanceId             → 放行（「无主事件」）
 *      非空且 !== viewingInstanceId → 丢弃
 *    所以把对话事件的 instanceId 置 **null 不会**出问题（实测全绿），置成不匹配的非空值
 *    才会被静默吞掉（实测两条红）。tests/e2e/mock/server.js 里那句「带 instanceId:null 的
 *    事件会被静默丢掉」与现在的代码对不上，别照抄。
 *
 * 【ack 的两种签名】socket.io 的语义，前端两种都在用：
 *   socket.emit(ev, payload, res => …)                  单参
 *   socket.timeout(ms).emit(ev, payload, (err, res) => …) 双参
 */
(function () {
  'use strict';

  var D = window.__DEMO_DATA__;

  // ---------------------------------------------------------------- 工具

  function later(fn, ms) { return setTimeout(fn, ms); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  // ---------------------------------------------------------------- Socket

  function DemoSocket(opts) {
    this.connected = false;
    this.id = 'demo-' + Math.random().toString(36).slice(2, 10);
    this.auth = (opts && opts.auth) || {};
    this._handlers = Object.create(null);

    // 对话流的 (epoch, seq)：切会话换 epoch 并重置 seq。
    this._epoch = 'demo-epoch-1';
    this._seq = 0;

    // 多工作区：每个工作区一个常驻实例，_ws 指向当前查看的那个。
    // 实例与会话都要可变——新建会话会改实例的 sessionId、往列表里加行。
    this._instances = D.instances();
    this._sessions = D.sessions();
    this._ws = 0;

    this._turn = null;        // 在途回合的取消句柄
    this._pendingPerm = null; // 等待批准的审批
    this._tasks = {};         // 播过的后台任务，供 task:output 取回输出
    this._stoppedTasks = {};  // 停过一次的任务：再停回 ok:false（对齐真 server）

    var self = this;
    later(function () { self._open(); }, 120); // 给 app.js 装好 handler 的时间
  }

  DemoSocket.prototype.on = function (ev, fn) {
    (this._handlers[ev] || (this._handlers[ev] = [])).push(fn);
    return this;
  };
  DemoSocket.prototype.off = function (ev, fn) {
    if (!this._handlers[ev]) return this;
    if (!fn) delete this._handlers[ev];
    else this._handlers[ev] = this._handlers[ev].filter(function (h) { return h !== fn; });
    return this;
  };
  DemoSocket.prototype._fire = function (ev, arg) {
    var hs = this._handlers[ev];
    if (!hs) return;
    hs.slice().forEach(function (h) {
      try { h(arg); } catch (e) { console.error('[demo] handler error on ' + ev, e); }
    });
  };

  DemoSocket.prototype.connect = function () {
    if (!this.connected) this._open();
    return this;
  };
  DemoSocket.prototype.disconnect = function () {
    if (!this.connected) return this;
    this.connected = false;
    this._fire('disconnect', 'io client disconnect');
    return this;
  };

  /** 演示站永远连得上——没有握手、没有鉴权、没有断线重连。 */
  DemoSocket.prototype._open = function () {
    this.connected = true;
    this._fire('connect');
    this._hydrate();
  };

  /** 控制面事件：对齐 mock 的 seq:0 / epoch:'server'，不参与对话流去重。 */
  DemoSocket.prototype._ctrl = function (type, payload, extra) {
    var env = {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: type, payload: payload
    };
    if (extra) for (var k in extra) env[k] = extra[k];
    this._fire('agent:event', env);
  };

  // ---- 当前工作区/实例的访问器。所有「当前模型/强度/权限」都从实例上读，不另存一份，
  //      免得切工作区后顶栏 pill 与实例列表各说各话。
  DemoSocket.prototype._inst = function () { return this._instances[this._ws]; };
  DemoSocket.prototype._ws_ = function () { return D.WORKSPACES[this._ws]; };
  DemoSocket.prototype._wsIndexOf = function (cwd) {
    for (var i = 0; i < this._instances.length; i++) if (this._instances[i].cwd === cwd) return i;
    return this._ws; // 不认识的 cwd：留在原地，别把视图扔到一个不存在的工作区
  };

  /**
   * 对话流事件：seq 严格递增，带 instanceId，否则会被前端丢掉。
   * extra 放【信封级】字段——task_progress 的 transient 就在信封上而不是 payload 里，
   * 塞进 payload 的话横幅照常出现，却永远不会被当成瞬时态清掉。
   */
  DemoSocket.prototype._stream = function (type, payload, extra) {
    this._seq += 1;
    var inst = this._inst();
    var env = {
      seq: this._seq, epoch: this._epoch, sessionId: inst.sessionId,
      instanceId: inst.instanceId, ts: Date.now(), type: type, payload: payload
    };
    if (extra) for (var k in extra) env[k] = extra[k];
    this._fire('agent:event', env);
  };

  DemoSocket.prototype._instancesPayload = function () {
    var inst = this._inst();
    return {
      canRestart: true,
      viewingInstanceId: inst.instanceId,
      viewingCwd: inst.cwd,
      dirs: D.WORKSPACES.map(function (w) { return w.cwd; }),
      instances: this._instances,
      service: D.SERVICE
    };
  };

  DemoSocket.prototype._broadcastInstances = function () {
    this._ctrl('instances', this._instancesPayload());
  };

  DemoSocket.prototype._emitInit = function () {
    var inst = this._inst();
    this._ctrl('init', {
      model: inst.model,
      cwd: inst.cwd,
      claudeVersion: D.SERVICE.versions.cli,
      mcpServers: D.MCP_SERVERS,
      skillsCount: 7,
      permissionMode: inst.permissionMode,
      slashCommands: D.SLASH_COMMANDS,
      terminalSlashCommands: ['color']
    });
  };

  DemoSocket.prototype._emitModes = function () {
    var inst = this._inst();
    this._ctrl('permission_mode', { mode: inst.permissionMode }, { instanceId: inst.instanceId });
    this._ctrl('effort_mode', { level: inst.effort }, { instanceId: inst.instanceId });
  };

  DemoSocket.prototype._emitStatusLine = function () {
    var inst = this._inst();
    var w = this._ws_();
    this._ctrl('status_line', {
      model: inst.model,
      project: w.project,
      cwd: inst.cwd,
      git: w.git,
      ctx: w.ctx,
      cost: 0.42
    });
  };

  /** 首屏水合序列，顺序抄 mock：init → models → permission_mode → effort_mode → instances → status_line。 */
  DemoSocket.prototype._hydrate = function () {
    this._ctrl('trusted_devices', { accessBypassActive: false, devices: D.DEVICES });
    this._emitInit();
    this._ctrl('models', { models: D.MODELS });
    this._emitModes();
    this._broadcastInstances();
    this._emitStatusLine();
  };

  /** 切工作区/切会话后把整套「当前视图」重发一遍，顺序同水合。 */
  DemoSocket.prototype._rebind = function () {
    this._epoch = 'demo-epoch-' + Math.random().toString(36).slice(2, 8);
    this._seq = 0;
    this._emitInit();
    this._ctrl('models', { models: D.MODELS });
    this._emitModes();
    this._broadcastInstances();
    this._emitStatusLine();
  };

  // ---------------------------------------------------------------- 回合播放

  /** 按关键词挑脚本；都不命中走兜底。 */
  function pickReply(text) {
    var low = String(text || '').toLowerCase();
    for (var i = 0; i < D.REPLIES.length; i++) {
      var r = D.REPLIES[i];
      for (var j = 0; j < r.match.length; j++) {
        if (low.indexOf(r.match[j]) !== -1) return r;
      }
    }
    return D.FALLBACK;
  }

  /**
   * 把 beats 播成事件流。返回一个 cancel 函数供 user:interrupt 用。
   * 播到 approval 会停下来等 user:approve，剩下的 beats 存进 _pendingPerm.rest。
   */
  DemoSocket.prototype._play = function (beats, messageId) {
    var self = this;
    var timers = [];
    var cancelled = false;
    var t0 = Date.now();

    function schedule(fn, ms) { timers.push(later(fn, ms)); }

    var at = 0;
    function step(i) {
      if (cancelled || i >= beats.length) {
        if (!cancelled) {
          schedule(function () {
            self._stream('result', {
              messageId: messageId, durationMs: Date.now() - t0,
              costUsd: 0, isError: false, models: [self._inst().model]
            });
            self._turn = null;
          }, 120);
        }
        return;
      }
      var b = beats[i];

      if (b.thinking) {
        schedule(function () {
          if (cancelled) return;
          self._stream('thinking_delta', { messageId: messageId, text: b.thinking });
          step(i + 1);
        }, 260);
        return;
      }

      if (b.tool) {
        var tid = 't_demo_' + i + '_' + Math.random().toString(36).slice(2, 7);
        schedule(function () {
          if (cancelled) return;
          self._stream('tool_use', { toolUseId: tid, name: b.tool.name, inputSummary: b.tool.input });
          schedule(function () {
            if (cancelled) return;
            self._stream('tool_result', { toolUseId: tid, ok: true, outputSummary: b.tool.out });
            step(i + 1);
          }, 620);
        }, 200);
        return;
      }

      if (b.approval) {
        schedule(function () {
          if (cancelled) return;
          var reqId = 'req_demo_' + Math.random().toString(36).slice(2, 8);
          var at2 = Date.now();
          self._pendingPerm = {
            requestId: reqId, messageId: messageId,
            rest: beats.slice(i + 1), why: b.approval.why
          };
          self._stream('permission_request', {
            requestId: reqId,
            name: b.approval.name,
            input: b.approval.input,
            cwd: D.CWD,
            fp: 'demo-fp-' + reqId,
            createdAt: at2,
            expiresAt: at2 + 10 * 60 * 1000
          });
        }, 260);
        return; // 不推进——等 user:approve
      }

      if (b.task) {
        var tk = b.task;
        self._tasks[tk.id] = tk;
        var steps = tk.steps || [];
        var STEP_MS = 1100;
        steps.forEach(function (s, k) {
          schedule(function () {
            if (cancelled) return;
            // taskType 决定横幅措辞（logic/bg-tasks.js 的 classifyBgTaskKind）：
            // local_bash → 「后台命令」，local_agent → 「子代理」。这个任务是跑命令，
            // 用 local_agent 会把一串 npm run 显示成「子代理 运行中」。
            self._stream('task_progress', {
              taskId: tk.id, taskType: tk.taskType || 'local_bash',
              message: s, description: s, lastToolName: 'Bash'
            }, { transient: true });
          }, 300 + k * STEP_MS);
        });
        schedule(function () {
          if (cancelled) return;
          // 字段与真 server 逐个对齐：skipTranscript 是 housekeeping 任务的静音开关，
          // 前端只认 === true，常规任务发 false。
          self._stream('task_notification', {
            source: 'system', taskId: tk.id, status: 'completed',
            summary: tk.label + ' · 已完成',
            outputFile: '/tmp/' + tk.id + '.log',
            toolUseId: 'toolu_' + tk.id,
            skipTranscript: false
          });
          step(i + 1);
        }, 300 + steps.length * STEP_MS + 500);
        return;
      }

      // text：按片吐，模拟流式打字
      var chunks = String(b.text).match(/[\s\S]{1,14}/g) || [];
      chunks.forEach(function (c, k) {
        schedule(function () {
          if (cancelled) return;
          self._stream('text_delta', { messageId: messageId, text: c });
        }, at + k * 26);
      });
      at += chunks.length * 26 + 90;
      schedule(function () { if (!cancelled) step(i + 1); }, at);
      at = 0;
    }

    step(0);

    return function cancel() {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  };

  DemoSocket.prototype._runTurn = function (text) {
    var self = this;
    var inst = this._inst();

    // 新会话的首轮：此刻才拿到 sessionId（对齐真 server——SDK 回 init 之前它是 null）。
    // 落进 _sessions 后，这条会话就出现在【它自己那个工作区】的抽屉列表里，而不是当前视图。
    if (!inst.sessionId) {
      inst.sessionId = 'demo-s-' + Math.random().toString(36).slice(2, 9);
      inst.title = text.length > 24 ? text.slice(0, 24) + '…' : text;
      this._sessions.unshift({
        id: inst.sessionId, cwd: inst.cwd, title: inst.title,
        lastUsedAt: Date.now(), messageCount: 1, model: inst.model
      });
      this._broadcastInstances();
    } else {
      for (var i = 0; i < this._sessions.length; i++) {
        if (this._sessions[i].id === inst.sessionId) {
          this._sessions[i].lastUsedAt = Date.now();
          this._sessions[i].messageCount += 1;
        }
      }
    }

    var messageId = 'msg_demo_' + Date.now();
    this._stream('user_message', { text: text });
    var reply = pickReply(text);
    later(function () {
      self._turn = self._play(clone(reply.beats), messageId);
    }, 300);
  };

  // ---------------------------------------------------------------- emit 路由

  /**
   * 兜底 ack：给一个「什么容器都有、但都是空」的对象。
   * 演示站不实现文件/git/日志/运维这些面板的真实数据，但 ack 必须回——
   * 前端等不到 ack 的面板会一直转圈，那比显示「空」难看得多。
   */
  function emptyAck() {
    return {
      ok: true, items: [], entries: [], files: [], messages: [], sessions: [],
      branches: [], rules: [], logs: [], list: [], devices: [], tasks: [],
      content: '', text: '', total: 0, hasMore: false
    };
  }

  var ROUTES = {
    'conn:ping': function () { return { ok: true, ts: Date.now() }; },
    'client:presence': function () { return { ok: true }; },
    'read:sync': function () { return { ok: true, state: null }; },
    'read:mark': function () { return { ok: true }; },
    'user:ackUnread': function () { return { ok: true }; },

    'session:list': function (p) {
      var cwd = p && p.cwd;
      var q = p && typeof p.query === 'string' ? p.query.trim().toLowerCase() : '';
      var rows = this._sessions.filter(function (s) { return !cwd || s.cwd === cwd; });
      if (q) rows = rows.filter(function (s) { return s.title.toLowerCase().indexOf(q) !== -1; });
      rows = rows.slice().sort(function (a, b) { return b.lastUsedAt - a.lastUsedAt; });
      return {
        currentSessionId: this._inst().sessionId,
        sessions: rows,
        pinned: [],
        readState: {},
        terminalBusy: false,
        hasMore: false,
        total: rows.length
      };
    },

    'session:history': function () {
      // 演示站每条会话都从空白开始：历史留空，让用户自己发第一句。
      return { messages: [] };
    },

    // 切会话要连工作区一起切——会话不属于「当前工作区」，它自带 cwd。
    // 只改 sessionId 不改 _ws，顶栏还显示着上一个项目，而 statusline 的 git 分支也是旧的。
    'session:switch': function (p) {
      var id = p && p.sessionId;
      var row = null;
      for (var i = 0; i < this._sessions.length; i++) if (this._sessions[i].id === id) row = this._sessions[i];
      if (!row) return { ok: false, error: '会话不存在' };
      this._ws = this._wsIndexOf(row.cwd);
      var inst = this._inst();
      inst.sessionId = row.id;
      inst.title = row.title;
      inst.model = row.model;
      this._rebind();
      return { ok: true, sessionId: row.id };
    },

    // 新会话开在【请求里带的那个 cwd】，不是当前工作区：抽屉里每个工作区行都有自己的 ＋，
    // 点哪一行就该开在哪一行下面。真 server 同形（app.js 的 session:new 也吃 payload.cwd）。
    'session:new': function (p) {
      var cwd = (p && p.cwd) || this._inst().cwd;
      this._ws = this._wsIndexOf(cwd);
      var inst = this._inst();
      inst.sessionId = null;   // 未保存：SDK 还没回 init，前端据此走空表面
      inst.title = null;
      this._rebind();
      return { ok: true };
    },

    // 顶栏切工作区。前端按 instanceId 指，找不到就当没发生。
    'user:setViewing': function (p) {
      var id = p && p.instanceId;
      for (var i = 0; i < this._instances.length; i++) {
        if (this._instances[i].instanceId === id) { this._ws = i; this._rebind(); break; }
      }
      return { ok: true };
    },

    'user:setEffort': function (p) {
      var inst = this._inst();
      inst.effort = (p && p.level) || null;
      this._ctrl('effort_mode', { level: inst.effort }, { instanceId: inst.instanceId });
      this._broadcastInstances();
      return { ok: true };
    },

    'user:setPermissionMode': function (p) {
      if (p && p.mode) {
        var inst = this._inst();
        inst.permissionMode = p.mode;
        this._ctrl('permission_mode', { mode: p.mode }, { instanceId: inst.instanceId });
        this._broadcastInstances();
      }
      return { ok: true };
    },

    'user:message': function (p) {
      var payload = (p && typeof p === 'object') ? p : {};
      var text = typeof p === 'string' ? p : payload.text;
      // 模型切换随 user:message 捎带（前端 send 内差分 setModel），init.model 才是真相源。
      if (typeof payload.model === 'string' && payload.model) {
        this._inst().model = payload.model;
        this._emitInit();
        this._broadcastInstances();
      }
      if (typeof text === 'string' && text.trim()) this._runTurn(text.trim());
      return { ok: true };
    },

    'user:interrupt': function () {
      if (this._turn) { this._turn(); this._turn = null; }
      this._pendingPerm = null;
      this._stream('system', { message: '已中断。' });
      return { ok: true };
    },

    'user:approve': function (p) {
      var self = this;
      var pend = this._pendingPerm;
      if (!pend) return { ok: true };
      this._pendingPerm = null;
      var approved = !p || p.approved !== false;
      this._stream('request_resolved', { requestId: pend.requestId, approved: approved });
      if (approved) {
        var tid = 't_demo_appr_' + Math.random().toString(36).slice(2, 7);
        later(function () {
          self._stream('tool_use', { toolUseId: tid, name: 'Bash', inputSummary: 'rm -rf node_modules && npm ci' });
          later(function () {
            self._stream('tool_result', { toolUseId: tid, ok: true, outputSummary: 'added 412 packages in 9s' });
            self._turn = self._play(pend.rest, pend.messageId);
          }, 700);
        }, 200);
      } else {
        later(function () {
          self._stream('text_delta', { messageId: pend.messageId, text: '好的，已取消这一步。' });
          self._stream('result', {
            messageId: pend.messageId, durationMs: 400, costUsd: 0,
            isError: false, models: [self._inst().model]
          });
        }, 200);
      }
      return { ok: true };
    },

    'user:answer': function () { return { ok: true }; },

    // ---- 设置与状态面板。这些不是「有就行」的占位：L1 六行的摘要是 general-nav.js
    //      现算的，service 给 null 那一行就退化成「状态读取中」，整页看着像坏了。

    'service:status': function () {
      var s = D.SERVICE;
      return {
        ok: true,
        startedAt: s.startedAt,
        versions: s.versions,
        deliveryFailure: s.deliveryFailure,
        rateLimitLockout: s.rateLimitLockout,
        clientError: s.clientError,
        restarts: s.restarts,
        hooksBridge: s.hooksBridge,
        statuslineBridge: s.statuslineBridge,
        logging: s.logging,
        timestamp: Date.now()
      };
    },

    'audit:get': function () { return D.audit(); },

    'env:get': function () {
      return { ok: true, envFileExists: true, groups: D.ENV_VIEW.groups };
    },

    // 演示站不落盘：把改动原样回给前端，让「保存成功」这条路走完整。
    'env:set': function (p) {
      return { ok: true, changed: Object.keys((p && p.changes) || {}) };
    },

    'doctor:run': function () { return D.DOCTOR; },

    'logs:get': function () { return D.logsFor(this._inst().cwd); },

    'permissions:rules': function (p) {
      return { ok: true, cwd: (p && p.cwd) || this._inst().cwd, rules: D.PERMISSION_RULES };
    },

    'git:status': function () {
      var w = this._ws_();
      return { ok: true, branch: w.git.branch, ahead: w.git.ahead, behind: w.git.behind, files: [] };
    },

    'git:branches': function () {
      var w = this._ws_();
      return { ok: true, current: w.git.branch, branches: [w.git.branch, 'main', 'dev'] };
    },

    // 两个 CLI 桥：演示站已装好，切换按钮点了给回执但不改状态——
    // 真去改会让「宿主机」那页的摘要和面板在刷新后自相矛盾。
    'statusline:setup': function () {
      return { ok: true, state: D.SERVICE.statuslineBridge.state, report: '演示站不改本机配置。' };
    },
    'hooks:setup': function () {
      return { ok: true, state: D.SERVICE.hooksBridge.state, report: '演示站不改本机配置。' };
    },
    'push:test': function () { return { ok: true, sent: 0, note: '演示站没有推送服务。' }; },

    // ---- 文件浏览。cwd 决定看哪棵树，所以切工作区后浏览的是另一个项目。

    'browse:list': function (p) {
      var cwd = (p && p.cwd) || this._inst().cwd;
      var entries = D.listDir(cwd, (p && p.relPath) || '');
      return { ok: true, entries: entries, truncated: false, totalCount: entries.length };
    },

    'browse:read': function (p) {
      var rel = (p && p.relPath) || '';
      var text = D.readFile(rel);
      return {
        ok: true, content: text, totalSize: text.length, bytesRead: text.length,
        truncated: false, binary: false,
        // 带 contentHash 才能进编辑态。演示站不落盘，但「改了能保存」这条路要走得完整。
        contentHash: 'demo:' + rel + ':' + text.length
      };
    },

    // 演示站不写磁盘：回一个新 hash，让保存成功的那条路走完。
    'files:write': function (p) {
      var rel = (p && p.relPath) || '';
      var body = (p && p.content) || '';
      return { ok: true, contentHash: 'demo:' + rel + ':' + body.length };
    },

    // composer 里打 @ 和文件搜索框共用这一条。空 query 返回全部候选（对齐真 server）。
    'files:search': function (p) {
      var cwd = (p && p.cwd) || this._inst().cwd;
      var all = D.FILE_TREE[cwd] || [];
      var q = String((p && p.query) || '').toLowerCase().trim();
      var paths = q ? all.filter(function (x) { return x.toLowerCase().indexOf(q) !== -1; }) : all.slice();
      return { ok: true, paths: paths };
    },

    // ---- 后台任务

    'task:output': function (p) {
      var tk = this._tasks[(p && p.taskId) || ''];
      if (!tk) return { ok: false, error: '输出不可用（演示站未记录该任务）' };
      return { ok: true, text: tk.output || '', truncated: false, size: (tk.output || '').length };
    },

    // 真 server 对已结束的任务再停一次回 ok:false（stopTask 返回 false）。照着来，
    // 否则「停两次都说成功」会让前端的二次点击看起来有效。
    'task:stop': function (p) {
      var id = (p && p.taskId) || '';
      var first = !this._stoppedTasks[id];
      this._stoppedTasks[id] = true;
      return { ok: first };
    }
  };

  /** 未在 ROUTES 里的事件走这里：立刻回空 ack，保证面板不转圈。 */
  DemoSocket.prototype._dispatch = function (ev, payload) {
    var fn = ROUTES[ev];
    if (!fn) return emptyAck();
    try {
      var r = fn.call(this, payload);
      return (r === undefined) ? { ok: true } : r;
    } catch (e) {
      console.error('[demo] route error on ' + ev, e);
      return emptyAck();
    }
  };

  DemoSocket.prototype._emit = function (ev, payload, ack, withErr) {
    var self = this;
    var res = this._dispatch(ev, payload);
    if (typeof ack !== 'function') return this;
    // 异步回，对齐真 socket 的时序（同步回 ack 会让前端某些「先设状态再等回执」的写法错位）
    later(function () {
      if (withErr) ack(null, res); // timeout(ms).emit → (err, res)
      else ack(res);               // 裸 emit → (res)
    }, 24);
    return this;
  };

  DemoSocket.prototype.emit = function (ev, payload, ack) {
    if (typeof payload === 'function') { ack = payload; payload = undefined; }
    return this._emit(ev, payload, ack, false);
  };

  DemoSocket.prototype.timeout = function () {
    var self = this;
    return {
      emit: function (ev, payload, ack) {
        if (typeof payload === 'function') { ack = payload; payload = undefined; }
        return self._emit(ev, payload, ack, true);
      }
    };
  };

  // ---------------------------------------------------------------- 导出

  window.io = function io(opts) { return new DemoSocket(opts); };
  window.io.connect = window.io;
})();
