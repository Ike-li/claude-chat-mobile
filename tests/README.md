# tests/

这份文件是**地图与词汇表**：目录各是什么、`XXX-NN` 这类编号指什么。
「哪些命令能在宿主机跑、哪些必须进容器」是安全边界，写在根 [CLAUDE.md](../CLAUDE.md) 里，不在这里重复。

## 目录

| 目录 | 是什么 | 槽 | 入口 |
|---|---|---|---|
| `unit/` | 按**被测模块**组织（`agent-lifecycle` / `history-list` / `service-cli`…） | S0·S1 | `npm run test:unit` |
| `invariants/` | 按**不变量**组织，每个文件头声明守护哪条、不测什么 | S1 | `npm run test:invariants` |
| `invariants/server/` | 同上，但加载真正的组装根（`app/server.js` 子进程 + 假 CLI） | S2 | `npm run test:invariants:server` |
| `invariants/env/` | 卸载器的对称性：删干净【且】没多删 | 环境级 | `npm run test:invariants:env` |
| `integration/` | 真 server + 真 CLI 路径；需真 agent turn 的由 `RUN_CLAUDE_INTEGRATION` 门控 | S2·S5 | `npm run test:integration` |
| `e2e/specs/` | 真浏览器 + 假后端，移动视口 | S3 | `npm run test:e2e` |
| `e2e/mock/` | 那个假后端本身（零外部依赖，不碰 `~/.claude`） | — | — |
| `smoke/` | 真 Claude，需显式授权 | S5 | `npm run test:smoke` |
| `playground/` | 干净 Linux 用户视角的装机/拓扑验收 | — | `npm run test:docker:playground` |
| `gates/` | 门禁脚本（边界、契约、i18n、破坏性删除、变异…） | S0 | `npm run check` |
| `infra/` | 测试基建：Dockerfile、compose、playwright config、分片编排 | — | — |
| `fixtures/` `helpers/` `setup/` | 假 CLI、共用 UI helper、preload 隔离 | — | — |

### ⚠ `infra/` 的编排脚本不在任何门禁覆盖范围

上表最后几行没有「怎么跑」是有代价的：`infra/` 下的编排脚本既不在 `npm run check` 链上，
也不在 CI 里，改坏了不会有任何东西变红。`e2e-parallel.js` 就这么坏过——2026-09-03（`74fc46e`）把
`playwright.config.ts` 从仓库根移进 `infra/` 时，`package.json` 的 `test:e2e` 补了 `-c`
而它漏了，Playwright 静默回落内建默认（workers 变成 CPU/2、完全不起 webServer），266 条
全红，一直到 2026-09-07 才被发现——因为在那之前没有任何路径会执行到它。

**改 `infra/` 下的东西，必须手动跑一次它编排的那条命令**，check 和 CI 都不会替你发现。
（同类的第二份真相已经消除：分片子进程现在直接 spawn `npm run test:e2e --`，config 路径
只有 `package.json` 一处。）

### `unit/` 与 `invariants/` 是两根轴，不是新旧

两者**执行槽相同**（纯函数 + 一次性目录的真磁盘，不起 server、不 spawn claude），CI 里同一个 job 跑。
区别只在组织方式：`unit/` 问「这个模块对不对」，`invariants/` 问「这条红线有没有被守住」。

同一条不变量常被两个槽分别守护，这是有意的——譬如 `SESSION-01` 的判定纯函数在 `invariants/cli-mirror-state.test.mjs`（S1），
它在真实接线上的效果在 `invariants/server/external-dirty.test.mjs`（S2）。ID 就是把这两层串起来的东西。

> 这棵树 2026-09-05 前叫 `tests/v2/`。那是迁移期的名字，指「相对 unit 的第二版」，已废弃。

## 执行槽

槽按「安全性依不依赖被测代码的正确性」分，不按测试流派分。

| 槽 | 内容 | 不含 |
|---|---|---|
| **S0** 静态 | 语法、非法 import、循环依赖、事件名单双向相等、i18n key、破坏性删除形态、分发裁剪、Swift typecheck | 不跑业务 |
| **S1** 决策与真磁盘 | 纯函数 + 一次性目录上的真 fs / git / symlink / FIFO | 不起 `app.js`、不 spawn Claude |
| **S2** 真 server + 假 CLI | 真组装根，HTTP + Socket，`CLAUDE_BIN` 指向 `fixtures/fake-claude.sh` | 模型回合 |
| **S3** 真浏览器 + 假后端 | 真 `app/public`，假 server 只模拟信封 | 无 CLI、无真组装根 |
| **S4** 薄跨缝 | 真浏览器 → 真 server → 假 CLI，只覆盖「假后端可能与真 server 字段分叉且用户看得见」的几条 | 模型回合 |
| **S5** 授权真 Claude | 真 CLI + 真 SDK + 隔离的 `CCM_DATA_DIR` / `HOME` | — |
| **S6** 变异 | 故意改坏源码再跑 S1（`npm run mutate:docker`） | 永不在宿主机真实 HOME 上跑 |
| **S7** Darwin | Swift 逻辑 + `CCMProcess` 资源 + 能编出 bundle | 唯一只能在宿主机跑的槽（容器无 `swiftc`） |

