# 项目概述

> `AGENTS.md` 是指向本文件的符号链接。修改本文件即同时更新两者，不要新建独立的 `AGENTS.md`。

移动端聊天式 Web UI，把**本机 claude CLI** 接到手机上。目标是终端等价性："坐在电脑前对 claude 打字"和"在手机上打字"效果一样。

技术栈：Node ≥20 · ESM · Express 5 · Socket.io · Agent SDK · `jose`（JWT）· `web-push`（离线推送）；**版本号一律以 `package.json` 为准**。测试用内置 `node --test` + Playwright（移动端 UI E2E，断言基于 DOM 状态非像素比对）。

**产品立场 n=1 自托管**（单用户、无多租户）。硬性规则、n=1 取舍、已决「不做」的技术债（AD-5 / SP-10 等）见 [docs/hard-rules.md](docs/hard-rules.md)。历史 design 文档已下线，以该文 + 实现为准。

## 动手前

- 不知道某个功能该怎么做时：**CLI 有什么 web 就有什么**，先去找 claude code CLI 是怎么实现的。Agent SDK 文档在 https://code.claude.com/docs/en/agent-sdk/overview ，尽量不重复造轮子。
- 新功能的状态**别再落** `app/public/js/app.js` / `app/src/server/app.js` 顶层作用域：前端新状态进 `app/public/js/app/` 模块（工厂 + context 注入，样板见 `app/public/js/app/event-dispatch.js`），后端新状态进所属域模块。存量不动。
- 前端逻辑能写成纯函数就先落 `app/public/js/logic/*`（数据进数据出，不碰 DOM/window/socket/应用可变态，唯一宿主外 import 是 `i18n.js`；浏览器与 `tests/unit/logic-*.test.mjs` 零构建共用同一份文件。`logic.js` 仅是 re-export barrel）。
- 改动涉及同步链路、推送、镜像锁、事件回放时，**先读 [docs/architecture.md](docs/architecture.md)**——判据都在那里，凭直觉改这几处基本会错。

## 同步与通道

双向实时同步走 Socket.io，出向统一收敛成 `agent:event` 信封（type 白名单见 `app/src/shared/protocol.js` 的 `AGENT_EVENT_TYPES`，当前 31 种；seq+epoch 去重回放，`npm run check` 校验双向事件契约）。并存的通道：Web 驾驶走 Agent SDK 双向流；CLI 终端驾驶**不经过 SDK**，靠磁盘 transcript 轮询同步只读镜像，「单驾驶员模型」防两端同时写分叉；设备审批走文件监听广播；离线唤醒走 web-push/ntfy。机制、判据与参数全在 [docs/architecture.md](docs/architecture.md)。

几条最容易改错的，摆在这里：

- **推送抑制**：审批/提问/后台任务完成**无条件推**（用户可能锁屏或在别的 app），只有回合完成的 `result` 与网关静默告警（`system` 信封里的 `gateway_stall` notice）在「approved 房间有前台可见连接」时才抑制——两者共用 `notifyHasClientsAtSend` 那条判据；前台判据是客户端上报的 `client:presence`，**不是 socket 连着**。其中「后台任务完成」**只算真后台任务**——CLI 把跑得久的前台 Bash 也建模成 task 走同一条 `task_notification`，靠 `task_started` 的 `is_backgrounded` 过滤掉（**别把这道过滤当多余删掉**，删了每条跑几秒的命令都会推到锁屏手机上）。
- **服务告警与「需要你(N)」是不同轴，绝不混判**：顶栏 chip / 角标只表达「点一下就能处理」的待办，服务告警只活在抽屉「服务」小节与服务状态面板。
- **限速锁定的措辞按来源分档**：本机来源**绝不说成「有人在暴力尝试」**。
- **不开无鉴权的 HTTP 数据端点**：`/health`、`/metrics`、历史回显都过鉴权。

## 代码地图与模块边界

