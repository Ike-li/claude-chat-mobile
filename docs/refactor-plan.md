# 重构计划书：状态所有权收敛（P0–P5）

> 定稿：2026-07-31，基线 commit `db9b749`。本文自包含，执行者无需任何对话上下文。
> 文中行号均为基线快照，执行时**以符号名 grep 定位为准**，行号仅作导航参考。

## 0. 背景与目标

全仓评估（三路只读扫描 + git 变更分析）的结论：

- 骨架正确且被机器强制：85 条 import 边全部单向零循环（`scripts/check-import-boundaries.js` 五条分层规则）；前端可判定逻辑全部外置为 `public/js/logic.js` 纯函数层（161 个导出、零 DOM 引用）；出向事件收敛单信封 `agent:event`（seq+epoch），出入向契约有门禁。
- 结构性债集中且可定位：
  1. **复杂度制度性流入两个汇点文件**。分层规则只约束依赖方向、不约束扇出与规模，`src/server/app.js`（3259 行，约 35 个模块级可变量被 32 个 socket handler 共享）与 `public/js/app.js`（7521 行 IIFE，225 个闭包变量）承接了一切。6 月以来 324 个触及源码的提交中 **59% 触及前端 app.js**。
  2. **一个状态机被劈成两半**：mirror/catchUp 引擎的可变状态在 `src/server/app.js`（`mirrorReadonly` 等，927 行起），步进规则在 `src/sessions/history.js`（`catchUpStep` 等纯函数）。历史回归 bug 高度集中于此。
  3. **事件契约真相源倒挂**：26 种出向 type 与 40 个入向事件名的唯一机器可读定义住在门禁脚本 `scripts/agent-event-contract.js`，运行时零引用。
  4. **分叉复制**：`truncate/stringify/redactBase64` 在 `src/agent/agent.js` 与 `src/sessions/history.js` 逐字两份且已语义漂移（agent 版有 WeakSet 环护栏，history 版无）；`CCM_DATA_DIR` 解析表达式重复 7 处（其中 5 个域模块在模块求值期各自固化）；前端两份剪贴板函数。
  5. **移动端为零构建付费**：约 854KB 阻塞 vendor JS（Tailwind 运行时 JIT 407KB + CodeMirror 全家约 255KB 等）。

**目标**：收敛共享可变状态的所有权、归位契约真相源、消除分叉复制、（可选）降低移动端启动成本。**不追求小文件本身。**

## 1. 总纲：判据、红线与执行协议

**拆分判据是「共享可变状态的所有权」，不是行数。**

明确**不拆**的（纯函数/数据聚合，集中无害）：
- `public/js/logic.js`（161 个互不共享状态的纯函数）
- `public/js/i18n.js`（词典）
- `src/agent/agent.js` 顶部/底部的纯函数区
- 各 `src/**` 已是"状态外置纯函数"形态的模块

**执行协议（硬约束）**：
- 一次只做一个阶段；阶段间不并行；每阶段单独提交（P3/P4 内部再按块拆提交）。
- 任一阶段结束仓库必须全绿：`npm run check` + `npm test` + `npm run test:e2e`。
- P3/P4 每块完成后须**真机回归**（清单见各阶段）通过才进入下一块。
- 阶段彼此独立：任何一个阶段单独交付都有完整价值，可随时停在任意阶段边界。
- 分支纪律与提交规范见附录 A。

**全局红线**：
- 所有 `emit(...)` / `on(socket, ...)` / `socket.on(...)` 调用点的事件名**必须保持字符串字面量**。契约门禁（`scripts/agent-event-contract.js`）靠字面量静态提取，type 写成变量会被判 `dynamic_type` 直接红。
- 不改任何 `agent:event` 的事件序列语义与信封字段；不改「单驾驶员模型」语义（web 发消息前检测外部写入 → dispose 旧 SDK 子进程 → resume 吸收）。
- 局部变量不得命名 `t`（ESLint 门禁，i18n 遮蔽）；模块顶层常量不得调用 `t()`（import 期早于 setLang）。

**成效判据**：不看行数，看**两个 app.js 顶层还剩多少业务状态**——基线为前端约 60 个业务态（225 个模块级变量中的可变业务部分）、后端约 35 个共享可变量。终点标志是两者顶层只剩装配代码、零业务状态；行数下降只是副产品，不作指标。

---

## 2. P0 止血（零搬迁，半天量级）

**目标**：让集中度停止恶化 + 清三处零风险重复。