## 不变量编号

**两套编号并存，都还活着，不要合并。**

- **不变量编号**（`AUTH-0N` / `SCOPE-0N` / `SESSION-01` …）：按「谁能撒谎」划分的红线，几乎只出现在 `tests/`。
- **既有编号**（`SEC-0N` / `FILES-N` / `REL-0N` / `SRV-00N` / `OPS-N`）：**生产代码注释里先有的**，指同一批红线里更具体的一条。
  不变量编号「吸收」它们而非取代——`app/src/**` 里那些注释仍按旧号写，改掉就对不上了。位数不齐（`FILES-1` vs `AUTH-01`）是这个来源差异的产物，不是笔误。

另有 `BE-0NN`（bug-hunting review 的发现编号，54 处活在 `app/src/**` 的 15 个文件里，去重后 12 个编号）与 `P0-NN`（E2E 用例编号，全部 e2e 都是 P0 级，所以 `e2e/` 下不再分优先级子目录）——多数是历史留痕。
其中一条已升格成被测试守护的红线，因此单独登记：

| ID | 红线 |
|---|---|
| `BE-002` | 校验失败的 `clientMessageId` **不得**记入去重表——否则重发被当成「已处理」而静默丢弃，消息永久消失 |

### 鉴权与设备

| ID | 红线 |
|---|---|
| `AUTH-01` | 未持实例令牌不得进入数据面与操作面（静态壳除外）。HTTP 与 Socket 握手共用拒绝语义 |
| `AUTH-02` | `ownsHost(host)` 为真时，验签失败**不得**回退 `AUTH_TOKEN` |
| `AUTH-03` | 限速只打鉴权口；成功认证后的业务 500 不计入失败。本机来源的锁定**不得**文案成「有人在暴力尝试」 |
| `AUTH-04` | 只在声明的可信拓扑下采信边缘注入头：公网 Host + loopback peer → `CF-Connecting-IP`；`TRUSTED_PROXY=loopback` + loopback peer → `X-Forwarded-For` **末跳**。LAN/直连、未声明、开关值写错，一律不采信（失败方向 = 合桶，不是拆桶）。限速桶与待审设备卡片上的来源 IP 取同一份判据（`clientSourceAddress`），不允许各算一份 |
| `AUTH-06` | CCM 自己的控制面密钥（`AUTH_TOKEN` · `VAPID_*` · `NTFY_*` · `CF_ACCESS_*`）不得随子进程环境流给 claude，也不得流给 server 在工作区里跑的 git（仓库配置能让它执行任意命令）。**这不是「裁剪终端等价性」而是恢复它**：普通终端里的 claude 本来就没有这几个键，它们只存在于 `ccm.config.json`，是 server 的投影把它们带进 `process.env` 的。反向同样要钉——`ANTHROPIC_*` / `CLAUDE_CODE_*` / 代理变量属于 claude，剥了会静默砍掉第三方网关那条支持路径 |
| `DEVICE-01` | 走到 peer/Host 判定时，bypass 必须 peer 本机**且** Host 本机；空 Host 不视为本机。**前面有两道早退，顺序不能换**：`DEVICE_APPROVAL_SCOPE === 'all'` 一律不 bypass（覆盖全部路径的总开关，含本机样 Host 那条——Host 是客户端填的头，纯 TCP 转发下可伪造，见 H1），其次 CF Access 已启用时直接 bypass、不看 peer/Host |
| `DEVICE-02` | 吊销后已建立的连接必须失权（文件监听驱动，不靠重连）；写盘成功才算数；pending 有界（`SEC-03` = macOS 上 `watch` 的 `eventType` 不可靠，监听形态本身是修过的坑） |
| `DEVICE-03` | 设备 ID / IP 不进推送正文；网络响应不返回受信任设备列表（那只给本机 CLI 与菜单栏）。网络响应里的设备 ID 一律是短 ID：待审列表、审计记录、服务端日志回传都不带完整设备令牌——令牌就是准入凭据，一台日后被吊销的设备手里不能还攥着别台的 |
| `AUTH-05` | `AUTH_TOKEN` 不得出现在服务端**自身**的输出里：启动横幅只打掩码（两条 `BIND_MODE` 分支都算），`logs:server` 回传前逐行 `sanitize`。泄露路径是两跳——横幅进 `LOG_FILE` / 日志窗口 / 投屏，而经 CF Access 进来的会话默认不需要 `AUTH_TOKEN`（设备审批也 bypass），读一次日志就能把它拿走。同一条路径的第三个出口是接入二维码：含令牌的码（`connect:qr`）只发给握手时出示过 `AUTH_TOKEN` 的会话 |
| `SEC-01` | 未审批 socket 不加入 approved 房间，收不到任何会话内容广播 |

