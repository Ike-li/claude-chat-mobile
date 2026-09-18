/**
 * demo-data.js —— 在线演示站的假数据层。
 *
 * 只被 demo-socket.js 读取，挂在 window.__DEMO_DATA__ 上（普通 script，非 module，
 * 必须排在 demo-socket.js 之前）。这里只有数据，没有协议逻辑——协议在 demo-socket.js。
 *
 * 【路径与身份约束】演示站是公开页面，所有 cwd / 项目名 / 分支名 / 设备名一律用中性占位
 * （/Users/you/...），不得出现任何真实机器上的路径、用户名、项目或 IP。
 *
 * 【为什么这些面板数据全写死】
 * 设置面板那六行的摘要是**算**出来的（logic/general-nav.js），算不出来就显示「状态读取中」。
 * 喂空对象和喂 null 在 UI 上是同一个结果：一整页灰字。演示站要展示的恰恰是「装好之后
 * 信息有多全」，所以每个面板都给一份形状正确、读起来像真的的快照。
 */
(function () {
  'use strict';

  var MIN = 60 * 1000;
  var HOUR = 60 * MIN;
  var DAY = 24 * HOUR;

  // ---------------------------------------------------------------- 工作区

  // 每个工作区一个常驻实例。git 数据挂在这里，切工作区时 statusline 跟着换。
  var WORKSPACES = [
    {
      cwd: '/Users/you/code/claude-chat-mobile',
      project: 'claude-chat-mobile',
      instanceId: 'demo-inst-ccm',
      git: { branch: 'dev', changed: 3, ahead: 1, behind: 0 },
      ctx: { tokens: 18400, cacheHitPct: 62 },
      model: 'claude-opus-5',
      effort: 'high',
      permissionMode: 'default'
    },
    {
      cwd: '/Users/you/code/api-gateway',
      project: 'api-gateway',
      instanceId: 'demo-inst-api',
      git: { branch: 'feat/rate-limit', changed: 7, ahead: 2, behind: 1 },
      ctx: { tokens: 52100, cacheHitPct: 44 },
      model: 'claude-sonnet-5',
      effort: 'medium',
      permissionMode: 'acceptEdits'
    },
    {
      cwd: '/Users/you/code/personal-blog',
      project: 'personal-blog',
      instanceId: 'demo-inst-blog',
      git: { branch: 'main', changed: 0, ahead: 0, behind: 0 },
      ctx: { tokens: 6200, cacheHitPct: 71 },
      model: 'claude-haiku-4-5-20251001',
      effort: null,
      permissionMode: 'default'
    },
    {
      cwd: '/Users/you/work/data-pipeline',
      project: 'data-pipeline',
      instanceId: 'demo-inst-pipe',
      git: { branch: 'main', changed: 1, ahead: 0, behind: 3 },
      ctx: { tokens: 31800, cacheHitPct: 58 },
      model: 'claude-opus-5',
      effort: 'xhigh',
      permissionMode: 'plan'
    }
  ];

  function wsOf(cwd) {
    for (var i = 0; i < WORKSPACES.length; i++) if (WORKSPACES[i].cwd === cwd) return WORKSPACES[i];
    return WORKSPACES[0];
  }

  // ---------------------------------------------------------------- 会话

  /**
   * 会话列表。时间相对当下现算，避免演示站上出现「3 个月前」的僵尸时间。
   * 字段名是 lastUsedAt 不是 updatedAt——前端按前者判「新会话（未保存）」，
   * 写错的话每一行都会被标成未保存（踩过）。
   */
  function sessions() {
    var t = Date.now();
    var W = WORKSPACES;
    return [
      { id: 'demo-s-nav', cwd: W[0].cwd, title: '给设置面板加上二级导航', lastUsedAt: t - 2 * MIN, messageCount: 24, model: 'claude-opus-5' },
      { id: 'demo-s-e2e', cwd: W[0].cwd, title: '修 E2E 分片里偶发的时序假红', lastUsedAt: t - 47 * MIN, messageCount: 61, model: 'claude-sonnet-5' },
      { id: 'demo-s-push', cwd: W[0].cwd, title: '审查推送抑制那条判据', lastUsedAt: t - 3 * HOUR, messageCount: 12, model: 'claude-opus-5' },
      { id: 'demo-s-ratelimit', cwd: W[1].cwd, title: '限流中间件按 IPv6 /64 分桶', lastUsedAt: t - 18 * MIN, messageCount: 38, model: 'claude-sonnet-5' },
      { id: 'demo-s-openapi', cwd: W[1].cwd, title: '把 OpenAPI 规格拆成按域的文件', lastUsedAt: t - 5 * HOUR, messageCount: 19, model: 'claude-sonnet-5' },
      { id: 'demo-s-draft', cwd: W[2].cwd, title: '把草稿箱迁到新的构建管线', lastUsedAt: t - 26 * HOUR, messageCount: 8, model: 'claude-haiku-4-5-20251001' },
      { id: 'demo-s-rss', cwd: W[2].cwd, title: 'RSS 里的相对链接补成绝对', lastUsedAt: t - 2 * DAY, messageCount: 5, model: 'claude-haiku-4-5-20251001' },
      { id: 'demo-s-backfill', cwd: W[3].cwd, title: '回填任务的幂等键设计', lastUsedAt: t - 9 * HOUR, messageCount: 44, model: 'claude-opus-5' }
    ];
  }

  // 每个工作区常驻一个实例，切工作区时 viewing 跟着换。
  function instances() {
    return WORKSPACES.map(function (w, i) {
      var mine = sessions().filter(function (s) { return s.cwd === w.cwd; });
      return {
        instanceId: w.instanceId,
        cwd: w.cwd,
        sessionId: mine.length ? mine[0].id : null,
        title: mine.length ? mine[0].title : w.project,
        state: 'idle',
        permissionMode: w.permissionMode,
        effort: w.effort,
        model: w.model,
        sideQuestionCalls: { suggestion: i === 0 ? 3 : 0, recap: i === 0 ? 1 : 0 }
      };
    });
  }

  // ---------------------------------------------------------------- 模型与命令

  // 思考档位：SDK Options.effort 认 low..max（见 logic/models-effort.js 的 effortLevelSubtitle，
  // max 的副文案是「最深入更慢更贵」）。**别漏 max**——漏了菜单就少一档，而少一档
  // 在界面上完全看不出异常，只是那一格不存在。
  // ultracode 不写进这里：前端的 withUltracodeTier 会在支持 xhigh 的模型上自己追加。
  var EFFORT_FULL = ['low', 'medium', 'high', 'xhigh', 'max'];

  var MODELS = [
    { value: 'default', displayName: 'Default (recommended)' },
    { value: 'claude-opus-5', displayName: 'Claude Opus 5', supportedEffortLevels: EFFORT_FULL },
    { value: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', supportedEffortLevels: EFFORT_FULL },
    { value: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },
    // 故意只给三档：演示「不同模型档位不同」，且不含 xhigh 就不会追加 ultracode。
    { value: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', supportedEffortLevels: ['low', 'medium', 'high'] }
  ];

  var SLASH_COMMANDS = [
    { name: 'help', description: 'Show help guide' },
    { name: 'model', description: 'Switch active model' },
    { name: 'clear', description: 'Clear conversation history' },
    { name: 'compact', description: 'Compact conversation to free context' },
    { name: 'review', description: 'Review the current diff' },
    { name: 'context', description: 'Show token usage breakdown' },
    { name: 'color', description: 'Set the prompt bar color for this session' }
  ];

  var MCP_SERVERS = [
    { name: 'filesystem', status: 'connected' },
    { name: 'sqlite', status: 'connected' },
    { name: 'puppeteer', status: 'failed' }
  ];

  // ---------------------------------------------------------------- 服务状态

  // 服务已跑了 6 小时 42 分：L1 的「宿主机」行靠 startedAt 算运行时长，
  // 给 0 或 null 那一行就退化成「状态读取中」。
  var STARTED_AT = Date.now() - (6 * HOUR + 42 * MIN);

  var SERVICE = {
    startedAt: STARTED_AT,
    versions: { server: '1.10.0', cli: '2.0.0', sdk: '0.3.263' },
    deliveryFailure: null,
    rateLimitLockout: null,
    clientError: null,
    hooksBridge: { state: 'installed', off: false },
    statuslineBridge: { state: 'installed', off: false },
    restarts: [
      { ts: STARTED_AT, reason: 'manual', detail: '菜单栏「重启」' },
      { ts: STARTED_AT - 27 * HOUR, reason: 'config', detail: '配置变更后自动重启' }
    ],
    logging: { interactions: true, sdkDebug: false, stderr: true }
  };

  var DEVICES = [
    { id: 'dev-iphone-01', name: 'iPhone · Safari', firstSeenAt: Date.now() - 34 * DAY, lastSeenAt: Date.now() - 2 * MIN, current: true },
    { id: 'dev-ipad-02', name: 'iPad · Safari', firstSeenAt: Date.now() - 12 * DAY, lastSeenAt: Date.now() - 3 * HOUR, current: false },
    { id: 'dev-pixel-03', name: 'Pixel · Chrome', firstSeenAt: Date.now() - 5 * DAY, lastSeenAt: Date.now() - 2 * DAY, current: false }
  ];

  // ---------------------------------------------------------------- 配置面板

  function L(zh, en) { return { zh: zh, en: en }; }

  var ENV_VIEW = {
    groups: [
      {
        id: 'auth', label: L('鉴权', 'Authentication'),
        items: [
          { key: 'AUTH_TOKEN', kind: 'readonly', label: L('访问令牌', 'Access token'), readonly: true, secret: true, masked: { set: true, length: 64 }, help: L('要更换请在电脑上跑 npm run setup。', 'Run npm run setup on the machine to rotate it.') },
          { key: 'DEVICE_TRUST', kind: 'select', label: L('设备信任门', 'Device trust gate'), readonly: false, secret: false, value: 'all', options: [{ value: 'off', label: L('关闭', 'Off') }, { value: 'remote', label: L('仅公网', 'Remote only') }, { value: 'all', label: L('全部来源', 'All sources') }] }
        ]
      },
      {
        id: 'runtime', label: L('运行时', 'Runtime'),
        items: [
          { key: 'PORT', kind: 'number', label: L('监听端口', 'Port'), readonly: false, secret: false, value: '3000', min: 1, max: 65535 },
          { key: 'BIND_MODE', kind: 'select', label: L('绑定模式', 'Bind mode'), readonly: false, secret: false, value: 'loopback', options: [{ value: 'loopback', label: L('仅本机 127.0.0.1', 'Loopback only') }, { value: 'lan', label: L('局域网', 'LAN') }] },
          { key: 'CLAUDE_BIN', kind: 'path', label: L('claude 可执行文件', 'claude binary'), readonly: false, secret: false, value: '/Users/you/.local/bin/claude' },
          {
            key: 'WORKDIRS', kind: 'list', label: L('工作区列表', 'Workspaces'), readonly: false, secret: false, value: '',
            list: WORKSPACES.map(function (w) { return { path: w.cwd }; })
          }
        ]
      },
      {
        id: 'network', label: L('公网接入', 'Public access'),
        items: [
          { key: 'ACCESS_PROFILE', kind: 'select', label: L('接入形态', 'Access profile'), readonly: false, secret: false, value: 'tunnel-access', options: [{ value: 'local', label: L('仅本机', 'Local only') }, { value: 'tunnel', label: L('裸隧道', 'Bare tunnel') }, { value: 'tunnel-access', label: L('隧道 + CF Access', 'Tunnel + CF Access') }] },
          { key: 'CF_ACCESS_AUD', kind: 'text', label: L('Access 应用 AUD', 'Access AUD tag'), readonly: false, secret: true, masked: { set: true, length: 64 } },
          { key: 'TRUST_PROXY', kind: 'bool', label: L('采信 X-Forwarded-For', 'Trust X-Forwarded-For'), readonly: false, secret: false, value: 'false', help: L('只有确认前面就是自己的反代时才开。', 'Only enable when a reverse proxy you control sits in front.') }
        ]
      },
      {
        id: 'notify', label: L('通知', 'Notifications'),
        items: [
          { key: 'PUSH_ENABLED', kind: 'bool', label: L('web-push 推送', 'Web push'), readonly: false, secret: false, value: 'true' },
          { key: 'PUSH_PREVIEW', kind: 'bool', label: L('锁屏预览带原文', 'Preview body on lock screen'), readonly: false, secret: false, value: 'false' },
          { key: 'NTFY_TOPIC', kind: 'text', label: L('ntfy 主题', 'ntfy topic'), readonly: false, secret: false, value: '' }
        ]
      },
      {
        id: 'ops', label: L('运维', 'Operations'),
        items: [
          { key: 'LOG_INTERACTIONS', kind: 'bool', label: L('记录交互日志', 'Log interactions'), readonly: false, secret: false, value: 'true' },
          { key: 'SDK_DEBUG', kind: 'bool', label: L('SDK 调试日志', 'SDK debug log'), readonly: false, secret: false, value: 'false' },
          { key: 'AUDIT_CAPACITY', kind: 'number', label: L('审计环形容量', 'Audit ring capacity'), readonly: false, secret: false, value: '5000', min: 100, max: 50000 }
        ]
      }
    ]
  };

  // ---------------------------------------------------------------- 排查

  var DOCTOR = {
    checks: [
      { id: 'AUTH_TOKEN', status: 'ok', detail: '已设置（长度 64）', safe: { isSet: true, length: 64 } },
      { id: 'CLAUDE_BIN', status: 'ok', detail: '2.0.0 (Claude Code)' },
      { id: 'WORKDIRS', status: 'ok', detail: '4 个工作区全部可读' },
      { id: 'BIND_MODE', status: 'ok', detail: 'loopback — 未监听局域网' },
      { id: 'CONFIG_PERMS', status: 'warn', detail: '1 个配置文件权限过宽（非 0600）' },
      { id: 'WHITELIST', status: 'warn', detail: '1 条偏宽规则', safe: { dangerous: [{ rule: 'Bash(*)', reason: '任意命令', scope: 'user' }] } }
    ],
    readiness: { level: 'caution', summary: '可用，但有需留意的偏宽项' }
  };

  var PERMISSION_RULES = {
    allow: ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(npm run test:*)', 'Read', 'Glob', 'Grep'],
    deny: ['Bash(rm -rf:*)', 'Bash(curl:*)'],
    ask: ['WebFetch', 'Bash(git push:*)'],
    total: 10
  };

  function audit() {
    var t = Date.now();
    return {
      ok: true,
      capacity: 5000,
      records: [
        { id: 'a6', ts: t - 2 * MIN, action: 'permission_approved', target: 'Bash(npm ci)', outcome: 'allowed', meta: { via: 'web' } },
        { id: 'a5', ts: t - 41 * MIN, action: 'session_opened', target: 'demo-s-ratelimit', outcome: 'allowed', meta: { via: 'web' } },
        { id: 'a4', ts: t - 3 * HOUR, action: 'device_approved', target: 'dev-pixel-03', outcome: 'allowed', meta: { via: 'cli' } },
        { id: 'a3', ts: t - 8 * HOUR, action: 'auth_rate_limited', target: 'ip:203.0.113.7', outcome: 'locked', meta: { via: 'http' } },
        { id: 'a2', ts: t - 11 * HOUR, action: 'config_changed', target: 'PUSH_PREVIEW', outcome: 'allowed', meta: { via: 'web' } },
        { id: 'a1', ts: STARTED_AT, action: 'service_started', target: 'ccm-server', outcome: 'allowed', meta: { via: 'launchd' } }
      ]
    };
  }

  function logsFor(ws) {
    var t = Date.now();
    var w = wsOf(ws);
    return {
      logs: [
        { ts: t - 90 * 1000, type: 'sys_info', text: '[demo] 会话轨迹 · ' + w.project, model: w.model, effort: w.effort || 'model-default', permissionMode: w.permissionMode },
        { ts: t - 70 * 1000, type: 'info', text: 'turn started · model=' + w.model },
        { ts: t - 64 * 1000, type: 'info', text: 'tool_use Bash · ' + (w.git.changed ? 'git status --porcelain' : 'ls') },
        { ts: t - 58 * 1000, type: 'info', text: 'tool_result ok · 耗时 142ms' },
        { ts: t - 41 * 1000, type: 'info', text: 'turn finished · 2.4s · 无错误' }
      ],
      diagLogs: [
        { ts: t - 6 * HOUR, level: 'info', text: 'mirror engine: 轮询间隔回落到 2s（无活跃终端会话）' },
        { ts: t - 5 * HOUR, level: 'warn', text: 'push: 1 个订阅返回 410，已移除' }
      ]
    };
  }

  // ---------------------------------------------------------------- 文件浏览

  /**
   * 文件树按【扁平路径清单】存，browse:list 时现算某一层的直接子项。
   * 逐层手写 entries 的话，加一个文件要改两处（父层的目录项 + 该层自己），漏一处就是
   * 点进去是空目录——而那个洞在列表页上完全看不出来。
   */
  var FILE_TREE = {
    '/Users/you/code/claude-chat-mobile': [
      'app/public/index.html', 'app/public/js/app.js', 'app/public/js/logic/general-nav.js',
      'app/public/css/app.css', 'app/src/server/app.js', 'app/src/server/http.js',
      'app/src/agent/agent.js', 'app/src/auth/rate-limit.js', 'app/src/shared/protocol.js',
      'docs/architecture.md', 'docs/testing.md', 'docs/hard-rules.md',
      'tests/unit/logic-general-nav.test.mjs', 'tests/e2e/mock/server.js',
      'tests/gates/check-import-boundaries.js',
      'package.json', 'README.md', 'CLAUDE.md', 'ccm.config.json'
    ],
    '/Users/you/code/api-gateway': [
      'src/middleware/rate-limit.js', 'src/middleware/auth.js', 'src/middleware/cors.js',
      'src/routes/health.js', 'src/routes/v1/users.js', 'src/routes/v1/tokens.js',
      'openapi/users.yaml', 'openapi/health.yaml',
      'tests/rate-limit.test.js', 'tests/auth.test.js',
      'package.json', 'README.md', 'Dockerfile'
    ],
    '/Users/you/code/personal-blog': [
      'content/posts/hello-world.md', 'content/posts/on-testing.md',
      'src/build.js', 'src/templates/post.html', 'src/templates/index.html',
      'package.json', 'README.md'
    ],
    '/Users/you/work/data-pipeline': [
      'dags/backfill.py', 'dags/daily.py', 'lib/idempotency.py', 'lib/sinks.py',
      'tests/test_idempotency.py', 'requirements.txt', 'README.md'
    ]
  };

  /**
   * 某个目录下的直接子项。
   * 根目录前端发的是 `'.'` 而不是空串——当成普通目录名去匹配前缀会把整棵树滤空，
   * 症状是文件浏览打开即「空目录」，看着像树本身没配。
   */
  function listDir(cwd, relPath) {
    var all = FILE_TREE[cwd] || [];
    var rel = String(relPath || '').replace(/^\.\/?/, '').replace(/\/+$/, '');
    var prefix = rel ? rel + '/' : '';
    var dirs = {}, files = [];
    all.forEach(function (p) {
      if (prefix && p.indexOf(prefix) !== 0) return;
      var rest = p.slice(prefix.length);
      if (!rest) return;
      var slash = rest.indexOf('/');
      if (slash === -1) files.push(rest);
      else dirs[rest.slice(0, slash)] = true;
    });
    var t = Date.now();
    var out = Object.keys(dirs).sort().map(function (n, i) {
      return { name: n, kind: 'dir', size: 0, mtime: t - (i + 1) * 3 * HOUR };
    });
    files.sort().forEach(function (n, i) {
      out.push({ name: n, kind: 'file', size: 400 + (n.length * 137) % 9000, mtime: t - (i + 1) * 40 * MIN });
    });
    return out;
  }

  // 点开看得到真内容的几个；其余给一条说明，不伪造代码。
  var FILE_CONTENT = {
    'README.md': '# 项目说明\n\n这是在线演示站里的示例文件。真实部署时，这里是你工作区里那个真的 README。\n\n文件浏览支持：目录下钻、文本预览、语法高亮、搜索，以及在可编辑的文件上直接改并保存。\n',
    'package.json': '{\n  "name": "demo-workspace",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "start": "node server.js",\n    "test": "node --test"\n  }\n}\n',
    'app/src/shared/protocol.js': '// 事件契约的唯一真相源。\n// 出向事件都收敛成 agent:event 信封，type 必须在这张白名单里。\n\nexport const AGENT_EVENT_TYPES = Object.freeze([\n  \'init\', \'models\', \'instances\', \'status_line\',\n  \'text_delta\', \'thinking_delta\', \'tool_use\', \'tool_result\', \'result\',\n  \'permission_request\', \'request_resolved\', \'question\',\n  \'task_progress\', \'task_notification\',\n  // …共 31 种\n]);\n',
    'src/middleware/rate-limit.js': '// 限流：按来源分桶。IPv6 按 /64 归桶——同一台机器的地址后 64 位会漂，\n// 逐地址计数等于没限。\n\nexport function bucketKeyOf(ip) {\n  if (!ip.includes(\':\')) return ip;\n  return ip.split(\':\').slice(0, 4).join(\':\') + \'::/64\';\n}\n',
    'lib/idempotency.py': '"""回填任务的幂等键。\n\n键 = (dag_id, logical_date, target_table)。重跑同一个窗口必须命中同一个键，\n否则补数会在下游产生重复行。\n"""\n\ndef idempotency_key(dag_id: str, logical_date: str, table: str) -> str:\n    return f"{dag_id}:{logical_date}:{table}"\n',
    'openapi/users.yaml': 'openapi: 3.1.0\ninfo:\n  title: Users\n  version: "1.4.0"\n\npaths:\n  /v1/users/{id}:\n    get:\n      summary: 取单个用户\n      parameters:\n        - name: id\n          in: path\n          required: true\n          schema: { type: string, format: uuid }\n      responses:\n        "200":\n          description: OK\n          content:\n            application/json:\n              schema: { $ref: "#/components/schemas/User" }\n        "429":\n          description: 触发限流，见 Retry-After\n\ncomponents:\n  schemas:\n    User:\n      type: object\n      required: [id, email]\n      properties:\n        id: { type: string, format: uuid }\n        email: { type: string, format: email }\n'
  };

  // 没准备内容的文件给一条说明。注释符按扩展名选——对 .yaml/.py 打 `//`
  // 在带语法高亮的查看器里会整段标红，比没内容更显假。
  var HASH_COMMENT = ['yaml', 'yml', 'py', 'sh', 'toml', 'cfg', 'txt'];

  function readFile(relPath) {
    var body = FILE_CONTENT[relPath];
    if (body) return body;
    var base = String(relPath).split('/').pop();
    var ext = base.indexOf('.') === -1 ? '' : base.split('.').pop().toLowerCase();
    var lines = [
      relPath,
      '',
      '演示站只为几个文件准备了内容，这一个没有。',
      '真实部署时这里是磁盘上那个文件的原文，支持下钻、高亮与编辑。'
    ];
    if (ext === 'md') return '# ' + lines[0] + '\n\n' + lines.slice(2).join('\n') + '\n';
    var c = (HASH_COMMENT.indexOf(ext) !== -1 || base === 'Dockerfile') ? '#' : '//';
    return lines.map(function (l) { return l ? c + ' ' + l : c; }).join('\n') + '\n';
  }

  // ---------------------------------------------------------------- 脚本化回复

  /**
   * 命中 match（小写子串）就播对应的 beats，否则播 fallback。
   *
   * beat 形态：
   *   { thinking: '…' }            → thinking_delta
   *   { text: '…' }                → text_delta（按字符切片流式吐）
   *   { tool: {name, input, out} } → tool_use + tool_result 一对
   *   { approval: {…} }            → permission_request（等用户点批准/拒绝）
   */
  var REPLIES = [
    {
      match: ['结构', '架构', 'structure', 'architecture'],
      beats: [
        { thinking: '先看仓库布局，再决定从哪个入口讲起。' },
        { tool: { name: 'Bash', input: 'ls app/src', out: 'agent/\nauth/\nfiles/\nops/\nserver/\nsessions/\nshared/' } },
        { text: '后端按域分层，七个目录各有单一职责：\n\n' },
        { text: '- `agent/` — SDK 会话驱动、审批生命周期\n- `sessions/` — 会话注册表、transcript 历史\n- `server/` — 组装根，接线与多实例管理\n- `auth/` — 限速、设备指纹与信任门\n- `files/` — 浏览/预览/搜索/上传\n- `ops/` — 配置、doctor、通知与推送\n- `shared/` — 叶子工具层\n\n' },
        { text: '边界由 `check-import-boundaries.js` 硬闸执行，不是靠约定。' }
      ]
    },
    {
      match: ['测试', 'test', '跑一下'],
      beats: [
        { thinking: '跑单测最快，零 token、不起 server。' },
        { tool: { name: 'Bash', input: 'npm run test:unit', out: 'ℹ tests 1847\nℹ pass 1847\nℹ fail 0\nℹ duration_ms 12043' } },
        { text: '单测全绿，1847 条、12 秒。\n\n这一档不起 server、不 spawn claude，所以能放心在开发机上跑。需要真实例或会改环境的那几档走容器。' }
      ]
    },
    {
      match: ['审批', '权限', 'approve', 'permission', '删'],
      beats: [
        { thinking: '这条命令会动工作区文件，得先要授权。' },
        { approval: { name: 'Bash', input: 'rm -rf node_modules && npm ci', why: '重装依赖会删掉整个 node_modules' } },
        { text: '好的，依赖已重装完成。\n\n刚才那一步就是审批链路：CLI 判定命令有风险 → 手机收到推送 → 你点批准 → 命令才真的执行。锁屏状态下也推得到。' }
      ]
    },
    {
      match: ['git', '改动', 'diff', '提交'],
      beats: [
        { tool: { name: 'Bash', input: 'git status --porcelain', out: ' M app/src/auth/rate-limit.js\n M tests/unit/rate-limit.test.mjs\n?? docs/rate-limit.md' } },
        { text: '三处改动：限流实现、对应单测，加一份还没跟踪的说明文档。\n\n要我把前两个提交了，文档先留着吗？' }
      ]
    },
    {
      match: ['后台', 'background', '长任务', '慢慢跑'],
      beats: [
        { thinking: '这个跑满要几分钟，放后台去，别占着这一轮。' },
        {
          task: {
            id: 'demo-task-suite',
            label: '全量回归：lint + 单测 + 集成',
            steps: [
              'npm run lint · 扫描 312 个文件',
              'npm run test:unit · 1847 条',
              'npm run test:integration · 起真 server',
              '汇总覆盖率'
            ],
            output: '$ npm run lint\n✔ 312 files, 0 problems\n\n'
              + '$ npm run test:unit\nℹ tests 1847\nℹ pass 1847\nℹ fail 0\nℹ duration_ms 12043\n\n'
              + '$ npm run test:integration\nℹ tests 96\nℹ pass 96\nℹ fail 0\nℹ duration_ms 48210\n\n'
              + '=== 全部通过 ==='
          }
        },
        { text: '后台任务跑完了，三档全绿。\n\n刚才那条横幅就是后台任务的实时进度——**真跑起来时你可以锁屏走开**，完成时手机会收到推送。这一类通知是无条件推的，不受「前台可见就抑制」那条判据管，因为你本来就不在看。' }
      ]
    },
    {
      match: ['文件', '看看代码', 'file', '目录'],
      beats: [
        { tool: { name: 'Glob', input: 'app/src/**/*.js', out: 'app/src/server/app.js\napp/src/agent/agent.js\napp/src/auth/rate-limit.js\napp/src/shared/protocol.js' } },
        { text: '点顶栏那颗工作区 pill 就能直接浏览文件树——目录能下钻，文本文件有语法高亮，可编辑的还能当场改并保存。\n\n搜索框支持路径模糊匹配，composer 里打 `@` 也是同一套候选。' }
      ]
    },
    {
      match: ['你好', 'hello', 'hi', '在吗'],
      beats: [
        { text: '在。这里是 claude-chat-mobile 的在线演示——你正在操作的是**真实的前端代码**，只有后端被换成了一层脚本。\n\n可以试试：\n\n- 点顶栏的工作区名，切到别的项目\n- 发一句「帮我看看项目结构」\n- 发一句「删掉 node_modules 重装」看审批\n- 开会话抽屉 →「设置与状态」，里面每一页都有数据' }
      ]
    }
  ];

  var FALLBACK = {
    beats: [
      { thinking: '演示站没有接真实模型，按脚本回一条。' },
      { text: '这是演示站，回复是固定脚本，不会真的调用模型。\n\n真跑起来时这里是你本机那个 `claude` CLI 的完整输出——流式文本、思考过程、工具调用、审批请求，和你坐在终端前看到的一样。\n\n想看更多可以试试「项目结构」「跑测试」「git 改动」「删掉 node_modules」这几句。' }
    ]
  };

  window.__DEMO_DATA__ = {
    WORKSPACES: WORKSPACES,
    wsOf: wsOf,
    sessions: sessions,
    instances: instances,
    MODELS: MODELS,
    SLASH_COMMANDS: SLASH_COMMANDS,
    MCP_SERVERS: MCP_SERVERS,
    SERVICE: SERVICE,
    DEVICES: DEVICES,
    ENV_VIEW: ENV_VIEW,
    DOCTOR: DOCTOR,
    PERMISSION_RULES: PERMISSION_RULES,
    audit: audit,
    logsFor: logsFor,
    listDir: listDir,
    readFile: readFile,
    FILE_TREE: FILE_TREE,
    REPLIES: REPLIES,
    FALLBACK: FALLBACK
  };
})();