**运行时代码住在 `app/`**（`app/src/` 后端 · `app/public/` 前端 · `app/server.js` 入口）；`scripts/`（用户装机/运维命令）与 `desktop/`（macOS 菜单栏）留在仓库根——前者是用户要敲的命令（`node scripts/doctor.js`，加一层前缀纯属体验退化），后者不是 web 运行时。

**注意两个脆弱点**：

1. `app/src/**` 里算「项目根」是**三层**向上（`app/src/server/app.js` 的 `HERE`、`app/src/shared/data-dir.js` 的 `PROJECT_ROOT`）——`data/`、`scripts/`、`ccm.config.json` 都在仓库根、不随代码进 `app/`，少一层会让它们全部解析到 `app/` 下且**无任何报错**。
2. `desktop/launchd/server.plist.template` 的启动命令 `exec <node> app/server.js` 与 `app/src/ops/service-units.js` 解析它的后缀**必须逐字一致**，漏改一边会让服务面板的 repo/node 恒为 null。

后端 `app/src/` 按域分层：`agent/`（SDK 会话驱动、审批生命周期与存储、CLI 镜像态判定）· `sessions/`（会话注册表、transcript 历史与 catchUp、工作区、「需要你」聚合）· `server/`（组装根：接线、多实例管理、mirror-engine、hooks 投递箱）· `auth/`（限速、CF Access、设备指纹与信任门）· `files/`（浏览/预览/搜索/上传、git 变更、工作区范围门）· `ops/`（配置、doctor、通知与推送通道、statusline 与额度、metrics、审计、受管服务）· `shared/`（叶子工具层；`protocol.js` 是事件契约真相源）。

**测试与门禁全部住在 `tests/` 下**：`tests/{unit,invariants,integration,e2e,smoke,playground}/` 是用例，`tests/infra/` 是测试基建（Dockerfile、compose、playwright config、playground 夹具、E2E 分片编排），`tests/gates/` 是门禁脚本。`scripts/` 是用户装机/运维会执行的命令 + 少量维护者工具（`release.sh`/`gen-icons.js`/`upstream-watch.js`/`dist-manifest.js`）。**两个门禁不能移进 `tests/`**：`scripts/doc-consistency.js`（check 链第 4 环）与 `scripts/collect-source-files.js` 被 `scripts/doctor.js` import，而 `tests/**` 整棵被 `export-ignore` 裁掉——移过去等于用户跑 `doctor` 直接 `ERR_MODULE_NOT_FOUND`（判据见 hard-rules §4.1.1，由 `dist-manifest.test.mjs` 单列断言保护）。**这样分发裁剪、inventory 分类、门禁自检三处都退化成目录前缀**，不再各存一份会漂移的文件名清单。

`unit/` 与 `invariants/` **执行槽相同**（纯函数 + 一次性目录真磁盘，CI 同 job），分的是组织轴：前者按被测模块，后者按不变量（文件头声明守护哪条 `XXX-NN`、不测什么）。目录职责、执行槽 S0–S7、以及那两套并存的编号（新的 `AUTH-01` 类 与生产代码注释里先有的 `FILES-1`/`SEC-01`/`SRV-003` 类）都在 [tests/README.md](tests/README.md)——**看到 `// 守护：SRV-003` 不知道是什么就去查那份**，别照着编号猜。

**要新增、修改或删除任何测试文件之前，先读 [docs/testing.md](docs/testing.md)。** 那里有三件在这个仓库里判错过、且不读就一定会判错的事：

1. **文件放 `tests/unit/` 还是 `tests/invariants/`** —— 判据唯一：编号表里查得到就进 `invariants/` 并写 `// 守护：<编号>`，查不到就进 `unit/` 且不写守护行。`check-invariant-ids.js` 硬闸执行（四种失效形态各自会红）。
2. **失败方向** —— 本产品的 fail-closed 是**逐条选过的**，有两条的正确方向恰恰是「不拒绝」（`trusted-devices.json` 瞬时读失败保留 last-good；鉴权通过后 handler 抛 500 不得计入限速）。按「所有异常都该拒绝」写会把它们测反。
3. **怎么证明这条测试不是永远绿的** —— 两侧验收的证据写进 commit 的 `Tested:` trailer（注入了什么、哪条红了），不写就是没做。