### 范围与文件

| ID | 红线 |
|---|---|
| `SCOPE-01` | 任何用户可控路径经 `realpath` 后仍须落在授权工作区内。**三层窗口各有编号，缺一层就是一个可逃逸的时间窗**：`FILES-1` readdir 之后复校（目录级）· `FILES-2` mkdir 之后用 realpath 后的目录做前缀校验（中间路径级）· `FILES-3` `O_NOFOLLOW` 打开（叶节点级） |
| `SCOPE-02` | 上传：只留 basename、去控制字符与前导点；不把服务端绝对路径交给不可信面；个数/单文件/总量上限前后端必须同一数字（`FILES-4` 缩略图上限两侧对齐） |
| `SCOPE-03` | 授权工作区列表必须来自**显式配置**；一个都解析不出时拒绝启动，**绝不回落家目录**。`SCOPE-01` 管的是「路径必须落在白名单内」，白名单本身 = `[家目录]` 时它全绿而整个家目录已经暴露 —— 这是它的上游，不是同一条 |
| `FILE-01` | 编辑器直写不走审批链，但走独立的闸：已存在文件、大小硬顶、`baseHash`、写前后范围门、审计、`FILE_EDIT=off` 整段关闭 |
| `FILE-02` | `open` 之前拒绝 FIFO / 字符设备 / unix socket。实现是**白名单**（只放行常规文件与 symlink），测试要按白名单写，否则新增一种特殊文件类型时不会红 |
| `FILE-03` | 控制面状态文件（设备、审批、配置、审计、上传附件）owner-only `0600` |

### 会话与 Claude

| ID | 红线 |
|---|---|
| `MSG-01` | 同一 `clientMessageId` 对 Claude `send` 至多一次。校验失败不得 commit；并发重发靠 in-flight claim，无论成败都要 release（`REL-01` 两阶段 + claim/release · `SRV-001` FRESH 分支**同样**要单飞——「FRESH 不去重」是修过的坑） |
| `SESSION-01` | 终端仍在驾驶时 Web 不得向同一会话发新消息；接管前若有外部增长先 dispose + resume 吸收（`SRV-003` 该置换时置换、**忙碌时禁止置换**，两侧都要钉） |
| `SESSION-03` | 会话中途 `EnterWorktree` / `ExitWorktree` 之后，实例的驾驶轴 cwd 必须跟到新目录——CLI 已把整份 transcript 迁到新 cwd 的 project 目录，停在旧值 = 历史、resume、附件全按一个空目录解析。信号以主链 `tool_use_result`（`worktreePath` / `originalCwd`）为准：CLI 2.1.280 实测 EnterWorktree **不派发** CwdChanged，hook 只是另一条冗余通道。两路先后到达必须幂等；子 agent 的、`is_error` 的、别的工具的结果一律不采信；采信前仍过 server 的范围判据。<br>*（2026-09-24 建：9/13 那版只接了 hook，真机会话 `1c401b5d` 证明它从未生效）* |
| `SOCKET-01` | Socket 断开不得杀死 Agent；Agent 死必须清 busy、通知客户端、允许恢复 |
| `SYNC-01` | 出向唯一信封 `agent:event`（`seq` + `epoch` + `type`）。重连用 `sync:since` 补缺口，超缓冲或换 epoch 走鉴权 `session:history`。一台设备连入触发的追平重定基线只对它自己生效：其余在线端照样收到终端刚写的那段 `history_append`，待审批设备连入不触发 |
| `READ-01` | 未读位点跨设备共享、按时间戳单调合并。手动标未读**不得**用「删条目」表达已读——LWW 合并里会被另一台设备复活；标记也**不得**被分页截断吞掉——`session:list` 要把挤出本页的那些补回列表（否则确认框承诺的「会一直显示未读」当场食言） |
| `APPROVAL-01` | 一次审批只有一个终态。所批即所行：前后端同一份 `canonicalizeOp`（`app/public/js/canonicalize.js` 是前后端唯一豁免的共用文件），指纹不符不得执行 |
| `APPROVAL-02` | 启动时磁盘上残留的 pending 标为 expired（`decidedBy=system:restart`），不可再批准执行 |