1. **增量规则固化**：在 `CLAUDE.md` 项目概述部分加一行：
   > 新功能的状态不得再落 `public/js/app.js` / `src/server/app.js` 顶层作用域：前端新状态进 `public/js/app/` 模块（工厂 + context 注入，样板见 `public/js/app/event-dispatch.js`），后端新状态进所属域模块（状态外置纯函数或自持模块）。存量不动。
2. **前端剪贴板去重**：`public/js/app.js` 内 `copyText`（约 6970 行）与 `copyToClipboard`（约 7250 行）功能等价，保留 `copyText`，唯一调用点（约 7273 行）改用它，删除 `copyToClipboard`。
3. **边界白名单死条目**：`scripts/check-import-boundaries.js` 的 `SHARED_ALLOWLIST`（59–62 行）删除 `'public/js/logic.js'` 条目——后端当前零引用（已实证），需要时再加回。

**验收**：`npm run check`、`npm run test:unit`、`npm run test:e2e` 全绿。

## 3. P1 数据目录与工具函数单点化（低风险机械重构，1 天量级）

**目标**：`CCM_DATA_DIR` 解析收敛单点；消灭已分叉的三件套复制。

1. **新建 `src/shared/data-dir.js`**（叶子模块，只准 import node 内置）：导出如 `resolveDataDir()` / `dataFile(name)`。真实解析点盘点（2026-07-31 grep 实测）：
   - **改造对象——6 处**：5 个域模块在模块求值期固化（`src/sessions/sessions.js:14`、`src/agent/approval-store.js:17`、`src/ops/audit.js:20`、`src/auth/devices.js:9`、`src/auth/cf-access.js:14`）+ `src/server/config.js:67`（`parseServerConfig` 调用期解析，必须走带参重载 `resolveDataDir(env, projectRoot)` 才能保住它的可注入纯度与既有单测）。
   - **`src/server/app.js:2915` 排除**（执行期实测订正）：该处 `process.env.CCM_DATA_DIR || null` 的 `null` 兜底有语义，`src/ops/doctor-runtime.js:31-33` 靠它判「未覆盖」，换成统一解析会改行为。
   - **不要动的**：`src/server/app.js` 主体（init-cache、worktree-settings 等）与 `notify-channels`、`device-gate`、`log-terminal` 已经通过 `parseServerConfig().dataDir` 单源注入（app.js:107 解构后下发）——这正是目标形态，保持注入模式不变。
   - **时序红线**：`src/server/config.js` 在 .env 加载**之前**就被求值（`server.js` 须先 import 它才能调 `loadRuntimeEnvironment`）。`data-dir.js` 一旦被 config.js import，**模块顶层不得读 env**，必须调用期解析（函数体内读 `process.env`）。5 个域模块把顶层 `const` 改为调用 `dataFile('xxx.json')`——其模块求值发生在 .env 加载后，时机不变。
   - **优先级保持**：各模块的 `CCM_*_FILE` 文件级覆盖（`tests/setup/preload-env.mjs` 靠它隔离单测）优先级不变，目标形态 `process.env.CCM_SESSIONS_FILE || dataFile('sessions.json')`。
   - TDD：先为 `data-dir.js` 写解析优先级单测（`CCM_DATA_DIR` 设/未设两态 + 调用期而非模块期读取），再实现。
2. **新建 `src/shared/tool-summary.js`**（命名执行者可调）：收敛 `truncate` / `stringify` / `redactBase64` 三函数。**以 `src/agent/agent.js` 版本为准**（约 2109/2119/2158 行，`redactBase64` 带 `seen = new WeakSet()` 循环引用护栏——取超集行为）；删除 `src/sessions/history.js` 的 `histTruncate` / `histStringify` / `histRedactBase64`（约 339/343/348 行）改 import。截断阈值常量（600/500）保持不变。前端 `logic.js` 的同口径 summarize **不动**（分层规则禁止前端 import src/）。
3. 新文件登记：`npm run inventory:update`；若新增单测文件同样登记。

**验收**：`npm run check`、`npm test` 全绿（重点看 `agent-*`、`history-*` 单测无一变化即行为未漂移）。

## 4. P2 事件契约上移（真相源归位，1 天量级）

**目标**：契约从门禁层搬进运行时可引用的位置，门禁与运行时同源。