**看着漂亮却永不变红的测试比没有更坏**，它占着「这里测过了」的位置。

模块边界由 `tests/gates/check-import-boundaries.js` **硬闸执行**（check 一环）：前后端互不 import（唯一豁免 `app/public/js/canonicalize.js`，指纹规范化两侧共用）· `shared` 是叶子、不得反向 import 其他后端域 · `server` 是组装根、只有 `app/server.js` 与它自身能 import · 运行时禁止 import `scripts/` 与 `tests/` · 零循环依赖。违反时它会自己说清是哪条，不必背。

文档索引：

- [docs/architecture.md](docs/architecture.md) — 双通道 / 单驾驶员 / 回放 / 推送 / 可观测详解
- [docs/testing.md](docs/testing.md) — **写测试前先读**：三条铁律、选槽的判据、怎么知道自己没写出假绿、怎么知道自己写慢了、增删改功能时分别做什么。配套 [tests/README.md](tests/README.md)（目录地图 + 执行槽 + 不变量编号词汇表）
- [docs/display-contracts.md](docs/display-contracts.md) — 模型、effort、statusline 展示语义。**改契约先改 `tests/unit/display-contracts.test.mjs`**
- [docs/deployment.md](docs/deployment.md) — 常驻 / 隧道 / CF Access 运维
- [docs/getting-started.md](docs/getting-started.md) — 装机教程
- README.md — 产品入口，含安全边界

新增文件必须落进 `tests/gates/repo-inventory.js` 的某条目录前缀；往 `docs/` 加文档还要在那份 `ROOT_FILES` 里逐篇登记，否则 check 里的 inventory 拒绝（这道闸挡的是一次性产物——审计报告、进度笔记、提案——悄悄回堆）。

## 分支纪律

两条分支各有单一职责：**`dev` = 开发主线**（dependabot 与所有日常 PR 都落在这里）；**`master` = 对外发布的稳定版本**，HEAD 恒等于最新发布，**同时是 GitHub 默认分支**——仓库首页展示的 README 必须与装机 `curl` 拿到的那份一致。

- **日常改动走 feature 分支 → PR → `dev`**，每个小改动一个 PR。不在 `dev` 上直接提交：`dev` 要求 PR 且 CI 必须绿。**默认分支是 `master`，所以开 PR 必须显式 `--base dev`**——忘了会被 `quality` 那道闸拦住（显式报错，不会静默合错）。
- **`master` 只接受 `scripts/release.sh` 开的那条 `dev` → `master` 发版 PR**。它开了 `enforce_admins`，谁都不能直推（包括仓库 owner），`quality` 里还有一道 step 拦住任何 head 不是 `dev` 的 PR。
- 两条分支的 required checks 都是 `quality` / `unit-test (20)` / `unit-test (24)` / `e2e`；**approvals = 0**——单人仓库里 GitHub 不允许自己 approve 自己的 PR，设成 1 会让所有 PR 永远合不进去。PR 在这里的作用是「强制 CI + 可读的变更面」，不是等人点同意。
- 发版走 `scripts/release.sh`：bump → 推 `dev` → **等真 CI 绿** → 开发版 PR → 等 PR 检查绿 → 合并 → 在合并后的 `master` HEAD 上打 tag → 建 Release。中途失败就直接重跑，它会从中断处接上（不会二次 bump）。
- PR 合并产生 merge commit，所以 `master` 不再等于 `dev` 的 tip，**这是正常的**——merge commit 的父之一就是 `dev`，下次 PR 的 merge base 仍然正确，不需要把 `master` 合回 `dev`。

装机 `curl` 直接拉 GitHub 对 `master` 的源码归档（`/archive/refs/heads/master.tar.gz`，GitHub 现场 `git archive`、遵守 `export-ignore`），发版不打包、不上传资产——这正是 `master` 必须恒等于最新发布的原因。裁什么由 `.gitattributes` 的 `export-ignore` 定；新增的测试/门禁文件只要落在 `tests/` 下就被目录前缀自动覆盖、无需手动同步（见前文"代码地图与模块边界"），不变量由 `tests/unit/dist-manifest.test.mjs` 钉住（详见 [docs/hard-rules.md](docs/hard-rules.md) §4.1.1）。