### 配置、通知、分发

| ID | 红线 |
|---|---|
| `CONFIG-01` | 面板/CLI 写入的必须是启动时读的那一份。schema 单一事实源 `env-schema.js`，读写归一在 `config-file.js`；shell env 压过文件 |
| `CONFIG-02` | `.env` 的 dotenv 与 `source` 两个消费者必须**同时**安全，不轮流迁就一侧 |
| `CONFIG-03` | 存放凭据的配置文件（`ccm.config.json` 三形态 · `.env` 系列 · `workdirs.json`）必须被 `.gitignore` 覆盖——本仓是 **public** 的。gitleaks 钩子不是替代品：它扫的是「内容像不像凭据」，这条管的是「路径会不会被收进来」。**由门禁守而非用例守**（`tests/gates/check-config-gitignored.js`，在 check 链上）：它要跑 `git`，而 linked worktree 检出的 `.git` 是指向宿主机的指针文件，放进 `tests/invariants/` 会让容器全量档在测到任何代码之前就 128。<br>*（2026-09-17 反向补登：hard-rules §4.6 早写着「删掉那三行 `.gitignore` 不会让任何东西变红」，一直没人管）* |
| `NOTIFY-01` | 审批/提问/后台任务完成无条件推；`result` 仅当 approved 房间有**前台可见**连接时抑制，判据是 `client:presence` 而非 socket 连着（`SEC-04` 正文不进第三方明文通道 · `OPS-3` `notify_failed` 须覆盖 push 与 ntfy 双通道） |
| `ALERT-01` | 服务告警与「需要你(N)」是两根轴，绝不混判（`OPS-1` doctor readiness 假绿） |
| `DISPLAY-01` | 模型列表、effort、statusline 只做 [display-contracts.md](../docs/display-contracts.md) 允许的变换（`OPS-2` `utilization` 必须夹在 `[0,100]`） |
| `OPS-04` | `/health` 的 `busy` 反映「**有在途轮次**」（`anyTurnRunning()`），不是「有实例」。运维探针据此判断能否重启——报成空闲会让正在跑的回合被腰斩。多端看到的 `instances.turnRunning` 同口径：后台任务完成触发的自动汇报轮由 agent 合成账面，开轮那一刻就要广播出去，否则其它端以为它空闲、发消息被在途轮闸拒掉。<br>*（2026-09-05 反向补登：这条一直被 `invariants/server/health-busy.test.mjs` 守着，只是从未登记）* |
| `OPS-05` | 写进**外部配置**（launchd plist、`~/.claude/settings.json`）的 node 路径必须是跨版本升级存活的稳定 symlink，不得是 `process.execPath`（解析过 symlink 的版本化真身）。失效是**静默**的——node 一升级两个 hook 与 statusline 一起停摆，用户只看到「手机端收不到推送」，无任何报错指向 node。<br>*（2026-09-07：注释和局部函数拦不住——同一个坑在 `service.js`、`app-build.js` 修过两次后，两个 bridge 安装器照样踩了第三次）* |
| `PROTO-01` | `AGENT_EVENT_TYPES` 与 `INBOUND_SOCKET_EVENTS` 是唯一名单；后端 emit / 后端 listen / 前端 handle / 假后端四处与名单双向相等 |
| `DIST-01` | 分发树（GitHub `master` 归档）`npm ci --omit=dev` 可装可启、生产代码零 devDependency 泄漏；`uninstall` 只删产品自己写下的白名单，**永删不到** `~/.claude/projects` |
| `TEST-01` | 测试不得以真实 `HOME`、`~/.claude`、生产 `CCM_DATA_DIR` 为删除或写入目标 |
| `TEST-02` | E2E 分片跑过的 spec 并集必须等于磁盘上的全量清单。<br>*（2026-09-13 e2e 改跨 runner 横向分片时建：每台 runner 各自读时长缓存算分组，任何一台 cache 未命中就会算出另一套分组，于是有 spec 谁都没跑——而 CI 全绿。required check 静默放过整个文件，与 `74fc46e` 漏传 `-c` 同型）* |
| `RESOURCE-01` | 不测 QPS，测「开合 N 次后 FD / listener / timer / child / watcher 不随 N 线性涨」 |