1. **新建 `src/shared/protocol.js`**：`AGENT_EVENT_TYPES`（26 型）与 `INBOUND_SOCKET_EVENTS`（40 项）两个 `Object.freeze` 数组，内容自 `scripts/agent-event-contract.js`（约 6–33 行、369–410 行）平移。
2. **门禁改引用**：`scripts/agent-event-contract.js` 删除本地两份清单，改 `import` 上述模块。方向合法：`runtime-no-tooling` 规则只禁 src→scripts；scripts/ 本身不在边界扫描根内。手写字面量扫描器**保留**，职责收窄为「验证各处字面量 ⊆ 共享清单、mock ⊆ real」。
3. **运行时校验**：`src/agent/agent.js` 的 `emit()`（1490 行）与 `emitTransient()`（1520 行）增加：type 不在 `AGENT_EVENT_TYPES` 时 `console.error` 并**照常发出**（不拦截——n=1 生产稳定优先，门禁负责挡提交，运行时只负责暴露）。TDD：先写失败单测（未知 type → console.error 一次、事件照发、seq 照常递增），再实现。
4. **可选小项**：`src/server/socket.js` 错误路径手工构造的信封（`seq:0, epoch:'server'`）缺 `instanceId`/`cwd` 字段，与正规信封不同形——补齐为 `null` 值使前端只需容忍一种形状。改动会碰前端容错逻辑，做前先确认 `tests/e2e` 相关断言。

**红线重申**：所有 emit/注册调用点保持字符串字面量，只有清单本体上移。

**验收**：`npm run contract:check`（输出应仍为 real 26 / server 40 全对齐）、`npm run check`、`npm test` 全绿。

## 4.5 切块前必做的测量（替代行数判据）

行数不是判据。动手拆任何一块之前，先量三个数，用它们决定该块值不值得拆、边界画在哪：

1. **注入面**：该块引用了多少个所属文件的模块级符号（函数 + 稳定引用 + 可变状态）。
2. **可搬状态数**：其中的可变状态里，有几个在块外零引用（能真正随模块走）。
3. **跨用度**：剩下的可变状态各自在块外被引用多少次（决定是需要 getter 桥、setter 桥，还是该改成方法调用）。

判据：**「可搬状态数 / 注入面」越高越值得拆**。实测对照（2026-07-31）：

| 候选块 | 注入面 | 可搬状态 | 结论 |
|---|---|---|---|
| 事件 handler 表（约 826 行） | 98 | 1 | **否决**——搬 824 行只减 1 个共享状态，等于把耦合换成上下文对象穿针 |
| 审批/选择题子系统（约 304 行） | 14 | 7 + 17 个独占 DOM 引用 | **已执行**（P3-3a） |

测量方法：抽出块的行范围 → 剥掉注释与字符串 → 取标识符集合 → 与所属文件的模块级声明求交；再对交集里的每个可变状态分别统计块内写次数与块外引用次数。

外部调用点的改写方向：**不要暴露状态，要暴露动词**。P3-3a 的实证是外部 7 处引用最终收敛成 4 个动词（判重 / 入队 / 按 id 解决 / 全清 + 一个只读查询），app.js 从此拿不到也改不了那 7 个状态。

## 5. P3 前端 app.js 续拆（中风险，按块推进）

**目标**：把 `public/js/app.js` 剩余两块状态密集区按已验证的 `app/` 模式外迁。模式样板：`public/js/app/event-dispatch.js`（依赖全注入）、`public/js/app/task-status.js`（工厂 + context）；跨模块状态通道只有 `app/context.js` + `Object.defineProperties` getter 桥（app.js 约 585–595 行），**不得开第二条后门、不得新增 window 全局**。

**3a. 事件 handler 表**（约 826 行，`const handle = {` 在 app.js:1628 起，含 `renderToolDiff` 与工具卡渲染）→ `public/js/app/event-handlers.js`，导出 `createEventHandlers(context)`。接线点：dispatcher 已惰性取 `handlers: () => handle`（app.js 1470–1627 接线区），改取工厂产物。状态迁移原则：仅 handler 族使用的集合（`streams`/`thinkings`/`toolCards`/`subagentCards` 等 Map）随模块走；被外部读写的经 context 暴露。

**3b（原方案已否决）**：计划书初稿写「外迁会话大区（app.js 5276–6966，约 1691 行）」。2026-07-31 实测：**注入面 143、可搬状态仅 1、需桥接 36**——与被否决的 handler 表同属一类，照做只会把耦合换成上下文对象穿针。会话大区要拆，须先在其内部找到自带状态的子系统（如 SWR 重校验器、历史渲染分块器各自的私有状态），逐个按 4.5 节测量后再定，**不要整块搬**。

**已执行的块**（均为零桥接/低注入面）：
- P3-3a `app/approval-questions.js`：审批/选择题子系统（注入面 14，搬走 7 个状态 + 17 个独占 DOM 引用）
- `app/sheets.js`：sheet 开合原语 + 通用确认弹窗（3 个状态；顺带去掉「通用原语认识具体业务弹窗」的泄漏）
- `app/drawer.js`：左抽屉 + 边缘手势（3 个状态）
- `app/session-delete.js`：两级删除会话（1 个状态）