其他分支的常驻 worktree 检出位是仓库外的平级兄弟目录（`../claude-chat-mobile-<分支名>`），**不是本分支源码**，物理上不在本仓库树内，开发/搜索/审查天然不会扫到，无需额外排除规则。

## 测试跑在哪：宿主机只跑白名单，其余进容器

**宿主机上只允许跑这四条**：`npm run lint`、`npm run check`、`npm run test:unit`、`npm run test:e2e`
（钩子的白名单还含同源别名与 check 的组成环节：`lint:fix`、`test:visual`、`test:playwright`、`app:test`，
外加与 `test:unit` 同档的 `test:invariants` 与 `test:coverage`、与 `test:e2e` 同源的 `test:e2e:parallel`，
见 `tests/gates/guard-host-tests.js` 的 `HOST_ALLOWED_SCRIPTS`）。
前三条不起 server、不 spawn claude；E2E 打的是 `tests/e2e/mock/server.js`（纯 mock，零外部依赖，
已核实不碰 `~/.claude`）。

> ⚠️ **`test:invariants` 的两个兄弟不在白名单上，别照着后缀类推**：`test:invariants:server` 起真 `app/server.js` 子进程；
> `test:invariants:env` 跑的是卸载器（`tests/invariants/env/`），它的隔离**依赖被测代码认注入的 `home`/`root`/`appPath`**
> ——回落成 `homedir()` / `/Applications/CCM.app` 就打在真实家目录上，与 8/2 删库同形态。两条都进容器。

> **这几条现在是【强制】的，不再只是约定**：`tests/invariants/env/`、`tests/invariants/server/`、
> `tests/integration/` 下的每个测试文件顶部都 import 了 `tests/setup/require-disposable-env.mjs`，
> `npm run mutate` 在 `main()` 开头调用同一份判据。不在一次性环境（容器 / GitHub Actions runner）里跑
> 就**直接 exit 1 并打印改跑什么**，不是静默跳过。漏加那行 import 由 check 链的
> `check-disposable-env-guard.js` 钉住（判据：目录前缀 + 那行必须是第一条 import——排在被测模块
> 后面等于没接上，而那和加对了看起来一模一样）。真要在开发机上跑：`CCM_ALLOW_HOST_DESTRUCTIVE_TESTS=1`，
> 放行但在 stderr 留一行警告。
>
> 守卫**不是**物理隔离：它和被守的测试住同一个仓库，改得动测试的人就删得掉那行 import。
> 它把「需要正确归类才能生效」降成「需要刻意绕过才能失效」。不依赖任何判断的隔离仍然只有容器本身。

**其余一切会跑测试的命令，一律进容器**：`npm run test:docker`（容器里跑 unit + invariants 三档 + 集成，共 5 档）、
`npm run test:docker:e2e`、`npm run test:docker:integration`、`npm run test:docker:invariants`（server+env 两档）、
`npm run test:docker:playground`、`npm run mutate:docker -- <文件>`。首次用先 `npm run docker:build`
（拉 Playwright 镜像 + npm ci，约 7 分钟）。维护者要打开一张干净 Linux 用户的 Web UI 时用
`npm run playground:up`（`127.0.0.1:13000`，fake-claude，不是产品入口；聊天/流式走 `playground:up:mock`）。

> `test:docker` 不含 `check`：`inventory:check` 要 `git ls-files`，而 worktree 检出的 `.git` 是指向
> 宿主机路径的指针文件，容器里解析不到。`check` 本来就在宿主机白名单里，留在宿主机跑即可。

> **为什么是白名单，不是"危险命令清单"**
> 2026-08-02 那次把用户的 `~/.claude/projects` 整棵树删光（70 个项目 / 291 memory / 2990 transcript），
> 根因不是没看见警告，是**没把 `npm run mutate` 归类成破坏性操作**——它会故意把源码改坏再跑测试，
> 而被改坏的恰恰可能是算删除路径的代码（当时 `getProjectDir` 被改成恒返回 `''`，
> `join(真实根, '')` 塌成真实根本身，测试的 `rmSync` 就打上去了）。
>
> 黑名单要求"每遇到一个新命令都正确归类"，而那正是失败的那一步。白名单反过来：
> **不在名单上的默认进容器**，判断错了顶多多跑一次容器，代价不对称地小。
>
> 钩子对**有容器替代**的命令直接 `deny` 并指出改跑哪条（不是 `ask`）——agent 自己换命令继续，
> 长任务不会卡在一条本可自助解决的命令上。只有真 agent turn 与 smoke 走 `ask`：那两档要真凭据、
> 容器里跑不了，花不花那笔额度只有人能决定。

容器里 `HOME` 是一次性目录，`~/.claude/projects` 解析到容器内空壳——这道防线**不依赖任何代码正确性**，
和仓库里那几层代码级防护（执行位守卫、单测的目录级 `CCM_DATA_DIR` 隔离、`mutate` 的沙箱 HOME、
删除点护栏、`check-destructive-deletes` 门禁）是不同的轴。

写删除相关代码时会撞上 `check-destructive-deletes` 门禁：测试里的 recursive 删除必须可追溯到 `mkdtemp`，
否则写 `// safe-rm: 理由`；生产代码里「追不到一次性目录、目录段由代码算出」的单文件删除要写 `// safe-path: 理由`。
**两种标记不通用**——为单文件删除批的豁免不放行递归删除。

**两档例外不进容器**（需要真凭据，得单独授权）：`RUN_CLAUDE_INTEGRATION=1`（需真 agent turn 的那批文件）
与 `npm run test:smoke`。其余全部零 token——集成层靠 `tests/fixtures/fake-claude.sh` 过 preflight。

## 常用命令

> ⚠️ **启动只有两条入口**：headless = 终端 `npm start`；macOS 还可走 `desktop/` 的 CCM.app。桌面端占着 3000 时**勿再手动 `npm start`**。改配置/代码后，桌面端菜单里 server 一行点「重启」，headless 重启那个进程。**例外**：工作区列表支持热加载，改完即生效、免重启（`ccm.config.json` 的 `WORKDIRS` 或旧版 `workdirs.json`，server 监听文件变化，被移除目录上的已开会话继续运行、仅拒新开）。哪些项热加载由 schema 的 `reload` 标记决定，当前只有 `WORKDIRS`。

配置统一放在项目根 `ccm.config.json`（结构化 JSON，`AUTH_TOKEN`/`PORT`/`WORKDIRS`/各开关都在里面）；旧版 `.env` 仍受支持——**新文件存在时优先，缺失才回落 `.env`**。schema 单一事实源是 `app/src/ops/env-schema.js`，读写与类型归一在 `app/src/ops/config-file.js`（**读写必须同源，写错源＝假成功**）。环境变量始终压过文件。