**app.js 剩余候选的实测数据**（2026-07-31，按 4.5 节口径；行号会漂移，用区块横幅定位）：

| 区块 | 注入面 | 可搬状态 | 需桥接 | 判断 |
|---|---:|---:|---:|---|
| @ 文件引用浮层 | 14 | 3 | 3 | 值得做，次优先 |
| 工具函数区 | 15 | 1 | 3 | 可做，收益小 |
| 设置 sheet 接线 | 22 | 0 | 4 | 无状态收益，不做 |
| 子 agent 折叠卡 | 31 | 0 | 3 | 不做 |
| 斜杠命令 + @ 列表 | 35 | 1 | 7 | 不做 |
| 权限档/会话档/effort | 34 | 0 | 10 | 不做 |
| 发送 / 停止 | 48 | 0 | 14 | 不做 |
| 工作目录切换 | 81 | 2 | 31 | 不做 |
| 未读角标 + bindView | 94 | 3 | 21 | 不做 |
| 会话大区 | 143 | 1 | 36 | 不做（见上） |

「不做」不代表这些代码没问题，而是**按当前形态搬迁无法减少共享状态**——它们要改善，得先在 app.js 内部把状态本身重新归属（例如把 `currentModel`/`currentCwd`/`viewingInstanceId` 这类被 30–50 处引用的视图态收敛成一个显式的视图状态模块），那是比搬迁更大的一步，需单独立项。

**硬要求**：
- 每块独立提交；**每块完成后 E2E 全绿 + 真机回归通过，才动下一块**。
- 改动前端 JS 后必须重启常驻 server 才能拿到新 `?v=` assetVersion（真机验证前勿忘）。
- E2E（mock 服务真前端）天然覆盖前端搬迁；E2E 基线为全绿，出红即新引入。

**真机回归清单（P3 每块）**：冷启动进会话、切换会话、流式回复渲染、工具卡展开全文、审批弹窗批准/拒绝、AskUserQuestion 选择题、历史加载与翻页、未读角标、附件预览。

## 6. P4 mirror/catchUp 引擎收敛（最高风险，收尾阶段）

> 机主已裁决（2026-07-31）：本阶段是「**合并所有权**」——把状态与规则收进同一模块，不是把引擎打散。此前「别拆同步引擎」的禁令即指打散，勿混淆。

**4a. 新建 `src/server/mirror-engine.js`**，收敛 `src/server/app.js` 约 927–1268 行一带的模块级状态为引擎自持字段：
`mirrorReadonly`、`mirrorStale`、`mirrorAutonomous`、`mirrorObservedCli`、`mirrorSessionId`、`mirrorInstanceId`、`mirrorLastEmittedRemainingMs`、`mirrorRelease`、`mirrorLastSize`、`mirrorCliSeen`、`catchUpKey`、`catchUpState`、`catchUpRebaselineRequested`、`catchUpInFlight`、`catchUpTimer`；`catchUpTickOnce`（约 1046–1253 行，208 行）成为引擎方法。
- 对 app.js 暴露**窄接口**（以现有调用面反推，命名不必照抄）：tick 启停调度、`isReadonly(sessionId, instanceId)`、状态快照（供 `instances` 广播与 `mirror_state` 事件）、rebaseline 请求、外部写入通知。
- 依赖注入进构造器：广播回调、`src/sessions/history.js` 规则函数、`src/agent/diag-log.js`。**实测补充**（2026-07-31 对 `catchUpTickOnce` 1046–1253 行扫描）：函数体还引用 `registryBusy`（12 次，session-registry 判活）、`viewingInstanceId`（5 次，视图态）、`agents.get`（5 次，实例注册表）、`io.to`（2 次）——窄接口除广播回调外**必须注入视图态读取器与实例注册表访问器**，遗漏会迫使引擎反向 import app.js（边界规则直接红）。
- 行为不变判据：`mirror_state`/`diag_log` 事件序列不变（契约门禁 + E2E 镜像 spec 锚定）；`data/` 无新持久化。

**4b. 规则迁入**：`src/sessions/history.js` 中与「读历史」无关的镜像状态机纯函数簇迁到引擎侧（同文件或平级 `mirror-rules.js`）：`catchUpStep`(211)、`mirrorReleaseStep`(303)、`mirrorEntryLock`(949)、`mirrorStaleFlag`(984)、`classifyTailEntries`(1120)，及同簇的 `classifyChainTail`、`externalGrowthWhilePaused`、`hasAutonomousLoopMarker`、`rebaselineAbsorbedExternal`、`describeMirrorEntryLock`。对应单测同步搬迁改 import 路径（注意 inventory 登记）。history.js 回归「读 transcript + 历史重建」单一职责。

**提交与回退**：4a、4b 分开提交，出问题按提交粒度 revert。

**真机回归清单（P4，强制，全部通过才算完成）**：
1. CLI 终端直驱会话 → web 端显只读镜像并实时跟进；
2. 镜像 stale（终端疑似中断）→「可接管」文案出现；
3. web 接管：先 dispose 再 resume 吸收外部写入，transcript 不分叉；
4. 断线重连 `sync:since` 回放正确（无重复无丢失）;
5. 杀 CLI / `/clear` 后 web 续接不卡「等终端完成」；
6. 自主循环唤起（ScheduleWakeup 形态）不误标「终端会话运行中」；
7. server 重启后腰斩回合不误标终端会话。
（3–7 全部是历史真实 bug 场景，改镜像引擎必须复测。）
建议收尾加跑 `npm run test:smoke -- --scenario core`（耗 token，仅此阶段）。

## 7. P5 前端启动成本（独立可选轨，与 P0–P4 零依赖）

1. **CodeMirror 懒加载**：`public/index.html` 移除 11 个 codemirror `<script>`（约 255KB），`public/js/app/file-browser.js` 首次打开文件预览时按需注入 `<script>`（vendor 为非 ESM min 文件，用注入 + onload Promise；CSP `script-src 'self'` 允许本域注入）。收益：冷启动少 255KB 阻塞。
2. **Tailwind 预生成静态 CSS**：现状是 Play CDN 运行时 JIT（407KB JS）跑生产。项目已刻意只用预设类（见 `public/js/tw-config.js` 注释），静态提取可行：一次性脚本收集全部用到的工具类产出静态 css 入库，`index.html` 撤 `tailwind.js` + `tw-config.js` 运行时链路。**必须配防漂移手段**（新增 class 未再生成会静默缺样式）：生成物比对检查或 E2E 视觉断言兜底。复杂度高，**独立立项，勿与其他阶段混做**。

---

## 附录 A：执行者须知（项目陷阱清单）

- **分支**：日常开发一律在 `dev`，不动 `master`；发版走 `scripts/release.sh`。执行分支听机主安排（本文档所在检出位可能是 worktree）。
- **commit**：不加 Claude 署名（含 Co-Authored-By / Claude-Session 行）；push 前先 `CI=true npm test` 模拟 CI。
- **测试隔离**：任何一次性起 server 的测试/脚本必须带隔离四件套 `PORT` / `WORK_DIR` / `CCM_DATA_DIR` / `AUTH_TOKEN`，否则会污染生产 `data/`。不要绕过 `tests/setup/preload-env.mjs` 直接 `node --test 单文件`。
- **新文件**：任何新增源码/测试/文档文件必须 `npm run inventory:update`，否则 `npm run check` 红。
- E2E mock 零 import `src/`（只改 src/ 时 E2E 红不是你引起的——先 stash 对照基线确认归属）。
- **前端改动**：必须重启常驻 server 才生效（启动期预读 + assetVersion 改写）；生产是 LaunchAgent/systemd 常驻服务，**勿手动 `npm start`**（撞 3000 端口）。
- **E2E**：禁 `test.only/skip/fixme`、`networkidle`、`waitForTimeout`（门禁强制）；判断元素显隐查 `classList` 不查 `textContent`。
- **沙箱**：不使用绕沙箱的执行方式；git/npm/doctor 普通模式即可。
- **验证分级**：常规阶段用零 token 的 `npm run check` + `npm test` + `npm run test:e2e`；耗 token 的 `RUN_CLAUDE_INTEGRATION=1` 与 `npm run test:smoke` 仅 P4 收尾使用。
- 架构背景阅读：[docs/architecture.md](architecture.md)、[docs/display-contracts.md](display-contracts.md)。

## 附录 B：每阶段验收命令速查

```bash
npm run check        # 8 道门禁（eslint/边界/契约/文档/i18n/mock registry/playwright 禁例/inventory）
npm test             # 单测 + 可靠集成
npm run test:e2e     # Playwright 移动端 UI 回归（零外部依赖）
npm run contract:check   # 单独跑事件契约（P2 重点）
npm run inventory:update # 新增文件后重新生成 docs/repository-map.md
node scripts/doctor.js   # 部署后 12 项自检（真机验证前）
```