```bash
npm start          # node app/server.js（默认端口 3000）
npm run dev        # node --watch app/server.js
npm run check      # 零 token、最快。**具体有哪几道逐项以 package.json 的 check 为准**——这里原本
                   # 抄着一份清单，漂过两次，已删。每道门禁失败时会自己说清违反了什么，不必预先背。
                   # 链上成员由 tests/unit/gate-wiring.test.mjs 钉住：新门禁忘了接线会红
npm run lint       # 仅 ESLint（eslint .）；lint:fix 自动修可修项
npm test           # 单测 + tests/integration/*.test.mjs 全部（不是只跑 server/auth/upload 那几个）；
                   # 需真 agent turn 的由 RUN_CLAUDE_INTEGRATION 门控、默认跳过；--test-force-exit 保证退出。
                   # CI 不跑本条(force-exit 会腰斩异步单测)，拆成 test:unit + test:integration 两步
npm run test:unit  # node --test tests/unit/*.test.mjs：零 token、不 spawn claude、不起 server（最快）。
                   # 注意「单测」不等于「纯函数」——相当一部分文件会用 mkdtemp 临时目录或 spawnSync
                   # 跑本仓脚本（门禁类、CLI 类、文件类），隔离靠 preload-env + 一次性目录
npm run test:integration # 仅集成测试（起真 server，需本机 claude CLI）。CI 里靠 CLAUDE_BIN 指向
                         # tests/fixtures/fake-claude.sh 过 preflight，接线类用例真跑
RUN_CLAUDE_INTEGRATION=1 npm test  # 连同需真 claude agent turn 的一起跑（慢/耗 token/不稳）。
                                   # 受门控的是哪几个（写稿时 8 个）：
                                   #   grep -rl 'process\.env\.RUN_CLAUDE_INTEGRATION' tests/integration/
                                   # **必须带 process.env 前缀**：有几个文件的注释里写着「不挂
                                   # RUN_CLAUDE_INTEGRATION」，裸词 grep 会把它们一并捞出来，
                                   # 把零 token 的用例误判成要真凭据的
npm run test:e2e   # Playwright 移动端 UI 回归（零外部依赖 mock server）；test:visual 是兼容别名
                   # 本机跑必带 NO_PROXY=127.0.0.1,localhost，否则就绪探针走代理恒 30s 假红
                   # 【本条是 workers:1 串行】跑全量约 14 分钟（52 个 spec 实测时长加总 834s）。
                   # 要全量走下面的 test:e2e:parallel（4 片 ~225s）；开发循环则只跑相关的那几条：
                   # `-- tests/e2e/specs/xxx.spec.ts` 或 `-- --grep "P0-08 …"`，3-30s 出结果。两个坑：
                   # ① **--grep 的模式带空格必须加引号**。不加会被 shell 拆成「--grep 第一个词
                   #    ＋若干位置参数」，而它照样打印「Running 1 test … passed」——2026-09-18
                   #    据此得出「单跑绿、整份跑红」的假对照，差点去查根本不存在的 spec 间耦合。
                   # ② **--only-changed 在本仓不可用**。spec 不 import app/public（它们经浏览器
                   #    访问页面），Playwright 的依赖图看不见产品代码：改 app.js 时它选出
                   #    **0 个测试然后报绿**，正是「漏跑表现为全绿」。只有改 spec 自身时才有意义。
npm run test:e2e:parallel  # 同一批用例分片并行（分片数按核数自适应，CCM_E2E_SHARDS=N 可覆盖）。
                   # 每个分片就是一条 `npm run test:e2e --`，安全面同源。
                   # 分片按【实测时长】LPT 分配，不是 Playwright 原生 --shard 的按条数均分
                   # （原生 4 片 167s / 8 片 170s「一秒不差」是改造前的旧结论，已被 7e3b78e 推翻）。
                   # 2026-09-18 实测（10 核 · 52 个 spec 文件 · 串行总和 834s，其中 55% 是空等，
                   # 所以并行才有这么大收益）：4 片 ~225s = 缺省档 · 5 片 ~180s · 6 片 ~150s ·
                   # 8 片 ~110s。地板≈最大那个 spec 文件自己的耗时——同一文件不跨分片，
                   # workspace-sessions-sidebar 单跑实测 108s，所以 8 片已经触底、再加没有收益。
                   # （别拿 .e2e-durations.json 里的值当地板：那是【上一轮】的观测，含当轮负载，
                   # 实测偏大——本次缓存记 117.9s 而单跑只要 108s，照抄会算出「8 片比地板还快」。）
                   # **缺省停在 4 是 flaky 选的，不是性能选的**：并行度越高，一批「等固定时间窗」
                   # 的用例越容易超时。当前已知 P0-SYNC-ACK-TIMEOUT 一条，4 片下也会偶发红，
                   # 根因未定位（单跑 3/3 绿、CPU 占满绿、6 进程并行绿，只有真跑分片全量才中）。
                   # 想提分片数就得先把它清掉，否则只是让既有 flaky 更频繁。
                   # **以上全是「N 片挤同一台机器」的数字**。CI 上是另一种形态：
                   # CCM_E2E_SHARD_INDEX=i 让本进程只跑第 i 片，8 台 runner 各跑一片、
                   # 互不争抢 CPU，所以上面那条「分片数越高越容易假红」不能照搬过去（病因是
                   # N 片挤同一台机抢 CPU；CI 那边每片独占一台 4 核 runner，等于每个浏览器
                   # 拿到的资源是本机 8 片时的 3 倍多）——横向 8 片实测 323 条全绿、零 flaky，
                   # 整个 workflow 墙钟 296s → 140s。横向分片新增一条**漏跑表现为全绿**的路径——
                   # 各 runner 各自读时长缓存算分组，一台 cache 没命中就算出另一套分组，
                   # 于是有 spec 谁都没跑。汇总 job 用 `--merge-durations` 做并集校验堵它
                   # （TEST-02，少一个就红）。时长缓存在 CI 上靠 actions/cache 跨 run 复用：
                   # 没有它 LPT 整个退化成按文件数轮转，而轮转在分片数变大时更差——两个大文件
                   # 会撞进同一片，6 片轮转的最慢片实测 209-213s，而 LPT 理想值只要 ~117s
                   # （CI 串行基线实测 ~700s，固定开销 33-41s/片）

# 装机与配置
npm run setup                  # 交互装机向导。非交互下「会动全局」的项缺省 off、危险回落直接拒绝（hard-rules §1）
node scripts/config.js         # headless 配置 CLI：init|get|set|unset|check|migrate|schema；secret 明文须显式 --reveal
node scripts/doctor.js         # 启动自检。跑一次看输出，别背清单。--env=prod.env 指定 .env

# 两个 CLI 桥（可选、显式安装，动 ~/.claude；一键卸载会对称移除。机制见 architecture.md）
npm run statusline:install|status|uninstall
npm run hooks:install|status|verify|uninstall

# macOS 桌面端（第二条入口；service:* 是它背后的 CLI，一般不用手敲）
npm run app:install   # 编译并装进 /Applications。装过之后升级走菜单「更新桌面端（重新编译）」一步到位
npm run app:build     # 只编译到 desktop/build/CCM.app。check 里的 app:test 已含 swiftc -typecheck，
                      # 所以「check 全绿」蕴含「能编译」；但 typecheck 不产出 bundle，
                      # **改了菜单栏要真跑起来仍需 app:build/app:install**
                      # app:test 按指纹缓存（desktop/*.swift 内容 + swiftc 版本 + 编译参数）：
                      # 没动 desktop/ 时跳过，check 从 22s 降到 5s。改了内容必重编，
                      # CI 全新 checkout 无戳、必然全量。CCM_FORCE_SWIFT_VERIFY=1 强制重跑
npm run service:status                             # 各 unit 运行态/归属/漂移；--json 供菜单栏与 doctor 消费
npm run service:install|adopt|restart|logs|health  # adopt=接管手工安装（只写 manifest 不碰 plist）
npm run uninstall -- [--purge] [--dry-run] --yes   # 一键卸载。**只删产品自己装的**，manifest 外的 unit /
                                                   # ~/.cloudflared / ~/.claude/projects 永不碰

node scripts/device.js list [--json] | approve <ID> | deny <ID>   # 设备审批的 headless 入口
                                                                  # （另三个入口见 architecture.md）
node scripts/qr.js [--public|--url <地址>]  # 把连接地址+token 打成终端二维码，免手输 64 位 token。
                                   # 含凭据、须显式敲（口径同 config.js 的 --reveal），不进启动横幅。
                                   # 全块渲染需 90 列×45 行：半块只要 23 行但真机实测扫不出来（行距）。
                                   # --public 自动解析 CF Access 域名 / Tailscale；**受 Access 保护的
                                   # 域名不带 token**（那条路只认 JWT、不回退 token），判据在
                                   # app/src/shared/public-target.js，--url 也走同一道
```
